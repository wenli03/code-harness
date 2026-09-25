import { useState } from 'react'
import type { ToolCall, ToolResult } from '@shared/types'
import { duration, summarizeToolCall, toolLabel } from '../lib/format'
import { Icon } from './Icon'

/** 单条工具调用：折叠时只显示「工具 + 摘要 + 状态」，展开看完整输出。 */
export function ToolCallCard({
  call,
  result,
  status
}: {
  call: ToolCall
  result?: ToolResult
  status: 'running' | 'done' | 'error'
}) {
  const [open, setOpen] = useState(status === 'error')
  const summary = summarizeToolCall(call)

  return (
    <div className="tool-card">
      <div className="tool-head" onClick={() => setOpen((value) => !value)}>
        <span className={`tool-status ${status}`}>{status === 'done' ? '✓' : status === 'error' ? '!' : ''}</span>
        <span className="name">{toolLabel(call.name)}</span>
        <span className="summary truncate">{summary}</span>
        {result && <span className="muted">{duration(result.durationMs)}</span>}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </div>
      {open && (
        <div className="tool-output">
          {result ? result.output || '(无输出)' : '执行中…'}
        </div>
      )}
    </div>
  )
}
