import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import { catalogModels } from '../src/catalog.ts'
import { assertServiceable, Config, resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { DEFAULT_MODELS_MAX_AGE_MS, DEFAULT_MODELS_TIMEOUT_MS, ModelListingCache } from '../src/model-listing.ts'
import type { ListedModel, ModelListingCacheDependencies, ModelListingSettings } from '../src/model-listing.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

const KEY_ENV = 'PI_LISTING_KEY'
const GO_ENDPOINT = 'https://opencode.ai/inference/go/v1'
const goModels = [...catalogModels('opencode-go').values()]
const goChatModel = goModels.find(model => model.api === 'openai-completions')!

beforeEach(() => {
  vi.stubEnv(KEY_ENV, 'route-key')
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await closeMockServers()
})

/** Resolve one route and return its profile and served models. */
function resolveRoute(
  provider: string,
  profile: PiAiProviderProfile,
  options: {
    validation?: 'strict' | 'deferred'
    overlayFor?: (provider: string) => readonly Model<Api>[] | undefined
    listing?: readonly ListedModel[]
  } = {},
) {
  const resolved = resolveProfiles(
    { [provider]: profile },
    options.validation ?? 'strict',
    options.overlayFor,
    options.listing === undefined ? undefined : () => options.listing,
  ).get(provider)!
  return { resolved, models: resolved.piProvider?.getModels() ?? [] }
}

async function harness(config: LlmPiAi.Options): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

const hello = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'test' } })]

describe('inherited catalog', () => {
  it('serves the named provider\'s catalog, endpoints, and overlay under the route\'s own key', () => {
    const overlayModel: Model<Api> = { ...goChatModel, id: 'overlay-only', name: 'Overlay Only' }
    const asked: string[] = []
    const { resolved, models } = resolveRoute('opencode-go-2', {
      catalog: 'opencode-go',
      displayName: 'OpenCode Go (second)',
      apiKeyEnv: KEY_ENV,
      modelOverrides: { [goChatModel.id]: { maxTokens: 1234 } },
    }, { overlayFor: (provider) => { asked.push(provider); return [overlayModel] } })

    expect(asked).toEqual(['opencode-go'])
    expect(resolved.catalogError).toBeUndefined()
    expect(resolved.piProvider?.id).toBe('opencode-go-2')
    expect(models.map(model => model.id)).toEqual([...goModels.map(model => model.id), 'overlay-only'])
    for (const model of models) {
      const installed = catalogModels('opencode-go').get(model.id) ?? overlayModel
      expect(model).toMatchObject({ provider: 'opencode-go-2', api: installed.api, baseUrl: installed.baseUrl })
    }
    expect(models.find(model => model.id === goChatModel.id)?.maxTokens).toBe(1234)
    expect(resolved.configuredMaxTokens.get(goChatModel.id)).toBe(1234)
  })

  it('refuses a catalog the installed build does not ship, on a shipped route, or naming the route itself', () => {
    expect(() => resolveRoute('opencode-go-2', { catalog: 'no-such-provider' }))
      .toThrow('provider "opencode-go-2" sets catalog "no-such-provider", which the installed pi-ai catalog does not ship')
    expect(() => resolveRoute('opencode', { catalog: 'opencode-go' }))
      .toThrow('provider "opencode" sets catalog "opencode-go", but the installed catalog already ships this route')
    expect(() => resolveRoute('opencode-go-2', { catalog: '' })).toThrow('catalog must name another installed provider')
    expect(() => resolveRoute('opencode-go-2', { catalog: 'opencode-go-2' })).toThrow('catalog must name another installed provider')
    expect(() => { assertServiceable({ providers: { 'opencode-go-2': { catalog: 'no-such-provider' } } }) })
      .toThrow('does not ship')
  })

  it('keeps a stored route whose catalog disappeared editable, with the failure as its diagnostic', () => {
    const { resolved } = resolveRoute('opencode-go-2', { catalog: 'no-such-provider' }, { validation: 'deferred' })
    expect(resolved.piProvider).toBeUndefined()
    expect(resolved.catalogError).toContain('which the installed pi-ai catalog does not ship')
  })

  it('authenticates with the route\'s own credential, never the inherited provider\'s environment', async () => {
    vi.stubEnv('OPENCODE_API_KEY', 'ambient-first-account')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness({ providers: {
      'opencode-go-2': { catalog: 'opencode-go', apiKeyEnv: KEY_ENV, baseURL: `${server.url}/v1` },
    } })

    const result = await assemble(ctx, { provider: 'opencode-go-2', model: goChatModel.id, messages: hello })

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer route-key')
    const configurable = ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'opencode-go-2')
    expect(configurable).toMatchObject({ declared: true })
    expect(configurable?.nativeAuth).toBeUndefined()
  })
})

describe('listed catalog resolution', () => {
  const listing: ListedModel[] = [
    { id: 'listed-only', name: 'Listed Only', contextWindow: 4321 },
    { id: goChatModel.id, name: 'Listed Name', contextWindow: 1, maxTokens: 2 },
    { id: 'configured', contextWindow: 5, maxTokens: 6 },
    { id: 'bare' },
  ]
  const route: PiAiProviderProfile = {
    catalog: 'opencode-go',
    apiKeyEnv: KEY_ENV,
    followModelListing: true,
    defaultContextWindow: 1000,
    defaultMaxTokens: 100,
    models: [
      { id: 'configured', contextWindow: 77 },
      { id: 'kept', name: 'Kept' },
    ],
  }

  it('serves the listing in order, then configured models it omits, describing each by entry, catalog, listing, then defaults', () => {
    const { resolved, models } = resolveRoute('opencode-go-2', { ...route, api: 'openai-completions' }, { listing })

    expect(models.map(model => model.id)).toEqual(['listed-only', goChatModel.id, 'configured', 'bare', 'kept'])
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('listed-only')).toMatchObject({
      name: 'Listed Only', contextWindow: 4321, maxTokens: 100, api: 'openai-completions', baseUrl: GO_ENDPOINT, input: ['text'],
    })
    expect(byId.get(goChatModel.id)).toMatchObject({
      name: goChatModel.name, contextWindow: goChatModel.contextWindow, maxTokens: goChatModel.maxTokens,
    })
    expect(byId.get('configured')).toMatchObject({ contextWindow: 77, maxTokens: 6 })
    expect(byId.get('bare')).toMatchObject({ name: 'bare', contextWindow: 1000, maxTokens: 100 })
    expect(resolved.configuredMaxTokens.has('configured')).toBe(false)
    expect(resolved.modelListing).toEqual({
      baseURL: GO_ENDPOINT, api: 'openai-completions', timeoutMs: DEFAULT_MODELS_TIMEOUT_MS, maxAgeMs: DEFAULT_MODELS_MAX_AGE_MS,
    })
  })

  it('reads a mixed-protocol catalog\'s listing over Chat Completions and serves its other models over their own protocol', () => {
    const anthropic = goModels.find(model => model.api === 'anthropic-messages')!
    const { resolved, models } = resolveRoute('opencode-go-2', {
      catalog: 'opencode-go', followModelListing: true, modelsTimeoutMs: 250, modelsMaxAgeMs: 0,
    }, { listing: [{ id: anthropic.id }, { id: 'brand-new' }] })

    expect(resolved.modelListing).toEqual({ baseURL: GO_ENDPOINT, api: 'openai-completions', timeoutMs: 250, maxAgeMs: 0 })
    expect(models.map(model => [model.id, model.api, model.baseUrl])).toEqual([
      [anthropic.id, 'anthropic-messages', anthropic.baseUrl],
      ['brand-new', 'openai-completions', GO_ENDPOINT],
    ])
  })

  it('serves its configured or catalog models until a listing loads, and nothing on a bare route', () => {
    expect(resolveRoute('opencode-go-2', { catalog: 'opencode-go', followModelListing: true }).models.map(model => model.id))
      .toEqual(goModels.map(model => model.id))
    const bare = resolveRoute('commandcode', {
      api: 'openai-completions', baseURL: 'https://api.commandcode.test/provider/v1', followModelListing: true,
    })
    expect(bare.models).toEqual([])
    expect(bare.resolved.catalogError).toBeUndefined()
    expect(() => resolveRoute('commandcode', { api: 'openai-completions', baseURL: 'https://api.commandcode.test/v1' }))
      .toThrow('resolves no models')
  })

  it('ignores a listing once the route stops following it', () => {
    const { models } = resolveRoute('opencode-go-2', { catalog: 'opencode-go' }, { listing: [{ id: 'listed-only' }] })
    expect(models.map(model => model.id)).toEqual(goModels.map(model => model.id))
  })

  it('refuses listing settings it cannot honour', () => {
    expect(() => resolveRoute('commandcode', { api: 'openai-completions', baseURL: 'https://x.test', models: [{ id: 'm' }], modelsMaxAgeMs: 5 }))
      .toThrow('sets modelsMaxAgeMs, which applies only with followModelListing: true')
    expect(() => resolveRoute('commandcode', { api: 'openai-completions', baseURL: 'https://x.test', models: [{ id: 'm' }], modelsTimeoutMs: 5 }))
      .toThrow('sets modelsTimeoutMs, which applies only with followModelListing: true')
    expect(() => resolveRoute('commandcode', { api: 'openai-completions', baseURL: 'https://x.test', followModelListing: true, modelsTimeoutMs: 0 }))
      .toThrow('modelsTimeoutMs must be a positive finite number')
    expect(() => resolveRoute('commandcode', { api: 'openai-completions', baseURL: 'https://x.test', followModelListing: true, modelsMaxAgeMs: 1.5 }))
      .toThrow('modelsMaxAgeMs must be a non-negative safe integer')
    expect(() => resolveRoute('commandcode', { api: 'openai-completions', followModelListing: true }))
      .toThrow('follows its model listing but has no baseURL to read it from')
    expect(() => resolveRoute('commandcode', { baseURL: 'https://x.test', followModelListing: true }))
      .toThrow('follows its model listing but names no api')
    expect(() => resolveRoute('gemini-2', { catalog: 'google', followModelListing: true }))
      .toThrow('follows its model listing over api "google-generative-ai", which has no listing this build can read')
    const unchecked: Record<string, unknown> = { followModelListing: 'yes' }
    expect(() => Config({ providers: { x: { ...unchecked } } })).toThrow()
  })
})

/** A cache over a scripted transport and a hand-moved clock. */
function cacheHarness() {
  let now = 0
  const loads: {
    settings: ModelListingSettings
    credential: string | undefined
    signal: AbortSignal
    answer: PromiseWithResolvers<readonly ListedModel[]>
  }[] = []
  const warnings: string[] = []
  const changed = vi.fn()
  const dependencies: ModelListingCacheDependencies = {
    load: (settings, credential, signal) => {
      const answer = Promise.withResolvers<readonly ListedModel[]>()
      loads.push({ settings, credential, signal, answer })
      return answer.promise
    },
    now: () => now,
    warn: (message) => { warnings.push(message) },
    changed,
  }
  return {
    cache: new ModelListingCache(dependencies),
    loads,
    warnings,
    changed,
    advance: (ms: number) => { now += ms },
  }
}

const settings: ModelListingSettings = { baseURL: 'https://gateway.test/v1', api: 'openai-completions', timeoutMs: 1000, maxAgeMs: 600 }

describe('listing cache', () => {
  it('waits for the first listing, then refreshes a stale one in the background on the next access', async () => {
    const { cache, loads, changed, advance } = cacheHarness()
    const first = cache.access(settings, 'key')
    expect(loads).toHaveLength(1)
    loads[0]!.answer.resolve([{ id: 'a' }])
    await first
    expect(cache.current()).toEqual([{ id: 'a' }])
    expect(changed).toHaveBeenCalledOnce()

    advance(599)
    await cache.access(settings, 'key')
    expect(loads).toHaveLength(1)

    advance(1)
    await cache.access(settings, 'key')
    expect(loads).toHaveLength(2)
    expect(cache.current()).toEqual([{ id: 'a' }])
    const published = new Promise<void>((resolve) => { changed.mockImplementationOnce(() => { resolve() }) })
    loads[1]!.answer.resolve([{ id: 'a' }, { id: 'b' }])
    await published
    expect(cache.current()).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('publishes nothing when a refresh lists the same models', async () => {
    const { cache, loads, changed } = cacheHarness()
    const first = cache.access(settings, 'key')
    loads[0]!.answer.resolve([{ id: 'a' }])
    await first
    const again = cache.access(settings, 'key', { refresh: true })
    loads[1]!.answer.resolve([{ id: 'a' }])
    await again
    expect(changed).toHaveBeenCalledOnce()
  })

  it('keeps the last good listing through failures and reports a failing streak once', async () => {
    const { cache, loads, warnings, advance } = cacheHarness()
    const first = cache.access(settings, 'key')
    loads[0]!.answer.reject(new Error('down'))
    await first
    expect(cache.current()).toBeUndefined()
    expect(warnings).toEqual(['llm-pi-ai: model listing from https://gateway.test/v1 failed (Error: down); serving the configured models'])

    const recovered = cache.access(settings, 'key', { refresh: true })
    loads[1]!.answer.resolve([{ id: 'a' }])
    await recovered
    for (const attempt of [2, 3]) {
      advance(600)
      const failing = cache.access(settings, 'key', { refresh: true })
      loads[attempt]!.answer.reject(new Error('down again'))
      await failing
    }
    expect(cache.current()).toEqual([{ id: 'a' }])
    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toContain('keeping the previous listing')
  })

  it('scopes a listing to its endpoint and credential', async () => {
    const { cache, loads } = cacheHarness()
    const first = cache.access(settings, 'key-one')
    loads[0]!.answer.resolve([{ id: 'account-one' }])
    await first

    const rotated = cache.access(settings, 'key-two')
    expect(cache.current()).toBeUndefined()
    expect(loads[1]?.credential).toBe('key-two')
    loads[1]!.answer.resolve([{ id: 'account-two' }])
    await rotated
    expect(cache.current()).toEqual([{ id: 'account-two' }])

    const repointed = cache.access({ ...settings, baseURL: 'https://other.test/v1' }, 'key-two')
    expect(cache.current()).toBeUndefined()
    loads[2]!.answer.resolve([])
    await repointed
    expect(cache.current()).toEqual([])
  })

  it('bounds the first access by the request deadline', async () => {
    vi.useFakeTimers()
    const { cache, loads, warnings } = cacheHarness()
    const first = cache.access({ ...settings, timeoutMs: 50 }, 'key')
    loads[0]!.signal.addEventListener('abort', () => { loads[0]!.answer.reject(loads[0]!.signal.reason) })
    await vi.advanceTimersByTimeAsync(50)
    await first
    expect(cache.current()).toBeUndefined()
    expect(warnings[0]).toContain('serving the configured models')
  })

  it('shares one load between concurrent first accesses, and lists a keyless route', async () => {
    const { cache, loads } = cacheHarness()
    const first = cache.access(settings, undefined)
    const second = cache.access(settings, undefined)
    expect(loads).toHaveLength(1)
    expect(loads[0]!.credential).toBeUndefined()
    loads[0]!.answer.resolve([{ id: 'a' }])
    await Promise.all([first, second])
    expect(cache.current()).toEqual([{ id: 'a' }])
  })

  it('lets one caller abandon its wait while the load carries on', async () => {
    const { cache, loads } = cacheHarness()
    const abandoned = new AbortController()
    const waiting = cache.access(settings, 'key', { signal: abandoned.signal })
    abandoned.abort(new Error('caller left'))
    await expect(waiting).rejects.toThrow('caller left')
    await expect(cache.access(settings, 'key', { signal: abandoned.signal })).rejects.toThrow('caller left')
    const completed = cache.access(settings, 'key', { signal: new AbortController().signal })
    loads[0]!.answer.resolve([{ id: 'a' }])
    await completed
    expect(loads).toHaveLength(1)
    expect(cache.current()).toEqual([{ id: 'a' }])
  })

  it('ignores the answer of a scope it already left, success or failure', async () => {
    const { cache, loads, warnings, changed } = cacheHarness()
    void cache.access(settings, 'key-one')
    void cache.access(settings, 'key-two')
    const third = cache.access(settings, 'key-three')
    loads[0]!.answer.resolve([{ id: 'stale' }])
    loads[1]!.answer.reject(new Error('stale failure'))
    loads[2]!.answer.resolve([{ id: 'current' }])
    await third
    expect(cache.current()).toEqual([{ id: 'current' }])
    expect(warnings).toEqual([])
    expect(changed).toHaveBeenCalledOnce()
  })

  it('reports a change notification that fails and keeps the listing', async () => {
    const { cache, loads, warnings, changed } = cacheHarness()
    changed.mockImplementation(() => { throw new Error('observer broke') })
    const first = cache.access(settings, 'key')
    loads[0]!.answer.resolve([{ id: 'a' }])
    await first
    expect(cache.current()).toEqual([{ id: 'a' }])
    expect(warnings).toEqual(['llm-pi-ai: model listing change notification failed (Error: observer broke)'])
  })

  it('stops loading on disposal and ignores the answer in flight', async () => {
    const { cache, loads, changed } = cacheHarness()
    void cache.access(settings, 'key')
    const disposed = cache.dispose()
    expect(loads[0]!.signal.aborted).toBe(true)
    loads[0]!.answer.resolve([{ id: 'late' }])
    await disposed
    expect(cache.current()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
    await cache.access(settings, 'key')
    expect(loads).toHaveLength(1)
  })
})

describe('following a listing in a real composition', () => {
  const listingBody = (ids: string[]): string => JSON.stringify({ data: ids.map(id => ({ id, context_length: 32_768 })) })

  it('waits for the listing on first use, serves its models, and republishes on refresh', async () => {
    const server = await mockServer([
      { body: listingBody(['cc-large', 'cc-small']) },
      { events: textEvents },
      { body: listingBody(['cc-large', 'cc-new']) },
      { status: 500 },
    ])
    const ctx = await harness({ providers: {
      'commandcode-goat': {
        apiKeyEnv: KEY_ENV,
        api: 'openai-completions',
        baseURL: `${server.url}/provider/v1`,
        followModelListing: true,
        headers: { 'X-Tenant': 'goat' },
      },
    } })
    const updates: string[] = []
    ctx.on('llm/models-updated', (provider) => { updates.push(provider) })

    expect((await ctx.llm.listModels('commandcode-goat')).map(model => model.id)).toEqual(['cc-large', 'cc-small'])
    expect(server.paths[0]).toBe('/provider/v1/models')
    expect(server.headers[0]).toMatchObject({ authorization: 'Bearer route-key', 'x-tenant': 'goat' })
    expect(updates).toEqual(['commandcode-goat'])
    expect((await ctx.llm.resolveModelInfo('commandcode-goat', 'cc-small')).context).toEqual({ contextWindow: 32_768 })

    const result = await assemble(ctx, { provider: 'commandcode-goat', model: 'cc-small', messages: hello })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.paths[1]).toBe('/provider/v1/chat/completions')
    expect((server.requests[1] as { model: string }).model).toBe('cc-small')

    await ctx.llm.refreshModelCatalogs()
    expect(updates).toEqual(['commandcode-goat', 'commandcode-goat'])
    expect((await ctx.llm.listModels('commandcode-goat')).map(model => model.id)).toEqual(['cc-large', 'cc-new'])

    await ctx.llm.refreshModelCatalogs()
    expect(server.paths).toHaveLength(4)
    expect((await ctx.llm.listModels('commandcode-goat')).map(model => model.id)).toEqual(['cc-large', 'cc-new'])
    expect(updates).toHaveLength(2)
  })

  it('lists a keyless route, and drops its cache when the route stops following', async () => {
    const server = await mockServer([{ body: listingBody(['local-a']) }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const live = await liveConfig(ctx, LlmPiAi, { providers: {
      local: { api: 'openai-completions', baseURL: `${server.url}/v1`, followModelListing: true, models: [{ id: 'fallback' }] },
    } })
    expect((await ctx.llm.listModels('local')).map(model => model.id)).toEqual(['local-a', 'fallback'])
    expect(server.headers[0]?.authorization).toBeUndefined()

    await live.update({ providers: { local: { displayName: 'Local' } } })
    expect((await ctx.llm.listModels('local')).map(model => model.id)).toEqual(['local-a', 'fallback'])
    await live.update({ providers: { local: { followModelListing: false } } })
    expect((await ctx.llm.listModels('local')).map(model => model.id)).toEqual(['fallback'])
    // A fresh cache loads again; the script is exhausted, so the route falls back to its models.
    await live.update({ providers: { local: { followModelListing: true } } })
    expect((await ctx.llm.listModels('local')).map(model => model.id)).toEqual(['fallback'])
    expect(server.paths).toEqual(['/v1/models', '/v1/models'])
    await ctx.fiber.dispose()
  })

  it('offers no listing for a route whose named credential is missing', async () => {
    vi.stubEnv(KEY_ENV, '')
    const server = await mockServer([])
    const ctx = await harness({ providers: {
      'commandcode-goat': {
        apiKeyEnv: KEY_ENV, api: 'openai-completions', baseURL: `${server.url}/v1`, followModelListing: true,
      },
    } })
    expect(await ctx.llm.listModels('commandcode-goat')).toEqual([])
    expect(server.paths).toEqual([])
  })
})
