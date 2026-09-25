import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** 读取 JSON；文件缺失或损坏时返回 fallback（不抛错，保证应用可启动）。 */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 原子写入：先写临时文件再 rename，避免进程中断留下半截 JSON。 */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file))
  const tmp = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

/** 追加 JSONL 行（会话转录用）。 */
export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file))
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const out: T[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as T)
      } catch {
        // 跳过损坏行，保证已有历史仍可读取
      }
    }
    return out
  } catch {
    return []
  }
}

export async function removeFile(file: string): Promise<void> {
  try {
    await fs.rm(file, { force: true })
  } catch {
    // ignore
  }
}
