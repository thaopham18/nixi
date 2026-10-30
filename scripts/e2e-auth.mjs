// Password prompt + terminal size e2e against scripts/dev-ssh-server.mjs (user test / password test).
//   node scripts/dev-ssh-server.mjs   (in another terminal)
//   node scripts/e2e-auth.mjs
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'
import { readDb } from './read-db.mjs'

const ROOT = join(tmpdir(), 'nixi-dev-sftp')
// The dev server's shell is PowerShell on Windows, $SHELL elsewhere.
const isWin = process.platform === 'win32'
const widthCmd = isWin ? '$Host.UI.RawUI.WindowSize.Width | Out-File e2e-width.txt\r' : 'tput cols > e2e-width.tmp && mv e2e-width.tmp e2e-width.txt\r'
const readOut = (f) => readFileSync(f, isWin ? 'utf16le' : 'utf8')
const hostKey = ssh2.utils.parseKey(readFileSync(join(tmpdir(), 'nixi-dev-hostkey')))
const fp = 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '')
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-auth-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
json('known_hosts.json', { '[127.0.0.1]:2222': fp })
json('sessions.json', [{ id: 'n', name: 'no-saved-pw', type: 'ssh', folder: '', host: '127.0.0.1', port: 2222, username: 'test', auth: 'password' }])
json('settings.json', { sftpAutoOpen: false })

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const menu = (app, cmd) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', c), cmd)

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master', SSH_AUTH_SOCK: '' } })
try {
  const win = await app.firstWindow()
  await win.locator('.tree-row', { hasText: 'no-saved-pw' }).last().dblclick()
  // Resize the pane while the connection is being set up (the race behind the cursor glitch).
  await menu(app, 'toggleSidebar')

  let pw = await win.waitForSelector('.modal input[type=password]', { timeout: 15000 })
  await pw.fill('wrong-password')
  await pw.press('Enter')
  await win.waitForSelector('.modal .error-line:has-text("rejected")', { timeout: 15000 })
  check('wrong password → asked again with a hint', true)
  pw = await win.waitForSelector('.modal input[type=password]')
  await pw.fill('test')
  await win.locator('.modal label.check input').check()
  await pw.press('Enter')
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  check('correct password connects', true)
  await sleep(500)
  const { secrets } = readDb(join(userData, 'nixi.nxdb'), 'e2e-master')
  check('"Remember in Keychain" stored the password', secrets.n === 'test')

  // Remote terminal width must match what the pane shows.
  await sleep(800)
  await win.locator('.tab-view:visible .term-container').click()
  const out = join(ROOT, 'e2e-width.txt')
  rmSync(out, { force: true })
  await win.keyboard.type(widthCmd)
  for (let i = 0; i < 30 && !existsSync(out); i++) await sleep(200)
  const remote = Number(readOut(out).replace(/[^\d]/g, ''))
  const local = Number((await win.locator('.tab-view:visible .term-container').getAttribute('data-size')).split('x')[0])
  check('server terminal width = pane width', Math.abs(remote - local) <= 1, `(server ${remote}, pane ${local})`)

  // Race: resize while a (saved-password) connection is in flight.
  await menu(app, 'toggleSidebar') // show sidebar again
  await win.locator('.tree-row', { hasText: 'no-saved-pw' }).last().dblclick()
  await sleep(30)
  await menu(app, 'toggleSidebar')
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  await sleep(800)
  await win.locator('.tab-view:visible .term-container').click()
  rmSync(out, { force: true })
  await win.keyboard.type(widthCmd)
  for (let i = 0; i < 30 && !existsSync(out); i++) await sleep(200)
  const remote2 = Number(readOut(out).replace(/[^\d]/g, ''))
  const local2 = Number((await win.locator('.tab-view:visible .term-container').getAttribute('data-size')).split('x')[0])
  check('width still right after resizing mid-connect', Math.abs(remote2 - local2) <= 1, `(server ${remote2}, pane ${local2})`)
  await menu(app, 'closeTab')

  // Two more panes of the same server at once: no prompt (saved), both connect.
  await menu(app, 'duplicateTab')
  await menu(app, 'splitRight')
  await sleep(4000)
  const prompts = await win.locator('.modal input[type=password]').count()
  const connected = await win.locator('.tab .dot.connected').count()
  check('duplicate + split connect without asking again', prompts === 0 && connected === 2, `(prompts ${prompts}, connected tabs ${connected})`)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-auth.png') })
} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  await app.close()
}
process.exit(results.every(Boolean) ? 0 : 1)
