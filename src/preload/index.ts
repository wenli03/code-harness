import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { CodeHarnessApi } from '@shared/api'

/** 统一的 invoke 封装：通道名集中在 shared/ipc.ts，避免字符串漂移。 */
const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

/** 订阅主进程推送，返回取消订阅函数（组件卸载时必须调用，避免监听器泄漏）。 */
const subscribe = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const handler = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: CodeHarnessApi = {
  app: {
    info: () => call(IPC.app.info),
    openExternal: (url) => call(IPC.app.openExternal, url),
    pickDirectory: () => call(IPC.app.pickDirectory),
    revealPath: (target) => call(IPC.app.revealPath, target),
    getAutoLaunch: () => call(IPC.app.getAutoLaunch),
    setAutoLaunch: (enabled) => call(IPC.app.setAutoLaunch, enabled)
  
  },
  settings: {
    get: () => call(IPC.settings.get),
    save: (next) => call(IPC.settings.save, next),
    testProvider: (providerId) => call(IPC.settings.testProvider, providerId)
  },
  projects: {
    list: () => call(IPC.projects.list),
    add: (path) => call(IPC.projects.add, path),
    remove: (id) => call(IPC.projects.remove, id),
    touch: (id) => call(IPC.projects.touch, id)
  },
  sessions: {
    list: (projectPath) => call(IPC.sessions.list, projectPath),
    create: (input) => call(IPC.sessions.create, input),
    get: (id) => call(IPC.sessions.get, id),
    rename: (id, title) => call(IPC.sessions.rename, id, title),
    archive: (id, archived) => call(IPC.sessions.archive, id, archived),
    remove: (id) => call(IPC.sessions.remove, id),
    search: (query) => call(IPC.sessions.search, query),
    transcript: (id) => call(IPC.sessions.transcript, id),
    setHead: (id, entryId) => call(IPC.sessions.setHead, id, entryId),
    fork: (id, entryId) => call(IPC.sessions.fork, id, entryId),
    clone: (id) => call(IPC.sessions.clone, id),
    setVisibility: (id, entryId, visible) => call(IPC.sessions.setVisibility, id, entryId, visible)
  },
  trust: {
    info: (projectPath) => call(IPC.trust.info, projectPath),
    set: (projectPath, decision) => call(IPC.trust.set, projectPath, decision)
  },
  agent: {
    run: (input) => call(IPC.agent.run, input),
    steer: (sessionId, text) => call(IPC.agent.steer, sessionId, text),
    abort: (sessionId) => call(IPC.agent.abort, sessionId),
    status: (sessionId) => call(IPC.agent.status, sessionId),
    answerApproval: (requestId, approved, remember) =>
      call(IPC.agent.answerApproval, requestId, approved, remember),
    pendingApprovals: (sessionId) => call(IPC.agent.pendingApprovals, sessionId)
  },
  files: {
    tree: (projectPath, relPath) => call(IPC.files.tree, projectPath, relPath),
    read: (projectPath, relPath) => call(IPC.files.read, projectPath, relPath)
  },
  git: {
    status: (projectPath) => call(IPC.git.status, projectPath),
    diff: (projectPath, file, staged) => call(IPC.git.diff, projectPath, file, staged),
    stage: (projectPath, files) => call(IPC.git.stage, projectPath, files),
    unstage: (projectPath, files) => call(IPC.git.unstage, projectPath, files),
    discard: (projectPath, files) => call(IPC.git.discard, projectPath, files),
    commit: (projectPath, message) => call(IPC.git.commit, projectPath, message)
  },
  shell: {
    run: (req) => call(IPC.shell.run, req),
    kill: (runId) => call(IPC.shell.kill, runId)
  },
  skills: {
    list: (projectPath) => call(IPC.skills.list, projectPath),
    save: (input) => call(IPC.skills.save, input),
    remove: (input) => call(IPC.skills.remove, input),
    toggle: (input) => call(IPC.skills.toggle, input)
  },
  harness: {
    view: (input) => call(IPC.harness.view, input),
    setGoal: (input) => call(IPC.harness.setGoal, input),
    updateGoal: (input) => call(IPC.harness.updateGoal, input),
    addMemory: (input) => call(IPC.harness.addMemory, input),
    removeMemory: (input) => call(IPC.harness.removeMemory, input),
    rollback: (input) => call(IPC.harness.rollback, input)
  },
  scheduler: {
    list: (projectPath) => call(IPC.scheduler.list, projectPath),
    create: (input) => call(IPC.scheduler.create, input),
    update: (input) => call(IPC.scheduler.update, input),
    remove: (id) => call(IPC.scheduler.remove, id),
    runNow: (id) => call(IPC.scheduler.runNow, id)
  },
  events: {
    onAgentEvent: (cb) => subscribe(IPC.push.agentEvent, cb),
    onShellChunk: (cb) => subscribe(IPC.push.shellChunk, cb),
    onShellExit: (cb) => subscribe(IPC.push.shellExit, cb),
    onTodos: (cb) => subscribe(IPC.push.todos, cb)
  }
}

contextBridge.exposeInMainWorld('pi', api)
