import { execCommand } from '../../util/exec'
import { asNumber, asOptionalString, asString } from './args'
import { requireProjectPath, resolveInsideProject } from './paths'
import type { ToolDefinition } from './types'
import { toolError, toolOk } from './types'

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 15 * 60_000

export const runCommandTool: ToolDefinition = {
  schema: {
    name: 'run_command',
    description:
      '在项目目录执行 shell 命令并返回 stdout/stderr。Windows 下由 cmd.exe 执行。可用 cwd 指定子目录。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '相对项目根的工作目录，默认项目根' },
        timeout_ms: { type: 'integer', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT}` }
      },
      required: ['command']
    }
  },
  async run(args, ctx, call) {
    const project = requireProjectPath(ctx.projectPath)
    const command = asString(args, 'command')
    const cwdRel = asOptionalString(args, 'cwd')
    const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1_000, asNumber(args, 'timeout_ms', DEFAULT_TIMEOUT)))
    const cwd = cwdRel ? resolveInsideProject(project, cwdRel) : project

    const approved = await ctx.requestApproval(call, `执行命令：${command}`)
    if (!approved) return toolError('用户拒绝执行该命令')

    const result = await execCommand(command, { cwd, timeoutMs, signal: ctx.signal })
    const parts: string[] = []
    if (result.timedOut) parts.push(`[超时] 已在 ${timeoutMs}ms 后终止进程`)
    if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`)
    if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`)
    if (result.truncated) parts.push('[输出已截断]')
    parts.push(`退出码: ${result.code ?? 'null'}${result.signal ? ` (signal ${result.signal})` : ''}`)

    const ok = result.code === 0 && !result.timedOut
    return { ok, output: parts.join('\n\n') }
  }
}

export const shellTools: ToolDefinition[] = [runCommandTool]
