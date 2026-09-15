# Spec: Grok Build driver for the DSH Web UI

Sessions created in the DSH Web UI run **Grok Build** as the agent: that harness's own loop, prompt, tools, MCP servers, skills, hooks, sandbox, and config. DSH stays the shell: session create/resume, transcript, approvals, notifications, model picker.

The user-visible outcome is Grok Build in the browser, not in the Grok CLI or TUI.

This is the Grok counterpart of the Codex / Devin foreign-harness spec on `heb` (`spec.md` there). Same shell, different harness. Do not land both drivers in one profile: `setFactory` throws on a second registration.

Non-goals v1: DSH tools inside Grok sessions, DSH loop plugins (compaction, goal, plan, guard, delegation) for those sessions, editing `~/.grok/config.toml` from DSH, sharing a Grok leader with an interactive TUI, more than one account per process.

## 1. Architecture

- One driver package registering an `AgentFactory` through `ctx.agents.setFactory`:
  - `packages/core/agent-grok` → `@deepseek-ai/dsh-agent-grok`
- Shared core `packages/core/agent-external` (extract, do not duplicate): session-event projection, agent creation/publication bookkeeping, process lifecycle.
  - Creation bookkeeping lives in `agent-loop` (`src/agent.ts`; `agent/session-start` at `src/index.ts:675`). Factor it; `pnpm run duplication` gates clones.
  - `assistant/message.stream` needs the loop's stream record builder. Extract it if loop-private.
  - If the Codex/Devin work lands `agent-external` first, import it; do not fork the extraction.
- `setFactory` throws on a second registration, so the profile mounts this driver and must omit the `agent-loop` row (`packages/bundle/base/cordis.patch.yml:478`). Add a profile bundle overlaying `web-app`.
- No client or `api-session-controller` change: both program against `ctx.agents` and session persistence, and all UI rendering derives from session events.

### Harness ownership

DSH is a rich ACP **client** for Grok Build, never the loop. The agent loop, prompt, tool schemas, permission policy, MCP, skills, hooks, sandbox, and `~/.grok` configuration belong to Grok; DSH supplies session create/resume, transcript projection, approvals, and notifications.

ACP is a client/agent protocol, not a harness. `grok agent stdio` is Grok's own process running Grok's loop; ACP carries prompts, session updates, permission requests, and control ([ACP overview](https://agentclientprotocol.com/protocol/v1/overview); Grok documents the stdio server, `session/new`, `session/load`, `session/prompt`, `session/set_config_option`, and `x.ai/*` extensions in its agent-mode guide).

`packages/acp` is the opposite direction: DSH as an ACP **server** for automation clients. This driver does not use it. The matching client precedent is `packages/subagent/subagent-acp`, which already speaks ACP over stdio.

The one place DSH could leak into the harness is optional ACP client capabilities. Grok's own TypeScript example advertises `fs` and `terminal` on `initialize`. Advertising them would route file and command execution through DSH instead of Grok Build. Answer `initialize` with `clientCapabilities: {}`, exactly as `subagent-acp` does today (`packages/subagent/subagent-acp/src/run.ts:488`: "the child self-serves in its own process").

Rejected alternatives:

- Pointing a DSH LLM provider at `api.x.ai` / the CLI chat proxy. That keeps the DSH loop and drops Grok Build's tools, MCP, skills, and sandbox.
- Embedding the Grok TUI, or driving it with tmux/PTY scraping.
- `grok -p` headless as the session driver. It is one-shot, has no approval stream, and is a subagent-provider shape, not a Web UI session.
- `grok agent --leader` against the user's interactive leader socket. Web sessions would share process state with the TUI.
- Passing DSH MCP servers on `session/new` in v1. That injects DSH tools into Grok's loop.

## 2. Grok Build driver

One `grok agent --no-leader stdio` per profile, spawned through the subprocess seam with a credential-scrubbed environment. Default `GROK_HOME` is the user's `~/.grok` so login, MCP, skills, and hooks already on the machine keep working; an explicit `GROK_HOME` is a Config field for isolation. Teardown proves managed-range quiescence. Do not join `~/.grok/leader.sock`.

Reuse the ACP JSON-RPC client already used by `subagent-acp`; do not fork it. Grok-specific methods live in this package.

| DSH | Grok ACP |
|---|---|
| `createAgent` | `initialize`, `session/new` (`cwd` from the workspace, `mcpServers: []`) |
| `resume` | `session/load` (fail loud when Grok no longer has the session) |
| `followup` | `session/prompt` |
| `steer` | `session/prompt` (Grok queues an in-flight prompt; there is no Codex-style `turn/steer`) |
| `inject` | unsupported in v1; fail loud |
| `cancel` | `session/cancel` |
| `dispose` | `session/cancel` if a prompt is in flight, then process teardown |

`session/new` takes `cwd` from the workspace. Model and effort from `AgentOptions` are applied after create via ACP `session/set_config_option` (`configId: model` and `configId: reasoning_effort`); process-level `--model` / `--reasoning-effort` are only the profile default before the first session. Record the Grok session id (UUIDv7 under `GROK_HOME/sessions`) in a plugin-owned session event.

Permission mode is Grok-owned. The interactive Web profile starts Grok **without** `--always-approve`. Map the DSH approval policy:

| DSH `ctx.approval` policy | Grok |
|---|---|
| `ask` (default) | default ask; ACP permission requests answer through the DSH approval seam |
| `never` | `_meta.yoloMode: true` on `session/new` (Grok `bypassPermissions` / always-approve) |

Do not pass `autoMode` unless a later profile field names it. Deny rules and hooks stay in `~/.grok`; DSH does not rewrite them.

Projection (names from `packages/core/session/src/types.ts`):

| Grok ACP `session/update` | Session event |
|---|---|
| prompt | `turn/start` + `user/message` |
| `agent_message_chunk` | `assistant/message` (`stream`, `usage` when Grok reports it) |
| `agent_thought_chunk` | reasoning blocks in `assistant/message` |
| `tool_call` / `tool_call_update` | `tool/call` + `tool/result`; presenter or generic card |
| `plan` | ignored as a DSH plan-mode session; render as a generic card or assistant text so the transcript still shows it |
| prompt completion | `step/end`, `turn/end` |

Emissions per turn: `turn/start`, `step/start`, `user/message`, `assistant/message`, `tool/call`/`tool/result` pairs, `step/end`, `turn/end`, contiguous `seq`.

Approvals: ACP `session/request_permission` (and Grok's permission prompts) answer through the DSH approval seam. User questions and elicitation, if Grok emits them, go through the user-questions seam. Unknown Grok `x.ai/*` notifications are ignored for v1 unless they carry model-visible content; model-visible content is always logged.

Auth is Grok-owned. Tokens live in `GROK_HOME/auth.json` (`https://auth.x.ai::<client-id>` today) and never enter DSH storage or logs.

- Interactive: unsigned-in, the profile settings panel runs `grok login --device-auth` (or Grok's `x.ai/auth/get_url` + `x.ai/auth/submit_code` if those methods are advertised on `initialize`) and waits for `auth.json`. Prefer device-code when the browser cannot reach a localhost OAuth callback.
- Unattended: `XAI_API_KEY` is Grok's documented fallback when no session token is active. DSH may expose it through `ctx.credentials` into the child environment; it does not mint or store a Grok OAuth token.
- Status: presence of a non-expired `auth.json` entry, or a failed `initialize` / first `session/new` that reports authentication required.

Models: `grok models` plus the `model` `configOption` on `session/new` / `session/load` feed the picker and per-turn overrides. Effort uses `reasoning_effort` (`minimal`, `low`, `medium`, `high`, `xhigh`; a model only accepts levels it advertises). Config: `GROK_HOME` owns `config.toml`, MCP, plugins, skills, and hooks; v1 reads none of it and writes none of it.

Quota is connection-global, not per session. The settings panel reads Grok's credits config (`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the CLI bearer, or `x.ai/billing` if the agent advertises it) and shows the weekly usage percent, product breakdown, and `currentPeriod.end`. Tokens from that response never enter the session log.

Phase 3 (not now): pass selected DSH tools as ACP `mcpServers` on `session/new` so Grok calls them as MCP, still inside Grok's loop.

## 3. Shared obligations

- Every model-visible input is logged; `tool/result.meta` carries card payloads; Grok tool names (`run_terminal_cmd`, `search_replace`, `read_file`, Imagine, MCP `server__tool`) get presenters or deliberately fall back to generic cards.
- Fail loud: missing `grok` binary, unauthenticated account, unsupported `inject`, unresumable Grok session, advertised client fs/terminal accidentally enabled.
- Teardown: no orphan `grok agent` processes; HMR disposal for every registry contribution; `--no-leader` so teardown cannot kill the user's TUI leader.
- Tests: non-unit REAL composition booting a test-only `cordis.yml` through the Loader and process, mocking only the `grok` binary or transport; keyless recorded-session snapshot for model-visible output; invariant package only when independent observations diverge.
- Docs in the same PR: package README with i18n, group page, config catalog regeneration, Agent Note.

## 4. Acceptance

1. Web UI, new session, prompt: Grok Build tools execute in Grok's process, file changes and shell calls render as cards, an approval prompt is answered in the UI, Stop cancels the in-flight `session/prompt`.
2. Reload and resume continue the same Grok session id under `GROK_HOME/sessions`.
3. Signed-out, the settings panel can complete `grok login --device-auth` and the next session starts. Weekly usage percent is visible on that panel.
4. Snapshot tests pass without credentials, and no Grok access token or refresh token appears in any log or transcript.
5. A running Grok TUI on the same machine is unaffected (`--no-leader`).

## 5. Open questions

- Whether to wait for `agent-external` / `agent-acp` from the Codex/Devin work and make this package a Grok profile on that ACP driver, or ship `agent-grok` first and fold the generic wire later. Either way the binary is `grok agent --no-leader stdio` and `clientCapabilities` stays `{}`.
- Whether Web UI sessions should be listed by `grok sessions` / the Grok TUI (they will if `GROK_HOME` is `~/.grok`) or isolated in a driver-owned home.
- Whether Grok `plan` updates should become DSH plan-mode state or stay transcript cards. v1 keeps DSH plan mode unmounted.
- Multi-user isolation: one `grok agent` process per identity, keyed by `GROK_HOME`.
