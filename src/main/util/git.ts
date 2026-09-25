import type { GitFileChange, GitStatus } from '@shared/types'
import { execCommand } from './exec'

const GIT_TIMEOUT = 30_000

async function git(projectPath: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await execCommand(`git ${args.map(quote).join(' ')}`, {
    cwd: projectPath,
    timeoutMs: GIT_TIMEOUT
  })
  return { ok: result.code === 0, out: result.stdout, err: result.stderr }
}

/** 仅允许安全的参数透传，规避注入。 */
function quote(value: string): string {
  if (/^[A-Za-z0-9_\-./=:@+]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

/**
 * 通用 git 调用（参数经 quote 透传），供需要任意 ref 组合的工具使用
 * ——例如 `ocr_review` 要按 `merge_base..to` 或 `show <commit>` 取单个文件的 diff。
 * 只读用途；不要用它执行写操作（写操作各有专用封装）。
 */
export const runGit = git

export async function gitStatus(projectPath: string): Promise<GitStatus> {
  const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) {
    return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [], clean: true, error: inside.err.trim() }
  }

  const porcelain = await git(projectPath, ['status', '--porcelain=v1', '-z', '--branch'])
  if (!porcelain.ok) {
    return { isRepo: true, branch: '', ahead: 0, behind: 0, files: [], clean: true, error: porcelain.err.trim() }
  }

  let branch = ''
  let ahead = 0
  let behind = 0
  const files: GitFileChange[] = []

  const tokens = porcelain.out.split('\0').filter((t) => t.length > 0)
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i]
    if (entry.startsWith('## ')) {
      const head = entry.slice(3)
      branch = head.split('...')[0].trim()
      const aheadMatch = /ahead (\d+)/.exec(head)
      const behindMatch = /behind (\d+)/.exec(head)
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0
      behind = behindMatch ? Number(behindMatch[1]) : 0
      continue
    }
    if (entry.length < 3) continue
    const x = entry[0]
    const y = entry[1]
    let path = entry.slice(3)
    // 重命名条目后跟一个 \0 分隔的原路径
    if (x === 'R' || y === 'R') i += 1
    path = path.replace(/\\/g, '/')
    files.push({ path, x, y, staged: x !== ' ' && x !== '?', untracked: x === '?' && y === '?' })
  }

  return { isRepo: true, branch, ahead, behind, files, clean: files.length === 0 }
}

export async function gitDiff(projectPath: string, file: string, staged: boolean): Promise<string> {
  const args = ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', file]
  const result = await git(projectPath, args)
  if (!result.ok) return result.err || '(git diff 失败)'
  if (result.out.trim()) return result.out
  // 未跟踪文件没有 diff，退化为全文预览
  const untracked = await git(projectPath, ['diff', '--no-color', '--no-index', '--', '/dev/null', file])
  return untracked.out || result.out || '(无差异)'
}

export async function gitStage(projectPath: string, files: string[]): Promise<void> {
  if (!files.length) return
  await git(projectPath, ['add', '--', ...files])
}

export async function gitUnstage(projectPath: string, files: string[]): Promise<void> {
  if (!files.length) return
  const result = await git(projectPath, ['reset', 'HEAD', '--', ...files])
  // 尚无初始提交时 reset 会失败，退回 rm --cached
  if (!result.ok) await git(projectPath, ['rm', '--cached', '-r', '--', ...files])
}

export async function gitDiscard(projectPath: string, files: string[]): Promise<void> {
  if (!files.length) return
  await git(projectPath, ['checkout', '--', ...files])
}

export async function gitCommit(
  projectPath: string,
  message: string
): Promise<{ ok: boolean; output: string }> {
  const result = await git(projectPath, ['commit', '-m', message])
  return { ok: result.ok, output: (result.out + result.err).trim() }
}
