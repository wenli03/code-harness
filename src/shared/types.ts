/**
 * 跨进程共享类型：主进程（Agent 内核）、preload、渲染层共用同一份契约。
 * 设计对齐两个参考项目：
 *  - prime-agent：AgentSession 是状态中心（transcript / 工具 / compaction / goals / 子会话）
 *  - gooey-pi：桌面工作区（项目、会话、面板、调度、技能、设置）
 */

/* ------------------------------------------------------------------ *
 * 消息与工具
 * ------------------------------------------------------------------ */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** 模型返回的原始参数串（JSON 解析失败时保留，便于排障） */
  raw?: string
}

export interface ToolResult {
  id: string
  name: string
  ok: boolean
  output: string
  durationMs: number
  /** 输出被截断 */
  truncated?: boolean
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
}

export interface MessageMeta {
  providerId?: string
  model?: string
  usage?: TokenUsage
  stopReason?: string
}

export interface AgentMessage {
  id: string
  role: Role
  /** 纯文本（assistant 可能为空，仅有 toolCalls） */
  text: string
  /** assistant 请求的工具调用 */
  toolCalls?: ToolCall[]
  /** role === 'tool' 时的执行结果 */
  toolResult?: ToolResult
  /** 推理摘要（支持 reasoning 的模型） */
  reasoning?: string
  /** 用户消息携带的附件（图片 dataUrl 仅存活于内存，落盘时只保留名称与类型） */
  attachments?: Attachment[]
  createdAt: number
  meta?: MessageMeta
}

/* ------------------------------------------------------------------ *
 * JSON Schema（工具参数）
 * ------------------------------------------------------------------ */

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

export interface JsonSchema {
  type: JsonSchemaType
  description?: string
  enum?: string[]
  /** 数组元素 schema；允许直接内联对象 schema（工具参数常见的嵌套结构）。 */
  items?: JsonSchema | JsonSchemaObject
  /** 内联对象 schema 的属性表（与 JsonSchemaObject 同形，避免嵌套时必须拆成具名类型）。 */
  properties?: Record<string, JsonSchema>
  required?: string[]
  default?: unknown
}

export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolSchema {
  name: string
  description: string
  parameters: JsonSchemaObject
  /**
   * 只读工具即使 permissionMode=readonly 也允许。
   * 注意：审批不在这里声明 —— 有副作用的工具必须在 run() 里显式调用
   * ctx.requestApproval(call, reason)，这样审批提示才能带上工具自己的上下文。
   */
  readOnly?: boolean
  /**
   * 该工具会派生**新的审查子会话**（review_changes / ocr_review 这类）。
   * 只读角色（reviewer）不得持有它：只读工具本来就能进 reviewer 的工具面，
   * 不排除的话审查专员可以再派一个审查专员，形成自我递归。
   */
  reviewerExcluded?: boolean
}

/* ------------------------------------------------------------------ *
 * Provider（BYOK）
 * ------------------------------------------------------------------ */

export type ProviderKind = 'openai' | 'anthropic' | 'openai-compatible'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  models: string[]
  headers?: Record<string, string>
}

export interface ProviderStatus {
  id: string
  name: string
  kind: ProviderKind
  configured: boolean
  reachable: boolean | null
  detail?: string
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

export type PermissionMode = 'ask' | 'auto' | 'readonly'
export type ReasoningEffort = 'low' | 'medium' | 'high'
export type ThemeMode = 'light' | 'dark' | 'system'

export interface AppSettings {
  providers: ProviderConfig[]
  activeProviderId: string
  activeModel: string
  temperature: number
  maxTokens: number
  reasoningEffort: ReasoningEffort
  fastMode: boolean
  theme: ThemeMode
  fontSize: number
  reduceMotion: boolean
  permissionMode: PermissionMode
  /** 自动批准的工具（白名单） */
  autoApproveTools: string[]
  contextCompaction: 'auto' | 'off'
  /** 单轮最多工具步数，防止失控 */
  maxStepsPerTurn: number
  /** 追加到系统提示词的额外指令 */
  systemPromptExtra: string
  /** 内置浏览器/外部链接是否放行 */
  allowExternalLinks: boolean
  /**
   * 是否加载上下文文件（AGENTS.md / CLAUDE.md：全局 + 项目父目录链 + 项目根）。
   * 对齐上游 pi 的惯例；关掉后只有 systemPromptExtra 起作用。
   */
  contextFiles: boolean
  /**
   * 本地决策引擎（laya）仓库路径——含 mcp/laya_mcp.py 的那一层目录。
   * 留空表示不显式配置，此时按「项目目录 → 项目内 laya/ → 项目同级 laya/」自动探测。
   * 不内置一个默认绝对路径：仓库位置因机器而异，写死等于把某台机器的目录结构带给所有人。
   */
  layaRepoPath: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  providers: [],
  activeProviderId: '',
  activeModel: '',
  temperature: 0.2,
  maxTokens: 8192,
  reasoningEffort: 'medium',
  fastMode: false,
  theme: 'system',
  fontSize: 14,
  reduceMotion: false,
  permissionMode: 'ask',
  autoApproveTools: [],
  contextCompaction: 'auto',
  maxStepsPerTurn: 40,
  systemPromptExtra: '',
  allowExternalLinks: true,
  contextFiles: true,
  layaRepoPath: ''
}

/**
 * 「最大输出 tokens」的允许范围。
 *
 * 这个值只来自用户输入，但各家服务端都会校验它：填超了会让**每个回合都 400**
 * （DashScope 的原文是 `Range of max_tokens should be [1, 131072]`），而且错在请求参数上，
 * 模型根本没机会被调用。所以落盘与展示前都必须收敛，不能只判断「是不是数字」。
 */
export const MIN_OUTPUT_TOKENS = 1
/**
 * 上限取 131072 —— 这是实测过的最宽松的服务端约束。
 * 注意它**不是**所有厂商都接受：DeepSeek 系只到 8192，所以默认值仍然是保守的 8192，
 * 调高前请确认当前 Provider 的模型支持。
 */
export const MAX_OUTPUT_TOKENS = 131_072

/** 把输出上限收敛到服务端普遍接受的范围；非法输入回退到默认值而不是丢弃。 */
export function clampMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.maxTokens
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.floor(value)))
}

/* ------------------------------------------------------------------ *
 * 项目 / 会话
 * ------------------------------------------------------------------ */

export interface ProjectRecord {
  id: string
  path: string
  name: string
  addedAt: number
  lastOpenedAt: number
}

export interface SessionMeta {
  id: string
  title: string
  projectPath: string | null
  createdAt: number
  updatedAt: number
  archived: boolean
  providerId: string
  model: string
  /** 当前分支上模型可见的消息条数（不是转录条目总数） */
  messageCount: number
  /** 子智能体会话的父会话 id */
  parentId: string | null
  /** 该会话是否为子智能体（不直接在侧栏展示） */
  isSubAgent: boolean
  /**
   * 树形转录的**当前指针**：本分支叶子条目的 id。
   * 旧版本会话没有这个字段（读取时归一化为 null，按"线性转录的最后一条"处理）。
   */
  headId: string | null
  /** 当前分支之外还有几个分支尖（0 = 没分叉过）。派生值，仅供列表展示。 */
  branchCount?: number
}

/* ------------------------------------------------------------------ *
 * 转录（树形 JSONL）
 *
 * 三种条目进同一份 append-only 文件，`id` / `parentId` 让它可以长出分支：
 *  - message：一条 AgentMessage
 *  - context-edit：把某条消息对**模型**隐藏/恢复（文件不动、UI 里仍在）
 *  - compaction：此前的历史由 summary 代表（原始条目仍留在文件里，可回溯）
 * ------------------------------------------------------------------ */

export type TranscriptEntryKind = 'message' | 'context-edit' | 'compaction'

export interface TranscriptEntry {
  id: string
  parentId: string | null
  kind: TranscriptEntryKind
  createdAt: number
  /** kind === 'message' */
  message?: AgentMessage
  /** kind === 'context-edit'：作用对象 */
  targetId?: string
  /** kind === 'context-edit'：false = 从模型上下文隐藏 */
  visible?: boolean
  /** kind === 'compaction' */
  summary?: string
  /** kind === 'compaction'：被折叠到的位置（审计与 UI 展示用；投影以条目位置为准） */
  upToId?: string | null
  /** kind === 'compaction'：压缩前的字符规模 / 释放的字符数 */
  charsBefore?: number
  freedChars?: number
}

/** 一个分支尖（叶子条目）：/tree 切换分支的最小信息。 */
export interface BranchTip {
  id: string
  createdAt: number
  /** 该分支尖对应的消息预览（不是消息条目时退化为种类名） */
  preview: string
  kind: TranscriptEntryKind
  isActive: boolean
}

/** 会话转录视图：UI 渲染当前分支 + 切换其它分支 + 标记隐藏项所需的全部信息。 */
export interface SessionTranscriptView {
  sessionId: string
  headId: string | null
  /** 当前分支上的条目（含被隐藏的、含压缩标记） */
  entries: TranscriptEntry[]
  /** 对模型隐藏的条目 id */
  hiddenIds: string[]
  /** 全部分支尖（含当前分支） */
  branches: BranchTip[]
}

/* ------------------------------------------------------------------ *
 * Agent 运行状态与事件
 * ------------------------------------------------------------------ */

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool'
  | 'waiting-approval'
  | 'aborted'
  | 'error'

export interface ApprovalRequest {
  id: string
  sessionId: string
  call: ToolCall
  reason: string
  createdAt: number
}

export interface Attachment {
  name: string
  mimeType: string
  /** data URL（图片）或文本内容 */
  dataUrl?: string
  text?: string
}

export type AgentEvent =
  | { type: 'session:created'; session: SessionMeta }
  | { type: 'session:updated'; session: SessionMeta }
  | { type: 'turn:start'; sessionId: string }
  | { type: 'message:start'; sessionId: string; message: AgentMessage }
  | { type: 'message:delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'reasoning:delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'message:end'; sessionId: string; message: AgentMessage }
  | { type: 'tool:start'; sessionId: string; call: ToolCall }
  | { type: 'tool:end'; sessionId: string; result: ToolResult }
  | { type: 'turn:end'; sessionId: string; usage?: TokenUsage; stopReason?: string }
  | { type: 'compaction'; sessionId: string; removedMessages: number; freedChars: number; summary: string }
  /** 每次模型调用前发出的上下文成本归因快照（字符估算，用于定位"钱花在哪"）。 */
  | {
      type: 'context:stats'
      sessionId: string
      systemChars: number
      historyChars: number
      toolOutputChars: number
      totalChars: number
      /** 本次调用中被"更新的读取"取代而折叠掉的重复读取条数。 */
      foldedReads: number
      /** 服务端回传的真实输入 token（provider 支持时才有）。 */
      inputTokens?: number
    }
  | { type: 'subagent'; sessionId: string; child: SessionMeta; state: 'spawned' | 'done' | 'error' }
  | { type: 'approval:request'; request: ApprovalRequest }
  | { type: 'approval:resolved'; requestId: string; approved: boolean }
  | { type: 'status'; sessionId: string; status: AgentStatus; detail?: string }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'sessions:changed' }
  | { type: 'scheduler:changed' }

/* ------------------------------------------------------------------ *
 * Harness（持续 Harness：记忆 / 精炼 / 目标 / 快照）
 * ------------------------------------------------------------------ */

export interface HarnessMemory {
  id: string
  scope: 'user' | 'project'
  text: string
  evidence: string
  source: 'user' | 'refine'
  createdAt: number
}

export interface HarnessRefinement {
  id: string
  text: string
  evidence: string
  active: boolean
  createdAt: number
}

export interface Goal {
  id: string
  sessionId: string
  text: string
  status: 'active' | 'paused' | 'done'
  createdAt: number
  updatedAt: number
}

export interface HarnessSnapshot {
  id: string
  reason: string
  createdAt: number
  memoryCount: number
  refinementCount: number
}

export interface HarnessView {
  memories: HarnessMemory[]
  refinements: HarnessRefinement[]
  goals: Goal[]
  snapshots: HarnessSnapshot[]
  /** 拼装后实际注入系统提示词的内容长度 */
  injectedChars: number
}

/* ------------------------------------------------------------------ *
 * 调度（周期 / 定时重入会话）
 * ------------------------------------------------------------------ */

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  projectPath: string | null
  sessionId: string | null
  /** iCalendar RRULE，例如 FREQ=DAILY;BYHOUR=9;BYMINUTE=0 */
  rrule: string
  enabled: boolean
  createdAt: number
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: string
}

/* ------------------------------------------------------------------ *
 * 技能（Skills）
 * ------------------------------------------------------------------ */

export interface SkillRecord {
  id: string
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
  enabled: boolean
  /**
   * 技能来自哪一类目录：
   * - `native`：code-harness 自己的目录（`<项目>/.code-harness/skills`、应用数据目录 `skills/`），可增删改；
   * - `agents` / `pi`：跨工具约定目录（`.agents/skills`、`.pi/skills`，含父目录链与用户主目录），
   *   **只读来源**——它们可能同时被别的工具使用，本应用不改写其中的文件。
   */
  origin: 'native' | 'agents' | 'pi'
  /** 是否可编辑（可切换启用 / 删除）。只读来源为 false，界面上不提供修改入口。 */
  editable: boolean
}

/** 项目信任决定：`always` 注入项目级资源；`never` 永不注入；未记录 = 需要时询问。 */
export type TrustDecision = 'always' | 'never'

export interface TrustState {
  /** 归一化后的项目路径 → 决定 */
  decisions: Record<string, TrustDecision>
  file: string
}

/** 某个项目当前的信任情况（渲染层据此决定是否弹提示）。 */
export interface ProjectTrustInfo {
  projectPath: string
  decision: TrustDecision | null
  /** 该项目是否含项目级资源（没有就不必打扰用户） */
  hasResources: boolean
  /** 项目级资源当前是否真的参与提示词装配（= decision === 'always'） */
  injected: boolean
}

/* ------------------------------------------------------------------ *
 * 文件 / Git / 终端
 * ------------------------------------------------------------------ */

export interface FileNode {
  name: string
  /** 相对项目根的 POSIX 路径 */
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: FileNode[]
}

export interface FileReadResult {
  path: string
  content: string
  truncated: boolean
  lines: number
}

export interface GitFileChange {
  path: string
  /** porcelain XY 状态，如 ' M' / 'M ' / '??' */
  x: string
  y: string
  staged: boolean
  untracked: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  files: GitFileChange[]
  clean: boolean
  error?: string
}

export interface ShellRunRequest {
  projectPath: string
  command: string
  cwd?: string
}

export interface ShellChunk {
  runId: string
  stream: 'stdout' | 'stderr'
  data: string
}

export interface ShellExit {
  runId: string
  code: number | null
  signal: string | null
  durationMs: number
}

/* ------------------------------------------------------------------ *
 * 待办（Agent 的 todo 工具，与 UI 同步）
 * ------------------------------------------------------------------ */

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  /** 该项的验收标准：怎么算做完（可执行的验证命令 / 可检查的行为）。未跑通验收不得标 completed。 */
  acceptance?: string
}

/** 开机启动（系统登录项）的**实际**状态；以操作系统为准，不落 settings.json。 */
export interface AutoLaunchState {
  /** 当前平台是否支持（Windows / macOS 支持，Linux 不支持） */
  supported: boolean
  enabled: boolean
  /** 已注册的启动命令（Windows 可读，便于排查），未注册时为空串 */
  command: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
  userDataPath: string
  workspaceRoot: string | null
  /** 是否为打包后的安装版（false = 开发态 `electron .`）；影响开机启动注册的可执行文件 */
  isPackaged: boolean
}
