/**
 * A route that follows its endpoint's model listing: which protocols can be
 * listed, the listing's timing, and the credential-scoped cache that keeps one
 * route's last good listing.
 *
 * Catalog resolution stays synchronous and pure; it reads the listing this
 * cache already holds. The cache is what an operation awaits before it
 * resolves: the first access of a scope waits for the listing, bounded by the
 * request deadline, and a later access returns at once and refreshes a listing
 * older than its maximum age in the background. A failed load keeps the last
 * good listing, and a changed listing is published through `changed`.
 *
 * @module dsh-llm-pi-ai/model-listing
 */

import { createHash } from 'node:crypto'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'

/**
 * Protocols whose model listing this package can read. OpenAI protocols use
 * bearer auth at `GET {baseURL}/models`; Anthropic Messages uses `x-api-key`
 * and `anthropic-version` at its native `GET /v1/models`. Azure is absent
 * despite its OpenAI lineage — it authenticates with an `api-key` header and
 * requires an `api-version` query — and Codex authenticates through OAuth;
 * guessing at either would report an authentication failure as a provider
 * with no models. pi-ai's remaining protocols are absent for the same reason.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/**
 * Whether this package can read the model listing of one wire protocol.
 * @param api - pi-ai wire protocol.
 * @returns true for OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages.
 */
export function isListableProtocol(api: string): boolean {
  return LISTABLE_PROTOCOLS.has(api)
}

/** Default deadline of one listing request, which also bounds a first-access wait. */
export const DEFAULT_MODELS_TIMEOUT_MS = 5_000

/** Default age after which the next access refreshes a listing in the background. */
export const DEFAULT_MODELS_MAX_AGE_MS = 600_000

/** Code of a listing deadline's timeout reason. */
const LISTING_TIMEOUT = 'MODEL_LISTING_TIMEOUT'

/** One model an endpoint lists, with whatever it discloses about it. */
export type ListedModel = Pick<LlmDiscoveredModel, 'id' | 'name' | 'contextWindow' | 'maxTokens'>

/** Where one route reads its listing and how long a listing stays current. */
export interface ModelListingSettings {
  /** Endpoint root the protocol's listing path is joined to. */
  readonly baseURL: string
  /** Wire protocol whose listing path and authentication apply. */
  readonly api: string
  /** Deadline of one listing request, which also bounds a first-access wait. */
  readonly timeoutMs: number
  /** Listing age after which the next access refreshes it in the background; 0 refreshes on every access. */
  readonly maxAgeMs: number
}

/** Host-owned inputs of one route's cache. */
export interface ModelListingCacheDependencies {
  /**
   * Perform one listing request.
   * @param settings - endpoint and protocol of the caller's configuration generation.
   * @param credential - the route's credential, or `undefined` for a route that names none.
   * @param signal - carries the request deadline and disposal.
   * @returns the listed models in endpoint order.
   */
  readonly load: (settings: ModelListingSettings, credential: string | undefined, signal: AbortSignal) => Promise<readonly ListedModel[]>
  /** Wall clock used for listing age. */
  readonly now: () => number
  /** Report the first failure of a failing streak. */
  readonly warn: (message: string) => void
  /** Publish a changed listing; readers can immediately read `current()`. */
  readonly changed: () => void
}

/** Wait for `task` unless `signal` aborts first; the task keeps running. */
function abandonable(task: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return task
  signal.throwIfAborted()
  const settled = Promise.withResolvers<void>()
  const abandon = (): void => { settled.reject(signal.reason) }
  signal.addEventListener('abort', abandon, { once: true })
  void task.then(settled.resolve, settled.reject).finally(() => { signal.removeEventListener('abort', abandon) })
  return settled.promise
}

/**
 * One route's listing cache. A scope is one endpoint, protocol, and credential;
 * a changed scope discards the listing, so a rotated key or a repointed route
 * never serves another account's models.
 */
export class ModelListingCache {
  private scope: string | undefined
  private listing: readonly ListedModel[] | undefined
  /** Settle time of the latest load in this scope; `undefined` before the first one settles. */
  private settledAt: number | undefined
  private inflight: Promise<void> | undefined
  private request: AbortController | undefined
  private generation = 0
  private failing = false
  private closed = false

  /** @param dependencies - transport, clock, diagnostics, and change publication. */
  constructor(private readonly dependencies: ModelListingCacheDependencies) {}

  /**
   * The last good listing of the current scope, without I/O.
   * @returns the listed models, or `undefined` until a load in this scope succeeds.
   */
  current(): readonly ListedModel[] | undefined {
    return this.listing
  }

  /**
   * Bring the listing current for one access. The first access of a scope
   * waits for its load, which the request deadline bounds; a later access
   * returns at once and starts a background load when the listing is older
   * than `maxAgeMs`. `refresh` waits for a new load whatever the listing's age.
   * @param settings - endpoint and timing of the caller's configuration generation.
   * @param credential - the credential the route sends, or `undefined` when it names none.
   * @param options - `refresh` forces and awaits a load; `signal` abandons this wait only.
   */
  async access(
    settings: ModelListingSettings,
    credential: string | undefined,
    options: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.closed) return
    const scope = [
      settings.baseURL,
      settings.api,
      credential === undefined ? '' : createHash('sha256').update(credential).digest('hex'),
    ].join('\n')
    if (scope !== this.scope) this.rescope(scope)
    if (options.refresh === true || this.settledAt === undefined) {
      await abandonable(this.start(settings, credential), options.signal)
    } else if (this.dependencies.now() - this.settledAt >= settings.maxAgeMs) {
      void this.start(settings, credential)
    }
  }

  /**
   * Abort the load in flight; later results and accesses change nothing.
   * @returns completion of the load in flight.
   */
  async dispose(): Promise<void> {
    this.closed = true
    this.generation += 1
    this.request?.abort()
    await this.inflight
  }

  private rescope(scope: string): void {
    this.request?.abort()
    this.scope = scope
    this.listing = undefined
    this.settledAt = undefined
    this.inflight = undefined
    this.failing = false
    this.generation += 1
  }

  private start(settings: ModelListingSettings, credential: string | undefined): Promise<void> {
    if (this.inflight !== undefined) return this.inflight
    this.generation += 1
    const generation = this.generation
    const request = new AbortController()
    this.request = request
    const limit = deadline(request.signal, settings.timeoutMs, LISTING_TIMEOUT)
    const run = this.dependencies.load(settings, credential, limit.signal)
      .then((listing) => {
        if (generation !== this.generation) return
        const changed = !deepEqualJson(this.listing, listing)
        this.listing = listing
        this.settledAt = this.dependencies.now()
        this.failing = false
        if (changed) this.notify()
      }, (error: unknown) => {
        if (generation !== this.generation) return
        if (!this.failing) {
          const fallback = this.listing === undefined ? 'serving the configured models' : 'keeping the previous listing'
          this.dependencies.warn(`llm-pi-ai: model listing from ${settings.baseURL} failed (${String(error)}); ${fallback}`)
        }
        this.settledAt = this.dependencies.now()
        this.failing = true
      })
      .finally(() => {
        limit[Symbol.dispose]()
        if (this.inflight === run) this.inflight = undefined
      })
    this.inflight = run
    return run
  }

  private notify(): void {
    try { this.dependencies.changed() }
    catch (error) { this.dependencies.warn(`llm-pi-ai: model listing change notification failed (${String(error)})`) }
  }
}
