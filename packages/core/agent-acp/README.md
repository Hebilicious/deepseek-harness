---
description: "The multi-harness ACP session driver for dsh: one shared process per configured harness, one ACP session per dsh session, per-harness catalogs for the model picker, and harness-scoped auth Remotes."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-acp

English | [中文](README.zh.md)

## Summary

Run agent sessions on ACP harnesses instead of the in-process loop. One plugin instance drives several at once (Devin, Grok Build, opencode, mimocode, or any other ACP agent), each with its own shared process, its own agent-registry identity, and its own model-picker route. Every session binds its own ACP session on its harness's process: prompts go out as `session/prompt`, updates come back as durable assistant and tool events, and permission requests route into the dsh approval seam. The harness keeps its loop, prompt, tools, MCP servers, and config; dsh keeps the session, transcript, approvals, notifications, and picker.

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

Mount this provider when sessions should run on ACP harness accounts rather than on a dsh model route. The [`dsh-web-acp`](../../bundle/web-acp/README.md) bundle mounts it for the browser surface, and any composition can add the row itself.

### When to choose it

Choose this driver when a harness's own loop, prompt, tools, MCP servers, and config should serve the session, and the two sides can agree on the Agent Client Protocol. Each configured entry registers one harness in `ctx.agents`, so a session's caller names the harness it wants, and the durable `agent/harness` record keeps a resume on the same one. The in-process [`dsh-agent-loop`](../agent-loop/README.md) registers as the separate `dsh` harness, so a profile can offer both and let the caller choose.

### Configuration

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    harnesses:
      - id: devin
        name: Devin
        description: Devin runs the session through devin acp
        executable: devin
        args: ['acp']
      - id: grok
        name: Grok Build
        description: xAI Grok Build runs the session through grok agent
        executable: grok
        args: ['agent', '--no-leader', 'stdio']
```

| Field | Default | Meaning |
|---|---|---|
| `harnesses` | required | One entry per ACP harness this plugin instance drives; ids must be unique |
| `harnesses[].id` | required | Lowercase slug; the `ctx.agents` harness id and the `ctx.llm` catalog route |
| `harnesses[].name` | required | Human-readable name for a harness picker |
| `harnesses[].description` | — | One sentence on what runs the session |
| `harnesses[].executable` | required | Harness executable name or absolute path |
| `harnesses[].args` | `['acp']` | Arguments after the executable |
| `harnesses[].cwd` | `process.cwd()` | Working directory for the harness process itself; sessions carry their own |
| `harnesses[].env` | `{}` | Explicit environment entries layered over the scrubbed parent environment |
| `harnesses[].sandbox` | `workspace-write` | Filesystem sandbox for sessions that log no `sandbox/mode` override |
| `harnesses[].approval` | `ask` | Approval routing for sessions that log no `approval/policy` override |
| `harnesses[].mode` | — | Deployment override for the session's `mode` config option |
| `harnesses[].model` | — | Deployment default below the session's `model/selection` |
| `harnesses[].reasoningEffort` | — | Deployment default below the session's selection |
| `harnesses[].catalogArgs` | — | Model-catalog CLI arguments; omitted, the catalog comes from a session advert |
| `harnesses[].probeCatalog` | `true` | Read the catalog by opening one throwaway session before any session binds |
| `catalogCacheMs` | `300000` | How long one harness's catalog read is reused before the next read |
| `catalogFailureCacheMs` | `30000` | How long one harness's failed catalog read is remembered before the next attempt |
| `harnesses[].authStatusArgs` | `['auth', 'status']` | Auth-status command arguments; an explicitly empty list declares no CLI verb |
| `harnesses[].authLogoutArgs` | `['auth', 'logout']` | Auth-logout command arguments |
| `disposeGraceMs` | `5000` | Grace between managed-range termination tiers |
| `eofGraceMs` | `2000` | Window after stdin EOF before termination escalation |
| `cliTimeoutMs` | `180000` | Deadline for one one-shot CLI verb before the driver gives up on it |

### Before the first session

Each harness needs its own authenticated CLI: run `devin auth login`, `grok login`, or the harness's equivalent once, or start its browser flow through the `acp` Remote's `login` method. The service reports the agent's advertised auth methods and that harness's auth-status CLI verdict, so a settings surface can show which half is missing. A harness that reports authorization through its ACP methods instead of a CLI command configures empty `authStatusArgs` and `authLogoutArgs`: status then reports the ACP-only situation without spawning anything, and logout fails loud unless the agent advertises its own `logout` method. This is how an adapter-driven harness such as Claude Code is mounted. The `acp` Remote takes the harness id: `status({harness})`, `login({harness, methodId})`, and `logout({harness})`; an id no entry mounted fails with `gateway/bad-request` and lists the mounted ids.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### One runtime per harness

Each configured entry builds its own `AcpRuntime`, which lazily spawns that harness's process and memoizes its connection and the agent's initialize response. The ACP SDK validates inbound frames; the driver's own `AcpClientConnection` fixes the handshake at `clientCapabilities: {}`, so the harness self-serves its filesystem and terminal work instead of calling back into dsh, and routes each notification and request to the peer registered for its `sessionId`. An endpoint is memoized until the child exits or the connection fails, then retired, so the next `connect()` spawns a fresh child. Every runtime, its agent-factory host, and its catalog route live in their own effect, so unloading the plugin disposes each harness's process once. The same runtime runs the entry's short-lived CLI verbs (`catalogArgs`, `authStatusArgs`, `authLogoutArgs`) through the same subprocess seam, each bounded by `cliTimeoutMs`.

### Agent-registry identity

Each entry constructs its own `AcpAgentHost`, which registers `{id, name, description, factory}` through `ctx.agents.registerHarness`. `ctx.agents.create` and `ctx.agents.resume` dispatch by harness id, and each host appends the durable `agent/harness` record to the sessions it publishes, so a resume that names another harness is refused instead of replaying a conversation this harness cannot drive.

### Session binding

`bind()` joins its harness's shared connection and creates an ACP session (`session/new`) or loads the recorded one (`session/load`), before the dsh session is published. A fresh session appends `agent-acp/session` with the agent-issued id; a resume requires the agent to advertise `loadSession`, otherwise the driver fails loudly with `session "<id>" cannot resume: the agent does not advertise loadSession`. The peer registers only after the load response, so replayed history never double-commits. Some agents store a session only once it receives a prompt (Claude Code does), so after a harness restart `session/load` of a session no turn reached answers `Resource not found`; the driver then creates a fresh ACP session and appends a replacement `agent-acp/session`, because the agent held no history for it. A session that ran a turn keeps the failure. The session advert also republishes that harness's model catalog.

When [`ctx.agentToolBridge`](../agent-tool-bridge/README.md) is mounted and the agent advertises `mcpCapabilities.http`, `bind()` opens one bridge endpoint and passes it as an `http` `mcpServers` entry in both `session/new` and `session/load`, so the harness gains the dsh tools visible in the session's agent scope under its own MCP integration. The endpoint's credential is per-agent and closes with the agent. A mounted bridge with an agent that lacks HTTP MCP support logs one warning and the session runs without bridged tools; the throwaway catalog probe session always opens with `mcpServers: []`, because it exists before a durable agent does. A bridged `tool_call` logs under the dsh tool name: the driver resolves `mcp__<server>__<tool>` whether the harness reports it as the update's `name`/`title` (Claude Code) or in `_meta` as `cognition.ai/toolName`/`inferenceToolName` (Devin), and the result carries the execution's `meta` when the tool declares `presentationMeta`.

### Turn driving

One `session/prompt` is one durable dsh turn, and the driver opens a new step when the agent starts another model response: a text, thought, plan, or tool call that arrives after every tool call of the current step has its result. `agent_message_chunk` and `agent_thought_chunk` updates feed an assistant stream, `tool_call` and `tool_call_update` commit durable tool pairs, `plan` renders as a text block, and `config_option_update` refreshes the session's known options. An agent may announce a call before its input has streamed (the Claude Code adapter sends `{}` and refines it through `tool_call_update`), so a call whose input is empty commits its `tool/call` at the first refinement that carries input, its permission request, its terminal update, the agent's next chunk, plan, or call, or the turn end, whichever comes first. A new call first commits the assistant text streamed before it, so the log keeps the order the agent produced text and tool calls in. The response's stop reason maps to the turn ending: `end_turn` completes, `max_tokens` records the ceiling, `cancelled` aborts with the user cause, and `refusal` or `max_turn_requests` fails with a fixed code. A turn that ends with open tool calls or open assistant streams settles them, so nothing model-visible is left dangling.

### Model catalog

Each harness id is also a `ctx.llm` provider route, served by an `AcpCatalogAdapter` registered for that id. The catalog is the harness's own session advert: `models.availableModels` when the agent sends it, otherwise the `model` config option's selectable values. The advertised reasoning-effort option (for example the Claude Code adapter's `effort`) becomes every listed model's effort menu, with its current value as the default, because ACP advertises one per session rather than per model. The most recent non-empty advert of a bound session wins, so the picker reflects the running harness. Before any session binds, an entry reads its catalog in this order: the configured `catalogArgs` CLI listing, then, when `probeCatalog` is left at its default, one throwaway session whose advert is published and whose session is closed again when the agent advertises `close` or `delete`, with a close that fails logged and left to the process lifetime rather than failing the read. An agent that advertises neither keeps that probe session until the process exits, because dropping the connection without closing would leave the harness believing the session is live; set `probeCatalog: false` where spawning the harness for a catalog read is unwanted, and the route then lists nothing until a real session binds. One read serves every caller and its result is reused for `catalogCacheMs`, including an empty result, so a picker that polls never starts a harness CLI or probe session per request; a session that binds replaces the cached read with its own advert. A failed read is remembered for `catalogFailureCacheMs` and rethrown to every caller inside that window, so a harness that keeps failing, such as an executable missing from `PATH`, is not respawned by every poll; the next read after the window retries, and an advert still wins over the remembered failure. Every step of a probe carries the `cliTimeoutMs` deadline, because one read is single-flight: a harness that starts but never answers `session/new` would otherwise leave this route pending for the process lifetime. A read that deadline ended is retried on the next read rather than remembered, and so is a cancellation that reached the read from another caller, because neither is a verdict on the harness. The route serves no stream, and a stream request fails loudly. Each harness registers its id as its `modelProvider`, so the picker lists that route only for Sessions the harness runs, and `session.selectModel` refuses any other route for them.

### Permissions, mode, and reasoning effort

`session/request_permission` routes through `ctx.approval`, and `elicitation/create` in `form` mode routes through `ctx.userQuestions` when its schema is a flat object of string and enum fields. With no approval service, no live turn, or a richer schema, the driver declines or cancels instead of guessing. Before each prompt the driver applies the session's selections with `session/set_config_option`, only for options the session advertises: `model` carries the durable selection or deployment default, the advertised reasoning-effort option (`thought_level` on Devin, `reasoning_effort` on Grok Build, or any option in the ACP `thought_level` category) carries the session's effort or the deployment default, and `mode` carries the DSH sandbox and approval knobs. A requested value the harness does not advertise is logged once with the value that will actually run, never dropped silently. A `never` approval policy selects the harness's auto-approve mode (`bypass` on Devin, `bypassPermissions` on the Claude Code adapter), because the harness asks for every tool call its mode does not cover and `never` rejects each ask; a writable `ask` session selects its edit-accepting mode (`accept-edits`, `acceptEdits`, or `build`). An `approval/policy` or `sandbox/mode` change re-applies `mode` at once rather than at the next prompt, one write at a time, and a failed write is logged and retried by the next prompt.

### Auth operations

The `acpHarness` service publishes one Remote in the `acp` namespace: `status`, `login`, and `logout`, each taking a harness id. Logout prefers the ACP `logout` request when the agent advertises it and otherwise runs that entry's `authLogoutArgs`, because the shipped Devin answers `agentCapabilities.auth` as `{}`. Login and logout connect the harness on demand when it has not connected yet, so a freshly mounted harness answers from its agent's own initialize response instead of being judged before it speaks.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `acpHarness` service: per-entry runtimes, hosts, catalog routes, auth Remote |
| [`src/config.ts`](src/config.ts) | Harness entries, the static Config schema, and default resolution |
| [`src/agent.ts`](src/agent.ts) | `AcpAgent`: session lifecycle, turn driving, update projection, permissions |
| [`src/host.ts`](src/host.ts) | `AcpAgentHost`: registers one harness and binds its runtime into each agent |
| [`src/runtime.ts`](src/runtime.ts) | `AcpRuntime`: one harness's process, connection, CLI verbs, model catalog |
| [`src/connection.ts`](src/connection.ts) | `AcpClientConnection`: handshake, session routing, fatal observation |
| [`src/protocol.ts`](src/protocol.ts) | Stop reasons, tool content, prompt blocks, permission outcomes, config options, session adverts |
| [`src/catalog.ts`](src/catalog.ts) | `AcpCatalogAdapter`: the catalog-only route for one harness id |
| [`src/session-state.ts`](src/session-state.ts) | `agent-acp/session` event and its projection |
| [`src/types.ts`](src/types.ts) | Client-safe account payloads, catalog entries, and Remote error codes |
| [`tests/agent-acp.spec.ts`](tests/agent-acp.spec.ts) | Turn, session, permission, mode, auth, and catalog behavior over the mock ACP agent |
| [`tests/agent-edge.spec.ts`](tests/agent-edge.spec.ts) | Update variants, attachments, refusals, session overrides, and degraded agent responses |
| [`tests/multi-harness.spec.ts`](tests/multi-harness.spec.ts) | Several harnesses in one plugin: routing, resume, auth scope, catalog, and option application |
| [`tests/catalog.spec.ts`](tests/catalog.spec.ts) | Catalog routes: session adverts, config-option fallback, absent catalogs, provider names |
| [`tests/config.spec.ts`](tests/config.spec.ts) | Entry defaults and the loud refusals for an unmountable harness list |
| [`tests/runtime.spec.ts`](tests/runtime.spec.ts) | Runtime lifecycle: mid-handshake disposal, respawn after a dead child, CLI verbs, cancellation |
| [`tests/service.spec.ts`](tests/service.spec.ts) | Mounted harness identities and Remote error normalization |
| [`tests/protocol.spec.ts`](tests/protocol.spec.ts) | Pure wire-helper mapping without a child process |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | The plugin mounts and registers through a real Loader tree |
| — | No runtime invariant companion is published: the durable relations are the `agent-acp/session` fold and the session events the shared projector commits, both asserted by their owning packages. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-agent-external](../agent-external/README.md) — the driver base, inbox, and create/resume/publish transaction this driver builds on.
- [dsh-agent](../agent/README.md) — the harness registry every entry registers into and create/resume dispatch through.
- [dsh-web-acp](../../bundle/web-acp/README.md) — the bundle that runs the browser profile on this driver.
- [dsh-agent-loop](../agent-loop/README.md) — the in-process driver, mounted beside this one as the `dsh` harness.
- [Agent Client Protocol](https://agentclientprotocol.com) — the public protocol specification this driver and every ACP harness speak.
- [Core subsystem](../../../docs/subsystems/core.md) — the `Agent` contract and turn flow a driver implements.

-----

<a id="model-experience"></a>
## Model Experience

### Harness turn

#### What the model sees

The claimed user input is converted to ACP prompt blocks: text passes through, and a file or image attachment with a resolvable host path becomes an ACP `resource_link` block. An attachment whose path cannot be resolved degrades to a `[file: name]` placeholder instead of failing the turn. Everything else the model sees — the harness's prompt, its earlier turns, and its tool definitions — belongs to the harness process, not to dsh.

#### Token effect

dsh contributes only the new user input per turn; the harness pays for its own prompt, history, and tool schemas. Reasoning text the harness streams as `agent_thought_chunk` is recorded in the dsh transcript, but dsh never sends it back, because the harness's own context already holds it.

#### KV Cache effect

The harness owns the request prefix, so dsh can neither guarantee nor measure reuse. Within one ACP session the prefix is append-only while the model and mode stay unchanged; changing either starts a request the previous prefix may not match.

### Session mode and model selection

#### What the model sees

Before each prompt the driver applies the session's selections with `session/set_config_option`: the `model` option carries the durable `model/selection` or the deployment default, the reasoning-effort option carries the session's selected effort, and the `mode` option carries the sandbox and approval knobs. A value the session does not advertise is logged with the value that will actually run, and the durable `request/header` records the harness's own reported model, or `agent-default` when the session advertises no model option.

#### Token effect

No direct token cost. The applied model, mode, and reasoning effort change how much reasoning and tool work the harness performs for the turn.

#### KV Cache effect

A model change replaces the route, so a prefix cached under the previous model is not reused. A mode or reasoning-effort change alone leaves the token prefix intact when the model and history are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this driver is the wrong choice or needs operational care. They are current package constraints, not a task backlog.

- **Devin has no read-only permission mode** — the ACP session modes are `accept-edits`, `smart`, `ask`, `plan`, and `bypass`. None restricts the agent to reading, so a dsh `read-only` sandbox cannot be enforced by Devin; the driver logs a warning naming the mode the session actually runs instead of pretending it applied.
- **A harness may not advertise a mode for the DSH knobs** — opencode and mimocode advertise `build` and `plan`, so the driver applies `build` for a writable session and warns, naming the request and the mode in effect, when only `plan` (or nothing) is offered. A warning is always logged, never a silent skip.
- **Each harness owns the turn, dsh owns the shell** — the loop, prompt, tools, MCP servers, and config live in the harness. DSH keeps the durable session, transcript, approvals, notifications, and model picker; the driver forwards a model selection per turn and reports the harness's own current model.
- **Each harness needs its own login** — sessions need a signed-in CLI per harness (`devin auth login`, `grok login`, …); dsh neither stores nor provisions those credentials.
- **A catalog read may start the harness or its CLI** — with `probeCatalog` left at its default, an entry that has no bound session and no `catalogArgs` opens one throwaway session to read the advert, and an entry with `catalogArgs` runs that CLI verb; both spawn the harness on the first picker read, and the result is then reused for `catalogCacheMs` (a failure for `catalogFailureCacheMs`). Set `probeCatalog: false` for an entry whose process must not start for a catalog read, and the route then lists nothing until a real session binds.
- **The catalog write can fail inside a contained child** — on Linux the local subprocess provider's systemd-scope path leaves the child's stdout non-blocking, so Devin's ~180 KB catalog write can die with `exited 101 ... Resource temporarily unavailable (os error 11)`; the driver reports the CLI's exit code and stderr tail, and the stdio defect belongs to the subprocess provider, not this package.
- **A session resumes only on its recorded harness** — the durable `agent/harness` record routes the resume, and another harness refuses the session instead of replaying a conversation it cannot drive.
- **No mid-turn steering** — ACP carries no steering channel, so `steer()` input stays queued for the next turn instead of reaching the running one.
- **A recorded session cannot resume without `loadSession`** — an agent that does not advertise the capability fails the bind rather than silently starting a fresh session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
