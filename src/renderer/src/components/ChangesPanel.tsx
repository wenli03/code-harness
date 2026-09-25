import { useCallback, useEffect, useState } from 'react'
import type { GitFileChange, GitStatus } from '@shared/types'
import { actions, useApp } from '../state/store'
import { Icon } from './Icon'

export function ChangesPanel() {
  const { projectPath } = useApp()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [selected, setSelected] = useState<GitFileChange | null>(null)
  const [diff, setDiff] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!projectPath) {
      setStatus(null)
      return
    }
    try {
      const next = await window.pi.git.status(projectPath)
      setStatus(next)
      setSelected((current) =>
        current ? next.files.find((file) => file.path === current.path) ?? null : null
      )
    } catch (error) {
      actions.toast('error', error instanceof Error ? error.message : String(error))
    }
  }, [projectPath])

  useEffect(() => {
    setSelected(null)
    setDiff('')
    void load()
    const timer = window.setInterval(() => void load(), 8000)
    return () => window.clearInterval(timer)
  }, [load])

  const openDiff = async (change: GitFileChange): Promise<void> => {
    if (!projectPath) return
    setSelected(change)
    try {
      setDiff(await window.pi.git.diff(projectPath, change.path, change.staged))
    } catch (error) {
      setDiff(String(error))
    }
  }

  const act = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await task()
      await load()
      if (selected) await openDiff(selected)
    } catch (error) {
      actions.toast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (!projectPath) {
    return (
      <div className="empty" style={{ paddingTop: 60 }}>
        <Icon name="git" size={22} />
        <div style={{ fontSize: '0.9em' }}>先选择一个项目目录</div>
      </div>
    )
  }

  const staged = status?.files.filter((file) => file.staged) ?? []
  const unstaged = status?.files.filter((file) => !file.staged) ?? []

  return (
    <div className="col" style={{ height: '100%', minHeight: 0 }}>
      <div className="panel-toolbar">
        <span className="chip">
          <Icon name="branch" size={12} />
          {status?.isRepo ? status.branch || 'HEAD' : '非 Git 仓库'}
        </span>
        {!!status?.ahead && <span className="chip accent">↑{status.ahead}</span>}
        {!!status?.behind && <span className="chip warn">↓{status.behind}</span>}
        <div className="spacer" />
        {busy && <span className="spin" />}
        <button className="icon-btn" title="刷新" onClick={() => void load()}>
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {status && !status.isRepo && (
        <div className="empty" style={{ paddingTop: 50 }}>
          <Icon name="git" size={22} />
          <div style={{ fontSize: '0.9em' }}>{status.error ?? '该目录不是 Git 仓库'}</div>
          <div style={{ fontSize: '0.84em' }}>Agent 仍可读写文件并执行命令</div>
        </div>
      )}

      {status?.isRepo && (
        <>
          <div className="panel-form">
            <textarea
              rows={2}
              placeholder="提交说明（提交会一并提交暂存区内容）"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              style={{ minHeight: 56 }}
            />
            <div className="row">
              <button
                className="btn primary"
                disabled={!message.trim() || !staged.length || busy}
                onClick={() =>
                  void act(async () => {
                    const result = await window.pi.git.commit(projectPath, message.trim())
                    actions.toast(result.ok ? 'ok' : 'error', result.output || '已提交')
                    if (result.ok) setMessage('')
                  })
                }
              >
                <Icon name="check" size={14} /> 提交暂存区（{staged.length}）
              </button>
              <button
                className="btn"
                disabled={!status.files.length || busy}
                onClick={() =>
                  void act(() =>
                    window.pi.git.stage(
                      projectPath,
                      status.files.map((file) => file.path)
                    )
                  )
                }
              >
                全部暂存
              </button>
            </div>
          </div>

          <div style={{ flex: diff ? '0 0 38%' : 1, minHeight: 0, overflow: 'auto' }}>
            {status.clean && <div className="empty">工作区干净</div>}
            {staged.length > 0 && <GroupLabel text={`已暂存（${staged.length}）`} />}
            {staged.map((change) => (
              <ChangeRow
                key={`s-${change.path}`}
                change={change}
                selected={selected?.path === change.path && selected.staged}
                onOpen={() => void openDiff(change)}
                onStage={() => void act(() => window.pi.git.unstage(projectPath, [change.path]))}
                stageLabel="取消暂存"
              />
            ))}
            {unstaged.length > 0 && <GroupLabel text={`未暂存（${unstaged.length}）`} />}
            {unstaged.map((change) => (
              <ChangeRow
                key={`u-${change.path}`}
                change={change}
                selected={selected?.path === change.path && !selected.staged}
                onOpen={() => void openDiff(change)}
                onStage={() => void act(() => window.pi.git.stage(projectPath, [change.path]))}
                stageLabel="暂存"
                onDiscard={() => void act(() => window.pi.git.discard(projectPath, [change.path]))}
              />
            ))}
          </div>

          {selected && (
            <div className="col" style={{ flex: 1, minHeight: 0, borderTop: '1px solid var(--border)' }}>
              <div className="panel-toolbar">
                <span className="truncate mono" style={{ fontSize: '0.84em' }}>{selected.path}</span>
                <div className="spacer" />
                <button className="icon-btn" title="关闭" onClick={() => { setSelected(null); setDiff('') }}>
                  <Icon name="x" size={13} />
                </button>
              </div>
              <div className="diff" style={{ flex: 1, minHeight: 0 }}>
                {diff.split('\n').map((line, index) => (
                  <span key={index} className={`diff-line ${classifyDiff(line)}`}>
                    {line || ' '}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function GroupLabel({ text }: { text: string }) {
  return (
    <div
      className="muted"
      style={{ padding: '7px 10px 4px', fontSize: '0.78em', letterSpacing: '0.06em', textTransform: 'uppercase' }}
    >
      {text}
    </div>
  )
}

function ChangeRow({
  change,
  selected,
  onOpen,
  onStage,
  stageLabel,
  onDiscard
}: {
  change: GitFileChange
  selected: boolean
  onOpen: () => void
  onStage: () => void
  stageLabel: string
  onDiscard?: () => void
}) {
  const code = change.untracked ? '??' : `${change.x}${change.y}`.trim() || 'M'
  const kind = change.untracked ? 'untracked' : change.y === 'M' || change.x === 'M' ? 'mod' : change.y === 'D' || change.x === 'D' ? 'del' : 'add'

  return (
    <div className={`change-row ${selected ? 'selected' : ''}`} onClick={onOpen}>
      <span className={`change-badge ${kind}`}>{code}</span>
      <span className="truncate mono" style={{ flex: 1, fontSize: '0.86em' }}>
        {change.path}
      </span>
      <button
        className="btn ghost sm"
        onClick={(event) => {
          event.stopPropagation()
          onStage()
        }}
      >
        {stageLabel}
      </button>
      {onDiscard && (
        <button
          className="btn ghost sm danger"
          title="丢弃该文件的改动（不可撤销）"
          onClick={(event) => {
            event.stopPropagation()
            onDiscard()
          }}
        >
          丢弃
        </button>
      )}
    </div>
  )
}

function classifyDiff(line: string): string {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return ''
}
