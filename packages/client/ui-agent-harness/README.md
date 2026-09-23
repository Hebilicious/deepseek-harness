---
description: "Agent-harness picker for the Web GUI new-session screen: choose which mounted harness runs a new session, and read back the harness an existing session runs; for users and maintainers of deployments that mount several harnesses."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-harness

English | [中文](README.zh.md)

## Summary

Pick which agent harness runs a new Web GUI session from the harnesses this deployment mounts. Each menu row carries the harness's name and description, and the pick stages the harness the next session is created with. A session that already exists reports the harness it runs, with no switch offered, because another harness cannot continue its conversation. A deployment that mounts fewer than two harnesses renders no control and keeps its create requests unchanged.

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

Mount this plugin alongside the conversation package; the new-session screen receives the `conversation.hero.agentHarness` chip beside the workspace and agent-mode controls. The mounted harnesses come from the host catalog, read when the plugin applies, again on every reconnect, and again each time either surface mounts; a read that fails leaves the chip on the catalog it already had.

### Choosing a harness

Beside the Session title, the same plugin contributes the harness mark: a `HarnessBadge` showing which harness owns the open session, rendered for every session that records one, whether the deployment mounts one harness or several. It carries no control, because the harness is fixed at creation.

The chip names the harness the next session will run and opens a menu of every mounted harness with its own name and description. The first mounted harness is the opening choice, and a pick replaces it at once. The choice is staged on the Session Controller, so the create request the Workspace flow sends carries it: the menu is offered while no session exists, and a deployment that mounts several harnesses refuses a create that names none.

### After the session exists

A session is created with its harness, and the host refuses to hand the conversation to a second harness. A chip rendered for a session therefore shows the harness that session records, disabled, with the harness's own description as its tooltip; a session whose log records no harness renders nothing. That record reaches the browser through the `agentHarness` session projection, which [`dsh-agent`](../../core/agent/README.md) publishes read-only.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One controller (`seat-store.ts`) keeps the catalog and the staged choice in a snapshot store; the chip component is presentation over that store, the standard session seats, and its own locale namespace. The plugin registers the chip through `slots.inject('conversation.hero.agentHarness', ...)`, so the contribution waits for the ui-conversation declaration instead of apply order and leaves with the plugin fiber. The catalog read is `ctx.remote.session.harnessCatalog`, and staging is `ctx.sessions.stageHarness`, which the Session Controller's client applies to the next create that names neither an explicit harness nor a stored identity.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-agent](../../core/agent/README.md) — the harness registry and the durable `agent/harness` record this chip reports.
- [dsh-api-session-controller](../../api/session-controller/README.md) — the `session.harnessCatalog` Remote and the create request that carries the choice.
- [ui-conversation](../ui-conversation/README.md) — the hero row that declares the seat this chip fills.
- [ui-agent-preset](../ui-agent-preset/README.md) — the neighbouring staged choice on the same row.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the agent harness a new session is created with; that harness owns every model-facing effect.

#### KV Cache effect

No direct invalidation. Choosing a harness decides which harness creates the next session; it neither alters a running session's request prefix nor rewrites the harness a stored session records.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current harness surface.

- **The menu needs a session-less screen** — the Workspace flow creates the Session as soon as a workspace is connected, so the picker is offered only while no session is current; a blank Session that already exists reports its recorded harness like any other.
- **Registration order decides the opening choice** — the catalog publishes mounted harnesses in registration order and names no default, so the first mounted harness is both the chip's opening choice and the harness every later new session starts from until a pick replaces it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This is a browser-side surface plugin whose node half owns no event stream or mutable runtime data; the catalog and the staged choice belong to the Session Controller, and the recorded harness belongs to `dsh-agent`.
