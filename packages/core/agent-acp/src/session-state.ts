/**
 * Durable ACP session binding: the plugin-owned session event that records
 * which agent-side session a DSH session owns, and the projection that reads
 * it back on resume.
 *
 * @module @deepseek-ai/dsh-agent-acp/session-state
 */

import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The ACP session this session is bound to. Appended by the driver after
     * `session/new`, inside the pre-publication suffix; resume reads the fold
     * to call `session/load` on the same identity. A later record replaces
     * the binding: resume appends one when the agent no longer knows a
     * session that no turn reached. Log-only: the foreign session id is not
     * model-visible content.
     */
    'agent-acp/session': {
      /** Opaque agent-issued ACP session id returned by `session/new`. */
      sessionId: string
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The session's bound ACP session id, or null before binding. */
    acpSession: AcpSessionState | null
  }
}

/** The folded {@link acpSessionProjection} state. */
export interface AcpSessionState {
  /** The bound ACP session id. */
  readonly sessionId: string
}

const acpSessionStateSchema: z.ZodType<AcpSessionState | null> = z.object({
  sessionId: z.string().min(1),
}).nullable()

/** Host-only fold of the durable session binding; the latest binding event wins. */
export const acpSessionProjection = {
  key: 'acpSession',
  stateVersion: 1,
  stateSchema: acpSessionStateSchema,
  init: (): AcpSessionState | null => null,
  apply: (state, event) => {
    if (event.type !== 'agent-acp/session') return state
    const { sessionId } = event.data
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`invalid agent-acp/session at seq ${event.seq}`)
    }
    return { sessionId }
  },
} satisfies ProjectionDefinition<'acpSession', AcpSessionState | null>

/**
 * Read the session's bound ACP session id.
 * @param projections - registry that owns the projection.
 * @param session - session whose log is folded.
 * @returns the bound session id, or `undefined` before `session/new` committed.
 */
export function acpSessionOf(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): string | undefined {
  return projections.stateOf(session, 'acpSession')?.sessionId
}
