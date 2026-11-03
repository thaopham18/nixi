// Buttons in one area match: same height and width per area (the --ctl-h / --ctl-w scale), icon buttons same size,
// line icons rather than font glyphs. Screenshots go to nixi-buttons-*.png in the temp folder.
// Starts its own scripts/dev-ssh-server.mjs (port 2293); RDP/VNC only need their toolbars, so
// they point at a closed port.
//   npm run build && node scripts/e2e-buttons.mjs
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-buttons-'))
const sshd = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', '2293'], { stdio: 'ignore' })
const keyFile = join(tmpdir(), 'nixi-dev-hostkey')
for (let i = 0; i < 50 && !existsSync(keyFile); i++) await sleep(100)
const hostKey = ssh2.utils.parseKey(readFileSync(keyFile))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
const raw = (s) => 'raw:' + Buffer.from(s).toString('base64')
json('known_hosts.json', { '[127.0.0.1]:2293': 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '') })
json('sessions.json', [
  { id: 's', name: 'srv', type: 'ssh', folder: '', host: '127.0.0.1', port: 2293, username: 'test', auth: 'password' },
  { id: 'l', name: 'shell', type: 'local', folder: '' },
  { id: 'r', name: 'desk', type: 'rdp', folder: '', host: '127.0.0.1', port: 1, username: 'alice' },
  { id: 'v', name: 'screen', type: 'vnc', folder: '', host: '127.0.0.1', port: 1 }
])
json('secrets.json', { s: raw('test'), r: raw('good'), v: raw('good') })
json('tunnels.json', [{ id: 'tn', name: 'web', type: 'L', sessionId: 's', bindHost: '127.0.0.1', bindPort: 18080, destHost: '127.0.0.1', destPort: 80 }])
json('macros.json', [{ id: 'm1', name: 'one', steps: [{ kind: 'send', text: 'ls\r' }] }, { id: 'm2', name: 'two', steps: [{ kind: 'send', text: 'pwd\r' }] }])

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : extra}`)
}
const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' } })
try {
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 720))
  await win.waitForSelector('.tree-row')
  const px = await win.evaluate(() => {
    const css = getComputedStyle(document.documentElement)
    return { md: parseFloat(css.getPropertyValue('--ctl-h')), sm: parseFloat(css.getPropertyValue('--ctl-h-sm')), xs: parseFloat(css.getPropertyValue('--ctl-h-xs')) }
  })
  const menu = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', c), c)
  const shot = (name) => win.screenshot({ path: join(tmpdir(), `nixi-buttons-${name}.png`) })
  const open = async (name) => {
    await win.locator('.tree-row', { hasText: new RegExp(`^${name}`) }).last().dblclick()
    await sleep(800)
  }
  const boxes = (selector) =>
    win.evaluate((selector) =>
      [...document.querySelectorAll(selector)]
        .filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'none')
        .map((e) => {
          const r = e.getBoundingClientRect()
          return { w: r.width, h: r.height, text: e.innerText.trim(), svg: !!e.querySelector('svg') }
        }), selector)
  /** Every button in the area has this height, and icon-only ones are square when asked. */
  const area = async (name, selector, height, square = false) => {
    const found = await boxes(selector)
    const off = found.filter((b) => b.h !== height || (square && b.w !== height))
    check(`${name}: ${found.length} button(s) at ${height}px`, found.length > 0 && !off.length, JSON.stringify(off.length ? off : 'none found'))
  }
  /** They all have one width: the same, or at least this much when the text needs more. */
  const sameWidth = async (name, selector) => {
    const widths = (await boxes(selector)).map((b) => b.w)
    check(`${name}: all one width`, widths.length > 1 && new Set(widths).size === 1, JSON.stringify(widths))
  }
  const noGlyphs = async (name) => {
    const bad = (await boxes('button')).filter((b) => /[✕×⇱🗖🗗＋●■⊞⧉↑↓▾]/u.test(b.text))
    check(`${name}: icons are drawn, not font glyphs`, !bad.length, JSON.stringify(bad))
  }
  const closeModal = async () => {
    await win.locator('.modal .icon[title="Close"]').click()
    await sleep(150)
  }

  await area('welcome', '.welcome-actions button', px.md)
  await area('sidebar segmented', '.sidebar-tabs button', px.sm)
  await area('toolbar', '.toolbar button', px.md)
  await sameWidth('toolbar', '.toolbar button:not(.square)')
  await area('toolbar settings', '.toolbar button.square', px.md, true)
  await sameWidth('welcome', '.welcome-actions button')
  await shot('welcome')
  // Too narrow for labels: icons only, still all one width.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 720))
  await sleep(300)
  await sameWidth('narrow toolbar', '.toolbar button:not(.square)')
  await shot('narrow')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 720))
  await sleep(300)

  await open('srv')
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  await win.locator('.sidebar-tabs button', { hasText: 'SFTP' }).click()
  await sleep(500)
  await area('sftp toolbar', '.sftp-toolbar button', px.sm, true)
  await shot('sftp')
  await noGlyphs('ssh tab + sftp')
  await win.locator('.sidebar-tabs button', { hasText: 'Sessions' }).click()

  await open('shell')
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  await win.locator('.tab.active').hover()
  await area('tab buttons', '.tab.active .tab-close, .tab.active .tab-dup', px.xs, true)
  await area('new tab button', '.tab-add', px.sm, true)
  await area('sidebar icon button', '.sidebar-search .icon', px.sm, true)
  await win.locator('.tab', { hasText: 'shell' }).first().click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Split with' }).click()
  await sleep(500)
  await area('pane header', '.pane-header .icon', px.xs, true)
  await menu('find')
  await sleep(300)
  await area('search bar', '.search-bar button', px.sm, true)
  await shot('split')
  await noGlyphs('split + search')
  await win.keyboard.press('Escape')

  await menu('settings')
  await sleep(300)
  await area('settings footer', '.modal-footer button', px.md)
  await area('settings pages', '.settings-nav button', px.md)
  await sameWidth('settings pages', '.settings-nav button')
  await sameWidth('settings footer', '.modal-footer button')
  await shot('settings')
  await closeModal()

  await menu('macros')
  await sleep(300)
  await win.locator('.macro-row').first().click()
  await sleep(100)
  await area('macro list', '.macro-list > button', px.md)
  await area('macro order', '.order-buttons button', px.xs, true)
  await area('macro mode', '.macro-editor .type-picker button', px.sm)
  await sameWidth('macro mode', '.macro-editor .type-picker button')
  await area('macro actions', '.macro-editor .row.end button', px.md)
  await shot('macros')
  await noGlyphs('macros')
  await closeModal()

  await menu('credentials')
  await sleep(300)
  await area('credential list', '.macro-list > button', px.md)
  await area('credential type', '.type-picker button', px.sm)
  await sameWidth('credential type', '.type-picker button')
  await area('credential actions', '.macro-editor .row.end button', px.md)
  await shot('credentials')
  await noGlyphs('credentials')
  await closeModal()

  await menu('tunnels')
  await sleep(300)
  await area('tunnel footer', '.modal button.primary', px.md)
  await sameWidth('tunnel card', '.tunnel-card-head button:not(.square)')
  await area('tunnel delete', '.tunnel-card-head button.square', px.md, true)
  await shot('tunnels')
  await noGlyphs('tunnels')
  await closeModal()

  await win.locator('.tree-row', { hasText: /^srv/ }).last().click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Edit…' }).click()
  await sleep(300)
  await area('session type', '.modal .type-picker button', px.sm)
  await sameWidth('session type', '.modal .type-picker button')
  const kinds = await win.locator('.modal .type-picker button').allInnerTexts()
  check('session types in order, Telnet near the end', kinds.map((k) => k.trim()).join() === 'SSH,RDP,VNC,Telnet,Local', kinds.join())
  await area('session footer', '.modal-footer button', px.md)
  await sameWidth('session footer', '.modal-footer button')
  await shot('session')
  await closeModal()

  await open('desk')
  await sleep(1500)
  await win.keyboard.press('Escape')
  await area('RDP toolbar', '.rdp-toolbar button', px.sm)
  await sameWidth('RDP toolbar', '.rdp-toolbar button')
  await shot('rdp')
  await noGlyphs('rdp')
  await open('screen')
  await sleep(1500)
  await win.keyboard.press('Escape')
  await area('VNC toolbar', '.rdp-toolbar button', px.sm)
  await sameWidth('VNC toolbar', '.rdp-toolbar button')
  await area('VNC toolbar select', '.rdp-toolbar select', px.sm)
  await shot('vnc')

  // The same look in the light theme: a segmented button must still stand out.
  await win.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  await sleep(200)
  await shot('light')
  console.log('shots in', tmpdir())
} finally {
  await app.close()
  sshd.kill()
  rmSync(userData, { recursive: true, force: true })
}
console.log(failed ? `${failed} FAILED` : 'all pass')
process.exit(failed ? 1 : 0)
