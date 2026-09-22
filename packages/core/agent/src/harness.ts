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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { HarnessId } from './types.ts'

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
 * Read the harness recorded in a persisted log, for a resume that must resolve
 * the owning factory before an agent exists.
 * @param events - the persisted session events, oldest first.
 * @returns the last recorded harness id, or `undefined` when the log holds none.
 */
export function recordedHarness(events: readonly SessionEvent[]): HarnessId | undefined {
  let harness: string | undefined
  for (const event of events) {
    if (event.type !== 'agent/harness') continue
    const value = (event.data as { harness?: unknown }).harness
    if (typeof value === 'string' && value !== '') harness = value
  }
  // The projection owns validation for live reads; this path only routes, and
  // an unknown id fails loudly in the registry with the mounted ids listed.
  return harness === undefined ? undefined : harness as HarnessId
}
