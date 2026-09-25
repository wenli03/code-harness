import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { Attachment } from '@shared/types'
import { actions, fileToAttachment, useApp } from '../state/store'
import { Icon } from './Icon'

const RUNNING = new Set(['thinking', 'streaming', 'tool', 'waiting-approval'])

export function Composer() {
  const { status, sessionId, projectPath } = useApp()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const running = RUNNING.has(status)

  // 自动增高
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, 260)}px`
  }, [text])

  // 切换会话时清空草稿
  useEffect(() => {
    setText('')
    setAttachments([])
  }, [sessionId])

  const submit = (): void => {
    if (running) {
      // 运行中只支持插话文本：空内容不要清掉草稿，附件也留到本轮结束后再发
      const trimmed = text.trim()
      if (!trimmed) return
      void actions.steer(trimmed)
      setText('')
      return
    }
    if (!text.trim() && !attachments.length) return
    void actions.send(text, attachments)
    setText('')
    setAttachments([])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const next: Attachment[] = []
    for (const file of Array.from(files)) {
      const attachment = await fileToAttachment(file)
      if (attachment) next.push(attachment)
      else actions.toast('warn', `已跳过过大或不可读的附件：${file.name}`)
    }
    if (next.length) setAttachments((current) => [...current, ...next])
  }

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files)
    if (files.length) {
      event.preventDefault()
      void addFiles(files)
    }
  }

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files?.length) void addFiles(event.target.files)
    event.target.value = ''
  }

  return (
    <div className="composer">
      <div className="composer-inner">
        {attachments.length > 0 && (
          <div className="attachments" style={{ marginBottom: 8 }}>
            {attachments.map((attachment, index) => (
              <span key={index} className="chip accent">
                <Icon name={attachment.dataUrl ? 'sparkle' : 'file'} size={12} />
                {attachment.name}
                <button
                  className="icon-btn"
                  style={{ width: 16, height: 16 }}
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="composer-box">
          <textarea
            ref={areaRef}
            rows={2}
            value={text}
            placeholder={
              running
                ? '正在执行… 输入内容后按 Enter 可插话，Agent 会在下一步采纳'
                : projectPath
                  ? '描述任务，例如：修复 utils/date.ts 的时区偏移，并补上单测'
                  : '描述任务；建议先在上方选择一个项目目录'
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div className="composer-tools">
            <button className="icon-btn" title="添加附件（图片 / 文本）" onClick={() => fileRef.current?.click()}>
              <Icon name="plus" />
            </button>
            <input ref={fileRef} type="file" multiple hidden onChange={onPickFiles} />
            <div className="spacer" />
            {running ? (
              <>
                <button className="btn" onClick={() => void actions.abort()}>
                  <Icon name="stop" size={14} /> 中止
                </button>
                <button className="btn primary" onClick={submit}>
                  <Icon name="send" size={14} /> 插话
                </button>
              </>
            ) : (
              <button className="btn primary" disabled={!text.trim() && !attachments.length} onClick={submit}>
                <Icon name="send" size={14} /> 发送
              </button>
            )}
          </div>
        </div>

        <div className="composer-hint">
          <span>Enter 发送 · Shift+Enter 换行 · 可粘贴截图</span>
          <div className="spacer" />
          <span>所有文件改动都会在右侧「变更」中可见</span>
        </div>
      </div>
    </div>
  )
}
