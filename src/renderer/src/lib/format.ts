import type { ToolCall } from '@shared/types'

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 09-14 */
export function relTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 45_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(timestamp)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function shortPath(path: string, max = 34): string {
  if (path.length <= max) return path
  return `…${path.slice(path.length - max + 1)}`
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function bytes(size?: number): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** 工具调用的单行摘要，用于活动卡片与命令面板。 */
export function summarizeToolCall(call: ToolCall): string {
  const args = call.args ?? {}
  const pick = (key: string): string => {
    const value = args[key]
    return typeof value === 'string' ? value : ''
  }
  switch (call.name) {
    case 'read_file':
    case 'write_file':
      return pick('path')
    case 'edit_file':
    case 'multi_edit':
      return pick('path')
    case 'list_dir':
      return pick('path') || '.'
    case 'grep':
    case 'search_files':
      return pick('pattern') + (pick('path') ? ` · ${pick('path')}` : '')
    case 'run_command':
      return pick('command')
    case 'git_commit':
      return pick('message')
    case 'task':
      return pick('prompt').slice(0, 60)
    case 'ocr_review': {
      const mode = pick('mode') || 'workspace'
      const scope = pick('from') ? `${pick('from')}→${pick('to')}` : pick('commit')
      return [mode, scope, pick('requirement') ? `需求：${pick('requirement')}` : ''].filter(Boolean).join(' · ')
    }
    case 'install_skill_pack':
      return pick('pack') || '列出技能包'
    case 'todo_write':
      return '更新任务清单'
    case 'set_goal':
      return pick('goal').slice(0, 60)
    case 'add_memory':
    case 'remember':
      return pick('text').slice(0, 60)
    case 'add_refinement':
      return pick('text').slice(0, 60)
    default: {
      const first = Object.values(args).find((value) => typeof value === 'string')
      return typeof first === 'string' ? first.slice(0, 80) : ''
    }
  }
}

export function toolLabel(name: string): string {
  const map: Record<string, string> = {
    read_file: '读取文件',
    write_file: '写入文件',
    edit_file: '编辑文件',
    multi_edit: '批量编辑',
    list_dir: '列目录',
    grep: '内容检索',
    search_files: '文件检索',
    run_command: '执行命令',
    git_status: 'Git 状态',
    git_diff: 'Git 差异',
    git_commit: 'Git 提交',
    task: '派生子智能体',
    todo_write: '更新待办',
    review_changes: '生产就绪审查',
    ocr_review: 'OCR 委派审查',
    install_skill_pack: '安装技能包',
    set_goal: '设定目标',
    add_memory: '写入记忆',
    add_refinement: '沉淀经验',
    remember: '写入记忆',
    web_fetch: '抓取网页',
    web_search: '联网搜索'
  }
  return map[name] ?? name
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    idle: '空闲',
    thinking: '思考中',
    streaming: '输出中',
    tool: '执行工具',
    'waiting-approval': '等待审批',
    aborted: '已中止',
    error: '出错'
  }
  return map[status] ?? status
}
