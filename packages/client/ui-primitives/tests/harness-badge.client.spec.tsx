// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessBadge, harnessMark } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('HarnessBadge', () => {
  it('marks each shipped harness with its own monogram and tone', () => {
    const expected: readonly (readonly [string, string, string])[] = [
      ['dsh', 'DS', 'brand'],
      ['codex', 'CX', 'graphite'],
      ['claude', 'CL', 'clay'],
      ['devin', 'DV', 'blue'],
      ['grok', 'GK', 'neutral'],
      ['opencode', 'OC', 'green'],
      ['mimo', 'MM', 'red'],
    ]
    for (const [id, mark, tone] of expected) {
      const { container } = render(<HarnessBadge harnessId={id} label={id} />)
      const badge = container.firstElementChild as HTMLElement
      expect(badge.textContent).toBe(mark)
      expect(badge.dataset['tone']).toBe(tone)
      cleanup()
    }
  })

  it('derives a stable mark for a harness outside the shipped set', () => {
    expect(harnessMark('my-harness')).toEqual({ mark: 'MY', tone: 'neutral' })
    expect(harnessMark('zed')).toEqual({ mark: 'ZE', tone: 'neutral' })
    // An id with nothing alphanumeric keeps a visible placeholder rather than
    // an empty square.
    expect(harnessMark('---')).toEqual({ mark: '??', tone: 'neutral' })
  })

  it('labels the mark with the harness name for assistive technology', () => {
    const { container } = render(<HarnessBadge harnessId="claude" label="Claude Code" />)

    const badge = container.firstElementChild as HTMLElement
    expect(badge.getAttribute('role')).toBe('img')
    expect(badge.getAttribute('aria-label')).toBe('Claude Code')
    expect(badge.getAttribute('title')).toBe('Claude Code')
    expect(badge.dataset['harness']).toBe('claude')
  })

  it('sizes the square and keeps the monogram legible at the smallest size', () => {
    const { container, rerender } = render(<HarnessBadge harnessId="codex" label="Codex" size={20} />)
    const large = container.firstElementChild as HTMLElement
    expect(large.style.width).toBe('20px')
    expect(large.style.height).toBe('20px')
    expect(large.style.fontSize).toBe('9px')

    rerender(<HarnessBadge harnessId="codex" label="Codex" size={8} />)
    const small = container.firstElementChild as HTMLElement
    // Two glyphs in an 8px square would be unreadable, so the floor wins.
    expect(small.style.fontSize).toBe('7px')
  })
})
