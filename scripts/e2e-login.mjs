// Login dialogs of every kind of session: username + password in one dialog, a rejected login asks
// again, Save stores it only after the server accepted it, unticked stays in memory only.
// SSH and VNC use the fake servers. RDP has no fake server: the first run swaps <iron-remote-desktop>
// for a stand-in that accepts alice/good, the second uses the real one up to the TCP connection.
//   npm run build && node scripts/e2e-login.mjs
import { execFileSync, spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'
import ssh2 from 'ssh2'
import { startVncServer } from './dev-vnc-server.mjs'
import { readDb } from './read-db.mjs'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  if (!ok) failed++
}

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-login-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
const raw = (s) => 'raw:' + Buffer.from(s).toString('base64')

const keygen = (file, passphrase) => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-f', file])
  return file
}
const goodKey = keygen(join(userData, 'good_key'), 'open-sesame')
const otherKey = keygen(join(userData, 'other_key'), '')

const SSH_PORT = 2295
const sshd = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', String(SSH_PORT), '--authorized-key', `${goodKey}.pub`], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const hostKey = ssh2.utils.parseKey(readFileSync(join(tmpdir(), 'nixi-dev-hostkey')))
const hosts = { [`[127.0.0.1]:${SSH_PORT}`]: 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '') }

const sessions = []
const secrets = {}
const add = (name, fields, secret) => {
  sessions.push({ id: name, name, folder: '', host: '127.0.0.1', ...fields })
  if (secret) secrets[name] = raw(secret)
}
const ssh = (name, fields, secret) => add(name, { type: 'ssh', port: SSH_PORT, ...fields }, secret)
const rdp = (name, fields, secret) => add(name, { type: 'rdp', port: 3389, ...fields }, secret)
const vnc = async (name, security, fields, secret) => {
  const server = await startVncServer({ security })
  add(name, { type: 'vnc', port: server.port, ...fields }, secret)
  return server
}

ssh('ssh-new', {})
ssh('ssh-ram', {})
ssh('ssh-wrong-saved', { username: 'test', auth: 'password' }, 'nope')
ssh('ssh-no-user-saved-pw', {}, 'test')
ssh('ssh-cancel', {})
ssh('ssh-key', { username: 'test', auth: 'key', privateKeyPath: goodKey })
ssh('ssh-key-refused', { username: 'test', auth: 'key', privateKeyPath: otherKey })
ssh('jump-no-password', { username: 'test', auth: 'password' })
ssh('ssh-via-bad-jump', { username: 'test', auth: 'password', jumpSessionId: 'jump-no-password' }, 'test')
ssh('jump-good', { username: 'test', auth: 'password' }, 'test')
ssh('ssh-via-good-jump', { username: 'test', auth: 'password', jumpSessionId: 'jump-good' }, 'test')

rdp('rdp-new', {})
rdp('rdp-domain', {})
rdp('rdp-session-domain', { username: 'alice', rdpDomain: 'CORP' }, 'good')
rdp('rdp-pw-only', { username: 'alice' })
rdp('rdp-user-only', {}, 'good')
rdp('rdp-saved', { username: 'alice' }, 'good')
rdp('rdp-wrong-saved', { username: 'alice' }, 'nope')
rdp('rdp-wrong-user', { username: 'bob' }, 'good')
rdp('rdp-give-up', { username: 'alice' }, 'nope')
rdp('rdp-cancel', {})

const vncNew = await vnc('vnc-new', 'ard', {})
const vncRam = await vnc('vnc-ram', 'ard', {})
const vncWrongUser = await vnc('vnc-wrong-user', 'ard', { username: 'bob' }, 'test')
await vnc('vnc-user-only', 'ard', {}, 'test')
await vnc('vnc-password-only', 'vnc', {})

// Real IronRDP: only needs something that accepts the TCP connection.
let rdpConnections = 0
const fakeRdp = createServer((s) => {
  rdpConnections++
  s.on('error', () => {})
  s.destroy()
})
await new Promise((r) => fakeRdp.listen(0, '127.0.0.1', r))
rdp('rdp-real', { port: fakeRdp.address().port })

json('sessions.json', sessions)
json('secrets.json', secrets)
json('known_hosts.json', hosts)

const stored = () => readDb(join(userData, 'nixi.nxdb'), 'e2e-master')
const storedSession = (id) => stored().sessions.find((s) => s.id === id)

/** Installed before the RDP code loads: the real element then fails to register, which is ignored. */
function installFakeRdp() {
  const define = customElements.define.bind(customElements)
  customElements.define = (name, cls, opts) => (name === 'iron-remote-desktop' ? undefined : define(name, cls, opts))
  window.rdpConfigs = []
  const ui = () => ({
    configBuilder: () => {
      const config = {}
      const builder = new Proxy({}, {
        get: (_t, key) => (value) => {
          if (key === 'build') return config
          config[String(key).replace(/^with/, '')] = value
          return builder
        }
      })
      return builder
    },
    connect: async (config) => {
      window.rdpConfigs.push({ Username: config.Username, Password: config.Password, ServerDomain: config.ServerDomain, AuthToken: config.AuthToken })
      if (config.Username === 'alice' && config.Password === 'good') return { run: () => new Promise(() => {}) }
      throw { kind: () => 2, backtrace: () => 'stand-in' }
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

async function withApp(run) {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master', SSH_AUTH_SOCK: '' } })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.tree-row')
    await run(app, win)
  } finally {
    await app.close()
  }
}

function helpers(app, win) {
  const modal = win.locator('.modal')
  const h = {
    open: (name) => win.locator('.tree-row', { hasText: name }).first().dblclick(),
    closeTab: async () => {
      if (await modal.count()) await win.keyboard.press('Escape')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'closeTab'))
      await win.waitForTimeout(150)
    },
    /** What the dialog asks for, once it is up. */
    dialog: async (timeout = 6000) => {
      await win.waitForSelector('.modal input', { timeout })
      await win.waitForTimeout(50)
      const user = win.locator('.modal input[name=username]')
      const hasUser = (await user.count()) > 0
      return {
        hasUser,
        hasPassword: (await win.locator('.modal input[type=password]').count()) > 0,
        username: hasUser ? await user.inputValue() : undefined,
        text: await modal.innerText()
      }
    },
    answer: async ({ username, password, save }) => {
      if (username !== undefined) await win.locator('.modal input[name=username]').fill(username)
      if (password !== undefined) await win.locator('.modal input[type=password]').fill(password)
      if (save) await win.locator('.modal label.check input').check()
      await win.locator('.modal button.primary').click()
      await win.waitForTimeout(80)
    },
    connected: () => win.locator('.tab.active .dot.connected').waitFor({ timeout: 10000 }).then(() => true, () => false),
    noDialog: async () => (await modal.count()) === 0,
    /** Run one scenario; a timeout fails it and the next one starts clean. */
    scenario: async (name, fn) => {
      try {
        await fn()
      } catch (e) {
        check(`${name}: finished`, false, String(e.message).split('\n')[0])
      }
      await h.closeTab()
    }
  }
  return h
}

try {
  await withApp(async (app, win) => {
    const { open, dialog, answer, connected, noDialog, closeTab, scenario } = helpers(app, win)
    await win.evaluate(installFakeRdp)
    const lastConfig = () => win.evaluate(() => window.rdpConfigs.at(-1))
    const configCount = () => win.evaluate(() => window.rdpConfigs.length)
    const overlay = () => win.waitForSelector('.rdp-overlay.error', { timeout: 8000 }).then((e) => e.innerText())

    console.log('--- SSH')
    await scenario('ssh new', async () => {
      await open('ssh-new')
      const d = await dialog()
      check('SSH, nothing filled in: asks username and password together', d.hasUser && d.hasPassword)
      check('…no "rejected" hint before trying', !/rejected/i.test(d.text))
      await win.keyboard.type('nobody')
      await win.keyboard.press('Enter')
      check('…Enter in the username moves on to the password', (await win.evaluate(() => document.activeElement.type)) === 'password')
      await win.keyboard.type('test')
      await win.keyboard.press('Enter')
      const again = await dialog(12000)
      check('wrong username: asks again and keeps what was typed', /rejected/i.test(again.text) && again.username === 'nobody', again.username)
      await answer({ username: 'test', password: 'test', save: true })
      check('…corrected username connects', await connected())
      await win.waitForTimeout(300)
      check('Save ticked: username and password stored', storedSession('ssh-new').username === 'test' && stored().secrets['ssh-new'] === 'test')
    })
    await scenario('ssh memory', async () => {
      await open('ssh-ram')
      await dialog()
      await answer({ username: 'test', password: 'test' })
      check('SSH unticked: connects', await connected())
      await win.waitForTimeout(300)
      check('…nothing stored', !storedSession('ssh-ram').username && !stored().secrets['ssh-ram'])
      await closeTab()
      await open('ssh-ram')
      check('…second tab reuses it from memory', (await connected()) && (await noDialog()))
    })
    await scenario('ssh wrong saved', async () => {
      await open('ssh-wrong-saved')
      const d = await dialog(12000)
      check('wrong saved password: asks with a hint, username can be fixed', /rejected/i.test(d.text) && d.username === 'test')
      await answer({ password: 'test' })
      check('…typed one connects', await connected())
      await win.waitForTimeout(300)
      check('…saved one untouched when unticked', stored().secrets['ssh-wrong-saved'] === 'nope')
    })
    await scenario('ssh username only', async () => {
      await open('ssh-no-user-saved-pw')
      const d = await dialog()
      check('saved password, no username: asks only the username', d.hasUser && !d.hasPassword)
      await answer({ username: 'test', save: true })
      check('…connects', await connected())
      await win.waitForTimeout(300)
      check('…username stored, password kept', storedSession('ssh-no-user-saved-pw').username === 'test' && stored().secrets['ssh-no-user-saved-pw'] === 'test')
    })
    await scenario('ssh cancel', async () => {
      await open('ssh-cancel')
      await dialog()
      await win.keyboard.press('Escape')
      await win.waitForTimeout(300)
      check('Esc: no connection, no further dialog', (await win.locator('.tab.active .dot.connected').count()) === 0 && (await noDialog()))
    })
    await scenario('ssh key', async () => {
      await open('ssh-key')
      const d = await dialog(12000)
      check('encrypted key: asks the passphrase, not the username', /Passphrase/.test(d.text) && !d.hasUser, d.text.split('\n')[0])
      await answer({ password: 'not-it' })
      const again = await dialog(12000)
      check('wrong passphrase: asks again with a hint', /wrong passphrase/i.test(again.text))
      await answer({ password: 'open-sesame', save: true })
      check('…right passphrase connects', await connected())
      await win.waitForTimeout(300)
      check('…stored when ticked', stored().secrets['ssh-key'] === 'open-sesame')
    })
    await scenario('ssh key refused', async () => {
      await open('ssh-key-refused')
      await win.waitForTimeout(2500)
      check('key the server refuses: no pointless password dialog', await noDialog())
    })
    await scenario('bad jump', async () => {
      await open('ssh-via-bad-jump')
      await win.waitForTimeout(2500)
      check("jump host without password: doesn't ask as if it were the target", await noDialog())
    })
    await scenario('good jump', async () => {
      await open('ssh-via-good-jump')
      check('through a jump host with a saved password: connects', await connected())
    })

    console.log('--- RDP (stand-in for the server)')
    await scenario('rdp new', async () => {
      await open('rdp-new')
      const d = await dialog(15000)
      check('RDP, nothing filled in: asks username and password together', d.hasUser && d.hasPassword)
      await answer({ username: 'bob', password: 'bad', save: true })
      const again = await dialog()
      check('rejected: asks again, says why, keeps the username', /Logon failed/.test(again.text) && again.username === 'bob', again.username)
      check('…a rejected login is never stored', !storedSession('rdp-new').username && !stored().secrets['rdp-new'])
      await answer({ username: 'alice', password: 'good', save: true })
      check('…right login connects', await connected())
      await win.waitForTimeout(300)
      check('Save ticked: username and password stored after the login worked', storedSession('rdp-new').username === 'alice' && stored().secrets['rdp-new'] === 'good')
    })
    await scenario('rdp domain', async () => {
      await open('rdp-domain')
      await dialog()
      await answer({ username: 'LAB\\alice', password: 'good' })
      check('DOMAIN\\user: connects', await connected())
      const c = await lastConfig()
      check('…sent as user + domain', c.Username === 'alice' && c.ServerDomain === 'LAB', JSON.stringify([c.Username, c.ServerDomain]))
      await win.waitForTimeout(300)
      check('unticked: nothing stored', !storedSession('rdp-domain').username && !stored().secrets['rdp-domain'])
      await closeTab()
      await open('rdp-domain')
      check('…second tab reuses it from memory', (await connected()) && (await noDialog()))
      const c2 = await lastConfig()
      check('…with the same domain', c2.Username === 'alice' && c2.ServerDomain === 'LAB')
    })
    await scenario('rdp session domain', async () => {
      await open('rdp-session-domain')
      check("session's domain field is used", await connected())
      check('…sent', (await lastConfig()).ServerDomain === 'CORP')
    })
    await scenario('rdp password only', async () => {
      await open('rdp-pw-only')
      const d = await dialog()
      check('username known: asks only the password', !d.hasUser && d.hasPassword)
      await answer({ password: 'good', save: true })
      check('…connects', await connected())
      await win.waitForTimeout(300)
      check('…stored when ticked', stored().secrets['rdp-pw-only'] === 'good')
    })
    await scenario('rdp username only', async () => {
      await open('rdp-user-only')
      const d = await dialog()
      check('password saved, no username: asks only the username', d.hasUser && !d.hasPassword)
      await answer({ username: 'alice' })
      check('…connects with the saved password', await connected())
    })
    await scenario('rdp saved', async () => {
      await open('rdp-saved')
      check('everything saved: no dialog', (await connected()) && (await noDialog()))
    })
    await scenario('rdp wrong saved', async () => {
      await open('rdp-wrong-saved')
      const d = await dialog()
      check('wrong saved password: asks again by itself', /Logon failed/.test(d.text) && d.hasPassword)
      await answer({ password: 'good' })
      check('…typed one connects', await connected())
      await win.waitForTimeout(300)
      check('…saved one untouched when unticked', stored().secrets['rdp-wrong-saved'] === 'nope')
    })
    await scenario('rdp wrong user', async () => {
      await open('rdp-wrong-user')
      const d = await dialog()
      check('wrong saved username: can be fixed in the dialog', d.username === 'bob')
      await answer({ username: 'alice', password: 'good', save: true })
      check('…connects', await connected())
      await win.waitForTimeout(300)
      check('…corrected username stored', storedSession('rdp-wrong-user').username === 'alice')
    })
    await scenario('rdp give up', async () => {
      const before = await configCount()
      await open('rdp-give-up')
      for (let i = 0; i < 3; i++) {
        await dialog()
        await answer({ password: 'bad' })
      }
      const text = await overlay()
      check('3 more wrong tries: stops with the error', /Logon failed/.test(text) && (await noDialog()), text.split('\n')[0])
      check('…4 attempts in all', (await configCount()) - before === 4, String((await configCount()) - before))
    })
    await scenario('rdp cancel', async () => {
      await open('rdp-cancel')
      await dialog()
      await win.keyboard.press('Escape')
      check('Esc: shows Cancelled', /Cancelled/.test(await overlay()))
      await win.locator('.rdp-overlay.error button', { hasText: 'Reconnect' }).click()
      const d = await dialog()
      check('Reconnect: asks again', d.hasUser && d.hasPassword)
    })

    console.log('--- VNC')
    await scenario('vnc new', async () => {
      await open('vnc-new')
      const d = await dialog()
      check('account server, nothing filled in: asks both', d.hasUser && d.hasPassword)
      await answer({ username: 'test', password: 'bad', save: true })
      const again = await dialog()
      check('rejected: asks again, keeps the username', /rejected/i.test(again.text) && again.username === 'test', again.username)
      check('…a rejected login is never stored', !storedSession('vnc-new').username && !stored().secrets['vnc-new'])
      await answer({ password: 'test', save: true })
      check('…right password connects', await connected())
      check('…server got the username', vncNew.seen.username === 'test')
      await win.waitForTimeout(300)
      check('Save ticked: both stored', storedSession('vnc-new').username === 'test' && stored().secrets['vnc-new'] === 'test')
    })
    await scenario('vnc memory', async () => {
      await open('vnc-ram')
      await dialog()
      await answer({ username: 'test', password: 'test' })
      check('unticked: connects', await connected())
      await win.waitForTimeout(300)
      check('…nothing stored', !storedSession('vnc-ram').username && !stored().secrets['vnc-ram'])
      await closeTab()
      await open('vnc-ram')
      check('…second tab reuses it from memory', (await connected()) && (await noDialog()) && vncRam.seen.username === 'test')
    })
    await scenario('vnc wrong user', async () => {
      await open('vnc-wrong-user')
      const d = await dialog()
      check('wrong saved username: can be fixed in the dialog', d.username === 'bob' && vncWrongUser.seen.username === 'bob', d.username)
      await answer({ username: 'test', password: 'test', save: true })
      check('…connects', await connected())
      await win.waitForTimeout(300)
      check('…corrected username stored', storedSession('vnc-wrong-user').username === 'test')
    })
    await scenario('vnc username only', async () => {
      await open('vnc-user-only')
      const d = await dialog()
      check('password saved, no username: asks only the username', d.hasUser && !d.hasPassword)
      await answer({ username: 'test' })
      check('…connects with the saved password', await connected())
    })
    await scenario('vnc password only', async () => {
      await open('vnc-password-only')
      const d = await dialog()
      check('password-only server: no username field', !d.hasUser && d.hasPassword)
      await answer({ password: 'test' })
      check('…connects', await connected())
    })
  })

  console.log('--- RDP (real IronRDP, as far as the TCP connection)')
  await withApp(async (app, win) => {
    const { open, dialog, answer } = helpers(app, win)
    const errors = []
    win.on('pageerror', (e) => errors.push(e.message))
    await open('rdp-real')
    const d = await dialog(20000)
    check('real client: asks username and password', d.hasUser && d.hasPassword)
    // The proxy's ticket lasts 60 s: a slow typist must not end up with an expired one.
    await win.waitForTimeout(62000)
    await answer({ username: 'alice', password: 'whatever' })
    await win.waitForSelector('.rdp-overlay.error', { timeout: 15000 })
    check('62 s in the dialog: the proxy still reaches the server', rdpConnections > 0, `connections=${rdpConnections}`)
    check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  })
} finally {
  sshd.kill()
  fakeRdp.close()
  rmSync(userData, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} FAILED` : '\nAll login checks passed')
process.exit(failed ? 1 : 0)
