---
description: "The dsh browser profile where one GUI offers every agent harness: the in-process loop, Codex, and the configured ACP harnesses, chosen per session."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-harnesses

English | [中文](README.zh.md)

## Summary

Run `dsh web` and choose, for each session, which agent harness runs it. The layer stacks over [`dsh-base`](../base/README.md) and [`dsh-web-app`](../web-app/README.md), leaves the in-process agent loop mounted as the `dsh` harness, and adds the Codex driver plus one ACP driver entry per configured harness: Devin, Grok Build, opencode, mimocode, and Claude Code. Each harness keeps its own loop, prompt, tools, MCP servers, and config, while dsh keeps the session, transcript, approvals, notifications, and model picker. Every harness must be installed and signed in on the machine, and each one spawns its own process.

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
dsh web
```

The `web` profile template ships with dsh and stacks `dsh-base`, `dsh-web-app`, and this bundle in that order, so the harness picker is part of the ordinary browser surface. The `web-harnesses` template names the same three bundles for a home whose `web` profile was initialized before this layer existed.

### Install into another profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-web-harnesses
dsh plugin --profile <name> remove @deepseek-ai/dsh-web-harnesses
```

In-box bundles resolve from the dsh installation; the launcher activates this layer for the profile because the package declares `dsh.bundle.patch`. The layer expects the profile to already contain the rows it patches, so add it after `dsh-base` and `dsh-web-app`. A profile that mounts a single-harness bundle such as `dsh-web-codex` must not also mount this one, because that bundle disables the `agent-loop` row this layer keeps.

### What the layer changes

| Target row | Change |
|---|---|
| `agent-default-model` | `provider: ''`, `model: ''`: a deployment default belongs to one harness's catalog route, so no session carries one until the picker or a `model/selection` chooses it |
| `session-title-llm` | Pinned to `deepseek-official` / `deepseek-flash`, because a session's logged route is a catalog-only adapter for external harnesses and serves no streams |
| `agent-codex` | Inserted: one shared app-server per profile, one Codex thread per session |
| `agent-acp` | Inserted with five harness entries, one process each: `devin`, `grok`, `opencode`, `mimo`, `claude`; `opencode` runs one process per session (`processPerSession`) because it keeps MCP servers process-wide |
| `agent-tool-bridge` | Inserted: serves the session's scoped dsh tools to external harnesses over one authenticated loopback MCP endpoint per agent, excluding names every harness has natively or only the in-process loop can drive |

The harness rows themselves are ordinary profile configuration. Repoint, add, or remove an ACP entry in the profile's own `cordis.patch.yml`, and the picker follows the mounted set.

### Claude Code runs through an adapter

Claude Code speaks no Agent Client Protocol of its own, so the `claude` entry runs the [Agent Client Protocol project's adapter](https://github.com/agentclientprotocol/claude-agent-acp) and that adapter drives the `claude` CLI underneath. The entry pins the adapter version and resolves it with `npx`; a machine that installs it globally replaces both fields with `executable: claude-agent-acp` and no args. The adapter reports authorization through its ACP methods rather than a CLI verb, which is why both verb lists are empty, and the `claude` binary must be on the serving process's `PATH`.

The driver contracts, configuration, and limitations live in [`dsh-agent-codex`](../../core/agent-codex/README.md) and [`dsh-agent-acp`](../../core/agent-acp/README.md).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Patch semantics

A patch replaces the targeted row's whole `config`, and an `insert` list appends new rows. This bundle therefore states only what it owns: two id-targeted overrides and three inserted rows. The profile's own `cordis.patch.yml`, the home-level patch, and any `--patch` overlay still apply after this layer, so a deployment can add a harness, repoint an executable, or change a sandbox policy without editing the bundle.

### Why several harnesses coexist here

Each driver registers its factory through `ctx.agents.registerHarness({ id, name, factory })`, and the in-process loop registers the `dsh` harness the same way, so one process holds one factory per harness id. `session.create` names the harness, the owning factory records it as an `agent/harness` event inside the pre-publication suffix, and `resume` routes through that record. A request naming a harness this deployment does not mount fails with the mounted ids listed instead of falling back to another one.

### Why the title request moves

`dsh-session-title-first-prompt-llm` resolves the session's logged route. For an external harness that route is a catalog-only adapter whose `stream()` always throws, so the layer pins the title row to the DeepSeek route the base mounts: titles keep working whichever harness ran the turn.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The whole layer: the two overrides and the inserted bridge and driver rows |
| [`src/index.ts`](src/index.ts) | Module marker only; the package carries no runtime API |
| [`packages/boot/app-boot/src/profile.ts`](../../boot/app-boot/src/profile.ts) | The `web` and `web-harnesses` profile templates that stack this bundle |

</details>

**Runtime invariant:** No companion is published because this bundle is a patch layer: it points the default model and title route at harness-neutral values and inserts the driver rows. The driver packages own the lifecycle and protocol invariants, and the bundle holds no mutable relation of its own to check.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-agent-acp](../../core/agent-acp/README.md) — the ACP driver this layer mounts for Devin, Grok Build, opencode, and mimocode.
- [dsh-agent-codex](../../core/agent-codex/README.md) — the Codex app-server driver this layer mounts.
- [dsh-agent-tool-bridge](../../core/agent-tool-bridge/README.md) — the loopback MCP bridge serving scoped dsh tools to the mounted external harnesses.
- [dsh-agent](../../core/agent/README.md) — the harness registry every driver registers with.
- [dsh-web-app](../web-app/README.md) — the browser surface this layer builds on.
- [Bundle package map](../README.md) — the surfaces built on the same core.

-----

<a id="model-experience"></a>
## Model Experience

### Harness-owned session turns

#### What the model sees

Each session's turns run inside the harness the user chose. For the `dsh` harness that is the base's own loop, prompt, and tools; for every other harness it is that harness's prompt, history, and tool definitions, and dsh contributes the user input the session claims plus the durable transcript projected from the harness's streamed items.

#### Token effect

A session on an external harness no longer pays for the base's prompt sections and tool schemas; that harness pays for its own. Model and reasoning-effort choices are per session and per harness, so the same prompt costs different amounts depending on who runs it.

#### KV Cache effect

The harness owns the request prefix, so dsh can neither guarantee nor measure reuse for external sessions. Changing harness, model, or reasoning effort, or starting a fresh harness-side conversation after an unresumable one, produces a request the previous prefix may not match.

### Session title request

#### What the model sees

The first-prompt title provider sends one small request carrying the session's opening user message and a word-count instruction. This layer pins that request to `deepseek-official` / `deepseek-flash`, so it never resolves a catalog-only harness route.

#### Token effect

One bounded title request per session: at most 4096 input bytes and 64 output tokens, with a 60000 ms timeout.

#### KV Cache effect

Independent of the session's harness turns; the title request has its own short prompt and does not reuse or invalidate the session prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this profile is the wrong choice or needs operational care. They are current package constraints, not a task backlog.

- **The profile ships no deployment model default** — a default belongs to one harness's catalog route, so this layer clears it. A session on the in-process `dsh` harness needs a model chosen in the picker before its first turn, while an external harness applies its own default until the session records a `model/selection`.
- **Every external harness is a separate program** — Codex and each ACP entry spawn their own process: the app-server when its first session binds, an ACP harness when its first session binds or when the model picker first asks for its catalog. Each executable must be installed, signed in, and reachable by name or absolute path from the serving process, which for mimocode usually means adding its install directory to `PATH` and for Claude Code means having both `claude` and a resolvable adapter.
- **Claude Code depends on a third-party adapter** — the `claude` entry runs `@agentclientprotocol/claude-agent-acp`, pinned in this bundle and fetched with `npx` on first use, so that harness needs network access until the adapter is cached and needs the adapter kept in step with the `claude` CLI it drives. Anthropic ships no ACP mode, and the adapter is the only supported path in this bundle. Because the catalog probe is on by default, the first model-picker read in a fresh install resolves and starts that adapter; a deployment that must not run it until a Claude session is chosen sets `probeCatalog: false` on the entry and installs the adapter globally with `executable: claude-agent-acp` and no args.
- **One session belongs to one harness** — the recorded `agent/harness` event fixes it at creation. Resuming a session under a different harness is refused, because another harness cannot continue that conversation.
- **A session that records no harness resumes on the loop** — a log written before the `agent/harness` record existed was driven by the in-process loop, so opening or forking it continues on `dsh` and records that harness from then on. A session that records a harness this profile does not mount stays refused.
- **Approvals and sandbox policy stay per harness** — each ACP entry carries its own `sandbox` and `approval` defaults, and a harness that offers no read-only mode cannot honor a read-only expectation; the driver logs the mode actually in effect.
- **Model catalogs come from the harness** — entries are read from the bound session's own advertisement or the configured catalog command, so an unreachable or broken harness executable leaves its group empty in the picker.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
