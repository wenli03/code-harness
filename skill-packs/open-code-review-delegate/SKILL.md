---
name: open-code-review-delegate
description: 规则驱动的代码审查（委派模式）：由 ocr 的确定性管线做文件筛选与规则解析，审查本身交给本机模型执行，无需配置 OCR 的 API Key。需要按语言/框架规则逐条核查改动、要行级定位与覆盖率账本时用。
enabled: true
---

# Open Code Review — 委派模式（code-harness 适配入口）

本技能是 `alibaba/open-code-review` 官方 `open-code-review-delegate` 技能在 code-harness 上的适配入口。
上游原文（含完整字段表与排错细节）见同目录 `UPSTREAM-SKILL.md`；来源与改动见 `ORIGIN.md`。

## 何时用它

- 要审查一段**有范围的改动**（工作区 / 分支对比 / 单个提交），且希望按**语言与框架规则**逐条核查，而不是凭感觉通读 diff。
- 需要**行级定位**（path + 行号）、严重程度分级、以及"每个文件都交代清楚"的**覆盖率账本**。
- 与 `review_changes` 的分工：`review_changes` 走 code-harness 自研的"生产就绪"清单（占位实现、吞错误、未声明假设）；本技能走上游沉淀的规则集（NPE、线程安全、XSS、SQL 注入等）与确定性文件筛选。**两者互补，不要互相替代**；交付前两个都跑一遍是合理的。

## 主路径：调用 `ocr_review` 工具

code-harness 已把整个委派流程封装成一个工具，一次调用即可完成"预览 → 取规则 → 审查 → 汇总报告"：

```
ocr_review(mode: workspace | range | commit, from, to, commit, requirement, focus, exclude)
```

- `mode: workspace`（默认）审工作区未提交改动；`range` 配 `from`/`to` 审分支差异（内部用 merge-base）；`commit` 配 `commit` 审单个提交。
- `requirement` 建议填原始需求（会作为业务上下文传给 ocr，审查员据此判断"是不是漏实现了"）。
- 工具内部会：探测 `ocr` 是否可用 → `ocr delegate preview --format json` 拿可审查文件 → `ocr delegate rule --format json` 拿规则组 → 取受影响文件的 diff（带预算截断）→ 派**只读审查子会话**按规则组逐文件审 → 回传结构化报告与覆盖率。

## 手动路径（需要更细的控制时才用）

`ocr_review` 覆盖不了时，用 `run_command`（cwd 为项目根）自己走两步：

```bash
ocr delegate preview --format json [--from main --to feature] [-c <hash>] [--exclude <patterns>] [-b "<业务上下文>"]
ocr delegate rule --format json <path1> <path2> ...
```

要点：

- `preview` 返回 `mode` / `merge_base` / `from` / `to` / `commit` / `reviewable_files` / `excluded_files`（含排除原因）。**排除原因是证据**，报告里要能说出为什么某些文件没审。
- `rule` 的输出按**规则内容分组**，同规则的文件归在一组；文件多时分批取规则，不要一次塞几百个路径。
- 取 diff 按模式走（这是 `preview` 给出 ref 元数据的用途）：
  - range → `git diff <merge_base>..<to> -- <path>`
  - commit → `git show <commit> -- <path>`
  - workspace → 已跟踪文件 `git diff HEAD -- <path>`；**未跟踪新文件直接读全文**（没有 diff）
- 大改动**分批**审（按规则组 + diff 大小切），不要找到第一个高危问题就收工。

## 输出契约

每条评论的字段（报告里必须能被机器和人读懂）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 相对仓库根的路径 |
| `content` | string | 是 | 问题描述 |
| `start_line` / `end_line` | integer | 否 | 新文件中的行号范围 |
| `category` | enum | 否 | bug / security / performance / maintainability / test / style / documentation / other |
| `severity` | enum | 否 | critical / high / medium / low |

分级口径：**critical / high 一律报**（Bug、安全问题、数据丢失风险）；medium 带上下文报；low（风格、无关痛痒的建议）**确有价值才报**，其余静默丢弃——不要把噪声当产出。

## 覆盖率纪律（硬要求）

- `preview` 给出的每个 `reviewable_files` 条目，最终必须落到 `reviewed` 或 `skipped`；`skipped` 必须写明**具体理由**。
- 报告结尾给出 `total_files` / `reviewed_files` / `skipped_files` / `coverage_rate`。
- 同一路径可能以不同 `status` 出现两次（暂存的删除 + 未跟踪的重建），此时用 `(path, status)` 作为条目身份，不要误判为重复。

## 排错

- `ocr` 未安装：`npm install -g @alibaba-group/open-code-review`（也可用 GitHub Release 二进制或安装脚本），前置要求 **Git ≥ 2.41**。
- 报 `unknown flag: --format`：说明 CLI 低于 **v1.9.0**。用 `ocr --version` 确认后升级。**不要把文本输出当 JSON 解析，也不要凭空补字段**——升级或改走 `ocr_review` 工具（它会明确报这个错）。
- 委派模式在 OCR 侧**不调用任何 LLM**，所以不需要 `ocr config provider` / `ocr config model`；出现"未配置模型"的报错说明命令走错模式了。
