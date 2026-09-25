import { promises as fs } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { ToolDefinition } from './types'
import { toolError, toolOk } from './types'
import { IGNORED_DIRS, requireProjectPath, resolveInsideProject, toPosixPath } from './paths'
import { asBoolean, asNumber, asOptionalString, asString } from './args'

const MAX_READ_BYTES = 400_000
const MAX_READ_LINES = 2_000
const MAX_WALK_FILES = 20_000

/** 递归列举项目内文件（跳过依赖/构建目录），返回相对项目根的 POSIX 路径。 */
async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    // 读取失败（权限/竞态删除）时按空目录处理；显式写出泛型避免 readdir 重载推断成 Buffer 变体
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        stack.push(join(dir, entry.name))
      } else if (entry.isFile()) {
        out.push(toPosixPath(relative(root, join(dir, entry.name))))
        if (out.length >= MAX_WALK_FILES) return out
      }
    }
  }
  return out
}

function globToRegExp(pattern: string): RegExp {
  const specials = '.+^${}()|[]\\'
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += specials.includes(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`^${out}$`)
}

async function looksBinary(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r').catch(() => null)
  if (!handle) return true
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    for (let i = 0; i < bytesRead; i += 1) if (buffer[i] === 0) return true
    return false
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export const readFileTool: ToolDefinition = {
  schema: {
    name: 'read_file',
    description:
      '读取项目内某个文件的文本内容，返回带行号的片段。大文件请用 offset/limit 分段读取。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的路径，例如 src/index.ts' },
        offset: { type: 'integer', description: '起始行号（从 1 开始），默认 1' },
        limit: { type: 'integer', description: '最多读取行数，默认 400' }
      },
      required: ['path']
    }
  },
  async run(args, ctx) {
    const project = requireProjectPath(ctx.projectPath)
    const rel = asString(args, 'path')
    const offset = Math.max(1, asNumber(args, 'offset', 1))
    const limit = Math.min(MAX_READ_LINES, Math.max(1, asNumber(args, 'limit', 400)))
    const target = resolveInsideProject(project, rel)

    const stat = await fs.stat(target).catch(() => null)
    if (!stat) return toolError(`文件不存在：${rel}`)
    if (stat.isDirectory()) return toolError(`${rel} 是目录，请改用 list_dir`)
    if (stat.size > MAX_READ_BYTES) {
      return toolError(`文件过大（${Math.round(stat.size / 1024)}KB），请用 offset/limit 分段读取`)
    }

    const raw = await fs.readFile(target, 'utf8')
    const all = raw.split(/\r?\n/)
    const slice = all.slice(offset - 1, offset - 1 + limit)
    const numbered = slice
      .map((line, index) => `${String(offset + index).padStart(5, ' ')}: ${line}`)
      .join('\n')
    const tail = offset - 1 + slice.length < all.length ? `\n…（共 ${all.length} 行，已截断）` : ''
    return toolOk(`${rel}（共 ${all.length} 行）\n${numbered}${tail}`)
  }
}

export const writeFileTool: ToolDefinition = {
  schema: {
    name: 'write_file',
    description: '写入（覆盖）项目内文件。新文件会自动创建父目录。修改已有文件优先用 edit_file。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的路径' },
        content: { type: 'string', description: '完整文件内容' }
      },
      required: ['path', 'content']
    }
  },
  async run(args, ctx, call) {
    const project = requireProjectPath(ctx.projectPath)
    const rel = asString(args, 'path')
    const content = asString(args, 'content', false)
    const target = resolveInsideProject(project, rel)

    const approved = await ctx.requestApproval(call, `写入文件 ${rel}（${content.length} 字符）`)
    if (!approved) return toolError(`用户拒绝写入 ${rel}`)

    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    return toolOk(`已写入 ${rel}（${content.length} 字符）`)
  }
}

export const editFileTool: ToolDefinition = {
  schema: {
    name: 'edit_file',
    description:
      '在文件中精确替换一段文本（old_string 必须与文件内容完全一致，含缩进）。默认要求 old_string 唯一。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的路径' },
        old_string: { type: 'string', description: '要被替换的原文（需精确匹配）' },
        new_string: { type: 'string', description: '替换后的内容；传空串表示删除' },
        replace_all: { type: 'boolean', description: '是否替换全部匹配，默认 false' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  async run(args, ctx, call) {
    const project = requireProjectPath(ctx.projectPath)
    const rel = asString(args, 'path')
    const oldStr = asString(args, 'old_string')
    const newStr = asOptionalString(args, 'new_string') ?? ''
    const replaceAll = asBoolean(args, 'replace_all', false)
    const target = resolveInsideProject(project, rel)

    const raw = await fs.readFile(target, 'utf8').catch(() => null)
    if (raw === null) return toolError(`文件不存在或不可读：${rel}`)

    const occurrences = raw.split(oldStr).length - 1
    if (occurrences === 0) return toolError('old_string 未在文件中找到，请先 read_file 核对原文（注意缩进）')
    if (occurrences > 1 && !replaceAll) {
      return toolError(`old_string 匹配到 ${occurrences} 处，请扩大上下文使其唯一，或设置 replace_all=true`)
    }

    const approved = await ctx.requestApproval(call, `编辑文件 ${rel}（${occurrences} 处替换）`)
    if (!approved) return toolError(`用户拒绝编辑 ${rel}`)

    const next = replaceAll ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, newStr)
    await fs.writeFile(target, next, 'utf8')
    return toolOk(`已更新 ${rel}（替换 ${replaceAll ? occurrences : 1} 处）`)
  }
}

export const listDirTool: ToolDefinition = {
  schema: {
    name: 'list_dir',
    description: '列出目录下的直接子项（文件与目录），用于了解项目结构。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的目录，默认项目根目录' }
      }
    }
  },
  async run(args, ctx) {
    const project = requireProjectPath(ctx.projectPath)
    const rel = asOptionalString(args, 'path') ?? '.'
    const target = resolveInsideProject(project, rel)
    const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => null)
    if (!entries) return toolError(`目录不存在或不可读：${rel}`)

    const lines = await Promise.all(
      entries
        .filter((entry) => !IGNORED_DIRS.has(entry.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map(async (entry) => {
          if (entry.isDirectory()) return `[dir]  ${entry.name}/`
          const size = await fs.stat(join(target, entry.name)).then((s) => s.size).catch(() => 0)
          return `[file] ${entry.name}  (${size} B)`
        })
    )
    return toolOk(lines.length ? lines.join('\n') : '(空目录)')
  }
}

export const globTool: ToolDefinition = {
  schema: {
    name: 'glob',
    description: '按通配符查找文件，支持 ** 递归，例如 **/*.ts、src/**/test_*.py。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '通配符模式' },
        max_results: { type: 'integer', description: '最多返回条数，默认 200' }
      },
      required: ['pattern']
    }
  },
  async run(args, ctx) {
    const project = requireProjectPath(ctx.projectPath)
    const pattern = asString(args, 'pattern')
    const max = Math.min(1000, Math.max(1, asNumber(args, 'max_results', 200)))
    const regex = globToRegExp(pattern)
    const bare = !pattern.includes('/')
    const files = await collectFiles(project)
    const matched = files.filter((file) => regex.test(file) || (bare && regex.test(basename(file))))
    const shown = matched.slice(0, max)
    return toolOk(
      `匹配 ${matched.length} 个文件${matched.length > shown.length ? `（仅显示前 ${shown.length} 个）` : ''}\n${shown.join('\n')}`
    )
  }
}

export const grepTool: ToolDefinition = {
  schema: {
    name: 'grep',
    description: '按正则表达式搜索文件内容，返回 文件:行号:内容。可用 glob 限定文件范围。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        glob: { type: 'string', description: '文件过滤通配符，如 **/*.ts' },
        ignore_case: { type: 'boolean', description: '是否忽略大小写' },
        max_results: { type: 'integer', description: '最多返回条数，默认 80' }
      },
      required: ['pattern']
    }
  },
  async run(args, ctx) {
    const project = requireProjectPath(ctx.projectPath)
    const source = asString(args, 'pattern')
    const filter = asOptionalString(args, 'glob')
    const ignoreCase = asBoolean(args, 'ignore_case', false)
    const max = Math.min(400, Math.max(1, asNumber(args, 'max_results', 80)))

    let regex: RegExp
    try {
      regex = new RegExp(source, ignoreCase ? 'i' : '')
    } catch (error) {
      return toolError(`正则表达式无效：${error instanceof Error ? error.message : source}`)
    }

    const filterRegex = filter ? globToRegExp(filter) : null
    const files = (await collectFiles(project)).filter((file) => !filterRegex || filterRegex.test(file))

    const hits: string[] = []
    for (const file of files) {
      if (hits.length >= max) break
      const full = join(project, file)
      const stat = await fs.stat(full).catch(() => null)
      if (!stat || stat.size > 1_000_000) continue
      if (await looksBinary(full)) continue
      const raw = await fs.readFile(full, 'utf8').catch(() => '')
      if (!raw) continue
      const lines = raw.split(/\r?\n/)
      for (let i = 0; i < lines.length && hits.length < max; i += 1) {
        if (regex.test(lines[i])) {
          hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 240)}`)
        }
      }
    }
    return toolOk(hits.length ? hits.join('\n') : '未找到匹配内容')
  }
}

export const fsTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool
]
