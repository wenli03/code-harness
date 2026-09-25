import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SessionMeta } from '@shared/types'
import { actions, useApp, type RightTab } from '../state/store'
import { relTime } from '../lib/format'
import { Icon, type IconName } from './Icon'

interface Entry {
  id: string
  label: string
  hint: string
  icon: IconName
  group: '命令' | '会话'
  run: () => void
}

const PANELS: Array<{ id: RightTab; label: string; icon: IconName }> = [
  { id: 'files', label: '文件', icon: 'file' },
  { id: 'changes', label: '变更', icon: 'git' },
  { id: 'terminal', label: '终端', icon: 'terminal' },
  { id: 'tasks', label: '定时任务', icon: 'clock' },
  { id: 'harness', label: 'Harness', icon: 'brain' }
]

export function CommandPalette() {
  const { paletteOpen, sessions, sessionId, status } = useApp()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [remote, setRemote] = useState<SessionMeta[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (paletteOpen) {
      setQuery('')
      setIndex(0)
    }
  }, [paletteOpen])

  // 服务端全文检索（带 140ms 去抖），空查询时退回最近会话
  useEffect(() => {
    if (!paletteOpen) return
    const keyword = query.trim()
    if (!keyword) {
      setRemote([])
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      void window.pi.sessions
        .search(keyword)
        .then((found) => {
          if (alive) setRemote(found.filter((session) => !session.isSubAgent))
        })
        .catch(() => {
          if (alive) setRemote([])
        })
    }, 140)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [paletteOpen, query])

  const commands = useMemo<Entry[]>(() => {
    const running = ['thinking', 'streaming', 'tool', 'waiting-approval'].includes(status)
    const list: Entry[] = [
      {
        id: 'session:new',
        label: '新建会话',
        hint: 'Ctrl N',
        icon: 'plus',
        group: '命令',
        run: () => void actions.createSession()
      },
      {
        id: 'project:add',
        label: '打开代码目录…',
        hint: '添加项目',
        icon: 'folderPlus',
        group: '命令',
        run: () => void actions.pickAndAddProject()
      },
      {
        id: 'settings:open',
        label: '打开设置',
        hint: 'Ctrl ,',
        icon: 'settings',
        group: '命令',
        run: () => actions.setSettingsOpen(true)
      },
      {
        id: 'theme:toggle',
        label: '切换亮色 / 暗色主题',
        hint: '外观',
        icon: 'sun',
        group: '命令',
        run: () => {
          const dark = document.documentElement.dataset.theme !== 'light'
          void actions.updateSettings({ theme: dark ? 'light' : 'dark' })
        }
      },
      {
        id: 'layout:sidebar',
        label: '折叠 / 展开侧栏',
        hint: 'Ctrl B',
        icon: 'sidebar',
        group: '命令',
        run: () => actions.toggleSidebar()
      },
      {
        id: 'layout:panel',
        label: '折叠 / 展开右侧面板',
        hint: 'Ctrl J',
        icon: 'panel',
        group: '命令',
        run: () => actions.togglePanel()
      }
    ]

    for (const panel of PANELS) {
      list.push({
        id: `panel:${panel.id}`,
        label: `打开${panel.label}面板`,
        hint: '面板',
        icon: panel.icon,
        group: '命令',
        run: () => actions.setRightTab(panel.id)
      })
    }

    if (running) {
      list.unshift({
        id: 'agent:abort',
        label: '中止当前回合',
        hint: '停止生成与工具执行',
        icon: 'stop',
        group: '命令',
        run: () => void actions.abort()
      })
    }
    return list
  }, [status])

  const entries = useMemo<Entry[]>(() => {
    const keyword = query.trim().toLowerCase()
    const matchedCommands = commands.filter(
      (command) => !keyword || `${command.label} ${command.hint}`.toLowerCase().includes(keyword)
    )
    const source = keyword ? remote : sessions.slice(0, 6)
    const sessionEntries: Entry[] = source
      .filter((session) => !session.archived)
      .map((session) => ({
        id: `session:${session.id}`,
        label: session.title,
        hint: `${relTime(session.updatedAt)} · ${session.messageCount} 条`,
        icon: session.parentId ? 'brain' : 'sparkle',
        group: '会话',
        run: () => void actions.openSession(session.id)
      }))

    if (!keyword) return [...matchedCommands, ...sessionEntries]

    const byId = new Map<string, Entry>()
    for (const entry of [...matchedCommands, ...sessionEntries]) byId.set(entry.id, entry)
    return [...byId.values()]
  }, [commands, query, remote, sessions])

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(entries.length - 1, 0)))
  }, [entries.length])

  useEffect(() => {
    const active = listRef.current?.querySelector('.palette-item.active')
    active?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!paletteOpen) return null

  const commit = (entry: Entry | undefined): void => {
    if (!entry) return
    actions.setPaletteOpen(false)
    entry.run()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex((current) => (entries.length ? (current + 1) % entries.length : 0))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex((current) => (entries.length ? (current - 1 + entries.length) % entries.length : 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      commit(entries[index])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      actions.setPaletteOpen(false)
    }
  }

  let lastGroup = ''

  return (
    <div className="overlay" onClick={() => actions.setPaletteOpen(false)}>
      <div className="palette" onClick={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder="搜索会话，或执行命令（新建会话 / 打开面板 / 切换主题…）"
          onChange={(event) => {
            setQuery(event.target.value)
            setIndex(0)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {entries.length === 0 && (
            <div className="empty" style={{ padding: '22px 10px' }}>
              <Icon name="search" size={18} />
              <div style={{ fontSize: '0.9em' }}>没有匹配结果</div>
            </div>
          )}

          {entries.map((entry, position) => {
            const header = entry.group !== lastGroup ? entry.group : null
            lastGroup = entry.group
            return (
              <div key={entry.id}>
                {header && (
                  <div className="sidebar-section-title" style={{ padding: '8px 10px 4px' }}>
                    {header}
                  </div>
                )}
                <div
                  className={`palette-item ${position === index ? 'active' : ''}`}
                  onMouseEnter={() => setIndex(position)}
                  onClick={() => commit(entry)}
                >
                  <Icon name={entry.icon} size={14} />
                  <span className="truncate">{entry.label}</span>
                  {entry.group === '会话' && entry.id === `session:${sessionId}` && <span className="chip accent">当前</span>}
                  <span className="hint truncate">{entry.hint}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
