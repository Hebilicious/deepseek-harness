// @vitest-environment jsdom
import * as uiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { bindSnapshotSelector, RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { modelPinKey, toggleModelPin, type ModelPinsState } from '../src/client/pins.ts'
import { en, zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

/** The in-process loop, the harness every fixture provider serves. */
const LOOP = ['dsh'] as unknown as ModelProviderGroup['harnesses']

/**
 * The seat's refresh and pin shares, stubbed with an empty pin store bound the
 * way the renderer binds it; props written after the spread override them.
 * @returns the refresh, pin toggle, and pin hook props.
 */
function seatFace(): Pick<ComponentProps<typeof ModelSelect>, 'refresh' | 'togglePin' | 'useModelPins'> {
  return {
    refresh: vi.fn().mockResolvedValue(undefined),
    togglePin: vi.fn(),
    useModelPins: bindSnapshotSelector(createSnapshotStore<ModelPinsState>({ pinned: [] })),
  }
}

const renderLabel: ComponentProps<typeof ModelSelect>['renderSlot'] = (_name, _owner, options) => options?.fallback ?? null

const resolveText: ComponentProps<typeof ModelSelect>['resolveText'] = text => typeof text === 'string' ? text : text.en

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      harnesses: LOOP,
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
    ...overrides,
  }
}

function modelGroups(count: number): ModelDirectoryState['groups'] {
  const group = state().groups[0]!
  return [{ ...group, models: [
    ...group.models,
    ...Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
      id: `model-${index + 2}`, name: `Model ${index + 2}`,
    })),
  ].slice(0, count) }]
}

const scrollIntoView = vi.fn()
beforeEach(() => {
  scrollIntoView.mockClear()
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
})

afterEach(cleanup)

describe('ModelSelect label slot', () => {
  it('distinguishes identical model names and ids by provider across all placements and restores labels on unload', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const sessionId = SessionId('model-label')
    await runtime.sessions.add({ id: sessionId })
    const session = runtime.sessions.retainFor(runtime.ctx, sessionId)
    const groups = ['trusted', 'external'].map(id => ({
      id, name: `${id} gateway`, harnesses: LOOP, models: [{ id: 'same-model', name: 'Same model' }],
    }))
    const directory = createSnapshotStore(state({ groups, current: { provider: 'trusted', model: 'same-model' } }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.update((snapshot) => { snapshot.current = selection })
      return { ok: true as const, value: undefined }
    })
    await runtime.root.declare({
      'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
    }, ({ renderSlot, SessionProvider }) => <SessionProvider session={session}>
      <ModelSelect {...seatFace()} locked={false} available directory={directory} load={vi.fn()}
        resolveText={resolveText} select={select} t={t} renderSlot={renderSlot} />
    </SessionProvider>)
    runtime.renderRoot()
    const trigger = screen.getByRole('button', { name: '选择模型，当前 Same model' })
    expect(trigger.textContent).toBe('Same model')
    const plugin = await runtime.mount({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
        name: 'conversation.input.model.label',
      }, ({ provider, model, placement, selected }) => <span
        data-testid={`${placement}-${provider.id}`}
        data-selected={selected}
        title={provider.name}
      >{provider.id}: {model.name}</span>))
    } })
    expect(screen.getByTestId('trigger-trusted').textContent).toBe('trusted: Same model')
    expect(screen.getByTestId('trigger-trusted').title).toBe('trusted gateway')
    expect(trigger.querySelector('div')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByTestId('menu-trusted').textContent).toBe('trusted: Same model')
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    expect(screen.getByTestId('option-trusted').getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('option-external').getAttribute('data-selected')).toBe('false')
    const external = screen.getByRole('menuitemradio', { name: 'external: Same model' })
    expect(external.querySelector('[data-provider-id="external"][data-model-id="same-model"]')).toBeTruthy()
    expect(external.querySelector('div')).toBeNull()
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'trusted: Same model' }), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(external)
    fireEvent.keyDown(external, { key: 'Tab' })
    await waitFor(() => { expect(screen.getByTestId('trigger-external')).toBeTruthy() })
    expect(select).toHaveBeenCalledWith({ provider: 'external', model: 'same-model' })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    await act(async () => { await plugin.dispose() })
    expect(runtime.slots.entries('conversation.input.model.label')).toHaveLength(0)
    expect(trigger.textContent).toBe('Same model')
    expect(trigger.querySelector('[data-provider-id="external"][data-model-id="same-model"]')).toBeTruthy()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Same model', 'Same model'])
  })

  it('does not decorate loading or missing selections with a stale provider', () => {
    const directory = createSnapshotStore(state({ groups: [], status: 'loading' }))
    const renderSlot = vi.fn(() => null)
    render(<ModelSelect {...seatFace()} locked={false} available directory={directory} load={vi.fn()}
      resolveText={resolveText} select={vi.fn()} t={t} renderSlot={renderSlot} />)
    expect(renderSlot).not.toHaveBeenCalled()
    expect(document.querySelector('[data-provider-id]')).toBeNull()
    act(() => { directory.set(state({ groups: [] })) })
    expect(screen.getByRole('button', { name: '请选择模型' })).toBeTruthy()
    expect(renderSlot).not.toHaveBeenCalled()
  })
})

describe('ModelSelect catalog badges', () => {
  const BADGE = { text: { en: 'New', zh: '新' }, tone: 'info' } as const
  const badged = () => state({
    current: { provider: 'deepseek-official', model: 'deepseek-flash' },
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      harnesses: LOOP,
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', badge: BADGE },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }],
  })
  const chinese: ComponentProps<typeof ModelSelect>['resolveText'] = text => typeof text === 'string' ? text : text.zh ?? text.en

  it('places the badge before the trigger name and after names in the menus', () => {
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(badged())}
      load={vi.fn()} resolveText={chinese} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: '选择模型，当前 DeepSeek-V4.1-Flash' })
    expect(trigger.textContent).toBe('新 DeepSeek-V4.1-Flash')
    expect(screen.getByText('新').getAttribute('data-tone')).toBe('info')
    fireEvent.click(trigger)
    const current = screen.getByRole('menuitem', { name: /^模型/ })
    expect(current.textContent).toContain('DeepSeek-V4.1-Flash 新')
    fireEvent.click(current)
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['DeepSeek-V4.1-Flash 新', 'DeepSeek-V4-Pro'])
  })

  it('hands the badge to a label contribution, which replaces the default rendering', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const sessionId = SessionId('model-badge')
    await runtime.sessions.add({ id: sessionId })
    const session = runtime.sessions.retainFor(runtime.ctx, sessionId)
    await runtime.root.declare({
      'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
    }, ({ renderSlot, SessionProvider }) => <SessionProvider session={session}>
      <ModelSelect {...seatFace()} locked={false} available directory={createSnapshotStore(badged())} load={vi.fn()} resolveText={chinese}
        select={vi.fn()} t={t} renderSlot={renderSlot} />
    </SessionProvider>)
    runtime.renderRoot()
    await runtime.mount({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
        name: 'conversation.input.model.label',
      }, ({ model }) => <span>{model.name} [{model.badge?.tone ?? 'none'}]</span>))
    } })
    expect(screen.getByRole('button', { name: '选择模型，当前 DeepSeek-V4.1-Flash' }).textContent).toBe('DeepSeek-V4.1-Flash [info]')
    expect(screen.queryByText('新')).toBeNull()
  })
})

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()} resolveText={resolveText}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
      expect(document.activeElement).toBe(trigger)
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        harnesses: LOOP,
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()} resolveText={resolveText}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('opens model choices without exposing a saved route absent from the catalog', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()} resolveText={resolveText}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '请选择模型' })
    expect(trigger.textContent).toBe('请选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /模型/ })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: 'removed-model' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
    expect(select).not.toHaveBeenCalled()
    expect(directory.getSnapshot().current).toEqual({ provider: 'deepseek-official', model: 'removed-model' })
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull()
  })

  it.each(['model', 'provider'])('hides the saved id and effort when the selected %s disappears', (removed) => {
    const directory = createSnapshotStore(state({ retainedEffort: 'High' }))
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
      resolveText={resolveText} select={vi.fn()} t={t} />)
    expect(screen.getByRole('button', { name: /选择模型，当前/ }).textContent).toContain('DeepSeek-V4-Flash')
    act(() => { directory.update((snapshot) => {
      snapshot.groups = removed === 'provider' ? [] : snapshot.groups.map(group => ({ ...group, models: [] }))
      snapshot.routable = false
    }) })
    const trigger = screen.getByRole('button', { name: '请选择模型' })
    expect(trigger.textContent).toBe('请选择模型')
    expect(directory.getSnapshot().current).toEqual(state().current)
    fireEvent.click(trigger)
    expect(screen.getByRole('status').textContent).toBe(zh['empty.models'])
    fireEvent.keyDown(trigger, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull()
  })

  it.each([null, state().current])('shows loading until the catalog and Session projection are both ready (%j)', async (current) => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()} resolveText={resolveText}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    expect(screen.getByRole('button', { name: '正在加载模型…' }).textContent)
      .toContain('正在加载模型…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
      })).toBeTruthy()
    })
  })

  it.each([false, true])('announces rejected selections with ownership guidance only for held writers (%s)', async (sessionInUse) => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      harnesses: LOOP,
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      const error = sessionInUse
        ? new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') })
        : new RemoteError('session/model-unavailable', 'session already contains images', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
      directory.set(state({ groups, status: 'error', error: 'unrelated catalog refresh' }))
      return { ok: false as const, error }
    })
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()} resolveText={resolveText}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: /选择模型|当前/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    const rejected = screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ })
    fireEvent.mouseMove(rejected)
    fireEvent.click(rejected)
    const toast = await screen.findByRole('alert')
    expect(document.activeElement).toBe(trigger)
    expect(toast.textContent).toBe(sessionInUse
      ? zh['error.sessionInUse']
      : '模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
  })

  it('spins on the trigger and the chosen model row until the selection settles, across pane changes', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      harnesses: LOOP,
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    let settle!: () => void
    const select = vi.fn((selection: ModelSelection) => {
      directory.set(state({ groups, status: 'selecting', pending: selection }))
      return new Promise<{ ok: true; value: undefined }>((resolve) => {
        settle = () => {
          directory.set(state({ groups, current: selection }))
          resolve({ ok: true, value: undefined })
        }
      })
    })
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
      resolveText={resolveText} select={select} t={t} />)
    const spinners = () => document.querySelectorAll('[data-state="ongoing"]')

    const trigger = screen.getByRole('button', { name: /选择模型|当前/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    expect(spinners()).toHaveLength(2)
    expect(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }).querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(trigger.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(trigger.getAttribute('aria-busy')).toBe('true')

    // Leaving the pane unmounts the row; the trigger keeps the feedback.
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menuitemradio')).toBeNull()
    expect(spinners()).toHaveLength(1)
    expect(trigger.querySelector('[data-state="ongoing"]')).not.toBeNull()

    await act(async () => { settle() })
    expect(spinners()).toHaveLength(0)
    expect(trigger.getAttribute('aria-busy')).toBe('false')
  })

  it('spins on the chosen effort row only', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn((selection: ModelSelection) => {
      directory.set(state({ status: 'selecting', pending: selection }))
      return new Promise<undefined>(() => {})
    })
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
      resolveText={resolveText} select={select} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    expect(screen.getAllByRole('menuitemradio')
      .filter(row => row.querySelector('[data-state="ongoing"]') !== null)
      .map(row => row.textContent)).toEqual(['Max'])
  })

  it('portals the placed menu card to body and closes only on truly-outside mousedown', () => {
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })
    try {
      const { container } = render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
        locked={false}
        available
        directory={createSnapshotStore(state())}
        load={vi.fn()} resolveText={resolveText}
        select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
        t={t}
      />)
      const trigger = screen.getByRole('button', { name: /选择模型/ })
      fireEvent.click(trigger)
      const menu = screen.getByRole('menu')
      // Outside the composer subtree — column overflow clips cannot crop it.
      expect(container.contains(menu)).toBe(false)
      expect(menu.parentElement).toBe(document.body)
      // jsdom anchor rects are all zero, so the measured 200x300 card clamps
      // to the 12px viewport margin on both axes.
      expect(menu.style.left).toBe('12px')
      expect(menu.style.top).toBe('12px')
      // Interactions inside the trigger subtree or the portaled card stay open.
      expect(fireEvent.mouseDown(menu)).toBe(true)
      expect(fireEvent.mouseDown(trigger)).toBe(false)
      fireEvent.blur(trigger, { relatedTarget: menu })
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load} resolveText={resolveText}
      select={vi.fn().mockResolvedValue(undefined)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect keyboard walk', () => {
  function mountOpen() {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()} resolveText={resolveText}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    return select
  }

  it.each([
    { device: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 },
    { device: 'desktop-mode iPad', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 },
  ].flatMap(device => [1, 5].map(modelCount => ({ ...device, modelCount }))))(
    'retains menu keyboard focus on $device with $modelCount models without automatically focusing search',
    async ({ userAgent, platform, maxTouchPoints, modelCount }) => {
      for (const [name, value] of Object.entries({ userAgent, platform, maxTouchPoints })) {
        const descriptor = Object.getOwnPropertyDescriptor(navigator, name)
        Object.defineProperty(navigator, name, { configurable: true, value })
        onTestFinished(() => {
          if (descriptor === undefined) Reflect.deleteProperty(navigator, name)
          else Object.defineProperty(navigator, name, descriptor)
        })
      }
      vi.resetModules()
      const detection = await import('@deepseek-ai/dsh-client-ui-primitives/src/focus.ts')
      const device = vi.spyOn(uiPrimitives, 'isMobileDevice').mockImplementation(detection.isMobileDevice)
      onTestFinished(() => { device.mockRestore() })
      const select = vi.fn()
      render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available
        directory={createSnapshotStore(state({ groups: modelGroups(modelCount) }))}
        load={vi.fn()} resolveText={resolveText} select={select} t={t}
      />)
      const trigger = screen.getByRole('button', { name: /选择模型/ })
      fireEvent.click(trigger)
      expect(document.activeElement).toBe(trigger)

      const modelCell = screen.getByRole('menuitem', { name: /^模型/ })
      const effortCell = screen.getByRole('menuitem', { name: /推理等级/ })
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
      fireEvent.keyDown(modelCell, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(effortCell)
      fireEvent.keyDown(effortCell, { key: 'Tab' })
      const high = screen.getByRole('menuitemradio', { name: 'High' })
      const max = screen.getByRole('menuitemradio', { name: /Max/ })
      expect(document.activeElement).toBe(high)
      fireEvent.keyDown(high, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(max)
      fireEvent.keyDown(max, { key: 'Escape' })

      const restoredEffortCell = screen.getByRole('menuitem', { name: /推理等级/ })
      expect(document.activeElement).toBe(restoredEffortCell)
      fireEvent.keyDown(restoredEffortCell, { key: 'ArrowUp' })
      const restoredModelCell = screen.getByRole('menuitem', { name: /^模型/ })
      expect(document.activeElement).toBe(restoredModelCell)
      fireEvent.keyDown(restoredModelCell, { key: 'Tab' })
      const model = screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })
      expect(document.activeElement).toBe(model)
      if (modelCount > 4) {
        const search = screen.getByRole('searchbox')
        expect(document.activeElement).not.toBe(search)
        fireEvent.keyDown(model, { key: 'ArrowDown' })
        expect(document.activeElement).toBe(search)
      } else {
        expect(screen.queryByRole('searchbox')).toBeNull()
      }
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /^模型/ }))
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      await waitFor(() => { expect(document.activeElement).toBe(trigger) })
      expect(select).not.toHaveBeenCalled()
    },
  )

  it.each(['model', 'effort'])('prevents button mousedown defaults in the %s pane without selecting it', (pane) => {
    const select = mountOpen()
    const cell = screen.getByRole('menuitem', { name: pane === 'model' ? /^模型/ : /推理等级/ })
    expect(fireEvent.mouseDown(cell.firstElementChild!)).toBe(false)
    fireEvent.click(cell)
    const rows = screen.getAllByRole('menuitemradio')
    const focused = document.activeElement
    expect(fireEvent.mouseDown(rows[0]!.firstElementChild!)).toBe(false)
    fireEvent.mouseUp(screen.getByRole('menu'))
    expect(select).not.toHaveBeenCalled()
    fireEvent.keyDown(focused!, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: pane === 'model' ? /^模型/ : /推理等级/ }))
  })

  it('↑↓ walk the rows of the shown pane, wrapping, and stay open', () => {
    mountOpen()
    // The trigger holds focus while the menu opens: the first forward step
    // enters at the first cell instead of skipping it. false = preventDefault ran.
    const cells = screen.getAllByRole('menuitem')
    expect(fireEvent.keyDown(cells[0]!, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(cells[0])

    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.map(row => row.textContent)).toEqual(['Off', 'High', 'Max'])
    // The pane opens on its checked row, so walking starts from High.
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[2])
    fireEvent.keyDown(rows[2]!, { key: 'ArrowDown' }) // wraps to the top
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' }) // wraps to the bottom
    expect(document.activeElement).toBe(rows[2])
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('Tab settles the focused row like Enter and closes the menu', async () => {
    const select = mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' }) // High → Max
    expect(fireEvent.keyDown(rows[2]!, { key: 'Tab' })).toBe(false)
    expect(select).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })

  it('Shift+Tab leaves a drilled pane and then closes, like Escape', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(fireEvent.keyDown(rows[0]!, { key: 'Tab', shiftKey: true })).toBe(false)
    // Back on the drilled cell, then closed on the second press.
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[1])
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(cells[1]!, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Tab with the keyboard still on the trigger enters the menu at the value in use', () => {
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()} resolveText={resolveText}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(false)
    // The root pane's first cell carries the current selection.
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[0])
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('a backward step from outside the list enters at the last row, and a closed menu leaves Tab native', () => {
    mountOpen()
    const [modelRow, effortRow] = screen.getAllByRole('menuitem')
    expect(fireEvent.keyDown(modelRow!, { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(effortRow)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
  })

  it('hands a drilled pane the focus its unmounted cell left behind, on the value in use', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    // The fixture's model defaults to the High effort: the checked row is where
    // the keyboard lands, not the top of the list.
    expect(rows[1]!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(rows[1])
    // The walk continues from there.
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[2])
  })

  it('keeps the card navigable when a pane has no rows, and leaves a retry its Tab', () => {
    const load = vi.fn()
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: [], failures: [], status: 'error', error: 'catalog down',
    }))
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={load} resolveText={resolveText}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    const retry = screen.getByRole('button', { name: '重试' })
    expect(fireEvent.mouseDown(retry)).toBe(false)
    fireEvent.click(retry)
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('group', { name: '模型与推理等级' })).toBeTruthy()
    retry.focus()
    // A control that is not a row keeps the browser's traversal.
    expect(fireEvent.keyDown(retry, { key: 'Tab' })).toBe(true)
    fireEvent.keyDown(retry, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull()
  })

  it('focuses the checked model in a small catalog', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows[0]!.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(rows[0])
  })

  it('Escape returns to the root pane with the keyboard on the cell that drilled in', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    fireEvent.keyDown(rows[0]!, { key: 'Escape' })
    // The root pane is back with its two cells.
    const cells = screen.getAllByRole('menuitem')
    // Back on the drilled cell, so the next keystroke still reaches the menu.
    expect(document.activeElement).toBe(cells[1])
    expect(screen.getByRole('menu')).toBeTruthy()
    // A second Escape closes back to the trigger.
    fireEvent.keyDown(cells[1]!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Escape from the model list lands back on the model cell', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.keyDown(screen.getAllByRole('menuitemradio')[0]!, { key: 'Escape' })
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[0])
  })

  it('focuses the first row when no model is checked in a small catalog', () => {
    // The session runs a model the catalog no longer lists: no row is checked.
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel}
      locked={false}
      available
      directory={createSnapshotStore(state({ current: { provider: 'gone', model: 'gone' } }))}
      load={vi.fn()} resolveText={resolveText}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.every(row => row.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(rows[0])
  })
})

describe('ModelSelect catalog size', () => {
  it.each([0, 1, 4, 5])('shows search only above four models (%i models)', (count) => {
    const groups = modelGroups(count)
    const current = { provider: 'deepseek-official', model: count > 1 ? 'model-2' : 'deepseek-v4-flash' }
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(state({ groups, current }))}
      load={vi.fn()} resolveText={resolveText} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    if (count > 0) fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const rows = screen.queryAllByRole('menuitemradio')
    expect(rows).toHaveLength(count)
    if (count > 4) {
      const search = screen.getByRole('searchbox')
      expect(search).toBeInstanceOf(HTMLInputElement)
      expect(document.activeElement).toBe(search)
      expect(search.getAttribute('aria-activedescendant')).toBe(rows[1]!.id)
      expect(rows.every(row => row.tabIndex === -1)).toBe(true)
    } else {
      expect(screen.queryByRole('searchbox')).toBeNull()
      expect(document.activeElement).toBe(count === 0 ? trigger : rows[count > 1 ? 1 : 0])
      expect(rows.every(row => row.tabIndex === 0)).toBe(true)
    }
    if (count === 0) expect(screen.getByRole('status').textContent).toBe(zh['empty.models'])
  })

  it.each([0, 1, 4, 5])('opens an unselected %i-model catalog on search or its first row', (count) => {
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(count), current: null }))}
      load={vi.fn()} resolveText={resolveText} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: '请选择模型' })
    fireEvent.click(trigger)
    const rows = screen.queryAllByRole('menuitemradio')
    expect(rows).toHaveLength(count)
    expect(rows.every(row => row.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(document.activeElement).toBe(count > 4 ? screen.getByRole('searchbox') : rows[0] ?? trigger)
    if (count <= 4) expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it.each([true, false])('clears search and restores focus across 5 → 4 → 5 models (checked: %s)', (checked) => {
    const current = { provider: 'deepseek-official', model: checked ? 'model-3' : 'removed' }
    const directory = createSnapshotStore(state({ groups: modelGroups(5), current }))
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
      resolveText={resolveText} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    if (checked) fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'Model 5' } })
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(document.activeElement).toBe(search)

    act(() => { directory.set(state({ groups: modelGroups(4), current })) })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '清除搜索' })).toBeNull()
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows).toHaveLength(4)
    expect(document.activeElement).toBe(rows[checked ? 2 : 0])

    act(() => { directory.set(state({ groups: modelGroups(5), current })) })
    const restored = screen.getByRole('searchbox')
    expect(restored.getAttribute('value')).toBe('')
    expect(document.activeElement).toBe(restored)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    expect(restored.getAttribute('aria-activedescendant'))
      .toBe(screen.getAllByRole('menuitemradio')[checked ? 2 : 0]!.id)
  })

  it('moves actual row focus with arrows, leaves Enter native, and selects with Tab in a small catalog', async () => {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(4), current: { provider: 'deepseek-official', model: 'model-2' } }))}
      load={vi.fn()} resolveText={resolveText} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(document.activeElement).toBe(rows[1])
    expect(fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(rows[2])
    fireEvent.keyDown(rows[2]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[3])
    fireEvent.keyDown(rows[3]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[3])
    fireEvent.keyDown(rows[3]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[2])
    expect(rows[2]!.hasAttribute('data-highlighted')).toBe(true)
    expect(fireEvent.keyDown(rows[2]!, { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(rows[2]!, { key: 'ArrowLeft' })).toBe(true)
    expect(document.activeElement).toBe(rows[2])
    expect(select).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(rows[2]!, { key: 'Tab' })).toBe(false)
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'model-3' })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull()
    expect(trigger.hasAttribute('data-selection-focus')).toBe(true)
  })

  it('keeps Tab selection available after hovering a small-catalog row', async () => {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(state({ groups: modelGroups(4) }))}
      load={vi.fn()} resolveText={resolveText} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const row = screen.getByRole('menuitemradio', { name: 'Model 3' })
    fireEvent.mouseMove(row)
    expect(document.activeElement).toBe(row)
    expect(row.hasAttribute('data-highlighted')).toBe(true)
    expect(fireEvent.keyDown(row, { key: 'Tab' })).toBe(false)
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'model-3' })
    await waitFor(() => { expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull() })
  })

  it.each(['Escape', 'Tab'])('leaves a small model pane with %s and returns to its root cell', (key) => {
    const select = vi.fn()
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(state({ groups: modelGroups(4) }))}
      load={vi.fn()} resolveText={resolveText} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const row = screen.getAllByRole('menuitemradio')[0]!
    expect(fireEvent.keyDown(row, { key, shiftKey: key === 'Tab' })).toBe(false)
    const cell = screen.getByRole('menuitem', { name: /^模型/ })
    expect(document.activeElement).toBe(cell)
    expect(select).not.toHaveBeenCalled()
    fireEvent.keyDown(cell, { key, shiftKey: key === 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('ModelSelect search', () => {
  it('clears search when reopening an unselected large catalog', () => {
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(5), current: null }))}
      load={vi.fn()} resolveText={resolveText} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: '请选择模型' })
    fireEvent.click(trigger)
    const search = screen.getByRole('searchbox')
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'zzzz' } })
    // Escape would drop the query first; Shift+Tab leaves with it typed.
    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('searchbox').getAttribute('value')).toBe('')
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
  })

  it('hides empty provider headings and announces an empty catalog', () => {
    const directory = createSnapshotStore(state({ groups: [
      ...state().groups, { id: 'empty', name: 'Empty Provider', harnesses: LOOP, models: [] },
    ] }))
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
      resolveText={resolveText} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByRole('group', { name: 'Empty Provider' })).toBeNull()
    act(() => { directory.set(state({ groups: [] })) })
    expect(screen.getByRole('status').textContent).toBe(zh['empty.models'])
    expect(screen.getByRole('status').closest('[role="menu"]')).toBeNull()
  })

  it.each(['Enter', 'Tab'])('returns focus silently after %s accepts the current model, without suppressing later focus', async (key) => {
    const select = vi.fn()
    render(<>
      <button type="button">Outside</button>
      <ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(state({ groups: modelGroups(5) }))}
        load={vi.fn()} resolveText={resolveText} select={select} t={t} />
    </>)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.keyDown(screen.getByRole('searchbox'), { key })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(trigger.hasAttribute('data-selection-focus')).toBe(true)
    expect(select).not.toHaveBeenCalled()
    act(() => { screen.getByRole('button', { name: 'Outside' }).focus() })
    expect(trigger.hasAttribute('data-selection-focus')).toBe(false)
    act(() => { trigger.focus() })
    expect(trigger.hasAttribute('data-selection-focus')).toBe(false)
  })

  it.each(['Enter', 'Tab'])('keeps typing focus while arrows wrap across groups and %s accepts the highlight', async (key) => {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'beta' },
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek', harnesses: LOOP, models: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }] },
        { id: 'other', name: 'Other', harnesses: LOOP, models: [
          { id: 'delta', name: 'Delta' }, { id: 'epsilon', name: 'Epsilon' }, { id: 'gamma', name: 'Gamma' },
        ] },
      ],
    }))
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
      resolveText={resolveText} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    const search = screen.getByRole('searchbox')
    expect(search).toBeInstanceOf(HTMLInputElement)
    const [alpha, beta, delta, epsilon, gamma] = screen.getAllByRole('menuitemradio')
    expect(search.getAttribute('aria-activedescendant')).toBe(beta!.id)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toBe(delta!.id)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toBe(epsilon!.id)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toBe(gamma!.id)
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toBe(alpha!.id)
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(search.getAttribute('aria-activedescendant')).toBe(gamma!.id)
    expect(gamma!.hasAttribute('data-highlighted')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.instances.at(-1)).toBe(gamma)
    expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true)
    expect(fireEvent.keyDown(search, { key: 'ArrowRight' })).toBe(true)
    fireEvent.keyDown(search, { key: 'ArrowDown', isComposing: true })
    expect(search.getAttribute('aria-activedescendant')).toBe(gamma!.id)
    fireEvent.change(search, { target: { value: 'alp' } })
    expect(search.getAttribute('aria-activedescendant')).toBe(screen.getByRole('menuitemradio', { name: 'Alpha' }).id)
    fireEvent.change(search, { target: { value: 'zzzz' } })
    expect(search.hasAttribute('aria-activedescendant')).toBe(false)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(select).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    const restored = screen.getAllByRole('menuitemradio')
    expect(search.getAttribute('aria-activedescendant')).toBe(restored[0]!.id)
    fireEvent.mouseMove(restored[4]!)
    expect(search.getAttribute('aria-activedescendant')).toBe(restored[4]!.id)
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key })
    expect(select).toHaveBeenCalledWith({ provider: 'other', model: 'gamma' })
    await waitFor(() => { expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull() })
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(trigger.hasAttribute('data-selection-focus')).toBe(true)
  })

  it('filters model names fuzzily, hides empty groups, clears on reopening, and selects a result', async () => {
    const directory = createSnapshotStore(state({ groups: [
      ...modelGroups(4),
      { id: 'other', name: 'Other', harnesses: LOOP, models: [{ id: 'gemini', name: 'Gemini Flash' }] },
    ] }))
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
      resolveText={resolveText} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    const search = screen.getByRole('searchbox')
    expect(document.activeElement).toBe(search)
    expect(search.closest('[role="menu"]')).toBeNull()
    expect(fireEvent.keyDown(search, { key: 'ArrowDown', isComposing: true })).toBe(true)
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: '  GMFL  ' } })
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Gemini Flash'])
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(document.activeElement).toBe(search)
    expect(screen.queryByRole('group', { name: 'DeepSeek' })).toBeNull()
    expect(trigger.textContent).toContain('DeepSeek-V4-Flash')
    fireEvent.change(search, { target: { value: 'zzzz' } })
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('没有匹配的模型。')
    expect(status.closest('[role="menu"]')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(fireEvent.keyDown(search, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(search)
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(search.getAttribute('value')).toBe('')
    expect(document.activeElement).toBe(search)
    expect(screen.queryByRole('button', { name: '清除搜索' })).toBeNull()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    fireEvent.change(search, { target: { value: 'gmfl' } })
    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true })
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.getByRole('searchbox').getAttribute('value')).toBe('')
    const reopened = screen.getByRole('searchbox')
    fireEvent.change(reopened, { target: { value: 'gmfl' } })
    const row = screen.getByRole('menuitemradio', { name: 'Gemini Flash' })
    expect(screen.getByRole('menu', { name: '模型' }).contains(row)).toBe(true)
    fireEvent.keyDown(reopened, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(reopened)
    expect(reopened.getAttribute('aria-activedescendant')).toBe(row.id)
    fireEvent.keyDown(reopened, { key: 'Tab' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'other', model: 'gemini' })
  })
})

it('hides the inherited effort until a listed model is selected', async () => {
  const directory = createSnapshotStore<ModelDirectoryState>(state({ current: null, routable: false, retainedEffort: 'High' }))
  render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
    resolveText={resolveText} select={vi.fn()} t={t} />)
  const trigger = screen.getByRole('button', { name: '请选择模型' })
  expect(trigger.hasAttribute('disabled')).toBe(false)
  await expect(`${trigger.textContent}\n`).toMatchFileSnapshot('./expected/unselected-model.txt')
  expect(trigger.textContent).not.toContain('High')
  fireEvent.click(trigger)
  expect(screen.queryByRole('menuitem', { name: /模型/ })).toBeNull()
  expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  expect(screen.queryByRole('searchbox')).toBeNull()
  const row = screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })
  expect(document.activeElement).toBe(row)
  fireEvent.keyDown(row, { key: 'Escape' })
  expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull()
  fireEvent.click(trigger)
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
})


it('places account and official models before third-party models', async () => {
  const groups = ['custom', 'deepseek-official', 'deepseek-account', 'another'].map(id => ({
    id, name: id, harnesses: LOOP, models: [1, 2].map(index => ({ id: `${id}-${index}`, name: `${id}-${index}` })),
  }))
  const directory = createSnapshotStore<ModelDirectoryState>(state({ current: null, groups }))
  render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
    resolveText={resolveText} select={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '请选择模型' }))
  const names = screen.getAllByRole('menuitemradio').map(row => row.textContent)
  expect(names).toEqual([
    'deepseek-account-1', 'deepseek-account-2', 'deepseek-official-1', 'deepseek-official-2',
    'custom-1', 'custom-2', 'another-1', 'another-2',
  ])
  expect(groups.map(group => group.id)).toEqual(['custom', 'deepseek-official', 'deepseek-account', 'another'])
  await expect(`${names.join('\n')}\n`).toMatchFileSnapshot('./expected/account-first.txt')
})

it.each([en, zh])('localizes the account group while preserving external names', (copy) => {
  const groups = ['deepseek-account', 'custom'].map(id => ({
    id, name: id === 'deepseek-account' ? 'DeepSeek Account' : 'My Gateway',
    harnesses: LOOP,
    models: [{ id: 'model', name: 'Model' }],
  }))
  render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available
    directory={createSnapshotStore(state({ current: null, groups }))}
    load={vi.fn()} resolveText={resolveText} select={vi.fn()} t={key => key in copy ? copy[key as keyof typeof copy] : key} />)
  fireEvent.click(screen.getByRole('button', { name: copy['trigger.selectAria'] }))
  expect(screen.getByRole('group', { name: copy['provider.account'] })).toBeTruthy()
  expect(screen.getByRole('group', { name: 'My Gateway' })).toBeTruthy()
})

it('restores the account model name after login without changing the saved route', () => {
  const groups = [{ id: 'deepseek-account', name: 'DeepSeek Account', harnesses: LOOP, models: [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning },
  ] }]
  const selected = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }
  const directory = createSnapshotStore(state({ current: selected, groups, retainedEffort: 'High' }))
  render(<ModelSelect {...seatFace()} renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()}
    resolveText={resolveText} select={vi.fn()} t={t} />)
  expect(screen.getByRole('button', { name: /选择模型，当前/ }).textContent).toBe('DeepSeek FlashHigh')
  act(() => { directory.update((snapshot) => { snapshot.groups = []; snapshot.routable = false }) })
  expect(screen.getByRole('button', { name: '请选择模型' }).textContent).toBe('请选择模型')
  act(() => { directory.update((snapshot) => { snapshot.groups = groups; snapshot.routable = true }) })
  expect(screen.getByRole('button', { name: /选择模型，当前/ }).textContent).toBe('DeepSeek FlashHigh')
  expect(directory.getSnapshot().current).toEqual(selected)
})

/** Two providers whose names, model names, and ids all differ: five models, so the seat shows search. */
const filterGroups = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    harnesses: LOOP,
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'opencode-go',
    name: 'opencode-go',
    harnesses: LOOP,
    models: [
      { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' },
      { id: 'minimax-m3', name: 'MiniMax-M3' },
      { id: 'kimi-k3', name: 'Kimi K3' },
    ],
  },
]

/**
 * Seat props over {@link filterGroups}; a test overrides only the share it exercises.
 * @param overrides - the shares this test drives.
 * @returns the complete prop set.
 */
function seatProps(
  overrides: Partial<ComponentProps<typeof ModelSelect>> = {},
): ComponentProps<typeof ModelSelect> {
  return {
    ...seatFace(),
    renderSlot: renderLabel,
    locked: false,
    available: true,
    directory: createSnapshotStore<ModelDirectoryState>(state({ groups: filterGroups })),
    load: vi.fn(),
    resolveText,
    select: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    t,
    ...overrides,
  }
}

/** Open the seat's drill-in model list. */
function openModels(): void {
  fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
}

/** The visible model rows' text, in render order. */
const rowTexts = (): (string | null)[] => screen.queryAllByRole('menuitemradio').map(row => row.textContent)

describe('ModelSelect id and provider search', () => {
  it('keeps models whose id or provider name contains the query after the ranked name matches', () => {
    render(<ModelSelect {...seatProps()} />)
    openModels()
    const search = screen.getByRole('searchbox')

    fireEvent.change(search, { target: { value: 'qwen' } })
    expect(rowTexts()).toEqual(['Qwen3.8 Flash'])
    // A provider name keeps its whole catalog; an id matches hyphenated spellings.
    fireEvent.change(search, { target: { value: 'OPENCODE' } })
    expect(rowTexts()).toEqual(['Qwen3.8 Flash', 'MiniMax-M3', 'Kimi K3'])
    fireEvent.change(search, { target: { value: 'v4-pro' } })
    expect(rowTexts()).toEqual(['DeepSeek-V4-Pro'])
  })

  it('clears a typed query on Escape before leaving the model list', () => {
    render(<ModelSelect {...seatProps()} />)
    openModels()
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'qwen' } })
    expect(rowTexts()).toHaveLength(1)

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(rowTexts()).toHaveLength(5)
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: /^模型/ })).toBeTruthy()
  })
})

describe('ModelSelect pinned models', () => {
  it('lists pinned models in pin order, labelled with their provider, above the provider groups', () => {
    const pins = createSnapshotStore<ModelPinsState>({
      pinned: [modelPinKey('opencode-go', 'qwen3.8-flash'), modelPinKey('deepseek-official', 'deepseek-v4-pro')],
    })
    render(<ModelSelect {...seatProps({ useModelPins: bindSnapshotSelector(pins) })} />)
    openModels()

    expect(within(screen.getByRole('group', { name: '已固定' })).getAllByRole('menuitemradio')
      .map(row => row.textContent)).toEqual(['Qwen3.8 Flashopencode-go', 'DeepSeek-V4-ProDeepSeek'])
    // Pinned rows are shortcuts, not moves: each stays in its provider group.
    expect(within(screen.getByRole('group', { name: 'DeepSeek' })).getAllByRole('menuitemradio')
      .map(row => row.textContent)).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro'])
    // The provider label is part of the pinned row's accessible name, which is
    // what tells two providers' identically named models apart.
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Pro，提供方 DeepSeek' })).toBeTruthy()
  })

  it('filters the pinned section with the same query and drops pins the catalog no longer serves', () => {
    const pins = createSnapshotStore<ModelPinsState>({
      pinned: ['gone/provider-model', modelPinKey('opencode-go', 'qwen3.8-flash')],
    })
    render(<ModelSelect {...seatProps({ useModelPins: bindSnapshotSelector(pins) })} />)
    openModels()

    expect(within(screen.getByRole('group', { name: '已固定' })).getAllByRole('menuitemradio')
      .map(row => row.textContent)).toEqual(['Qwen3.8 Flashopencode-go'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'minimax' } })
    expect(screen.queryByRole('group', { name: '已固定' })).toBeNull()
    expect(rowTexts()).toEqual(['MiniMax-M3'])
  })

  it('pins and unpins through the row toggle without selecting the model', () => {
    const pins = createSnapshotStore<ModelPinsState>({ pinned: [] })
    const togglePin = vi.fn((providerId: string, modelId: string) => {
      toggleModelPin(pins, modelPinKey(providerId, modelId))
    })
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect {...seatProps({ select, togglePin, useModelPins: bindSnapshotSelector(pins) })} />)
    openModels()
    expect(screen.getByRole('button', { name: '固定 Qwen3.8 Flash' }).getAttribute('aria-pressed')).toBe('false')

    // The toggle is a sibling of the row button, so pinning never selects.
    fireEvent.click(screen.getByRole('button', { name: '固定 Qwen3.8 Flash' }))
    expect(togglePin).toHaveBeenCalledWith('opencode-go', 'qwen3.8-flash')
    expect(select).not.toHaveBeenCalled()

    expect(within(screen.getByRole('group', { name: '已固定' })).getByRole('menuitemradio', { name: /Qwen3.8 Flash/ }))
      .toBeTruthy()
    const unpin = screen.getAllByRole('button', { name: '取消固定 Qwen3.8 Flash' })
    expect(unpin).toHaveLength(2)
    expect(unpin.every(button => button.getAttribute('aria-pressed') === 'true')).toBe(true)

    fireEvent.click(unpin[0]!)
    expect(screen.queryByRole('group', { name: '已固定' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '固定 Qwen3.8 Flash' })).toHaveLength(1)
  })
})

describe('ModelSelect catalog refresh', () => {
  it('asks the Host to fetch its model sources again and keeps the list open', async () => {
    const deferred = Promise.withResolvers<undefined>()
    const refresh = vi.fn().mockReturnValue(deferred.promise)
    render(<ModelSelect {...seatProps({ refresh })} />)
    openModels()

    fireEvent.click(screen.getByRole('button', { name: '刷新模型列表' }))

    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })
    // In flight: the row must not queue a second fetch, and the card must stay
    // open — a self-disabling button would drop focus to the page body, where
    // the seat's blur handler closes the whole menu.
    const running = screen.getByRole('button', { name: '刷新模型列表' })
    expect(running.hasAttribute('disabled')).toBe(false)
    expect(running.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(running)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('group', { name: '模型与推理等级' })).toBeTruthy()

    deferred.resolve(undefined)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '刷新模型列表' }).getAttribute('aria-disabled')).not.toBe('true')
    })
  })

  it('keeps the list usable after a failed refresh', async () => {
    // The Host reports the failure on the shared store; the row must stay
    // usable so the user can try again without reopening the menu.
    const refresh = vi.fn().mockRejectedValue(new Error('model directory unreachable'))
    render(<ModelSelect {...seatProps({ refresh })} />)
    openModels()

    fireEvent.click(screen.getByRole('button', { name: '刷新模型列表' }))

    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '刷新模型列表' }).getAttribute('aria-disabled')).not.toBe('true')
    })
    expect(screen.getByRole('group', { name: '模型与推理等级' })).toBeTruthy()
  })
})
