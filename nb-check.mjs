import { chromium } from './node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const url = process.argv[2]
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 200)))
await page.goto(url, { waitUntil: 'load' })
await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
await page.waitForTimeout(3000)
await page.getByRole('button', { name: 'New Session' }).first().click()
await page.waitForTimeout(4500)

const chip = async () => page.evaluate(() =>
  [...document.querySelectorAll('[class*="heroWorkspaceRow"] button')].at(-1)?.textContent?.trim())
const selected = async () => page.evaluate(() => JSON.parse(window.localStorage.getItem('dsh.sessions.current') ?? '{}').sessionId)
console.log('before click chip=', await chip(), 'selected=', await selected())

// Click the harness chip with a real mouse click, then the Codex row.
await page.locator('[class*="heroWorkspaceRow"] button').last().click({ timeout: 8000 })
await page.waitForTimeout(800)
const items = page.getByRole('menuitem')
console.log('menu open, options =', await items.count())
await items.nth(1).click()
await page.waitForTimeout(6000)
console.log('after click chip=', await chip(), 'selected=', await selected())
await browser.close()
