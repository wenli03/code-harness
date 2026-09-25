import { useMemo, useState } from 'react'
import { actions, useApp } from '../state/store'
import { baseName, relTime } from '../lib/format'
import { Icon } from './Icon'

export function Sidebar() {
  const { projects, sessions, projectPath, sessionId } = useApp()
  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return sessions
      .filter((session) => (showArchived ? session.archived : !session.archived))
      .filter((session) => !keyword || session.title.toLowerCase().includes(keyword))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, query, showArchived])

  const archivedCount = sessions.filter((session) => session.archived).length

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <span>项目</span>
          <button className="icon-btn" title="添加项目" onClick={() => void actions.pickAndAddProject()}>
            <Icon name="folderPlus" />
          </button>
        </div>
        {projects.length === 0 && (
          <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => void actions.pickAndAddProject()}>
            <Icon name="folderPlus" /> 打开一个代码目录
          </button>
        )}
        {projects.map((project) => (
          <div
            key={project.id}
            className={`project-item ${project.path === projectPath ? 'active' : ''}`}
            onClick={() => void actions.selectProject(project.path)}
            title={project.path}
          >
            <Icon name="folder" />
            <div className="session-main">
              <div className="session-title">{project.name}</div>
              <div className="session-sub truncate">{project.path}</div>
            </div>
            <div className="row-actions">
              <button
                className="icon-btn"
                title="从列表移除（不会删除磁盘文件）"
                onClick={(event) => {
                  event.stopPropagation()
                  void actions.removeProject(project.id)
                }}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="sidebar-section" style={{ paddingBottom: 0 }}>
        <div className="sidebar-section-title">
          <span>会话</span>
          <button className="icon-btn" title="新建会话" onClick={() => void actions.createSession()}>
            <Icon name="plus" />
          </button>
        </div>
        <input
          className="input"
          style={{ marginBottom: 6 }}
          placeholder="过滤会话…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="sidebar-list">
        {visible.length === 0 && (
          <div className="empty" style={{ padding: '18px 10px' }}>
            <Icon name="sparkle" size={20} />
            <div style={{ fontSize: '0.9em' }}>{showArchived ? '没有已归档会话' : '还没有会话'}</div>
            <div style={{ fontSize: '0.82em' }}>在下方输入框描述你的任务即可开始</div>
          </div>
        )}

        {visible.map((session) => (
          <div
            key={session.id}
            className={`session-item ${session.id === sessionId ? 'active' : ''}`}
            onClick={() => void actions.openSession(session.id)}
          >
            <Icon name={session.parentId ? 'brain' : 'sparkle'} />
            <div className="session-main">
              {renamingId === session.id ? (
                <input
                  className="input"
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={() => {
                    if (draft.trim()) void actions.renameSession(session.id, draft.trim())
                    setRenamingId(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') setRenamingId(null)
                  }}
                />
              ) : (
                <>
                  <div className="session-title">{session.title}</div>
                  <div className="session-sub">
                    <span>{relTime(session.updatedAt)}</span>
                    <span>·</span>
                    <span>{session.messageCount} 条</span>
                  </div>
                </>
              )}
            </div>
            <div className="row-actions">
              <button
                className="icon-btn"
                title="重命名"
                onClick={(event) => {
                  event.stopPropagation()
                  setDraft(session.title)
                  setRenamingId(session.id)
                }}
              >
                <Icon name="edit" size={13} />
              </button>
              <button
                className="icon-btn"
                title={session.archived ? '取消归档' : '归档'}
                onClick={(event) => {
                  event.stopPropagation()
                  void actions.archiveSession(session.id, !session.archived)
                }}
              >
                <Icon name="archive" size={13} />
              </button>
              <button
                className="icon-btn"
                title="删除会话"
                onClick={(event) => {
                  event.stopPropagation()
                  void actions.deleteSession(session.id)
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}

        {archivedCount > 0 && (
          <button
            className="btn ghost sm"
            style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
            onClick={() => setShowArchived((value) => !value)}
          >
            <Icon name="archive" size={13} />
            {showArchived ? '返回进行中会话' : `已归档（${archivedCount}）`}
          </button>
        )}
      </div>

      {projectPath && (
        <div className="sidebar-section" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <div className="session-sub truncate" title={projectPath}>
            <Icon name="folder" size={12} /> {baseName(projectPath)}
          </div>
        </div>
      )}
    </aside>
  )
}
