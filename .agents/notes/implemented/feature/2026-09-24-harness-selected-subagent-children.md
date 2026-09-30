# Agent Note: Harness-selected subagent children

Status: implemented

English | [中文](2026-09-24-harness-selected-subagent-children.zh.md)

## Problem

The subagent seam's out-of-process product providers — `dsh-subagent-acp`, `dsh-subagent-codex`, and `dsh-subagent-claude-code` ([capability-seam Agent Note](2026-06-21-subagent-capability-seam.md), [product-provider Agent Note](2026-08-04-claude-code-and-codex-subagent-backends.md)) — each own a private transport, spawn one product process per call, and return a parent-scoped run with no durable child `Session`. Such a child is invisible in the Web UI, cannot be resumed or continued, and each provider repeats lifecycle, cwd, capability, and diagnostic plumbing.

The Agent registry already mounts several agent harnesses — the in-process loop, the Codex app-server driver, and the ACP drivers — and each produces durable Sessions. A delegated child nevertheless always ran under its parent's harness, and an external-harness Session could not call dsh tools, so an external parent could not delegate at all.

## Decision

A fresh child may run under any mounted agent harness. `SubagentStartRequest.harness` names the harness; `SubagentCapabilities.harness` is optional, and an absent flag means unsupported. `spawn` advertises it and creates the child through `ctx.agents.create({ harness })` as a normal durable Session with `parentSession` lineage. `fork` leaves it unset because its parent-history seed only continues under the harness owning the parent log; out-of-process providers leave it unset because their child is not a mounted harness. `ctx.subagents` rejects an unsupported or unmounted choice before any child work, on one-shot and continuable starts alike. Omission keeps the harness owning the parent's session.

`dsh-tool-subagent` exposes a model-facing `harness` parameter when its provider supports the capability and more than one allowed harness is mounted; the optional `harnesses` config narrows the offer, and the tool enforces the allowlist at execution.

Harness resolution has one owner. `AgentRegistry.resolveHarness(harness, 'create' | 'resume')` returns the mounted harness a `create` or `resume` call would land on — the named harness, else for a resume the owner of unrecorded logs, else the sole mounted harness — and the subagent code calls it instead of repeating those fallbacks. `persona`, `toolFilter`, and `outputSchema` install through the loop's scoped composition, so they reject unless the resolved harness declares `AgentHarness.hostsLoopComposition`; the loop harness and `AgentRegistry.setFactory` declare it. A requested provider route that the resolved harness does not serve rejects, and a route the child only inherited from its parent is dropped when an explicit harness choice cannot serve it, so the chosen harness applies its own default. A child on a non-loop harness records `subagent/descriptor` during creation because such a harness emits no `agent/pre-step`. Cold resume reads the child's own `agent/harness` record and refuses when that harness is no longer mounted.

A harness-selected child receives the same delegated permission state as any in-process child: the sandbox override, the approval policy pinned to `never` ([pinned-never Agent Note](2026-08-10-subagent-approval-pinned-never.md)), and the permission preset. The ACP driver maps that state to an agent mode that cannot escape a confined sandbox: a `read-only` sandbox selects `ask` or `plan` under any approval policy; only `never` over `danger-full-access` selects the auto-approve mode (`bypass` or `bypassPermissions`); `never` over `workspace-write` selects the harness's guarded autonomous mode (`auto`, `smart`, or `build`) so a delegated child can run commands; an `ask` session over a writable sandbox selects the edit-accepting mode, where the approval policy answers each remaining ask.

`ctx.agentToolBridge` serves dsh tools to an external-harness Session over an authenticated per-agent MCP endpoint, including `subagent` and the Agent Team tools, so every bridged harness can delegate to every mounted harness. Each bind logs `agent-tool-bridge/exposed` with the served tool names.

The external-harness creation transaction in `dsh-agent-external` orders its steps so the bridge sees scoped tools. The ACP and Codex hosts set `announceBeforeBind`; the in-process loop, whose bind snapshots nothing, keeps binding before it enters and announces with live dispatch. For an `announceBeforeBind` host, after caller setup the host records `agent/harness`, enters the Session with `SessionStore.enter(session, { deferPublication: true })`, announces `session/created`, and awaits the `agent/created` listeners, which install the agent's scoped delegation and Team tools. Only then does `bind()` send `session/new` or `thread/start`, whose tool snapshot therefore includes those tools. The deferred entry holds `session/event` dispatch. After a successful bind the host stores the log below store entry through the write handle and calls `SessionStore.publish(session)`, which dispatches every held append in log order to all observers; persistence writes them through its live path. A rolled-back bind never dispatches the held appends, so a refused handshake leaves nothing stored or observed and the session id stays reusable. `SessionStore.flush()` on a deferred entry waits for publication, so a checkpoint taken while the handshake runs covers the held appends.

Harness-selected children are the recommended delegation path to external products. The one-shot product providers remain available: the web-app presets mount the `subagent_codex` and `subagent_claude_code` tool rows with `disabled: true`, and `dsh-subagent-acp` is available to compositions that mount it. `dsh-subagent-dsh-sdk` remains the process-isolated backend: it drives a separate Harness child process through the TypeScript SDK where memory or crash isolation matters more than shared-process cost.

## Alternatives considered

- **Delete the one-shot product providers.** A deployment that has not mounted the product as a harness, or that depends on a pinned product CLI, product-specific diagnostics, or a one-shot process per call, would lose its route; keeping them disabled by default costs one tool row each.
- **A dedicated provider per harness pair.** Each pair would duplicate the durable-Session, policy-pinning, and capability-rejection semantics that `spawn` already provides, and would stay invisible to the Session UI.
- **Run `agent/created` after `bind()`.** The handshake snapshots the tool set, so scoped tools installed afterward would never reach `session/new` or `thread/start`.
- **Publish the Session before `bind()`.** Observers and persistence would see creation events for a handshake that may still be refused, leaving residue the rollback cannot retract; deferred publication keeps observation behind the commit point.
- **Compare against a fixed loop harness id.** A harness registered under another id could not declare that it hosts the loop composition; `hostsLoopComposition` makes the harness state it.

## Consequences

Delegation to any mounted harness costs one provider implementation and one tool row; the harness matrix is any-to-any because every mounted harness is selectable and every bridged external Session can call `subagent` itself. Harness-selected children gain durability, Web visibility, and continuation through ordinary Session mechanisms. A harness-selected child's reasoning effort goes through `agentOptions.reasoningEffort`, which `spawn` merges into the selected harness's child options.

What is given up: a harness-selected child's Session and driver live in the parent's Harness process, so `dsh-subagent-dsh-sdk` stays the choice for isolation; loop-only options are unavailable on external harnesses; a continuable child whose harness is unmounted cannot cold-resume; and `session/event` observers receive creation-window appends at publication rather than as each append commits. Presets do not install or authenticate external products — mounting a harness is host-composition work. Routing a harness child's approvals to the parent session remains deferred.

## Testing

`packages/subagent/subagent/tests/service.spec.ts` covers the capability and unmounted-harness rejections; `continuation-inheritance.spec.ts` covers loop-only option rejection, seeded-child ownership, and cold resume on the child's recorded harness, including its refusal when that harness is unmounted; `packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts` covers route compatibility and the dropped inherited route; `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` covers the `harness` parameter, the `harnesses` allowlist, and schema rebuilds. `packages/core/agent/tests/harness.spec.ts` covers `resolveHarness`. `packages/core/session/tests/session.spec.ts` covers held dispatch, in-order publication, and a rolled-back deferred entry that never dispatches. `packages/core/agent-acp/tests/tool-bridge.spec.ts` covers `agent/created`-scoped tools reaching the handshake snapshot, and `agent-acp.spec.ts` covers the mode mapping. `snapshots/session/acp-bridged-subagent` records an external-harness parent reaching the `subagent` tool through `agentToolBridge`.

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
