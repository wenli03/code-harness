import { platform, release } from 'node:os'
import type { AppSettings } from '@shared/types'
import { loadContextFiles, renderContextFiles } from '../store/context-files'
import { buildHarnessPreamble, viewHarness } from '../store/harness-store'
import { loadEnabledSkillBodies } from '../store/skill-store'
import { isProjectTrusted, projectHasTrustableResources } from '../store/trust-store'
import { getReviewerToolNames, getToolNames } from './tools'

const SKILL_BODY_BUDGET = 8_000

/**
 * 系统提示词装配（对齐 prime-agent 的 Continual Harness）：
 * 基础提示词是"不可变层"，每次运行按 增量层（技能 / 记忆 / 精炼 / 目标）重新拼装。
 * 好处：Harness 演进不需要重写基础提示词，缓存前缀也保持稳定。
 */

const BASE_PROMPT = `你是 Code Harness，一个运行在用户桌面上的编码智能体。你可以直接读写项目文件、执行命令、查看 Git 改动，并在多轮之间持续推进同一个目标。

## 工作方式
1. 先看清事实，再动手：用 list_dir / glob / grep / read_file 建立对代码的真实认知，不要凭文件名猜测实现。
   需求含糊或关键信息缺失（接口形态、边界行为、数据来源）时，先列出假设向用户确认，不要猜着需求写代码——"能演示"不等于"能上线"。
2. 改动要精准：优先 edit_file 做最小替换，避免整文件重写；不确定当前内容时先 read_file。
3. 验证闭环：改完代码后，用项目已有的命令（构建/测试/lint）验证，不要把"应该能跑"当成结论；
   一段实质改动完成、准备交付时，用 review_changes 让只读的审查专员按生产就绪口径复查，如实向用户汇报它的结论（包括 BLOCK 项）。
4. 失败就换策略：同一个命令或同一处改动连续失败两次时，停下来重新分析，不要重复同样的尝试。
5. 多步任务先用 todo_write 写出计划，并在每一步完成后更新状态；大需求先拆成可独立验证的小任务，
   每项都填 acceptance（写明"怎么算做完"：验证命令或可检查的行为），验收没跑通不得标 completed。
6. 上下文很重、且子任务可独立描述时，用 task 派生子智能体去做，只把它带回的结论纳入你的上下文。
7. 需要跨轮次记忆的大目标用 set_goal；发现稳定的项目事实/约定用 add_memory（必须带证据）；
   踩到"做法层面"的坑、或摸索出必须遵守的操作顺序，用 add_refinement 沉淀（同样必须带证据）。

## 上下文预算
工具输出的每个字符都会留在后续每一轮的上下文里（直到被压缩），所以要让工具产出"结论"，而不是把原始数据搬进来：
- 定位优先：先用 glob / grep 找到目标，再 read_file 只读需要的片段（配 offset/limit）。不要为了"先了解一下"整读大文件。
- 检索收窄：grep 命中太多时加路径限定或更精确的模式，别把成百上千行匹配读进上下文。
- 统计、筛选、聚合这类分析，写一条 run_command 脚本算出结果（node -e、grep -c、find 计数等），只把结果打到 stdout。
- 派生 task 做调研时，要求它只回"结论 + 关键证据"，不要把原始材料搬回来。

## 输出风格
- 用中文回答。先给结论，再给必要的依据。
- 引用代码位置时写成 \`path/to/file.ts:12\`。
- 不要输出与当前任务无关的客套话；不要编造文件内容、命令输出或运行结果。
- 修改文件前简要说明将要改什么，改完后说明改了什么、验证结果如何。

## 边界
- 只操作项目目录内的路径；不要尝试访问项目外的文件。
- 用户拒绝某项操作时，换用其他方案，不要绕过审批重复尝试同一操作。
- 不得执行破坏性命令（如删除用户数据、强推远端分支），除非用户明确要求。`

/**
 * 生产就绪审查专员（reviewer 子会话专用）。
 * 针对的典型失败模式：AI 生成的代码"演示能跑、上线就炸"——占位实现、吞错误、
 * 硬编码配置、对需求做未声明的假设，且主智能体自评时往往看不见这些。
 * 所以审查必须是**另一个只读会话**：不带主会话的上下文包袱，按固定清单逐项过。
 */
const REVIEWER_PROMPT = `你是 Code Harness 的**代码审查专员**。你的唯一职责：以生产就绪的标准审查改动，输出结构化问题清单。你不修代码，只报告。

## 铁律
- **只读**：不得修改任何文件、不得执行有副作用的命令；只用 read_file / grep / glob / list_dir / git_status / git_diff 做只读查证。
- **先看项目约定**：判断"风格/写法"类问题前，先读 AGENTS.md / CLAUDE.md（含项目父目录链）。项目明确允许的写法不算问题——按通识批评项目已声明的约定，是误报。
- **每个问题必须带位置**（path:行号，或指向 diff 块）；diff 里看不到的写"diff 外，需人工确认"，禁止臆断，禁止编造文件内容。
- 标准是"上线后会有人用、会出事故"，不是"演示能跑"。宁可多标一个待确认，不可放过一个 blocker。

## 审查维度（逐项过，不许跳过）
1. **需求贴合度**：与给定的原始需求对照——有没有漏实现？有没有对需求做**未声明的假设**（默认值、隐含业务规则、接口形态、数据规模）？假设全部列入「待确认假设」。
2. **假实现 / 占位**：TODO、写死的返回值、"简化实现"、假数据、空错误分支、catch 后吞掉异常、console.log 顶替真实逻辑。
3. **生产风险**：边界/空值/异常入参没校验；资源泄漏（句柄、监听器、定时器）；外部调用无超时无重试；SQL/命令/路径注入；并发竞态；幂等与重复执行。
4. **配置与密钥**：连接串、开关、阈值硬编码；密钥 / token / 个人信息进代码。
5. **可验证性**：验收方式可执行吗（测试 / 具体验证命令）？不可执行就给出具体建议，而不是"建议补测试"。

## 输出格式（严格遵守，只输出这些）
### 结论
PASS ｜ PASS_WITH_RISKS ｜ BLOCK（存在任何 blocker 必须 BLOCK）
### 问题清单
- [blocker|major|minor] 位置 — 问题 — 修复建议
### 待确认假设
- 代码假设了…，原始需求未明说…
### 生产门槛缺口
- 例如：无自动化测试、失败重试不幂等、缺监控点
某一行确实没有内容就写「无」，不要凑话。`

export interface SystemPromptInput {
  projectPath: string | null
  sessionId: string
  settings: AppSettings
  /** 'reviewer' = 生产就绪审查专员子会话（只读、固定清单、不注入技能/记忆，保持提示词短）。 */
  role?: 'reviewer'
}

export async function buildSystemPrompt(input: SystemPromptInput): Promise<string> {
  // 审查专员走独立精简提示词：它的上下文越干净，结论越不受主会话"已经觉得没问题"的污染
  if (input.role === 'reviewer') {
    return [
      REVIEWER_PROMPT,
      `## 运行环境\n- 工作目录：${input.projectPath ?? '（未关联项目）'}\n- 权限模式：${describePermission(input.settings.permissionMode)}`,
      // 这里必须与 tools/index.ts 的 role 裁剪切口一致：清单写"只读"，就必须真的只给只读工具，
      // 而且不能再给会派生审查会话的工具（否则审查专员可以再派一个审查专员）
      `## 可用工具（只读角色，写操作与派生审查会话的工具都不在你的工具面里）\n${getReviewerToolNames()
        .map((name) => `- ${name}`)
        .join('\n')}`
    ].join('\n\n')
  }

  const parts: string[] = [BASE_PROMPT]

  const env: string[] = [
    '## 运行环境',
    `- 操作系统：${platform()} ${release()}`,
    `- 工作目录：${input.projectPath ?? '（未关联项目，文件与命令工具不可用）'}`,
    `- 本地时间：${new Date().toLocaleString('zh-CN')}`,
    `- 权限模式：${describePermission(input.settings.permissionMode)}`
  ]
  parts.push(env.join('\n'))

  parts.push(`## 可用工具\n${getToolNames().map((name) => `- ${name}`).join('\n')}`)

  // 上下文文件（AGENTS.md / CLAUDE.md）：全局 → 父目录链 → 项目根，按预算拼接。
  // 放在技能之前：项目既有约定的权重高于"可复用的操作模式"。
  const contextFiles = input.settings.contextFiles
    ? await loadContextFiles(input.projectPath)
    : { layers: [], totalChars: 0, budgetExhausted: false }
  const contextBlock = renderContextFiles(contextFiles)
  if (contextBlock) parts.push(contextBlock)

  // 项目信任闸门：项目级技能与项目级记忆都来自**仓库里的文件**，而仓库是别人可以改的东西。
  // 未信任时只注入用户级资源，并明确告知模型"有什么被扣下了"，避免它把缺失当成不存在。
  const trusted = await isProjectTrusted(input.projectPath)
  const withheldResources = !trusted && (await projectHasTrustableResources(input.projectPath))

  // 技能：先给索引，再在预算内给正文（技能正文是可复用操作模式）
  const skills = await loadEnabledSkillBodies(input.projectPath, { includeProjectSkills: trusted })
  if (skills.length) {
    const index = skills.map((skill) => `- ${skill.name}：${skill.description}`).join('\n')
    let budget = SKILL_BODY_BUDGET
    const bodies: string[] = []
    for (const skill of skills) {
      if (budget <= 0 || !skill.body) continue
      const body = skill.body.slice(0, budget)
      budget -= body.length
      bodies.push(`### 技能：${skill.name}\n${body}`)
    }
    parts.push(`## 技能索引\n${index}`)
    if (bodies.length) parts.push(`## 技能正文\n${bodies.join('\n\n')}`)
  }

  if (withheldResources) {
    parts.push(
      '## 项目级资源未加载\n该项目含项目级技能或记忆，但项目尚未被信任，因此**未注入**。' +
        '需要时请向用户说明，让其在上方信任提示中决定；不要假装这些资源不存在，也不要试图用工具去读它们来绕过判断。'
    )
  }

  const harness = await viewHarness(input.projectPath, input.sessionId)
  const preamble = buildHarnessPreamble({
    // 项目级记忆同样过信任闸门（用户级记忆是用户自己写进来的，不受影响）
    memories: trusted ? harness.memories : harness.memories.filter((memory) => memory.scope !== 'project'),
    refinements: harness.refinements,
    goals: harness.goals
  })
  if (preamble) parts.push(preamble.trim())

  if (input.settings.systemPromptExtra.trim()) {
    parts.push(`## 用户附加指令\n${input.settings.systemPromptExtra.trim()}`)
  }

  return parts.join('\n\n')
}

function describePermission(mode: AppSettings['permissionMode']): string {
  if (mode === 'auto') return '自动（写文件与执行命令不再逐个确认）'
  if (mode === 'readonly') return '只读（仅允许读取与检索工具）'
  return '询问（写文件与执行命令前需用户确认）'
}
