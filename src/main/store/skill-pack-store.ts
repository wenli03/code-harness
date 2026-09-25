import { promises as fs } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { app } from 'electron'
import { parseFrontmatter } from './skill-store'
import { ensureDir, pathExists } from './json-file'
import { projectSkillsDir } from './paths'

/**
 * 内置技能包：随应用分发的第三方技能（见仓库 `skill-packs/`）。
 *
 * 为什么要有这一层：技能包往往是「入口 SKILL.md + 若干同伴文档」的多文件结构，
 * 而文件工具被围栏在项目根内——装到用户级技能目录会导致同伴文档读不到。
 * 因此安装目标只有一种：项目级 `<项目>/.code-harness/skills/<包名>/`。
 */

/** 内置包目录：开发态在仓库根，打包后在 resources 下（见 electron-builder.yml 的 extraResources）。 */
export function builtinSkillPacksDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skill-packs')
    : join(app.getAppPath(), 'skill-packs')
}

export interface BuiltinSkillPack {
  /** 目录名，同时是安装后的技能 id */
  id: string
  name: string
  description: string
  /** 包内文件数（含同伴文档） */
  fileCount: number
  dir: string
}

/** 列出内置技能包。包 = 一个含 SKILL.md 的目录。 */
export async function listBuiltinSkillPacks(): Promise<BuiltinSkillPack[]> {
  const root = builtinSkillPacksDir()
  if (!(await pathExists(root))) return []
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const packs: BuiltinSkillPack[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const skillFile = join(dir, 'SKILL.md')
    if (!(await pathExists(skillFile))) continue
    const raw = await fs.readFile(skillFile, 'utf8').catch(() => '')
    const { attrs } = parseFrontmatter(raw)
    packs.push({
      id: entry.name,
      name: attrs.name || entry.name,
      description: attrs.description ?? '',
      fileCount: (await collectFiles(dir)).length,
      dir
    })
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id))
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  return out
}

export interface InstallSkillPackResult {
  id: string
  dir: string
  files: number
  /** 目标目录已存在且未指定 force 时为 true（不覆盖） */
  alreadyInstalled: boolean
}

/**
 * 把内置技能包安装到 `input.projectPath/.code-harness/skills/<包名>/`。
 *
 * 默认**不覆盖**已存在的同名技能目录：用户很可能已经改过装好的技能，
 * 静默覆盖会把改动吃掉。要升级得显式传 force（由调用方在确认后传）。
 */
export async function installBuiltinSkillPack(input: {
  pack: string
  projectPath: string
  force?: boolean
}): Promise<InstallSkillPackResult> {
  const packs = await listBuiltinSkillPacks()
  // 只允许安装清单里的包名：包名直接参与路径拼接，不能让调用方任意指定
  const pack = packs.find((item) => item.id === input.pack || item.name === input.pack)
  if (!pack) {
    const known = packs.map((item) => item.id).join('、') || '（未发现任何内置包）'
    throw new Error(`未知的内置技能包「${input.pack}」。可用：${known}`)
  }

  const targetDir = join(projectSkillsDir(input.projectPath), pack.id)
  if (await pathExists(targetDir)) {
    if (!input.force) return { id: pack.id, dir: targetDir, files: 0, alreadyInstalled: true }
    await fs.rm(targetDir, { recursive: true, force: true })
  }

  const files = await collectFiles(pack.dir)
  let copied = 0
  for (const file of files) {
    const rel = relative(pack.dir, file)
    // 双保险：包内路径不得逃逸出包目录（软链接或异常命名）
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) continue
    const dest = join(targetDir, rel)
    await ensureDir(dirname(dest))
    await fs.copyFile(file, dest)
    copied += 1
  }

  return { id: pack.id, dir: targetDir, files: copied, alreadyInstalled: false }
}

/** 安装后的技能目录（项目内相对路径），给用户看的写法。 */
export function installedSkillRelPath(packId: string): string {
  return ['.code-harness', 'skills', packId].join('/')
}
