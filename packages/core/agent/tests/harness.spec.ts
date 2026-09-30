/** The per-harness factory registry and the durable `agent/harness` record. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  HarnessId,
  agentHarnessOf,
  agentHarnessProjectionDefinition,
  harnessOwning,
  harnessesServing,
  recordedHarness,
} from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentHarness } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

/** A factory that records each entry point with the harness the caller requested. */
function recordingFactory(): { factory: AgentFactory; calls: string[] } {
  const calls: string[] = []
  const factory: AgentFactory = {
    createAgent(_ownerCtx, options) {
      calls.push(`create:${options.harness ?? 'sole'}`)
      return Promise.resolve({
        agent: { id: options.sessionId } as Agent,
        dispose: () => Promise.resolve(),
      })
    },
    resume(_ownerCtx, options) {
      calls.push(`resume:${options.harness ?? 'sole'}`)
      return Promise.resolve({
        agent: { id: options.resumeSessionId } as Agent,
        dispose: () => Promise.resolve(),
      })
    },
  }
  return { factory, calls }
}

/** One `agent/harness` record at an exact sequence, with a deliberately loose value. */
function harnessEvent(seq: number, harness: unknown): SessionEvent {
  return { type: 'agent/harness', seq, time: 1, data: { harness } } as unknown as SessionEvent
}

/** An unrelated event, to prove the record fold ignores every other type. */
function unrelatedEvent(seq: number): SessionEvent {
  return { type: 'turn/start', seq, time: 1, data: { turn: 1 } } as unknown as SessionEvent
}

describe('AgentRegistry harnesses', () => {
  it('keeps registration order, exposes each identity, and removes one on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const dsh = recordingFactory()
    const codex = recordingFactory()
    const disposeDsh = ctx.agents.registerHarness({
      id: HarnessId('dsh'), name: 'DeepSeek Harness', factory: dsh.factory,
    })
    const disposeCodex = ctx.agents.registerHarness({
      id: HarnessId('codex'),
      name: 'Codex',
      description: 'OpenAI Codex CLI',
      modelProvider: 'codex',
      factory: codex.factory,
    })

    const mounted = ctx.agents.harnesses()
    expect(mounted).toEqual([
      { id: HarnessId('dsh'), name: 'DeepSeek Harness' },
      { id: HarnessId('codex'), name: 'Codex', description: 'OpenAI Codex CLI', modelProvider: 'codex' },
    ])
    expect(ctx.agents.harnesses()[0]).toBe(mounted[0])

    disposeCodex()
    expect(ctx.agents.harnesses().map(entry => entry.id)).toEqual([HarnessId('dsh')])
    disposeDsh()
    expect(ctx.agents.harnesses()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects a duplicate or empty harness id without disturbing mounted harnesses', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const { factory } = recordingFactory()
    ctx.agents.registerHarness({ id: HarnessId('dsh'), name: 'DeepSeek Harness', factory })

    expect(() => ctx.agents.registerHarness({ id: HarnessId('dsh'), name: 'Other', factory }))
      .toThrow('agent harness "dsh" is already registered')
    expect(() => ctx.agents.registerHarness({ id: HarnessId(''), name: 'Empty', factory }))
      .toThrow('agent harness id must be a non-empty string')
    expect(ctx.agents.harnesses().map(entry => entry.id)).toEqual([HarnessId('dsh')])
    await ctx.fiber.dispose()
  })

  it('commits a registration even when a harnesses-changed listener throws', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const { factory } = recordingFactory()
    let failing = true
    ctx.on('agents/harnesses-changed', () => {
      if (failing) throw new Error('listener exploded')
    })

    // The listener's failure surfaces to the registrant, but the registration
    // already committed with a live disposer: the harness stays mounted and
    // its id stays owned rather than stranding without a cleanup path.
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      expect(() => inner.agents.registerHarness({ id: HarnessId('dsh'), name: 'DeepSeek Harness', factory }))
        .toThrow('listener exploded')
    }, { inject: ['agents'] }))
    expect(ctx.agents.harnesses().map(entry => entry.id)).toEqual([HarnessId('dsh')])
    failing = false
    expect(() => ctx.agents.registerHarness({ id: HarnessId('dsh'), name: 'Other', factory }))
      .toThrow('agent harness "dsh" is already registered')

    // The orphaned call still left a working effect: unloading the registering
    // fiber removes the harness.
    await owner.dispose()
    expect(ctx.agents.harnesses()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('removes a harness with the fiber that registered it (HMR)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const { factory } = recordingFactory()
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.registerHarness({ id: HarnessId('codex'), name: 'Codex', factory })
    }, { inject: ['agents'] }))
    expect(ctx.agents.harnesses().map(entry => entry.id)).toEqual([HarnessId('codex')])

    await owner.dispose()
    expect(ctx.agents.harnesses()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('resolves each call by explicit id, the loop for an unrecorded log, a sole harness, or a loud failure', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)

    await expect(ctx.agents.create({ sessionId: SessionId('none') }))
      .rejects.toThrow('no agent factory registered (load an agent-loop plugin)')
    await expect(ctx.agents.resume({ resumeSessionId: SessionId('none') }))
      .rejects.toThrow('no agent factory registered (load an agent-loop plugin)')
    await expect(ctx.agents.create({ sessionId: SessionId('unknown'), harness: HarnessId('codex') }))
      .rejects.toThrow('agent harness "codex" is not registered (mounted: none)')
    expect(ctx.agents.harnessForUnrecordedSession()).toBeUndefined()

    const dsh = recordingFactory()
    const disposeDsh = ctx.agents.registerHarness({
      id: HarnessId('dsh'), name: 'DeepSeek Harness', factory: dsh.factory,
    })
    await expect(ctx.agents.resume({ resumeSessionId: SessionId('unknown'), harness: HarnessId('codex') }))
      .rejects.toThrow('agent harness "codex" is not registered (mounted: dsh)')

    await ctx.agents.create({ sessionId: SessionId('sole') })
    await ctx.agents.resume({ resumeSessionId: SessionId('sole'), harness: HarnessId('dsh') })
    expect(dsh.calls).toEqual(['create:sole', 'resume:dsh'])
    expect(ctx.agents.harnessForUnrecordedSession()).toBe(HarnessId('dsh'))

    const codex = recordingFactory()
    ctx.agents.registerHarness({ id: HarnessId('codex'), name: 'Codex', factory: codex.factory })
    await expect(ctx.agents.create({ sessionId: SessionId('ambiguous') }))
      .rejects.toThrow('agent creation needs a harness id (mounted: dsh, codex)')
    // A resume reaches the registry unnamed exactly when the caller's log
    // records no harness, and the loop claims those logs instead of refusing.
    await ctx.agents.resume({ resumeSessionId: SessionId('unrecorded') })
    expect(dsh.calls).toEqual(['create:sole', 'resume:dsh', 'resume:sole'])
    expect(codex.calls).toEqual([])

    await ctx.agents.create({ sessionId: SessionId('chosen'), harness: HarnessId('codex') })
    expect(codex.calls).toEqual(['create:codex'])
    expect(dsh.calls).toEqual(['create:sole', 'resume:dsh', 'resume:sole'])

    disposeDsh()
    expect(ctx.agents.harnessForUnrecordedSession()).toBeUndefined()
    await ctx.agents.resume({ resumeSessionId: SessionId('last-resume') })
    await ctx.agents.create({ sessionId: SessionId('last') })
    expect(codex.calls).toEqual(['create:codex', 'resume:sole', 'create:sole'])
    await ctx.fiber.dispose()
  })

  it('routes an owned provider to its declaring harness and unowned routes to provider-less harnesses', () => {
    const harnesses: AgentHarness[] = [
      { id: HarnessId('dsh'), name: 'DeepSeek Harness' },
      { id: HarnessId('codex'), name: 'Codex', modelProvider: 'codex' },
      { id: HarnessId('acp'), name: 'ACP' },
    ]

    expect(harnessesServing(harnesses, 'codex')).toEqual([HarnessId('codex')])
    expect(harnessesServing(harnesses, 'deepseek')).toEqual([HarnessId('dsh'), HarnessId('acp')])
  })

  it('registers the built-in dsh harness through setFactory', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const { factory, calls } = recordingFactory()
    const dispose = ctx.agents.setFactory(factory)

    expect(ctx.agents.harnesses()).toEqual([{ id: HarnessId('dsh'), name: 'DeepSeek Harness', hostsLoopComposition: true }])
    await ctx.agents.create({ sessionId: SessionId('built-in') })
    expect(calls).toEqual(['create:sole'])

    dispose()
    expect(ctx.agents.harnesses()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('resolves the harness a create or resume would land on without calling it', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    expect(ctx.agents.resolveHarness(undefined, 'create')).toBeUndefined()

    const foreign = recordingFactory()
    ctx.agents.registerHarness({ id: HarnessId('foreign'), name: 'Foreign', factory: foreign.factory })
    // One mounted harness answers every unnamed call.
    expect(ctx.agents.resolveHarness(undefined, 'create')?.id).toBe('foreign')
    expect(ctx.agents.resolveHarness(undefined, 'resume')?.id).toBe('foreign')

    ctx.agents.setFactory(recordingFactory().factory)
    // Several mounted: an unnamed create refuses, an unnamed resume takes the loop.
    expect(ctx.agents.resolveHarness(undefined, 'create')).toBeUndefined()
    expect(ctx.agents.resolveHarness(undefined, 'resume')).toEqual({
      id: HarnessId('dsh'), name: 'DeepSeek Harness', hostsLoopComposition: true,
    })
    expect(ctx.agents.resolveHarness(HarnessId('foreign'), 'create')).toEqual({ id: 'foreign', name: 'Foreign' })
    expect(ctx.agents.resolveHarness(HarnessId('missing'), 'create')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('agent/harness record', () => {
  it('folds the first record and rejects a duplicate or malformed one', () => {
    const { init, apply, wire } = agentHarnessProjectionDefinition
    expect(init()).toBeNull()
    expect(apply(null, unrelatedEvent(0))).toBeNull()
    expect(apply(null, harnessEvent(1, 'dsh'))).toBe('dsh')
    expect(wire.view('dsh')).toBe('dsh')

    expect(() => apply('dsh', harnessEvent(3, 'codex')))
      .toThrow('duplicate agent/harness at session seq 3')
    expect(() => apply(null, harnessEvent(4, undefined)))
      .toThrow('invalid agent/harness at session seq 4')
    expect(() => apply(null, harnessEvent(5, '')))
      .toThrow('invalid agent/harness at session seq 5')
    expect(() => apply(null, harnessEvent(6, 7)))
      .toThrow('invalid agent/harness at session seq 6')
  })

  it('reads the live session record and the last valid persisted one', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(SessionId('recorded-harness'), { meta: { cwd: '/workspace' } })

    expect(agentHarnessOf(ctx.sessionProjections, session)).toBeUndefined()
    session.append('agent/harness', { harness: 'dsh' })
    expect(agentHarnessOf(ctx.sessionProjections, session)).toBe(HarnessId('dsh'))
    await ctx.fiber.dispose()

    expect(recordedHarness([])).toBeUndefined()
    // Malformed and unrelated entries are skipped; the one valid record wins.
    expect(recordedHarness([
      harnessEvent(0, 'codex'),
      harnessEvent(1, ''),
      harnessEvent(2, undefined),
      harnessEvent(3, 7),
      unrelatedEvent(4),
    ])).toEqual(HarnessId('codex'))
    // A second valid id is a corrupt log, exactly as the live fold treats it:
    // one session is never handed from one harness to another.
    expect(() => recordedHarness([
      harnessEvent(0, 'codex'),
      harnessEvent(1, 'acme'),
    ])).toThrow('duplicate agent/harness at session seq 1')
  })

  it('resolves the harness a descendant inherits, and nothing when there is none', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(SessionId('owning-harness'), { meta: { cwd: '/workspace' } })

    expect(harnessOwning(ctx, session)).toBeUndefined()
    session.append('agent/harness', { harness: 'codex' })
    expect(harnessOwning(ctx, session)).toBe(HarnessId('codex'))
    await ctx.fiber.dispose()

    // A deployment mounting no projection registry has no record to fold: the
    // read yields nothing and the host resolves the owner itself.
    const bare = new Context()
    await bare.plugin(SessionStore)
    const unprojected = bare.sessions.create(SessionId('unprojected'), { meta: { cwd: '/workspace' } })
    expect(harnessOwning(bare, unprojected)).toBeUndefined()
    await bare.fiber.dispose()
  })
})
