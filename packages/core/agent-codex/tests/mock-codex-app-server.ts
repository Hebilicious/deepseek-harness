/**
 * A minimal mock `codex app-server --stdio`-shape SERVER, run as a
 * subprocess, for the keyless `dsh-agent-codex` tests. It speaks the server
 * side of the Codex app-server JSON-RPC protocol — newline-delimited JSON-RPC
 * 2.0 over stdio — and is fully scripted by environment variables; no model,
 * no network:
 *
 * - `MOCK_CODEX_RECORD_FILE`  — append one JSONL `{method, params}` line per
 *                             incoming request/notification, plus
 *                             `{method: 'approval-decision' | 'permissions-outcome' |
 *                             'user-input-answers' | 'elicitation-outcome'}`
 *                             records for client answers, so a test asserts
 *                             exactly what the driver sent and answered.
 * - `MOCK_CODEX_THREAD_ID`  — fixed thread id from `thread/start` (random
 *                             otherwise); `thread/resume` accepts only the
 *                             recorded ids.
 * - `MOCK_CODEX_TEXT`       — assistant text carried by the agentMessage item.
 * - `MOCK_CODEX_SCENARIO`   — the turn script `turn/start` runs:
 *     `text`       (default) agentMessage started → delta → completed → turn completed.
 *     `early`      the same frames emitted BEFORE the `turn/start` response,
 *                  exercising the provisional-turn buffer.
 *     `reasoning`  a completed reasoning item folds into the assistant message.
 *     `tool`       commandExecution started → completed → message → completed.
 *     `tool-open`  commandExecution started, never completed — the driver's
 *                  settlement must close it as an error result.
 *     `file-change` fileChange started → completed with a diff → completed.
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
 * - `MOCK_CODEX_READY_FILE` — path touched once the scripted turn is in
 *                             flight, so a test steers or cancels on a
 *                             condition, not a timeout.
 * - `MOCK_CODEX_AUTH`       — `out`: `account/read` reports
 *                             `{requiresOpenaiAuth: true, account: null}`;
 *                             `key`: the same until `account/login/start
 *                             {type:'apiKey'}` flips the account signed in.
 * - `MOCK_CODEX_MODELS`     — JSON array served by `model/list`;
 *                             `MOCK_CODEX_PAGE_SIZE` splits it into pages.
 * - `MOCK_CODEX_FAIL_INITIALIZE`, `MOCK_CODEX_FAIL_THREAD`,
 *   `MOCK_CODEX_EPHEMERAL`, `MOCK_CODEX_NO_THREAD_ID`,
 *   `MOCK_CODEX_FAIL_RESUME` — startup and bind failure fixtures.
 * - `MOCK_CODEX_FLUSH_ON_EOF` / `MOCK_CODEX_FLUSH_DELAY_MS`,
 *   `MOCK_CODEX_IGNORE_EOF` / `MOCK_CODEX_SIGTERM_FILE`,
 *   `MOCK_CODEX_TRAP_SIGTERM` — the disposal-tier fixtures (EOF quiesce,
 *   SIGTERM cooperation, SIGKILL escalation).
 *
 * It is not a test spec: the specs launch this protocol-only fixture through
 * `process.execPath` (Node's native type stripping). It imports no harness
 * code or workspace paths.
 *
 * @module @deepseek-ai/dsh-agent-codex/tests/mock-codex-app-server
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'

const RECORD_FILE = process.env.MOCK_CODEX_RECORD_FILE
const TEXT = process.env.MOCK_CODEX_TEXT ?? 'mock codex answer'
const SCENARIO = process.env.MOCK_CODEX_SCENARIO ?? 'text'
const READY_FILE = process.env.MOCK_CODEX_READY_FILE
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

function record(method: string, params: unknown): void {
  if (RECORD_FILE === undefined) return
  appendFileSync(RECORD_FILE, `${JSON.stringify({ method, params })}\n`)
}

// ---- line-delimited JSON-RPC 2.0 server over stdio ----

type JsonRpcId = string | number
let nextServerId = 0
const serverPending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const threads = new Set<string>()
let turnCounter = 0
let signedIn = AUTH !== 'out' && AUTH !== 'key'
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

function accountRead(): Record<string, unknown> {
  return {
    requiresOpenaiAuth: true,
    account: signedIn
      ? { type: 'chatgpt', email: 'mock@example.com', planType: 'pro' }
      : null,
  }
}

/** Emit the shared agentMessage tail: started → delta → completed. */
function emitMessage(threadId: string, turnId: string, itemId: string): void {
  notify('item/started', { threadId, turnId, item: { id: itemId, type: 'agentMessage' } })
  notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: TEXT })
  notify('item/completed', { threadId, turnId, item: { id: itemId, type: 'agentMessage', text: TEXT } })
}

function completeTurn(threadId: string, turnId: string, status: string, error?: unknown): void {
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, status, ...error === undefined ? {} : { error } },
  })
}

/** The scripted turn body, run after `turn/start` answered (or before, for `early`). */
async function runTurn(threadId: string, turnId: string): Promise<void> {
  notify('turn/started', { threadId, turn: { id: turnId } })
  switch (SCENARIO) {
    case 'hang':
    case 'steer':
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
          content: [{ type: 'text', text: 'deep thought' }],
        },
      })
      break
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
    case 'file-change':
      notify('item/started', {
        threadId,
        turnId,
        item: { id: 'fc-1', type: 'fileChange', changes: [{ path: 'a.txt', diff: '@@\n-old\n+new\n' }] },
      })
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          id: 'fc-1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'a.txt', diff: '@@\n-old\n+new\n' }],
        },
      })
      break
    case 'approval':
    case 'permissions':
    case 'user-input':
    case 'elicit':
    case 'elicit-plain':
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
      })
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
    case 'elicit':
    case 'elicit-plain': {
      const schema = SCENARIO === 'elicit'
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

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  record(method, params)
  switch (method) {
    case 'initialize':
      if (process.env.MOCK_CODEX_FAIL_INITIALIZE === '1') process.exit(11)
      return { userAgent: 'mock-codex' }
    case 'thread/start': {
      if (process.env.MOCK_CODEX_FAIL_THREAD === '1') {
        throw new Error('thread/start refused')
      }
      const threadId = process.env.MOCK_CODEX_THREAD_ID ?? `thread-${randomUUID()}`
      threads.add(threadId)
      const thread = process.env.MOCK_CODEX_NO_THREAD_ID === '1'
        ? { ephemeral: false }
        : { id: threadId, ephemeral: process.env.MOCK_CODEX_EPHEMERAL === '1' }
      return { thread, model: 'codex-x', reasoningEffort: 'medium' }
    }
    case 'thread/resume': {
      if (process.env.MOCK_CODEX_FAIL_RESUME === '1') {
        throw new Error('thread/resume refused')
      }
      const requested = typeof params.threadId === 'string' ? params.threadId : ''
      if (!threads.has(requested)) {
        threads.add(requested)
      }
      return { thread: { id: requested }, model: 'codex-x' }
    }
    case 'thread/unsubscribe':
      return {}
    case 'thread/inject_items':
      return {}
    case 'turn/start': {
      const threadId = typeof params.threadId === 'string' ? params.threadId : ''
      const turnId = `turn-${++turnCounter}`
      if (SCENARIO === 'early') {
        // Emit the whole turn before the response so the driver must buffer
        // frames against the still-provisional turn id.
        await runTurn(threadId, turnId)
        return { turn: { id: turnId } }
      }
      void runTurn(threadId, turnId)
      return { turn: { id: turnId } }
    }
    case 'turn/steer': {
      const turnId = typeof params.expectedTurnId === 'string' ? params.expectedTurnId : ''
      const threadId = waitingTurns.get(turnId)
      if (SCENARIO !== 'steer' || threadId === undefined) {
        throw new Error('no steerable turn')
      }
      waitingTurns.delete(turnId)
      emitMessage(threadId, turnId, 'msg-1')
      completeTurn(threadId, turnId, 'completed')
      return {}
    }
    case 'turn/interrupt': {
      const turnId = typeof params.turnId === 'string' ? params.turnId : ''
      const threadId = waitingTurns.get(turnId)
        ?? (typeof params.threadId === 'string' ? params.threadId : '')
      waitingTurns.delete(turnId)
      if (SCENARIO === 'hang') completeTurn(threadId, turnId, 'interrupted')
      return {}
    }
    case 'account/read':
      return accountRead()
    case 'account/login/start': {
      if (params.type === 'apiKey') {
        signedIn = true
        return {}
      }
      if (params.type === 'chatgptDeviceCode') {
        return {
          loginId: 'login-1',
          verificationUrl: 'https://example.com/device',
          userCode: 'CODE-1234',
        }
      }
      return { loginId: 'login-2', authUrl: 'https://example.com/oauth' }
    }
    case 'account/login/cancel':
      return {}
    case 'account/logout':
      signedIn = false
      return {}
    case 'account/rateLimits/read':
      return { rateLimits: { primary: { remaining: 42 } }, rateLimitsByLimitId: null }
    case 'model/list': {
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
      throw new Error(`unsupported method ${method}`)
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
        result => respond(id, result ?? {}),
        error => respondError(id, -32603, error instanceof Error ? error.message : String(error)),
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
