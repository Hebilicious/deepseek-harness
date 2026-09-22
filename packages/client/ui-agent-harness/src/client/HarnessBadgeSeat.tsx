/**
 * The harness mark beside a Session's title.
 *
 * A session's harness is a durable fact about the conversation, so the header
 * shows it for every session rather than only where a choice existed: a reader
 * scanning the transcript needs to know which harness produced it, and the
 * deployment may mount one harness or several. The mark carries no control,
 * because the harness is fixed at creation.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { HarnessBadge } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the header seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentHarnessSeatState } from './seat-store.ts'
import css from './HarnessBadgeSeat.module.css'

/** Registration-side business face for the header mark. */
export interface HarnessBadgeSeatInjected {
  hooks: {
    /** Seat snapshot bound by the renderer as useAgentHarnessSeat. */
    agentHarnessSeat: SnapshotStore<AgentHarnessSeatState>
  }
  /** Read the mounted harnesses when the mark first renders. */
  load: () => Promise<void>
}

/** Full component props. */
export type HarnessBadgeSeatProps =
  PropsRuntime<'conversation.session.header.harness'>
  & PropsLocale<'agentHarness'>
  & InjectFace<HarnessBadgeSeatInjected>

/**
 * Render the mark of the harness that owns this session.
 * @param props - composed slot props.
 * @returns the badge, or null while the session records no harness.
 */
export function HarnessBadgeSeat({
  useProjection, useAgentHarnessSeat,
}: HarnessBadgeSeatProps) {
  const recorded = useProjection('agentHarness')
  const state = useAgentHarnessSeat(snapshot => snapshot)
  if (recorded === null || recorded === undefined) return null
  // The catalog names the harness; an id it does not carry yet still marks the
  // session, labelled by the id itself.
  const label = state.harnesses.find(entry => entry.id === recorded)?.name ?? recorded
  return <HarnessBadge harnessId={recorded} label={label} size={16} className={css.mark} />
}
