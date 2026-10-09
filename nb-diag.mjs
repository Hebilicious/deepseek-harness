import { chromium } from './node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const url = process.argv[2]
const browser = await chromium.launch()
const page = await browser.newPage()
const diag = []
page.on('console', m => {
  const text = m.text()
  if (text.includes('[harness-chip]')) diag.push(text.replace('[harness-chip] ', ''))
})
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 200)))
await page.goto(url, { waitUntil: 'load' })
await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
await page.waitForTimeout(3000)

const dump = (label) => console.log(label, JSON.stringify(diag.slice(-2)))
dump('initial')
for (let i = 1; i <= 3; i += 1) {
  diag.length = 0
  await page.getByRole('button', { name: 'New Session' }).first().click()
  await page.waitForTimeout(3500)
  dump(`after New Session #${i}`)
}
// And the workspace-scoped new session: click the workspace row's New Session.
diag.length = 0
const workspaceNew = page.getByRole('treeitem', { name: /New Session/ }).first()
if (await workspaceNew.count() > 0) { await workspaceNew.click(); await page.waitForTimeout(3000); dump('after workspace New Session') }
await browser.close()
