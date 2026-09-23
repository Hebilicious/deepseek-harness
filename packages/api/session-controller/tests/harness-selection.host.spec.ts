/** Harness selection on the Host Session face: catalog, create routing, and resume routing. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { HarnessId, recordedHarness } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type SessionController from '../src/index.ts'
import {
  createSessionTestController,
  createSessionTestRemote,
  installSessionReadTestServices,
  testSessionPersistence,
} from './test-remote.ts'
import type { TestSessionRemote } from './test-remote.ts'

const DSH = HarnessId('dsh')
const CODEX = HarnessId('codex')
const DEVIN = HarnessId('devin')
const CWD = '/workspace'

const roots: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Per-harness record of the create and resume calls its factory served. */
interface HarnessCalls {
  readonly create: CreateAgentOptions[]
  readonly resume: ResumeAgentOptions[]
}

/** One Host context with a real Agent registry, scripted per-harness factories, and its Remote. */
interface HarnessWorld {
  readonly ctx: Context
  readonly controller: SessionController
  readonly remote: TestSessionRemote
  mount(id: HarnessId, name: string, description?: string, record?: boolean): HarnessCalls
  /** Mount a harness whose resume rejects with one exact failure. */
  mountFailingResume(id: HarnessId, error: unknown): void
  persist(header: SessionHeader, events?: readonly SessionEvent[]): void
}

function sessionHeader(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd: CWD }
}

function harnessRecord(harness: HarnessId, seq: number): SessionEvent {
  return { type: 'agent/harness', seq, time: 1, data: { harness } } as unknown as SessionEvent
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-harness-selection-'))
  tempDirs.push(dir)
  return dir
}

async function world(): Promise<HarnessWorld> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  await ctx.plugin(AgentRegistry)
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
  const stored = new Map<SessionId, { meta: SessionHeader; events: readonly SessionEvent[] }>()
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([...stored.values()].map(entry => entry.meta)),
    inspect: (sessionId: SessionId) => Promise.resolve(stored.get(sessionId)),
  }) as never)
  const defaults = {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: CWD,
  }
  const controller = createSessionTestController(ctx, defaults)

  const publish = async (
    ownerCtx: Context,
    sessionId: SessionId,
    meta: CreateAgentOptions['meta'] | SessionHeader | undefined,
    seed: readonly SessionEvent[],
    setup: AgentSetup | undefined,
    harness: HarnessId | undefined,
    inheritedEventCount?: SessionLogOffset,
  ): Promise<AgentHandle> => {
    const session = ctx.sessions.create(sessionId, {
      ...(meta === undefined ? {} : { meta }),
      ...(seed.length === 0 ? {} : { seed: [...seed] }),
      ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }),
    })
    const agent = { id: sessionId, session, status: 'idle', ctx: ownerCtx } as Agent
    await setup?.(ownerCtx, agent)
    // The production host records the owning harness before publication; a
    // resumed seed that already names the same harness tolerates the repeat.
    // A raw mount stands in for a Session created before this feature.
    if (harness !== undefined) session.append('agent/harness', { harness })
    await ctx.agents.register(agent)
    return { agent, dispose: () => Promise.resolve() }
  }

  const mount = (id: HarnessId, name: string, description?: string, record = true): HarnessCalls => {
    const calls: HarnessCalls = { create: [], resume: [] }
    const factory: AgentFactory = {
      async createAgent(ownerCtx, options) {
        calls.create.push(options)
        return publish(
          ownerCtx,
          options.sessionId,
          options.meta,
          options.seed ?? [],
          options.setup,
          record ? id : undefined,
          options.inheritedEventCount,
        )
      },
      async resume(ownerCtx, options) {
        calls.resume.push(options)
        const persisted = stored.get(options.resumeSessionId)
        if (persisted === undefined) {
          throw new Error(`harness test has no persisted session "${options.resumeSessionId}"`)
        }
        return publish(ownerCtx, options.resumeSessionId, persisted.meta, persisted.events, options.setup, record ? id : undefined)
      },
    }
    ctx.agents.registerHarness({ id, name, ...(description === undefined ? {} : { description }), factory })
    return calls
  }

  const mountFailingResume = (id: HarnessId, error: unknown): void => {
    const factory: AgentFactory = {
      createAgent: () => Promise.reject(error instanceof Error ? error : new Error(String(error))),
      resume: () => Promise.reject(error instanceof Error ? error : new Error(String(error))),
    }
    ctx.agents.registerHarness({ id, name: id, factory })
  }

  return {
    ctx,
    controller,
    remote: createSessionTestRemote(ctx, defaults),
    mount,
    mountFailingResume,
    persist: (header, events = []) => { stored.set(header.id, { meta: header, events }) },
  }
}

describe('Session harness selection', () => {
  it('lists mounted harnesses in registration order', async () => {
    const w = await world()
    w.mount(CODEX, 'Codex', 'OpenAI Codex CLI')
    w.mount(DSH, 'DeepSeek Harness')

    expect(w.controller.harnessCatalog()).toEqual({
      harnesses: [
        { id: CODEX, name: 'Codex', description: 'OpenAI Codex CLI' },
        { id: DSH, name: 'DeepSeek Harness' },
      ],
    })
  })

  it('creates a new session under the requested harness', async () => {
    const w = await world()
    const codex = w.mount(CODEX, 'Codex')
    const dsh = w.mount(DSH, 'DeepSeek Harness')

    const response = await w.remote.create({ cwd: tempDir(), harness: CODEX })

    if (!response.ok) throw response.error
    expect(codex.create).toHaveLength(1)
    expect(codex.create[0]?.harness).toBe(CODEX)
    expect(dsh.create).toEqual([])
    expect(w.ctx.agents.get(response.value.sessionId)?.id).toBe(response.value.sessionId)
  })

  it('refuses an unnamed create while several harnesses are mounted', async () => {
    const w = await world()
    const dsh = w.mount(DSH, 'DeepSeek Harness')
    const codex = w.mount(CODEX, 'Codex')

    const response = await w.remote.create({ cwd: tempDir() })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'gateway/bad-request',
        message: 'session.create needs a harness id (mounted: dsh, codex)',
      },
    })
    expect(dsh.create).toEqual([])
    expect(codex.create).toEqual([])
  })

  it('adopts a session that records no harness under the requested one', async () => {
    const w = await world()
    const header = sessionHeader('unrecorded-adoption')
    w.persist(header)
    const codex = w.mount(CODEX, 'Codex')
    const dsh = w.mount(DSH, 'DeepSeek Harness')

    const response = await w.remote.create({ sessionId: header.id, cwd: CWD, harness: CODEX })

    if (!response.ok) throw response.error
    expect(response.value.sessionId).toBe(header.id)
    expect(codex.resume).toHaveLength(1)
    expect(codex.resume[0]?.harness).toBe(CODEX)
    expect(dsh.resume).toEqual([])
  })

  it('adopts a session that records no harness under the in-process loop', async () => {
    const w = await world()
    const header = sessionHeader('unrecorded-loop-adoption')
    w.persist(header)
    const dsh = w.mount(DSH, 'DeepSeek Harness')
    const codex = w.mount(CODEX, 'Codex')

    const response = await w.remote.create({ sessionId: header.id, cwd: CWD })

    if (!response.ok) throw response.error
    expect(response.value.sessionId).toBe(header.id)
    expect(dsh.resume).toHaveLength(1)
    expect(codex.resume).toEqual([])
  })

  it('refuses a request that names a harness other than the recorded one', async () => {
    const w = await world()
    const header = sessionHeader('recorded-dsh')
    w.persist(header, [harnessRecord(DSH, 0)])
    const dsh = w.mount(DSH, 'DeepSeek Harness')
    const codex = w.mount(CODEX, 'Codex')

    const response = await w.remote.create({ sessionId: header.id, cwd: CWD, harness: CODEX })

    expect(response).toMatchObject({
      ok: false,
      error: {
        // The requested harness is mounted; the session belongs to another
        // one, which is a conflict rather than an unavailable id.
        code: 'session/harness-conflict',
        message: `session "${header.id}" runs agent harness "dsh", not "codex"`,
        details: { sessionId: header.id, requestedHarness: CODEX, recordedHarness: DSH },
      },
    })
    expect(dsh.resume).toEqual([])
    expect(codex.resume).toEqual([])
  })

  it('reports an unmounted recorded harness through the resume path too', async () => {
    const w = await world()
    const header = sessionHeader('unmounted-resolve')
    w.persist(header, [harnessRecord(CODEX, 0)])
    w.mount(DSH, 'DeepSeek Harness')

    // Opening a session goes through resolveAgent, not create: the typed
    // failure must survive that path instead of becoming an internal fault.
    const result = await w.controller.resolveAgent(header.id)

    expect(result).toMatchObject({
      error: {
        code: 'session/harness-unavailable',
        message: expect.stringContaining('agent harness "codex" is not mounted') as string,
        details: { harness: CODEX, available: [DSH] },
      },
    })
  })

  it('refuses a live session resolved under a harness other than its record', async () => {
    const w = await world()
    const header = sessionHeader('live-conflict')
    w.persist(header)
    const dsh = w.mount(DSH, 'DeepSeek Harness')
    w.mount(CODEX, 'Codex')
    const handle = await w.ctx.agents.create({ sessionId: header.id, harness: DSH, meta: { cwd: CWD } })

    // The live-agent fast path skips the persisted checks, so the resolution
    // result itself must be verified against the requested harness.
    const response = await w.remote.create({ sessionId: header.id, cwd: CWD, harness: CODEX })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'session/harness-conflict',
        details: { sessionId: header.id, requestedHarness: CODEX, recordedHarness: DSH },
      },
    })
    expect(dsh.create).toHaveLength(1)
    await handle.dispose()
  })

  it('adopts a live session that records no harness under the requested one', async () => {
    const w = await world()
    const header = sessionHeader('live-unrecorded')
    // A raw mount stands in for a Session created before this feature.
    const dsh = w.mount(DSH, 'DeepSeek Harness', undefined, false)
    w.mount(CODEX, 'Codex')
    const handle = await w.ctx.agents.create({ sessionId: header.id, harness: DSH, meta: { cwd: CWD } })

    const response = await w.remote.create({ sessionId: header.id, cwd: CWD, harness: CODEX })

    // Nothing records which harness owns the live agent, so the request is not
    // a conflict: this is the pre-feature session the adoption path exists for.
    expect(response).toMatchObject({ ok: true, value: { sessionId: header.id } })
    expect(dsh.create).toHaveLength(1)
    await handle.dispose()
  })

  it('keeps a failure this boundary cannot name internal', async () => {
    const w = await world()
    const header = sessionHeader('typed-but-unmapped')
    w.persist(header)
    w.mountFailingResume(DSH, new RemoteError('session/agent-busy', 'busy', {
      reason: 'the harness is mid-turn',
    }))

    const result = await w.controller.resolveAgent(header.id)

    // Only the harness codes above cross this boundary; another typed failure
    // stays an internal fault rather than inventing a client-facing code.
    expect(result).toMatchObject({
      error: { code: 'gateway/internal', message: expect.stringContaining('busy') as string },
    })
  })

  it('refuses a session whose recorded harness is not mounted', async () => {
    const w = await world()
    const header = sessionHeader('recorded-codex')
    w.persist(header, [harnessRecord(CODEX, 0)])
    const dsh = w.mount(DSH, 'DeepSeek Harness')

    const response = await w.remote.create({ sessionId: header.id, cwd: CWD })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'session/harness-unavailable',
        message: 'agent harness "codex" is not mounted (available: dsh)',
        details: { harness: CODEX, available: [DSH] },
      },
    })
    expect(dsh.resume).toEqual([])
  })

  it('names the empty mount list when a requested harness is unavailable', async () => {
    const w = await world()

    const response = await w.remote.create({ cwd: tempDir(), harness: DSH })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'session/harness-unavailable',
        message: 'agent harness "dsh" is not mounted (available: none)',
        details: { harness: DSH, available: [] },
      },
    })
  })

  it('resumes a recorded session under its own harness', async () => {
    const w = await world()
    const header = sessionHeader('recorded-resume')
    w.persist(header, [harnessRecord(DSH, 0)])
    const dsh = w.mount(DSH, 'DeepSeek Harness')

    const result = await w.controller.resolveAgent(header.id)

    expect(result).toMatchObject({ agent: { id: header.id } })
    expect(dsh.resume).toHaveLength(1)
    expect(dsh.resume[0]?.harness).toBe(DSH)
  })

  it('resumes a session that records no harness under the in-process loop', async () => {
    const w = await world()
    const header = sessionHeader('unrecorded-loop-resume')
    w.persist(header)
    const dsh = w.mount(DSH, 'DeepSeek Harness')
    const codex = w.mount(CODEX, 'Codex')

    const result = await w.controller.resolveAgent(header.id)

    // A log written before the harness record existed ran the deployment's
    // loop, which claims it here rather than refusing among several mounts.
    expect(result).toMatchObject({ agent: { id: header.id } })
    expect(dsh.resume).toHaveLength(1)
    expect(codex.resume).toEqual([])
    const resumed = w.ctx.agents.get(header.id)
    if (resumed === undefined) throw new Error('expected the resumed session to be published')
    expect(recordedHarness(resumed.session.snapshotEvents())).toBe(DSH)
  })

  it('refuses to resume a session that records no harness when no loop is mounted', async () => {
    const w = await world()
    const header = sessionHeader('unrecorded-no-loop')
    w.persist(header)
    const codex = w.mount(CODEX, 'Codex')
    const devin = w.mount(DEVIN, 'Devin')

    const result = await w.controller.resolveAgent(header.id)

    expect(result).toMatchObject({
      error: {
        // The typed refusal survives the resume path, so a client can tell an
        // unadoptable session from an internal fault.
        code: 'gateway/bad-request',
        message: expect.stringContaining(
          `session "${header.id}" records no agent harness and this deployment mounts codex, devin`,
        ) as string,
      },
    })
    expect(codex.resume).toEqual([])
    expect(devin.resume).toEqual([])
  })

  it('forks a completed session that records no harness under the in-process loop', async () => {
    const w = await world()
    const source = w.ctx.sessions.create(SessionId('fork-unrecorded'), { meta: { cwd: CWD } })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'work' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    w.persist({ ...source.header }, source.snapshotEvents())
    const dsh = w.mount(DSH, 'DeepSeek Harness')
    const codex = w.mount(CODEX, 'Codex')

    const response = await w.remote.fork({ sessionId: source.id })

    if (!response.ok) throw response.error
    expect(dsh.create).toHaveLength(1)
    expect(codex.create).toEqual([])
    expect(dsh.create[0]?.harness).toBe(DSH)
    const child = w.ctx.agents.get(response.value.sessionId)
    if (child === undefined) throw new Error('expected the fork child to be published')
    expect(recordedHarness(child.session.snapshotEvents())).toBe(DSH)
  })

  it('forks a completed session under the harness its log records', async () => {
    const w = await world()
    const source = w.ctx.sessions.create(SessionId('fork-source'), { meta: { cwd: CWD } })
    // Codex, not the loop's `dsh`: a hardcoded or sole-harness fallback would
    // route the child to the wrong factory here.
    source.append('agent/harness', { harness: CODEX })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'work' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    w.persist({ ...source.header }, source.snapshotEvents())
    const dsh = w.mount(DSH, 'DeepSeek Harness')
    const codex = w.mount(CODEX, 'Codex')

    const response = await w.remote.fork({ sessionId: source.id })

    if (!response.ok) throw response.error
    expect(codex.create).toHaveLength(1)
    expect(dsh.create).toEqual([])
    expect(codex.create[0]?.harness).toBe(CODEX)
    // The child's own log opens with the source prefix, so its durable record
    // carries the harness the fork ran.
    const child = w.ctx.agents.get(response.value.sessionId)
    if (child === undefined) throw new Error('expected the fork child to be published')
    expect(recordedHarness(child.session.snapshotEvents())).toBe(CODEX)
  })
})
