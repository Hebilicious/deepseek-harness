/**
 * Overlay of a public model directory onto the installed pi-ai catalog.
 *
 * A route pi-ai ships serves exactly the models its generated catalog records,
 * so a model a provider released after the installed pi-ai build cannot be
 * requested until a newer pi-ai ships. This module turns a models.dev document
 * into the entries that catalog would carry for those models, and
 * {@link overlayCatalog} adds them under it.
 *
 * Endpoint facts come from the installed models of the same provider and
 * protocol — base URL, wire-compatibility switches, reasoning map, headers, and
 * the capacities a directory entry omits — while the model's own facts (id,
 * name, modalities, reasoning, limits, cost) come from the directory. An
 * entry's protocol comes from its npm package, from the provider's own protocol
 * when it ships exactly one, or from the gateway convention recorded for the
 * OpenCode family. A provider and protocol pair with no installed models
 * therefore yields no overlay entry: the overlay extends endpoints the
 * installed catalog already serves and never invents one.
 *
 * @module dsh-llm-pi-ai/catalog-overlay
 */

import type { Api, Model, ModelCost, ThinkingLevelMap } from '@earendil-works/pi-ai'

/** One installed catalog model, whichever wire protocol it speaks. */
export type CatalogModel = Model<Api>

/**
 * The wire-compatibility switches an installed model may carry, spelled as the
 * protocols pi-ai gives a compat type: `Model<Api>['compat']` resolves to
 * `never` for the protocols that carry none, which cannot be narrowed from.
 */
export type CatalogModelCompat = NonNullable<Model<'openai-completions'>['compat']>
  | NonNullable<Model<'openai-responses'>['compat']>
  | NonNullable<Model<'anthropic-messages'>['compat']>
  | NonNullable<Model<'bedrock-converse-stream'>['compat']>

/**
 * Why one directory entry produced no overlay model. Counts travel together so
 * a refresh reports one diagnostic line instead of one per entry.
 */
export interface CatalogSkipCounts {
  /** The entry is not tool-capable, so this harness could not drive it. */
  untooled: number
  /** The directory marks the entry deprecated. */
  deprecated: number
  /** The installed catalog already describes that model id. */
  installed: number
  /** No installed model shares the entry's provider and protocol. */
  unmapped: number
}

/** The extra models one directory document contributes, by provider route. */
export interface CatalogOverlay {
  /** Extra models by installed provider, in directory order. */
  readonly models: ReadonlyMap<string, readonly CatalogModel[]>
  /** Directory entries left out, by reason. */
  readonly skipped: Readonly<CatalogSkipCounts>
}

/** Endpoint facts one provider and protocol pair carries in the installed catalog. */
interface ProtocolFacts {
  /** The pair's single endpoint; a pair served from several is left out. */
  baseUrl: string
  /** Most common wire-compatibility switches, absent when the models state none. */
  compat: CatalogModelCompat | undefined
  /** Most common reasoning-level map, absent when the models state none. */
  thinkingLevelMap: ThinkingLevelMap | undefined
  /** Most common model headers, absent when the models state none. */
  headers: Record<string, string> | undefined
  /** Capacity for a directory entry that states none. */
  contextWindow: number
  /** Output cap for a directory entry that states none. */
  maxTokens: number
}

/**
 * Protocols a directory entry names through its npm package. The mapping is the
 * convention the OpenCode-family gateway entries publish; a package outside it
 * is not guessed at, and the entry falls back to its provider's own protocol.
 */
const NPM_PROTOCOLS: Readonly<Record<string, string>> = {
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/google': 'google-generative-ai',
  '@ai-sdk/openai-compatible': 'openai-completions',
}

/**
 * Providers whose directory entries route every package-less model through
 * OpenAI-compatible Chat Completions. These gateways publish one endpoint per
 * protocol and name the package only for the ones that are not Chat
 * Completions, so a missing package is the Chat Completions case rather than an
 * unanswered question. Every other provider that serves several protocols
 * leaves a package-less entry unplaced, because there its protocol is genuinely
 * unstated.
 */
const PACKAGE_LESS_COMPLETIONS_PROVIDERS: ReadonlySet<string> = new Set(['opencode', 'opencode-go'])

/** Pricing for a directory entry that states none, or states an unusable value. */
const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** One JSON object, or `undefined` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A non-negative finite number, or zero. */
function rate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** A positive integer, or `undefined` for anything else. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * A `JSON.stringify` replacer that orders object keys, so two equal values
 * serialize identically. Keys are compared by code unit rather than a locale,
 * which would make the result depend on the host's collation; they are unique,
 * so the comparator never orders equal strings.
 * @param _key - the property name, unused.
 * @param inner - the value being serialized.
 * @returns the value with its object keys ordered.
 */
function sortedKeys(_key: string, inner: unknown): unknown {
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner
  return Object.fromEntries(Object.entries(inner as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : 1))
}

/**
 * A serialization that ignores object key order, so two equal values count as
 * one.
 * @param value - the value to key.
 * @returns a stable string key.
 */
function stableKey(value: unknown): string {
  // Undefined is a value to count like any other, and stringifying it answers
  // undefined rather than a key.
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, sortedKeys)
}

/**
 * The most frequent value among `values`; a tie goes to the first appearance,
 * which is catalog order, so the result does not depend on map iteration.
 * @param values - a non-empty list of candidate values.
 * @returns the most frequent value.
 */
function mostCommon<T>(values: readonly T[]): T {
  const counts = new Map<string, { value: T; count: number }>()
  for (const value of values) {
    const key = stableKey(value)
    const seen = counts.get(key)
    if (seen === undefined) counts.set(key, { value, count: 1 })
    else seen.count += 1
  }
  let best: { value: T; count: number } | undefined
  for (const entry of counts.values()) {
    if (best === undefined || entry.count > best.count) best = entry
  }
  // `values` is never empty at any call site, so `counts` holds at least one entry.
  return (best as { value: T; count: number }).value
}

/**
 * The endpoint facts each protocol of one provider carries, derived from the
 * models the installed catalog ships for it.
 * @param models - the provider's installed models, in catalog order.
 * @returns facts by protocol; a protocol served from several endpoints is absent.
 */
function installedFacts(models: readonly CatalogModel[]): Map<string, ProtocolFacts> {
  const groups = new Map<string, CatalogModel[]>()
  for (const model of models) {
    const group = groups.get(model.api)
    if (group === undefined) groups.set(model.api, [model])
    else group.push(model)
  }
  const facts = new Map<string, ProtocolFacts>()
  for (const [api, group] of groups) {
    const baseUrls = new Set(group.map(model => model.baseUrl))
    if (baseUrls.size !== 1) continue
    facts.set(api, {
      baseUrl: (group[0] as CatalogModel).baseUrl,
      compat: mostCommon(group.map(model => model.compat)),
      thinkingLevelMap: mostCommon(group.map(model => model.thinkingLevelMap)),
      headers: mostCommon(group.map(model => model.headers)),
      contextWindow: mostCommon(group.map(model => model.contextWindow)),
      maxTokens: mostCommon(group.map(model => model.maxTokens)),
    })
  }
  return facts
}

/**
 * The protocol a directory entry names through its npm package.
 * @param entry - one directory model record.
 * @returns the mapped protocol, or `undefined` when the package is outside the mapping.
 */
function npmProtocol(entry: Record<string, unknown>): string | undefined {
  const npm = asRecord(entry.provider)?.npm
  return typeof npm === 'string' ? NPM_PROTOCOLS[npm] : undefined
}

/**
 * One directory record as an overlay model.
 * @param provider - provider route the model is stamped with.
 * @param id - model id, also the directory key.
 * @param entry - the directory record.
 * @param api - resolved wire protocol.
 * @param protocol - the endpoint facts of that provider and protocol pair.
 * @returns the model entry the installed catalog would carry for it.
 */
function overlayModel(
  provider: string,
  id: string,
  entry: Record<string, unknown>,
  api: string,
  protocol: ProtocolFacts,
): CatalogModel {
  const reasoning = entry.reasoning === true
  const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id
  const modalities = asRecord(entry.modalities)?.input
  const cost = asRecord(entry.cost)
  return {
    id,
    name,
    api,
    provider,
    baseUrl: protocol.baseUrl,
    reasoning,
    ...reasoning && protocol.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: { ...protocol.thinkingLevelMap } }
      : {},
    input: Array.isArray(modalities) && modalities.includes('image') ? ['text', 'image'] : ['text'],
    cost: cost === undefined ? { ...NO_COST } : {
      input: rate(cost.input),
      output: rate(cost.output),
      cacheRead: rate(cost.cache_read),
      cacheWrite: rate(cost.cache_write),
    },
    ...protocol.compat === undefined ? {} : { compat: protocol.compat },
    ...protocol.headers === undefined ? {} : { headers: { ...protocol.headers } },
    contextWindow: positiveInteger(asRecord(entry.limit)?.context) ?? protocol.contextWindow,
    maxTokens: positiveInteger(asRecord(entry.limit)?.output) ?? protocol.maxTokens,
  }
}

/**
 * Map one directory document onto the installed catalog.
 * @param document - parsed directory document; anything else contributes nothing.
 * @param providers - provider ids the installed catalog ships, in catalog order.
 * @param installed - that provider's installed models by id.
 * @returns the extra models by provider, and the skipped-entry counts.
 */
export function mapCatalogOverlay(
  document: unknown,
  providers: readonly string[],
  installed: (provider: string) => Map<string, CatalogModel>,
): CatalogOverlay {
  const models = new Map<string, readonly CatalogModel[]>()
  const skipped: CatalogSkipCounts = { untooled: 0, deprecated: 0, installed: 0, unmapped: 0 }
  const directory = asRecord(document)
  for (const provider of providers) {
    const known = installed(provider)
    if (known.size === 0) continue
    const entries = asRecord(asRecord(directory?.[provider])?.models)
    if (entries === undefined) continue
    const facts = installedFacts([...known.values()])
    const protocols = [...facts.keys()]
    const single = protocols.length === 1 ? protocols[0] : undefined
    const added: CatalogModel[] = []
    for (const [id, raw] of Object.entries(entries)) {
      const entry = asRecord(raw)
      if (entry === undefined) {
        skipped.unmapped += 1
        continue
      }
      if (entry.tool_call !== true) {
        skipped.untooled += 1
        continue
      }
      if (entry.status === 'deprecated') {
        skipped.deprecated += 1
        continue
      }
      if (known.has(id)) {
        skipped.installed += 1
        continue
      }
      // A catalog route serves every protocol its own models declare, so a
      // directory entry that names none takes that protocol only while the
      // provider has exactly one, or the gateway's stated convention when it
      // publishes one; otherwise where it would be served is unanswerable and
      // the entry is left out.
      const api = npmProtocol(entry)
        ?? single
        ?? (PACKAGE_LESS_COMPLETIONS_PROVIDERS.has(provider) ? 'openai-completions' : undefined)
      const protocol = api === undefined ? undefined : facts.get(api)
      if (api === undefined || protocol === undefined) {
        skipped.unmapped += 1
        continue
      }
      added.push(overlayModel(provider, id, entry, api, protocol))
    }
    if (added.length > 0) models.set(provider, added)
  }
  return { models, skipped }
}

/**
 * The installed catalog with a route's overlay entries added. An id the
 * installed catalog already describes keeps its installed entry: the pi-ai
 * build is the authority on a model it ships, and a snapshot may predate it.
 * @param installed - the installed catalog by model id.
 * @param extra - this route's overlay models, when any.
 * @returns the merged catalog; the installed map itself when there is nothing to add.
 */
export function overlayCatalog(
  installed: Map<string, CatalogModel>,
  extra: readonly CatalogModel[] | undefined,
): Map<string, CatalogModel> {
  if (extra === undefined || extra.length === 0) return installed
  const merged = new Map(installed)
  for (const model of extra) {
    if (!merged.has(model.id)) merged.set(model.id, model)
  }
  return merged
}
