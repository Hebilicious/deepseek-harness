// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { modelPinKey, toggleModelPin, type ModelPinsState } from '../src/client/pins.ts'
import { zh } from '../src/client/locales.ts'
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
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

/** Two providers whose names, model names, and ids all differ, for filter coverage. */
const groups = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'opencode-go',
    name: 'opencode-go',
    models: [
      { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' },
      { id: 'minimax-m3', name: 'MiniMax-M3' },
    ],
  },
]

/**
 * Seat props with the pin face stubbed and its hook bound the way the
 * renderer binds it; a test overrides only the share it exercises.
 * @param overrides - the shares this test drives.
 * @returns the complete prop set.
 */
function seatProps(
  overrides: Partial<ComponentProps<typeof ModelSelect>> = {},
): ComponentProps<typeof ModelSelect> {
  return {
    locked: false,
    available: true,
    directory: createSnapshotStore<ModelDirectoryState>(state()),
    load: vi.fn(),
    select: vi.fn().mockResolvedValue(true),
    togglePin: vi.fn(),
    useModelPins: bindSnapshotSelector(createSnapshotStore<ModelPinsState>({ pinned: [] })),
    t,
    ...overrides,
  }
}

/** Open the seat's drill-in model list. */
function openModels(): void {
  fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect {...seatProps({ directory, select })} />)

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
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect {...seatProps({ directory })} />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect {...seatProps({ directory, select })} />)

    const trigger = screen.getByRole('button', { name: '选择模型，当前 deepseek-official/removed-model' })
    expect(trigger.textContent).toContain('deepseek-official/removed-model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByRole('menuitemradio', { name: 'removed-model' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect {...seatProps({ directory })} />)

    expect(screen.getByRole('button', { name: '正在加载模型…' }).textContent)
      .toContain('正在加载模型…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
      })).toBeTruthy()
    })
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({
        groups,
        status: 'error',
        error: 'session/model-unavailable: session already contains images',
      }))
      return false
    })
    render(<ModelSelect {...seatProps({ directory, select })} />)

    openModels()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Pro' }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('portals the placed menu card to body and closes only on truly-outside mousedown', () => {
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })
    try {
      const { container } = render(<ModelSelect {...seatProps()} />)
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
      fireEvent.mouseDown(menu)
      fireEvent.mouseDown(trigger)
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
    render(<ModelSelect {...seatProps({ available: false, load })} />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect model filter', () => {
  /** The visible model rows, in render order. */
  const rows = (): HTMLElement[] => screen.getAllByRole('menuitemradio')

  it('filters by model name, model id, and provider name, and reports an unmatched filter', () => {
    render(<ModelSelect {...seatProps({ directory: createSnapshotStore(state({ groups })) })} />)
    openModels()
    const search = screen.getByRole('searchbox', { name: '搜索模型' })
    expect(rows().map(row => row.textContent))
      .toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'Qwen3.8 Flash', 'MiniMax-M3'])

    fireEvent.change(search, { target: { value: 'qwen' } })
    expect(rows().map(row => row.textContent)).toEqual(['Qwen3.8 Flash'])
    // A provider name keeps its whole catalog; an id matches hyphenated spellings.
    fireEvent.change(search, { target: { value: 'OPENCODE' } })
    expect(rows().map(row => row.textContent)).toEqual(['Qwen3.8 Flash', 'MiniMax-M3'])
    fireEvent.change(search, { target: { value: 'v4-pro' } })
    expect(rows().map(row => row.textContent)).toEqual(['DeepSeek-V4-Pro'])

    fireEvent.change(search, { target: { value: 'nope' } })
    expect(screen.queryAllByRole('menuitemradio')).toEqual([])
    expect(screen.getByText('没有匹配“nope”的模型。')).toBeTruthy()
    expect(screen.queryByText('没有可用的模型。')).toBeNull()
  })

  it('reports an empty catalog once, without a no-match message for the filter', () => {
    render(<ModelSelect {...seatProps({
      directory: createSnapshotStore(state({ groups: [], current: null })),
    })} />)
    openModels()
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'qwen' } })

    expect(screen.getByText('没有可用的模型。')).toBeTruthy()
    expect(screen.queryByText(/没有匹配/)).toBeNull()
  })

  it('focuses the filter field when the model list opens', () => {
    render(<ModelSelect {...seatProps({ directory: createSnapshotStore(state({ groups })) })} />)
    openModels()

    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: '搜索模型' }))
  })

  it('drops the filter on Escape before leaving the model list', () => {
    render(<ModelSelect {...seatProps({ directory: createSnapshotStore(state({ groups })) })} />)
    openModels()
    const menu = screen.getByRole('menu')
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'qwen' } })
    expect(rows()).toHaveLength(1)

    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(rows()).toHaveLength(4)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: /模型/ })).toBeTruthy()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('enters the filtered rows with ArrowDown while the search field holds focus', () => {
    render(<ModelSelect {...seatProps({ directory: createSnapshotStore(state({ groups })) })} />)
    openModels()
    const menu = screen.getByRole('menu')
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'qwen' } })

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Qwen3.8 Flash' }))
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Qwen3.8 Flash' }))
  })
})

describe('ModelSelect pinned models', () => {
  /** The rendered groups, in render order. */
  const sections = (): HTMLElement[] => screen.getAllByRole('group')

  it('lists pinned models in pin order, labelled with their provider, above the provider groups', () => {
    const pins = createSnapshotStore<ModelPinsState>({
      pinned: [modelPinKey('opencode-go', 'qwen3.8-flash'), modelPinKey('deepseek-official', 'deepseek-v4-pro')],
    })
    render(<ModelSelect {...seatProps({
      directory: createSnapshotStore(state({ groups })),
      useModelPins: bindSnapshotSelector(pins),
    })} />)
    openModels()

    const [pinned, first] = sections()
    expect(within(pinned!).getByText('已固定')).toBeTruthy()
    expect(within(pinned!).getAllByRole('menuitemradio').map(row => row.textContent))
      .toEqual(['Qwen3.8 Flashopencode-go', 'DeepSeek-V4-ProDeepSeek'])
    // Pinned rows are shortcuts, not moves: each stays in its provider group.
    expect(within(first!).getAllByRole('menuitemradio').map(row => row.textContent))
      .toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro'])
    // The provider label is part of the pinned row's accessible name, which is
    // what tells two providers' identically named models apart.
    expect(screen.getAllByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ })).toHaveLength(2)
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Pro，提供方 DeepSeek' })).toBeTruthy()
  })

  it('filters the pinned section with the same query and drops pins the catalog no longer serves', () => {
    const pins = createSnapshotStore<ModelPinsState>({
      pinned: ['gone/provider-model', modelPinKey('opencode-go', 'qwen3.8-flash')],
    })
    render(<ModelSelect {...seatProps({
      directory: createSnapshotStore(state({ groups })),
      useModelPins: bindSnapshotSelector(pins),
    })} />)
    openModels()

    expect(sections()).toHaveLength(3)
    expect(within(sections()[0]!).getAllByRole('menuitemradio').map(row => row.textContent))
      .toEqual(['Qwen3.8 Flashopencode-go'])

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'minimax' } })
    expect(screen.queryByText('已固定')).toBeNull()
    expect(sections()).toHaveLength(1)
  })

  it('pins and unpins through the row toggle without selecting the model', () => {
    const pins = createSnapshotStore<ModelPinsState>({ pinned: [] })
    const togglePin = vi.fn((providerId: string, modelId: string) => {
      toggleModelPin(pins, modelPinKey(providerId, modelId))
    })
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect {...seatProps({
      directory: createSnapshotStore(state({ groups })),
      select,
      togglePin,
      useModelPins: bindSnapshotSelector(pins),
    })} />)
    openModels()
    expect(screen.getByRole('button', { name: '固定 Qwen3.8 Flash' }).getAttribute('aria-pressed'))
      .toBe('false')

    // The toggle is a sibling of the row button, so pinning never selects.
    fireEvent.click(screen.getByRole('button', { name: '固定 Qwen3.8 Flash' }))
    expect(togglePin).toHaveBeenCalledWith('opencode-go', 'qwen3.8-flash')
    expect(select).not.toHaveBeenCalled()

    const [pinned] = sections()
    expect(within(pinned!).getByRole('menuitemradio', { name: /Qwen3.8 Flash/ })).toBeTruthy()
    const unpin = screen.getAllByRole('button', { name: '取消固定 Qwen3.8 Flash' })
    expect(unpin).toHaveLength(2)
    expect(unpin.every(button => button.getAttribute('aria-pressed') === 'true')).toBe(true)

    fireEvent.click(unpin[0]!)
    expect(screen.queryByText('已固定')).toBeNull()
    expect(screen.getAllByRole('button', { name: '固定 Qwen3.8 Flash' })).toHaveLength(1)
  })
})
