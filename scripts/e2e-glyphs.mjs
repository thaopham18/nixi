// Repro / regression for garbled terminal glyphs (WebGL texture atlas): print text, then
// change the device pixel ratio (like dragging the window to a monitor with other scaling)
// and hide/show the tab. Compares terminal screenshots before/after.
//   node scripts/e2e-glyphs.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-glyph-'))
writeFileSync(join(userData, 'sessions.json'), JSON.stringify([{ id: 'l', name: 'local', type: 'local', folder: '' }]))
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ sftpAutoOpen: false }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (n) => join(tmpdir(), `nixi-glyph-${n}.png`)

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' } })
try {
  const win = await app.firstWindow()
  const cdp = await win.context().newCDPSession(win)
  await win.locator('.tree-row', { hasText: 'local' }).last().dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  await sleep(1200)
  await win.locator('.term-container').click()
  await win.keyboard.type('Write-Output "The quick brown fox 0123456789 ABCDEFGHIJ abcdefghij !@#$%^&*()"\r')
  await sleep(800)
  const term = win.locator('.tab-view:visible .term-container')
  await term.screenshot({ path: out('1-before') })

  for (const dpr of [1.5, 2, 1.25, 1]) {
    const { width, height } = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false })
    await sleep(600)
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await sleep(600)
  await term.screenshot({ path: out('2-after-dpr') })

  // Hide + show the tab (another tab in front), then print more.
  await win.locator('button.tab-add').click()
  await sleep(1500)
  await win.locator('.tab').first().click()
  await sleep(600)
  await win.locator('.tab-view:visible .term-container').click()
  await win.keyboard.type('Write-Output "after tab switch: The quick brown fox 0123456789"\r')
  await sleep(800)
  await win.locator('.tab-view:visible .term-container').screenshot({ path: out('3-after-switch') })

  // A new terminal next to a visible one (split): the visible one must stay readable.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'splitRight'))
  await sleep(2000)
  await win.locator('.tab-view:visible .pane').first().screenshot({ path: out('4-after-split') })
  console.log('screenshots:', out('1-before'), out('2-after-dpr'), out('3-after-switch'), out('4-after-split'))
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
