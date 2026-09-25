import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AgentMessage,
  AgentStatus,
  Attachment,
  Goal,
  ProjectTrustInfo,
  ScheduledTask,
  TrustDecision
} from '@shared/types'
import { runtime } from '../agent/runtime'
import {
  addMemory,
  removeMemory,
  rollback,
  setGoal,
  updateGoal,
  viewHarness
} from '../store/harness-store'
import {
  appendContextEdit,
  cloneSession,
  createSession,
  forkSession,
  getSessionMessages,
  getTranscriptView,
  listSessions,
  removeSession,
  searchSessions,
  setSessionHead,
  updateSessionMeta
} from '../store/session-store'
import { getTrustDecision, projectHasTrustableResources, setTrustDecision } from '../store/trust-store'
import { listSkills, removeSkill, saveSkill, toggleSkill } from '../store/skill-store'
import { createTask, listTasks, removeTask, updateTask } from '../store/scheduler-store'
import { send } from './bus'

/** 这些状态下会话正在跑模型或工具：此时移动分支指针会让"界面显示的上下文"与"模型看到的"错位。 */
const BUSY_STATUSES: AgentStatus[] = ['thinking', 'streaming', 'tool', 'waiting-approval']

function assertSessionIdle(sessionId: string): void {
  const status = runtime.status(sessionId)
  if (BUSY_STATUSES.includes(status)) {
    throw new Error('会话正在运行（' + status + '），请先中止当前回合，再切换分支或修改上下文')
  }
}

export function registerAgentIpc(): void {
  /* ---------------- 会话 ---------------- */
  ipcMain.handle(IPC.sessions.list, (_event, projectPath: string | null) => listSessions(projectPath))

  ipcMain.handle(IPC.sessions.create, async (_event, input: { projectPath: string | null; title?: string }) => {
    const settings = await runtime.refreshSettings()
    const meta = await createSession({
      projectPath: input.projectPath,
      title: input.title,
      providerId: settings.activeProviderId,
      model: settings.activeModel
    })
    send(IPC.push.agentEvent, { type: 'session:created', session: meta })
    send(IPC.push.agentEvent, { type: 'sessions:changed' })
    return meta
  })

  ipcMain.handle(IPC.sessions.get, async (_event, id: string) => {
    const session = await runtime.ensure(id)
    return { meta: session.meta, messages: session.messages }
  })

  ipcMain.handle(IPC.sessions.rename, async (_event, id: string, title: string) => {
    const meta = await updateSessionMeta(id, { title })
    send(IPC.push.agentEvent, { type: 'sessions:changed' })
    return meta
  })

  ipcMain.handle(IPC.sessions.archive, async (_event, id: string, archived: boolean) => {
    const meta = await updateSessionMeta(id, { archived })
    send(IPC.push.agentEvent, { type: 'sessions:changed' })
    return meta
  })

  ipcMain.handle(IPC.sessions.remove, async (_event, id: string) => {
    runtime.abort(id)
    await removeSession(id)
    send(IPC.push.agentEvent, { type: 'sessions:changed' })
  })

  ipcMain.handle(IPC.sessions.search, (_event, query: string) => searchSessions(query))

  ipcMain.handle(IPC.sessions.transcript, (_event, id: string) => getTranscriptView(id))

  // 回到历史某点继续：只移动存储层的指针，不新建文件；之后的条目自然长成一条新分支。
  ipcMain.handle(IPC.sessions.setHead, async (_event, id: string, entryId: string) => {
    assertSessionIdle(id)
    const view = await setSessionHead(id, entryId)
    // 内存里那个实例还抱着旧分支的 messages，必须丢弃，下次用时按新投影重建
    runtime.forget(id)
    send(IPC.push.agentEvent, { type: 'sessions:changed' })
    return view
  })

  ipcMain.handle(IPC.sessions.fork, async (_event, id: string, entryId: string) => {
    const meta = await forkSession(id, entryId)
    send(IPC.push.agentEvent, { type: 'sessions:changed' })
    return meta
  })

  ipcMain.handle(IPC.sessions.clone, async (_event, id: string) => {
    const meta = await cloneSession(id)
    send(IPC.push.agentEvent, { type: 'sessions:changed' })
    return meta
  })

  // 隐藏/恢复一条消息：转录与界面都不动，只影响**后续**的模型上下文
  ipcMain.handle(
    IPC.sessions.setVisibility,
    async (_event, id: string, entryId: string, visible: boolean) => {
      assertSessionIdle(id)
      await appendContextEdit(id, entryId, visible)
      runtime.forget(id)
      return getTranscriptView(id)
    }
  )

  /* ---------------- 项目信任 ---------------- */
  ipcMain.handle(IPC.trust.info, async (_event, projectPath: string | null): Promise<ProjectTrustInfo> => {
    const decision = await getTrustDecision(projectPath)
    return {
      projectPath: projectPath ?? '',
      decision,
      hasResources: await projectHasTrustableResources(projectPath),
      injected: decision === 'always'
    }
  })

  // 信任状态不需要重建会话实例：系统提示词是**每次模型调用前**重新装配的，
  // 所以改变决定在下一个回合就生效（见 harness.ts 的信任闸门）。
  ipcMain.handle(IPC.trust.set, (_event, projectPath: string, decision: TrustDecision | null) =>
    setTrustDecision(projectPath, decision)
  )

  /* ---------------- 智能体 ---------------- */
  ipcMain.handle(
    IPC.agent.run,
    (
      _event,
      input: { sessionId: string; prompt: string; attachments?: Attachment[] }
    ): Promise<{ ok: boolean; error?: string }> =>
      runtime.run(input.sessionId, input.prompt, input.attachments ?? [])
  )

  ipcMain.handle(IPC.agent.steer, (_event, sessionId: string, text: string) => runtime.steer(sessionId, text))
  ipcMain.handle(IPC.agent.abort, (_event, sessionId: string) => runtime.abort(sessionId))
  ipcMain.handle(IPC.agent.status, (_event, sessionId: string) => runtime.status(sessionId))
  ipcMain.handle(IPC.agent.answerApproval, (_event, requestId: string, approved: boolean, remember?: boolean) =>
    runtime.answerApproval(requestId, approved, remember ?? false)
  )
  ipcMain.handle(IPC.agent.pendingApprovals, (_event, sessionId: string) => runtime.pendingApprovals(sessionId))

  /* ---------------- 技能 ---------------- */
  ipcMain.handle(IPC.skills.list, (_event, projectPath: string | null) => listSkills(projectPath))
  ipcMain.handle(IPC.skills.save, (_event, input) => saveSkill(input))
  ipcMain.handle(IPC.skills.remove, (_event, input) => removeSkill(input))
  ipcMain.handle(IPC.skills.toggle, (_event, input) => toggleSkill(input))

  /* ---------------- Harness ---------------- */
  ipcMain.handle(IPC.harness.view, (_event, input: { projectPath: string | null; sessionId: string }) =>
    viewHarness(input.projectPath, input.sessionId)
  )
  ipcMain.handle(IPC.harness.setGoal, async (_event, input: { sessionId: string; text: string }): Promise<Goal> => {
    const session = await runtime.ensure(input.sessionId)
    return setGoal(session.meta.projectPath, input.sessionId, input.text)
  })
  ipcMain.handle(
    IPC.harness.updateGoal,
    async (_event, input: { sessionId: string; goalId: string; status: Goal['status'] }) => {
      const session = await runtime.ensure(input.sessionId)
      return updateGoal(session.meta.projectPath, input.sessionId, input.goalId, input.status)
    }
  )
  ipcMain.handle(
    IPC.harness.addMemory,
    async (_event, input: { projectPath: string | null; text: string; evidence: string }) => {
      await addMemory({ ...input, scope: input.projectPath ? 'project' : 'user', source: 'user' })
      return viewHarness(input.projectPath, '')
    }
  )
  ipcMain.handle(
    IPC.harness.removeMemory,
    async (_event, input: { projectPath: string | null; id: string }) => {
      await removeMemory(input.projectPath, input.id)
      return viewHarness(input.projectPath, '')
    }
  )
  ipcMain.handle(
    IPC.harness.rollback,
    async (_event, input: { projectPath: string | null; snapshotId: string }) => {
      await rollback(input.projectPath, input.snapshotId)
      return viewHarness(input.projectPath, '')
    }
  )

  /* ---------------- 调度 ---------------- */
  ipcMain.handle(IPC.scheduler.list, (_event, projectPath: string | null) => listTasks(projectPath))
  ipcMain.handle(IPC.scheduler.create, async (_event, input) => {
    const task = await createTask(input)
    send(IPC.push.agentEvent, { type: 'scheduler:changed' })
    return task
  })
  ipcMain.handle(IPC.scheduler.update, async (_event, input: { id: string; patch: Partial<ScheduledTask> }) => {
    const task = await updateTask(input.id, input.patch)
    send(IPC.push.agentEvent, { type: 'scheduler:changed' })
    return task
  })
  ipcMain.handle(IPC.scheduler.remove, async (_event, id: string) => {
    await removeTask(id)
    send(IPC.push.agentEvent, { type: 'scheduler:changed' })
  })
  ipcMain.handle(IPC.scheduler.runNow, (_event, id: string) => runtime.runScheduledTask(id))
}

export type { AgentMessage }
