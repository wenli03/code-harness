import { promises as fs } from 'node:fs'
import { execCommand } from '../../util/exec'
import { runGit } from '../../util/git'
import { asOptionalString } from './args'
import { collectBudgetedDiffs } from './diff-budget'
import { requireProjectPath, resolveInsideProject } from './paths'
import type { ToolDefinition } from './types'
import { toolError, toolOk } from './types'

/**
 * ocr_review：把 `alibaba/open-code-review`（ocr）的**委派模式**接进 code-harness。
 *
 * 委派模式的职责划分正是我们要的：ocr 只做**确定性工程**（按扩展名/体积/排除规则选出该审哪些文件、
 * 按源码解析出每个文件适用的规则组），**一切 LLM 推理留给宿主**——这里就是 code-harness 的
 * 只读审查子会话。好处有两个：不必再为 OCR 单独配一份模型和 API Key；
 * 而"该审什么、按什么规则审"不再靠模型自由发挥，是确定性的。
 *
 * 与 `review_changes` 的分工：那个走 code-harness 自研的生产就绪清单；这个走 ocr 沉淀的规则集。
 * 两者互补，不是替代关系。
 */

const VERSION_TIMEOUT = 20_000
const PREVIEW_TIMEOUT = 120_000
const RULE_TIMEOUT = 180_000
/** 规则解析按批取：命令行长度与单次调用耗时要可控。 */
const RULE_BATCH_FILES = 40
const RULE_BATCH_CHARS = 3_000
/** 未跟踪文件没有 diff，退化为读全文，但要防一个大文件把上下文打爆。 */
const UNTRACKED_READ_LIMIT = 60_000
/** `-b` 走命令行，超长会撞到 Windows 的命令行长度上限。 */
const BACKGROUND_LIMIT = 2_000
/** 展开 diff 的文件数上限（总预算由 diff-budget 控制）。 */
const MAX_DIFF_FILES = 60
/**
 * 规则组预算。规则是 ocr 的核心产出，但**按语言各一份**（实测单份约 2KB）：
 * 多语言仓库能堆出几十 KB 规则文本，全量塞进审查子会话会把它的上下文推高到触发压缩。
 * 超预算时截断到单组上限并如实报出被截断的组，而不是静默丢弃。
 */
const RULE_TOTAL_BUDGET = 40_000
const RULE_PER_GROUP_BUDGET = 8_000

/**
 * shell 参数白名单。路径来自**被测仓库的文件名**，是不可信输入：
 * 一旦拼进 `shell: true` 的命令串，`& | > " \`` 之类字符就能逃逸出参数位置。
 * 所以白名单之外的路径不执行、直接记为 skipped（而不是"尽力转义"）。
 */
const UNSAFE_PATH_CHARS = /["'`;&|<>^%!$(){}[\]\r\n\t]/

function isSafePath(path: string): boolean {
  return path.length > 0 && !UNSAFE_PATH_CHARS.test(path)
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_\-./=:@+,#~]+$/.test(value)) return value
  return `"${value}"`
}

interface OcrPreviewFile {
  path: string
  status?: string
  insertions?: number
  deletions?: number
  exclude_reason?: string
}

interface OcrPreview {
  schema_version?: string
  mode?: string
  repository?: string
  from?: string
  to?: string
  commit?: string
  merge_base?: string
  background?: string
  total_files?: number
  reviewable_count?: number
  excluded_count?: number
  total_insertions?: number
  total_deletions?: number
  reviewable_files?: OcrPreviewFile[]
  excluded_files?: OcrPreviewFile[]
}

interface OcrRuleGroup {
  group_id?: number
  source?: string
  pattern?: string
  files?: string[]
  rule?: string
}

interface OcrRules {
  schema_version?: string
  groups?: OcrRuleGroup[]
}

/**
 * 从输出里抠 JSON：ocr 的 `--format json` 只往 stdout 写一份 JSON，
 * 但 stdout 前面可能混有 shell 噪声（编码、警告），所以按首尾大括号截取而不是直接 parse。
 */
function parseJsonLoose<T>(raw: string): T | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

interface OcrRun {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

async function runOcr(
  projectPath: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<OcrRun> {
  const result = await execCommand(`ocr ${args.map(quoteArg).join(' ')}`, {
    cwd: projectPath,
    timeoutMs,
    signal,
    maxChars: 2 * 1024 * 1024
  })
  return {
    ok: result.code === 0 && !result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    timedOut: result.timedOut
  }
}

const INSTALL_HINT =
  '未找到可用的 `ocr` 命令。安装：npm install -g @alibaba-group/open-code-review（前置要求 Git ≥ 2.41）；也可用官方安装脚本或 GitHub Release 二进制。装好后重启本应用以刷新 PATH。'

/** 判读 ocr 调用的失败原因，把"版本过低/不在 git 仓库"这类可自纠的错误说清楚。 */
function describeOcrFailure(run: OcrRun, fallback: string): string {
  const detail = (run.stderr || run.stdout).trim().slice(0, 800)
  if (run.timedOut) return `ocr 调用超时（${fallback}）。大改动请缩小范围（mode=commit 或 --exclude）后重试。`
  if (/unknown flag:?\s*--format/i.test(detail)) {
    return `当前 ocr 版本不支持 --format json（需要 v1.9.0 及以上）。请升级：npm install -g @alibaba-group/open-code-review。升级前不要改用手工解析文本输出——文本格式没有稳定契约，容易把字段读错。`
  }
  if (/not a git repository|not a git work tree/i.test(detail)) {
    return '当前项目不是 git 仓库，ocr 依赖 git 生成 diff。请先初始化 git 或改用 review_changes。'
  }
  if (/no such file|不是内部或外部命令|is not recognized/i.test(detail)) return `${INSTALL_HINT}\n\n原始输出：${detail}`
  return `ocr ${fallback} 失败（退出码 ${run.code ?? 'null'}）：${detail || '(无输出)'}`
}

export const ocrReviewTool: ToolDefinition = {
  schema: {
    name: 'ocr_review',
    description:
      '规则驱动的代码审查（open-code-review 委派模式）：ocr 负责确定性文件筛选与规则解析，审查由本机模型的只读审查子会话完成，不需要额外的 API Key。会启动本地 ocr 进程、只读仓库，不修改任何文件。需要按语言/框架规则逐条核查改动、要行级定位与覆盖率账本时用；交付前与 review_changes 一起跑是合理的。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['workspace', 'range', 'commit'],
          description:
            '审查范围：workspace=工作区未提交改动（默认）；range=两个分支/引用之间的差异（需 from 与 to，内部按 merge-base 取）；commit=单个提交（需 commit）'
        },
        from: { type: 'string', description: 'range 模式的源引用，如 main' },
        to: { type: 'string', description: 'range 模式的目标引用，如 feature/login' },
        commit: { type: 'string', description: 'commit 模式的提交哈希' },
        requirement: {
          type: 'string',
          description: '强烈建议：本次改动对应的原始需求或业务上下文（作为 ocr 的 background 传给审查员，据它判断漏实现与未声明假设）'
        },
        focus: { type: 'string', description: '可选：额外关注点，如"重点看并发与失败重试、多租户隔离"' },
        exclude: { type: 'string', description: '可选：逗号分隔的排除模式，如 "docs/**,*.min.js,dist/**"' }
      },
      required: []
    },
    readOnly: true,
    // 会派生审查子会话：reviewer 自己不得持有（否则审查专员再派审查专员）
    reviewerExcluded: true
  },

  async run(args, ctx) {
    const projectPath = ctx.projectPath
    if (!projectPath) return toolError('未关联项目，无法审查改动。')

    const mode = asOptionalString(args, 'mode') ?? 'workspace'
    if (mode !== 'workspace' && mode !== 'range' && mode !== 'commit') {
      return toolError(`mode 只支持 workspace / range / commit，收到「${mode}」。`)
    }
    const from = asOptionalString(args, 'from')
    const to = asOptionalString(args, 'to')
    const commit = asOptionalString(args, 'commit')
    if (mode === 'range' && (!from || !to)) return toolError('range 模式需要同时提供 from 与 to。')
    if (mode === 'commit' && !commit) return toolError('commit 模式需要提供 commit。')
    const exclude = asOptionalString(args, 'exclude')

    let requirement = asOptionalString(args, 'requirement') ?? ''
    let requirementTruncated = false
    if (requirement.length > BACKGROUND_LIMIT) {
      requirement = requirement.slice(0, BACKGROUND_LIMIT)
      requirementTruncated = true
    }
    const focus = asOptionalString(args, 'focus')

    // 先探测 CLI：未安装 / 版本过低要在最开始就报清楚，而不是让后续步骤各报一个费解的错误
    const version = await runOcr(projectPath, ['--version'], VERSION_TIMEOUT, ctx.signal)
    if (!version.ok) return toolError(`${INSTALL_HINT}\n\n探测输出：${(version.stderr || version.stdout).trim().slice(0, 400)}`)
    const versionText = (version.stdout || version.stderr).trim().split('\n')[0]

    // ── 第 1 步：preview（ocr 的确定性文件筛选）
    ctx.log('info', `ocr 委派审查：解析 ${mode} 范围的可审查文件…`)
    const previewArgs = ['delegate', 'preview', '--format', 'json']
    if (mode === 'range') previewArgs.push('--from', from as string, '--to', to as string)
    if (mode === 'commit') previewArgs.push('-c', commit as string)
    if (exclude) previewArgs.push('--exclude', exclude)
    if (requirement) previewArgs.push('-b', requirement)

    const previewRun = await runOcr(projectPath, previewArgs, PREVIEW_TIMEOUT, ctx.signal)
    if (!previewRun.ok) return toolError(describeOcrFailure(previewRun, 'delegate preview'))
    const preview = parseJsonLoose<OcrPreview>(previewRun.stdout)
    if (!preview) {
      return toolError(`无法解析 ocr delegate preview 的 JSON 输出（前 400 字符）：${previewRun.stdout.slice(0, 400)}`)
    }
    if (preview.schema_version !== '1') {
      return toolError(
        `ocr 的委派模式输出契约版本为「${preview.schema_version ?? '未知'}」，本集成只认版本 1。请升级 code-harness 的 ocr 集成或回退 ocr 版本，不要按旧字段硬解析。`
      )
    }

    const reviewable = (preview.reviewable_files ?? []).filter((file) => typeof file?.path === 'string')
    const excluded = (preview.excluded_files ?? []).filter((file) => typeof file?.path === 'string')
    if (!reviewable.length) {
      return toolOk(
        `ocr 判定本次没有可审查的文件（共 ${preview.total_files ?? 0} 个变更全被排除）。\n${formatExcluded(excluded)}`
      )
    }

    // 路径来自被测仓库的文件名，是不可信输入：候选路径先过白名单，不安全的整条跳过并如实报出
    const skippedUnsafe = reviewable.filter((file) => !isSafePath(file.path))
    const safe = reviewable.filter((file) => isSafePath(file.path))

    // ── 第 2 步：rule（ocr 的确定性规则解析，按内容分组）
    ctx.log('info', `ocr 委派审查：解析 ${safe.length} 个文件的适用规则…`)
    const { groups, failures } = await fetchRuleGroups(projectPath, safe, ctx.signal)

    // ── 第 3 步：取 diff（带预算，超出按序截断并如实告知）
    const repoRoot = preview.repository?.trim() || projectPath
    const diffTargets = safe.slice(0, MAX_DIFF_FILES).map((file) => ({
      heading: `#### ${file.path} (${file.status ?? '?'}, +${file.insertions ?? 0}/-${file.deletions ?? 0})`,
      load: () => loadFileDiff(projectPath, repoRoot, file, { mode, from, to, commit, mergeBase: preview.merge_base }),
      onError: `(取 diff 失败：${file.path})`
    }))
    const { sections, omitted } = await collectBudgetedDiffs(
      diffTargets,
      '需要时用 git_diff / read_file 只读查看'
    )
    const notExpanded = omitted + Math.max(0, safe.length - MAX_DIFF_FILES)

    // ── 第 4 步：交给只读审查子会话（宿主自己的模型做审查，这正是委派模式的含义）
    const prompt = buildDelegationPrompt({
      versionText,
      mode,
      from,
      to,
      commit,
      mergeBase: preview.merge_base,
      requirement,
      requirementTruncated,
      focus,
      safe,
      skippedUnsafe,
      excluded,
      groups,
      ruleFailures: failures,
      diffs: sections,
      notExpanded
    })

    ctx.log('info', `ocr 委派审查：派生只读审查子会话（${safe.length} 个文件）…`)
    try {
      const report = await ctx.spawnSubAgent({
        prompt,
        title: `OCR 委派审查：${mode} ${safe.length} 个文件`,
        role: 'reviewer'
      })
      return toolOk(
        [
          `【ocr 委派审查报告】范围=${mode}，可审查 ${reviewable.length} 个文件（已排除 ${excluded.length} 个）`,
          report || '(审查子会话未返回内容)',
          skippedUnsafe.length ? `\n注意：${skippedUnsafe.length} 个文件因路径含不安全字符未参与审查：${skippedUnsafe.map((f) => f.path).join('、')}` : '',
          failures.length ? `\n规则解析失败的文件（未带规则审查）：${failures.join('、')}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      )
    } catch (error) {
      return toolError(`审查子会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 按批取规则组：一次几十个路径，避免命令行超长与单次调用过慢。 */
async function fetchRuleGroups(
  projectPath: string,
  files: OcrPreviewFile[],
  signal?: AbortSignal
): Promise<{ groups: OcrRuleGroup[]; failures: string[] }> {
  const batches: OcrPreviewFile[][] = []
  let current: OcrPreviewFile[] = []
  let chars = 0
  for (const file of files) {
    if (current.length >= RULE_BATCH_FILES || chars + file.path.length > RULE_BATCH_CHARS) {
      if (current.length) batches.push(current)
      current = []
      chars = 0
    }
    current.push(file)
    chars += file.path.length
  }
  if (current.length) batches.push(current)

  const groups: OcrRuleGroup[] = []
  const failures: string[] = []
  for (const batch of batches) {
    const run = await runOcr(
      projectPath,
      ['delegate', 'rule', '--format', 'json', ...batch.map((file) => file.path)],
      RULE_TIMEOUT,
      signal
    )
    if (!run.ok) {
      // 单批失败不放弃整轮审查：这些文件照审，但要在报告里说明"它们是裸审的"
      failures.push(...batch.map((file) => file.path))
      continue
    }
    const parsed = parseJsonLoose<OcrRules>(run.stdout)
    if (parsed?.groups?.length) groups.push(...parsed.groups)
    else failures.push(...batch.map((file) => file.path))
  }
  return { groups, failures }
}

interface DiffRefs {
  mode: string
  from?: string
  to?: string
  commit?: string
  mergeBase?: string
}

/**
 * 按模式取单个文件的 diff（对应上游 SKILL 的第 3 步）。
 * workspace 模式下未跟踪的新文件没有 diff，退化为读全文——整个文件都是新代码。
 */
async function loadFileDiff(
  projectPath: string,
  repoRoot: string,
  file: OcrPreviewFile,
  refs: DiffRefs
): Promise<string> {
  if (refs.mode === 'commit' && refs.commit) {
    const result = await runGit(repoRoot, ['show', '--no-color', refs.commit, '--', file.path])
    return result.ok ? result.out : result.err || '(git show 失败)'
  }
  if (refs.mode === 'range' && refs.to) {
    const range = `${refs.mergeBase || refs.from}..${refs.to}`
    const result = await runGit(repoRoot, ['diff', '--no-color', range, '--', file.path])
    return result.ok ? result.out : result.err || '(git diff 失败)'
  }

  const result = await runGit(repoRoot, ['diff', '--no-color', 'HEAD', '--', file.path])
  if (result.ok && result.out.trim()) return result.out
  if (!result.ok && result.err.trim()) return result.err

  // 未跟踪文件：直接读全文（沙箱边界同理，只读项目内的文件）
  try {
    const absolute = resolveInsideProject(projectPath, file.path)
    const raw = await fs.readFile(absolute, 'utf8')
    return raw.length > UNTRACKED_READ_LIMIT
      ? `${raw.slice(0, UNTRACKED_READ_LIMIT)}\n…(新增文件超长，已截断)`
      : raw
  } catch (error) {
    return `(未跟踪文件读取失败：${error instanceof Error ? error.message : String(error)})`
  }
}

/** 渲染规则组，按总预算与单组上限截断，返回被截断的组数。 */
function renderRuleGroups(groups: OcrRuleGroup[]): { text: string; truncated: number } {
  const parts: string[] = []
  let budget = RULE_TOTAL_BUDGET
  let truncated = 0

  for (const group of groups) {
    const header = [
      `#### Rule Group ${group.group_id ?? '?'}：${group.source ?? '未知来源'} / ${group.pattern ?? '-'}`,
      `适用文件：${(group.files ?? []).join('、') || '(未标注)'}`,
      ''
    ].join('\n')
    const rule = group.rule ?? '(规则内容为空)'
    if (budget <= header.length) {
      truncated += 1
      continue
    }
    const room = Math.min(budget - header.length, RULE_PER_GROUP_BUDGET)
    const body = rule.length > room ? `${rule.slice(0, room)}\n…(本组规则超长，已截断)` : rule
    if (body.length < rule.length) truncated += 1
    budget -= header.length + body.length
    parts.push(`${header}${body}`)
  }

  return { text: parts.join('\n\n---\n\n'), truncated }
}

function formatExcluded(excluded: OcrPreviewFile[]): string {
  if (!excluded.length) return ''
  const lines = excluded.slice(0, 30).map((file) => `- ${file.path}（排除原因：${file.exclude_reason ?? '未说明'}）`)
  const more = excluded.length > lines.length ? `\n…另有 ${excluded.length - lines.length} 个未列出` : ''
  return `已排除的文件：\n${lines.join('\n')}${more}`
}

function buildDelegationPrompt(input: {
  versionText: string
  mode: string
  from?: string
  to?: string
  commit?: string
  mergeBase?: string
  requirement: string
  requirementTruncated: boolean
  focus?: string
  safe: OcrPreviewFile[]
  skippedUnsafe: OcrPreviewFile[]
  excluded: OcrPreviewFile[]
  groups: OcrRuleGroup[]
  ruleFailures: string[]
  diffs: string[]
  notExpanded: number
}): string {
  const scope = [
    `模式：${input.mode}`,
    input.from ? `from：${input.from}` : '',
    input.to ? `to：${input.to}` : '',
    input.commit ? `commit：${input.commit}` : '',
    input.mergeBase ? `merge_base：${input.mergeBase}` : ''
  ]
    .filter(Boolean)
    .join('｜')

  const checklist = input.safe
    .map((file) => `- (${file.path}, ${file.status ?? '?'}) +${file.insertions ?? 0}/-${file.deletions ?? 0}`)
    .join('\n')

  const groups = input.groups.length
    ? renderRuleGroups(input.groups)
    : { text: '(本次没有解析出规则组，按通用生产就绪口径审查，并在报告中说明缺规则)', truncated: 0 }

  return [
    '## 委派代码审查任务（由 open-code-review 的确定性管线选定范围与规则）',
    `ocr CLI：${input.versionText}｜${scope}`,
    input.skippedUnsafe.length
      ? `### 未参与审查的文件（路径含不安全字符，工具侧已跳过）\n${input.skippedUnsafe.map((file) => `- ${file.path}`).join('\n')}`
      : '',
    `### 原始需求 / 业务上下文\n${input.requirement || '(未提供——此时做纯技术审查，并在报告中说明缺需求上下文)'}${input.requirementTruncated ? '\n（需求文本过长，已截断后传给 ocr）' : ''}`,
    `### 额外关注点\n${input.focus ?? '无'}`,
    `### 审查清单（这 ${input.safe.length} 个文件每个都要有结论）\n${checklist}`,
    formatExcluded(input.excluded) || '### 已排除文件\n(无)',
    input.ruleFailures.length
      ? `### 规则解析失败的文件（按通用口径审，并在报告中标注）\n${input.ruleFailures.join('、')}`
      : '',
    `### 适用规则组（来自 ocr delegate rule，按内容分组）\n${groups.text}${
      groups.truncated > 0
        ? `\n\n（因预算限制有 ${groups.truncated} 个规则组被截断；需要时用 run_command 单独执行 \`ocr delegate rule --format json <path>\` 查看）`
        : ''
    }`,
    `### 文件差异（带预算）\n${input.diffs.join('\n\n')}${
      input.notExpanded > 0
        ? `\n\n（另有 ${input.notExpanded} 个文件的 diff 未展开；用 git_diff / read_file 只读查看后一并审查）`
        : ''
    }`,
    [
      '### 交付要求',
      '1. **覆盖率**：清单里每个 (path, status) 条目必须落到 `reviewed` 或 `skipped`，skipped 必须写明具体理由；结尾给出 total_files / reviewed_files / skipped_files / coverage_rate。同一路径以不同 status 出现两次时视为两个条目。',
      '2. **行级定位**：每条问题必须带 `path:起始行-结束行`；diff 里看不到的事实写「diff 外，需人工确认」，禁止臆断。',
      '3. **标注分类与严重程度**：问题清单每行写成 `- [severity|category] path:start-end — 问题 — 修复建议`（severity 取 critical/high/medium/low，category 取 bug/security/performance/maintainability/test/style/documentation/other）。',
      '4. **分级口径**：critical/high（Bug、安全、数据丢失）一律报；medium 带上下文报；low 仅确有价值时报，其余丢弃——不要把噪声当产出。',
      '5. **只读**：不修改任何文件、不执行有副作用的命令；需要更多上下文时只用只读工具查证。',
      '6. 除上述「覆盖率」一节外，其余按你的标准输出格式（结论 / 问题清单 / 待确认假设 / 生产门槛缺口）组织。'
    ].join('\n')
  ]
    .filter(Boolean)
    .join('\n\n')
}
