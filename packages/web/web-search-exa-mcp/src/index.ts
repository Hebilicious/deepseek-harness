/**
 * Exa MCP-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-search-exa-mcp
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ExaMcpSearchProvider,
  EXA_MCP_DEFAULT_ENDPOINT,
} from './provider.ts'

export {
  EXA_MCP_DEFAULT_ENDPOINT,
  EXA_MCP_PROVIDER_ID,
  EXA_MCP_SEARCH_TOOL,
  ExaMcpSearchProvider,
} from './provider.ts'
export type { ExaMcpSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa-mcp'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills the environment and constant defaults). */
export interface Config {
  /** Exa API key, sent as the endpoint's `exaApiKey` parameter. Falls back to `$EXA_API_KEY`; absent = anonymous access. */
  apiKey?: string
  /** Endpoint URL. Defaults to the hosted Exa MCP endpoint. */
  endpoint?: string
  /** Default result count when a request carries no `maxResults`. Omitted = the endpoint's own default. */
  numResults?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  endpoint: z.string(),
  numResults: z.number().step(1).min(1),
})

/** Register the Exa MCP search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ExaMcpSearchProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('EXA_API_KEY')?.value ?? '',
    endpoint: config.endpoint ?? EXA_MCP_DEFAULT_ENDPOINT,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
  }))
}
