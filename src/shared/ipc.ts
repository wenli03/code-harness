/** IPC 通道常量：主进程注册、preload 调用共用，避免字符串漂移。 */
export const IPC = {
  app: {
    info: 'app:info',
    openExternal: 'app:open-external',
    pickDirectory: 'app:pick-directory',
    pickFiles: 'app:pick-files',
    revealPath: 'app:reveal-path',
    setBadge: 'app:set-badge',
    getAutoLaunch: 'app:get-auto-launch',
    setAutoLaunch: 'app:set-auto-launch'
  },
  settings: {
    get: 'settings:get',
    save: 'settings:save',
    testProvider: 'settings:test-provider'
  },
  projects: {
    list: 'projects:list',
    add: 'projects:add',
    remove: 'projects:remove',
    touch: 'projects:touch'
  },
  sessions: {
    list: 'sessions:list',
    create: 'sessions:create',
    get: 'sessions:get',
    rename: 'sessions:rename',
    archive: 'sessions:archive',
    remove: 'sessions:remove',
    search: 'sessions:search',
    /** 当前分支的转录视图（含隐藏项、压缩标记、可切换的分支尖） */
    transcript: 'sessions:transcript',
    /** 回到历史某点继续（移动指针，不新建会话文件） */
    setHead: 'sessions:set-head',
    /** 从历史某点分叉出一个新会话 */
    fork: 'sessions:fork',
    /** 把当前分支复制成新会话 */
    clone: 'sessions:clone',
    /** 把某条消息对模型隐藏 / 恢复 */
    setVisibility: 'sessions:set-visibility'
  },
  trust: {
    info: 'trust:info',
    set: 'trust:set'
  },
  agent: {
    run: 'agent:run',
    steer: 'agent:steer',
    abort: 'agent:abort',
    status: 'agent:status',
    answerApproval: 'agent:answer-approval',
    pendingApprovals: 'agent:pending-approvals'
  },
  files: {
    tree: 'files:tree',
    read: 'files:read'
  },
  git: {
    status: 'git:status',
    diff: 'git:diff',
    stage: 'git:stage',
    unstage: 'git:unstage',
    discard: 'git:discard',
    commit: 'git:commit'
  },
  shell: {
    run: 'shell:run',
    kill: 'shell:kill'
  },
  skills: {
    list: 'skills:list',
    save: 'skills:save',
    remove: 'skills:remove',
    toggle: 'skills:toggle'
  },
  harness: {
    view: 'harness:view',
    setGoal: 'harness:set-goal',
    updateGoal: 'harness:update-goal',
    rollback: 'harness:rollback',
    addMemory: 'harness:add-memory',
    removeMemory: 'harness:remove-memory'
  },
  scheduler: {
    list: 'scheduler:list',
    create: 'scheduler:create',
    update: 'scheduler:update',
    remove: 'scheduler:remove',
    runNow: 'scheduler:run-now'
  },
  /** 主进程主动推送 */
  push: {
    agentEvent: 'push:agent-event',
    shellChunk: 'push:shell-chunk',
    shellExit: 'push:shell-exit',
    todos: 'push:todos',
    menu: 'push:menu'
  }
} as const

export type IpcChannel = typeof IPC
