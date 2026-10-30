// SFTP transfers (one progress row per batch, "already exists" → overwrite / keep both with a
// 5-digit suffix), tab bar (active tab, pin, close left/right/all, fixed + button), fullest disk
// in the stats bar. Starts its own scripts/dev-ssh-server.mjs (port 2297, temp SFTP root).
//   npm run build && node scripts/e2e-sftp.mjs
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = mkdtempSync(join(tmpdir(), 'nixi-e2e-sftp-root-'))
const local = mkdtempSync(join(tmpdir(), 'nixi-e2e-sftp-local-'))
const downloads = mkdtempSync(join(tmpdir(), 'nixi-e2e-sftp-dl-'))
// the folder "picked" in the Download-to dialog
const picked = mkdtempSync(join(tmpdir(), 'nixi-e2e-sftp-picked-'))
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-sftp-'))

// Local files to upload: two files and a folder with two more.
writeFileSync(join(local, 'a.txt'), 'A'.repeat(300_000))
writeFileSync(join(local, 'b.tar.gz'), 'B'.repeat(200_000))
mkdirSync(join(local, 'docs'))
writeFileSync(join(local, 'docs', 'c.md'), 'C')
writeFileSync(join(local, 'docs', 'd.md'), 'D')
const toUpload = ['a.txt', 'b.tar.gz', 'docs'].map((n) => join(local, n))

const sshd = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', '2297', '--root', root], { stdio: 'ignore' })
const keyFile = join(tmpdir(), 'nixi-dev-hostkey')
for (let i = 0; i < 50 && !existsSync(keyFile); i++) await sleep(100)
const hostKey = ssh2.utils.parseKey(readFileSync(keyFile))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
json('known_hosts.json', { '[127.0.0.1]:2297': 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '') })
// Session color = the accent (#4f8cff), the same blue as the active-tab bar.
json('sessions.json', [{ id: 's1', name: 'sftp-srv', type: 'ssh', folder: '', host: '127.0.0.1', port: 2297, username: 'test', auth: 'password', color: '#4f8cff' }])
json('secrets.json', { s1: 'raw:' + Buffer.from('test').toString('base64') })
json('settings.json', { downloadDir: downloads, sftpAutoOpen: true })

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const shot = (win, name) => win.screenshot({ path: join(tmpdir(), `nixi-e2e-sftp-${name}.png`) })

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' } })
// Native file dialogs, answered from here: upload → the local files; "Download to" (a folder
// picker) → `picked`, remembering the folder it opened on.
await app.evaluate(({ dialog }, [paths, dir]) => {
  dialog.showOpenDialog = async (w, o) => {
    const opts = o ?? w
    if (!opts.properties.includes('createDirectory')) return { canceled: false, filePaths: paths }
    globalThis.__downloadDialog = opts.defaultPath
    return globalThis.__cancelPick ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [dir] }
  }
}, [toUpload, picked])
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')
  await win.locator('.tree-row', { hasText: 'sftp-srv' }).last().dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  await win.locator('.sidebar-tabs button', { hasText: 'SFTP' }).click()
  await win.locator('.sftp-list td.name', { hasText: 'hello.txt' }).waitFor({ timeout: 10000 })

  // ---- upload: one batch → one row
  const transferRows = win.locator('.transfers .transfer')
  await win.locator('.sftp-toolbar button[title^="Upload"]').click()
  await win.locator('.transfer.done').waitFor({ timeout: 10000 })
  check('3 items + a folder upload as one transfer row', (await transferRows.count()) === 1, `(${await transferRows.count()} rows)`)
  const row = await transferRows.first().innerText()
  check('the row says "3 items" and counts the 4 files', /3 items/.test(row) && /4 files/.test(row), JSON.stringify(row))
  check('files arrived', readFileSync(join(root, 'a.txt'), 'utf8').length === 300_000 && existsSync(join(root, 'docs', 'd.md')))
  check('no question when nothing clashes', (await win.locator('.modal').count()) === 0)
  await shot(win, 'upload')

  // ---- same upload again: asked; Keep both → random 5-digit suffix
  await win.locator('.sftp-toolbar button[title^="Upload"]').click()
  const modal = win.locator('.modal')
  await modal.waitFor({ timeout: 5000 })
  const listed = await modal.locator('.choice-items li').allInnerTexts()
  check('asks about the 3 existing items', JSON.stringify(listed) === '["a.txt","b.tar.gz","docs"]', JSON.stringify(listed))
  await shot(win, 'conflict')
  await modal.getByRole('button', { name: 'Keep both' }).click()
  await win.locator('.transfer.done').nth(1).waitFor({ timeout: 10000 })
  const names = readdirSync(root).sort()
  const suffixed = names.filter((n) => /^(a-\d{5}\.txt|b-\d{5}\.tar\.gz|docs-\d{5})$/.test(n))
  check('keep both adds -NNNNN before the extension', suffixed.length === 3, JSON.stringify(names))
  check('originals untouched', readFileSync(join(root, 'a.txt'), 'utf8').length === 300_000)

  // ---- Overwrite: no new names; Cancel: nothing happens
  writeFileSync(join(local, 'a.txt'), 'new content')
  await win.locator('.sftp-toolbar button[title^="Upload"]').click()
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Overwrite' }).click()
  await win.locator('.transfer.done').nth(2).waitFor({ timeout: 10000 })
  check('overwrite replaces in place', readFileSync(join(root, 'a.txt'), 'utf8') === 'new content' && readdirSync(root).length === names.length)
  const before = await transferRows.count()
  await win.locator('.sftp-toolbar button[title^="Upload"]').click()
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Cancel' }).click()
  await sleep(500)
  check('cancel starts no transfer', (await transferRows.count()) === before && readdirSync(root).length === names.length)

  // ---- download two selected items: one row; again → keep both in the download folder
  await win.locator('.transfers button.link', { hasText: 'clear' }).click()
  await win.locator('.sftp-toolbar button[title="Refresh"]').click()
  await win.locator('.sftp-list td.name', { hasText: /^\s*b\.tar\.gz/ }).first().click()
  await win.locator('.sftp-list td.name', { hasText: /^\s*docs$/ }).first().click({ modifiers: ['Meta'] })
  // Cancel in the folder picker: nothing happens.
  await app.evaluate(() => (globalThis.__cancelPick = true))
  await win.locator('.sftp-toolbar button[title="Download selected"]').click()
  await sleep(500)
  check('download asks for a folder; cancel = no download', (await transferRows.count()) === 0 && readdirSync(picked).length === 0)
  await app.evaluate(() => (globalThis.__cancelPick = false))
  // Right-click → Download… : picker opens on the download folder from Settings.
  await win.locator('.sftp-list td.name', { hasText: /^\s*docs$/ }).first().click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Download (2)…' }).click()
  await win.locator('.transfer.done').waitFor({ timeout: 10000 })
  check('the folder picker opens on the default download folder', (await app.evaluate(() => globalThis.__downloadDialog)) === downloads)
  check('2 selected items download as one row', (await transferRows.count()) === 1 && /2 items/.test(await transferRows.first().innerText()))
  check('downloaded into the picked folder', existsSync(join(picked, 'b.tar.gz')) && existsSync(join(picked, 'docs', 'c.md')) && readdirSync(downloads).length === 0)
  await win.locator('.sftp-toolbar button[title="Download selected"]').click()
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Keep both' }).click()
  await win.locator('.transfer.done').nth(1).waitFor({ timeout: 10000 })
  const dl = readdirSync(picked)
  check('download keep both', dl.some((n) => /^b-\d{5}\.tar\.gz$/.test(n)) && dl.some((n) => /^docs-\d{5}$/.test(n)), JSON.stringify(dl))
  check('rows are draggable (drag out to download)', (await win.locator('.sftp-list tbody tr[draggable=true]').count()) > 3)
  // Drag out (macOS: file promises). Without a real mouse nothing can be dropped (the drop into
  // Finder is checked by hand); this checks the no-button case.
  const dlBefore = readdirSync(downloads).length
  await win.locator('.transfers button.link', { hasText: 'clear' }).click()
  await win.locator('.sftp-list td.name', { hasText: /^\s*docs$/ }).first().click()
  await win.locator('.sftp-list tbody tr').filter({ has: win.locator('td.name', { hasText: /^\s*docs$/ }) }).first().dispatchEvent('dragstart')
  await sleep(1500)
  // No button held here: the drag must not start at all, or AppKit's drag loop would block the
  // main process waiting for a mouse-up (seen as a hang when the app quits).
  const mainAlive = await Promise.race([app.evaluate(() => true), sleep(3000).then(() => false)])
  check('a drag without a held mouse button starts nothing, main stays responsive', readdirSync(downloads).length === dlBefore && (await transferRows.count()) === 0 && mainAlive)

  // ---- stats bar: every user mount (fullest first) in the bar, system ones only in the popup
  await win.waitForFunction(() => document.querySelector('.stats-bar .disk-chip'), null, { timeout: 10000 })
  const chips = await win.locator('.stats-bar .disk-chip').evaluateAll((cs) =>
    cs.map((c) => ({ mount: c.querySelector('.disk-mount').textContent, pct: Number(c.querySelector('.meter-text').textContent.replace('%', '')) }))
  )
  await win.locator('.stats-bar .disks').hover()
  await win.locator('.stats-popup').waitFor({ timeout: 3000 })
  const rowsOf = (sel) =>
    win.locator(sel).evaluateAll((rs) => rs.map((r) => ({ mount: r.querySelector('.mount').textContent, pct: Number(r.querySelector('.meter-text').textContent.replace('%', '')) })))
  const userRows = await rowsOf('.disk-table tbody:not(.system) tr')
  const systemRows = await rowsOf('.disk-table tbody.system tr:not(.section)')
  const sorted = chips.every((c, i) => !i || chips[i - 1].pct >= c.pct)
  check('bar shows each user mount with its %, fullest first', chips.length === userRows.length && sorted && chips.every((c, i) => c.mount === userRows[i].mount && c.pct === userRows[i].pct), JSON.stringify({ chips, userRows }))
  const sysInBar = systemRows.filter((r) => chips.some((c) => c.mount === r.mount))
  check('system mounts only in the popup', sysInBar.length === 0 && (process.platform !== 'darwin' || systemRows.some((r) => r.mount === '/')), JSON.stringify(systemRows))
  await shot(win, 'disk')
  await win.mouse.move(600, 300)

  // ---- tabs
  for (let i = 0; i < 4; i++) await win.locator('.tab-add').click()
  await win.waitForFunction(() => document.querySelectorAll('.tab').length === 5)
  const tabs = win.locator('.tab')
  // The open tab is outlined and joins the frame around the terminal (neutral color); the session
  // color is only the small bar on the tab.
  const look = (el) => {
    const cs = getComputedStyle(el)
    const views = document.querySelector('.tab-views')
    return {
      outline: cs.borderTopColor,
      bg: cs.backgroundColor,
      color: cs.color,
      bar: el.querySelector('.tab-color') && getComputedStyle(el.querySelector('.tab-color')).backgroundColor,
      touches: el.getBoundingClientRect().bottom >= views.getBoundingClientRect().top + 1,
      frame: getComputedStyle(views).borderTopColor
    }
  }
  // tabs.first() is sftp-srv, colored with the accent itself.
  const act = await win.locator('.tab.active').evaluate(look)
  const srv = await tabs.first().evaluate(look)
  check('open tab: outlined, terminal background, joined to the frame', act.outline === act.frame && act.touches && act.bg !== srv.bg && act.color !== srv.color, JSON.stringify({ act, srv }))
  check('a tab colored like the accent: color bar only, no outline while not open', srv.bar === 'rgb(79, 140, 255)' && srv.outline === 'rgba(0, 0, 0, 0)' && !srv.touches, JSON.stringify(srv))
  await tabs.first().click()
  const srvActive = await tabs.first().evaluate(look)
  check('…once open: same bar, neutral outline joined to the frame', srvActive.bar === srv.bar && srvActive.outline === srvActive.frame && srvActive.frame !== srv.bar && srvActive.touches, JSON.stringify(srvActive))
  check('no ‹ › while the tabs fit', (await win.locator('.tab-nav').count()) === 0)

  const titles = () => tabs.evaluateAll((ts) => ts.map((t) => t.querySelector('.tab-title').textContent + (t.classList.contains('pinned') ? '*' : '')))
  // Local tabs may share a title: pin the 3rd tab whatever it is called.
  const third = tabs.nth(2)
  const thirdTitle = await third.locator('.tab-title').innerText()
  await third.click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Pin tab' }).click()
  const afterPin = await titles()
  check('pinned tab moves to the front, no close button', afterPin[0] === `${thirdTitle}*` && (await tabs.first().locator('.tab-close').count()) === 0, JSON.stringify(afterPin))
  await shot(win, 'tabs')

  // close to the right of tab #3 (index 2): pinned + 2 others remain
  await tabs.nth(2).click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Close tabs to the right' }).click()
  await sleep(300)
  check('close tabs to the right', (await tabs.count()) === 3, JSON.stringify(await titles()))
  await tabs.nth(2).click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Close tabs to the left' }).click()
  await sleep(300)
  const leftDone = await titles()
  check('close tabs to the left keeps the pinned one', leftDone.length === 2 && leftDone[0].endsWith('*'), JSON.stringify(leftDone))
  await tabs.nth(1).click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Close all' }).click()
  await sleep(300)
  check('close all keeps pinned tabs', JSON.stringify(await titles()) === JSON.stringify([`${thirdTitle}*`]), JSON.stringify(await titles()))

  // + button stays at the right end however many tabs there are
  for (let i = 0; i < 25; i++) await win.locator('.tab-add').click()
  await sleep(500)
  const addBox = await win.locator('.tab-add').boundingBox()
  const barBox = await win.locator('.tabbar').boundingBox()
  const strip = await win.locator('.tab-strip').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sl: e.scrollLeft }))
  check('+ stays visible at the right end with many tabs', Math.abs(addBox.x + addBox.width - (barBox.x + barBox.width)) <= 1 && strip.sw > strip.cw, JSON.stringify({ addBox, barBox, strip }))
  const activeBox = await win.locator('.tab.active').boundingBox()
  check('new active tab scrolled into view', activeBox.x + activeBox.width <= addBox.x + 1 && strip.sl > 0)
  const nav = win.locator('.tab-nav button')
  const navBox = await win.locator('.tab-nav').boundingBox()
  const stripBox = await win.locator('.tab-strip').boundingBox()
  check('‹ › appear left of the tabs when they overflow', (await nav.count()) === 2 && navBox.x + navBox.width <= stripBox.x + 1 && navBox.x <= barBox.x + 1)
  check('at the right end: › disabled, ‹ enabled', (await nav.nth(1).isDisabled()) && !(await nav.nth(0).isDisabled()))
  const scrollLeft = () => win.locator('.tab-strip').evaluate((e) => e.scrollLeft)
  const sl0 = await scrollLeft()
  await nav.nth(0).click()
  await sleep(600)
  const sl1 = await scrollLeft()
  check('‹ scrolls the tabs left', sl1 < sl0 - 100, `(${sl0} → ${sl1})`)
  for (let i = 0; i < 8 && !(await nav.nth(0).isDisabled()); i++) {
    await nav.nth(0).click()
    await sleep(500)
  }
  check('…down to the first tab, then ‹ is disabled', (await scrollLeft()) === 0 && (await nav.nth(0).isDisabled()))
  await nav.nth(1).click()
  await sleep(600)
  check('› scrolls right again', (await scrollLeft()) > 100)
  await shot(win, 'many-tabs')
} catch (err) {
  check('unexpected error', false, err.message)
  await app.windows()[0]?.screenshot({ path: join(tmpdir(), 'nixi-e2e-sftp-error.png') }).catch(() => {})
} finally {
  await app.close()
  sshd.kill()
  for (const d of [root, local, downloads, picked, userData]) rmSync(d, { recursive: true, force: true })
}
console.log(`Screenshots: ${join(tmpdir(), 'nixi-e2e-sftp-*.png')}`)
process.exit(results.every(Boolean) ? 0 : 1)
