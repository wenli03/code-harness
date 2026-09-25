import { join, resolve } from 'node:path'
import type { TrustDecision, TrustState } from '@shared/types'
import { readJson, writeJson } from './json-file'
import { pathExists } from './json-file'
import { projectDir, projectSkillsDir, userDataDir } from './paths'

/**
 * 项目信任（对齐上游 pi 的 Project Trust）：**项目级资源在"用户明确信任过"之前不参与提示词装配**。
 *
 * 为什么需要它：项目级技能与项目级 Harness 记忆都来自仓库里的文件，
 * 而仓库是**别人可以改的东西**。一旦 clone 一个恶意仓库就自动把里面的 `SKILL.md`
 * 与"记忆"注入系统提示词，等于把提示词注入的入口交给仓库作者。
 * 审批闸门管不住这件事——它拦的是工具调用，不是提示词装配。
 *
 * 与本项目其它安全设计的取舍一致：**默认不信任**（未决定 = 不注入），
 * 交互场景再问用户；非交互场景（定时任务、子智能体、被工具链触发的回合）
 * 没有人可问，就保持不注入。
 */

interface TrustFile {
  decisions: Record<string, TrustDecision>
}

let cache: TrustFile | null = null

export function trustFile(): string {
  return join(userDataDir(), 'trust.json')
}

/** 归一化路径做键：Windows 下大小写与分隔符都会变，不归一化会出现"信任过但还是被问"。 */
function normalizeKey(projectPath: string): string {
  const normalized = resolve(projectPath).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function load(): Promise<TrustFile> {
  if (cache) return cache
  const data = await readJson<TrustFile>(trustFile(), { decisions: {} })
  cache = { decisions: data.decisions && typeof data.decisions === 'object' ? data.decisions : {} }
  return cache
}

/**
 * 查决定：**子目录继承父目录的决定**（上游 /trust 也连带保存直接父目录）。
 * 否则一个 monorepo 里每个子项目都要单独确认一次。
 */
export async function getTrustDecision(projectPath: string | null): Promise<TrustDecision | null> {
  if (!projectPath) return null
  const file = await load()
  let key = normalizeKey(projectPath)
  for (let i = 0; i < 32; i += 1) {
    const hit = file.decisions[key]
    if (hit === 'always' || hit === 'never') return hit
    const index = key.lastIndexOf('/')
    if (index <= 0) break
    key = key.slice(0, index)
  }
  return null
}

/** 项目级资源是否可以参与提示词装配。未决定 = false（保守默认）。 */
export async function isProjectTrusted(projectPath: string | null): Promise<boolean> {
  return (await getTrustDecision(projectPath)) === 'always'
}

export async function setTrustDecision(
  projectPath: string,
  decision: TrustDecision | null
): Promise<TrustState> {
  const file = await load()
  const key = normalizeKey(projectPath)
  if (decision === null) delete file.decisions[key]
  else file.decisions[key] = decision
  await writeJson(trustFile(), file)
  return { decisions: { ...file.decisions }, file: trustFile() }
}

export async function viewTrust(): Promise<TrustState> {
  const file = await load()
  return { decisions: { ...file.decisions }, file: trustFile() }
}

/**
 * 这个项目**是否含项目级资源**——用于"没事别打扰用户"：
 * 一个干净的仓库（没有 `.code-harness/`、`.pi/`、`.agents/`）根本不需要弹信任提示。
 */
export async function projectHasTrustableResources(projectPath: string | null): Promise<boolean> {
  if (!projectPath) return false
  const candidates = [
    projectSkillsDir(projectPath),
    join(projectDir(projectPath), 'harness.json'),
    join(projectPath, '.pi', 'skills'),
    join(projectPath, '.agents', 'skills')
  ]
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return true
  }
  return false
}
