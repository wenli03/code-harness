import { app } from 'electron'
import { join } from 'node:path'

/** 应用级数据目录（macOS ~/Library/Application Support、Windows %APPDATA%、Linux ~/.config）。 */
export function userDataDir(): string {
  return app.getPath('userData')
}

export function settingsFile(): string {
  return join(userDataDir(), 'settings.json')
}

export function projectsFile(): string {
  return join(userDataDir(), 'projects.json')
}

export function sessionsDir(): string {
  return join(userDataDir(), 'sessions')
}

export function sessionsIndexFile(): string {
  return join(sessionsDir(), 'index.json')
}

export function transcriptsDir(): string {
  return join(sessionsDir(), 'transcripts')
}

export function transcriptFile(sessionId: string): string {
  return join(transcriptsDir(), `${sessionId}.jsonl`)
}

export function userHarnessFile(): string {
  return join(userDataDir(), 'harness.json')
}

export function schedulerFile(): string {
  return join(userDataDir(), 'scheduler.json')
}

export function userSkillsDir(): string {
  return join(userDataDir(), 'skills')
}

/** 项目内私有目录：技能与项目级 Harness 记忆跟随仓库走，可提交或加入 .gitignore。 */
export const PROJECT_DIR_NAME = '.code-harness'

export function projectDir(projectPath: string): string {
  return join(projectPath, PROJECT_DIR_NAME)
}

export function projectHarnessFile(projectPath: string): string {
  return join(projectDir(projectPath), 'harness.json')
}

export function projectSkillsDir(projectPath: string): string {
  return join(projectDir(projectPath), 'skills')
}
