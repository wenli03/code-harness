# Provider 对接说明

Code Harness 不绑定任何模型厂商：`ProviderConfig` 只有 `kind`（协议）+ `baseUrl` + `apiKey` + 模型名列表。所有国内主流网关都能直接接。

本文记录的是**实测结果**（2026-09 校验），不是文档抄录——下面标 ✅ 的都是用项目自身的 Provider 适配层（`src/main/agent/providers/`）真实跑通的。

## 快速接入

### 方式一：界面里点预置（推荐）

设置 → 模型 → **从预置快速添加**，点一下就有 Base URL 和常用模型名，你只需要粘贴 API Key，然后点「测试」。

预置清单在 `src/shared/presets.ts`（只有接入信息，**不含任何密钥**）。

### 方式二：批量注入密钥

适合一次性把多家 Key 都配好、或者做无人值守部署：

```bash
# 1) 仓库根写一个 providers.local.json（已在 .gitignore，不会被提交）
#    格式见文件内的 _comment / tools/seed-providers.cjs 顶部注释
# 2) 注入（密钥用 safeStorage 加密写入应用设置）
npm run seed:providers
```

脚本是幂等的：按 `baseUrl` 匹配已有 Provider，命中就地更新，不会重复堆叠。它是个 **Electron 主进程脚本**而不是普通 node 脚本，因为要用 `safeStorage`（系统密钥环）和 `app.getPath('userData')`——只有这样才能保证加密形态与界面里点「保存」完全一致，并且写进应用真正读取的目录。

> ⚠️ **别把脚本改成 `app.exit(0)` 或用普通 node 跑。**
> `safeStorage` 在 Windows 上走 Chromium OSCrypt，主密钥保存在 `userData/Local State`，而该文件是 Chromium **异步**落盘的。
> 在它出现之前加密出来的密文**只有当前进程能解**，重启后就是废数据（现象：设置里 API Key 变空）。
> 所以 `tools/seed-providers.cjs` 里做了三件事，缺一不可：建一个隐藏 `BrowserWindow` 把 profile 拉起来 →
> 轮询等 `Local State` 出现 → 用 `app.quit()` 优雅退出（`app.exit()` 会跳过 profile flush）。
> 应用自身不受影响：用户真正去填 Key 时应用已经运行了足够久，`Local State` 早已落盘。

配置落盘位置：

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\Code Harness\settings.json` |
| macOS | `~/Library/Application Support/Code Harness/settings.json` |
| Linux | `~/.config/Code Harness/settings.json` |

（`package.json` 里固定了 `productName: "Code Harness"`，所以开发态和打包后共用同一份配置。）

## 实测结论

| Provider | kind | Base URL | 模型（实测可用） | 状态 |
| --- | --- | --- | --- | --- |
| DeepSeek 官方 | `openai-compatible` | `https://api.deepseek.com/v1` | `deepseek-v4-pro`、`deepseek-flash` | ✅ 流式 + 工具调用 + 思维链 |
| 硅基流动 SiliconFlow | `openai-compatible` | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V4-Pro`、`deepseek-ai/DeepSeek-V4-Flash`、`Qwen/Qwen3.8-27B`、`zai-org/GLM-5.3`、`moonshotai/Kimi-K2.7-Code` | ✅ 流式 + 工具调用（共 94 个模型） |
| 智谱 GLM（BigModel） | `openai-compatible` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3-flash`、`glm-5.3`、`glm-4.7`、`glm-4.6` | ⚠️ Key 有效，但账户**余额不足**（`HTTP 429 code 1113`） |
| 千问 Qwen（DashScope 兼容模式） | `openai-compatible` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.8-max`、`qwen3.8-flash`、`qwen3.8-27b` | ✅ 流式 + 工具调用 + 思维链 |
| 千问 Qwen（Anthropic 原生） | `anthropic` | `https://dashscope.aliyuncs.com/apps/anthropic` | 同上 | ✅ `/v1/messages` + `tool_use` |

实测方式：把 `src/main/agent/providers/index.ts` 单独打包，用真实 Key 走一遍 `createProvider(config).stream({ tools, stream: true })`，检查产物里的 `StreamEvent` 序列。

```
[OK] deepseek / deepseek-v4-pro
     tool_calls=1 :: list_dir({"path":"."})  reasoning=162字  stop=tool_calls
     usage={"inputTokens":376,"outputTokens":79,"totalTokens":455}
[OK] siliconflow / deepseek-ai/DeepSeek-V4-Pro
     tool_calls=1 :: list_dir({"path":"."})  reasoning=103字  stop=tool_calls
[FAIL] bigmodel / glm-5.3-flash
     HTTP 429 — {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}
[OK] qianwen / qwen3.8-max
     tool_calls=1 :: list_dir({"path":"."})  reasoning=120字  finish=tool_calls
[OK] qianwen / qwen3.8-flash
     tool_calls=1 :: list_dir({"path":"."})  reasoning=194字  finish=tool_calls
[OK] qianwen / qwen3.8-27b
     tool_calls=1 :: list_dir({"path":"."})  reasoning=138字  finish=tool_calls
[OK] qianwen-anthropic / qwen3.8-max   (x-api-key 与 Bearer 两种鉴权头都实测通过)
     tool_use=1 :: list_dir({"path":"."})  stop=tool_use
```

## 踩坑清单

**1. 智谱的模型 id 是全小写的。**
`/models` 返回的是 `glm-5.3-flash`，写成 `GLM-5.3-Flash` 虽然鉴权能过，但模型名不一定被接受。一律用小写。

**2. 智谱返回 429 不一定是限流。**
`code: 1113` + "余额不足或无可用资源包" 是**账户没充值**，不是并发限制，重试无用。要在 <https://open.bigmodel.cn> 充值或用带资源包的 Key。注意应用内「测试」按钮走的是 `/models`，没余额时它**依然返回 200 显示"连接正常"**——所以别只看测试结果，要真正发一条消息试试。

**3. Base URL 要写到 `/v1`（或各家等价的版本段），不要写到 `chat/completions`。**
适配层会自己拼 `${baseUrl}/chat/completions`。智谱给的是 `https://open.bigmodel.cn/api/paas/v4`，DeepSeek 是 `https://api.deepseek.com/v1`（写 `https://api.deepseek.com` 也能通，但 `/v1` 更稳）。另外 `/models` 自检也走同一个前缀，所以 `https://api.deepseek.com/v1/models` 必须是通的——实测 200。

**4. DeepSeek 与硅基流动上的 DeepSeek 系模型默认是推理模型。**
返回里 `content` 可能为空而 `reasoning_content` 有内容（`max_tokens` 小的时候尤其明显）。适配层已经单独解析 `reasoning_content`，UI 会折叠成「思考过程」，**不要把 content 为空当成调用失败**。要拿到正文就把 `max_tokens` 给足。

**5. 硅基流动的 `Pro/` 前缀是独立付费通道。**
同一个模型有 `deepseek-ai/...` 和 `Pro/deepseek-ai/...` 两个 id，后者优先级更高也另计费。预置里默认用不带前缀的。

**6. 本地 Ollama 的 Key 不能留空。**
`testProvider` 在 `apiKey` 为空时直接返回"未填写 API Key"、不会发请求。Ollama 不校验 Key，随便填一个非空字符串即可。

**7. 千问（DashScope）有两种协议，同一把 Key 都通。**
兼容模式 `https://dashscope.aliyuncs.com/compatible-mode/v1` 走 OpenAI 协议；`https://dashscope.aliyuncs.com/apps/anthropic` 走 Anthropic 原生协议。**后者不要自己补 `/v1`** —— 适配层对 `kind: anthropic` 的规则是「baseUrl 已以 `/v1` 结尾则拼 `/messages`，否则补 `/v1/messages`」，填 `.../apps/anthropic` 会正确得到 `.../apps/anthropic/v1/messages`。鉴权头 `x-api-key` 与 `Authorization: Bearer` **实测都能通过**，适配层默认发的 `x-api-key` 直接可用，无需额外配 `headers`。

**8. Qwen3.8 系是推理模型。**
和 DeepSeek 一样，返回里 `content` 可能为空而有 `reasoning_content`（`max_tokens` 给得小时尤其明显），别当成调用失败——适配层会把推理内容单独解析成可折叠的「思考过程」。实测三个模型都稳定吐 120~200 字思维链后才发工具调用。

**9. DashScope 的 `/models` 返回 250+ 个模型，别照着列表挑。**
里面混着 embedding / rerank / 图像 / 语音 / 数学等**不能做对话**的模型；同一模型还有别名与定版快照之分（`qwen3.8-max` 是别名，`qwen3.8-max-0902` 是某日定版）。预置里只放**实测跑通对话 + 工具调用**的那三个。

**10. `max_tokens` 必须落在服务端允许的范围内，否则每个回合都 400。**
实测踩到：DashScope 直接回
`<400> InternalError.Algo.InvalidParameter: Range of max_tokens should be [1, 131072]`。
这个值来自「设置 → 模型 → 最大输出 tokens」，它是**单次回复的输出上限，不是上下文窗口**——最容易被误填成一个大数，
而且错在请求参数上，模型根本没机会被调用。

应用侧已做收敛：`src/shared/types.ts` 的 `clampMaxTokens()`（范围 `[1, 131072]`）在
`settings-store.normalize()` 里对**读盘与保存**都生效，界面输入框也加了 `min`/`max` 与夹断。

但注意 **131072 只是「最宽松厂商」的值，不是所有厂商都接受**：DeepSeek 系只到 8192，
所以默认值保持保守的 8192。调高之前先确认当前 Provider 的模型支持，否则会在切换 Provider 时重新踩到同一个 400。

**11. DashScope 的内容审查会拒掉整个请求（`DataInspectionFailed`）。**
原文：`<400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.`
它**不是参数错误** —— 请求参数完全正确时也照样发生，所以「检查自己的参数」这个方向是白费的。

实测排查结论（2026-09-15）：

| 假设 | 实测 |
| --- | --- |
| 与输入长度有关 | ❌ 2K / 20K / 80K / 150K 字的普通中文全部 200 |
| 两个端点策略不同 | ❌ `compatible-mode` 与 `apps/anthropic` 表现一致 |
| 系统提示词触发 | ❌ BASE_PROMPT + 项目 Harness 记忆/精炼/目标全部 200 |
| 会话历史里的具体文本 | ✅ 二分定位到一个 **41,817 字符的 `read_file` 工具结果**（GitHub 检索结果汇总），单独送它就 400 |

所以典型症状是「**某个会话一直报这个错，而新建会话就正常**」——
被拒的那段文本作为历史消息被每一轮原样重发。`describeHttpError()` 现在会识别这类响应并直接给出三条可操作建议
（换 Provider / 新建会话 / 别再让模型读那个文件）。

**顺带修掉一个把这个故障放大成「永久性」的 bug**：`maybeCompact` 的规模估算只累加 `message.text`，
**漏掉了工具输出**——而实测工具输出占真实上下文的 88%（351,335 字符里占 308,720），估算低估 **8.24 倍**，
导致压缩阈值永远达不到、历史从不收敛。已把 `toolResult.output.length` 计入估算。

## 接入其他厂商

任何提供 OpenAI 兼容 `/chat/completions` 的服务：设置 → 模型 → 添加自定义 Provider → `kind` 选 `OpenAI 兼容` → 填 Base URL 与模型名即可，**不用改代码**。

要把它做成内置预置（让下次点一下就出来），往 `src/shared/presets.ts` 的 `PROVIDER_PRESETS` 里加一条，然后同步更新本文的实测表。

支持 Anthropic 原生协议（`/v1/messages` + `tool_use`）的服务，`kind` 选 `Anthropic` 即可——适配层实现了完整的 `tool_use` / `tool_result` 与角色交替规范化。
