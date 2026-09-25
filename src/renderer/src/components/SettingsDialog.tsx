import { useEffect, useState } from 'react'
import {
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  clampMaxTokens,
  type AppSettings,
  type AutoLaunchState,
  type ProviderConfig,
  type ProviderKind,
  type SkillRecord
} from '@shared/types'
import { PROVIDER_PRESETS, providerFromPreset, type ProviderPreset } from '@shared/presets'
import { TOOL_APPROVAL_GROUPS, groupApprovalState, toggleApprovalGroup } from '@shared/tool-groups'
import { actions, useApp } from '../state/store'
import { baseName } from '../lib/format'
import { Icon } from './Icon'

type Tab = 'model' | 'appearance' | 'permission' | 'skills' | 'about'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'model', label: '模型' },
  { id: 'appearance', label: '外观' },
  { id: 'permission', label: '权限' },
  { id: 'skills', label: '技能' },
  { id: 'about', label: '关于' }
]

const KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'openai-compatible': 'OpenAI 兼容（自建/网关）'
}

function newProvider(): ProviderConfig {
  return {
    id: crypto.randomUUID(),
    name: '新 Provider',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: []
  }
}

export function SettingsDialog() {
  const { settingsOpen, settings, appInfo, projectPath } = useApp()
  const [tab, setTab] = useState<Tab>('model')
  const [draft, setDraft] = useState<AppSettings | null>(settings)
  const [skillList, setSkillList] = useState<SkillRecord[]>([])
  const [skillDraft, setSkillDraft] = useState({ name: '', description: '', body: '', scope: 'project' as 'project' | 'user' })
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [autoLaunch, setAutoLaunchState] = useState<AutoLaunchState | null>(null)

  useEffect(() => {
    if (settingsOpen) setDraft(settings)
  }, [settingsOpen, settings])

  // 开机启动以系统登录项为准（不在 settings.json 里另存），所以每次打开都现读一次
  useEffect(() => {
    if (!settingsOpen) return
    void window.pi.app
      .getAutoLaunch()
      .then(setAutoLaunchState)
      .catch(() => setAutoLaunchState(null))
  }, [settingsOpen])

  useEffect(() => {
    if (settingsOpen && tab === 'skills') void window.pi.skills.list(projectPath).then(setSkillList)
  }, [settingsOpen, tab, projectPath])

  if (!settingsOpen || !draft) return null

  const patch = (change: Partial<AppSettings>): void => setDraft({ ...draft, ...change })

  /** 从预置添加：同 Base URL 视为同一个 Provider，避免重复堆叠。 */
  const addPreset = (preset: ProviderPreset): void => {
    const existing = draft.providers.find((provider) => provider.baseUrl === preset.baseUrl)
    if (existing) {
      patch({
        activeProviderId: existing.id,
        activeModel: draft.activeModel || existing.models[0] || ''
      })
      actions.toast('info', `${preset.label} 已在列表中，已切换为当前 Provider`)
      return
    }

    const provider = providerFromPreset(preset)
    const useAsActive = !draft.activeProviderId || draft.providers.length === 0
    patch({
      providers: [...draft.providers, provider],
      ...(useAsActive ? { activeProviderId: provider.id, activeModel: provider.models[0] ?? '' } : {})
    })
    actions.toast('ok', `已添加 ${preset.label}，填入 API Key 后点「测试」`)
  }

  const patchProvider = (id: string, change: Partial<ProviderConfig>): void =>
    patch({ providers: draft.providers.map((provider) => (provider.id === id ? { ...provider, ...change } : provider)) })

  const save = async (): Promise<void> => {
    await actions.saveSettings(draft)
    actions.toast('ok', '设置已保存')
    actions.setSettingsOpen(false)
  }

  const activeProvider = draft.providers.find((provider) => provider.id === draft.activeProviderId)

  const autoLaunchHint = ((): string => {
    if (!autoLaunch) return '正在读取系统登录项…'
    if (!autoLaunch.supported) return '当前平台不支持开机启动（Linux 下 Electron 未提供登录项 API）。'
    if (autoLaunch.command) return `已注册命令：${autoLaunch.command}`
    return appInfo?.isPackaged
      ? '尚未注册。勾选后写入系统登录项；你在系统「设置 → 启动应用」里的改动会被如实读取，不会被应用改回来。'
      : '尚未注册。开发态注册的是 node_modules 里的 Electron + 本项目目录，开机后启动的是已构建产物（out/）。'
  })()

  return (
    <div className="overlay" onClick={() => actions.setSettingsOpen(false)}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <Icon name="settings" size={16} />
          <span className="title">设置</span>
          <div className="spacer" />
          <button className="icon-btn" onClick={() => actions.setSettingsOpen(false)}>
            <Icon name="x" />
          </button>
        </div>

        <div className="dialog-body">
          <div className="tabs">
            {TABS.map((item) => (
              <button key={item.id} className={`tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
                {item.label}
              </button>
            ))}
          </div>

          {tab === 'model' && (
            <div className="settings-grid">
              <div className="row" style={{ gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>当前 Provider</label>
                  <select
                    value={draft.activeProviderId}
                    onChange={(event) => {
                      const provider = draft.providers.find((item) => item.id === event.target.value)
                      patch({
                        activeProviderId: event.target.value,
                        activeModel: provider?.models[0] ?? ''
                      })
                    }}
                  >
                    <option value="">未选择</option>
                    {draft.providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>当前模型</label>
                  <input
                    className="input"
                    list="model-options"
                    value={draft.activeModel}
                    placeholder="例如 gpt-4o-mini / claude-sonnet-4"
                    onChange={(event) => patch({ activeModel: event.target.value })}
                  />
                  <datalist id="model-options">
                    {(activeProvider?.models ?? []).map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </div>
              </div>

              {draft.providers.map((provider) => (
                <div className="provider-card" key={provider.id}>
                  <div className="row">
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      value={provider.name}
                      onChange={(event) => patchProvider(provider.id, { name: event.target.value })}
                    />
                    <select
                      value={provider.kind}
                      onChange={(event) => patchProvider(provider.id, { kind: event.target.value as ProviderKind })}
                    >
                      {Object.entries(KIND_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn sm"
                      onClick={() =>
                        void window.pi.settings
                          .save(draft)
                          .then(() => window.pi.settings.testProvider(provider.id))
                          .then((status) =>
                            setTestResult((current) => ({
                              ...current,
                              [provider.id]: status.reachable
                                ? `连通（${status.detail ?? 'ok'}）`
                                : `不通：${status.detail ?? '未知错误'}`
                            }))
                          )
                      }
                    >
                      测试
                    </button>
                    <button
                      className="icon-btn"
                      title="删除"
                      onClick={() => patch({ providers: draft.providers.filter((item) => item.id !== provider.id) })}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>

                  <div className="provider-grid">
                    <div className="field">
                      <label>Base URL</label>
                      <input
                        className="input mono"
                        value={provider.baseUrl}
                        onChange={(event) => patchProvider(provider.id, { baseUrl: event.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label>API Key（本地加密存储）</label>
                      <input
                        className="input mono"
                        type="password"
                        value={provider.apiKey}
                        placeholder="sk-…"
                        onChange={(event) => patchProvider(provider.id, { apiKey: event.target.value })}
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label>可选模型（逗号分隔）</label>
                    <input
                      className="input mono"
                      value={provider.models.join(', ')}
                      placeholder="gpt-4o, gpt-4o-mini"
                      onChange={(event) =>
                        patchProvider(provider.id, {
                          models: event.target.value
                            .split(',')
                            .map((item) => item.trim())
                            .filter(Boolean)
                        })
                      }
                    />
                  </div>

                  {testResult[provider.id] && <div className="muted" style={{ fontSize: '0.85em' }}>{testResult[provider.id]}</div>}
                </div>
              ))}

              <div className="field">
                <label>从预置快速添加</label>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {PROVIDER_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      className="chip"
                      style={{ cursor: 'pointer' }}
                      title={[preset.baseUrl, preset.note].filter(Boolean).join('\n')}
                      onClick={() => addPreset(preset)}
                    >
                      <Icon name="plus" size={12} /> {preset.label}
                    </button>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: '0.82em' }}>
                  只预填 Base URL 与常用模型名，API Key 需要你自己粘贴（本地加密存储，不会进转录或日志）。
                </div>
              </div>

              <button className="btn" onClick={() => patch({ providers: [...draft.providers, newProvider()] })}>
                <Icon name="plus" size={14} /> 添加自定义 Provider
              </button>

              <div className="row" style={{ gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>温度 {draft.temperature}</label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.temperature}
                    onChange={(event) => patch({ temperature: Number(event.target.value) })}
                  />
                </div>
                <div className="field" style={{ width: 150 }}>
                  <label>最大输出 tokens</label>
                  <input
                    className="input"
                    type="number"
                    min={MIN_OUTPUT_TOKENS}
                    max={MAX_OUTPUT_TOKENS}
                    value={draft.maxTokens}
                    title={
                      `单次回复的输出上限（不是上下文窗口），允许范围 ${MIN_OUTPUT_TOKENS} ~ ${MAX_OUTPUT_TOKENS}。` +
                      '填超过服务端限制会让每次请求都 400 —— 例如 DeepSeek 系只到 8192。'
                    }
                    onChange={(event) => patch({ maxTokens: clampMaxTokens(Number(event.target.value)) })}
                  />
                </div>
                <div className="field" style={{ width: 160 }}>
                  <label>推理强度</label>
                  <select
                    value={draft.reasoningEffort}
                    onChange={(event) => patch({ reasoningEffort: event.target.value as AppSettings['reasoningEffort'] })}
                  >
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <label>追加系统提示词（项目约定、禁忌）</label>
                <textarea
                  value={draft.systemPromptExtra}
                  placeholder="例如：仓库使用 pnpm；禁止直接改 generated/ 下的文件"
                  onChange={(event) => patch({ systemPromptExtra: event.target.value })}
                />
              </div>

              <div className="field">
                <label>本地决策引擎（laya）仓库路径</label>
                <input
                  className="input"
                  value={draft.layaRepoPath}
                  placeholder="含 mcp/laya_mcp.py 的那层目录；留空则在项目内及同级目录自动探测"
                  title={
                    '配置后，智能体可以调用本地离线决策引擎做独立判断：' +
                    '命令危不危险（laya_gate）、改动算不算做完（laya_review）、' +
                    '外部内容有没有注入（laya_guard）。不配置则该能力不可用。'
                  }
                  onChange={(event) => patch({ layaRepoPath: event.target.value })}
                />
              </div>
            </div>
          )}

          {tab === 'appearance' && (
            <div className="settings-grid">
              <div className="field">
                <label>主题</label>
                <select value={draft.theme} onChange={(event) => patch({ theme: event.target.value as AppSettings['theme'] })}>
                  <option value="system">跟随系统</option>
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                </select>
              </div>
              <div className="field">
                <label>界面字号 {draft.fontSize}px</label>
                <input
                  type="range"
                  min={12}
                  max={18}
                  value={draft.fontSize}
                  onChange={(event) => patch({ fontSize: Number(event.target.value) })}
                />
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={draft.reduceMotion}
                  onChange={(event) => patch({ reduceMotion: event.target.checked })}
                />
                减少动效
              </label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={draft.allowExternalLinks}
                  onChange={(event) => patch({ allowExternalLinks: event.target.checked })}
                />
                允许打开外部链接（交给系统浏览器）
              </label>
            </div>
          )}

          {tab === 'permission' && (
            <div className="settings-grid">
              <div className="field">
                <label>审批策略</label>
                <select
                  value={draft.permissionMode}
                  onChange={(event) => patch({ permissionMode: event.target.value as AppSettings['permissionMode'] })}
                >
                  <option value="ask">每次询问（推荐）</option>
                  <option value="auto">自动批准写操作（只读仍放行）</option>
                  <option value="readonly">只读模式（禁止一切写操作）</option>
                </select>
              </div>
              <div className="field">
                <label>总是允许（按类别一键授权）</label>
                <div className="settings-grid" style={{ gap: 4 }}>
                  {TOOL_APPROVAL_GROUPS.map((group) => {
                    const state = groupApprovalState(group, draft.autoApproveTools)
                    return (
                      <label key={group.id} className="switch" title={group.hint}>
                        <input
                          type="checkbox"
                          checked={state === 'all'}
                          onChange={(event) =>
                            patch({
                              autoApproveTools: toggleApprovalGroup(
                                group,
                                draft.autoApproveTools,
                                event.target.checked
                              )
                            })
                          }
                        />
                        总是允许{group.label}
                        {state === 'partial' && <span className="muted">（部分）</span>}
                      </label>
                    )
                  })}
                </div>
                <div className="muted" style={{ fontSize: '0.82em', lineHeight: 1.6 }}>
                  勾选后这一类操作不再逐个弹确认。只读工具（读文件 / 搜索 / 查看 diff）本来就不需要确认。
                  执行命令的权限等同于你自己在终端里操作，请谨慎开启。
                </div>
              </div>
              <div className="field">
                <label>自动批准的工具（高级：直接编辑白名单，每行一个）</label>
                <textarea
                  value={draft.autoApproveTools.join('\n')}
                  placeholder="write_file"
                  onChange={(event) =>
                    patch({
                      autoApproveTools: event.target.value
                        .split('\n')
                        .map((item) => item.trim())
                        .filter(Boolean)
                    })
                  }
                />
              </div>
              <div className="row" style={{ gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>单轮最大工具步数（防失控）</label>
                  <input
                    className="input"
                    type="number"
                    min={4}
                    max={200}
                    value={draft.maxStepsPerTurn}
                    onChange={(event) => patch({ maxStepsPerTurn: Number(event.target.value) || 40 })}
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>上下文压缩</label>
                  <select
                    value={draft.contextCompaction}
                    onChange={(event) =>
                      patch({ contextCompaction: event.target.value as AppSettings['contextCompaction'] })
                    }
                  >
                    <option value="auto">自动（超出预算时把旧历史折叠为摘要）</option>
                    <option value="off">关闭</option>
                  </select>
                </div>
              </div>
              <label
                className="switch"
                title="按上游 pi 的惯例加载 AGENTS.md / CLAUDE.md：全局 → 项目父目录链 → 项目根；同目录内 AGENTS.override.md 优先"
              >
                <input
                  type="checkbox"
                  checked={draft.contextFiles}
                  onChange={(event) => patch({ contextFiles: event.target.checked })}
                />
                加载上下文文件（AGENTS.md / CLAUDE.md）
              </label>
            </div>
          )}

          {tab === 'skills' && (
            <div className="settings-grid">
              <div className="muted" style={{ fontSize: '0.86em' }}>
                技能是一段可复用的操作手册，Agent 在需要时会读取对应文件。项目技能随仓库走，全局技能对所有项目生效。
              </div>

              {skillList.length === 0 && <div className="empty">还没有技能</div>}

              {skillList.map((skill) => (
                <div className="provider-card" key={`${skill.scope}-${skill.id}`}>
                  <div className="row">
                    <span className="chip">{skill.scope === 'project' ? '项目' : '全局'}</span>
                    <strong style={{ flex: 1 }}>{skill.name}</strong>
                    {skill.editable ? (
                      <>
                        <button
                          className={`btn sm ${skill.enabled ? '' : 'ghost'}`}
                          onClick={() =>
                            void window.pi.skills
                              .toggle({ scope: skill.scope, projectPath, id: skill.id, enabled: !skill.enabled })
                              .then(() => window.pi.skills.list(projectPath))
                              .then(setSkillList)
                          }
                        >
                          {skill.enabled ? '已启用' : '已停用'}
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() =>
                            void window.pi.skills
                              .remove({ scope: skill.scope, projectPath, id: skill.id })
                              .then(() => window.pi.skills.list(projectPath))
                              .then(setSkillList)
                          }
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </>
                    ) : (
                      <span
                        className="chip"
                        title={
                          '来自跨工具约定目录（只读来源，本应用不改写这些文件）：' +
                          skill.path
                        }
                      >
                        {skill.origin === 'agents' ? '.agents' : '.pi'} 约定目录 · 只读
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: '0.85em' }}>{skill.description}</div>
                  <div className="muted mono truncate" style={{ fontSize: '0.78em' }}>{skill.path}</div>
                </div>
              ))}

              <div className="provider-card">
                <strong style={{ fontSize: '0.92em' }}>新建技能</strong>
                <div className="row">
                  <input
                    className="input"
                    placeholder="名称，例如 提交前检查清单"
                    value={skillDraft.name}
                    onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })}
                  />
                  <select
                    value={skillDraft.scope}
                    onChange={(event) => setSkillDraft({ ...skillDraft, scope: event.target.value as 'project' | 'user' })}
                  >
                    <option value="project">项目</option>
                    <option value="user">全局</option>
                  </select>
                </div>
                <input
                  className="input"
                  placeholder="一句话描述，Agent 靠它判断何时使用"
                  value={skillDraft.description}
                  onChange={(event) => setSkillDraft({ ...skillDraft, description: event.target.value })}
                />
                <textarea
                  rows={5}
                  placeholder="正文：步骤、命令、注意事项"
                  value={skillDraft.body}
                  onChange={(event) => setSkillDraft({ ...skillDraft, body: event.target.value })}
                />
                <button
                  className="btn primary"
                  disabled={!skillDraft.name.trim() || !skillDraft.description.trim()}
                  onClick={() =>
                    void window.pi.skills
                      .save({
                        scope: skillDraft.scope,
                        projectPath,
                        name: skillDraft.name.trim(),
                        description: skillDraft.description.trim(),
                        body: skillDraft.body
                      })
                      .then(() => window.pi.skills.list(projectPath))
                      .then((list) => {
                        setSkillList(list)
                        setSkillDraft({ name: '', description: '', body: '', scope: 'project' })
                      })
                  }
                >
                  <Icon name="check" size={14} /> 保存技能
                </button>
              </div>
            </div>
          )}

          {tab === 'about' && (
            <div className="settings-grid">
              <div className="provider-card">
                <div className="row">
                  <span className="brand-mark">π</span>
                  <strong>Code Harness</strong>
                  <span className="chip">v{appInfo?.version}</span>
                </div>
                <div className="muted" style={{ fontSize: '0.86em', lineHeight: 1.7 }}>
                  桌面版开发 Agent：Electron 外壳 + 常驻运行时（会话 / 审批 / 子智能体 / 定时任务 / 持续 Harness）。
                  架构参考 PrimeIntellect 的 prime-agent（运行时与工具循环）与 gooey-pi（桌面工作区形态）。
                </div>
                <div className="card-meta">
                  <span className="chip mono">Electron {appInfo?.electron}</span>
                  <span className="chip mono">Node {appInfo?.node}</span>
                  <span className="chip mono">Chromium {appInfo?.chrome}</span>
                  <span className="chip mono">{appInfo?.platform}</span>
                </div>
              </div>
              <div className="field">
                <label>数据目录（会话、设置、技能）</label>
                <div className="row">
                  <input className="input mono" readOnly value={appInfo?.userDataPath ?? ''} />
                  <button
                    className="btn sm"
                    onClick={() => appInfo && void window.pi.app.revealPath(appInfo.userDataPath)}
                  >
                    <Icon name="folder" size={13} /> 打开
                  </button>
                </div>
              </div>
              <div className="field">
                <label>开机启动</label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={autoLaunch?.enabled === true}
                    disabled={!autoLaunch?.supported}
                    onChange={(event) => {
                      const next = event.target.checked
                      void window.pi.app
                        .setAutoLaunch(next)
                        .then((state) => {
                          setAutoLaunchState(state)
                          actions.toast(
                            state.enabled === next ? 'ok' : 'warn',
                            state.enabled ? '已注册为开机启动' : '已取消开机启动'
                          )
                        })
                        .catch((error: unknown) =>
                          actions.toast('error', error instanceof Error ? error.message : String(error))
                        )
                    }}
                  />
                  登录系统后自动启动 Code Harness
                </label>
                <div className="muted" style={{ fontSize: '0.82em', lineHeight: 1.6 }}>
                  {autoLaunchHint}
                </div>
              </div>

              {projectPath && (
                <div className="muted" style={{ fontSize: '0.86em' }}>
                  当前项目：{baseName(projectPath)}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="dialog-foot">
          <button className="btn ghost" onClick={() => actions.setSettingsOpen(false)}>
            取消
          </button>
          <button className="btn primary" onClick={() => void save()}>
            <Icon name="check" size={14} /> 保存
          </button>
        </div>
      </div>
    </div>
  )
}
