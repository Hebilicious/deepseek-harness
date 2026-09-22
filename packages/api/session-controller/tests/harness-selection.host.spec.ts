/** Harness selection on the Host Session face: catalog, create routing, and resume routing. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { HarnessId } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
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
  mount(id: HarnessId, name: string, description?: string): HarnessCalls
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
  ): Promise<AgentHandle> => {
    const session = ctx.sessions.create(sessionId, {
      ...(meta === undefined ? {} : { meta }),
      ...(seed.length === 0 ? {} : { seed: [...seed] }),
    })
    const agent = { id: sessionId, session, status: 'idle', ctx: ownerCtx } as Agent
    await setup?.(ownerCtx, agent)
    await ctx.agents.register(agent)
    return { agent, dispose: () => Promise.resolve() }
  }

  const mount = (id: HarnessId, name: string, description?: string): HarnessCalls => {
    const calls: HarnessCalls = { create: [], resume: [] }
    const factory: AgentFactory = {
      async createAgent(ownerCtx, options) {
        calls.create.push(options)
        return publish(ownerCtx, options.sessionId, options.meta, options.seed ?? [], options.setup)
      },
      async resume(ownerCtx, options) {
        calls.resume.push(options)
        const persisted = stored.get(options.resumeSessionId)
        if (persisted === undefined) {
          throw new Error(`harness test has no persisted session "${options.resumeSessionId}"`)
        }
        return publish(ownerCtx, options.resumeSessionId, persisted.meta, persisted.events, options.setup)
      },
    }
    ctx.agents.registerHarness({ id, name, ...(description === undefined ? {} : { description }), factory })
    return calls
  }

  return {
    ctx,
    controller,
    remote: createSessionTestRemote(ctx, defaults),
    mount,
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
        code: 'session/harness-unavailable',
        message: `session "${header.id}" runs agent harness "dsh", not "codex"`,
        details: { harness: CODEX, available: [DSH, CODEX] },
      },
    })
    expect(dsh.resume).toEqual([])
    expect(codex.resume).toEqual([])
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

  it('refuses to resume a session that records no harness while several are mounted', async () => {
    const w = await world()
    const header = sessionHeader('unrecorded-resume')
    w.persist(header)
    const dsh = w.mount(DSH, 'DeepSeek Harness')
    const codex = w.mount(CODEX, 'Codex')

    const result = await w.controller.resolveAgent(header.id)

    expect(result).toMatchObject({
      error: {
        code: 'gateway/internal',
        message: expect.stringContaining(
          `session "${header.id}" records no agent harness and this deployment mounts dsh, codex`,
        ) as string,
      },
    })
    expect(dsh.resume).toEqual([])
    expect(codex.resume).toEqual([])
  })
})
