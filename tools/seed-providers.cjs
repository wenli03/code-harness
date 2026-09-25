/**
 * 把本地密钥文件写进应用设置（密钥用 safeStorage 加密，与 UI 里点「保存」后的落盘形态完全一致）。
 *
 * 为什么是 Electron 主进程脚本而不是普通 node 脚本：
 *  1. safeStorage 只在 Electron 里可用；
 *  2. app.getPath('userData') 才是应用真实读取的配置目录（package.json 里把 productName 固定为
 *     "Code Harness"，因此开发态与打包后用同一份配置）。
 *
 * ⚠️ Windows 上的关键约束（实测踩过一次，务必别改回去）：
 *  Electron 的 safeStorage 走 Chromium OSCrypt，它的主密钥落在 `userData/Local State` 里，
 *  而该文件是 Chromium **异步**写出的。在它出现之前加密出来的密文只有本进程能解——
 *  应用重启后就是一堆废数据（现象是设置里 API Key 变空）。
 *  所以这里必须：① 建一个隐藏窗口把 profile 拉起来；② 轮询等 Local State 出现后才加密；
 *  ③ 用 app.quit() 优雅退出（app.exit() 会跳过 profile flush）。
 *
 * 用法：npm run seed:providers
 * 输入：仓库根的 providers.local.json（已在 .gitignore 中），形如
 *   { "activate": "deepseek",
 *     "providers": [{ "preset": "deepseek", "name": "...", "kind": "openai-compatible",
 *                     "baseUrl": "...", "models": ["..."], "apiKey": "..." }] }
 *
 * 幂等：按 baseUrl 匹配已存在的 Provider，命中则就地更新（不会重复堆叠）。
 * settings.json 不需要写全量字段 —— settings-store 的 normalize() 会用 DEFAULT_SETTINGS 兜底。
 */
const { app, safeStorage, BrowserWindow } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const INPUT = path.join(ROOT, 'providers.local.json')

// 直接以 electron 执行脚本时 app.getName() 不一定会读到本仓库的 package.json，
// 显式对齐一次，保证 userData 与应用运行时用的是同一个目录。
const pkg = require(path.join(ROOT, 'package.json'))
app.setName(pkg.productName || pkg.name)

function encryptKey(plain) {
  if (!plain) return { apiKey: '' }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { apiKeyEnc: safeStorage.encryptString(plain).toString('base64') }
    }
  } catch {
    // 落到明文兜底
  }
  console.warn('  ! safeStorage 不可用，该密钥将以明文写入（下次在 UI 里保存会自动转为加密）')
  return { apiKey: plain }
}

/** 等 Chromium 把 OSCrypt 主密钥写进 Local State —— 不等到就加密等于写垃圾。 */
async function waitForKeychain(userData, timeoutMs = 20_000) {
  const localState = path.join(userData, 'Local State')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(localState)) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

app.whenReady().then(async () => {
  if (!fs.existsSync(INPUT)) {
    console.error(`找不到 ${INPUT}`)
    app.exit(1)
    return
  }

  let input
  try {
    input = JSON.parse(fs.readFileSync(INPUT, 'utf8'))
  } catch (error) {
    console.error(`providers.local.json 解析失败：${error.message}`)
    app.exit(1)
    return
  }

  const incoming = Array.isArray(input.providers) ? input.providers : []
  if (!incoming.length) {
    console.error('providers.local.json 里没有 providers 数组')
    app.exit(1)
    return
  }

  const userData = app.getPath('userData')
  fs.mkdirSync(userData, { recursive: true })

  // 隐藏窗口把 Chromium profile 拉起来，Local State 才会被调度落盘
  const win = new BrowserWindow({ show: false })
  await win.loadURL('about:blank').catch(() => undefined)

  const keychainReady = await waitForKeychain(userData)
  if (!keychainReady) {
    console.error(`等待密钥环超时：${path.join(userData, 'Local State')} 未出现。`)
    console.error('已中止，以免写入本进程之外无法解密的密钥。可重试一次（第二次通常就好了）。')
    win.destroy()
    app.exit(1)
    return
  }

  const settingsFile = path.join(userData, 'settings.json')
  let current = {}
  if (fs.existsSync(settingsFile)) {
    try {
      current = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) ?? {}
    } catch {
      console.warn('  现有 settings.json 无法解析，将重建（原文件已备份为 settings.json.bak）')
      fs.copyFileSync(settingsFile, `${settingsFile}.bak`)
      current = {}
    }
  }

  const providers = Array.isArray(current.providers) ? [...current.providers] : []
  const results = []

  for (const entry of incoming) {
    if (!entry.baseUrl) {
      console.warn(`  跳过缺少 baseUrl 的条目：${entry.preset ?? entry.name ?? '(未命名)'}`)
      continue
    }

    const index = providers.findIndex((p) => p.baseUrl === entry.baseUrl)
    const existing = index >= 0 ? providers[index] : null
    const id = existing?.id ?? crypto.randomUUID()

    const record = {
      id,
      name: entry.name ?? existing?.name ?? entry.preset ?? 'Provider',
      kind: entry.kind ?? existing?.kind ?? 'openai-compatible',
      baseUrl: entry.baseUrl,
      models: Array.isArray(entry.models) && entry.models.length ? entry.models : (existing?.models ?? []),
      ...(existing?.headers ? { headers: existing.headers } : {}),
      ...encryptKey(entry.apiKey ?? '')
    }

    if (index >= 0) providers[index] = record
    else providers.push(record)

    results.push({
      preset: entry.preset ?? entry.name,
      action: index >= 0 ? '已更新' : '已新增',
      models: record.models,
      encrypted: Boolean(record.apiKeyEnc)
    })
  }

  // 选一个作为当前 Provider：显式指定 > 保持原有 > 第一个
  const activated =
    providers.find((p) => p.id === results.find((r) => r.preset === input.activate)?.id) ??
    providers.find((p) => p.id === current.activeProviderId) ??
    providers[0]

  const next = {
    ...current,
    providers,
    activeProviderId: activated?.id ?? '',
    activeModel: current.activeModel || activated?.models?.[0] || ''
  }

  const tmp = `${settingsFile}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, settingsFile)

  console.log(`配置已写入：${settingsFile}`)
  for (const r of results) {
    console.log(`  [${r.action}] ${r.preset}  模型：${r.models.join(', ') || '(未填)'}  加密：${r.encrypted ? '是' : '否'}`)
  }
  console.log(`当前 Provider：${activated?.name ?? '(无)'} / 模型：${next.activeModel || '(未填)'}`)

  win.destroy()
  // 必须优雅退出：app.exit() 会跳过 profile flush，密钥环可能来不及落盘
  app.quit()
})
