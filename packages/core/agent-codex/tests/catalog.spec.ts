/**
 * Unit tests for the `codex` catalog route. The adapter reads the shared
 * app-server's `model/list`; these cases drive it through a stand-in runtime
 * so every mapping branch of the picker payload is exercised without a child
 * process.
 */

import { describe, expect, it } from 'vitest'
import { CodexCatalogAdapter } from '../src/catalog.ts'
import type { CodexAppServerRuntime } from '../src/runtime.ts'

/** An adapter over a runtime whose `model/list` answers one fixed catalog. */
function adapterOver(models: Array<Record<string, unknown>>): CodexCatalogAdapter {
  const runtime = { listCodexModels: async () => models } as unknown as CodexAppServerRuntime
  return new CodexCatalogAdapter(runtime)
}

describe('CodexCatalogAdapter', () => {
  it('names the provider route', () => {
    expect(adapterOver([]).providerInfo('codex')).toEqual({ id: 'codex', name: 'Codex' })
  })

  it('refuses every stream request as a catalog-only route', () => {
    expect(() => adapterOver([]).stream({ messages: [] } as never)).toThrow('catalog entry')
  })

  it('maps catalog entries onto the picker model payload', async () => {
    const models = await adapterOver([
      {
        model: 'codex-a',
        displayName: 'Codex A',
        description: 'first',
        inputModalities: ['text', 'image'],
      },
      { id: 'codex-b', inputModalities: ['text', 'audio'] },
    ]).listModels('codex')

    expect(models).toEqual([
      {
        provider: 'codex',
        id: 'codex-a',
        name: 'Codex A',
        description: 'first',
        inputModalities: ['text', 'image'],
      },
      { provider: 'codex', id: 'codex-b', name: 'codex-b', inputModalities: ['text'] },
    ])
  })

  it('refuses an entry that names no model', async () => {
    await expect(adapterOver([{ displayName: 'nameless' }]).listModels('codex'))
      .rejects.toThrow('invalid model/list entry id')
  })

  it('leaves modalities unreported when the entry carries no modalities array', async () => {
    const models = await adapterOver([{ model: 'codex-a', inputModalities: 'text' }]).listModels('codex')
    expect(models[0]).not.toHaveProperty('inputModalities')
  })

  it('resolves an exact model with its reasoning menu', async () => {
    const adapter = adapterOver([{
      model: 'codex-a',
      displayName: 'Codex A',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'high', description: 'slower' },
        { description: 'effortless' },
        'minimal',
      ],
      defaultReasoningEffort: 'low',
    }])
    expect(await adapter.resolveModel('codex', 'codex-a', new AbortController().signal)).toEqual({
      provider: 'codex',
      id: 'codex-a',
      name: 'Codex A',
      reasoning: {
        efforts: [
          { id: 'low', name: 'low' },
          { id: 'high', name: 'high', description: 'slower' },
        ],
        defaultEffort: 'low',
      },
    })
  })

  it('resolves an entry by its fallback id member', async () => {
    const adapter = adapterOver([{ id: 'codex-b', defaultReasoningEffort: 'low' }])
    expect(await adapter.resolveModel('codex', 'codex-b')).toEqual({
      provider: 'codex',
      id: 'codex-b',
      name: 'codex-b',
    })
  })

  it('resolves an unlisted model to an identity entry', async () => {
    const adapter = adapterOver([{ model: 'codex-a' }])
    expect(await adapter.resolveModel('codex', 'codex-gone')).toEqual({
      provider: 'codex',
      id: 'codex-gone',
      name: 'codex-gone',
    })
  })

  it('reports no reasoning menu for an entry without usable efforts', async () => {
    const adapter = adapterOver([
      { model: 'codex-a' },
      { model: 'codex-b', supportedReasoningEfforts: [] },
      { model: 'codex-c', supportedReasoningEfforts: { reasoningEffort: 'low' } },
    ])
    expect(await adapter.resolveModel('codex', 'codex-a')).not.toHaveProperty('reasoning')
    expect(await adapter.resolveModel('codex', 'codex-b')).not.toHaveProperty('reasoning')
    expect(await adapter.resolveModel('codex', 'codex-c')).not.toHaveProperty('reasoning')
  })

  it('reports a reasoning menu without a default effort', async () => {
    const adapter = adapterOver([{ model: 'codex-a', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }])
    expect(await adapter.resolveModel('codex', 'codex-a')).toEqual({
      provider: 'codex',
      id: 'codex-a',
      name: 'codex-a',
      reasoning: { efforts: [{ id: 'low', name: 'low' }] },
    })
  })
})
