/**
 * The refresh lifecycle is what keeps a network dependency out of catalog
 * resolution: a cycle publishes the cached document first, fetches only when
 * that snapshot is missing or stale, and reports every failure while leaving
 * the snapshot in use untouched. These cases pin each of those outcomes against
 * a local server and a private cache directory, and dispose each cycle so no
 * timer or request outlives the test.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  catalogSnapshotPath,
  fetchCatalogDocument,
  readCatalogSnapshot,
  startCatalogRefresh,
  writeCatalogSnapshot,
} from '../src/catalog-sync.ts'
import type { CatalogRefreshHandle } from '../src/catalog-sync.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

let root: string | undefined
const handles: CatalogRefreshHandle[] = []
const warnings: string[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  warnings.length = 0
  await closeMockServers()
  vi.unstubAllEnvs()
})

/** A private home for this case, so the snapshot cache never touches the real one. */
async function privateHome(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-catalog-'))
  return root
}

/** Start one refresh the teardown disposes. */
function refresh(options: Parameters<typeof startCatalogRefresh>[0]): CatalogRefreshHandle {
  const handle = startCatalogRefresh(options)
  handles.push(handle)
  return handle
}

/** The logger every case reports through. */
const logger = { warn: (message: string): void => { warnings.push(message) } }

describe('snapshot cache', () => {
  it('resolves the cache under the harness home', async () => {
    const home = await privateHome()
    vi.stubEnv('DSH_HOME', home)
    expect(catalogSnapshotPath()).toBe(join(home, 'cache', 'llm-pi-ai', 'models-dev.json'))
  })

  it('round-trips a snapshot', async () => {
    const home = await privateHome()
    const path = join(home, 'nested', 'snapshot.json')
    await writeCatalogSnapshot(path, {
      document: { opencode: { models: {} } },
      url: 'https://directory.test/api.json',
      fetchedAt: 1234,
    })
    await expect(readCatalogSnapshot(path)).resolves.toEqual({
      document: { opencode: { models: {} } },
      url: 'https://directory.test/api.json',
      fetchedAt: 1234,
    })
  })

  it('reports a missing cache as no snapshot', async () => {
    const home = await privateHome()
    await expect(readCatalogSnapshot(join(home, 'absent.json'))).resolves.toBeUndefined()
  })

  it('refuses a cache it did not write', async () => {
    const home = await privateHome()
    const cases = [
      'not json at all',
      '[]',
      '{"version":2,"url":"https://directory.test","fetchedAt":1,"document":{}}',
      '{"version":1,"document":{}}',
      '{"version":1,"fetchedAt":1}',
      '{"version":1,"url":"https://directory.test","fetchedAt":1}',
      '{"version":1,"url":7,"fetchedAt":1,"document":{}}',
    ]
    for (const [index, body] of cases.entries()) {
      const path = join(home, `cache-${index}.json`)
      await writeFile(path, body)
      await expect(readCatalogSnapshot(path)).rejects.toThrow()
    }
    // A path that exists but cannot be read is a failure, not a missing cache.
    await expect(readCatalogSnapshot(home)).rejects.toThrow()
  })
})

describe('directory fetch', () => {
  it('reads one JSON document', async () => {
    const server = await mockServer([{ body: JSON.stringify({ opencode: { models: {} } }) }])
    await expect(fetchCatalogDocument(server.url, new AbortController().signal))
      .resolves.toEqual({ opencode: { models: {} } })
    expect(server.headers[0]?.accept).toBe('application/json')
  })

  it('refuses a refused reply and a reply that is not JSON', async () => {
    const refused = await mockServer([{ status: 503, body: '{}' }])
    await expect(fetchCatalogDocument(refused.url, new AbortController().signal))
      .rejects.toThrow(/answered 503/)

    const broken = await mockServer([{ body: 'not json' }])
    await expect(fetchCatalogDocument(broken.url, new AbortController().signal)).rejects.toThrow()
  })
})

describe('catalog refresh', () => {
  it('serves a fresh cache without touching the network', async () => {
    const home = await privateHome()
    const path = join(home, 'snapshot.json')
    const document = { opencode: { models: { cached: { tool_call: true } } } }
    const server = await mockServer([{ body: JSON.stringify({}) }])
    await writeCatalogSnapshot(path, { document, url: server.url, fetchedAt: Date.now() })
    const published: unknown[] = []

    refresh({
      source: { url: server.url, refreshHours: 12 },
      cachePath: path,
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })

    await vi.waitFor(() => { expect(published).toEqual([document]) })
    expect(server.paths).toEqual([])
    expect(warnings).toEqual([])
  })

  it('refetches a snapshot that belongs to another directory', async () => {
    const home = await privateHome()
    const path = join(home, 'snapshot.json')
    const server = await mockServer([{ body: JSON.stringify({ live: true }) }])
    // Fresh, but fetched from somewhere else: repointing the section at another
    // catalog must not keep serving what the previous one said.
    await writeCatalogSnapshot(path, {
      document: { other: true },
      url: 'https://other-directory.test/api.json',
      fetchedAt: Date.now(),
    })
    const published: unknown[] = []

    refresh({
      source: { url: server.url, refreshHours: 12 },
      cachePath: path,
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })

    await vi.waitFor(() => { expect(published).toEqual([{ live: true }]) })
    expect(server.paths).toEqual(['/'])
  })

  it('fetches once per start when the refresh interval is zero, even with a fresh cache', async () => {
    const home = await privateHome()
    const path = join(home, 'snapshot.json')
    const fresh = { opencode: { models: { live: { tool_call: true } } } }
    const server = await mockServer([{ body: JSON.stringify(fresh) }])
    await writeCatalogSnapshot(path, { document: { stale: true }, url: server.url, fetchedAt: Date.now() })
    const published: unknown[] = []

    refresh({
      source: { url: server.url, refreshHours: 0 },
      cachePath: path,
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })

    await vi.waitFor(() => { expect(published).toEqual([{ stale: true }, fresh]) })
    expect(server.paths).toEqual(['/'])
    const stored = await readCatalogSnapshot(path)
    expect(stored?.document).toEqual(fresh)
    expect(stored?.fetchedAt).toBeGreaterThan(0)
  })

  it('publishes the cached snapshot before fetching a stale one, and replaces the cache', async () => {
    const home = await privateHome()
    const path = join(home, 'snapshot.json')
    const fresh = { opencode: { models: { live: { tool_call: true } } } }
    const server = await mockServer([{ body: JSON.stringify(fresh) }])
    await writeCatalogSnapshot(path, {
      document: { stale: true },
      url: server.url,
      fetchedAt: Date.now() - 86_400_000,
    })
    const published: unknown[] = []

    refresh({
      source: { url: server.url, refreshHours: 12 },
      cachePath: path,
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })

    await vi.waitFor(() => { expect(published).toEqual([{ stale: true }, fresh]) })
    const cached = JSON.parse(await readFile(path, 'utf8')) as { document: unknown }
    expect(cached.document).toEqual(fresh)
  })

  it('keeps the snapshot in use when the fetch fails, and reports it once', async () => {
    const server = await mockServer([{ status: 500, body: '{}' }])
    const published: unknown[] = []

    refresh({
      source: { url: server.url, refreshHours: 12 },
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })

    await vi.waitFor(() => { expect(warnings).toHaveLength(1) })
    expect(warnings[0]).toMatch(/model directory refresh failed/)
    expect(warnings[0]).toMatch(/answered 500/)
    expect(published).toEqual([])
  })

  it('reports an unreadable cache and fetches anyway', async () => {
    const home = await privateHome()
    const path = join(home, 'snapshot.json')
    await writeFile(path, 'not json')
    const server = await mockServer([{ body: JSON.stringify({ live: true }) }])
    const published: unknown[] = []

    refresh({
      source: { url: server.url, refreshHours: 12 },
      cachePath: path,
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })

    await vi.waitFor(() => { expect(published).toEqual([{ live: true }]) })
    expect(warnings[0]).toMatch(/ignoring the unreadable model directory cache/)
  })

  it('serves the snapshot even when it cannot be cached, and reports that', async () => {
    const home = await privateHome()
    const blocker = join(home, 'blocker')
    await writeFile(blocker, 'not a directory')
    const server = await mockServer([{ body: JSON.stringify({ live: true }) }])
    const published: unknown[] = []

    refresh({
      source: { url: server.url, refreshHours: 12 },
      cachePath: join(blocker, 'snapshot.json'),
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })

    // The path under a file is unreadable and unwritable, and neither outcome
    // may cost the snapshot the fetch supplies.
    await vi.waitFor(() => { expect(warnings).toHaveLength(2) })
    expect(warnings[0]).toMatch(/ignoring the unreadable model directory cache/)
    expect(warnings[1]).toMatch(/could not cache the model directory snapshot/)
    expect(published).toEqual([{ live: true }])
  })

  it('contains a consumer that refuses the snapshot', async () => {
    const server = await mockServer([{ body: JSON.stringify({ live: true }) }])

    refresh({
      source: { url: server.url, refreshHours: 12 },
      onSnapshot: () => { throw new Error('adapter refused') },
      logger,
    })

    await vi.waitFor(() => { expect(warnings).toHaveLength(1) })
    expect(warnings[0]).toMatch(/refused a model directory snapshot \(adapter refused\)/)
  })

  it('reports a consumer that fails without an error', async () => {
    const server = await mockServer([{ body: JSON.stringify({ live: true }) }])

    refresh({
      source: { url: server.url, refreshHours: 12 },
      onSnapshot: () => { throw 'adapter refused' },
      logger,
    })

    await vi.waitFor(() => { expect(warnings).toHaveLength(1) })
    expect(warnings[0]).toMatch(/refused a model directory snapshot \(adapter refused\)/)
  })

  it('stops a cycle that fetches after the handle was disposed', async () => {
    const home = await privateHome()
    const path = join(home, 'snapshot.json')
    const server = await mockServer([{ body: JSON.stringify({ live: true }) }])
    await writeCatalogSnapshot(path, {
      document: { stale: true },
      url: server.url,
      fetchedAt: Date.now() - 86_400_000,
    })

    const handle = refresh({
      source: { url: server.url, refreshHours: 12 },
      cachePath: path,
      // Disposing from the cache publication lands between the two halves of
      // one cycle: the fetch it was about to start must never go out.
      onSnapshot: () => { void handle.dispose() },
      logger,
    })

    await handle.dispose()
    expect(server.paths).toEqual([])
  })

  it('aborts the fetch in flight when disposed, and settles', async () => {
    const server = await mockServer([{ events: ['{"late":true}'], delayMs: 10_000 }])
    const published: unknown[] = []

    const handle = startCatalogRefresh({
      source: { url: server.url, refreshHours: 12 },
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })
    await vi.waitFor(() => { expect(server.paths).toHaveLength(1) })
    await handle.dispose()

    expect(published).toEqual([])
    expect(warnings).toEqual([])
  })

  it('fetches nothing further until an explicit refresh asks for it', async () => {
    const first = { opencode: { models: { one: { tool_call: true } } } }
    const second = { opencode: { models: { two: { tool_call: true } } } }
    const server = await mockServer([{ body: JSON.stringify(first) }, { body: JSON.stringify(second) }])
    const published: unknown[] = []

    const handle = refresh({
      source: { url: server.url, refreshHours: 12 },
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })

    await vi.waitFor(() => { expect(published).toEqual([first]) })
    // Nothing is scheduled: an unchanged period must not fetch on its own.
    expect(server.paths).toEqual(['/'])

    await handle.refresh()
    expect(published).toEqual([first, second])
    expect(server.paths).toEqual(['/', '/'])
  })

  it('refreshes a snapshot the cache would still call current', async () => {
    const home = await privateHome()
    const path = join(home, 'snapshot.json')
    const cached = { opencode: { models: { cached: { tool_call: true } } } }
    const fresh = { opencode: { models: { live: { tool_call: true } } } }
    const server = await mockServer([{ body: JSON.stringify(fresh) }])
    await writeCatalogSnapshot(path, { document: cached, url: server.url, fetchedAt: Date.now() })
    const published: unknown[] = []

    const handle = refresh({
      source: { url: server.url, refreshHours: 12 },
      cachePath: path,
      onSnapshot: (snapshot) => { published.push(snapshot) },
      logger,
    })

    await vi.waitFor(() => { expect(published).toEqual([cached]) })
    await handle.refresh()
    expect(published).toEqual([cached, fresh])
    expect(server.paths).toEqual(['/'])
  })

  it('serializes an explicit refresh behind the fetch already in flight', async () => {
    const home = await privateHome()
    const path = join(home, 'snapshot.json')
    const server = await mockServer([
      { body: JSON.stringify({ one: true }) },
      { body: JSON.stringify({ two: true }) },
      { body: JSON.stringify({ three: true }) },
    ])
    await writeCatalogSnapshot(path, { document: { cached: true }, url: server.url, fetchedAt: Date.now() })

    const handle = refresh({
      source: { url: server.url, refreshHours: 0 },
      cachePath: path,
      onSnapshot: () => { /* publication order is asserted through the server */ },
      logger,
    })

    await Promise.all([handle.refresh(), handle.refresh()])
    // Two refreshes queue behind the start fetch rather than overlapping it.
    expect(server.paths).toEqual(['/', '/', '/'])
    expect(warnings).toEqual([])
  })
})

describe('catalog refresh disposal', () => {
  it('answers an explicit refresh after disposal without fetching', async () => {
    const server = await mockServer([{ body: JSON.stringify({ live: true }) }])
    const handle = refresh({
      source: { url: server.url, refreshHours: 12 },
      onSnapshot: () => { /* nothing is published after disposal */ },
      logger,
    })
    await vi.waitFor(() => { expect(server.paths).toEqual(['/']) })
    await handle.dispose()

    await expect(handle.refresh()).resolves.toBeUndefined()
    expect(server.paths).toEqual(['/'])
  })
})
