import { app } from 'electron'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AutoLaunchState } from '@shared/types'

const run = promisify(execFile)

/**
 * 固定的应用身份。必须与 electron-builder.yml 的 `appId` 保持一致。
 *
 * Windows 上开机启动的注册表值名就是它（见下面），不显式设置的话会落到
 * `electron.app.Electron` —— 所有未设置的 Electron 应用共用同一个值名，会互相覆盖。
 */
export const APP_USER_MODEL_ID = 'app.codeharness.desktop'

/** Windows 的开机启动注册表位置。 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/**
 * 开机启动。
 *
 * 设计取舍：**以操作系统里的登录项为准，不在 settings.json 里另存一份**。
 * 否则用户在系统设置（Windows 的「启动应用」、macOS 的「登录项」）里关掉之后，
 * 应用下次启动又会把它加回来，两边说法不一致。
 *
 * ⚠️ Windows 上**写入用 Electron API、读取直接查注册表**，这不是多余：
 *   `app.setLoginItemSettings()` 写注册表是可靠的，但配套的 `app.getLoginItemSettings()`
 *   在开发态（`electron .`）读回的是 false —— 同一个注册表项，独立脚本读是 true、应用内读是 false，
 *   实测且与 AppUserModelId / 参数 / 名字都无关。既然要展示给用户看，就不能靠它。
 *   直接读注册表既确定、又能顺带把真实注册的命令显示出来。
 */

/**
 * 计算要注册的可执行文件与参数。
 *
 * Windows 开发态用 `electron .` 启动时 `process.execPath` 指向 `node_modules/electron/dist/electron.exe`，
 * 只注册它、不带参数的话开机后只会弹出一个空的 Electron。所以开发态要把**应用入口目录**
 * 作为参数带上（`electron .` 的 argv[1] 就是它）。打包后（`process.defaultApp === false`）
 * 可执行文件本身就是应用，不需要参数。
 */
function launchTarget(): { path: string; args: string[] } {
  if (process.platform !== 'win32') return { path: process.execPath, args: [] }
  const entry = process.argv[1]
  if (process.defaultApp && entry) {
    return { path: process.execPath, args: [resolve(entry)] }
  }
  return { path: process.execPath, args: [] }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function getAutoLaunch(): Promise<AutoLaunchState> {
  if (process.platform === 'win32') {
    const target = launchTarget()
    try {
      const { stdout } = await run('reg', ['query', RUN_KEY, '/v', APP_USER_MODEL_ID], {
        windowsHide: true
      })
      const line = new RegExp(`^\\s*${escapeRegExp(APP_USER_MODEL_ID)}\\s+REG_SZ\\s+(.+)$`, 'im').exec(
        stdout
      )
      const command = line?.[1]?.trim() ?? ''
      if (!command) return { supported: true, enabled: false, command: '' }

      // 命令里带了引号/大小写差异，按「路径与参数都出现」判定，别做全等比较
      const lower = command.toLowerCase()
      const enabled =
        lower.includes(target.path.toLowerCase()) &&
        target.args.every((arg) => lower.includes(arg.toLowerCase()))
      return { supported: true, enabled, command }
    } catch {
      // 值不存在时 reg 以非 0 退出
      return { supported: true, enabled: false, command: '' }
    }
  }

  if (process.platform === 'darwin') {
    try {
      return { supported: true, enabled: app.getLoginItemSettings().openAtLogin, command: '' }
    } catch {
      return { supported: true, enabled: false, command: '' }
    }
  }

  // Linux 上 Electron 不支持 openAtLogin
  return { supported: false, enabled: false, command: '' }
}

/** 写入登录项，返回写入后的**实际**状态（回读注册表，不猜）。 */
export async function setAutoLaunch(enabled: boolean): Promise<AutoLaunchState> {
  if (process.platform === 'linux') return { supported: false, enabled: false, command: '' }

  const options: Parameters<typeof app.setLoginItemSettings>[0] = {
    openAtLogin: enabled,
    ...launchTarget()
  }
  if (process.platform === 'win32') {
    // 同时改 StartupApproved，避免被「设置 → 启动应用」里的开关挡掉
    options.enabled = enabled
  }
  app.setLoginItemSettings(options)
  return getAutoLaunch()
}
