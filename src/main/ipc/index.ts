import { IPC } from '@shared/ipc'
import { runtime } from '../agent/runtime'
import { registerAgentIpc } from './agent'
import { send, setMainWindow } from './bus'
import { registerWorkspaceIpc } from './workspace'

export { setMainWindow }

/** 注册全部 IPC 处理器，并把运行时的推送接到窗口。 */
export function registerIpc(): void {
  runtime.setEmitter((event) => send(IPC.push.agentEvent, event))
  runtime.setTodoSink((sessionId, todos) => send(IPC.push.todos, { sessionId, todos }))

  registerWorkspaceIpc()
  registerAgentIpc()
}
