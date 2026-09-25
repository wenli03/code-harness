import type { TodoItem, ToolCall, ToolSchema } from '@shared/types'

export interface ToolContext {
  sessionId: string
  projectPath: string | null
  signal: AbortSignal
  /** 请求用户审批（permissionMode==='ask' 时由 UI 弹窗确认） */
  requestApproval(call: ToolCall, reason: string): Promise<boolean>
  log(level: 'info' | 'warn', message: string): void
  /** 派生子智能体（prime-agent 的 rlm.spawn 语义：真实子会话 + 独立上下文）。role='reviewer' 走生产就绪审查专用系统提示词。 */
  spawnSubAgent(input: { prompt: string; title?: string; role?: 'reviewer' }): Promise<string>
  setTodos(todos: TodoItem[]): void
  getTodos(): TodoItem[]
  /** 设置跨轮次长期目标 */
  setGoal(text: string): Promise<void>
  /** 写入长期记忆（带证据） */
  rememberMemory(input: { text: string; evidence: string }): Promise<void>
  /** 沉淀一条工作方式改进（Harness 精炼，带证据） */
  rememberRefinement(input: { text: string; evidence: string }): Promise<void>
}

export interface ToolRunResult {
  ok: boolean
  output: string
}

export interface ToolDefinition {
  schema: ToolSchema
  /** call 用于审计与审批展示；工具不应对它做业务判断 */
  run(args: Record<string, unknown>, ctx: ToolContext, call: ToolCall): Promise<ToolRunResult>
}

export const toolError = (message: string): ToolRunResult => ({ ok: false, output: message })
export const toolOk = (output: string): ToolRunResult => ({ ok: true, output })
