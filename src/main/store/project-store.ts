import { basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { ProjectRecord } from '@shared/types'
import { readJson, writeJson } from './json-file'
import { projectsFile } from './paths'

interface Persisted {
  projects: ProjectRecord[]
}

let cache: ProjectRecord[] | null = null

export async function listProjects(): Promise<ProjectRecord[]> {
  if (!cache) {
    const data = await readJson<Persisted>(projectsFile(), { projects: [] })
    cache = Array.isArray(data.projects) ? data.projects : []
  }
  return [...cache].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

async function persist(): Promise<void> {
  await writeJson(projectsFile(), { projects: cache ?? [] })
}

export async function addProject(rawPath: string): Promise<ProjectRecord> {
  const path = resolve(rawPath)
  const projects = await listProjects()
  const existing = projects.find((p) => p.path === path)
  if (existing) return existing

  // 校验目录存在，避免把无效路径写进列表
  const stat = await fs.stat(path).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new Error(`不是有效目录：${path}`)
  }

  const record: ProjectRecord = {
    id: randomUUID(),
    path,
    name: basename(path) || path,
    addedAt: Date.now(),
    lastOpenedAt: Date.now()
  }
  cache = [record, ...projects]
  await persist()
  return record
}

export async function removeProject(id: string): Promise<void> {
  const projects = await listProjects()
  cache = projects.filter((p) => p.id !== id)
  await persist()
}

export async function touchProject(id: string): Promise<void> {
  const projects = await listProjects()
  cache = projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: Date.now() } : p))
  await persist()
}
