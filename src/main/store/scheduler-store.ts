import { randomUUID } from 'node:crypto'
import type { ScheduledTask } from '@shared/types'
import { nextOccurrence } from '../util/rrule'
import { readJson, writeJson } from './json-file'
import { schedulerFile } from './paths'

interface Persisted {
  tasks: ScheduledTask[]
}

let cache: ScheduledTask[] | null = null

async function load(): Promise<ScheduledTask[]> {
  if (cache) return cache
  const data = await readJson<Persisted>(schedulerFile(), { tasks: [] })
  cache = Array.isArray(data.tasks) ? data.tasks : []
  return cache
}

async function persist(): Promise<void> {
  await writeJson(schedulerFile(), { tasks: cache ?? [] })
}

export async function listTasks(projectPath?: string | null): Promise<ScheduledTask[]> {
  const tasks = await load()
  const filtered =
    projectPath === undefined ? tasks : tasks.filter((t) => t.projectPath === projectPath)
  return [...filtered].sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
}

export async function createTask(input: {
  name: string
  prompt: string
  projectPath: string | null
  sessionId: string | null
  rrule: string
}): Promise<ScheduledTask> {
  const tasks = await load()
  const task: ScheduledTask = {
    id: randomUUID(),
    name: input.name.trim() || '未命名任务',
    prompt: input.prompt,
    projectPath: input.projectPath,
    sessionId: input.sessionId,
    rrule: input.rrule,
    enabled: true,
    createdAt: Date.now(),
    lastRunAt: null,
    nextRunAt: nextOccurrence(input.rrule),
    lastResult: ''
  }
  cache = [...tasks, task]
  await persist()
  return task
}

export async function updateTask(
  id: string,
  patch: Partial<ScheduledTask>
): Promise<ScheduledTask | null> {
  const tasks = await load()
  const current = tasks.find((t) => t.id === id)
  if (!current) return null
  const merged: ScheduledTask = { ...current, ...patch, id: current.id }
  if (patch.rrule && patch.rrule !== current.rrule) {
    merged.nextRunAt = nextOccurrence(patch.rrule)
  }
  if (patch.enabled === true && current.enabled === false) {
    merged.nextRunAt = nextOccurrence(merged.rrule)
  }
  cache = tasks.map((t) => (t.id === id ? merged : t))
  await persist()
  return merged
}

export async function removeTask(id: string): Promise<void> {
  const tasks = await load()
  cache = tasks.filter((t) => t.id !== id)
  await persist()
}

/** 执行后推进下一次触发时间（失败也推进，避免失败任务无限重试打满）。 */
export async function markRun(id: string, result: string): Promise<void> {
  const tasks = await load()
  cache = tasks.map((t) =>
    t.id === id
      ? {
          ...t,
          lastRunAt: Date.now(),
          nextRunAt: nextOccurrence(t.rrule),
          lastResult: result.slice(0, 400)
        }
      : t
  )
  await persist()
}
