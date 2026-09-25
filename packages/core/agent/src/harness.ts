/**
 * Durable record of which agent harness owns a session. The chosen harness
 * decides who drives every turn, so a resume must reach the same one: another
 * harness cannot continue the conversation, and the recorded id is what tells
 * the shell which factory to call.
 *
 * The record is a session event rather than header metadata because a header
 * field addition is a structural Session-format change, while a new log-only
 * event is a same-version addition that older builds that understand the
 * vocabulary can still read.
 *
 * @module @deepseek-ai/dsh-agent/harness
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { HarnessId } from './types.ts'
import type { AgentHarness } from './types.ts'

/**
 * Harness id under which the in-process agent loop registers itself
 * (`@deepseek-ai/dsh-agent-loop`). Only a session owned by this harness
 * consumes the loop's scoped composition: `tools.restrict()`, `systemPrompt`
 * sections, and the structured-output runtime.
 */
export const LOOP_HARNESS_ID = HarnessId('dsh')

/**
 * The harnesses a Session may run while selecting a model from one provider.
 *
 * A harness that declares a `modelProvider` owns that route alone: the route
 * lists its models and serves no model calls. Every other route is sent through
 * the deployment's LLM providers, so it serves exactly the harnesses that
 * declare no `modelProvider`.
 * @param harnesses - the mounted harnesses.
 * @param provider - one LLM provider route id.
 * @returns the ids of the harnesses that can drive `provider`, in registration order.
 */
export function harnessesServing(harnesses: readonly AgentHarness[], provider: string): HarnessId[] {
  const owner = harnesses.find(harness => harness.modelProvider === provider)
  if (owner !== undefined) return [owner.id]
  return harnesses.filter(harness => harness.modelProvider === undefined).map(harness => harness.id)
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The agent harness this session's agent belongs to. Appended once, by the
     * harness's own factory, before the session is published. Log-only: the
     * harness id is not model-visible content.
     */
    'agent/harness': { harness: string }
  }
}

const agentHarnessSchema: z.ZodType<string | null> = z.string().min(1).nullable()

/**
 * Fold of the durable harness record. A second record for a session
 * that already named a harness is a corrupt log rather than a rebind: one
 * session is never handed from one harness to another.
 */
export const agentHarnessProjectionDefinition = {
  key: 'agentHarness',
  stateVersion: 1,
  stateSchema: agentHarnessSchema,
  init: (): string | null => null,
  apply: (state, event) => {
    if (event.type !== 'agent/harness') return state
    if (state !== null) {
      throw new Error(`duplicate agent/harness at session seq ${event.seq}`)
    }
    const { harness } = event.data
    if (typeof harness !== 'string' || harness === '') {
      throw new Error(`invalid agent/harness at session seq ${event.seq}`)
    }
    return harness
  },
  wire: { viewSchema: agentHarnessSchema, view: state => state },
} satisfies ProjectionDefinition<'agentHarness', string | null>

/**
 * Read the harness that owns a live session's agent.
 * @param projections - registry that owns the projection.
 * @param session - session whose log is folded.
 * @returns the recorded harness id, or `undefined` before the record exists.
 */
export function agentHarnessOf(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): string | undefined {
  return projections.stateOf(session, 'agentHarness') ?? undefined
}

/**
 * Read the harness that owns a live session's agent, for a caller that creates
 * or resumes a descendant of that session.
 *
 * A child belongs to the same harness as the session it descends from, which is
 * what the single-harness world did implicitly: the caller passes the result as
 * the create/resume `harness`. A session recording no harness yields
 * `undefined`, and the fallback then differs by operation — a resume resolves
 * the harness that claims unrecorded logs (the in-process loop, else the sole
 * mounted harness), while a fresh child may fall back only to the sole mounted
 * harness, so no caller invents a harness id for it. The
 * projection registry is optional; without one this read has nothing to fold
 * and yields `undefined` too.
 * @param ctx - context the projection registry is resolved from.
 * @param session - live session whose log is folded.
 * @returns the recorded harness id, or `undefined` when the session records none.
 */
export function harnessOwning(ctx: Context, session: Session): HarnessId | undefined {
  const projections: Pick<SessionProjectionRegistry, 'stateOf'> | undefined = ctx.get('sessionProjections')
  if (projections === undefined) return undefined
  const recorded = agentHarnessOf(projections, session)
  return recorded === undefined ? undefined : HarnessId(recorded)
}

/**
 * Read the harness recorded in a persisted log, for a resume that must resolve
 * the owning factory before an agent exists.
 *
 * A log recording two different harnesses is corrupt rather than rebound: one
 * session is never handed from one harness to another, so routing to the later
 * id would resume a conversation the earlier harness owns. A repeat of the same
 * id answers with that id, which is what a resume into a seed carrying the
 * record produces; the live fold is the stricter reader and rejects any second
 * record, so a log this scanner accepts is still refused where a live session
 * folds it. Malformed or empty values are skipped, because the fold owns
 * their validation for live reads and an unknown id fails loudly in the
 * registry with the mounted ids listed.
 * @param events - the persisted session events, oldest first.
 * @returns the recorded harness id, or `undefined` when the log holds none.
 * @throws when the log records two different harnesses.
 */
export function recordedHarness(events: readonly SessionEvent[]): HarnessId | undefined {
  let harness: string | undefined
  for (const event of events) {
    if (event.type !== 'agent/harness') continue
    const value = (event.data as { harness?: unknown }).harness
    if (typeof value !== 'string' || value === '') continue
    if (harness !== undefined && harness !== value) {
      throw new Error(`duplicate agent/harness at session seq ${event.seq}`)
    }
    harness = value
  }
  return harness === undefined ? undefined : harness as HarnessId
}
