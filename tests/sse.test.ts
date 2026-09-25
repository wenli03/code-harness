import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeHttpError, iterateSSE } from '../src/main/agent/providers/sse.ts'

/** 把若干段字节拼成一个流，用来模拟**网络分片**（真正的坑都在这里）。 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = []
  for await (const payload of iterateSSE(streamOf(chunks))) out.push(payload)
  return out
}

describe('iterateSSE：按 \\n\\n 切块并剥掉 data: 前缀', () => {
  it('解析多个事件', async () => {
    assert.deepEqual(await collect(['data: {"a":1}\n\ndata: {"b":2}\n\n']), ['{"a":1}', '{"b":2}'])
  })

  it('兼容 \\r\\n\\r\\n 分隔（部分网关会这样发）', async () => {
    assert.deepEqual(await collect(['data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n']), ['{"a":1}', '{"b":2}'])
  })

  it('忽略注释行与 event: 行，只取 data', async () => {
    assert.deepEqual(await collect([': keep-alive\nevent: message\ndata: {"a":1}\n\n']), ['{"a":1}'])
  })

  it('**分片边界**：一个事件被拆到两次 read 里，仍应拼回一个完整负载', async () => {
    assert.deepEqual(await collect(['data: {"a"', ':1}\n\n']), ['{"a":1}'])
  })

  it('**分片边界**：分隔符本身被拆开', async () => {
    assert.deepEqual(await collect(['data: {"a":1}\n', '\ndata: {"b":2}\n\n']), ['{"a":1}', '{"b":2}'])
  })

  it('**[DONE] 原样透传**（由上层决定怎么终止，解析层不替它做判断）', async () => {
    assert.deepEqual(await collect(['data: {"a":1}\n\ndata: [DONE]\n\n']), ['{"a":1}', '[DONE]'])
  })

  it('流结束时残留的不完整块也会被吐出（否则最后一帧会丢）', async () => {
    assert.deepEqual(await collect(['data: {"a":1}']), ['{"a":1}'])
  })

  it('空行与空白 data 不产出空负载', async () => {
    assert.deepEqual(await collect(['\n\n', 'data:\n\n', 'data:   \n\n']), [])
  })

  it('UTF-8 多字节字符被拆到两次 read 时不会花屏', async () => {
    const encoder = new TextEncoder()
    const bytes = encoder.encode('data: 你好\n\n')
    const parts = [bytes.slice(0, 8), bytes.slice(8)]  // 故意切在「你」的字节中间
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(p)
        controller.close()
      }
    })
    const out: string[] = []
    for await (const payload of iterateSSE(stream)) out.push(payload)
    assert.deepEqual(out, ['你好'])
  })
})

describe('describeHttpError：把不可操作的报错翻译成可操作的话', () => {
  it('内容审查类拒绝要给出「换 Provider / 新建会话」这类动作', () => {
    const msg = describeHttpError(400, 'Bad Request',
      '{"error":{"code":"DataInspectionFailed","message":"Input text data may contain inappropriate content."}}')
    assert.match(msg, /内容审查/)
    assert.match(msg, /换一个 Provider/)
    assert.match(msg, /新建会话/)
  })

  it('普通错误保持简短并截断，不污染上下文', () => {
    const msg = describeHttpError(500, 'Internal Server Error', 'x'.repeat(5000))
    assert.match(msg, /HTTP 500/)
    assert.ok(msg.length < 600, `错误提示过长：${msg.length}`)
  })

  it('空错误体也能给出可读提示', () => {
    assert.match(describeHttpError(502, 'Bad Gateway', ''), /HTTP 502/)
  })
})
