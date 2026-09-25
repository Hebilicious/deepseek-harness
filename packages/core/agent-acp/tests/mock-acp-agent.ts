/**
 * A minimal mock `devin acp`-shape ACP AGENT, run as a subprocess, for the
 * keyless `dsh-agent-acp` tests. It speaks the agent side of ACP over stdio
 * and is fully scripted by environment variables — no model, no network:
 *
 * - `MOCK_RECORD_FILE`  — append one JSONL `{method, params}` line per incoming
 *                         request/notification, so a test asserts exactly what
 *                         the driver sent (initialize capabilities, session/new
 *                         vs session/load, set_config_option, prompt, cancel).
 * - `MOCK_SESSION_ID`   — fixed session id from `session/new` (random otherwise).
 * - `MOCK_LOAD_SESSION` — advertise `loadSession: true` and serve `session/load`.
 * - `MOCK_LOAD_UNKNOWN` — answer `session/load` with `resourceNotFound`, as an
 *                         agent that stored no session for the id does.
 * - `MOCK_CLOSE`        — advertise `sessionCapabilities.close` and serve
 *                         `session/close`.
 * - `MOCK_DELETE`       — advertise `sessionCapabilities.delete` and serve
 *                         `session/delete`, the other capability the catalog
 *                         probe closes a throwaway session through.
 * - `MOCK_CLOSE_ERROR`  — reject `session/close`, so the catalog probe's
 *                         best-effort close has a failing producer.
 * - `MOCK_CONFIG_OPTIONS` — JSON `SessionConfigOption[]` returned by
 *                         `session/new` and `session/load`; the mock tracks
 *                         `session/set_config_option` writes and echoes the
 *                         updated `currentValue` back.
 * - `MOCK_SESSION_MODELS` — JSON `[{modelId, name, description?}]` returned as
 *                         the session's `models.availableModels` advert, the
 *                         newer ACP session model state.
 * - `MOCK_CURRENT_MODEL`  — `models.currentModelId`; defaults to the first
 *                         `MOCK_SESSION_MODELS` entry.
 * - `MOCK_TEXT`         — assistant text streamed as `agent_message_chunk`s;
 *                         an empty value emits no chunk.
 * - `MOCK_THOUGHT`      — text streamed as one `agent_thought_chunk` first.
 * - `MOCK_PLAN`         — JSON `[{content, status}]` emitted as a `plan` update.
 * - `MOCK_TOOL`         — emit `tool_call` then a completed `tool_call_update`.
 * - `MOCK_SCRIPT`       — JSON list sent in order before the text: each entry is
 *                         a `session/update` payload, or `{permission: toolCall}`
 *                         for one allow-once permission request.
 * - `MOCK_TOOL_OPEN`    — emit `tool_call` with no terminal update, so the
 *                         driver's settlement must close it as an error result.
 * - `MOCK_INTERLEAVED`  — stream the value as one `agent_message_chunk` before
 *                         the tool pair; `MOCK_TEXT` still streams after it,
 *                         so one turn interleaves text, call, and text.
 * - `MOCK_TOOL_BARE`    — emit a `tool_call` with no name/title/rawInput and a
 *                         failed `tool_call_update` carrying only rawOutput.
 * - `MOCK_CONFIG_UPDATE`— emit a `config_option_update` during the prompt.
 * - `MOCK_UNHANDLED_UPDATE` — emit a `current_mode_update`, which the driver
 *                         deliberately ignores.
 * - `MOCK_UNREGISTERED_REQUEST` — request permission and elicitation for a
 *                         session id this client carries no peer for, plus one
 *                         elicitation with no session id at all.
 * - `MOCK_IDLE_UPDATE_FILE` — after answering the prompt, emit every handled
 *                         update kind and probe the driver with a permission
 *                         and an elicitation request, then touch this file.
 *                         Exercises the no-active-turn arms.
 * - `MOCK_MESSAGE_ID`   — stream the message chunk under that ACP messageId.
 * - `MOCK_TEXT_IMAGE`   — stream the assistant chunk as an image block, which
 *                         the driver has no text for.
 * - `MOCK_REPEAT_CHUNKS`— stream every chunk twice, so each open lane appends.
 * - `MOCK_HANG_ONCE`    — hang only the first prompt, so a cancelled turn's
 *                         queued input can run on the next one.
 * - `MOCK_NO_STOP_REASON` — answer the prompt with no `stopReason` field.
 * - `MOCK_NO_CONFIG_OPTIONS` — omit `configOptions` from session/new,
 *                         session/load, and set_config_option responses.
 * - `MOCK_SET_OPTION_EMPTY` — answer set_config_option without configOptions.
 * - `MOCK_SET_OPTION_FAIL` — reject set_config_option for this value.
 * - `MOCK_MODELS_EXIT`  — exit the `models` subcommand with that code and no
 *                         stderr.
 * - `MOCK_MODELS_HANG`  — never answer the `models` subcommand.
 * - `MOCK_ELICIT_EXTRA` — add a number property to the elicitation schema.
 * - `MOCK_ELICIT_NO_PROPERTIES` — send a form elicitation without properties.
 * - `MOCK_PERMISSION_TITLE` — permission tool-call title (empty reaches the
 *                         driver's unnamed-tool fallback).
 * - `MOCK_PERMISSION`   — call `session/request_permission` before answering;
 *                         `MOCK_PERMISSION_OPTIONS` overrides the option list.
 * - `MOCK_ELICIT`       — call `elicitation/create` with a flat form schema
 *                         (`MOCK_ELICIT_MODE` selects a non-form mode).
 * - `MOCK_STOP`         — the `stopReason` `session/prompt` returns
 *                         (`end_turn` default, `max_tokens`, `refusal`, …).
 * - `MOCK_HANG`         — `session/prompt` resolves only via `session/cancel`.
 * - `MOCK_IGNORE_CANCEL`— receive `session/cancel` but never resolve the prompt
 *                         and never exit — a non-cooperative child.
 * - `MOCK_READY_FILE`   — path touched once the prompt handler is in flight, so
 *                         a test cancels on a condition, not a timeout.
 * - `MOCK_CRASH_ON_INITIALIZE` — exit while `initialize` is in flight.
 * - `MOCK_INITIALIZE_DELAY_MS` — hold the `initialize` response for that long,
 *                         so a test can dispose mid-handshake.
 * - `MOCK_PID_FILE`     — path this ACP child writes its pid to, so a test can
 *                         kill it or prove it exited.
 * - `MOCK_CRASH_AFTER_CHUNK`   — exit after streaming the assistant chunk, so
 *                         partial output survives a fatal connection loss.
 * - `MOCK_MISSING_SESSION_ID`  — return `{}` from `session/new`.
 * - `MOCK_HANG_SESSION_NEW`    — never answer `session/new`, so the catalog
 *                         probe's own deadline is the only thing that ends it.
 * - `MOCK_AUTH_METHODS` — JSON auth-method array for the initialize response.
 * - `MOCK_MCP_HTTP`   — advertise `agentCapabilities.mcpCapabilities.http`.
 * - `MOCK_MCP_PROBE`  — probe every http entry a session request's `mcpServers`
 *                       carries: a credential-less POST (`mcp-unauthorized`),
 *                       then initialize, `tools/list` (`mcp-tools`), and the
 *                       `MOCK_MCP_CALL` (`{name, arguments}`) `tools/call`
 *                       (`mcp-call`) under the entry's headers.
 * - `MOCK_MCP_PROMPT_CALL` — JSON `{name, arguments}` called on the session's
 *                       first http `mcpServers` entry during `session/prompt`,
 *                       then reported as a `tool_call`/`tool_call_update` pair
 *                       in Devin's shape: `title` is display text and the
 *                       canonical `mcp__<server>__<tool>` name rides
 *                       `_meta['cognition.ai/toolName']`.
 * - `MOCK_MCP_PROMPT_ONCE` — fire `MOCK_MCP_PROMPT_CALL` only on the first
 *                       `session/prompt` this process serves; sessions that
 *                       share the process, such as a bridged subagent's child,
 *                       answer later prompts without the call.
 * - `MOCK_MCP_PROMPT_STYLE` — `claude` reports the same call in Claude Code's
 *                       shape instead: the canonical name is the `title` and
 *                       `_meta` is absent.
 * - `MOCK_LOGOUT`       — advertise `agentCapabilities.auth.logout` and serve
 *                         the ACP `logout` request; off by default because real
 *                         Devin advertises `auth: {}` and serves no logout.
 * - `MOCK_FLUSH_ON_EOF` / `MOCK_FLUSH_DELAY_MS`, `MOCK_IGNORE_EOF` /
 *   `MOCK_SIGTERM_FILE`, `MOCK_TRAP_SIGTERM` — the disposal-tier fixtures
 *   (EOF quiesce, SIGTERM cooperation, SIGKILL escalation).
 *
 * It is not a test spec: the specs launch this protocol-only fixture through
 * `process.execPath` (Node's native type stripping). It imports no harness
 * code or workspace paths.
 *
 * @module @deepseek-ai/dsh-agent-acp/tests/mock-acp-agent
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type CancelNotification,
  type AuthenticateRequest,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'

// The `devin` CLI is one binary: `devin acp` serves the protocol while
// `devin models list` / `devin auth …` are one-shot commands. The fixture
// mirrors that: spawned as `node mock-acp-agent.ts acp` it serves ACP below;
// `node mock-acp-agent.ts models …` / `auth …` answer and exit.
const subcommand = process.argv[2]
if (subcommand === 'models') {
  recordCli()
  // Read the flags here: this branch runs before the const block below.
  if (process.env.MOCK_MODELS_HANG === '1') {
    // A catalog refresh that never answers, so the driver's deadline fires.
    setInterval(() => { /* stay alive until terminated */ }, 1000)
  } else {
    const exitCode = process.env.MOCK_MODELS_EXIT
    if (exitCode === undefined) {
      process.stdout.write(`${process.env.MOCK_MODELS_JSON ?? JSON.stringify({ families: [] })}\n`)
    }
    process.exit(exitCode === undefined ? 0 : Number(exitCode))
  }
}
if (subcommand === 'auth') {
  const verb = process.argv[3]
  recordCli()
  process.stdout.write(`${process.env.MOCK_AUTH_DETAIL ?? 'mock auth detail'}\n`)
  process.exit(verb === 'status' && process.env.MOCK_AUTH_LOGGED_OUT === '1' ? 3 : 0)
}
if (subcommand !== undefined && subcommand !== 'acp') {
  process.stderr.write(`unknown subcommand ${subcommand}\n`)
  process.exit(2)
}
if (process.env.MOCK_PID_FILE !== undefined) {
  writeFileSync(process.env.MOCK_PID_FILE, String(process.pid))
}

/** Append one `cli` record for a one-shot subcommand, so a test sees which verb the driver ran. */
function recordCli(): void {
  const file = process.env.MOCK_RECORD_FILE
  if (file === undefined) return
  appendFileSync(file, `${JSON.stringify({ method: 'cli', params: { argv: process.argv.slice(2) } })}\n`)
}

const RECORD_FILE = process.env.MOCK_RECORD_FILE
const TEXT = process.env.MOCK_TEXT ?? 'mock acp answer'
const THOUGHT = process.env.MOCK_THOUGHT
const STOP = (process.env.MOCK_STOP ?? 'end_turn') as StopReason
const HANG = process.env.MOCK_HANG === '1'
const IGNORE_CANCEL = process.env.MOCK_IGNORE_CANCEL === '1'
const WANT_PERMISSION = process.env.MOCK_PERMISSION === '1'
const ELICIT = process.env.MOCK_ELICIT === '1'
const CRASH_ON_INITIALIZE = process.env.MOCK_CRASH_ON_INITIALIZE === '1'
const CRASH_AFTER_CHUNK = process.env.MOCK_CRASH_AFTER_CHUNK === '1'
const READY_FILE = process.env.MOCK_READY_FILE
const LOAD_SESSION = process.env.MOCK_LOAD_SESSION === '1'
const CLOSE = process.env.MOCK_CLOSE === '1'
const DELETE = process.env.MOCK_DELETE === '1'
const CLOSE_ERROR = process.env.MOCK_CLOSE_ERROR === '1'
const EMIT_TOOL = process.env.MOCK_TOOL === '1'
const EMIT_TOOL_OPEN = process.env.MOCK_TOOL_OPEN === '1'
const INTERLEAVED = process.env.MOCK_INTERLEAVED
const FLUSH_ON_EOF = process.env.MOCK_FLUSH_ON_EOF
const INITIALIZE_DELAY_MS = Number(process.env.MOCK_INITIALIZE_DELAY_MS ?? '0')
const WANT_LOGOUT = process.env.MOCK_LOGOUT === '1'
const EMIT_TOOL_BARE = process.env.MOCK_TOOL_BARE === '1'
const TEXT_IMAGE = process.env.MOCK_TEXT_IMAGE === '1'
const MESSAGE_ID = process.env.MOCK_MESSAGE_ID
const UPDATE_CONFIG = process.env.MOCK_CONFIG_UPDATE === '1'
const UNHANDLED_UPDATE = process.env.MOCK_UNHANDLED_UPDATE === '1'
const UNREGISTERED_REQUEST = process.env.MOCK_UNREGISTERED_REQUEST === '1'
const IDLE_UPDATE_FILE = process.env.MOCK_IDLE_UPDATE_FILE
const NO_CONFIG_OPTIONS = process.env.MOCK_NO_CONFIG_OPTIONS === '1'
const NO_STOP_REASON = process.env.MOCK_NO_STOP_REASON === '1'
const SET_OPTION_EMPTY = process.env.MOCK_SET_OPTION_EMPTY === '1'
const REPEAT_CHUNKS = process.env.MOCK_REPEAT_CHUNKS === '1'
const HANG_ONCE = process.env.MOCK_HANG_ONCE === '1'
const PERMISSION_TITLE = process.env.MOCK_PERMISSION_TITLE ?? 'mock side effect'
const ELICIT_EXTRA = process.env.MOCK_ELICIT_EXTRA === '1'
const ELICIT_NO_PROPERTIES = process.env.MOCK_ELICIT_NO_PROPERTIES === '1'
const MCP_HTTP = process.env.MOCK_MCP_HTTP === '1'
const MCP_PROBE = process.env.MOCK_MCP_PROBE === '1'
const MCP_CALL = jsonEnv('MOCK_MCP_CALL') as { name: string; arguments?: unknown } | undefined
const MCP_PROMPT_CALL = jsonEnv('MOCK_MCP_PROMPT_CALL') as { name: string; arguments?: unknown } | undefined
const MCP_PROMPT_ONCE = process.env.MOCK_MCP_PROMPT_ONCE === '1'
const MCP_PROMPT_STYLE = process.env.MOCK_MCP_PROMPT_STYLE ?? 'devin'
/** The http `mcpServers` entries the latest session request carried. */
let sessionMcpServers: readonly ProbedMcpServer[] = []

function jsonEnv(name: string): unknown {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  return JSON.parse(raw)
}

/**
 * The session model state some agents send: newer than this SDK's
 * `NewSessionResponse` type, so the mock and the driver both read it as an
 * extension field.
 */
interface MockSessionModels {
  readonly currentModelId: string
  readonly availableModels: NonNullable<typeof SESSION_MODELS>
}

/** This child's session model advert, or undefined when the script declares none. */
function sessionModels(): MockSessionModels | undefined {
  if (SESSION_MODELS === undefined) return undefined
  return {
    currentModelId: process.env.MOCK_CURRENT_MODEL ?? SESSION_MODELS[0]?.modelId ?? '',
    availableModels: SESSION_MODELS,
  }
}

const CONFIG_OPTIONS = (jsonEnv('MOCK_CONFIG_OPTIONS') as SessionConfigOption[] | undefined) ?? []
const SESSION_MODELS = jsonEnv('MOCK_SESSION_MODELS') as
  | Array<{ modelId: string; name: string; description?: string }>
  | undefined
const PERMISSION_OPTIONS = jsonEnv('MOCK_PERMISSION_OPTIONS') as
  | Array<{ optionId: string; name: string; kind: string }>
  | undefined
const AUTH_METHODS = (jsonEnv('MOCK_AUTH_METHODS') as InitializeResponse['authMethods'] | undefined) ?? []
const AGENT_INFO = jsonEnv('MOCK_AGENT_INFO') as InitializeResponse['agentInfo'] | undefined
const PLAN = jsonEnv('MOCK_PLAN') as
  | Array<{ content: string; status?: string; priority?: string }>
  | undefined

function record(method: string, params: unknown): void {
  if (RECORD_FILE === undefined) return
  appendFileSync(RECORD_FILE, `${JSON.stringify({ method, params })}\n`)
}

// Every ACP-mode child records its own startup facts, so a test driving
// several harnesses can tell which process served which session.
record('process', { cwd: process.cwd(), args: process.argv.slice(2) })

/**
 * Emit one of every handled `session/update` kind after the prompt response,
 * exercising the driver's arms for updates that arrive while no turn is
 * active. The trailing request round-trips prove the client dispatched every
 * notification before the marker lands.
 */
async function emitIdleUpdates(conn: AgentContext, sessionId: string, marker: string): Promise<void> {
  const update = (payload: SessionNotification['update']): Promise<void> =>
    conn.notify(methods.client.session.update, { sessionId, update: payload })
  await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late message' } })
  await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'late thought' } })
  await update({
    sessionUpdate: 'tool_call',
    toolCallId: 'late-call',
    title: 'late tool',
    kind: 'execute',
  })
  await update({ sessionUpdate: 'tool_call_update', toolCallId: 'late-call', status: 'completed' })
  await update({
    sessionUpdate: 'plan',
    entries: [{ content: 'late step', status: 'pending', priority: 'medium' }],
  })
  await update({ sessionUpdate: 'config_option_update', configOptions: [] })
  record('idle-permission', await conn.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: 'idle-probe', title: 'idle probe' },
    options: [],
  }))
  record('idle-elicitation', await conn.request(methods.client.elicitation.create, {
    sessionId,
    message: 'idle probe',
    mode: 'form',
    requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } },
  }))
  writeFileSync(marker, 'sent')
}

/** One http `mcpServers` entry a session request carried. */
interface ProbedMcpServer {
  readonly type?: string
  readonly name?: string
  readonly url?: string
  readonly headers?: readonly { name: string; value: string }[]
}

/** POST one MCP JSON-RPC message; returns the status and any result/error payload. */
async function mcpPost(
  url: string,
  headers: Record<string, string>,
  message: Record<string, unknown>,
): Promise<{ status: number; result?: unknown; error?: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(message),
  })
  const text = await response.text()
  if (!response.ok || text === '') return { status: response.status }
  const messages = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()) as { result?: unknown; error?: unknown })
    : [JSON.parse(text) as { result?: unknown; error?: unknown }]
  const reply = messages.find(entry => entry !== null && ('result' in entry || 'error' in entry)) ?? {}
  return { status: response.status, ...reply }
}

/**
 * Probe every http `mcpServers` entry a session request carried, so a test
 * reads from the record whether the endpoint is reachable, requires its
 * bearer credential, and serves the bridged tools. A probe failure lands as
 * `mcp-error` rather than failing the session request.
 */
async function probeMcpServers(params: { mcpServers?: readonly unknown[] }): Promise<void> {
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mock-acp-agent', version: '0' },
    },
  }
  for (const entry of params.mcpServers ?? []) {
    const server = entry as ProbedMcpServer
    if (server.type !== 'http' || server.url === undefined) continue
    const headers = Object.fromEntries((server.headers ?? []).map(header => [header.name, header.value]))
    try {
      record('mcp-unauthorized', await mcpPost(server.url, {}, init))
      record('mcp-initialize', await mcpPost(server.url, headers, init))
      await mcpPost(server.url, headers, { jsonrpc: '2.0', method: 'notifications/initialized' })
      record('mcp-tools', await mcpPost(server.url, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
      if (MCP_CALL !== undefined) {
        record('mcp-call', await mcpPost(server.url, headers, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: MCP_CALL.name, arguments: MCP_CALL.arguments ?? {} },
        }))
      }
    } catch (error) {
      record('mcp-error', String(error))
    }
  }
}

/**
 * Call `MOCK_MCP_PROMPT_CALL` on the session's first http `mcpServers` entry
 * and report it to the client as one `tool_call` plus its terminal
 * `tool_call_update`, in the shape Devin emits for MCP calls: `title` is
 * display text and the canonical `mcp__<server>__<tool>` name rides
 * `_meta['cognition.ai/toolName']`.
 */
async function promptMcpCall(conn: AgentContext, sessionId: string): Promise<void> {
  if (MCP_PROMPT_CALL === undefined) return
  const server = sessionMcpServers.find(entry => entry.type === 'http' && entry.url !== undefined)
  if (server === undefined) {
    record('mcp-prompt-call', { error: 'no http mcpServers entry' })
    return
  }
  const headers = Object.fromEntries((server.headers ?? []).map(header => [header.name, header.value]))
  const called = await mcpPost(server.url!, headers, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mock-acp-agent', version: '0' },
    },
  })
  if (called.error !== undefined || called.result === undefined) {
    record('mcp-prompt-call', called)
    return
  }
  await mcpPost(server.url!, headers, { jsonrpc: '2.0', method: 'notifications/initialized' })
  const result = await mcpPost(server.url!, headers, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: MCP_PROMPT_CALL.name, arguments: MCP_PROMPT_CALL.arguments ?? {} },
  })
  record('mcp-prompt-call', result)
  const payload = result.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined
  const canonical = `mcp__${server.name ?? 'dsh'}__${MCP_PROMPT_CALL.name}`
  // Devin keeps the canonical name in `_meta`; Claude Code reports it as the
  // `title` and sends no `_meta`.
  const claude = MCP_PROMPT_STYLE === 'claude'
  await conn.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp-call-1',
      title: claude ? canonical : `Calling ${MCP_PROMPT_CALL.name} from ${server.name ?? 'dsh'}`,
      rawInput: MCP_PROMPT_CALL.arguments ?? {},
      ...claude ? {} : {
        _meta: {
          'cognition.ai/toolName': canonical,
          'cognition.ai/eventType': 'mcp_tool_call',
          'cognition.ai/inferenceToolName': canonical,
        },
      },
    },
  })
  await conn.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mcp-call-1',
      status: payload?.isError === true || result.error !== undefined ? 'failed' : 'completed',
      content: (payload?.content ?? []).map(block => ({
        type: 'content' as const,
        content: block.type === 'text'
          ? { type: 'text' as const, text: block.text ?? '' }
          : { type: 'text' as const, text: JSON.stringify(block) },
      })),
      ...claude ? {} : { _meta: { 'cognition.ai/inferenceToolName': canonical } },
    },
  })
}

function makeAgent() {
  // Pending cancel resolver for the HANG path: `session/cancel` resolves the
  // prompt with `cancelled`.
  let resolveCancel: ((reason: StopReason) => void) | undefined
  let prompts = 0
  // The mock keeps the advertised options mutable so set_config_option echoes
  // the caller's write — like a real harness updating its current selection.
  const configOptions = CONFIG_OPTIONS.map(option => ({ ...option }))

  return {
    initialize(params: InitializeRequest): Promise<InitializeResponse> {
      record('initialize', params)
      if (CRASH_ON_INITIALIZE) process.exit(11)
      const response: InitializeResponse = {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          ...LOAD_SESSION ? { loadSession: true } : {},
          ...CLOSE ? { sessionCapabilities: { close: {} } } : {},
          ...DELETE ? { sessionCapabilities: { delete: {} } } : {},
          ...MCP_HTTP ? { mcpCapabilities: { http: true } } : {},
          // Real Devin answers `auth: {}` (no logout method); MOCK_LOGOUT
          // advertises it so the driver's ACP logout arm stays exercised.
          ...WANT_LOGOUT ? { auth: { logout: {} } } : {},
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
        },
        authMethods: AUTH_METHODS,
        ...AGENT_INFO === undefined ? {} : { agentInfo: AGENT_INFO },
      }
      if (INITIALIZE_DELAY_MS === 0) return Promise.resolve(response)
      return new Promise((resolve) => { setTimeout(() => { resolve(response) }, INITIALIZE_DELAY_MS) })
    },
    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      record('session/new', params)
      sessionMcpServers = params.mcpServers ?? []
      if (MCP_PROBE) await probeMcpServers(params)
      if (process.env.MOCK_HANG_SESSION_NEW === '1') return new Promise(() => {})
      if (process.env.MOCK_MISSING_SESSION_ID === '1') return {} as NewSessionResponse
      const models = sessionModels()
      const response = {
        sessionId: process.env.MOCK_SESSION_ID ?? randomUUID(),
        ...NO_CONFIG_OPTIONS ? {} : { configOptions },
        ...models === undefined ? {} : { models },
      }
      return response
    },
    async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
      record('session/load', params)
      sessionMcpServers = params.mcpServers ?? []
      if (MCP_PROBE) await probeMcpServers(params)
      if (!LOAD_SESSION) {
        const error = new Error('loadSession is not advertised') as Error & { code: number }
        error.code = -32601
        return Promise.reject(error)
      }
      if (process.env.MOCK_LOAD_UNKNOWN === '1') return Promise.reject(RequestError.resourceNotFound(params.sessionId))
      const models = sessionModels()
      return Promise.resolve({
        ...NO_CONFIG_OPTIONS ? {} : { configOptions },
        ...models === undefined ? {} : { models },
      })
    },
    deleteSession(params: unknown): Promise<Record<string, never>> {
      record('session/delete', params)
      return Promise.resolve({})
    },

    closeSession(params: unknown): Promise<Record<string, never>> {
      record('session/close', params)
      if (CLOSE_ERROR) return Promise.reject(new Error('mock close failed'))
      return Promise.resolve({})
    },
    setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
      record('session/set_config_option', params)
      if (params.value === process.env.MOCK_SET_OPTION_FAIL) return Promise.reject(new Error(`refused ${params.value}`))
      for (const option of configOptions) {
        if (option.id === params.configId && option.type === 'select' && typeof params.value === 'string') {
          option.currentValue = params.value
        }
      }
      // The SDK's response type requires the field; SET_OPTION_EMPTY models a
      // server that omits it, which is the case the driver tolerates.
      return Promise.resolve(SET_OPTION_EMPTY ? {} as SetSessionConfigOptionResponse : { configOptions })
    },
    authenticate(params: AuthenticateRequest): Promise<Record<string, never>> {
      record('authenticate', params)
      return Promise.resolve({})
    },
    logout(params: unknown): Promise<Record<string, never>> {
      record('logout', params)
      return Promise.resolve({})
    },
    async prompt(params: PromptRequest, conn: AgentContext): Promise<PromptResponse> {
      record('session/prompt', params)
      prompts += 1
      const hangThisPrompt = HANG || (HANG_ONCE && prompts === 1)
      for (const step of (jsonEnv('MOCK_SCRIPT') ?? []) as Record<string, unknown>[]) {
        if ('permission' in step) {
          const decision = await conn.request(methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: step.permission as RequestPermissionRequest['toolCall'],
            options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' as const }],
          })
          record('permission-outcome', decision)
          continue
        }
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: step as SessionNotification['update'],
        })
      }
      if (WANT_PERMISSION) {
        const decision = await conn.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'mock-call', title: PERMISSION_TITLE },
          options: PERMISSION_OPTIONS ?? [
            { optionId: 'yes', name: 'Allow once', kind: 'allow_once' as const },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' as const },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
          ],
        }) as RequestPermissionResponse
        record('permission-outcome', decision)
        if (decision.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' }
      }
      if (ELICIT) {
        const mode = process.env.MOCK_ELICIT_MODE ?? 'form'
        const requestedSchema = {
          type: 'object' as const,
          properties: {
            choice: {
              type: 'string' as const,
              description: 'Pick one',
              // An empty enum member maps to no offered option.
              enum: ['alpha', '', 'beta'],
            },
            ...ELICIT_EXTRA
              // No description and no enum, so the driver names it by key and
              // asks without options.
              ? { count: { type: 'number' as const } }
              : {},
          },
        }
        const answer = await conn.request(methods.client.elicitation.create, mode === 'url'
          // The url mode carries a redirect instead of a form schema.
          ? { sessionId: params.sessionId, message: 'mock elicitation', mode, elicitationId: 'elicit-1', url: 'https://example.com/elicit' }
          // A form without a properties map has nothing to ask about.
          : ELICIT_NO_PROPERTIES
            ? { sessionId: params.sessionId, message: 'mock elicitation', mode: 'form', requestedSchema: { type: 'object' } }
            : { sessionId: params.sessionId, message: 'mock elicitation', mode: 'form', requestedSchema })
        record('elicitation-outcome', answer)
      }
      if (THOUGHT !== undefined) {
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: THOUGHT } },
        })
      }
      if (PLAN !== undefined) {
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          // PlanEntry requires status and priority; the script may omit them.
          update: {
            sessionUpdate: 'plan',
            entries: PLAN.map(entry => ({
              content: entry.content,
              status: entry.status ?? 'pending',
              priority: entry.priority ?? 'medium',
            })),
          },
        })
      }
      if (INTERLEAVED !== undefined) {
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: INTERLEAVED } },
        })
      }
      if (EMIT_TOOL || EMIT_TOOL_OPEN) {
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'mock-tool-1',
            title: 'mock tool',
            kind: 'execute',
            rawInput: { command: 'true' },
          },
        })
      }
      if (EMIT_TOOL) {
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'mock-tool-1', status: 'in_progress' },
        })
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'mock-tool-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'tool output' } }],
          },
        })
      }
      if (EMIT_TOOL_BARE) {
        // An empty toolCallId is the only wire-valid way to reach the driver's
        // id guard; an empty title reaches its unnamed-tool fallback.
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: '', title: '', kind: 'execute' },
        })
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: 'bare-call', title: '', kind: 'execute' },
        })
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: '', status: 'failed' },
        })
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'bare-call',
            status: 'failed',
            rawOutput: { error: 'boom' },
          },
        })
        // A terminal update with neither content nor rawOutput closes its call
        // with the driver's empty text block.
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: 'empty-call', title: 'empty', kind: 'execute' },
        })
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'empty-call', status: 'completed' },
        })
      }
      if (!MCP_PROMPT_ONCE || prompts === 1) {
        try {
          await promptMcpCall(conn, params.sessionId)
        } catch (error) {
          // A bridged call that never reached the endpoint emits no tool pair;
          // the record carries the failure for the test.
          record('mcp-prompt-call', { error: String(error) })
        }
      }
      if (UNREGISTERED_REQUEST) {
        // Requests addressed to a session this client carries no peer for: the
        // driver answers each from its unregistered-session default.
        record('unregistered-permission', await conn.request(methods.client.session.requestPermission, {
          sessionId: 'unregistered-session',
          toolCall: { toolCallId: 'other-call', title: 'other session tool' },
          options: [],
        }))
        record('unregistered-elicitation', await conn.request(methods.client.elicitation.create, {
          sessionId: 'unregistered-session',
          message: 'other session',
          mode: 'form',
          requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } },
        }))
        // A request-scoped elicitation carries `requestId` instead of a
        // sessionId, so no peer can own it.
        record('sessionless-elicitation', await conn.request(methods.client.elicitation.create, {
          requestId: 7,
          message: 'no session',
          mode: 'form',
          requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } },
        }))
      }
      if (UNHANDLED_UPDATE) {
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' },
        })
      }
      if (UPDATE_CONFIG) {
        await conn.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions },
        })
      }
      const messageChunk = {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          ...MESSAGE_ID === undefined ? {} : { messageId: MESSAGE_ID },
          content: TEXT_IMAGE
            ? { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }
            : { type: 'text' as const, text: TEXT },
        },
      }
      if (TEXT !== '' || TEXT_IMAGE) await conn.notify(methods.client.session.update, messageChunk)
      if (REPEAT_CHUNKS) {
        // A second chunk per open lane, and a second plan update.
        await conn.notify(methods.client.session.update, messageChunk)
        if (THOUGHT !== undefined) {
          await conn.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: THOUGHT } },
          })
        }
        if (PLAN !== undefined) {
          await conn.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'plan',
              entries: PLAN.map(entry => ({
                content: entry.content,
                status: entry.status ?? 'pending',
                priority: entry.priority ?? 'medium',
              })),
            },
          })
        }
      }
      if (IDLE_UPDATE_FILE !== undefined) {
        setTimeout(() => { void emitIdleUpdates(conn, params.sessionId, IDLE_UPDATE_FILE) }, 150)
      }
      if (CRASH_AFTER_CHUNK) {
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        process.exit(17)
      }
      if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ready')
      if (hangThisPrompt) {
        return new Promise<PromptResponse>((resolve) => {
          resolveCancel = (reason) => { resolve({ stopReason: reason }) }
        })
      }
      // NO_STOP_REASON models a server that omits the required member.
      return NO_STOP_REASON ? {} as PromptResponse : { stopReason: STOP }
    },
    cancel(params: CancelNotification): Promise<void> {
      record('session/cancel', params)
      if (IGNORE_CANCEL) return Promise.resolve()
      resolveCancel?.('cancelled')
      return Promise.resolve()
    },
  }
}

const implementation = makeAgent()
const app = createAcpAgentApp({ name: 'dsh-agent-acp-test-agent' })
  .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
  .onRequest(methods.agent.authenticate, async ({ params }) => {
    await implementation.authenticate(params)
    return {}
  })
  .onRequest(methods.agent.session.new, ({ params }) => implementation.newSession(params))
  .onRequest(methods.agent.session.load, ({ params }) => implementation.loadSession(params))
  .onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params))
  .onRequest(methods.agent.session.delete, ({ params }) => implementation.deleteSession(params))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => implementation.setConfigOption(params))
  .onRequest(methods.agent.session.prompt, ({ params, client }) => implementation.prompt(params, client))
  .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
// Real Devin serves no `logout` method, so the fixture registers one only
// where it also advertises the capability.
if (WANT_LOGOUT) app.onRequest(methods.agent.logout, ({ params }) => implementation.logout(params))
app.connect(ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
))

// Under MOCK_TRAP_SIGTERM, ignore SIGTERM and keep stdin open so the process
// neither quiesces on EOF nor dies on the graceful signal — exercising the
// dispose path's SIGKILL escalation.
if (process.env.MOCK_TRAP_SIGTERM === '1') {
  process.on('SIGTERM', () => { /* trapped: refuse to exit on the graceful signal */ })
  setInterval(() => { /* stay alive until SIGKILL */ }, 1000)
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'trap-armed')
}

// Under MOCK_FLUSH_ON_EOF, model the real agent's EOF-driven quiesce: on stdin
// 'end', take an async beat (MOCK_FLUSH_DELAY_MS, default 150), touch the
// marker, and exit on its own — no signal.
if (FLUSH_ON_EOF !== undefined) {
  const flushDelayMs = Number(process.env.MOCK_FLUSH_DELAY_MS ?? '150')
  process.stdin.on('end', () => {
    setTimeout(() => {
      writeFileSync(FLUSH_ON_EOF, 'flushed')
      process.exit(0)
    }, flushDelayMs)
  })
}

// Under MOCK_IGNORE_EOF, keep the loop alive past stdin EOF but install a
// SIGTERM handler that records the signal and exits — the middle disposal tier.
if (process.env.MOCK_IGNORE_EOF === '1') {
  const sigtermFile = process.env.MOCK_SIGTERM_FILE
  process.on('SIGTERM', () => {
    if (sigtermFile !== undefined) writeFileSync(sigtermFile, 'sigterm')
    process.exit(0)
  })
  setInterval(() => { /* stay alive past EOF until SIGTERM */ }, 1000)
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ignore-eof-armed')
}
