import { actions, useApp } from '../state/store'
import { Icon } from './Icon'

export function TitleBar() {
  const { projects, projectPath, settings, panelOpen, sidebarOpen } = useApp()

  const toggleTheme = (): void => {
    if (!settings) return
    const isDark = document.documentElement.dataset.theme !== 'light'
    void actions.updateSettings({ theme: isDark ? 'light' : 'dark' })
  }

  return (
    <header className="titlebar">
      <button className="icon-btn no-drag" title="折叠/展开侧栏" onClick={() => actions.toggleSidebar()}>
        <Icon name="sidebar" />
      </button>
      <div className="brand no-drag">
        <span className="brand-mark">π</span>
        <span>Code Harness</span>
      </div>

      <div className="project-picker no-drag">
        <Icon name="folder" size={14} />
        <select
          value={projectPath ?? ''}
          onChange={(event) => void actions.selectProject(event.target.value || null)}
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            maxWidth: 260,
            color: 'inherit'
          }}
        >
          <option value="">（无项目 · 仅对话）</option>
          {projects.map((project) => (
            <option key={project.id} value={project.path}>
              {project.name}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="添加项目目录" onClick={() => void actions.pickAndAddProject()}>
          <Icon name="plus" size={14} />
        </button>
      </div>

      <button className="search-trigger no-drag" onClick={() => actions.setPaletteOpen(true)}>
        <Icon name="search" size={14} />
        <span>搜索会话 / 执行命令</span>
        <div className="spacer" />
        <kbd>Ctrl K</kbd>
      </button>

      <div className="spacer" />

      <button
        className="chip accent no-drag"
        title="当前模型（点击打开设置）"
        onClick={() => actions.setSettingsOpen(true)}
      >
        <Icon name="sparkle" size={12} />
        {settings?.activeModel || '未配置模型'}
      </button>

      <button className="icon-btn no-drag" title="切换主题" onClick={toggleTheme}>
        <Icon name={document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun'} />
      </button>
      <button
        className={`icon-btn no-drag ${panelOpen ? 'active' : ''}`}
        title="折叠/展开右侧面板"
        onClick={() => actions.togglePanel()}
      >
        <Icon name="panel" />
      </button>
      <button className="icon-btn no-drag" title="设置" onClick={() => actions.setSettingsOpen(true)}>
        <Icon name="settings" />
      </button>
    </header>
  )
}
