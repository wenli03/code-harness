import { asBoolean, asOptionalString } from './args'
import { requireProjectPath } from './paths'
import type { ToolDefinition } from './types'
import { toolError, toolOk } from './types'
import {
  installBuiltinSkillPack,
  installedSkillRelPath,
  listBuiltinSkillPacks
} from '../../store/skill-pack-store'

/**
 * install_skill_pack：把随应用分发的**第三方技能包**装进当前项目。
 *
 * 为什么必须装到项目级：技能包是「入口 SKILL.md + 同伴文档」的多文件结构，入口会要求 Agent
 * 去读同伴文档（渐进披露）；而文件工具被围栏在项目根内，装在用户级技能目录会导致同伴文档读不到。
 * 详见仓库 `skill-packs/README.md`。
 *
 * 不传 pack 时只列清单——让 Agent 能先看清有什么、再决定装什么，而不是靠猜包名试错。
 */
export const installSkillPackTool: ToolDefinition = {
  schema: {
    name: 'install_skill_pack',
    description:
      '把内置的第三方技能包安装到当前项目（复制到 <项目>/.code-harness/skills/<包名>/）。不传 pack 只列出可用清单。包内是"入口 SKILL.md + 同伴文档"，安装后 Agent 才能按技能目录结构读到同伴文档。',
    parameters: {
      type: 'object',
      properties: {
        pack: { type: 'string', description: '要安装的包名（目录名）。省略则只返回可用包清单' },
        force: { type: 'boolean', description: '目标技能目录已存在时是否覆盖（默认 false：不覆盖，避免吃掉用户改过的版本）' }
      },
      required: []
    }
  },

  async run(args, ctx, call) {
    const projectPath = requireProjectPath(ctx.projectPath)
    const packId = asOptionalString(args, 'pack')?.trim()

    if (!packId) {
      const packs = await listBuiltinSkillPacks()
      if (!packs.length) return toolOk('没有可用的内置技能包。')
      return toolOk(
        `可用内置技能包：\n${packs
          .map((pack) => `- ${pack.id}：${pack.description || '(无描述)'}（${pack.fileCount} 个文件）`)
          .join('\n')}\n\n安装：install_skill_pack(pack: "<包名>")`
      )
    }

    const force = asBoolean(args, 'force')
    const packs = await listBuiltinSkillPacks()
    const target = packs.find((pack) => pack.id === packId || pack.name === packId)
    if (!target) {
      const known = packs.map((pack) => pack.id).join('、') || '(无)'
      return toolError(`未知的内置技能包「${packId}」。可用：${known}`)
    }

    const approved = await ctx.requestApproval(
      call,
      `把内置技能包「${target.id}」（${target.fileCount} 个文件）安装到 ${installedSkillRelPath(target.id)}/`
    )
    if (!approved) return toolError('用户拒绝安装该技能包')

    try {
      const result = await installBuiltinSkillPack({ pack: target.id, projectPath, force })
      if (result.alreadyInstalled) {
        return toolOk(
          `技能目录 ${installedSkillRelPath(result.id)}/ 已存在，未覆盖（用户可能改过装好的版本）。` +
            `确认要重装时再调用并传 force: true。`
        )
      }
      return toolOk(
        [
          `已安装技能包「${result.id}」→ ${installedSkillRelPath(result.id)}/（${result.files} 个文件）`,
          '说明：技能索引与正文会在**下一个回合**装配系统提示词时生效；同伴文档在技能目录内，用 read_file 按需读取。'
        ].join('\n')
      )
    } catch (error) {
      return toolError(`安装失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
