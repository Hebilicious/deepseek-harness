/**
 * Projection of committed Session events onto agent activity records and spans.
 * Records carry identifiers, names, counts, durations, and outcomes; prompt
 * text, tool arguments, tool output, and model output are never read into them.
 */
import { ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Span, type Tracer } from '@opentelemetry/api'
import type { OTelEventRecord, OTelEventScalar } from '@deepseek-ai/dsh-otel'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'

/** Session fields read by the recorder. */
export interface ObservedSession {
  readonly id: SessionId
  readonly header: Pick<SessionHeader, 'parentSession' | 'origin' | 'delegationDepth' | 'agentPreset'>
  /** Events below this sequence number are restored history and are ignored. */
  readonly firstLiveSeq: number
}

/** Destinations of the recorder's output; an absent destination receives nothing. */
export interface ActivitySinks {
  /** Receives one `dsh.*` log record per reported activity. */
  readonly events?: { emit(record: OTelEventRecord): void }
  /** Creates turn, model-request, and tool spans. */
  readonly tracer?: Tracer
}

type Scalars = Record<string, OTelEventScalar>

interface TurnState {
  readonly index: number
  readonly startedAt: number
  readonly span?: Span
  steps: number
  /** Attempt number of the latest model attempt that committed no message, until a later message commits. */
  uncommittedAttempt?: number
  toolCalls: number
  toolFailures: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

interface StepState {
  readonly index: number
  attemptStartedAt: number
  attempts: number
  span?: Span
}

interface ToolState {
  readonly name: string
  readonly startedAt: number
  readonly span?: Span
  decision?: string
}

interface SessionState {
  readonly sessionId: SessionId
  readonly identity: Scalars
  provider?: string
  model?: string
  turn?: TurnState
  step?: StepState
  readonly tools: Map<string, ToolState>
  readonly approvals: Map<string, { toolName: string; callId?: string }>
}

/**
 * Stateful per-Session projection. The caller feeds every committed event of
 * every live Session in append order and closes Sessions when they leave the
 * store; open spans then end without an outcome.
 */
export class AgentActivityRecorder {
  private readonly sessions = new Map<SessionId, SessionState>()

  /** @param sinks - log and span destinations selected by the owning plugin. */
  constructor(private readonly sinks: ActivitySinks) {}

  /**
   * Project one committed event.
   * @param session - the Session whose log grew.
   * @param event - the appended event.
   */
  observe(session: ObservedSession, event: SessionEvent): void {
    if (event.seq < session.firstLiveSeq) return
    const state = this.stateOf(session, event)
    switch (event.type) {
      case 'request/header':
        state.provider = event.data.header.config.provider
        state.model = event.data.header.config.model
        return
      case 'turn/start': {
        this.endTurn(state, event.time, undefined)
        const span = this.sinks.tracer?.startSpan('dsh.turn', {
          startTime: new Date(event.time),
          attributes: { ...state.identity, 'prompt.id': promptId(session.id, event.data.turn), turn: event.data.turn },
        }, this.parentContext(session))
        state.turn = { index: event.data.turn, startedAt: event.time, ...span && { span }, steps: 0, toolCalls: 0,
          toolFailures: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
        return
      }
      case 'user/message': {
        if (event.data.source.kind !== 'user') return
        const length = event.data.content.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0)
        this.emit(state, 'dsh.user_prompt', event, { prompt_length: length }, state.turn?.span)
        return
      }
      case 'step/start': {
        this.endStep(state, event.time)
        if (state.turn !== undefined) state.turn.steps++
        state.step = { index: event.data.step, attemptStartedAt: event.time, attempts: 1 }
        return
      }
      case 'llm/retry-started':
        if (state.step === undefined) return
        state.step.attemptStartedAt = event.time
        state.step.attempts = event.data.retry + 1
        return
      case 'llm/retry': {
        const failure = event.data.failure
        const fields: Scalars = { ...this.modelFields(state), error_code: failure.code, attempt: event.data.retry,
          ...failure.status === undefined ? {} : { status_code: failure.status },
          ...state.step === undefined ? {} : { duration_ms: event.time - state.step.attemptStartedAt } }
        const span = state.step?.span
        this.emit(state, 'dsh.api_error', event, fields, span)
        span?.addEvent('dsh.api_error', fields, new Date(event.time))
        span?.end(new Date(event.time))
        if (state.step !== undefined) delete state.step.span
        return
      }
      case 'assistant/message': {
        state.provider = event.data.message.source.provider
        state.model = event.data.message.source.model
        const usage = event.data.usage
        const span = this.stepSpan(state, event.time)
        const fields: Scalars = {
          ...this.modelFields(state),
          ...state.step === undefined ? {} : { duration_ms: event.time - state.step.attemptStartedAt, attempt: state.step.attempts },
          ...usage === undefined ? {} : {
            input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
            ...usage.cacheReadTokens === undefined ? {} : { cache_read_tokens: usage.cacheReadTokens },
            ...usage.cacheWriteTokens === undefined ? {} : { cache_creation_tokens: usage.cacheWriteTokens },
            ...usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens },
          },
          ...event.data.interrupted === true ? { interrupted: true } : {},
        }
        if (state.turn !== undefined) delete state.turn.uncommittedAttempt
        if (usage !== undefined && state.turn !== undefined) {
          state.turn.inputTokens += usage.inputTokens
          state.turn.outputTokens += usage.outputTokens
          state.turn.cacheReadTokens += usage.cacheReadTokens ?? 0
          state.turn.cacheCreationTokens += usage.cacheWriteTokens ?? 0
        }
        this.emit(state, 'dsh.api_request', event, fields, span)
        span?.setAttributes(fields)
        span?.end(new Date(event.time))
        if (state.step !== undefined) delete state.step.span
        return
      }
      case 'assistant/attempt': {
        // The span stays open for a following llm/retry record; step/end closes it otherwise.
        const span = this.stepSpan(state, event.time)
        span?.setAttributes(this.modelFields(state))
        span?.setStatus({ code: SpanStatusCode.ERROR, message: 'attempt committed no message' })
        if (state.turn !== undefined) state.turn.uncommittedAttempt = state.step?.attempts ?? 1
        return
      }
      case 'step/end':
        this.endStep(state, event.time)
        return
      case 'tool/call': {
        const fields = toolFields(event.data.name, event.data.callId)
        const span = this.sinks.tracer?.startSpan('dsh.tool', {
          startTime: new Date(event.time), attributes: { ...this.position(state), ...fields },
        }, this.turnContext(state))
        state.tools.set(event.data.callId, { name: event.data.name, startedAt: event.time, ...span && { span } })
        if (state.turn !== undefined) state.turn.toolCalls++
        return
      }
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const tool = state.tools.get(callId)
        state.tools.delete(callId)
        const success = event.data.message.isError !== true
        if (!success && state.turn !== undefined) state.turn.toolFailures++
        const fields: Scalars = {
          ...tool === undefined ? { call_id: callId } : toolFields(tool.name, callId), success,
          ...tool === undefined ? {} : { duration_ms: event.time - tool.startedAt },
          ...success ? {} : { error_code: event.data.error?.code ?? 'TOOL_ERROR' },
          ...tool?.decision === undefined ? {} : { decision: tool.decision },
        }
        this.emit(state, 'dsh.tool_result', event, fields, tool?.span)
        if (tool?.span !== undefined) {
          tool.span.setAttributes(fields)
          if (!success) tool.span.setStatus({ code: SpanStatusCode.ERROR, message: String(fields.error_code) })
          tool.span.end(new Date(event.time))
        }
        return
      }
      case 'approval/asked':
        state.approvals.set(event.data.id, {
          toolName: event.data.toolName, ...event.data.callId === undefined ? {} : { callId: event.data.callId },
        })
        return
      case 'approval/decided': {
        const asked = state.approvals.get(event.data.id)
        state.approvals.delete(event.data.id)
        const tool = asked?.callId === undefined ? undefined : state.tools.get(asked.callId)
        if (tool !== undefined) tool.decision = event.data.outcome
        const fields: Scalars = {
          ...asked === undefined ? {} : toolFields(asked.toolName, asked.callId),
          decision: event.data.outcome, source: 'approval',
        }
        tool?.span?.addEvent('dsh.tool_decision', fields, new Date(event.time))
        this.emit(state, 'dsh.tool_decision', event, fields, tool?.span)
        return
      }
      case 'turn/end': {
        const reason = event.data.reason
        let failure: Scalars = {}
        if (reason.kind === 'error') {
          failure = { error_code: reason.error.code, ...reason.error.status === undefined ? {} : { status_code: reason.error.status } }
          const attempt = state.turn?.uncommittedAttempt
          if (attempt !== undefined) this.emit(state, 'dsh.api_error', event, { ...this.modelFields(state), ...failure, attempt }, state.turn?.span)
        }
        this.endTurn(state, event.time, {
          outcome: reason.kind, ...failure,
          ...reason.kind === 'aborted' ? { cancel_cause: reason.reason.kind } : {},
        }, event)
        return
      }
      default:
        // Other Session events carry no activity reported here.
        return
    }
  }

  /**
   * End a Session's open spans without an outcome and forget its state.
   * @param id - the Session leaving the store.
   * @param time - Unix milliseconds at which open spans end.
   */
  close(id: SessionId, time: number): void {
    const state = this.sessions.get(id)
    if (state === undefined) return
    this.sessions.delete(id)
    for (const tool of state.tools.values()) tool.span?.end(new Date(time))
    this.endStep(state, time)
    this.endTurn(state, time, undefined)
  }

  /**
   * End every open span, as at unload.
   * @param time - Unix milliseconds at which open spans end.
   */
  closeAll(time: number): void {
    for (const id of [...this.sessions.keys()]) this.close(id, time)
  }

  private stateOf(session: ObservedSession, event: SessionEvent): SessionState {
    const existing = this.sessions.get(session.id)
    if (existing !== undefined) return existing
    const header = session.header
    const identity: Scalars = {
      'session.id': session.id,
      ...header.parentSession === undefined ? {} : { 'parent_session.id': header.parentSession },
      ...header.origin === undefined ? {} : { 'session.origin': header.origin },
      ...header.delegationDepth === undefined ? {} : { delegation_depth: header.delegationDepth },
      ...header.agentPreset === undefined ? {} : { agent_preset: header.agentPreset },
    }
    const state: SessionState = { sessionId: session.id, identity, tools: new Map(), approvals: new Map() }
    this.sessions.set(session.id, state)
    this.emit(state, 'dsh.session_start', event, { resumed: session.firstLiveSeq > 0 }, undefined)
    return state
  }

  /** A subagent's turn is a child of the parent's latest open tool span, else of the parent's open turn span. */
  private parentContext(session: ObservedSession) {
    const parentId = session.header.parentSession
    const parent = parentId === undefined ? undefined : this.sessions.get(parentId)
    if (parent === undefined) return ROOT_CONTEXT
    const tools = [...parent.tools.values()].filter(tool => tool.span !== undefined)
    const span = tools.at(-1)?.span ?? parent.turn?.span
    return span === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, span)
  }

  /** The current step's model-request span, started on first use at the attempt's start time. */
  private stepSpan(state: SessionState, time: number): Span | undefined {
    const step = state.step
    if (step === undefined || this.sinks.tracer === undefined) return undefined
    step.span ??= this.sinks.tracer.startSpan('dsh.llm_request', {
      startTime: new Date(Math.min(step.attemptStartedAt, time)),
      attributes: this.position(state),
    }, this.turnContext(state))
    return step.span
  }

  private endStep(state: SessionState, time: number): void {
    state.step?.span?.end(new Date(time))
    delete state.step
  }

  private endTurn(state: SessionState, time: number, outcome: Scalars | undefined, event?: SessionEvent): void {
    const turn = state.turn
    if (turn === undefined) return
    this.endStep(state, time)
    const fields: Scalars = {
      ...this.modelFields(state), ...outcome, duration_ms: time - turn.startedAt, steps: turn.steps,
      tool_calls: turn.toolCalls, tool_failures: turn.toolFailures,
      input_tokens: turn.inputTokens, output_tokens: turn.outputTokens,
      cache_read_tokens: turn.cacheReadTokens, cache_creation_tokens: turn.cacheCreationTokens,
    }
    if (event !== undefined) this.emit(state, 'dsh.turn_end', event, fields, turn.span)
    delete state.turn
    if (turn.span === undefined) return
    turn.span.setAttributes(fields)
    if (outcome?.outcome === 'error') turn.span.setStatus({ code: SpanStatusCode.ERROR, message: String(outcome.error_code) })
    turn.span.end(new Date(time))
  }

  private modelFields(state: SessionState): Scalars {
    return {
      ...state.provider === undefined ? {} : { provider: state.provider },
      ...state.model === undefined ? {} : { model: state.model },
    }
  }

  /** Session identity plus the open turn and step. */
  private position(state: SessionState): Scalars {
    const turn = state.turn?.index
    return {
      ...state.identity,
      ...turn === undefined ? {} : { 'prompt.id': promptId(state.sessionId, turn), turn },
      ...state.step === undefined ? {} : { step: state.step.index },
    }
  }

  private turnContext(state: SessionState) {
    return state.turn?.span === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, state.turn.span)
  }

  private emit(state: SessionState, name: string, event: SessionEvent, fields: Scalars, span: Span | undefined): void {
    const events = this.sinks.events
    if (events === undefined) return
    const attributes: Attributes & Scalars = {
      ...this.position(state),
      'event.name': name,
      'event.timestamp': new Date(event.time).toISOString(),
      'event.sequence': event.seq,
      ...fields,
    }
    events.emit({ eventName: name, body: name, timestamp: event.time, attributes, ...span && { spanContext: span.spanContext() } })
  }
}

/** Turn identifier unique across Sessions. */
function promptId(sessionId: SessionId, turn: number): string {
  return `${sessionId}:${turn}`
}

/** Tool identity, splitting MCP tools named `mcp__<server>__<tool>` into server and tool names. */
function toolFields(name: string, callId: string | undefined): Scalars {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name) ?? []
  return {
    tool_name: name,
    ...callId === undefined ? {} : { call_id: callId },
    ...server === undefined || tool === undefined ? {} : { mcp_server_name: server, mcp_tool_name: tool },
  }
}
