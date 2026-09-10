# Agent Note: Keyless Exa MCP search provider

Status: implemented

English | [中文](2026-09-11-keyless-exa-mcp-search-provider.zh.md)

## Problem

The base bundle pins `searchProvider: deepseek-official`, and that route resolves `$DEEPSEEK_API_KEY` — the credential the Models page manages for chat. A deployment that runs the harness on a different model credential therefore has no working `web_search`: every call fails to resolve a key. Search was the only model-facing capability that required a vendor credential of its own, because `web_fetch` already works anonymously. Every shipped alternative needs a key the user must obtain (Exa, Perplexity, or DeepSeek), and substituting a model call is not acceptable: a chat model without live internet answers a news query with fabricated URLs rather than admitting it cannot search.

## Decision

`@deepseek-ai/dsh-web-search-exa-mcp` registers the `exa-mcp` search provider on `ctx.web` and calls the hosted Exa MCP endpoint `https://mcp.exa.ai/mcp`. The base bundle mounts the row and pins `web.searchProvider: exa-mcp`, and it keeps `web-search-deepseek` mounted so a deployment can pin `deepseek-official` back without re-adding a package. `available()` needs no credential and makes no network call: it accepts a parseable endpoint URL and, when set, a positive-integer `numResults`.

### Endpoint contract

The endpoint answers a JSON-RPC `tools/call` for `web_search_exa` and needs no credential. Two request facts are load-bearing and were confirmed against the live endpoint: the `Accept` header must list both `application/json` and `text/event-stream` or the endpoint answers HTTP 406, and the tool's input schema declares only `query` and `numResults` with `additionalProperties: false`, so any other argument fails the call. An optional `apiKey` rides the `exaApiKey` query parameter and raises the endpoint's rate limits; it is never an availability condition. Requests set `redirect: 'error'`, matching every other provider on this seam.

The answer body is SSE (`event: message` plus a `data:` line) or, for a JSON-RPC negotiation failure, plain JSON; both parse. The first `text` content block carries rendered prose rather than a structured source array: result blocks separated by a `---` line, each with `Title:`, `URL:`, `Published:`, `Author:`, and a `Highlights:` section whose fragments are separated by a `...` line. `N/A` is Exa's placeholder for an absent value.

### Mapping

Each block with a URL becomes a `WebSearchSource`: `title`, the first non-blank highlight fragment as `snippet`, and a `Published:` value as `publishedAt`. `N/A` and blank fields become omitted properties rather than literal values, `Author:` is ignored because the seam has no author field, and a URL-less block is dropped. `maxResults` passes through as the endpoint's `numResults` and the seam still enforces the final bound, so the provider reports `truncated: false`. Exa returns no generated answer, so `content` stays omitted.

Exa's own empty-result notice maps to zero sources. Any other text with no result blocks fails the call as `WEB_PROVIDER_ERROR`, following the rule `dsh-web-search-deepseek` states: absence of the expected blocks is an error rather than a prose-scraping fallback. Aborts surface as `WEB_ABORTED`, including an abort that fires while the body is being read.

## Alternatives considered

**Search through the configured chat model.** OpenCode Go exposes no search endpoint and its models have no live internet — a direct news query returns no access — so this route would return fabricated URLs. A provider that invents citations is worse than one that fails loudly.

**Ship the new provider but keep `deepseek-official` as the default.** This is the conservative upstream choice, and it leaves the reported problem unsolved: a deployment with no DeepSeek search credential keeps failing every search until someone edits composition. Mounting both rows makes the shipped default work while the credentialed route stays one config line away.

**Replace `web-search-deepseek` in the base bundle.** A deployment holding only a DeepSeek credential would then have to re-add a removed package to keep its existing route. Removing a working credentialed path is not required to add a keyless one.

**Also implement the endpoint's `web_fetch_exa` tool.** `web-fetch-http` already retrieves pages anonymously and validates every destination, so a second fetch provider adds a package surface without removing any credential requirement.

**Send the endpoint `type`, `livecrawl`, or `contextMaxCharacters`.** Other MCP clients send these to other Exa MCP deployments, but this endpoint's `web_search_exa` schema rejects additional properties, so sending them fails every call.

## Consequences

Every shipped profile now performs web search through a third-party endpoint with no availability or quota contract. Its rate limits and uptime lie outside this repository's control, and the real-endpoint e2e suite exercises it on every `test:e2e` run; `DSH_EXA_MCP_E2E=0` takes it back out without a code change.

`web_search` becomes usable on any model route, including deployments that hold no search credential at all. The cost is fidelity: the credentialed `dsh-web-search-exa` requests highlights explicitly and this provider takes whatever fragment Exa renders first, and a deployment wanting Exa's category, domain, or date controls still needs that provider.

The Web search settings card continues to edit the `web-search-deepseek` settings namespace, so `exa-mcp` is configured through `cordis.yml` or the launch environment. Giving it a settings surface means a second card bound to its own namespace.

## Testing

`packages/web/web-search-exa-mcp/tests/exa-mcp.spec.ts` pins block mapping, body parsing, availability, request mapping, error classification, and HMR-safe registration at 100% per-file coverage; `tests/egress.spec.ts` proves the request reaches the configured proxy with the key inside the proxied URL; `tests/exa-mcp.e2e.ts` runs a live query against the hosted endpoint and verifies the provider still returns citeable sources. The recorded-session scenario `snapshots/session/web-search-endpoint-guidance` pins `searchProvider: deepseek-official` in its own patch, because it records the DeepSeek route rather than the shipped default.

No recorded-session scenario drives a successful `web_search` through the keyless route, because a live answer cannot be a deterministic replay fixture without an endpoint fixture of its own.

## Related

- [Web capability seam](../architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.
