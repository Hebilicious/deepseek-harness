import clsx from 'clsx'
import css from './HarnessBadge.module.css'

/**
 * Mark drawn for one harness id. These are monograms over the theme's static
 * palette rather than vendor artwork: the shipped entries drive third-party
 * CLIs, and shipping their logos would mean carrying licensed brand assets in
 * the repository. A deployment that mounts an id outside this table still gets
 * a stable mark derived from that id.
 */
const MARKS: Readonly<Record<string, { mark: string; tone: string }>> = {
  dsh: { mark: 'DS', tone: 'brand' },
  codex: { mark: 'CX', tone: 'graphite' },
  claude: { mark: 'CL', tone: 'clay' },
  devin: { mark: 'DV', tone: 'blue' },
  grok: { mark: 'GK', tone: 'neutral' },
  opencode: { mark: 'OC', tone: 'green' },
  mimo: { mark: 'MM', tone: 'red' },
}

/**
 * Resolve the monogram and tone one harness id renders with.
 * @param harnessId - the harness id recorded on the session.
 * @returns the two-character mark and the tone name its styles key on.
 */
export function harnessMark(harnessId: string): { mark: string; tone: string } {
  const known = MARKS[harnessId]
  if (known !== undefined) return known
  const letters = harnessId.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase()
  return { mark: letters === '' ? '??' : letters, tone: 'neutral' }
}

/**
 * Render the mark of the harness that owns a session.
 * @param props.harnessId - harness id as recorded on the session.
 * @param props.label - harness display name, used as the accessible label and tooltip.
 * @param props.size - square size in px (default 16, the sidebar's status slot).
 * @param props.className - extra class for layout placement at the call site.
 * @returns the badge element, labelled as an image by its harness name.
 */
export function HarnessBadge({ harnessId, label, size = 16, className }: {
  harnessId: string
  label: string
  size?: number | undefined
  className?: string | undefined
}) {
  const { mark, tone } = harnessMark(harnessId)
  return (
    <span
      className={clsx(css.badge, className)}
      data-tone={tone}
      data-harness={harnessId}
      style={{ width: size, height: size, fontSize: `${Math.max(7, Math.round(size * 0.46))}px` }}
      role="img"
      aria-label={label}
      title={label}
    >
      {mark}
    </span>
  )
}
