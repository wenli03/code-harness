import { useCallback, useEffect, useState } from 'react'
import type { FileNode, FileReadResult } from '@shared/types'
import { actions, useApp } from '../state/store'
import { bytes } from '../lib/format'
import { Icon, type IconName } from './Icon'

export function FilesPanel() {
  const { projectPath } = useApp()
  const [tree, setTree] = useState<FileNode | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<FileReadResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!projectPath) {
      setTree(null)
      return
    }
    setLoading(true)
    try {
      setTree(await window.pi.files.tree(projectPath))
    } catch (error) {
      actions.toast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    setSelected(null)
    setFile(null)
    setExpanded(new Set())
    void load()
  }, [load])

  const openFile = async (node: FileNode): Promise<void> => {
    if (!projectPath) return
    setSelected(node.path)
    try {
      setFile(await window.pi.files.read(projectPath, node.path))
    } catch (error) {
      actions.toast('error', error instanceof Error ? error.message : String(error))
    }
  }

  if (!projectPath) {
    return (
      <div className="empty" style={{ paddingTop: 60 }}>
        <Icon name="folder" size={22} />
        <div style={{ fontSize: '0.9em' }}>先选择一个项目目录</div>
      </div>
    )
  }

  return (
    <div className="col" style={{ height: '100%', minHeight: 0 }}>
      <div className="panel-toolbar">
        <button className="icon-btn" title="刷新" onClick={() => void load()}>
          <Icon name="refresh" size={14} />
        </button>
        {loading && <span className="spin" />}
        <div className="spacer" />
        <button
          className="btn ghost sm"
          onClick={() => void window.pi.app.revealPath(projectPath)}
          title="在文件管理器中打开"
        >
          <Icon name="folder" size={13} /> 打开目录
        </button>
      </div>

      <div className="tree" style={{ flex: file ? '0 0 42%' : 1, overflow: 'auto', borderBottom: file ? '1px solid var(--border)' : undefined }}>
        {tree?.children?.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            selected={selected}
            onToggle={(path) =>
              setExpanded((current) => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }
            onOpen={(target) => void openFile(target)}
          />
        ))}
        {tree && !tree.children?.length && <div className="empty">目录为空</div>}
      </div>

      {file && (
        <div className="col" style={{ flex: 1, minHeight: 0 }}>
          <div className="panel-toolbar">
            <Icon name="file" size={13} />
            <span className="truncate mono" style={{ fontSize: '0.85em' }}>
              {file.path}
            </span>
            <div className="spacer" />
            <span className="muted" style={{ fontSize: '0.8em' }}>{file.lines} 行</span>
            <button className="icon-btn" title="关闭" onClick={() => setFile(null)}>
              <Icon name="x" size={13} />
            </button>
          </div>
          <pre className="code-view" style={{ flex: 1, minHeight: 0 }}>
            {file.content.split('\n').map((line, index) => (
              <div className="code-line" key={index}>
                <span className="ln">{index + 1}</span>
                <span>{line || ' '}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}

function TreeNode({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onOpen
}: {
  node: FileNode
  depth: number
  expanded: Set<string>
  selected: string | null
  onToggle: (path: string) => void
  onOpen: (node: FileNode) => void
}) {
  const isDir = node.type === 'directory'
  const open = expanded.has(node.path)

  const glyph: IconName = isDir ? 'folder' : 'file'

  return (
    <>
      <div
        className={`tree-row ${selected === node.path ? 'selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 13 }}
        title={node.path}
        onClick={() => (isDir ? onToggle(node.path) : onOpen(node))}
      >
        {isDir ? (
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="glyph" />
        ) : (
          <span className="glyph" />
        )}
        <Icon name={glyph} size={13} className="glyph" />
        <span className="truncate">{node.name}</span>
        {!isDir && node.size !== undefined && <span className="size">{bytes(node.size)}</span>}
      </div>
      {isDir && open && node.children?.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          selected={selected}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}
    </>
  )
}
