import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { EXA_MCP_PROVIDER_ID, ExaMcpSearchProvider } from '@deepseek-ai/dsh-web-search-exa-mcp'
import * as exaMcpPlugin from '@deepseek-ai/dsh-web-search-exa-mcp'
import { mapExaMcpBlock, mapExaMcpResponse, mapExaMcpText, parseExaMcpBody } from '../src/provider.ts'

const options = { apiKey: '', endpoint: 'https://mcp.exa.test/mcp' }

/** One result block in the exact rendering the hosted endpoint returns. */
const BLOCK = [
  'Title: Rust ownership explained',
  'URL: https://docs.test/rust-ownership',
  'Published: 2026-08-26T00:00:00.000Z',
  'Author: N/A',
  'Highlights:',
  'Every value has a single owner.',
  '...',
  'The owner frees the value when it goes out of scope.',
].join('\n')

const SECOND_BLOCK = [
  'Title: Second',
  'URL: https://b.test',
  'Published: N/A',
  'Author: Ada',
  'Highlights:',
  'Second highlight.',
].join('\n')

/** One JSON-RPC envelope framed the way the endpoint frames a live answer. */
function sseResponse(envelope: unknown, init: ResponseInit = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  })
}

/** The `arguments` object of the call the provider sent, parsed from one stubbed request. */
function sentArguments(init: RequestInit): Record<string, unknown> {
  const body = JSON.parse(init.body as string) as { params: { arguments: Record<string, unknown> } }
  return body.params.arguments
}

/** A successful answer carrying one rendered text block. */
function resultResponse(text: string): Response {
  return sseResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Exa MCP block mapping', () => {
  it('maps a full block, taking only the first highlight fragment', () => {
    expect(mapExaMcpBlock(BLOCK)).toEqual({
      url: 'https://docs.test/rust-ownership',
      title: 'Rust ownership explained',
      snippet: 'Every value has a single owner.',
      publishedAt: '2026-08-26T00:00:00.000Z',
    })
  })

  it('omits Exa N/A placeholders rather than emitting them', () => {
    expect(mapExaMcpBlock(SECOND_BLOCK)).toEqual({
      url: 'https://b.test',
      title: 'Second',
      snippet: 'Second highlight.',
    })
  })

  it('drops a block with no URL', () => {
    expect(mapExaMcpBlock('Title: Headless\nHighlights:\ntext')).toBeUndefined()
    expect(mapExaMcpBlock('URL: \nTitle: Blank url')).toBeUndefined()
  })

  it('omits the snippet when a block carries no highlight', () => {
    expect(mapExaMcpBlock('URL: https://c.test\nHighlights:')).toEqual({ url: 'https://c.test' })
    expect(mapExaMcpBlock('URL: https://c.test')).toEqual({ url: 'https://c.test' })
  })

  it('skips blank highlight fragments before the first real one', () => {
    expect(mapExaMcpBlock(['URL: https://d.test', 'Highlights:', '', '...', 'real'].join('\n')))
      .toEqual({ url: 'https://d.test', snippet: 'real' })
  })
})

describe('Exa MCP text mapping', () => {
  it('splits rendered blocks on the separator', () => {
    const result = mapExaMcpText(`${BLOCK}\n\n---\n\n${SECOND_BLOCK}`)
    expect(result.sources.map(source => source.url)).toEqual(['https://docs.test/rust-ownership', 'https://b.test'])
    expect(result.truncated).toBe(false)
    expect(result.content).toBeUndefined()
  })

  it('maps the empty-result notice to zero sources', () => {
    expect(mapExaMcpText('No search results found. Please try a different query.'))
      .toEqual({ sources: [], truncated: false })
  })

  it('fails loudly on prose with no result blocks', () => {
    expect(() => mapExaMcpText('Here are some thoughts about rust.')).toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )
  })
})

describe('Exa MCP envelope mapping', () => {
  it('maps a JSON-RPC error to WEB_PROVIDER_ERROR with its message', () => {
    expect(() => mapExaMcpResponse({ error: { code: -32602, message: 'Invalid params' } })).toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Exa MCP error: Invalid params' }),
    )
  })

  it('keeps a generic message when the JSON-RPC error carries none', () => {
    expect(() => mapExaMcpResponse({ error: {} })).toThrow(
      expect.objectContaining({ message: 'Exa MCP returned a JSON-RPC error' }),
    )
  })

  it('rejects an envelope with neither result nor error', () => {
    expect(() => mapExaMcpResponse({})).toThrow(
      expect.objectContaining({ message: 'Exa MCP response carried no result' }),
    )
  })

  it('maps a tool-level isError result to WEB_PROVIDER_ERROR', () => {
    expect(() => mapExaMcpResponse({
      result: { isError: true, content: [{ type: 'text', text: 'MCP error -32602: Tool nope not found' }] },
    })).toThrow(expect.objectContaining({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Exa MCP search failed: MCP error -32602: Tool nope not found',
    }))
  })

  it('names the failure when an isError result carries no text', () => {
    expect(() => mapExaMcpResponse({ result: { isError: true } })).toThrow(
      expect.objectContaining({ message: 'Exa MCP search failed without a message' }),
    )
  })

  it('rejects a result with no text content block', () => {
    expect(() => mapExaMcpResponse({ result: {} })).toThrow(
      expect.objectContaining({ message: 'Exa MCP returned no text content block to map' }),
    )
    expect(() => mapExaMcpResponse({ result: { content: [{ type: 'image' }] } })).toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )
  })
})

describe('Exa MCP body parsing', () => {
  it('parses an SSE-framed envelope', () => {
    expect(parseExaMcpBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'))
      .toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('parses a plain JSON body', () => {
    expect(parseExaMcpBody('{"error":{"code":-32000,"message":"Not Acceptable"}}'))
      .toEqual({ error: { code: -32000, message: 'Not Acceptable' } })
  })

  it('rejects a body with no JSON payload', () => {
    expect(() => parseExaMcpBody('event: ping\n\n')).toThrow(
      expect.objectContaining({ message: 'Exa MCP response body is neither JSON nor an SSE data payload' }),
    )
  })

  it('rejects a data line that is not JSON', () => {
    expect(() => parseExaMcpBody('data: not json\n\n')).toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )
  })

  it('rejects a JSON payload that is not an envelope', () => {
    expect(() => parseExaMcpBody('data: 5\n\n')).toThrow(
      expect.objectContaining({ message: 'Exa MCP response body is not a JSON-RPC envelope' }),
    )
  })
})

describe('ExaMcpSearchProvider availability', () => {
  it('is available with no key at all', () => {
    expect(new ExaMcpSearchProvider(options).available()).toBe(true)
  })

  it('is available when an endpoint query string is already present', () => {
    expect(new ExaMcpSearchProvider({ ...options, endpoint: 'https://mcp.exa.test/mcp?tools=web_search_exa' }).available())
      .toBe(true)
  })

  it('is misconfigured when the endpoint is unparseable', () => {
    expect(new ExaMcpSearchProvider({ ...options, endpoint: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when numResults is set but not a positive integer', () => {
    expect(new ExaMcpSearchProvider({ ...options, numResults: 0 }).available()).toBe(false)
    expect(new ExaMcpSearchProvider({ ...options, numResults: -1 }).available()).toBe(false)
    expect(new ExaMcpSearchProvider({ ...options, numResults: 1.5 }).available()).toBe(false)
  })
})

describe('ExaMcpSearchProvider request mapping', () => {
  it('sends one anonymous JSON-RPC tools/call accepting both response types', async () => {
    const fetchMock = vi.fn(async () => resultResponse(BLOCK))
    vi.stubGlobal('fetch', fetchMock)

    await new ExaMcpSearchProvider(options).search({ query: 'rust ownership', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://mcp.exa.test/mcp')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers['accept']).toBe('application/json, text/event-stream')
    expect(headers['user-agent']).toBe('deepseek-harness/0.0.1')
    expect(headers).not.toHaveProperty('authorization')
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query: 'rust ownership', numResults: 5 } },
    })
  })

  it('appends exaApiKey and preserves an existing endpoint query string', async () => {
    const fetchMock = vi.fn(async () => resultResponse(BLOCK))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new ExaMcpSearchProvider({
      apiKey: 'sk-test',
      endpoint: 'https://mcp.exa.test/mcp?tools=web_search_exa',
    })
    await provider.search({ query: 'q' })

    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    const parsed = new URL(url)
    expect(parsed.searchParams.get('tools')).toBe('web_search_exa')
    expect(parsed.searchParams.get('exaApiKey')).toBe('sk-test')
  })

  it('falls back to the configured numResults when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => resultResponse(BLOCK))
    vi.stubGlobal('fetch', fetchMock)
    await new ExaMcpSearchProvider({ ...options, numResults: 7 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ params: { arguments: { numResults: 7 } } })
  })

  it('lets a request maxResults win over the configured numResults', async () => {
    const fetchMock = vi.fn(async () => resultResponse(BLOCK))
    vi.stubGlobal('fetch', fetchMock)
    await new ExaMcpSearchProvider({ ...options, numResults: 7 }).search({ query: 'q', maxResults: 2 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ params: { arguments: { numResults: 2 } } })
  })

  it('omits numResults when neither maxResults nor a configured default is set', async () => {
    const fetchMock = vi.fn(async () => resultResponse(BLOCK))
    vi.stubGlobal('fetch', fetchMock)
    await new ExaMcpSearchProvider(options).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(sentArguments(init)).not.toHaveProperty('numResults')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => resultResponse(BLOCK))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new ExaMcpSearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('ExaMcpSearchProvider error handling', () => {
  it('prefers the JSON-RPC message from an HTTP error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both"},"id":null}',
      { status: 406 },
    )))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Not Acceptable: Client must accept both' }),
    )
  })

  it('keeps the status-line message when the error body is not an envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ message: 'Exa MCP error (HTTP 502)' }),
    )
  })

  it('keeps the status-line message when the envelope carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{}}', { status: 500 })))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ message: 'Exa MCP error (HTTP 500)' }),
    )
  })

  it('keeps the status-line message when the error body cannot be read at all', async () => {
    const body = { text: () => Promise.reject(new TypeError('terminated')), ok: false, status: 502 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Exa MCP error (HTTP 502)' }),
    )
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
  })

  it('surfaces an abort during the success-body read as WEB_ABORTED', async () => {
    const body = { text: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
  })

  it('surfaces an abort during the error-body read as WEB_ABORTED', async () => {
    const body = { text: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
  })

  it('maps an unreadable success body to WEB_PROVIDER_ERROR', async () => {
    const body = { text: () => Promise.reject(new TypeError('terminated')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"result":{"content":null}}', { status: 200 })))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ message: 'Exa MCP returned no text content block to map' }),
    )
  })

  it('skips a non-object content block while looking for text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"result":{"content":[null,{"type":"text","text":"No search results found."}]}}',
      { status: 200 },
    )))
    await expect(new ExaMcpSearchProvider(options).search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })
})

describe('web-search-exa-mcp plugin registration', () => {
  it('registers the provider into ctx.web with no configuration (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resultResponse(BLOCK)))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_MCP_PROVIDER_ID })
    const fiber = await ctx.plugin(exaMcpPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
      sources: [{ url: 'https://docs.test/rust-ownership' }],
      truncated: false,
    })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in exaMcpPlugin).toBe(false)
  })

  it('threads endpoint and numResults config into the request', async () => {
    const fetchMock = vi.fn(async () => resultResponse(BLOCK))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_MCP_PROVIDER_ID })
    const fiber = await ctx.plugin(exaMcpPlugin, { endpoint: 'https://mcp.exa.test/custom', numResults: 9 })
    await ctx.web.search({ query: 'q' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://mcp.exa.test/custom')
    expect(JSON.parse(init.body as string)).toMatchObject({ params: { arguments: { numResults: 9 } } })
    await fiber.dispose()
  })

  it('falls back to $EXA_API_KEY and the hosted endpoint when config omits them', async () => {
    const prev = process.env.EXA_API_KEY
    process.env.EXA_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => resultResponse(BLOCK))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_MCP_PROVIDER_ID })
      const fiber = await ctx.plugin(exaMcpPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe('https://mcp.exa.ai/mcp?exaApiKey=env-key')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = prev
    }
  })
})
