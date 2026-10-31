---
description: "Export agent activity (prompts, model requests, tool calls, approvals, turns) as OTLP/HTTP logs and spans to the collector named by the OpenTelemetry environment variables."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-telemetry-otel

English | [中文](README.zh.md)

## Summary

Report what agents do to an OpenTelemetry collector. Each live Session's prompts, model requests, retries, tool calls, approval decisions, and turn outcomes become `dsh.*` log records, and each turn becomes a trace with a span per model request and tool call. Records carry identifiers, names, counts, durations, and outcomes; prompt text, tool arguments, tool output, and model output never leave the process. The standard OpenTelemetry exporter environment variables choose the collector, and without an endpoint the plugin exports nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The base bundle mounts the plugin after `@deepseek-ai/dsh-otel`, so every base-backed profile, including `acp`, has it. Set an endpoint in the environment that launches `dsh` to turn it on:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318 \
OTEL_SERVICE_NAME=dsh \
dsh --profile acp
```

### Environment variables

Each variable is read from the launching process or the Harness home `.env`; a project `.env` cannot set them, so a repository the agent works in cannot redirect its activity. A configured field with the same meaning wins over its variable.

| Variable | Config field | Meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `endpoint` | Base URL; `/v1/logs` and `/v1/traces` are appended |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `logsEndpoint`, `tracesEndpoint` | Full URL of one signal, used as is |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `…_LOGS_PROTOCOL`, `…_TRACES_PROTOCOL` | `protocol`, `logsProtocol`, `tracesProtocol` | `http/protobuf` (default) or `http/json` |
| `OTEL_EXPORTER_OTLP_HEADERS`, `…_LOGS_HEADERS`, `…_TRACES_HEADERS` | `headers`, `logsHeaders`, `tracesHeaders` | `key=value` pairs separated by commas, values percent-encoded; signal headers override shared ones |
| `OTEL_SERVICE_NAME` | `serviceName` | Resource `service.name`; defaults to `deepseek-harness` |
| `OTEL_RESOURCE_ATTRIBUTES` | `resourceAttributes` | Extra resource attributes in the header format |
| `OTEL_LOGS_EXPORTER`, `OTEL_TRACES_EXPORTER` | `logsExporter`, `tracesExporter` | `otlp` (default) or `none` to turn one signal off |
| `OTEL_SDK_DISABLED` | `disabled` | `true` exports nothing |

`OTEL_EXPORTER_OTLP_COMPRESSION` and `OTEL_EXPORTER_OTLP_TIMEOUT` and their signal forms apply through the shared transport. A signal is exported only when an endpoint applies to it. Unsupported exporters or protocols (for example `grpc`), malformed lists, and endpoints that are not HTTP(S) URLs fail the plugin at load. Errors name the field or header key, never a header value. Batching uses `maxExportBatchSize` (512), `maxQueueSize` (2,048), `scheduledDelayMillis` (5,000), `timeoutMillis` (10,000), and `exportTimeoutMillis` (15,000); unload drains both channels within `shutdownTimeoutMillis` (3,000) and then cancels the remaining exports.

### Log records

Every record has `event.name`, `event.timestamp` (ISO 8601), `event.sequence` (the Session event sequence), and `session.id`. Records inside a turn add `prompt.id` (`<session id>:<turn>`), `turn`, and `step`, and carry the trace and span ids of the span they belong to. Subagent Sessions add `parent_session.id`, `session.origin`, `delegation_depth`, and `agent_preset`.

| Event | Emitted when | Fields |
|---|---|---|
| `dsh.session_start` | The first live event of a Session | `resumed` |
| `dsh.user_prompt` | A human message enters a turn | `prompt_length` (characters of text) |
| `dsh.api_request` | A model response commits | `provider`, `model`, `duration_ms`, `attempt`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `reasoning_tokens`, `interrupted` |
| `dsh.api_error` | A model request fails and is retried, or the turn ends on a failed attempt | `provider`, `model`, `error_code`, `status_code`, `attempt`, `duration_ms` |
| `dsh.tool_decision` | An approval request is answered | `tool_name`, `call_id`, `mcp_server_name`, `mcp_tool_name`, `decision` (`allowed-once`, `rejected`, `cancelled`, `unavailable`), `source` (`approval`) |
| `dsh.tool_result` | A tool call completes | `tool_name`, `call_id`, `mcp_server_name`, `mcp_tool_name`, `success`, `duration_ms`, `error_code`, `decision` |
| `dsh.turn_end` | A turn ends | `outcome`, `error_code`, `status_code`, `cancel_cause`, `duration_ms`, `steps`, `tool_calls`, `tool_failures`, and the turn's token totals |

Fields appear only when known. Token counts are the adapter's: `input_tokens` excludes cache reads. MCP tools named `mcp__<server>__<tool>` report their server and tool names. Durations come from Session event times.

### Traces

Each turn is one trace. The `dsh.turn` span has a `dsh.llm_request` child per model attempt and a `dsh.tool` child per tool call, with the record fields as attributes; failed attempts, failed tools, and failed turns have error status. Retries and approval decisions are span events. A subagent's turn is a child of the parent's latest open tool span, so a delegation appears inside the parent's trace. Spans still open when a Session leaves the store or the plugin unloads end without an outcome.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) resolves the destinations, creates an ordinary-event channel and a span channel through the [shared OTel service](../otel/README.md), listens to `session/event` and `session/disposed`, and drains both channels at unload. [`src/config.ts`](src/config.ts) owns the environment-variable mapping and its validation. [`src/recorder.ts`](src/recorder.ts) is the per-Session projection from committed events to records and spans; it reads event types, identifiers, counts, and times, and never copies message content, tool arguments, or results. Model and provider come from the committed assistant message, or from the latest `request/header` before one commits. Events before a Session's first live sequence are restored history and are skipped.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [OTel service](../otel/README.md) — channel ownership, encodings, and transport.
- [OTel subsystem](../../../docs/subsystems/otel.md) — the generated service API.
- [Launch environment](../../util/launch-environment/README.md) — the environment layers the variables are read from.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin reports committed Session events to a collector without contributing model context.

#### KV Cache effect

None; reporting does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Delivery is best effort and the reported fields are fixed.

- **No gRPC** — only OTLP/HTTP with protobuf or JSON bodies is supported; `grpc` fails at load.
- **Memory-only queues** — queue overflow, an unreachable collector, and process exit lose records; there is no durable outbox.
- **No cost** — records carry token counts, not prices.
- **No content capture** — there is no option to export prompts, tool arguments, or outputs.
- **Subagent links are by timing** — a subagent's turn is attached to the parent's latest open tool span, which is the delegating call when one delegation runs at a time.

<a id="dev-note"></a>
### Dev Note

None.
