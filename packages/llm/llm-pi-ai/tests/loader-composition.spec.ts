/** Profile patch edits and credential updates reach the next real adapter request. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createMessage, createUserMessage, userAgent } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { writeCatalogSnapshot } from '../src/catalog-sync.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

/** One text block, then a tool call truncated by the output-token ceiling. */
const truncatedToolCallEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"partial"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\\"text\\":"}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
  '[DONE]',
]

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

/** The two optional inputs one composition case supplies before the Loader boots. */
interface CompositionOptions {
  /** The profile patch document to boot with. */
  patch?: string
  /** Seed the harness home, for a case that starts from a cache instead of a fetch. */
  prepare?: (home: string) => Promise<void>
}

/**
 * Boot the dormant composition: a bare `llm-pi-ai` row with no config at all.
 * The harness home is this case's own directory, so the catalog snapshot cache
 * is never the real one.
 */
async function loadComposition(
  options: CompositionOptions = {},
): Promise<{ ctx: Context; settingsPath: string; home: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  vi.stubEnv('DSH_HOME', root)
  if (options.patch !== undefined) {
    // The profile keeps an existing patch, so the composition boots with it.
    await mkdir(join(root, 'profile'), { recursive: true })
    await writeFile(join(root, 'profile', 'cordis.patch.yml'), options.patch)
  }
  await options.prepare?.(root)
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  PI_COMPOSITION_KEY: key-from-store\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, root, configPath)
  return { ctx, settingsPath: patchPath, home: root }
}

describe('llm-pi-ai real dormant composition', () => {
  it('boots with zero routes and registers one the moment settings supply a profile', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()

    // The shipped posture: the adapter exists, no route does.
    expect(ctx.llm.listProviders()).toEqual([])

    // Exactly what the web Models page leaves on disk.
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
  })

  it('uses settings-only route headers for model discovery', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ body: JSON.stringify({ data: [{ id: 'acme-private' }] }) }])
    const { ctx, settingsPath } = await loadComposition()

    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      acme-gateway:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      '        api: openai-completions',
      `        baseURL: ${server.url}`,
      '        headers:',
      '          X-Company-Code: private-tenant',
      '          Accept: text/plain',
      '          User-Agent: deployment-owned',
      '        models:',
      '          - id: acme-bootstrap',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['acme-gateway'])
    }, { timeout: 5000 })

    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'acme-gateway',
      baseURL: server.url,
      api: 'openai-completions',
    })).resolves.toEqual([{ id: 'acme-private', name: 'acme-private' }])
    expect(server.paths).toEqual(['/models'])
    expect(server.headers[0]?.['x-company-code']).toBe('private-tenant')
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
    expect(server.headers[0]?.accept).toBe('application/json')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('continues natively after max-token assembly drops a tool call, with pruned replay metadata', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([
      { events: truncatedToolCallEvents },
      { events: textEvents },
    ])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const truncated = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [],
    })
    expect(truncated.finish).toEqual({ kind: 'max-tokens' })
    expect(truncated.message.content).toEqual([{ type: 'text', text: 'partial' }])
    expect(truncated.message.source).toEqual({
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: 'openai-completions',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          stopReason: 'length',
        },
        blocks: [{ type: 'text' }],
      },
    })

    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [
        truncated.message,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
    const followup = server.requests[1] as { messages?: unknown[] }
    expect(followup.messages?.[0]).not.toHaveProperty('tool_calls')
  })

  it('continues a legacy session whose stored replay state no longer matches its content', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // A pre-envelope session log entry: max-token assembly dropped the tool
    // call from content while the flat v1 state still describes both blocks.
    const poisoned = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      source: {
        kind: 'model',
        ...{
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-completions',
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            stopReason: 'length',
            blocks: [{ type: 'text' }, { type: 'tool-call' }],
          },
        },
      },
    })
    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [
        poisoned,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.finish).toEqual({ kind: 'stop' })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests[0]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
  })
})

describe('llm-pi-ai catalog overlay composition', () => {
  /** One OpenCode Go entry the installed catalog of this build does not describe. */
  const directory = {
    'opencode-go': {
      models: {
        'mimo-v2.6-flash': {
          name: 'MiMo V2.6 Flash',
          tool_call: true,
          reasoning: true,
          modalities: { input: ['text', 'image'] },
          limit: { context: 1048576, output: 131072 },
          provider: { npm: '@ai-sdk/openai-compatible' },
        },
      },
    },
  }

  it('serves and requests a directory model the installed catalog does not describe', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([
      { body: JSON.stringify(directory) },
      { events: textEvents },
    ])
    const { ctx, home } = await loadComposition({
      patch: [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      opencode-go:',
        '        apiKeyEnv: PI_COMPOSITION_KEY',
        `        baseURL: ${server.url}`,
        '    catalogOverlay:',
        `      url: ${server.url}`,
        '      refreshHours: 0',
        '',
      ].join('\n'),
    })

    // The snapshot lands after the settings section resolved, so the route is
    // registered before the overlay exists and has to pick it up live.
    await vi.waitFor(async () => {
      const models = await ctx.llm.listModels('opencode-go')
      expect(models.map(model => model.id)).toContain('mimo-v2.6-flash')
    }, { timeout: 5000 })

    const resolved = await ctx.llm.resolveModelInfo('opencode-go', 'mimo-v2.6-flash')
    expect(resolved).toMatchObject({
      provider: 'opencode-go',
      id: 'mimo-v2.6-flash',
      name: 'MiMo V2.6 Flash',
      context: { contextWindow: 1048576 },
    })

    const result = await assemble(ctx, { provider: 'opencode-go', model: 'mimo-v2.6-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests[1]).toMatchObject({ model: 'mimo-v2.6-flash' })
    expect(server.headers[1]?.authorization).toBe('Bearer key-from-store')

    // The snapshot is cached, which is what lets a start with no reachable
    // directory still serve the overlay.
    await expect(readFile(join(home, 'cache', 'llm-pi-ai', 'models-dev.json'), 'utf8'))
      .resolves.toContain('mimo-v2.6-flash')
  })

  it('serves the cached snapshot when the directory is unreachable', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    // Port 9 is the discard service: nothing accepts a connection there.
    const { ctx } = await loadComposition({
      patch: [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      opencode-go:',
        '        apiKeyEnv: PI_COMPOSITION_KEY',
        '    catalogOverlay:',
        '      url: http://127.0.0.1:9/catalog.json',
        '      refreshHours: 12',
        '',
      ].join('\n'),
      prepare: home => writeCatalogSnapshot(join(home, 'cache', 'llm-pi-ai', 'models-dev.json'), {
        document: directory,
        url: 'http://127.0.0.1:9/catalog.json',
        fetchedAt: Date.now(),
      }),
    })

    await vi.waitFor(async () => {
      const models = await ctx.llm.listModels('opencode-go')
      expect(models.map(model => model.id)).toContain('mimo-v2.6-flash')
    }, { timeout: 5000 })
  })

  it('adopts an unchanged snapshot once and leaves installed ids to the catalog', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const repeated = {
      'opencode-go': {
        models: {
          ...directory['opencode-go'].models,
          // An id the installed catalog already describes: the overlay counts it
          // as skipped and the catalog entry keeps serving.
          'mimo-v2.5': { name: 'MiMo V2.5 renamed by the directory', tool_call: true },
        },
      },
    }
    const server = await mockServer([
      { body: JSON.stringify(repeated) },
      { body: JSON.stringify(repeated) },
    ])
    const { ctx } = await loadComposition({
      patch: [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      opencode-go:',
        '        apiKeyEnv: PI_COMPOSITION_KEY',
        '    catalogOverlay:',
        `      url: ${server.url}`,
        '      refreshHours: 12',
        '',
      ].join('\n'),
    })
    await vi.waitFor(async () => {
      const models = await ctx.llm.listModels('opencode-go')
      expect(models.map(model => model.id)).toContain('mimo-v2.6-flash')
    }, { timeout: 5000 })

    // The second fetch returns the same document: it is adopted once, and the
    // installed entry keeps its name either way.
    await ctx.llm.refreshModelCatalogs()
    expect(server.paths).toHaveLength(2)
    const models = await ctx.llm.listModels('opencode-go')
    expect(models.map(model => model.id)).toContain('mimo-v2.6-flash')
    expect(models.find(model => model.id === 'mimo-v2.5')?.name).not.toBe('MiMo V2.5 renamed by the directory')
  })

  it('publishes a model the directory starts serving later on the explicit refresh', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const first = { 'opencode-go': { models: { 'mimo-v2.6-flash': { name: 'MiMo V2.6 Flash', tool_call: true } } } }
    const second = {
      'opencode-go': {
        models: {
          'mimo-v2.6-flash': { name: 'MiMo V2.6 Flash', tool_call: true },
          'mimo-v2.7-flash': { name: 'MiMo V2.7 Flash', tool_call: true },
        },
      },
    }
    const server = await mockServer([
      { body: JSON.stringify(first) },
      { body: JSON.stringify(second) },
    ])
    const { ctx } = await loadComposition({
      patch: [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      opencode-go:',
        '        apiKeyEnv: PI_COMPOSITION_KEY',
        '    catalogOverlay:',
        `      url: ${server.url}`,
        '      refreshHours: 12',
        '',
      ].join('\n'),
    })
    await vi.waitFor(async () => {
      const models = await ctx.llm.listModels('opencode-go')
      expect(models.map(model => model.id)).toContain('mimo-v2.6-flash')
    }, { timeout: 5000 })
    expect((await ctx.llm.listModels('opencode-go')).map(model => model.id)).not.toContain('mimo-v2.7-flash')

    // What the selector's refresh button triggers on the Host.
    await ctx.llm.refreshModelCatalogs()

    await vi.waitFor(async () => {
      const models = await ctx.llm.listModels('opencode-go')
      expect(models.map(model => model.id)).toContain('mimo-v2.7-flash')
    }, { timeout: 5000 })
  })

  it('drops the overlay when the section is removed', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ body: JSON.stringify(directory) }])
    const { ctx, settingsPath } = await loadComposition({
      patch: [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      opencode-go:',
        '        apiKeyEnv: PI_COMPOSITION_KEY',
        '    catalogOverlay:',
        `      url: ${server.url}`,
        '      refreshHours: 0',
        '',
      ].join('\n'),
    })
    await vi.waitFor(async () => {
      const models = await ctx.llm.listModels('opencode-go')
      expect(models.map(model => model.id)).toContain('mimo-v2.6-flash')
    }, { timeout: 5000 })

    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      opencode-go:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      '',
    ].join('\n'))

    await vi.waitFor(async () => {
      const models = await ctx.llm.listModels('opencode-go')
      expect(models.map(model => model.id)).not.toContain('mimo-v2.6-flash')
    }, { timeout: 5000 })
  })

  it('keeps the routes serving when the stored overlay section cannot be fetched from', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await loadComposition({
      patch: [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      deepseek:',
        '        apiKeyEnv: PI_COMPOSITION_KEY',
        `        baseURL: ${server.url}`,
        '    catalogOverlay:',
        '      url: ""',
        '',
      ].join('\n'),
    })

    // The URL is refused where the overlay would start, which is after the
    // routes registered: the adapter keeps them and the overlay simply stays off.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })
    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  })
})
