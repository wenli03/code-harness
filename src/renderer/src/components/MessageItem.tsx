import { useState } from 'react'
import type { AgentMessage, ToolResult } from '@shared/types'
import { relTime } from '../lib/format'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'
import { Icon } from './Icon'

const WHO: Record<string, string> = {
  user: '你',
  assistant: 'Pi',
  tool: '工具',
  system: '系统'
}

export function MessageItem({
  message,
  results,
  toolStatus,
  streaming,
  hidden = false,
  onFork,
  onContinue,
  onToggleVisibility
}: {
  message: AgentMessage
  results: Record<string, ToolResult>
  toolStatus: Record<string, 'running' | 'done' | 'error'>
  streaming: boolean
  /** 该条已被"上下文编辑"从模型视角隐藏（转录里仍然保留，所以界面上照样显示） */
  hidden?: boolean
  /** 从这一条分叉出新会话 */
  onFork?: () => void
  /** 回到这一条继续（之后的对话从该处长出新分支） */
  onContinue?: () => void
  /** 隐藏 / 恢复这一条在模型上下文中的可见性 */
  onToggleVisibility?: (visible: boolean) => void
}) {
  const [showReasoning, setShowReasoning] = useState(false)
  const reasoning = message.reasoning ?? ''
  const toolCalls = message.toolCalls ?? []
  const actionable = Boolean(onFork || onContinue || onToggleVisibility)

  return (
    <div className={`msg ${message.role}${hidden ? ' msg-hidden' : ''}`}>
      <div className="msg-avatar">{message.role === 'user' ? '你' : message.role === 'assistant' ? 'π' : '·'}</div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="who">{WHO[message.role] ?? message.role}</span>
          <span>{relTime(message.createdAt)}</span>
          {message.meta?.usage && (
            <span className="muted">
              {message.meta.usage.inputTokens + message.meta.usage.outputTokens} tokens
            </span>
          )}
          {message.meta?.stopReason === 'aborted' && <span className="chip warn">已中止</span>}
          {hidden && (
            <span className="chip warn" title="这一条仍在转录里，只是不再发给模型">
              已从上下文隐藏
            </span>
          )}
        </div>

        {reasoning && (
          <div style={{ marginBottom: 8 }}>
            <button className="btn ghost sm" onClick={() => setShowReasoning((value) => !value)}>
              <Icon name={showReasoning ? 'chevronDown' : 'chevronRight'} size={13} />
              思考过程
            </button>
            {showReasoning && <div className="bubble" style={{ marginTop: 6 }}>{reasoning}</div>}
          </div>
        )}

        {(message.text || (streaming && !toolCalls.length)) && (
          <div className="bubble">
            <Markdown text={message.text} />
            {streaming && <span className="typing-caret" />}
          </div>
        )}

        {message.attachments && message.attachments.length > 0 && (
          <div className="attachments">
            {message.attachments.map((attachment, index) =>
              attachment.dataUrl ? (
                <img key={index} className="attachment-thumb" src={attachment.dataUrl} alt={attachment.name} />
              ) : (
                <span key={index} className="chip">
                  <Icon name="file" size={12} /> {attachment.name}
                </span>
              )
            )}
          </div>
        )}

        {toolCalls.length > 0 && (
          <div className="tool-list">
            {toolCalls.map((call) => (
              <ToolCallCard
                key={call.id}
                call={call}
                result={results[call.id]}
                status={toolStatus[call.id] ?? (results[call.id] ? (results[call.id].ok ? 'done' : 'error') : 'running')}
              />
            ))}
          </div>
        )}

        {actionable && !streaming && (
          <div className="msg-actions">
            {onContinue && (
              <button
                className="btn ghost sm"
                title="回到这一条继续：之后的对话会从这里长出一条新分支（原分支保留）"
                onClick={onContinue}
              >
                <Icon name="git" size={12} /> 从此继续
              </button>
            )}
            {onFork && (
              <button className="btn ghost sm" title="把这一条之前的历史复制成一个新会话" onClick={onFork}>
                <Icon name="plus" size={12} /> 分叉为新会话
              </button>
            )}
            {onToggleVisibility && (
              <button
                className="btn ghost sm"
                title={
                  hidden
                    ? '恢复这一条进入模型上下文（下个回合生效）'
                    : '把这一条从模型上下文里隐藏：转录与界面都不变，只是不再发给模型'
                }
                onClick={() => onToggleVisibility(hidden)}
              >
                <Icon name={hidden ? 'check' : 'x'} size={12} /> {hidden ? '恢复到上下文' : '从上下文隐藏'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
