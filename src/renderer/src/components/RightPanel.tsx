import { useApp } from '../state/store'
import type { RightTab } from '../state/store'
import { Icon, type IconName } from './Icon'
import { ChangesPanel } from './ChangesPanel'
import { FilesPanel } from './FilesPanel'
import { HarnessPanel } from './HarnessPanel'
import { TasksPanel } from './TasksPanel'
import { TerminalPanel } from './TerminalPanel'
import { actions } from '../state/store'

const TABS: Array<{ id: RightTab; label: string; icon: IconName }> = [
  { id: 'files', label: '文件', icon: 'file' },
  { id: 'changes', label: '变更', icon: 'git' },
  { id: 'terminal', label: '终端', icon: 'terminal' },
  { id: 'tasks', label: '定时', icon: 'clock' },
  { id: 'harness', label: 'Harness', icon: 'brain' }
]

export function RightPanel() {
  const { rightTab } = useApp()
  // 折叠时不卸载：宽度由 .workspace.panel-collapsed 置 0，
  // 这样终端缓冲、文件树展开状态、滚动位置都不会因为折叠而丢失。

  return (
    <aside className="right-panel">
      <div className="panel-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`panel-tab ${rightTab === tab.id ? 'active' : ''}`}
            onClick={() => actions.setRightTab(tab.id)}
          >
            <Icon name={tab.icon} size={14} />
            {tab.label}
          </button>
        ))}
      </div>
      <div className="panel-body" style={rightTab === 'terminal' ? { overflow: 'hidden' } : undefined}>
        {rightTab === 'files' && <FilesPanel />}
        {rightTab === 'changes' && <ChangesPanel />}
        {rightTab === 'terminal' && <TerminalPanel />}
        {rightTab === 'tasks' && <TasksPanel />}
        {rightTab === 'harness' && <HarnessPanel />}
      </div>
    </aside>
  )
}
