/**
 * The agent-harness chip on the new-session screen, beside the workspace and
 * agent-preset controls.
 *
 * The choice is only open before a session exists: a session's harness is
 * recorded when it is created, and the host refuses to hand the conversation
 * to a second harness. The chip therefore splits in two — a picker that stages
 * the harness for the next session, and a read-only label reporting what a
 * session already runs. A deployment that mounts fewer than two harnesses
 * renders neither, because a create request that names none resolves the sole
 * mounted harness.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HarnessId } from '@deepseek-ai/dsh-agent/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the hero seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentHarnessSeatState } from './seat-store.ts'
import css from './AgentHarnessSeat.module.css'

/** Registration-side business face for the hero chip. */
export interface AgentHarnessSeatInjected {
  hooks: {
    /** Seat snapshot bound by the renderer as useAgentHarnessSeat. */
    agentHarnessSeat: SnapshotStore<AgentHarnessSeatState>
  }
  /** Read the mounted harnesses when the chip first renders. */
  load: () => Promise<void>
  /** Stage one harness for the next session. */
  select: (harness: HarnessId) => void
}

/** Full component props. */
export type AgentHarnessSeatProps =
  PropsRuntime<'conversation.hero.agentHarness'>
  & PropsLocale<'agentHarness'>
  & InjectFace<AgentHarnessSeatInjected>

/**
 * Render the new-session agent-harness control.
 * @param props - composed slot props.
 * @returns the picker, a session's recorded harness, or null when the
 *   deployment mounts fewer than two harnesses.
 */
export function AgentHarnessSeat({
  sessionId, useProjection, load, select, useAgentHarnessSeat, t,
}: AgentHarnessSeatProps) {
  const state = useAgentHarnessSeat(snapshot => snapshot)
  const recorded = useProjection('agentHarness')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  // One mounted harness is no choice, and the host resolves it for a create
  // request that names none: the deployment keeps the composer it has today.
  if (state.harnesses.length < 2) return null

  const mounted = (id: string | null | undefined): AgentHarnessSeatState['harnesses'][number] | undefined =>
    id === null || id === undefined ? undefined : state.harnesses.find(harness => harness.id === id)

  if (sessionId !== undefined) {
    // A session that records no harness is one this deployment cannot run, or
    // one created before the record existed; a label with no fact would only
    // report the chip's own guess.
    if (recorded === null || recorded === undefined) return null
    const entry = mounted(recorded)
    return (
      <button
        type="button"
        className={css.seat}
        disabled
        title={entry?.description ?? t('sessionHint')}
      >
        <span className={css.seatLabel}>{entry?.name ?? recorded}</span>
      </button>
    )
  }

  const chosen = mounted(state.current)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={state.harnesses.map(harness => ({
        id: harness.id,
        // Name and description together: the id alone never says what runs
        // the session, which is why the catalog carries display copy.
        label: (
          <span className={css.item}>
            <span className={css.itemName}>{harness.name}</span>
            <span className={css.itemDesc}>{harness.description ?? t('noDescription')}</span>
          </span>
        ),
      }))}
      {...state.current === null ? {} : { selectedId: state.current }}
      onSelect={(id) => {
        setOpen(false)
        const picked = mounted(id)
        /* v8 ignore next -- the menu's rows ARE the catalog, so an emitted id always resolves */
        if (picked !== undefined) select(picked.id)
      }}
      align="start"
      portal
      className={css.menuAnchor}
      anchor={(
        <button
          type="button"
          className={css.seat}
          aria-haspopup="menu"
          aria-expanded={open}
          title={t('seatHint')}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className={css.seatLabel}>{chosen?.name ?? state.current ?? ''}</span>
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      )}
    />
  )
}
