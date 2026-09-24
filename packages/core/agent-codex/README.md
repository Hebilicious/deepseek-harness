---
description: "The Codex session driver for dsh: one app-server instance per configured entry, one Codex thread per session, harness-scoped account operations, and Codex models in the picker."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

English | [中文](README.zh.md)

## Summary

Run agent sessions on Codex instead of the in-process loop. One plugin instance drives one or more Codex instances, each with its own `codex app-server` process, `CODEX_HOME`, credentials, agent-registry identity, and model-picker route; every session binds its own Codex thread with its own durable thread id. The driver forwards each turn over JSON-RPC, projects Codex items into `assistant/message`, `tool/call`, and `tool/result` events, routes Codex approvals into the dsh approval seam, and exposes the account operations a settings surface drives. Codex keeps the loop, prompt, tools, MCP servers, and config; dsh keeps the session, transcript, approvals, notifications, and model picker.

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

Mount this provider when sessions should run on a Codex account rather than on a dsh model route. The [`dsh-web-codex`](../../bundle/web-codex/README.md) bundle mounts it for the browser surface with one `codex` instance, and any composition can add the row itself.

### When to choose it

Choose this driver when Codex's own loop, prompt, tools, MCP servers, and `config.toml` should serve the session. Each configured entry registers one agent harness in `ctx.agents` under its id, with that id as its model-picker route, so a profile can mount this driver beside [`dsh-agent-loop`](../agent-loop/README.md) and any ACP harness, and can run a work account beside a personal one. The shipped `dsh-web-codex` bundle still disables the loop row to keep that profile Codex-only.

### Configuration

```yaml
- id: agent-codex
  name: '@deepseek-ai/dsh-agent-codex'
  config:
    harnesses:
      - id: work
        name: Work Codex
        description: OpenAI Codex runs the session through codex app-server
        codexHome: /home/me/.codex-work
        sandbox: workspace-write
      - id: personal
        name: Personal Codex
        codexHome: /home/me/.codex-personal
```

| Field | Default | Meaning |
|---|---|---|
| `harnesses` | required | One entry per Codex instance this plugin instance drives; ids must be unique |
| `harnesses[].id` | `codex` | Lowercase slug; the `ctx.agents` harness id and the `ctx.llm` catalog route |
| `harnesses[].name` | `Codex` | Human-readable name for a harness picker |
| `harnesses[].description` | — | One sentence on what runs the session |
| `harnesses[].executable` | `codex` | Codex executable name or absolute path |
| `harnesses[].args` | `['app-server']` | Arguments after the executable |
| `harnesses[].codexHome` | `~/.codex` | `CODEX_HOME` handed to the child; owns auth, `config.toml`, MCP servers, and hooks |
| `harnesses[].env` | `{}` | Explicit environment entries layered over the scrubbed parent environment |
| `harnesses[].sandbox` | `workspace-write` | Filesystem sandbox for sessions that log no `sandbox/mode` override |
| `harnesses[].networkAccess` | `false` | `networkAccess` member of the structured sandbox policy |
| `harnesses[].approval` | `ask` | `ask` maps to Codex `on-request` approvals, `never` to no approvals |
| `harnesses[].model` | — | Deployment default below the session's `model/selection` |
| `harnesses[].reasoningEffort` | — | Deployment default below the session's selection |
| `harnesses[].credentialRef` | — | Credential reference resolved for unattended `account/login/start {type:'apiKey'}` |
| `disposeGraceMs` | `5000` | Grace between managed-range termination tiers |
| `eofGraceMs` | `2000` | Window after stdin EOF before termination escalation |

### Before the first session

The driver refuses to bind a session while its instance's app-server reports an account that is unauthenticated and requires OpenAI auth. `bind()` then throws `agent-codex: Codex is not authenticated; sign in through the settings panel or run` followed by the `codex login` command. Run `codex login` once against that instance's `CODEX_HOME`, or set its `credentialRef` so an unattended deployment can send an API key through `account/login/start`. The `codex` Remote takes the instance id: `status({harness})`, `loginDeviceCode({harness})`, `loginBrowser({harness})`, `cancelLogin({harness, loginId})`, `logout({harness})`, `rateLimits({harness})`, and `events({harness})`; an id no entry mounted fails with `gateway/bad-request` and lists the mounted ids.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### One runtime per instance

Each configured entry builds its own `CodexAppServerRuntime`, which spawns `codex app-server` lazily on that instance's first session bind and memoizes the connection, so concurrent binds on one instance share a handshake. The runtime routes thread-scoped server requests and notifications to the agent that owns the thread id; a peer's own failure stays on that peer, while a transport failure fails that instance's connection for every one of its threads. Retiring a child clears the memo, so the next `connect()` spawns a fresh process instead of handing back a dead endpoint.

### Instance identity

Each entry constructs its own `CodexAgentHost`, which registers `{id, name, description, factory}` through `ctx.agents.registerHarness`. `ctx.agents.create` and `ctx.agents.resume` dispatch by harness id, and each host appends the durable `agent/harness` record to the sessions it publishes, so another instance refuses a session instead of replaying a conversation it cannot drive. An unqualified create resolves to the sole mounted instance and fails loud while several are mounted. Every runtime, its host, and its catalog route live in their own effect, so unloading the plugin disposes each instance's process once.

### Thread binding

`bind()` joins its instance's connection, proves the account is authenticated, then resumes the recorded thread or starts a fresh one, all before the session is published. A fresh `thread/start` runs with `ephemeral: false` and appends `agent-codex/thread`; a recorded thread is resumed with `excludeTurns: true`. Codex answering `-32600 no rollout found` for a thread that was never prompted makes the driver log a warning and start a fresh thread; every other refusal stays fatal, and a resumed id that differs from the recorded one is a protocol error. `unbind()` sends `thread/unsubscribe` while that instance's process is still alive.

### Turn driving

One Codex turn is one durable dsh step. `turn/start` carries the claimed input, `clientUserMessageId`, the effective approval policy and sandbox policy, and the selected `model`/`effort`; notifications stream through `ExternalTurnProjector`. A turn id is provisional until `turn/started` or the `turn/start` response commits it, and frames that arrive first are buffered and replayed. `turn/completed` maps `completed` to a completed turn, `interrupted` to an aborted one, and `failed` to `max-tokens` or an error code derived from Codex's failure category. An interrupted or failed turn still settles its open tool items and assistant streams, so a dangling `tool/call` never survives.

### Approvals, questions, and elicitation

Codex command, file-change, and permission requests route through `ctx.approval`; `item/tool/requestUserInput` and `mcpServer/elicitation/request` route through `ctx.userQuestions`. With neither service mounted, or no live turn, every request is refused rather than auto-approved. An elicitation whose schema is a flat object of string, enum, boolean, or number fields becomes one question per field; a richer schema declines instead of fabricating content.

### Account operations

The `codexAppServer` service publishes a harness-scoped Remote in the `codex` namespace: `status`, `loginDeviceCode`, `loginBrowser`, `cancelLogin`, `logout`, `rateLimits`, and an `events` stream of account notifications, each naming a mounted instance. An unknown id fails with `gateway/bad-request` and lists the mounted ids. `credentialRef` drives at most one `account/login/start {type:'apiKey'}` per instance, and the key value never enters logs or the transcript.

### Model catalog

Each instance id is also a `ctx.llm` provider route, served by a `CodexCatalogAdapter` registered for that id. Picker reads walk that instance's `model/list` over its own connection, so two instances can offer different accounts' catalogs. The route serves no stream, and a stream request fails loudly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `codexAppServer` service: per-entry runtimes, hosts, catalog routes, account Remote |
| [`src/config.ts`](src/config.ts) | Instance entries, the static Config schema, and default resolution |
| [`src/agent.ts`](src/agent.ts) | `CodexAgent`: thread lifecycle, turn driving, item projection, approvals |
| [`src/host.ts`](src/host.ts) | `CodexAgentHost`: registers one instance and binds its runtime into each agent |
| [`src/runtime.ts`](src/runtime.ts) | `CodexAppServerRuntime`: one instance's process, connection, thread routing, account calls, `model/list` |
| [`src/connection.ts`](src/connection.ts) | `CodexAppServerConnection`: line transport, handshake, request/notification dispatch |
| [`src/protocol.ts`](src/protocol.ts) | Wire decoding, permission modes, terminal turn statuses, failure classification |
| [`src/catalog.ts`](src/catalog.ts) | `CodexCatalogAdapter`: the catalog-only route for one instance id |
| [`src/thread-state.ts`](src/thread-state.ts) | `agent-codex/thread` event and its projection |
| [`src/types.ts`](src/types.ts) | Client-safe account payloads and Remote error codes |
| [`tests/agent-codex.spec.ts`](tests/agent-codex.spec.ts) | Turn, thread, approval, and account behavior over a mock app-server |
| [`tests/multi-instance.spec.ts`](tests/multi-instance.spec.ts) | Several instances in one plugin: routing, homes, resume, account scope, disposal |
| [`tests/config.spec.ts`](tests/config.spec.ts) | Entry defaults and the loud refusals for an unmountable instance list |
| [`tests/service.spec.ts`](tests/service.spec.ts) | Mounted instance identities and Remote scoping and error normalization |
| [`tests/runtime-lifecycle.spec.ts`](tests/runtime-lifecycle.spec.ts) | Process startup, retirement, and disposal |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | The plugin mounts and registers through a real Loader tree |
| — | No runtime invariant companion is published: the durable relations are the `agent-codex/thread` fold and the session events the shared projector commits, both asserted by their owning packages. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-agent-external](../agent-external/README.md) — the driver base, inbox, and create/resume/publish transaction this driver builds on.
- [dsh-agent](../agent/README.md) — the harness registry every entry registers into and create/resume dispatch through.
- [dsh-web-codex](../../bundle/web-codex/README.md) — the bundle that runs the browser profile on this driver.
- [dsh-agent-loop](../agent-loop/README.md) — the in-process driver a profile mounts beside this one as the `dsh` harness.
- [Core subsystem](../../../docs/subsystems/core.md) — the `Agent` contract and turn flow a driver implements.

-----

<a id="model-experience"></a>
## Model Experience

### Codex harness turn

#### What the model sees

The claimed user input is forwarded as Codex `UserInput` entries: text blocks pass through, an image with a resolvable attachment path becomes `localImage`, and files become their deterministic handle text. Everything else the model sees — Codex's system prompt, its earlier turns, and its tool definitions — belongs to the Codex process, not to dsh.

#### Token effect

dsh contributes only the new user input per turn; Codex pays for its own prompt, history, and tool schemas. A content block the driver cannot forward fails the turn with an `agent-codex: Codex sessions cannot forward ... input blocks` error rather than being dropped silently.

#### KV Cache effect

Codex owns the request prefix, so dsh can neither guarantee nor measure reuse. Within one Codex thread the prefix is append-only while the model and thread settings stay unchanged; changing `model`, `effort`, or the permission policy starts a request the previous prefix may not match.

### Model picker catalog

#### What the model sees

Each instance id is a `ctx.llm` route whose entries come from that instance's `model/list`, including each model's display name and reasoning-effort menu. A picker selection reaches the turn as the `model` and `effort` members of `turn/start`, and the durable `request/header` records what ran. The harness registers the instance id as its `modelProvider`, so the picker lists that route only for Sessions the instance runs, and `session.selectModel` refuses any other route for them.

#### Token effect

No direct token cost. The selected reasoning effort changes how many thinking tokens Codex spends on the turn.

#### KV Cache effect

A model or effort change replaces the route; a cached prefix under the previous route is not reused.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this driver is the wrong choice or needs operational care. They are current package constraints, not a task backlog.

- **The `dsh-web-codex` bundle keeps its profile Codex-only** — it disables the `agent-loop` row. The driver itself needs no such exclusion: a multi-harness profile mounts this driver beside the loop and the ACP harnesses.
- **Several Codex accounts need several entries** — two instances of the same `codex` CLI run side by side by mounting two `harnesses` entries with distinct ids; each entry owns its own process, `codexHome`, `credentialRef`, and catalog route, so a `codex login` or an API key applies to the instance that declares it and no other.
- **Codex owns the turn, dsh owns the shell** — the loop, prompt, tools, MCP servers, and config live in Codex. DSH keeps the durable session, transcript, approvals, notifications, and model picker; the driver forwards a model selection per turn and reports the harness's own current model, falling back to `agent-default` when Codex never reports one.
- **A Codex account is required and not provided** — sessions need `CODEX_HOME` with a completed `codex login`, or a `credentialRef` for the API-key path; dsh neither stores nor provisions Codex credentials.
- **The model catalog needs the CLI** — every picker read walks `model/list` over that instance's app-server, so an unreachable, broken, or slow `codex` binary leaves that instance's route without entries.
- **A thread without a rollout is replaced** — a session bound but never prompted owns a Codex thread with no stored rollout; the next bind logs a warning and starts a fresh thread instead of resuming.
- **An instance route serves no model calls** — `ctx.llm` requests on an instance id throw; the route exists so the picker can enumerate that instance's Codex models.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
