---
description: "ctx.web 的免密钥 Exa MCP 搜索提供方：部署方如何在没有任何搜索凭证的情况下获得实时 web 搜索，以及端点的渲染结果块映射为什么。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-exa-mcp

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-exa-mcp`，harness 可以通过 Exa 的托管 MCP 端点搜索 web，因此即使部署完全不持有搜索凭证，`web_search` 也能工作。当没有任何来源提供 Exa、Perplexity 或 DeepSeek 的搜索凭证、而实时结果仍然重要时选择它；Exa 密钥只会提高端点的速率上限，永远不是必需条件。该端点返回渲染后的文本而非结构化来源，因此既不携带结果块、也不携带 Exa 空结果提示的响应体会让调用失败，而不是返回空结果。Exa 不返回生成答案，因此结果不携带 `content`——只产出可引用的来源。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `exa-mcp` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: exa-mcp` 固定。

### 何时选择

当部署必须在没有搜索凭证的情况下搜索 web 时选择此后端：托管端点接受匿名请求，因此挂载提供方本身就是全部配置。部署持有 Exa 密钥并希望使用 Exa 的关键词或神经搜索时，优先选择 [`dsh-web-search-exa`](../web-search-exa/README.zh.md)；希望获得生成答案时选择 [`dsh-web-search-perplexity`](../web-search-perplexity/README.zh.md)；搜索必须使用 Models 页面已管理的凭证时选择 [`dsh-web-search-deepseek`](../web-search-deepseek/README.zh.md)。只有当端点 URL 无法解析或 `numResults` 不是正整数时，提供方才不可用。

### 最小配置

加载 web 服务与本提供方；无需任何凭证，其余设置都有默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: exa-mcp
- name: '@deepseek-ai/dsh-web-search-exa-mcp'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$EXA_API_KEY` | 可选的 Exa API 密钥，以端点的 `exaApiKey` 参数发送，用于提高其速率上限；缺失或为空时使用匿名访问 |
| `endpoint` | `https://mcp.exa.ai/mcp` | 端点 URL；其已有的查询字符串会被保留。无法解析时提供方不可用 |
| `numResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数；必须是正整数。省略时使用端点自身的默认值 10 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-exa-mcp)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每个渲染结果块映射为 `WebSearchSource`：`url`、`title`、以首个高亮片段作为 `snippet`、`Published:` 值作为 `publishedAt`。Exa 的 `N/A` 占位符与空字段会成为被省略的属性而非字面值，其 `Author:` 行因 seam 没有作者字段而被忽略，缺少 URL 的块会被丢弃。请求的 `maxResults` 优先于已配置的默认 `numResults`，并作为端点的 `numResults` 发送——最终上限由服务强制执行：截断并标记。Exa 不返回生成答案，因此结果不携带 `content`。

### 失败与恢复

提供方失败——HTTP 错误、JSON-RPC 错误、工具级 `isError` 结果、既非 JSON 也非 SSE `data:` 载荷的响应体，以及既不携带结果块、也不携带 Exa 空结果提示的文本——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Exa 托管 MCP 端点之上的薄适配器，遵循三条刻意的规则：

- **默认匿名。** 该端点不需要凭证，因此 `available()` 只检查本地配置；密钥是可选的速率上限升级，绝不是可用性条件。
- **渲染文本就是线上格式。** Exa 不返回结构化来源数组，因此提供方逐块解析，并在结果块与空结果提示都未到达时让调用失败，而不是把散文抓取成凭空编造的来源。
- **不虚构答案。** Exa 不返回生成答案，因此省略 `content`，而不是编造模型可能信任的提供方文本。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `ExaMcpSearchProvider`：响应体解析、中止分类、结果块映射 |
| [`src/types.ts`](src/types.ts) | MCP 协议类型：`ExaMcpToolCallRequest`、`ExaMcpResponse`、`ExaMcpToolResult` |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 请求与映射流程

`search()` 以 `redirect: 'error'` 向配置的端点 POST 一次匿名的 JSON-RPC `tools/call`（调用 `web_search_exa`），因此重定向会在不接触目标的情况下使请求失败。请求同时接受 `application/json` 与 `text/event-stream`，因为该端点对更窄的取值返回 HTTP 406；并且只发送该工具声明的参数，因为其输入 schema 拒绝额外属性。响应体按 SSE `data:` 载荷或普通 JSON 解析；首个 `text` 内容块被切分为渲染块并逐块映射，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、相邻提供方与面向模型的工具。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——七包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-web-search-exa](../web-search-exa/README.zh.md)——返回结构化结果、需要凭证的 Exa 提供方。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-exa-mcp)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方经 `maxResults` 限制的 URL、标题、首个高亮片段与发布日期；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `Exa MCP search aborted`、`Exa MCP search request failed: <error>` 和 `Exa MCP returned no text content block to map`。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **搜索依赖没有可用性约定的第三方端点**——`mcp.exa.ai` 接受匿名请求，其速率上限、配额与可用性不在本仓库控制之内；需要受约定约束路线的部署应固定到需要凭证的提供方。
- **只公开 `endpoint` 与 `numResults`**——端点的 `web_search_exa` 工具只声明 `query` 与 `numResults` 并拒绝额外参数，因此 Exa 的 category、域名与日期控制项在此不可用；端点的 `web_fetch_exa` 工具未挂载，抓取仍由 `dsh-web-fetch-http` 承担。
- **没有自己的设置界面**——Web 搜索卡片编辑的是 `web-search-deepseek` 设置命名空间，因此本提供方通过 `cordis.yml` 或启动环境配置。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：端点更广的工具集

Exa 的 MCP 端点还公开 `web_fetch_exa`，以及通过 `tools` 查询参数启用的 `web_search_advanced_exa` 与 `agent_run`。挂载其中任何一个都意味着 seam 尚不具备的提供方角色或服务字段，因此它们保持未挂载。

</details>
