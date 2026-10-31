---
description: "将智能体活动（提示、模型请求、工具调用、审批、轮次）作为 OTLP/HTTP 日志和 span 导出到 OpenTelemetry 环境变量指定的收集器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-telemetry-otel

[English](README.md) | 中文

## 概述

将智能体的活动上报到 OpenTelemetry 收集器。每个活动 Session 的提示、模型请求、重试、工具调用、审批决定和轮次结果都会成为 `dsh.*` 日志记录，每个轮次成为一条 trace，其中每个模型请求和工具调用各有一个 span。记录只包含标识、名称、计数、时长和结果；提示文本、工具参数、工具输出和模型输出不会离开进程。标准 OpenTelemetry exporter 环境变量选择收集器；没有 endpoint 时插件不导出任何内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

base bundle 在 `@deepseek-ai/dsh-otel` 之后挂载本插件，因此包括 `acp` 在内的所有基于 base 的 profile 都包含它。在启动 `dsh` 的环境中设置 endpoint 即可开启：

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318 \
OTEL_SERVICE_NAME=dsh \
dsh --profile acp
```

### 环境变量

每个变量从启动进程或 Harness home 的 `.env` 读取；项目 `.env` 不能设置它们，因此智能体所工作的仓库无法改变其活动的去向。含义相同的已配置字段优先于对应变量。

| 变量 | 配置字段 | 含义 |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `endpoint` | 基础 URL；追加 `/v1/logs` 和 `/v1/traces` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`、`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `logsEndpoint`、`tracesEndpoint` | 单个信号的完整 URL，原样使用 |
| `OTEL_EXPORTER_OTLP_PROTOCOL`、`…_LOGS_PROTOCOL`、`…_TRACES_PROTOCOL` | `protocol`、`logsProtocol`、`tracesProtocol` | `http/protobuf`（默认）或 `http/json` |
| `OTEL_EXPORTER_OTLP_HEADERS`、`…_LOGS_HEADERS`、`…_TRACES_HEADERS` | `headers`、`logsHeaders`、`tracesHeaders` | 以逗号分隔的 `key=value`，值经百分号编码；信号专用 header 覆盖共享 header |
| `OTEL_SERVICE_NAME` | `serviceName` | Resource 的 `service.name`；默认 `deepseek-harness` |
| `OTEL_RESOURCE_ATTRIBUTES` | `resourceAttributes` | header 格式的附加 resource 属性 |
| `OTEL_LOGS_EXPORTER`、`OTEL_TRACES_EXPORTER` | `logsExporter`、`tracesExporter` | `otlp`（默认），或 `none` 关闭该信号 |
| `OTEL_SDK_DISABLED` | `disabled` | `true` 时不导出任何内容 |

`OTEL_EXPORTER_OTLP_COMPRESSION`、`OTEL_EXPORTER_OTLP_TIMEOUT` 及其信号专用形式通过共享传输生效。只有存在适用 endpoint 的信号才会导出。不支持的 exporter 或协议（例如 `grpc`）、格式错误的列表以及不是 HTTP(S) URL 的 endpoint 会使插件在加载时失败。错误信息只给出字段或 header 键，从不包含 header 值。批处理使用 `maxExportBatchSize`（512）、`maxQueueSize`（2,048）、`scheduledDelayMillis`（5,000）、`timeoutMillis`（10,000）和 `exportTimeoutMillis`（15,000）；卸载时在 `shutdownTimeoutMillis`（3,000）内清空两个通道，之后取消剩余导出。

### 日志记录

每条记录都有 `event.name`、`event.timestamp`（ISO 8601）、`event.sequence`（Session 事件序号）和 `session.id`。轮次内的记录另有 `prompt.id`（`<session id>:<turn>`）、`turn` 和 `step`，并携带所属 span 的 trace id 与 span id。子智能体 Session 另有 `parent_session.id`、`session.origin`、`delegation_depth` 和 `agent_preset`。

| 事件 | 触发时机 | 字段 |
|---|---|---|
| `dsh.session_start` | Session 的第一个实时事件 | `resumed` |
| `dsh.user_prompt` | 人类消息进入轮次 | `prompt_length`（文本字符数） |
| `dsh.api_request` | 模型响应提交 | `provider`、`model`、`duration_ms`、`attempt`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens`、`reasoning_tokens`、`interrupted` |
| `dsh.api_error` | 模型请求失败并重试，或轮次以失败的尝试结束 | `provider`、`model`、`error_code`、`status_code`、`attempt`、`duration_ms` |
| `dsh.tool_decision` | 审批请求得到答复 | `tool_name`、`call_id`、`mcp_server_name`、`mcp_tool_name`、`decision`（`allowed-once`、`rejected`、`cancelled`、`unavailable`）、`source`（`approval`） |
| `dsh.tool_result` | 工具调用完成 | `tool_name`、`call_id`、`mcp_server_name`、`mcp_tool_name`、`success`、`duration_ms`、`error_code`、`decision` |
| `dsh.turn_end` | 轮次结束 | `outcome`、`error_code`、`status_code`、`cancel_cause`、`duration_ms`、`steps`、`tool_calls`、`tool_failures` 以及该轮次的 token 合计 |

字段仅在已知时出现。token 数来自适配器：`input_tokens` 不含缓存读取。名为 `mcp__<server>__<tool>` 的 MCP 工具会报告服务器名和工具名。时长根据 Session 事件时间计算。

### Trace

每个轮次是一条 trace。`dsh.turn` span 下，每次模型尝试有一个 `dsh.llm_request` 子 span，每次工具调用有一个 `dsh.tool` 子 span，记录字段作为属性；失败的尝试、工具和轮次带错误状态。重试和审批决定是 span event。子智能体的轮次是父 Session 最近一个未结束工具 span 的子 span，因此委派显示在父 trace 内。Session 离开存储或插件卸载时仍未结束的 span 会在没有结果的情况下结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`src/index.ts`](src/index.ts) 解析目标地址，通过[共享 OTel 服务](../otel/README.zh.md)创建一个普通事件通道和一个 span 通道，监听 `session/event` 与 `session/disposed`，并在卸载时清空两个通道。[`src/config.ts`](src/config.ts) 负责环境变量映射及其校验。[`src/recorder.ts`](src/recorder.ts) 是从已提交事件到记录和 span 的逐 Session 投影；它读取事件类型、标识、计数和时间，从不复制消息内容、工具参数或结果。模型与 provider 取自已提交的助手消息，在其提交前取自最近的 `request/header`。Session 首个实时序号之前的事件属于恢复的历史，会被跳过。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [OTel 服务](../otel/README.zh.md)——通道归属、编码和传输。
- [OTel 子系统](../../../docs/subsystems/otel.zh.md)——生成的服务 API。
- [启动环境](../../util/launch-environment/README.zh.md)——读取这些变量的环境层。

-----

<a id="model-experience"></a>
## 模型体验

无，因为插件只将已提交的 Session 事件上报到收集器，不提供模型上下文。

#### KV Cache 影响

无；上报不会改变模型请求。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

投递为尽力而为，上报字段固定。

- **不支持 gRPC**——只支持 protobuf 或 JSON 请求体的 OTLP/HTTP；`grpc` 在加载时失败。
- **仅内存队列**——队列溢出、收集器不可达和进程退出会丢失记录；没有持久发件箱。
- **没有费用**——记录包含 token 数，不包含价格。
- **不采集内容**——没有导出提示、工具参数或输出的选项。
- **子智能体按时间关联**——子智能体的轮次挂在父 Session 最近一个未结束的工具 span 下；同一时间只运行一个委派时，该 span 就是发起委派的调用。

<a id="dev-note"></a>
### 开发备注

无。
