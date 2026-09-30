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
 * Bridge-side lookup the projector consults for harness-reported tool calls:
 * resolves the harness's `mcp__<server>__<tool>` name back to the bridged
 * dsh tool, then hands over the settled execution's presentation `meta` for
 * the matching `tool/result`. Undefined means no bridge is mounted and every
 * name logs exactly as the harness reported it.
 */
export interface BridgedToolCalls {
  /**
   * @param reported - one tool name the harness reported for the call.
   * @returns the bridged dsh tool name, or undefined when the call is not bridged.
   */
  toolName(reported: string): string | undefined
  /**
   * Consume the settled bridged execution matching one logged `tool/call`.
   * @param tool - the dsh tool name {@link toolName} resolved.
   * @param argumentsJson - the serialized arguments `tool/call` logged.
   * @returns the completion carrying the execution `meta`, or undefined when
   *   no settled execution matches.
   */
  completion(tool: string, argumentsJson: string): { meta?: JsonValue } | undefined
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
    private readonly bridged?: BridgedToolCalls,
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
   * Bridged calls this turn logged under their dsh name, keyed by the
   * harness's call id so {@link toolResult} can pick up the settled
   * execution's `meta`. Turn-scoped: the map dies with the projector.
   */
  private readonly bridgedCalls = new Map<string, { name: string; argumentsJson: string }>()

  /**
   * Attempts this projector opened and has not yet settled. Settlement removes
   * its attempt even when the commit throws; a driver-side
   * {@link AssistantStreamAttempt.abandon} leaves an ended entry that
   * {@link openAssistant} skips.
   */
  private readonly openAttempts = new Set<AssistantStreamAttempt>()

  /** Model route most recently committed through {@link noteRoute}. */
  private route: { provider: string; model: string } | undefined

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
    this.openAttempts.add(attempt)
    attempt.start()
    return attempt
  }

  /**
   * The most recently opened attempt still streaming, if any. {@link toolCall}
   * folds a mid-stream call's advertisement into it; drivers whose lane
   * bookkeeping points at a settled attempt check `ended` and reopen.
   */
  private openAssistant(): AssistantStreamAttempt | undefined {
    let latest: AssistantStreamAttempt | undefined
    for (const attempt of this.openAttempts) {
      if (!attempt.ended) latest = attempt
    }
    return latest
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
    try {
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
    } finally {
      this.openAttempts.delete(attempt)
    }
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
    try {
      attempt.settle('assistant/attempt', () => (committed = this.session.append('assistant/attempt', {
        turn: this.turn,
        step: this.step,
        stream: attempt.stream,
      })).seq)
    } finally {
      this.openAttempts.delete(attempt)
    }
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
   * Commit one harness tool invocation record. Every call — bridged or not —
   * is first advertised as a `tool-call` block on a committed
   * `assistant/message` (see {@link advertiseToolCall}), so the durable
   * transcript's tool lifecycle matches a dsh-loop call's. When the
   * reported name — or `options.alias`, a second name the harness carries for
   * the same call — resolves to a bridged dsh tool, the record logs under the
   * dsh name so tool presenters apply, while `arguments` stays the
   * harness's report.
   * @param callId - foreign call identity; paired with its `tool/result`.
   * @param name - foreign tool name as the harness reported it.
   * @param argsJson - raw JSON arguments exactly as reported.
   * @param options - `alias` is the canonical `mcp__<server>__<tool>` name a
   *   harness carries separately from the display `name`.
   * @returns the committed event.
   * @throws when no route was noted for the turn — the advertisement needs the
   *   provider/model source (see {@link advertiseToolCall}).
   */
  toolCall(
    callId: string,
    name: string,
    argsJson: string,
    options: { alias?: string } = {},
  ): SessionEvent<'tool/call'> {
    const dsh = this.bridged === undefined ? undefined
      : (options.alias === undefined ? undefined : this.bridged.toolName(options.alias))
        ?? this.bridged.toolName(name)
    this.advertiseToolCall(callId, dsh ?? name, argsJson)
    const committed = this.session.append('tool/call', {
      turn: this.turn,
      step: this.step,
      callId: brandString<ToolCallId>(callId),
      name: dsh ?? name,
      arguments: argsJson,
    })
    // The correlation entry exists only once both appends committed, so a
    // failed advertisement or call leaves nothing for `toolResult` to consume.
    if (dsh !== undefined) this.bridgedCalls.set(callId, { name: dsh, argumentsJson: argsJson })
    return committed
  }

  /**
   * Commit the durable `assistant/message` advertising one harness-reported
   * call before its `tool/call` append. A call arriving while an assistant
   * attempt is still streaming folds the `tool-call` block into that attempt
   * and settles it — the shape a dsh loop produces when text precedes a
   * call; the driver continues streaming on a fresh attempt. With no open
   * attempt a standalone single-block message stands in.
   * @param callId - foreign call identity the block advertises.
   * @param name - the tool name the block advertises.
   * @param argumentsJson - serialized arguments the block advertises.
   * @throws when the turn never noted a route: the advertisement needs the
   *   provider/model source, so a driver that skipped {@link noteRoute} fails
   *   loudly instead of committing an unadvertised `tool/call`.
   */
  private advertiseToolCall(callId: string, name: string, argumentsJson: string): void {
    const route = this.route
    if (route === undefined) {
      throw new Error(
        `external tool call "${callId}" arrived before noteRoute recorded this turn's model route`,
      )
    }
    const attempt = this.openAssistant() ?? this.beginAssistant()
    attempt.pushToolCall(brandString<ToolCallId>(callId), name, argumentsJson)
    attempt.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    this.commitAssistant(attempt, route)
  }

  /**
   * Commit one completed harness tool call's result. `content` is exactly
   * what the harness's model saw; when the call was bridged, the logged
   * `meta` comes from the settled dsh execution instead.
   * @param callId - identity of the paired `tool/call`.
   * @param content - model-facing result blocks.
   * @param options - `isError` marks the block; `error` carries the failure
   *   identity (allowed only with `isError`); `meta` is the JSON-serializable
   *   card payload the producing driver reads back for presentation and
   *   overrides the bridged execution's `meta` when both exist.
   * @returns the committed event.
   */
  toolResult(
    callId: string,
    content: ContentBlock[],
    options: { isError?: boolean; error?: { name: string; code: string }; meta?: JsonValue } = {},
  ): SessionEvent<'tool/result'> {
    const isError = options.isError === true
    const toolCallId = brandString<ToolCallId>(callId)
    // A bridged call's settled execution owns the presentation `meta`; an
    // explicit `options.meta` wins when a driver supplies its own payload.
    // The completion is consumed either way so it cannot match a later call.
    const pending = this.bridgedCalls.get(callId)
    this.bridgedCalls.delete(callId)
    const completion = pending === undefined ? undefined
      : this.bridged?.completion(pending.name, pending.argumentsJson)
    const meta = options.meta ?? completion?.meta
    return this.session.append('tool/result', {
      turn: this.turn,
      step: this.step,
      message: createToolResultMessage({ callId: toolCallId, content, isError }),
      ...options.error === undefined || !isError ? {} : { error: options.error },
      ...meta === undefined ? {} : { meta },
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
    this.route = { provider: route.provider, model: route.model }
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
