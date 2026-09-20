/**
 * Pinned models: the browser-wide favourite list the composer's model menu
 * keeps at the top.
 *
 * Pins belong to the browser rather than to a session, so they live outside
 * the per-session directory and outside the slot store seat (whose instances
 * are materialized per scope key). Persistence is explicit instead of
 * `createSnapshotStore`'s `persist` option because that path installs
 * whatever JSON localStorage holds, and this list owns a durable format
 * other page loads read back.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Pinned-model keys in the order the user pinned them; the menu renders that order. */
export interface ModelPinsState {
  pinned: readonly string[]
}

/** localStorage key holding this browser's pinned models. */
const PINS_KEY = 'dsh.model-pins'

/**
 * Build the key one pinned model is stored under.
 * @param providerId - the provider group id.
 * @param modelId - the provider-owned model id.
 * @returns the pin key.
 */
export function modelPinKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/**
 * Read the persisted pin list.
 * @returns the stored keys, or an empty list when storage is absent, unreadable, or malformed.
 */
function readPinned(): readonly string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(PINS_KEY)
    if (raw === null) return []
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null) return []
    const pinned = (stored as { pinned?: unknown }).pinned
    return Array.isArray(pinned) ? pinned.filter((key): key is string => typeof key === 'string') : []
  } catch {
    // Unparsable JSON: the keys are only a shortcut, so the menu starts
    // unpinned instead of failing to render.
    return []
  }
}

/**
 * Create the browser's pin store, rehydrated from storage and rewritten on
 * every change.
 * @returns the observable pin state.
 */
export function createModelPinsStore(): SnapshotStore<ModelPinsState> {
  const store = createSnapshotStore<ModelPinsState>({ pinned: readPinned() })
  store.subscribe(() => {
    // Non-browser runs (node suites booting the client tree) have no storage.
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(store.getSnapshot()))
    } catch {
      // Quota and private-mode failures only stop persisting; this page keeps
      // using the in-memory list.
    }
  })
  return store
}

/**
 * Add or remove one model's pin.
 * @param store - the pin store to mutate.
 * @param key - the pin key from {@link modelPinKey}.
 */
export function toggleModelPin(store: SnapshotStore<ModelPinsState>, key: string): void {
  store.update((draft) => {
    const at = draft.pinned.indexOf(key)
    // Replaced wholesale: the published state keeps its readonly list type,
    // so the mutator cannot edit the array in place.
    draft.pinned = at === -1
      ? [...draft.pinned, key]
      : draft.pinned.filter((_pinned, index) => index !== at)
  })
}
