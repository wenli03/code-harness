import { asOptionalString, asString } from './args'
import { collectBudgetedDiffs } from './diff-budget'
import type { ToolDefinition } from './types'
import { toolError, toolOk } from './types'
import { gitDiff, gitStatus } from '../../util/git'

/**
 * review_changes：把当前改动交给**只读审查专员子会话**（role='reviewer'，
 * 独立上下文 + 固定生产就绪清单，见 harness.ts REVIEWER_PROMPT）。
 * 针对的典型失败模式：主会话自己写代码自己夸——它已经"相信"方案是对的，
 * 同样的上下文里再审一遍大概率还是自洽通过；换一个新会话按清单硬查，
 * 才能把占位实现、吞错误、对需求的隐性假设揪出来。
 */
export const reviewChangesTool: ToolDefinition = {
  schema: {
    name: 'review_changes',
    description:
      '对当前未提交的代码改动做一次生产就绪审查：派生只读审查专员子会话，按固定清单核查需求贴合度（含"对需求做了哪些未声明假设"）、假实现/占位、生产风险、硬编码配置、可验证性，返回结构化报告（PASS/PASS_WITH_RISKS/BLOCK + 问题清单）。一段实质改动完成、准备交付时调用；不修改任何文件。',
    parameters: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: '强烈建议：本次改动对应的原始需求（用户原话或忠实转述）。审查员会据此找出代码里对需求的假设与漏实现。'
        },
        scope: { type: 'string', enum: ['working', 'staged'], description: '审查工作区改动（默认）还是已暂存改动' },
        focus: { type: 'string', description: '可选：额外关注点，如"重点看并发与失败重试"' }
      },
      required: []
    },
    readOnly: true,
    // 会派生审查子会话：reviewer 自己不得持有（否则审查专员再派审查专员）
    reviewerExcluded: true
  },
  async run(args, ctx) {
    const projectPath = ctx.projectPath
    if (!projectPath) return toolError('未关联项目，无法审查改动。')

    const staged = asOptionalString(args, 'scope') === 'staged'
    const requirement = asString(args, 'requirement') || '(用户未提供原始需求——此时纯技术审查，并在报告中要求补充需求说明)'
    const focus = asOptionalString(args, 'focus')

    let status
    try {
      status = await gitStatus(projectPath)
    } catch (error) {
      return toolError(`读取 git 状态失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!status.isRepo) return toolError('当前项目不是 git 仓库，无法按 diff 审查；请先初始化 git 或改用人工审查。')
    // staged 视图看暂存区标记；working 视图看工作树改动（y≠空格）或未跟踪新文件
    const changed = status.files.filter((file) =>
      staged ? file.staged : file.y !== ' ' || file.untracked
    )
    if (!changed.length) return toolError(staged ? '暂存区没有改动可审。' : '工作区没有未提交改动可审。')

    // 收集 diff（带预算）：改动文件多时按序截断，并如实告诉审查员"后面还有 N 个文件没展开"
    const { sections: parts, omitted } = await collectBudgetedDiffs(
      changed.map((file) => ({
        heading: `#### ${file.path}${file.untracked ? '（新增文件，全文）' : ''}`,
        load: () => gitDiff(projectPath, file.path, file.staged),
        onError: `(git diff 失败：${file.path})`
      }))
    )
    const names = changed.slice(0, 60).map((file) => file.path)

    const prompt = [
      `## 审查任务`,
      `### 原始需求\n${requirement}`,
      `### 额外关注点\n${focus ?? '无'}`,
      `### 改动概览\n分支 ${status.branch || '(未知)'}｜${staged ? '已暂存' : '工作区'}改动 ${changed.length} 个文件：\n${names.join('\n')}${changed.length > names.length ? '\n…' : ''}`,
      `### 完整 diff\n${parts.join('\n\n')}${omitted > 0 ? `\n\n（因预算限制另有 ${omitted} 个文件的 diff 未展开，请用 git_diff 只读查看后一并审查）` : ''}`,
      `请严格按你的输出格式给出报告。需要更多上下文（调用方、被改文件的完整内容）时用只读工具查证，查不到的写"diff 外，需人工确认"。`
    ].join('\n\n')

    try {
      const report = await ctx.spawnSubAgent({ prompt, title: `代码审查：${staged ? 'staged' : '工作区'} ${changed.length} 个文件`, role: 'reviewer' })
      return toolOk(`【审查专员报告】\n${report || '(审查员未返回内容)'}`)
    } catch (error) {
      return toolError(`审查子会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
