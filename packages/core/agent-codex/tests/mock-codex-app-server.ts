/**
 * A minimal mock `codex app-server --stdio`-shape SERVER, run as a
 * subprocess, for the keyless `dsh-agent-codex` tests. It speaks the server
 * side of the Codex app-server 0.153.4 JSON-RPC protocol — newline-delimited
 * JSON-RPC 2.0 over stdio — and is fully scripted by environment variables; no
 * model, no network. Every inbound request is validated against the method's
 * required params and answered with the protocol's own error codes, and the
 * scripted item/response payloads carry the members the real bindings
 * require, so a driver that sends or expects the wrong member fails here.
 *
 * - `MOCK_CODEX_RECORD_FILE`  — append one JSONL `{method, params}` line per
 *                             incoming request/notification, plus
 *                             `{method: 'approval-decision' | 'permissions-outcome' |
 *                             'user-input-answers' | 'elicitation-outcome'}`
 *                             records for client answers, so a test asserts
 *                             exactly what the driver sent and answered.
 * - `MOCK_CODEX_PID_FILE`   — the mock's own pid, for a test that kills the
 *                             child directly.
 * - `MOCK_CODEX_THREAD_ID`  — fixed thread id from `thread/start` (random
 *                             otherwise).
 * - `MOCK_CODEX_TEXT`       — assistant text carried by the agentMessage item.
 * - `MOCK_CODEX_SCENARIO`   — the turn script `turn/start` runs:
 *     `text`       (default) agentMessage started → delta → completed → turn completed.
 *     `early`      the same frames emitted BEFORE the `turn/start` response,
 *                  exercising the provisional-turn buffer.
 *     `reasoning`  a completed reasoning item folds into the assistant message.
 *     `tool`       commandExecution started → completed → message → completed.
 *     `tool-open`  commandExecution started, never completed — the driver's
 *                  settlement must close it as an error result.
 *     `interleaved` agentMessage delta, a completed commandExecution, then
 *                  more of the same item's deltas and its completion —
 *                  text → call → text inside one streamed item.
 *     `interleaved-settled` agentMessage delta, a completed commandExecution,
 *                  then the item's completion carrying only the already
 *                  streamed text — the continuation attempt commits nothing.
 *     `message-open` agentMessage started → delta → turn completed, with no item
 *                  completion — the settlement must close the open stream.
 *     `file-change` fileChange started → completed with a diff → completed.
 *     `mcp-turn-call` calls `MOCK_CODEX_MCP_TURN_CALL` on the thread's first
 *                  `mcp_servers` entry, then reports one `mcpToolCall` pair.
 *     `approval`   commandExecution gated on an `item/commandExecution/
 *                  requestApproval` answer; `MOCK_CODEX_DECISIONS` overrides
 *                  the offered list.
 *     `permissions` `item/permissions/requestApproval` for a network grant.
 *     `user-input` `item/tool/requestUserInput` with one select question.
 *     `elicit`     `mcpServer/elicitation/request` with a flat form schema;
 *                  `elicit-plain` asks schema-less free text.
 *     `hang`       turn starts, then waits for `turn/interrupt` (the cancel
 *                  path); `never` starts and never completes at all.
 *     `steer`      turn waits for `turn/steer`, then completes.
 *     `crash`      partial agentMessage, then the process exits mid-turn.
 *     `fail`       `turn/completed` with `status: 'failed'` and
 *                  `codexErrorInfo: 'serverOverloaded'`; `max-tokens` uses
 *                  `contextWindowExceeded`.
 *     `bad-item-first` the first turn's `item/completed` omits its item id,
 *                  which the driver cannot fold; later turns run normally.
 *     `late-frame` a completed turn followed by an unfoldable `turn/started`,
 *                  arriving after the driver settled the turn.
 *     `foreign-frame` a frame addressed to a turn id the driver did not commit,
 *                  arriving while its own turn is live.
 *     `early-conflict` two item frames naming different turn ids before the
 *                  `turn/start` response commits one.
 * - `MOCK_CODEX_READY_FILE` — path touched once the scripted turn is in
 *                             flight, so a test steers or cancels on a
 *                             condition, not a timeout.
 * - `MOCK_CODEX_EXIT_FILE`  — path touched immediately before the scripted
 *                             self-exit (`crash`), for a test that observes
 *                             the child's death without polling its pid.
 * - `MOCK_CODEX_INITIALIZE_FILE` / `MOCK_CODEX_INITIALIZE_GATE_FILE` — the
 *                             first is touched when `initialize` arrives, the
 *                             second gates the response until it exists, so a
 *                             test can dispose the driver in the middle of
 *                             the handshake deterministically.
 * - `MOCK_CODEX_AUTH`       — `out`: `account/read` reports
 *                             `{requiresOpenaiAuth: true, account: null}`;
 *                             `key`: the same until `account/login/start
 *                             {type:'apiKey'}` flips the account signed in.
 * - `MOCK_CODEX_MODELS`     — JSON array served by `model/list`;
 *                             `MOCK_CODEX_PAGE_SIZE` splits it into pages;
 *                             `MOCK_CODEX_MODEL_LIST_SHAPE` answers
 *                             `bad-data` or `bad-cursor` instead.
 * - `MOCK_CODEX_RATE_LIMIT_BUCKETS` — serve one entry in
 *                             `rateLimitsByLimitId`.
 * - `MOCK_CODEX_ACCOUNT_NOTIFY` — emit one `account/updated` notification
 *                             after the initialize response.
 * - `MOCK_CODEX_UNKNOWN_FRAMES` — emit a notification and two server→client
 *                             requests no registered thread owns, recording
 *                             each refusal as `server-request-error`.
 * - `MOCK_CODEX_FAIL_INITIALIZE`, `MOCK_CODEX_FAIL_THREAD`,
 *   `MOCK_CODEX_EPHEMERAL`, `MOCK_CODEX_NO_THREAD_ID`,
 *   `MOCK_CODEX_FAIL_RESUME` — startup and bind failure fixtures.
 * - `MOCK_CODEX_FLUSH_ON_EOF` / `MOCK_CODEX_FLUSH_DELAY_MS`,
 *   `MOCK_CODEX_IGNORE_EOF` / `MOCK_CODEX_SIGTERM_FILE`,
 *   `MOCK_CODEX_TRAP_SIGTERM` — the disposal-tier fixtures (EOF quiesce,
 *   SIGTERM cooperation, SIGKILL escalation).
 * - `MOCK_CODEX_TURN_START_FILE` — touched with the turn id when `turn/start`
 *                             arrives; `MOCK_CODEX_TURN_START_GATE_FILE` holds
 *                             the response (and every frame of the turn) until
 *                             it exists, so a test drives a turn whose id the
 *                             driver has not committed yet.
 *                             `MOCK_CODEX_TURN_START_GATE_MODE` picks what the
 *                             release carries: `plain` answers and runs the
 *                             scripted turn, `late-started` delivers the turn id
 *                             only as a `turn/started` notification after local
 *                             settlement, `bad-started` sends an unfoldable
 *                             `turn/started` before the response, and
 *                             `close-stdout` ends the server's output without
 *                             ever answering.
 * - `MOCK_CODEX_STEER_FILE` — touched when `turn/steer` arrives;
 *                             `MOCK_CODEX_STEER_GATE_FILE` holds its answer
 *                             until it exists.
 * - `MOCK_CODEX_INJECT_GATE_FILE` — `thread/inject_items` holds its answer
 *                             until the file exists, so a test can release the
 *                             thread while an injection is still in flight.
 * - `MOCK_CODEX_EARLY_STARTED` — emit one `turn/started` right after the
 *                             `thread/start` response, before any turn exists;
 *                             `MOCK_CODEX_EARLY_STARTED_FILE` is touched once it
 *                             is written.
 * - `MOCK_CODEX_FAIL_INJECT` — `thread/inject_items` answers an error.
 * - `MOCK_CODEX_MCP_PROBE` — probe every `mcp_servers.<name>` entry a
 *                             `thread/start`/`thread/resume` `config` override
 *                             carries: a credential-less POST
 *                             (`mcp-unauthorized`), then initialize,
 *                             `tools/list` (`mcp-tools`), and the
 *                             `MOCK_CODEX_MCP_CALL` (`{name, arguments}`)
 *                             `tools/call` (`mcp-call`) under the entry's
 *                             `http_headers`.
 * - `MOCK_CODEX_MCP_TURN_CALL` — JSON `{name, arguments}` called on the
 *                             thread's first `mcp_servers` entry during the
 *                             `mcp-turn-call` scenario, then reported as one
 *                             `mcpToolCall` item pair (`server` names the
 *                             endpoint, `tool` the dsh tool).
 *
 * `thread/resume` models the real rollout store: a thread earns a rollout only
 * once a turn starts on it (recorded under `$CODEX_HOME/mock-rollouts`), and
 * resuming a thread without one answers `-32600 no rollout found for thread
 * id ...` exactly as 0.153.4 does.
 *
 * It is not a test spec: the specs launch this protocol-only fixture through
 * `process.execPath` (Node's native type stripping). It imports no harness
 * code or workspace paths.
 *
 * @module @deepseek-ai/dsh-agent-codex/tests/mock-codex-app-server
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RECORD_FILE = process.env.MOCK_CODEX_RECORD_FILE
const TEXT = process.env.MOCK_CODEX_TEXT ?? 'mock codex answer'
const SCENARIO = process.env.MOCK_CODEX_SCENARIO ?? 'text'
const READY_FILE = process.env.MOCK_CODEX_READY_FILE
const EXIT_FILE = process.env.MOCK_CODEX_EXIT_FILE
const INITIALIZE_FILE = process.env.MOCK_CODEX_INITIALIZE_FILE
const INITIALIZE_GATE_FILE = process.env.MOCK_CODEX_INITIALIZE_GATE_FILE
const AUTH = process.env.MOCK_CODEX_AUTH ?? 'in'
const MODELS = process.env.MOCK_CODEX_MODELS === undefined
  ? [{ model: 'codex-x', displayName: 'Codex X', inputModalities: ['text', 'image'] }]
  : JSON.parse(process.env.MOCK_CODEX_MODELS) as unknown[]
const PAGE_SIZE = process.env.MOCK_CODEX_PAGE_SIZE === undefined
  ? undefined
  : Number(process.env.MOCK_CODEX_PAGE_SIZE)
const DECISIONS = process.env.MOCK_CODEX_DECISIONS === undefined
  ? ['accept', 'decline', 'cancel']
  : JSON.parse(process.env.MOCK_CODEX_DECISIONS) as string[]
const FLUSH_ON_EOF = process.env.MOCK_CODEX_FLUSH_ON_EOF
const TURN_START_FILE = process.env.MOCK_CODEX_TURN_START_FILE
const TURN_START_GATE = process.env.MOCK_CODEX_TURN_START_GATE_FILE
const TURN_START_GATE_MODE = process.env.MOCK_CODEX_TURN_START_GATE_MODE ?? 'plain'
const STEER_FILE = process.env.MOCK_CODEX_STEER_FILE
const STEER_GATE = process.env.MOCK_CODEX_STEER_GATE_FILE
const INJECT_GATE = process.env.MOCK_CODEX_INJECT_GATE_FILE
const EARLY_STARTED = process.env.MOCK_CODEX_EARLY_STARTED === '1'
const EARLY_STARTED_FILE = process.env.MOCK_CODEX_EARLY_STARTED_FILE
const FAIL_INJECT = process.env.MOCK_CODEX_FAIL_INJECT === '1'
const MCP_PROBE = process.env.MOCK_CODEX_MCP_PROBE === '1'
const MCP_CALL = process.env.MOCK_CODEX_MCP_CALL === undefined
  ? undefined
  : JSON.parse(process.env.MOCK_CODEX_MCP_CALL) as { name: string; arguments?: unknown }
const MCP_TURN_CALL = process.env.MOCK_CODEX_MCP_TURN_CALL === undefined
  ? undefined
  : JSON.parse(process.env.MOCK_CODEX_MCP_TURN_CALL) as { name: string; arguments?: unknown }
/** The `mcp_servers` entries the latest thread request's config carried. */
let threadMcpServers: ProbedMcpServer[] = []
/** Rollout store the real app-server keeps under `CODEX_HOME`. */
const ROLLOUT_ROOT = join(process.env.CODEX_HOME ?? process.cwd(), 'mock-rollouts')

if (process.env.MOCK_CODEX_PID_FILE !== undefined) {
  writeFileSync(process.env.MOCK_CODEX_PID_FILE, String(process.pid))
}

function record(method: string, params: unknown): void {
  if (RECORD_FILE === undefined) return
  appendFileSync(RECORD_FILE, `${JSON.stringify({ method, params })}\n`)
}

// ---- inbound frame validation ----

type JsonObject = Record<string, unknown>

/** A JSON-RPC error response the mock answers with: an unsupported method or invalid params. */
class MockProtocolError extends Error {
  /** The JSON-RPC error code the response carries. */
  readonly code: number

  /**
   * @param code - the JSON-RPC error code.
   * @param message - the error message.
   */
  constructor(code: number, message: string) {
    super(message)
    this.name = 'MockProtocolError'
    this.code = code
  }
}

function invalidParams(method: string, detail: string): never {
  throw new MockProtocolError(-32602, `${method}: ${detail}`)
}

function requireObject(params: JsonObject, field: string, method: string): JsonObject {
  const value = params[field]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidParams(method, `params.${field} must be an object`)
  }
  return value as JsonObject
}

function requireString(params: JsonObject, field: string, method: string): string {
  const value = params[field]
  if (typeof value !== 'string' || value.length === 0) {
    invalidParams(method, `params.${field} must be a non-empty string`)
  }
  return value
}

function requireArray(params: JsonObject, field: string, method: string): unknown[] {
  const value = params[field]
  if (!Array.isArray(value)) invalidParams(method, `params.${field} must be an array`)
  return value
}

function requireBoolean(params: JsonObject, field: string, method: string): boolean {
  const value = params[field]
  if (typeof value !== 'boolean') invalidParams(method, `params.${field} must be a boolean`)
  return value
}

/** Validate one `UserInput` array (`turn/start`, `turn/steer`). */
function requireInput(params: JsonObject, method: string): unknown[] {
  const input = requireArray(params, 'input', method)
  if (input.length === 0) invalidParams(method, 'params.input must not be empty')
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      invalidParams(method, 'params.input entries must be objects')
    }
    const item = entry as JsonObject
    const type = requireString(item, 'type', method)
    if (type === 'text' && typeof item.text !== 'string') {
      invalidParams(method, 'params.input text entries require a text string')
    }
    if (type === 'localImage' && typeof item.path !== 'string') {
      invalidParams(method, 'params.input localImage entries require a path string')
    }
  }
  return input
}

/** Validate the `threadId` of a thread-scoped request against this child's threads. */
function requireThread(params: JsonObject, method: string): string {
  const threadId = requireString(params, 'threadId', method)
  if (!threads.has(threadId)) invalidParams(method, `params.threadId "${threadId}" is not a known thread`)
  return threadId
}

// ---- line-delimited JSON-RPC 2.0 server over stdio ----

type JsonRpcId = string | number
let nextServerId = 0
const serverPending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const threads = new Set<string>()
let turnCounter = 0
let signedIn = AUTH !== 'out' && AUTH !== 'key' && AUTH !== 'stubborn'
/** The `hang` turn awaiting `turn/interrupt`, and the `steer` turn awaiting `turn/steer`. */
const waitingTurns = new Map<string, string>()

function send(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function respond(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: '2.0', method, params })
}

/** One server→client request; resolves with the client's `result`. */
function serverRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `srv_${++nextServerId}`
  return new Promise((resolve, reject) => {
    serverPending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function touchReady(): void {
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ready')
}

// ---- MCP endpoint probe ----

/** One MCP server reconstructed from the dotted `mcp_servers.*` config overrides. */
interface ProbedMcpServer {
  readonly name: string
  readonly url: string
  readonly headers: Record<string, string>
}

/**
 * Rebuild the `mcp_servers.<name>` tables a thread request's `config`
 * overrides carry: `mcp_servers.<name>.url` selects the entry and
 * `mcp_servers.<name>.http_headers` supplies its request headers.
 */
function mcpServersOf(config: unknown): ProbedMcpServer[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return []
  const servers = new Map<string, { url?: string; headers: Record<string, string> }>()
  for (const [key, value] of Object.entries(config as JsonObject)) {
    const match = /^mcp_servers\.([^.]+)\.(url|http_headers)$/.exec(key)
    if (match === null) continue
    const entry = servers.get(match[1]!) ?? { headers: {} }
    if (match[2] === 'url' && typeof value === 'string') entry.url = value
    if (match[2] === 'http_headers' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, header] of Object.entries(value as JsonObject)) {
        if (typeof header === 'string') entry.headers[name] = header
      }
    }
    servers.set(match[1]!, entry)
  }
  return [...servers.entries()].flatMap(([name, server]) =>
    server.url === undefined ? [] : [{ name, url: server.url, headers: server.headers }])
}

/**
 * Call `MOCK_CODEX_MCP_TURN_CALL` on the thread's first `mcp_servers` entry
 * mid-turn, then report it as one `mcpToolCall` item pair — the shape Codex
 * emits for MCP calls, with `server` naming the configured endpoint and
 * `tool` the dsh tool it ran.
 */
async function emitMcpTurnCall(threadId: string, turnId: string): Promise<void> {
  const server = threadMcpServers[0]
  if (MCP_TURN_CALL === undefined || server === undefined) {
    record('mcp-turn-call', { error: 'no mcp_servers entry' })
    return
  }
  try {
    const opened = await mcpPost(server.url, server.headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mock-codex-app-server', version: '0' },
      },
    })
    if (opened.error !== undefined || opened.result === undefined) {
      record('mcp-turn-call', opened)
      return
    }
    await mcpPost(server.url, server.headers, { jsonrpc: '2.0', method: 'notifications/initialized' })
    const called = await mcpPost(server.url, server.headers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: MCP_TURN_CALL.name, arguments: MCP_TURN_CALL.arguments ?? {} },
    })
    record('mcp-turn-call', called)
    const payload = called.result as { content?: unknown[]; isError?: boolean } | undefined
    const failed = payload?.isError === true || called.error !== undefined
    notify('item/started', {
      threadId,
      turnId,
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server: server.name,
        tool: MCP_TURN_CALL.name,
        arguments: MCP_TURN_CALL.arguments ?? {},
      },
    })
    notify('item/completed', {
      threadId,
      turnId,
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server: server.name,
        tool: MCP_TURN_CALL.name,
        status: failed ? 'failed' : 'completed',
        result: { content: payload?.content ?? [] },
        ...failed ? { error: { message: 'mcp call failed' } } : {},
      },
    })
  } catch (error) {
    record('mcp-turn-call', { error: String(error) })
  }
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
 * Probe every `mcp_servers` entry a thread request's `config` carried, so a
 * test reads from the record whether the endpoint is reachable, requires its
 * bearer credential, and serves the bridged tools. A probe failure lands as
 * `mcp-error` rather than failing the thread request.
 */
async function probeMcpConfig(config: unknown): Promise<void> {
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mock-codex-app-server', version: '0' },
    },
  }
  for (const server of mcpServersOf(config)) {
    try {
      record('mcp-unauthorized', await mcpPost(server.url, {}, init))
      record('mcp-initialize', await mcpPost(server.url, server.headers, init))
      await mcpPost(server.url, server.headers, { jsonrpc: '2.0', method: 'notifications/initialized' })
      record('mcp-tools', await mcpPost(server.url, server.headers, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
      if (MCP_CALL !== undefined) {
        record('mcp-call', await mcpPost(server.url, server.headers, {
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

/** One bounded poll beat for the gate fixtures. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function accountRead(): Record<string, unknown> {
  if (!signedIn) return { requiresOpenaiAuth: true, account: null }
  // `bare` models an account whose optional identity members are absent.
  if (AUTH === 'bare') return { requiresOpenaiAuth: true, account: { type: 'apiKey' } }
  return {
    requiresOpenaiAuth: true,
    account: { type: 'chatgpt', email: 'mock@example.com', planType: 'pro' },
  }
}

/** The `ThreadStartResponse`/`ThreadResumeResponse` members the driver reads, plus their required peers. */
function threadResponse(id: string, ephemeral: boolean): Record<string, unknown> {
  if (process.env.MOCK_CODEX_NO_ROUTE === '1') {
    return { thread: { id, ephemeral, sessionId: `session-${id}` } }
  }
  return {
    thread: { id, ephemeral, sessionId: `session-${id}` },
    model: 'codex-x',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: process.env.CODEX_HOME ?? process.cwd(),
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: 'medium',
  }
}

/** Emit the shared agentMessage tail: started → delta → completed. */
function emitMessage(threadId: string, turnId: string, itemId: string): void {
  notify('item/started', { threadId, turnId, item: { id: itemId, type: 'agentMessage' } })
  notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: TEXT })
  notify('item/completed', {
    threadId,
    turnId,
    item: { id: itemId, type: 'agentMessage', text: TEXT, phase: null },
  })
}

function completeTurn(threadId: string, turnId: string, status: string, error?: unknown): void {
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, status, items: [], ...error === undefined ? {} : { error } },
  })
}

/** The scripted turn body, run after `turn/start` answered (or before, for `early`). */
async function runTurn(threadId: string, turnId: string): Promise<void> {
  if (SCENARIO === 'late-turn' || SCENARIO === 'foreign-frame') {
    // Let the `turn/start` response reach the client first, so every frame of
    // this turn lands against an already committed turn id.
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  if (SCENARIO === 'early-item-first') {
    // An item frame before `turn/started` latches a provisional turn id, which
    // `turn/started` and the response must then confirm.
    notify('item/started', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage' } })
    notify('turn/started', { threadId, turn: { id: turnId } })
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: TEXT })
    notify('item/completed', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage', text: TEXT } })
    completeTurn(threadId, turnId, 'completed')
    return
  }
  if (SCENARIO === 'early-mismatch') {
    // A provisional turn id the `turn/start` response contradicts.
    notify('item/started', { threadId, turnId: 'turn-other', item: { id: 'msg-1', type: 'agentMessage' } })
    return
  }
  if (SCENARIO === 'early-conflict') {
    // Two frames naming different turns before `turn/start` commits either.
    notify('item/started', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage' } })
    notify('item/started', { threadId, turnId: 'turn-other', item: { id: 'msg-2', type: 'agentMessage' } })
    return
  }
  notify('turn/started', { threadId, turn: { id: turnId } })
  if (process.env.MOCK_CODEX_THREAD_NOTIFY === '1') {
    notify('thread/name/updated', { threadId, name: 'renamed' })
  }
  switch (SCENARIO) {
    case 'hang':
    case 'steer':
    case 'steer-refused':
      notify('item/started', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage' } })
      waitingTurns.set(turnId, threadId)
      touchReady()
      return
    case 'never':
      touchReady()
      return
    case 'crash':
      notify('item/started', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage' } })
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: TEXT })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      if (EXIT_FILE !== undefined) writeFileSync(EXIT_FILE, 'exited')
      process.exit(17)
      return
    case 'reasoning':
      notify('item/started', { threadId, turnId, item: { id: 'r-1', type: 'reasoning' } })
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          id: 'r-1',
          type: 'reasoning',
          summary: ['thinking hard'],
          content: ['deep thought'],
        },
      })
      break
    case 'bad-item-first':
      // Only the child's first turn carries a foldable-frame violation, so a
      // second session on the same connection still runs a healthy turn.
      if (turnId === 'turn-1') {
        notify('item/completed', { threadId, turnId, item: { type: 'commandExecution' } })
        return
      }
      break
    case 'late-frame':
      emitMessage(threadId, turnId, 'msg-1')
      completeTurn(threadId, turnId, 'completed')
      // Written after the `turn/start` response, once the driver has settled
      // the turn: the thread then has no live drive, so the failure must reach
      // the agent's error channel alone.
      setImmediate(() => { notify('turn/started', { threadId, turn: 'not-a-turn' }) })
      return
    case 'tool':
    case 'tool-open':
      notify('item/started', {
        threadId,
        turnId,
        item: { id: 'cmd-1', type: 'commandExecution', command: 'true', cwd: '/' },
      })
      if (SCENARIO === 'tool') {
        notify('item/completed', {
          threadId,
          turnId,
          item: {
            id: 'cmd-1',
            type: 'commandExecution',
            command: 'true',
            status: 'completed',
            aggregatedOutput: 'tool output',
            exitCode: 0,
            durationMs: 5,
          },
        })
      }
      break
    case 'message-open':
      // The stream stays open when the turn completes: settlement closes it.
      notify('item/started', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage' } })
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: TEXT })
      completeTurn(threadId, turnId, 'completed')
      return
    case 'interleaved':
      // One agentMessage item streams text, yields to a tool pair, then
      // resumes; its completion text is the whole item's, so the driver
      // splits it across the two attempts the advertisement settles between.
      notify('item/started', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage' } })
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: 'before ' })
      notify('item/started', {
        threadId,
        turnId,
        item: { id: 'cmd-1', type: 'commandExecution', command: 'true', cwd: '/' },
      })
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'true',
          status: 'completed',
          aggregatedOutput: 'tool output',
          exitCode: 0,
          durationMs: 5,
        },
      })
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: ' after' })
      notify('item/completed', {
        threadId,
        turnId,
        item: { id: 'msg-1', type: 'agentMessage', text: 'before  after', phase: null },
      })
      completeTurn(threadId, turnId, 'completed')
      return
    case 'interleaved-settled':
      // The tool pair lands between the item's last delta and its completion,
      // whose text repeats what already streamed: the advertisement settled
      // the first attempt, and the continuation attempt carries no new text.
      notify('item/started', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage' } })
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: TEXT })
      notify('item/started', {
        threadId,
        turnId,
        item: { id: 'cmd-1', type: 'commandExecution', command: 'true', cwd: '/' },
      })
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'true',
          status: 'completed',
          aggregatedOutput: 'tool output',
          exitCode: 0,
          durationMs: 5,
        },
      })
      notify('item/completed', {
        threadId,
        turnId,
        item: { id: 'msg-1', type: 'agentMessage', text: TEXT, phase: null },
      })
      completeTurn(threadId, turnId, 'completed')
      return
    case 'advertised-open':
      // The tool-call advertisement settles the message item's streaming
      // attempt, and the item never completes: turn settlement must skip the
      // ended attempt rather than double-committing it.
      notify('item/started', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage' } })
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: TEXT })
      notify('item/started', {
        threadId,
        turnId,
        item: { id: 'cmd-1', type: 'commandExecution', command: 'true', cwd: '/' },
      })
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'true',
          status: 'completed',
          aggregatedOutput: 'tool output',
          exitCode: 0,
          durationMs: 5,
        },
      })
      completeTurn(threadId, turnId, 'completed')
      return
    case 'foreign-frame':
      // One frame naming a turn the driver never committed, while its own turn
      // is live and committed from the response.
      emitMessage(threadId, turnId, 'msg-1')
      notify('item/started', { threadId, turnId: 'turn-other', item: { id: 'msg-2', type: 'agentMessage' } })
      notify('item/agentMessage/delta', { threadId, turnId: 'turn-other', itemId: 'msg-2', delta: 'foreign text' })
      completeTurn(threadId, turnId, 'completed')
      return
    case 'file-change': {
      const changes = [{ path: 'a.txt', kind: 'update', diff: '@@\n-old\n+new\n' }]
      notify('item/started', {
        threadId,
        turnId,
        item: { id: 'fc-1', type: 'fileChange', changes },
      })
      notify('item/completed', {
        threadId,
        turnId,
        item: { id: 'fc-1', type: 'fileChange', status: 'completed', changes },
      })
      break
    }
    case 'mcp-turn-call': {
      // The harness runs the bridged tool itself, then reports its own
      // mcpToolCall pair — the driver only projects what it observed.
      await emitMcpTurnCall(threadId, turnId)
      break
    }
    case 'items-tools':
      emitToolsTurn(threadId, turnId)
      return
    case 'progress-mirrors':
      emitProgressTurn(threadId, turnId)
      return
    case 'odd-items':
      emitOddItemsTurn(threadId, turnId)
      return
    case 'diff-shapes':
      notify('item/started', {
        threadId,
        turnId,
        item: { id: 'fc-1', type: 'fileChange' },
      })
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          id: 'fc-1',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: 'pure-add.txt', kind: 'add', diff: '@@ -0,0 +1 @@\n+added\n' },
            { path: 'no-newline.txt', kind: 'update', diff: '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n' },
            { path: 'malformed.txt', kind: 'update', diff: 'not a diff at all' },
          ],
        },
      })
      emitMessage(threadId, turnId, 'msg-1')
      completeTurn(threadId, turnId, 'completed')
      return
    case 'items-misc':
      emitMiscTurn(threadId, turnId)
      return
    case 'reasoning-only':
      notify('item/started', { threadId, turnId, item: { id: 'r-1', type: 'reasoning' } })
      notify('item/completed', {
        threadId,
        turnId,
        item: { id: 'r-1', type: 'reasoning', summary: ['only thoughts'], content: [] },
      })
      completeTurn(threadId, turnId, 'completed')
      return
    case 'bad-status':
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'mystery' } })
      return
    case 'server-interrupt':
      completeTurn(threadId, turnId, 'interrupted')
      return
    case 'fail-bare':
      completeTurn(threadId, turnId, 'failed')
      return
    case 'unsupported-request': {
      const outcome = await serverRequest('item/nonexistent/request', { threadId, turnId })
        .then(() => 'answered', (error: unknown) => String(error))
      record('unsupported-request', outcome)
      completeTurn(threadId, turnId, 'completed')
      return
    }
    case 'approval':
    case 'approval-bare':
    case 'file-approval':
    case 'permissions':
    case 'permissions-files':
    case 'permissions-bare':
    case 'user-input':
    case 'user-input-odd':
    case 'user-input-bare':
    case 'elicit':
    case 'elicit-plain':
    case 'elicit-rich':
    case 'elicit-loose':
    case 'elicit-typed':
    case 'elicit-nomessage':
      await runInteraction(threadId, turnId)
      break
    case 'fail':
      completeTurn(threadId, turnId, 'failed', {
        codexErrorInfo: 'serverOverloaded',
        message: 'server overloaded',
      })
      return
    case 'max-tokens':
      completeTurn(threadId, turnId, 'failed', {
        codexErrorInfo: 'contextWindowExceeded',
        message: 'context window exceeded',
      })
      return
    default:
      break
  }
  emitMessage(threadId, turnId, 'msg-1')
  completeTurn(threadId, turnId, 'completed')
}

/**
 * One turn carrying a tool item of every projected kind, plus an
 * `item/completed` for an id the driver never opened and an unrecognized item
 * type, so one run covers the whole projection switch.
 */
function emitToolsTurn(threadId: string, turnId: string): void {
  const start = (item: Record<string, unknown>): void => {
    notify('item/started', { threadId, turnId, item })
  }
  const complete = (item: Record<string, unknown>): void => {
    notify('item/completed', { threadId, turnId, item })
  }
  const changes = [{ path: 'a.txt', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n' }]

  start({ id: 'cmd-1', type: 'commandExecution', command: 'false', cwd: '/work' })
  complete({
    id: 'cmd-1',
    type: 'commandExecution',
    command: 'false',
    cwd: '/work',
    status: 'failed',
    aggregatedOutput: 'boom',
    exitCode: 1,
    durationMs: 12,
  })

  start({ id: 'cmd-2', type: 'commandExecution' })
  complete({ id: 'cmd-2', type: 'commandExecution' })

  start({ id: 'fc-1', type: 'fileChange', changes })
  complete({ id: 'fc-1', type: 'fileChange', status: 'failed', changes })

  start({ id: 'fc-2', type: 'fileChange' })
  complete({
    id: 'fc-2',
    type: 'fileChange',
    changes: ['not-an-object', { path: '' }, { path: 'no-diff.txt' }],
  })

  start({ id: 'mcp-1', type: 'mcpToolCall', server: 'fs', tool: 'read', arguments: { path: 'a' } })
  complete({
    id: 'mcp-1',
    type: 'mcpToolCall',
    server: 'fs',
    tool: 'read',
    status: 'failed',
    error: { message: 'mcp refused' },
    result: { content: ['raw-entry', { type: 'text', text: 'partial' }, { type: 'image', data: 'x' }] },
  })

  start({ id: 'mcp-2', type: 'mcpToolCall' })
  complete({ id: 'mcp-2', type: 'mcpToolCall' })

  start({ id: 'dyn-1', type: 'dynamicToolCall', namespace: 'app', tool: 'do', arguments: { n: 1 } })
  complete({
    id: 'dyn-1',
    type: 'dynamicToolCall',
    namespace: 'app',
    tool: 'do',
    status: 'completed',
    success: false,
    contentItems: ['raw-entry', { type: 'inputText', text: 'dynamic out' }, { type: 'other', value: 1 }],
  })

  start({ id: 'dyn-2', type: 'dynamicToolCall', tool: 'plain' })
  complete({ id: 'dyn-2', type: 'dynamicToolCall', tool: 'plain' })

  start({ id: 'collab-1', type: 'collabAgentToolCall', tool: 'spawn', prompt: 'do work', model: 'codex-x' })
  complete({
    id: 'collab-1',
    type: 'collabAgentToolCall',
    tool: 'spawn',
    prompt: 'do work',
    model: 'codex-x',
    status: 'failed',
    failure: { message: 'collab failed' },
  })

  start({ id: 'collab-2', type: 'collabAgentToolCall' })
  complete({ id: 'collab-2', type: 'collabAgentToolCall', failure: {} })

  start({ id: 'ws-1', type: 'webSearch', query: 'codex' })
  complete({ id: 'ws-1', type: 'webSearch', query: 'codex', status: 'completed', result: 'web result' })

  start({ id: 'ws-2', type: 'webSearch' })
  complete({ id: 'ws-2', type: 'webSearch' })

  start({ id: 'img-1', type: 'imageGeneration' })
  complete({ id: 'img-1', type: 'imageGeneration', status: 'completed' })

  start({ id: 'plan-1', type: 'plan', text: 'step one' })
  complete({ id: 'plan-1', type: 'plan', text: 'step one' })

  start({ id: 'plan-2', type: 'plan' })
  complete({ id: 'plan-2', type: 'plan' })

  start({ id: 'sleep-1', type: 'sleep' })
  complete({ id: 'sleep-1', type: 'sleep', status: 'completed' })

  // Completions for items the driver never opened are dropped.
  complete({ id: 'ghost-1', type: 'commandExecution', status: 'completed' })
  complete({ id: 'ghost-2', type: 'fileChange', status: 'completed' })
  complete({ id: 'ghost-3', type: 'mcpToolCall', status: 'completed' })
  complete({ id: 'ghost-4', type: 'dynamicToolCall', status: 'completed' })
  complete({ id: 'ghost-5', type: 'webSearch', status: 'completed' })
  complete({ id: 'ghost-6', type: 'sleep', status: 'completed' })

  // A completion for an item the driver never opened is dropped.
  complete({ id: 'ghost-1', type: 'commandExecution', status: 'completed' })
  emitMessage(threadId, turnId, 'msg-1')
  completeTurn(threadId, turnId, 'completed')
}

/**
 * One turn that carries every live progress mirror the driver must ignore:
 * turn-level mirrors, item output deltas, patch updates, MCP progress, and
 * auto-approval review notices.
 */
function emitProgressTurn(threadId: string, turnId: string): void {
  const frame = (method: string, params: Record<string, unknown> = {}): void => {
    notify(method, { threadId, turnId, ...params })
  }
  notify('item/started', {
    threadId,
    turnId,
    item: { id: 'cmd-1', type: 'commandExecution', command: 'true', cwd: '/' },
  })
  frame('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'out' })
  frame('item/fileChange/outputDelta', { itemId: 'fc-1', delta: 'patch' })
  frame('item/fileChange/patchUpdated', { itemId: 'fc-1', changes: [] })
  frame('item/mcpToolCall/progress', { itemId: 'mcp-1', message: 'working' })
  frame('item/autoApprovalReview/started', { itemId: 'cmd-1' })
  frame('item/autoApprovalReview/completed', { itemId: 'cmd-1' })
  frame('item/reasoning/textDelta', { itemId: 'r-1', delta: 'thinking' })
  frame('item/reasoning/summaryTextDelta', { itemId: 'r-1', delta: 'summary' })
  frame('item/reasoning/summaryPartAdded', { itemId: 'r-1', summaryIndex: 0 })
  frame('turn/diff/updated', { diff: 'x' })
  frame('turn/plan/updated', { plan: [] })
  frame('turn/moderation/metadata', { metadata: {} })
  notify('item/completed', {
    threadId,
    turnId,
    item: { id: 'cmd-1', type: 'commandExecution', command: 'true', cwd: '/', status: 'completed', aggregatedOutput: '' },
  })
  emitMessage(threadId, turnId, 'msg-1')
  completeTurn(threadId, turnId, 'completed')
}

/**
 * One turn carrying the item-start and item-completion forms whose optional
 * members are absent: unknown item types, unaddressed tool fields, and
 * completions that report no status, result, or failure.
 */
function emitOddItemsTurn(threadId: string, turnId: string): void {
  const start = (item: Record<string, unknown>): void => {
    notify('item/started', { threadId, turnId, item })
  }
  const complete = (item: Record<string, unknown>): void => {
    notify('item/completed', { threadId, turnId, item })
  }

  start({ id: 'view-1', type: 'imageView' })
  complete({ id: 'view-1', type: 'imageView' })
  start({ id: 'sub-1', type: 'subAgentActivity' })
  complete({ id: 'sub-1', type: 'subAgentActivity' })
  start({ id: 'review-in', type: 'enteredReviewMode' })
  complete({ id: 'review-in', type: 'enteredReviewMode' })
  start({ id: 'review-out', type: 'exitedReviewMode' })
  complete({ id: 'review-out', type: 'exitedReviewMode' })
  start({ id: 'compact-1', type: 'contextCompaction' })
  complete({ id: 'compact-1', type: 'contextCompaction' })

  start({ id: 'cmd-1', type: 'commandExecution' })
  complete({ id: 'cmd-1', type: 'commandExecution' })

  start({ id: 'fc-1', type: 'fileChange' })
  complete({ id: 'fc-1', type: 'fileChange', status: 'completed' })

  start({ id: 'mcp-1', type: 'mcpToolCall' })
  complete({ id: 'mcp-1', type: 'mcpToolCall', status: 'completed' })

  start({ id: 'dyn-1', type: 'dynamicToolCall', tool: 'do' })
  complete({ id: 'dyn-1', type: 'dynamicToolCall', status: 'completed' })

  start({ id: 'dyn-2', type: 'dynamicToolCall' })
  complete({ id: 'dyn-2', type: 'dynamicToolCall', status: 'completed' })

  start({ id: 'collab-1', type: 'collabAgentToolCall' })
  complete({ id: 'collab-1', type: 'collabAgentToolCall', status: 'completed' })

  start({ id: 'ws-1', type: 'webSearch' })
  complete({ id: 'ws-1', type: 'webSearch' })

  start({ id: 'plan-1', type: 'plan' })
  complete({ id: 'plan-1', type: 'plan' })

  start({ id: 'msg-1', type: 'agentMessage' })
  complete({ id: 'msg-1', type: 'agentMessage' })

  completeTurn(threadId, turnId, 'completed')
}

/**
 * One turn whose items need no tool result: echoed user input, an internal
 * prompt fragment, a bare reasoning item, and an assistant delta that arrives
 * without an `item/started`.
 */
function emitMiscTurn(threadId: string, turnId: string): void {
  notify('item/started', {
    threadId,
    turnId,
    item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
  })
  notify('item/started', { threadId, turnId, item: { id: 'hook-1', type: 'hookPrompt' } })
  notify('item/started', { threadId, turnId, item: { id: 'fco-1', type: 'functionCallOutput' } })
  notify('item/started', { threadId, turnId, item: { id: 'r-1', type: 'reasoning' } })
  notify('item/completed', { threadId, turnId, item: { id: 'r-1', type: 'reasoning' } })
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: TEXT })
  notify('item/completed', { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage', text: TEXT } })
  completeTurn(threadId, turnId, 'completed')
}

/** The server→client request half of the interactive scenarios. */
async function runInteraction(threadId: string, turnId: string): Promise<void> {
  switch (SCENARIO) {
    case 'approval': {
      notify('item/started', {
        threadId,
        turnId,
        item: { id: 'cmd-1', type: 'commandExecution', command: 'rm -rf /' },
      })
      const outcome = await serverRequest('item/commandExecution/requestApproval', {
        threadId,
        turnId,
        itemId: 'cmd-1',
        command: 'rm -rf /',
        reason: 'destructive command',
        availableDecisions: DECISIONS,
      }).catch((error: unknown) => String(error))
      record('approval-decision', outcome)
      notify('item/completed', {
        threadId,
        turnId,
        item: { id: 'cmd-1', type: 'commandExecution', status: 'completed', aggregatedOutput: '' },
      })
      return
    }
    case 'permissions': {
      const outcome = await serverRequest('item/permissions/requestApproval', {
        threadId,
        turnId,
        reason: 'needs network',
        permissions: { network: { enabled: true } },
      })
      record('permissions-outcome', outcome)
      return
    }
    case 'permissions-files': {
      const outcome = await serverRequest('item/permissions/requestApproval', {
        threadId,
        turnId,
        permissions: { fileSystem: { read: ['/work'] } },
      })
      record('permissions-outcome', outcome)
      return
    }
    case 'permissions-bare': {
      const outcome = await serverRequest('item/permissions/requestApproval', { threadId, turnId })
      record('permissions-outcome', outcome)
      return
    }
    case 'user-input-bare': {
      const outcome = await serverRequest('item/tool/requestUserInput', { threadId, turnId })
      record('user-input-answers', outcome)
      return
    }
    case 'file-approval': {
      const outcome = await serverRequest('item/fileChange/requestApproval', {
        threadId,
        turnId,
        reason: 'writes a file',
        availableDecisions: DECISIONS,
      })
      record('approval-decision', outcome)
      return
    }
    case 'approval-bare': {
      const outcome = await serverRequest('item/commandExecution/requestApproval', {
        threadId,
        turnId,
        availableDecisions: DECISIONS,
      })
      record('approval-decision', outcome)
      return
    }
    case 'user-input-odd': {
      const outcome = await serverRequest('item/tool/requestUserInput', {
        threadId,
        turnId,
        questions: [
          'not-a-question',
          { id: 'no-text' },
          { id: 'choice', question: 'Pick one', options: ['not-an-option', { description: 'no label' }, { label: 'beta' }] },
          { id: 'plain', question: 'Free text' },
        ],
      })
      record('user-input-answers', outcome)
      return
    }
    case 'elicit-nomessage': {
      const outcome = await serverRequest('mcpServer/elicitation/request', { threadId })
      record('elicitation-outcome', outcome)
      return
    }
    case 'user-input': {
      const outcome = await serverRequest('item/tool/requestUserInput', {
        threadId,
        turnId,
        itemId: 'q-1',
        questions: [{
          id: 'choice',
          question: 'Pick one',
          header: 'Choice',
          options: [
            { label: 'alpha', description: 'first' },
            { label: 'beta' },
          ],
        }],
      })
      record('user-input-answers', outcome)
      return
    }
    case 'elicit-typed': {
      const outcome = await serverRequest('mcpServer/elicitation/request', {
        threadId,
        message: 'mock typed elicitation',
        requestedSchema: {
          type: 'object',
          properties: {
            agree: { type: 'boolean', title: 'Agree?' },
            count: { type: 'number', description: 'How many?' },
            choice: { type: 'string', enum: ['alpha', 'beta'] },
          },
        },
      })
      record('elicitation-outcome', outcome)
      return
    }
    case 'elicit':
    case 'elicit-plain':
    case 'elicit-rich':
    case 'elicit-loose': {
      const schema = SCENARIO === 'elicit-rich'
        ? {
          type: 'object',
          properties: {
            choice: { type: 'string', description: 'Pick one', enum: ['alpha', 'beta'] },
            nested: { type: 'object', properties: {} },
          },
        }
        : SCENARIO === 'elicit-loose'
          ? {
            // One property value is not a schema object and one enum member is
            // not a string: neither is a form field the driver can ask about.
            type: 'object',
            properties: {
              loose: 'not-a-schema',
              choice: { type: 'string', enum: ['alpha', 7] },
            },
          }
          : SCENARIO === 'elicit'
            ? {
              type: 'object',
              properties: {
                choice: { type: 'string', description: 'Pick one', enum: ['alpha', 'beta'] },
              },
            }
            : undefined
      const outcome = await serverRequest('mcpServer/elicitation/request', {
        threadId,
        message: 'mock elicitation',
        ...schema === undefined ? {} : { requestedSchema: schema },
      })
      record('elicitation-outcome', outcome)
      return
    }
    default:
      return
  }
}

// ---- request dispatch ----

/** Wait for the handshake gate, when the test scripted one. */
async function awaitInitializeGate(): Promise<void> {
  if (INITIALIZE_FILE !== undefined) writeFileSync(INITIALIZE_FILE, 'received')
  if (INITIALIZE_GATE_FILE === undefined) return
  while (!existsSync(INITIALIZE_GATE_FILE)) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
}

/**
 * Emit one notification and two server→client requests that no registered
 * thread owns, then record the error responses the client answered with. The
 * connection must stay live after refusing them.
 */
async function probeUnownedFrames(): Promise<void> {
  notify('turn/plan/updated', { threadId: 'thread-unowned', turnId: 'turn-unowned' })
  await serverRequest('item/commandExecution/requestApproval', {
    threadId: 'thread-unowned',
    turnId: 'turn-unowned',
    itemId: 'cmd-unowned',
  }).catch((error: unknown) => { record('server-request-error', String(error)) })
  await serverRequest('item/commandExecution/requestApproval', {})
    .catch((error: unknown) => { record('server-request-error', String(error)) })
}

async function dispatch(method: string, params: JsonObject): Promise<unknown> {
  record(method, params)
  switch (method) {
    case 'initialize': {
      const clientInfo = requireObject(params, 'clientInfo', method)
      requireString(clientInfo, 'name', method)
      requireString(clientInfo, 'title', method)
      requireString(clientInfo, 'version', method)
      requireObject(params, 'capabilities', method)
      if (process.env.MOCK_CODEX_FAIL_INITIALIZE === '1') process.exit(11)
      await awaitInitializeGate()
      if (process.env.MOCK_CODEX_ACCOUNT_NOTIFY === '1') {
        setImmediate(() => { notify('account/updated', { authMode: null, planType: null }) })
      }
      if (process.env.MOCK_CODEX_UNKNOWN_FRAMES === '1') {
        setImmediate(() => { void probeUnownedFrames() })
      }
      return {
        userAgent: 'mock-codex/0.153.4',
        codexHome: process.env.CODEX_HOME ?? '',
        platformFamily: 'unix',
        platformOs: 'linux',
      }
    }
    case 'thread/start': {
      if (params.ephemeral !== false) invalidParams(method, 'params.ephemeral must be false for a durable thread')
      if (params.cwd !== undefined && typeof params.cwd !== 'string') invalidParams(method, 'params.cwd must be a string')
      if (process.env.MOCK_CODEX_FAIL_THREAD === '1') {
        throw new Error('thread/start refused')
      }
      const threadId = process.env.MOCK_CODEX_THREAD_ID ?? `thread-${randomUUID()}`
      threads.add(threadId)
      if (EARLY_STARTED) {
        // One frame for this thread before any turn exists on it. The marker
        // lets a test prove the frame reached the client before its next round
        // trip, since the notification is written first.
        setImmediate(() => {
          notify('turn/started', { threadId, turn: { id: 'turn-unowned' } })
          if (EARLY_STARTED_FILE !== undefined) writeFileSync(EARLY_STARTED_FILE, 'sent')
        })
      }
      const ephemeral = process.env.MOCK_CODEX_EPHEMERAL === '1'
      const response = threadResponse(threadId, ephemeral)
      if (process.env.MOCK_CODEX_NO_THREAD_ID === '1') delete (response.thread as JsonObject).id
      threadMcpServers = mcpServersOf(params.config)
      if (MCP_PROBE) await probeMcpConfig(params.config)
      return response
    }
    case 'thread/resume': {
      if (process.env.MOCK_CODEX_FAIL_RESUME === '1') {
        throw new Error('thread/resume refused')
      }
      const requested = requireString(params, 'threadId', method)
      if (params.excludeTurns !== undefined && typeof params.excludeTurns !== 'boolean') {
        invalidParams(method, 'params.excludeTurns must be a boolean')
      }
      if (!existsSync(join(ROLLOUT_ROOT, requested))) {
        // The real app-server answers exactly this for a thread it never stored.
        throw new MockProtocolError(-32600, `no rollout found for thread id ${requested}`)
      }
      threads.add(requested)
      threadMcpServers = mcpServersOf(params.config)
      if (MCP_PROBE) await probeMcpConfig(params.config)
      return threadResponse(process.env.MOCK_CODEX_RESUME_THREAD_ID ?? requested, false)
    }
    case 'thread/unsubscribe': {
      const threadId = requireString(params, 'threadId', method)
      if (process.env.MOCK_CODEX_FAIL_UNSUBSCRIBE === '1') {
        throw new MockProtocolError(-32603, 'thread/unsubscribe refused')
      }
      if (!threads.delete(threadId)) return { status: 'notLoaded' }
      return { status: 'unsubscribed' }
    }
    case 'thread/inject_items': {
      requireThread(params, method)
      const items = requireArray(params, 'items', method)
      if (items.length === 0) invalidParams(method, 'params.items must not be empty')
      for (const entry of items) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          invalidParams(method, 'params.items entries must be objects')
        }
        requireString(entry as JsonObject, 'type', method)
      }
      if (INJECT_GATE !== undefined) {
        while (!existsSync(INJECT_GATE)) await delay(5)
      }
      if (FAIL_INJECT) throw new MockProtocolError(-32600, 'thread/inject_items refused')
      return {}
    }
    case 'turn/start': {
      const threadId = requireThread(params, method)
      requireInput(params, method)
      if (params.sandboxPolicy !== undefined) requireObject(params, 'sandboxPolicy', method)
      const turnId = `turn-${++turnCounter}`
      // A started turn is what persists the thread's rollout on disk.
      mkdirSync(ROLLOUT_ROOT, { recursive: true })
      writeFileSync(join(ROLLOUT_ROOT, threadId), 'rollout')
      if (TURN_START_FILE !== undefined) writeFileSync(TURN_START_FILE, turnId)
      if (TURN_START_GATE !== undefined) {
        // Hold the response (and every frame of the turn) until the test
        // releases the gate: the driver drives a turn whose id it has not
        // committed yet.
        while (!existsSync(TURN_START_GATE)) await delay(5)
        if (TURN_START_GATE_MODE === 'late-started') {
          // The id reaches the driver only as a notification, after the local
          // turn already settled.
          notify('turn/started', { threadId, turn: { id: turnId } })
          return { turn: { id: turnId } }
        }
        if (TURN_START_GATE_MODE === 'bad-started') {
          // A frame the driver cannot fold, before it ever learns the id.
          notify('turn/started', { threadId, turn: 'not-a-turn' })
          return { turn: { id: turnId } }
        }
        if (TURN_START_GATE_MODE === 'close-stdout') {
          // End the server's output without ever answering: the wire dies while
          // this turn's id is still unknown. The dispatch never settles, so no
          // write follows the closed stream.
          process.stdout.end()
          return new Promise<never>(() => {})
        }
        // The scripted turn registers itself as steerable before the response,
        // so a steer that lands first is still addressed to this turn.
        if (SCENARIO === 'steer') waitingTurns.set(turnId, threadId)
        void runTurn(threadId, turnId)
        return { turn: { id: turnId } }
      }
      if (SCENARIO === 'early' || SCENARIO === 'early-conflict') {
        // Emit the whole turn before the response so the driver must buffer
        // frames against the still-provisional turn id.
        await runTurn(threadId, turnId)
        return { turn: { id: turnId } }
      }
      void runTurn(threadId, turnId)
      return { turn: { id: turnId } }
    }
    case 'turn/steer': {
      requireThread(params, method)
      requireInput(params, method)
      if (STEER_FILE !== undefined) writeFileSync(STEER_FILE, 'steer')
      if (STEER_GATE !== undefined) {
        while (!existsSync(STEER_GATE)) await delay(5)
      }
      const turnId = requireString(params, 'expectedTurnId', method)
      const threadId = waitingTurns.get(turnId)
      if (SCENARIO === 'steer-refused') {
        throw new MockProtocolError(-32600, `no steerable turn ${turnId}`)
      }
      if (SCENARIO !== 'steer' || threadId === undefined) {
        throw new MockProtocolError(-32600, `no steerable turn ${turnId}`)
      }
      waitingTurns.delete(turnId)
      emitMessage(threadId, turnId, 'msg-1')
      completeTurn(threadId, turnId, 'completed')
      return { turnId }
    }
    case 'turn/interrupt': {
      requireThread(params, method)
      const turnId = requireString(params, 'turnId', method)
      const threadId = waitingTurns.get(turnId)
        ?? requireString(params, 'threadId', method)
      waitingTurns.delete(turnId)
      if (SCENARIO === 'hang') completeTurn(threadId, turnId, 'interrupted')
      return {}
    }
    case 'account/read':
      return accountRead()
    case 'account/login/start': {
      const type = requireString(params, 'type', method)
      if (type === 'apiKey') {
        requireString(params, 'apiKey', method)
        // `stubborn` models a deployment whose key login does not take effect,
        // so the next bind re-enters the configured-key path.
        signedIn = AUTH !== 'stubborn'
        return {}
      }
      if (type === 'chatgptDeviceCode') {
        return {
          loginId: 'login-1',
          verificationUrl: 'https://example.com/device',
          userCode: 'CODE-1234',
        }
      }
      if (type === 'chatgpt') {
        return { loginId: 'login-2', authUrl: 'https://example.com/oauth' }
      }
      return invalidParams(method, `params.type "${type}" is not a supported login type`)
    }
    case 'account/login/cancel':
      requireString(params, 'loginId', method)
      return {}
    case 'account/logout':
      signedIn = false
      return {}
    case 'account/rateLimits/read': {
      const bucket = {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: null },
        secondary: null,
        credits: null,
      }
      return {
        rateLimits: bucket,
        rateLimitsByLimitId: process.env.MOCK_CODEX_RATE_LIMIT_BUCKETS === '1'
          ? { codex: bucket }
          : null,
      }
    }
    case 'model/list': {
      requireBoolean(params, 'includeHidden', method)
      if (process.env.MOCK_CODEX_MODEL_LIST_SHAPE === 'bad-data') return { data: 'not-an-array', nextCursor: null }
      if (process.env.MOCK_CODEX_MODEL_LIST_SHAPE === 'bad-cursor') return { data: [], nextCursor: 42 }
      const start = typeof params.cursor === 'string' && params.cursor.length > 0
        ? Number(params.cursor)
        : 0
      const data = PAGE_SIZE === undefined ? MODELS : MODELS.slice(start, start + PAGE_SIZE)
      const next = PAGE_SIZE === undefined || start + PAGE_SIZE >= MODELS.length
        ? null
        : String(start + PAGE_SIZE)
      return { data, nextCursor: next }
    }
    default:
      // The transport's own missing-method code, so a driver that renames a
      // method fails on the wire instead of on an unexpected payload.
      throw new MockProtocolError(-32601, `method not found: ${method}`)
  }
}

// ---- stdin frame pump ----

let buffer = ''
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length === 0) continue
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const id = frame.id
    const method = frame.method
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      const params = frame.params !== null && typeof frame.params === 'object' && !Array.isArray(frame.params)
        ? frame.params as Record<string, unknown>
        : {}
      void dispatch(method, params).then(
        (result) => { respond(id, result ?? {}) },
        (error: unknown) => {
          respondError(
            id,
            error instanceof MockProtocolError ? error.code : -32603,
            error instanceof Error ? error.message : String(error),
          )
        },
      )
      continue
    }
    if (typeof id === 'string' || typeof id === 'number') {
      const pending = serverPending.get(id)
      if (pending === undefined) continue
      serverPending.delete(id)
      const error = frame.error
      if (error !== null && typeof error === 'object') {
        pending.reject(new Error(
          typeof (error as Record<string, unknown>).message === 'string'
            ? (error as Record<string, unknown>).message as string
            : 'client error',
        ))
      } else {
        pending.resolve(frame.result)
      }
      continue
    }
    if (typeof method === 'string') record(method, frame.params ?? {})
  }
})

// Under MOCK_CODEX_TRAP_SIGTERM, ignore SIGTERM and keep stdin open so the
// process neither quiesces on EOF nor dies on the graceful signal —
// exercising the dispose path's SIGKILL escalation.
if (process.env.MOCK_CODEX_TRAP_SIGTERM === '1') {
  process.on('SIGTERM', () => { /* trapped: refuse to exit on the graceful signal */ })
  setInterval(() => { /* stay alive until SIGKILL */ }, 1000)
}

// Under MOCK_CODEX_FLUSH_ON_EOF, model the real server's EOF-driven quiesce:
// on stdin 'end', take an async beat (MOCK_CODEX_FLUSH_DELAY_MS, default 150),
// touch the marker, and exit on its own — no signal.
if (FLUSH_ON_EOF !== undefined) {
  const flushDelayMs = Number(process.env.MOCK_CODEX_FLUSH_DELAY_MS ?? '150')
  process.stdin.on('end', () => {
    setTimeout(() => {
      writeFileSync(FLUSH_ON_EOF, 'flushed')
      process.exit(0)
    }, flushDelayMs)
  })
}

// Under MOCK_CODEX_IGNORE_EOF, keep the loop alive past stdin EOF but install
// a SIGTERM handler that records the signal and exits — the middle disposal
// tier.
if (process.env.MOCK_CODEX_IGNORE_EOF === '1') {
  const sigtermFile = process.env.MOCK_CODEX_SIGTERM_FILE
  process.on('SIGTERM', () => {
    if (sigtermFile !== undefined) writeFileSync(sigtermFile, 'sigterm')
    process.exit(0)
  })
  setInterval(() => { /* stay alive past EOF until SIGTERM */ }, 1000)
}
