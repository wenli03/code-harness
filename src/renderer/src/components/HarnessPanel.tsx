import { useCallback, useEffect, useState } from 'react'
import type { HarnessView } from '@shared/types'
import { actions, useApp } from '../state/store'
import { relTime } from '../lib/format'
import { Icon } from './Icon'

/**
 * Harness 面板：把「持续 harness」对用户摊开——长期记忆、目标、精炼建议、快照回滚。
 * 记忆与精炼会注入系统提示词，因此必须让用户能看、能删、能回滚。
 */
export function HarnessPanel() {
  const { projectPath, sessionId, messages } = useApp()
  const [view, setView] = useState<HarnessView | null>(null)
  const [memory, setMemory] = useState('')
  const [evidence, setEvidence] = useState('')
  const [goal, setGoal] = useState('')

  const load = useCallback(async () => {
    if (!sessionId) {
      setView(null)
      return
    }
    setView(await window.pi.harness.view({ projectPath, sessionId }))
  }, [projectPath, sessionId])

  useEffect(() => {
    void load()
  }, [load, messages.length])

  if (!sessionId) {
    return (
      <div className="empty" style={{ paddingTop: 60 }}>
        <Icon name="brain" size={22} />
        <div style={{ fontSize: '0.9em' }}>选择一个会话后可查看 Harness 状态</div>
      </div>
    )
  }

  const addMemory = async (): Promise<void> => {
    if (!memory.trim()) return
    setView(
      await window.pi.harness.addMemory({
        projectPath,
        text: memory.trim(),
        evidence: evidence.trim() || `用户于 ${new Date().toLocaleString()} 手动添加`
      })
    )
    setMemory('')
    setEvidence('')
  }

  const addGoal = async (): Promise<void> => {
    if (!goal.trim()) return
    await window.pi.harness.setGoal({ sessionId, text: goal.trim() })
    setGoal('')
    await load()
  }

  return (
    <div className="col" style={{ minHeight: '100%' }}>
      <div className="panel-form">
        <div className="muted" style={{ fontSize: '0.82em' }}>
          注入系统提示词：{view?.injectedChars ?? 0} 字符 · 记忆 {view?.memories.length ?? 0} 条 · 精炼{' '}
          {view?.refinements.filter((item) => item.active).length ?? 0} 条
        </div>
        <textarea
          rows={2}
          placeholder="新增长期记忆，例如：本项目所有命令必须通过 pnpm 执行"
          value={memory}
          onChange={(event) => setMemory(event.target.value)}
        />
        <input
          className="input"
          placeholder="证据（可选）：来自哪次对话/哪份文件"
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
        />
        <button className="btn" disabled={!memory.trim()} onClick={() => void addMemory()}>
          <Icon name="plus" size={13} /> 写入记忆
        </button>
      </div>

      <div style={{ padding: 12 }}>
        <Section title="目标" icon="sparkle">
          <div className="row" style={{ marginBottom: 8 }}>
            <input
              className="input"
              placeholder="设定本轮目标，Agent 会持续围绕它推进"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void addGoal()}
            />
            <button className="btn sm" onClick={() => void addGoal()}>
              设定
            </button>
          </div>
          {view?.goals.length ? (
            view.goals.map((item) => (
              <div className="row" key={item.id} style={{ padding: '4px 0' }}>
                <span className={`chip ${item.status === 'done' ? 'ok' : item.status === 'active' ? 'accent' : ''}`}>
                  {item.status === 'active' ? '进行中' : item.status === 'done' ? '已完成' : '已暂停'}
                </span>
                <span className="truncate" style={{ flex: 1 }}>{item.text}</span>
                <button
                  className="icon-btn"
                  title={item.status === 'done' ? '标记为进行中' : '标记为完成'}
                  onClick={() =>
                    void window.pi.harness
                      .updateGoal({ sessionId, goalId: item.id, status: item.status === 'done' ? 'active' : 'done' })
                      .then(() => load())
                  }
                >
                  <Icon name="check" size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="muted" style={{ fontSize: '0.86em' }}>暂无目标</div>
          )}
        </Section>

        <Section title="长期记忆" icon="brain">
          {view?.memories.length ? (
            view.memories.map((item) => (
              <div className="card" key={item.id}>
                <div className="row">
                  <span className="chip">{item.scope === 'project' ? '项目' : '全局'}</span>
                  <span className="chip">{item.source === 'user' ? '用户写入' : 'Agent 精炼'}</span>
                  <div className="spacer" />
                  <span className="muted" style={{ fontSize: '0.8em' }}>{relTime(item.createdAt)}</span>
                  <button
                    className="icon-btn"
                    title="删除该记忆"
                    onClick={() => void window.pi.harness.removeMemory({ projectPath, id: item.id }).then(setView)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                <div className="card-text" style={{ marginTop: 6 }}>{item.text}</div>
                {item.evidence && (
                  <div className="muted" style={{ fontSize: '0.8em', marginTop: 4 }}>证据：{item.evidence}</div>
                )}
              </div>
            ))
          ) : (
            <div className="muted" style={{ fontSize: '0.86em' }}>暂无记忆</div>
          )}
        </Section>

        <Section title="精炼建议" icon="sparkle">
          {view?.refinements.length ? (
            view.refinements.map((item) => (
              <div className="card" key={item.id}>
                <div className="row">
                  <span className={`chip ${item.active ? 'ok' : ''}`}>{item.active ? '生效中' : '已停用'}</span>
                  <div className="spacer" />
                  <span className="muted" style={{ fontSize: '0.8em' }}>{relTime(item.createdAt)}</span>
                </div>
                <div className="card-text" style={{ marginTop: 6 }}>{item.text}</div>
              </div>
            ))
          ) : (
            <div className="muted" style={{ fontSize: '0.86em' }}>
              Agent 在复盘后会在这里沉淀经验（带证据才会生效）
            </div>
          )}
        </Section>

        <Section title="快照" icon="archive">
          {view?.snapshots.length ? (
            view.snapshots.map((item) => (
              <div className="row" key={item.id} style={{ padding: '5px 0' }}>
                <span className="truncate" style={{ flex: 1, fontSize: '0.9em' }}>{item.reason}</span>
                <span className="muted" style={{ fontSize: '0.8em' }}>{relTime(item.createdAt)}</span>
                <button
                  className="btn sm"
                  onClick={() => void window.pi.harness.rollback({ projectPath, snapshotId: item.id }).then(setView)}
                >
                  <Icon name="refresh" size={12} /> 回滚
                </button>
              </div>
            ))
          ) : (
            <div className="muted" style={{ fontSize: '0.86em' }}>还没有快照</div>
          )}
        </Section>
      </div>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: 'sparkle' | 'brain' | 'archive'; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <Icon name={icon} size={14} />
        <strong style={{ fontSize: '0.92em' }}>{title}</strong>
      </div>
      {children}
    </div>
  )
}
