import { chromium } from './node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const [url, sid] = process.argv.slice(2)
const browser = await chromium.launch()
const page = await browser.newPage()
const log = []
page.on('console', m => { const t = m.text(); if (t.includes('[harness-chip')) log.push(t.slice(0, 180)) })
await page.addInitScript(v => { window.localStorage.setItem('dsh.sessions.current', JSON.stringify(v)) }, { sessionId: sid })
await page.goto(url, { waitUntil: 'load' })
await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
await page.waitForTimeout(3000)
log.length = 0
await page.locator('[class*="heroWorkspaceRow"] button').last().click({ timeout: 8000 })
await page.waitForTimeout(800)
await page.getByRole('menuitem').nth(2).click({ timeout: 8000 })
await page.waitForTimeout(6000)
console.log(log.join('\n'))
await browser.close()
