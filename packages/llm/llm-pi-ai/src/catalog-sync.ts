/**
 * Lifecycle of one model-directory snapshot: load the cached document, fetch a
 * fresh one when the cache is missing or stale, and keep exactly one snapshot
 * current for the adapter to overlay.
 *
 * The fetch never runs inside catalog resolution, which stays synchronous and
 * pure. Everything here is out of band: a cycle publishes through
 * `onSnapshot`, a failing cycle reports once and leaves the snapshot already
 * loaded in place, and `dispose()` stops the schedule and settles the cycle in
 * flight.
 *
 * @module dsh-llm-pi-ai/catalog-sync
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import { readBounded } from './bounded-body.ts'

/**
 * Ceiling on one directory reply. Unlike a model listing, the document is read
 * whole, and the published catalog is several megabytes; a truncated one is not
 * parseable, so overflow is refused rather than truncated.
 */
const MAX_CATALOG_BYTES = 32 * 1024 * 1024

/** Snapshot cache format this build reads and writes. */
const SNAPSHOT_VERSION = 1

/** Milliseconds in the hour `refreshHours` is expressed in. */
const HOUR_MS = 3_600_000

/**
 * Ceiling on one directory request. A fetch that outlives its usefulness would
 * also delay disposal and the next cycle; the schedule retries either way, so
 * an unresponsive host costs one interval at most.
 */
const FETCH_TIMEOUT_MS = 30_000

/** One cached directory snapshot. */
export interface CatalogSnapshot {
  /** The parsed directory document. */
  readonly document: unknown
  /** The directory it was fetched from; a snapshot of another source is not this source's. */
  readonly url: string
  /** Epoch milliseconds of the fetch that produced it. */
  readonly fetchedAt: number
}

/** Where the directory snapshot comes from and how long it stays current. */
export interface CatalogOverlaySource {
  /** Directory URL the snapshot is fetched from. */
  readonly url: string
  /** Hours a cached snapshot stays current before the next start refetches it; 0 refetches at every start. */
  readonly refreshHours: number
}

/** Logger the refresh reports through. */
export interface CatalogRefreshLogger {
  /**
   * Report a cycle that could not complete.
   * @param message - the diagnostic, naming the URL or path at fault.
   */
  warn(message: string): void
}

/** Inputs of one catalog refresh lifecycle. */
export interface CatalogRefreshOptions {
  /** Directory source. */
  readonly source: CatalogOverlaySource
  /** Snapshot cache file; absent keeps the snapshot in memory only. */
  readonly cachePath?: string
  /** Called with each document that becomes current, from cache or network. */
  readonly onSnapshot: (document: unknown) => void
  /** Where refresh failures are reported. */
  readonly logger: CatalogRefreshLogger
}

/** One running refresh. */
export interface CatalogRefreshHandle {
  /**
   * Fetch the directory now, whatever the cached snapshot's age, and publish
   * the result. Attempts are serialized: one queued behind a fetch in flight
   * runs after it settles.
   * @returns a promise that settles once this attempt has published or failed.
   */
  refresh(): Promise<void>
  /**
   * Stop the refresh and any fetch in flight.
   * @returns a promise that settles once the running attempt has stopped.
   */
  dispose(): Promise<void>
}

/**
 * The snapshot cache file this deployment writes.
 * @returns the absolute path under the harness home's cache directory.
 */
export function catalogSnapshotPath(): string {
  return dshCachePath('llm-pi-ai', 'models-dev.json')
}

/** A failure's message, for a diagnostic that reports one line. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the cached snapshot.
 * @param path - snapshot cache file.
 * @returns the snapshot, or `undefined` when no cache exists.
 * @throws Error when the file exists but is not a snapshot this build wrote.
 */
export async function readCatalogSnapshot(path: string): Promise<CatalogSnapshot | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
  if (record === undefined
    || record.version !== SNAPSHOT_VERSION
    || typeof record.fetchedAt !== 'number'
    || typeof record.url !== 'string'
    || !('document' in record)) {
    throw new Error(`${path} is not a version ${SNAPSHOT_VERSION} model directory snapshot`)
  }
  return { document: record.document, url: record.url, fetchedAt: record.fetchedAt }
}

/**
 * Replace the snapshot cache.
 *
 * The document lands in a sibling named for this process and is renamed over
 * the target, so a reader never sees a half-written file, a crash never leaves
 * the previous snapshot replaced by one, and two harness instances sharing the
 * cache do not share a temporary path.
 * @param path - snapshot cache file.
 * @param snapshot - the document, its directory, and the time it was fetched.
 */
export async function writeCatalogSnapshot(path: string, snapshot: CatalogSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({
    version: SNAPSHOT_VERSION,
    url: snapshot.url,
    fetchedAt: snapshot.fetchedAt,
    document: snapshot.document,
  }), 'utf8')
  await rename(temporary, path)
}

/**
 * Fetch one directory document.
 * @param url - directory URL.
 * @param signal - cancellation for the request and its body read.
 * @returns the parsed document.
 * @throws Error when the request fails, the reply is not ok, is oversized, or is not JSON.
 */
export async function fetchCatalogDocument(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...attributionHeaders() },
    signal,
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const text = await readBounded(response, url, MAX_CATALOG_BYTES)
  return JSON.parse(text) as unknown
}

/**
 * Start one directory refresh.
 *
 * The start cycle publishes the cached document first, when there is one, so a
 * restart has its overlay before the network answers; it then fetches only if
 * that snapshot is missing, belongs to another directory, or is older than
 * `refreshHours`. Nothing else runs on a schedule: `refresh()` is the only
 * further fetch, which is what a surface offers as an explicit action.
 * @param options - source, cache, publication, and diagnostics.
 * @returns the handle that refreshes and stops it.
 */
export function startCatalogRefresh(options: CatalogRefreshOptions): CatalogRefreshHandle {
  const { source, cachePath, logger } = options
  const staleAfterMs = source.refreshHours * HOUR_MS
  let disposed = false
  let controller: AbortController | undefined
  let cycle: Promise<void> = Promise.resolve()

  const publish = (document: unknown): void => {
    try {
      options.onSnapshot(document)
    } catch (error: unknown) {
      logger.warn(`llm-pi-ai: the adapter refused a model directory snapshot (${message(error)})`)
    }
  }

  const readCached = async (path: string): Promise<CatalogSnapshot | undefined> => {
    try {
      return await readCatalogSnapshot(path)
    } catch (error: unknown) {
      logger.warn(`llm-pi-ai: ignoring the unreadable model directory cache (${message(error)})`)
      return undefined
    }
  }

  const fetchAndPublish = async (): Promise<void> => {
    if (disposed) return
    const attempt = new AbortController()
    controller = attempt
    try {
      const document = await fetchCatalogDocument(source.url, AbortSignal.any([
        attempt.signal,
        AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ]))
      /* v8 ignore next 2 -- disposal between a resolved fetch and its publication is a race unobservable to a test. */
      if (attempt.signal.aborted) return
      publish(document)
      if (cachePath === undefined) return
      try {
        await writeCatalogSnapshot(cachePath, { document, url: source.url, fetchedAt: Date.now() })
      } catch (error: unknown) {
        logger.warn(`llm-pi-ai: could not cache the model directory snapshot (${message(error)})`)
      }
    } catch (error: unknown) {
      // A failed refresh is never a failed start: the snapshot already loaded
      // keeps serving, and the next refresh tries again. Disposal aborts this
      // attempt's own controller and reports nothing.
      if (!attempt.signal.aborted) {
        logger.warn(`llm-pi-ai: model directory refresh failed, keeping the snapshot in use (${message(error)})`)
      }
    } finally {
      controller = undefined
    }
  }

  const load = async (): Promise<void> => {
    const cached = cachePath === undefined ? undefined : await readCached(cachePath)
    // A snapshot of another directory says nothing about this one, so repointing
    // the section at a different catalog fetches rather than serving the old one.
    const usable = cached !== undefined && cached.url === source.url ? cached : undefined
    if (usable !== undefined) publish(usable.document)
    if (usable !== undefined && Date.now() - usable.fetchedAt < staleAfterMs) return
    await fetchAndPublish()
  }

  /** Run one attempt after everything already queued, so two never overlap. */
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    cycle = cycle.then(work, work)
    return cycle
  }

  cycle = enqueue(load)

  return {
    refresh(): Promise<void> {
      return disposed ? Promise.resolve() : enqueue(fetchAndPublish)
    },
    async dispose(): Promise<void> {
      disposed = true
      controller?.abort()
      await cycle
    },
  }
}
