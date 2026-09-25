import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { killProcessTree } from '../../util/exec'

/**
 * 本地决策引擎（laya）的接入层：以 MCP over stdio 的方式常驻一个子进程。
 *
 * 为什么**常驻**而不是每次 fork 一个 CLI：
 *  一次性进程每次都要重新加载 checkpoint（实测 CPU 上 multilingual 首次前向 34 s，
 *  大部分时间花在装载权重上），而「这条命令危不危险」「这活算不算做完」这类裁决
 *  本该是随手就调的动作——30 s 的代价会让模型干脆不调，能力等于没有。
 *  常驻进程把权重留在内存里（服务端 LAYA_MAX_LOADED 默认 2 个 checkpoint），
 *  之后每次裁决只需一次前向。
 *
 * 为什么**复用 laya 自己的 MCP server** 而不是在 pi 里重写决策逻辑：
 *  本地引擎只有一份实现（`mcp/laya_mcp.py`：提示词、问题定义、阈值都在里面）。
 *  在这里重写一份必然与服务端漂移，那样「本地裁决」就不再可信——而它唯一的
 *  价值就是可信。
 *
 * 生命周期：子进程随 pi 主进程存活。pi 退出时子进程 stdin 收到 EOF 会自行退出，
 * 因此不需要额外的退出钩子；这里只在启动失败 / 进程死亡时给出可读错误并允许重启。
 */

export type LayaToolName = 'laya_route' | 'laya_guard' | 'laya_gate' | 'laya_review' | 'laya_decide'

/** 冷启动首次 tools/call 要装载 checkpoint，给足时间；之后是毫秒级。 */
const CALL_TIMEOUT_MS = 300_000
const HANDSHAKE_TIMEOUT_MS = 60_000
/** 子进程 stderr 只保留尾部，用于把「为什么起不来」带回给用户。 */
const STDERR_TAIL_CHARS = 4_000
/** stdout 单行缓冲上限，防止异常输出把内存吃满。 */
const STDOUT_BUFFER_CHARS = 8 * 1024 * 1024

interface LayaLocation {
  repo: string
  python: string
  server: string
}

interface Pending {
  resolve: (message: LayaResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface LayaResponse {
  result?: {
    isError?: boolean
    content?: Array<{ type?: string; text?: string }>
  }
  error?: { code?: number; message?: string }
}

let configuredRepo = ''

/** 由设置写入。空串表示未显式配置，此时按 candidates() 的顺序自动探测。 */
export function configureLaya(repoPath: string): void {
  configuredRepo = repoPath.trim()
}

/** 候选仓库路径：显式配置 > 项目目录本身 > 项目内的 laya/ > 项目同级的 laya/。 */
function candidates(projectPath: string | null): string[] {
  const list: string[] = []
  if (configuredRepo) list.push(configuredRepo)
  if (projectPath) {
    list.push(projectPath, join(projectPath, 'laya'), join(dirname(projectPath), 'laya'))
  }
  return [...new Set(list)]
}

/** 优先用仓库自带的 venv：laya 依赖 torch，系统解释器不一定装了。 */
function resolvePython(repo: string): string {
  const venv =
    process.platform === 'win32'
      ? join(repo, '.venv', 'Scripts', 'python.exe')
      : join(repo, '.venv', 'bin', 'python')
  if (existsSync(venv)) return venv
  return process.platform === 'win32' ? 'python' : 'python3'
}

function resolve(projectPath: string | null): LayaLocation | null {
  for (const repo of candidates(projectPath)) {
    const server = join(repo, 'mcp', 'laya_mcp.py')
    if (existsSync(server)) return { repo, python: resolvePython(repo), server }
  }
  return null
}

function notFoundMessage(projectPath: string | null): string {
  const searched = candidates(projectPath)
  return [
    '没有找到本地 laya 决策引擎（缺少 mcp/laya_mcp.py），这次裁决没有发生——不要凭猜测代替它。',
    searched.length ? `已查找：${searched.join('、')}` : '未配置任何候选路径。',
    '修复方式（任一）：① 在「设置 → 编码」填写 laya 仓库路径；',
    '② 把 laya 仓库放进当前项目目录下或其同级目录。'
  ].join('\n')
}

class LayaClient {
  private child: ChildProcess | null = null
  private location: LayaLocation | null = null
  private ready: Promise<void> | null = null
  private buffer = ''
  private stderrTail = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  /** 串行化：单个子进程只有一个模型实例，并发调用只会互相抢 CPU，还让超时无法归因。 */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * 调用一个 laya 工具，返回它的 JSON 结果文本（原样，不解析——引擎的字段还会演进，
   * 这里解析成结构体只会多一层漂移点，模型直接读 JSON 更可靠）。
   */
  async consult(
    tool: LayaToolName,
    args: Record<string, unknown>,
    projectPath: string | null
  ): Promise<string> {
    const run = this.queue.then(() => this.dispatch(tool, args, projectPath))
    // 队列本身必须吞掉失败，否则一次调用出错会让后续所有调用直接短路
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async dispatch(
    tool: LayaToolName,
    args: Record<string, unknown>,
    projectPath: string | null
  ): Promise<string> {
    const location = resolve(projectPath)
    if (!location) throw new Error(notFoundMessage(projectPath))

    await this.ensure(location)
    const response = await this.request('tools/call', { name: tool, arguments: args }, CALL_TIMEOUT_MS)

    const content = response.result?.content
    const text = Array.isArray(content)
      ? content
          .map((part) => String(part?.text ?? ''))
          .join('\n')
          .trim()
      : ''
    if (response.error || response.result?.isError) {
      throw new Error(text || response.error?.message || `${tool} 执行失败`)
    }
    return text || `${tool} 没有返回内容`
  }

  private ensure(location: LayaLocation): Promise<void> {
    const alive =
      this.child !== null &&
      !this.child.killed &&
      this.location?.server === location.server &&
      this.location?.python === location.python
    if (alive && this.ready) return this.ready

    this.stop()
    this.location = location
    this.ready = this.start(location)
    return this.ready
  }

  private start(location: LayaLocation): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(location.python, [location.server], {
          cwd: location.repo,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            // 显式指向仓库内的 models/：与 IDE 侧用的是同一份权重，
            // 不这样会把 LAYA_HOME 落到默认缓存路径，变成「同一台机器两套权重」。
            LAYA_HOME: join(location.repo, 'models'),
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8'
          }
        })
      } catch (error) {
        reject(new Error(`无法启动 laya 服务（${location.python}）：${describeError(error)}`))
        return
      }

      this.child = child
      this.buffer = ''
      this.stderrTail = ''

      child.stdout?.on('data', (chunk: Buffer) => this.onData(String(chunk)))
      child.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS)
      })
      child.on('error', (error) => {
        this.failAll(`laya 服务进程异常：${error.message}`)
        reject(new Error(`无法启动 laya 服务（${location.python}）：${error.message}`))
      })
      child.on('exit', (code) => {
        const tail = this.stderrTail.trim()
        this.child = null
        this.ready = null
        this.failAll(
          `laya 服务进程已退出（code=${code}）${tail ? `\n${tail}` : ''}\n下次调用会自动重启。`
        )
      })

      this.request(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'code-harness', version: '1.0.0' }
        },
        HANDSHAKE_TIMEOUT_MS
      )
        .then(() => {
          this.notify('notifications/initialized')
          resolve()
        })
        .catch((error: Error) => {
          this.stop()
          reject(error)
        })
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onMessage(line)
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > STDOUT_BUFFER_CHARS) this.buffer = ''
  }

  private onMessage(line: string): void {
    let message: LayaResponse & { id?: number | null }
    try {
      message = JSON.parse(line)
    } catch {
      // 服务端若把日志写到了 stdout，这里静默跳过即可（协议消息一定是合法 JSON 单行）
      return
    }
    if (message.id === undefined || message.id === null) return
    const pending = this.pending.get(Number(message.id))
    if (!pending) return
    this.pending.delete(Number(message.id))
    clearTimeout(pending.timer)
    pending.resolve(message)
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<LayaResponse> {
    const stdin = this.child?.stdin
    if (!stdin) return Promise.reject(new Error('laya 服务未启动'))

    const id = this.nextId++
    return new Promise<LayaResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`laya ${method} 超时（${Math.round(timeoutMs / 1000)} s）${this.hint()}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (!error) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`向 laya 服务写入请求失败：${error.message}`))
      })
    })
  }

  private notify(method: string): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }

  private hint(): string {
    const tail = this.stderrTail.trim()
    return tail ? `\n服务端 stderr：\n${tail}` : ''
  }

  private failAll(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private stop(): void {
    this.failAll('laya 服务已停止')
    const child = this.child
    this.child = null
    this.ready = null
    this.buffer = ''
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      // 管道已关闭
    }
    killProcessTree(child)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const client = new LayaClient()

export function consultLaya(
  tool: LayaToolName,
  args: Record<string, unknown>,
  projectPath: string | null
): Promise<string> {
  return client.consult(tool, args, projectPath)
}
