import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MISSING_TOOL_RESULT, pairToolResults } from '../src/main/agent/turn-pairing.ts'
import type { ChatTurn } from '../src/main/agent/providers.ts'

/**
 * 「assistant 的 tool_calls ↔ tool 结果」是一条**协议不变量**：一旦破坏，
 * 这个会话此后每一轮都会被服务端 400 拒收 —— 用户看到的是「会话坏了，发什么报错」。
 *
 * 这些用例覆盖四种真实坏法：中止、流式报错、context-edit 隐藏了结果、旧版本遗留历史。
 */

const call = (id: string, name = 'read_file') => ({ id, name })

function assistant(...ids: string[]): ChatTurn {
  return { role: 'assistant', content: '', toolCalls: ids.map((id) => call(id)) }
}

function toolTurn(...results: { id: string; ok?: boolean }[]): ChatTurn {
  return {
    role: 'tool',
    results: results.map((r) => ({ id: r.id, name: 'read_file', ok: r.ok ?? true, output: `out-${r.id}` }))
  }
}

/** 协议体检：孤儿的 tool 回合不合法，且每个调用都必须有结果 */
function assertProtocolValid(turns: ChatTurn[]): void {
  const pending = new Set<string>()
  for (const turn of turns) {
    if (turn.role === 'tool') {
      assert.ok(pending.size > 0 || turn.results.length === 0, '出现孤儿 tool 回合（前面没有对应调用）')
      for (const result of turn.results) {
        assert.ok(pending.has(result.id), `tool 结果 ${result.id} 没有对应的 tool_call`)
        pending.delete(result.id)
      }
      continue
    }
    if (turn.role === 'assistant') {
      assert.equal(pending.size, 0, '上一个 assistant 的 tool_calls 没有被结果覆盖完')
      for (const c of turn.toolCalls) pending.add(c.id)
    }
  }
  assert.equal(pending.size, 0, '有 tool_call 始终没拿到结果')
}

describe('pairToolResults：协议自愈', () => {
  it('完整配对的序列原样通过', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'hi' },
      assistant('c1'),
      toolTurn({ id: 'c1' })
    ]
    const out = pairToolResults(turns)
    assertProtocolValid(out)
    assert.equal(out.length, 3)
  })

  it('调用没有结果时补位，并明确告诉模型「这次没执行」而不是留空', () => {
    const out = pairToolResults([assistant('c1')])
    assertProtocolValid(out)
    assert.equal(out.length, 2)
    const results = out[1].results
    assert.equal(results[0].id, 'c1')
    assert.equal(results[0].ok, false)
    assert.equal(results[0].output, MISSING_TOOL_RESULT)
  })

  it('部分结果缺失时，只补缺的那些（已有结果不能被覆盖）', () => {
    const out = pairToolResults([assistant('c1', 'c2'), toolTurn({ id: 'c1' })])
    assertProtocolValid(out)
    const results = out[1].results
    assert.deepEqual(results.map((r) => r.id), ['c1', 'c2'])
    assert.equal(results[0].output, 'out-c1')
    assert.equal(results[1].output, MISSING_TOOL_RESULT)
  })

  it('丢弃孤儿 tool 回合（context-edit 只隐藏了结果、没隐藏调用的情况）', () => {
    const out = pairToolResults([
      { role: 'user', content: 'hi' },
      toolTurn({ id: 'ghost' }),
      assistant('c1'),
      toolTurn({ id: 'c1' })
    ])
    assertProtocolValid(out)
    assert.equal(out.filter((t) => t.role === 'tool').length, 1)
  })

  it('多个连续 assistant 都各自配到自己的 tool 回合', () => {
    const out = pairToolResults([assistant('c1'), toolTurn({ id: 'c1' }), assistant('c2'), toolTurn({ id: 'c2' })])
    assertProtocolValid(out)
    assert.equal(out.length, 4)
  })

  it('无 toolCalls 的 assistant 不会被凭空补一个 tool 回合', () => {
    const out = pairToolResults([{ role: 'assistant', content: '直接回答', toolCalls: [] }])
    assertProtocolValid(out)
    assert.equal(out.length, 1)
  })

  it('不修改输入（纯函数），否则调用方会静默改掉落盘历史', () => {
    const turns: ChatTurn[] = [assistant('c1')]
    const before = JSON.stringify(turns)
    pairToolResults(turns)
    assert.equal(JSON.stringify(turns), before)
  })
})
