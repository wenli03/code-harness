import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ShellChunk, ShellExit } from '@shared/types'
import { actions, terminalBus, useApp } from '../state/store'
import { Icon } from './Icon'

interface Line {
  id: number
  kind: 'cmd' | 'stdout' | 'stderr' | 'meta'
  text: string
}

export function TerminalPanel() {
  const { projectPath } = useApp()
  const [lines, setLines] = useState<Line[]>([])
  const [command, setCommand] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const counter = useRef(0)
  const outRef = useRef<HTMLDivElement>(null)

  const push = (kind: Line['kind'], text: string): void => {
    counter.current += 1
    setLines((current) => [...current, { id: counter.current, kind, text }])
  }

  useEffect(() => {
    const offChunk = terminalBus.subscribe((chunk: ShellChunk) => push(chunk.stream, chunk.data))
    const offExit = terminalBus.onExit((exit: ShellExit) => {
      push('meta', `— 退出码 ${exit.code ?? 'null'} · ${exit.durationMs} ms —\n`)
      // 必须清掉「运行中」标记，否则进程早已退出、终止按钮却一直可用
      setRunId((current) => (current === exit.runId ? null : current))
    })
    return () => {
      offChunk()
      offExit()
    }
  }, [])

  useEffect(() => {
    const container = outRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [lines])

  const run = async (): Promise<void> => {
    if (!projectPath) {
      actions.toast('warn', '先选择一个项目目录')
      return
    }
    const trimmed = command.trim()
    if (!trimmed) return
    push('cmd', `$ ${trimmed}\n`)
    setHistory((current) => [...current, trimmed])
    setHistoryIndex(-1)
    setCommand('')
    try {
      const { runId: id } = await window.pi.shell.run({ projectPath, command: trimmed })
      setRunId(id)
    } catch (error) {
      push('stderr', `${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void run()
      return
    }
    if (event.key === 'ArrowUp' && history.length) {
      event.preventDefault()
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      setCommand(history[next])
    }
    if (event.key === 'ArrowDown' && history.length && historyIndex >= 0) {
      event.preventDefault()
      const next = historyIndex + 1
      if (next >= history.length) {
        setHistoryIndex(-1)
        setCommand('')
      } else {
        setHistoryIndex(next)
        setCommand(history[next])
      }
    }
  }

  return (
    <div className="terminal">
      <div className="panel-toolbar">
        <Icon name="terminal" size={13} />
        <span className="muted" style={{ fontSize: '0.84em' }}>{projectPath ?? '未选择项目'}</span>
        <div className="spacer" />
        {runId && <span className="chip accent">运行中</span>}
        <button
          className="btn ghost sm"
          disabled={!runId}
          onClick={() => {
            if (runId) void window.pi.shell.kill(runId)
            setRunId(null)
          }}
        >
          <Icon name="stop" size={12} /> 终止
        </button>
        <button className="btn ghost sm" onClick={() => setLines([])}>
          清空
        </button>
      </div>

      <div className="terminal-out" ref={outRef}>
        {lines.length === 0 && (
          <span className="muted">
            手动执行命令的工作台（Agent 自己跑的命令显示在对话里的工具卡片中）。{'\n'}
            支持 ↑ / ↓ 翻阅历史。
          </span>
        )}
        {lines.map((line) => (
          <span key={line.id} className={line.kind === 'cmd' ? 'terminal-cmd' : line.kind === 'stderr' ? 'terminal-err' : undefined}>
            {line.text}
          </span>
        ))}
      </div>

      <div className="terminal-input">
        <span className="terminal-cmd">$</span>
        <input
          value={command}
          placeholder="输入命令后回车执行"
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <button className="btn ghost sm" onClick={() => void run()}>
          <Icon name="play" size={12} /> 运行
        </button>
      </div>
    </div>
  )
}
