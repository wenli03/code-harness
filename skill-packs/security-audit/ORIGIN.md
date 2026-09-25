# 来源与改动说明

## 上游

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/cloudflare/security-audit-skill |
| 许可 | MIT（Copyright (c) 2025-2026 Cloudflare, Inc.，全文见同目录 `LICENSE`） |
| 取材路径 | `skills/security-audit/`（整个目录） |
| 取回 ref | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`（默认分支 HEAD，2026-09-21 取回） |
| 官方联系 | security-ai-research@cloudflare.com |

## 本目录文件

| 文件 | 说明 |
| --- | --- |
| `SKILL.md` | **code-harness 适配入口**（精简版，会被注入系统提示词，受 8k 字符预算约束） |
| `UPSTREAM-SKILL.md` | 上游 `SKILL.md` 原文，**未改动**，作为完整方法论与升级基准 |
| `RECONNAISSANCE.md` … `DESKTOP-MOBILE-AND-LOCAL-IPC.md` | 15 个阶段与攻击面同伴文档，**未改动**，按需读取 |
| `report-schema.json` | 产物 JSON Schema，**未改动** |
| `validate-findings.cjs`、`validate-coverage-ledger.cjs` 及各自 `.test.cjs` | 零依赖校验器与测试，**未改动** |
| `LICENSE` | 上游 MIT 原文 |

## 改了什么

**只新增了一个适配入口，同伴文档、Schema、校验器全部保持上游原样。**

适配的动机是 code-harness 与上游假设的宿主环境有两处**硬冲突**——如果不改写，技能会直接执行失败或违反它自己的安全规则：

1. **路径围栏 vs 写入位置**：code-harness 的文件工具被限制在项目根内，而上游默认把审计产物写到 `~/security-audit-skill/<repo>/run-<N>`（项目外，必然被拒）。适配为 `<项目>/.code-harness/audits/<repo>/run-<N>`。
2. **无沙箱 vs 允许有界本地执行**：上游把"允许执行被测代码"的条件写得很严（无外网、净化环境、只读目标与工具链、资源配额、scratch 写入隔离）。code-harness 不具备这些控制，只有审批与超时。按上游自己的规则，此情形下**不得执行被测代码**，只能把执行层结论记为 `needs_validation` 并给出安全验证方案——适配入口把这条提到最前面显式声明，避免 Agent 误以为可以用 `run_command` 跑构建来"验证"漏洞。

另有两处术语与机制的映射：`Task tool` → code-harness 的 `task` 工具；`research` / `general` 两类子智能体 → 用 `task` 派生 + prompt 显式声明角色（code-harness 没有角色化的普通子会话，只有 `reviewer`）。

以及一处格式原因：frontmatter 的 `description` **必须写成单行**——code-harness 的 frontmatter 解析器只认 `key: value`，上游的多行折叠写法会被解析成 `>`。

## 升级方式

上游更新时：重新取回 `skills/security-audit/` 覆盖同伴文档、Schema、校验器与 `UPSTREAM-SKILL.md`，检查适配入口中引用的规则是否被上游改动（尤其是执行安全与写隔离两节），改完更新本文件的 ref。**不要改动同伴文档**——保持"上游原文可逐字节比对"是这套集成的核心价值。
