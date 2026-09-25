# 来源与改动说明

## 上游

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/alibaba/open-code-review |
| 许可 | Apache-2.0（全文见同目录 `LICENSE`） |
| 取材路径 | `skills/open-code-review-delegate/SKILL.md` |
| 取回 ref | `cf64e7080f600d507888a26785ad6a8b7a13ab6a`（默认分支 HEAD，2026-09-21 取回） |

## 本目录文件

| 文件 | 说明 |
| --- | --- |
| `SKILL.md` | **code-harness 适配入口**（精简版，会被注入系统提示词，受 8k 字符预算约束） |
| `UPSTREAM-SKILL.md` | 上游原文，**未改动**，作为完整参考与后续比对的基准 |
| `LICENSE` | 上游 Apache-2.0 原文 |

## 改了什么

- 新增 frontmatter 的 `name` / `description` / `enabled`，并**改成单行键值**：code-harness 的 frontmatter 解析器只认 `key: value` 单行形式，上游的多行 YAML 折叠写法（`description: >`）会导致 description 被读成 `>`。
- 正文从"上游给任意宿主 Agent 的通用的 7 步流程"改写成 **code-harness 视角**：主路径指向内置的 `ocr_review` 工具，把手动 `run_command` 两步流程降级为备选。
- 精简了上游的字段表与排错段，保留**覆盖率纪律**、**输出字段契约**、**排错三连**（未安装 / `--format` 版本要求 / 委派模式不需要 LLM 配置）。
- 增加了与 code-harness 自研 `review_changes` 的分工说明。

## 升级方式

上游更新时：重新取回 `skills/open-code-review-delegate/SKILL.md` 覆盖 `UPSTREAM-SKILL.md`，比对后按需把新事实回填到适配入口与 `ocr_review` 工具（改完更新本文件的 ref）。
