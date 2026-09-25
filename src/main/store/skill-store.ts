import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SkillRecord } from '@shared/types'
import { ensureDir, pathExists } from './json-file'
import { projectSkillsDir, userSkillsDir } from './paths'

/**
 * 技能：目录形态 `<skills>/<slug>/SKILL.md`，含 YAML frontmatter。
 *
 * 扫描范围对齐上游 pi / Agent Skills 约定（**多目录 + 父目录遍历**）：
 *  - 本应用私有：用户级 `<应用数据>/skills`、项目级 `<项目>/.code-harness/skills`（可增删改）
 *  - 跨工具约定：`<用户主目录>/.agents/skills`、`<项目>/.agents/skills`、`<项目>/.pi/skills`，
 *    以及**项目父目录链上的 `.agents/skills` / `.pi/skills`**（monorepo 里子项目继承仓库级技能）
 *
 * 为什么约定目录是**只读**的：这些目录与别的工具共享，往里写 `enabled:` 会改到别人的文件。
 * 所以它们只参与扫描与注入，`editable: false`，不带切换/删除入口。
 */

/** 向上追溯父目录的层数上限。 */
const MAX_PARENT_LEVELS = 8

interface Frontmatter {
  attrs: Record<string, string>
  body: string
}

export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { attrs: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { attrs: {}, body: text }
  const head = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  const attrs: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    attrs[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return { attrs, body }
}

function serializeFrontmatter(attrs: Record<string, string>, body: string): string {
  const head = Object.entries(attrs)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return `---\n${head}\n---\n\n${body.trim()}\n`
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `skill-${randomUUID().slice(0, 8)}`
}

interface SkillSource {
  dir: string
  scope: 'user' | 'project'
  origin: SkillRecord['origin']
  editable: boolean
}

/** 一个项目要扫的全部技能目录（父目录链从**远到近**，近的覆盖远的同名技能）。 */
function skillSources(projectPath: string | null): SkillSource[] {
  const sources: SkillSource[] = [
    // 顺序即优先级：后面的同名技能覆盖前面的
    { dir: join(homedir(), '.agents', 'skills'), scope: 'user', origin: 'agents', editable: false },
    { dir: userSkillsDir(), scope: 'user', origin: 'native', editable: true }
  ]
  if (!projectPath) return sources

  const root = resolve(projectPath)
  const parents: string[] = []
  let dir = root
  for (let i = 0; i < MAX_PARENT_LEVELS; i += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    parents.push(parent)
    dir = parent
  }
  for (const parent of parents.reverse()) {
    sources.push({ dir: join(parent, '.agents', 'skills'), scope: 'project', origin: 'agents', editable: false })
    sources.push({ dir: join(parent, '.pi', 'skills'), scope: 'project', origin: 'pi', editable: false })
  }
  sources.push({ dir: join(root, '.agents', 'skills'), scope: 'project', origin: 'agents', editable: false })
  sources.push({ dir: join(root, '.pi', 'skills'), scope: 'project', origin: 'pi', editable: false })
  sources.push({ dir: projectSkillsDir(root), scope: 'project', origin: 'native', editable: true })
  return sources
}

async function scanDir(source: SkillSource): Promise<SkillRecord[]> {
  if (!(await pathExists(source.dir))) return []
  const entries = await fs.readdir(source.dir, { withFileTypes: true }).catch(() => [])
  const out: SkillRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(source.dir, entry.name, 'SKILL.md')
    if (!(await pathExists(file))) continue
    const raw = await fs.readFile(file, 'utf8').catch(() => '')
    const { attrs } = parseFrontmatter(raw)
    out.push({
      id: entry.name,
      name: attrs.name || entry.name,
      description: attrs.description ?? '',
      scope: source.scope,
      path: file,
      enabled: attrs.enabled !== 'false',
      origin: source.origin,
      editable: source.editable
    })
  }
  return out
}

/** 按目录优先级合并：同名技能由更近的来源覆盖（项目级 > 用户级、原生目录 > 约定目录）。 */
function mergeByPriority(groups: SkillRecord[][]): SkillRecord[] {
  const byId = new Map<string, SkillRecord>()
  for (const group of groups) {
    for (const skill of group) byId.set(skill.id, skill)
  }
  return [...byId.values()]
}

function sortSkills(skills: SkillRecord[]): SkillRecord[] {
  return [...skills].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
    return a.id.localeCompare(b.id)
  })
}

export async function listSkills(projectPath: string | null): Promise<SkillRecord[]> {
  const groups: SkillRecord[][] = []
  for (const source of skillSources(projectPath)) groups.push(await scanDir(source))
  return sortSkills(mergeByPriority(groups))
}

/** 原生目录（只有这两个可以被增删改）。 */
function writableRoot(input: { scope: 'project' | 'user'; projectPath: string | null }): string {
  if (input.scope === 'project') {
    if (!input.projectPath) throw new Error('项目级技能需要先选择项目')
    return projectSkillsDir(input.projectPath)
  }
  return userSkillsDir()
}

export async function saveSkill(input: {
  scope: 'project' | 'user'
  projectPath: string | null
  name: string
  description: string
  body: string
}): Promise<SkillRecord> {
  const root = writableRoot(input)
  const id = slugify(input.name)
  const dir = join(root, id)
  await ensureDir(dir)
  const file = join(dir, 'SKILL.md')
  await fs.writeFile(
    file,
    serializeFrontmatter({ name: input.name, description: input.description, enabled: 'true' }, input.body),
    'utf8'
  )
  return {
    id,
    name: input.name,
    description: input.description,
    scope: input.scope,
    path: file,
    enabled: true,
    origin: 'native',
    editable: true
  }
}

/** 定位一个技能的文件：只在**原生目录**里找，避免误改跨工具共享的技能文件。 */
async function locateEditable(input: {
  scope: 'project' | 'user'
  projectPath: string | null
  id: string
}): Promise<string> {
  const root = writableRoot(input)
  const dir = join(root, input.id)
  if (!(await pathExists(dir))) {
    throw new Error(`技能「${input.id}」不在可编辑目录里（跨工具约定目录的技能是只读来源）`)
  }
  return dir
}

export async function removeSkill(input: {
  scope: 'project' | 'user'
  projectPath: string | null
  id: string
}): Promise<void> {
  const dir = await locateEditable(input)
  await fs.rm(dir, { recursive: true, force: true })
}

export async function toggleSkill(input: {
  scope: 'project' | 'user'
  projectPath: string | null
  id: string
  enabled: boolean
}): Promise<SkillRecord> {
  const dir = await locateEditable(input)
  const file = join(dir, 'SKILL.md')
  const raw = await fs.readFile(file, 'utf8')
  const { attrs, body } = parseFrontmatter(raw)
  // 显式标注：展开带索引签名的对象会丢掉索引签名，不标注就拿不到 name/description
  const next: Record<string, string> = { ...attrs, enabled: input.enabled ? 'true' : 'false' }
  await fs.writeFile(file, serializeFrontmatter(next, body), 'utf8')
  return {
    id: input.id,
    name: next.name || input.id,
    description: next.description ?? '',
    scope: input.scope,
    path: file,
    enabled: input.enabled,
    origin: 'native',
    editable: true
  }
}

/**
 * 读取所有启用技能的正文，供系统提示词注入（技能即"可复用的操作模式"）。
 *
 * `includeProjectSkills: false` 时**只注入用户级技能**：项目级技能来自仓库里的文件，
 * 而仓库是别人可以改的东西（见 `trust-store.ts`）。默认为 true，由调用方按信任状态传。
 */
export async function loadEnabledSkillBodies(
  projectPath: string | null,
  options: { includeProjectSkills?: boolean } = {}
): Promise<Array<{ name: string; description: string; body: string }>> {
  const includeProject = options.includeProjectSkills ?? true
  const skills = await listSkills(projectPath)
  const out: Array<{ name: string; description: string; body: string }> = []
  for (const skill of skills) {
    if (!skill.enabled) continue
    if (!includeProject && skill.scope === 'project') continue
    const raw = await fs.readFile(skill.path, 'utf8').catch(() => '')
    const { body } = parseFrontmatter(raw)
    out.push({ name: skill.name, description: skill.description, body: body.trim() })
  }
  return out
}
