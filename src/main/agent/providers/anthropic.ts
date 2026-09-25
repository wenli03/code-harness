import type { ProviderConfig, TokenUsage, ToolCall } from '@shared/types'
import { describeHttpError, iterateSSE } from './sse'
import type { ChatProvider, ChatRequest, StreamEvent } from './types'

const ANTHROPIC_VERSION = '2023-06-01'

/** Anthropic Messages API 实现（含 tool_use / thinking 流式）。 */
export function createAnthropicProvider(config: ProviderConfig): ChatProvider {
  const base = config.baseUrl.replace(/\/+$/, '')
  const endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`

  return {
    id: config.id,
    label: config.name,
    async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
      const body = {
        model: request.model,
        system: request.system,
        messages: toMessages(request),
        tools: request.tools.length
          ? request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters
            }))
          : undefined,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        stream: true
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          ...(config.headers ?? {})
        },
        body: JSON.stringify(body),
        signal
      })

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '')
        yield { type: 'error', message: describeHttpError(response.status, response.statusText, text) }
        return
      }

      // 当前正在流式输出的 content block
      let activeTool: { id: string; name: string; json: string } | null = null
      let stopReason = 'end_turn'
      let inputTokens = 0
      let outputTokens = 0

      for await (const payload of iterateSSE(response.body)) {
        let parsed: any
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }

        switch (parsed?.type) {
          case 'message_start':
            inputTokens = Number(parsed.message?.usage?.input_tokens ?? 0)
            break
          case 'content_block_start': {
            const block = parsed.content_block
            if (block?.type === 'tool_use') {
              activeTool = { id: String(block.id), name: String(block.name), json: '' }
            }
            break
          }
          case 'content_block_delta': {
            const delta = parsed.delta ?? {}
            if (delta.type === 'text_delta' && delta.text) {
              yield { type: 'text', delta: String(delta.text) }
            } else if (delta.type === 'thinking_delta' && delta.thinking) {
              yield { type: 'reasoning', delta: String(delta.thinking) }
            } else if (delta.type === 'input_json_delta' && activeTool) {
              activeTool.json += String(delta.partial_json ?? '')
            }
            break
          }
          case 'content_block_stop': {
            if (activeTool) {
              yield { type: 'tool_call', call: toToolCall(activeTool) }
              activeTool = null
            }
            break
          }
          case 'message_delta': {
            if (parsed.delta?.stop_reason) stopReason = String(parsed.delta.stop_reason)
            if (parsed.usage?.output_tokens) outputTokens = Number(parsed.usage.output_tokens)
            break
          }
          case 'error': {
            yield { type: 'error', message: String(parsed.error?.message ?? '未知 Provider 错误') }
            return
          }
          default:
            break
        }
      }

      if (inputTokens || outputTokens) {
        const usage: TokenUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
        yield { type: 'usage', usage }
      }
      yield { type: 'done', stopReason }
    }
  }
}

function toToolCall(active: { id: string; name: string; json: string }): ToolCall {
  try {
    return { id: active.id, name: active.name, args: active.json.trim() ? JSON.parse(active.json) : {} }
  } catch {
    return { id: active.id, name: active.name, args: {}, raw: active.json }
  }
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: unknown[]
}

function toMessages(request: ChatRequest): unknown[] {
  const raw: AnthropicMessage[] = []

  for (const turn of request.turns) {
    if (turn.role === 'user') {
      const content: unknown[] = []
      for (const image of turn.images ?? []) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mimeType,
            data: image.dataUrl.split(',')[1] ?? ''
          }
        })
      }
      if (turn.text) content.push({ type: 'text', text: turn.text })
      // Anthropic 不接受空 text block
      if (!content.length) content.push({ type: 'text', text: '（空消息）' })
      raw.push({ role: 'user', content })
      continue
    }

    if (turn.role === 'assistant') {
      const content: unknown[] = []
      if (turn.text) content.push({ type: 'text', text: turn.text })
      for (const call of turn.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} })
      }
      raw.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '…' }] })
      continue
    }

    // 工具结果以 user 回合紧随 tool_use 之后（Anthropic 的约定）
    raw.push({
      role: 'user',
      content: turn.results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.id,
        is_error: !result.ok,
        content: result.output || (result.ok ? '(无输出)' : '(失败，无输出)')
      }))
    })
  }

  return normalizeAlternation(raw)
}

/**
 * Anthropic 要求 messages 的 role 严格交替，且首条必须是 user。展开历史时会自然违反两次：
 *  ① 工具结果回合 + 用户插话回合 → 连续两个 user；
 *  ② 压缩摘要（assistant）紧跟在一条 assistant 消息之前 → 连续两个 assistant。
 * 这里合并相邻同角色、并在首条非 user 时补一条最小 user 回合。
 * 合并是安全的：工具结果回合的内容始终排在同一条消息的前部，符合 tool_result 必须前置的要求。
 */
function normalizeAlternation(messages: AnthropicMessage[]): unknown[] {
  const out: AnthropicMessage[] = []
  for (const message of messages) {
    const last = out[out.length - 1]
    if (last && last.role === message.role) {
      last.content.push(...message.content)
      continue
    }
    out.push({ role: message.role, content: [...message.content] })
  }
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '（继续）' }] })
  }
  return out
}
