/**
 * Keyless integration tests for the Codex session driver. Each case spawns a
 * REAL subprocess — the scripted mock `codex app-server --stdio` server
 * (tests/mock-codex-app-server.ts) — and drives it through the REAL driver
 * over real app-server JSON-RPC stdio: connection setup, thread start and
 * resume, turn projection, approval and question routing, steering,
 * cancellation, fatal teardown, and quiescent disposal are all exercised end
 * to end. No model, no network.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { CodexAppServer, CodexCatalogAdapter, codexThreadOf } from '../src/index.ts'
import type { CodexAppServerRuntime } from '../src/index.ts'

const mockServer = fileURLToPath(new URL('./mock-codex-app-server.ts', import.meta.url))

interface RecordedCall {
  readonly method: string
  readonly params: unknown
}

/** Read the mock's JSONL frame record (initialize, thread/*, turn/*, …). */
async function recordedCalls(file: string): Promise<RecordedCall[]> {
  const text = await readFile(file, 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line) as RecordedCall)
}

/** Poll until `file` exists — subprocess cold-start is variable. */
async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`mock child never wrote ${file}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/**
 * Poll the mock's frame record until `method` appears. Server-side record
 * writes trail the wire exchange that settles the caller, so awaiting the
 * agent is not enough to observe one.
 */
async function waitForCall(file: string, method: string, timeoutMs: number): Promise<RecordedCall[]> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const calls = existsSync(file) ? await recordedCalls(file) : []
    if (calls.some(call => call.method === method)) return calls
    if (Date.now() > deadline) throw new Error(`mock child never recorded ${method}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** Minimal userQuestions stand-in: answers every asked item with `beta`. */
class FakeQuestions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'userQuestions')
  }

  async ask(req: { questions: readonly { id: string }[] }) {
    return {
      answers: req.questions.map(item => ({ id: item.id, selected: ['beta'] })),
    }
  }
}

/** Minimal credentials stand-in: resolves every reference to a fixed key. */
class FakeCredentials extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  async resolve() {
    return { value: 'sk-mock-test-key', source: 'env' }
  }
}

interface Bench {
  readonly ctx: Context
  readonly root: string
  readonly recordFile: string
}

/**
 * Mount the full driver bench: real session/agent/projection/subprocess/llm
 * services plus JSONL persistence in a temp root, with `CodexAppServer`
 * pointed at the mock server scripted by `env`.
 */
async function setup(
  env: Record<string, string> = {},
  options: { approval?: boolean; questions?: boolean; credentials?: boolean; config?: Record<string, unknown> } = {},
): Promise<Bench> {
  const root = await mkdtemp(join(tmpdir(), 'agent-codex-test-'))
  const recordFile = join(root, 'record.jsonl')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  if (options.approval === true) await ctx.plugin(ApprovalService)
  if (options.questions === true) await ctx.plugin(FakeQuestions)
  if (options.credentials === true) await ctx.plugin(FakeCredentials)
  await ctx.plugin(CodexAppServer, {
    harnesses: [{
      executable: process.execPath,
      args: [mockServer],
      codexHome: root,
      env: { MOCK_CODEX_RECORD_FILE: recordFile, ...env },
      ...options.config,
    }],
  })
  return { ctx, root, recordFile }
}

async function teardown(target: Bench | undefined): Promise<void> {
  await target?.ctx.fiber.dispose()
  if (target !== undefined) await rm(target.root, { recursive: true, force: true })
}

let bench: Bench | undefined
afterEach(async () => {
  await teardown(bench)
  bench = undefined
})

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

function eventsOf(agent: Agent, type: string): SessionEvent[] {
  return events(agent).filter(event => event.type === type)
}

function turnEndKind(agent: Agent): string | undefined {
  const end = events(agent).findLast(event => event.type === 'turn/end')
  const reason = end?.data['reason'] as { kind?: string } | undefined
  return reason?.kind
}

const TEST_TIMEOUT = 30_000

describe('agent-codex driver', () => {
  it('creates a session over the app-server initialize handshake', async () => {
    bench = await setup()
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('s1'), agentOptions: {} })
    await handle.dispose()

    const calls = await recordedCalls(bench.recordFile)
    const methods = calls.map(call => call.method)
    expect(methods[0]).toBe('initialize')
    expect(methods).toContain('initialized')
    expect(methods).toContain('account/read')
    expect(methods).toContain('thread/start')
    expect(methods).not.toContain('thread/resume')
  }, TEST_TIMEOUT)

  it('binds the Codex thread durably and projects a text turn', async () => {
    bench = await setup({ MOCK_CODEX_TEXT: 'hello from codex' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s2'), agentOptions: {} })

    const binding = codexThreadOf(bench.ctx.sessionProjections, agent.session)
    expect(binding).toBeDefined()

    send(agent, 'hi')
    await agent.whenIdle()

    const log = events(agent)
    const bound = log.find(event => event.type === 'agent-codex/thread')
    expect(bound).toBeDefined()
    const assistant = log.find(event => event.type === 'assistant/message')
    expect(assistant).toBeDefined()
    const content = assistant!.data['message'].content
    expect(content.some(block => block.type === 'text' && block.text === 'hello from codex'))
      .toBe(true)
    expect(turnEndKind(agent)).toBe('completed')
    const header = log.find(event => event.type === 'request/header')
    expect((header?.data['header'] as { config: { provider: string } }).config.provider)
      .toBe('codex')
  }, TEST_TIMEOUT)

  it('buffers turn frames emitted before the turn/start response', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'early', MOCK_CODEX_TEXT: 'early answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s3'), agentOptions: {} })
    send(agent, 'hi')
    await agent.whenIdle()

    const assistant = eventsOf(agent, 'assistant/message')
    expect(assistant).toHaveLength(1)
    expect(JSON.stringify(assistant[0]!.data)).toContain('early answer')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('folds completed reasoning items into the assistant stream', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'reasoning', MOCK_CODEX_TEXT: 'reasoned answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s4'), agentOptions: {} })
    send(agent, 'think')
    await agent.whenIdle()

    const assistant = eventsOf(agent, 'assistant/message')
    expect(assistant).toHaveLength(1)
    const content = JSON.stringify(assistant[0]!.data)
    expect(content).toContain('thinking hard')
    expect(content).toContain('deep thought')
    expect(content).toContain('reasoned answer')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('projects a command execution and its terminal result', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'tool' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s5'), agentOptions: {} })
    send(agent, 'run a command')
    await agent.whenIdle()

    const calls = eventsOf(agent, 'tool/call')
    expect(calls).toHaveLength(1)
    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    const message = (results[0]!.data as {
      message: { isError: boolean; content: { text?: string }[] }
    }).message
    expect(message.isError).toBe(false)
    expect(JSON.stringify(message.content)).toContain('tool output')
  }, TEST_TIMEOUT)

  it('closes an open tool item as an error result at turn settlement', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'tool-open' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s6'), agentOptions: {} })
    send(agent, 'open tool')
    await agent.whenIdle()

    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    expect((results[0]!.data as { message: { isError: boolean } }).message.isError).toBe(true)
  }, TEST_TIMEOUT)

  it('routes command approvals through the approval seam', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'approval' }, { approval: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s7'), agentOptions: {} })
    bench.ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))

    send(agent, 'needs approval')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'approval-decision')
    expect(JSON.stringify(outcome)).toContain('"accept"')
    expect(eventsOf(agent, 'approval/asked')).toHaveLength(1)
    expect(eventsOf(agent, 'approval/decided')).toHaveLength(1)
  }, TEST_TIMEOUT)

  it('maps an approval rejection onto the decline decision', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'approval' }, { approval: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s8'), agentOptions: {} })
    bench.ctx.on('approval/request', () => Promise.resolve('rejected' as const))

    send(agent, 'deny me')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'approval-decision')
    expect(JSON.stringify(outcome)).toContain('"decline"')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('echoes a permissions grant on allowed-once and grants nothing otherwise', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'permissions' }, { approval: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s9'), agentOptions: {} })
    bench.ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))

    send(agent, 'grant')
    await agent.whenIdle()

    let calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'permissions-outcome')
    expect(JSON.stringify(outcome)).toContain('"network"')
    await teardown(bench)
    bench = undefined

    bench = await setup({ MOCK_CODEX_SCENARIO: 'permissions' }, { approval: true })
    const second = await bench.ctx.agents.create({ sessionId: SessionId('s9b'), agentOptions: {} })
    bench.ctx.on('approval/request', () => Promise.resolve('rejected' as const))
    send(second.agent, 'deny')
    await second.agent.whenIdle()
    calls = await recordedCalls(bench.recordFile)
    const denied = calls.find(call => call.method === 'permissions-outcome')
    expect(JSON.stringify(denied)).toContain('"permissions":{}')
  }, TEST_TIMEOUT)

  it('routes tool user input through the user-questions seam', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'user-input' }, { questions: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s10'), agentOptions: {} })
    send(agent, 'ask me')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'user-input-answers')
    expect(JSON.stringify(outcome)).toContain('beta')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('answers nothing for user input without a user-questions service', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'user-input' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s11'), agentOptions: {} })
    send(agent, 'ask me')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'user-input-answers')
    expect(JSON.stringify(outcome)).toContain('"answers":{}')
  }, TEST_TIMEOUT)

  it('accepts a form elicitation through user-questions and declines without it', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit' }, { questions: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s12'), agentOptions: {} })
    send(agent, 'answer')
    await agent.whenIdle()
    let calls = await recordedCalls(bench.recordFile)
    expect(JSON.stringify(calls.find(call => call.method === 'elicitation-outcome')))
      .toContain('accept')
    await teardown(bench)
    bench = undefined

    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit' })
    const second = await bench.ctx.agents.create({ sessionId: SessionId('s12b'), agentOptions: {} })
    send(second.agent, 'decline')
    await second.agent.whenIdle()
    calls = await recordedCalls(bench.recordFile)
    expect(JSON.stringify(calls.find(call => call.method === 'elicitation-outcome')))
      .toContain('decline')
  }, TEST_TIMEOUT)

  it('forwards the session model and effort on thread/start and turn/start', async () => {
    bench = await setup()
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('s13'),
      agentOptions: {
        provider: 'codex',
        model: 'codex-y',
        reasoningEffort: brandString<ReasoningEffortId>('high'),
      },
    })
    send(agent, 'with model')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const start = calls.find(call => call.method === 'thread/start')
    expect((start!.params as { model?: string }).model).toBe('codex-y')
    const turn = calls.find(call => call.method === 'turn/start')
    expect((turn!.params as { model?: string }).model).toBe('codex-y')
    expect((turn!.params as { effort?: string }).effort).toBe('high')
  }, TEST_TIMEOUT)

  it('resumes a persisted session through thread/resume', async () => {
    bench = await setup({ MOCK_CODEX_THREAD_ID: 'codex-fixed-1' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s14'), agentOptions: {} })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    await first.dispose()

    const resumed = await bench.ctx.agents.resume({ resumeSessionId: SessionId('s14') })
    send(resumed.agent, 'second turn')
    await resumed.agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const resume = calls.find(call => call.method === 'thread/resume')
    expect(resume).toBeDefined()
    expect((resume!.params as { threadId: string }).threadId).toBe('codex-fixed-1')
    expect(eventsOf(resumed.agent, 'assistant/message').length).toBeGreaterThanOrEqual(2)
    await resumed.dispose()
  }, TEST_TIMEOUT)

  it('rebinds a session whose recorded thread has no rollout', async () => {
    bench = await setup()
    // A session created and never prompted owns a thread with no rollout on
    // disk, so the mock refuses thread/resume exactly as 0.153.4 does.
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s15'), agentOptions: {} })
    const original = codexThreadOf(bench.ctx.sessionProjections, first.agent.session)
    expect(original).toBeDefined()
    await first.dispose()

    const recovered = await bench.ctx.agents.resume({ resumeSessionId: SessionId('s15') })
    send(recovered.agent, 'recovered turn')
    await recovered.agent.whenIdle()

    const rebound = codexThreadOf(bench.ctx.sessionProjections, recovered.agent.session)
    expect(rebound).toBeDefined()
    expect(rebound).not.toBe(original)
    expect(eventsOf(recovered.agent, 'agent-codex/thread')).toHaveLength(2)
    expect(turnEndKind(recovered.agent)).toBe('completed')
    await recovered.dispose()

    // The rebound identity is the durable one: the next resume targets it and
    // succeeds without another thread/start.
    const again = await bench.ctx.agents.resume({ resumeSessionId: SessionId('s15') })
    expect(codexThreadOf(bench.ctx.sessionProjections, again.agent.session)).toBe(rebound)
    await again.dispose()

    const calls = await recordedCalls(bench.recordFile)
    const resumes = calls.filter(call => call.method === 'thread/resume')
    expect(resumes.map(call => (call.params as { threadId: string }).threadId))
      .toEqual([original, rebound])
    expect(calls.filter(call => call.method === 'thread/start')).toHaveLength(2)
  }, TEST_TIMEOUT)

  it('keeps a resume failure other than a missing rollout fatal', async () => {
    // `thread/start` still succeeds; only the resume call errors.
    bench = await setup({ MOCK_CODEX_FAIL_RESUME: '1' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s15b'), agentOptions: {} })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    await first.dispose()

    await expect(bench.ctx.agents.resume({ resumeSessionId: SessionId('s15b') }))
      .rejects.toThrow('thread/resume')
  }, TEST_TIMEOUT)

  it('cancels a hung turn through turn/interrupt', async () => {
    const ready = join(await mkdtemp(join(tmpdir(), 'agent-codex-ready-')), 'ready')
    bench = await setup({ MOCK_CODEX_SCENARIO: 'hang', MOCK_CODEX_READY_FILE: ready })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s16'), agentOptions: {} })
    send(agent, 'hang')
    await waitForFile(ready, TEST_TIMEOUT - 5000)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    const calls = await waitForCall(bench.recordFile, 'turn/interrupt', TEST_TIMEOUT - 5000)
    expect(calls.some(call => call.method === 'turn/interrupt')).toBe(true)
    expect(turnEndKind(agent)).toBe('aborted')
  }, TEST_TIMEOUT)

  it('steers a live turn through turn/steer', async () => {
    const ready = join(await mkdtemp(join(tmpdir(), 'agent-codex-steer-')), 'ready')
    bench = await setup({ MOCK_CODEX_SCENARIO: 'steer', MOCK_CODEX_READY_FILE: ready })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s17'), agentOptions: {} })
    send(agent, 'start')
    await waitForFile(ready, TEST_TIMEOUT - 5000)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'steer me' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const calls = await waitForCall(bench.recordFile, 'turn/steer', TEST_TIMEOUT - 5000)
    expect(calls.some(call => call.method === 'turn/steer')).toBe(true)
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('injects context through thread/inject_items outside a turn', async () => {
    bench = await setup()
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s18'), agentOptions: {} })
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'context only' }],
      source: { kind: 'user' },
    }))

    const calls = await waitForCall(bench.recordFile, 'thread/inject_items', TEST_TIMEOUT - 5000)
    expect(calls.some(call => call.method === 'thread/inject_items')).toBe(true)
    const committed = eventsOf(agent, 'user/message')
    expect(JSON.stringify(committed)).toContain('context only')
  }, TEST_TIMEOUT)

  it('settles partial streams on a fatal child exit', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'crash', MOCK_CODEX_TEXT: 'partial answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s19'), agentOptions: {} })
    send(agent, 'crash')
    await agent.whenIdle()

    const assistant = eventsOf(agent, 'assistant/message')
    expect(assistant).toHaveLength(1)
    expect(JSON.stringify(assistant[0]!.data)).toContain('partial answer')
    expect(turnEndKind(agent)).not.toBe('completed')
  }, TEST_TIMEOUT)

  it('rolls creation back when initialize crashes', async () => {
    bench = await setup({ MOCK_CODEX_FAIL_INITIALIZE: '1' })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('s20'), agentOptions: {} }))
      .rejects.toThrow()
    expect(bench.ctx.agents.roots()).toHaveLength(0)
  }, TEST_TIMEOUT)

  it('rejects an ephemeral thread for a durable session', async () => {
    bench = await setup({ MOCK_CODEX_EPHEMERAL: '1' })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('s21'), agentOptions: {} }))
      .rejects.toThrow('ephemeral')
    expect(bench.ctx.agents.roots()).toHaveLength(0)
  }, TEST_TIMEOUT)

  it('rejects a thread/start response without a thread id', async () => {
    bench = await setup({ MOCK_CODEX_NO_THREAD_ID: '1' })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('s22'), agentOptions: {} }))
      .rejects.toThrow('thread id')
    expect(bench.ctx.agents.roots()).toHaveLength(0)
  }, TEST_TIMEOUT)

  it('fails binding when the account is signed out and no credential is configured', async () => {
    bench = await setup({ MOCK_CODEX_AUTH: 'out' })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('s23'), agentOptions: {} }))
      .rejects.toThrow('not authenticated')
    expect(bench.ctx.agents.roots()).toHaveLength(0)
  }, TEST_TIMEOUT)

  it('logs in with the configured api key when the account starts signed out', async () => {
    bench = await setup(
      { MOCK_CODEX_AUTH: 'key' },
      { credentials: true, config: { credentialRef: 'MOCK_OPENAI_KEY' } },
    )
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s24'), agentOptions: {} })
    send(agent, 'hi')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const login = calls.find(call => call.method === 'account/login/start')
    expect(login).toBeDefined()
    expect((login!.params as { type: string }).type).toBe('apiKey')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('quiesces the child through the EOF grace window on dispose', async () => {
    const flushMarker = join(await mkdtemp(join(tmpdir(), 'agent-codex-flush-')), 'flushed')
    bench = await setup({ MOCK_CODEX_FLUSH_ON_EOF: flushMarker, MOCK_CODEX_FLUSH_DELAY_MS: '50' })
    await bench.ctx.agents.create({ sessionId: SessionId('s25'), agentOptions: {} })
    // Unload the harness alone: fiber teardown runs sibling disposables
    // concurrently, so the subprocess provider would SIGTERM the child before
    // the driver's stdin-EOF grace can land.
    bench.ctx.registry.delete(CodexAppServer)
    await waitForFile(flushMarker, TEST_TIMEOUT - 5000)
  }, TEST_TIMEOUT)

  it('settles the live turn and rebinds on a fresh child after the child dies', async () => {
    const ready = join(await mkdtemp(join(tmpdir(), 'agent-codex-dead-')), 'ready')
    const pidFile = join(await mkdtemp(join(tmpdir(), 'agent-codex-pid-')), 'pid')
    bench = await setup({
      MOCK_CODEX_SCENARIO: 'never',
      MOCK_CODEX_READY_FILE: ready,
      MOCK_CODEX_PID_FILE: pidFile,
    })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s26'), agentOptions: {} })
    send(first.agent, 'never answers')
    await waitForFile(ready, TEST_TIMEOUT - 5000)

    process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL')
    // The dead child must settle the in-flight turn instead of hanging it.
    await first.agent.whenIdle()
    expect(turnEndKind(first.agent)).not.toBe('completed')

    // The dead connection must not stay memoized: a later session binds on a
    // freshly spawned child.
    const second = await bench.ctx.agents.create({ sessionId: SessionId('s27'), agentOptions: {} })
    expect(codexThreadOf(bench.ctx.sessionProjections, second.agent.session)).toBeDefined()

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.filter(call => call.method === 'initialize')).toHaveLength(2)
  }, TEST_TIMEOUT)

  it('fails only the owning thread when a notification cannot be folded', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'bad-item-first' })
    const errors: unknown[] = []
    bench.ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject.id === SessionId('s28')) errors.push(error)
    })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s28'), agentOptions: {} })
    send(first.agent, 'malformed frame')
    await first.agent.whenIdle()

    expect(turnEndKind(first.agent)).toBe('error')
    expect(errors).toHaveLength(1)

    // The shared connection is still live: a second session on the same child
    // runs its own turn to completion.
    const second = await bench.ctx.agents.create({ sessionId: SessionId('s29'), agentOptions: {} })
    send(second.agent, 'healthy turn')
    await second.agent.whenIdle()
    expect(turnEndKind(second.agent)).toBe('completed')

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.filter(call => call.method === 'initialize')).toHaveLength(1)
  }, TEST_TIMEOUT)

  it('reports an unfoldable frame outside a turn on the agent error channel', async () => {
    const started = await setup({ MOCK_CODEX_SCENARIO: 'late-frame' })
    bench = started
    const reported = new Promise<unknown>((resolve) => {
      started.ctx.on('agent/error', ({ error }) => { resolve(error) })
    })
    const { agent } = await started.ctx.agents.create({ sessionId: SessionId('s30'), agentOptions: {} })
    send(agent, 'late frame')
    await agent.whenIdle()

    // The frame arrives after settlement, so the turn still completes and the
    // failure surfaces only on the error channel.
    expect(turnEndKind(agent)).toBe('completed')
    expect(String(await reported)).toContain('turn/started')
  }, TEST_TIMEOUT)

  it('reaps a child still handshaking when the plugin unloads during creation', async () => {
    const markers = await mkdtemp(join(tmpdir(), 'agent-codex-startup-'))
    const initialized = join(markers, 'initialized')
    const exited = join(markers, 'exited')
    bench = await setup({
      MOCK_CODEX_INITIALIZE_FILE: initialized,
      MOCK_CODEX_INITIALIZE_GATE_FILE: join(markers, 'release'),
      MOCK_CODEX_FLUSH_ON_EOF: exited,
      MOCK_CODEX_FLUSH_DELAY_MS: '20',
    })
    const creating = bench.ctx.agents.create({ sessionId: SessionId('s31'), agentOptions: {} })
    await waitForFile(initialized, TEST_TIMEOUT - 5000)

    // Unload the plugin while the initialize response is still gated: the
    // disposal must reach the child instead of returning on a live process.
    bench.ctx.registry.delete(CodexAppServer)
    await expect(creating).rejects.toThrow()
    await waitForFile(exited, TEST_TIMEOUT - 5000)
  }, TEST_TIMEOUT)

  it('enumerates the codex catalog over model/list pages', async () => {
    bench = await setup({
      MOCK_CODEX_MODELS: JSON.stringify([
        { model: 'codex-a', displayName: 'Codex A' },
        { model: 'codex-b', displayName: 'Codex B', inputModalities: ['text'] },
        { model: 'codex-c', displayName: 'Codex C' },
      ]),
      MOCK_CODEX_PAGE_SIZE: '2',
    })
    const models = await bench.ctx.llm.listModels('codex')
    expect(models.map(model => model.id)).toEqual(['codex-a', 'codex-b', 'codex-c'])
    expect(models[1]!.inputModalities).toEqual(['text'])

    const calls = await recordedCalls(bench.recordFile)
    const pages = calls.filter(call => call.method === 'model/list')
    expect(pages.length).toBe(2)
  }, TEST_TIMEOUT)

  it('reports account and rate-limit state through the shared connection', async () => {
    bench = await setup()
    const signal = new AbortController().signal
    const status = await bench.ctx.codexAppServer.status({ harness: 'codex' }, signal)
    expect(status.authenticated).toBe(true)
    expect(status.accountType).toBe('chatgpt')
    const limits = await bench.ctx.codexAppServer.rateLimits({ harness: 'codex' }, signal)
    expect(limits.rateLimits).toMatchObject({
      primary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: null },
    })
    await bench.ctx.codexAppServer.logout({ harness: 'codex' }, signal)
    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'account/logout')).toBe(true)
  }, TEST_TIMEOUT)

  it('rejects stream calls as a catalog-only provider', async () => {
    const adapter = new CodexCatalogAdapter('codex', 'Codex', {
      listCodexModels: async () => [],
    } as unknown as CodexAppServerRuntime)
    expect(() => adapter.stream({ messages: [] } as never)).toThrow('catalog')
  })
})
