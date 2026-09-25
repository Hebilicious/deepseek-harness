/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { OptionalSessionSeq, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TypertContext, TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}

/** Merge-extensible agent creation options. Persona belongs to system-prompt sections. */
export interface AgentOptions {
  /** Provider route (must have a registered adapter at call time). */
  provider?: string
  /** Model id interpreted by the selected provider adapter. */
  model?: string
  /** Adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: ReasoningEffortId
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }

  interface TypertContextMap {
    /** Agent Context identity shared by Host and Client adapters. */
    agent: TypertContext<SessionId>
  }
}

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

/** Complete pending Inbox value reconstructed from durable splices. */
export interface InboxState {
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}

/**
 * Wire-JSON pending Inbox value. Each message round-trips the session log
 * losslessly, but the fold state's full `UserMessage` type cannot cross a
 * typert Remote boundary (its source union carries an `unknown` replay
 * field), so the typed projection table keeps this JSON-safe form.
 */
export interface InboxWireState {
  readonly 'next-turn': readonly JsonValue[]
  readonly 'next-step': readonly JsonValue[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxState
    /** The harness that owns this session's agent, or null before the record. */
    agentHarness: string | null
  }
  interface SessionProjectionMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxWireState
    /**
     * The harness that owns this session's agent, or null before the record.
     * Client surfaces report it read-only: a session never changes harness.
     */
    agentHarness: string | null
  }
}

/**
 * Turn and step boundaries folded from one agent session log.
 *
 * Reader contract: the key is registered by `dsh-agent-loop` and absent
 * otherwise. Without agent-loop no turn events exist, so readers treat an
 * absent key as "no open turn / no boundaries" — capability absence, not a
 * corrupt state. A reader whose behavior has no safe fallback for that
 * absence (the step-open decision, for example) may fail loud instead.
 */
export interface TurnBoundaryProjection {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: OptionalSessionSeq
  /** Seq of the latest `step/start` event, or null before the first step. */
  readonly lastStepStartSeq: OptionalSessionSeq
  /** The latest step boundary (`step/start` or `step/end`) and its seq, or null before the first step boundary. */
  readonly lastStepBoundary: { readonly kind: 'start' | 'end'; readonly seq: SessionSeq } | null
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * The session-projection registry applies the committed event before
     * `Session.append()` returns; Inbox live notifications follow that commit.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
  }
}

/** Stable id of one agent harness a deployment can create sessions with. */
export type HarnessId = Branded<'HarnessId'>

/**
 * Brand a string as a {@link HarnessId}.
 * @param id - the harness id, unique within one process.
 * @returns the same string with the harness-id brand.
 */
export function HarnessId(id: string): HarnessId {
  return brandString<HarnessId>(id)
}

/** One agent harness a deployment can create sessions with, as consumers see it. */
export interface AgentHarness {
  /** Stable id carried on create, resume, and the session's durable record. */
  readonly id: HarnessId
  /** Human-readable name for a harness picker. */
  readonly name: string
  /** One sentence on what runs the session, for a harness picker. */
  readonly description?: string
  /**
   * The catalog-only LLM provider route that lists this harness's own models.
   * A session under this harness selects only from that route, and no other
   * harness selects from it. Absent for a harness that sends its requests
   * through the deployment's LLM providers, which may use every route no
   * harness claims.
   */
  readonly modelProvider?: string
}
