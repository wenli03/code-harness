import type { BrowserWindow } from 'electron'

/** 主进程 → 渲染层的单向推送通道（放在独立模块，避免 ipc/* 之间循环依赖）。 */
let mainWindow: BrowserWindow | null = null

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window
}

export function send(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}
