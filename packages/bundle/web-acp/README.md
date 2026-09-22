---
description: "The dsh browser profile driven by Devin: the same GUI and core as dsh-web-app with a shared `devin acp` process serving every session over the Agent Client Protocol."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-acp

English | [中文](README.zh.md)

## Summary

Run `dsh --profile web-acp` to get the same browser GUI as `dsh --profile web`, with every session bound to its own ACP session on a shared `devin acp` process. The layer stacks over [`dsh-base`](../base/README.md) and [`dsh-web-app`](../web-app/README.md), disables the in-process agent loop, and inserts the ACP driver. Devin then owns the loop, prompt, tools, MCP servers, and config, while dsh keeps the session, transcript, approvals, notifications, and model picker. You need a logged-in Devin CLI, and one profile runs one driver.

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

### Start the profile

```sh
dsh --profile web-acp
```

The `web-acp` profile template ships with dsh and stacks `dsh-base`, `dsh-web-app`, and this bundle in that order. Startup, the printed URL line, the browser handoff, and the GUI itself behave exactly as [`dsh-web-app`](../web-app/README.md) describes; only the driver behind each session differs.

### Install into another profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-web-acp
dsh plugin --profile <name> remove @deepseek-ai/dsh-web-acp
```

In-box bundles resolve from the dsh installation; the launcher activates this layer for the profile because the package declares `dsh.bundle.patch`. The layer expects the profile to already contain the rows it patches, so add it after `dsh-base` and `dsh-web-app`.

### What the layer changes

| Target row | Change |
|---|---|
| `agent-loop` | Disabled, because `ctx.agents.setFactory()` accepts exactly one factory and the ACP driver takes that slot |
| `agent-default-model` | `provider: devin`, `model: ''`, so a new session carries no model until the picker or a `model/selection` chooses one |
| `session-title-llm` | Pinned to `deepseek-official` / `deepseek-flash`, because the session's logged route is the catalog-only `devin` adapter, which serves no streams |
| `agent-acp` | Inserted: one shared `devin acp` process per profile, one ACP session per session |

The driver's own contract, configuration, and limitations live in [`dsh-agent-acp`](../../core/agent-acp/README.md).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Patch semantics

A patch replaces the targeted row's whole `config`, and an `insert` list appends new rows. This bundle therefore states only what it owns: two id-targeted overrides, one disable, and one inserted row. The profile's own `cordis.patch.yml`, the home-level patch, and any `--patch` overlay still apply after this layer, so a deployment can repoint the driver's executable, sandbox, or approval policy without editing the bundle.

### Why the loop leaves the composition

`AgentRegistry.setFactory()` throws `an agent factory is already registered` on a second registration. Both `dsh-agent-loop` and `dsh-agent-acp` register themselves as that factory, so the profile composes exactly one of them: this layer disables the base's `agent-loop` row and inserts the driver.

### Why the title request moves

`dsh-session-title-first-prompt-llm` resolves the session's logged route. In this profile that route is the `devin` provider, which is a catalog-only adapter whose `stream()` always throws. The layer pins the title row to the DeepSeek route the base mounts, so session titles keep working while sessions themselves run on Devin.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The whole layer: the disable, the two overrides, and the driver insert |
| [`src/index.ts`](src/index.ts) | Module marker only; the package carries no runtime API |
| [`packages/boot/app-boot/src/profile.ts`](../../boot/app-boot/src/profile.ts) | The `web-acp` profile template that stacks this bundle |

</details>

**Runtime invariant:** No companion is published because this bundle is a patch layer: it disables the `agent-loop` row, points the default model and title route at the Devin driver, and inserts the driver row. The driver package owns the lifecycle and protocol invariants, and the bundle holds no mutable relation of its own to check.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-agent-acp](../../core/agent-acp/README.md) — the driver this layer mounts, its configuration, and its limitations.
- [dsh-web-app](../web-app/README.md) — the browser surface this layer builds on.
- [dsh-base](../base/README.md) — the shared core every base-backed profile starts from.
- [Bundle package map](../README.md) — the surfaces built on the same core.
- [Profile plugin bundles](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md) — the profile and bundle composition design.

-----

<a id="model-experience"></a>
## Model Experience

### Devin-driven session turns

#### What the model sees

Each session's turns run inside Devin, so the model sees Devin's own prompt, history, and tool definitions rather than the dsh ones the base composes. dsh contributes the user input the session claims, plus the durable transcript it projects from Devin's ACP session updates.

#### Token effect

The base's prompt sections and tool schemas no longer reach the model, so their per-step cost disappears. Devin pays for its own prompt and tools instead, and the session's applied mode and model change how much work it does per turn.

#### KV Cache effect

Devin owns the request prefix, so dsh can neither guarantee nor measure reuse. A model change starts a request the previous prefix may not match; a mode-only change leaves the prefix intact while the model and history stay unchanged.

### Session title request

#### What the model sees

The first-prompt title provider sends one small request carrying the session's opening user message and a word-count instruction. This layer pins that request to `deepseek-official` / `deepseek-flash`, so it never resolves the catalog-only `devin` route.

#### Token effect

One bounded title request per session: at most 4096 input bytes and 64 output tokens, with a 60000 ms timeout.

#### KV Cache effect

Independent of the session's Devin turns; the title request has its own short prompt and does not reuse or invalidate the session prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this profile is the wrong choice or needs operational care. They are current package constraints, not a task backlog.

- **The profile runs one driver** — `ctx.agents.setFactory()` accepts exactly one factory, so this layer disables `agent-loop` for the whole profile instead of composing the in-process loop beside Devin.
- **A read-only expectation cannot be enforced** — the ACP session modes Devin advertises (`accept-edits`, `smart`, `ask`, `plan`, `bypass`) express approval behavior only, so a session that logs a `read-only` sandbox still runs a mode that can edit; the driver logs a warning naming the mode it actually runs.
- **Devin owns the turn, dsh owns the shell** — the loop, prompt, tools, MCP servers, and config live in Devin; dsh keeps the durable session, transcript, approvals, notifications, and model picker, and forwards the picker's selection per turn.
- **A Devin login is required and not provided** — the driver cannot serve sessions until `devin auth login` has run for the account the CLI uses; dsh neither stores nor provisions Devin credentials.
- **The model picker depends on the CLI** — entries come from `devin models list --format json`, so an unreachable, unauthenticated, or slow CLI leaves the picker empty.
- **Titles stay on the DeepSeek route** — the layer pins `session-title-llm` to `deepseek-official` / `deepseek-flash`; a deployment that removes or renames that route must repoint the row, because the `devin` route serves no streams.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
