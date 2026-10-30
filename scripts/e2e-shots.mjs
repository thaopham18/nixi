// Screenshots of the main window for eyeballing the look (rounded corners, tabs around the
// terminal). Local shells only; writes nixi-shot-*.png into the temp folder.
//   node scripts/e2e-shots.mjs [name-prefix]
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'

const prefix = process.argv[2] || 'nixi-shot'
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-shots-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
json('sessions.json', [
  { id: 'a', name: 'web-01', type: 'ssh', folder: 'Prod', host: '10.0.0.1', username: 'root', auth: 'password', color: '#e06c75' },
  { id: 'b', name: 'switch', type: 'telnet', folder: 'Prod', host: '10.0.0.2' },
  { id: 'c', name: 'shell', type: 'local', folder: '', color: '#98c379' },
  { id: 'd', name: 'blue shell', type: 'local', folder: '', color: '#4f8cff' },
  { id: 'e', name: 'plain', type: 'local', folder: '' },
  // enough rows for the tree to scroll
  ...Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, name: `server-${String(i).padStart(2, '0')}-with-a-rather-long-name`, type: 'ssh', folder: 'Many', host: `10.1.0.${i}`, username: 'root', auth: 'password' }))
])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' } })
try {
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 720))
  await win.waitForSelector('.tree-row')
  await win.screenshot({ path: join(tmpdir(), `${prefix}-welcome.png`) })
  for (const name of ['shell', 'blue shell', 'plain']) {
    await win.locator('.tree-row', { hasText: new RegExp(`^${name}$`) }).last().dblclick()
    await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  }
  await win.locator('.tab-view:visible .term-container').click()
  await win.keyboard.type('seq 300\r')
  await sleep(800)
  await win.locator('.tree').hover()
  await win.screenshot({ path: join(tmpdir(), `${prefix}-tabs.png`) })
  await win.locator('.tab', { hasText: 'blue shell' }).click()
  await sleep(300)
  await win.screenshot({ path: join(tmpdir(), `${prefix}-blue.png`) })
  // Split: tile all, then a context menu and a dialog.
  await win.locator('.tab', { hasText: 'shell' }).first().click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Tile all' }).click()
  await sleep(600)
  await win.screenshot({ path: join(tmpdir(), `${prefix}-split.png`) })
  const menuCmd = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', c), c)
  await menuCmd('multiExec')
  await sleep(300)
  await win.screenshot({ path: join(tmpdir(), `${prefix}-multiexec.png`) })
  await menuCmd('multiExec')
  await win.locator('.tab').first().click({ button: 'right' })
  await sleep(200)
  await win.screenshot({ path: join(tmpdir(), `${prefix}-menu.png`) })
  await win.keyboard.press('Escape')
  await win.locator('.tree-row', { hasText: 'web-01' }).click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Edit…' }).click()
  await sleep(300)
  await win.screenshot({ path: join(tmpdir(), `${prefix}-dialog.png`) })
  await win.keyboard.press('Escape')
  for (const theme of ['light', 'solarized']) {
    await win.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    await sleep(300)
    await win.screenshot({ path: join(tmpdir(), `${prefix}-${theme}.png`) })
  }
  console.log('shots in', tmpdir())
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
