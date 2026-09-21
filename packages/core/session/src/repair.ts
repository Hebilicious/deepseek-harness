/**
 * Crash-recovery repair for an interrupted session log. It preserves a fully
 * written final turn and supplies the missing tool, step, and turn boundaries
 * needed to resume with a provider-valid transcript.
 * @module @deepseek-ai/dsh-session/repair
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from './types.ts'
import type { SessionEvent, SessionEventMap, SessionSeq as SessionSeqType, SurfaceIntent } from './types.ts'

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** Model-facing recovery text for a call that never reached dispatch. */
const NOT_STARTED_TEXT = 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'

/** Model-facing recovery text for a recorded call whose outcome was never durably recorded. */
const OUTCOME_UNKNOWN_TEXT = 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'

/** One assistant tool call that produced no durable result. */
export interface UnresolvedToolCall {
  /** Provider-issued call identity, matching the assistant block that requested it. */
  callId: ToolCallId
  /** Turn owning the unanswered call. */
  turn: number
  /** Step owning the unanswered call. */
  step: number
  /** Seq of the recorded `tool/call` event, absent when the call never reached dispatch. */
  callSeq?: SessionSeqType
}

/** Complete recovery record for one unanswered assistant tool call. */
export interface ToolCallRecovery {
  /** Payload to append as a `tool/result` event. */
  data: SessionEventMap['tool/result']
  /** Surface placement, citing the recorded call when one exists. */
  intent: SurfaceIntent<'tool/result'>
}

/**
 * Build the durable recovery result for one unanswered assistant tool call.
 * Every provider transcript needs one result per assistant call, so a call that
 * failed before producing a result is closed with an error result whose text
 * tells the model how far the call got and whether retrying is safe. The
 * message id embeds `seq` because the session-format migrations recognize this
 * recovery shape by that canonical identity.
 *
 * @param call - the unanswered call and its recorded start, if any.
 * @param seq - sequence the event will occupy.
 * @returns the payload and surface placement to append.
 */
export function toolCallRecovery(call: UnresolvedToolCall, seq: SessionSeqType): ToolCallRecovery {
  const started = call.callSeq !== undefined
  const message: ToolResultMessage = deepFreeze({
    id: brandString<MessageId>(`interrupted-tool-result-${call.callId}-${seq}`),
    role: 'user',
    source: { kind: 'tool', callId: call.callId },
    content: [{
      type: 'tool-result',
      toolCallId: call.callId,
      isError: true,
      content: [{ type: 'text', text: started ? OUTCOME_UNKNOWN_TEXT : NOT_STARTED_TEXT }],
    }],
  })
  return {
    data: {
      turn: call.turn,
      step: call.step,
      message,
      error: started
        ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
        : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
    },
    intent: {
      surfaceOp: 'append',
      ...call.callSeq === undefined ? {} : { sourceEventSeqs: [call.callSeq] },
    },
  }
}

/**
 * Return deterministic synthetic events that close an open tail turn. Unmatched
 * calls receive error results first, followed by an open `step/end` and an
 * interrupted `turn/end`; sequences continue the log and timestamps reuse the
 * last real event. A balanced or empty log returns no events.
 *
 * @param events - the loaded durable log to scan (a valid committed prefix, possibly with a crash tail).
 * @returns the synthetic closer events to append after `events`, in order; empty when the log is already balanced.
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  // Reset at each turn boundary so earlier calls cannot leak into tail repair.
  // Assistant blocks register calls; later `tool/call` events add their seqs to `sourceEventSeqs`.
  const pendingCalls = new Map<ToolCallId, { step: number; callSeq?: SessionSeqType }>()
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        pendingCalls.clear()
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        pendingCalls.clear()
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        pendingCalls.clear()
        openStep = null
        break
      case 'assistant/message':
        // The assistant message carries the tool-call blocks; each is pending
        // until a tool/result event with the same callId is logged.
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') pendingCalls.set(block.id, { step: event.data.step })
        }
        break
      case 'tool/call':
        // Cite the `tool/call` seq from the synthetic result.
        {
          const entry = pendingCalls.get(event.data.callId)
          if (entry) {
            entry.callSeq = event.seq
          }
        }
        break
      case 'tool/result':
        pendingCalls.delete(event.data.message.source.callId)
        break
      // Other event types do not move the turn/step boundary cursor.
      default:
        break
    }
  }

  // Balanced log (no crash mid-turn): nothing to close. An open turn implies
  // `events` is non-empty (its turn/start was logged), so `last` exists.
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  // The last real event supplies the seq base and the timestamp for the
  // synthetic closers (reusing the last timestamp keeps them deterministic and
  // never invents a "future" time).
  let seq = last.seq + 1
  const time = last.time
  const closers: SessionEvent[] = []

  // Close calls before their step: providers reject dangling assistant calls,
  // and Map insertion order preserves their transcript order.
  for (const [callId, { step, callSeq }] of pendingCalls) {
    const recoverySeq = SessionSeq(seq++)
    const recovery = toolCallRecovery({
      callId,
      turn: openTurn,
      step,
      ...callSeq === undefined ? {} : { callSeq },
    }, recoverySeq)
    closers.push({ type: 'tool/result', seq: recoverySeq, time, ...recovery.intent, data: recovery.data })
  }

  // Close an open step next — a turn/end while a step is open is an invariant
  // violation, so the step's boundary must be synthesized before the turn's.
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, reason: { kind: 'interrupted' } } })
  return closers
}
