# Code Harness 架构

## 1. 进程模型

Electron 的三层进程模型，职责边界严格：

```
┌─────────────────────────────────────────────────────────────┐
│ Main（Node，全权限）                                          │
│  window.ts      窗口生命周期 / CSP / 外链拦截                  │
│  ipc/*          领域处理器：workspace、agent                   │
│  agent/*        Agent 运行时：会话、Provider、工具、审批、调度    │
│  store/*        持久化：设置（密钥加密）、项目、JSONL 转录、技能   │
└───────────────▲─────────────────────────────────────────────┘
                │ ipcMain.handle / webContents.send
┌───────────────┴─────────────────────────────────────────────┐
│ Preload（沙箱，唯一桥梁）                                      │
│  contextBridge.exposeInMainWorld('pi', CodeHarnessApi)           │
│  不暴露 ipcRenderer；只暴露白名单方法 + 取消订阅函数             │
└───────────────▲─────────────────────────────────────────────┘
                │ window.pi.*
┌───────────────┴─────────────────────────────────────────────┐
│ Renderer（Chromium，无 Node）                                 │
│  state/store.ts  外部 store + IPC 事件归并 + 全部动作          │
│  components/*    纯展示 + 用户意图                             │
└─────────────────────────────────────────────────────────────┘
```

**关键约束**：渲染层拿不到 `ipcRenderer`，也拿不到 `require`。所有能力都必须先在 `src/shared/api.ts` 里声明，再在 `src/preload/index.ts` 实现，最后在 `src/main/ipc/` 提供处理器。三处对齐由 TypeScript 保证——少了任何一处都编译不过。

## 2. 契约层（`src/shared`）

| 文件 | 作用 |
| --- | --- |
| `types.ts` | 领域模型：`AgentMessage`、`ToolCall/ToolResult`、`AgentEvent`、`AppSettings`、`SessionMeta`、`HarnessView`… 以及 `ToolSchema`（含 `readOnly` 与 `reviewerExcluded` 两个角色裁剪标记） |
| `ipc.ts` | 通道名常量。主进程与 preload 引用同一份，避免「字符串拼错但编译通过」 |
| `api.ts` | `CodeHarnessApi`——渲染层能看到的全部能力面 |

`AgentEvent` 是个判别联合（discriminated union），渲染层的 `handleAgentEvent` 用 `switch (event.type)` 穷尽处理，新增事件类型时漏处理会有类型提示。

## 3. Agent 运行时

### 3.1 三层对象

```
AgentRuntime        常驻单例。会话注册表、审批仲裁、子智能体派生、调度心跳
  └─ AgentSession   单个会话。转录、回合循环、工具执行、压缩
       └─ Provider  OpenAI / Anthropic 适配，SSE 流式 + 工具调用增量解析
```

`AgentRuntime` 对应 prime-agent 里的 daemon：常驻、拥有全部会话、不随窗口关闭而销毁。窗口只是它的一个视图。

### 3.2 一次回合的完整链路（`session.ts`）

```
用户输入
  │
  ├─ 装配系统提示词（harness.ts：基础层 + 技能 + 记忆 + 精炼 + 目标）
  ├─ messages → ChatTurn[]（Provider 无关的中间表示，图片只挂到对应回合）
  │
  ├─ 循环（最多 maxStepsPerTurn 步）
  │    │
  │    ├─ ① 调用 Provider，流式接收
  │    │     ├─ message:start / message:delta / reasoning:delta → 推 UI
  │    │     └─ 累积 tool_calls 增量（index → id/name/arguments 分批到达）
  │    │
  │    ├─ ② 落盘 assistant 消息 → message:end
  │    │
  │    └─ ③ 逐个执行工具调用
  │         ├─ 需要审批？→ 挂起 Promise，emit approval:request，等 UI 回话
  │         ├─ 执行（注入 ToolContext：项目根、设置、emit、审批回调、子智能体回调）
  │         ├─ 截断输出（上限 6 万字符）
  │         └─ tool:end → 结果作为 role=tool 消息回灌，进入下一轮
  │
  ├─ 工具列表为空 → 结束本轮 → turn:end
  │
  └─ 上下文超阈值且 contextCompaction=auto
       └─ 追加一条压缩标记（此前的历史由摘要代表）+ compaction 事件
```

**JSON 解析失败的容错**：模型偶尔吐出截断的 JSON 参数。这里不静默丢弃，而是保留原始串（`ToolCall.raw`），在回灌时明确告诉模型「参数不是合法 JSON，原始参数是 …，请重新调用」——把修复机会交还给模型，而不是让工具用错误的参数跑一遍。

### 3.3 中断

`AbortController` 贯穿整条链路：中止时同时（a）取消正在进行的 HTTP 流，（b）杀掉所有在跑的子进程（Windows 用 `taskkill /T /F` 连进程树，避免留下孤儿 `npm`/`node`），（c）把当前回合标记为 `aborted`。

### 3.4 Steering

回合进行中用户可以直接插话。插话文本进入一个队列，在**下一次模型调用前**追加进对话——不打断当前正在执行的工具，保证工具执行到一半不会留下不一致状态。

### 3.5 子智能体

`task` 工具 → `runtime.spawnSubAgent()`：

- 新建一个 `isSubAgent: true` 的会话（有独立转录与独立上下文，侧栏默认不展示）；
- 嵌套深度上限 2 层，防止 `task` 无限自我派生；
- 子会话只把**最终一条 assistant 文本**作为工具结果返回父会话，中间的工具调用与文件内容全部留在子会话里，父会话上下文不被污染。

### 3.6 调度器

`setInterval` 30 秒 tick 一次，扫 `scheduler.json`，`nextRunAt <= now` 就触发。任务可以绑定既有会话（持续推进同一目标）或每次新建会话（一次性巡检）。执行结果写回 `lastResult` 并在失败时保留错误信息。

### 3.7 转录投影（树形会话）

会话状态是**树**，模型上下文是它的一次**投影**。投影规则集中在 `store/transcript.ts`——纯函数、不依赖 Electron，所以能单独 bundle 后用 node 单跑验证（这个仓库没有测试框架，这是它的验证路径）：

```
文件条目（append-only，三种 kind：message / context-edit / compaction）
  └─ activeChain(entries, headId)   沿 parentId 回溯 → 当前分支（含被隐藏的、含压缩标记）
       └─ projectMessages(chain)    最后一次压缩之前由摘要代表 + 剔除被隐藏的 → 发给 Provider
```

两个约定决定了整套机制的正确性：

- **消息条目复用消息自身的 id**（只有压缩标记另发新 id）。于是"隐藏这一条""从这一条分叉"在存储层与界面层是同一个 id 问题，不需要维护第二份映射；
- **隐藏集合同时按"条目 id 或消息 id"匹配**。存储层保证两者相同，但手工改过的转录或历史数据可能不一致——此时**宁可多隐藏一条**：漏隐藏的后果是"用户以为已经扣下的内容继续发给模型"，那是隐私问题，不是显示问题。

`headId`（当前分支指针）落在会话索引里。旧索引没有这个字段时归一化为 null，并在首次追加时按"线性转录的最后一条"补上指针——`normalizeEntries` 的**父链修复**就是为这条升级路径存在的：不修复的话，一个老会话加上一条新消息，整棵树会退化成"只看得见最后一条"。

## 4. Harness（持续演进层）

系统提示词分成两层：

```
不可变层（代码里的 BASE_PROMPT）
  └─ 工作方式 / 输出风格 / 边界

增量层（每次运行重新拼装）
  ├─ 运行环境（OS、工作目录、权限模式）
  ├─ 可用工具清单
  ├─ 上下文文件（AGENTS.md / CLAUDE.md：全局 → 父目录链 → 项目根，合计预算 16k 字符）
  ├─ 技能索引 + 技能正文（预算 8k 字符）
  ├─ Harness preamble：记忆 + 精炼 + 目标
  └─ 用户附加指令
```

这样设计的原因：Harness 会随使用不断演进（记忆变多、精炼变准），如果把增量内容直接写进基础提示词，每次演进都会导致提示词前缀变化，**缓存前缀失效**。分层后基础层稳定，只有增量层变。

**技能正文预算是所有技能共享的**（8k 字符）。所以在 `skill-packs/` 里集成第三方技能时，入口 `SKILL.md` 刻意写短、把方法论留在同伴文档里由 Agent 按需 `read_file`——上游原样搬进来的话（例如 security-audit 的 SKILL.md 单独一份就超过 8k），要么被截断丢掉关键规则，要么把别的技能挤出预算。

**记忆的准入规则**：`add_memory` 必须带 `evidence`（文件路径、命令输出、具体现象）。没有证据的记忆会被拒绝——这是防止 Agent 把猜测固化成"事实"的关键闸门。

**快照与回滚**：每次 Harness 变更前留一份快照，出问题可从 UI 回滚。

## 5. Provider 适配（`agent/providers/`）

统一的 `Provider` 接口，两个实现：

- `openai.ts`：`/chat/completions` + `stream: true`，工具走 `tools` / `tool_calls`；
- `anthropic.ts`：`/v1/messages` + `stream: true`，工具走 `tools` / `tool_use` / `tool_result` content block。

`openai-compatible` 复用 `openai.ts`，只改 `baseUrl`（覆盖 Ollama / vLLM / OneAPI / 各种网关）。

`sse.ts` 是共用的 SSE 解析器：按 `\n\n` 切事件、剥 `data:` 前缀、处理 `[DONE]` 哨兵。两个 Provider 都靠它把字节流变成结构化增量。

**增量工具调用**是这里最容易出错的地方：`tool_calls` 的 `id` / `name` / `arguments` 是**分批**到达的，且可能多条并发。解析器按 `index` 聚合到各自的累积器里，最后统一 JSON.parse。

## 6. 持久化（`main/store/`）

| 存储 | 形态 | 理由 |
| --- | --- | --- |
| 设置 | 单个 `settings.json`（原子写） | 读多写少；API Key 用 `safeStorage` 加密 |
| 项目 | `projects.json` | 列表很短 |
| 会话索引 | `sessions/index.json` | 侧栏列表要一次读全 |
| 会话转录 | `sessions/transcripts/<id>.jsonl` | **树形条目 + 逐行追加、从不重写**：条目带 `id`/`parentId`，所以"回到历史某点继续"只移动指针，压缩与隐藏都只是追加标记 |
| Harness | `harness.json`（用户级 + 项目级） |
| 项目信任 | `trust.json` | 决定项目级技能与项目级记忆是否参与提示词装配；子目录继承父目录的决定 |
| 调度 | `scheduler.json` |
| 技能 | `skills/` 目录（用户级 + 项目级） |

**原子写**（`json-file.ts`）：先写 `.tmp`，再 `rename` 覆盖。避免进程在写一半时被杀导致文件半截。

**转录用 JSONL 而不是单个大 JSON**：一次会话可能几百条消息、几十 MB。每次追加都重写整个 JSON 数组是 O(n²) 的，而且崩溃时整份文件都可能坏掉。JSONL 追加是 O(1)，坏行也只坏一行。

## 7. 渲染层

### 7.1 状态管理

不用 Redux/Zustand，用一个约 500 行的外部 store + `useSyncExternalStore`：

- 状态是**单个不可变对象**，`set(patch)` 整体替换引用；
- 组件通过 `useApp()` 订阅全量状态。会话与消息列表的规模（几百条）在这个量级下不需要细粒度选择器；
- 临时高频数据（终端输出、调度变更）**不进全局状态**，走 `terminalBus` / `schedulerBus` 两个轻量事件总线，避免每次终端输出都触发全量重渲染。

### 7.2 事件归并

`handleAgentEvent` 是流式 UI 的核心。两条容易踩的规则：

1. **非当前会话的事件不能直接丢**。子智能体和定时任务可能在后台跑，它们的审批请求和错误必须仍然提示用户，否则会静默阻塞在「等待审批」上。
2. **流式增量用 id 定位而不是索引**。`message:delta` 带着 `messageId`，归并时按 id 找到目标消息追加文本——因为压缩、重排都可能让索引失效。

### 7.3 布局

CSS Grid 三层：

```
.app        grid-template-rows: 44px 1fr 26px     （标题栏 / 工作区 / 状态栏）
.workspace  grid-template-columns: 侧栏 聊天 右面板
```

侧栏与右面板的折叠通过 `sidebar-collapsed` / `panel-collapsed` 类把对应列宽设成 0，不是 `display: none`——保持 DOM 不卸载，折叠展开时组件状态（滚动位置、展开的目录树、终端会话）不丢。

## 8. 安全设计

| 面 | 措施 |
| --- | --- |
| 渲染层 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox` 由 preload 显式设为 CJS 产物 |
| 出网 | `index.html` 里的 CSP 只放开 `self` 与本地 dev server；远程脚本/样式一律拒绝 |
| 文件系统 | 所有文件工具把入参解析成绝对路径后校验前缀是否在项目根内，`..` 越界直接拒绝 |
| 命令执行 | 默认逐个审批；子进程有超时；中止时连进程树终止 |
| 角色化子会话 | `reviewer` 是**只读角色**：`toolSchemas(mode, role)` 无条件按只读裁剪，并在执行层用 `isToolAllowedForRole` 再挡一道（模型可能凭上下文调一个不在清单里的工具名）。承诺不落在机制上就等于没有承诺 |
| 派生审查会话的工具 | `review_changes` / `ocr_review` 标 `reviewerExcluded`：只读工具本来就能进 reviewer 的工具面，不排除的话审查专员可以再派一个审查专员，形成自我递归 |
| 外部 CLI 参数 | `ocr_review` 拼给 `shell: true` 的路径来自**被测仓库的文件名**（不可信输入），因此走白名单：含 `& \| > " \`` 等字符的路径不执行、整条记为 skipped 并如实报出，而不是"尽力转义" |
| 密钥 | `safeStorage` 加密；密钥不进转录、不进日志、只发给用户配置的模型端点 |
| 失控保护 | `maxStepsPerTurn` 限制单轮工具步数；子智能体嵌套上限 2 层 |

外部链接：渲染层里的 `target=_blank` 与 `window.open` 被拦截，改由 `shell.openExternal` 交给系统浏览器（`allowExternalLinks` 可关闭）。

## 9. 扩展点

**加一个工具**：在 `src/main/agent/tools/` 新建或加入某个工具组，实现 `ToolDefinition`（`schema` + `run`），加进 `ALL_TOOLS`。

- 要能被 `readonly` 权限模式保留，设 `schema.readOnly = true`；
- 有副作用的工具**必须在 `run()` 里显式 `await ctx.requestApproval(call, reason)`** 并在拒绝时返回 `toolError(...)`。审批不由 schema 声明——因为审批提示需要工具自己才知道的上下文（改哪个文件、跑哪条命令）。`session.ts` 的 `requestApproval` 包装负责叠加 `permissionMode` 与自动批准白名单；
- 如果是「同一类操作」的新工具（例如又一个写文件的方式），把它加进 `src/shared/tool-groups.ts` 的对应分组 —— 否则用户在审批卡上点「总是允许编辑文件」只放开了老工具，新工具仍会逐个询问；
- 工具执行期间长时间无输出时可用 `ctx.log()` 把进度推给状态栏；
- 最后给 `src/renderer/src/lib/format.ts` 的 `toolLabel` 补一行中文名，UI 上就会显示中文而不是英文工具名。

**加一个 Harness 能力**：如果新工具需要读写跨轮次状态，先看 `src/main/store/harness-store.ts` 有没有现成实现，再按 `ctx.setGoal` / `ctx.rememberMemory` / `ctx.rememberRefinement` 的方式挂到 `ToolContext` 上——不要在工具里直接读写文件。

**加一个 Provider**：在 `src/main/agent/providers/` 实现 `Provider` 接口（一个 `stream()` 方法，产出统一的增量事件），在 `providers/index.ts` 的工厂里注册，然后在 `ProviderKind` 联合类型里加上它。

**加一个 AgentEvent**：在 `types.ts` 的 `AgentEvent` 联合里加成员 → 在 `session.ts` 里 emit → 在 `store.ts` 的 `handleAgentEvent` 里处理。TypeScript 会在第三步提醒你漏了分支。

**加一个面板**：`components/` 下写组件 → `RightPanel.tsx` 的 `TABS` 数组加一项 → `store.ts` 的 `RightTab` 联合类型加成员。侧栏折叠/展开、快捷键（`Ctrl+1..5`）都在 `App.tsx` 统一处理。

**加一种转录条目**：在 `types.ts` 的 `TranscriptEntryKind` 加成员 → 在 `transcript.ts` 里同时处理 `projectMessages`（投影必须显式认识它，否则可能把不该进上下文的东西漏进去）与 `entryPreview`（界面上的分支尖预览）→ 需要写入时在 `session-store.ts` 加一层 append 封装，**不要绕过 `appendEntry`**：它是维护 `headId` 与 `messageCount` 的唯一入口，绕过它就会出现"文件里有、但当前分支看不到"的条目。

**加一个内置技能包**：在 `skill-packs/<包名>/` 放 `SKILL.md` 与同伴文档，再补一个 `ORIGIN.md` 记清上游仓库、ref、许可证与本地改动。三个容易踩的点：

- frontmatter 的 `name` / `description` **必须写成单行** `key: value`——`skill-store.ts` 的解析器不认 YAML 的多行折叠写法（`description: >` 会被读成 `>`）；
- 分发走 `electron-builder.yml` 的 `extraResources`：安装技能包是把它整包**复制**到用户项目，打进 asar 就读不到普通文件路径；
- 安装目标是**项目级** `<项目>/.code-harness/skills/`，默认不覆盖同名目录（要通过工具显式传 `force` 才升级）——用户很可能已经改过装好的版本。
