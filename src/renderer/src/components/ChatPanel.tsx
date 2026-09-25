import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMessage, SessionTranscriptView, ToolResult } from '@shared/types'
import { approvalGroupForTool } from '@shared/tool-groups'
import { actions, useApp } from '../state/store'
import { relTime, statusLabel, toolLabel } from '../lib/format'
import { Composer } from './Composer'
import { Icon } from './Icon'
import { MessageItem } from './MessageItem'

/** 聊天区的一行：可能是一条消息，也可能是一条"压缩分隔"（此前的历史由摘要代表）。 */
type RenderedRow =
  | { kind: 'divider'; key: string; summary: string; collapsed: number }
  | { kind: 'message'; key: string; message: AgentMessage; hidden: boolean }

/**
 * 聊天按**转录**渲染，而不是按 `messages`。
 *
 * `messages` 是"模型看到什么"：被上下文隐藏的、被压缩折叠的都不在里面。
 * 拿它当界面数据源会出两个错：一隐藏某条消息，界面上那条就凭空消失；
 * 一压缩上下文，界面上的历史会整段缩水——而用户其实什么都没删。
 * 转录视图才是"实际存在什么"，流式期间尚未落盘的消息补在末尾。
 */
function buildRows(transcript: SessionTranscriptView | null, messages: AgentMessage[]): RenderedRow[] {
  const rows: RenderedRow[] = []
  const known = new Set<string>()
  let collapsed = 0

  if (transcript) {
    for (const entry of transcript.entries) {
      known.add(entry.id)
      if (entry.kind === 'compaction') {
        rows.push({ kind: 'divider', key: entry.id, summary: entry.summary ?? '', collapsed })
        // 归零：第二次压缩只折叠"上一次压缩之后"的那一段，不是从头再数
        collapsed = 0
        continue
      }
      if (entry.kind !== 'message' || !entry.message) continue
      collapsed += 1
      rows.push({
        kind: 'message',
        key: entry.id,
        message: entry.message,
        hidden: transcript.hiddenIds.includes(entry.id)
      })
    }
  }

  for (const message of messages) {
    if (known.has(message.id)) continue
    rows.push({ kind: 'message', key: message.id, message, hidden: false })
  }
  return rows
}

export function ChatPanel() {
  const { messages, transcript, trust, session, sessionId, status, todos, approvals, toolStatus, loadingSession } =
    useApp()
  const [showBranches, setShowBranches] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  const results = useMemo(() => {
    const map: Record<string, ToolResult> = {}
    for (const message of messages) {
      if (message.role === 'tool' && message.toolResult) map[message.toolResult.id] = message.toolResult
    }
    return map
  }, [messages])

  const rows = useMemo(() => buildRows(transcript, messages), [transcript, messages])
  // 只有用户贴近底部时才自动跟随，避免打断向上翻阅
  const visible = useMemo(
    () => rows.filter((row) => row.kind !== 'message' || row.message.role !== 'tool'),
    [rows]
  )
  const lastKey = visible.length ? visible[visible.length - 1].key : null

  useEffect(() => {
    const container = scrollRef.current
    if (!container || !pinnedRef.current) return
    container.scrollTop = container.scrollHeight
  }, [visible.length, status, results])

  const onScroll = (): void => {
    const container = scrollRef.current
    if (!container) return
    pinnedRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 120
  }

  const activeApprovals = approvals.filter((request) => request.sessionId === sessionId)
  const running = ['thinking', 'streaming', 'tool', 'waiting-approval'].includes(status)

  const renderRow = (row: RenderedRow) => {
    if (row.kind === 'divider') {
      return (
        <div key={row.key} className="compaction-divider" title={row.summary}>
          <span className="line" />
          <span className="chip">
            上下文已压缩：此前 {row.collapsed} 条历史由摘要代表（原始内容仍在转录里，可回溯）
          </span>
          <span className="line" />
        </div>
      )
    }

    // 分支操作只对"有语义的轮次"给出：工具结果与系统消息上没有分叉/隐藏的意义
    const branchable = row.message.role === 'user' || row.message.role === 'assistant'
    return (
      <MessageItem
        key={row.key}
        message={row.message}
        results={results}
        toolStatus={toolStatus}
        streaming={running && row.message.role === 'assistant' && row.key === lastKey}
        hidden={row.hidden}
        onContinue={branchable ? () => void actions.switchBranch(row.key) : undefined}
        onFork={branchable ? () => void actions.forkFrom(row.key) : undefined}
        onToggleVisibility={
          branchable ? (nextVisible) => void actions.toggleEntryVisibility(row.key, nextVisible) : undefined
        }
      />
    )
  }

  return (
    <section className="chat">
      <div className="chat-header">
        <Icon name={session?.parentId ? 'brain' : 'sparkle'} size={14} />
        <span className="title truncate">{session?.title ?? '新会话'}</span>
        <span className={`chip ${running ? 'accent' : ''}`}>{statusLabel(status)}</span>
        {session?.parentId && <span className="chip">子智能体</span>}
        <div className="spacer" />
        {trust?.hasResources && trust.decision === 'never' && (
          <button
            className="chip warn"
            title="该项目里有项目级技能或记忆，但已设为不信任，因此不会注入上下文。点击改为信任。"
            onClick={() => void actions.setTrust('always')}
          >
            项目级资源未注入
          </button>
        )}
        <button className="icon-btn" title="新建会话" onClick={() => void actions.createSession()}>
          <Icon name="plus" />
        </button>
      </div>

      {trust?.hasResources && trust.decision === null && (
        <div className="trust-banner">
          <Icon name="alert" size={15} />
          <div style={{ flex: 1 }}>
            <div>该项目含项目级技能或 Harness 记忆，是否信任并注入上下文？</div>
            <div className="dim" style={{ fontSize: '0.86em', marginTop: 2 }}>
              这些内容来自<strong>仓库里的文件</strong>（`.code-harness/`、`.pi/`、`.agents/`）。仓库是别人可以改的东西，
              注入等于把系统提示词的一部分交给仓库作者，所以默认不注入。信任决定记在本地，可随时改。
            </div>
          </div>
          <button className="btn" onClick={() => void actions.setTrust('never')}>
            不信任
          </button>
          <button className="btn primary" onClick={() => void actions.setTrust('always')}>
            信任并注入
          </button>
        </div>
      )}

      {transcript && transcript.branches.length > 1 && (
        <div className="branch-bar">
          <Icon name="git" size={13} />
          <span>
            当前分支 {transcript.entries.filter((entry) => entry.kind === 'message').length} 条 · 另有{' '}
            {transcript.branches.filter((branch) => !branch.isActive).length} 个分支尖
          </span>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => setShowBranches((value) => !value)}>
            <Icon name={showBranches ? 'chevronDown' : 'chevronRight'} size={12} /> 分支
          </button>
          <button
            className="btn ghost sm"
            title="把当前分支复制成一个新会话（之后两边互不影响）"
            onClick={() => void actions.cloneBranch()}
          >
            <Icon name="plus" size={12} /> 复制当前分支
          </button>
        </div>
      )}

      {showBranches && transcript && (
        <div className="branch-list">
          {transcript.branches.slice(0, 12).map((branch) => (
            <button
              key={branch.id}
              className={`branch-row${branch.isActive ? ' active' : ''}`}
              disabled={branch.isActive}
              title={branch.isActive ? '这是当前分支' : '切换到这个分支尖继续'}
              onClick={() => void actions.switchBranch(branch.id)}
            >
              <span className="chip">{branch.kind === 'message' ? relTime(branch.createdAt) : '压缩点'}</span>
              <span className="truncate" style={{ flex: 1, textAlign: 'left' }}>
                {branch.preview}
              </span>
              {branch.isActive && <span className="muted">当前</span>}
            </button>
          ))}
          {transcript.branches.length > 12 && (
            <div className="muted" style={{ padding: '4px 8px', fontSize: '0.85em' }}>
              只列出最近 12 个分支尖
            </div>
          )}
        </div>
      )}

      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        <div className="messages-inner">
          {loadingSession && (
            <div className="empty">
              <span className="spin" />
              加载会话…
            </div>
          )}

          {!loadingSession && visible.length === 0 && (
            <div className="empty" style={{ paddingTop: 60 }}>
              <span className="brand-mark" style={{ width: 34, height: 34, fontSize: 16 }}>
                π
              </span>
              <div style={{ fontSize: '1.05em', color: 'var(--text-dim)' }}>开始一个开发任务</div>
              <div style={{ fontSize: '0.9em', maxWidth: 460, lineHeight: 1.7 }}>
                我可以在你的项目里读写文件、执行命令、跑 Git 操作，并把每一步都摊开给你审批。
                危险动作（写入、删除、提交、执行命令）默认需要你点头。
              </div>
              <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                {['看一下项目结构，说明主要模块', '找出所有 TODO 并归类', '跑一遍测试，修掉失败用例'].map(
                  (sample) => (
                    <button
                      key={sample}
                      className="chip"
                      onClick={() => void actions.send(sample)}
                      style={{ cursor: 'pointer' }}
                    >
                      {sample}
                    </button>
                  )
                )}
              </div>
            </div>
          )}

          {visible.map((row) => renderRow(row))}

          {todos.length > 0 && (
            <div className="todos">
              <div className="msg-head" style={{ marginBottom: 4 }}>
                <Icon name="list" size={13} />
                <span className="who">任务清单</span>
                <span className="muted">
                  {todos.filter((todo) => todo.status === 'completed').length}/{todos.length}
                </span>
              </div>
              {todos.map((todo) => (
                <div key={todo.id} className={`todo-row ${todo.status}`}>
                  <span className="box">
                    {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '•' : ''}
                  </span>
                  <span className="text">{todo.content}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {activeApprovals.map((request) => {
          // 属于某个审批分组时，一次授权覆盖整组（否则用户点了「总是允许 edit_file」，
          // 下一句 write_file 还会再问一次，看起来像设置没生效）
          const group = approvalGroupForTool(request.call.name)
          return (
            <div key={request.id} className="approval-card">
              <div className="approval-head">
                <Icon name="alert" size={15} />
                需要你确认：{toolLabel(request.call.name)}
              </div>
              <div className="dim" style={{ fontSize: '0.9em', marginTop: 4 }}>
                {request.reason || '该操作会修改工作区或执行外部命令'}
              </div>
              <pre>{JSON.stringify(request.call.args, null, 2)}</pre>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" onClick={() => void actions.answerApproval(request.id, true)}>
                  <Icon name="check" size={14} /> 允许
                </button>
                <button
                  className="btn"
                  onClick={() => void actions.answerApproval(request.id, true, true)}
                  title={
                    group
                      ? `允许，并把「${group.label}」整类加入自动批准：${group.tools.join(' / ')}`
                      : `允许，并把 ${request.call.name} 加入自动批准列表`
                  }
                >
                  总是允许{group ? group.label : ` ${request.call.name}`}
                </button>
                <div className="spacer" />
                <button className="btn danger" onClick={() => void actions.answerApproval(request.id, false)}>
                  <Icon name="x" size={14} /> 拒绝
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <Composer />
    </section>
  )
}
