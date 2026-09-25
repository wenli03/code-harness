import type { ChatTurn } from './providers'

/**
 * 回合序列的协议体检：把 `assistant 的 tool_calls ↔ tool 结果` 修成严格配对。
 *
 * 单独成模块的原因：这是一条**不变量**，不是某段流程的实现细节。它需要能被单独验证
 * （不拉起 Electron、不联网就能跑用例），也需要在阅读 session.ts 时一眼看得见——
 * 它是「协议层」的东西，混在两千行的会话循环里只会被当成一段防御性噪声。
 *
 * 为什么必须存在这一层：
 *  OpenAI / Anthropic 都要求 assistant 消息里的每个 tool_call 都有对应的 tool 消息应答
 *  （服务端原话：`An assistant message with 'tool_calls' must be followed by tool messages
 *  responding to each 'tool_call_id'`）。这条不变量一旦被破坏，**整个会话此后每一轮都 400**：
 *  请求在进入模型之前就被拒了，模型连解释的机会都没有，用户看到的是「这个会话坏了，
 *  发什么都报错，只能新建会话」。
 *
 * 为什么会坏（都是真实路径，不是理论风险）：
 *  ① 用户在工具批次执行到一半时点「中止」；
 *  ② 流式响应报错，但已经收下的 tool_calls 被落盘；
 *  ③ 用户用 context-edit 隐藏了某条结果，却没隐藏它的调用；
 *  ④ 旧版本留下的历史——append-only 的历史不会因为后来修好了记录端而被治好。
 *
 * 所以自愈放在**发送前**，而不是只靠记录端保证正确：老会话也能靠这一层重新可用。
 */

/** 补位结果：调用没有留下任何结果时，用它明确告诉模型「这里什么都没有」，而不是留空。 */
export const MISSING_TOOL_RESULT =
  '（这次调用没有留下结果：它在执行前被中止，或结果已从上下文中移除。' +
  '需要这个工具的结论就重新调用一次，不要假设它执行过。）'

/**
 * 返回一份新的回合序列，保证：
 *  - 每个声明了 toolCalls 的 assistant 回合，后面**紧跟**一个 tool 回合，且结果覆盖每一个调用（缺的补位）；
 *  - 不存在孤儿 tool 回合（前面没有对应调用的结果）——服务端同样会拒收未知的 tool_call_id。
 *
 * 为什么补位而不是丢弃整个 assistant 回合：丢弃会让模型不知道自己刚才请求过什么，
 * 于是它可能重新规划一套完全不同的动作；补一条说明能让它准确知道「那次没执行」。
 */
export function pairToolResults(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = []
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]
    // tool 回合只允许由下面「紧跟在 assistant 之后」的分支产出，其余都是孤儿
    if (turn.role === 'tool') continue
    if (turn.role === 'user') {
      out.push(turn)
      continue
    }

    out.push(turn)
    if (!turn.toolCalls.length) continue

    const next = turns[index + 1]
    const provided = next?.role === 'tool' ? next.results : []
    if (next?.role === 'tool') index += 1

    const byId = new Map(provided.map((result) => [result.id, result]))
    out.push({
      role: 'tool',
      results: turn.toolCalls.map(
        (call) =>
          byId.get(call.id) ?? {
            id: call.id,
            name: call.name,
            ok: false,
            output: MISSING_TOOL_RESULT
          }
      )
    })
  }
  return out
}
