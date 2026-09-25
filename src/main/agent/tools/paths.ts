import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 所有文件类工具都必须经过这里：把相对路径解析进项目根，并阻断越界（../ 逃逸、绝对路径穿透）。 */
export function resolveInsideProject(projectPath: string, rel: string): string {
  const root = resolve(projectPath)
  const target = isAbsolute(rel) ? resolve(rel) : resolve(root, rel)
  const relToRoot = relative(root, target)
  if (relToRoot.startsWith('..') || (relToRoot === '' ? false : relToRoot.startsWith(`..${sep}`))) {
    throw new Error(`路径越界：${rel} 不在项目目录内`)
  }
  if (isAbsolute(rel) && target !== root) {
    // 绝对路径一律视为越界，除非等于根目录本身
    throw new Error(`不允许使用绝对路径：${rel}`)
  }
  return target
}

export function toPosixPath(value: string): string {
  return value.split(sep).join('/')
}

export function requireProjectPath(projectPath: string | null): string {
  if (!projectPath) {
    throw new Error('当前会话未关联项目目录，请先在左侧添加并选择一个项目。')
  }
  return projectPath
}

/** 遍历时统一跳过的重目录（既提速也避免把依赖源码喂给模型）。 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'release',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode'
])
