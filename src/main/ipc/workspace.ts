import { app, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { IPC } from '@shared/ipc'
import type { AppInfo, FileNode, FileReadResult, ShellRunRequest } from '@shared/types'
import { testProvider } from '../agent/providers'
import { runtime } from '../agent/runtime'
import { getAutoLaunch, setAutoLaunch } from '../auto-launch'
import { IGNORED_DIRS } from '../agent/tools/paths'
import { addProject, listProjects, removeProject, touchProject } from '../store/project-store'
import { loadSettings, saveSettings } from '../store/settings-store'
import { gitCommit, gitDiff, gitDiscard, gitStage, gitStatus, gitUnstage } from '../util/git'
import { killShellRun, startShellRun } from '../util/shell-runner'
import { send } from './bus'

const MAX_TREE_ENTRIES = 1_500
const MAX_FILE_READ_BYTES = 2_000_000

export function registerWorkspaceIpc(): void {
  /* ---------------- 应用 ---------------- */
  ipcMain.handle(IPC.app.info, (): AppInfo => {
    return {
      name: 'Code Harness',
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      node: process.versions.node ?? '',
      chrome: process.versions.chrome ?? '',
      platform: `${process.platform} ${process.arch}`,
      userDataPath: app.getPath('userData'),
      workspaceRoot: app.isPackaged ? null : app.getAppPath(),
      isPackaged: app.isPackaged
    }
  })

  ipcMain.handle(IPC.app.getAutoLaunch, () => getAutoLaunch())
  ipcMain.handle(IPC.app.setAutoLaunch, (_event, enabled: boolean) => setAutoLaunch(enabled))


  ipcMain.handle(IPC.app.openExternal, async (_event, url: string) => {
    const settings = await loadSettings()
    if (!settings.allowExternalLinks) return
    if (!/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })

  ipcMain.handle(IPC.app.pickDirectory, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.app.revealPath, (_event, target: string) => {
    shell.showItemInFolder(resolve(target))
  })

  /* ---------------- 设置 ---------------- */
  ipcMain.handle(IPC.settings.get, () => loadSettings())
  ipcMain.handle(IPC.settings.save, async (_event, next) => {
    const saved = await saveSettings(next)
    // 必须同步刷新运行时缓存：会话每个回合都从 settingsCache 读 permissionMode 与
    // autoApproveTools。不刷新的话，在设置里把权限改成「自动」或勾上「总是允许编辑文件」
    // 要等到下次新建会话或重启才生效 —— 用户看到的就是「我明明允许了，它还在问」。
    await runtime.refreshSettings()
    return saved
  })
  ipcMain.handle(IPC.settings.testProvider, async (_event, providerId: string) => {
    const settings = await loadSettings()
    const provider = settings.providers.find((p) => p.id === providerId)
    if (!provider) {
      return { id: providerId, name: providerId, kind: 'openai-compatible' as const, configured: false, reachable: false, detail: '未找到该 Provider' }
    }
    return testProvider(provider)
  })

  /* ---------------- 项目 ---------------- */
  ipcMain.handle(IPC.projects.list, () => listProjects())
  ipcMain.handle(IPC.projects.add, (_event, path: string) => addProject(path))
  ipcMain.handle(IPC.projects.remove, (_event, id: string) => removeProject(id))
  ipcMain.handle(IPC.projects.touch, (_event, id: string) => touchProject(id))

  /* ---------------- 文件 ---------------- */
  ipcMain.handle(IPC.files.tree, async (_event, projectPath: string, relPath?: string) => {
    const root = resolve(projectPath)
    return buildTree(root, relPath ? resolve(root, relPath) : root)
  })

  ipcMain.handle(IPC.files.read, async (_event, projectPath: string, relPath: string): Promise<FileReadResult> => {
    const root = resolve(projectPath)
    const target = resolve(root, relPath)
    if (!isInside(root, target)) throw new Error('路径越界')
    const stat = await fs.stat(target)
    if (stat.size > MAX_FILE_READ_BYTES) {
      return { path: relPath, content: '(文件过大，未加载)', truncated: true, lines: 0 }
    }
    const content = await fs.readFile(target, 'utf8')
    return { path: relPath, content, truncated: false, lines: content.split(/\r?\n/).length }
  })

  /* ---------------- Git ---------------- */
  ipcMain.handle(IPC.git.status, (_event, projectPath: string) => gitStatus(resolve(projectPath)))
  ipcMain.handle(IPC.git.diff, (_event, projectPath: string, file: string, staged: boolean) =>
    gitDiff(resolve(projectPath), file, staged)
  )
  ipcMain.handle(IPC.git.stage, (_event, projectPath: string, files: string[]) =>
    gitStage(resolve(projectPath), files)
  )
  ipcMain.handle(IPC.git.unstage, (_event, projectPath: string, files: string[]) =>
    gitUnstage(resolve(projectPath), files)
  )
  ipcMain.handle(IPC.git.discard, (_event, projectPath: string, files: string[]) =>
    gitDiscard(resolve(projectPath), files)
  )
  ipcMain.handle(IPC.git.commit, (_event, projectPath: string, message: string) =>
    gitCommit(resolve(projectPath), message)
  )

  /* ---------------- 终端 ---------------- */
  ipcMain.handle(IPC.shell.run, (_event, request: ShellRunRequest) => {
    const runId = startShellRun(request, {
      onChunk: (chunk) => send(IPC.push.shellChunk, chunk),
      onExit: (exit) => send(IPC.push.shellExit, exit)
    })
    return { runId }
  })
  ipcMain.handle(IPC.shell.kill, (_event, runId: string) => killShellRun(runId))
}

/* ------------------------------------------------------------------ *
 * 文件树
 * ------------------------------------------------------------------ */

async function buildTree(root: string, target: string): Promise<FileNode> {
  let count = 0

  const walk = async (dir: string, depth: number): Promise<FileNode[]> => {
    if (depth > 6 || count > MAX_TREE_ENTRIES) return []
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const nodes: FileNode[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.code-harness') continue
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
      if (count >= MAX_TREE_ENTRIES) break
      count += 1
      const full = join(dir, entry.name)
      const rel = relative(root, full).split('\\').join('/')
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: rel, type: 'directory', children: await walk(full, depth + 1) })
      } else if (entry.isFile()) {
        const size = await fs.stat(full).then((s) => s.size).catch(() => 0)
        nodes.push({ name: entry.name, path: rel, type: 'file', size })
      }
    }
    return nodes.sort(
      (a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)
    )
  }

  const relTarget = relative(root, target).split('\\').join('/')
  return {
    name: basename(root) || root,
    path: relTarget,
    type: 'directory',
    children: await walk(target, 0)
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'))
}
