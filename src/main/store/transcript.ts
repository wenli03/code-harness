import { randomUUID } from 'node:crypto'
import type { AgentMessage, BranchTip, TranscriptEntry } from '@shared/types'

/**
 * 树形转录的纯逻辑：**不依赖 Electron、不碰磁盘**，只做"条目数组 → 当前分支 / 模型上下文"的推导。
 *
 * 为什么要有这一层：会话状态一旦树形化，"当前看到什么"就不再等于"文件里有什么"，
 * 而是三个东西叠加的结果——当前分支指针 + 压缩标记 + 上下文编辑。
 * 把这段推导抽成纯函数，才能脱离 Electron 直接单跑验证（这个仓库没有测试框架）。
 *
 * 语义对齐上游 pi 的 session-format：
 *  - 文件是 **append-only**，条目带 `id` / `parentId`，所以"回到历史某点继续"只移动指针、
 *    **不新建文件**，新条目自然长成一条分支；
 *  - 压缩（compaction）**不删历史**：它只是往文件里追加一条标记，声明"此前的历史由这段摘要代表"；
 *  - 上下文编辑（context-edit）把某条消息对模型隐藏，**文件与 UI 都不动**。
 */

/** 旧版（线性）转录里的一行就是一条 AgentMessage；这是识别它的判据。 */
function isMessageShaped(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.role === 'string' && typeof record.text === 'string'
}

function isEntryShaped(value: unknown): value is Partial<TranscriptEntry> {
  if (!value || typeof value !== 'object') return false
  const kind = (value as Record<string, unknown>).kind
  return kind === 'message' || kind === 'context-edit' || kind === 'compaction'
}

/**
 * 把文件里的原始行归一化成条目数组，并**修复父链**。
 *
 * 修复父链不是"容错"，是升级路径的必需品：旧版转录每行是一条消息、没有 `parentId`，
 * 而升级后的第一条第新条目写的父子关系建立在"当前指针"上。若不修复，
 * 一棵老会话加上一条新消息就会退化成"只看得见最后一条"。
 * 判据：只有**第一条**条目允许 `parentId === null`，其余缺失或指向未知 id 的一律接到上一条。
 */
export function normalizeEntries(raw: unknown[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let prevId: string | null = null

  for (const item of raw) {
    let entry: TranscriptEntry | null = null
    if (isEntryShaped(item)) {
      const record = item as Partial<TranscriptEntry>
      entry = {
        id: typeof record.id === 'string' && record.id ? record.id : randomUUID(),
        parentId: typeof record.parentId === 'string' ? record.parentId : null,
        kind: record.kind as TranscriptEntry['kind'],
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        ...(record.message ? { message: record.message } : {}),
        ...(record.targetId ? { targetId: record.targetId } : {}),
        ...(typeof record.visible === 'boolean' ? { visible: record.visible } : {}),
        ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
        ...(record.upToId !== undefined ? { upToId: record.upToId } : {}),
        ...(typeof record.charsBefore === 'number' ? { charsBefore: record.charsBefore } : {}),
        ...(typeof record.freedChars === 'number' ? { freedChars: record.freedChars } : {})
      }
    } else if (isMessageShaped(item)) {
      entry = {
        id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
        parentId: null,
        kind: 'message',
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        message: item
      }
    }
    if (!entry) continue

    if (prevId === null) {
      entry.parentId = null
    } else if (!entry.parentId || !entries.some((known) => known.id === entry.parentId)) {
      // 父缺失 / 指向未知 id：按写入顺序接到上一条（线性转录的语义）
      entry.parentId = prevId
    }

    entries.push(entry)
    prevId = entry.id
  }

  return entries
}

/** 当前指针：指向不存在的条目（文件被截断、会话被外部改动）时退化为最后一条。 */
export function resolveHead(entries: TranscriptEntry[], headId: string | null | undefined): string | null {
  if (!entries.length) return null
  if (headId && entries.some((entry) => entry.id === headId)) return headId
  return entries[entries.length - 1].id
}

/** 从当前指针沿 `parentId` 回溯到根，返回**从早到晚**的条目序列（即当前分支）。 */
export function activeChain(entries: TranscriptEntry[], headId: string | null | undefined): TranscriptEntry[] {
  const head = resolveHead(entries, headId)
  if (!head) return []
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const chain: TranscriptEntry[] = []
  const seen = new Set<string>()
  let cursor: string | null = head

  while (cursor) {
    if (seen.has(cursor)) break // 环（文件被手工改坏）：就地截断，绝不无限循环
    seen.add(cursor)
    const entry = byId.get(cursor)
    if (!entry) break
    chain.push(entry)
    cursor = entry.parentId
  }

  return chain.reverse()
}

/** 对模型隐藏的条目 id 集合（同一目标被多次编辑时，后写的生效）。 */
export function hiddenIdSet(chain: TranscriptEntry[]): Set<string> {
  const state = new Map<string, boolean>()
  for (const entry of chain) {
    if (entry.kind === 'context-edit' && entry.targetId) {
      state.set(entry.targetId, entry.visible !== false)
    }
  }
  const hidden = new Set<string>()
  for (const [id, visible] of state) if (!visible) hidden.add(id)
  return hidden
}

/**
 * 把当前分支投影成**模型可见的消息数组**——这是发给 Provider 的上下文。
 *
 * 两条规则：
 * 1. 最后一次压缩之前的一切由它的摘要代表（原始条目仍在文件里，UI 仍可回溯）；
 * 2. 被上下文编辑隐藏的消息不进这个数组（但仍在文件里）。
 */
export function projectMessages(chain: TranscriptEntry[]): AgentMessage[] {
  const hidden = hiddenIdSet(chain)
  let cutoff = -1
  for (let i = 0; i < chain.length; i += 1) {
    if (chain[i].kind === 'compaction') cutoff = i
  }

  const out: AgentMessage[] = []
  if (cutoff >= 0) {
    const marker = chain[cutoff]
    out.push({
      id: marker.id,
      role: 'assistant',
      text: marker.summary ?? '【历史工作快照】',
      createdAt: marker.createdAt,
      meta: { stopReason: 'compaction' }
    })
  }

  for (let i = cutoff + 1; i < chain.length; i += 1) {
    const entry = chain[i]
    if (entry.kind !== 'message' || !entry.message) continue
    // 同时按**条目 id** 与**消息 id** 匹配隐藏集合。
    // 存储层保证消息条目的两者相同（消息条目复用消息 id），但手工改过的转录或历史数据里
    // 可能不一致——此时宁可多隐藏一条：漏隐藏的后果是"用户以为已经扣下的内容继续发给模型"，
    // 方向错了就变成隐私问题，而不是显示问题。
    if (hidden.has(entry.id) || hidden.has(entry.message.id)) continue
    out.push(entry.message)
  }

  return out
}

function entryPreview(entry: TranscriptEntry): string {
  if (entry.kind === 'compaction') return '【压缩点】此前的历史由摘要代表'
  if (entry.kind === 'context-edit') {
    return entry.visible === false ? '【上下文编辑】隐藏了一条消息' : '【上下文编辑】恢复了一条消息'
  }
  const text = entry.message?.text?.replace(/\s+/g, ' ').trim() ?? ''
  if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text
  if (entry.message?.toolCalls?.length) return `（请求 ${entry.message.toolCalls.length} 个工具调用）`
  if (entry.message?.toolResult) return `（工具结果：${entry.message.toolResult.name}）`
  return '（空消息）'
}

/**
 * 分支尖列表：**没有子节点的条目**，外加当前指针自己。
 *
 * 为什么当前指针也要算进来：跳到历史某点继续后，那个点上原有的子条目属于**另一条分支**，
 * 指针本身就成了活动分支的尖端——不把它算进来的话，`/tree` 里会看不到"我正站在哪"。
 */
export function branchTips(entries: TranscriptEntry[], headId: string | null | undefined): BranchTip[] {
  const head = resolveHead(entries, headId)
  if (!entries.length || !head) return []
  const hasChild = new Set(entries.map((entry) => entry.parentId).filter((id): id is string => Boolean(id)))
  const tips: BranchTip[] = []
  for (const entry of entries) {
    const isLeaf = !hasChild.has(entry.id)
    if (!isLeaf && entry.id !== head) continue
    tips.push({
      id: entry.id,
      createdAt: entry.createdAt,
      preview: entryPreview(entry),
      kind: entry.kind,
      isActive: entry.id === head
    })
  }
  return tips.sort((a, b) => b.createdAt - a.createdAt)
}

/** 当前分支上的消息条目（含被隐藏的）——UI 用，投影用 `projectMessages`。 */
export function chainMessages(chain: TranscriptEntry[]): TranscriptEntry[] {
  return chain.filter((entry) => entry.kind === 'message' && Boolean(entry.message))
}
