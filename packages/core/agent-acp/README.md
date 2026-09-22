---
description: "The Devin session driver for dsh: bind each session to its own ACP session on a shared `devin acp` process, drive turns over the Agent Client Protocol, and put Devin models in the picker."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-acp

English | [中文](README.zh.md)

## Summary

Run agent sessions on Devin instead of the in-process loop: one `devin acp` process serves the whole profile, and every session binds its own ACP session with its own durable session id. The driver sends each prompt with `session/prompt`, projects ACP session updates into `assistant/message`, `tool/call`, and `tool/result` events, routes Devin permission requests into the dsh approval seam, and exposes Devin's auth operations. Devin keeps the loop, prompt, tools, MCP servers, and config; dsh keeps the session, transcript, approvals, notifications, and model picker. It needs a logged-in Devin CLI, and mounting it replaces the profile's in-process loop.

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

Mount this provider when sessions should run on a Devin account over the Agent Client Protocol rather than on a dsh model route. The [`dsh-web-acp`](../../bundle/web-acp/README.md) bundle mounts it for the browser surface, and any composition can add the row itself.

### When to choose it

Choose this driver when Devin's own loop, prompt, tools, MCP servers, and config should serve the session, and the two sides can agree on the Agent Client Protocol. The driver registers itself as the `ctx.agents` factory, and `AgentRegistry.setFactory()` accepts exactly one factory, so the composition cannot also run [`dsh-agent-loop`](../agent-loop/README.md); the shipped bundle disables that row.

### Configuration

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    sandbox: workspace-write
    approval: ask
```

| Field | Default | Meaning |
|---|---|---|
| `executable` | `devin` | Harness executable name or absolute path |
| `args` | `['acp']` | Arguments after the executable |
| `cwd` | `process.cwd()` | Working directory for the harness process itself; sessions carry their own |
| `env` | `{}` | Explicit environment entries layered over the scrubbed parent environment |
| `sandbox` | `workspace-write` | Filesystem sandbox for sessions that log no `sandbox/mode` override |
| `approval` | `ask` | Approval routing for sessions that log no `approval/policy` override |
| `mode` | — | Deployment override for the session's `mode` config option |
| `model` | — | Deployment default below the session's `model/selection` |
| `disposeGraceMs` | `5000` | Grace between managed-range termination tiers |
| `eofGraceMs` | `2000` | Window after stdin EOF before termination escalation |
| `modelsArgs` | `['models', 'list', '--format', 'json']` | Model-catalog command arguments |
| `authStatusArgs` | `['auth', 'status']` | Auth-status command arguments |
| `authLogoutArgs` | `['auth', 'logout']` | Auth-logout command arguments |
| `cliTimeoutMs` | `180000` | Deadline for one one-shot CLI verb before the driver gives up on it |

### Before the first session

Sessions need an authenticated Devin CLI: run `devin auth login` once, or start the browser flow through the `acp` Remote's `login` method. The service reports both the agent's advertised auth methods and the `devin auth status` verdict, so a settings surface can show which half is missing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Shared ACP runtime

One `AcpRuntime` per mounted plugin spawns `devin acp` lazily and memoizes the connection and the agent's initialize response. The ACP SDK validates inbound frames; the driver's own `AcpClientConnection` fixes the handshake at `clientCapabilities: {}`, so Devin self-serves its filesystem and terminal work instead of calling back into dsh, and routes each notification and request to the peer registered for its `sessionId`. The endpoint is memoized until the child exits or the connection fails; it is then retired, so the next `connect()` spawns a fresh child instead of returning a dead one. `dispose()` latches before its first await, so a handshake still in flight is awaited and torn down rather than published, and every later `connect()` fails. The same runtime runs the short-lived CLI verbs (`models list`, `auth status`, `auth logout`) through the same subprocess seam, each bounded by `cliTimeoutMs`.

### Session binding

`bind()` joins the shared connection and creates an ACP session (`session/new`) or loads the recorded one (`session/load`), before the dsh session is published. A fresh session appends `agent-acp/session` with the agent-issued id; a resume requires the agent to advertise `loadSession`, otherwise the driver fails loudly with `session "<id>" cannot resume: the agent does not advertise loadSession`. The peer registers only after the load response, so replayed history never double-commits.

### Turn driving

One `session/prompt` is one durable dsh step. `agent_message_chunk` and `agent_thought_chunk` updates feed an assistant stream, `tool_call` and `tool_call_update` commit durable tool pairs, `plan` renders as a text block, and `config_option_update` refreshes the session's known options. The response's stop reason maps to the turn ending: `end_turn` completes, `max_tokens` records the ceiling, `cancelled` aborts with the user cause, and `refusal` or `max_turn_requests` fails with a fixed code. A turn that ends with open tool calls or open assistant streams settles them, so nothing model-visible is left dangling.

### Permissions and elicitation

`session/request_permission` routes through `ctx.approval`, and `elicitation/create` in `form` mode routes through `ctx.userQuestions` when its schema is a flat object of string and enum fields. With no approval service, no live turn, or a richer schema, the driver declines or cancels instead of guessing.

### Auth operations

The `acpHarness` service publishes a connection-global Remote in the `acp` namespace: `status`, `login`, and `logout`. Logout prefers the ACP `logout` request when the agent advertises it and otherwise runs `devin auth logout`, because the shipped Devin answers `agentCapabilities.auth` as `{}`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `acpHarness` service: config, catalog registration, host mount, auth Remote |
| [`src/agent.ts`](src/agent.ts) | `AcpAgent`: session lifecycle, turn driving, update projection, permissions |
| [`src/host.ts`](src/host.ts) | `AcpAgentHost`: binds the runtime and deployment config into each agent |
| [`src/runtime.ts`](src/runtime.ts) | `AcpRuntime`: process, connection, CLI verbs, model catalog, auth |
| [`src/connection.ts`](src/connection.ts) | `AcpClientConnection`: handshake, session routing, fatal observation |
| [`src/protocol.ts`](src/protocol.ts) | Stop reasons, tool content, prompt blocks, permission outcomes, config options |
| [`src/catalog.ts`](src/catalog.ts) | `DevinCatalogAdapter`: the catalog-only `devin` model route |
| [`src/session-state.ts`](src/session-state.ts) | `agent-acp/session` event and its projection |
| [`src/types.ts`](src/types.ts) | Client-safe Devin account payloads and Remote error codes |
| [`tests/agent-acp.spec.ts`](tests/agent-acp.spec.ts) | Turn, session, permission, mode, auth, and catalog behavior over the mock ACP agent |
| [`tests/agent-edge.spec.ts`](tests/agent-edge.spec.ts) | Update variants, attachments, refusals, session overrides, and degraded agent responses |
| [`tests/runtime.spec.ts`](tests/runtime.spec.ts) | Runtime lifecycle: mid-handshake disposal, respawn after a dead child, CLI verbs, cancellation |
| [`tests/service.spec.ts`](tests/service.spec.ts) | `AcpHarness` config fallbacks and Remote error normalization |
| [`tests/protocol.spec.ts`](tests/protocol.spec.ts) | Pure wire-helper mapping without a child process |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | The plugin mounts and registers through a real Loader tree |
| — | No runtime invariant companion is published: the durable relations are the `agent-acp/session` fold and the session events the shared projector commits, both asserted by their owning packages. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-agent-external](../agent-external/README.md) — the driver base, inbox, and create/resume/publish transaction this driver builds on.
- [dsh-web-acp](../../bundle/web-acp/README.md) — the bundle that runs the browser profile on this driver.
- [dsh-agent-loop](../agent-loop/README.md) — the in-process driver this one replaces in a profile.
- [Agent Client Protocol](https://agentclientprotocol.com) — the public protocol specification Devin and this driver speak.
- [Core subsystem](../../../docs/subsystems/core.md) — the `Agent` contract and turn flow a driver implements.

-----

<a id="model-experience"></a>
## Model Experience

### Devin harness turn

#### What the model sees

The claimed user input is converted to ACP prompt blocks: text passes through, and a file or image attachment with a resolvable host path becomes an ACP `resource_link` block. An attachment whose path cannot be resolved degrades to a `[file: name]` placeholder instead of failing the turn. Everything else the model sees — Devin's prompt, its earlier turns, and its tool definitions — belongs to the Devin process, not to dsh.

#### Token effect

dsh contributes only the new user input per turn; Devin pays for its own prompt, history, and tool schemas. Reasoning text Devin streams as `agent_thought_chunk` is recorded in the dsh transcript, but dsh never sends it back to Devin, whose own context already holds it.

#### KV Cache effect

Devin owns the request prefix, so dsh can neither guarantee nor measure reuse. Within one ACP session the prefix is append-only while the model and mode stay unchanged; changing either starts a request the previous prefix may not match.

### Session mode and model selection

#### What the model sees

Before each prompt the driver applies the session's selections with `session/set_config_option`: the `model` option carries the durable `model/selection` or the deployment default, and the `mode` option carries the sandbox and approval knobs. A value the session does not advertise is logged with the value that will actually run, and the durable `request/header` records the agent's own reported model.

#### Token effect

No direct token cost. The applied model and mode change how much reasoning and tool work Devin performs for the turn.

#### KV Cache effect

A model change replaces the route, so a prefix cached under the previous model is not reused. A mode change alone leaves the token prefix intact when the model and history are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this driver is the wrong choice or needs operational care. They are current package constraints, not a task backlog.

- **Devin has no read-only permission mode** — `devin --permission-mode` accepts approval modes (`auto`, `accept-edits`, `smart`, `dangerous`), and the ACP session modes are `accept-edits`, `smart`, `ask`, `plan`, and `bypass`. None restricts the agent to reading, so a dsh `read-only` sandbox cannot be enforced by Devin; the driver logs a warning naming the mode the session actually runs instead of pretending it applied.
- **It replaces the profile's agent loop** — `ctx.agents.setFactory()` accepts exactly one factory, so mounting this driver excludes `dsh-agent-loop` for the whole profile; the `dsh-web-acp` bundle disables that row instead of composing both.
- **Devin owns the turn, dsh owns the shell** — the loop, prompt, tools, MCP servers, and config live in Devin. DSH keeps the durable session, transcript, approvals, notifications, and model picker; the driver forwards a model selection per turn and reports the agent's own current model, falling back to `agent-default` when the session advertises no model option.
- **A Devin login is required and not provided** — sessions need `devin auth login`; dsh neither stores nor provisions Devin credentials.
- **The model catalog needs the CLI** — the `devin` route walks `devin models list --format json`, so an unreachable, unauthenticated, or slow CLI leaves the picker without entries; each call is bounded by the caller's signal and `cliTimeoutMs`.
- **The catalog write can fail inside a contained child** — on Linux the local subprocess provider's systemd-scope path leaves the child's stdout non-blocking, so the ~180 KB catalog write can die with `exited 101 ... Resource temporarily unavailable (os error 11)`; the driver reports the CLI's exit code and stderr tail, and the stdio defect belongs to the subprocess provider, not this package.
- **No mid-turn steering** — ACP carries no steering channel, so `steer()` input stays queued for the next turn instead of reaching the running one.
- **A recorded session cannot resume without `loadSession`** — an agent that does not advertise the capability fails the bind rather than silently starting a fresh session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
