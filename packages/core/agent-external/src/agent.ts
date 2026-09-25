/**
 * Abstract Agent driver whose work runs inside a foreign harness process. The
 * shared {@link ManagedAgent} base owns the session-facing machinery every
 * driver has in common; this subclass adds the harness surface — one turn
 * opens at step 1 and the driver advances a step at each harness model
 * response, live steering and context injection reach the harness, and the
 * durable model-selection fold decides the route.
 *
 * @module @deepseek-ai/dsh-agent-external/agent
 */

import { errorChain } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { ManagedAgent, type RunningAgentPhase, type TurnBodyOutcome } from './base.ts'
import { ExternalTurnProjector, type RouteLogState } from './projector.ts'

/** One live harness-turn boundary handed to the driver. */
export interface ExternalTurnDrive {
  /** Durable turn number. */
  readonly turn: number
  /** Durable step number the projector writes into; a turn opens at step 1. */
  readonly step: number
  /** Abort signal for this turn; aborted by {@link Agent.cancel} or lifecycle teardown. */
  readonly signal: AbortSignal
  /** Session-event projector bound to this turn and its current step. */
  readonly projector: ExternalTurnProjector
  /**
   * Close the current step and open the next one. A harness makes several
   * model calls in one turn; a driver advances at each new model response so
   * the log carries one assistant message and its tool calls per step, as the
   * in-process loop writes it. The caller commits or settles every assistant
   * stream and tool call of the current step first.
   */
  nextStep(): void
}

/**
 * Model id recorded when the harness never reports which model ran: the
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
 * inbox, turn/step events, live notifications, cancellation — comes from
 * {@link ManagedAgent}.
 *
 * The host calls {@link bind} after caller setup and before publication, and
 * {@link unbind} during teardown after driver quiescence; neither is part of
 * the public {@link Agent} surface.
 */
export abstract class ExternalAgent extends ManagedAgent {
  /** Live drive window for mid-turn steering, or undefined between turns. */
  private liveDrive: ExternalTurnDrive | undefined
  /** Serialized steer/inject forwards, so wire order matches inbox order. */
  private liveForward: Promise<unknown> = Promise.resolve()
  /** Process-local revision of assistant frames for this attached Session. */
  private assistantStreamRevision = 0
  private assistantAttemptCounter = 0
  /** Request-header bookkeeping shared by every turn's projector. */
  private readonly routeState: RouteLogState = { logged: false }

  override steer(input: UserMessage): void {
    // Capture the live drive BEFORE send() can wake a driver: steering sent
    // while idle rides the turn claim like ordinary input, and only a drive
    // already live at call time receives the wire-level forward.
    const drive = this.liveDrive
    this.send(input, 'next-step', true)
    if (drive !== undefined) this.forwardLive(input, message => this.steerLive(message, drive))
  }

  override inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
    this.forwardLive(input, message => this.injectHarness(message))
  }

  /**
   * Drive the claimed batch through one harness call. The turn opens at step
   * 1, the driver advances through {@link ExternalTurnDrive.nextStep}, and the
   * last step closes when the call settles; an empty claim still opens the
   * turn boundary.
   * @param turn - the durable turn already appended.
   * @param signal - the live turn's abort signal.
   * @param phase - the running phase the skeleton reserved for this turn.
   * @returns the turn ending, and whether the driver stops here.
   */
  protected override async runTurnBody(
    turn: number,
    signal: AbortSignal,
    phase: RunningAgentPhase,
  ): Promise<TurnBodyOutcome> {
    signal.throwIfAborted()
    const claimed = this.inbox.claim('next-turn', turn)
    // A bare wake (cleared or consumed input) still owns its turn boundary
    // but spends no harness call.
    if (claimed.length === 0) return { ends: { kind: 'completed' }, stop: true }
    let step = 1
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
      const session = this.session
      const drive: ExternalTurnDrive = {
        turn,
        get step() { return step },
        signal,
        projector,
        nextStep: () => {
          session.append('step/end', { turn, step })
          step += 1
          session.append('step/start', { turn, step })
          phase.step = step
          projector.enterStep(step)
        },
      }
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
        return { ends: await this.driveTurn(claimed, drive), stop: false }
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
      const turn = this.liveDrive?.turn ?? this.currentTurn + 1
      if (!this.inbox.consume(message.id, turn)) return
      this.session.append('user/message', message, { surfaceOp: 'append' })
    })
    // The chain carries no caller: a refused forward is silent, while a
    // forward or durable-commit failure surfaces at the agent's error channel.
    this.liveForward = chained.then(() => undefined, () => undefined)
    void chained.catch((error: unknown) => {
      this.dispatch.emit('agent/error', {
        turn: this.currentTurn,
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
        ? this.options.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.reasoningEffort }
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
  abstract override bind(signal: AbortSignal): Promise<void>

  /**
   * Release the harness-side conversation — Codex `thread/unsubscribe`, ACP
   * `session/close`. Called during teardown after driver quiescence, before
   * the agent scope unwinds; the shared process is still alive.
   */
  abstract override unbind(): Promise<void>

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
