/**
 * 命令行开关「开机启动」，用于无界面场景（部署脚本 / 一次性设置）。
 *
 * 用法：
 *   npx electron tools/auto-launch.cjs status
 *   npx electron tools/auto-launch.cjs on
 *   npx electron tools/auto-launch.cjs off
 *
 * 注意：这是由 Electron 直接执行的 CJS 脚本，无法复用 TS 模块，
 * 因此逻辑必须与 src/main/auto-launch.ts 保持一致：
 *  ① Windows 开发态要带上应用入口目录作为参数，否则开机只会弹出一个空的 Electron
 *    （应用是以 `electron <项目根>` 启动的，所以那个参数就是项目根目录）；
 *  ② **写入用 Electron API、读取直接查注册表** —— `app.getLoginItemSettings()` 在
 *    开发态读回的是 false，而注册表里明明写着（应用内读也一样）。要展示给用户看，
 *    就只能读注册表。别图省事换回 getLoginItemSettings。
 */
const { app } = require('electron')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
app.setName(pkg.productName || pkg.name)

// 与 src/main/auto-launch.ts 的 APP_USER_MODEL_ID 保持一致（也是 electron-builder.yml 的 appId）。
// Windows 上开机启动的注册表值名就是它。
const APP_USER_MODEL_ID = 'app.codeharness.desktop'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function launchTarget() {
  if (process.platform !== 'win32') return { path: process.execPath, args: [] }
  return { path: process.execPath, args: [ROOT] }
}

/** 读注册表拿到真实的启动命令（空串 = 未注册）。 */
function readRegisteredCommand() {
  if (process.platform !== 'win32') return ''
  try {
    const stdout = execFileSync('reg', ['query', RUN_KEY, '/v', APP_USER_MODEL_ID], {
      encoding: 'utf8',
      windowsHide: true
    })
    const escaped = APP_USER_MODEL_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`^\\s*${escaped}\\s+REG_SZ\\s+(.+)$`, 'im').exec(stdout)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

const mode = String(process.argv[2] || 'status').toLowerCase()

app.whenReady().then(() => {
  if (!['status', 'on', 'off'].includes(mode)) {
    console.error(`未知参数：${mode}（可用：status | on | off）`)
    app.exit(1)
    return
  }

  const target = launchTarget()

  if (mode !== 'status') {
    const options = { openAtLogin: mode === 'on', ...target }
    // Windows：同时改 StartupApproved，避免被「设置 → 启动应用」里的开关挡掉
    if (process.platform === 'win32') options.enabled = mode === 'on'
    app.setLoginItemSettings(options)
  }

  const command = readRegisteredCommand()
  const lower = command.toLowerCase()
  const enabled =
    Boolean(command) &&
    lower.includes(target.path.toLowerCase()) &&
    target.args.every((arg) => lower.includes(arg.toLowerCase()))

  console.log(`操作      ：${mode}`)
  console.log(`可执行文件：${target.path}`)
  console.log(`参数      ：${target.args.join(' ') || '(无)'}`)
  console.log(`注册表值名：${APP_USER_MODEL_ID}（HKCU\\...\\Run）`)
  console.log(`已注册命令：${command || '(未注册)'}`)
  console.log(`开机启动  ：${enabled ? '已开启 ✅' : '已关闭'}`)

  app.exit(0)
})
