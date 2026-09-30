---
description: "The shared base for writing agent drivers in dsh: durable inbox, turn and step boundaries, the create/resume/publish transaction, and managed harness processes."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-external

English | [中文](README.zh.md)

## Summary

Write an agent driver that reuses every session-facing behavior dsh already defines: the durable inbox, phase machine, cancellation, turn and step boundaries, the create/resume/publish transaction, and the proven teardown of a spawned harness process. Extend `ManagedAgent` to keep your own step loop, or extend `ExternalAgent` with `ExternalAgentHost` to hand the inside of a turn to a foreign harness process. The consumers are [`dsh-agent-loop`](../agent-loop/README.md), [`dsh-agent-codex`](../agent-codex/README.md), and [`dsh-agent-acp`](../agent-acp/README.md). Reach for this package to add a driver; mounting it by itself registers nothing.

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

### When to use it

Every driver in dsh extends this package instead of reimplementing the session shell. `dsh-agent-loop` extends `ManagedAgent` and keeps its own step loop; `dsh-agent-codex` and `dsh-agent-acp` extend `ExternalAgent` so a Codex account or the Devin CLI owns the loop, prompt, tools, MCP servers, and config. Choose `ManagedAgent` when your driver calls `ctx.llm` and `ctx.tools` itself, and `ExternalAgent` plus `ExternalAgentHost` when the model work happens in another process over a wire protocol.

A driver registers itself as one agent harness: `AgentRegistry.registerHarness({ id, name, factory })` keys each registration by harness id, so several drivers coexist in one process and `session.create`/`resume` name the harness that owns each session. `ctx.agents.setFactory()` remains for a deployment that mounts one factory under the built-in `dsh` id; every in-tree driver registers with `registerHarness` instead.

### Entry point

Subclass one of the two agent shapes and, for an external harness, the host that constructs it.

```text
import { ExternalAgent, ExternalAgentHost, type ExternalTurnDrive } from '@deepseek-ai/dsh-agent-external'

class MyAgent extends ExternalAgent {
  async bind(signal: AbortSignal): Promise<void> { /* open the harness conversation */ }
  async unbind(): Promise<void> { /* release it while the process is still alive */ }
  protected async driveTurn(messages: readonly UserMessage[], drive: ExternalTurnDrive): Promise<TurnEndReason> {
    drive.projector.noteRoute({ provider: 'my-harness', model: 'current' })
    // stream harness output through drive.projector, then report the ending
    return { kind: 'completed' }
  }
  protected steerLive(): Promise<boolean> { return Promise.resolve(false) }
  protected interruptTurn(_drive: ExternalTurnDrive): Promise<void> { return Promise.resolve() }
}

class MyHost extends ExternalAgentHost<MyAgent> {
  protected constructAgent(hostCtx, id, options, session): MyAgent {
    return new MyAgent(hostCtx, id, options, session)
  }
}
```

Constructing `MyHost` inside a service constructor registers the `turnBoundary` projection, the factory-owned lifecycle teardown, and the factory slot itself, all effect-scoped to that service's fiber. Both creation announcements run before `bind()` — `session/created` then `agent/created`, whose scoped composition listeners install the agent's tools before the handshake snapshots them — while the session's `session/event` dispatch stays held, so a rejected handshake rolls the creation back with nothing stored or observed and the session id stays reusable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The package splits one agent into a session-facing half and a harness-facing half. `ManagedAgent` owns everything the session sees: the durable inbox, the activity phase machine, wake latching, maintenance exclusion, cooperative cancellation, and the `turn/start` … `turn/end` skeleton around one `runTurnBody()` call. `ExternalAgent` adds the harness surface on top: a foreign turn opens at step 1 and the driver calls `drive.nextStep()` at each new harness model response, so the log carries one assistant message and its tool calls per step as the in-process loop writes it, live steering and injection reach the harness through the driver's own verbs, and the model route comes from the durable selection fold. A driver that receives harness output while idle reports it with `hasUnpromptedHarnessWork` and projects it from `driveUnpromptedTurn`; an empty inbox claim then opens a turn with no user message instead of stopping. A wake signaled while the driver is still running is latched and opens that turn after the driver goes idle. A next-step inject queued without a wake stays pending until that turn ends; a waking steer is claimed ahead of it. `ExternalAgentHost` owns the lifecycle every driver shares, so a driver implementation contains protocol translation only.

### Lifecycle transaction

`createAgent()` prepares a private session, takes durable write ownership through `persistence.create()` when a backend is mounted, constructs the driver on the owner's fiber, and runs caller setup. A host constructed without `announceBeforeBind` — the in-process loop — then calls `bind()`, appends `agent/harness`, stores the unstored log, and enters and announces both registries with live dispatch. A host with `announceBeforeBind` — the ACP and Codex drivers, whose handshake snapshots the tool set — instead appends `agent/harness`, enters both registries — the session through `SessionStore.enter(session, { deferPublication: true })`, which holds its `session/event` dispatch — announces `session/created`, and awaits the serial `agent/created` listeners, so tools they install reach the `bind()` handshake. After `bind()` succeeds, the host stores the log below store entry through the write handle and calls `SessionStore.publish()`, which dispatches every held append in log order to all observers; persistence writes those appends through its live path. `resume()` opens the write handle first — which excludes a concurrent resume of the same id — reads the physically valid log, appends `interruptedTurnClosers`, and runs the same path with source `resume`. Any failure, cancellation, or owner disposal rolls the transaction back without dispatching the held appends — a bind failure disposes the announced pair, pairing `agent/disposed` with `session/disposed` — and the shared teardown is memoized: stop the driver, `unbind()`, unwind the agent scope, drain and close the write handle, then detach both registries.

### Durable inbox and projections

`DurableAgentInbox` stores pending input in the session log: every mutation commits one `agent/inbox/spliced` event and publishes `agent/inbox/inserted`, `agent/inbox/claimed`, or `agent/inbox/discarded`, so a claim survives restart and replay. The host registers `turnBoundary` (open turn, last step boundary, last turn) and, unless the driver opts out, `externalModelSelection`, the fold of the durable `model/selection` records the picker writes. `dsh-agent-loop` opts out because it reads selection through the session controller's own fold.

### Turn projection

`ExternalTurnProjector` is the one place harness observations become durable events: `beginAssistant()` opens a streamed attempt that emits `agent/assistant-stream` frames and settles as `assistant/message` or the log-only `assistant/attempt`, `toolCall()`/`toolResult()` commit pairs, and `noteRoute()` logs `request/header` when the reported route changes. Every `toolCall()` first advertises its `tool-call` block on a committed `assistant/message` — folded into the attempt still streaming, which settles with `finish: tool-calls`, or a standalone single-block message when no attempt is open — so every external call keeps the advertised-lifecycle durable shape a dsh-loop call produces. When a mounted [`agentToolBridge`](../agent-tool-bridge/README.md) resolves the reported tool name — or the `alias` a harness carries separately, such as Devin's `_meta` canonical name — the call logs under the dsh tool name and its result picks up the settled bridged execution's `meta`; unrecognized names log verbatim.

### Harness process

`ExternalHarnessProcess.spawn()` resolves the executable through `ctx.subprocess`, spawns it with piped stdio and a bounded stderr tail, and rejects when the provider returns no pipe. `dispose()` ends stdin to give the child a window to flush its own persistence, then escalates through `terminate()` and waits for the whole managed range to exit; it throws what the seam could not reap instead of reporting a clean stop.

### Source map

| File | Role |
|---|---|
| [`src/base.ts`](src/base.ts) | `ManagedAgent`: inbox, phase machine, cancellation, maintenance exclusion, turn skeleton |
| [`src/agent.ts`](src/agent.ts) | `ExternalAgent`: multi-step foreign turns, live steering and injection, `HARNESS_DEFAULT_MODEL` route marker |
| [`src/host.ts`](src/host.ts) | `ExternalAgentHost`: create/resume/publish transaction, registrations, reverse teardown |
| [`src/lifecycle.ts`](src/lifecycle.ts) | `FactoryOwnership`, abort races, agent-option validation |
| [`src/inbox.ts`](src/inbox.ts) | `DurableAgentInbox` and the `inbox` projection |
| [`src/turn-boundary.ts`](src/turn-boundary.ts) | The shared `turnBoundary` projection |
| [`src/model-selection.ts`](src/model-selection.ts) | The `externalModelSelection` fold |
| [`src/projector.ts`](src/projector.ts) | `ExternalTurnProjector`: assistant streams, tool pairs, route logging |
| [`src/assistant-stream.ts`](src/assistant-stream.ts) | `AssistantStreamAttempt`: live frames plus the durable compact stream |
| [`src/process.ts`](src/process.ts) | `ExternalHarnessProcess`: spawn, stderr tail, teardown ladder |
| [`tests/agent-external.spec.ts`](tests/agent-external.spec.ts) | Lifecycle, teardown, and abort races over the fake drivers |
| [`tests/inbox.spec.ts`](tests/inbox.spec.ts) | Durable inbox commands and replay |
| — | No runtime invariant companion is published: every contribution is a registry-disposed effect, and the durable relations it folds are asserted by the owning session and projection packages. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-agent-loop](../agent-loop/README.md) — the in-process driver that extends `ManagedAgent` and mounts this host as `LoopAgentHost`.
- [dsh-agent-codex](../agent-codex/README.md) — a driver over the Codex app-server JSON-RPC protocol.
- [dsh-agent-acp](../agent-acp/README.md) — a driver over the Agent Client Protocol.
- [agent package](../agent/README.md) — the public `Agent` contract, registry, and `agent/*` events this base implements.
- [Core subsystem](../../../docs/subsystems/core.md) — turn flow, projection seam, and cancellation decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Per-turn model selection

#### What the model sees

Each turn's driver reads `currentSelection()`, the newest durable `model/selection` for the session, and forwards the resolved provider, model, and reasoning effort to its own harness. The base never writes a request itself; the driver decides which harness call carries them.

#### Token effect

No direct token cost. The selection changes which model serves the turn, and reasoning effort on the harness side can change how many thinking tokens are spent.

#### KV Cache effect

A selection change replaces the model route, so a previously cached prefix under the old route is not reused. Repeated turns under one route stay append-only.

### Durable route record

#### What the model sees

`ExternalTurnProjector.noteRoute()` logs a durable `request/header` carrying the provider and model the turn really used. When a harness never reports its model, the driver records `HARNESS_DEFAULT_MODEL` (`agent-default`) rather than an empty or invented id, so the transcript stays honest about who chose the model.

#### Token effect

One header event per route change; the header itself is not sent to a model.

#### KV Cache effect

None. The logged header describes the request without altering its token sequence.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this base does not decide for a driver. They are current package constraints, not a task backlog.

- **One harness owns each session** — the session records its harness as an `agent/harness` event, and a resume under a different harness is refused, so a conversation cannot move between drivers; a profile that mounts several drivers chooses the harness at creation instead.
- **The harness owns the turn** — for an `ExternalAgent`, the loop, prompt, tools, MCP servers, and config live in the foreign process. DSH keeps the durable session, transcript, approvals, notifications, and model picker; the driver forwards a model selection per turn and reports the harness's own current model.
- **Harness credentials are outside DSH** — Codex sessions need a Codex account (`CODEX_HOME`, `codex login`) and Devin sessions need `devin auth login`; DSH neither stores nor provisions either one.
- **Model catalogs come from the harness** — a driver that feeds its picker from a CLI call has no entries while that CLI is unreachable or slow.
- **No invariant companion is published** — the package owns no event sequence or mutable relation beyond what the session log and the projection registry already assert.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
