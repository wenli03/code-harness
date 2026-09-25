import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentMessage,
  AgentStatus,
  AppSettings,
  Attachment,
  ProviderConfig,
  SessionMeta,
  TodoItem,
  TokenUsage,
  ToolCall,
  ToolResult
} from '@shared/types'
import { buildSystemPrompt } from './harness'
import { createProvider } from './providers'
import type { ChatProvider, ChatTurn, StreamEvent } from './providers'
import { executeTool, isToolAllowedForRole, toolSchemas } from './tools'
import type { ToolContext } from './tools'
import { pairToolResults } from './turn-pairing'
import { appendCompaction, appendMessage, updateSessionMeta } from '../store/session-store'
import { addMemory, addRefinement, setGoal } from '../store/harness-store'

/** 触发压缩的上下文规模（字符）。 */
const CONTEXT_CHAR_BUDGET = 160_000
/** 压缩后保留的最近消息条数。 */
const COMPACTION_KEEP = 14
/** 保留原文的工具输出条数（比这更早的工具输出会被截断）。 */
const KEEP_RECENT_TOOL_OUTPUTS = 6
/** 历史工具输出截断后保留的字符数。 */
const HISTORICAL_TOOL_OUTPUT_LIMIT = 1_500

/**
 * 截断「较早的工具输出」。
 *
 * 工具输出是上下文里绝对的大头：实测 27 个真实会话中，工具输出占全部内容的 **95.7%**，
 * 其中 read_file 一家就占 83%（290 次调用、单次均值约 1 万字符）。
 * 而它们的价值随时间快速衰减——模型在产生它的那一轮就已经用掉了，之后每一轮都在为它重复付费，
 * 还会挤占真正有用的历史（这正是「上下文塞满垃圾 → 被迫压缩 → 丢失关键状态」的起点）。
 *
 * 所以：最近几条保留原文（模型可能正在引用），更早的只留开头，并**明确告知可重新读取**，避免模型
 * 以为内容本来就这么短。实测该策略把最大会话的每轮上下文从 404K 降到 145K 字符（省 64%）。
 */
function clipHistoricalToolOutput(output: string, toolName: string): string {
  if (output.length <= HISTORICAL_TOOL_OUTPUT_LIMIT) return output
  return (
    output.slice(0, HISTORICAL_TOOL_OUTPUT_LIMIT) +
    `\n\n…[历史输出已截断] ${toolName} 本次原文共 ${output.length} 字符，此处只保留了前 ` +
    `${HISTORICAL_TOOL_OUTPUT_LIMIT} 字符。需要完整内容就重新调用该工具，并且只取需要的片段` +
    '（read_file 配 offset/limit、grep 收窄模式或限定 glob），不要整份读回来。]'
  )
}

/* ------------------------------------------------------------------ *
 * 压缩快照（本地生成，不调用模型）
 * ------------------------------------------------------------------ */

/** 快照各分区的上限。 */
const SNAPSHOT_LAST_REQUESTS = 3
const SNAPSHOT_REQUEST_CHARS = 300
const SNAPSHOT_MAX_FILES = 12
const SNAPSHOT_MAX_COMMANDS = 8
const SNAPSHOT_MAX_FAILURES = 8
const SNAPSHOT_COMMAND_CHARS = 160
const SNAPSHOT_FAILURE_CHARS = 220

/** 压成单行并限长——快照要的是可读的目录，不是原文。 */
function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** 取前 n 项渲染，超出时补一行说明（避免模型误以为"只有这些"）。 */
function take<T>(items: T[], limit: number, label: string, render: (item: T) => string): string[] {
  const shown = items.slice(0, limit).map(render)
  if (items.length > limit) shown.push(`- （另有 ${items.length - limit} 个${label}未列出）`)
  return shown
}

/**
 * 从「即将被压缩掉的历史」里提取结构化工作快照。
 *
 * 这里**刻意不调用模型**，替代掉原先「把最多 40K 字符的历史再发给模型做摘要」的做法，原因有三：
 *  ① 那是一次额外的模型调用，而它同样是**有损**的；失败时只能退化成一句「摘要生成失败」；
 *  ② 它要把最老的那段历史**整段重发**，正好是服务端内容审查最容易拦下来的部分
 *     （见 docs/PROVIDERS.md 坑 11：DashScope 会因此让整个会话每个回合都 400）；
 *  ③ 「压缩后必须知道的事」本来就是结构化事实——改过哪些文件、跑过哪些命令、什么失败了、
 *     用户最后要什么——从消息与工具调用记录里直接提取即可，零 token、确定性、不会失败。
 *
 * 边界划分：**滚动细节**由保留的最近若干条原文负责；**跨轮次的长期事实**由系统提示词里的
 * Harness（目标/记忆/精炼）负责——模型有 add_memory / add_refinement 这两个显式通道去沉淀它们。
 * 所以快照只需要覆盖"这一段的动作与状态"。
 */
function buildWorkSnapshot(messages: AgentMessage[], todos: TodoItem[]): string {
  const sections: string[] = []

  const requests = messages
    .filter((message) => message.role === 'user' && message.text.trim())
    .slice(-SNAPSHOT_LAST_REQUESTS)
  if (requests.length) {
    sections.push(
      `### 用户最近的诉求\n${requests.map((m) => `- ${oneLine(m.text, SNAPSHOT_REQUEST_CHARS)}`).join('\n')}`
    )
  }

  if (todos.length) {
    const lines = todos.map((todo) => {
      const base = `- [${todo.status === 'completed' ? 'x' : ' '}] ${oneLine(todo.content, 160)}`
      // 验收标准跟着清单进快照：压缩后模型仍知道"每一项要做什么才算完成"，拆掉的大需求不会因压缩失忆
      return todo.acceptance ? `${base}（验收：${oneLine(todo.acceptance, 120)}）` : base
    })
    sections.push(`### 任务清单（压缩时的状态）\n${lines.join('\n')}`)
  }

  const written = new Set<string>()
  const read = new Set<string>()
  const commands: string[] = []
  const failures: string[] = []

  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const args = (call.args ?? {}) as Record<string, unknown>
      const path = typeof args.path === 'string' ? args.path : ''
      if (call.name === 'write_file' || call.name === 'edit_file') {
        if (path) written.add(path)
      } else if (call.name === 'read_file') {
        if (path) read.add(path)
      } else if (call.name === 'run_command' && typeof args.command === 'string') {
        commands.push(oneLine(args.command, SNAPSHOT_COMMAND_CHARS))
      }
    }
    if (message.role === 'tool' && message.toolResult && !message.toolResult.ok) {
      failures.push(`${message.toolResult.name}: ${oneLine(message.toolResult.output, SNAPSHOT_FAILURE_CHARS)}`)
    }
  }

  if (written.size) {
    sections.push(
      `### 已修改的文件\n${take([...written], SNAPSHOT_MAX_FILES, '文件', (p) => `- ${p}`).join('\n')}`
    )
  }
  if (read.size) {
    sections.push(
      `### 读取/检索过的文件\n${take([...read], SNAPSHOT_MAX_FILES, '文件', (p) => `- ${p}`).join('\n')}`
    )
  }
  if (commands.length) {
    // 命令按时间倒序取最近的，旧的不影响继续工作
    const recent = [...commands].reverse()
    sections.push(
      `### 执行过的命令（最近在前）\n${take(recent, SNAPSHOT_MAX_COMMANDS, '命令', (c) => `- ${c}`).join('\n')}`
    )
  }
  if (failures.length) {
    sections.push(
      `### 失败的工具调用（避免重犯）\n${take(failures, SNAPSHOT_MAX_FAILURES, '失败记录', (f) => `- ${f}`).join('\n')}`
    )
  }

  if (!sections.length) return '（这一段历史里没有可提取的工作状态）'
  return sections.join('\n\n')
}

/** 落盘前剥离附件里的图片二进制，只保留名称与类型，避免转录文件膨胀。 */
function stripBinary(message: AgentMessage): AgentMessage {
  if (!message.attachments?.some((attachment) => attachment.dataUrl)) return message
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType
    }))
  }
}

export interface SubAgentRequest {
  parentSessionId: string
  projectPath: string | null
  prompt: string
  title?: string
  /** 角色化子会话：'reviewer' 使用生产就绪审查专用系统提示词（只读、不改文件）。 */
  role?: 'reviewer'
}

export interface AgentSessionOptions {
  meta: SessionMeta
  messages: AgentMessage[]
  getSettings: () => AppSettings
  getProvider: () => ProviderConfig | null
  emit: (event: AgentEvent) => void
  requestApproval: (call: ToolCall, reason: string) => Promise<boolean>
  spawnSubAgent: (request: SubAgentRequest) => Promise<string>
  onTodos: (sessionId: string, todos: TodoItem[]) => void
  /** 子会话角色（由 runtime 派生时传入）；主会话为 undefined。 */
  role?: 'reviewer'
}

/** 会话消息数组的字符规模（含工具输出），压缩触发与收益度量共用。 */
function contextSizeChars(messages: AgentMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + message.text.length + (message.toolResult?.output.length ?? 0) + 200,
    0
  )
}

/** 对发给模型的 turns 做成本归因：模型看不到我们，但我们要知道钱花在哪个分区。 */
function measureTurns(system: string, turns: ChatTurn[]): {
  systemChars: number
  historyChars: number
  toolOutputChars: number
  totalChars: number
} {
  let toolOutput = 0
  let history = 0
  for (const turn of turns) {
    if (turn.role === 'tool') {
      for (const result of turn.results) toolOutput += result.output.length
    } else {
      history += turn.text.length
    }
  }
  const systemChars = system.length
  return {
    systemChars,
    historyChars: history,
    toolOutputChars: toolOutput,
    totalChars: systemChars + history + toolOutput
  }
}

/**
 * 一个会话 = 一个可中断的智能体循环。
 * 状态中心是 this.messages（与 prime-agent 的 AgentSession 对齐）：
 * 模型看到的上下文、持久化转录、UI 渲染都源自这一个数组。
 */
export class AgentSession {
  readonly id: string
  meta: SessionMeta
  messages: AgentMessage[]
  status: AgentStatus = 'idle'
  todos: TodoItem[] = []

  private readonly options: AgentSessionOptions
  private controller: AbortController | null = null
  private readonly steering: string[] = []
  private running = false
  /** 待随下一个用户回合发送的图片附件（不落盘） */
  private pendingImages: Attachment[] = []

  /** 子会话角色：'reviewer' 走精简只读提示词；主会话为 undefined。 */
  readonly role: 'reviewer' | undefined

  constructor(options: AgentSessionOptions) {
    this.options = options
    this.id = options.meta.id
    this.meta = options.meta
    this.messages = options.messages
    this.role = options.role
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 追加一条跨轮次保持的指令；若正在运行会在下一次模型调用前注入。 */
  steer(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.steering.push(trimmed)
  }

  abort(): void {
    this.controller?.abort()
    this.emit({ type: 'status', sessionId: this.id, status: 'aborted', detail: '已被用户中止' })
  }

  async runTurn(prompt: string, attachments: Attachment[] = []): Promise<void> {
    if (this.running) throw new Error('该会话正在运行，请先中止或等待完成')

    this.running = true
    this.controller = new AbortController()
    const settings = this.options.getSettings()
    let usage: TokenUsage | null = null

    try {
      this.emit({ type: 'turn:start', sessionId: this.id })
      await this.pushMessage({ role: 'user', text: prompt, attachments })
      usage = await this.loop(settings)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'error', sessionId: this.id, message })
      this.setStatus('error')
    } finally {
      this.running = false
      this.controller = null
      // 图片只在本回合的各次模型调用间复用，回合结束即丢弃（下一条用户消息会重新设置）
      this.pendingImages = []
      if (this.status !== 'error') this.setStatus('idle')
      this.emit({ type: 'turn:end', sessionId: this.id, usage: usage ?? undefined })
    }
  }

  /* ---------------------------------------------------------------- *
   * 主循环
   * ---------------------------------------------------------------- */

  private async loop(settings: AppSettings): Promise<TokenUsage | null> {
    let usage: TokenUsage | null = null

    for (let step = 0; step < settings.maxStepsPerTurn; step += 1) {
      if (this.signal.aborted) {
        this.setStatus('aborted')
        return usage
      }

      const steerText = this.steering.shift()
      if (steerText) {
        await this.pushMessage({ role: 'user', text: `【用户插话】${steerText}` })
      }

      await this.maybeCompact(settings)

      const turn = await this.callModel(settings)
      if (turn.usage) usage = sumUsage(usage, turn.usage)
      if (this.signal.aborted) {
        this.setStatus('aborted')
        return usage
      }
      if (!turn.toolCalls.length) {
        return usage
      }

      // 中止后不再执行剩余调用，但**仍要为每一个调用写一条结果**。
      // assistant 的 tool_calls 必须逐个有 tool 消息应答（见 pairToolResults），
      // 这里若直接 return，就会在历史里留下「有 tool_calls、无 tool 消息」的孤儿记录 ——
      // 用户看到的现象是「点了一次中止，这个会话之后发什么都 400」。
      let aborted = false
      for (const call of turn.toolCalls) {
        const result: ToolResult = aborted
          ? {
              id: call.id,
              name: call.name,
              ok: false,
              output: '（用户已中止，这次调用没有执行）',
              durationMs: 0
            }
          : await this.runTool(call, settings)
        if (this.signal.aborted) aborted = true
        await this.pushMessage({ role: 'tool', text: '', toolResult: result })
      }
      if (aborted) {
        this.setStatus('aborted')
        return usage
      }
    }

    this.emit({
      type: 'error',
      sessionId: this.id,
      message: `已达到单轮最大工具步数（${settings.maxStepsPerTurn}），已停止以避免失控。可继续发消息让它接着做。`
    })
    return usage
  }

  /** 调用一次模型（流式），把增量推给 UI，并返回本轮产生的工具调用。 */
  private async callModel(
    settings: AppSettings
  ): Promise<{ toolCalls: ToolCall[]; usage: TokenUsage | null }> {
    const provider = this.resolveProvider(settings)
    const model = settings.activeModel || provider.config.models[0] || ''
    if (!model) throw new Error('未配置模型，请在设置中选择或填写模型名')

    const system = await buildSystemPrompt({
      projectPath: this.meta.projectPath,
      sessionId: this.id,
      settings,
      role: this.role
    })
    const { turns, foldedReads } = this.toTurns()
    const contextStats = measureTurns(system, turns)

    const assistant: AgentMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: '',
      toolCalls: [],
      createdAt: Date.now(),
      meta: { providerId: provider.config.id, model }
    }

    this.setStatus('thinking')
    this.emit({ type: 'message:start', sessionId: this.id, message: { ...assistant } })

    const toolCalls: ToolCall[] = []
    let usage: TokenUsage | null = null
    let stopReason = ''
    let streamError = ''

    const stream = provider.impl.stream(
      {
        model,
        system,
        turns,
        tools: toolSchemas(settings.permissionMode, this.role),
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        fastMode: settings.fastMode
      },
      this.signal
    )

    for await (const event of stream) {
      switch (event.type) {
        case 'text': {
          assistant.text += event.delta
          this.setStatus('streaming')
          this.emit({
            type: 'message:delta',
            sessionId: this.id,
            messageId: assistant.id,
            delta: event.delta
          })
          break
        }
        case 'reasoning': {
          assistant.reasoning = `${assistant.reasoning ?? ''}${event.delta}`
          this.emit({
            type: 'reasoning:delta',
            sessionId: this.id,
            messageId: assistant.id,
            delta: event.delta
          })
          break
        }
        case 'tool_call': {
          toolCalls.push(event.call)
          break
        }
        case 'usage': {
          usage = event.usage
          break
        }
        case 'done': {
          stopReason = event.stopReason
          break
        }
        case 'error': {
          streamError = event.message
          break
        }
        default:
          break
      }
    }

    if (streamError) {
      this.setStatus('error')
      this.emit({ type: 'error', sessionId: this.id, message: streamError })
    }

    // 上下文成本归因：把本次调用实际发出的字符按分区（系统/历史/工具输出）记账，
    // 治理是否有效要用数字说话，不靠感觉。
    this.emit({
      type: 'context:stats',
      sessionId: this.id,
      ...contextStats,
      foldedReads,
      inputTokens: usage?.inputTokens
    })

    // 流式报错时这批工具调用不会被执行：若把 toolCalls 原样落盘，就成了「有 tool_calls、
    // 无 tool 消息」的孤儿记录，会让该会话此后每一轮都 400（见 pairToolResults）。
    // 这里只保留文本；文本也为空时 toTurns 会整条跳过，不会留下空 assistant 消息。
    assistant.toolCalls = streamError ? [] : toolCalls
    assistant.meta = { ...assistant.meta, usage: usage ?? undefined, stopReason }
    this.messages.push(assistant)
    const meta = await appendMessage(this.id, assistant)
    if (meta) {
      this.meta = meta
      this.options.emit({ type: 'session:updated', session: meta })
    }
    this.emit({ type: 'message:end', sessionId: this.id, message: assistant })

    // 流错误已通过 error 事件上报，这里返回空工具列表让循环自然结束（避免重复报错）
    return { toolCalls: streamError ? [] : toolCalls, usage }
  }

  /* ---------------------------------------------------------------- *
   * 工具执行
   * ---------------------------------------------------------------- */

  private async runTool(call: ToolCall, settings: AppSettings): Promise<ToolResult> {
    const started = Date.now()
    this.setStatus('tool')
    this.emit({ type: 'tool:start', sessionId: this.id, call })

    const ctx: ToolContext = {
      sessionId: this.id,
      projectPath: this.meta.projectPath,
      signal: this.signal,
      requestApproval: async (target, reason) => {
        if (settings.permissionMode === 'auto') return true
        if (settings.autoApproveTools.includes(target.name)) return true
        if (settings.permissionMode === 'readonly') return false
        this.setStatus('waiting-approval')
        // 用户可能在等待审批时点「中止」：等待必须可被打断，否则会话会永久卡在 running
        const approved = await raceWithAbort(this.options.requestApproval(target, reason), this.signal)
        this.setStatus('tool')
        return approved
      },
      log: (level, message) => {
        this.emit({ type: 'status', sessionId: this.id, status: 'tool', detail: `${level}: ${message}` })
      },
      spawnSubAgent: (input) =>
        this.options.spawnSubAgent({
          parentSessionId: this.id,
          projectPath: this.meta.projectPath,
          prompt: input.prompt,
          title: input.title,
          role: input.role
        }),
      setTodos: (todos) => {
        this.todos = todos
        this.options.onTodos(this.id, todos)
      },
      getTodos: () => this.todos,
      setGoal: async (text) => {
        await setGoal(this.meta.projectPath, this.id, text)
      },
      rememberMemory: async ({ text, evidence }) => {
        await addMemory({ projectPath: this.meta.projectPath, text, evidence, source: 'user' })
      },
      rememberRefinement: async ({ text, evidence }) => {
        await addRefinement({ projectPath: this.meta.projectPath, text, evidence })
      }
    }

    // 审查专员是只读角色：工具清单已被裁成只读，但模型仍可能凭上下文调一个不在清单里的工具名
    // （或工具名来自更早的会话记忆），所以执行层必须再挡一道——否则"只读审查"只是提示词承诺。
    const result =
      this.role === 'reviewer' && !isToolAllowedForRole(call.name, this.role)
        ? {
            ok: false,
            output: `审查会话是只读角色，不允许调用 ${call.name}。请只使用只读工具查证，并在报告中说明需要人工确认的部分。`,
            truncated: false
          }
        : await executeTool(call, ctx)
    const toolResult: ToolResult = {
      id: call.id,
      name: call.name,
      ok: result.ok,
      output: result.output,
      durationMs: Date.now() - started,
      truncated: result.truncated
    }
    this.emit({ type: 'tool:end', sessionId: this.id, result: toolResult })
    this.setStatus(this.signal.aborted ? 'aborted' : 'thinking')
    return toolResult
  }

  /* ---------------------------------------------------------------- *
   * 上下文压缩
   * ---------------------------------------------------------------- */

  private async maybeCompact(settings: AppSettings): Promise<void> {
    if (settings.contextCompaction === 'off') return
    // 规模必须把**工具输出**算进去：它通常是上下文的绝对大头（实测一个长会话共 351K 字符里，
    // 工具输出占 309K）。只算 message.text 会低估近一个数量级，后果是压缩几乎永不触发、
    // 历史无限膨胀——既持续烧 token，也会让早期的一段内容被每一轮原样重发。
    const size = contextSizeChars(this.messages)
    if (size < CONTEXT_CHAR_BUDGET || this.messages.length <= COMPACTION_KEEP + 4) return

    let cut = this.messages.length - COMPACTION_KEEP
    // 切点不能落在 assistant(tool_calls) 与它的 tool 结果之间：否则 recent 会以孤儿 tool 结果开头，
    // OpenAI 与 Anthropic 都会直接判 400（tool 消息必须紧跟在对应的 tool_calls 之后）。
    while (cut < this.messages.length && this.messages[cut].role === 'tool') cut += 1

    const older = this.messages.slice(0, cut)
    const recent = this.messages.slice(cut)
    // 本地生成快照：不调用模型，因此压缩不再有模型调用成本，也不会被服务端拒绝
    const summary = buildWorkSnapshot(older, this.todos)

    const summaryMessage: AgentMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: `【历史工作快照】已省略前 ${older.length} 条历史消息。\n\n${summary}`,
      createdAt: Date.now(),
      meta: { stopReason: 'compaction' }
    }
    const before = size
    this.messages = [summaryMessage, ...recent]
    const freedChars = Math.max(0, before - contextSizeChars(this.messages))

    // **只追加一个压缩标记，不重写转录**：被折叠的原始条目全部留在 JSONL 里，
    // 界面上仍可回溯到它们（对齐上游的 appendCompaction 语义）。
    // 旧实现是 replaceMessages —— 那会把历史真正删掉，压缩一次就永久失去前半段对话。
    const saved = await appendCompaction(this.id, {
      summary: summaryMessage.text,
      upToId: older.length ? older[older.length - 1].id : null,
      charsBefore: before,
      freedChars
    })
    if (saved) {
      this.meta = saved
      this.options.emit({ type: 'session:updated', session: saved })
    }

    this.emit({
      type: 'compaction',
      sessionId: this.id,
      removedMessages: older.length,
      // 压缩收益记账：释放的字符数（治理效果的可测口径）
      freedChars,
      summary
    })
  }

  /* ---------------------------------------------------------------- *
   * 辅助
   * ---------------------------------------------------------------- */

  private get signal(): AbortSignal {
    if (!this.controller) this.controller = new AbortController()
    return this.controller.signal
  }

  private resolveProvider(settings: AppSettings): { config: ProviderConfig; impl: ChatProvider } {
    const config =
      settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0] ?? null
    if (!config) throw new Error('尚未配置任何 Provider，请打开设置添加 API Key')
    if (!config.apiKey) throw new Error(`Provider「${config.name}」缺少 API Key`)
    return { config, impl: createProvider(config) }
  }

  private async pushMessage(input: {
    role: AgentMessage['role']
    text: string
    attachments?: Attachment[]
    toolResult?: ToolResult
  }): Promise<AgentMessage> {
    const images = (input.attachments ?? []).filter((a) => a.dataUrl)
    const textParts = [
      input.text,
      ...(input.attachments ?? []).filter((a) => a.text).map((a) => `[附件 ${a.name}]\n${a.text}`)
    ].filter(Boolean)

    const message: AgentMessage = {
      id: randomUUID(),
      role: input.role,
      text: textParts.join('\n\n'),
      createdAt: Date.now(),
      toolResult: input.toolResult,
      attachments: input.attachments?.length
        ? input.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, dataUrl: a.dataUrl }))
        : undefined
    }
    // 图片只在本次模型调用时随回合传递；转录只留文本与附件元数据，避免存储膨胀
    if (images.length) this.pendingImages = images

    this.messages.push(message)
    const meta = await appendMessage(this.id, stripBinary(message))
    if (meta) {
      this.meta = meta
      this.options.emit({ type: 'session:updated', session: meta })
    }
    this.emit({ type: 'message:end', sessionId: this.id, message })
    return message
  }

  /**
   * 把消息数组映射为 Provider 无关的回合序列。
   * 两级控本：①旧工具输出截断（内容在场、体积受控、可重取）；
   * ②重复读取折叠——同一文件被 read_file 读过不止一次时，旧的那几次已被最新读取
   * 取代，留着纯属每轮重复付费（实测 read_file 占全部上下文的 83%，重复读取是最大单头）。
   */
  private toTurns(): { turns: ChatTurn[]; foldedReads: number } {
    const turns: ChatTurn[] = []
    // 图片挂在「最后一条 user 消息」上，并在本回合的每次模型调用中都带上
    const images = this.pendingImages.length
      ? this.pendingImages.map((attachment) => ({
          mimeType: attachment.mimeType,
          dataUrl: attachment.dataUrl as string
        }))
      : undefined
    const imageAnchor = images ? this.messages.findLastIndex((message) => message.role === 'user') : -1

    // toolResult 本身不带调用参数，从 assistant 消息的 toolCalls 反查 callId → {工具名, path}
    const callArgs = new Map<string, { name: string; path?: string }>()
    for (const message of this.messages) {
      for (const call of message.toolCalls ?? []) {
        const path = (call.args as Record<string, unknown> | undefined)?.path
        callArgs.set(call.id, { name: call.name, path: typeof path === 'string' ? path : undefined })
      }
    }
    // 每个 read_file 路径的「最后一次输出」所在消息下标；比它早的同路径输出全部折叠
    const lastReadIndex = new Map<string, number>()
    for (let index = 0; index < this.messages.length; index += 1) {
      const message = this.messages[index]
      if (message.role !== 'tool' || !message.toolResult) continue
      const args = callArgs.get(message.toolResult.id)
      if (args?.name === 'read_file' && args.path) lastReadIndex.set(args.path, index)
    }

    // 找出「保留原文」的分界线：只有最后 KEEP_RECENT_TOOL_OUTPUTS 条工具输出不截断。
    // 注意是按工具消息计数，而不是按消息总数——否则一次多工具并行就会把窗口吃掉。
    const toolPositions: number[] = []
    for (let index = 0; index < this.messages.length; index += 1) {
      if (this.messages[index].role === 'tool') toolPositions.push(index)
    }
    const clipBefore =
      toolPositions.length > KEEP_RECENT_TOOL_OUTPUTS
        ? toolPositions[toolPositions.length - KEEP_RECENT_TOOL_OUTPUTS]
        : Number.POSITIVE_INFINITY

    let foldedReads = 0
    for (let index = 0; index < this.messages.length; index += 1) {
      const message = this.messages[index]

      if (message.role === 'user') {
        turns.push({
          role: 'user',
          text: message.text,
          images: index === imageAnchor ? images : undefined
        })
        continue
      }

      if (message.role === 'assistant') {
        // 流中断会留下「既无文本也无工具调用」的空 assistant 消息，必须剔除：
        // 它会被映射成 content 与 tool_calls 双空，OpenAI 直接判 400。
        if (!message.text.trim() && !message.toolCalls?.length) continue
        turns.push({ role: 'assistant', text: message.text, toolCalls: message.toolCalls ?? [] })
        continue
      }

      if (message.role === 'tool' && message.toolResult) {
        const last = turns[turns.length - 1]
        const { id, name, output } = message.toolResult
        const args = callArgs.get(id)
        const superseded =
          name === 'read_file' && args?.path !== undefined && lastReadIndex.get(args.path) !== index
        let clipped: string
        if (superseded) {
          foldedReads += 1
          clipped = `[折叠] 这是对 ${args?.path ?? '?'} 的一次旧读取，同文件已有更新的读取结果，内容以最新一次为准；确需旧版本时重新调用 read_file。`
        } else {
          clipped = index < clipBefore ? clipHistoricalToolOutput(output, name) : output
        }
        const entry = {
          id,
          name,
          output: clipped,
          ok: message.toolResult.ok
        }
        // 相邻的多个工具结果合并成一个回合（Anthropic 要求 tool_result 紧凑跟随 tool_use）
        if (last && last.role === 'tool') last.results.push(entry)
        else turns.push({ role: 'tool', results: [entry] })
      }
    }
    // 最后一道：配平 tool_calls 与 tool 结果（见 pairToolResults 的说明）
    return { turns: pairToolResults(turns), foldedReads }
  }

  private setStatus(status: AgentStatus, detail?: string): void {
    if (this.status === status && !detail) return
    this.status = status
    this.emit({ type: 'status', sessionId: this.id, status, detail })
  }

  private emit(event: AgentEvent): void {
    this.options.emit(event)
  }
}

function sumUsage(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  if (!a) return b
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0)
  }
}

/**
 * 让一个等待中的 Promise 可被中止：中止时以 false 结束。
 * 不改动原 Promise（它由 runtime 的审批表持有，会在用户应答或中止时被 resolve），
 * 只是不再让智能体循环无限等下去。
 */
function raceWithAbort(promise: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (value: boolean): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    promise.then(settle, () => settle(false))
  })
}
