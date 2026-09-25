import { useCallback, useEffect, useState } from 'react'
import type { ScheduledTask } from '@shared/types'
import { actions, schedulerBus, useApp } from '../state/store'
import { relTime } from '../lib/format'
import { Icon } from './Icon'

const PRESETS: Array<{ label: string; rrule: string }> = [
  { label: '每小时', rrule: 'FREQ=HOURLY;INTERVAL=1' },
  { label: '每天 09:00', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
  { label: '每周一 09:00', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' }
]

export function TasksPanel() {
  const { projectPath, sessionId } = useApp()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [rrule, setRrule] = useState(PRESETS[1].rrule)
  const [attach, setAttach] = useState(true)

  const load = useCallback(async () => {
    setTasks(await window.pi.scheduler.list(projectPath))
  }, [projectPath])

  useEffect(() => {
    void load()
    return schedulerBus.subscribe(() => void load())
  }, [load])

  const create = async (): Promise<void> => {
    if (!name.trim() || !prompt.trim()) {
      actions.toast('warn', '请填写任务名称与指令')
      return
    }
    await window.pi.scheduler.create({
      name: name.trim(),
      prompt: prompt.trim(),
      projectPath,
      sessionId: attach ? sessionId : null,
      rrule
    })
    setName('')
    setPrompt('')
    await load()
    actions.toast('ok', '已创建定时任务')
  }

  return (
    <div className="col" style={{ minHeight: '100%' }}>
      <div className="panel-form">
        <div className="row">
          <input className="input" placeholder="任务名称" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <textarea
          rows={3}
          placeholder="到点后要执行的指令，例如：跑一遍 npm test 并总结失败原因"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {PRESETS.map((preset) => (
            <button
              key={preset.rrule}
              className={`chip ${rrule === preset.rrule ? 'accent' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => setRrule(preset.rrule)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <input className="input mono" value={rrule} onChange={(event) => setRrule(event.target.value)} />
        <label className="switch">
          <input type="checkbox" checked={attach} disabled={!sessionId} onChange={(event) => setAttach(event.target.checked)} />
          复用当前会话（不勾选则每次新建会话）
        </label>
        <button className="btn primary" onClick={() => void create()}>
          <Icon name="plus" size={14} /> 创建任务
        </button>
      </div>

      <div style={{ padding: 12 }}>
        {tasks.length === 0 && (
          <div className="empty">
            <Icon name="clock" size={22} />
            <div style={{ fontSize: '0.9em' }}>还没有定时任务</div>
            <div style={{ fontSize: '0.84em' }}>可用来做每日回归测试、依赖巡检、周报汇总</div>
          </div>
        )}
        {tasks.map((task) => (
          <div className="card" key={task.id}>
            <div className="card-head">
              <Icon name="clock" size={14} />
              <span className="card-title truncate">{task.name}</span>
              <span className={`chip ${task.enabled ? 'ok' : ''}`}>{task.enabled ? '启用' : '暂停'}</span>
            </div>
            <div className="card-text">{task.prompt}</div>
            <div className="card-meta">
              <span className="chip mono">{task.rrule}</span>
              <span className="chip">
                下次：{task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : '—'}
              </span>
              <span className="chip">
                上次：{task.lastRunAt ? relTime(task.lastRunAt) : '未运行'}
              </span>
              {task.lastResult && <span className="chip warn truncate">{task.lastResult}</span>}
            </div>
            <div className="row" style={{ marginTop: 9, gap: 6 }}>
              <button className="btn sm" onClick={() => void window.pi.scheduler.runNow(task.id).then(() => load())}>
                <Icon name="play" size={12} /> 立即执行
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  void window.pi.scheduler.update({ id: task.id, patch: { enabled: !task.enabled } }).then(() => load())
                }
              >
                {task.enabled ? '暂停' : '启用'}
              </button>
              <div className="spacer" />
              <button
                className="btn sm danger"
                onClick={() => void window.pi.scheduler.remove(task.id).then(() => load())}
              >
                <Icon name="trash" size={12} /> 删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
