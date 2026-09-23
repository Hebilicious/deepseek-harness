import clsx from 'clsx'
import { HARNESS_LOGOS } from './harness-logos.ts'
import css from './HarnessBadge.module.css'

/**
 * Monogram of a harness that publishes no symbol this repository can carry.
 * Only Devin needs one today: its site serves no SVG mark, so a two-letter
 * tile stands in rather than a redrawn approximation of its logo.
 */
const MONOGRAMS: Readonly<Record<string, string>> = {
  devin: 'DV',
}

/**
 * Resolve the fallback monogram for one harness id.
 * @param harnessId - the harness id recorded on the session.
 * @returns the two-character mark, derived from the id when it is unknown.
 */
export function harnessMark(harnessId: string): string {
  const known = MONOGRAMS[harnessId]
  if (known !== undefined) return known
  const letters = harnessId.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase()
  return letters === '' ? '??' : letters
}

/**
 * Render the mark of the harness that owns a session: its official symbol
 * when the repository carries one, otherwise a monogram tile.
 *
 * The symbol is drawn from the published geometry in the current label color,
 * so it follows the theme instead of imposing a vendor background.
 * @param props.harnessId - harness id as recorded on the session.
 * @param props.label - harness display name, used as the accessible label and tooltip.
 * @param props.size - mark size in px (default 16, the sidebar's status slot).
 * @param props.className - extra class for layout placement at the call site.
 * @returns the mark element, labelled as an image by its harness name.
 */
export function HarnessBadge({ harnessId, label, size = 16, className }: {
  harnessId: string
  label: string
  size?: number | undefined
  className?: string | undefined
}) {
  const logo = HARNESS_LOGOS[harnessId]
  if (logo !== undefined) {
    return (
      <svg
        className={clsx(css.logo, className)}
        data-harness={harnessId}
        width={size}
        height={size}
        viewBox={logo.viewBox}
        role="img"
        aria-label={label}
        preserveAspectRatio="xMidYMid meet"
      >
        <title>{label}</title>
        {logo.shapes.map(shape => shape.kind === 'path'
          ? <path key={shape.data} d={shape.data} fill="currentColor" />
          : <polygon key={shape.data} points={shape.data} fill="currentColor" />)}
      </svg>
    )
  }
  return (
    <span
      className={clsx(css.badge, className)}
      data-harness={harnessId}
      style={{ width: size, height: size, fontSize: `${Math.max(7, Math.round(size * 0.46))}px` }}
      role="img"
      aria-label={label}
      title={label}
    >
      {harnessMark(harnessId)}
    </span>
  )
}
