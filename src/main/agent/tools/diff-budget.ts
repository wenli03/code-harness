/**
 * 审查类工具共用的 diff 收集器。
 *
 * 为什么要独立成模块：`review_changes` 与 `ocr_review` 都要把"改动的 diff"交给只读审查子会话，
 * 而一个巨型 diff 会把审查会话自己撑爆。两边必须用**同一套预算口径**，
 * 否则同一次交付在两个工具里能审到的范围不一致，覆盖率就说不清了。
 */

/** diff 总预算（字符）。 */
export const DIFF_TOTAL_BUDGET = 60_000
/** 单个文件的 diff 预算（字符）。 */
export const DIFF_PER_FILE_BUDGET = 8_000

export interface DiffTarget {
  /** 已格式化好的小标题，例如 `#### src/a.ts` */
  heading: string
  /** 取该文件 diff；抛错时用 onError 兜底 */
  load: () => Promise<string>
  /** 取 diff 失败时的占位说明 */
  onError: string
}

export interface CollectedDiff {
  sections: string[]
  /** 因总预算耗尽而未展开的文件数 */
  omitted: number
  /** 实际用量（字符），供调用方在报告里说明预算 */
  used: number
}

/**
 * 按顺序收集 diff，超出总预算的**按序截断**并如实报出省略数量
 * ——审查员需要知道"后面还有 N 个文件没展开"，否则会误以为覆盖完整。
 */
export async function collectBudgetedDiffs(
  targets: DiffTarget[],
  truncationHint = '需要时用 git_diff 查看'
): Promise<CollectedDiff> {
  const sections: string[] = []
  let used = 0
  let omitted = 0

  for (const target of targets) {
    if (used >= DIFF_TOTAL_BUDGET) {
      omitted += 1
      continue
    }
    let chunk = ''
    try {
      chunk = await target.load()
    } catch {
      chunk = target.onError
    }
    if (chunk.length > DIFF_PER_FILE_BUDGET) {
      chunk = `${chunk.slice(0, DIFF_PER_FILE_BUDGET)}\n…(本文件 diff 超长，已截断，${truncationHint})`
    }
    sections.push(`${target.heading}\n${chunk || '(无差异)'}`)
    used += chunk.length
  }

  return { sections, omitted, used }
}
