# Agent Note: Keyless Exa MCP search provider

Status: implemented

[English](2026-09-11-keyless-exa-mcp-search-provider.md) | 中文

## Problem

基础 bundle 固定了 `searchProvider: deepseek-official`，而该路线解析 `$DEEPSEEK_API_KEY`——也就是 Models 页面为聊天管理的凭证。因此，使用其他模型凭证运行 harness 的部署没有可用的 `web_search`：每次调用都因无法解析密钥而失败。搜索曾是唯一需要自己厂商凭证的面向模型能力，因为 `web_fetch` 已经可以匿名工作。所有已交付的替代方案都需要用户自行获取密钥（Exa、Perplexity 或 DeepSeek），而改用模型调用并不可接受：没有实时互联网的聊天模型面对新闻查询会给出编造的 URL，而不是承认自己无法搜索。

## Decision

`@deepseek-ai/dsh-web-search-exa-mcp` 在 `ctx.web` 上注册 `exa-mcp` 搜索提供方，并调用托管的 Exa MCP 端点 `https://mcp.exa.ai/mcp`。基础 bundle 挂载该条目并把 `web.searchProvider` 固定为 `exa-mcp`，同时保留 `web-search-deepseek` 的挂载，使部署无需重新添加包即可把 `deepseek-official` 固定回来。`available()` 不需要凭证，也不发起网络调用：只要端点 URL 可解析，并且（在设置时）`numResults` 为正整数即可。

### 端点约定

该端点响应针对 `web_search_exa` 的 JSON-RPC `tools/call`，且不需要凭证。有两条请求事实是关键约束，并已对着实时端点确认：`Accept` 头必须同时列出 `application/json` 与 `text/event-stream`，否则端点返回 HTTP 406；该工具的输入 schema 只声明 `query` 与 `numResults` 且 `additionalProperties: false`，因此任何其他参数都会让调用失败。可选的 `apiKey` 通过 `exaApiKey` 查询参数传递，用于提高端点的速率上限；它绝不是可用性条件。请求设置 `redirect: 'error'`，与这一 seam 上的其他所有提供方一致。

响应体是 SSE（`event: message` 加一行 `data:`），或者在 JSON-RPC 协商失败时是普通 JSON；两者都能解析。首个 `text` 内容块携带的是渲染后的散文，而非结构化来源数组：结果块之间以 `---` 行分隔，每块含 `Title:`、`URL:`、`Published:`、`Author:` 以及一个 `Highlights:` 区段，区段内的片段以 `...` 行分隔。`N/A` 是 Exa 表示值缺失的占位符。

### 映射

每个带 URL 的结果块映射为一个 `WebSearchSource`：`title`、以首个非空白高亮片段作为 `snippet`、`Published:` 值作为 `publishedAt`。`N/A` 与空字段成为被省略的属性而非字面值，`Author:` 因 seam 没有作者字段而被忽略，缺少 URL 的块被丢弃。`maxResults` 会作为端点的 `numResults` 透传，而最终上限仍由 seam 强制执行，因此提供方报告 `truncated: false`。Exa 不返回生成答案，因此 `content` 保持省略。

Exa 自身的空结果提示映射为零个来源。任何其他不含结果块的文本都会以 `WEB_PROVIDER_ERROR` 让调用失败，遵循 `dsh-web-search-deepseek` 所陈述的规则：缺少预期块是错误，而不是退化为抓取散文。中止以 `WEB_ABORTED` 呈现，包括在读取响应体期间触发的中止。

## Alternatives considered

**通过已配置的聊天模型搜索。** OpenCode Go 不公开搜索端点，其模型也没有实时互联网——直接发起新闻查询会返回无访问权限——因此这条路线会返回编造的 URL。编造引用的提供方比大声失败的提供方更糟。

**交付新提供方，但保留 `deepseek-official` 为默认值。** 这是上游的保守选择，却让所报告的问题依旧存在：没有 DeepSeek 搜索凭证的部署会持续让每次搜索失败，直到有人修改组合。同时挂载两个条目既让交付的默认值可用，又让需要凭证的路线只需一行配置。

**在基础 bundle 中替换掉 `web-search-deepseek`。** 只持有 DeepSeek 凭证的部署届时必须重新添加被移除的包才能保住现有路线。为新增免密钥路径并不需要移除一条可用的需要凭证路径。

**同时实现该端点的 `web_fetch_exa` 工具。** `web-fetch-http` 已经可以匿名抓取页面并校验每个目标地址，因此第二个抓取提供方只会增加包的表面积，而不会消除任何凭证要求。

**向端点发送 `type`、`livecrawl` 或 `contextMaxCharacters`。** 其他 MCP 客户端会把这些发送给其他 Exa MCP 部署，但本端点的 `web_search_exa` schema 拒绝额外属性，因此发送它们会让每次调用失败。

## Consequences

每个已交付的 profile 现在都通过一个没有可用性或配额约定的第三方端点执行 web 搜索。其速率上限与可用性不在本仓库控制之内，而且真实端点 e2e 套件会在每次 `test:e2e` 运行时访问它；`DSH_EXA_MCP_E2E=0` 无需改动代码即可将其移出。

`web_search` 在任意模型路线上都变得可用，包括完全不持有搜索凭证的部署。代价是保真度：需要凭证的 `dsh-web-search-exa` 会显式请求高亮，而本提供方只取 Exa 最先渲染的片段；需要 Exa 的 category、域名或日期控制项的部署仍需使用前者。

Web 搜索卡片仍在编辑 `web-search-deepseek` 设置命名空间，因此 `exa-mcp` 通过 `cordis.yml` 或启动环境配置。为它提供设置界面意味着新增一张绑定其自身命名空间的卡片。

## Testing

`packages/web/web-search-exa-mcp/tests/exa-mcp.spec.ts` 以每文件 100% 覆盖率固定了结果块映射、响应体解析、可用性、请求映射、错误分类与 HMR 安全的注册；`tests/egress.spec.ts` 证明请求携带置于被代理 URL 中的密钥到达配置的代理；`tests/exa-mcp.e2e.ts` 对托管端点执行真实查询，验证提供方仍返回可引用来源。录制会话场景 `snapshots/session/web-search-endpoint-guidance` 在自己的补丁中固定 `searchProvider: deepseek-official`，因为它录制的是 DeepSeek 路线而非交付的默认值。

没有录制会话场景驱动经由免密钥路线的成功 `web_search`，因为实时答案在没有专属端点夹具的情况下无法成为确定性的回放夹具。

## Related

- [Web 能力 seam](../architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。
