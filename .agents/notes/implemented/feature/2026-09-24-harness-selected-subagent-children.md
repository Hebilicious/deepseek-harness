# Agent Note: Harness-selected subagent children replace one-shot product backends

Status: implemented

English | [中文](2026-09-24-harness-selected-subagent-children.zh.md)

## Problem

The subagent seam shipped three one-shot out-of-process providers — `dsh-subagent-acp`, `dsh-subagent-codex`, and `dsh-subagent-claude-code` ([capability-seam Agent Note](2026-06-21-subagent-capability-seam.md), [product-provider Agent Note](../../archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md)). Each owned a private transport, spawned one product process per call, and returned a parent-scoped run with no durable child `Session`: children were invisible in the Web UI, could not be resumed or continued, and each provider duplicated lifecycle, cwd, capability, and diagnostic plumbing.

Two later mechanisms made those providers redundant. `SubagentStartRequest.harness` lets the in-process `spawn` provider create the child through `ctx.agents.create({ harness })` — a normal durable Session under any mounted agent harness, including the Codex app-server and ACP drivers. `agentToolBridge` lets an external harness Session call dsh tools, including `subagent`, so every harness can already delegate to every other harness without a dedicated provider per pair.

## Decision

The three product providers are deleted. The shipped delegation path is one code path: `dsh-tool-subagent` binds the `spawn` provider and exposes the model-facing `harness` parameter; the optional `harnesses` config restricts the offered allowlist, and omitting it offers every mounted harness. A `harness` value that is not mounted rejects at start. The child is a first-class Session with `parentSession` lineage — visible in the Web UI, resumable, and continuable through ordinary Session mechanisms.

`dsh-subagent-dsh-sdk` remains as the process-isolated backend: it drives a separate Harness child process through the TypeScript SDK where memory or crash isolation matters more than shared-process cost.

## Alternatives considered

- **Keep the product providers alongside harness selection.** Three private transports would duplicate semantics the spawn path already covers — durable Sessions, delegated policy pinning, capability rejection — while remaining invisible to the Session UI and unable to continue.
- **Keep them for per-call process isolation.** Process isolation survives through `dsh-subagent-dsh-sdk`; the product providers added nothing isolation-specific beyond it.
- **Keep the ACP client provider for ACP reach.** An ACP child is now an `agent-acp` Session selected through `harness`; external ACP agents reach back through `agentToolBridge` instead of a dedicated client provider.

## Consequences

Delegation costs one provider implementation and one tool row instead of a provider per product; the harness matrix is any-to-any because every mounted harness is selectable and every bridged external Session can itself call `subagent`. Child Sessions gain durability, Web visibility, and continuation for free. Provider-specific options such as Codex child reasoning-effort pinning are covered by `agentOptions.reasoningEffort`, which `spawn` merges into the selected harness's child options.

What was given up: a bespoke provider could pin a product CLI, shape product-specific diagnostics, and isolate each child in a one-shot process; the retained SDK backend covers the isolation case, and product diagnostics now arrive through the generic `SubagentResult.diagnostic` channel. Presets no longer carry disabled product tool rows, and no preset row installs or authenticates an external product — mounting a harness is host-composition work. Routing a harness child's approvals to the parent session remains deferred.

## Testing

Registry and tool tests exercise `harness` validation and the unmounted-harness rejection; `snapshots/session/acp-bridged-subagent` records an external-harness child reaching the `subagent` tool through `agentToolBridge`; `product-subagent-result-diagnostic` keeps deterministic coverage of provider diagnostics through the shared result contract.

A headless real-model pass ran against the `web` profile, plus the Agent Team overlay for the team rows, driving `session/create` then `session/prompt` over the remote RPC and reading durable session logs. A delegated call counts as confirmed when the child session records `agent/harness` with the requested runtime and the child's reply reaches the parent tool result; bridged parents and teammates also log an `agent-tool-bridge/exposed` record listing the tools served at bind, which is the signature to check when an external harness reports a missing delegation or Team tool.

Confirmed `subagent` pairs:

| Parent harness | Child harness | Tool path |
|---|---|---|
| `dsh` | `dsh` | in-process `subagent` |
| `dsh` | `devin` | in-process `subagent` |
| `devin` | `dsh` | bridged `subagent` |
| `codex` | `devin` | bridged `subagent` |
| `codex` | `dsh` | bridged `subagent` |
| `claude` | `dsh` | bridged `subagent` |
| `claude` | `devin` | bridged `subagent` |

Confirmed `spawn_teammate` pairs:

| Lead harness | Teammate harness | Notes |
|---|---|---|
| `dsh` | `dsh` | same-runtime default |
| `devin` | `devin` | teammate exposes the nine Team tools over the bridge |
| `claude` | `claude` | same-runtime default |
| `dsh` | `devin` | cross-harness on the target's default route |
| `devin` | `dsh` | cross-harness with an explicit `provider`/`model` |

Coverage gaps: `grok`, `opencode`, and `mimo` were exercised neither as parent nor child, though they bind through the same `agent-acp` path as the confirmed ACP harnesses; `codex` and `claude` were not exercised as cross-harness team members; a `dsh` child selected from an external parent carries no default route in this profile, so `spawn_teammate` must pass `provider`/`model` or the loop's `{{model}}` assembly rejects the first turn.
