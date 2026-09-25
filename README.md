# Code Harness

桌面版 AI 编码 Agent 工作区。把「Agent 运行时」和「桌面工作区」两件事合成一个 Electron 应用：

- **Agent 运行时** 参考 [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)：会话是状态中心（转录 / 工具循环 / 上下文压缩 / 目标 / 子智能体 / Harness 演进）。
- **桌面工作区** 参考 [am-will/gooey-pi](https://github.com/am-will/gooey-pi)：项目与会话管理、右侧文件/变更/终端/定时面板、命令面板、技能库、BYOK 设置。

产物是一个**纯本地**应用：模型走你自己的 API Key，代码不出本机，唯一的出网请求是你配置的模型端点。

---

## 快速开始

```powershell
cd code-harness

# 关键：清空 IDE 注入的 NODE_OPTIONS，否则 npm 会在语言 shim 下卡死
$env:NODE_OPTIONS=''

npm install
npm run dev
```

Windows 上也可以直接用引导脚本（自动清空 `NODE_OPTIONS`、切换 Electron 镜像、装完顺手跑类型检查）：

```powershell
.\tools\bootstrap.cmd
```

### 环境要求

| 项 | 要求 |
| --- | --- |
| Node | ≥ 20.19（开发机实测 24.x） |
| 包管理器 | npm 10+（仓库内只有 `package-lock.json` 语义，不依赖 pnpm） |
| 系统 | Windows / macOS / Linux 桌面环境 |

> **关于 Electron 二进制**：`electron@44` 起官方包里去掉了 `postinstall`，只跑 `npm install`
> 不会下载运行时，`npm run dev` 会报找不到可执行文件。本仓库用 `scripts/ensure-electron.mjs`
> 在安装后自动补一次（幂等，已装即跳过）。如果它失败了，手动补：
>
> ```powershell
> node node_modules/electron/install.js
> ```
>
> 国内网络慢的话，`.npmrc` 里已配好 npmmirror 镜像；也可以临时改用官方源。

### 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动开发模式（主进程改动自动重启，渲染层 HMR） |
| `npm run build` | 产出 `out/`（main / preload / renderer 三份产物） |
| `npm start` | 以生产产物预览（`electron-vite preview`） |
| `npm run typecheck` | 同时检查主进程侧与渲染层侧的 TypeScript |
| `npm run package` | 只打包目录，不生成安装器（`electron-builder --dir`），用于快速验证 |
| `npm run dist` | 生成安装包到 `release/<version>/` |
| `npm run seed:providers` | 读 `providers.local.json`，把多家 API Key 加密批量写入应用设置 |
| `npm test` | 跑 `tests/` 下的用例（Node 内置 test runner + 原生 TS 剥离，**不引入任何新依赖**） |

### 测试覆盖什么（刻意只测"不变量"）

Agent 应用大部分代码是难以离线验证的胶水（窗口、IPC、流式渲染），硬去测性价比很低。
所以这里只挑**四条会静默退化、又最不该靠手工点出来的不变量**：

| 用例文件 | 守住的不变量 | 退化了会怎样 |
| --- | --- | --- |
| `tests/paths.test.ts` | 路径围栏：`../` 逃逸与绝对路径穿透一律拒绝 | 模型可以读写项目外的文件，审批闸门成了唯一防线 |
| `tests/tool-groups.test.ts` | 审批分组：「总是允许」要覆盖**整类**操作，且不得连带 `run_command` | 用户以为授权过了，其实每次还在被问；或悄悄放开了执行命令 |
| `tests/turn-pairing.test.ts` | `tool_calls ↔ tool 结果` 严格配对（缺的补位、孤儿的丢弃） | 该会话此后**每一轮都被服务端 400 拒收**，只能新建会话 |
| `tests/sse.test.ts` | SSE 分帧、`\r\n` 兼容、UTF-8 跨片解码、错误信息可操作性 | 流式输出花屏或最后一帧丢失；报错无法定位 |

跑法：

```powershell
npm test
```

> `turn-pairing.ts` 之所以从 `session.ts` 里单独拆出来，就是为了**能被这样单独验证** ——
> 它是一条协议不变量，不是某段流程的实现细节，混在两千行的会话循环里只会被当成防御性噪声。

---

## 首次使用

1. 打开应用 → 右上角齿轮（或 `Ctrl+,`）进设置 → **模型** 标签。
2. 在 **从预置快速添加** 里点一家（DeepSeek / 硅基流动 / 智谱 GLM / Ollama / OpenAI / Anthropic）——
   Base URL 与常用模型名会自动填好，你只要粘贴 API Key，然后点「测试」。
   - 预置没覆盖的服务：**添加自定义 Provider**，`kind` 选 `OpenAI 兼容`，Base URL 指向 `http(s)://host/v1` 即可，不用改代码；
   - 走 Anthropic 原生协议的服务，`kind` 选 `Anthropic`。
3. 确认 **当前 Provider** 与 **当前模型**，保存。
4. 左上角 **＋** 添加一个代码目录作为项目。
5. 在底部输入框描述任务即可开始。没有会话时会自动新建。

> 想一次性把多家 Key 都配好，可以走脚本：在仓库根写 `providers.local.json`（已在 `.gitignore`），
> 然后 `npm run seed:providers` —— 密钥会用系统密钥环（`safeStorage`）加密写入应用设置，与界面里点「保存」形态一致。
> 各家 Base URL、实测可用的模型 id 与踩坑清单见 [`docs/PROVIDERS.md`](docs/PROVIDERS.md)。

`Ctrl+K` 打开命令面板，可以直接搜会话、切面板、换主题、建会话。

---

## 核心能力

### Agent 循环

一次「回合」= 模型流式输出 → 解析工具调用 → 逐个执行 → 把结果回灌 → 继续，直到模型不再请求工具或达到 `maxStepsPerTurn`。

- **流式输出**：文本与推理摘要（`reasoning`）分别增量推送；工具调用参数按增量拼接，JSON 解析失败时保留原始串并在回灌时明确告知模型「参数不是合法 JSON」，让模型自己修正，而不是静默失败。
- **审批闸门**：写文件、编辑、执行命令、提交等「有副作用」的工具默认逐次向 UI 申请批准。点「总是允许编辑文件 / 执行命令 / Git 提交」授权的是**整类**操作（而不是当前这一个工具名），例如「总是允许编辑文件」会同时放开 `write_file` 与 `edit_file`；设置 → 权限里有同样的勾选项，也可直接编辑白名单。
- **Steering**：回合进行中可以直接插入一句新指令，会在下一个模型调用前生效，不必中止。
- **中止**：随时中断，正在跑的子进程会被连进程树一起杀掉（Windows 上 `taskkill /T /F`）。
- **上下文压缩**：历史过长时自动把早期消息折叠成摘要，只保留最近窗口，压缩行为会在 UI 上提示。

### 工具集

| 工具 | 说明 | 需审批 |
| --- | --- | --- |
| `read_file` | 读文件（带行号、超长截断） | 否 |
| `list_dir` | 列目录（树形） | 否 |
| `glob` | 按通配符找文件 | 否 |
| `grep` | 正则检索内容 | 否 |
| `write_file` | 写文件（新建/覆盖） | 是 |
| `edit_file` | 精确字符串替换 | 是 |
| `run_command` | 执行 shell 命令 | 是 |
| `git_status` / `git_diff` | 看仓库状态与差异 | 否 |
| `git_commit` | 提交 | 是 |
| `todo_write` | 维护任务清单（实时同步到 UI） | 否 |
| `task` | 派生一个子智能体（独立会话 + 独立上下文） | 否 |
| `set_goal` | 设定跨轮次持续推进的目标 | 否 |
| `add_memory` | 写一条 Harness 长期记忆（**必须带证据**） | 否 |
| `add_refinement` | 沉淀一条「做法层面」的经验（**必须带证据**） | 否 |
| `review_changes` | 派生只读审查专员，按生产就绪清单复查改动（PLAN/PASS/BLOCK） | 否 |
| `ocr_review` | 用 open-code-review 的委派模式做规则驱动审查（见下文「内置技能包」） | 否 |
| `install_skill_pack` | 把内置技能包安装到当前项目 `.code-harness/skills/` | 是 |

所有文件类工具的路径都被限制在项目根目录内，越界会被拒绝。单个工具输出超过 6 万字符自动截断，避免一次 `cat` 巨文件把上下文打爆。

**权限模式**（设置 → 权限）：

- `ask`（默认）：有副作用的操作逐个确认；
- `auto`：有副作用的操作直接执行，不弹窗；
- `readonly`：只向模型暴露只读工具，任何写操作都不可用。

### Harness（持续演进层）

系统提示词分成两层：**不可变的基础提示词** + 每次运行重新拼装的**增量层**（技能 → 记忆 → 精炼 → 目标）。这样 Harness 演进不需要重写基础提示词，前缀缓存也保持稳定。

- **记忆**：`add_memory` 写入，必须附证据（文件路径 / 命令输出），无证据不采纳；项目级记忆存在 `<项目>/.code-harness/harness.json`，用户级存在应用数据目录。
- **精炼**：从反复出现的失败/纠正里沉淀出的规则，可启用/停用。
- **目标**：跨轮次持续推进的任务，状态分 `active / paused / done`。
- **快照**：Harness 每次变更留一份快照，出问题可以回滚。

右侧 **Harness** 面板可以看到全部内容，以及「实际注入系统提示词的字数」。

### 子智能体

`task` 工具会派生出**独立会话**（有自己的上下文与转录，侧栏默认不展示）。子智能体只把自己总结后的结论带回父会话，父会话的上下文不会被中间过程污染。适合「读一堆文件只为回答一个问题」这类场景。

### 定时任务

右侧 **定时** 面板可创建周期任务，RRULE 语法：

```
FREQ=HOURLY;INTERVAL=2
FREQ=DAILY;BYHOUR=9;BYMINUTE=0
FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=18;BYMINUTE=30
```

到点后按配置复用当前会话或新建会话执行。适合每日回归测试、依赖巡检、周报汇总。

### 会话与分支（树形转录）

转录是**一棵树**，不是一条线：每个条目带 `id` / `parentId`，当前指针（`headId`）指向你正在走的那条分支的末端。

- **回到历史某点继续**：消息悬浮出现「从此继续」，只移动指针——之后的对话会从那里长出一条新分支，原分支仍在同一个文件里（不新建文件、不复制历史）；
- **分叉为新会话**：把该点之前的历史复制成一个独立会话（原会话不动）；
- **复制当前分支**：当前分支整体复制成新会话；
- **从上下文隐藏**：把某条消息对**模型**隐藏/恢复。转录与界面都不动，它只是不再出现在后续发给模型的上下文里；
- **上下文压缩**（设置 → 行为）：超出预算时把旧历史折叠为一份工作快照。**原始条目一条都不删**，聊天区用一条分隔线标出折叠位置，往回翻仍能看到被折叠的内容。

三个语义值得记住，它们解释了"界面看到什么"和"模型看到什么"为什么可以不一致：

| | 界面（转录） | 模型（投影） |
| --- | --- | --- |
| 被隐藏的消息 | 显示，带「已从上下文隐藏」标记 | **不出现** |
| 被压缩折叠的历史 | 显示（分隔线之前的内容仍可回溯） | 折叠成一条摘要 |
| 分支之外的条目 | 切到那条分支才显示 | 不在当前分支就不出现 |

聊天区因此按**转录**渲染，而不是按"模型看到的消息列表"渲染——否则用户一隐藏某条消息、界面上那条就凭空消失，一压缩历史整段缩水，看起来像数据被删了。

### 上下文文件（AGENTS.md / CLAUDE.md）

按上游 pi 的惯例，装配系统提示词时读取并拼接：**全局（应用数据目录）→ 项目父目录链 → 项目根**；同一目录里 `AGENTS.override.md` 优先于 `AGENTS.md`，再退到 `CLAUDE.md`。可在 设置 → 行为 里关掉。

预算是字符量纲：单文件 6k、合计 16k，**按"离项目近的优先"裁剪**（不够时先丢最外层）。父目录链会读到项目根之外的文件——这是刻意的：路径围栏约束的是**模型能调用的文件工具**，与主进程装配提示词时的只读读取是两件事（也正是 monorepo 里子项目能继承仓库级约定的原因）。

### 项目信任（项目级资源默认不注入）

项目级技能（`.code-harness/skills`、`.pi/skills`、`.agents/skills`）与项目级 Harness 记忆都来自**仓库里的文件**，而仓库是别人可以改的东西。clone 一个仓库就自动把它的 `SKILL.md` 与"记忆"拼进系统提示词，等于把提示词的一部分交给仓库作者——**审批闸门管不住这件事**，它拦的是工具调用，不是提示词装配。

所以默认**不注入**：含项目级资源的项目首次打开时会问一次，决定记在 `trust.json`（子目录继承父目录的决定）。未决定时用户级技能与记忆照常注入，只是项目级的不参与；模型会收到一句"项目级资源未加载"的说明，而不是被蒙在鼓里。

### 技能（Skills）

「技能」= 可复用的操作模式（一段说明 + 正文步骤）。启用后，技能索引进入系统提示词，正文在预算内（8k 字符）注入。

扫描范围：**本应用私有**的用户级 `<应用数据>/skills` 与项目级 `<项目>/.code-harness/skills`（可增删改）；再加跨工具约定目录 `~/.agents/skills`、`<项目>/.agents/skills`、`<项目>/.pi/skills`，以及**项目父目录链**上的同名目录（monorepo 里子项目能继承仓库级技能）。约定目录是**只读来源**——它们可能同时被别的工具使用，本应用不改写其中的文件，界面上也不提供切换/删除入口。

### 内置技能包（第三方技能集成）

仓库 `skill-packs/` 里随应用分发两个**第三方技能包**，装到项目里即可用（清单、许可证与安装细节见 [`skill-packs/README.md`](skill-packs/README.md)）：

| 包 | 做了什么 | 上游（许可） |
| --- | --- | --- |
| `open-code-review-delegate` | 接入 Alibaba 的 `ocr` 委派模式：**ocr 只做确定性工程**（按扩展名/体积/排除规则选出该审哪些文件、按源码解析出每个文件适用的规则组），**审查由本机模型的只读审查子会话完成** | [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（Apache-2.0） |
| `security-audit` | 源码优先的安全审计：信任边界 → 覆盖驱动的候选搜寻 → 独立验证 → 结构化产物（`findings.json` + 报告 + 覆盖率账本） | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill)（MIT） |

```bash
# 让 Agent 装（工具走审批闸门）
install_skill_pack(pack: "security-audit")     # 不传 pack 先列清单
```

三点设计说明：

- **为什么必须装项目级**：技能包是「入口 `SKILL.md` + 同伴文档」的多文件结构，入口会要求 Agent 去读同伴文档（渐进披露）；而文件工具被围栏在项目根内，装在用户级技能目录会导致同伴文档读不到。所以 `install_skill_pack` 只往 `<项目>/.code-harness/skills/` 装，且**默认不覆盖**已存在的同名目录（避免吃掉你改过的版本）。
- **委派模式不引入出网点**：`ocr delegate preview` / `rule` 在 OCR 侧**不调用任何 LLM**，只读仓库并输出 JSON。所以「纯本地、代码不出本机」这条依然成立——你不需要为 OCR 再配一份 API Key 或模型端点。前置条件是本机装了 `ocr`（`npm install -g @alibaba-group/open-code-review`）与 Git ≥ 2.41；未装时 `ocr_review` 会直接给出安装指引而不是抛一个费解的错。
- **`security-audit` 的沙箱降级必须说明**：上游要求「执行被测代码」必须处在 OS 级沙箱（无外网、净化环境、只读目标与工具链、资源配额）之下。code-harness 只有审批闸门、进程超时与路径围栏，**没有**这些控制。因此按上游自己的规则，这里**不执行被测代码**，执行层结论一律记为 `needs_validation` 并给出安全验证方案；审计产物写在项目内 `.code-harness/audits/<repo>/run-N/`（上游默认的 `~/security-audit-skill/...` 在项目外，会被路径围栏拒绝）。

---

## 系统集成

### 开机启动

设置 → 关于 → **开机启动**，或者命令行：

```bash
npx electron tools/auto-launch.cjs status   # 查看当前状态与实际注册的命令
npx electron tools/auto-launch.cjs on
npx electron tools/auto-launch.cjs off
```

两个设计取舍值得说明：

- **以操作系统为准，不在 `settings.json` 里另存一份。** 你在 Windows「设置 → 启动应用」或 macOS「登录项」里关掉之后，应用会如实显示为「已关闭」，不会下次启动又偷偷加回来。
- **Windows 上写入用 Electron API、读取直接查注册表。** 这不是重复劳动：`app.getLoginItemSettings()` 在开发态（`electron .`）读回的是 `false`，而同一个注册表项用独立脚本读是 `true` —— 实测与 AppUserModelId、启动参数、应用名都无关。既然要把状态显示给用户看，就不能依赖它；顺手还能把真实注册的命令显示出来。

开发态与打包后的差异：开发态注册的是 `node_modules/electron/dist/electron.exe` **加上项目目录作为参数**（不带参数的话开机只会弹出一个空的 Electron），因此开机启动的是**已构建产物**（`out/`）——改了源码要先 `npm run build`。`npm run dist` 打包安装后会指向安装目录本身。换机器、移动项目目录后需要重新注册。

Linux 上 Electron 未提供登录项 API，开关会显示为不支持。

## 目录结构

```
code-harness/
├── electron.vite.config.ts     # main / preload / renderer 三份构建配置
├── electron-builder.yml        # 打包配置（nsis / zip、dmg、AppImage / deb）
├── tsconfig.{json,node,web}.json
├── scripts/ensure-electron.mjs # npm install 后补装 Electron 二进制（44+ 已无 postinstall）
├── tools/bootstrap.cmd         # Windows 一键引导（清 NODE_OPTIONS + 装依赖 + typecheck）
├── tools/seed-providers.cjs    # 批量注入 Provider 密钥（Electron 脚本，走 safeStorage 加密）
├── tools/auto-launch.cjs       # 命令行开关开机启动（status | on | off）
├── docs/ARCHITECTURE.md        # 架构说明：进程模型、回合链路、安全设计、扩展点
├── docs/PROVIDERS.md           # Provider 对接：实测模型 id、Base URL、踩坑清单
├── skill-packs/                # 内置第三方技能包（分发到用户项目，见其中的 README.md）
├── tests/                      # 单测：四条不变量（见「测试覆盖什么」）
└── src/
    ├── shared/                 # 跨进程契约（主进程 / preload / 渲染层共用）
    │   ├── types.ts            #   AgentMessage、ToolCall/Result、AgentEvent、AppSettings…
    │   ├── ipc.ts              #   通道名常量（主进程与 preload 共用，避免拼错字符串）
    │   ├── api.ts              #   CodeHarnessApi：暴露给渲染层的唯一接口面
    │   ├── presets.ts          #   内置 Provider 预置（只有 Base URL 与模型名，不含密钥）
    │   └── tool-groups.ts      #   审批分组：同类工具归一组，支撑「总是允许编辑文件」这类整类授权
    ├── preload/index.ts        # contextBridge 安全桥（不暴露 ipcRenderer 本身）
    ├── main/
    │   ├── index.ts            # 应用入口、单实例锁、生命周期
    │   ├── window.ts           # BrowserWindow 创建（无边框标题栏、CSP、外部链接拦截）
    │   ├── ipc/                # 按领域拆分的处理器
    │   │   ├── bus.ts          #   事件广播（AgentEvent / shell 输出 / todo）
    │   │   ├── workspace.ts    #   app / settings / projects / files / git / shell
    │   │   └── agent.ts        #   sessions / agent / skills / harness / scheduler
    │   ├── agent/
    │   │   ├── session.ts      # AgentSession：回合循环、工具执行、审批、压缩
    │   │   ├── runtime.ts      # 会话注册表、审批仲裁、子智能体派生、调度心跳
    │   │   ├── harness.ts      # 系统提示词装配
    │   │   ├── providers/      # openai / anthropic 适配（SSE 流式 + 工具增量）
    │   │   └── tools/          # 工具实现（fs / shell / git / agent 四组）
    │   ├── store/              # 持久化层（路径、原子 JSON、会话 JSONL 转录、技能、调度）
    │   └── util/               # exec（进程树、超时）、git、rrule、常驻 shell 运行器
    └── renderer/               # React 19 + 外部 store（useSyncExternalStore）
        ├── index.html          # 含 CSP：默认拒绝远程资源
        └── src/
            ├── App.tsx         # 骨架 + 全局快捷键
            ├── state/store.ts  # 状态、IPC 事件归并、全部动作
            ├── components/     # 侧栏 / 聊天 / 审批 / 四个面板 / 设置 / 命令面板
            └── styles/         # tokens / base / layout / panels
```

---

## 数据存放位置

应用数据目录（Windows `%APPDATA%\Code Harness`，macOS `~/Library/Application Support/Code Harness`，Linux `~/.config/Code Harness`）：

```
settings.json                 # 设置；API Key 用 Electron safeStorage 加密后落盘
projects.json                 # 项目列表
scheduler.json                # 定时任务
harness.json                  # 用户级 Harness（记忆 / 精炼 / 目标 / 快照）
trust.json                    # 项目信任决定（决定项目级资源是否注入上下文）
skills/                       # 用户级技能
sessions/
  index.json                  # 会话索引（标题、时间、消息数、当前分支指针 headId）
  transcripts/<id>.jsonl      # 单会话转录：树形条目，逐行追加、从不重写
```

项目内目录 `<项目>/.code-harness/`：项目级 Harness 与技能。是否提交进仓库由你决定——想跟随仓库走就提交，不想就加进 `.gitignore`。

**API Key 处理**：读盘时解密，写盘时加密（`safeStorage`）。如果系统密钥环不可用会自动降级为明文并在设置页提示。密钥**不会**进入转录文件，也**不会**发给除你配置的模型端点之外的任何地方。

---

## 安全模型

- **渲染层无 Node**：`contextIsolation: true`、`nodeIntegration: false`，渲染层只能调用 `preload` 里显式列出的方法；`ipcRenderer` 本身不外泄。
- **CSP**：`index.html` 里禁止远程脚本与远程样式，`connect-src` 只放开本地 dev server。
- **路径围栏**：所有文件工具把入参解析为绝对路径后校验是否在项目根内，`..` 越界直接拒绝。
- **审批默认开启**：`permissionMode` 默认 `ask`，写操作必须用户点头；`readonly` 模式直接不向模型暴露写工具。白名单按**类别**授权（分组定义在 `src/shared/tool-groups.ts`）：勾「编辑文件」只放开 `write_file` + `edit_file`，**不会**连带放开 `run_command`。
- **命令执行**：`run_command` 走审批，可逐条拒绝；子进程有超时，中止时连进程树一起终止。

---

## 与参考项目的关系

| 能力 | 来源 |
| --- | --- |
| 会话作为状态中心、转录与压缩、子智能体、Harness 演进 | prime-agent |
| Electron 桌面外壳、项目/会话管理、多面板工作区、命令面板、技能库 | gooey-pi |

本项目是**从零编写的独立实现**，不包含上述两个项目的代码；协议适配与工具层均为自研，只借鉴其架构思路。

> **名称与身份说明**：本仓库与 GitHub 上其它名称相近的 Agent 项目（例如 `badlogic/pi-mono`）
> **没有任何关联，也不是它们任何之一的 fork 或衍生仓库**。它的参考对象只有上表列出的这两个。
> 早期版本曾用过 `pi-agent` 这个名字，因为与上述项目过于接近而改名 —— 这里留个记录，
> 免得有人把它当成某个上游项目的第三方分支。

## 许可

MIT
