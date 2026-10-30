// Split view + folder delete e2e against scripts/dev-ssh-server.mjs (port 2222).
//   node scripts/dev-ssh-server.mjs   (in another terminal)
//   node scripts/e2e-split.mjs
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const ROOT = join(tmpdir(), 'nixi-dev-sftp')
// The dev server's shell is PowerShell on Windows, $SHELL elsewhere.
const isWin = process.platform === 'win32'
const hostKey = ssh2.utils.parseKey(readFileSync(join(tmpdir(), 'nixi-dev-hostkey')))
const fp = 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '')
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-split-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
const ssh = (id, name, folder) => ({ id, name, type: 'ssh', folder, host: '127.0.0.1', port: 2222, username: 'test', auth: 'password' })
json('known_hosts.json', { '[127.0.0.1]:2222': fp })
json('sessions.json', [ssh('a', 'srv-a', 'Grp'), ssh('b', 'srv-b', 'Grp'), ssh('c', 'srv-c', 'Grp/Sub'), ssh('d', 'keep-me', '')])
json('secrets.json', Object.fromEntries(['a', 'b', 'c', 'd'].map((k) => [k, 'raw:' + Buffer.from('test').toString('base64')])))
json('settings.json', { sftpAutoOpen: false })

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master' } })
try {
  const win = await app.firstWindow()
  win.on('dialog', (d) => d.accept())
  await win.waitForSelector('.tree-row')
  for (const n of ['srv-a', 'srv-b', 'srv-c']) {
    await win.locator('.tree-row', { hasText: n }).last().dblclick()
    await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  }
  check('three tabs connected', (await win.locator('.tab').count()) === 3)

  // Mark srv-b's shell so we can prove the same live session survives the move.
  await win.locator('.tab', { hasText: 'srv-b' }).click()
  await sleep(800)
  await win.locator('.tab-view:visible .term-container').click()
  await win.keyboard.type(isWin ? '$m="survived"\r' : 'm=survived\r')
  await sleep(500)

  await win.locator('.tab', { hasText: 'srv-a' }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'tileAll'))
  await win.waitForSelector('.tab-view.grid')
  const panes = await win.locator('.tab-view:visible .pane').count()
  check('tile all tabs → one grid tab', (await win.locator('.tab').count()) === 1 && panes === 3, `(${panes} panes)`)

  const marker = join(ROOT, 'e2e-split-marker.txt')
  rmSync(marker, { force: true })
  await win.locator('.tab-view:visible .pane', { hasText: 'srv-b' }).locator('.term-container').click()
  await win.keyboard.type(isWin ? '$m | Out-File e2e-split-marker.txt\r' : 'echo $m > e2e-split.tmp && mv e2e-split.tmp e2e-split-marker.txt\r')
  for (let i = 0; i < 30 && !existsSync(marker); i++) await sleep(200)
  const ok = existsSync(marker) && readFileSync(marker, isWin ? 'utf16le' : 'utf8').includes('survived')
  check('moved terminal kept its live shell (no reconnect)', ok)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-split-grid.png') })

  await win.locator('.tab-view:visible .pane', { hasText: 'srv-c' }).locator('button[title="Move to its own tab"]').click()
  check('detach pane → own tab', (await win.locator('.tab').count()) === 2)

  await win.locator('.tab', { hasText: 'srv-a' }).click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Layout: side by side' }).click()
  await sleep(300)
  const divider = win.locator('.tab-view:visible .divider.v')
  const box = await divider.boundingBox()
  const firstBefore = (await win.locator('.tab-view:visible .pane').first().boundingBox()).width
  await win.mouse.move(box.x + 2, box.y + 100)
  await win.mouse.down()
  await win.mouse.move(box.x + 202, box.y + 100, { steps: 5 })
  await win.mouse.up()
  const firstAfter = (await win.locator('.tab-view:visible .pane').first().boundingBox()).width
  check('divider drag resizes panes', firstAfter > firstBefore + 150, `(${Math.round(firstBefore)} → ${Math.round(firstAfter)}px)`)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-split-row.png') })

  await win.locator('.tree-row.folder', { hasText: 'Grp' }).first().click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Delete folder' }).click()
  await sleep(500)
  const names = await win.locator('.session-tree .tree-row').allInnerTexts()
  check('delete folder removes it with subfolders', !names.some((t) => /Grp|srv-/.test(t)) && names.some((t) => /keep-me/.test(t)), JSON.stringify(names))

  // Right-click anywhere in the session list: create a session or an (empty) folder.
  const prompt = async (text) => {
    await win.locator('.modal input').fill(text)
    await win.locator('.modal button', { hasText: 'OK' }).click()
    await sleep(300)
  }
  const tree = win.locator('.session-tree .tree')
  const tb = await tree.boundingBox()
  await tree.click({ button: 'right', position: { x: 60, y: tb.height - 30 } })
  const bg = await win.locator('.context-menu .item').allInnerTexts()
  check('right-click on the empty area offers New session / New folder', bg.includes('New session…') && bg.includes('New folder…'), JSON.stringify(bg))
  await win.locator('.context-menu .item', { hasText: 'New folder…' }).click()
  await prompt('Lab')
  check('empty folder appears', (await win.locator('.tree-row.folder', { hasText: 'Lab' }).count()) === 1)
  await win.locator('.tree-row.folder', { hasText: 'Lab' }).click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'New folder in Lab…' }).click()
  await prompt('Switches')
  check('subfolder inside an empty folder', (await win.locator('.tree-row.folder', { hasText: 'Switches' }).count()) === 1)
  await win.locator('.tree-row', { hasText: 'keep-me' }).last().click({ button: 'right' })
  const onSession = await win.locator('.context-menu .item').allInnerTexts()
  check('session menu offers New session / New folder too', onSession.includes('New session…') && onSession.includes('New folder…'), JSON.stringify(onSession))
  await win.keyboard.press('Escape')
  await win.mouse.click(5, 5)
  await win.locator('.tree-row.folder', { hasText: 'Lab' }).first().click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'New session in Lab…' }).click()
  const folderField = await win.locator('.modal label.field', { hasText: 'Folder' }).locator('input').inputValue().catch(() => '')
  check('"New session in Lab" pre-fills the folder', folderField === 'Lab', JSON.stringify(folderField))
  await win.keyboard.press('Escape')
  const saved = await win.evaluate(() => window.api.listFolders())
  check('folders are saved in the database', JSON.stringify(saved) === '["Lab","Lab/Switches"]', JSON.stringify(saved))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-folders.png') })
  await win.locator('.tree-row.folder', { hasText: 'Lab' }).first().click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Delete folder' }).click()
  await sleep(300)
  check('empty folder can be deleted', (await win.locator('.tree-row.folder').count()) === 0 && JSON.stringify(await win.evaluate(() => window.api.listFolders())) === '[]')
} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  await app.close()
}
process.exit(results.every(Boolean) ? 0 : 1)
