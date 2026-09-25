import type { ProviderConfig, TokenUsage, ToolCall } from '@shared/types'
import { describeHttpError, iterateSSE } from './sse'
import type { ChatProvider, ChatRequest, StreamEvent } from './types'

/** OpenAI Chat Completions 兼容实现（覆盖 OpenAI / DeepSeek / GLM / vLLM / Ollama 等）。 */
export function createOpenAIProvider(config: ProviderConfig): ChatProvider {
  const base = config.baseUrl.replace(/\/+$/, '')

  return {
    id: config.id,
    label: config.name,
    async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
      const body = {
        model: request.model,
        messages: toMessages(request),
        tools: request.tools.length
          ? request.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
              }
            }))
          : undefined,
        tool_choice: request.tools.length ? ('auto' as const) : undefined,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true }
      }

      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
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

      // 流式工具调用按 index 累积分片
      const pending = new Map<number, { id: string; name: string; args: string }>()
      let stopReason = 'stop'
      let usage: TokenUsage | null = null

      for await (const payload of iterateSSE(response.body)) {
        if (payload === '[DONE]') break
        let parsed: any
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }

        if (parsed?.error) {
          yield { type: 'error', message: String(parsed.error?.message ?? parsed.error) }
          return
        }
        if (parsed?.usage) {
          usage = {
            inputTokens: Number(parsed.usage.prompt_tokens ?? 0),
            outputTokens: Number(parsed.usage.completion_tokens ?? 0),
            totalTokens: Number(parsed.usage.total_tokens ?? 0)
          }
        }

        const choice = parsed?.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          yield { type: 'reasoning', delta: delta.reasoning_content }
        }
        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'text', delta: delta.content }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const fragment of delta.tool_calls) {
            const index = Number(fragment.index ?? pending.size)
            const current = pending.get(index) ?? { id: '', name: '', args: '' }
            if (fragment.id) current.id = fragment.id
            if (fragment.function?.name) current.name = fragment.function.name
            if (typeof fragment.function?.arguments === 'string') current.args += fragment.function.arguments
            pending.set(index, current)
          }
        }
        if (choice.finish_reason) stopReason = String(choice.finish_reason)
      }

      for (const [, value] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        if (!value.name) continue
        const call = toToolCall(value.id || `call_${Math.random().toString(36).slice(2, 10)}`, value.name, value.args)
        yield { type: 'tool_call', call }
      }

      if (usage) yield { type: 'usage', usage }
      yield { type: 'done', stopReason }
    }
  }
}

function toToolCall(id: string, name: string, rawArgs: string): ToolCall {
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {}
    return { id, name, args: parsed as Record<string, unknown> }
  } catch {
    // 参数不是合法 JSON：保留原串并给出空参数，让工具层报出可读错误
    return { id, name, args: {}, raw: rawArgs }
  }
}

function toMessages(request: ChatRequest): unknown[] {
  const messages: unknown[] = [{ role: 'system', content: request.system }]
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      if (turn.images?.length) {
        messages.push({
          role: 'user',
          content: [
            ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
            ...turn.images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } }))
          ]
        })
      } else {
        messages.push({ role: 'user', content: turn.text })
      }
      continue
    }
    if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: turn.toolCalls.length
          ? turn.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
            }))
          : undefined
      })
      continue
    }
    for (const result of turn.results) {
      messages.push({
        role: 'tool',
        tool_call_id: result.id,
        content: result.output || (result.ok ? '(无输出)' : '(失败，无输出)')
      })
    }
  }
  return messages
}
