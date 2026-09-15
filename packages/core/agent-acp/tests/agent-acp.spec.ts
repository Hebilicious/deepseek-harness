/**
 * Keyless integration tests for the ACP session driver. Each case spawns a
 * REAL subprocess — the scripted mock `devin acp` agent
 * (tests/mock-acp-agent.ts) — and drives it through the REAL driver over real
 * ACP JSON-RPC stdio: connection setup, session creation and load, prompt
 * projection, permission and elicitation routing, cancellation, fatal
 * teardown, and quiescent disposal are all exercised end to end. No model,
 * no network.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { AcpHarness, acpSessionOf, DevinCatalogAdapter } from '../src/index.ts'
import type { AcpRuntime } from '../src/runtime.ts'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

const mockAgent = fileURLToPath(new URL('./mock-acp-agent.ts', import.meta.url))

interface RecordedCall {
  readonly method: string
  readonly params: unknown
}

/** Read the mock's JSONL request record (initialize, session/*, authenticate, …). */
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
 * Poll the mock's request record until `method` appears. Agent-side record
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

interface Bench {
  readonly ctx: Context
  readonly root: string
  readonly recordFile: string
}

/**
 * Mount the full driver bench: real session/agent/projection/subprocess/llm
 * services plus JSONL persistence in a temp root, with `AcpHarness` pointed
 * at the mock agent scripted by `env`.
 */
async function setup(
  env: Record<string, string> = {},
  options: { approval?: boolean; questions?: boolean; config?: Record<string, unknown> } = {},
): Promise<Bench> {
  const root = await mkdtemp(join(tmpdir(), 'agent-acp-test-'))
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
  await ctx.plugin(AcpHarness, {
    executable: process.execPath,
    args: [mockAgent, 'acp'],
    modelsArgs: [mockAgent, 'models', 'list', '--format', 'json'],
    authStatusArgs: [mockAgent, 'auth', 'status'],
    authLogoutArgs: [mockAgent, 'auth', 'logout'],
    env: { MOCK_RECORD_FILE: recordFile, ...env },
    ...options.config,
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

describe('agent-acp driver', () => {
  it('creates a session over ACP with no optional client capabilities', async () => {
    bench = await setup()
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('s1'), agentOptions: {} })
    await handle.dispose()

    const calls = await recordedCalls(bench.recordFile)
    const initialize = calls.find(call => call.method === 'initialize')
    expect(initialize).toBeDefined()
    // The agent-side SDK normalizes omitted capabilities to explicit false.
    expect((initialize!.params as { clientCapabilities?: unknown }).clientCapabilities)
      .toEqual({
        auth: { terminal: false },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      })
    const created = calls.find(call => call.method === 'session/new')
    expect(created).toBeDefined()
    expect(calls.some(call => call.method === 'session/load')).toBe(false)
  }, TEST_TIMEOUT)

  it('binds the ACP session durably and projects a text turn', async () => {
    bench = await setup({ MOCK_TEXT: 'hello from acp' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s2'), agentOptions: {} })

    const binding = acpSessionOf(bench.ctx.sessionProjections, agent.session)
    expect(binding).toBeDefined()

    send(agent, 'hi')
    await agent.whenIdle()

    const log = events(agent)
    const bound = log.find(event => event.type === 'agent-acp/session')
    expect(bound).toBeDefined()
    const assistant = log.find(event => event.type === 'assistant/message')
    expect(assistant).toBeDefined()
    const content = (assistant!.data['message'] as {
      content: { type: string; text?: string }[]
    }).content
    expect(content.some(block => block.type === 'text' && block.text === 'hello from acp'))
      .toBe(true)
    expect(turnEndKind(agent)).toBe('completed')
    const header = log.find(event => event.type === 'request/header')
    expect((header?.data['header'] as { config: { provider: string } }).config.provider)
      .toBe('devin')
  }, TEST_TIMEOUT)

  it('projects reasoning and plan updates into the assistant stream', async () => {
    bench = await setup({
      MOCK_THOUGHT: 'deliberating',
      MOCK_PLAN: JSON.stringify([
        { content: 'first step', status: 'completed' },
        { content: 'second step', status: 'pending' },
      ]),
      MOCK_TEXT: 'done',
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s3'), agentOptions: {} })
    send(agent, 'plan it')
    await agent.whenIdle()

    const assistant = eventsOf(agent, 'assistant/message')
    // The ACP message stream and the turn-level plan update commit as
    // separate assistant messages.
    expect(assistant).toHaveLength(2)
    const content = assistant.map(event => JSON.stringify(event.data)).join('\n')
    expect(content).toContain('deliberating')
    expect(content).toContain('[completed] first step')
    expect(content).toContain('[pending] second step')
    expect(content).toContain('done')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('projects tool calls and terminal results', async () => {
    bench = await setup({ MOCK_TOOL: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s4'), agentOptions: {} })
    send(agent, 'run a tool')
    await agent.whenIdle()

    expect(eventsOf(agent, 'tool/call')).toHaveLength(1)
    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    const block = (results[0]!.data['message'] as {
      content: { type: string; isError?: boolean; content?: { text?: string }[] }[]
    }).content[0]!
    expect(block.isError).toBe(false)
    expect(JSON.stringify(block.content)).toContain('tool output')
  }, TEST_TIMEOUT)

  it('closes an open tool call as an error result at turn settlement', async () => {
    bench = await setup({ MOCK_TOOL_OPEN: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s5'), agentOptions: {} })
    send(agent, 'open tool')
    await agent.whenIdle()

    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    const block = (results[0]!.data['message'] as {
      content: { isError?: boolean }[]
    }).content[0]!
    expect(block.isError).toBe(true)
  }, TEST_TIMEOUT)

  it('routes permission requests through the approval seam', async () => {
    bench = await setup({ MOCK_PERMISSION: '1' }, { approval: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s6'), agentOptions: {} })
    bench.ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))

    send(agent, 'needs approval')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'permission-outcome')
    expect(JSON.stringify(outcome)).toContain('"yes"')
    expect(eventsOf(agent, 'approval/asked')).toHaveLength(1)
    expect(eventsOf(agent, 'approval/decided')).toHaveLength(1)
  }, TEST_TIMEOUT)

  it('maps a rejection to the offered reject option', async () => {
    bench = await setup({ MOCK_PERMISSION: '1' }, { approval: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s7'), agentOptions: {} })
    bench.ctx.on('approval/request', () => Promise.resolve('rejected' as const))

    send(agent, 'deny me')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'permission-outcome')
    expect(JSON.stringify(outcome)).toContain('"no"')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('declines elicitation without a user-questions service and accepts with one', async () => {
    bench = await setup({ MOCK_ELICIT: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s8'), agentOptions: {} })
    send(agent, 'decline')
    await agent.whenIdle()
    let calls = await recordedCalls(bench.recordFile)
    expect(JSON.stringify(calls.find(call => call.method === 'elicitation-outcome')))
      .toContain('decline')
    await teardown(bench)
    bench = undefined

    bench = await setup({ MOCK_ELICIT: '1' }, { questions: true })
    const second = await bench.ctx.agents.create({ sessionId: SessionId('s9'), agentOptions: {} })
    send(second.agent, 'answer')
    await second.agent.whenIdle()
    calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'elicitation-outcome')
    expect(JSON.stringify(outcome)).toContain('accept')
    expect(JSON.stringify(outcome)).toContain('beta')
  }, TEST_TIMEOUT)

  it('applies the session model/mode through session/set_config_option', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'swe-1',
          options: [{ value: 'swe-1', name: 'SWE 1' }, { value: 'swe-2', name: 'SWE 2' }],
        },
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'accept-edits', name: 'Accept edits' },
            { value: 'bypass', name: 'Bypass' },
          ],
        },
      ]),
    })
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('s10'),
      agentOptions: { provider: 'devin', model: 'swe-2' },
    })
    send(agent, 'with model')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const sets = calls.filter(call => call.method === 'session/set_config_option')
    const byConfig = new Map(sets.map(call => [
      (call.params as { configId: string }).configId,
      (call.params as { value: string }).value,
    ]))
    expect(byConfig.get('model')).toBe('swe-2')
    expect(byConfig.get('mode')).toBe('accept-edits')
  }, TEST_TIMEOUT)

  it('resumes a persisted session through session/load', async () => {
    bench = await setup({ MOCK_LOAD_SESSION: '1', MOCK_SESSION_ID: 'acp-fixed-1' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s11'), agentOptions: {} })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    await first.dispose()

    const resumed = await bench.ctx.agents.resume({ resumeSessionId: SessionId('s11') })
    send(resumed.agent, 'second turn')
    await resumed.agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const load = calls.find(call => call.method === 'session/load')
    expect(load).toBeDefined()
    expect((load!.params as { sessionId: string }).sessionId).toBe('acp-fixed-1')
    expect(eventsOf(resumed.agent, 'assistant/message').length).toBeGreaterThanOrEqual(2)
    await resumed.dispose()
  }, TEST_TIMEOUT)

  it('rejects resume when the agent does not advertise loadSession', async () => {
    bench = await setup({ MOCK_SESSION_ID: 'acp-fixed-2' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s12'), agentOptions: {} })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    await first.dispose()

    await expect(bench.ctx.agents.resume({ resumeSessionId: SessionId('s12') }))
      .rejects.toThrow('loadSession')
  }, TEST_TIMEOUT)

  it('cancels a hung prompt through session/cancel', async () => {
    const ready = join(await mkdtemp(join(tmpdir(), 'agent-acp-ready-')), 'ready')
    bench = await setup({ MOCK_HANG: '1', MOCK_READY_FILE: ready })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s13'), agentOptions: {} })
    send(agent, 'hang')
    await waitForFile(ready, TEST_TIMEOUT - 5000)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    // `whenIdle` settles on the aborted drive; the fire-and-forget
    // session/cancel notification reaches the child's record independently.
    const calls = await waitForCall(bench.recordFile, 'session/cancel', TEST_TIMEOUT - 5000)
    expect(calls.some(call => call.method === 'session/cancel')).toBe(true)
    expect(turnEndKind(agent)).toBe('aborted')
  }, TEST_TIMEOUT)

  it('settles partial streams on a fatal child exit', async () => {
    bench = await setup({ MOCK_CRASH_AFTER_CHUNK: '1', MOCK_TEXT: 'partial answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s14'), agentOptions: {} })
    send(agent, 'crash')
    await agent.whenIdle()

    const assistant = eventsOf(agent, 'assistant/message')
    expect(assistant).toHaveLength(1)
    expect(JSON.stringify(assistant[0]!.data)).toContain('partial answer')
    expect(turnEndKind(agent)).not.toBe('completed')
  }, TEST_TIMEOUT)

  it('rolls creation back when initialize crashes', async () => {
    bench = await setup({ MOCK_CRASH_ON_INITIALIZE: '1' })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('s15'), agentOptions: {} }))
      .rejects.toThrow()
    expect(bench.ctx.agents.roots()).toHaveLength(0)
  }, TEST_TIMEOUT)

  it('rejects a session/new response without a session id', async () => {
    bench = await setup({ MOCK_MISSING_SESSION_ID: '1' })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('s16'), agentOptions: {} }))
      .rejects.toThrow('session id')
    expect(bench.ctx.agents.roots()).toHaveLength(0)
  }, TEST_TIMEOUT)

  it('quiesces the child through the EOF grace window on dispose', async () => {
    const flushMarker = join(await mkdtemp(join(tmpdir(), 'agent-acp-flush-')), 'flushed')
    bench = await setup({ MOCK_FLUSH_ON_EOF: flushMarker, MOCK_FLUSH_DELAY_MS: '50' })
    await bench.ctx.agents.create({ sessionId: SessionId('s17'), agentOptions: {} })
    // Unload the harness alone: fiber teardown runs sibling disposables
    // concurrently, so the subprocess provider would SIGTERM the child before
    // the driver's stdin-EOF grace can land.
    bench.ctx.registry.delete(AcpHarness)
    await waitForFile(flushMarker, TEST_TIMEOUT - 5000)
  }, TEST_TIMEOUT)

  it('enumerates the devin catalog and reports auth state through the CLI', async () => {
    bench = await setup({
      MOCK_MODELS_JSON: JSON.stringify({
        families: [{
          variants: [
            { model_uid: 'swe-1', label: 'SWE 1', cost_summary: 'standard', supports_images: true },
            { model_uid: 'swe-2', label: 'SWE 2' },
          ],
        }],
      }),
      MOCK_AUTH_DETAIL: 'logged in as mock@example.com',
    })
    const models = await bench.ctx.llm.listModels('devin')
    expect(models.map(model => model.id)).toEqual(['swe-1', 'swe-2'])
    expect(models[0]!.inputModalities).toEqual(['text', 'image'])
    const status = await bench.ctx.acpHarness.status(new AbortController().signal)
    expect(status.cliLoggedIn).toBe(true)
    expect(status.cliDetail).toBe('logged in as mock@example.com')
  }, TEST_TIMEOUT)

  it('rejects stream calls as a catalog-only provider', async () => {
    const adapter = new DevinCatalogAdapter({
      listDevinModels: async () => [],
    } as unknown as AcpRuntime)
    expect(() => adapter.stream({ messages: [] } as never)).toThrow('catalog')
  })
})
