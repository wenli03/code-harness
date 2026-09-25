import type { ProviderConfig, ProviderKind } from './types'

/**
 * 内置 Provider 预置：只包含「接入信息」，不含任何密钥。
 * 目的：省去用户查 Base URL 与模型 id 的成本，并规避常见坑
 * （例如智谱的模型 id 是全小写的 glm-5.3-flash，大小写写错会 400）。
 *
 * 下面的 baseUrl 与模型 id 均为实测可用（2026-09 校验，见 docs/PROVIDERS.md）。
 */
export interface ProviderPreset {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  models: string[]
  /** 申请 API Key 的页面 */
  keyUrl?: string
  /** 需要提醒用户的注意事项（UI 上直接展示） */
  note?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-pro', 'deepseek-flash'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '模型自带思维链，思考过程会在对话里折叠展示'
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    kind: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      'deepseek-ai/DeepSeek-V4-Pro',
      'deepseek-ai/DeepSeek-V4-Flash',
      'Qwen/Qwen3.8-27B',
      'zai-org/GLM-5.3',
      'moonshotai/Kimi-K2.7-Code'
    ],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '一个 Key 通吃多家模型；带 Pro/ 前缀的是独立付费通道'
  },
  {
    id: 'bigmodel',
    label: '智谱 GLM（BigModel）',
    kind: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3-flash', 'glm-5.3', 'glm-4.7', 'glm-4.6'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '模型 id 全小写；账户需要余额或资源包，否则会返回 429'
  },
  {
    id: 'qianwen',
    label: '千问 Qwen（DashScope 兼容模式）',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-27b'],
    keyUrl: 'https://platform.qianwenai.com/home/api-keys',
    note: 'Qwen3.8 系是推理模型，思考过程会在对话里折叠展示。与下面那条 Anthropic 原生协议共用同一把 Key，二选一即可'
  },
  {
    id: 'qianwen-anthropic',
    label: '千问 Qwen（Anthropic 原生）',
    kind: 'anthropic',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-27b'],
    keyUrl: 'https://platform.qianwenai.com/home/api-keys',
    note: '同一把 Key 可用，与上一条只是协议不同；这条走 /v1/messages，工具调用语义更贴合 Anthropic 规范'
  },
  {
    id: 'ollama',
    label: '本地 Ollama',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [],
    keyUrl: 'https://ollama.com/download',
    note: '先 `ollama serve` 并 `ollama pull <模型>`；API Key 填任意非空字符串即可，模型名要写成本地实际存在的'
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '各家模型迭代频繁，这里不预设模型名，请填写你账号下可用的'
  },
  {
    id: 'anthropic',
    label: 'Anthropic 官方',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: '同样不预设模型名，请填写你账号下可用的'
  }
]

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)
}

/** 预置 → 可编辑的 ProviderConfig（apiKey 留空，由用户填或由 seed 脚本注入）。 */
export function providerFromPreset(preset: ProviderPreset, apiKey = ''): ProviderConfig {
  return {
    id: crypto.randomUUID(),
    name: preset.label,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    apiKey,
    models: [...preset.models]
  }
}
