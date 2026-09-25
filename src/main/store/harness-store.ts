import { randomUUID } from 'node:crypto'
import type {
  Goal,
  HarnessMemory,
  HarnessRefinement,
  HarnessSnapshot,
  HarnessView
} from '@shared/types'
import { readJson, writeJson } from './json-file'
import { projectHarnessFile, userHarnessFile } from './paths'

/**
 * 持续 Harness（Continual Harness）状态：跨会话/跨轮次存活的补充提示、记忆、目标与快照。
 * 对齐 prime-agent：只做"小步、有证据"的更新，且任何修改前留快照，可回滚；
 * 绝不改写不可变的基础系统提示词——这里只存"增量"，由 harness.ts 拼接。
 */

interface HarnessPersisted {
  memories: HarnessMemory[]
  refinements: HarnessRefinement[]
  goals: Goal[]
  snapshots: HarnessSnapshot[]
}

const EMPTY: HarnessPersisted = { memories: [], refinements: [], goals: [], snapshots: [] }
const MAX_SNAPSHOTS = 20

function scopeFile(projectPath: string | null): string {
  return projectPath ? projectHarnessFile(projectPath) : userHarnessFile()
}

async function loadRaw(projectPath: string | null): Promise<HarnessPersisted> {
  const data = await readJson<Partial<HarnessPersisted>>(scopeFile(projectPath), {})
  return {
    memories: Array.isArray(data.memories) ? data.memories : [],
    refinements: Array.isArray(data.refinements) ? data.refinements : [],
    goals: Array.isArray(data.goals) ? data.goals : [],
    snapshots: Array.isArray(data.snapshots) ? data.snapshots : []
  }
}

async function saveRaw(projectPath: string | null, state: HarnessPersisted): Promise<void> {
  await writeJson(scopeFile(projectPath), {
    ...state,
    snapshots: state.snapshots.slice(0, MAX_SNAPSHOTS)
  })
}

function snapshotOf(state: HarnessPersisted, reason: string): HarnessSnapshot {
  return {
    id: randomUUID(),
    reason,
    createdAt: Date.now(),
    memoryCount: state.memories.length,
    refinementCount: state.refinements.length
  }
}

async function withSnapshot(
  projectPath: string | null,
  reason: string,
  mutate: (state: HarnessPersisted) => void
): Promise<HarnessPersisted> {
  const state = await loadRaw(projectPath)
  state.snapshots.unshift(snapshotOf(state, reason))
  mutate(state)
  await saveRaw(projectPath, state)
  return state
}

/** 合并 user + project 两个作用域的视图。 */
export async function viewHarness(
  projectPath: string | null,
  sessionId: string
): Promise<HarnessView> {
  const user = await loadRaw(null)
  const project = projectPath ? await loadRaw(projectPath) : EMPTY
  const memories = [...user.memories, ...project.memories]
  const refinements = [...user.refinements, ...project.refinements]
  const goals = [...user.goals, ...project.goals].filter((g) => g.sessionId === sessionId)
  const snapshots = [...project.snapshots, ...user.snapshots].slice(0, MAX_SNAPSHOTS)
  return {
    memories,
    refinements,
    goals,
    snapshots,
    injectedChars: buildHarnessPreamble({ memories, refinements, goals }).length
  }
}

/**
 * 注入系统提示词的体量上限。
 *
 * 这段内容**每一轮都会重新拼进系统提示词**，而记忆是只增不减的：不设上限的话，
 * 它对每轮成本的影响会随使用时间单调增长，最终变成"每轮先烧几千 token 在提醒上"。
 * 所以按类别限制条数与单条长度，并明确告知还有多少条没注入（完整列表在 Harness 面板）。
 */
const MAX_INJECTED_GOALS = 3
const MAX_INJECTED_MEMORIES = 12
const MAX_INJECTED_REFINEMENTS = 8
const MAX_INJECTED_GOAL_TEXT = 400
const MAX_INJECTED_MEMORY_TEXT = 240
const MAX_INJECTED_EVIDENCE_TEXT = 160

/** 截断单条文本并标注省略量，避免模型把截断误读成"原文就这么短"。 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…（略 ${text.length - limit} 字符）`
}

/** 超出注入上限时的提示行，避免模型以为"没有更多了"。 */
function overflowNote(total: number, shown: number, label: string): string[] {
  return total > shown ? [`- （另有 ${total - shown} 条${label}未注入，完整列表见 Harness 面板）`] : []
}

/** 拼装注入系统提示词的 Harness 段落（内容为空时返回空串）。 */
export function buildHarnessPreamble(input: {
  memories: HarnessMemory[]
  refinements: HarnessRefinement[]
  goals: Goal[]
}): string {
  const sections: string[] = []
  const activeGoals = input.goals.filter((g) => g.status === 'active')
  if (activeGoals.length) {
    const shown = activeGoals.slice(0, MAX_INJECTED_GOALS)
    sections.push(
      [
        '## 长期目标（跨轮次保持，直到完成/暂停/清除）',
        ...shown.map((g) => `- ${clip(g.text, MAX_INJECTED_GOAL_TEXT)}`),
        ...overflowNote(activeGoals.length, shown.length, '目标')
      ].join('\n')
    )
  }
  if (input.memories.length) {
    const shown = input.memories.slice(0, MAX_INJECTED_MEMORIES)
    sections.push(
      [
        '## 项目记忆（已确认的事实与约定，直接遵守）',
        ...shown.map((m) => {
          const evidence = m.evidence ? `（依据：${clip(m.evidence, MAX_INJECTED_EVIDENCE_TEXT)}）` : ''
          return `- ${clip(m.text, MAX_INJECTED_MEMORY_TEXT)}${evidence}`
        }),
        ...overflowNote(input.memories.length, shown.length, '记忆')
      ].join('\n')
    )
  }
  const activeRefinements = input.refinements.filter((r) => r.active)
  if (activeRefinements.length) {
    const shown = activeRefinements.slice(0, MAX_INJECTED_REFINEMENTS)
    sections.push(
      [
        '## 工作方式改进（本会话经验沉淀）',
        ...shown.map((r) => `- ${clip(r.text, MAX_INJECTED_MEMORY_TEXT)}`),
        ...overflowNote(activeRefinements.length, shown.length, '精炼')
      ].join('\n')
    )
  }
  if (!sections.length) return ''
  return `\n\n# 持续 Harness 状态\n\n${sections.join('\n\n')}\n`
}

export async function addMemory(input: {
  projectPath: string | null
  text: string
  evidence: string
  scope?: 'user' | 'project'
  source?: 'user' | 'refine'
}): Promise<void> {
  const scope = input.scope ?? (input.projectPath ? 'project' : 'user')
  const target = scope === 'user' ? null : input.projectPath
  await withSnapshot(target, `新增记忆：${input.text.slice(0, 24)}`, (state) => {
    state.memories.unshift({
      id: randomUUID(),
      scope,
      text: input.text,
      evidence: input.evidence,
      source: input.source ?? 'user',
      createdAt: Date.now()
    })
  })
}

export async function removeMemory(projectPath: string | null, id: string): Promise<void> {
  for (const scope of [projectPath, null]) {
    const state = await loadRaw(scope)
    if (state.memories.some((m) => m.id === id)) {
      await withSnapshot(scope, '删除记忆', (s) => {
        s.memories = s.memories.filter((m) => m.id !== id)
      })
      return
    }
  }
}

export async function addRefinement(input: {
  projectPath: string | null
  text: string
  evidence: string
}): Promise<void> {
  await withSnapshot(input.projectPath, `Harness 精炼：${input.text.slice(0, 24)}`, (state) => {
    state.refinements.unshift({
      id: randomUUID(),
      text: input.text,
      evidence: input.evidence,
      active: true,
      createdAt: Date.now()
    })
  })
}

export async function setGoal(projectPath: string | null, sessionId: string, text: string): Promise<Goal> {
  const goal: Goal = {
    id: randomUUID(),
    sessionId,
    text,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  await withSnapshot(projectPath, `设置目标：${text.slice(0, 24)}`, (state) => {
    // 同一会话只保留一个活跃目标，避免目标互相打架
    state.goals = state.goals.map((g) =>
      g.sessionId === sessionId && g.status === 'active' ? { ...g, status: 'done' as const } : g
    )
    state.goals.unshift(goal)
  })
  return goal
}

export async function updateGoal(
  projectPath: string | null,
  sessionId: string,
  goalId: string,
  status: Goal['status']
): Promise<Goal | null> {
  let updated: Goal | null = null
  for (const scope of [projectPath, null]) {
    const state = await loadRaw(scope)
    const found = state.goals.find((g) => g.id === goalId && g.sessionId === sessionId)
    if (!found) continue
    await withSnapshot(scope, `目标状态改为 ${status}`, (s) => {
      s.goals = s.goals.map((g) =>
        g.id === goalId ? { ...g, status, updatedAt: Date.now() } : g
      )
    })
    updated = { ...found, status, updatedAt: Date.now() }
    break
  }
  return updated
}

/**
 * 回滚：仅还原记忆与精炼条目（目标不回滚，避免"撤销用户意图"）。
 * 当前实现为「按快照计数裁剪」，语义直观且不会破坏快照链。
 */
export async function rollback(
  projectPath: string | null,
  snapshotId: string,
  override?: HarnessPersisted
): Promise<void> {
  const scopes: Array<string | null> = projectPath ? [projectPath, null] : [null]
  for (const scope of scopes) {
    const state = await loadRaw(scope)
    const index = state.snapshots.findIndex((s) => s.id === snapshotId)
    if (index < 0) continue
    const target = state.snapshots[index]
    await withSnapshot(scope, `回滚到 ${new Date(target.createdAt).toLocaleString()}`, (s) => {
      s.memories = s.memories.slice(0, target.memoryCount)
      s.refinements = s.refinements.slice(0, target.refinementCount)
      if (override) {
        s.memories = override.memories
        s.refinements = override.refinements
      }
    })
    return
  }
}
