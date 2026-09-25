import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { userDataDir } from './paths'

/**
 * 上下文文件（`AGENTS.md` / `CLAUDE.md`）——对齐上游 pi 的惯例：
 * 启动时按 **全局 → 项目父目录链 → 当前目录** 的顺序拼接注入系统提示词。
 *
 * 两个细节值得说明：
 * 1. **同目录内 `AGENTS.override.md` 优先**：下游可以覆盖上游约定，而不必去改上级仓库里的文件；
 * 2. 父目录链会读到**项目根之外**的文件——这是刻意的，且不违反路径围栏：
 *    路径围栏约束的是**模型能调用的文件工具**，而这里是主进程装配提示词时的只读读取。
 *    上游同样是这个行为（"含父目录遍历"），否则 monorepo 里子项目就继承不到仓库级约定。
 *
 * 预算是字符量纲（与本项目其它预算一致，无分词器）。
 */

/** 单文件上限（字符）。 */
const PER_FILE_CHAR_BUDGET = 6_000
/** 全部上下文文件合计上限（字符）。 */
const TOTAL_CHAR_BUDGET = 16_000
/** 向上追溯的父目录层数上限（避免在超长路径上无限往上找）。 */
const MAX_PARENT_LEVELS = 8
/** 超大文件直接跳过：上下文文件是给人读的约定，不该有几百 KB。 */
const MAX_FILE_BYTES = 200_000

export interface ContextFileLayer {
  /** 来源文件的绝对路径（注入时会标注，便于模型引用） */
  path: string
  /** 该层属于哪个作用域 */
  scope: 'user' | 'parent' | 'project'
  content: string
  /** 因预算被截断 */
  truncated: boolean
}

export interface ContextFilesResult {
  layers: ContextFileLayer[]
  totalChars: number
  /** 还有内容因总预算未注入 */
  budgetExhausted: boolean
}

/** 同一目录下的候选文件名，按优先级排列（override 优先）。 */
const CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']

async function readCandidate(dir: string, scope: ContextFileLayer['scope']): Promise<ContextFileLayer | null> {
  for (const name of CANDIDATES) {
    const file = join(dir, name)
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) continue
    let content = ''
    try {
      content = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    if (content.includes('\u0000')) continue // 二进制
    const trimmed = content.trim()
    if (!trimmed) continue
    // 只取命中的**第一个**候选：同目录内 override 优先，不把 AGENTS.md 与 CLAUDE.md 都塞进去
    const truncated = trimmed.length > PER_FILE_CHAR_BUDGET
    return {
      path: file,
      scope,
      content: truncated ? `${trimmed.slice(0, PER_FILE_CHAR_BUDGET)}\n…(本文件超长，已截断)` : trimmed,
      truncated
    }
  }
  return null
}

/** 从项目根往上收集父目录层，返回**从最外层到项目根**（对人读起来是自上而下）。 */
function parentChain(projectPath: string): string[] {
  const chain: string[] = []
  let dir = resolve(projectPath)
  for (let i = 0; i < MAX_PARENT_LEVELS; i += 1) {
    const parent = dirname(dir)
    if (parent === dir) break // 到盘根了
    chain.push(parent)
    dir = parent
  }
  return chain.reverse()
}

export async function loadContextFiles(projectPath: string | null): Promise<ContextFilesResult> {
  const layers: ContextFileLayer[] = []

  const userLayer = await readCandidate(userDataDir(), 'user')
  if (userLayer) layers.push(userLayer)

  if (projectPath) {
    for (const dir of parentChain(projectPath)) {
      const layer = await readCandidate(dir, 'parent')
      if (layer) layers.push(layer)
    }
    const projectLayer = await readCandidate(resolve(projectPath), 'project')
    if (projectLayer) layers.push(projectLayer)
  }

  // 总预算：从**近到远**保留更有用的一层（项目根 > 父目录 > 用户级），
  // 所以倒着裁——先丢最外层的约定，而不是把子项目的约定丢掉。
  let total = 0
  let budgetExhausted = false
  const kept: ContextFileLayer[] = []
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i]
    if (total + layer.content.length > TOTAL_CHAR_BUDGET) {
      budgetExhausted = true
      continue
    }
    total += layer.content.length
    kept.unshift(layer)
  }

  return { layers: kept, totalChars: total, budgetExhausted }
}

/** 拼接成一段可注入的提示词（无文件时返回空串）。 */
export function renderContextFiles(result: ContextFilesResult): string {
  if (!result.layers.length) return ''
  const scopeLabel: Record<ContextFileLayer['scope'], string> = {
    user: '全局',
    parent: '父目录',
    project: '项目根'
  }
  const parts = result.layers.map(
    (layer) => `### ${scopeLabel[layer.scope]}：${layer.path}\n${layer.content}`
  )
  const tail = result.budgetExhausted
    ? '\n\n（部分上下文文件因预算未注入——它们的信息量超出了上下文预算，优先保留离项目更近的层）'
    : ''
  return `## 上下文文件（AGENTS.md / CLAUDE.md）\n以下是项目的既有约定，权重高于你的默认习惯，但低于用户本次的明确指令：\n\n${parts.join(
    '\n\n'
  )}${tail}`
}
