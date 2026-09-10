---
description: "The keyless Exa MCP search provider for ctx.web: how a deployment gets live web search with no search credential, and what the endpoint's rendered result blocks map to."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-exa-mcp

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-exa-mcp`, the harness searches the web through Exa's hosted MCP endpoint, so `web_search` works in a deployment that holds no search credential. Choose it when nothing supplies an Exa, Perplexity, or DeepSeek search credential and live results still matter; an Exa key raises the endpoint's rate limits but never becomes required. The endpoint returns rendered text rather than structured sources, so a body carrying neither result blocks nor Exa's empty-result notice fails the call instead of returning nothing. Exa returns no generated answer, so results carry no `content` — only citeable sources.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `exa-mcp` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: exa-mcp`.

### When to choose it

Choose this backend when a deployment must search the web without holding a search credential: the hosted endpoint answers anonymous requests, so mounting the provider is the whole configuration. Prefer [`dsh-web-search-exa`](../web-search-exa/README.md) when the deployment holds an Exa key and wants Exa's keyword or neural search, [`dsh-web-search-perplexity`](../web-search-perplexity/README.md) when it wants a generated answer, or [`dsh-web-search-deepseek`](../web-search-deepseek/README.md) when search must run on the credential the Models page already manages. The provider is unavailable only when the endpoint URL does not parse or `numResults` is not a positive integer.

### Minimal configuration

Load the web service and the provider; no credential is needed, and every other setting has a default.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: exa-mcp
- name: '@deepseek-ai/dsh-web-search-exa-mcp'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `$EXA_API_KEY` | Optional Exa API key, sent as the endpoint's `exaApiKey` parameter to raise its rate limits; absent or empty uses anonymous access |
| `endpoint` | `https://mcp.exa.ai/mcp` | Endpoint URL; a query string it already carries is preserved. An unparseable value makes the provider unavailable |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`; must be a positive integer. Omitted leaves the endpoint's own default of 10 |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-exa-mcp) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each rendered result block maps to a `WebSearchSource`: `url`, `title`, the first highlight fragment as `snippet`, and a `Published:` value as `publishedAt`. Exa's `N/A` placeholder and a blank field become an omitted property rather than a literal value, its `Author:` line is ignored because the seam has no author field, and a block with no URL is dropped. A request's `maxResults` wins over the configured `numResults` default and is sent as the endpoint's `numResults` — the final bound is enforced by the service, which truncates and flags. Exa returns no generated answer, so the result carries no `content`.

### Failures and recovery

Provider failures — HTTP errors, JSON-RPC errors, tool-level `isError` results, bodies that are neither JSON nor an SSE `data:` payload, and text carrying neither result blocks nor Exa's empty-result notice — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Exa's hosted MCP endpoint with three deliberate rules:

- **Anonymous by default.** The endpoint needs no credential, so `available()` checks only local configuration; a key is an optional rate-limit upgrade, never an availability condition.
- **The rendered text is the wire format.** Exa returns no structured source array, so the provider parses its blocks one by one and fails the call when neither blocks nor the empty-result notice arrive, rather than scraping prose into invented sources.
- **No invented answers.** Exa returns no generated answer, so `content` is omitted rather than fabricating provider prose the model might trust.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `ExaMcpSearchProvider`: body parsing, abort classification, block mapping |
| [`src/types.ts`](src/types.ts) | MCP wire types: `ExaMcpToolCallRequest`, `ExaMcpResponse`, `ExaMcpToolResult` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` posts one anonymous JSON-RPC `tools/call` for `web_search_exa` to the configured endpoint with `redirect: 'error'`, so a redirect fails the request without contacting the target. The request accepts both `application/json` and `text/event-stream` because the endpoint answers HTTP 406 to anything narrower, and sends only the arguments that tool declares, because its input schema rejects additional properties. The response body parses as an SSE `data:` payload or as plain JSON; the first `text` content block is split into rendered blocks, mapped one by one, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the neighboring providers, and the model-facing tool.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the seven-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-web-search-exa](../web-search-exa/README.md) — the credentialed Exa provider that returns structured results.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-exa-mcp) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, first highlight fragments, and publication dates or its exact `Exa MCP search aborted`, `Exa MCP search request failed: <error>`, and `Exa MCP returned no text content block to map` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **Search depends on a third-party endpoint with no availability contract** — `mcp.exa.ai` answers anonymous requests, and its rate limits, quota, and uptime lie outside this repository's control; a deployment that needs a contracted route pins the credentialed providers.
- **Only `endpoint` and `numResults` are exposed** — the endpoint's `web_search_exa` tool declares exactly `query` and `numResults` and rejects additional arguments, so Exa's category, domain, and date controls stay unavailable; the endpoint's `web_fetch_exa` tool is not mounted, and fetching remains with `dsh-web-fetch-http`.
- **No settings surface of its own** — the Web search card edits the `web-search-deepseek` settings namespace, so this provider is configured through `cordis.yml` or the launch environment.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: the endpoint's wider tool set

Exa's MCP endpoint exposes `web_fetch_exa` and, behind a `tools` query parameter, `web_search_advanced_exa` and `agent_run`. Mounting any of them means a provider role or service field the seam does not have yet, so they stay unmounted.

</details>
