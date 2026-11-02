// VNC e2e: the real noVNC client in the app against a fake server, one per security type.
//   npm run build && node scripts/e2e-vnc.mjs
import { spawn } from 'child_process'
import { createHash, X509Certificate } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'
import ssh2 from 'ssh2'
import { COLOR, makeCert, startVncServer } from './dev-vnc-server.mjs'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  if (!ok) failed++
}

const tls = makeCert()
const fingerprint = 'SHA256:' + createHash('sha256').update(new X509Certificate(tls.cert).raw).digest('base64').replace(/=+$/, '')

// name → server options, session fields, what must happen
const connecting = [
  { name: 'None', security: 'none' },
  { name: 'VNC password (TightVNC, x11vnc, QEMU)', security: 'vnc', secret: true },
  { name: 'RFB 3.3 (old servers)', security: 'v33', secret: true },
  { name: 'Tight (TightVNC on Windows)', security: 'tight', secret: true },
  { name: 'ARD (macOS Screen Sharing)', security: 'ard', secret: true, user: true },
  { name: 'Apple 003.889 greeting', security: 'apple', secret: true, user: true },
  { name: 'MS-Logon II (UltraVNC)', security: 'mslogon', secret: true, user: true },
  { name: 'VeNCrypt Plain', security: 'plain', secret: true, user: true },
  { name: 'VeNCrypt TLSVnc + VncAuth (TigerVNC)', security: 'tigervnc', secret: true },
  { name: 'X509None', security: 'x509none' },
  { name: 'X509Vnc', security: 'x509vnc', secret: true },
  { name: 'X509Plain (wayvnc)', security: 'x509plain', secret: true, user: true }
]

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-vnc-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
const sessions = []
const secrets = {}
const hosts = {}
const raw = (s) => 'raw:' + Buffer.from(s).toString('base64')
const add = async (name, options, session = {}) => {
  const server = await startVncServer({ tls, ...options })
  const id = `v${sessions.length}`
  sessions.push({ id, name, type: 'vnc', folder: '', host: '127.0.0.1', port: server.port, ...session })
  return { id, name, server }
}

for (const c of connecting) {
  c.conn = await add(c.name, { security: c.security }, c.user ? { username: 'test' } : {})
  if (c.secret) secrets[c.conn.id] = raw('test')
  if (c.security.startsWith('x509')) hosts[`vnc [127.0.0.1]:${c.conn.server.port}`] = fingerprint
}
const wrong = await add('wrong saved password', { security: 'vnc' })
secrets[wrong.id] = raw('nope')
const asks = await add('no saved password', { security: 'ard' })
const giveUp = await add('cancelled prompt', { security: 'vnc' })
const realvnc = await add('realvnc only', { security: 'ra2' })
const anon = await add('anonymous tls only', { security: 'anon' })
const fallback = await add('vencrypt anon plus vnc', { security: 'anon+vnc' })
secrets[fallback.id] = raw('test')
const untrusted = await add('untrusted cert', { security: 'x509none' })
const clip = await add('clipboard', { security: 'none', sendClipboard: 'from the server' })
const quality = await add('picture quality', { security: 'none' }, { vncQuality: 'smooth' })
const pipelined = await add('pipelined', { security: 'none', animate: 'small' })
const noClip = await add('clipboard off', { security: 'none' }, { vncSendClipboard: false })
const view = await add('view only', { security: 'none' }, { vncViewOnly: true })
const resize = await add('resize remote', { security: 'none' }, { vncScale: 'remote' })
const actual = await add('actual size', { security: 'none', width: 3000, height: 2000 }, { vncScale: 'actual' })
const gone = await add('nobody listening', { security: 'none' })
gone.server.close()
const external = await add('external app', { security: 'none' }, { username: 'me@work' })

// Through a saved SSH session (the fake SSH server allows -L).
const SSH_PORT = 2296
const sshd = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', String(SSH_PORT)], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
sessions.push({ id: 'ssh', name: 'gateway', type: 'ssh', folder: '', host: '127.0.0.1', port: SSH_PORT, username: 'test', auth: 'password' })
secrets.ssh = raw('test')
const hostKey = ssh2.utils.parseKey(readFileSync(join(tmpdir(), 'nixi-dev-hostkey')))
hosts[`[127.0.0.1]:${SSH_PORT}`] = 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '')
const tunneled = await add('through ssh', { security: 'none' }, { jumpSessionId: 'ssh' })

json('sessions.json', sessions)
json('secrets.json', secrets)
json('known_hosts.json', hosts)

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master' } })
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForSelector('.tree-row')
  // the client sends the clipboard to the server: keep the developer's own out of the test
  await app.evaluate(({ clipboard }) => clipboard.writeText('e2e'))

  const open = (name) => win.locator('.tree-row', { hasText: name }).first().dblclick()
  /** The canvas of the visible pane, once it shows the server's color. */
  const showsScreen = async (timeout = 15000) => {
    // polled by hand: waitForFunction uses eval, which the app's CSP blocks
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const ok = await win.evaluate(([r, g, b]) => {
        const canvas = [...document.querySelectorAll('.vnc-display canvas')].find((c) => c.getBoundingClientRect().width > 0)
        if (!canvas?.width) return false
        const p = canvas.getContext('2d').getImageData(5, 5, 1, 1).data
        return p[0] === r && p[1] === g && p[2] === b
      }, COLOR)
      if (ok) return true
      await win.waitForTimeout(50)
    }
    return false
  }
  const closeTab = async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'closeTab'))
    await win.waitForTimeout(100)
  }
  const overlay = () => win.waitForSelector('.rdp-overlay.error', { timeout: 15000 }).then((e) => e.innerText())
  const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (fn()) return true
      await win.waitForTimeout(50)
    }
    return fn()
  }

  // Every security type: picture, keyboard and mouse must get through.
  for (const c of connecting) {
    await open(c.name)
    const shown = await showsScreen()
    const canvas = win.locator('.vnc-display canvas').first()
    let input = false
    if (shown) {
      await canvas.click()
      await win.keyboard.press('a')
      input = await until(() => c.conn.server.seen.keys.includes(0x61) && c.conn.server.seen.pointer.length > 0)
    }
    check(`connects: ${c.name}`, shown && input, shown ? `keys=${c.conn.server.seen.keys} clicks=${c.conn.server.seen.pointer.length}` : await win.locator('.rdp-overlay').allInnerTexts())
    if (c.user) check(`  …sent the saved username`, c.conn.server.seen.username === 'test', c.conn.server.seen.username)
    await closeTab()
  }
  check('TigerVNC style: VncAuth inside VeNCrypt', connecting[8].conn.server.seen.chosenType === 19)

  // Wrong saved password → asks again, the right one connects.
  await open(wrong.name)
  await win.waitForSelector('.prompt-hint, .modal input[type=password]')
  const dialogText = await win.locator('.modal').innerText()
  check('wrong password: asks again with a hint', /rejected/i.test(dialogText), dialogText.split('\n').slice(0, 2).join(' | '))
  await win.keyboard.type('test')
  await win.keyboard.press('Enter')
  check('wrong password: the typed one connects', await showsScreen())
  check('wrong password: server saw one failure', wrong.server.seen.authFailures === 1, String(wrong.server.seen.authFailures))
  await closeTab()

  // Nothing saved → asks, no "rejected" hint; ARD needs the username too.
  await open(asks.name)
  await win.waitForSelector('.modal input')
  check('no saved username: asks for it first', /Username/.test(await win.locator('.modal').innerText()))
  await win.keyboard.type('test')
  await win.keyboard.press('Enter')
  await until(() => false, 300)
  check('no saved password: no rejected hint', !/rejected/i.test(await win.locator('.modal').innerText()))
  await win.keyboard.type('test')
  await win.keyboard.press('Enter')
  check('typed username + password connect', await showsScreen())
  await closeTab()

  // Esc on the prompt.
  await open(giveUp.name)
  await win.waitForSelector('.modal input')
  await win.keyboard.press('Escape')
  check('cancelling the prompt ends with Reconnect offered', /Cancelled/.test(await overlay()))
  await closeTab()

  // Errors the user can act on.
  await open(realvnc.name)
  check('RealVNC RA2 only: says what to change', /RealVNC/.test(await overlay()))
  await closeTab()
  await open(anon.name)
  check('anonymous TLS only: says why', /anonymous TLS/.test(await overlay()))
  await closeTab()
  await open(gone.name)
  check('nobody listening: says so', /Could not reach/.test(await overlay()))
  await closeTab()

  // Reconnects over plain VNC when VeNCrypt has nothing usable.
  await open(fallback.name)
  check('VeNCrypt unusable: falls back to the VNC password', await showsScreen())
  await closeTab()

  // Unknown certificate: the user's answer decides.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => {
      globalThis.__askedCert = (globalThis.__askedCert ?? 0) + 1
      return { response: 0 }
    }
  })
  await open(untrusted.name)
  check('refused certificate: does not connect', /not trusted/.test(await overlay()))
  check('…after asking the user', (await app.evaluate(() => globalThis.__askedCert)) === 1)
  await closeTab()

  // Clipboard both ways.
  await app.evaluate(({ clipboard }) => clipboard.writeText('from nixi'))
  await open(clip.name)
  await showsScreen()
  const received = await until(() => false, 900).then(() => app.evaluate(({ clipboard }) => clipboard.readText()))
  check('clipboard: server → computer', received === 'from the server', received)
  await app.evaluate(({ clipboard }) => clipboard.writeText('from nixi'))
  await win.locator('.vnc-display canvas').first().click()
  await win.evaluate(() => document.activeElement?.blur())
  await win.locator('.vnc-display canvas').first().click()
  check('clipboard: computer → server', await until(() => clip.server.seen.clipboard.includes('from nixi')), JSON.stringify(clip.server.seen.clipboard))
  await closeTab()

  // Automatic sending turned off: nothing leaves until the button is pressed.
  await app.evaluate(({ clipboard }) => clipboard.writeText('stay here'))
  await open(noClip.name)
  await showsScreen()
  await win.locator('.vnc-display canvas').first().click()
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await win.waitForTimeout(400)
  check('clipboard off: focus sends nothing', noClip.server.seen.clipboard.length === 0, JSON.stringify(noClip.server.seen.clipboard))
  await win.getByRole('button', { name: 'Send clipboard' }).click()
  check('clipboard off: the button sends it', await until(() => noClip.server.seen.clipboard.includes('stay here')), JSON.stringify(noClip.server.seen.clipboard))
  await closeTab()
  await open(clip.name)
  await showsScreen()
  check('clipboard on: no such button', (await win.getByRole('button', { name: 'Send clipboard' }).count()) === 0)
  await closeTab()

  // View only: nothing goes to the server; the button lifts it.
  await open(view.name)
  await showsScreen()
  await win.locator('.vnc-display canvas').first().click()
  await win.keyboard.press('b')
  await win.waitForTimeout(300)
  check('view only: keys and clicks stay here', view.server.seen.keys.length === 0 && view.server.seen.pointer.length === 0, JSON.stringify(view.server.seen.pointer))
  check('view only: Ctrl+Alt+Del is disabled', await win.getByRole('button', { name: 'Ctrl+Alt+Del' }).isDisabled())
  await win.getByRole('button', { name: 'View only' }).click()
  await win.locator('.vnc-display canvas').first().click()
  await win.keyboard.press('b')
  check('…and the button turns input on', await until(() => view.server.seen.keys.includes(0x62)))
  await win.getByRole('button', { name: 'Ctrl+Alt+Del' }).click()
  check('Ctrl+Alt+Del reaches the server', await until(() => view.server.seen.keys.includes(0xffff) && view.server.seen.keys.includes(0xffe3)), view.server.seen.keys.join(','))
  await closeTab()

  // Picture quality reaches the server while connected; the pointer stays local.
  await open(quality.name)
  await showsScreen()
  const levels = () => quality.server.seen.encodings.filter((e) => (e >= -32 && e <= -23) || (e >= -256 && e <= -247)).join(',')
  check('quality: Smooth from the session settings', levels() === '-29,-255', levels())
  await win.locator('.rdp-toolbar select').nth(1).selectOption('sharp')
  check('quality: toolbar changes it live', await until(() => levels() === '-23,-254'), levels())
  check('pointer: local dot while the server sends none', (await win.evaluate(() => document.querySelector('.vnc-display canvas').style.cursor)).startsWith('url('))
  await closeTab()

  // Extra frame requests stay in flight, so a changing screen isn't capped by the round trip.
  await open(pipelined.name)
  await showsScreen()
  await win.waitForTimeout(1500)
  const before2 = pipelined.server.seen.frames ?? 0
  await win.waitForTimeout(2000)
  const rate = ((pipelined.server.seen.frames ?? 0) - before2) / 2
  check('pipelining: more updates than one per round trip', rate > 20, `${rate} fps through a 30 Hz screen`)
  await win.getByRole('button', { name: 'Stats' }).click()
  await win.waitForTimeout(2200)
  const line = await win.locator('.vnc-stats').innerText()
  check('stats: shows size, rate and encoding', /800×600 · \d+ fps · [\d.]+ MB\/s · decode \d+ ms\/s · Raw/.test(line), line)
  check('stats: counts frames', Number(line.match(/(\d+) fps/)?.[1]) > 15, line)
  await win.getByRole('button', { name: 'Stats' }).click()
  check('stats: the button hides them', (await win.locator('.vnc-stats').count()) === 0)
  await closeTab()

  // Resize remote screen: the server follows the pane.
  await open(resize.name)
  await showsScreen()
  check('resize remote: server gets the pane size', await until(() => resize.server.seen.resizes.length > 0, 5000), JSON.stringify(resize.server.seen.resizes.at(-1)))
  await win.waitForTimeout(500)
  const remoteSize = await win.evaluate(() => {
    const c = document.querySelector('.vnc-display canvas')
    const box = document.querySelector('.rdp-host').getBoundingClientRect()
    return { w: c.width, h: c.height, boxW: Math.floor(box.width), boxH: Math.floor(box.height) }
  })
  check('resize remote: canvas matches the pane', Math.abs(remoteSize.w - remoteSize.boxW) <= 2 && Math.abs(remoteSize.h - remoteSize.boxH) <= 2, JSON.stringify(remoteSize))
  await closeTab()

  // Actual size: 1:1 with scrollbars; Fit then shrinks it into the pane.
  await open(actual.name)
  await showsScreen()
  const sizes = () =>
    win.evaluate(() => {
      const c = document.querySelector('.vnc-display canvas')
      const r = c.getBoundingClientRect()
      const box = document.querySelector('.rdp-host').getBoundingClientRect()
      const screen = c.parentElement
      return { w: Math.round(r.width), h: Math.round(r.height), boxW: box.width, boxH: box.height, scrolls: screen.scrollWidth > screen.clientWidth }
    })
  const big = await sizes()
  check('actual size: 1:1 with scrollbars', big.w === 3000 && big.h === 2000 && big.scrolls, JSON.stringify(big))
  await win.locator('.rdp-toolbar select').first().selectOption('fit')
  await win.waitForTimeout(300)
  const fit = await sizes()
  check('fit: shrinks to the tab, no scrollbars', fit.w <= fit.boxW + 1 && fit.h <= fit.boxH + 1 && !fit.scrolls, JSON.stringify(fit))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-vnc-fit.png') })

  // Moving between tabs and splits keeps the connection.
  const before = actual.server.seen.connections
  await open(clip.name)
  await showsScreen()
  await win.locator('.tab', { hasText: actual.name }).click()
  await win.waitForTimeout(200)
  check('tab switch: screen comes back scaled', (await sizes()).w > 100, JSON.stringify(await sizes()))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'tileAll'))
  await win.waitForTimeout(400)
  const panes = await win.locator('.vnc-display canvas').count()
  const widths = await win.locator('.vnc-display canvas').evaluateAll((list) => list.map((c) => Math.round(c.getBoundingClientRect().width)))
  check('tile: both screens visible in one tab', panes === 2 && widths.every((w) => w > 50), JSON.stringify(widths))
  check('tile: no reconnect', actual.server.seen.connections === before, `${before} → ${actual.server.seen.connections}`)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-vnc-split.png') })
  await closeTab()

  // Through SSH: the fake VNC server only sees the SSH server's connection.
  await open(tunneled.name)
  check('through SSH: connects', await showsScreen(), await win.locator('.rdp-overlay').allInnerTexts())
  await closeTab()

  // Native client: address only, never the password.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      globalThis.__opened = url
    }
  })
  await win.evaluate((id) => window.api.openVncExternal(id), external.id)
  const opened = await app.evaluate(() => globalThis.__opened)
  check('native client gets a vnc:// address', opened === `vnc://me%40work@127.0.0.1:${external.server.port}`, opened)
  const viaSsh = await win.evaluate((id) => window.api.openVncExternal(id).then(() => '', (e) => e.message), tunneled.id)
  check('native client refused for SSH sessions', /SSH/.test(viaSsh), viaSsh)

  // Session dialog offers VNC with its port.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'newSession'))
  await win.locator('.type-picker button', { hasText: 'VNC' }).click()
  const portValue = await win.locator('label.field', { hasText: 'Port' }).locator('input').inputValue()
  check('new session: VNC defaults to port 5900', portValue === '5900', portValue)
  check('new session: can go through SSH', await win.getByText('Connect through SSH').isVisible())
  check('new session: automatic clipboard is on by default', await win.locator('label.inline', { hasText: 'clipboard' }).locator('input').isChecked())
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-vnc-dialog.png') })

  check('no uncaught page errors', errors.length === 0, errors.join(' | '))
} catch (err) {
  check('run finished', false, err.message)
} finally {
  await app.close().catch(() => {})
  sshd.kill()
  rmSync(userData, { recursive: true, force: true })
}
console.log(`Screenshots: ${tmpdir()}/nixi-e2e-vnc-*.png`)
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
