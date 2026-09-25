import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type {
  AgentMessage,
  SessionMeta,
  SessionTranscriptView,
  TranscriptEntry
} from '@shared/types'
import { appendJsonl, ensureDir, readJson, readJsonl, removeFile, writeJson } from './json-file'
import { sessionsDir, sessionsIndexFile, transcriptFile, transcriptsDir } from './paths'
import { activeChain, branchTips, hiddenIdSet, normalizeEntries, projectMessages, resolveHead } from './transcript'

/**
 * 会话存储，对齐上游 pi 的 session-format（**树形、append-only**）：
 *  - 元数据索引：sessions/index.json（列表、重命名、归档、**当前分支指针 headId**）
 *  - 转录：sessions/transcripts/<id>.jsonl（每行一个 TranscriptEntry，只追加、从不重写）
 *
 * 与"线性转录"的关键差别：**当前看到什么 ≠ 文件里有什么**。
 * 文件是一棵树（条目带 id/parentId），"回到历史某点继续"只移动指针、不新建文件，
 * 压缩与"对模型隐藏"都只是追加标记。推导逻辑全在 `transcript.ts`（纯函数，可单跑验证）。
 *
 * 兼容性：旧版转录每行是一条 AgentMessage、没有 id/parentId，读取时由
 * `normalizeEntries` 归一化并**修复父链**（否则老会话接一条新消息就会只剩最后一条）。
 */

interface SessionsIndex {
  sessions: SessionMeta[]
}

let index: SessionMeta[] | null = null

async function loadIndex(): Promise<SessionMeta[]> {
  if (index) return index
  const data = await readJson<SessionsIndex>(sessionsIndexFile(), { sessions: [] })
  const sessions = Array.isArray(data.sessions) ? data.sessions : []
  // 旧索引没有 headId：归一化成 null（读取时按"线性转录的最后一条"处理）
  index = sessions.map((session) => ({ ...session, headId: session.headId ?? null }))
  return index
}

async function persistIndex(): Promise<void> {
  await writeJson(sessionsIndexFile(), { sessions: index ?? [] })
}

export async function listSessions(projectPath?: string | null): Promise<SessionMeta[]> {
  const all = await loadIndex()
  const filtered = all.filter((s) => {
    if (s.isSubAgent) return false
    if (projectPath === undefined) return true
    if (projectPath === null) return s.projectPath === null
    return s.projectPath === projectPath
  })
  return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function searchSessions(query: string): Promise<SessionMeta[]> {
  const all = await listSessions(undefined)
  if (!query.trim()) return all
  const q = query.toLowerCase()
  const titleHits = all.filter((s) => s.title.toLowerCase().includes(q))
  const hitIds = new Set(titleHits.map((s) => s.id))
  // 标题未命中时回退到**当前分支**内容匹配（限制扫描量；被折叠/隐藏的历史不参与，避免
  // 搜出"模型其实看不到"的内容）
  for (const session of all) {
    if (hitIds.has(session.id)) continue
    const messages = await getSessionMessages(session.id)
    if (messages.some((m) => m.text && m.text.toLowerCase().includes(q))) hitIds.add(session.id)
  }
  return all.filter((s) => hitIds.has(s.id))
}

export async function getSessionMeta(id: string): Promise<SessionMeta | null> {
  const all = await loadIndex()
  return all.find((s) => s.id === id) ?? null
}

/** 读原始条目（归一化 + 父链修复）。转录是权威历史，索引只是派生视图。 */
export async function readTranscriptEntries(id: string): Promise<TranscriptEntry[]> {
  const raw = await readJsonl<unknown>(transcriptFile(id))
  return normalizeEntries(raw)
}

/** 模型可见的上下文（当前分支 + 压缩标记 + 上下文编辑的结果）。 */
export async function getSessionMessages(id: string): Promise<AgentMessage[]> {
  const meta = await getSessionMeta(id)
  const entries = await readTranscriptEntries(id)
  return projectMessages(activeChain(entries, meta?.headId))
}

/** UI 视图：当前分支条目（含隐藏的与压缩标记）+ 分支尖 + 隐藏集合。 */
export async function getTranscriptView(id: string): Promise<SessionTranscriptView> {
  const meta = await getSessionMeta(id)
  const entries = await readTranscriptEntries(id)
  const head = resolveHead(entries, meta?.headId)
  const chain = activeChain(entries, head)
  return {
    sessionId: id,
    headId: head,
    entries: chain,
    hiddenIds: [...hiddenIdSet(chain)],
    branches: branchTips(entries, head)
  }
}

export async function createSession(input: {
  projectPath: string | null
  title?: string
  providerId?: string
  model?: string
  parentId?: string | null
  isSubAgent?: boolean
}): Promise<SessionMeta> {
  await ensureDir(sessionsDir())
  await ensureDir(transcriptsDir())
  const now = Date.now()
  const meta: SessionMeta = {
    id: randomUUID(),
    title: input.title?.trim() || '新会话',
    projectPath: input.projectPath,
    createdAt: now,
    updatedAt: now,
    archived: false,
    providerId: input.providerId ?? '',
    model: input.model ?? '',
    messageCount: 0,
    parentId: input.parentId ?? null,
    isSubAgent: input.isSubAgent ?? false,
    headId: null
  }
  const all = await loadIndex()
  index = [meta, ...all]
  await persistIndex()
  await fs.writeFile(transcriptFile(meta.id), '', 'utf8')
  return meta
}

export async function updateSessionMeta(
  id: string,
  patch: Partial<SessionMeta>
): Promise<SessionMeta | null> {
  const all = await loadIndex()
  const current = all.find((s) => s.id === id)
  if (!current) return null
  const next: SessionMeta = { ...current, ...patch, updatedAt: Date.now() }
  index = all.map((s) => (s.id === id ? next : s))
  await persistIndex()
  return next
}

/**
 * 追加一条转录条目，并把当前指针移到它上面。
 *
 * 指针缺失时（旧会话首次写入）才需要读一次文件来定位末尾；
 * 之后指针落在索引里，追加是 O(1) 的。
 */
async function appendEntry(
  id: string,
  input: Omit<TranscriptEntry, 'id' | 'parentId' | 'createdAt'>
): Promise<{ entry: TranscriptEntry; meta: SessionMeta | null }> {
  const meta = await getSessionMeta(id)
  if (!meta) throw new Error(`会话不存在：${id}`)

  let parentId = meta.headId
  if (!parentId) {
    const entries = await readTranscriptEntries(id)
    parentId = resolveHead(entries, null)
  }

  const entry: TranscriptEntry = {
    // 消息条目复用消息自己的 id：这样"隐藏这一条""从这条分叉"都只是同一个 id 的问题，
    // 界面上拿 message.id 就能对上，不需要再维护一层映射（压缩标记才需要新 id）。
    id: input.kind === 'message' && input.message ? input.message.id : randomUUID(),
    parentId,
    createdAt: Date.now(),
    ...input
  }
  await appendJsonl(transcriptFile(id), entry)

  const next = await updateSessionMeta(id, {
    headId: entry.id,
    messageCount: meta.messageCount + (entry.kind === 'message' ? 1 : 0),
    title:
      meta.title === '新会话' && entry.kind === 'message' && entry.message?.role === 'user' && entry.message.text.trim()
        ? deriveTitle(entry.message.text)
        : meta.title
  })
  return { entry, meta: next }
}

/** 追加一条消息（流水线写入，不重写整个转录）。 */
export async function appendMessage(id: string, message: AgentMessage): Promise<SessionMeta | null> {
  const { meta } = await appendEntry(id, { kind: 'message', message })
  return meta
}

/**
 * 上下文编辑：把某条消息对**模型**隐藏或恢复。
 * 转录文件与界面都不动 —— 这是上游 `appendContextEdit` 的语义，也是"压缩不再等于删历史"的基础。
 */
export async function appendContextEdit(
  id: string,
  targetId: string,
  visible: boolean
): Promise<SessionMeta | null> {
  const { meta } = await appendEntry(id, { kind: 'context-edit', targetId, visible })
  return meta
}

/** 追加一个压缩标记：此前的历史由 summary 代表（原始条目全部保留，可回溯）。 */
export async function appendCompaction(
  id: string,
  input: { summary: string; upToId: string | null; charsBefore: number; freedChars: number }
): Promise<SessionMeta | null> {
  const { meta } = await appendEntry(id, { kind: 'compaction', ...input })
  return meta
}

/** 移动当前指针（`/tree` 的"回到此点继续"）：不新建文件，之后的条目自然长成一条新分支。 */
export async function setSessionHead(id: string, entryId: string): Promise<SessionTranscriptView> {
  const entries = await readTranscriptEntries(id)
  if (!entries.some((entry) => entry.id === entryId)) {
    throw new Error('要跳转的历史点不存在于该会话的转录里')
  }
  await updateSessionMeta(id, { headId: entryId })
  return getTranscriptView(id)
}

/** 把一条分支写成一个新会话文件。条目 id 原样保留，压缩标记与上下文编辑的引用才不会断。 */
async function copyChainToNewSession(
  source: SessionMeta,
  chain: TranscriptEntry[],
  suffix: string
): Promise<SessionMeta> {
  const meta = await createSession({
    projectPath: source.projectPath,
    title: `${source.title}${suffix}`,
    providerId: source.providerId,
    model: source.model,
    parentId: source.parentId,
    isSubAgent: source.isSubAgent
  })
  const body = chain.map((entry) => JSON.stringify(entry)).join('\n')
  await fs.writeFile(transcriptFile(meta.id), body ? `${body}\n` : '', 'utf8')
  const next = await updateSessionMeta(meta.id, {
    headId: chain.length ? chain[chain.length - 1].id : null,
    messageCount: chain.filter((entry) => entry.kind === 'message').length
  })
  return next ?? meta
}

/** 分叉：从历史某点开一个新会话（原会话不动，可以继续走原来的路）。 */
export async function forkSession(id: string, fromEntryId: string): Promise<SessionMeta> {
  const source = await getSessionMeta(id)
  if (!source) throw new Error(`会话不存在：${id}`)
  const entries = await readTranscriptEntries(id)
  const chain = activeChain(entries, fromEntryId)
  if (!chain.length) throw new Error('找不到要分叉的历史点')
  return copyChainToNewSession(source, chain, ' · 分支')
}

/** 克隆：把当前分支复制成一个新会话（继续往前走时两边互不影响）。 */
export async function cloneSession(id: string): Promise<SessionMeta> {
  const source = await getSessionMeta(id)
  if (!source) throw new Error(`会话不存在：${id}`)
  const entries = await readTranscriptEntries(id)
  const chain = activeChain(entries, source.headId)
  return copyChainToNewSession(source, chain, ' · 副本')
}

export async function removeSession(id: string): Promise<void> {
  const all = await loadIndex()
  const children = all.filter((s) => s.parentId === id)
  for (const child of children) {
    await removeFile(transcriptFile(child.id))
  }
  index = all.filter((s) => s.id !== id && s.parentId !== id)
  await persistIndex()
  await removeFile(transcriptFile(id))
}

function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine
}
