/**
 * Multi-instance tests: one plugin instance driving several Codex instances,
 * each with its own process, `CODEX_HOME`, agent-registry identity, catalog
 * route, and account Remote scope. Every case runs the real plugin against
 * scripted mock app-server children, one per instance.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { HarnessId, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { CodexAppServer, codexThreadOf } from '../src/index.ts'

const mockServer = fileURLToPath(new URL('./mock-codex-app-server.ts', import.meta.url))

/** One mounted instance's own `CODEX_HOME` and mock-child record file. */
interface InstanceRoot {
  readonly root: string
  readonly recordFile: string
}

interface Bench {
  readonly ctx: Context
  /** The default `codex` instance. */
  readonly primary: InstanceRoot
  /** The extra `personal` instance. */
  readonly secondary: InstanceRoot
}

let bench: Bench | undefined
const scratch: string[] = []

afterEach(async () => {
  await bench?.ctx.fiber.dispose()
  bench = undefined
  for (const root of scratch.splice(0)) await rm(root, { recursive: true, force: true })
})

const TEST_TIMEOUT = 30_000

/** Own one temp directory through teardown and derive its record file. */
async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(root)
  return root
}

/**
 * Mount the two-instance bench: a default `codex` entry and a `personal` one,
 * each with its own home, mock child, and record file.
 */
async function setup(
  primaryEnv: Record<string, string> = {},
  secondaryEnv: Record<string, string> = {},
): Promise<Bench> {
  const primaryRoot = await tempRoot('agent-codex-multi-primary-')
  const secondaryRoot = await tempRoot('agent-codex-multi-secondary-')
  const sessionRoot = await tempRoot('agent-codex-multi-sessions-')
  const primary: InstanceRoot = { root: primaryRoot, recordFile: join(primaryRoot, 'record.jsonl') }
  const secondary: InstanceRoot = { root: secondaryRoot, recordFile: join(secondaryRoot, 'record.jsonl') }
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(sessionRoot, 'sessions') })
  await ctx.plugin(CodexAppServer, {
    harnesses: [
      {
        id: 'codex',
        name: 'Codex',
        executable: process.execPath,
        args: [mockServer],
        codexHome: primaryRoot,
        env: { MOCK_CODEX_RECORD_FILE: primary.recordFile, ...primaryEnv },
      },
      {
        id: 'personal',
        name: 'Personal Codex',
        description: 'OpenAI Codex on the personal account',
        executable: process.execPath,
        args: [mockServer],
        codexHome: secondaryRoot,
        env: { MOCK_CODEX_RECORD_FILE: secondary.recordFile, ...secondaryEnv },
      },
    ],
  })
  return { ctx, primary, secondary }
}

/** Read one mock child's JSONL frame record. */
async function recordedCalls(file: string): Promise<{ method: string }[]> {
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line) as { method: string })
}

/** Queue one user message on the agent. */
function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

/** The provider one agent's durable request header recorded. */
function headerProvider(agent: Agent): unknown {
  const header = events(agent).find(event => event.type === 'request/header')
  return (header?.data as { header: { config: { provider: string } } }).header.config.provider
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

describe('one plugin instance, several Codex instances', () => {
  it('registers every entry and runs each session on its own process', async () => {
    bench = await setup({ MOCK_CODEX_TEXT: 'from codex' }, { MOCK_CODEX_TEXT: 'from personal' })

    expect(bench.ctx.agents.harnesses()).toEqual([
      { id: 'codex', name: 'Codex', modelProvider: 'codex' },
      { id: 'personal', name: 'Personal Codex', description: 'OpenAI Codex on the personal account', modelProvider: 'personal' },
    ])

    const primary = await bench.ctx.agents.create({
      sessionId: SessionId('m1'),
      harness: HarnessId('codex'),
      agentOptions: {},
    })
    const secondary = await bench.ctx.agents.create({
      sessionId: SessionId('m2'),
      harness: HarnessId('personal'),
      agentOptions: {},
    })
    send(primary.agent, 'hello codex')
    send(secondary.agent, 'hello personal')
    await primary.agent.whenIdle()
    await secondary.agent.whenIdle()

    expect(JSON.stringify(events(primary.agent))).toContain('from codex')
    expect(JSON.stringify(events(secondary.agent))).toContain('from personal')
    expect(headerProvider(primary.agent)).toBe('codex')
    expect(headerProvider(secondary.agent)).toBe('personal')

    // Two sessions, two children: neither instance reused the other's wire.
    expect((await recordedCalls(bench.primary.recordFile)).filter(call => call.method === 'initialize'))
      .toHaveLength(1)
    expect((await recordedCalls(bench.secondary.recordFile)).filter(call => call.method === 'initialize'))
      .toHaveLength(1)
    await primary.dispose()
    await secondary.dispose()
  }, TEST_TIMEOUT)

  it('gives each instance its own CODEX_HOME and spawns only the one a session uses', async () => {
    bench = await setup({}, { MOCK_CODEX_TEXT: 'personal answer' })
    const created = await bench.ctx.agents.create({
      sessionId: SessionId('m3'),
      harness: HarnessId('personal'),
      agentOptions: {},
    })
    send(created.agent, 'write a rollout')
    await created.agent.whenIdle()

    // The mock app-server keeps its rollout store under `$CODEX_HOME`, so a
    // turn on one instance proves which home that child received.
    expect(existsSync(join(bench.secondary.root, 'mock-rollouts'))).toBe(true)
    expect(existsSync(join(bench.primary.root, 'mock-rollouts'))).toBe(false)
    expect(await recordedCalls(bench.primary.recordFile)).toEqual([])
    await created.dispose()
  }, TEST_TIMEOUT)

  it('resumes a session only through the instance that recorded it', async () => {
    bench = await setup({ MOCK_CODEX_TEXT: 'codex answer' })
    const first = await bench.ctx.agents.create({
      sessionId: SessionId('m4'),
      harness: HarnessId('codex'),
      agentOptions: {},
    })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    const thread = codexThreadOf(bench.ctx.sessionProjections, first.agent.session)
    expect(thread).toBeDefined()
    await first.dispose()

    // Another instance refuses a session its own log assigns elsewhere.
    await expect(bench.ctx.agents.resume({
      resumeSessionId: SessionId('m4'),
      harness: HarnessId('personal'),
    })).rejects.toThrow('belongs to agent harness "codex", not "personal"')

    const resumed = await bench.ctx.agents.resume({
      resumeSessionId: SessionId('m4'),
      harness: HarnessId('codex'),
    })
    expect(codexThreadOf(bench.ctx.sessionProjections, resumed.agent.session)).toBe(thread)
    await resumed.dispose()
  }, TEST_TIMEOUT)

  it('refuses an unqualified create and names every mounted instance on an unknown id', async () => {
    bench = await setup()
    await expect(bench.ctx.agents.create({ sessionId: SessionId('m5'), agentOptions: {} }))
      .rejects.toThrow('agent creation needs a harness id (mounted: codex, personal)')

    const failure: unknown = await bench.ctx.codexAppServer
      .status({ harness: 'ghost' }, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error)
    expect(String(failure)).toContain('unknown Codex harness "ghost" (mounted: codex, personal)')
  }, TEST_TIMEOUT)

  it('scopes account operations to the named instance', async () => {
    bench = await setup({ MOCK_CODEX_RATE_LIMIT_BUCKETS: '1' }, { MOCK_CODEX_AUTH: 'out' })
    const signal = new AbortController().signal

    expect(await bench.ctx.codexAppServer.status({ harness: 'codex' }, signal))
      .toMatchObject({ authenticated: true, accountType: 'chatgpt' })
    // The signed-out personal instance answers from its own child, never from
    // the signed-in instance's connection.
    expect(await bench.ctx.codexAppServer.status({ harness: 'personal' }, signal))
      .toMatchObject({ authenticated: false, requiresOpenaiAuth: true })
    expect((await recordedCalls(bench.secondary.recordFile)).some(call => call.method === 'account/read'))
      .toBe(true)
  }, TEST_TIMEOUT)

  it('serves one catalog route per instance', async () => {
    bench = await setup(
      { MOCK_CODEX_MODELS: JSON.stringify([{ model: 'codex-a', displayName: 'Codex A' }]) },
      { MOCK_CODEX_MODELS: JSON.stringify([{ model: 'personal-b', displayName: 'Personal B' }]) },
    )
    expect((await bench.ctx.llm.listModels('codex')).map(model => model.id)).toEqual(['codex-a'])
    expect((await bench.ctx.llm.listModels('personal')).map(model => model.id)).toEqual(['personal-b'])
    expect(bench.ctx.llm.listProviders().filter(provider => provider.id === 'personal'))
      .toEqual([{ id: 'personal', name: 'Personal Codex' }])
  }, TEST_TIMEOUT)

  it('disposes every instance process when the plugin unloads', async () => {
    const primaryPid = join(await tempRoot('agent-codex-pids-primary-'), 'pid')
    const secondaryPid = join(await tempRoot('agent-codex-pids-secondary-'), 'pid')
    bench = await setup(
      { MOCK_CODEX_PID_FILE: primaryPid },
      { MOCK_CODEX_PID_FILE: secondaryPid },
    )
    await bench.ctx.agents.create({
      sessionId: SessionId('m6'),
      harness: HarnessId('codex'),
      agentOptions: {},
    })
    await bench.ctx.agents.create({
      sessionId: SessionId('m7'),
      harness: HarnessId('personal'),
      agentOptions: {},
    })
    await expect.poll(() => existsSync(primaryPid) && existsSync(secondaryPid), { timeout: TEST_TIMEOUT - 5000 })
      .toBe(true)
    const primaryChild = Number(await readFile(primaryPid, 'utf8'))
    const secondaryChild = Number(await readFile(secondaryPid, 'utf8'))
    expect(primaryChild).not.toBe(secondaryChild)

    bench.ctx.registry.delete(CodexAppServer)
    await expect.poll(() => !alive(primaryChild) && !alive(secondaryChild), { timeout: TEST_TIMEOUT - 5000 })
      .toBe(true)
  }, TEST_TIMEOUT)
})
