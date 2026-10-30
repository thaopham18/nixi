// Smoke test of the packaged app (after `npm run dist:win` / `dist:mac`): local shell (node-pty),
// SSH (dev-ssh-server on 2222) and the RDP proxy worker, all from inside app.asar.
//   node scripts/e2e-packaged.mjs [path/to/Nixi.exe | path/to/Nixi.app/Contents/MacOS/Nixi]
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const isMac = process.platform === 'darwin'
const exe = process.argv[2] ?? (isMac ? join('dist', 'mac', 'Nixi.app', 'Contents', 'MacOS', 'Nixi') : join('dist', 'win-unpacked', 'Nixi.exe'))
if (!existsSync(exe)) throw new Error(`Not found: ${exe} (run npm run ${isMac ? 'dist:mac' : 'dist:win'} first)`)

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-pkg-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
const sessions = [{ id: 'l', name: 'local', type: 'local', folder: '' }]
const hostKeyFile = join(tmpdir(), 'nixi-dev-hostkey')
if (existsSync(hostKeyFile)) {
  const key = ssh2.utils.parseKey(readFileSync(hostKeyFile))
  json('known_hosts.json', { '[127.0.0.1]:2222': 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '') })
  sessions.push({ id: 's', name: 'ssh', type: 'ssh', folder: '', host: '127.0.0.1', port: 2222, username: 'test', auth: 'password' })
  json('secrets.json', { s: 'raw:' + Buffer.from('test').toString('base64') })
}
sessions.push({ id: 'r', name: 'rdp', type: 'rdp', folder: '', host: '127.0.0.1', port: 3389, username: 'nixi-no-such-user' })
json('sessions.json', sessions)
json('secrets.json', {
  ...(sessions.some((s) => s.id === 's') ? { s: 'raw:' + Buffer.from('test').toString('base64') } : {}),
  r: 'raw:' + Buffer.from('definitely-wrong').toString('base64')
})
json('settings.json', { sftpAutoOpen: false })

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}

const app = await electron.launch({ executablePath: exe, env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'pkg-test' } })
app.process().stderr.on('data', (d) => process.env.DEBUG && process.stdout.write('[main] ' + d))
app.process().stdout.on('data', (d) => process.env.DEBUG && process.stdout.write('[main] ' + d))
try {
  const win = await app.firstWindow()
  win.on('console', (m) => process.env.DEBUG && console.log('[renderer]', m.type(), m.text()))
  check('window title', (await win.title()) === 'Nixi')
  for (const name of sessions.filter((s) => s.type !== 'rdp').map((s) => s.name)) {
    await win.locator('.tree-row', { hasText: name }).last().dblclick()
    await win.locator('.tab.active .dot.connected').waitFor({ timeout: 20000 })
    check(`${name} session connects`, true)
  }
  if (sessions.length === 2) console.log('SKIP  ssh (dev-ssh-server never ran on this machine)')
  // Trust-on-first-use dialog for the RDP certificate would block: accept it automatically.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  await win.locator('.tree-row', { hasText: 'rdp' }).last().dblclick()
  const overlay = await win.waitForSelector('.rdp-overlay.error', { timeout: 60000 })
  const text = await overlay.innerText()
  check('RDP proxy worker + WASM client run', /logon|password|access denied/i.test(text), `(${text.split('\n')[0]})`)
} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
process.exit(results.every(Boolean) ? 0 : 1)
