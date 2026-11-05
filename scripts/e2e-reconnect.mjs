// Auto reconnect: a dropped SSH / Telnet / VNC / RDP connection comes back by itself, an `exit` or
// a logoff does not, Esc / Stop and the setting turn it off, nothing asks for a password it has.
// Starts its own servers (SSH 2292, VNC 5992, Telnet on a free port); RDP is a stand-in element.
//   npm run build && node scripts/e2e-reconnect.mjs
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { connect, createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-reconnect-'))
const SSH = 2292
const VNC = 5992
const listening = async (port, up = true) => {
  for (let i = 0; i < 100; i++) {
    const open = await new Promise((r) => {
      const s = connect(port, '127.0.0.1')
      s.once('connect', () => (s.destroy(), r(true)))
      s.once('error', () => r(false))
    })
    if (open === up) return
    await sleep(100)
  }
  throw new Error(`port ${port} never ${up ? 'opened' : 'closed'}`)
}
const start = async (script, port, args = []) => {
  const proc = spawn(process.execPath, [script, '--port', String(port), ...args], { stdio: 'ignore' })
  await listening(port)
  return proc
}
const stop = async (proc, port) => {
  proc.kill('SIGKILL')
  await listening(port, false)
}
let sshd = await start('scripts/dev-ssh-server.mjs', SSH)
let vncd = await start('scripts/dev-vnc-server.mjs', VNC, ['--security', 'none'])

// Telnet: `exit` closes the socket politely, destroy() is the drop.
const telnetSocks = new Set()
let telnetConnects = 0
const telnet = createServer((sock) => {
  telnetConnects++
  telnetSocks.add(sock)
  sock.on('close', () => telnetSocks.delete(sock))
  sock.on('error', () => {})
  sock.write('box$ ')
  let line = ''
  sock.on('data', (d) => {
    for (const b of d) {
      if (b === 255) return
      if (b === 13) {
        if (line === 'exit') return void sock.end()
        sock.write(`\r\nbox$ `)
        line = ''
      } else if (b !== 10 && b !== 0) {
        line += String.fromCharCode(b)
        sock.write(Buffer.from([b]))
      }
    }
  })
})
await new Promise((r) => telnet.listen(0, '127.0.0.1', r))

for (let i = 0; i < 50 && !existsSync(join(tmpdir(), 'nixi-dev-hostkey')); i++) await sleep(100)
const hostKey = ssh2.utils.parseKey(readFileSync(join(tmpdir(), 'nixi-dev-hostkey')))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
const raw = (s) => 'raw:' + Buffer.from(s).toString('base64')
json('known_hosts.json', { [`[127.0.0.1]:${SSH}`]: 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '') })
const ssh = { type: 'ssh', folder: '', host: '127.0.0.1', port: SSH, username: 'test', auth: 'password' }
json('sessions.json', [
  { id: 's1', name: 'saved-pw', ...ssh },
  { id: 's2', name: 'typed-pw', ...ssh },
  { id: 'l', name: 'shell', type: 'local', folder: '' },
  { id: 't', name: 'tel', type: 'telnet', folder: '', host: '127.0.0.1', port: telnet.address().port },
  { id: 'v', name: 'screen', type: 'vnc', folder: '', host: '127.0.0.1', port: VNC },
  { id: 'r', name: 'desk', type: 'rdp', folder: '', host: '127.0.0.1', port: 3389, username: 'alice' }
])
json('secrets.json', { s1: raw('test'), r: raw('good') })
// The DOM renderer lets the test read the screen.
json('settings.json', { gpuRendering: false, sftpAutoOpen: false })

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : extra}`)
}

/** A stand-in for IronRDP, installed before the RDP code loads: the test ends the session. */
function installFakeRdp() {
  const define = customElements.define.bind(customElements)
  customElements.define = (name, cls, opts) => (name === 'iron-remote-desktop' ? undefined : define(name, cls, opts))
  window.rdpTries = 0
  const ui = () => ({
    configBuilder: () => {
      const builder = new Proxy({}, { get: (_t, key) => () => (key === 'build' ? {} : builder) })
      return builder
    },
    connect: async () => {
      window.rdpTries++
      if (window.rdpDown) throw { kind: () => 5, backtrace: () => 'stand-in' }
      return { run: () => new Promise((resolve) => (window.rdpEnd = (reason) => resolve({ reason: () => reason }))) }
    },
    setEnableClipboard() {},
    setEnableAutoClipboard() {},
    onWarningCallback() {},
    setVisibility() {},
    shutdown() {},
    resize() {}
  })
  define('iron-remote-desktop', class extends HTMLElement {
    connectedCallback() {
      setTimeout(() => this.dispatchEvent(new CustomEvent('ready', { detail: { irgUserInteraction: ui() } })))
    }
  })
}

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' } })
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')
  await win.evaluate(installFakeRdp)
  const text = () =>
    win.evaluate(() => [...document.querySelectorAll('.xterm-rows')].find((e) => e.getBoundingClientRect().width > 0)?.innerText ?? '')
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) return false
      await sleep(150)
    }
  }
  const sees = (re, ms) => until(async () => re.test(await text()), ms)
  const open = (name) => win.locator('.tree-row', { hasText: new RegExp(`^${name}`) }).last().dblclick()
  const up = () => win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 }).then(() => true, () => false)
  const dialogUp = () => win.locator('.modal').count().then((n) => n > 0)
  const type = async (s) => {
    await win.locator('.tab-view:visible .term-container').first().click()
    await win.keyboard.type(s)
  }
  const closeTab = async () => {
    await win.locator('.tab.active .tab-close').click()
    await sleep(200)
  }

  console.log('--- SSH')
  await open('saved-pw')
  check('connects', await up())
  await sleep(500)
  await stop(sshd, SSH)
  check('drop: says so and counts down', await sees(/Connection lost[\s\S]*Reconnecting in \d+s, try 1\b/), await text())
  check('…the countdown stays on one line', ((await text()).match(/Reconnecting in/g) ?? []).length === 1, await text())
  check('…a second try after the first fails', await sees(/try 2\b/, 8000), await text())
  check('…no dialog', !(await dialogUp()))
  sshd = await start('scripts/dev-ssh-server.mjs', SSH)
  check('server back: reconnects by itself', await sees(/Reconnected/, 15000), await text())
  check('…connected', await up())
  await sleep(500)
  await type('echo mark-$((40+2))\r')
  check('…and the new shell works', await sees(/mark-42/, 5000), await text())
  await type('exit\r')
  check('`exit`: closed, no retrying', await sees(/Session closed[\s\S]*Press R/, 8000), await text())
  await sleep(2500)
  check('…still no countdown', !/Reconnecting in/.test((await text()).split('Session closed').pop()), await text())
  await win.keyboard.press('r')
  check('…R reconnects', await up())
  await sleep(300)

  // The shell timing out (bash TMOUT) reports an exit code. The notice must land under the last
  // output, wherever the cursor was last saved: leaving an alternate screen that isn't open
  // restores that saved cursor.
  const idleOut = async (name, before) => {
    await type(`clear; ${before}echo ${name}-a; echo ${name}-b; echo ${name}-c\r`)
    check(`${name}: output is there`, await sees(new RegExp(`\\n${name}-c`), 5000), await text())
    await type('exec bash --norc --noprofile\r')
    await sleep(500)
    await type('TMOUT=1\r')
    check(`${name}: idle logout closes, no retrying`, await sees(/Session closed[\s\S]*Press R/, 8000), await text())
    const screen = await text()
    check(`${name}: nothing overwritten`, [`${name}-a`, `${name}-b`, `${name}-c`].every((l) => screen.includes(l)), screen)
    check(`${name}: the notice is under the last output`, screen.lastIndexOf('Session closed') > screen.lastIndexOf(`${name}-c`), screen)
    await win.keyboard.press('r')
    await up()
    await sleep(500)
  }
  await idleOut('nosave', '')
  await idleOut('saved', "printf '\\033''7'; ")

  await stop(sshd, SSH)
  check('Esc: stops the loop', await sees(/Reconnecting in/))
  await win.keyboard.press('Escape')
  check('…and says so', await sees(/Stopped reconnecting/, 3000), await text())
  sshd = await start('scripts/dev-ssh-server.mjs', SSH)
  await sleep(5000)
  check('…no more tries once the server is back', (await win.locator('.tab.active .dot.connected').count()) === 0)
  await win.keyboard.press('r')
  check('…R still works', await up())
  await sleep(300)

  await stop(sshd, SSH)
  await sees(/Reconnecting in/)
  sshd = await start('scripts/dev-ssh-server.mjs', SSH)
  await win.keyboard.press('r')
  check('R during the pause: tries now', await sees(/Reconnected/, 8000), await text())
  await closeTab()

  await stop(sshd, SSH)
  sshd = await start('scripts/dev-ssh-server.mjs', SSH)
  await open('typed-pw')
  await win.locator('.modal input[type=password]').waitFor({ timeout: 8000 })
  await win.locator('.modal input[type=password]').fill('test')
  await win.keyboard.press('Enter')
  check('password typed, not saved: connects', await up())
  await sleep(500)
  await stop(sshd, SSH)
  await sees(/Reconnecting in/)
  sshd = await start('scripts/dev-ssh-server.mjs', SSH)
  check('…comes back without asking again', await sees(/Reconnected/, 15000), await text())
  check('…no dialog', !(await dialogUp()))
  await sleep(300)
  await stop(sshd, SSH)
  await sees(/Reconnecting in/)
  sshd = await start('scripts/dev-ssh-server.mjs', SSH, ['--password', 'changed'])
  const asked = await until(() => dialogUp(), 15000)
  check('password changed meanwhile: asks once, and stops counting', asked && !/Reconnecting in \d+s/.test((await text()).split('\n').pop()), await text())
  await win.keyboard.press('Escape')
  check('…cancel: stays closed, R to retry', await sees(/Press R/, 5000), await text())
  await closeTab()
  await stop(sshd, SSH)
  sshd = await start('scripts/dev-ssh-server.mjs', SSH)

  console.log('--- a tab in the background')
  await open('saved-pw')
  await up()
  await sleep(500)
  await open('shell')
  await up()
  await sleep(300)
  await stop(sshd, SSH)
  sshd = await start('scripts/dev-ssh-server.mjs', SSH)
  await sleep(4000)
  const front = await win.locator('.tab.active').innerText()
  check('it reconnects without taking the front', /shell/.test(front), front)
  await win.locator('.tab', { hasText: 'saved-pw' }).click()
  check('…and it did reconnect', await sees(/Reconnected/, 12000), await text())
  await closeTab()

  console.log('--- local shell')
  await win.locator('.tab', { hasText: 'shell' }).click()
  await sleep(200)
  await type('kill -9 $$\r')
  check('a local shell that dies is not reconnected', await sees(/Session closed[\s\S]*Press R/, 5000), await text())
  await closeTab()

  console.log('--- Telnet')
  await open('tel')
  check('connects', await up())
  await sees(/box\$/, 5000)
  for (const s of telnetSocks) s.destroy()
  check('drop: counts down', await sees(/Reconnecting in/, 5000), await text())
  check('…reconnects', await sees(/Reconnected/, 8000), await text())
  await sleep(300)
  await type('exit\r')
  check('`exit`: closed, no retrying', await sees(/Session closed[\s\S]*Press R/, 5000), await text())
  const before = telnetConnects
  await sleep(3500)
  check('…no new connection', telnetConnects === before, `${before} → ${telnetConnects}`)
  await closeTab()

  console.log('--- VNC')
  const overlay = () => win.locator('.rdp-overlay.error').innerText({ timeout: 300 }).catch(() => '')
  const vncUp = () => until(async () => (await win.locator('.tab.active .dot.connected').count()) > 0 && !(await overlay()), 15000)
  await open('screen')
  check('connects', await vncUp())
  await stop(vncd, VNC)
  check('drop: counts down', await until(async () => /Reconnecting in \d+s, try 1/.test(await overlay()), 8000), await overlay())
  check('…has Now and Stop', (await win.locator('.rdp-overlay.error button', { hasText: 'Now' }).count()) === 1 && (await win.locator('.rdp-overlay.error button', { hasText: 'Stop' }).count()) === 1)
  check('…a second try after the first fails', await until(async () => /try 2/.test(await overlay()), 10000), await overlay())
  vncd = await start('scripts/dev-vnc-server.mjs', VNC, ['--security', 'none'])
  check('server back: reconnects by itself', await vncUp())
  await stop(vncd, VNC)
  await until(async () => /Reconnecting in/.test(await overlay()), 8000)
  await win.locator('.rdp-overlay.error button', { hasText: 'Stop' }).click()
  await sleep(200)
  const stopped = await overlay()
  check('Stop: back to a plain Reconnect', /connection was lost/.test(stopped) && !/Reconnecting in/.test(stopped) && /Reconnect/.test(stopped), stopped)
  vncd = await start('scripts/dev-vnc-server.mjs', VNC, ['--security', 'none'])
  await sleep(3000)
  check('…no more tries', /connection was lost/.test(await overlay()), await overlay())
  await win.locator('.rdp-overlay.error button', { hasText: 'Reconnect' }).click()
  check('…Reconnect still works', await vncUp())
  await closeTab()

  console.log('--- RDP (stand-in)')
  await open('desk')
  check('connects', await until(() => win.evaluate(() => Boolean(window.rdpEnd)), 8000))
  await win.evaluate(() => {
    window.rdpDown = true
    window.rdpEnd('connection reset by peer')
  })
  check('drop: counts down', await until(async () => /Reconnecting in \d+s, try 1/.test(await overlay()), 5000), await overlay())
  check('…retries while the server is away', await until(async () => /try 2/.test(await overlay()), 8000), await overlay())
  await win.evaluate(() => {
    window.rdpEnd = undefined
    window.rdpDown = false
  })
  check('…reconnects', await until(() => win.evaluate(() => Boolean(window.rdpEnd)), 10000))
  const tries = await win.evaluate(() => window.rdpTries)
  await win.evaluate(() => window.rdpEnd('The user logged off'))
  await sleep(3000)
  check('logoff: no retrying', /logged off/.test(await overlay()) && (await win.evaluate(() => window.rdpTries)) === tries, await overlay())
  await closeTab()

  console.log('--- the setting')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'settings'))
  await win.locator('.settings-nav button', { hasText: 'Connections' }).click()
  const box = win.locator('.modal label.check', { hasText: 'Reconnect by itself' }).locator('input')
  check('on by default', await box.isChecked())
  await box.uncheck()
  await win.locator('.modal-footer button.primary').click()
  await sleep(300)
  await open('saved-pw')
  check('connects', await up())
  await sleep(500)
  await stop(sshd, SSH)
  check('off: the old message, no countdown', await sees(/Session closed[\s\S]*Press R/, 5000), await text())
  await sleep(2500)
  check('…no tries', !/Reconnecting/.test(await text()), await text())
} finally {
  await app.close()
  sshd.kill('SIGKILL')
  vncd.kill('SIGKILL')
  telnet.close()
  for (const s of telnetSocks) s.destroy()
  rmSync(userData, { recursive: true, force: true })
}
console.log(failed ? `${failed} FAILED` : 'All reconnect checks passed')
process.exit(failed ? 1 : 0)
