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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /**
   * Whether the Session on screen is still provisional, so its harness is
   * chosen here rather than in a create request that already happened.
   */
  bindable: (sessionId: SessionId | undefined) => boolean
  /** Apply one pick to the Session on screen, or stage it for the next one. */
  select: (sessionId: SessionId | undefined, harness: HarnessId) => void
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
  sessionId, useProjection, load, bindable, select, useAgentHarnessSeat, t,
}: AgentHarnessSeatProps) {
  const state = useAgentHarnessSeat(snapshot => snapshot)
  const recorded = useProjection('agentHarness')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // A failed read leaves the chip on the state it has; a rejection nothing
    // awaits would surface as an unhandled rejection in the browser.
    void load().catch(() => { /* the chip keeps the state it has */ })
  }, [load])

  // One mounted harness is no choice, and the host resolves it for a create
  // request that names none: the deployment keeps the composer it has today.
  if (state.harnesses.length < 2) return null

  const mounted = (id: string | null | undefined): AgentHarnessSeatState['harnesses'][number] | undefined =>
    id === null || id === undefined ? undefined : state.harnesses.find(harness => harness.id === id)

  // A Session the Workspace flow already published is still provisional until
  // its first message, so its harness is chosen here rather than in a create
  // request that has already happened.
  const provisional = sessionId !== undefined && bindable(sessionId)

  if (sessionId !== undefined && !provisional) {
    // A session that records no harness, and can no longer take one, is one
    // this deployment cannot run or one whose first message already landed; a
    // label with no fact would only report the chip's own guess.
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

  // What the next message runs: what the Session already records, else the
  // choice staged for it, else the catalog's own opening choice.
  const current = recorded ?? state.current
  const chosen = mounted(current)
  // The label is empty while the catalog is between reads, so the trigger
  // always carries an accessible name; once a harness is staged that name
  // starts with the visible label, which voice control matches on.
  const triggerName = chosen === undefined ? t('seatHint') : t('seatHintNamed', { name: chosen.name })
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
      {...current === null ? {} : { selectedId: current }}
      onSelect={(id) => {
        setOpen(false)
        const picked = mounted(id)
        /* v8 ignore next -- the menu's rows ARE the catalog, so an emitted id always resolves */
        if (picked !== undefined) select(sessionId, picked.id)
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
          aria-label={triggerName}
          title={t('seatHint')}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className={css.seatLabel}>{chosen?.name ?? current ?? ''}</span>
          <IconChevronDownOutlineRegular className={css.chevron} />
        </button>
      )}
    />
  )
}
