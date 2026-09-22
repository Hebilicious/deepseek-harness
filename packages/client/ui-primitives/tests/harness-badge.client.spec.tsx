// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessBadge, harnessMark, HARNESS_LOGOS } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

/** Harness ids whose official mark this repository carries. */
const MARKED = ['dsh', 'codex', 'claude', 'grok', 'opencode', 'mimo'] as const

describe('HarnessBadge', () => {
  it('draws the official mark of every harness that publishes one', () => {
    for (const harnessId of MARKED) {
      const { container } = render(<HarnessBadge harnessId={harnessId} label={harnessId} />)
      const mark = container.firstElementChild as SVGElement
      expect(mark.tagName).toBe('svg')
      expect(mark.getAttribute('data-harness')).toBe(harnessId)
      // The published geometry, not a redrawn approximation: the mark keeps
      // the source viewBox and fills with the surrounding text color.
      const logo = HARNESS_LOGOS[harnessId]
      expect(logo).toBeDefined()
      expect(mark.getAttribute('viewBox')).toBe(logo?.viewBox)
      const shapes = mark.querySelectorAll('path, polygon')
      expect(shapes).toHaveLength(logo?.shapes.length ?? 0)
      expect([...shapes].every(shape => shape.getAttribute('fill') === 'currentColor')).toBe(true)
      cleanup()
    }
  })

  it('keeps the fish mark of the built-in harness, not a vendor symbol', () => {
    const { container } = render(<HarnessBadge harnessId="dsh" label="DSH Loop" />)

    const path = container.querySelector('path')
    // The in-repo silhouette is the same geometry the shell draws elsewhere.
    expect(path?.getAttribute('d')?.startsWith('M22.9168 1.43018')).toBe(true)
  })

  it('falls back to a monogram tile for a harness with no published symbol', () => {
    const { container } = render(<HarnessBadge harnessId="devin" label="Devin" />)

    const tile = container.firstElementChild as HTMLElement
    expect(tile.tagName).toBe('SPAN')
    expect(tile.textContent).toBe('DV')
    expect(harnessMark('devin')).toBe('DV')
  })

  it('derives a stable monogram for a harness outside the shipped set', () => {
    expect(harnessMark('my-harness')).toBe('MY')
    expect(harnessMark('---')).toBe('??')
    const { container } = render(<HarnessBadge harnessId="my-harness" label="Mine" />)
    expect(container.firstElementChild?.textContent).toBe('MY')
  })

  it('labels the mark with the harness name for assistive technology', () => {
    const symbol = render(<HarnessBadge harnessId="claude" label="Claude Code" />)
    const svg = symbol.container.firstElementChild as SVGElement
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('Claude Code')
    expect(svg.querySelector('title')?.textContent).toBe('Claude Code')
    cleanup()

    const tile = render(<HarnessBadge harnessId="custom-harness" label="Custom" />)
    const span = tile.container.firstElementChild as HTMLElement
    expect(span.getAttribute('role')).toBe('img')
    expect(span.getAttribute('aria-label')).toBe('Custom')
    expect(span.getAttribute('title')).toBe('Custom')
  })

  it('sizes both shapes from the size prop', () => {
    const { container, rerender } = render(<HarnessBadge harnessId="codex" label="Codex" size={20} />)
    const svg = container.firstElementChild as SVGElement
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')

    rerender(<HarnessBadge harnessId="devin" label="Devin" size={8} />)
    const tile = container.firstElementChild as HTMLElement
    expect(tile.style.width).toBe('8px')
    expect(tile.style.height).toBe('8px')
    // Two glyphs in an 8px square would be unreadable, so the floor wins.
    expect(tile.style.fontSize).toBe('7px')
  })
})
