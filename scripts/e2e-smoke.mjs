// End-to-end smoke test: drives the built app against scripts/dev-ssh-server.mjs.
//   npm run build && node scripts/dev-ssh-server.mjs   (in another terminal)
//   node scripts/e2e-smoke.mjs
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { createServer } from 'http'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const ROOT = join(tmpdir(), 'nixi-dev-sftp')
// The dev server's shell is PowerShell on Windows, $SHELL elsewhere.
const isWin = process.platform === 'win32'
const hostKey = ssh2.utils.parseKey(readFileSync(join(tmpdir(), 'nixi-dev-hostkey')))
const fp = 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '')

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
json('known_hosts.json', { '[127.0.0.1]:2222': fp })
json('sessions.json', [
  { id: 's1', name: 'dev-server', type: 'ssh', folder: 'Dev', host: '127.0.0.1', port: 2222, username: 'test', auth: 'password' },
  { id: 's2', name: 'ask-password', type: 'ssh', folder: '', host: '127.0.0.1', port: 2222, username: 'test', auth: 'password' }
])
json('secrets.json', { s1: 'raw:' + Buffer.from('test').toString('base64') })
json('tunnels.json', [
  { id: 't1', name: 'web', sessionId: 's1', type: 'L', bindHost: '127.0.0.1', bindPort: 18080, destHost: '127.0.0.1', destPort: 18999, autoStart: true },
  { id: 't2', name: 'socks', sessionId: 's1', type: 'D', bindHost: '127.0.0.1', bindPort: 11080, autoStart: true }
])
json('settings.json', { warnMultilinePaste: false })

const http = createServer((_q, r) => r.end('tunnel-ok')).listen(18999, '127.0.0.1')
const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Async on purpose: the HTTP target lives in this process, a sync call would deadlock it.
const curl = (...args) =>
  new Promise((r) => execFile(isWin ? 'curl.exe' : 'curl', ['-s', '-m', '5', ...args], { encoding: 'utf8' }, (_e, out) => r(out ?? '')))

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master' } })
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')
  await win.getByText('dev-server', { exact: false }).last().dblclick()
  await win.waitForSelector('.tab .dot.connected', { timeout: 20000 })
  check('SSH session connects', true)

  await win.waitForSelector('.sftp-list td.name:has-text("hello.txt")', { timeout: 10000 })
  check('SFTP panel lists remote files', true)
  check('SFTP tab shown for an SSH tab', (await win.locator('.sidebar-tabs button', { hasText: 'SFTP' }).count()) === 1)

  // Server resource bar under the SSH terminal (dev server runs the stats script via exec).
  await win.waitForSelector('.stats-bar .meter-label:has-text("RAM")', { timeout: 10000 }).catch(() => {})
  const bar = (await win.locator('.stats-bar').count()) ? await win.locator('.stats-bar').innerText() : ''
  check('stats bar shows CPU / RAM / Disk', /CPU/.test(bar) && /RAM/.test(bar) && /Disk/.test(bar), JSON.stringify(bar))
  await win.waitForFunction(() => /\d+%/.test(document.querySelector('.stats-bar .meter')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
  await win.locator('.stats-bar .disks').hover()
  const rows = await win.locator('.stats-popup .disk-table tbody tr').count()
  const popup = await win.locator('.stats-popup').boundingBox().catch(() => null)
  const barTop = (await win.locator('.stats-bar').boundingBox()).y
  check('hovering Disk lists the filesystems above the bar', rows > 0 && popup && popup.y + popup.height <= barTop, `(${rows} rows)`)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-disks.png') })
  await win.mouse.move(5, 5)
  await win.waitForTimeout(200)
  check('table hides when the mouse leaves', (await win.locator('.stats-popup').count()) === 0)
  // Narrow window: the bar drops items instead of overflowing.
  const statsOverflow = () => win.evaluate(() => [...document.querySelectorAll('.stats-bar')].some((e) => e.scrollWidth > e.clientWidth + 1))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 480))
  await win.waitForTimeout(500)
  check('stats bar fits a narrow window', !(await statsOverflow()) && /RAM\s*\d+%/.test(await win.locator('.stats-bar').innerText()), JSON.stringify(await win.locator('.stats-bar').innerText()))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
  await win.waitForTimeout(500)
  check('CPU percentage appears after the second sample', /CPU\s*\d+%/.test(await win.locator('.stats-bar').innerText()))

  await sleep(1500)
  await win.click('.term-container')
  const marker = join(ROOT, 'e2e-marker.txt')
  rmSync(marker, { force: true })
  await win.keyboard.type(isWin ? "'typed-in-terminal' | Out-File e2e-marker.txt\r" : 'echo typed-in-terminal > e2e-marker.tmp && mv e2e-marker.tmp e2e-marker.txt\r')
  for (let i = 0; i < 30 && !existsSync(marker); i++) await sleep(200)
  check('keystrokes reach the remote shell', existsSync(marker))

  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e.png') })

  let viaL = ''
  for (let i = 0; i < 20 && viaL !== 'tunnel-ok'; i++) {
    viaL = await curl('http://127.0.0.1:18080/')
    if (viaL !== 'tunnel-ok') await sleep(300)
  }
  check('local forward (-L) works', viaL === 'tunnel-ok')
  const viaD = await curl('--socks5-hostname', '127.0.0.1:11080', 'http://127.0.0.1:18999/')
  check('dynamic SOCKS (-D) works', viaD === 'tunnel-ok')

  await win.click('button:has-text("Tunnels")')
  await win.waitForSelector('.modal .tunnel-card.running')
  check('tunnel manager shows running tunnels', true)
  const hops = await win.locator('.tunnel-card').first().locator('.tunnel-hop .hop-role').allInnerTexts()
  check('tunnel card draws this computer → SSH server → destination', hops.length === 3 && /ssh server/i.test(hops[1]) && /destination/i.test(hops[2]), JSON.stringify(hops))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-tunnels.png') })
  await win.locator('.tunnel-card').first().locator('button', { hasText: 'Edit' }).click()
  await win.waitForSelector('.tunnel-flow.big')
  check('tunnel editor shows the flow with fields inside', (await win.locator('.tunnel-flow.big .tunnel-hop input').count()) >= 4)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-tunnel-edit.png') })
  await win.locator('.tunnel-types button', { hasText: 'Share a local service' }).click()
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-tunnel-edit-r.png') })
  await win.getByRole('button', { name: 'Back', exact: true }).click()
  await win.keyboard.press('Escape')

  // Session without a saved password and no ssh-agent: must prompt, not crash.
  await win.click('.sidebar-tabs button:has-text("Sessions")')
  await win.getByText('ask-password').last().dblclick()
  const pw = await win.waitForSelector('.modal input[type=password]', { timeout: 15000 })
  check('asks for password when none is saved', true)
  await pw.fill('test')
  await pw.press('Enter')
  await win.locator('.tab .dot.connected').nth(1).waitFor({ timeout: 15000 })
  check('connects with the prompted password', true)} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  await app.close()
  http.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${tmpdir()}`)
process.exit(failed ? 1 : 0)
