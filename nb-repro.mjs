import { chromium } from './node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const [url, sid] = process.argv.slice(2)
const browser = await chromium.launch()
const page = await browser.newPage()
const log = []
page.on('console', m => { const t = m.text(); if (t.includes('[harness-chip]')) log.push('CHIP ' + t.replace('[harness-chip] ', '')) })
page.on('response', async r => {
  if (r.url().includes('/api/session/')) {
    const ep = r.url().split('/api/')[1]
    if (/create|bindHarness/.test(ep)) log.push(`RPC ${ep} -> ${(await r.text().catch(() => '')).slice(0, 120)}`)
  }
})
page.on('pageerror', e => log.push('PAGEERROR ' + String(e).slice(0, 200)))
await page.addInitScript(v => { window.localStorage.setItem('dsh.sessions.current', JSON.stringify(v)) }, { sessionId: sid })
await page.goto(url, { waitUntil: 'load' })
await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
await page.waitForTimeout(3500)
const chip = async () => page.evaluate(() => [...document.querySelectorAll('[class*="heroWorkspaceRow"] button')].at(-1)?.textContent?.trim())
const selected = async () => page.evaluate(() => JSON.parse(window.localStorage.getItem('dsh.sessions.current') ?? '{}').sessionId)
console.log('BEFORE chip=', await chip(), 'sel=', await selected())

// Real mouse click on the chip, then on the Codex row, and log whether the item handler ran.
log.length = 0
await page.locator('[class*="heroWorkspaceRow"] button').last().click({ timeout: 8000 })
await page.waitForTimeout(900)
const items = page.getByRole('menuitem')
console.log('MENU options=', await items.count())
await items.nth(1).click({ timeout: 8000 })
await page.waitForTimeout(7000)
console.log('AFTER  chip=', await chip(), 'sel=', await selected())
console.log(log.join('\n'))
await browser.close()
