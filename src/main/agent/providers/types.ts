import type { JsonSchemaObject, TokenUsage, ToolCall } from '@shared/types'

export interface ImagePart {
  mimeType: string
  /** data URL，例如 data:image/png;base64,xxx */
  dataUrl: string
}

/** Provider 无关的对话回合表示，各 Provider 自行映射到自家 wire format。 */
export type ChatTurn =
  | { role: 'user'; text: string; images?: ImagePart[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: Array<{ id: string; name: string; output: string; ok: boolean }> }

export interface ChatRequest {
  model: string
  system: string
  turns: ChatTurn[]
  tools: Array<{ name: string; description: string; parameters: JsonSchemaObject }>
  temperature: number
  maxTokens: number
  fastMode?: boolean
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string }

export interface ChatProvider {
  readonly id: string
  readonly label: string
  stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>
}
