# Agent Note: Model catalog overlay and explicit refresh

Status: implemented

English | [中文](2026-09-23-model-catalog-overlay-and-refresh.zh.md)

## Problem

A route pi-ai ships serves exactly the models its generated catalog records, so a model a provider published after the installed pi-ai build cannot be requested until a newer build ships, and nothing in the harness can fetch one. Adding such a model per route takes a `models` list, which replaces the route's whole catalog and cannot express a mixed-protocol gateway route at all.

## Decision

`dsh-llm-pi-ai` may overlay a published model directory on the installed catalog. `catalogOverlay` names the directory (`true` for the published models.dev catalog) and how long a cached snapshot stays current; the snapshot lives at `$DSH_HOME/cache/llm-pi-ai/models-dev.json` and is read at start, never on a schedule. Each directory entry the installed catalog does not describe becomes a model whose protocol comes from the entry's npm package, the provider's single protocol, or the OpenCode gateways' package-less convention, and whose endpoint facts — base URL, compatibility switches, reasoning map, headers, omitted capacities — come from the installed models of that same provider and protocol. An id the installed catalog describes keeps its installed entry, and an entry with no installed sibling is skipped rather than guessed at.

Freshness is explicit. `LlmAdapter.refreshModels()` fetches one adapter's catalogs again, `LlmRuntime.refreshModelCatalogs()` asks every registered adapter once, `session.refreshModelCatalog` rebuilds the browser directory from the result, and the composer model list's refresh button is the surface that calls it. Snapshot resolution stays synchronous: the resolver merges whichever snapshot is current, and every fetch runs out of band.

## Alternatives considered

- **A periodic background refresh.** Rejected: it puts a third-party fetch on a timer in every deployment that enables the overlay, while the need is a list the user can update on demand.
- **Overlaying inside the resolver.** Rejected: `resolveRouteModels` is synchronous and pure, and a network read there would make model resolution depend on a directory's availability.
- **A separate package owning the directory fetch.** Deferred: the merge has to live in the resolver, and the fetch needs the installed catalog's facts to place an entry. The halves stay separate modules (`catalog-overlay.ts`, `catalog-sync.ts`) so extraction stays mechanical.
- **Declaring the models per route in `models`.** Rejected: it replaces the route's whole catalog, and the models this exists for sit on a mixed-protocol gateway route.
- **A build-time generated overlay shipped in the package.** Deferred: the installed catalog already supplies the baseline, so a generated artifact would add release lag without removing a failure mode.

## Consequences

A deployment that enables the overlay serves models newer than its pi-ai build and can refresh them without a restart; one that does not is unchanged, because absence and `false` both mean off. An overlay model inherits its endpoint facts, so a gateway quirk that differs for the new model takes a `modelOverrides` entry. The snapshot is one file per harness home, and a start with no cache and no reachable directory serves no overlay. `LlmAdapter` gained a default-no-op method, so every adapter answers the runtime's refresh without implementing it.

## Testing

`catalog-overlay.ts` and `catalog-sync.ts` cases pin the mapping, skip, cache, and disposal rules; a real-Loader composition serves, requests, caches, refreshes, and drops an overlay model; the `LlmRuntime` and Session Controller cases cover the seam and the RPC; the composer seat's component and browser cases cover the button.
