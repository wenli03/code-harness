/**
 * Electron 二进制补装脚本。
 *
 * 背景：electron@44 起 package.json 里不再有 `postinstall`，二进制改为显式安装
 * （官方提供的 bin 是 `install-electron`）。所以只跑 `npm install` 拿到的
 * node_modules/electron 里没有 dist/，`electron-vite dev` 会直接报找不到可执行文件。
 *
 * 这里在 npm install 之后补一次；install.js 自身是幂等的——检测到 dist 版本匹配就立即退出。
 * 下载源优先取 npm 配置里的 electron_mirror（.npmrc 或环境变量），未配置时交给 @electron/get 走默认源。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const installer = join(process.cwd(), 'node_modules', 'electron', 'install.js')

if (!existsSync(installer)) {
  // 依赖还没装全（例如只装了部分 workspace），交给后续 npm install 处理
  process.exit(0)
}

const mirror = process.env.ELECTRON_MIRROR || process.env.npm_config_electron_mirror
const env = mirror ? { ...process.env, ELECTRON_MIRROR: mirror } : process.env

if (mirror) console.log(`[ensure-electron] 使用镜像：${mirror}`)

const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', env, cwd: process.cwd() })

if (result.status !== 0) {
  console.error('[ensure-electron] Electron 二进制下载失败。可手动重试：')
  console.error('  node node_modules/electron/install.js')
  process.exit(result.status ?? 1)
}

console.log('[ensure-electron] Electron 二进制就绪')
