/**
 * 极简 RRULE 解析（不引入 rrule 依赖，覆盖本应用需要的三种频率）。
 * 支持：
 *   FREQ=HOURLY;INTERVAL=<n>
 *   FREQ=DAILY;BYHOUR=<h>;BYMINUTE=<m>
 *   FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=<h>;BYMINUTE=<m>
 * 解析失败一律回退为「每小时」，保证调度器永不静默停摆。
 */

const WEEKDAY_INDEX: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6
}

export interface ParsedRRule {
  freq: 'HOURLY' | 'DAILY' | 'WEEKLY'
  interval: number
  byHour: number | null
  byMinute: number
  byDay: number[]
}

export function parseRRule(rule: string): ParsedRRule {
  const out: ParsedRRule = { freq: 'HOURLY', interval: 1, byHour: null, byMinute: 0, byDay: [] }
  for (const part of (rule ?? '').split(';')) {
    const [rawKey, rawValue] = part.split('=')
    if (!rawKey || rawValue === undefined) continue
    const key = rawKey.trim().toUpperCase()
    const value = rawValue.trim()
    switch (key) {
      case 'FREQ': {
        const freq = value.toUpperCase()
        if (freq === 'HOURLY' || freq === 'DAILY' || freq === 'WEEKLY') out.freq = freq
        break
      }
      case 'INTERVAL': {
        const n = Number.parseInt(value, 10)
        if (Number.isFinite(n) && n > 0) out.interval = n
        break
      }
      case 'BYHOUR': {
        const n = Number.parseInt(value, 10)
        if (Number.isFinite(n) && n >= 0 && n <= 23) out.byHour = n
        break
      }
      case 'BYMINUTE': {
        const n = Number.parseInt(value, 10)
        if (Number.isFinite(n) && n >= 0 && n <= 59) out.byMinute = n
        break
      }
      case 'BYDAY': {
        out.byDay = value
          .split(',')
          .map((d) => WEEKDAY_INDEX[d.trim().toUpperCase()])
          .filter((n): n is number => typeof n === 'number')
        break
      }
      default:
        break
    }
  }
  return out
}

/** 计算 from 之后的下一次触发时间（毫秒时间戳）。 */
export function nextOccurrence(rule: string, from: number = Date.now()): number {
  const parsed = parseRRule(rule)
  const base = new Date(from)

  if (parsed.freq === 'HOURLY') {
    const next = new Date(base.getTime())
    next.setSeconds(0, 0)
    next.setMinutes(parsed.byMinute)
    if (next.getTime() <= base.getTime()) {
      next.setHours(next.getHours() + parsed.interval)
    }
    return next.getTime()
  }

  if (parsed.freq === 'DAILY') {
    const hour = parsed.byHour ?? 9
    const next = new Date(base.getTime())
    next.setHours(hour, parsed.byMinute, 0, 0)
    if (next.getTime() <= base.getTime()) {
      next.setDate(next.getDate() + parsed.interval)
    }
    return next.getTime()
  }

  // WEEKLY
  const hours = parsed.byHour ?? 9
  const days = parsed.byDay.length ? parsed.byDay : [base.getDay()]
  const candidate = new Date(base.getTime())
  for (let offset = 0; offset <= 14 * parsed.interval; offset += 1) {
    const probe = new Date(candidate.getTime())
    probe.setDate(candidate.getDate() + offset)
    probe.setHours(hours, parsed.byMinute, 0, 0)
    if (probe.getTime() <= base.getTime()) continue
    if (days.includes(probe.getDay())) return probe.getTime()
  }
  // 兜底：一周后
  const fallback = new Date(base.getTime())
  fallback.setDate(fallback.getDate() + 7)
  fallback.setHours(hours, parsed.byMinute, 0, 0)
  return fallback.getTime()
}

/** 供 UI 展示的可读描述。 */
export function describeRRule(rule: string): string {
  const p = parseRRule(rule)
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (p.freq === 'HOURLY') return p.interval === 1 ? '每小时' : `每 ${p.interval} 小时`
  if (p.freq === 'DAILY') return `每天 ${pad(p.byHour ?? 9)}:${pad(p.byMinute)}`
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const days = (p.byDay.length ? p.byDay : [1]).map((d) => names[d]).join('、')
  return `${days} ${pad(p.byHour ?? 9)}:${pad(p.byMinute)}`
}
