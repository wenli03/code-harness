import { useEffect } from 'react'
import { actions, useApp } from './state/store'
import { ChatPanel } from './components/ChatPanel'
import { CommandPalette } from './components/CommandPalette'
import { RightPanel } from './components/RightPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { Icon } from './components/Icon'

/** StrictMode 在开发模式下会重复执行副作用，用模块级标记保证只初始化一次。 */
let booted = false

export function App() {
  const { ready, sidebarOpen, panelOpen } = useApp()

  useEffect(() => {
    if (booted) return
    booted = true
    void actions.init().catch((error: unknown) => {
      actions.toast('error', error instanceof Error ? error.message : String(error))
    })
  }, [])

  useEffect(() => {
    const isMac = navigator.platform.toLowerCase().includes('mac')

    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = isMac ? event.metaKey : event.ctrlKey
      const key = event.key.toLowerCase()

      if (mod && key === 'k') {
        event.preventDefault()
        actions.setPaletteOpen(true)
        return
      }
      if (mod && key === 'n') {
        event.preventDefault()
        void actions.createSession()
        return
      }
      if (mod && key === ',') {
        event.preventDefault()
        actions.setSettingsOpen(true)
        return
      }
      if (mod && key === 'b') {
        event.preventDefault()
        actions.toggleSidebar()
        return
      }
      if (mod && key === 'j') {
        event.preventDefault()
        actions.togglePanel()
        return
      }
      if (mod && key === '1') {
        event.preventDefault()
        actions.setRightTab('files')
        return
      }
      if (mod && key === '2') {
        event.preventDefault()
        actions.setRightTab('changes')
        return
      }
      if (mod && key === '3') {
        event.preventDefault()
        actions.setRightTab('terminal')
        return
      }
      if (mod && key === '4') {
        event.preventDefault()
        actions.setRightTab('tasks')
        return
      }
      if (mod && key === '5') {
        event.preventDefault()
        actions.setRightTab('harness')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!ready) {
    return (
      <div className="app">
        <div className="empty" style={{ height: '100%' }}>
          <span className="brand-mark" style={{ width: 30, height: 30, fontSize: 15 }}>
            π
          </span>
          <div className="row" style={{ gap: 8 }}>
            <span className="spin" />
            正在启动 Code Harness…
          </div>
        </div>
      </div>
    )
  }

  const workspaceClass = [
    'workspace',
    panelOpen ? '' : 'panel-collapsed',
    sidebarOpen ? '' : 'sidebar-collapsed'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="app">
      <TitleBar />
      <div className={workspaceClass}>
        <Sidebar />
        <ChatPanel />
        <RightPanel />
      </div>
      <StatusBar />

      <Toasts />
      <SettingsDialog />
      <CommandPalette />

      {!panelOpen && (
        <button
          className="icon-btn"
          title="展开右侧面板（Ctrl J）"
          onClick={() => actions.togglePanel()}
          style={{ position: 'fixed', right: 12, bottom: 34, background: 'var(--bg-elev-2)' }}
        >
          <Icon name="panel" />
        </button>
      )}
    </div>
  )
}
