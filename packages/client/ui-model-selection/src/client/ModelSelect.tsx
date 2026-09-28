/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * While open, ↑/↓ move focus across the rows of the shown pane (wrapping; a
 * step taken while the trigger still holds focus enters at the near end), Tab
 * settles like Enter, and Escape drops a typed filter, then leaves a drilled
 * pane, then closes back to the trigger; Shift+Tab leaves a drilled pane and
 * otherwise closes. Drilling hands focus to the row of the value in use, and
 * returning to the root pane hands it back to the cell that opened it; the
 * model pane opens on its filter field instead, so a filter can be typed at
 * once. Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; exact-model reasoning metadata and the selected effort come
 * from the Host rather than a client-owned vocabulary. A rejected selection
 * announces through the shared transient Toast anchored to the composer
 * card; the in-menu strip with Retry remains the catalog-load surface. While
 * the directory's pending selection is unsettled, the trigger shows a spinner
 * in place of its chevron, and each row whose value that selection carries
 * shows one in place of its check mark.
 *
 * The model list carries a filter field and a per-row favourite toggle. A
 * pinned model is repeated in the Pinned section above the provider groups
 * rather than moved out of its group, so every group stays a complete list
 * of what its provider serves while the shortcut sits at the top. Pin
 * membership is the browser-wide pin store; the filter lasts one opening of
 * the menu.
 */
import { MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconDataOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, IconStarFillRegular,
  IconStarOutlineRegular, IconWarningOutlineRegular, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from './directory.ts'
import { modelPinKey } from './pins.ts'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** One directory row: its provider group, the provider-owned model, and both as a selection. */
interface Choice {
  group: ModelDirectoryState['groups'][number]
  model: ModelDirectoryState['groups'][number]['models'][number]
  selection: ModelSelection
}

/** The seat's owner share plus its bound inject face (hooks compartment included). */
type ModelSelectProps =
  InjectFace<ModelSelectInjected> & { locked: boolean } & PropsLocale<'model'>

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Whether one catalog row matches the typed filter. The model's display name,
 * its provider-owned id, and its provider name all match, because the menu
 * shows names while ids are what route keys and documentation use.
 * @param groupName - the provider group's display name.
 * @param model - the provider-owned model row.
 * @param needle - the lowercased, trimmed filter text; empty matches everything.
 * @returns whether the row stays visible.
 */
function matchesQuery(
  groupName: string,
  model: Choice['model'],
  needle: string,
): boolean {
  if (needle === '') return true
  return `${model.name} ${model.id} ${groupName}`.toLowerCase().includes(needle)
}

/**
 * Display name of one provider group or failure. The account provider's label
 * is locale-owned; every other provider names itself.
 * @param provider - the catalog group or failure.
 * @param t - the seat's `model` translator.
 * @returns the provider label.
 */
function providerName(
  provider: { readonly id: string; readonly name: string },
  t: ModelSelectProps['t'],
): string {
  return provider.id === 'deepseek-account' ? t('provider.account') : provider.name
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs, browser-wide pins) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, refresh, select, togglePin, useModelPins, t }: ModelSelectProps,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const pinnedKeys = useModelPins(pins => pins.pinned)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [query, setQuery] = useState('')
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const sortedGroups = useMemo(() => state.groups.toSorted((left, right) =>
    (left.id === 'deepseek-account' ? 0 : left.id === 'deepseek-official' ? 1 : 2)
      - (right.id === 'deepseek-account' ? 0 : right.id === 'deepseek-official' ? 1 : 2)), [state.groups])
  const choices = useMemo(() => sortedGroups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [sortedGroups])
  const needle = query.trim().toLowerCase()
  // Buckets keep the sorted group order: rows arrive grouped by provider, and
  // an empty group survives only while nothing is filtered out of it.
  const groups = useMemo(() => {
    const buckets = new Map<string, Choice[]>()
    for (const choice of choices) {
      if (!matchesQuery(providerName(choice.group, t), choice.model, needle)) continue
      const bucket = buckets.get(choice.group.id)
      if (bucket === undefined) buckets.set(choice.group.id, [choice])
      else bucket.push(choice)
    }
    return sortedGroups
      .map(group => ({ group, rows: buckets.get(group.id) ?? [] }))
      .filter(entry => needle === '' || entry.rows.length > 0)
  }, [choices, sortedGroups, needle, t])
  const pinnedRows = useMemo(() => {
    const byKey = new Map(choices.map(choice => [modelPinKey(choice.group.id, choice.model.id), choice]))
    return pinnedKeys
      .map(key => byKey.get(key))
      .filter((choice): choice is Choice => choice !== undefined)
      .filter(choice => matchesQuery(providerName(choice.group, t), choice.model, needle))
  }, [choices, pinnedKeys, needle, t])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? state.retainedEffort
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const { pending } = state
  const busy = pending !== null
  const [refreshing, setRefreshing] = useState(false)

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // The explicit refresh asks the Host to fetch its model sources again, so a
  // model published since this process started appears without a restart. The
  // button stays focusable while it runs: disabling it would drop focus to the
  // page body, and the seat closes on that blur.
  const refreshList = (): void => {
    if (refreshing) return
    lastActionRef.current = 'load'
    setRefreshing(true)
    void refresh().catch(() => { /* surfaced on the store */ }).finally(() => { setRefreshing(false) })
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  // A pane switch unmounts the row that had focus, which drops focus onto the
  // page body — outside the card's subtree, where its key handling no longer
  // sees a keystroke. Every switch therefore names where the keyboard lands:
  // drilling on the pane's current value, coming back on the cell that opened
  // the pane left. The model pane is the exception: its filter field takes the
  // keyboard so a filter can be typed at once, and Arrow Up/Down walk from
  // there into the rows.
  const paneFocus = useRef<'drill' | 'model' | 'effort' | null>(null)
  useEffect(() => {
    const intent = paneFocus.current
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      if (pane === 'model') return
      // The checked row is the value in use; a pane without one opens on its
      // first row.
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      const target = checked ?? itemRefs.current.find(item => item !== null && !item.disabled)
      // Rows a selection in flight disabled cannot take the keyboard; the
      // trigger does, so the card's keys still reach the menu.
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const cell = itemRefs.current[intent === 'effort' ? 1 : 0]
    ;(cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane])

  // Portaled placement (the Menu primitive's portal rules: fixed from the
  // anchor rect, measured before paint, clamped inside the viewport): above
  // the trigger, right edges aligned. Depends on pane and directory state
  // because a pane switch changes the card's size and an async catalog load
  // changes the rows a content-sized pane shows.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // the card lands placed before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, state])
  /* jscpd:ignore-end */

  // Focus the filter when the model list opens, but not on later renders:
  // re-focusing while a filter is typed or a row is focused would fight the
  // user (the placement pass above re-renders on every keystroke).
  useLayoutEffect(() => {
    if (!open || pane !== 'model') return
    searchRef.current?.focus()
  }, [open, pane])

  if (!available) return null

  const show = (): void => {
    triggerRef.current?.focus()
    if (state.current === null) paneFocus.current = 'drill'
    setPane(state.current === null ? 'model' : 'root')
    setQuery('')
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    setQuery('')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const drill = (next: Pane): void => {
    paneFocus.current = 'drill'
    setPane(next)
  }

  /** Leave a drilled pane for the root one, dropping the filter with it and handing the keyboard back to its cell. */
  const back = (from: Exclude<Pane, 'root'>): void => {
    paneFocus.current = from
    setPane('root')
    setQuery('')
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens, or the filter field) enters at the end the step comes from: the
    // first row forward, the last row backward.
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape drops a typed filter first, then backs out of a drilled pane,
      // then closes.
      if (pane === 'model' && query !== '') setQuery('')
      else if (pane !== 'root' && state.current !== null) back(pane)
      else close(true)
      return
    }
    if (!open) return
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root' && state.current !== null) back(pane)
        else close(true)
        return
      }
      // Settling activates the row the keyboard is on; with focus still on the
      // trigger, Tab enters the menu at the value in use instead. Any other
      // control inside the card (a retry button) keeps the browser's traversal,
      // so the keystroke stays unconsumed there.
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) close(true)
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const submit = (selection: ModelSelection): void => {
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    triggerRef.current?.focus()
    void select(selection).then(settleSelection)
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    submit(selection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    submit(selection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  /**
   * Render one model row with its favourite toggle.
   * @param choice - the directory row.
   * @param providerLabel - the provider label to show under the name, for the
   * mixed-provider Pinned section; omitted inside a provider group, whose
   * heading already names it.
   * @returns the row.
   */
  const renderRow = (choice: Choice, providerLabel?: string) => {
    const key = modelPinKey(choice.group.id, choice.model.id)
    const selected = state.current?.provider === choice.group.id && state.current.model === choice.model.id
    const pinned = pinnedKeys.includes(key)
    const pinLabel = t(pinned ? 'pin.remove' : 'pin.add', { model: choice.model.name })
    return (
      <div className={css.optionRow} key={key}>
        <button
          ref={itemRef()}
          type="button"
          role="menuitemradio"
          aria-checked={selected}
          className={clsx(css.option, selected && css.selected)}
          title={choice.model.name}
          // The Pinned section mixes providers, so its rows name the provider
          // too; content order alone would run the two labels together.
          aria-label={providerLabel === undefined
            ? undefined
            : t('option.providerAria', { model: choice.model.name, provider: providerLabel })}
          disabled={busy}
          onClick={() => { choose({ provider: choice.group.id, model: choice.model.id }) }}
        >
          <span className={css.optionCopy}>
            <span className={css.modelName}>{choice.model.name}</span>
            {providerLabel !== undefined && <span className={css.optionProvider}>{providerLabel}</span>}
          </span>
          <span className={css.check}>
            {pending?.provider === choice.group.id && pending.model === choice.model.id
              ? <StateDot state="ongoing" />
              : selected ? <IconCheckOutlineRegular /> : null}
          </span>
        </button>
        <button
          type="button"
          className={clsx(css.pin, pinned && css.pinSet)}
          aria-pressed={pinned}
          aria-label={pinLabel}
          title={pinLabel}
          onClick={() => { togglePin(choice.group.id, choice.model.id) }}
        >
          {pinned ? <IconStarFillRegular /> : <IconStarOutlineRegular />}
        </button>
      </div>
    )
  }

  const pinnedHeadingId = `${id}-pinned`

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={busy}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={clsx(css.menu, pane === 'model' && css.menuModel)}
          style={menuPos ?? MEASURE_STYLE}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy || refreshing}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('model') }}>
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <IconChevronRightOutlineRegular className={css.cellChevron} />
              </button>
              {reasoning !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutlineRegular className={css.cellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {/* Focus lands here on entry so a filter can be typed at once;
                  Arrow Up/Down leave the field for the rows. */}
              <div className={css.search}>
                <IconSearchOutlineRegular size={14} className={css.searchIcon} />
                <input
                  ref={searchRef}
                  type="search"
                  className={css.searchInput}
                  aria-label={t('search.label')}
                  placeholder={t('search.placeholder')}
                  value={query}
                  onChange={(event) => { setQuery(event.currentTarget.value) }}
                />
                <button
                  type="button"
                  className={clsx(css.searchRefresh, refreshing && css.searchRefreshBusy)}
                  aria-label={t('search.refresh')}
                  title={t('search.refresh')}
                  aria-disabled={refreshing}
                  onClick={refreshList}
                >
                  <IconRefreshOutlineRegular size={14} />
                </button>
              </div>
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: providerName(failure, t), message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div className={clsx(css.groups, 'scrollable')}>
                {pinnedRows.length > 0 && (
                  <section role="group" aria-labelledby={pinnedHeadingId} className={css.group}>
                    <div className={css.groupTitle} id={pinnedHeadingId}>{t('group.pinned')}</div>
                    {pinnedRows.map(choice => renderRow(choice, providerName(choice.group, t)))}
                  </section>
                )}
                {groups.map(({ group, rows }) => {
                  const headingId = `${id}-${group.id}`
                  return (
                    <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                      <div className={css.groupTitle} id={headingId}>{providerName(group, t)}</div>
                      {rows.map(choice => renderRow(choice))}
                    </section>
                  )
                })}
              </div>
              {state.status === 'ready' && choices.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
              {/* Only a filter that hid rows the catalog does have is a
                  no-match; an empty catalog already reported itself above. */}
              {needle !== '' && choices.length > 0 && groups.length === 0 && (
                <div className={css.empty}>{t('empty.search', { query: query.trim() })}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                    </span>
                    <span className={css.check}>
                      {pending !== null && pending.provider === state.current?.provider
                        && pending.model === state.current.model && pending.reasoningEffort === level.effort
                        ? <StateDot state="ongoing" />
                        : effectiveEffort === level.effort ? <IconCheckOutlineRegular /> : null}
                    </span>
                  </button>
                ))}
            </>
          )}
        </MenuSurface>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
