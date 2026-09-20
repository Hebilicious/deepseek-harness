// @vitest-environment jsdom
/**
 * The pin store owns a durable localStorage entry that later page loads read
 * back, so every malformed and unreadable case is asserted here rather than
 * left to a component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelPinsStore, modelPinKey, toggleModelPin } from '../src/client/pins.ts'

const PINS_KEY = 'dsh.model-pins'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('model pins', () => {
  it('keeps pin order and reads it back on the next page load', () => {
    const store = createModelPinsStore()
    expect(store.getSnapshot().pinned).toEqual([])

    toggleModelPin(store, modelPinKey('opencode-go', 'qwen3.8-flash'))
    toggleModelPin(store, modelPinKey('deepseek-official', 'deepseek-v4-pro'))
    const pinned = ['opencode-go/qwen3.8-flash', 'deepseek-official/deepseek-v4-pro']
    expect(store.getSnapshot().pinned).toEqual(pinned)
    expect(createModelPinsStore().getSnapshot().pinned).toEqual(pinned)

    toggleModelPin(store, modelPinKey('opencode-go', 'qwen3.8-flash'))
    expect(store.getSnapshot().pinned).toEqual(['deepseek-official/deepseek-v4-pro'])
  })

  it('starts empty on storage that is absent, unparsable, or another shape', () => {
    localStorage.setItem(PINS_KEY, '{')
    expect(createModelPinsStore().getSnapshot().pinned).toEqual([])

    localStorage.setItem(PINS_KEY, '"deepseek-official/deepseek-v4-flash"')
    expect(createModelPinsStore().getSnapshot().pinned).toEqual([])

    localStorage.setItem(PINS_KEY, '{"pinned":"deepseek-official/deepseek-v4-flash"}')
    expect(createModelPinsStore().getSnapshot().pinned).toEqual([])
  })

  it('keeps the keys it can read and drops entries that are not keys', () => {
    localStorage.setItem(PINS_KEY, '{"pinned":["a/b",7,null,{"provider":"c"}]}')
    expect(createModelPinsStore().getSnapshot().pinned).toEqual(['a/b'])
  })

  it('keeps the in-memory list when storage refuses the write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const store = createModelPinsStore()

    toggleModelPin(store, 'a/b')

    expect(store.getSnapshot().pinned).toEqual(['a/b'])
    expect(setItem).toHaveBeenCalled()
  })
})
