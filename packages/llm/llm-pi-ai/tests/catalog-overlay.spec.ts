/**
 * The overlay's rules are what keep it from inventing an endpoint: protocol,
 * base URL, compatibility switches, reasoning map, and headers all come from
 * the installed models of the same provider and protocol, and only the model's
 * own facts come from the directory. The synthetic provider below states those
 * rules one branch at a time, and the last case pins the real OpenCode Go
 * catalog, where the overlay is what a newer model needs to be requestable.
 */

import { describe, expect, it } from 'vitest'
import { catalogModels, catalogProviderIds } from '../src/catalog.ts'
import { mapCatalogOverlay, overlayCatalog } from '../src/catalog-overlay.ts'
import type { CatalogModel } from '../src/catalog-overlay.ts'

/** One installed model of a synthetic provider, with the caller's facts layered on. */
function installed(over: Partial<CatalogModel> & Pick<CatalogModel, 'id' | 'api'>): CatalogModel {
  return {
    name: over.id,
    provider: 'acme',
    baseUrl: 'https://acme.test/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...over,
  }
}

/** The `installed` lookup `mapCatalogOverlay` reads, over a provider table. */
function lookup(table: Readonly<Record<string, readonly CatalogModel[]>>) {
  return (provider: string): Map<string, CatalogModel> =>
    new Map((table[provider] ?? []).map(model => [model.id, model]))
}

/** One directory document for `acme`, whose entries the cases vary. */
function document(entries: Readonly<Record<string, unknown>>): unknown {
  return { acme: { models: entries } }
}

describe('catalog overlay mapping', () => {
  it('maps a directory entry onto the endpoint facts of its provider and protocol', () => {
    const acme = [installed({
      id: 'acme-large',
      api: 'openai-completions',
      compat: { maxTokensField: 'max_tokens' },
    })]
    const overlay = mapCatalogOverlay(document({
      'acme-next': {
        name: 'Acme Next',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'] },
        limit: { context: 8192, output: 1024 },
        cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 0.25 },
        provider: { npm: '@ai-sdk/openai-compatible' },
      },
    }), ['acme'], lookup({ acme }))

    expect([...overlay.models.keys()]).toEqual(['acme'])
    expect(overlay.models.get('acme')).toEqual([{
      id: 'acme-next',
      name: 'Acme Next',
      api: 'openai-completions',
      provider: 'acme',
      baseUrl: 'https://acme.test/v1',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
      compat: { maxTokensField: 'max_tokens' },
      contextWindow: 8192,
      maxTokens: 1024,
    }])
    expect(overlay.skipped).toEqual({ untooled: 0, deprecated: 0, installed: 0, unmapped: 0 })
  })

  it('takes the most common endpoint facts, and the first model to state a tied one', () => {
    const acme = [
      installed({ id: 'first', api: 'openai-completions', compat: { supportsStore: true }, headers: { 'x-first': '1' } }),
      installed({ id: 'second', api: 'openai-completions', compat: { supportsStore: false }, headers: { 'x-second': '2' } }),
      installed({ id: 'third', api: 'openai-completions', compat: { supportsStore: true }, headers: { 'x-first': '1' } }),
    ]
    const overlay = mapCatalogOverlay(document({
      'acme-next': { tool_call: true, provider: { npm: '@ai-sdk/openai-compatible' } },
    }), ['acme'], lookup({ acme }))

    const next = overlay.models.get('acme')?.[0]
    expect(next?.compat).toEqual({ supportsStore: true })
    expect(next?.headers).toEqual({ 'x-first': '1' })
  })

  it('leaves a protocol served from several endpoints out', () => {
    const acme = [
      installed({ id: 'one', api: 'openai-completions' }),
      installed({ id: 'two', api: 'openai-completions', baseUrl: 'https://acme.test/eu/v1' }),
    ]
    const overlay = mapCatalogOverlay(document({
      'acme-next': { tool_call: true, provider: { npm: '@ai-sdk/openai-compatible' } },
    }), ['acme'], lookup({ acme }))

    expect(overlay.models.size).toBe(0)
    expect(overlay.skipped.unmapped).toBe(1)
  })

  it('falls back to the provider protocol when the entry names no known package', () => {
    const acme = [installed({ id: 'one', api: 'anthropic-messages', baseUrl: 'https://acme.test' })]
    const overlay = mapCatalogOverlay(document({
      'acme-next': { tool_call: true, reasoning: true },
      'acme-other': { tool_call: true, provider: { npm: '@ai-sdk/unknown' } },
    }), ['acme'], lookup({ acme }))

    expect(overlay.models.get('acme')?.map(model => [model.id, model.api])).toEqual([
      ['acme-next', 'anthropic-messages'],
      ['acme-other', 'anthropic-messages'],
    ])
  })

  it('leaves an entry out when its provider does not serve that protocol', () => {
    const acme = [installed({ id: 'one', api: 'openai-completions' })]
    const overlay = mapCatalogOverlay(document({
      'acme-claude': { tool_call: true, provider: { npm: '@ai-sdk/anthropic' } },
    }), ['acme'], lookup({ acme }))

    expect(overlay.models.size).toBe(0)
    expect(overlay.skipped.unmapped).toBe(1)
  })

  it('leaves an entry out when the provider serves several protocols and the entry names none', () => {
    const acme = [
      installed({ id: 'one', api: 'openai-completions' }),
      installed({ id: 'two', api: 'anthropic-messages', baseUrl: 'https://acme.test' }),
    ]
    const overlay = mapCatalogOverlay(document({
      'acme-next': { tool_call: true },
    }), ['acme'], lookup({ acme }))

    expect(overlay.models.size).toBe(0)
    expect(overlay.skipped.unmapped).toBe(1)
  })

  it('counts every entry it leaves out, by reason', () => {
    const acme = [installed({ id: 'acme-large', api: 'openai-completions' })]
    const overlay = mapCatalogOverlay(document({
      'acme-large': { tool_call: true },
      'acme-retired': { tool_call: true, status: 'deprecated' },
      'acme-chat': { tool_call: false },
      'acme-broken': null,
      'acme-next': { tool_call: true },
    }), ['acme'], lookup({ acme }))

    expect(overlay.skipped).toEqual({ untooled: 1, deprecated: 1, installed: 1, unmapped: 1 })
    expect(overlay.models.get('acme')?.map(model => model.id)).toEqual(['acme-next'])
  })

  it('contributes nothing for a document, provider, or record that is not an object', () => {
    const acme = [installed({ id: 'acme-large', api: 'openai-completions' })]
    expect(mapCatalogOverlay(null, ['acme'], lookup({ acme })).models.size).toBe(0)
    expect(mapCatalogOverlay([], ['acme'], lookup({ acme })).models.size).toBe(0)
    expect(mapCatalogOverlay('catalog', ['acme'], lookup({ acme })).models.size).toBe(0)
    expect(mapCatalogOverlay({ acme: { models: { x: 1 } } }, ['acme'], lookup({ acme })).skipped.unmapped).toBe(1)
    expect(mapCatalogOverlay({ acme: { models: [] } }, ['acme'], lookup({ acme })).models.size).toBe(0)
    expect(mapCatalogOverlay({}, ['acme'], lookup({ acme })).models.size).toBe(0)
    // A provider the installed catalog does not ship has no endpoint facts at all.
    expect(mapCatalogOverlay(document({ x: { tool_call: true } }), ['unknown'], lookup({ acme })).models.size).toBe(0)
  })

  it('copies inherited maps and headers instead of sharing them with the installed model', () => {
    const acme = [installed({
      id: 'acme-large',
      api: 'openai-completions',
      reasoning: true,
      thinkingLevelMap: { high: 'high' },
      headers: { 'x-tenant': 'one' },
    })]
    const overlay = mapCatalogOverlay(document({
      'acme-next': { tool_call: true, reasoning: true },
    }), ['acme'], lookup({ acme }))

    const next = overlay.models.get('acme')?.[0]
    expect(next?.thinkingLevelMap).toEqual({ high: 'high' })
    expect(next?.headers).toEqual({ 'x-tenant': 'one' })
    if (next?.thinkingLevelMap !== undefined) next.thinkingLevelMap.high = 'mutated'
    if (next?.headers !== undefined) next.headers['x-tenant'] = 'mutated'
    expect(acme[0]?.thinkingLevelMap).toEqual({ high: 'high' })
    expect(acme[0]?.headers).toEqual({ 'x-tenant': 'one' })
  })

  it('drops the reasoning map for a non-reasoning entry and fills absent facts defensively', () => {
    const acme = [installed({
      id: 'acme-large',
      api: 'openai-completions',
      contextWindow: 4096,
      maxTokens: 512,
      compat: { maxTokensField: 'max_tokens' },
    })]
    const overlay = mapCatalogOverlay(document({
      'acme-next': {
        tool_call: true,
        reasoning: false,
        modalities: { input: 'text' },
        limit: { context: 0, output: -1 },
        cost: { input: -1, output: 'free', cache_read: Number.NaN },
      },
    }), ['acme'], lookup({ acme }))

    expect(overlay.models.get('acme')?.[0]).toEqual({
      id: 'acme-next',
      name: 'acme-next',
      api: 'openai-completions',
      provider: 'acme',
      baseUrl: 'https://acme.test/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { maxTokensField: 'max_tokens' },
      contextWindow: 4096,
      maxTokens: 512,
    })
  })

  it('maps MiMo V2.6 onto the installed OpenCode Go gateway', () => {
    const overlay = mapCatalogOverlay({
      'opencode-go': {
        models: {
          // The published entries name no npm package, so the gateway's stated
          // convention is what places them on Chat Completions.
          'mimo-v2.6-flash': {
            name: 'MiMo V2.6 Flash',
            tool_call: true,
            reasoning: true,
            modalities: { input: ['text', 'image'] },
            limit: { context: 1048576, output: 131072 },
            cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
          },
          'mimo-v2.5': { name: 'installed already', tool_call: true },
        },
      },
    }, catalogProviderIds(), catalogModels)

    expect(overlay.skipped.installed).toBe(1)
    const [mapped] = overlay.models.get('opencode-go') ?? []
    expect(mapped).toMatchObject({
      id: 'mimo-v2.6-flash',
      name: 'MiMo V2.6 Flash',
      api: 'openai-completions',
      provider: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1048576,
      maxTokens: 131072,
      // The V2.5 siblings' gateway switches, which the V2.6 entries state no facts about.
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    })
    expect(catalogModels('opencode-go').has('mimo-v2.6-flash')).toBe(false)
  })

  it('leaves a package-less entry unplaced on a gateway that publishes no convention', () => {
    const overlay = mapCatalogOverlay({
      // Cloudflare AI Gateway serves several protocols and names a package for
      // each of its entries, so a package-less one states no protocol.
      'cloudflare-ai-gateway': {
        models: { 'acme-next': { name: 'Acme Next', tool_call: true } },
      },
    }, catalogProviderIds(), catalogModels)

    expect(overlay.models.size).toBe(0)
    expect(overlay.skipped.unmapped).toBe(1)
  })
})

describe('catalog merge', () => {
  it('adds only the ids the installed catalog does not describe', () => {
    const installedCatalog = new Map([['known', installed({ id: 'known', api: 'openai-completions' })]])
    const merged = overlayCatalog(installedCatalog, [
      installed({ id: 'known', api: 'anthropic-messages' }),
      installed({ id: 'next', api: 'openai-completions' }),
    ])

    expect([...merged.keys()]).toEqual(['known', 'next'])
    expect(merged.get('known')?.api).toBe('openai-completions')
    expect(merged.get('known')).toBe(installedCatalog.get('known'))
  })

  it('returns the installed catalog itself when there is nothing to add', () => {
    const installedCatalog = new Map([['known', installed({ id: 'known', api: 'openai-completions' })]])
    expect(overlayCatalog(installedCatalog, undefined)).toBe(installedCatalog)
    expect(overlayCatalog(installedCatalog, [])).toBe(installedCatalog)
  })
})
