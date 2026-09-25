---
description: "The ctx.agentToolBridge service that projects an agent's scoped tools onto authenticated loopback MCP endpoints for external harnesses such as ACP agents and Codex."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-tool-bridge

English | [中文](README.zh.md)

## Summary

Use `dsh-agent-tool-bridge` to give an external-harness session access to the dsh tools visible in its agent's scope. The service keeps the harness's own loop and native tools, and adds one bearer-credentialed MCP Streamable HTTP endpoint per agent on a shared loopback listener. Every bridged call runs `ctx.tools.execute` under that agent's identity, so policy, approvals, and guards apply unchanged. The driver logs each bridged call under the dsh tool name with the execution's `meta`, so transcript presentation matches an in-process call. [`dsh-agent-acp`](../agent-acp/README.md) opens the endpoint per session; [`dsh-agent-codex`](../agent-codex/README.md) passes it through `mcp_servers` overrides.

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

Mount `dsh-agent-tool-bridge` in a profile that also runs external-harness sessions and [`dsh-tools`](../tools/README.md); it provides `ctx.agentToolBridge` and injects `tools`. The [`dsh-web-harnesses`](../../bundle/web-harnesses/README.md) bundle mounts it with the `exclude` list that profile ships.

### Configuration

```yaml
- id: agent-tool-bridge
  name: '@deepseek-ai/dsh-agent-tool-bridge'
  config:
    exclude: [read, write, edit, bash]
    host: 127.0.0.1
    port: 0
    serverName: dsh
```

| Field | Default | Meaning |
|---|---|---|
| `exclude` | `[]` | Tool names withheld from every endpoint; enforced again at call time |
| `host` | `127.0.0.1` | Listener bind address; only loopback interfaces are accepted because the bearer credential is the endpoint's whole request check |
| `port` | `0` | Listener port; `0` binds the shared listener on one ephemeral port every endpoint URL reports |
| `serverName` | `dsh` | The MCP server name endpoints and driver `mcpServers` entries advertise; it joins `mcp__<serverName>__<tool>` names and Codex `mcp_servers.<serverName>` keys, so empty strings, `.`, and `__` are rejected |
| `correlationLimit` | `100` | Settled executions retained per agent so a reported `tool/result` can pick up the dsh `meta`; the oldest entry drops at the limit |

### Bridge tools to a harness

`openMcpEndpoint(agent)` serves the agent's scoped, non-excluded tools as MCP `{name, description, inputSchema}` entries and returns `{name, url, headers, close()}`, where `headers` carries the endpoint's fresh `Authorization: Bearer` credential. A `tools/call` naming a withheld tool — excluded or unknown to the scope — returns an error result without reaching the registry; every other call runs `ctx.tools.execute` as the agent. An endpoint closes on `close()`, on `agent/disposed`, and with the service, which also closes the shared listener.

Two further operations serve the external drivers' transcript projection. `bridgedToolName(agent, reported)` resolves a harness-reported `mcp__<serverName>__<tool>` name to the dsh tool currently bridged for that agent; unrecognized, excluded, or unscoped names return `undefined` and the driver logs them verbatim. `takeCompletion(agent, tool, argumentsJson)` consumes the oldest settled execution matching the dsh name and the reported arguments — compared as canonical JSON, so object key order is irrelevant — so the driver's `tool/result` carries the execution's `meta`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The service owns one `node:http` server bound lazily on the first endpoint. `openMcpEndpoint` mints a 32-byte random credential, registers the endpoint, and appends the log-only `agent-tool-bridge/exposed` event (`{tools: string[]}`) to the agent's session once the exposed list is known — the model-visible ⟺ logged rule for the tool list the harness may see. Each request authenticates by constant-time comparison against every live credential; a missing or wrong token answers `401`, and the credential selects which agent's view serves the request, so endpoints share one URL path safely.

Each `tools/list` request builds a fresh `McpServer` from the agent's current bridged set, so scoped registrations, restrictions, and exclusions apply at request time. `tools/call` runs `ctx.tools.execute` under a signal fused from the request's and the endpoint's, so closing the endpoint aborts in-flight calls. Result content projects onto MCP blocks: text and reasoning carry over, an image resolves verified bytes through `ctx.attachments` and degrades to handle text when bytes cannot cross, a file becomes its handle text, and a nested tool result flattens.

Every settled `tools/call` also pushes `{name, canonical argumentsJson, meta}` onto the agent's completion queue, bounded by `correlationLimit` with the oldest entry dropped first. The bridge never sees the harness's call report, so the queue is the handover point: the driver's projector resolves the reported name through `bridgedToolName` and consumes the matching entry at `tool/result` time. `agent/disposed` drops the agent's queue together with its endpoints.

**Runtime invariant:** No companion is published: endpoint credentials and listener state are process-local, and the only durable record, `agent-tool-bridge/exposed`, is appended at its commit point and asserted by the session package.

<a id="further-exploration"></a>
## Further Exploration

- [dsh-tools](../tools/README.md): the registry and policy pipeline bridged calls execute through.
- [dsh-agent-acp](../agent-acp/README.md): the driver that consumes `openMcpEndpoint` for `session/new` and `session/load`.
- [dsh-agent-codex](../agent-codex/README.md): the driver that consumes `openMcpEndpoint` for `thread/start` and `thread/resume` config overrides.
- [dsh-agent-external](../agent-external/README.md): the shared external-driver base whose agent scope selects visible tools.

-----

<a id="model-experience"></a>
## Model Experience

### Bridged tool list

#### What the model sees

The external harness's model sees each bridged tool's name, description, and JSON Schema through its harness's MCP integration, alongside the harness's native tools. The set is the agent's scope-visible tools minus `exclude`; the durable `agent-tool-bridge/exposed` event records what one endpoint exposed when it opened.

#### Token effect

Bridged schemas add a per-request cost on the harness's side proportional to the exposed set; every `exclude` entry removes that schema entirely.

#### KV Cache effect

Prefix-stable while the exposed list is unchanged. Scoped registration, disposal, or restriction changes the next `tools/list` answer and may invalidate reuse from the first changed schema token; the harness owns its own cache policy.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Bridged calls do not append `tool/call` or `tool/result` records themselves; the external driver logs the harness's report under the resolved dsh name with the execution's `meta`, so a bridged call's transcript identity depends on the harness reporting it. A report that arrives past `correlationLimit` still logs under the dsh name, without `meta`. Policy side effects such as approvals still record normally.
- The endpoint serves Streamable HTTP only; harnesses that support just stdio MCP cannot consume it, and stdio bridging is deferred.
- The harness's own surface renders the call in its native form; dsh presenters and cards apply to the durable `tool/result` the driver logs, not inside the harness UI.
- A settled execution stays queued until a reported call consumes it, with no per-turn expiry: an execution whose call report never arrives — for example a turn abort that logged a synthesized error `tool/result` first — can attach its `meta` to a later identical call in a subsequent turn. The effect is presentation-only, bounded by `correlationLimit`, and dropped on `agent/disposed`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
