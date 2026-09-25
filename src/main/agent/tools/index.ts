import type { PermissionMode, ToolCall, ToolSchema } from '@shared/types'
import { agentTools } from './agent-tools'
import { fsTools } from './fs-tools'
import { gitTools } from './git-tools'
import { layaTools } from './laya-tools'
import { shellTools } from './shell-tool'
import type { ToolContext, ToolDefinition, ToolRunResult } from './types'

/** 单个工具输出上限：防止一次 `cat` 巨文件把上下文直接打爆。 */
export const MAX_TOOL_OUTPUT_CHARS = 60_000

export const ALL_TOOLS: ToolDefinition[] = [
  ...fsTools,
  ...shellTools,
  ...gitTools,
  ...agentTools,
  ...layaTools
]

const REGISTRY = new Map<string, ToolDefinition>(ALL_TOOLS.map((tool) => [tool.schema.name, tool]))

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return REGISTRY.get(name)
}

export function getToolNames(): string[] {
  return ALL_TOOLS.map((tool) => tool.schema.name)
}

/** reviewer 角色实际可用的工具名：只读，且不会派生新的审查子会话（避免自我递归）。 */
export function getReviewerToolNames(): string[] {
  return ALL_TOOLS.filter((tool) => isToolAllowedForRole(tool.schema.name, 'reviewer')).map(
    (tool) => tool.schema.name
  )
}

export function isReadOnlyTool(name: string): boolean {
  return REGISTRY.get(name)?.schema.readOnly === true
}

/**
 * 角色工具闸门：**执行层**与"暴露给模型的清单"共用同一判据，
 * 避免出现"清单里没有、但模型报个工具名照样能跑"的缝。
 * 判据说明见 `toolSchemas`。未注册的工具名一律不允许。
 */
export function isToolAllowedForRole(name: string, role?: 'reviewer'): boolean {
  const tool = REGISTRY.get(name)
  if (!tool) return false
  if (role !== 'reviewer') return true
  return tool.schema.readOnly === true && tool.schema.reviewerExcluded !== true
}

/**
 * 按权限模式裁剪暴露给模型的工具集：readonly 下只给只读工具。
 *
 * `role === 'reviewer'` 时**无条件**按只读裁剪：审查专员承诺"不修代码、不跑有副作用的命令"，
 * 这个承诺不能只写在提示词里——否则默认的 `ask` 模式下它照样拿到写文件与执行命令的工具。
 * 同时排除会派生新审查会话的工具（`reviewerExcluded`），否则它会再派一个审查专员。
 */
export function toolSchemas(mode: PermissionMode, role?: 'reviewer'): ToolSchema[] {
  const effective: PermissionMode = role === 'reviewer' ? 'readonly' : mode
  return ALL_TOOLS.filter(
    (tool) =>
      isToolAllowedForRole(tool.schema.name, role) &&
      (effective === 'readonly' ? tool.schema.readOnly === true : true)
  ).map((tool) => tool.schema)
}

export function truncateOutput(output: string, limit = MAX_TOOL_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (output.length <= limit) return { text: output, truncated: false }
  return {
    text: `${output.slice(0, limit)}\n\n…（输出过长，已截断，共 ${output.length} 字符）`,
    truncated: true
  }
}

export async function executeTool(
  call: ToolCall,
  ctx: ToolContext
): Promise<ToolRunResult & { truncated: boolean }> {
  const definition = REGISTRY.get(call.name)
  if (!definition) {
    return { ok: false, output: `未知工具：${call.name}`, truncated: false }
  }
  if (call.raw !== undefined) {
    return {
      ok: false,
      output: `工具参数不是合法 JSON，无法执行。请重新调用并确保 ${call.name} 的参数是合法 JSON。原始参数：${call.raw.slice(0, 400)}`,
      truncated: false
    }
  }

  try {
    const result = await definition.run(call.args ?? {}, ctx, call)
    const { text, truncated } = truncateOutput(result.output)
    return { ok: result.ok, output: text, truncated }
  } catch (error) {
    return {
      ok: false,
      output: `工具执行异常：${error instanceof Error ? error.message : String(error)}`,
      truncated: false
    }
  }
}

export type { ToolContext, ToolDefinition, ToolRunResult }
