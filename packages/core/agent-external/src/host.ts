/**
 * AgentFactory host shared by foreign-harness drivers: owns the create/resume
 * transaction — unpublished session preparation, durable write ownership,
 * caller setup, driver binding, ordered publication, and reverse teardown —
 * while the driver subclass supplies construction and harness binding through
 * {@link ExternalAgent}.
 *
 * @module @deepseek-ai/dsh-agent-external/host
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  type Agent,
  type AgentHarness,
  type AgentFactory,
  type AgentHandle,
  type AgentOptions,
  type AgentSetup,
  type CreateAgentOptions,
  type ResumeAgentOptions,
  type SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import {
  interruptedTurnClosers,
  SessionLogOffset,
  SessionPreparation,
  type Session,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ManagedAgent } from './base.ts'
import { agentHarnessOf, recordedHarness } from '@deepseek-ai/dsh-agent'
import { assertAgentOptions, FactoryOwnership, raceAbort, raceAbortCall } from './lifecycle.ts'
import { inboxProjectionDefinition } from './inbox.ts'
import { externalModelSelectionProjection } from './model-selection.ts'
import { turnBoundaryProjectionDefinition } from './turn-boundary.ts'

/** One session's owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

/** Prepared-but-unpublished agent resources sharing one memoized teardown. */
interface PreparedAgent<TAgent extends ManagedAgent> {
  agent: TAgent
  /** Aborts when the factory unloads, the caller cancels, or teardown begins — ends any setup await. */
  signal: AbortSignal
  /**
   * Enter both registries and await both creation edges.
   * @param source - the creation source `agent/created` reports.
   * @param deferred - hold the session's `session/event` dispatch until {@link publish}.
   */
  announce(source: SessionStartSource, deferred: boolean): Promise<void>
  /** Dispatch a deferred entry's held appends in log order and return the live handle. */
  publish(deferred: boolean): Promise<AgentHandle>
  /** Reverse teardown: stop the driver, unbind, unregister, unwind the scope. Memoized. */
  dispose(): Promise<void>
}

/**
 * Abstract AgentFactory for drivers that wrap a foreign harness. The host owns
 * every session/registry/persistence step; the subclass owns only agent
 * construction ({@link constructAgent}) and, on the agent itself, harness
 * binding (`bindSession`), turn driving, steering, injection, and interrupt.
 *
 * Construct one inside the driver Service's constructor: the host registers
 * the shared `turnBoundary` projection, registers the factory-owned ownership
 * teardown, and registers this host as the `ctx.agents` factory — all
 * effect-scoped to the service's fiber.
 */
/** Host-wide choices a driver makes when it mounts the shared transaction. */
export interface ExternalAgentHostOptions {
  /**
   * Identity this driver registers under. Every session it creates records
   * the id as a durable `agent/harness` event, and resume reaches this host
   * through the same id, so two drivers can never claim one session.
   */
  readonly harness: AgentHarness
  /**
   * Register the durable `model/selection` fold this host's drivers read
   * through `ExternalAgent.currentSelection`. The in-process loop reads
   * selection through the session controller's own fold and opts out.
   */
  readonly modelSelection?: boolean
  /**
   * Effect-label prefix for the units this host registers. Owners and
   * diagnostic tooling match on it, so a driver that already publishes a
   * prefix keeps it.
   */
  readonly effectPrefix?: string
  /**
   * Announce the creation edges before `bind()`, with the session's
   * `session/event` dispatch held until the bind commits. A driver whose
   * handshake snapshots the agent's tool set (ACP `session/new`, Codex
   * `thread/start`) sets it so `agent/created` scoped tool installs reach that
   * snapshot. Without it the host binds first and then enters and announces
   * the session with live dispatch.
   */
  readonly announceBeforeBind?: boolean
}

/**
 * Abstract AgentFactory for drivers that own a session's agent lifecycle. The
 * host owns every session/registry/persistence step; the subclass owns agent
 * construction (`constructAgent`) and, on the agent itself, harness binding,
 * turn driving, steering, injection, and interrupt.
 */
export abstract class ExternalAgentHost<TAgent extends ManagedAgent> implements AgentFactory {
  /** Factory-level ownership shared by create/resume wrappers and live agents. */
  protected readonly ownership: FactoryOwnership
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  protected readonly runtime: { ctx: Context }
  /** Prefix of every effect label this host registers. */
  private readonly effectPrefix: string
  /** Driver name used in lifecycle abort reasons and inactive-factory errors. */
  private readonly label: string
  /** Harness identity this host registers under and stamps on its sessions. */
  private readonly harness: AgentHarness
  /** Whether creation edges precede the bind (see {@link ExternalAgentHostOptions.announceBeforeBind}). */
  private readonly announceBeforeBind: boolean

  /**
   * @param ctx - the driver service's registration context (dependency origin for everything the host owns).
   * @param label - driver name used in lifecycle abort reasons (`"<label> is not active"`).
   * @param options - host-wide choices: this driver's harness identity and, optionally, the model-selection fold.
   */
  constructor(ctx: Context, label: string, options: ExternalAgentHostOptions) {
    this.ownership = new FactoryOwnership(ctx.fiber, label)
    this.runtime = { ctx }
    this.effectPrefix = options.effectPrefix ?? 'externalAgentHost'
    this.label = label
    this.harness = options.harness
    this.announceBeforeBind = options.announceBeforeBind === true
    // One registration per profile, never per agent: the inbox and turn-boundary
    // folds are read by every session this factory owns.
    ctx.sessionProjections.register(inboxProjectionDefinition)
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    if (options.modelSelection !== false) ctx.sessionProjections.register(externalModelSelectionProjection)
    ctx.effect(() => () => this.ownership.dispose(), `${this.effectPrefix}.transactions()`)
    ctx.effect(
      () => ctx.agents.registerHarness({ ...this.harness, factory: this }),
      `${this.effectPrefix}.registerHarness(${this.harness.id})`,
    )
  }

  /**
   * Construct the driver agent inside the unpublished lifecycle effect. Runs
   * synchronously on the owner's fiber; harness I/O belongs to
   * {@link ExternalAgent.bindSession}, which the host awaits afterward.
   * @param hostCtx - the factory service's context (scope minting parent).
   * @param id - the shared agent/session identity.
   * @param options - per-agent model and request options.
   * @param session - the prepared, unpublished session.
   * @returns the constructed driver agent.
   */
  protected abstract constructAgent(
    hostCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ): TAgent

  /**
   * Create an owned agent on a caller-supplied session id.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, optional live parent, session seed/metadata, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    const published = (async () => {
      let stored: StoredSession | undefined
      try {
        // raceAbortCall normalizes a pre-aborted or mid-create abort and
        // closes a handle that finishes creating after abandonment.
        stored = options.signal === undefined
          ? await this.createStoredSession(preparation.session)
          : await raceAbortCall(
            () => this.createStoredSession(preparation.session, options.signal),
            options.signal,
            options.sessionId,
            (abandoned) => { void abandoned?.handle.close().catch(() => {}) },
          )
      } catch (error: unknown) {
        preparation[Symbol.dispose]()
        throw error
      }
      return this.setupAndPublish(
        ownerCtx,
        options.sessionId,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        'startup',
        stored,
        options.parentAgent,
      )
    })()
    this.ownership.trackWrapper(published)
    return published
  }

  /**
   * Resume an owned agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, optional live parent, options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    return this.resumeWith(ownerCtx, persistence, options)
  }

  /**
   * Resume through an explicit persistence handle.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param persistence - mounted persistence backend.
   * @param options - persisted identity, options, setup, and cancellation.
   * @returns the published handle.
   */
  protected resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const id = options.resumeSessionId
    const published = (async () => {
      // The open and read may outlive their owner: race them against caller
      // cancellation, owner-fiber unload, and factory teardown so a
      // never-settling backend cannot pin the identity.
      const ownerAbort = new AbortController()
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      }, `externalAgentHost.resume-load(${id})`)
      const fused = AbortSignal.any([
        ...options.signal === undefined ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal,
      ])
      let handle: SessionHandle | undefined
      let stored: StoredSession | undefined
      let preparation: SessionPreparation | undefined
      try {
        try {
          // Taking write ownership FIRST excludes a concurrent resume of the
          // same id (in this process, a live agent's handle holds the claim).
          handle = await raceAbortCall(
            () => persistence.open(id, 'write', { signal: fused }),
            fused,
            id,
            (abandoned) => { void abandoned.close() },
          )
          // Semantic crash repair is the agent layer's job: persistence hands
          // back the physically valid log; an interrupted final turn receives
          // synthetic closers (missing tool errors, step/end, turn/end) that
          // are appended through the same handle as an ordinary batch.
          const coldRead = await handle.read(0, undefined, { signal: fused })
          fused.throwIfAborted()
          const persisted = coldRead.events
          // Ownership precedes publication: a session whose durable record
          // names another harness is not this host's to continue, and
          // continuing it here would replay a conversation this driver cannot
          // drive.
          const recorded = recordedHarness(persisted)
          if (recorded !== undefined && recorded !== this.harness.id) {
            throw new Error(
              `session "${id}" belongs to agent harness "${recorded}", not "${this.harness.id}"`,
            )
          }
          const closers = interruptedTurnClosers(persisted)
          if (closers.length > 0) await handle.append(closers)
          preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
            seed: [...persisted, ...closers],
            meta: structuredClone(handle.header),
            inheritedEventCount: handle.inheritedEventCount,
            eventState: coldRead.eventState,
          }))
          stored = { handle, storedCount: persisted.length + closers.length }
          await this.appendUnstoredSuffix(stored, preparation.session, preparation.session.seq)
        } finally {
          await unfollowOwner()
        }
        ownerCtx.fiber.assertActive()
        if (!this.ownership.isActive()) throw new Error(`${this.label} is not active`)
        const owned = stored
        handle = undefined // ownership passes to setupAndPublish/prepare
        return await this.setupAndPublish(
          ownerCtx,
          id,
          preparation,
          options.agentOptions ?? {},
          options.setup,
          options.signal,
          'resume',
          owned,
          options.parentAgent,
        )
      } finally {
        preparation?.[Symbol.dispose]()
        await handle?.close().catch(() => {})
      }
    })()
    this.ownership.trackWrapper(published)
    return published
  }

  /**
   * Construct the driver, scope, and one memoized reverse teardown for a new
   * agent. The teardown is registered with the factory and the owner fiber
   * BEFORE publication, so a mid-setup unload rolls everything back; `signal`
   * fuses caller cancellation with lifecycle teardown for setup awaits.
   */
  private prepare(
    ownerCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    callerSignal?: AbortSignal,
    handle?: SessionHandle,
    parentAgent?: Agent,
  ): PreparedAgent<TAgent> {
    assertAgentOptions(options)
    ownerCtx.fiber.assertActive()
    // Every caller reaches prepare() synchronously from a service method
    // whose Cordis dispatch already requires the live factory fiber, or
    // re-checks ownership itself after its awaits (resume's load barrier).
    if (!this.ownership.isActive()) throw new Error(`${this.label} is not active`)
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason })
    }
    const hostCtx = this.runtime.ctx

    // Deactivation fuses three owners, each with its own reason: the caller's
    // cancellation signal, the owner fiber's unload, and factory teardown.
    // It is registered BEFORE any resource exists, over mutable slots, so an
    // unload arriving while the scope is still minting finds a working
    // disposer instead of a leak.
    const abort = new AbortController()
    const onCallerAbort = (): void => {
      abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }))
    }
    const onFactoryTeardown = (): void => { abort.abort(this.ownership.signal.reason) }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true })

    let machine: TAgent | undefined
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    let publication: ReturnType<typeof Promise.withResolvers<void>> | undefined
    const machineReady = Promise.withResolvers<void>()
    // Reverse teardown, memoized so every racing owner awaits one quiescence:
    // stop the driver, release the harness binding, drain and close the
    // session's write path, leave the registries, unwind the scope.
    const dispose = (ownerTriggered = false): Promise<void> => (disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`))
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      // Teardown failures are collected, never swallowed: registry, scope,
      // and ownership cleanup always run to quiescence, then the memoized
      // disposal rejects with what failed so every racing owner observes it.
      const failures: unknown[] = []
      try {
        // Creation listeners retain the session and scope through their
        // awaits; teardown waits for the publication they hold.
        if (publication !== undefined) await publication.promise
        /* v8 ignore next -- Cordis effect teardown waits for synchronous setup before observing the machine slot. */
        if (machine === undefined) await machineReady.promise
        /* v8 ignore next -- setup failure untracks this disposer before resolving without a machine. */
        if (machine !== undefined) {
          machine.cancel({ kind: 'disposed' })
          await machine.whenIdle()
          await machine.unbind()
          await machine.scope.dispose()
        }
      } catch (error: unknown) {
        failures.push(error)
      }
      // The driver above committed its closing events synchronously into the
      // session; handle close drains them durably before releasing the write
      // path. The close drain can be the first operation that surfaces a
      // durability failure, so its error is retained, not logged away.
      try {
        await handle?.close()
      } catch (error: unknown) {
        failures.push(error)
      }
      try {
        detachAgent?.()
        detachSession?.()
      } finally {
        untrack()
        if (!ownerTriggered) await unfollowOwner()
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, `agent "${id}" disposal failed`)
      }
    })())
    const untrack = this.ownership.track(dispose)
    const construct = this.constructAgent.bind(this)
    let unfollowOwner: () => Promise<void> | void
    try {
      unfollowOwner = ownerCtx.effect(function* () {
        machine = construct(hostCtx, id, options, session)
        machineReady.resolve()
        yield machine.scope.rawDispose
        yield () => {
          // Owner disposal owns the same quiescence boundary. Its teardown skips
          // unregistering this already-running owner effect from inside itself.
          if (disposing !== undefined) return
          abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
          return dispose(true)
        }
      }, `${this.effectPrefix}.lifecycle(${id})`)
      /* v8 ignore start -- ctx.effect throws only on an inactive fiber, which assertActive() above already rejected */
    } catch (error: unknown) {
      machineReady.resolve()
      untrack()
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      throw error
    }
    /* v8 ignore stop */

    const assertLive = (): void => {
      if (!abort.signal.aborted) return
      // Every fused abort source carries an Error reason: onCallerAbort and
      // raceAbort wrap non-Error caller reasons, and the factory/lifecycle
      // owners abort with constructed Errors.
      /* v8 ignore next -- unreachable String() arm, see above */
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))
    }
    try {
      /* v8 ignore next -- a synchronous effect exhausts the generator before returning */
      if (machine === undefined) throw new Error(`agent "${id}" lifecycle did not construct its driver`)
      const agent = machine
      assertLive()

      return {
        agent,
        signal: abort.signal,
        announce: async (source, deferred) => {
          publication = Promise.withResolvers<void>()
          try {
            assertLive()
            // A deferred entry holds dispatch: creation listeners and the
            // handshake append normally, but no observer sees an event before
            // the bind commits, so a refused handshake rolls back without
            // residue. Otherwise the mounted backend routes live events into
            // the active write handle by session id from here on.
            detachSession = agent.ctx.sessions.enter(session, { deferPublication: deferred })
            detachAgent = hostCtx.agents.enter(agent, parentAgent)
            agent.ctx.sessions.announce(session)
            assertLive()
            // The registry's creation edge owns `agent/created` and awaits its
            // listeners; teardown above waits for this announcement to settle.
            await hostCtx.agents.announce(agent, source, abort.signal)
            assertLive()
          } finally {
            publication.resolve()
            publication = undefined
          }
        },
        publish: (deferred) => {
          assertLive()
          // The commit flush stored the log below store entry; publication
          // dispatches the held appends, which persistence writes after it.
          if (deferred) agent.ctx.sessions.publish(session)
          return Promise.resolve({ agent, dispose })
        },
        dispose,
      }
    } catch (error: unknown) {
      machineReady.resolve()
      // Rollback swallows a disposal rejection: the setup failure is primary.
      void dispose().catch(() => {})
      throw error
    }
  }

  /**
   * Prepare one Agent around an acquired Session, run caller setup, bind the
   * harness-side conversation, and publish the pair.
   */
  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    preparation: SessionPreparation,
    agentOptions: AgentOptions,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: SessionStartSource,
    stored?: StoredSession,
    parentAgent?: Agent,
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    const session = ownedPreparation.session
    let prepared: PreparedAgent<TAgent>
    try {
      prepared = this.prepare(ownerCtx, id, agentOptions, session, signal, stored?.handle, parentAgent)
    } catch (error: unknown) {
      await stored?.handle.close().catch(() => {})
      throw error
    }
    try {
      // Initialization runs as one maintenance activity: no turn can claim the
      // session while setup, binding, and publication are still in flight, and
      // a failure cancels the driver before rollback so its own cleanup (with
      // the inbox kept for teardown) runs in a defined phase.
      return await prepared.agent.runMaintenance(async () => {
        try {
          const setupCommit = await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id)
          setupCommit?.commit()
          if (this.announceBeforeBind) {
            // The creation edges run before the handshake so `agent/created`
            // listeners install the agent's scoped tools (delegation, Team)
            // before the driver snapshots the tool set into `session/new` or
            // `thread/start`. Dispatch stays held through the handshake, so a
            // rejected one rolls the announcement back with nothing stored or
            // observed. The harness record precedes store entry, so the
            // commit flush stores it.
            this.recordHarness(session)
            const entered = session.seq
            await prepared.announce(source, true)
            await raceAbort(prepared.agent.bind(prepared.signal), prepared.signal, id)
            await this.appendUnstoredSuffix(stored, session, entered)
            return await prepared.publish(true)
          }
          // Binding runs unpublished: a rejected handshake rolls the
          // transaction back without ever publishing either identity.
          await raceAbort(prepared.agent.bind(prepared.signal), prepared.signal, id)
          this.recordHarness(session)
          await this.appendUnstoredSuffix(stored, session, session.seq)
          await prepared.announce(source, false)
          return await prepared.publish(false)
        } catch (error: unknown) {
          // Teardown owns inbox cleanup and may already have removed its projection.
          prepared.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
          throw error
        }
      })
    } catch (error: unknown) {
      // Rollback swallows a disposal rejection (a failing final handle close):
      // the setup failure is the primary error the caller must see.
      await prepared.dispose().catch(() => {})
      throw error
    }
  }

  /**
   * Take a fresh session's write ownership when persistence is mounted.
   * Nothing is appended here: the constructor seed and the unpublished setup
   * suffix are stored by {@link appendUnstoredSuffix} at the publication commit
   * point, so a failed or cancelled setup closes an unmaterialized handle and
   * leaves no stored residue — the same id can be created again.
   * @param session - the unpublished session to store.
   * @param signal - optional cancellation forwarded to the backend create.
   * @returns the owned handle and stored cursor, or `undefined` without a backend.
   */
  private async createStoredSession(session: Session, signal?: AbortSignal): Promise<StoredSession | undefined> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    return { handle, storedCount: 0 }
  }

  /**
   * Record which harness owns this session, once, inside the pre-publication
   * suffix. A resumed session that already names its harness keeps the record
   * it has: one session is never handed from one harness to another, and the
   * resume check refused that case before publication.
   * @param session - the unpublished session about to be published.
   */
  private recordHarness(session: Session): void {
    if (agentHarnessOf(this.runtime.ctx.sessionProjections, session) !== undefined) return
    session.append('agent/harness', { harness: this.harness.id })
  }

  /**
   * Durably store the session events appended before store entry and not yet
   * stored: constructor seed markers, setup-window events, and the harness
   * record. Nothing dispatches them on `session/event`, so the commit flush
   * stores them through the handle before publication dispatches the held
   * appends that follow.
   * @param stored - the session's owned handle and stored cursor, if any.
   * @param session - the unpublished session whose suffix is stored.
   * @param until - the log length at store entry; later events reach
   *   persistence through the held dispatch.
   */
  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session, until: number): Promise<void> {
    if (stored === undefined) return
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount), SessionLogOffset(until))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }
}
