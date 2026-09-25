/**
 * Turn-bound session-event projector for external-harness drivers: the one
 * place harness observations become durable `assistant/message`,
 * `tool/call`/`tool/result`, and `request/header` events plus their live
 * notifications.
 *
 * @module @deepseek-ai/dsh-agent-external/projector
 */

import type { AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import {
  createAssistantMessage,
  createToolResultMessage,
  type ContentBlock,
  type ReasoningEffortId,
  type ToolCallId,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  canonicalHeader,
  headerEquals,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ExternalModelSelection } from './agent.ts'
import { AssistantStreamAttempt } from './assistant-stream.ts'

/** Cross-turn request-header bookkeeping owned by one agent lifecycle. */
export interface RouteLogState {
  /** Whether this agent instance already appended a `request/header`. */
  logged: boolean
}

/**
 * Session-event projector bound to one live turn and step. Durable appends
 * commit before any live notification leaves, so a UI observer never sees an
 * announcement for an event the log rejected.
 */
export class ExternalTurnProjector {
  /**
   * @param session - session whose durable log receives every projection.
   * @param dispatch - agent-scoped notification publisher.
   * @param turn - durable turn owning every projection.
   * @param step - durable step owning every projection.
   * @param allocAttempt - allocates one attempt number per assistant stream.
   * @param nextRevision - allocates the next emitted frame revision.
   * @param routeState - the agent lifecycle's request-header bookkeeping.
   */
  constructor(
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
    readonly turn: number,
    step: number,
    private readonly allocAttempt: () => number,
    private readonly nextRevision: () => number,
    private readonly routeState: RouteLogState,
  ) {
    this.currentStep = step
  }

  /** The step later projections are written into. */
  private currentStep: number

  /** Durable step every projection is written into. */
  get step(): number {
    return this.currentStep
  }

  /**
   * Write every later projection into another step of the same turn.
   * @param step - the step the driver just opened.
   */
  enterStep(step: number): void {
    this.currentStep = step
  }

  /**
   * Open one streamed assistant attempt: live `agent/assistant-stream` frames
   * plus the durable compact stream the settlement embeds. Callers push
   * adapter-shaped chunks; {@link commitAssistant} or {@link commitAttempt}
   * closes it exactly once.
   * @returns the open, started attempt.
   */
  beginAssistant(): AssistantStreamAttempt {
    const attempt = new AssistantStreamAttempt(
      this.session.id,
      this.allocAttempt(),
      this.nextRevision,
      this.turn,
      this.step,
      (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
    )
    attempt.start()
    return attempt
  }

  /**
   * Commit an open attempt's assembled blocks as one durable
   * `assistant/message`, then publish its committed end frame.
   * @param attempt - the open attempt to settle.
   * @param source - the provider and model recorded on the committed message.
   * @param options - `interrupted` marks a cancellation-truncated prefix;
   *   `usage` overrides the stream-reported token accounting.
   * @returns the committed event.
   */
  commitAssistant(
    attempt: AssistantStreamAttempt,
    source: { provider: string; model: string },
    options: { interrupted?: boolean; usage?: TokenUsage } = {},
  ): SessionEvent<'assistant/message'> {
    const content = options.interrupted === true ? attempt.interruptedBlocks() : attempt.blocks()
    const usage = options.usage ?? attempt.usage
    let committed!: SessionEvent<'assistant/message'>
    attempt.settle('assistant/message', () => (committed = this.session.append('assistant/message', {
      turn: this.turn,
      step: this.step,
      message: createAssistantMessage({
        content,
        source: {
          provider: source.provider,
          model: source.model,
          ...attempt.replayState === undefined ? {} : { replayState: attempt.replayState },
        },
      }),
      stream: attempt.stream,
      ...usage === undefined ? {} : { usage },
      ...options.interrupted === true ? { interrupted: true } : {},
    }, { surfaceOp: 'append' })).seq)
    return committed
  }

  /**
   * Record an open attempt that produced no surface message — a failed or
   * cancelled stream — as a durable `assistant/attempt`, then publish its
   * committed end frame.
   * @param attempt - the open attempt to settle.
   * @returns the committed event.
   */
  commitAttempt(attempt: AssistantStreamAttempt): SessionEvent<'assistant/attempt'> {
    let committed!: SessionEvent<'assistant/attempt'>
    attempt.settle('assistant/attempt', () => (committed = this.session.append('assistant/attempt', {
      turn: this.turn,
      step: this.step,
      stream: attempt.stream,
    })).seq)
    return committed
  }

  /**
   * Commit one complete assistant message whose text arrived without
   * incremental deltas: the stream is synthesized as a single text block so
   * replay and live rendering match a streamed delivery.
   * @param text - the complete assistant text.
   * @param source - the provider and model recorded on the committed message.
   * @param options - usage and interruption facts.
   * @returns the committed event.
   */
  assistantText(
    text: string,
    source: { provider: string; model: string },
    options: { interrupted?: boolean; usage?: TokenUsage } = {},
  ): SessionEvent<'assistant/message'> {
    const attempt = this.beginAssistant()
    attempt.push({ type: 'block-start', index: 0, blockType: 'text' })
    if (text.length > 0) attempt.push({ type: 'text-delta', index: 0, text })
    attempt.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
    attempt.push({
      type: 'finish',
      reason: options.interrupted === true
        ? { kind: 'aborted', failure: { message: 'turn interrupted', code: 'ABORTED' } }
        : { kind: 'stop' },
    })
    return this.commitAssistant(attempt, source, options)
  }

  /**
   * Commit one harness tool invocation record.
   * @param callId - foreign call identity; paired with its `tool/result`.
   * @param name - foreign tool name as the harness reported it.
   * @param argsJson - raw JSON arguments exactly as reported.
   * @returns the committed event.
   */
  toolCall(callId: string, name: string, argsJson: string): SessionEvent<'tool/call'> {
    return this.session.append('tool/call', {
      turn: this.turn,
      step: this.step,
      callId: brandString<ToolCallId>(callId),
      name,
      arguments: argsJson,
    })
  }

  /**
   * Commit one completed harness tool call's result.
   * @param callId - identity of the paired `tool/call`.
   * @param content - model-facing result blocks.
   * @param options - `isError` marks the block; `error` carries the failure
   *   identity (allowed only with `isError`); `meta` is the JSON-serializable
   *   card payload the producing driver reads back for presentation.
   * @returns the committed event.
   */
  toolResult(
    callId: string,
    content: ContentBlock[],
    options: { isError?: boolean; error?: { name: string; code: string }; meta?: JsonValue } = {},
  ): SessionEvent<'tool/result'> {
    const isError = options.isError === true
    const toolCallId = brandString<ToolCallId>(callId)
    return this.session.append('tool/result', {
      turn: this.turn,
      step: this.step,
      message: createToolResultMessage({ callId: toolCallId, content, isError }),
      ...options.error === undefined || !isError ? {} : { error: options.error },
      ...options.meta === undefined ? {} : { meta: options.meta },
    }, { surfaceOp: 'append' })
  }

  /**
   * Log the effective model route a turn is being driven with. The committed
   * `request/header` folds the picker's durable `modelSelection` projection —
   * a matching pending selection retires — and feeds the session's
   * current-route readers. Skips the append when the route is unchanged.
   * @param route - the provider/model/effort actually sent to the harness.
   * @returns the committed event, or undefined when the route was unchanged.
   */
  noteRoute(route: ExternalModelSelection): SessionEvent<'request/header'> | undefined {
    const header = canonicalHeader({
      config: {
        provider: route.provider,
        model: route.model,
        ...route.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: brandString<ReasoningEffortId>(route.reasoningEffort) },
      },
    })
    const baseline = this.session.requestHeader()
    if (!this.routeState.logged) {
      this.routeState.logged = true
      return this.session.append('request/header', {
        header,
        reason: baseline === undefined ? 'initial' : 'resume',
      })
    }
    if (baseline !== undefined && headerEquals(baseline, header)) return undefined
    return this.session.append('request/header', { header, reason: 'change' })
  }
}
