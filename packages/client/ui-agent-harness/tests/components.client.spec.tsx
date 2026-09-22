// @vitest-environment jsdom
/**
 * The new-session harness chip: a picker while no session exists, and the
 * harness a session already runs once one does. The split is the host's rule —
 * a session is created with its harness, and a second harness cannot continue
 * the conversation — so both postures are asserted here.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HarnessId } from '@deepseek-ai/dsh-agent/types'
import type { SessionHarnessOption } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentHarnessSeat } from '../src/client/AgentHarnessSeat.tsx'
import { HarnessBadgeSeat } from '../src/client/HarnessBadgeSeat.tsx'
import type { HarnessBadgeSeatProps } from '../src/client/HarnessBadgeSeat.tsx'
import type { AgentHarnessSeatProps } from '../src/client/AgentHarnessSeat.tsx'
import type { AgentHarnessSeatState } from '../src/client/seat-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const hid = (value: string): HarnessId => value as HarnessId

const MOUNTED: readonly SessionHarnessOption[] = [
  { id: hid('dsh'), name: 'DeepSeek Harness', description: 'The in-process agent loop.' },
  { id: hid('codex'), name: 'Codex' },
]

const READY: AgentHarnessSeatState = { harnesses: MOUNTED, current: hid('codex') }

/** The runtime's own `{name}` substitution, so a test reads the shown text. */
function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  const template = en[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function renderSeat(options: {
  state?: Partial<AgentHarnessSeatState>
  session?: string
  recorded?: string | null | undefined
} = {}) {
  const store = createSnapshotStore<AgentHarnessSeatState>({ ...READY, ...options.state })
  const actions = { load: vi.fn(() => Promise.resolve()), select: vi.fn() }
  render(<AgentHarnessSeat {...({
    ...actions,
    sessionId: options.session === undefined ? undefined : SessionId(options.session),
    useAgentHarnessSeat: bindSnapshotSelector(store),
    useProjection: () => options.recorded,
    t: translate,
  } as unknown as AgentHarnessSeatProps)} />)
  return { actions, store }
}

describe('the new-session picker', () => {
  it('reads the catalog once and opens on the staged harness', async () => {
    const { actions } = renderSeat()

    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button').textContent).toContain('Codex')
    expect(screen.getByRole('button').getAttribute('title')).toBe(en.seatHint)
  })

  it('offers every mounted harness with what it is for', () => {
    renderSeat()

    fireEvent.click(screen.getByRole('button'))

    // The id alone never said what runs the session, which is why the catalog
    // carries display copy; a harness that published none still reads as a row.
    expect(screen.getByRole('menuitem', { name: /Codex/ })).toBeTruthy()
    expect(screen.getByText(en.noDescription)).toBeTruthy()
    expect(screen.getByText(MOUNTED[0]!.description!)).toBeTruthy()
  })

  it('stages the picked harness and closes the menu', () => {
    const { actions } = renderSeat()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.click(screen.getByText('DeepSeek Harness'))

    expect(actions.select).toHaveBeenCalledWith('dsh')
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on an outside dismissal', () => {
    renderSeat()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the staged id until the catalog resolves it', () => {
    renderSeat({ state: { current: hid('arriving') } })

    expect(screen.getByRole('button').textContent).toContain('arriving')
  })

  it('renders no control before the catalog arrives', () => {
    renderSeat({ state: { harnesses: [], current: null } })

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders no control while the deployment mounts one harness', () => {
    renderSeat({ state: { harnesses: [MOUNTED[0]!], current: hid('dsh') } })

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows an empty label while the catalog carries harnesses but no choice', () => {
    renderSeat({ state: { current: null } })

    expect(screen.getByRole('button').textContent).toBe('')
  })
})

describe('a session that already exists', () => {
  it('shows the harness it runs, and never a menu', () => {
    renderSeat({ session: 's1', recorded: 'codex' })

    const label = screen.getByRole('button')
    expect(label).toHaveProperty('disabled', true)
    expect(label.textContent).toBe('Codex')
    expect(label.getAttribute('aria-haspopup')).toBeNull()
    // A control here would promise a switch the host refuses outright.
    expect(label.getAttribute('title')).toBe(en.sessionHint)
  })

  it('prefers the catalog description as the label tooltip', () => {
    renderSeat({ session: 's1', recorded: 'dsh' })

    expect(screen.getByRole('button').getAttribute('title')).toBe(MOUNTED[0]!.description)
  })

  it('falls back to the recorded id when the deployment no longer mounts it', () => {
    renderSeat({ session: 's1', recorded: 'grok' })

    expect(screen.getByRole('button').textContent).toBe('grok')
  })

  it('renders nothing for a session that records no harness', () => {
    const absent = renderSeat({ session: 's1', recorded: null })
    expect(absent.actions.load).toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()

    renderSeat({ session: 's1', recorded: undefined })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing while the deployment mounts one harness', () => {
    renderSeat({ session: 's1', recorded: 'dsh', state: { harnesses: [MOUNTED[0]!], current: hid('dsh') } })

    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('the Session header harness mark', () => {
  /** Render the header mark against one session projection value. */
  function renderMark(recorded: string | null | undefined, state?: Partial<AgentHarnessSeatState>) {
    const store = createSnapshotStore<AgentHarnessSeatState>({ ...READY, ...state })
    render(<HarnessBadgeSeat {...({
      load: vi.fn(() => Promise.resolve()),
      useAgentHarnessSeat: bindSnapshotSelector(store),
      useProjection: () => recorded,
    } as unknown as HarnessBadgeSeatProps)} />)
  }

  it('marks the session with the recorded harness and its catalog name', () => {
    renderMark('codex')

    const mark = screen.getByRole('img', { name: 'Codex' })
    expect(mark.getAttribute('data-harness')).toBe('codex')
    // The harness's own symbol, named for assistive technology.
    expect(mark.tagName).toBe('svg')
    expect(mark.querySelector('title')?.textContent).toBe('Codex')
  })

  it('still marks a harness the catalog no longer names, labelled by its id', () => {
    renderMark('grok')

    const mark = screen.getByRole('img', { name: 'grok' })
    expect(mark.getAttribute('data-harness')).toBe('grok')
    expect(mark.querySelector('path, polygon')).not.toBeNull()
  })

  it('marks a single-harness deployment too, and renders nothing before the record', () => {
    renderMark('dsh', { harnesses: [MOUNTED[0]!], current: hid('dsh') })
    const mark = screen.getByRole('img', { name: 'DeepSeek Harness' })
    expect(mark.getAttribute('data-harness')).toBe('dsh')
    cleanup()

    renderMark(null)
    expect(screen.queryByRole('img')).toBeNull()
    cleanup()

    renderMark(undefined)
    expect(screen.queryByRole('img')).toBeNull()
  })
})
