/**
 * Abstract Agent driver whose work runs inside a foreign harness process. The
 * class owns the session-facing machinery every driver shares — phase machine,
 * durable inbox, turn/step boundaries, live steer/inject delivery, and the
 * durable model-selection fold — while the subclass owns only the harness
 * binding and one turn's drive.
 *
 * @module @deepseek-ai/dsh-agent-external/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { DurableAgentInbox } from './inbox.ts'
import { ExternalTurnProjector, type RouteLogState } from './projector.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** One live harness-turn boundary handed to the driver. */
export interface ExternalTurnDrive {
  /** Durable turn number. */
  readonly turn: number
  /** Durable step number; a foreign turn always owns step 1. */
  readonly step: number
  /** Abort signal for this turn; aborted by {@link Agent.cancel} or lifecycle teardown. */
  readonly signal: AbortSignal
  /** Session-event projector bound to this turn and step. */
  readonly projector: ExternalTurnProjector
}

/**
 * Provenance recorded when the harness never reports which model ran: the
 * durable `source.model`/`request/header` fields require a non-empty value,
 * and this marks the harness's own default rather than a DSH-chosen route.
 */
export const HARNESS_DEFAULT_MODEL = 'agent-default'

/**
 * Model route folded from durable `model/selection` events; the payload
 * member merges in only where the picker package compiles, so the fold
 * validates the record structurally at the log boundary.
 */
export interface ExternalModelSelection {
  /** Provider route label the foreign harness understands. */
  readonly provider: string
  /** Model id the foreign harness understands. */
  readonly model: string
  /** Harness-interpreted reasoning effort, when selected. */
  readonly reasoningEffort?: string
}

/**
 * Agent whose turns run inside an external harness process. Subclasses
 * implement the four harness verbs; everything session-facing — durable
 * inbox, turn/step events, live notifications, cancellation — is owned here.
 *
 * The host calls {@link bind} after caller setup and before publication, and
 * {@link unbind} during teardown after driver quiescence; neither is part of
 * the public {@link Agent} surface.
 */
export abstract class ExternalAgent implements Agent {
  readonly inbox: DurableAgentInbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  protected readonly dispatch: AgentEventDispatch

  /** Live drive window for mid-turn steering, or undefined between turns. */
  private liveDrive: ExternalTurnDrive | undefined
  /** Serialized steer/inject forwards, so wire order matches inbox order. */
  private liveForward: Promise<unknown> = Promise.resolve()
  /** Process-local revision of assistant frames for this attached Session. */
  private assistantStreamRevision = 0
  private assistantAttemptCounter = 0
  /** Request-header bookkeeping shared by every turn's projector. */
  private readonly routeState: RouteLogState = { logged: false }

  constructor(
    /** The factory service's context: session projection reads and initiator scoping. */
    protected readonly hostCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(hostCtx, this)
    this.scope = createScope(hostCtx, this)
    this.ctx = this.scope.ctx
    this.inbox = new DurableAgentInbox(this.ctx.sessionProjections, session, this.dispatch)
    /* v8 ignore next -- the host registers its own turnBoundary unit, so the key is always present */
    const lastTurn = this.hostCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    // Capture the live drive BEFORE send() can wake a driver: steering sent
    // while idle rides the turn claim like ordinary input, and only a drive
    // already live at call time receives the wire-level forward.
    const drive = this.liveDrive
    this.send(input, 'next-step', true)
    if (drive !== undefined) this.forwardLive(input, message => this.steerLive(message, drive))
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
    this.forwardLive(input, message => this.injectHarness(message))
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.hostCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /**
   * Run one harness turn: claim the queued batch, commit it as user/message
   * events, and hand the turn to the subclass's harness call. A foreign turn
   * is exactly one durable step; pending input still queued at the boundary
   * rolls the driver into another turn.
   * @returns whether another turn should run immediately.
   */
  private async turn(): Promise<boolean> {
    /* v8 ignore next -- kick owns a running phase until this driver boundary */
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    try {
      signal.throwIfAborted()
      const claimed = this.inbox.claim('next-turn', turn)
      // A bare wake (cleared or consumed input) still owns its turn boundary
      // but spends no harness call.
      if (claimed.length === 0) {
        turnEnds = { kind: 'completed' }
        return false
      }
      const step = 1
      this.session.append('step/start', { turn, step })
      phase.step = step
      try {
        for (const message of claimed) {
          this.session.append('user/message', message, { surfaceOp: 'append' })
        }
        const projector = new ExternalTurnProjector(
          this.session,
          this.dispatch,
          turn,
          step,
          () => ++this.assistantAttemptCounter,
          () => ++this.assistantStreamRevision,
          this.routeState,
        )
        const drive: ExternalTurnDrive = { turn, step, signal, projector }
        const onAbort = (): void => {
          void Promise.resolve()
            .then(() => this.interruptTurn(drive))
            .catch((error: unknown) => {
              this.ctx.logger.warn(`agent "${this.id}": harness interrupt failed: ${errorChain(error)}`)
            })
        }
        signal.addEventListener('abort', onAbort)
        this.liveDrive = drive
        try {
          turnEnds = await this.driveTurn(claimed, drive)
        } finally {
          // Accepted live forwards still commit their durable rows inside
          // this turn's boundary; settlement cannot inspect the queue ahead
          // of them. The chain never rejects — forward failures surface on
          // the agent's error channel.
          await this.liveForward
          this.liveDrive = undefined
          signal.removeEventListener('abort', onAbort)
        }
      } finally {
        this.session.append('step/end', { turn, step })
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        const reason = signal.reason as AgentCancelCause
        turnEnds = { kind: 'aborted', reason }
        // Pending input kept through a non-disposal abort is owed a turn:
        // this driver is exiting, so the boundary latch replays the queue.
        if (reason.kind !== 'disposed' && this.inbox.hasPending) phase.wakeRequested = true
        throw error
      }
      // Every failure is structured: anything the harness threw flattens to
      // `errorChain` text under the `UNKNOWN` code.
      turnEnds = { kind: 'error', error: { message: errorChain(error), code: 'UNKNOWN' } }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /**
   * Forward one message into the live harness through the driver's channel,
   * serialized so wire order matches inbox order. On acceptance the pending
   * row is consumed and the model-visible message committed at the current
   * log position; a refused forward leaves the row pending for the next turn.
   */
  private forwardLive(message: UserMessage, forward: (message: UserMessage) => Promise<boolean>): void {
    const chained = this.liveForward.then(async () => {
      const accepted = await forward(message)
      if (!accepted) return
      // Steering accepted mid-turn belongs to the live turn; context a
      // harness accepted between turns belongs to the turn about to open.
      const turn = this.liveDrive?.turn
        ?? (this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn) + 1
      if (!this.inbox.consume(message.id, turn)) return
      this.session.append('user/message', message, { surfaceOp: 'append' })
    })
    // The chain carries no caller: a refused forward is silent, while a
    // forward or durable-commit failure surfaces at the agent's error channel.
    this.liveForward = chained.then(() => undefined, () => undefined)
    void chained.catch((error: unknown) => {
      this.dispatch.emit('agent/error', {
        turn: this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn,
        step: this.phase.kind === 'running' ? this.phase.step : 0,
        error,
      })
    })
  }

  /**
   * Effective model route for the next harness turn: the latest durable
   * `model/selection` the session recorded, falling back to the agent's
   * declared options. Drivers send it per turn (Codex `turn/start`, ACP
   * config options) and log it through {@link ExternalTurnProjector.noteRoute}.
   * @returns the resolved provider/model/effort, with empty strings for unset fields.
   */
  protected currentSelection(): ExternalModelSelection {
    const folded = this.ctx.sessionProjections.stateOf(this.session, 'externalModelSelection')
    const selected = folded?.selection
    return {
      provider: selected?.provider ?? this.options.provider ?? '',
      model: selected?.model ?? this.options.model ?? '',
      ...selected?.reasoningEffort === undefined
        ? this.options.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.reasoningEffort as string }
        : { reasoningEffort: selected.reasoningEffort },
    }
  }

  // ---- the driver's harness surface ----

  /**
   * Bind the harness-side conversation to this session — Codex `thread/start`
   * or `thread/resume`, ACP `session/new` or `session/load`. Runs unpublished:
   * a rejected handshake rolls the whole creation transaction back. Plugin-owned
   * durable records (the foreign thread/session id) append to `this.session`
   * here and flush with the pre-publication suffix.
   * @param signal - fused caller/lifecycle cancellation.
   */
  abstract bind(signal: AbortSignal): Promise<void>

  /**
   * Release the harness-side conversation — Codex `thread/unsubscribe`, ACP
   * `session/close`. Called during teardown after driver quiescence, before
   * the agent scope unwinds; the shared process is still alive.
   */
  abstract unbind(): Promise<void>

  /**
   * Drive one harness turn — Codex `turn/start` to `turn/completed`, ACP
   * `session/prompt` to its response. The claimed batch is already committed
   * as `user/message` events; the driver streams harness output through
   * `drive.projector` and resolves with the turn's ending.
   * @param messages - the claimed user input for this turn.
   * @param drive - turn boundary, abort signal, and bound projector.
   * @returns the durable turn ending.
   */
  protected abstract driveTurn(messages: readonly UserMessage[], drive: ExternalTurnDrive): Promise<TurnEndReason>

  /**
   * Forward one steering message into the live harness turn (Codex
   * `turn/steer`). Called only while a drive is live, serialized behind
   * earlier forwards. Resolving `false` leaves the message pending for the
   * next turn; `true` commits it durably as a `user/message`.
   * @param message - pending steering input.
   * @param drive - the live turn the steering targets.
   * @returns whether the harness accepted the steering.
   */
  protected abstract steerLive(message: UserMessage, drive: ExternalTurnDrive): Promise<boolean>

  /**
   * Deliver queued context to the harness outside a claim boundary (Codex
   * `thread/inject_items`). Called in inbox order, live or idle. Resolving
   * `false` leaves the message pending; the default refuses every message.
   * @param message - pending injected context.
   * @returns whether the harness accepted the context.
   */
  protected injectHarness(message: UserMessage): Promise<boolean> {
    void message
    return Promise.resolve(false)
  }

  /**
   * Interrupt the live harness turn after its abort signal fired (Codex
   * `turn/interrupt`, ACP `session/cancel`). Best-effort: failures are logged,
   * and the turn still ends aborted.
   * @param drive - the aborted live turn.
   */
  protected abstract interruptTurn(drive: ExternalTurnDrive): Promise<void>
}
