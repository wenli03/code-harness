import { spawn, type ChildProcess } from 'node:child_process'

export interface ExecOptions {
  cwd: string
  timeoutMs?: number
  /** 单流最大采集字符数，超出后截断（防止把构建日志灌满上下文/内存） */
  maxChars?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  onChunk?: (stream: 'stdout' | 'stderr', data: string) => void
}

export interface ExecResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  durationMs: number
}

/**
 * 终止整个进程树：
 *  - Windows：taskkill /T /F（spawn 出来的 shell 会再派生真实进程，只杀 shell 会留孤儿）
 *  - POSIX：detached 后按 -pid 杀进程组
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程已退出
    }
  }
}

export function execCommand(command: string, options: ExecOptions): Promise<ExecResult> {
  const started = Date.now()
  const maxChars = options.maxChars ?? 512 * 1024

  return new Promise<ExecResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, {
        cwd: options.cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...(options.env ?? {}) }
      })
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : '命令启动失败',
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false

    // 按剩余额度切片，而不是「满了就整块丢弃」：否则单个超大 chunk 会直接超过上限
    const append = (current: string, text: string): string => {
      const room = maxChars - current.length
      if (room <= 0) {
        truncated = true
        return current
      }
      if (text.length > room) truncated = true
      return current + text.slice(0, room)
    }

    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      options.onChunk?.(stream, text)
      if (stream === 'stdout') stdout = append(stdout, text)
      else stderr = append(stderr, text)
    }

    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk))

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        signal,
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - started
      })
    }

    const timer = setTimeout(
      () => {
        timedOut = true
        killProcessTree(child)
      },
      options.timeoutMs ?? 120_000
    )

    const onAbort = (): void => killProcessTree(child)
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (error) => {
      stderr += `${stderr ? '\n' : ''}${error.message}`
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}
