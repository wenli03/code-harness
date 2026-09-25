import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type { ShellChunk, ShellExit, ShellRunRequest } from '@shared/types'
import { killProcessTree } from './exec'

interface RunningShell {
  child: ChildProcess
  startedAt: number
}

const running = new Map<string, RunningShell>()

export interface ShellRunnerCallbacks {
  onChunk: (chunk: ShellChunk) => void
  onExit: (exit: ShellExit) => void
}

/**
 * 交互式命令运行器（不依赖 node-pty，避免原生模块编译）：
 * 用于 UI 的终端面板——用户手敲命令、流式回显，与 Agent 的工具执行互不干扰。
 */
export function startShellRun(request: ShellRunRequest, callbacks: ShellRunnerCallbacks): string {
  const runId = randomUUID()
  const startedAt = Date.now()

  let child: ChildProcess
  try {
    child = spawn(request.command, {
      cwd: request.cwd || request.projectPath,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: process.env
    })
  } catch (error) {
    callbacks.onChunk({ runId, stream: 'stderr', data: `${error instanceof Error ? error.message : error}\n` })
    callbacks.onExit({ runId, code: null, signal: null, durationMs: 0 })
    return runId
  }

  running.set(runId, { child, startedAt })

  child.stdout?.on('data', (chunk: Buffer) =>
    callbacks.onChunk({ runId, stream: 'stdout', data: chunk.toString('utf8') })
  )
  child.stderr?.on('data', (chunk: Buffer) =>
    callbacks.onChunk({ runId, stream: 'stderr', data: chunk.toString('utf8') })
  )

  const finish = (code: number | null, signal: string | null): void => {
    running.delete(runId)
    callbacks.onExit({ runId, code, signal, durationMs: Date.now() - startedAt })
  }

  child.on('error', (error) => {
    callbacks.onChunk({ runId, stream: 'stderr', data: `${error.message}\n` })
    finish(null, null)
  })
  child.on('close', (code, signal) => finish(code, signal))

  return runId
}

export function killShellRun(runId: string): void {
  const entry = running.get(runId)
  if (!entry) return
  killProcessTree(entry.child)
}
