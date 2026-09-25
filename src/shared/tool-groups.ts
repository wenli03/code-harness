/**
 * 审批分组：把「同一类操作」的工具归到一组，让用户能一次授权一整类。
 *
 * 为什么需要它：审批卡上的「总是允许」原本只写入**单个工具名**，于是用户点了
 * 「总是允许 edit_file」之后，`write_file` 还会再问一次 —— 用户既无法预期，也发现不了
 * 两者是同一件事。分组把「编辑文件」变成一个可直接点选的类别。
 *
 * 主进程（runtime 写入白名单）与渲染层（设置界面勾选态、审批卡按钮文案）共用这份定义，
 * 避免两边各维护一份工具名清单而漂移。
 */

export interface ToolApprovalGroup {
  id: string
  label: string
  /** 展示给用户的风险说明 —— 授权前应当能看懂自己放开了什么。 */
  hint: string
  tools: string[]
}

/**
 * 只收录「有副作用、需要审批」的工具。
 * 只读工具（read_file / list_dir / glob / grep / git_status / git_diff）不在此列：
 * 它们在 readonly 模式下也放行，本来就不会弹审批。
 */
export const TOOL_APPROVAL_GROUPS: ToolApprovalGroup[] = [
  {
    id: 'edit',
    label: '编辑文件',
    hint: '写入或修改项目内的文件内容（含把内置技能包安装到 <项目>/.code-harness/skills/），不碰项目之外的东西',
    tools: ['write_file', 'edit_file', 'install_skill_pack']
  },
  {
    id: 'shell',
    label: '执行命令',
    hint: '在项目目录里跑 shell 命令 —— 权限等同于你自己在终端里操作，请谨慎开启',
    tools: ['run_command']
  },
  {
    id: 'git',
    label: 'Git 提交',
    hint: '把已暂存的改动提交到当前分支',
    tools: ['git_commit']
  }
]

/** 该工具所属的审批分组；未分组返回 null。 */
export function approvalGroupForTool(toolName: string): ToolApprovalGroup | null {
  return TOOL_APPROVAL_GROUPS.find((group) => group.tools.includes(toolName)) ?? null
}

/**
 * 「总是允许」应当写入 `autoApproveTools` 的工具名集合：
 * 属于分组就整组写入（一次授权覆盖同类操作），否则只写它自己。
 */
export function expandApprovalTools(toolName: string): string[] {
  return approvalGroupForTool(toolName)?.tools.slice() ?? [toolName]
}

/** 分组在白名单里的覆盖情况，供设置界面渲染勾选态（部分命中要能看出来）。 */
export function groupApprovalState(
  group: ToolApprovalGroup,
  autoApproveTools: string[]
): 'all' | 'none' | 'partial' {
  const hit = group.tools.filter((tool) => autoApproveTools.includes(tool)).length
  if (hit === 0) return 'none'
  return hit === group.tools.length ? 'all' : 'partial'
}

/** 勾选/取消一个分组，返回新的 `autoApproveTools`（保持其他工具不变）。 */
export function toggleApprovalGroup(
  group: ToolApprovalGroup,
  autoApproveTools: string[],
  enabled: boolean
): string[] {
  const others = autoApproveTools.filter((tool) => !group.tools.includes(tool))
  return enabled ? [...others, ...group.tools] : others
}
