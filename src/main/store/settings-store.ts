import { safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, clampMaxTokens, type AppSettings, type ProviderConfig } from '@shared/types'
import { readJson, writeJson } from './json-file'
import { settingsFile, userDataDir } from './paths'

/** 落盘形态：apiKey 用操作系统安全存储加密（若可用），避免明文密钥进磁盘。 */
interface PersistedProvider extends Omit<ProviderConfig, 'apiKey'> {
  apiKey?: string
  apiKeyEnc?: string
}

interface PersistedSettings extends Omit<AppSettings, 'providers'> {
  providers: PersistedProvider[]
}

let cache: AppSettings | null = null

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * safeStorage 在 Windows 上走 Chromium OSCrypt，主密钥保存在 `userData/Local State`，
 * 而该文件由 Chromium **异步**落盘。在它出现之前加密出来的密文只有当前进程能解，
 * 重启后会解密失败（现象就是「API Key 莫名其妙变空了」）。
 *
 * 正常使用不会踩到（用户配置密钥时应用已经跑了一会儿），这里只做两件事：
 * 让这个前提在日志里可见、并在解密失败时明确告警，而不是静默吞掉用户的密钥。
 */
function keychainFlushed(): boolean {
  try {
    return existsSync(join(userDataDir(), 'Local State'))
  } catch {
    return false
  }
}

let warnedKeychain = false

function encryptKey(plain: string): Pick<PersistedProvider, 'apiKey' | 'apiKeyEnc'> {
  if (!plain) return { apiKey: '' }
  if (canEncrypt()) {
    if (!keychainFlushed() && !warnedKeychain) {
      warnedKeychain = true
      console.warn(
        '[settings] Chromium 密钥环（userData/Local State）尚未落盘，' +
          '此刻保存的密钥在重启后可能无法解密。稍等几秒后重新保存一次即可。'
      )
    }
    try {
      return { apiKeyEnc: safeStorage.encryptString(plain).toString('base64') }
    } catch {
      // 落到明文兜底
    }
  }
  return { apiKey: plain }
}

function decryptKey(p: PersistedProvider): string {
  if (p.apiKeyEnc) {
    try {
      if (!canEncrypt()) return ''
      return safeStorage.decryptString(Buffer.from(p.apiKeyEnc, 'base64'))
    } catch (error) {
      console.warn(
        `[settings] Provider「${p.name}」的 API Key 解密失败（密钥环可能已更换或该系统账户变更），需要重新填写。`,
        error instanceof Error ? error.message : ''
      )
      return ''
    }
  }
  return p.apiKey ?? ''
}

function normalize(raw: Partial<AppSettings> | null): AppSettings {
  const base: AppSettings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) }
  base.providers = Array.isArray(raw?.providers) ? raw!.providers : []
  base.autoApproveTools = Array.isArray(raw?.autoApproveTools) ? raw!.autoApproveTools : []
  base.temperature = typeof base.temperature === 'number' ? base.temperature : DEFAULT_SETTINGS.temperature
  // 必须收敛范围：超出服务端限制的值会让每个回合都 400（见 clampMaxTokens 的说明）
  base.maxTokens = clampMaxTokens(
    typeof base.maxTokens === 'number' ? base.maxTokens : DEFAULT_SETTINGS.maxTokens
  )
  base.maxStepsPerTurn = typeof base.maxStepsPerTurn === 'number' ? base.maxStepsPerTurn : DEFAULT_SETTINGS.maxStepsPerTurn
  base.layaRepoPath = typeof base.layaRepoPath === 'string' ? base.layaRepoPath : ''
  return base
}

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache
  const persisted = await readJson<PersistedSettings | null>(settingsFile(), null)
  if (!persisted) {
    cache = normalize(null)
    return cache
  }
  const providers: ProviderConfig[] = (persisted.providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    models: Array.isArray(p.models) ? p.models : [],
    headers: p.headers,
    apiKey: decryptKey(p)
  }))
  cache = normalize({ ...persisted, providers })
  return cache
}

export async function saveSettings(next: AppSettings): Promise<AppSettings> {
  const normalized = normalize(next)
  const persisted: PersistedSettings = {
    ...normalized,
    providers: normalized.providers.map((p) => {
      const { apiKey, ...rest } = p
      return { ...rest, ...encryptKey(apiKey) }
    })
  }
  await writeJson(settingsFile(), persisted)
  cache = normalized
  return normalized
}


