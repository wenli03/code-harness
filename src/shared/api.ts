import type {
  AgentEvent,
  AgentMessage,
  AgentStatus,
  AppInfo,
  AppSettings,
  ApprovalRequest,
  Attachment,
  AutoLaunchState,
  FileNode,
  FileReadResult,
  GitStatus,
  Goal,
  HarnessView,
  ProjectRecord,
  ProjectTrustInfo,
  ProviderStatus,
  ScheduledTask,
  SessionMeta,
  SessionTranscriptView,
  TrustDecision,
  TrustState,
  ShellChunk,
  ShellExit,
  ShellRunRequest,
  SkillRecord,
  TodoItem
} from './types'

/** 主进程通过 preload 暴露给渲染层的唯一 API 面（contextIsolation 下不暴露 ipcRenderer 本身）。 */
export interface CodeHarnessApi {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    pickDirectory(): Promise<string | null>
    revealPath(target: string): Promise<void>
    /** 开机启动的当前**实际**状态（读系统登录项，不读本地设置） */
    getAutoLaunch(): Promise<AutoLaunchState>
    /** 注册/取消开机启动，返回写入后的实际状态 */
    setAutoLaunch(enabled: boolean): Promise<AutoLaunchState>
  }
  settings: {
    get(): Promise<AppSettings>
    save(next: AppSettings): Promise<AppSettings>
    testProvider(providerId: string): Promise<ProviderStatus>
  }
  projects: {
    list(): Promise<ProjectRecord[]>
    add(path: string): Promise<ProjectRecord>
    remove(id: string): Promise<void>
    touch(id: string): Promise<void>
  }
  sessions: {
    list(projectPath: string | null): Promise<SessionMeta[]>
    create(input: { projectPath: string | null; title?: string }): Promise<SessionMeta>
    get(id: string): Promise<{ meta: SessionMeta; messages: AgentMessage[] }>
    rename(id: string, title: string): Promise<SessionMeta>
    archive(id: string, archived: boolean): Promise<SessionMeta>
    remove(id: string): Promise<void>
    search(query: string): Promise<SessionMeta[]>
    /** 当前分支的转录视图：条目（含被隐藏的与压缩标记）+ 分支尖 + 隐藏集合 */
    transcript(id: string): Promise<SessionTranscriptView>
    /** 回到历史某点继续（移动当前指针；会话正在运行时会被拒绝） */
    setHead(id: string, entryId: string): Promise<SessionTranscriptView>
    /** 从历史某点分叉出一个新会话（原会话保持不动） */
    fork(id: string, entryId: string): Promise<SessionMeta>
    /** 把当前分支复制成新会话 */
    clone(id: string): Promise<SessionMeta>
    /** 把某条消息对模型隐藏 / 恢复（转录与界面都不变，只影响后续上下文） */
    setVisibility(id: string, entryId: string, visible: boolean): Promise<SessionTranscriptView>
  }
  trust: {
    /** 项目信任情况（未决定 + 有项目级资源时，界面应弹提示） */
    info(projectPath: string | null): Promise<ProjectTrustInfo>
    /** 记录/清除信任决定（decision 传 null 表示清除） */
    set(projectPath: string, decision: TrustDecision | null): Promise<TrustState>
  }
  agent: {
    run(input: {
      sessionId: string
      prompt: string
      attachments?: Attachment[]
    }): Promise<{ ok: boolean; error?: string }>
    steer(sessionId: string, text: string): Promise<void>
    abort(sessionId: string): Promise<void>
    status(sessionId: string): Promise<AgentStatus>
    answerApproval(requestId: string, approved: boolean, remember?: boolean): Promise<void>
    pendingApprovals(sessionId: string): Promise<ApprovalRequest[]>
  }
  files: {
    tree(projectPath: string, relPath?: string): Promise<FileNode>
    read(projectPath: string, relPath: string): Promise<FileReadResult>
  }
  git: {
    status(projectPath: string): Promise<GitStatus>
    diff(projectPath: string, file: string, staged: boolean): Promise<string>
    stage(projectPath: string, files: string[]): Promise<void>
    unstage(projectPath: string, files: string[]): Promise<void>
    discard(projectPath: string, files: string[]): Promise<void>
    commit(projectPath: string, message: string): Promise<{ ok: boolean; output: string }>
  }
  shell: {
    run(req: ShellRunRequest): Promise<{ runId: string }>
    kill(runId: string): Promise<void>
  }
  skills: {
    list(projectPath: string | null): Promise<SkillRecord[]>
    save(input: {
      scope: 'project' | 'user'
      projectPath: string | null
      name: string
      description: string
      body: string
    }): Promise<SkillRecord>
    remove(input: { scope: 'project' | 'user'; projectPath: string | null; id: string }): Promise<void>
    toggle(input: {
      scope: 'project' | 'user'
      projectPath: string | null
      id: string
      enabled: boolean
    }): Promise<SkillRecord>
  }
  harness: {
    view(input: { projectPath: string | null; sessionId: string }): Promise<HarnessView>
    setGoal(input: { sessionId: string; text: string }): Promise<Goal>
    updateGoal(input: { sessionId: string; goalId: string; status: Goal['status'] }): Promise<Goal | null>
    addMemory(input: {
      projectPath: string | null
      text: string
      evidence: string
    }): Promise<HarnessView>
    removeMemory(input: { projectPath: string | null; id: string }): Promise<HarnessView>
    rollback(input: { projectPath: string | null; snapshotId: string }): Promise<HarnessView>
  }
  scheduler: {
    list(projectPath: string | null): Promise<ScheduledTask[]>
    create(input: {
      name: string
      prompt: string
      projectPath: string | null
      sessionId: string | null
      rrule: string
    }): Promise<ScheduledTask>
    update(input: { id: string; patch: Partial<ScheduledTask> }): Promise<ScheduledTask | null>
    remove(id: string): Promise<void>
    runNow(id: string): Promise<{ ok: boolean; error?: string }>
  }
  events: {
    onAgentEvent(cb: (event: AgentEvent) => void): () => void
    onShellChunk(cb: (chunk: ShellChunk) => void): () => void
    onShellExit(cb: (exit: ShellExit) => void): () => void
    onTodos(cb: (payload: { sessionId: string; todos: TodoItem[] }) => void): () => void
  }
}
