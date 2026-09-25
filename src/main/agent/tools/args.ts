/** 工具参数读取：模型给错类型时给出明确、可自纠的错误，而不是静默传 undefined。 */
export function asString(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key]
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (!required) return ''
  throw new Error(`缺少必填参数 ${key}（应为字符串）`)
}

export function asOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') return value
  return String(value)
}

export function asNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

export function asBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function asStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}
