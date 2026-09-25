import { actions, useApp } from '../state/store'
import { Icon } from './Icon'

const ICON = {
  info: 'info',
  ok: 'check',
  warn: 'alert',
  error: 'danger'
} as const

export function Toasts() {
  const { toasts } = useApp()
  if (!toasts.length) return null

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <Icon name={ICON[toast.kind]} size={15} />
          <div style={{ flex: 1, lineHeight: 1.5 }}>{toast.text}</div>
          <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => actions.dismissToast(toast.id)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
