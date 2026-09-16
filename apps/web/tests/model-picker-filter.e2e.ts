// Web e2e scenario: the composer's model list filters as the user types and
// keeps a pinned favourite above the provider groups. The declared catalog is
// the whole fixture — names, ids, and the provider label all come from the
// settings document, so the golden pins what the seat renders for a route the
// Host actually serves. Zero model calls: declaring and inspecting the catalog
// is settings/llm traffic only, so there is no session fixture and a stray
// stream would fail loud.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Starts the shipped default on one of this scenario's declared models. */
const OVERLAY = fileURLToPath(new URL('./model-picker-filter.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/model-picker-filter', import.meta.url))
const FILTERED_EXPECTED = fileURLToPath(new URL('./expected/model-picker-filter/filtered.expected.md', import.meta.url))
const PINNED_EXPECTED = fileURLToPath(new URL('./expected/model-picker-filter/pinned.expected.md', import.meta.url))
const MODE = webSnapshotMode()

/** Every row the composed catalog offers, in render order. */
const ALL_MODELS = [
  'DeepSeek-V4-Flash', 'DeepSeek-V4-Flash-Vision-Exp',
  'Acme Think', 'Acme Think Pro', 'Acme Swift', 'Acme Vision',
]

describe.skipIf(MODE === 'record')('web e2e: the composer model list filters and pins', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // Two names share the "think" stem while the ids stay distinct, so a
    // filtered list proves a name match rather than a whole-group remainder.
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [
            { id: 'acme-think', name: 'Acme Think' },
            { id: 'acme-think-pro', name: 'Acme Think Pro' },
            { id: 'acme-swift', name: 'Acme Swift' },
            { id: 'acme-vision', name: 'Acme Vision' },
          ],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('narrows the rows to the typed text and keeps a pinned model on top', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-picker-filter'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: /模型/ }).click()

    // The list opens on the whole catalog: the shipped provider the scaffold
    // registers, then this scenario's declared one, each in declaration order.
    const rows = page.getByRole('menuitemradio')
    await expect.poll(async () => rows.allTextContents(), { timeout: 10_000 })
      .toEqual(ALL_MODELS)

    // The filter field takes focus on entry, so the query is typed directly.
    const search = page.getByRole('searchbox', { name: '搜索模型' })
    await expect.poll(() => search.evaluate(node => node === document.activeElement), { timeout: 5_000 })
      .toBe(true)
    await search.fill('think')
    await expect.poll(async () => rows.allTextContents(), { timeout: 10_000 })
      .toEqual(['Acme Think', 'Acme Think Pro'])
    await compareOrRefreshGolden(
      FILTERED_EXPECTED,
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd),
      MODE,
    )

    // Pinning keeps the provider group complete and repeats the row above it,
    // labelled with the provider that serves it.
    await page.getByRole('button', { name: '固定 Acme Think Pro' }).click()
    await page.getByRole('searchbox', { name: '搜索模型' }).press('Escape')
    const pinned = page.getByRole('group', { name: '已固定' })
    await pinned.waitFor({ timeout: 10_000 })
    await expect.poll(async () => pinned.getByRole('menuitemradio').allTextContents(), { timeout: 10_000 })
      .toEqual(['Acme Think ProAcme Gateway'])
    // Six catalog rows plus the pinned repeat.
    expect(await rows.count()).toBe(ALL_MODELS.length + 1)
    await compareOrRefreshGolden(
      PINNED_EXPECTED,
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd),
      MODE,
    )

    // The pin is a browser preference, so it outlives this page under its own key.
    expect(await page.evaluate(() => localStorage.getItem('dsh.model-pins')))
      .toBe('{"pinned":["acme-gateway/acme-think-pro"]}')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['filtered.expected.md', 'pinned.expected.md'])
  })
})
