---
description: "ctx.agentToolBridge 服务：通过经认证的回环 MCP 端点，把 agent 作用域内可见的工具投影给 ACP agent、Codex 等外部 harness。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-tool-bridge

[English](README.md) | 中文

## 概述

使用 `dsh-agent-tool-bridge` 让外部 harness 会话访问其 agent 作用域内可见的 dsh 工具。该服务保留 harness 自身的循环与原生工具，并在共享回环监听器上为每个 agent 提供一个持 bearer 凭证的 MCP Streamable HTTP 端点。每次桥接调用都以该 agent 的身份运行 `ctx.tools.execute`，因此策略、审批与防护照常生效。驱动器把每次桥接调用记录为 dsh 工具名并带上执行的 `meta`，因此转录呈现与进程内调用一致。[`dsh-agent-acp`](../agent-acp/README.zh.md) 按会话打开端点；[`dsh-agent-codex`](../agent-codex/README.zh.md) 通过 `mcp_servers` 覆盖传入端点。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在同时运行外部 harness 会话与 [`dsh-tools`](../tools/README.zh.md) 的 profile 中挂载 `dsh-agent-tool-bridge`；它提供 `ctx.agentToolBridge` 并注入 `tools`。[`dsh-web-harnesses`](../../bundle/web-harnesses/README.zh.md) bundle 会以该 profile 自带的 `exclude` 列表挂载它。

### 配置

```yaml
- id: agent-tool-bridge
  name: '@deepseek-ai/dsh-agent-tool-bridge'
  config:
    exclude: [read, write, edit, bash]
    host: 127.0.0.1
    port: 0
    serverName: dsh
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `exclude` | `[]` | 对所有端点保留的工具名；调用时再次强制检查 |
| `host` | `127.0.0.1` | 监听器绑定地址；只接受回环接口，因为 bearer 凭证是端点唯一的请求校验 |
| `port` | `0` | 监听端口；`0` 让共享监听器绑定一个临时端口，每个端点 URL 都报告该端口 |
| `serverName` | `dsh` | 每个端点 MCP 服务器名（`<serverName>-<6 位十六进制>`）的前缀，驱动器 `mcpServers` 条目对外宣称该名称；它会拼入 `mcp__<name>__<tool>` 名称与 Codex `mcp_servers.<name>` 配置键，因此拒绝空字符串、`.` 与 `__` |
| `correlationLimit` | `100` | 每个 agent 保留的已结算执行数，让上报的 `tool/result` 能取得 dsh `meta`；到达上限时丢弃最旧的条目 |

### 把工具桥接给 harness

`openMcpEndpoint(agent)` 以 MCP `{name, description, inputSchema}` 条目形式提供该 agent 作用域可见且未被排除的工具，并返回 `{name, url, headers, close()}`，其中 `headers` 携带该端点全新的 `Authorization: Bearer` 凭证。`tools/call` 若命名了被保留的工具——被排除或不在作用域内——直接返回错误结果而不触达注册表；其余调用都以该 agent 身份运行 `ctx.tools.execute`。端点在 `close()`、`agent/disposed` 以及服务销毁时关闭，服务销毁同时也会关闭共享监听器。

每个端点以自己的名称 `<serverName>-<6 位十六进制>` 提供服务，因为按名称在进程范围内保存 MCP 服务器的 harness（opencode）否则会让一个会话的端点替换或关闭另一个会话的端点。另外两个操作服务于外部驱动器的转录投影。`bridgedToolName(agent, reported)` 把 harness 上报的 `mcp__<serverName>__<tool>` 名称解析为该 agent 当前桥接的 dsh 工具；无法识别、被排除或不在作用域内的名称返回 `undefined`，驱动器按原样记录。`takeCompletion(agent, tool, argumentsJson)` 消费与 dsh 名称和上报参数匹配的最早已结算执行——参数按规范化 JSON 比较，对象键序无关——使驱动器的 `tool/result` 携带该执行的 `meta`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

服务持有一个在首个端点打开时才惰性绑定的 `node:http` 服务器。`openMcpEndpoint` 生成 32 字节随机凭证、注册端点，并在确定暴露列表后向 agent 会话追加仅记录的 `agent-tool-bridge/exposed` 事件（`{tools: string[]}`）——这是 harness 可见工具列表的"模型可见 ⟺ 已记录"规则。每个请求都会对所有存活凭证做常量时间比较认证；缺失或错误的 token 返回 `401`，而凭证决定以哪个 agent 的视图服务该请求，因此多个端点可以安全地共享同一 URL 路径。

`tools/list` 每次请求都基于该 agent 当前的桥接集合构建新的 `McpServer`，因此作用域注册、限制与排除都在请求时生效。`tools/call` 在请求 signal 与端点 signal 融合后的 signal 下运行 `ctx.tools.execute`，因此关闭端点会中止在途调用。结果内容会投影为 MCP 内容块：text 与 reasoning 直接保留，image 通过 `ctx.attachments` 解析经过校验的字节、无法跨传输时降级为句柄文本，file 变为其句柄文本，嵌套的 tool result 会被展平。

每个已结算的 `tools/call` 还会把 `{name, 规范化 argumentsJson, meta}` 压入该 agent 的完成队列，队列以 `correlationLimit` 为界、最旧的条目先被丢弃。桥接器看不到 harness 的调用上报，因此队列就是交接点：驱动器的投影器在 `tool/result` 时通过 `bridgedToolName` 解析上报名称并消费匹配条目。`agent/disposed` 会连同端点一起丢弃该 agent 的队列。

**运行时不变式：** 不发布配套 invariant：端点凭证与监听器状态都是进程内的，唯一的持久记录 `agent-tool-bridge/exposed` 在其提交点追加并由 session 包断言。

<a id="further-exploration"></a>
## 进一步探索

- [dsh-tools](../tools/README.zh.md)：桥接调用经由其执行的注册表与策略流水线。
- [dsh-agent-acp](../agent-acp/README.zh.md)：在 `session/new` 与 `session/load` 中消费 `openMcpEndpoint` 的驱动器。
- [dsh-agent-codex](../agent-codex/README.zh.md)：在 `thread/start` 与 `thread/resume` 配置覆盖中消费 `openMcpEndpoint` 的驱动器。
- [dsh-agent-external](../agent-external/README.zh.md)：共享的外部驱动器基类，其 agent 作用域决定可见工具集。

-----

<a id="model-experience"></a>
## 模型体验

### 桥接工具列表

#### 模型所见

外部 harness 的模型通过其 harness 的 MCP 集成看到每个桥接工具的名称、描述与 JSON Schema，与 harness 原生工具并列。该集合是 agent 作用域可见工具减去 `exclude`；持久化的 `agent-tool-bridge/exposed` 事件记录某个端点打开时实际暴露的内容。

#### Token 影响

桥接 schema 在 harness 一侧产生与暴露集合成正比的每请求开销；每个 `exclude` 条目都会整体移除对应 schema 的开销。

#### KV Cache 影响

暴露列表不变时前缀稳定。作用域注册、销毁或限制会改变下一次 `tools/list` 的应答，并可能使自首个变化的 schema token 起的复用失效；缓存策略由 harness 自行决定。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 桥接调用自身不追加 `tool/call` 或 `tool/result` 记录；外部驱动器以解析出的 dsh 名称记录 harness 的上报并带上执行的 `meta`，因此桥接调用的转录身份取决于 harness 是否上报。超过 `correlationLimit` 才到达的上报仍会以 dsh 名称记录，只是没有 `meta`。审批等策略副作用仍照常记录。
- 端点仅提供 Streamable HTTP；只支持 stdio MCP 的 harness 无法使用，stdio 桥接暂缓。
- harness 自身界面按其原生形式渲染调用；dsh presenter 与卡片作用于驱动器记录的持久 `tool/result`，而非 harness UI 内部。
- 已结算的执行会一直留在队列中，直到某个上报的调用将其消费，不按回合过期：若某次调用的上报始终未到达——例如回合中止先记录了一个合成的错误 `tool/result`——它的 `meta` 可能挂到后续回合中一次相同的调用上。影响仅限呈现层面，受 `correlationLimit` 约束，并在 `agent/disposed` 时丢弃。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
