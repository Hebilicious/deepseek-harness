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
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentToolBridge, { type BridgeMcpEndpoint } from '@deepseek-ai/dsh-agent-tool-bridge'
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

/**
 * Minimal `agentToolBridge` stand-in: hands each bind a fixed endpoint and
 * counts opens and closes; `failClose` makes `close()` reject so the
 * driver's warn-and-continue teardown paths run. The endpoint URL is never
 * contacted — the mock only probes `mcp_servers` entries under
 * `MOCK_CODEX_MCP_PROBE`.
 */
class FakeToolBridge extends Service {
  opened = 0
  closed = 0

  constructor(ctx: Context, private readonly failClose = false) {
    super(ctx, 'agentToolBridge')
  }

  async openMcpEndpoint(): Promise<BridgeMcpEndpoint> {
    this.opened += 1
    const failClose = this.failClose
    return {
      name: 'dsh',
      url: 'http://127.0.0.1:9/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer fake-tool-bridge' }],
      close: async () => {
        this.closed += 1
        if (failClose) throw new Error('fake endpoint close failed')
      },
    }
  }

  /** The stand-in serves no real endpoint, so nothing it reports correlates. */
  bridgedToolName(): undefined {
    return undefined
  }

  takeCompletion(): undefined {
    return undefined
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
  options: {
    approval?: boolean
    questions?: boolean
    credentials?: boolean
    /** `true` mounts the real bridge; the fake variants mount the stand-in. */
    bridge?: boolean | 'fake' | 'fake-fail-close'
    /** Store the session log uncompressed so a test can rewrite its records. */
    plainLog?: boolean
    config?: Record<string, unknown>
  } = {},
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
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(root, 'sessions'),
    ...options.plainLog === true ? { compression: 'none' as const } : {},
  })
  if (options.approval === true) await ctx.plugin(ApprovalService)
  if (options.questions === true) await ctx.plugin(FakeQuestions)
  if (options.credentials === true) await ctx.plugin(FakeCredentials)
  if (options.bridge === 'fake' || options.bridge === 'fake-fail-close') {
    await ctx.plugin(FakeToolBridge, options.bridge === 'fake-fail-close')
  } else if (options.bridge === true) {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentToolBridge, {})
  }
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
    const content = (assistant!.data['message'] as {
      content: { type: string; text?: string }[]
    }).content
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
    const block = (results[0]!.data as {
      message: { content: { type: string; isError?: boolean; content?: { text?: string }[] }[] }
    }).message.content[0]!
    expect(block.isError).toBe(false)
    expect(JSON.stringify(block.content)).toContain('tool output')
  }, TEST_TIMEOUT)

  it('interleaves streamed text, a tool item, and post-call text in one turn', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'interleaved' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s5i'), agentOptions: {} })
    send(agent, 'run a command')
    await agent.whenIdle()

    const log = events(agent)
    const sequence = log.map(event => event.type)
    // The call's advertisement folds into the streaming item's attempt and
    // commits it; the item's remaining text completes on a fresh attempt.
    const messages = sequence.flatMap((type, index) => type === 'assistant/message' ? [index] : [])
    expect(messages).toHaveLength(2)
    const callIndex = sequence.indexOf('tool/call')
    const resultIndex = sequence.indexOf('tool/result')
    expect(messages[0]! < callIndex && callIndex < resultIndex && resultIndex < messages[1]!).toBe(true)

    const first = log[messages[0]!]
    expect(first!.type === 'assistant/message' && first!.data['message']).toMatchObject({
      content: [
        { type: 'text', text: 'before ' },
        { type: 'tool-call', id: 'cmd-1', name: 'shell', arguments: '{"command":"true","cwd":"/"}' },
      ],
    })
    // The completion's whole-item text splits at the committed prefix.
    const second = log[messages[1]!]
    expect(second!.type === 'assistant/message' && second!.data['message']).toMatchObject({
      content: [{ type: 'text', text: ' after' }],
    })
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('commits no extra message when the item completes with only its streamed text', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'interleaved-settled', MOCK_CODEX_TEXT: 'all of it' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s5j'), agentOptions: {} })
    send(agent, 'run a command')
    await agent.whenIdle()

    const log = events(agent)
    const sequence = log.map(event => event.type)
    const messages = sequence.flatMap((type, index) => type === 'assistant/message' ? [index] : [])
    // One message carries the streamed text and the advertised call; the
    // completion's continuation attempt held no new text and lands as a bare
    // assistant/attempt.
    expect(messages).toHaveLength(1)
    const callIndex = sequence.indexOf('tool/call')
    const resultIndex = sequence.indexOf('tool/result')
    const attemptIndex = sequence.indexOf('assistant/attempt')
    expect(messages[0]! < callIndex && callIndex < resultIndex && resultIndex < attemptIndex).toBe(true)

    const first = log[messages[0]!]
    expect(first!.type === 'assistant/message' && first!.data['message']).toMatchObject({
      content: [
        { type: 'text', text: 'all of it' },
        { type: 'tool-call', id: 'cmd-1', name: 'shell', arguments: '{"command":"true","cwd":"/"}' },
      ],
    })
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('skips the advertisement-settled attempt when its item never completes', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'advertised-open' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s5k'), agentOptions: {} })
    send(agent, 'run a command')
    await agent.whenIdle()

    const log = events(agent)
    const sequence = log.map(event => event.type)
    const messages = sequence.flatMap((type, index) => type === 'assistant/message' ? [index] : [])
    // The advertisement committed the item's one attempt; turn settlement
    // adds nothing for the still-open item.
    expect(messages).toHaveLength(1)
    expect(eventsOf(agent, 'assistant/attempt')).toHaveLength(0)
    const first = log[messages[0]!]
    expect(first!.type === 'assistant/message' && first!.data['message']).toMatchObject({
      content: [
        { type: 'text', text: 'mock codex answer' },
        { type: 'tool-call', id: 'cmd-1', name: 'shell', arguments: '{"command":"true","cwd":"/"}' },
      ],
    })
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('closes an open tool item as an error result at turn settlement', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'tool-open' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s6'), agentOptions: {} })
    send(agent, 'open tool')
    await agent.whenIdle()

    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    const block = (results[0]!.data as { message: { content: { isError?: boolean }[] } }).message.content[0]!
    expect(block.isError).toBe(true)
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

const bridgeEcho = defineTool({
  name: 'bridge_echo',
  description: 'echo text back through the bridge',
  parameters: { text: { type: 'string' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
    presentationMeta: (_args, value) => ({ echoed: value }),
  },
  async execute(args) {
    return `pong:${args.text ?? ''}`
  },
})

/** The `config` override map a recorded `thread/start`/`thread/resume` carried. */
function configOf(call: RecordedCall | undefined): Record<string, unknown> {
  return (call?.params as { config?: Record<string, unknown> } | undefined)?.config ?? {}
}

/** The `mcp_servers.dsh` entry fields a recorded thread request carried. */
function bridgeEndpointOf(call: RecordedCall | undefined): { url: string; headers: Record<string, string> } {
  const config = configOf(call)
  return {
    url: config['mcp_servers.dsh.url'] as string,
    headers: config['mcp_servers.dsh.http_headers'] as Record<string, string>,
  }
}

describe('agent-codex tool bridge', () => {
  it('passes a live authenticated MCP endpoint to thread/start and records the exposure', async () => {
    bench = await setup({
      MOCK_CODEX_MCP_PROBE: '1',
      MOCK_CODEX_MCP_CALL: JSON.stringify({ name: 'bridge_echo', arguments: { text: 'ping' } }),
    }, { bridge: true })
    bench.ctx.tools.register(bridgeEcho)

    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('bridge-1'), agentOptions: {} })

    const calls = await recordedCalls(bench.recordFile)
    const endpoint = bridgeEndpointOf(calls.find(call => call.method === 'thread/start'))
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(endpoint.headers['Authorization']).toMatch(/^Bearer /)

    // The mock probed the endpoint from its own process: 401 without the
    // bearer token, then the agent's bridged tools under it.
    const unauthorized = calls.find(call => call.method === 'mcp-unauthorized')
    expect(unauthorized?.params).toMatchObject({ status: 401 })
    const tools = calls.find(call => call.method === 'mcp-tools')
    const listed = (tools?.params as { result?: { tools?: { name: string }[] } })?.result?.tools
    expect(listed?.map(tool => tool.name)).toEqual(['bridge_echo'])
    const called = calls.find(call => call.method === 'mcp-call')
    expect(called?.params).toMatchObject({
      result: { content: [{ type: 'text', text: 'pong:ping' }] },
    })

    const exposed = eventsOf(agent, 'agent-tool-bridge/exposed')
    expect(exposed).toHaveLength(1)
    expect(exposed[0]!.data).toEqual({ tools: ['bridge_echo'] })
  }, TEST_TIMEOUT)

  it('logs a mid-turn bridged call under the dsh name with the execution meta', async () => {
    bench = await setup({
      MOCK_CODEX_SCENARIO: 'mcp-turn-call',
      MOCK_CODEX_MCP_TURN_CALL: JSON.stringify({ name: 'bridge_echo', arguments: { text: 'ping' } }),
    }, { bridge: true })
    bench.ctx.tools.register(bridgeEcho)

    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('bridge-meta'), agentOptions: {} })
    send(agent, 'call it')
    await agent.whenIdle()

    // The mock called the endpoint and reported `mcpToolCall` items naming
    // server `dsh`; the log carries the dsh tool name and the reported
    // arguments.
    const calls = eventsOf(agent, 'tool/call')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.type === 'tool/call' && calls[0]!.data.name).toBe('bridge_echo')
    expect(calls[0]!.type === 'tool/call' && calls[0]!.data.arguments).toBe(JSON.stringify({ text: 'ping' }))

    // The result keeps the model-visible content the harness reported and
    // picks up the execution's presentation meta.
    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.type === 'tool/result' && results[0]!.data.meta).toEqual({ echoed: 'pong:ping' })
    const message = (results[0]!.data as { message: {
      content: { type: string; content?: { type: string; text?: string }[] }[]
    } }).message
    expect(message.content).toEqual([{
      type: 'tool-result',
      toolCallId: 'mcp-1',
      isError: false,
      content: [{ type: 'text', text: 'pong:ping' }],
    }])

    const called = (await recordedCalls(bench.recordFile))
      .find(call => call.method === 'mcp-turn-call')
    expect(called?.params).toMatchObject({ result: { content: [{ type: 'text', text: 'pong:ping' }] } })
  }, TEST_TIMEOUT)

  it('carries a fresh endpoint on thread/resume', async () => {
    bench = await setup({ MOCK_CODEX_MCP_PROBE: '1', MOCK_CODEX_THREAD_ID: 'codex-bridge-1' }, { bridge: true })
    bench.ctx.tools.register(bridgeEcho)
    const first = await bench.ctx.agents.create({ sessionId: SessionId('bridge-2'), agentOptions: {} })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    await first.dispose()

    const resumed = await bench.ctx.agents.resume({ resumeSessionId: SessionId('bridge-2') })

    const calls = await recordedCalls(bench.recordFile)
    const resume = calls.find(call => call.method === 'thread/resume')
    expect(resume).toBeDefined()
    const endpoint = bridgeEndpointOf(resume)
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(endpoint.headers['Authorization']).toMatch(/^Bearer /)

    // The rebind minted a fresh credential, and the mock probed it from the
    // resumed thread's request: a second tools/list under the new headers.
    const started = bridgeEndpointOf(calls.find(call => call.method === 'thread/start'))
    expect(endpoint.headers['Authorization']).not.toBe(started.headers['Authorization'])
    expect(calls.filter(call => call.method === 'mcp-tools')).toHaveLength(2)
    await resumed.dispose()
  }, TEST_TIMEOUT)

  it('revokes the endpoint credential when the agent is disposed', async () => {
    bench = await setup({}, { bridge: true })
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('bridge-3'), agentOptions: {} })

    const calls = await recordedCalls(bench.recordFile)
    const { url, headers } = bridgeEndpointOf(calls.find(call => call.method === 'thread/start'))

    await handle.dispose()

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(response.status).toBe(401)
    await response.arrayBuffer()
  }, TEST_TIMEOUT)

  it('closes the endpoint when the bind rolls back', async () => {
    bench = await setup({ MOCK_CODEX_FAIL_THREAD: '1' }, { bridge: true })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('bridge-4'), agentOptions: {} }))
      .rejects.toThrow()
    expect(bench.ctx.agents.roots()).toHaveLength(0)

    const calls = await recordedCalls(bench.recordFile)
    const { url, headers } = bridgeEndpointOf(calls.find(call => call.method === 'thread/start'))
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(response.status).toBe(401)
    await response.arrayBuffer()
  }, TEST_TIMEOUT)

  it('sends no config when the bridge is not mounted', async () => {
    bench = await setup()
    await bench.ctx.agents.create({ sessionId: SessionId('bridge-5'), agentOptions: {} })

    const calls = await recordedCalls(bench.recordFile)
    const start = calls.find(call => call.method === 'thread/start')
    expect(start).toBeDefined()
    expect((start!.params as { config?: unknown }).config).toBeUndefined()
  }, TEST_TIMEOUT)

  it('closes the endpoint when thread registration rolls the bind back', async () => {
    // Two sessions cannot share one thread id: the second bind starts its
    // thread, registerThread refuses the duplicate, and the rollback must
    // revoke the endpoint the bind just opened.
    bench = await setup({ MOCK_CODEX_THREAD_ID: 'codex-dup' }, { bridge: true })
    await bench.ctx.agents.create({ sessionId: SessionId('bridge-6'), agentOptions: {} })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('bridge-7'), agentOptions: {} }))
      .rejects.toThrow('already has a registered peer')
    expect(bench.ctx.agents.roots()).toHaveLength(1)

    const calls = await recordedCalls(bench.recordFile)
    const starts = calls.filter(call => call.method === 'thread/start')
    expect(starts).toHaveLength(2)
    const { url, headers } = bridgeEndpointOf(starts[1])
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(response.status).toBe(401)
    await response.arrayBuffer()
  }, TEST_TIMEOUT)

  it('rejects a corrupted durable binding before opening an endpoint', async () => {
    bench = await setup({ MOCK_CODEX_THREAD_ID: 'codex-fold' }, { bridge: 'fake', plainLog: true })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('bridge-8'), agentOptions: {} })
    await first.dispose()

    // Corrupt the stored binding: the projection fold rejects the malformed
    // entry while the agent is constructed, before bind() opens its endpoint.
    const sessionsRoot = join(bench.root, 'sessions')
    const logs = await readdir(sessionsRoot, { recursive: true })
    const stored = logs.find(name => name.endsWith('.jsonl'))
    if (stored === undefined) throw new Error(`no session log under ${sessionsRoot}`)
    const logFile = join(sessionsRoot, stored)
    const content = await readFile(logFile, 'utf8')
    expect(content).toContain('"threadId":"codex-fold"')
    await writeFile(logFile, content.replace('"threadId":"codex-fold"', '"threadId":""'))

    await expect(bench.ctx.agents.resume({ resumeSessionId: SessionId('bridge-8') }))
      .rejects.toThrow('invalid agent-codex/thread')
    const stub = bench.ctx.get('agentToolBridge') as unknown as FakeToolBridge
    expect(stub.opened).toBe(1)
    expect(stub.closed).toBe(1)
  }, TEST_TIMEOUT)

  it('reports the bind failure when the rollback close also fails', async () => {
    bench = await setup({ MOCK_CODEX_FAIL_THREAD: '1' }, { bridge: 'fake-fail-close' })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    await expect(bench.ctx.agents.create({ sessionId: SessionId('bridge-9'), agentOptions: {} }))
      .rejects.toThrow('thread/start refused')

    const stub = bench.ctx.get('agentToolBridge') as unknown as FakeToolBridge
    expect(stub.closed).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tool-bridge endpoint close failed'))
  }, TEST_TIMEOUT)

  it('warns and finishes unbind when the endpoint close fails', async () => {
    bench = await setup({}, { bridge: 'fake-fail-close' })
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('bridge-10'), agentOptions: {} })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')

    await handle.dispose()

    const stub = bench.ctx.get('agentToolBridge') as unknown as FakeToolBridge
    expect(stub.closed).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tool-bridge endpoint close failed'))
  }, TEST_TIMEOUT)
})
