/**
 * `ExaMcpSearchProvider`: a `WebSearchProvider` backed by the hosted Exa MCP
 * endpoint (`tools/call` for `web_search_exa`). The endpoint answers without any
 * credential, so `available()` needs no key; a supplied key only raises the
 * endpoint's rate limits. Exa renders its results as prose blocks rather than a
 * structured source array, so this provider parses
 * `Title:`/`URL:`/`Published:`/`Highlights:` blocks and treats a body carrying
 * neither those blocks nor Exa's own empty-result notice as an error — the rule
 * `dsh-web-search-deepseek` states: absence of the expected blocks is an error
 * rather than a prose-scraping fallback. It omits `content` because Exa returns
 * no generated answer.
 *
 * @module @deepseek-ai/dsh-web-search-exa-mcp/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ExaMcpResponse, ExaMcpToolCallRequest, ExaMcpToolResult } from './types.ts'

/** Stable id this provider registers under. */
export const EXA_MCP_PROVIDER_ID = 'exa-mcp'

/** The hosted Exa MCP endpoint. */
export const EXA_MCP_DEFAULT_ENDPOINT = 'https://mcp.exa.ai/mcp'

/** The endpoint tool that performs a web search. */
export const EXA_MCP_SEARCH_TOOL = 'web_search_exa'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/**
 * JSON-RPC id sent with every call. The endpoint answers each POST on its own
 * response, so no correlation across concurrent calls is needed.
 */
const JSON_RPC_ID = 1

/** The `Accept` value the endpoint demands; anything narrower is answered HTTP 406. */
const ACCEPT = 'application/json, text/event-stream'

/** Separator Exa writes between the rendered result blocks of one answer. */
const BLOCK_SEPARATOR = '\n\n---\n\n'

/** Separator Exa writes between the highlight fragments of one result block. */
const HIGHLIGHT_SEPARATOR = '\n...\n'

/** Opening words of Exa's empty-result notice. */
const NO_RESULTS_PREFIX = 'No search results found'

/** The placeholder Exa writes when a field has no value. */
const NOT_AVAILABLE = 'N/A'

/** Resolved provider options (the plugin's `apply` supplies environment and constant defaults). */
export interface ExaMcpSearchProviderOptions {
  /** Optional Exa API key, sent as the `exaApiKey` query parameter. Empty = anonymous access. */
  apiKey: string
  /** Endpoint URL; a query string it already carries is preserved. */
  endpoint: string
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
}

/**
 * Map Exa's rendered text to a normalized search result.
 *
 * @param text - the `text` content block of the endpoint's MCP result.
 * @returns the normalized result; Exa's empty-result notice maps to zero
 *   sources, and `truncated` stays `false` because the web service owns the
 *   final `maxResults` truncation.
 * @throws WebError `WEB_PROVIDER_ERROR` when the text carries neither result
 *   blocks nor the empty-result notice.
 */
export function mapExaMcpText(text: string): WebSearchResult {
  if (text.trimStart().startsWith(NO_RESULTS_PREFIX)) return { sources: [], truncated: false }
  const sources = text
    .split(BLOCK_SEPARATOR)
    .map(mapExaMcpBlock)
    .filter((source): source is WebSearchSource => source !== undefined)
  if (sources.length === 0) {
    throw new WebError(
      'Exa MCP returned text with no Title:/URL: result blocks and no empty-result notice',
      'WEB_PROVIDER_ERROR',
    )
  }
  return { sources, truncated: false }
}

/**
 * Map one rendered result block to a normalized source. `Published: N/A` and a
 * blank field become an omitted property rather than a literal placeholder, and
 * Exa's `Author:` line is ignored because the seam has no author field.
 *
 * @param block - one `Title:`/`URL:`/`Published:`/`Highlights:` block.
 * @returns the normalized source, or `undefined` when the block supplies no URL
 *   — the one field a source cannot omit.
 */
export function mapExaMcpBlock(block: string): WebSearchSource | undefined {
  let url: string | undefined
  let title: string | undefined
  let publishedAt: string | undefined
  let highlightLines: readonly string[] = []
  const lines = block.split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('Highlights:')) {
      highlightLines = lines.slice(index + 1)
      break
    }
    if (line.startsWith('URL: ')) url = line.slice('URL: '.length)
    else if (line.startsWith('Title: ')) title = line.slice('Title: '.length)
    else if (line.startsWith('Published: ')) publishedAt = line.slice('Published: '.length)
  }
  const normalizedUrl = usableValue(url)
  if (normalizedUrl === undefined) return undefined
  const normalizedTitle = usableValue(title)
  const normalizedPublishedAt = usableValue(publishedAt)
  const snippet = firstHighlight(highlightLines)
  return {
    url: normalizedUrl,
    ...normalizedTitle !== undefined ? { title: normalizedTitle } : {},
    ...snippet !== undefined ? { snippet } : {},
    ...normalizedPublishedAt !== undefined ? { publishedAt: normalizedPublishedAt } : {},
  }
}

/**
 * Map a parsed JSON-RPC envelope to a normalized search result.
 *
 * @param response - the endpoint's JSON-RPC response, sent directly or inside
 *   an SSE `data:` line.
 * @returns the normalized result built from the first `text` content block.
 * @throws WebError `WEB_PROVIDER_ERROR` for a JSON-RPC error, a tool-level
 *   `isError` result, a missing result, or a result with no `text` block.
 */
export function mapExaMcpResponse(response: ExaMcpResponse): WebSearchResult {
  const error = response.error
  if (error !== undefined) {
    const detail = usableValue(error.message)
    throw new WebError(
      detail !== undefined ? `Exa MCP error: ${detail}` : 'Exa MCP returned a JSON-RPC error',
      'WEB_PROVIDER_ERROR',
    )
  }
  const result = response.result
  if (result === undefined) {
    throw new WebError('Exa MCP response carried no result', 'WEB_PROVIDER_ERROR')
  }
  const text = textBlock(result)
  if (result.isError === true) {
    throw new WebError(
      text !== undefined ? `Exa MCP search failed: ${text}` : 'Exa MCP search failed without a message',
      'WEB_PROVIDER_ERROR',
    )
  }
  if (text === undefined) {
    throw new WebError('Exa MCP returned no text content block to map', 'WEB_PROVIDER_ERROR')
  }
  return mapExaMcpText(text)
}

/**
 * Parse the endpoint's HTTP body into a JSON-RPC envelope. The endpoint frames
 * a successful answer as SSE (`event: message` plus a `data:` line) and answers
 * a JSON-RPC negotiation failure with a plain JSON body, so both forms parse.
 *
 * @param raw - the response body exactly as received.
 * @returns the parsed JSON-RPC envelope.
 * @throws WebError `WEB_PROVIDER_ERROR` when the body carries no JSON payload.
 */
export function parseExaMcpBody(raw: string): ExaMcpResponse {
  const trimmed = raw.trim()
  const payload = trimmed.startsWith('{') ? trimmed : ssePayload(trimmed)
  if (payload === undefined) {
    throw new WebError('Exa MCP response body is neither JSON nor an SSE data payload', 'WEB_PROVIDER_ERROR')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error: unknown) {
    throw new WebError(`Exa MCP response body is not valid JSON: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (!isEnvelope(parsed)) {
    throw new WebError('Exa MCP response body is not a JSON-RPC envelope', 'WEB_PROVIDER_ERROR')
  }
  return parsed
}

/** The Exa MCP-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class ExaMcpSearchProvider implements WebSearchProvider {
  readonly id = EXA_MCP_PROVIDER_ID

  constructor(private readonly options: ExaMcpSearchProviderOptions) {}

  available(): boolean {
    return URL.canParse(this.options.endpoint)
      && (this.options.numResults === undefined || isPositiveInteger(this.options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // A per-request bound wins over the configured default; either may be absent.
    const numResults = request.maxResults ?? this.options.numResults
    const call: ExaMcpToolCallRequest = {
      jsonrpc: '2.0',
      id: JSON_RPC_ID,
      method: 'tools/call',
      params: {
        name: EXA_MCP_SEARCH_TOOL,
        // The tool's input schema forbids additional properties, so only the
        // query and the optional result count are sent.
        arguments: {
          query: request.query,
          ...numResults !== undefined ? { numResults } : {},
        },
      },
    }
    let response: Response
    try {
      response = await fetch(this.endpointUrl(), {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          // The endpoint answers HTTP 406 unless both types are acceptable.
          'accept': ACCEPT,
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(call),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa MCP search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Exa MCP search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Exa MCP error (HTTP ${status})`
      try {
        const detail = errorDetail(await response.text())
        if (detail !== undefined) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Exa MCP search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/SSE error body can only cost a richer provider message,
        // never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    let raw: string
    try {
      raw = await response.text()
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa MCP search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Exa MCP returned an unreadable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    return mapExaMcpResponse(parseExaMcpBody(raw))
  }

  /** The configured endpoint, carrying the `exaApiKey` parameter when a key is set. */
  private endpointUrl(): string {
    if (this.options.apiKey.length === 0) return this.options.endpoint
    const url = new URL(this.options.endpoint)
    url.searchParams.set('exaApiKey', this.options.apiKey)
    return url.toString()
  }
}

/** A field value Exa actually supplied: present, non-blank, and not its `N/A` placeholder. */
function usableValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 || trimmed === NOT_AVAILABLE ? undefined : trimmed
}

/**
 * The first non-blank highlight fragment of a result block.
 *
 * @param lines - the block's lines following its `Highlights:` header.
 * @returns the fragment text, or `undefined` when the block carries no highlight.
 */
function firstHighlight(lines: readonly string[]): string | undefined {
  for (const fragment of lines.join('\n').split(HIGHLIGHT_SEPARATOR)) {
    const trimmed = fragment.trim()
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

/** True for a JSON object, the only body that can carry a JSON-RPC envelope. */
function isEnvelope(value: unknown): value is ExaMcpResponse {
  return typeof value === 'object' && value !== null
}

/** The first `text` content block's payload, when the result carries one. */
function textBlock(result: ExaMcpToolResult): string | undefined {
  if (!Array.isArray(result.content)) return undefined
  for (const block of result.content) {
    if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') {
      return block.text
    }
  }
  return undefined
}

/**
 * The endpoint's own message for a failed request.
 *
 * @param raw - the error response body.
 * @returns the JSON-RPC or MCP error message, or `undefined` when the body
 *   carries none.
 */
function errorDetail(raw: string): string | undefined {
  let envelope: ExaMcpResponse
  try {
    envelope = parseExaMcpBody(raw)
  } catch {
    // A body that is not a JSON-RPC envelope costs a richer message only; the
    // caller keeps its HTTP status-line message.
    return undefined
  }
  return usableValue(envelope.error?.message)
}

/**
 * Join the `data:` field values of an SSE body.
 *
 * @param body - the trimmed response body.
 * @returns the joined payload, or `undefined` when the body has no `data:` line.
 */
function ssePayload(body: string): string | undefined {
  const payloads = body
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
  return payloads.length > 0 ? payloads.join('\n') : undefined
}

/** True for a request limit that can be sent to the endpoint (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
