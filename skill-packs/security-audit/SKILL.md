---
name: security-audit
description: 源码优先的安全审计与漏洞核查：先定位真实信任边界，再给证据、安全复现、优先级与最小修复。用于安全问题咨询、聚焦式审查、漏洞研究，或按六阶段完整流程做代码库审计并产出报告。
enabled: true
---

# Security Audit（code-harness 适配入口）

本技能是 `cloudflare/security-audit-skill` 在 code-harness 上的适配入口。
**完整方法论必须按需读取**：上游原文见同目录 `UPSTREAM-SKILL.md`，各阶段与攻击面见同目录 15 个同伴文档（`RECONNAISSANCE.md`、`HUNTING.md`、`ATTACK-CLASSES.md` 等）；来源、许可与改动见 `ORIGIN.md`。

读取方式：同伴文档就在本技能目录下，用 `read_file` 按项目内相对路径读，例如 `.code-harness/skills/security-audit/HUNTING.md`。不要凭记忆复述它们的规则。

## 两种模式（先判定，别默认全跑）

- **指导模式（默认）**：回答安全问题、聚焦审查、方法论、结论分诊。**只取本技能与相关同伴文档中用得上的部分**，不跑六阶段、不建输出目录、不写审计产物。
- **完整审计模式**：仅当用户**明确要求**审计 / 渗透测试某个代码库，或要求完整 / 端到端安全审查，或要求产出报告产物时才进入。跑全部六阶段并落盘产物。

请求可能是两者之一时，**先问一个聚焦的问题**再建目录或开跑。

## code-harness 环境适配（与上游的关键差异，务必遵守）

1. **没有操作系统级沙箱。** code-harness 只有审批闸门、进程超时与项目内路径围栏，**没有**隔离网络 / 净化环境 / 只读目标与工具链 / 资源配额。因此：**不得执行被测代码**（构建、测试、fuzz、解释器、模拟器、浏览器一律不跑）。上游规则在此情形下的正确处置已经写明——把缺失的沙箱能力作为 `needs_validation` 阻塞项报告，并给出安全的验证方案。上一段这条**没有例外**。
2. **写入范围受限。** 文件工具只能写项目根内。上游默认的输出目录 `~/security-audit-skill/<repo>/run-<N>` 会被拒，**改为 `<项目>/.code-harness/audits/<repo>/run-<N>`**（`<N>` 取下一个未用整数）；`<repo>` 用目录名或本地 Git 远端推导。不要尝试写用户主目录或 `/tmp`。
3. **技能目录**（上游要求先解析的 `Skill directory`）＝ `<项目>/.code-harness/skills/security-audit`。
4. **子智能体映射**：上游的 `Task tool` ＝ code-harness 的 `task` 工具；上游的 `research` / `general` 两类子智能体在 code-harness 里没有对应角色，**用 `task` 派生并在 prompt 中显式写明角色、写入范围与独立性要求**。「发现者不得验证自己的发现」这条边界靠 prompt 与独立子会话保证：**候选验证必须新派一个子会话**，不得回到发现它的那个会话里自证。
5. **写隔离**（上游 `Write isolation` 节）：只有父会话写共享产物（`run-metadata.json`、`coverage-ledger.json`、`findings.json`、报告等）；每个 hunter / verifier 只在自己 `<output-dir>/agents/<agent-id>/scratch/` 内写。agent id 用 `^[a-z0-9][a-z0-9_-]{0,63}$`，避开 Windows 设备名（`con`、`nul`、`com1` 等）。
6. **校验器**用 `run_command` 跑（需要审批）：`node .code-harness/skills/security-audit/validate-findings.cjs ...`、`node .code-harness/skills/security-audit/validate-coverage-ledger.cjs ...`。上游文档给出的命令路径要按本适配改写。

## 不可让步的判据（完整版见同伴文档，这里只列闸门）

- **必须有边界和结果**：低信任主体、被接受的输入或动作、本该起作用的控制、被跨过的边界、受影响的主体或资源、可观测结果——少一样就不算发现。缺最佳实践、猜部署行为、通用解析器崩溃、自伤，都不能升格为安全缺陷。
- **证据必须有界**：静态分析确立代码路径；行为结论需要在可用控制下做有界本地验证。**本环境没有沙箱，所以行为层结论一律停在 `needs_validation`。**
- **严重程度只看已证明的影响**：critical/high/medium/low/informational 的锚点见上游 SKILL.md「Separate priority from certainty」；说不出具体损害，就往下调一级。**`needs_validation` 不给严重程度**——它表示"一个具体的、有源码依据的边界假设被卡住了"，不是低置信度的已确认漏洞。
- **覆盖要记账**：不允许"一遍扫完"的暗示。覆盖率由账本支撑，父会话独占账本更新权。
- **修复给最小有效改动**：写出代码必须维持的不变量，以及在**最后一个可信判定点**上最小的源码改动；优先具体到仓库相对路径的修改与回归测试，而不是通用加固建议。**审计只描述修复，不改被测源码。**

## 完整审计的六阶段与产物

1. **侦察** → 源码、信任边界、本地构建路径、同伴域选择、历史证据与初始覆盖账本（`RECONNAISSANCE.md`）。
2. **覆盖驱动的搜寻波次** → 从账本派独立 hunter（`HUNTING.md`、`ATTACK-CLASSES.md` + 选中的领域同伴文档）。
3. **候选验证** → 去重打分指纹，每个候选交给**新的**源码验证者（`VALIDATION-AND-REPORTING.md`）。
4. **结构化输出** → 全部 `confirmed` / `needs_validation` / `rejected` 写入 `findings.json`，用 `report-schema.json` 与两个校验器验证。
5. **独立记录复核** → 新子会话复核最终源码结论，对账修正。
6. **目标中立的报告** → 由最终记录派生 `REPORT.md`、`FINDINGS-DETAIL.md`、`NEEDS-VALIDATION.md`，**不含任何对线上环境发起探测的指令**。

只有两种合法终止状态：**(a)** 第 6 阶段产物齐备且两个校验器通过；**(b)** 记录 `run_status: "incomplete"` 与确切原因，并在报告中披露缺口。不得中途停在阶段之间。

## 预算

上游的 `quick` / `standard` / `deep` 档位与预算闸门全部适用，但**在 code-harness 里预算是"子智能体调用次数上限"**：一次 hunter 或 verifier 派发计一次。批评者（critic）与验证调用的预留必须在派 hunter 之前扣除；预算不够就先要更大预算、缩范围或换更粗的档位，**不要静默降低证据标准**。

## 反模式（上游原文，直接适用）

对照清单式的"偏差"当漏洞报 · 没有可达边界违规的纵深防御建议 · 在需要本地有界证据时去碰线上或共享环境 · 猜 provider / 代理 / 浏览器 / 身份 / 部署行为 · 把同一主体的既定权限或自伤当跨边界结果 · 把解析器或运行时报得比实测更严重 · 只给散文结论导致无法去重与验证 · 给 `needs_validation` 评严重程度 · 未经独立验证就写报告、或散文与 JSON 对不上。
