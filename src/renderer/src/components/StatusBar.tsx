import { actions, useApp } from '../state/store'
import { statusLabel } from '../lib/format'
import { Icon } from './Icon'

const DOT: Record<string, string> = {
  idle: 'var(--text-muted)',
  thinking: 'var(--accent)',
  streaming: 'var(--accent)',
  tool: 'var(--warn)',
  'waiting-approval': 'var(--warn)',
  aborted: 'var(--text-muted)',
  error: 'var(--err)'
}

export function StatusBar() {
  const { status, detail, todos, messages, appInfo, settings, sessionId } = useApp()
  const done = todos.filter((todo) => todo.status === 'completed').length
  const running = ['thinking', 'streaming', 'tool', 'waiting-approval'].includes(status)

  return (
    <footer className="statusbar">
      <span className="row" style={{ gap: 6 }}>
        <span
          className={running ? 'pulse' : undefined}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: DOT[status] ?? 'var(--text-muted)',
            display: 'inline-block'
          }}
        />
        {statusLabel(status)}
      </span>
      {detail && <span className="truncate" style={{ maxWidth: 320 }}>· {detail}</span>}
      {todos.length > 0 && (
        <span className="row" style={{ gap: 4 }}>
          <Icon name="list" size={12} /> {done}/{todos.length} 待办
        </span>
      )}
      <div className="spacer" />
      {sessionId && <span>{messages.filter((message) => message.role === 'user').length} 轮对话</span>}
      <span>{settings?.providers.length ?? 0} 个 Provider</span>
      <button className="btn ghost sm" onClick={() => actions.setSettingsOpen(true)}>
        Code Harness {appInfo?.version ?? ''}
      </button>
    </footer>
  )
}
