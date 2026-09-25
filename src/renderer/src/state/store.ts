import { useSyncExternalStore } from 'react'
import type {
  AgentEvent,
  AgentMessage,
  AgentStatus,
  AppInfo,
  AppSettings,
  ApprovalRequest,
  Attachment,
  ProjectRecord,
  ProjectTrustInfo,
  SessionMeta,
  SessionTranscriptView,
  TodoItem,
  ToolResult,
  TrustDecision
} from '@shared/types'

export type RightTab = 'files' | 'changes' | 'terminal' | 'tasks' | 'harness'

export interface Toast {
  id: string
  kind: 'info' | 'ok' | 'warn' | 'error'
  text: string
}

export interface AppState {
  ready: boolean
  settings: AppSettings | null
  appInfo: AppInfo | null
  projects: ProjectRecord[]
  sessions: SessionMeta[]
  /** 当前项目根路径；null 表示「无项目」模式 */
  projectPath: string | null
  sessionId: string | null
  session: SessionMeta | null
  messages: AgentMessage[]
  /**
   * 当前分支的转录视图：**聊天区按它渲染**（含被隐藏项与压缩标记），而不是按 `messages`。
   * `messages` 是"模型看到什么"（隐藏项与已折叠历史都不在里面），拿它当界面数据源会让
   * 用户一隐藏某条消息、界面上那条消息就凭空消失。
   */
  transcript: SessionTranscriptView | null
  /** 项目信任情况：决定项目级技能/记忆是否参与提示词装配 */
  trust: ProjectTrustInfo | null
  loadingSession: boolean
  status: AgentStatus
  detail: string
  todos: TodoItem[]
  approvals: ApprovalRequest[]
  /** 工具调用 id → 执行状态 */
  toolStatus: Record<string, 'running' | 'done' | 'error'>
  rightTab: RightTab
  panelOpen: boolean
  sidebarOpen: boolean
  paletteOpen: boolean
  settingsOpen: boolean
  toasts: Toast[]
}

const initialState: AppState = {
  ready: false,
  settings: null,
  appInfo: null,
  projects: [],
  sessions: [],
  projectPath: null,
  sessionId: null,
  session: null,
  messages: [],
  transcript: null,
  trust: null,
  loadingSession: false,
  status: 'idle',
  detail: '',
  todos: [],
  approvals: [],
  toolStatus: {},
  rightTab: 'changes',
  panelOpen: true,
  sidebarOpen: true,
  paletteOpen: false,
  settingsOpen: false,
  toasts: []
}

let state: AppState = initialState
const listeners = new Set<() => void>()

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 订阅整个状态对象：状态只在 set() 时整体替换，快照引用稳定。 */
export function useApp(): AppState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

export function getState(): AppState {
  return state
}

/* ------------------------------------------------------------------ *
 * 主题与外观
 * ------------------------------------------------------------------ */

function applyAppearance(settings: AppSettings): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme = settings.theme === 'system' ? (prefersDark ? 'dark' : 'light') : settings.theme
  document.documentElement.dataset.theme = theme
  document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`)
  document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion)
}

/* ------------------------------------------------------------------ *
 * 消息归并
 * ------------------------------------------------------------------ */

function upsert(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const index = messages.findIndex((item) => item.id === message.id)
  if (index < 0) return [...messages, message]
  const next = messages.slice()
  next[index] = message
  return next
}

/* ------------------------------------------------------------------ *
 * 事件处理
 * ------------------------------------------------------------------ */

function handleAgentEvent(event: AgentEvent): void {
  const isCurrent = 'sessionId' in event ? event.sessionId === state.sessionId : true

  switch (event.type) {
    case 'sessions:changed':
      void refreshSessions()
      return
    case 'session:created':
    case 'session:updated': {
      const exists = state.sessions.some((item) => item.id === event.session.id)
      set({
        sessions: exists
          ? state.sessions.map((item) => (item.id === event.session.id ? event.session : item))
          : [event.session, ...state.sessions],
        session: state.sessionId === event.session.id ? event.session : state.session
      })
      return
    }
    case 'scheduler:changed':
      void actions.refreshScheduler()
      return
    default:
      break
  }

  if (!isCurrent) {
    // 非当前会话的审批 / 错误仍然要提醒用户，避免子智能体或定时任务静默阻塞
    if (event.type === 'approval:request') {
      set({ approvals: [...state.approvals.filter((a) => a.id !== event.request.id), event.request] })
    }
    if (event.type === 'error') {
      actions.toast('error', `其他会话出错：${event.message}`)
    }
    return
  }

  switch (event.type) {
    case 'turn:start':
      set({ status: 'thinking', detail: '', toolStatus: {} })
      return
    case 'status':
      set({ status: event.status, detail: event.detail ?? state.detail })
      return
    case 'message:start':
      set({ messages: upsert(state.messages, event.message) })
      return
    case 'message:delta': {
      set({
        status: 'streaming',
        messages: state.messages.map((message) =>
          message.id === event.messageId ? { ...message, text: message.text + event.delta } : message
        )
      })
      return
    }
    case 'reasoning:delta': {
      set({
        messages: state.messages.map((message) =>
          message.id === event.messageId
            ? { ...message, reasoning: `${message.reasoning ?? ''}${event.delta}` }
            : message
        )
      })
      return
    }
    case 'message:end': {
      set({ messages: upsert(state.messages, event.message) })
      return
    }
    case 'tool:start': {
      set({ toolStatus: { ...state.toolStatus, [event.call.id]: 'running' } })
      return
    }
    case 'tool:end': {
      set({
        toolStatus: { ...state.toolStatus, [event.result.id]: event.result.ok ? 'done' : 'error' },
        messages: upsert(state.messages, toolMessage(event.result))
      })
      return
    }
    case 'turn:end': {
      set({ status: event.stopReason === 'aborted' ? 'aborted' : 'idle', detail: '' })
      void refreshSessions()
      // 回合结束后转录才补齐（流式期间的消息还没落盘），这时拉一次即可
      void refreshTranscript()
      return
    }
    case 'compaction': {
      const freed = (event.freedChars / 1000).toFixed(0)
      actions.toast(
        'info',
        `已压缩上下文：${event.removedMessages} 条历史消息被摘要代表（原始内容仍保留在转录里，可回溯），释放约 ${freed}K 字符`
      )
      void refreshSession(state.sessionId)
      void refreshTranscript()
      return
    }
    case 'subagent': {
      if (event.state === 'spawned') actions.toast('info', `已派生子智能体：${event.child.title}`)
      if (event.state === 'error') actions.toast('error', `子智能体「${event.child.title}」执行失败`)
      void refreshSessions()
      return
    }
    case 'approval:request': {
      set({ approvals: [...state.approvals.filter((a) => a.id !== event.request.id), event.request] })
      return
    }
    case 'approval:resolved': {
      set({ approvals: state.approvals.filter((a) => a.id !== event.requestId) })
      return
    }
    case 'error': {
      set({ status: 'error', detail: event.message })
      actions.toast('error', event.message)
      return
    }
    default:
      return
  }
}

/** 工具结果在主进程里是一条 role=tool 的消息，渲染层用它做占位映射。 */
function toolMessage(result: ToolResult): AgentMessage {
  return {
    id: result.id,
    role: 'tool',
    text: '',
    createdAt: Date.now(),
    toolResult: result
  }
}

/* ------------------------------------------------------------------ *
 * 数据拉取
 * ------------------------------------------------------------------ */

async function refreshSessions(): Promise<void> {
  const sessions = await window.pi.sessions.list(state.projectPath)
  set({ sessions: sessions.filter((session) => !session.isSubAgent) })
}

async function refreshSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return
  const { meta, messages } = await window.pi.sessions.get(sessionId)
  if (state.sessionId !== sessionId) return
  set({ session: meta, messages })
}

async function refreshTranscript(): Promise<void> {
  const sessionId = state.sessionId
  if (!sessionId) {
    set({ transcript: null })
    return
  }
  const transcript = await window.pi.sessions.transcript(sessionId)
  if (state.sessionId !== sessionId) return
  set({ transcript })
}

async function refreshTrust(): Promise<void> {
  const trust = await window.pi.trust.info(state.projectPath)
  set({ trust })
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

const toastTimers = new Map<string, number>()

export const actions = {
  async init(): Promise<void> {
    const [appInfo, settings, projects] = await Promise.all([
      window.pi.app.info(),
      window.pi.settings.get(),
      window.pi.projects.list()
    ])
    applyAppearance(settings)
    set({ appInfo, settings, projects, ready: true })

    window.pi.events.onAgentEvent(handleAgentEvent)
    window.pi.events.onTodos(({ sessionId, todos }) => {
      if (sessionId === state.sessionId) set({ todos })
    })
    window.pi.events.onShellChunk((chunk) => terminalBus.emitChunk(chunk))
    window.pi.events.onShellExit((exit) => terminalBus.emitExit(exit))

    const firstProject = projects[0]?.path ?? null
    await actions.selectProject(firstProject)
  },

  async saveSettings(next: AppSettings): Promise<void> {
    const saved = await window.pi.settings.save(next)
    applyAppearance(saved)
    set({ settings: saved })
  },

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    if (!state.settings) return
    await actions.saveSettings({ ...state.settings, ...patch })
  },

  async addProject(path: string): Promise<void> {
    const record = await window.pi.projects.add(path)
    set({ projects: [record, ...state.projects.filter((p) => p.id !== record.id)] })
    await actions.selectProject(record.path)
    actions.toast('ok', `已添加项目：${record.name}`)
  },

  async pickAndAddProject(): Promise<void> {
    const path = await window.pi.app.pickDirectory()
    if (path) await actions.addProject(path)
  },

  async removeProject(id: string): Promise<void> {
    await window.pi.projects.remove(id)
    const projects = state.projects.filter((project) => project.id !== id)
    set({ projects })
    if (!projects.some((project) => project.path === state.projectPath)) {
      await actions.selectProject(projects[0]?.path ?? null)
    }
  },

  async selectProject(path: string | null): Promise<void> {
    set({
      projectPath: path,
      sessionId: null,
      session: null,
      messages: [],
      transcript: null,
      todos: [],
      approvals: []
    })
    const match = state.projects.find((project) => project.path === path)
    if (match) void window.pi.projects.touch(match.id)
    void refreshTrust()
    await refreshSessions()
    const sessions = await window.pi.sessions.list(path)
    const visible = sessions.filter((session) => !session.isSubAgent)
    if (visible.length) await actions.openSession(visible[0].id)
  },

  async createSession(title?: string): Promise<string> {
    const meta = await window.pi.sessions.create({ projectPath: state.projectPath, title })
    set({
      sessionId: meta.id,
      session: meta,
      messages: [],
      transcript: null,
      todos: [],
      approvals: [],
      status: 'idle'
    })
    await refreshSessions()
    await actions.setRightTab('files')
    return meta.id
  },

  async openSession(id: string): Promise<void> {
    set({
      sessionId: id,
      loadingSession: true,
      messages: [],
      transcript: null,
      todos: [],
      approvals: [],
      status: 'idle'
    })
    try {
      const { meta, messages } = await window.pi.sessions.get(id)
      if (state.sessionId !== id) return
      const [approvals, transcript] = await Promise.all([
        window.pi.agent.pendingApprovals(id),
        window.pi.sessions.transcript(id)
      ])
      if (state.sessionId !== id) return
      set({ session: meta, messages, transcript, approvals, todos: [], loadingSession: false })
    } catch (error) {
      set({ loadingSession: false })
      actions.toast('error', error instanceof Error ? error.message : String(error))
    }
  },

  async renameSession(id: string, title: string): Promise<void> {
    await window.pi.sessions.rename(id, title)
    await refreshSessions()
    if (state.sessionId === id) set({ session: { ...(state.session as SessionMeta), title } })
  },

  async archiveSession(id: string, archived: boolean): Promise<void> {
    await window.pi.sessions.archive(id, archived)
    await refreshSessions()
    if (archived && state.sessionId === id) set({ sessionId: null, session: null, messages: [] })
  },

  async deleteSession(id: string): Promise<void> {
    await window.pi.sessions.remove(id)
    if (state.sessionId === id) set({ sessionId: null, session: null, messages: [], todos: [] })
    const sessions = await window.pi.sessions.list(state.projectPath)
    const visible = sessions.filter((session) => !session.isSubAgent)
    set({ sessions: visible })
    if (!state.sessionId && visible.length) await actions.openSession(visible[0].id)
  },

  /** 发送一条指令；没有会话时自动建一个。 */
  async send(text: string, attachments: Attachment[] = []): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed && !attachments.length) return

    let sessionId = state.sessionId
    if (!sessionId) {
      sessionId = await actions.createSession()
      await actions.setRightTab('changes')
    }

    set({ status: 'thinking', detail: '' })
    const result = await window.pi.agent.run({ sessionId, prompt: trimmed, attachments })
    if (!result.ok) actions.toast('error', result.error ?? '发送失败')
  },

  async steer(text: string): Promise<void> {
    if (!state.sessionId) return
    await window.pi.agent.steer(state.sessionId, text)
    actions.toast('info', '已插入指令，将在下一步生效')
  },

  async abort(): Promise<void> {
    if (!state.sessionId) return
    await window.pi.agent.abort(state.sessionId)
    set({ status: 'aborted' })
  },

  async answerApproval(requestId: string, approved: boolean, remember = false): Promise<void> {
    await window.pi.agent.answerApproval(requestId, approved, remember)
    set({ approvals: state.approvals.filter((item) => item.id !== requestId) })
    if (approved && remember && state.settings) {
      const settings = await window.pi.settings.get()
      set({ settings })
    }
  },

  setRightTab(tab: RightTab): void {
    set({ rightTab: tab, panelOpen: true })
  },

  togglePanel(): void {
    set({ panelOpen: !state.panelOpen })
  },

  toggleSidebar(): void {
    set({ sidebarOpen: !state.sidebarOpen })
  },

  setPaletteOpen(open: boolean): void {
    set({ paletteOpen: open })
  },

  setSettingsOpen(open: boolean): void {
    set({ settingsOpen: open })
  },

  toast(kind: Toast['kind'], text: string): void {
    const id = crypto.randomUUID()
    set({ toasts: [...state.toasts, { id, kind, text }] })
    const timer = window.setTimeout(() => actions.dismissToast(id), kind === 'error' ? 8000 : 4500)
    toastTimers.set(id, timer)
  },

  dismissToast(id: string): void {
    const timer = toastTimers.get(id)
    if (timer) window.clearTimeout(timer)
    toastTimers.delete(id)
    set({ toasts: state.toasts.filter((toast) => toast.id !== id) })
  },

  async refreshScheduler(): Promise<void> {
    schedulerBus.emitChanged()
  },

  /* ---------------- 分支与上下文（树形转录） ---------------- */

  async refreshTranscript(): Promise<void> {
    await refreshTranscript()
  },

  /** 回到历史某点继续：只移动指针，之后的对话从那里长出新分支。 */
  async switchBranch(entryId: string): Promise<void> {
    const sessionId = state.sessionId
    if (!sessionId) return
    try {
      const view = await window.pi.sessions.setHead(sessionId, entryId)
      set({ transcript: view })
      await refreshSession(sessionId)
      await refreshSessions()
      actions.toast('info', '已回到该处继续：之后的对话会从这里长出一条新分支')
    } catch (error) {
      actions.toast('error', error instanceof Error ? error.message : String(error))
    }
  },

  /** 从历史某点分叉出一个新会话（原会话不动）。 */
  async forkFrom(entryId: string): Promise<void> {
    const sessionId = state.sessionId
    if (!sessionId) return
    try {
      const meta = await window.pi.sessions.fork(sessionId, entryId)
      await refreshSessions()
      await actions.openSession(meta.id)
      actions.toast('ok', '已从该处分叉出新会话')
    } catch (error) {
      actions.toast('error', error instanceof Error ? error.message : String(error))
    }
  },

  /** 把当前分支复制成新会话。 */
  async cloneBranch(): Promise<void> {
    const sessionId = state.sessionId
    if (!sessionId) return
    try {
      const meta = await window.pi.sessions.clone(sessionId)
      await refreshSessions()
      await actions.openSession(meta.id)
      actions.toast('ok', '已把当前分支复制为新会话')
    } catch (error) {
      actions.toast('error', error instanceof Error ? error.message : String(error))
    }
  },

  /**
   * 把一条消息对模型隐藏 / 恢复。
   * 转录与界面都不变，只影响后续上下文——所以这里同时刷新转录（界面）与投影（模型视角）。
   */
  async toggleEntryVisibility(entryId: string, visible: boolean): Promise<void> {
    const sessionId = state.sessionId
    if (!sessionId) return
    try {
      const view = await window.pi.sessions.setVisibility(sessionId, entryId, visible)
      set({ transcript: view })
      await refreshSession(sessionId)
      actions.toast(
        'info',
        visible ? '已恢复进模型上下文（下个回合生效）' : '已从模型上下文隐藏（转录里仍保留）'
      )
    } catch (error) {
      actions.toast('error', error instanceof Error ? error.message : String(error))
    }
  },

  /* ---------------- 项目信任 ---------------- */

  async refreshTrust(): Promise<void> {
    await refreshTrust()
  },

  async setTrust(decision: TrustDecision | null): Promise<void> {
    if (!state.projectPath) return
    await window.pi.trust.set(state.projectPath, decision)
    await refreshTrust()
    if (decision === 'always') {
      actions.toast('ok', '已信任该项目：项目级技能与记忆会注入上下文（下个回合生效）')
    } else if (decision === 'never') {
      actions.toast('warn', '已设为不信任：该项目里的技能与记忆不会注入上下文')
    } else {
      actions.toast('info', '已清除该项目的信任决定')
    }
  }
}

/* ------------------------------------------------------------------ *
 * 事件总线（终端 / 调度面板订阅用，避免把瞬时数据塞进全局状态）
 * ------------------------------------------------------------------ */

type Listener<T> = (payload: T) => void

function createBus<T>() {
  const listeners = new Set<Listener<T>>()
  return {
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(payload: T): void {
      for (const listener of listeners) listener(payload)
    }
  }
}

const chunkBus = createBus<import('@shared/types').ShellChunk>()
const exitBus = createBus<import('@shared/types').ShellExit>()
const changedBus = createBus<void>()

export const terminalBus = {
  subscribe: chunkBus.subscribe,
  emitChunk: chunkBus.emit,
  onExit: exitBus.subscribe,
  emitExit: exitBus.emit
}

export const schedulerBus = {
  subscribe: changedBus.subscribe,
  emitChanged: () => changedBus.emit(undefined)
}

/* ------------------------------------------------------------------ *
 * 附件处理
 * ------------------------------------------------------------------ */

const MAX_TEXT_ATTACHMENT = 200_000

export async function fileToAttachment(file: File): Promise<Attachment | null> {
  if (file.type.startsWith('image/')) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    return { name: file.name, mimeType: file.type, dataUrl }
  }
  if (file.size > MAX_TEXT_ATTACHMENT) return null
  const text = await file.text()
  return { name: file.name, mimeType: file.type || 'text/plain', text }
}
