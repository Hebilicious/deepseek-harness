import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'

/** The in-process loop, the harness every fixture provider serves. */
const LOOP = ['dsh'] as unknown as ModelCatalog['groups'][number]['harnesses']

const catalog = (model: string): ModelCatalog => ({
  default: { provider: 'fixture', model },
  routableProviders: ['fixture'],
  groups: [{ id: 'fixture', name: 'Fixture', harnesses: LOOP, models: [{ id: model, name: model }] }],
  failures: [],
})

function directory(
  models: () => Promise<unknown>,
  refreshSources: () => Promise<unknown> = () => Promise.resolve({ ok: true, value: catalog('unused') }),
): ModelCatalogDirectory {
  // The providing plugin's context, scripted down to the methods it calls.
  return new ModelCatalogDirectory({
    remote: { session: { modelCatalog: models, refreshModelCatalog: refreshSources } },
  } as never)
}

describe('ModelCatalogDirectory', () => {
  it('shares one failing request, exposes the RPC error, and permits a retry', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: false, error: new RemoteError('gateway/internal', 'catalog offline', {}),
      })
      .mockResolvedValueOnce({ ok: true, value: catalog('recovered') })
    const subject = directory(models)

    const first = subject.load()
    expect(subject.load()).toBe(first)
    await expect(first).rejects.toThrow('gateway/internal: catalog offline')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'gateway/internal: catalog offline' })
    await expect(subject.load()).resolves.toEqual(catalog('recovered'))
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('does not publish a successful result from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.resolve({ ok: true, value: catalog('stale') })
    await expect(stale).resolves.toEqual(catalog('stale'))
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading' })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('does not publish a failure from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.reject(new Error('stale failure'))
    await expect(stale).rejects.toThrow('stale failure')
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading', error: null })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('contains refresh failures while retaining old data and clears it on a failed Host reset', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('old') })
      .mockRejectedValueOnce('refresh failed')
      .mockRejectedValueOnce(new Error('reset failed'))
    const subject = directory(models)
    await subject.load()

    subject.refresh()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: catalog('old'), status: 'error', error: 'refresh failed',
      })
    })

    subject.resetGeneration()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: null, status: 'error', error: 'reset failed',
      })
    })
  })
})

describe('ModelCatalogDirectory.refreshSources', () => {
  it('adopts the catalog the Host rebuilt, and reports a refused refresh', async () => {
    const refreshed = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('published') })
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
    const subject = directory(vi.fn(), refreshed)

    await expect(subject.refreshSources()).resolves.toEqual(catalog('published'))
    expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('published'), status: 'ready', error: null })

    await expect(subject.refreshSources()).rejects.toThrow('gateway/internal: offline')
    // The previously published models stay selectable through a refused refresh.
    expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('published'), status: 'error' })
  })

  it('does not publish a refresh result from an invalidated generation', async () => {
    const pending = Promise.withResolvers<unknown>()
    // The generation reset loads a replacement catalog; it never settles here,
    // so the only value that could appear is the stale refresh's.
    const subject = directory(() => new Promise(() => {}), () => pending.promise)

    const stale = subject.refreshSources()
    subject.resetGeneration()
    pending.resolve({ ok: true, value: catalog('stale') })

    await expect(stale).resolves.toEqual(catalog('stale'))
    expect(subject.store.getSnapshot()).toMatchObject({ value: null })
  })
})

describe('ModelCatalogDirectory.refreshSources failure handling', () => {
  it('reports a failure that is not an Error', async () => {
    // A Remote refusal can arrive as a bare value; the store must still show it.
    const subject = directory(vi.fn(), () => { throw 'gateway offline' })

    await expect(subject.refreshSources()).rejects.toBe('gateway offline')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'gateway offline' })
  })

  it('does not publish a failure from an invalidated generation', async () => {
    const pending = Promise.withResolvers<unknown>()
    const subject = directory(() => new Promise(() => {}), () => pending.promise)

    const stale = subject.refreshSources()
    subject.resetGeneration()
    pending.reject(new Error('stale refresh failure'))

    await expect(stale).rejects.toThrow('stale refresh failure')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'loading', error: null })
  })
})
