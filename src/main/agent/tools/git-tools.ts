import { gitCommit, gitDiff, gitStatus } from '../../util/git'
import { asBoolean, asOptionalString, asString } from './args'
import { requireProjectPath } from './paths'
import type { ToolDefinition } from './types'
import { toolError, toolOk } from './types'

export const gitStatusTool: ToolDefinition = {
  schema: {
    name: 'git_status',
    description: '查看当前分支与工作区改动（等价于 git status --porcelain）。',
    readOnly: true,
    parameters: { type: 'object', properties: {} }
  },
  async run(_args, ctx) {
    const project = requireProjectPath(ctx.projectPath)
    const status = await gitStatus(project)
    if (!status.isRepo) return toolError(`不是 Git 仓库：${status.error ?? ''}`)
    if (status.clean) return toolOk(`分支 ${status.branch}：工作区干净`)
    const lines = status.files.map((f) => `${f.x}${f.y} ${f.path}`)
    return toolOk(`分支 ${status.branch}（领先 ${status.ahead} / 落后 ${status.behind}）\n${lines.join('\n')}`)
  }
}

export const gitDiffTool: ToolDefinition = {
  schema: {
    name: 'git_diff',
    description: '查看某个文件的 diff（默认看工作区未暂存的改动）。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的文件路径' },
        staged: { type: 'boolean', description: '是否查看已暂存（index）的改动' }
      },
      required: ['path']
    }
  },
  async run(args, ctx) {
    const project = requireProjectPath(ctx.projectPath)
    const file = asString(args, 'path')
    const staged = asBoolean(args, 'staged', false)
    const diff = await gitDiff(project, file, staged)
    return toolOk(diff.slice(0, 60_000))
  }
}

export const gitCommitTool: ToolDefinition = {
  schema: {
    name: 'git_commit',
    description: '提交当前已暂存的改动。不会自动 git add，请先用 run_command 暂存需要提交的文件。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '提交信息' },
        push: { type: 'boolean', description: '保留字段（不会自动 push），默认 false' }
      },
      required: ['message']
    }
  },
  async run(args, ctx, call) {
    const project = requireProjectPath(ctx.projectPath)
    const message = asOptionalString(args, 'message') ?? asString(args, 'message', false)
    if (!message.trim()) return toolError('提交信息不能为空')

    const approved = await ctx.requestApproval(call, `提交改动：${message.slice(0, 80)}`)
    if (!approved) return toolError('用户拒绝提交')

    const result = await gitCommit(project, message)
    return result.ok ? toolOk(result.output || '提交成功') : toolError(result.output || '提交失败')
  }
}

export const gitTools: ToolDefinition[] = [gitStatusTool, gitDiffTool, gitCommitTool]
