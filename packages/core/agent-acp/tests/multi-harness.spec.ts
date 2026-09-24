/**
 * Multi-harness tests: one plugin instance driving several ACP harnesses, each
 * with its own process and connection, its own `ctx.agents` identity, its own
 * catalog route, and its own auth Remote scope. Every case runs the real
 * plugin against scripted mock ACP children, one per harness.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessId } from '@deepseek-ai/dsh-agent'
import type { AcpHarnessEntry } from '@deepseek-ai/dsh-agent-acp'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AcpHarness, acpSessionOf } from '../src/index.ts'
import {
  type Bench,
  events,
  mockAgent,
  recordedCalls,
  send,
  setup,
  teardown,
  turnEndKind,
  waitFor,
  waitForFile,
} from './bench.ts'

let bench: Bench | undefined
const scratch: string[] = []

afterEach(async () => {
  await teardown(bench)
  bench = undefined
  for (const root of scratch.splice(0)) await rm(root, { recursive: true, force: true })
})

const TEST_TIMEOUT = 30_000

/** One extra harness entry and the record file its mock child writes. */
interface ExtraHarness {
  readonly entry: AcpHarnessEntry
  readonly recordFile: string
}

/** Build an extra harness entry whose mock child records into its own temp file. */
async function extraHarness(
  id: string,
  name: string,
  env: Record<string, string> = {},
  entry: Record<string, unknown> = {},
): Promise<ExtraHarness> {
  const root = await mkdtemp(join(tmpdir(), `agent-acp-${id}-`))
  scratch.push(root)
  const recordFile = join(root, 'record.jsonl')
  return {
    recordFile,
    entry: {
      id,
      name,
      executable: process.execPath,
      args: [mockAgent, 'acp'],
      authStatusArgs: [mockAgent, 'auth', 'status'],
      authLogoutArgs: [mockAgent, 'auth', 'logout'],
      env: { MOCK_RECORD_FILE: recordFile, ...env },
      ...entry,
    },
  }
}

/** The provider one agent's durable request header recorded. */
function headerProvider(agent: { session: { snapshotEvents(): readonly { type: string; data: unknown }[] } }): unknown {
  const header = agent.session.snapshotEvents().find(event => event.type === 'request/header')
  return (header?.data as { header: { config: { provider: string } } }).header.config.provider
}

/** The `configId`/`value` pair one `session/set_config_option` request carried. */
function configWrite(call: { readonly params: unknown }): { configId: string; value: string } {
  const { configId, value } = call.params as { configId: string; value: string }
  return { configId, value }
}

/** Whether a pid still names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('one plugin instance, several harnesses', () => {
  it('registers every entry and spawns only the harness a session uses', async () => {
    const grok = await extraHarness('grok', 'Grok Build', { MOCK_TEXT: 'from grok' }, { description: 'xAI Grok Build' })
    bench = await setup({ MOCK_TEXT: 'from devin' }, { harnesses: [grok.entry] })

    expect(bench.ctx.agents.harnesses()).toEqual([
      { id: 'devin', name: 'Devin', description: 'Devin runs the session through devin acp', modelProvider: 'devin' },
      { id: 'grok', name: 'Grok Build', description: 'xAI Grok Build', modelProvider: 'grok' },
    ])

    const created = await bench.ctx.agents.create({
      sessionId: SessionId('m1'),
      harness: HarnessId('grok'),
      agentOptions: {},
    })
    send(created.agent, 'hello grok')
    await created.agent.whenIdle()

    expect(JSON.stringify(events(created.agent))).toContain('from grok')
    // The harness no session used never spawned its child.
    expect(await recordedCalls(bench.recordFile)).toEqual([])
    const calls = await recordedCalls(grok.recordFile)
    expect(calls.some(call => call.method === 'initialize')).toBe(true)
    await created.dispose()
  }, TEST_TIMEOUT)

  it('spawns each harness in its own configured working directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-acp-cwd-'))
    scratch.push(dir)
    const grok = await extraHarness('grok', 'Grok Build', {}, { cwd: dir })
    bench = await setup({}, { harnesses: [grok.entry] })
    await bench.ctx.agents.create({
      sessionId: SessionId('m2'),
      harness: HarnessId('grok'),
      agentOptions: {},
    })
    const startup = (await recordedCalls(grok.recordFile)).find(call => call.method === 'process')
    expect((startup?.params as { cwd: string }).cwd).toBe(dir)
  }, TEST_TIMEOUT)

  it('refuses an unqualified create while several harnesses are mounted', async () => {
    const grok = await extraHarness('grok', 'Grok Build')
    bench = await setup({}, { harnesses: [grok.entry] })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('m3'), agentOptions: {} }))
      .rejects.toThrow('agent creation needs a harness id (mounted: devin, grok)')
  }, TEST_TIMEOUT)

  it('shares one connection among one harness\u2019s sessions', async () => {
    const grok = await extraHarness('grok', 'Grok Build', { MOCK_TEXT: 'shared' })
    bench = await setup({}, { harnesses: [grok.entry] })
    const first = await bench.ctx.agents.create({
      sessionId: SessionId('m4'),
      harness: HarnessId('grok'),
      agentOptions: {},
    })
    const second = await bench.ctx.agents.create({
      sessionId: SessionId('m5'),
      harness: HarnessId('grok'),
      agentOptions: {},
    })
    await first.dispose()
    await second.dispose()

    const calls = await recordedCalls(grok.recordFile)
    expect(calls.filter(call => call.method === 'initialize')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'session/new')).toHaveLength(2)
  }, TEST_TIMEOUT)

  it('binds each session through its own harness and resumes it there', async () => {
    const grok = await extraHarness('grok', 'Grok Build', {
      MOCK_TEXT: 'grok answer',
      MOCK_LOAD_SESSION: '1',
      MOCK_SESSION_ID: 'grok-fixed',
    })
    bench = await setup({
      MOCK_TEXT: 'devin answer',
      MOCK_LOAD_SESSION: '1',
      MOCK_SESSION_ID: 'devin-fixed',
    }, { harnesses: [grok.entry] })

    const devin = await bench.ctx.agents.create({
      sessionId: SessionId('m6'),
      harness: HarnessId('devin'),
      agentOptions: {},
    })
    const other = await bench.ctx.agents.create({
      sessionId: SessionId('m7'),
      harness: HarnessId('grok'),
      agentOptions: {},
    })
    send(devin.agent, 'a')
    send(other.agent, 'b')
    await devin.agent.whenIdle()
    await other.agent.whenIdle()

    expect(headerProvider(devin.agent)).toBe('devin')
    expect(headerProvider(other.agent)).toBe('grok')
    expect(JSON.stringify(events(devin.agent))).toContain('devin answer')
    expect(JSON.stringify(events(other.agent))).toContain('grok answer')
    expect(acpSessionOf(bench.ctx.sessionProjections, devin.agent.session)).toBe('devin-fixed')
    expect(acpSessionOf(bench.ctx.sessionProjections, other.agent.session)).toBe('grok-fixed')
    await devin.dispose()
    await other.dispose()

    // The durable harness record routes the resume to the same harness.
    const resumed = await bench.ctx.agents.resume({
      resumeSessionId: SessionId('m7'),
      harness: HarnessId('grok'),
    })
    send(resumed.agent, 'again')
    await resumed.agent.whenIdle()
    expect((await recordedCalls(grok.recordFile)).filter(call => call.method === 'session/load'))
      .toHaveLength(1)
    expect(turnEndKind(resumed.agent)).toBe('completed')
    await resumed.dispose()

    // Another harness refuses a session its own log assigns elsewhere.
    await expect(bench.ctx.agents.resume({
      resumeSessionId: SessionId('m7'),
      harness: HarnessId('devin'),
    })).rejects.toThrow('belongs to agent harness "grok", not "devin"')
  }, TEST_TIMEOUT)

  it('scopes auth operations to the named harness', async () => {
    const grok = await extraHarness('grok', 'Grok Build', {
      MOCK_AUTH_METHODS: JSON.stringify([{ id: 'grok.com', name: 'Grok' }]),
      MOCK_AUTH_DETAIL: 'grok signed in',
    })
    bench = await setup({
      MOCK_AUTH_METHODS: JSON.stringify([{ id: 'devin-browser', name: 'Log in with browser' }]),
      MOCK_AUTH_DETAIL: 'devin signed in',
    }, { harnesses: [grok.entry] })
    await bench.ctx.agents.create({
      sessionId: SessionId('m8'),
      harness: HarnessId('grok'),
      agentOptions: {},
    })

    const signal = new AbortController().signal
    const grokStatus = await bench.ctx.acpHarness.status({ harness: 'grok' }, signal)
    expect(grokStatus.connected).toBe(true)
    expect(grokStatus.authMethods).toEqual([{ id: 'grok.com', name: 'Grok' }])
    expect(grokStatus.cliDetail).toBe('grok signed in')

    // The other harness answers from its own CLI and has no connection yet.
    const devinStatus = await bench.ctx.acpHarness.status({ harness: 'devin' }, signal)
    expect(devinStatus.connected).toBe(false)
    expect(devinStatus.cliDetail).toBe('devin signed in')

    await bench.ctx.acpHarness.login({ harness: 'grok' }, signal)
    const authenticate = (await recordedCalls(grok.recordFile))
      .find(call => call.method === 'authenticate')
    expect(authenticate?.params).toEqual({ methodId: 'grok.com' })
  }, TEST_TIMEOUT)

  it('disposes every harness process when the plugin unloads', async () => {
    const pidRoot = await mkdtemp(join(tmpdir(), 'agent-acp-pids-'))
    scratch.push(pidRoot)
    const devinPid = join(pidRoot, 'devin.pid')
    const grokPid = join(pidRoot, 'grok.pid')
    const grok = await extraHarness('grok', 'Grok Build', { MOCK_PID_FILE: grokPid })
    bench = await setup({ MOCK_PID_FILE: devinPid }, { harnesses: [grok.entry] })
    await bench.ctx.agents.create({
      sessionId: SessionId('m9'),
      harness: HarnessId('devin'),
      agentOptions: {},
    })
    await bench.ctx.agents.create({
      sessionId: SessionId('m10'),
      harness: HarnessId('grok'),
      agentOptions: {},
    })
    await waitForFile(devinPid, TEST_TIMEOUT - 5000)
    await waitForFile(grokPid, TEST_TIMEOUT - 5000)
    const devinChild = Number(await readFile(devinPid, 'utf8'))
    const grokChild = Number(await readFile(grokPid, 'utf8'))
    expect(devinChild).not.toBe(grokChild)

    bench.ctx.registry.delete(AcpHarness)
    await waitFor(() => !alive(devinChild) && !alive(grokChild), TEST_TIMEOUT - 5000)
  }, TEST_TIMEOUT)
})

describe('per-harness config options', () => {
  it('applies the selected reasoning effort to the advertised effort option', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'reasoning_effort',
        name: 'Reasoning Effort',
        type: 'select',
        category: 'thought_level',
        currentValue: 'high',
        options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
      }]),
    })
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('m11'),
      agentOptions: {
        provider: 'devin',
        model: 'swe-1',
        reasoningEffort: brandString<ReasoningEffortId>('low'),
      },
    })
    send(agent, 'think less')
    await agent.whenIdle()

    const sets = (await recordedCalls(bench.recordFile)).filter(call => call.method === 'session/set_config_option')
    expect(sets.map(configWrite))
      .toEqual([{ configId: 'reasoning_effort', value: 'low' }])
    // The durable route keeps the selection the session logged.
    const header = events(agent).find(event => event.type === 'request/header')
    expect((header?.data as { header: { config: { reasoningEffort?: string } } }).header.config.reasoningEffort)
      .toBe('low')
  }, TEST_TIMEOUT)

  it('applies a deployment reasoning-effort default to a Devin-shaped option id', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'thought_level',
        name: 'Thought Level',
        type: 'select',
        currentValue: 'max',
        options: [
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'max', name: 'Max' },
        ],
      }]),
    }, { config: { reasoningEffort: 'high' } })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('m12'), agentOptions: {} })
    send(agent, 'deployment effort')
    await agent.whenIdle()

    const sets = (await recordedCalls(bench.recordFile)).filter(call => call.method === 'session/set_config_option')
    expect(sets.map(configWrite))
      .toEqual([{ configId: 'thought_level', value: 'high' }])
  }, TEST_TIMEOUT)

  it('warns with the requested and effective effort when the session does not advertise it', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'reasoning_effort',
        name: 'Reasoning Effort',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      }]),
    })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('m13'),
      agentOptions: {
        provider: 'devin',
        model: 'swe-1',
        reasoningEffort: brandString<ReasoningEffortId>('xhigh'),
      },
    })
    send(agent, 'too much effort')
    await agent.whenIdle()

    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings.some(message => message.includes('reasoning effort "xhigh"')
      && message.includes('reasoning effort "high"'))).toBe(true)
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('warns when the session advertises no reasoning-effort option at all', async () => {
    bench = await setup()
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('m14'),
      agentOptions: {
        provider: 'devin',
        model: 'swe-1',
        reasoningEffort: brandString<ReasoningEffortId>('high'),
      },
    })
    send(agent, 'no effort option')
    await agent.whenIdle()

    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings.some(message => message.includes('reasoning effort "high"')
      && message.includes('no reasoning-effort option'))).toBe(true)
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('applies the tool-executing mode opencode and mimocode advertise', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'mode',
        name: 'Session Mode',
        type: 'select',
        currentValue: 'plan',
        options: [
          { value: 'build', name: 'build', description: 'Executes tools based on configured permissions.' },
          { value: 'plan', name: 'plan', description: 'Plan mode. Disallows all edit tools.' },
        ],
      }]),
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('m15'), agentOptions: {} })
    send(agent, 'write it')
    await agent.whenIdle()

    const sets = (await recordedCalls(bench.recordFile)).filter(call => call.method === 'session/set_config_option')
    expect(sets.map(configWrite))
      .toEqual([{ configId: 'mode', value: 'build' }])
  }, TEST_TIMEOUT)

  it('warns with the requested and effective mode instead of skipping a mode silently', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'mode',
        name: 'Session Mode',
        type: 'select',
        currentValue: 'plan',
        options: [{ value: 'plan', name: 'Plan' }],
      }]),
    })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('m16'), agentOptions: {} })
    send(agent, 'no writable mode')
    await agent.whenIdle()

    expect((await recordedCalls(bench.recordFile)).filter(call => call.method === 'session/set_config_option'))
      .toEqual([])
    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('approval policy "ask"')
    expect(warnings[0]).toContain('"plan"')
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('warns when the session advertises no mode option and names no mode', async () => {
    bench = await setup()
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('m17'), agentOptions: {} })
    send(agent, 'no mode option')
    await agent.whenIdle()

    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('approval policy "ask"')
    expect(warnings[0]).toContain('advertises no mode option')
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('warns when a deployment mode override is not advertised', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'mode',
        name: 'Session Mode',
        type: 'select',
        currentValue: 'build',
        options: [{ value: 'build', name: 'build' }],
      }]),
    }, { config: { mode: 'bypass' } })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('m18'), agentOptions: {} })
    send(agent, 'unadvertised override')
    await agent.whenIdle()

    expect((await recordedCalls(bench.recordFile)).filter(call => call.method === 'session/set_config_option'))
      .toEqual([])
    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('mode "bypass"')
    expect(warnings[0]).toContain('"build"')
    warn.mockRestore()
  }, TEST_TIMEOUT)
})
