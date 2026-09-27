/**
 * Focused coverage for the shared external-harness machinery the driver specs
 * cannot reach: ExternalAgent phase-machine edges (idle steer, refused
 * forwards, maintenance and wake latches, bare wakes, abort retargeting), the
 * ExternalAgentHost create/resume transaction (rollback, persistence load,
 * mid-setup teardown), the turn projector's route/tool/attempt paths, the
 * durable model-selection fold, the managed-process teardown ladder, and the
 * residual DurableAgentInbox edges. A scripted FakeAgent/FakeHost pair stands
 * in for a wire driver — no subprocess is spawned.
 */

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, {
  HarnessId,
  type Agent,
  type AgentHandle,
  type AgentOptions,
  type CreateAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, {
  canonicalHeader,
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  ExternalAgent,
  ExternalAgentHost,
  ExternalHarnessProcess,
  type ExternalModelSelection,
  type ExternalTurnDrive,
} from '../src/index.ts'
import { externalModelSelectionProjection } from '../src/model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** The picker's durable model selection; merged here so tests can append it directly. */
    'model/selection': {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }
  }
}

/** Scripted ExternalAgent: every harness verb is a recorded stub. */
class FakeAgent extends ExternalAgent {
  bound = false
  unbound = false
  readonly driven: UserMessage[][] = []
  readonly steered: UserMessage[] = []
  readonly injected: UserMessage[] = []
  interrupted = 0
  /** When set, the next empty claim runs {@link driveUnpromptedTurn}. */
  unprompted = false
  readonly adoptedTurns: number[] = []
  bindImpl: () => Promise<void> = () => Promise.resolve()
  unbindImpl: () => Promise<void> = () => Promise.resolve()
  driveImpl: (messages: readonly UserMessage[], drive: ExternalTurnDrive) => Promise<TurnEndReason> =
    () => Promise.resolve({ kind: 'completed' })
  steerImpl: (message: UserMessage, drive: ExternalTurnDrive) => Promise<boolean> =
    () => Promise.resolve(true)
  /** Injection script; `undefined` keeps the base class's refusing default. */
  injectImpl: ((message: UserMessage) => Promise<boolean>) | undefined
  interruptImpl: (drive: ExternalTurnDrive) => Promise<void> = () => Promise.resolve()

  /** Test read of the protected route fold. */
  effectiveSelection(): ExternalModelSelection {
    return this.currentSelection()
  }

  bind(): Promise<void> {
    this.bound = true
    return this.bindImpl()
  }

  unbind(): Promise<void> {
    this.unbound = true
    return this.unbindImpl()
  }

  protected driveTurn(messages: readonly UserMessage[], drive: ExternalTurnDrive): Promise<TurnEndReason> {
    this.driven.push([...messages])
    return this.driveImpl(messages, drive)
  }

  protected steerLive(message: UserMessage, drive: ExternalTurnDrive): Promise<boolean> {
    this.steered.push(message)
    return this.steerImpl(message, drive)
  }

  protected override injectHarness(message: UserMessage): Promise<boolean> {
    this.injected.push(message)
    return this.injectImpl === undefined ? super.injectHarness(message) : this.injectImpl(message)
  }

  protected interruptTurn(drive: ExternalTurnDrive): Promise<void> {
    this.interrupted += 1
    return this.interruptImpl(drive)
  }

  protected override hasUnpromptedHarnessWork(): boolean {
    return this.unprompted || super.hasUnpromptedHarnessWork()
  }

  protected override async driveUnpromptedTurn(drive: ExternalTurnDrive): Promise<TurnEndReason> {
    this.adoptedTurns.push(drive.turn)
    const ending = await super.driveUnpromptedTurn(drive)
    this.unprompted = false
    return ending
  }

  /** Queue one harness cycle and wake the driver without a user message. */
  beginUnprompted(): void {
    this.unprompted = true
    this.wakeIdleDriver()
  }
}

/** Host that hands out scripted agents and exposes the ownership teardown. */
class FakeHost extends ExternalAgentHost<FakeAgent> {
  readonly agents: FakeAgent[] = []
  onConstruct: ((agent: FakeAgent) => void) | undefined

  protected constructAgent(hostCtx: Context, id: SessionId, options: AgentOptions, session: Session): FakeAgent {
    const agent = new FakeAgent(hostCtx, id, options, session)
    this.agents.push(agent)
    this.onConstruct?.(agent)
    return agent
  }

  disposeOwnership(): Promise<void> {
    return this.ownership.dispose()
  }
}

/** The driver service: owns the host, which registers the factory and projections. */
class FakeHarness extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections']

  readonly host: FakeHost

  constructor(ctx: Context) {
    super(ctx, 'fakeHarness')
    this.host = new FakeHost(ctx, 'fake', {
      harness: { id: HarnessId('fake'), name: 'Fake harness' },
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Test-bench scripted external harness factory. */
    fakeHarness: FakeHarness
  }
}

/** In-memory SessionPersistence: a map of logs plus per-operation hooks and counters. */
class FakePersistence extends SessionPersistence {
  readonly stores = new Map<SessionId, SessionEvent[]>()
  readonly headers = new Map<SessionId, SessionHeader>()
  readonly opened: SessionHandle[] = []
  readonly closedHandles: SessionHandle[] = []
  createCalls = 0
  openCalls = 0
  appendCalls = 0
  openImpl: ((id: SessionId) => Promise<SessionHandle>) | undefined
  createGate: PromiseWithResolvers<undefined> | undefined
  appendGate: PromiseWithResolvers<undefined> | undefined
  closeImpl: (() => Promise<void>) | undefined

  create(header: SessionHeader): Promise<SessionHandle> {
    this.createCalls += 1
    const produce = (): SessionHandle => {
      this.headers.set(header.id, header)
      this.stores.set(header.id, [])
      const handle = this.handleFor(header.id)
      return handle
    }
    return this.createGate === undefined
      ? Promise.resolve(produce())
      : this.createGate.promise.then(produce)
  }

  open(id: SessionId): Promise<SessionHandle> {
    this.openCalls += 1
    if (this.openImpl !== undefined) return this.openImpl(id)
    if (!this.stores.has(id)) return Promise.reject(new Error(`no stored session "${id}"`))
    return Promise.resolve(this.handleFor(id))
  }

  flush(): Promise<void> {
    return Promise.resolve()
  }

  stat(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  list(): Promise<readonly []> {
    return Promise.resolve([])
  }

  /** Install a stored log for a session id before any open. */
  seed(id: SessionId, events: SessionEvent[]): void {
    this.headers.set(id, { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
    this.stores.set(id, [...events])
  }

  /** Open a fresh write handle onto a stored id (also the abandoned-open return path). */
  handleFor(id: SessionId): SessionHandle {
    const stored = this.stores.get(id)
    if (stored === undefined) throw new Error(`no stored session "${id}"`)
    const handle: SessionHandle = {
      id,
      header: this.headers.get(id)!,
      inheritedEventCount: SessionLogOffset(0),
      access: 'write',
      read: (offset = 0, length?: number) => Promise.resolve({
        eventState: 'detached' as const,
        events: length === undefined ? stored.slice(offset) : stored.slice(offset, offset + length),
      }),
      append: (events: readonly SessionEvent[]) => {
        this.appendCalls += 1
        const store = (): void => { stored.push(...events) }
        const gate = this.appendGate
        if (gate === undefined) {
          store()
          return Promise.resolve()
        }
        return gate.promise.then(store)
      },
      flush: () => Promise.resolve(),
      close: () => {
        this.closedHandles.push(handle)
        return (this.closeImpl ?? (() => Promise.resolve()))()
      },
      [Symbol.asyncDispose]() {
        return this.close()
      },
    }
    this.opened.push(handle)
    return handle
  }
}

interface Bench {
  readonly ctx: Context
  readonly host: FakeHost
  readonly persistence: FakePersistence | undefined
}

async function harness(options: { persistence?: boolean } = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  let persistence: FakePersistence | undefined
  if (options.persistence === true) {
    await ctx.plugin(FakePersistence)
    persistence = ctx.sessionPersistence as FakePersistence
  }
  await ctx.plugin(FakeHarness)
  return { ctx, host: ctx.fakeHarness.host, persistence }
}

let bench: Bench | undefined
afterEach(async () => {
  await bench?.ctx.fiber.dispose()
  bench = undefined
})

function msg(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function textOf(message: UserMessage): string {
  const block = message.content[0]
  return block?.type === 'text' ? block.text : ''
}

function send(agent: Agent, text: string): void {
  agent.followup(msg(text))
}

function types(agent: Agent): string[] {
  return agent.session.snapshotEvents().map(event => event.type)
}

function turnEndKinds(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event =>
    event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Let a fire-and-forget live-forward chain settle. */
async function flushForwards(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** One gated drive: resolves `started` when the drive is live, waits for `release`. */
function gateDrive(agent: FakeAgent, onAbort: 'throw' | 'complete' = 'throw'): {
  readonly started: Promise<void>
  readonly release: () => void
} {
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  agent.driveImpl = async (_messages, drive) => {
    started.resolve(undefined)
    await release.promise
    if (onAbort === 'throw') drive.signal.throwIfAborted()
    return { kind: 'completed' }
  }
  return { started: started.promise, release: () => { release.resolve(undefined) } }
}

async function create(
  ctx: Context,
  sessionId = 's1',
  options: Partial<CreateAgentOptions> = {},
): Promise<{ handle: AgentHandle; agent: FakeAgent }> {
  const handle = await ctx.agents.create({ sessionId: SessionId(sessionId), ...options })
  return { handle, agent: handle.agent as FakeAgent }
}

describe('ExternalAgent turn drive', () => {
  it('claims queued input as one durable turn and drives it', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)

    send(agent, 'one')
    await agent.whenIdle()

    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['one']])
    expect(types(agent)).toEqual([
      'agent/harness',
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'step/start',
      'user/message',
      'step/end',
      'turn/end',
    ])
    expect(turnEndKinds(agent)).toEqual(['completed'])
  })

  it('advances the durable step when the driver starts another model response', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    agent.driveImpl = (_messages, drive) => {
      drive.projector.assistantText('first', { provider: 'p1', model: 'm1' })
      expect(drive.step).toBe(1)
      drive.nextStep()
      expect(drive.step).toBe(2)
      drive.projector.assistantText('second', { provider: 'p1', model: 'm1' })
      return Promise.resolve({ kind: 'completed' })
    }

    send(agent, 'one')
    await agent.whenIdle()

    const steps = agent.session.snapshotEvents().flatMap(event =>
      event.type === 'step/start' || event.type === 'step/end' || event.type === 'assistant/message'
        ? [`${event.type} ${(event.data as { step: number }).step}`]
        : [])
    expect(steps).toEqual([
      'step/start 1',
      'assistant/message 1',
      'step/end 1',
      'step/start 2',
      'assistant/message 2',
      'step/end 2',
    ])
  })

  it('commits an accepted live steer inside the open turn boundary', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const gate = gateDrive(agent)
    send(agent, 'one')
    await gate.started

    agent.steer(msg('steer me'))
    gate.release()
    await agent.whenIdle()

    expect(agent.steered.map(textOf)).toEqual(['steer me'])
    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['one']])
    const sequence = types(agent)
    expect(sequence.filter(type => type === 'turn/start')).toHaveLength(1)
    const stepEnd = sequence.indexOf('step/end')
    const userMessages = sequence.flatMap((type, index) => type === 'user/message' ? [index] : [])
    expect(userMessages).toHaveLength(2)
    expect(userMessages[1]).toBeLessThan(stepEnd)
  })

  it('keeps a refused steer pending for the next turn', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const gate = gateDrive(agent)
    agent.steerImpl = () => Promise.resolve(false)
    send(agent, 'one')
    await gate.started

    agent.steer(msg('steer me'))
    gate.release()
    await agent.whenIdle()

    expect(agent.steered.map(textOf)).toEqual(['steer me'])
    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['one'], ['steer me']])
    expect(turnEndKinds(agent)).toEqual(['completed', 'completed'])
  })

  it('sends idle-time steering as ordinary turn input without a wire forward', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)

    agent.steer(msg('idle steer'))
    await agent.whenIdle()

    expect(agent.steered).toHaveLength(0)
    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['idle steer']])
    expect(turnEndKinds(agent)).toEqual(['completed'])
  })

  it('commits accepted injected context ahead of the next turn without claiming it', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    agent.injectImpl = () => Promise.resolve(true)

    agent.inject(msg('context'))
    await flushForwards()
    send(agent, 'one')
    await agent.whenIdle()

    expect(agent.injected.map(textOf)).toEqual(['context'])
    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['one']])
    const userMessages = agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' ? [event.data] : [])
    expect(userMessages.map(textOf)).toEqual(['context', 'one'])
  })

  it('drains a chained inject inside the same turn boundary', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const claimed: { text: string; turn: number }[] = []
    bench.ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
      if (subject === agent) claimed.push({ text: textOf(message), turn })
    })
    let chained = false
    // 'second' links onto the liveForward tail before the turn's drain await
    // evaluates it, so the drain covers both forwards: 'second' is consumed
    // at the live turn like 'first', and no second turn opens.
    agent.injectImpl = (message) => {
      if (!chained && textOf(message) === 'first') {
        chained = true
        agent.inject(msg('second'))
      }
      return Promise.resolve(true)
    }
    let seeded = false
    agent.driveImpl = () => {
      if (!seeded) {
        seeded = true
        agent.inject(msg('first'))
      }
      return Promise.resolve({ kind: 'completed' })
    }

    send(agent, 'a')
    await agent.whenIdle()

    expect(agent.injected.map(textOf)).toEqual(['first', 'second'])
    expect(claimed).toEqual([
      { text: 'a', turn: 1 },
      { text: 'first', turn: 1 },
      { text: 'second', turn: 1 },
    ])
    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['a']])
    const sequence = types(agent)
    expect(sequence.lastIndexOf('user/message'))
      .toBeLessThan(sequence.indexOf('step/end'))
    expect(turnEndKinds(agent)).toEqual(['completed'])
  })

  it('leaves refused injected context pending for the next claim', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)

    agent.inject(msg('context'))
    await flushForwards()
    send(agent, 'one')
    await agent.whenIdle()

    expect(agent.injected.map(textOf)).toEqual(['context'])
    // The refused message stayed in next-step and was claimed with the turn.
    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['context', 'one']])
  })

  it('drops a live forward whose durable row was already removed', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    agent.injectImpl = (message) => {
      agent.inbox.remove(message.id)
      return Promise.resolve(true)
    }

    agent.inject(msg('gone'))
    await flushForwards()
    send(agent, 'one')
    await agent.whenIdle()

    expect(agent.injected.map(textOf)).toEqual(['gone'])
    // The accepted forward found no pending row: no stray user/message.
    const userMessages = agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' ? [event.data] : [])
    expect(userMessages.map(textOf)).toEqual(['one'])
  })

  it('contains a harness interrupt failure inside the aborted turn', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const gate = gateDrive(agent)
    agent.interruptImpl = () => Promise.reject(new Error('interrupt blew up'))
    send(agent, 'one')
    await gate.started

    agent.cancel({ kind: 'user' })
    gate.release()
    await agent.whenIdle()

    expect(agent.interrupted).toBe(1)
    expect(turnEndKinds(agent)).toEqual(['aborted'])
  })

  it('surfaces a live-forward failure on the agent error channel', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const errors: unknown[] = []
    bench.ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) errors.push(error)
    })
    const gate = gateDrive(agent)
    agent.steerImpl = () => Promise.reject(new Error('steer blew up'))
    send(agent, 'one')
    await gate.started

    agent.steer(msg('lost steer'))
    gate.release()
    await agent.whenIdle()

    expect(errors).toHaveLength(1)
    // The failed forward left the row pending; the next turn claimed it.
    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['one'], ['lost steer']])
  })

  it('runs maintenance exclusively and replays a latched wake', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const jobGate = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(async () => {
      await jobGate.promise
      return 'done'
    })

    expect(agent.status).toBe('idle')
    send(agent, 'queued')
    expect(() => agent.runMaintenance(() => Promise.resolve('x'))).toThrow('already has active work')
    jobGate.resolve(undefined)
    await expect(maintenance).resolves.toBe('done')
    await agent.whenIdle()

    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['queued']])
    expect(turnEndKinds(agent)).toEqual(['completed'])
  })

  it('clears pending input on cancel', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const gate = gateDrive(agent)
    send(agent, 'one')
    await gate.started

    send(agent, 'two')
    agent.cancel({ kind: 'user' })
    gate.release()
    await agent.whenIdle()

    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['one']])
    expect(turnEndKinds(agent)).toEqual(['aborted'])
  })

  it('preserves pending input across cancel with keepInbox', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const gate = gateDrive(agent)
    send(agent, 'one')
    await gate.started

    send(agent, 'two')
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    gate.release()
    await agent.whenIdle()

    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['one'], ['two']])
    expect(turnEndKinds(agent)).toEqual(['aborted', 'completed'])
  })

  it('retargets a wake sent after the turn aborted onto the next turn', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const gate = gateDrive(agent)
    send(agent, 'one')
    await gate.started

    agent.cancel({ kind: 'user' })
    send(agent, 'two')
    gate.release()
    await agent.whenIdle()

    expect(agent.driven.map(batch => batch.map(textOf))).toEqual([['one'], ['two']])
    expect(turnEndKinds(agent)).toEqual(['aborted', 'completed'])
  })

  it('reports a drive failure at the turn boundary and keeps driving', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const errors: unknown[] = []
    bench.ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) errors.push(error)
    })
    agent.driveImpl = () => Promise.reject(new Error('drive exploded'))

    send(agent, 'one')
    await agent.whenIdle()

    expect(turnEndKinds(agent)).toEqual(['error'])
    expect(errors).toHaveLength(1)

    agent.driveImpl = () => Promise.resolve({ kind: 'completed' })
    send(agent, 'two')
    await agent.whenIdle()
    expect(turnEndKinds(agent)).toEqual(['error', 'completed'])
  })

  it('still owns a completed boundary when its input cleared mid-wake', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    let cleared = false
    // `agent/inbox/inserted` emits after the splice append completes, before
    // the wake claims the queue — a legal non-reentrant clear window.
    bench.ctx.on('agent/inbox/inserted', ({ agent: subject }) => {
      if (subject === agent && !cleared) {
        cleared = true
        agent.inbox.clear()
      }
    })

    send(agent, 'one')
    await agent.whenIdle()

    expect(agent.driven).toHaveLength(0)
    expect(types(agent)).not.toContain('step/start')
    expect(turnEndKinds(agent)).toEqual(['completed'])
  })

  it('opens a turn with no user message when the harness has output waiting', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)

    agent.beginUnprompted()
    await agent.whenIdle()

    expect(agent.driven).toHaveLength(0)
    expect(agent.adoptedTurns).toEqual([1])
    expect(types(agent).filter(type => type === 'user/message')).toHaveLength(0)
    expect(types(agent)).toContain('step/start')
    expect(turnEndKinds(agent)).toEqual(['completed'])
  })

  it('replays harness output that arrived during maintenance', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const jobGate = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(async () => {
      await jobGate.promise
      return 'done'
    })

    agent.beginUnprompted()
    jobGate.resolve(undefined)
    await expect(maintenance).resolves.toBe('done')
    await agent.whenIdle()

    expect(agent.adoptedTurns).toEqual([1])
    expect(agent.driven).toHaveLength(0)
  })

  it('does not latch a harness wake onto a disposed activity', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    agent.driveImpl = (_messages, drive) => new Promise((_resolve, reject) => {
      drive.signal.addEventListener('abort', () => {
        agent.beginUnprompted()
        reject(drive.signal.reason)
      }, { once: true })
    })

    send(agent, 'one')
    await vi.waitFor(() => { expect(agent.driven).toHaveLength(1) })
    agent.cancel({ kind: 'disposed' })
    await agent.whenIdle()

    expect(agent.adoptedTurns).toEqual([])
    expect(agent.status).toBe('idle')
  })

  it('replays harness output that arrives as the driver goes idle', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    let armed = true
    const original = agent.session.append.bind(agent.session)
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, ...rest: unknown[]) => {
      const result = (original as (type: string, ...args: unknown[]) => unknown)(type, ...rest)
      if (type === 'turn/end' && armed) {
        armed = false
        queueMicrotask(() => { agent.beginUnprompted() })
      }
      return result
    }) as never)

    send(agent, 'one')
    await agent.whenIdle()

    expect(agent.driven).toHaveLength(1)
    expect(agent.adoptedTurns).toEqual([2])
    expect(turnEndKinds(agent)).toEqual(['completed', 'completed'])
  })

  it('runs a harness cycle before a quiet inject that was already queued', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const notice = msg('job done')

    agent.inject(notice)
    agent.beginUnprompted()
    await agent.whenIdle()

    expect(agent.adoptedTurns).toEqual([1])
    expect(agent.driven).toHaveLength(1)
    expect(agent.driven[0]?.map(textOf)).toEqual(['job done'])
    expect(turnEndKinds(agent)).toEqual(['completed', 'completed'])
    const userTurns = agent.session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .map(event => event.data)
    expect(userTurns).toHaveLength(1)
  })

  it('does not replay a maintenance wake whose inbox was cleared', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const jobGate = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(async () => {
      await jobGate.promise
      return 'done'
    })

    send(agent, 'queued')
    agent.inbox.clear()
    jobGate.resolve(undefined)
    await expect(maintenance).resolves.toBe('done')
    await agent.whenIdle()

    expect(agent.driven).toHaveLength(0)
    expect(agent.adoptedTurns).toHaveLength(0)
  })

  it('surfaces a turn/end append failure through the agent error channel', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const errors: unknown[] = []
    bench.ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) errors.push(error)
    })
    const original = agent.session.append.bind(agent.session)
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, ...rest: unknown[]) => {
      if (type === 'turn/end') throw new Error('disk full')
      return (original as (...args: unknown[]) => unknown)(type, ...rest)
    }) as never)

    send(agent, 'one')
    await agent.whenIdle()

    expect(errors).toHaveLength(1)
  })

  it('surfaces a turn/start append failure without opening a boundary', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    const errors: unknown[] = []
    bench.ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) errors.push(error)
    })
    const original = agent.session.append.bind(agent.session)
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, ...rest: unknown[]) => {
      if (type === 'turn/start') throw new Error('disk full')
      return (original as (...args: unknown[]) => unknown)(type, ...rest)
    }) as never)

    send(agent, 'one')
    await agent.whenIdle()

    expect(errors).toHaveLength(1)
    expect(types(agent)).not.toContain('turn/end')
  })

  it('resolves an empty route when neither options nor a selection declare one', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx, 'undeclared')

    expect(agent.effectiveSelection()).toEqual({ provider: '', model: '' })
  })

  it('resolves the effective route from durable selection over declared options', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx, 's1', {
      agentOptions: { provider: 'base', model: 'm0', reasoningEffort: brandString<ReasoningEffortId>('low') },
    })

    expect(agent.effectiveSelection()).toEqual({ provider: 'base', model: 'm0', reasoningEffort: 'low' })
    agent.session.append('model/selection', { provider: 'picked', model: 'm1' })
    expect(agent.effectiveSelection()).toEqual({ provider: 'picked', model: 'm1', reasoningEffort: 'low' })
    agent.session.append('model/selection', { provider: 'picked', model: 'm2', reasoningEffort: 'high' })
    expect(agent.effectiveSelection()).toEqual({ provider: 'picked', model: 'm2', reasoningEffort: 'high' })
  })
})

describe('ExternalTurnProjector', () => {
  it('projects stream attempts, tool pairs, and the initial route', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    agent.driveImpl = (_messages, drive) => {
      const projector = drive.projector
      const attempt = projector.beginAssistant()
      attempt.push({ type: 'block-start', index: 0, blockType: 'text' })
      attempt.push({ type: 'text-delta', index: 0, text: 'hi' })
      attempt.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } })
      attempt.push({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'r1' } } })
      projector.commitAssistant(attempt, { provider: 'p1', model: 'm1' })
      projector.assistantText('cut off', { provider: 'p1', model: 'm1' }, {
        interrupted: true,
        usage: { inputTokens: 3, outputTokens: 4 },
      })
      projector.commitAttempt(projector.beginAssistant())
      projector.toolCall('c1', 'run', '{}')
      projector.toolResult('c1', [{ type: 'text', text: 'ok' }], {
        isError: true,
        error: { name: 'ToolError', code: 'BROKE' },
        meta: { title: 'card' },
      })
      projector.toolResult('c2', [{ type: 'text', text: 'ok' }], { error: { name: 'X', code: 'Y' } })
      projector.noteRoute({ provider: 'p1', model: 'm1' })
      return Promise.resolve({ kind: 'completed' })
    }

    send(agent, 'go')
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const sequence = events.map(event => event.type)
    expect(sequence.filter(type => type === 'assistant/message')).toHaveLength(2)
    expect(sequence).toContain('assistant/attempt')
    expect(sequence).toContain('tool/call')
    expect(sequence.filter(type => type === 'tool/result')).toHaveLength(2)
    const streamed = events.find(event => event.type === 'assistant/message')
    expect(streamed?.type === 'assistant/message' && streamed.data.message.source).toMatchObject({
      provider: 'p1',
      model: 'm1',
      replayState: { response: { id: 'r1' } },
    })
    const interrupted = events.filter(event => event.type === 'assistant/message').at(-1)
    expect(interrupted?.type === 'assistant/message' && interrupted.data.interrupted).toBe(true)
    expect(interrupted?.type === 'assistant/message' && interrupted.data.usage)
      .toEqual({ inputTokens: 3, outputTokens: 4 })
    const errorResult = events.find(event => event.type === 'tool/result')
    expect(errorResult?.type === 'tool/result' && errorResult.data.error)
      .toEqual({ name: 'ToolError', code: 'BROKE' })
    const plainResult = events.filter(event => event.type === 'tool/result').at(-1)
    // `error` is recorded only on a result marked isError.
    expect(plainResult?.type === 'tool/result' && 'error' in plainResult.data).toBe(false)
    const header = events.find(event => event.type === 'request/header')
    expect(header?.type === 'request/header' && header.data.reason).toBe('initial')
  })

  it('skips an unchanged route and marks a changed one', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    let route = { provider: 'p1', model: 'm1' }
    agent.driveImpl = (_messages, drive) => {
      drive.projector.noteRoute(route)
      return Promise.resolve({ kind: 'completed' })
    }

    send(agent, 'a')
    await agent.whenIdle()
    send(agent, 'b')
    await agent.whenIdle()
    route = { provider: 'p1', model: 'm2' }
    send(agent, 'c')
    await agent.whenIdle()

    const headers = agent.session.snapshotEvents().flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])
    expect(headers).toEqual(['initial', 'change'])
  })
})

describe('externalModelSelection fold', () => {
  function ev(type: 'model/selection' | 'turn/start', seq: number, data: unknown): SessionEvent {
    return { type, seq: SessionSeq(seq), time: 1, data } as SessionEvent
  }

  it('keeps only the newest durable selection and dedupes repeats', () => {
    let state = externalModelSelectionProjection.init()
    expect(state.selection).toBeNull()

    state = externalModelSelectionProjection.apply(
      state,
      ev('model/selection', 0, { provider: 'p1', model: 'm1' }),
    )
    expect(state.selection).toEqual({ provider: 'p1', model: 'm1' })

    const same = externalModelSelectionProjection.apply(
      state,
      ev('model/selection', 1, { provider: 'p1', model: 'm1' }),
    )
    expect(same).toBe(state)

    state = externalModelSelectionProjection.apply(
      state,
      ev('model/selection', 2, { provider: 'p2', model: 'm2', reasoningEffort: 'high' }),
    )
    expect(state.selection).toEqual({ provider: 'p2', model: 'm2', reasoningEffort: 'high' })

    expect(externalModelSelectionProjection.apply(state, ev('turn/start', 3, { turn: 1 }))).toBe(state)
  })

  it('rejects an invalid persisted selection', () => {
    const state = externalModelSelectionProjection.init()
    expect(() => externalModelSelectionProjection.apply(
      state,
      ev('model/selection', 4, { provider: '', model: 'm' }),
    )).toThrow('invalid persisted model/selection at session seq 4')
    expect(() => externalModelSelectionProjection.apply(
      state,
      ev('model/selection', 4, 'junk'),
    )).toThrow('invalid persisted model/selection')
    expect(() => externalModelSelectionProjection.apply(
      state,
      ev('model/selection', 4, { provider: 'p' }),
    )).toThrow('invalid persisted model/selection')
    expect(() => externalModelSelectionProjection.apply(
      state,
      ev('model/selection', 4, { provider: 'p', model: 'm', reasoningEffort: '' }),
    )).not.toThrow()
  })
})

describe('ExternalAgentHost transaction', () => {
  it('binds and publishes a new agent, then unbinds on dispose', async () => {
    bench = await harness()
    const { handle, agent } = await create(bench.ctx)

    expect(agent.bound).toBe(true)
    await handle.dispose()
    expect(agent.unbound).toBe(true)
  })

  it('rolls the transaction back when setup rejects', async () => {
    bench = await harness()
    await expect(bench.ctx.agents.create({
      sessionId: SessionId('s1'),
      setup: () => { throw new Error('setup blew up') },
    })).rejects.toThrow('setup blew up')

    expect(bench.host.agents[0]?.unbound).toBe(true)
  })

  it('rolls the transaction back when the setup commit refuses publication', async () => {
    bench = await harness()
    await expect(bench.ctx.agents.create({
      sessionId: SessionId('s1'),
      setup: () => ({ commit: () => { throw new Error('commit refused') } }),
    })).rejects.toThrow('commit refused')
  })

  it('rolls the transaction back when the harness bind rejects', async () => {
    bench = await harness()
    bench.host.onConstruct = (agent) => {
      agent.bindImpl = () => Promise.reject(new Error('bind refused'))
    }

    await expect(bench.ctx.agents.create({ sessionId: SessionId('s1') })).rejects.toThrow('bind refused')
    expect(bench.host.agents[0]?.unbound).toBe(true)
  })

  it('rejects create when the caller signal aborts during session setup', async () => {
    bench = await harness({ persistence: true })
    const persistence = bench.persistence!
    persistence.createGate = Promise.withResolvers<undefined>()
    const controller = new AbortController()

    const promise = bench.ctx.agents.create({ sessionId: SessionId('s1'), signal: controller.signal })
    await waitFor(() => persistence.createCalls === 1, 'persistence create')
    // The create resolves first in the settlement race; the abort lands
    // before the factory's own pre-publication check runs.
    persistence.createGate.resolve(undefined)
    controller.abort(new Error('caller bailed'))
    await expect(promise).rejects.toThrow('caller bailed')
  })

  it('rejects a non-positive maxTokens before any session work', async () => {
    bench = await harness()
    await expect(bench.ctx.agents.create({
      sessionId: SessionId('s1'),
      agentOptions: { maxTokens: 0 },
    })).rejects.toThrow('positive safe integer')
    await expect(bench.ctx.agents.create({
      sessionId: SessionId('s2'),
      agentOptions: { maxTokens: 1.5 },
    })).rejects.toThrow('positive safe integer')
  })

  it('rolls back publication when factory teardown lands mid-announce', async () => {
    bench = await harness()
    const promise = bench.ctx.agents.create({
      sessionId: SessionId('s1'),
      setup: (agentCtx) => {
        agentCtx.on('agent/created', () => {
          void bench!.host.disposeOwnership()
          return undefined
        })
      },
    })

    await expect(promise).rejects.toThrow('not active')
    expect(bench.host.agents[0]?.unbound).toBe(true)
  })

  it('tears the agent down when its owner fiber unloads', async () => {
    bench = await harness()
    const owner = await bench.ctx.plugin(() => {})
    const handle = await bench.host.createAgent(owner.ctx, { sessionId: SessionId('s1') })
    const agent = handle.agent as FakeAgent

    await owner.dispose()
    expect(agent.unbound).toBe(true)
  })

  it('rethrows a single teardown failure', async () => {
    bench = await harness()
    const { handle, agent } = await create(bench.ctx)
    agent.unbindImpl = () => Promise.reject(new Error('unbind broke'))

    await expect(handle.dispose()).rejects.toThrow('unbind broke')
  })

  it('collects machine and handle failures into one disposal error', async () => {
    bench = await harness({ persistence: true })
    const { handle, agent } = await create(bench.ctx)
    agent.unbindImpl = () => Promise.reject(new Error('unbind broke'))
    bench.persistence!.closeImpl = () => Promise.reject(new Error('close broke'))

    const failure = await handle.dispose().then(
      () => { throw new Error('expected dispose to reject') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
  })

  it('stores the unpublished suffix when persistence is mounted', async () => {
    bench = await harness({ persistence: true })
    const persistence = bench.persistence!
    await create(bench.ctx, 's1', {
      seed: [{ type: 'model/selection', seq: SessionSeq(0), time: 1, data: { provider: 'p0', model: 'm0' } }],
      meta: { isSeeded: true },
      inheritedEventCount: SessionLogOffset(1),
    })

    const stored = persistence.stores.get(SessionId('s1'))
    expect(stored?.some(event => event.type === 'session/end-seed')).toBe(true)
  })

  it('rejects resume without a persistence backend', async () => {
    bench = await harness()
    await expect(bench.ctx.agents.resume({ resumeSessionId: SessionId('gone') }))
      .rejects.toThrow('persistence is not configured')
  })

  it('resumes a persisted session and repairs an interrupted tail', async () => {
    bench = await harness({ persistence: true })
    const persistence = bench.persistence!
    persistence.seed(SessionId('old'), [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 1, data: { turn: 1, step: 1 } },
      {
        type: 'user/message',
        seq: SessionSeq(2),
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
    ])

    const handle = await bench.ctx.agents.resume({ resumeSessionId: SessionId('old') })
    const agent = handle.agent as FakeAgent

    expect(agent.bound).toBe(true)
    const stored = persistence.stores.get(SessionId('old'))!
    // The crash tail receives step/turn closers; the restore marker and the
    // harness record the resume wrote follow.
    expect(stored.map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'step/end',
      'turn/end',
      'session/end-seed',
      'agent/harness',
    ])
    const closer = stored.at(-3)
    expect(closer?.type === 'turn/end' && closer.data.reason).toEqual({ kind: 'interrupted' })

    send(agent, 'again')
    await agent.whenIdle()
    const starts = agent.session.snapshotEvents().flatMap(event =>
      event.type === 'turn/start' ? [event.data.turn] : [])
    expect(starts.at(-1)).toBe(2)
  })

  it('marks the first logged route after a persisted resume as resume', async () => {
    bench = await harness({ persistence: true })
    const persistence = bench.persistence!
    persistence.seed(SessionId('old'), [{
      type: 'request/header',
      seq: SessionSeq(0),
      time: 1,
      data: { header: canonicalHeader({ config: { provider: 'p0', model: 'm0' } }), reason: 'initial' },
    }])
    const handle = await bench.ctx.agents.resume({ resumeSessionId: SessionId('old') })
    const agent = handle.agent as FakeAgent
    agent.driveImpl = (_messages, drive) => {
      drive.projector.noteRoute({ provider: 'p1', model: 'm1' })
      return Promise.resolve({ kind: 'completed' })
    }

    send(agent, 'go')
    await agent.whenIdle()

    const reasons = agent.session.snapshotEvents().flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])
    expect(reasons.at(-1)).toBe('resume')
  })

  it('rejects resume when the persisted session does not exist', async () => {
    bench = await harness({ persistence: true })
    await expect(bench.ctx.agents.resume({ resumeSessionId: SessionId('gone') }))
      .rejects.toThrow('no stored session')
  })

  it('refuses to resume a session another harness recorded', async () => {
    bench = await harness({ persistence: true })
    const persistence = bench.persistence!
    persistence.seed(SessionId('old'), [{
      type: 'agent/harness',
      seq: SessionSeq(0),
      time: 1,
      data: { harness: 'other' },
    }])

    // Ownership precedes publication: the refusal names both harnesses and
    // publishes neither an agent nor a session.
    await expect(bench.ctx.agents.resume({ resumeSessionId: SessionId('old') }))
      .rejects.toThrow('session "old" belongs to agent harness "other", not "fake"')
    expect(bench.ctx.agents.get(SessionId('old'))).toBeUndefined()
    expect(bench.ctx.sessions.get(SessionId('old'))).toBeUndefined()
    // The refused resume released the write claim it opened to read the log.
    expect(persistence.closedHandles.map(handle => handle.id)).toEqual([SessionId('old')])
  })

  it('closes a handle that finishes opening after resume was cancelled', async () => {
    bench = await harness({ persistence: true })
    const persistence = bench.persistence!
    persistence.seed(SessionId('old'), [])
    const gate = Promise.withResolvers<undefined>()
    persistence.openImpl = id => gate.promise.then(() => persistence.handleFor(id))
    const controller = new AbortController()

    const promise = bench.ctx.agents.resume({ resumeSessionId: SessionId('old'), signal: controller.signal })
    await waitFor(() => persistence.openCalls === 1, 'open called')
    // Cancel while the open is still in flight; the handle that arrives
    // afterward must be closed by the race's release hook.
    controller.abort(new Error('caller gave up'))
    await expect(promise).rejects.toThrow('caller gave up')
    gate.resolve(undefined)
    await waitFor(() => persistence.closedHandles.length === 1, 'abandoned handle close')
  })

  it('rejects resume when the factory deactivates mid-load', async () => {
    bench = await harness({ persistence: true })
    const persistence = bench.persistence!
    persistence.seed(SessionId('old'), [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ])
    persistence.appendGate = Promise.withResolvers<undefined>()

    const promise = bench.ctx.agents.resume({ resumeSessionId: SessionId('old') })
    await waitFor(() => persistence.appendCalls === 1, 'closer append')
    void bench.host.disposeOwnership()
    persistence.appendGate.resolve(undefined)

    await expect(promise).rejects.toThrow('not active')
  })

  it('rejects resume when the owner fiber dies mid-load', async () => {
    bench = await harness({ persistence: true })
    const persistence = bench.persistence!
    persistence.seed(SessionId('old'), [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ])
    persistence.appendGate = Promise.withResolvers<undefined>()
    const owner = await bench.ctx.plugin(() => {})

    const promise = bench.host.resume(owner.ctx, { resumeSessionId: SessionId('old') })
    await waitFor(() => persistence.appendCalls === 1, 'closer append')
    await owner.dispose()
    persistence.appendGate.resolve(undefined)

    await expect(promise).rejects.toThrow()
  })
})

describe('ExternalHarnessProcess', () => {
  /** The seam's handle double; only the members the ladder touches are real. */
  function fakeHandle(options: {
    waitForExit?: (signal?: AbortSignal) => Promise<boolean>
    terminate?: () => void
    noPipes?: boolean
    stderrText?: string
    collectedStderr?: boolean
  } = {}): SubprocessHandle {
    const reader: SubprocessOutputReader = {
      readFrom: () => ({ text: options.stderrText ?? '', nextOffset: 0, lossy: false }),
    }
    return {
      stdin: options.noPipes === true ? undefined : new PassThrough(),
      stdout: options.noPipes === true ? undefined : new PassThrough(),
      stderr: new PassThrough(),
      control: undefined,
      collected: options.collectedStderr === false ? {} : { stderr: reader },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: options.terminate ?? (() => {}),
      waitForExit: options.waitForExit ?? (() => Promise.resolve(true)),
    }
  }

  /** Minimal SubprocessRuntime stub: the ladder calls only resolveExecutable and spawn. */
  class StubRuntime {
    readonly spawned: SubprocessSpawnSpec[] = []
    resolveImpl: (command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) => Promise<string> =
      command => Promise.resolve(`/resolved/${command}`)
    handleFactory: () => SubprocessHandle = () => fakeHandle()

    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
      return this.resolveImpl(command, env, signal)
    }

    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      this.spawned.push(spec)
      return this.handleFactory()
    }

    spawnTerminal(): Promise<never> {
      return Promise.reject(new Error('unsupported'))
    }
  }

  function spawn(runtime: StubRuntime, request: Partial<Parameters<typeof ExternalHarnessProcess.spawn>[1]> = {}) {
    // The stub deliberately omits the Service surface the seam never calls.
    return ExternalHarnessProcess.spawn(runtime as unknown as SubprocessRuntime, {
      command: 'harness-cli',
      args: ['--serve'],
      cwd: '/tmp/work',
      graceMs: 1000,
      ...request,
    })
  }

  it('resolves the executable, filters env tombstones, and spawns piped stdio', async () => {
    const runtime = new StubRuntime()
    let resolvedEnv: Readonly<Record<string, string>> | undefined
    runtime.resolveImpl = (command, env) => {
      resolvedEnv = env
      return Promise.resolve(`/resolved/${command}`)
    }
    const proc = await spawn(runtime, { env: { KEEP: 'v', DROP: undefined }, stderrMaxBytes: 128 })

    expect(runtime.spawned[0]?.argv).toEqual(['/resolved/harness-cli', '--serve'])
    expect(resolvedEnv).toEqual({ KEEP: 'v' })
    expect(runtime.spawned[0]?.env).toEqual({ KEEP: 'v', DROP: undefined })
    expect(runtime.spawned[0]?.stdio.stderr).toEqual({ maxBytes: 128 })
    expect(proc.stdin).toBeTruthy()
    expect(proc.stdout).toBeTruthy()
    await expect(proc.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('rejects when executable resolution fails', async () => {
    const runtime = new StubRuntime()
    runtime.resolveImpl = () => Promise.reject(new Error('not found'))

    await expect(spawn(runtime)).rejects.toThrow('not found')
    expect(runtime.spawned).toHaveLength(0)
  })

  it('rejects when the request signal aborts between resolve and spawn', async () => {
    const runtime = new StubRuntime()
    const controller = new AbortController()
    runtime.resolveImpl = () => {
      controller.abort(new Error('caller stopped'))
      return Promise.resolve('/resolved/late')
    }

    await expect(spawn(runtime, { signal: controller.signal })).rejects.toThrow('caller stopped')
    expect(runtime.spawned).toHaveLength(0)
  })

  it('rejects and terminates a handle that comes back without piped stdio', async () => {
    const runtime = new StubRuntime()
    let terminated = 0
    let exitWaits = 0
    runtime.handleFactory = () => fakeHandle({
      noPipes: true,
      terminate: () => { terminated += 1 },
      waitForExit: () => { exitWaits += 1; return Promise.resolve(true) },
    })

    await expect(spawn(runtime)).rejects.toThrow('no piped stdio')
    expect(terminated).toBe(1)
    expect(exitWaits).toBe(1)
  })

  it('reports the missing-pipe failure even when the failing child cannot be awaited', async () => {
    const runtime = new StubRuntime()
    runtime.handleFactory = () => fakeHandle({
      noPipes: true,
      waitForExit: () => Promise.reject(new Error('child already reaped')),
    })

    await expect(spawn(runtime)).rejects.toThrow('no piped stdio')
  })

  it('stderrTail is empty when the provider collected no stderr reader', async () => {
    const runtime = new StubRuntime()
    runtime.handleFactory = () => fakeHandle({ collectedStderr: false })
    const proc = await spawn(runtime)

    expect(proc.stderrTail()).toBe('')
  })

  it('dispose resolves on in-grace exit without terminating', async () => {
    const runtime = new StubRuntime()
    let terminated = 0
    const handle = fakeHandle({ terminate: () => { terminated += 1 } })
    runtime.handleFactory = () => handle
    const proc = await spawn(runtime)

    await proc.dispose(50)

    expect(handle.stdin?.writableEnded).toBe(true)
    expect(terminated).toBe(0)
  })

  it('dispose escalates to terminate when the EOF grace elapses', async () => {
    const runtime = new StubRuntime()
    let terminated = 0
    runtime.handleFactory = () => fakeHandle({
      terminate: () => { terminated += 1 },
      waitForExit: (signal?: AbortSignal) => signal === undefined
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
          signal.addEventListener('abort', () => { resolve(false) }, { once: true })
        }),
    })
    const proc = await spawn(runtime)

    await proc.dispose(20)

    expect(terminated).toBe(1)
  })

  it('dispose rethrows a single wait failure', async () => {
    const runtime = new StubRuntime()
    runtime.handleFactory = () => fakeHandle({
      waitForExit: (signal?: AbortSignal) => signal === undefined
        ? Promise.resolve(true)
        : Promise.reject(new Error('range watch failed')),
    })
    const proc = await spawn(runtime)

    await expect(proc.dispose(20)).rejects.toThrow('range watch failed')
  })

  it('dispose collects range-wait and terminate-wait failures', async () => {
    const runtime = new StubRuntime()
    runtime.handleFactory = () => fakeHandle({
      waitForExit: (signal?: AbortSignal) => signal === undefined
        ? Promise.reject(new Error('exit wait failed'))
        : Promise.reject(new Error('range watch failed')),
    })
    const proc = await spawn(runtime)

    const failure = await proc.dispose(20).then(
      () => { throw new Error('expected dispose to reject') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
  })

  it('stderrTail returns the collected tail', async () => {
    const runtime = new StubRuntime()
    runtime.handleFactory = () => fakeHandle({ stderrText: 'boom-tail' })
    const proc = await spawn(runtime)

    expect(proc.stderrTail()).toBe('boom-tail')
  })
})

describe('DurableAgentInbox edges', () => {
  it('consume returns false for a message that is not pending', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)

    expect(agent.inbox.consume(brandString<MessageId>('missing'), 1)).toBe(false)
    expect(agent.inbox.remove(brandString<MessageId>('missing'))).toBe(false)
    expect(agent.inbox.replace(brandString<MessageId>('missing'), msg('x'))).toBe(false)
  })
})

describe('shared driver defaults', () => {
  it('refuses injected context when the driver declares no injection channel', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)

    agent.inject(msg('context'))
    await flushForwards()

    expect(agent.injected.map(textOf)).toEqual(['context'])
    expect(types(agent)).not.toContain('user/message')
    expect(agent.inbox.nextStep.map(textOf)).toEqual(['context'])
  })

  it('commits context the harness accepts between turns and reports a rejected forward', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)

    agent.injectImpl = () => Promise.resolve(true)
    agent.inject(msg('accepted'))
    await flushForwards()
    // The accepted row leaves the queue and becomes a durable user message.
    expect(types(agent)).toEqual(['agent/harness', 'agent/inbox/spliced', 'agent/inbox/spliced', 'user/message'])
    expect(agent.inbox.nextStep).toEqual([])

    const failure = new Error('inject transport failed')
    const errors: unknown[] = []
    bench.ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) errors.push(error)
    })
    agent.injectImpl = () => Promise.reject(failure)
    agent.inject(msg('rejected'))
    await flushForwards()
    expect(errors).toEqual([failure])
    expect(agent.inbox.nextStep.map(textOf)).toEqual(['rejected'])
  })

  it('refuses creation once the factory ownership is torn down', async () => {
    bench = await harness()
    await bench.host.disposeOwnership()

    await expect(bench.ctx.agents.create({ sessionId: SessionId('after-teardown') }))
      .rejects.toThrow('fake is not active')
    expect(bench.ctx.agents.list()).toEqual([])
  })
})

describe('ExternalTurnProjector route and empty attempts', () => {
  it('records an empty text attempt and a route carrying reasoning effort', async () => {
    bench = await harness()
    const { agent } = await create(bench.ctx)
    agent.driveImpl = (_messages, drive) => {
      drive.projector.assistantText('', { provider: 'p1', model: 'm1' })
      drive.projector.noteRoute({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
      return Promise.resolve({ kind: 'completed' })
    }

    send(agent, 'go')
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    const header = events.find(event => event.type === 'request/header')
    expect(header === undefined ? undefined : JSON.stringify(header.data)).toContain('high')
  })
})
