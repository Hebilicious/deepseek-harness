/**
 * Durable Codex thread binding: the plugin-owned session event that records
 * which app-server thread a session owns, and the projection that reads it
 * back on resume.
 *
 * @module @deepseek-ai/dsh-agent-codex/thread-state
 */

import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The Codex thread this session is bound to. Appended by the driver at
     * bind time after `thread/start`, before the agent is published, and
     * once more when a recorded thread has no rollout left to resume. Resume
     * reads the fold to call `thread/resume` on the newest identity.
     * Log-only: the foreign thread id is not model-visible content.
     */
    'agent-codex/thread': {
      /** Opaque Codex thread id (UUIDv7) returned by `thread/start`. */
      threadId: string
    }
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

/**
 * Host-only fold of the durable thread binding. A bind appends the event once;
 * a later event rebinds the session when the recorded thread cannot be
 * resumed, so the fold keeps the newest identity and the next resume targets
 * the live thread.
 */
export const codexThreadProjection = {
  key: 'codexThread',
  stateVersion: 1,
  stateSchema: codexThreadStateSchema,
  init: (): CodexThreadState | null => null,
  apply: (state, event) => {
    if (event.type !== 'agent-codex/thread') return state
    const { threadId } = event.data
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error(`invalid agent-codex/thread at seq ${event.seq}`)
    }
    return { threadId }
  },
} satisfies ProjectionDefinition<'codexThread', CodexThreadState | null>

/**
 * Read the session's bound Codex thread id.
 * @param threads - registration handle of {@link codexThreadProjection}.
 * @param session - session whose log is folded.
 * @returns the bound thread id, or `undefined` before `thread/start` committed.
 */
export function codexThreadOf(
  threads: Pick<ProjectionHandle<CodexThreadState | null>, 'stateOf'>,
  session: Session,
): string | undefined {
  return threads.stateOf(session)?.threadId
}
