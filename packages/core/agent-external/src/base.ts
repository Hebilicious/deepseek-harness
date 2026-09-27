/**
 * The Agent surface every DSH driver shares: durable inbox, phase machine,
 * wake/latch bookkeeping, maintenance exclusion, and the turn skeleton that
 * opens and closes durable turn boundaries. A driver subclasses this and
 * implements {@link ManagedAgent.runTurnBody} with its own step loop.
 *
 * @module @deepseek-ai/dsh-agent-external/base
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

/** The driver's activity state; one activity (turn or maintenance) runs at a time. */
export type AgentPhase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** The phase a turn body runs inside; the shared skeleton reserves it. */
export type RunningAgentPhase = Extract<AgentPhase, { kind: 'running' }>

/**
 * How {@link ManagedAgent.runTurnBody} leaves the driver.
 *
 * `stop` ends the driver after this turn exactly as a rejected or empty claim
 * does, without consulting the queue again; `continue` hands the turn to the
 * shared tail, which starts another turn when input is still pending.
 */
export interface TurnBodyOutcome {
  /** The durable ending the shared skeleton records on `turn/end`. */
  readonly ends: TurnEndReason
  /** Whether the driver stops here instead of draining pending input. */
  readonly stop: boolean
}

/**
 * Shared driver base implementing the session-facing {@link Agent} surface.
 * The base owns the inbox, the phase machine, steering and injection queues,
 * cancellation, maintenance exclusion, and one turn's boundaries; the driver
 * owns what happens inside a turn.
 */
export abstract class ManagedAgent implements Agent {
  readonly inbox: DurableAgentInbox
  /** Live activity state; a driver's turn body reads and advances `step`. */
  protected phase: AgentPhase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  protected readonly dispatch: AgentEventDispatch

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
  private setPhase(next: AgentPhase): void {
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

  /**
   * Queue input as a waking follow-up turn.
   * @param input - the user message to queue.
   */
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  /**
   * Queue steering for the running activity, or the next proposed step when idle.
   * @param input - the user message to queue.
   */
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  /**
   * Queue context for the running activity without waking the driver.
   * @param input - the user message to queue.
   */
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  /**
   * Run one maintenance job while excluding agent turns, then rejoin the queue.
   * @param job - the maintenance work; its signal aborts on cancellation.
   * @returns the job's result.
   */
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: AgentPhase = {
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
        // A disposed maintenance activity owes no replay: teardown is about to
        // drop the agent, so pending input must not wake a driver again.
        const cause = maintenance.abort.signal.reason as AgentCancelCause | undefined
        const pendingWake = this.inbox.hasPending || this.hasUnpromptedHarnessWork()
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && pendingWake) this.wakeDriver()
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

  /**
   * The turn the driver is running, or the last one it finished. A forward
   * accepted between turn bodies belongs to the turn after it.
   * @returns the current or last reserved turn number.
   */
  protected get currentTurn(): number {
    return this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  protected throwError(error: unknown): never {
    const turn = this.currentTurn
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
   * Open one durable turn, run the driver's body inside it, and close the
   * boundary with the ending the body reported. A body that returns `stop`
   * leaves immediately, matching a rejected or empty claim; otherwise pending
   * input rolls the driver into another turn.
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
      const outcome = await this.runTurnBody(turn, signal, phase)
      turnEnds = outcome.ends
      if (outcome.stop) return false
    } catch (error: unknown) {
      if (signal.aborted) {
        const reason = signal.reason as AgentCancelCause
        turnEnds = { kind: 'aborted', reason }
        this.afterAbortedTurn(phase, reason)
        throw error
      }
      turnEnds = this.turnFailure(error)
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending && !this.hasUnpromptedHarnessWork()) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /**
   * Classify one turn failure into the durable ending recorded on `turn/end`.
   * Drivers whose failures carry structured facts override this.
   * @param error - the failure the turn body raised.
   * @returns the durable ending to record.
   */
  protected turnFailure(error: unknown): TurnEndReason {
    // Every failure is structured: anything a driver threw flattens to
    // `errorChain` text under the `UNKNOWN` code.
    return { kind: 'error', error: { message: errorChain(error), code: 'UNKNOWN' } }
  }

  /**
   * Latch pending input for replay after a non-disposal abort. A driver whose
   * turn body lets cancelled input survive overrides this.
   * @param phase - the running phase that was aborted.
   * @param reason - the cancellation reason carried by the turn signal.
   */
  protected afterAbortedTurn(phase: RunningAgentPhase, reason: AgentCancelCause): void {
    if (reason.kind !== 'disposed' && this.inbox.hasPending) phase.wakeRequested = true
  }

  /**
   * Whether harness output is waiting with no inbox row. An empty claim then
   * still runs {@link ExternalAgent.driveUnpromptedTurn} instead of stopping.
   * The default is no such output; a driver that adopts idle harness cycles
   * overrides this.
   * @returns whether the next empty claim must open a turn.
   */
  protected hasUnpromptedHarnessWork(): boolean {
    return false
  }

  /**
   * Start the driver while idle. A running or maintenance activity latches the
   * wake the same way {@link send} does.
   */
  protected wakeIdleDriver(): void {
    this.wakeDriver()
  }

  /**
   * Run one turn's body between the durable `turn/start` and `turn/end`
   * boundaries. The driver owns its step boundaries and its cancellation
   * handling inside; returning `stop` ends the driver at this turn.
   * @param turn - the durable turn number already appended.
   * @param signal - the live turn's abort signal.
   * @param phase - the running phase the skeleton reserved for this turn.
   * @returns the durable ending and whether the driver stops here.
   */
  protected abstract runTurnBody(
    turn: number,
    signal: AbortSignal,
    phase: RunningAgentPhase,
  ): Promise<TurnBodyOutcome>

  /**
   * Attach the driver's own conversation to this session before publication.
   * In-process drivers have nothing to attach and inherit the no-op.
   * @param signal - fused caller/lifecycle cancellation.
   */
  bind(signal: AbortSignal): Promise<void> {
    void signal
    return Promise.resolve()
  }

  /**
   * Release the driver's own conversation during teardown. In-process drivers
   * have nothing to release and inherit the no-op.
   */
  unbind(): Promise<void> {
    return Promise.resolve()
  }
}
