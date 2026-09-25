import type { ProviderConfig, ProviderStatus } from '@shared/types'
import { createAnthropicProvider } from './anthropic'
import { createOpenAIProvider } from './openai'
import type { ChatProvider } from './types'

export type { ChatProvider, ChatRequest, ChatTurn, StreamEvent } from './types'

export function createProvider(config: ProviderConfig): ChatProvider {
  if (config.kind === 'anthropic') return createAnthropicProvider(config)
  return createOpenAIProvider(config)
}

/** 连通性自检：只做最小代价探活，不消耗生成额度（OpenAI 兼容走 /models）。 */
export async function testProvider(config: ProviderConfig): Promise<ProviderStatus> {
  const base: ProviderStatus = {
    id: config.id,
    name: config.name,
    kind: config.kind,
    configured: Boolean(config.apiKey && config.models.length),
    reachable: null
  }
  if (!config.apiKey) {
    return { ...base, detail: '未填写 API Key' }
  }
  if (!config.models.length) {
    return { ...base, detail: '未填写模型列表' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const url = config.baseUrl.replace(/\/+$/, '')
    if (config.kind === 'anthropic') {
      const endpoint = url.endsWith('/v1') ? `${url}/messages` : `${url}/v1/messages`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          ...(config.headers ?? {})
        },
        body: JSON.stringify({
          model: config.models[0],
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }),
        signal: controller.signal
      })
      const ok = response.ok || response.status === 400
      return {
        ...base,
        reachable: ok,
        detail: response.ok ? '连接正常' : `HTTP ${response.status}（凭据或模型名可能不正确）`
      }
    }

    const response = await fetch(`${url}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}`, ...(config.headers ?? {}) },
      signal: controller.signal
    })
    return {
      ...base,
      reachable: response.ok,
      detail: response.ok ? '连接正常' : `HTTP ${response.status}`
    }
  } catch (error) {
    return {
      ...base,
      reachable: false,
      detail: error instanceof Error ? error.message : '连接失败'
    }
  } finally {
    clearTimeout(timer)
  }
}
