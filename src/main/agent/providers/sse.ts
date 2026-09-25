/** 把 fetch 的响应体流解析为 SSE 的 data 负载序列（同时兼容 \n 与 \r\n 分隔）。 */
export async function* iterateSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const drain = (flush: boolean): string[] => {
    const out: string[] = []
    const separator = buffer.includes('\r\n\r\n') && !buffer.includes('\n\n') ? '\r\n\r\n' : '\n\n'
    let index = buffer.indexOf(separator)
    while (index >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + separator.length)
      out.push(block)
      index = buffer.indexOf(separator)
    }
    if (flush && buffer.trim()) {
      out.push(buffer)
      buffer = ''
    }
    return out
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (const block of drain(false)) {
        for (const payload of extractData(block)) yield payload
      }
    }
    buffer += decoder.decode()
    for (const block of drain(true)) {
      for (const payload of extractData(block)) yield payload
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 流已关闭，忽略
    }
  }
}

function extractData(block: string): string[] {
  const out: string[] = []
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimStart()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload) out.push(payload)
  }
  return out
}

/**
 * 服务端「内容审查」类拒绝的特征。DashScope 等国内网关会在请求参数完全正确时
 * 仍然拒掉整次调用（`DataInspectionFailed: Input text data may contain inappropriate content`）。
 * 这类错误原始报错毫无可操作性，必须翻译成人能看懂的话。
 */
const CONTENT_INSPECTION = /datainspection|data inspection|inappropriate content|content[_ ]?(policy|filter|moderation)|risk[_ ]?control/i

/** 把 HTTP 错误体整理成人类可读的提示（截断避免污染上下文）。 */
export function describeHttpError(status: number, statusText: string, body: string): string {
  const snippet = (body ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)

  if (CONTENT_INSPECTION.test(snippet)) {
    return [
      `HTTP ${status} ${statusText} — 请求被服务端内容审查拦截（不是你填的参数有问题）。`,
      '',
      '厂商的合规检查拒绝了本次请求携带的**输入文本**。最可能的来源是上下文里的历史内容',
      '（读过的文件正文、命令输出）——它们会被每一轮原样重发，所以典型症状是：',
      '某个会话一直报这个错，而新建会话就正常。',
      '',
      '可以这样处理：',
      '① 在设置 → 模型里换一个 Provider（各家审查尺度不同，例如 DeepSeek / 硅基流动实测不拦）；',
      '② 新建会话，让它不再携带那段历史；',
      '③ 如果是某个文件的正文触发的，别再让模型读它。',
      '',
      `原始响应：${snippet}`
    ].join('\n')
  }

  return `HTTP ${status} ${statusText}${snippet ? ` — ${snippet}` : ''}`
}
