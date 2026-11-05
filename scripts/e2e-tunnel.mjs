// Tunnels: Stop really stops and the card says so (with a connection open, while still connecting,
// clicking fast), the server picker (saved session or typed by hand), the redesigned card and editor.
// Starts its own scripts/dev-ssh-server.mjs (ports 2289, 2290 with a slow login, 2288 killed and restarted).
//   npm run build && node scripts/e2e-tunnel.mjs
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-tunnel-'))
const shot = process.argv[2] ?? 'nixi-tunnel'
const servers = [
  spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', '2289'], { stdio: 'ignore' }),
  spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', '2290', '--auth-delay', '1500'], { stdio: 'ignore' })
]
const listening = (port) =>
  new Promise((r) => {
    const s = connect(port, '127.0.0.1')
    s.once('connect', () => (s.destroy(), r(true)))
    s.once('error', () => r(false))
  })
// Goes away and comes back during the test, once with another password.
let flaky
const startFlaky = async (password = 'test') => {
  flaky = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', '2288', '--password', password], { stdio: 'ignore' })
  for (let i = 0; i < 50 && !(await listening(2288)); i++) await sleep(100)
}
const stopFlaky = async () => {
  flaky.kill('SIGKILL')
  for (let i = 0; i < 50 && (await listening(2288)); i++) await sleep(100)
}
const keyFile = join(tmpdir(), 'nixi-dev-hostkey')
for (let i = 0; i < 50 && !existsSync(keyFile); i++) await sleep(100)
await sleep(500)
const hostKey = ssh2.utils.parseKey(readFileSync(keyFile))
const fp = 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '')
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
json('known_hosts.json', { '[127.0.0.1]:2289': fp, '[127.0.0.1]:2290': fp, '[localhost]:2289': fp, '[localhost]:2290': fp, '[127.0.0.1]:2288': fp })
json('sessions.json', [
  { id: 's', name: 'fast-server', type: 'ssh', folder: '', host: '127.0.0.1', port: 2289, username: 'test', auth: 'password' },
  { id: 'slow', name: 'slow-server', type: 'ssh', folder: '', host: '127.0.0.1', port: 2290, username: 'test', auth: 'password' },
  { id: 'fl', name: 'flaky-server', type: 'ssh', folder: '', host: '127.0.0.1', port: 2288, username: 'test', auth: 'password' }
])
json('secrets.json', { s: 'raw:' + Buffer.from('test').toString('base64'), slow: 'raw:' + Buffer.from('test').toString('base64'), fl: 'raw:' + Buffer.from('test').toString('base64') })
json('tunnels.json', [
  { id: 'a', name: 'busy', type: 'L', sessionId: 's', bindHost: '127.0.0.1', bindPort: 18101, destHost: '127.0.0.1', destPort: 18100, autoStart: false },
  { id: 'b', name: 'slow', type: 'L', sessionId: 'slow', bindHost: '127.0.0.1', bindPort: 18102, destHost: '127.0.0.1', destPort: 18100, autoStart: false },
  { id: 'c', name: 'flaky', type: 'L', sessionId: 'fl', bindHost: '127.0.0.1', bindPort: 18105, destHost: '127.0.0.1', destPort: 18100, autoStart: false },
  { id: 'r', name: 'reverse', type: 'R', sessionId: 'fl', bindHost: '127.0.0.1', bindPort: 18106, destHost: '127.0.0.1', destPort: 18100, autoStart: false }
])

// A service that holds every connection open, so a tunnel has live sockets when it is stopped.
const held = new Set()
const echo = createServer((s) => {
  held.add(s)
  s.on('data', (d) => s.write(d))
  s.on('error', () => {})
}).listen(18100, '127.0.0.1')

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : extra}`)
}
const openThrough = (port) =>
  new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1')
    s.once('error', reject)
    s.once('data', () => resolve(s))
    s.once('connect', () => s.write('hi'))
  })

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' } })
try {
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 760))
  await win.waitForSelector('.tree-row')
  await win.click('button:has-text("Tunnels")')
  await win.waitForSelector('.tunnel-card')

  const card = (name) => win.locator('.tunnel-card', { hasText: name }).first()
  const stateOf = async (name) => {
    const c = card(name)
    const cls = await c.getAttribute('class')
    return { running: / running/.test(cls), starting: / starting/.test(cls), stopBtn: (await c.locator('button', { hasText: 'Stop' }).count()) > 0, startBtn: (await c.locator('button', { hasText: 'Start' }).count()) > 0 }
  }
  const showsStopped = (s) => !s.running && !s.starting && !s.stopBtn && s.startBtn
  const waitRunning = async (name) => {
    for (let i = 0; i < 60 && !(await stateOf(name)).running; i++) await sleep(100)
    return (await stateOf(name)).running
  }

  // Stop with a connection open: closing its sockets must not bring the card back.
  await card('busy').locator('button', { hasText: 'Start' }).click()
  check('tunnel starts', await waitRunning('busy'))
  const through = await openThrough(18101)
  through.on('error', () => {})
  await sleep(300)
  check('card counts the open connection', /1 conn/.test(await card('busy').innerText()), await card('busy').innerText())
  await win.screenshot({ path: join(tmpdir(), `${shot}-running.png`) })
  await card('busy').locator('button', { hasText: 'Stop' }).click()
  await sleep(800)
  let st = await stateOf('busy')
  check('Stop with a connection open: card shows stopped', showsStopped(st), JSON.stringify(st))
  check('Stop with a connection open: port is closed', !(await listening(18101)))
  await win.screenshot({ path: join(tmpdir(), `${shot}-stopped.png`) })

  // Stop while still logging in: the login that finishes later must not start the tunnel.
  await card('slow').locator('button', { hasText: 'Start' }).click()
  await sleep(200)
  await card('slow').locator('button', { hasText: 'Stop' }).click()
  await sleep(3000)
  st = await stateOf('slow')
  check('Stop while connecting: card shows stopped', showsStopped(st), JSON.stringify(st))
  check('Stop while connecting: nothing listens', !(await listening(18102)))

  // Fast clicks: whatever the last click was, the card and the port agree.
  const toggle = () => card('busy').locator('.tunnel-card-head button').first().click()
  for (let i = 0; i < 7; i++) {
    await toggle()
    await sleep(30)
  }
  await sleep(2500)
  st = await stateOf('busy')
  let open = await listening(18101)
  check('fast clicks (odd): card and port agree', st.running === open && st.stopBtn === open && st.startBtn === !open, JSON.stringify({ st, open }))
  check('fast clicks (odd): ends running', open)
  for (let i = 0; i < 6; i++) {
    await toggle()
    await sleep(15)
  }
  await sleep(2500)
  st = await stateOf('busy')
  open = await listening(18101)
  check('fast clicks (even): card and port agree', st.running === open && st.stopBtn === open && st.startBtn === !open, JSON.stringify({ st, open }))
  if (open) await toggle()
  await sleep(300)

  // The server goes away for longer than one try, as in a reboot.
  await startFlaky()
  await card('flaky').locator('button', { hasText: 'Start' }).click()
  check('reconnect: starts', await waitRunning('flaky'))
  await stopFlaky()
  await sleep(1000)
  st = await stateOf('flaky')
  check('reconnect: says so and can be stopped', /Reconnecting/.test(await card('flaky').innerText()) && st.stopBtn && !st.startBtn, await card('flaky').innerText())
  await win.screenshot({ path: join(tmpdir(), `${shot}-reconnecting.png`) })
  await sleep(8000)
  st = await stateOf('flaky')
  check('reconnect: still trying after several failed tries', /Reconnecting/.test(await card('flaky').innerText()) && st.stopBtn, await card('flaky').innerText())
  await startFlaky()
  check('reconnect: comes back with the server', await waitRunning('flaky'))
  check('reconnect: error line is gone', !/Connection lost/.test(await card('flaky').innerText()))
  const back = await openThrough(18105).catch(() => null)
  check('reconnect: traffic flows again', !!back)
  await sleep(200)
  check('reconnect: counts connections from zero', /1 connection/.test(await card('flaky').innerText()), await card('flaky').innerText())
  back?.destroy()

  // Stop during the wait: no try after that.
  await stopFlaky()
  await sleep(500)
  await card('flaky').locator('button', { hasText: 'Stop' }).click()
  await startFlaky()
  await sleep(4500)
  st = await stateOf('flaky')
  check('Stop while reconnecting: stays stopped', showsStopped(st) && !(await listening(18105)), JSON.stringify(st))

  // The server is back but refuses the password: repeating that would only lock the account.
  await card('flaky').locator('button', { hasText: 'Start' }).click()
  await waitRunning('flaky')
  await stopFlaky()
  await startFlaky('changed')
  for (let i = 0; i < 80 && !/ error/.test(await card('flaky').getAttribute('class')); i++) await sleep(100)
  st = await stateOf('flaky')
  check('reconnect: a refused login ends it', /Failed/.test(await card('flaky').innerText()) && st.startBtn, await card('flaky').innerText())
  await stopFlaky()
  await startFlaky()
  await sleep(4000)
  check('reconnect: no more tries after that', !(await stateOf('flaky')).running && !(await listening(18105)))

  // The setting that turns reconnecting off everywhere.
  await card('flaky').locator('button', { hasText: 'Start' }).click()
  await waitRunning('flaky')
  await win.evaluate(() => window.api.getSettings().then((s) => window.api.setSettings({ ...s, autoReconnect: false })))
  await stopFlaky()
  await sleep(600)
  check('setting off: fails at once', /Failed/.test(await card('flaky').innerText()), await card('flaky').innerText())
  await startFlaky()
  await sleep(4000)
  check('setting off: no tries', !(await stateOf('flaky')).running)
  await win.evaluate(() => window.api.getSettings().then((s) => window.api.setSettings({ ...s, autoReconnect: true })))
  await stopFlaky()

  // -R listens on the server, so coming back means asking for that port again.
  await startFlaky()
  await card('reverse').locator('button', { hasText: 'Start' }).click()
  check('-R: starts', await waitRunning('reverse'))
  const rev = await openThrough(18106).catch(() => null)
  check('-R: traffic comes back through it', !!rev)
  rev?.destroy()
  await stopFlaky()
  await sleep(500)
  await startFlaky()
  check('-R: reconnects with the server', await waitRunning('reverse'))
  const rev2 = await openThrough(18106).catch(() => null)
  check('-R: traffic flows again', !!rev2)
  rev2?.destroy()
  await card('reverse').locator('button', { hasText: 'Stop' }).click()
  await sleep(300)
  check('-R: Stop closes the port on the server', !(await listening(18106)))
  await stopFlaky()

  // The server picker: the arrow lists saved sessions, typing narrows them, and anything else stays typed.
  await win.click('.modal button:has-text("New tunnel")')
  await win.waitForSelector('.tunnel-path')
  const input = win.locator('.server-input')
  const options = win.locator('.combo-list button')
  check('new tunnel starts on a saved session', (await input.inputValue()) === 'fast-server', await input.inputValue())
  await win.click('.combo-arrow')
  check('the arrow lists every saved session', (await options.count()) === 3 && /test@127\.0\.0\.1:2290/.test(await options.nth(1).innerText()), await options.count())
  await win.screenshot({ path: join(tmpdir(), `${shot}-picker.png`) })
  const box = await win.locator('.combo-list').boundingBox()
  const view = await win.evaluate(() => innerHeight)
  check('the list stays on screen', box.y >= 0 && box.y + box.height <= view, JSON.stringify(box))
  await options.nth(1).click()
  check('clicking one picks it', (await input.inputValue()) === 'slow-server' && (await options.count()) === 0)
  check('a saved session shows its address, no password box', /test@127\.0\.0\.1:2290/.test(await win.locator('.stop-note.mono').innerText()) && (await win.locator('.server-password').count()) === 0)

  await input.fill('fast')
  check('typing narrows the list', (await options.count()) === 1)
  await input.press('Enter')
  check('Enter picks from the list', (await input.inputValue()) === 'fast-server')
  await input.fill('slo')
  await input.press('Escape')
  check('Esc closes the list, not the dialog', (await options.count()) === 0 && (await win.locator('.tunnel-path').count()) === 1)

  await input.fill('two words')
  check('text that is no address says so', (await win.locator('.stop-note.warn').count()) === 1)
  await win.click('.modal button:has-text("Save tunnel")')
  await sleep(200)
  check('it cannot be saved', (await win.locator('.tunnel-path').count()) === 1)

  await input.fill('test@localhost:2289')
  check('a typed server asks for a password', (await win.locator('.server-password').count()) === 1)
  await win.locator('.server-password').fill('test')
  await win.locator('input[aria-label="Listen port"]').fill('18103')
  await win.locator('input[aria-label="Destination host"]').fill('127.0.0.1')
  await win.locator('input[aria-label="Destination port"]').fill('18100')
  await win.locator('.modal label.field input').fill('typed')
  await win.screenshot({ path: join(tmpdir(), `${shot}-typed.png`) })
  await win.click('.modal button:has-text("Save tunnel")')
  await card('typed').waitFor()
  check('card shows the typed server', /test@localhost:2289/.test(await card('typed').locator('.tunnel-route').innerText()))
  const list = await win.evaluate(() => window.api.listTunnels())
  const typed = list.tunnels.find((t) => t.name === 'typed')
  check('the password is saved in main only', typed.hasSecret === true && !typed.sessionId && !JSON.stringify({ ...typed, server: { ...typed.server, username: '' } }).includes('"test"'), JSON.stringify(typed))

  await card('typed').locator('button', { hasText: 'Start' }).click()
  check('a typed server connects', await waitRunning('typed'))
  const viaTyped = await openThrough(18103)
  check('traffic goes through it', !!viaTyped)
  viaTyped.destroy()

  // Editing while it runs must not leave the old settings running under the new card.
  await card('typed').locator('button', { hasText: 'Edit' }).click()
  await win.waitForSelector('.tunnel-path')
  check('the saved password is not shown again', (await win.locator('.server-password').inputValue()) === '' && /saved/i.test(await win.locator('.server-password').getAttribute('placeholder')))
  await win.locator('input[aria-label="Listen port"]').fill('18104')
  check('the button says it will restart', (await win.locator('.modal button:has-text("Save and restart")').count()) === 1)
  await win.click('.modal button:has-text("Save and restart")')
  await card('typed').waitFor()
  await sleep(300)
  check('Save and restart: the new port', await waitRunning('typed') && (await listening(18104)))
  check('Save and restart: the old port is gone', !(await listening(18103)))
  await card('typed').locator('button', { hasText: 'Stop' }).click()
  await sleep(300)

  // The password belongs to that server: it must not follow the tunnel somewhere else.
  await card('typed').locator('button', { hasText: 'Edit' }).click()
  await win.waitForSelector('.tunnel-path')
  await input.fill('test@localhost:2290')
  check('another server: password box is empty again', !/saved/i.test(await win.locator('.server-password').getAttribute('placeholder')))
  await win.click('.modal button:has-text("Save tunnel")')
  await card('typed').waitFor()
  const moved = (await win.evaluate(() => window.api.listTunnels())).tunnels.find((t) => t.name === 'typed')
  check('another server: the saved password is forgotten', moved.hasSecret === false, JSON.stringify(moved))

  // A wrong password ends as a failed card that can be started again.
  await card('typed').locator('button', { hasText: 'Edit' }).click()
  await win.waitForSelector('.tunnel-path')
  await input.fill('test@localhost:2289')
  await win.locator('.server-password').fill('wrong')
  await win.click('.modal button:has-text("Save tunnel")')
  await card('typed').waitFor()
  await card('typed').locator('button', { hasText: 'Start' }).click()
  for (let i = 0; i < 80 && !/ error/.test(await card('typed').getAttribute('class')); i++) await sleep(100)
  st = await stateOf('typed')
  check('wrong password: Failed, with Start back', /Failed/.test(await card('typed').innerText()) && st.startBtn && !st.stopBtn, await card('typed').innerText())
  await win.screenshot({ path: join(tmpdir(), `${shot}-list.png`) })

  // Deleting a tunnel takes its password along.
  const id = moved.id
  await card('typed').locator('button.square').click()
  await win.locator('.modal-footer button', { hasText: 'Delete' }).click()
  await sleep(200)
  await win.evaluate(async (t) => { await window.api.saveTunnels([...(await window.api.listTunnels()).tunnels, t]) }, { ...moved, id, name: 'again', hasSecret: undefined })
  const again = (await win.evaluate(() => window.api.listTunnels())).tunnels.find((t) => t.name === 'again')
  check('deleting forgets the password', again.hasSecret === false, JSON.stringify(again))

  // The other two kinds, and a narrow window.
  await win.click('.modal button:has-text("New tunnel")')
  await win.waitForSelector('.tunnel-path')
  await win.locator('.tunnel-kind button', { hasText: 'Share a local service' }).click()
  await win.screenshot({ path: join(tmpdir(), `${shot}-edit-r.png`) })
  const rLabels = await win.locator('.stop-label').allInnerTexts()
  check('-R starts at the server', /SSH server/.test(rLabels[0]) && /Destination/.test(rLabels[2]), JSON.stringify(rLabels))
  await win.locator('.tunnel-kind button', { hasText: 'SOCKS proxy' }).click()
  check('-D has no destination to fill in', (await win.locator('input[aria-label="Destination host"]').count()) === 0)
  await win.screenshot({ path: join(tmpdir(), `${shot}-edit-d.png`) })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 520))
  await sleep(300)
  const fits = await win.evaluate(() => {
    const body = document.querySelector('.modal-body')
    return { overflow: body.scrollWidth <= body.clientWidth + 1, bottom: document.querySelector('.modal').getBoundingClientRect().bottom <= innerHeight }
  })
  check('editor fits a small window', fits.overflow && fits.bottom, JSON.stringify(fits))
  await win.screenshot({ path: join(tmpdir(), `${shot}-narrow.png`) })
  await win.click('.modal button:has-text("Back")')
  await sleep(200)
  const noOverflow = await win.evaluate(() => [...document.querySelectorAll('.tunnel-card')].every((c) => c.scrollWidth <= c.clientWidth + 1))
  check('cards fit a small window', noOverflow)
  await win.screenshot({ path: join(tmpdir(), `${shot}-narrow-list.png`) })
} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  await app.close().catch(() => {})
  servers.forEach((s) => s.kill())
  flaky?.kill('SIGKILL')
  echo.close()
  held.forEach((s) => s.destroy())
  rmSync(userData, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
