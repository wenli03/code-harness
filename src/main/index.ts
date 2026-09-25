import { app, BrowserWindow } from 'electron'
import { runtime } from './agent/runtime'
import { APP_USER_MODEL_ID } from './auto-launch'
import { registerIpc, setMainWindow } from './ipc'
import { createWindow } from './window'

// 必须在任何「开机启动」读写之前固定身份，见 auto-launch.ts 的说明
app.setAppUserModelId(APP_USER_MODEL_ID)

/**
 * 主进程入口：常驻运行时（会话/审批/调度）+ 单窗口桌面壳。
 * 与 prime-agent 的 daemon 对应——运行时随应用存活，窗口只是它的一个视图。
 */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  app.whenReady().then(async () => {
    await runtime.init()
    runtime.startScheduler()

    const window = createWindow()
    setMainWindow(window)
    registerIpc()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const next = createWindow()
        setMainWindow(next)
      }
    })
  })

  app.on('window-all-closed', () => {
    runtime.stopScheduler()
    if (process.platform !== 'darwin') app.quit()
  })
}
