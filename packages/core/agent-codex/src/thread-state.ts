/**
 * Durable Codex thread binding: the plugin-owned session event that records
 * which app-server thread a session owns, and the projection that reads it
 * back on resume.
 *
 * @module @deepseek-ai/dsh-agent-codex/thread-state
 */

import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The Codex thread this session is bound to. Appended once by the driver
     * after `thread/start`, inside the pre-publication suffix; resume reads
     * the fold to call `thread/resume` on the same identity. Log-only: the
     * foreign thread id is not model-visible content.
     */
    'agent-codex/thread': {
      /** Opaque Codex thread id (UUIDv7) returned by `thread/start`. */
      threadId: string
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The session's bound Codex thread id, or null before binding. */
    codexThread: CodexThreadState | null
  }
}

/** The folded {@link codexThreadProjection} state. */
export interface CodexThreadState {
  /** The bound Codex thread id. */
  readonly threadId: string
}

const codexThreadStateSchema: z.ZodType<CodexThreadState | null> = z.object({
  threadId: z.string().min(1),
}).nullable()

/** Host-only fold of the durable thread binding; a second binding event is a corrupt log. */
export const codexThreadProjection = {
  key: 'codexThread',
  stateVersion: 1,
  stateSchema: codexThreadStateSchema,
  init: (): CodexThreadState | null => null,
  apply: (state, event) => {
    if (event.type !== 'agent-codex/thread') return state
    if (state !== null) {
      throw new Error(`duplicate agent-codex/thread binding at seq ${event.seq}`)
    }
    const { threadId } = event.data
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error(`invalid agent-codex/thread at seq ${event.seq}`)
    }
    return { threadId }
  },
} satisfies ProjectionDefinition<'codexThread', CodexThreadState | null>

/**
 * Read the session's bound Codex thread id.
 * @param projections - registry that owns the projection.
 * @param session - session whose log is folded.
 * @returns the bound thread id, or `undefined` before `thread/start` committed.
 */
export function codexThreadOf(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): string | undefined {
  return projections.stateOf(session, 'codexThread')?.threadId
}
