import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentStatus,
  AppSettings,
  ApprovalRequest,
  Attachment,
  SessionMeta,
  TodoItem,
  ToolCall
} from '@shared/types'
import { AgentSession, type SubAgentRequest } from './session'
import {
  createSession,
  getSessionMessages,
  getSessionMeta,
  updateSessionMeta
} from '../store/session-store'
import { loadSettings, saveSettings } from '../store/settings-store'
import { configureLaya } from './laya/client'
import { expandApprovalTools } from '@shared/tool-groups'
import { listTasks, markRun, updateTask } from '../store/scheduler-store'

/** 子智能体最大嵌套深度：防止 task 工具无限自我派生。 */
const MAX_SUBAGENT_DEPTH = 2
const SCHEDULER_TICK_MS = 30_000

type Emitter = (event: AgentEvent) => void

/**
 * 运行时（对齐 prime-agent 的 daemon：常驻、拥有全部会话、负责审批与调度）。
 */
class AgentRuntime {
  private emitter: Emitter | null = null
  private readonly sessions = new Map<string, AgentSession>()
  private readonly approvals = new Map<string, { resolve: (approved: boolean) => void; request: ApprovalRequest }>()
  private readonly depths = new Map<string, number>()
  private readonly todos = new Map<string, TodoItem[]>()
  private schedulerTimer: NodeJS.Timeout | null = null
  private running = new Set<string>()

  setEmitter(emitter: Emitter): void {
    this.emitter = emitter
  }

  emit(event: AgentEvent): void {
    try {
      this.emitter?.(event)
    } catch {
      // 渲染层可能已销毁，忽略
    }
  }

  /* ---------------------------------------------------------------- *
   * 会话装载
   * ---------------------------------------------------------------- */

  async ensure(sessionId: string): Promise<AgentSession> {
    const cached = this.sessions.get(sessionId)
    if (cached) return cached

    // 兜底：设置快照为空说明这个实例没被 init 过（历史上真出现过，见文件末尾 runtime 的说明）。
    // 不补这一步的后果不是"报个明显的错"，而是会话拿着**空 Provider 列表**去跑，
    // 每回合都抛「尚未配置任何 Provider」——用户看到设置里 Key 明明在，却以为密钥失效。
    await this.refreshSettings()

    const meta = await getSessionMeta(sessionId)
    if (!meta) throw new Error(`会话不存在：${sessionId}`)
    const messages = await getSessionMessages(sessionId)
    return this.instantiate(meta, messages)
  }

  private instantiate(meta: SessionMeta, messages: Awaited<ReturnType<typeof getSessionMessages>>): AgentSession {
    const session = new AgentSession({
      meta,
      messages,
      getSettings: () => this.settingsCache ?? defaultSettingsSnapshot(),
      getProvider: () => {
        const settings = this.settingsCache
        if (!settings) return null
        return settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0] ?? null
      },
      emit: (event) => this.emit(event),
      requestApproval: (call, reason) => this.requestApproval(meta.id, call, reason),
      spawnSubAgent: (request) => this.spawnSubAgent(request),
      onTodos: (sessionId, todos) => {
        this.todos.set(sessionId, todos)
        this.emitTodos(sessionId)
      }
    })
    this.sessions.set(meta.id, session)
    this.depths.set(meta.id, 0)
    return session
  }

  private settingsCache: AppSettings | null = null

  async init(): Promise<void> {
    this.settingsCache = await loadSettings()
    configureLaya(this.settingsCache.layaRepoPath)
  }

  async refreshSettings(): Promise<AppSettings> {
    this.settingsCache = await loadSettings()
    // 改了 laya 仓库路径要立刻生效：configureLaya 之后下次调用会自行换子进程重启，无需重启应用
    configureLaya(this.settingsCache.layaRepoPath)
    return this.settingsCache
  }

  getTodos(sessionId: string): TodoItem[] {
    return this.todos.get(sessionId) ?? this.sessions.get(sessionId)?.todos ?? []
  }

  private todoSink: ((sessionId: string, todos: TodoItem[]) => void) | null = null

  /** IPC 层注入：把待办变化直接推给渲染层（避免混进 AgentEvent 流）。 */
  setTodoSink(sink: (sessionId: string, todos: TodoItem[]) => void): void {
    this.todoSink = sink
  }

  private emitTodos(sessionId: string): void {
    this.todoSink?.(sessionId, this.getTodos(sessionId))
  }

  getAllTodos(): Array<{ sessionId: string; todos: TodoItem[] }> {
    return [...this.todos.entries()].map(([sessionId, todos]) => ({ sessionId, todos }))
  }

  /* ---------------------------------------------------------------- *
   * 运行 / 中断 / 插话
   * ---------------------------------------------------------------- */

  async run(
    sessionId: string,
    prompt: string,
    attachments: Attachment[] = []
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const session = await this.ensure(sessionId)
      if (this.running.has(sessionId)) {
        // 已在运行则退化为"插话"，避免用户误触产生并发的两条流水线
        session.steer(prompt)
        return { ok: true }
      }
      this.running.add(sessionId)
      session.runTurn(prompt, attachments).finally(() => {
        this.running.delete(sessionId)
      })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'error', sessionId, message })
      return { ok: false, error: message }
    }
  }

  /** 等待一轮完整结束（子智能体与调度器需要拿到最终结论）。 */
  private async runAndWait(sessionId: string, prompt: string): Promise<void> {
    const session = await this.ensure(sessionId)
    this.running.add(sessionId)
    try {
      await session.runTurn(prompt)
    } finally {
      this.running.delete(sessionId)
    }
  }

  async steer(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.isRunning) session.steer(text)
    else await this.run(sessionId, text)
  }

  abort(sessionId: string): void {
    this.sessions.get(sessionId)?.abort()
    this.running.delete(sessionId)
    // 正在等待审批的请求也要一起解除：否则渲染层的审批卡会一直挂着，
    // 而会话持有的审批 Promise 也不会 settle，会话状态永远停在 running。
    for (const [requestId, entry] of [...this.approvals.entries()]) {
      if (entry.request.sessionId !== sessionId) continue
      this.approvals.delete(requestId)
      entry.resolve(false)
      this.emit({ type: 'approval:resolved', requestId, approved: false })
    }
  }

  status(sessionId: string): AgentStatus {
    return this.sessions.get(sessionId)?.status ?? 'idle'
  }

  /**
   * 丢弃内存里的会话实例。
   *
   * 树形转录之后这是必需的：界面上"回到历史某点继续"只移动了存储层指针，
   * 内存里那个实例还抱着旧分支的 `messages`；不重建的话，模型看到的是旧上下文，
   * 而界面显示的是新分支——两边静默不一致。
   */
  forget(sessionId: string): void {
    this.abort(sessionId)
    this.sessions.delete(sessionId)
    this.depths.delete(sessionId)
    // 待办**不丢**：它没有落盘，删掉就等于用户的分步计划凭空消失。
    // 待办与"模型看到哪段上下文"无关，重建会话实例不影响它。
  }

  /* ---------------------------------------------------------------- *
   * 审批
   * ---------------------------------------------------------------- */

  private requestApproval(sessionId: string, call: ToolCall, reason: string): Promise<boolean> {
    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId,
      call,
      reason,
      createdAt: Date.now()
    }
    return new Promise<boolean>((resolve) => {
      this.approvals.set(request.id, { resolve, request })
      this.emit({ type: 'approval:request', request })
    })
  }

  async answerApproval(requestId: string, approved: boolean, remember = false): Promise<void> {
    const entry = this.approvals.get(requestId)
    if (!entry) return
    this.approvals.delete(requestId)
    entry.resolve(approved)
    this.emit({ type: 'approval:resolved', requestId, approved })

    if (approved && remember) {
      // 记住的是**整组**而不是单个工具名：否则用户点了「总是允许 edit_file」，
      // 下一句 write_file 还会再问一次，看起来像设置没生效。
      const wanted = expandApprovalTools(entry.request.call.name)
      const settings = await loadSettings()
      const missing = wanted.filter((name) => !settings.autoApproveTools.includes(name))
      if (missing.length) {
        await saveSettings({
          ...settings,
          autoApproveTools: [...settings.autoApproveTools, ...missing]
        })
        this.settingsCache = await loadSettings()
      }
    }
  }

  pendingApprovals(sessionId: string): ApprovalRequest[] {
    return [...this.approvals.values()]
      .map((entry) => entry.request)
      .filter((request) => request.sessionId === sessionId)
  }

  /* ---------------------------------------------------------------- *
   * 子智能体
   * ---------------------------------------------------------------- */

  private async spawnSubAgent(request: SubAgentRequest): Promise<string> {
    const parentDepth = this.depths.get(request.parentSessionId) ?? 0
    if (parentDepth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(`子智能体嵌套已达上限（${MAX_SUBAGENT_DEPTH} 层），请直接在当前会话中完成该任务`)
    }

    const settings = await this.refreshSettings()
    const child = await createSession({
      projectPath: request.projectPath,
      title: request.title?.trim() || '子智能体',
      providerId: settings.activeProviderId,
      model: settings.activeModel,
      parentId: request.parentSessionId,
      isSubAgent: true
    })
    this.emit({ type: 'subagent', sessionId: request.parentSessionId, child, state: 'spawned' })
    this.emit({ type: 'sessions:changed' })

    // 子会话继承内存中的会话视图，但不带动画式的父会话历史
    const childSession = new AgentSession({
      meta: child,
      messages: [],
      getSettings: () => this.settingsCache ?? defaultSettingsSnapshot(),
      getProvider: () => {
        const s = this.settingsCache
        if (!s) return null
        return s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0] ?? null
      },
      emit: (event) => this.emit(event),
      requestApproval: (call, reason) => this.requestApproval(child.id, call, reason),
      spawnSubAgent: (nested) => this.spawnSubAgent(nested),
      onTodos: () => undefined,
      // 角色化子会话：'reviewer' 拿生产就绪审查专用系统提示词（只读职责，见 harness.ts）
      role: request.role
    })
    this.sessions.set(child.id, childSession)
    this.depths.set(child.id, parentDepth + 1)

    try {
      await childSession.runTurn(request.prompt)
      const finalText = [...childSession.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.text.trim())
      await updateSessionMeta(child.id, { title: child.title })
      this.emit({ type: 'subagent', sessionId: request.parentSessionId, child, state: 'done' })
      return finalText?.text ?? ''
    } catch (error) {
      this.emit({ type: 'subagent', sessionId: request.parentSessionId, child, state: 'error' })
      throw error
    } finally {
      this.emit({ type: 'sessions:changed' })
    }
  }

  /* ---------------------------------------------------------------- *
   * 调度器
   * ---------------------------------------------------------------- */

  startScheduler(): void {
    if (this.schedulerTimer) return
    this.schedulerTimer = setInterval(() => void this.tick(), SCHEDULER_TICK_MS)
  }

  stopScheduler(): void {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer)
    this.schedulerTimer = null
  }

  private async tick(): Promise<void> {
    const tasks = await listTasks(undefined)
    const now = Date.now()
    for (const task of tasks) {
      if (!task.enabled) continue
      if (task.nextRunAt && task.nextRunAt > now) continue
      await this.runScheduledTask(task.id)
    }
  }

  async runScheduledTask(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const tasks = await listTasks(undefined)
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return { ok: false, error: '任务不存在' }

    const settings = await this.refreshSettings()
    let sessionId = task.sessionId
    try {
      if (!sessionId || !(await getSessionMeta(sessionId))) {
        const created = await createSession({
          projectPath: task.projectPath,
          title: `[定时] ${task.name}`,
          providerId: settings.activeProviderId,
          model: settings.activeModel
        })
        sessionId = created.id
        await updateTask(task.id, { sessionId })
        this.emit({ type: 'sessions:changed' })
      }
      await this.runAndWait(sessionId, task.prompt)
      await markRun(task.id, '执行成功')
      this.emit({ type: 'scheduler:changed' })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markRun(task.id, `执行失败：${message}`)
      this.emit({ type: 'scheduler:changed' })
      return { ok: false, error: message }
    }
  }
}

/** 设置尚未加载完成时的兜底快照（保证 getSettings 永不返回 null）。 */
function defaultSettingsSnapshot(): AppSettings {
  return {
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
}

/**
 * 进程内唯一的运行时实例。
 *
 * 为什么不直接 `export const runtime = new AgentRuntime()`：
 * 运行时的状态（会话表 / 审批表 / 设置快照）**只存在于内存**，一旦同一个模块被产出两份实例，
 * 症状全都无法从界面看出来。真实踩过一次：打包产物里 runtime 模块被重复打包，
 * 入口 `runtime.init()` 初始化的是 A，而 IPC 处理器拿到的是未初始化的 B——
 * 于是"设置里 5 个 Provider、Key 也在，一发消息却报『尚未配置任何 Provider』"，
 * 顺带审批也会挂死（B 收审批、A 等审批）。
 *
 * 所以这里显式兜底：不管模块被加载几次，同一个进程里都复用同一个实例。
 */
const globalRef = globalThis as typeof globalThis & { __codeHarnessRuntime?: AgentRuntime }
if (!globalRef.__codeHarnessRuntime) globalRef.__codeHarnessRuntime = new AgentRuntime()
export const runtime: AgentRuntime = globalRef.__codeHarnessRuntime
