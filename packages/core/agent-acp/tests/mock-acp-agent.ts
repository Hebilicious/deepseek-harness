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
 * - `MOCK_CLOSE`        — advertise `sessionCapabilities.close` and serve
 *                         `session/close`.
 * - `MOCK_CONFIG_OPTIONS` — JSON `SessionConfigOption[]` returned by
 *                         `session/new` and `session/load`; the mock tracks
 *                         `session/set_config_option` writes and echoes the
 *                         updated `currentValue` back.
 * - `MOCK_TEXT`         — assistant text streamed as `agent_message_chunk`s.
 * - `MOCK_THOUGHT`      — text streamed as one `agent_thought_chunk` first.
 * - `MOCK_PLAN`         — JSON `[{content, status}]` emitted as a `plan` update.
 * - `MOCK_TOOL`         — emit `tool_call` then a completed `tool_call_update`.
 * - `MOCK_TOOL_OPEN`    — emit `tool_call` with no terminal update, so the
 *                         driver's settlement must close it as an error result.
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
 * - `MOCK_CRASH_AFTER_CHUNK`   — exit after streaming the assistant chunk, so
 *                         partial output survives a fatal connection loss.
 * - `MOCK_MISSING_SESSION_ID`  — return `{}` from `session/new`.
 * - `MOCK_AUTH_METHODS` — JSON auth-method array for the initialize response.
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
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type StopReason,
} from '@agentclientprotocol/sdk'

// The `devin` CLI is one binary: `devin acp` serves the protocol while
// `devin models list` / `devin auth …` are one-shot commands. The fixture
// mirrors that: spawned as `node mock-acp-agent.ts acp` it serves ACP below;
// `node mock-acp-agent.ts models …` / `auth …` answer and exit.
const subcommand = process.argv[2]
if (subcommand === 'models') {
  process.stdout.write(`${process.env.MOCK_MODELS_JSON ?? JSON.stringify({ families: [] })}\n`)
  process.exit(0)
}
if (subcommand === 'auth') {
  const verb = process.argv[3]
  process.stdout.write(`${process.env.MOCK_AUTH_DETAIL ?? 'mock auth detail'}\n`)
  process.exit(verb === 'status' && process.env.MOCK_AUTH_LOGGED_OUT === '1' ? 3 : 0)
}
if (subcommand !== undefined && subcommand !== 'acp') {
  process.stderr.write(`unknown subcommand ${subcommand}\n`)
  process.exit(2)
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
const EMIT_TOOL = process.env.MOCK_TOOL === '1'
const EMIT_TOOL_OPEN = process.env.MOCK_TOOL_OPEN === '1'
const FLUSH_ON_EOF = process.env.MOCK_FLUSH_ON_EOF

function jsonEnv<T>(name: string): T | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  return JSON.parse(raw) as T
}

const CONFIG_OPTIONS = jsonEnv<SessionConfigOption[]>('MOCK_CONFIG_OPTIONS') ?? []
const PERMISSION_OPTIONS = jsonEnv<Array<{ optionId: string; name: string; kind: string }>>('MOCK_PERMISSION_OPTIONS')
const AUTH_METHODS = jsonEnv<InitializeResponse['authMethods']>('MOCK_AUTH_METHODS') ?? []
const PLAN = jsonEnv<Array<{ content: string; status?: string; priority?: string }>>('MOCK_PLAN')

function record(method: string, params: unknown): void {
  if (RECORD_FILE === undefined) return
  appendFileSync(RECORD_FILE, `${JSON.stringify({ method, params })}\n`)
}

function makeAgent() {
  // Pending cancel resolver for the HANG path: `session/cancel` resolves the
  // prompt with `cancelled`.
  let resolveCancel: ((reason: StopReason) => void) | undefined
  // The mock keeps the advertised options mutable so set_config_option echoes
  // the caller's write — like a real harness updating its current selection.
  const configOptions = CONFIG_OPTIONS.map(option => ({ ...option }))

  return {
    initialize(params: InitializeRequest): Promise<InitializeResponse> {
      record('initialize', params)
      if (CRASH_ON_INITIALIZE) process.exit(11)
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          ...LOAD_SESSION ? { loadSession: true } : {},
          ...CLOSE ? { sessionCapabilities: { close: {} } } : {},
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
        },
        authMethods: AUTH_METHODS,
      })
    },
    newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      record('session/new', params)
      if (process.env.MOCK_MISSING_SESSION_ID === '1') return {} as NewSessionResponse
      return {
        sessionId: process.env.MOCK_SESSION_ID ?? randomUUID(),
        configOptions: configOptions as NewSessionResponse['configOptions'],
      }
    },
    loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
      record('session/load', params)
      if (!LOAD_SESSION) {
        const error = new Error('loadSession is not advertised') as Error & { code: number }
        error.code = -32601
        return Promise.reject(error)
      }
      return Promise.resolve({ configOptions: configOptions as LoadSessionResponse['configOptions'] })
    },
    closeSession(params: unknown): Promise<Record<string, never>> {
      record('session/close', params)
      return Promise.resolve({})
    },
    setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
      record('session/set_config_option', params)
      for (const option of configOptions) {
        if (option.id === params.configId && option.type === 'select') {
          option.currentValue = params.value
        }
      }
      return Promise.resolve({ configOptions: configOptions as SetSessionConfigOptionResponse['configOptions'] })
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
      if (WANT_PERMISSION) {
        const decision = await conn.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'mock-call', title: 'mock side effect' },
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
        const answer = await conn.request(methods.client.elicitation.create, {
          sessionId: params.sessionId,
          message: 'mock elicitation',
          mode,
          requestedSchema: {
            type: 'object',
            properties: {
              choice: {
                type: 'string',
                description: 'Pick one',
                enum: ['alpha', 'beta'],
              },
            },
          },
        })
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
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'mock-tool-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'tool output' } }],
          },
        })
      }
      await conn.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: TEXT },
        },
      })
      if (CRASH_AFTER_CHUNK) {
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        process.exit(17)
      }
      if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ready')
      if (HANG) {
        return new Promise<PromptResponse>((resolve) => {
          resolveCancel = (reason) => { resolve({ stopReason: reason }) }
        })
      }
      return { stopReason: STOP }
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
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => implementation.setConfigOption(params))
  .onRequest(methods.agent.session.prompt, ({ params, client }) => implementation.prompt(params, client))
  .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
  .onRequest(methods.agent.logout, ({ params }) => implementation.logout(params))
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
