# 内置技能包

这里是随 code-harness 一起分发的**第三方技能包**，供 Agent 在某个项目里按需安装。

## 为什么不直接放进用户级技能目录

code-harness 的技能同时支持用户级（应用数据目录）与项目级（`<项目>/.code-harness/skills`）两个作用域，但**第三方技能包必须装到项目级**，原因是路径围栏：

所有文件类工具都把入参解析为绝对路径后校验是否在**项目根**内。而一个成体系的技能包往往由"入口 `SKILL.md` + 若干同伴文档"组成，入口会要求 Agent 去读同伴文档（渐进披露）。技能装在用户级目录时，那些同伴文档在项目根之外，`read_file` 直接被拒——技能会在读取阶段就断掉。装到项目级则整包都在项目内，读完即用。

## 包清单

| 包 | 用途 | 上游 | 许可 |
| --- | --- | --- | --- |
| `open-code-review-delegate` | 规则驱动的代码审查（委派模式）：ocr 做确定性文件筛选与规则解析，审查由本机模型执行 | [alibaba/open-code-review](https://github.com/alibaba/open-code-review) | Apache-2.0 |
| `security-audit` | 源码优先的安全审计：信任边界 → 候选搜寻 → 独立验证 → 结构化产物 | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) | MIT |

每个包内：

- `SKILL.md` — **code-harness 适配入口**，会被注入系统提示词的正文层（受 8k 字符共享预算约束，所以刻意精简）；
- `UPSTREAM-SKILL.md` — 上游原文，未改动，供比对与升级；
- `ORIGIN.md` — 上游 URL、取回 ref、许可证与**本地改动清单**；
- `LICENSE` — 上游许可证原文；
- 其余为上游同伴文档 / Schema / 校验器，未改动。

## 安装

两种方式（都装到**当前项目**的 `.code-harness/skills/<包名>/`）：

- 让 Agent 装：调用 `install_skill_pack` 工具，参数 `pack` 取上表的包名；
- 手工装：把本目录下对应的包文件夹整个复制到 `<项目>/.code-harness/skills/` 下，保持目录名不变。

安装后技能索引会进入系统提示词，正文按预算注入；技能未被启用（`SKILL.md` frontmatter 的 `enabled: false`）时只在索引里出现。

`.code-harness/` 目录是否提交进仓库由你决定——想跟随仓库走就提交，不想就加进 `.gitignore`。
