// Saved credentials: made in the manager, picked in the login dialog and the session dialog, used by
// SSH (password and key, jump host), RDP (stand-in, see
// e2e-login) and VNC (fake server). Changing or deleting one must not strand the sessions using it.
//   npm run build && node scripts/e2e-credentials.mjs
import { execFileSync, spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-cred-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
const keyFile = join(userData, 'key')
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'open-sesame', '-f', keyFile])

const SSH_PORT = 2294
const sshd = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', String(SSH_PORT), '--authorized-key', `${keyFile}.pub`], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const hostKey = ssh2.utils.parseKey(readFileSync(join(tmpdir(), 'nixi-dev-hostkey')))
const vncServer = await startVncServer({ security: 'ard' })

const ssh = (id, extra = {}) => ({ id, name: id, type: 'ssh', folder: '', host: '127.0.0.1', port: SSH_PORT, ...extra })
json('sessions.json', [
  ssh('pick-ram'),
  ssh('pick-save'),
  ssh('pick-nopw'),
  ssh('pick-key'),
  ssh('pick-key-save'),
  ssh('wrong-then-key', { username: 'test', auth: 'password' }),
  ssh('form-link'),
  ssh('other-link'),
  ssh('key-link'),
  ssh('jump'),
  ssh('via-jump', { username: 'test', jumpSessionId: 'jump' }),
  ssh('known-user', { username: 'nobody', auth: 'password' }),
  { id: 'rdp-link', name: 'rdp-link', type: 'rdp', folder: '', host: '127.0.0.1', port: 3389 },
  { id: 'rdp-ask', name: 'rdp-ask', type: 'rdp', folder: '', host: '127.0.0.1', port: 3389 },
  { id: 'vnc-link', name: 'vnc-link', type: 'vnc', folder: '', host: '127.0.0.1', port: vncServer.port }
])
json('known_hosts.json', { [`[127.0.0.1]:${SSH_PORT}`]: 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '') })

const stored = () => readDb(join(userData, 'nixi.nxdb'), 'e2e-master')
const session = (id) => stored().sessions.find((s) => s.id === id)
const credentialId = (name) => stored().credentials.find((c) => c.name === name)?.id
const secretOf = (name) => stored().secrets[`credential:${credentialId(name)}`]

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
      window.rdpConfigs.push({ Username: config.Username, Password: config.Password, ServerDomain: config.ServerDomain })
      return { run: () => new Promise(() => {}) }
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
    wait: (ms = 300) => win.waitForTimeout(ms),
    open: (name) => win.locator('.tree-row', { has: win.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) }).last().dblclick(),
    closeTab: async () => {
      if (await modal.count()) await win.keyboard.press('Escape')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'closeTab'))
      await win.waitForTimeout(150)
    },
    connected: () => win.locator('.tab.active .dot.connected').waitFor({ timeout: 10000 }).then(() => true, () => false),
    noDialog: async () => (await modal.count()) === 0,
    loginDialog: () => win.waitForSelector('.modal input[type=password]', { timeout: 12000 }),
    openManager: async () => {
      await win.locator('.toolbar button', { hasText: 'Credentials' }).click()
      await win.waitForSelector('.modal input[name=credentialName]')
    },
    closeManager: () => win.locator('.modal .modal-header button').click(),
    /** Fill the form on the right; `pick` selects an existing entry first. */
    editCredential: async ({ pick, name, username, secret, key }) => {
      if (pick) await modal.locator('.macro-row', { hasText: pick }).click()
      else await modal.locator('button', { hasText: 'New credential' }).click()
      if (name !== undefined) await modal.locator('input[name=credentialName]').fill(name)
      if (username !== undefined) await modal.locator('input[name=credentialUser]').fill(username)
      if (key) {
        await modal.locator('.type-picker button', { hasText: 'Private key' }).click()
        await modal.locator('input[name=credentialKey]').fill(key)
      }
      if (secret !== undefined) await modal.locator('input[name=credentialSecret]').fill(secret)
      await modal.locator('button.primary', { hasText: 'Save' }).click()
      await win.waitForTimeout(200)
    },
    /** Session dialog: pick a credential, save, leave. */
    linkInForm: async (id, credential) => {
      // last: the Recent list on top has no Edit in its menu
      await win.locator('.tree-row', { has: win.locator('.tree-name', { hasText: new RegExp(`^${id}$`) }) }).last().click({ button: 'right' })
      await win.locator('.context-menu .item', { hasText: /^Edit/ }).click()
      await win.waitForSelector('.modal select[name=credential]')
      await modal.locator('select[name=credential]').selectOption({ label: credential })
    }
  }
  return h
}


try {
  await withApp(async (app, win) => {
    const { wait, open, closeTab, connected, noDialog, loginDialog, openManager, closeManager, editCredential, linkInForm } = helpers(app, win)
    const modal = win.locator('.modal')
    await win.evaluate(installFakeRdp)

    console.log('--- manager')
    await openManager()
    await editCredential({ name: 'Ops', username: 'test', secret: 'test' })
    await editCredential({ name: 'Keyed', username: 'test', key: keyFile, secret: 'open-sesame' })
    await editCredential({ name: 'Win', username: 'CORP\\alice', secret: 'good' })
    await editCredential({ name: 'No password', username: 'test' })
    await wait()
    check('saved: name, username, kind', stored().credentials.length === 4 && stored().credentials.find((c) => c.name === 'Keyed').kind === 'key')
    check('…secret is in the database, under its own id', secretOf('Ops') === 'test' && secretOf('Keyed') === 'open-sesame')
    check('…the renderer list never holds the secret', !JSON.stringify(await win.evaluate(() => window.api.listCredentials())).includes('open-sesame'))
    await modal.locator('.macro-row', { hasText: 'Ops' }).click()
    await win.screenshot({ path: join(tmpdir(), 'nixi-credential-manager.png') })
    check('reopened: password field empty, says one is saved', (await modal.locator('input[name=credentialSecret]').inputValue()) === '' && /saved/.test(await modal.innerText()))
    await closeManager()

    console.log('--- login dialog')
    await open('pick-ram')
    await loginDialog()
    const options = await modal.locator('select[name=credential] option').allInnerTexts()
    check('SSH dialog offers every credential, keys too', ['Ops', 'Keyed', 'Win', 'No password'].every((n) => options.some((o) => o.includes(n))), options.join(' | '))
    await modal.locator('select[name=credential]').selectOption({ label: 'Ops (test)' })
    await wait(200)
    check('picking fills username and password', (await modal.locator('input[name=username]').inputValue()) === 'test' && (await modal.locator('input[type=password]').inputValue()) === 'test')
    check('…focus moves to OK, so Enter connects', (await win.evaluate(() => document.activeElement?.textContent)) === 'OK')
    await win.keyboard.press('Enter')
    check('…connects', await connected())
    await wait()
    check('…unticked: the session is not changed', !session('pick-ram').credentialId && !session('pick-ram').username)
    await closeTab()

    await open('pick-save')
    await loginDialog()
    await modal.locator('select[name=credential]').selectOption({ label: 'Ops (test)' })
    await wait(200)
    await win.screenshot({ path: join(tmpdir(), 'nixi-credential-login.png') })
    check('checkbox says what it will do', /Keep using Ops/.test(await modal.innerText()))
    await modal.locator('label.check input').check()
    await modal.locator('button.primary').click()
    check('ticked: connects', await connected())
    await wait()
    const linked = session('pick-save')
    check('…session links the credential, keeps no copy', linked.credentialId === credentialId('Ops') && !linked.username && !stored().secrets['pick-save'])
    await closeTab()
    await open('pick-save')
    check('…next time connects without asking', (await connected()) && (await noDialog()))
    await closeTab()

    await open('known-user')
    await loginDialog()
    const before = await modal.innerText()
    await modal.locator('select[name=credential]').selectOption({ label: 'Ops (test)' })
    await wait(200)
    check('dialog asking only a password: says which account it will use', /Logs in as test/.test(await modal.innerText()), before.split('\n')[0])
    await modal.locator('button.primary').click()
    check('…and logs in with it', await connected())
    await closeTab()

    await open('pick-nopw')
    await loginDialog()
    await modal.locator('select[name=credential]').selectOption({ label: 'No password (test)' })
    await wait(200)
    check('credential without a password: username filled, focus on password', (await win.evaluate(() => document.activeElement?.type)) === 'password' && (await modal.locator('input[name=username]').inputValue()) === 'test')
    await modal.locator('input[type=password]').fill('edited')
    check('…editing a field drops the link to it', (await modal.locator('select[name=credential]').inputValue()) === '')
    await closeTab()

    console.log('--- key credential in the login dialog')
    await open('pick-key')
    await loginDialog()
    await modal.locator('select[name=credential]').selectOption({ label: 'Keyed (test)' })
    await wait(200)
    await win.screenshot({ path: join(tmpdir(), 'nixi-credential-login-key.png') })
    check('picking a key: username filled, no password field, says which key', (await modal.locator('input[name=username]').inputValue()) === 'test' && (await modal.locator('input[type=password]').count()) === 0 && /Logs in with the key .*key \(passphrase saved\)/.test(await modal.innerText()), (await modal.innerText()).replace(/\n/g, ' | '))
    check('…focus on OK', (await win.evaluate(() => document.activeElement?.textContent)) === 'OK')
    await win.keyboard.press('Enter')
    check('…connects with the key and its saved passphrase', (await connected()) && (await noDialog()))
    await wait()
    check('…unticked: the session is not changed', !session('pick-key').credentialId && !session('pick-key').username && !stored().secrets['pick-key'])
    await closeTab()
    await open('pick-key')
    check('…same run: reopening uses it again without asking', (await connected()) && (await noDialog()))
    await closeTab()

    await open('pick-key-save')
    await loginDialog()
    await modal.locator('select[name=credential]').selectOption({ label: 'Keyed (test)' })
    await wait(200)
    await modal.locator('label.check input').check()
    await modal.locator('button.primary').click()
    check('key ticked: connects', await connected())
    await wait()
    check('…session links the key credential', session('pick-key-save').credentialId === credentialId('Keyed') && !stored().secrets['pick-key-save'])
    await closeTab()

    await open('wrong-then-key')
    let pw = await loginDialog()
    await pw.fill('wrong')
    await pw.press('Enter')
    await win.waitForSelector('.modal .error-line:has-text("rejected")', { timeout: 12000 })
    const again = await modal.locator('select[name=credential] option').allInnerTexts()
    check('wrong password: the dialog asking again offers the key credential', again.some((o) => o.includes('Keyed')), again.join(' | '))
    await modal.locator('select[name=credential]').selectOption({ label: 'Keyed (test)' })
    await wait(200)
    await modal.locator('button.primary').click()
    check('…and logs in with the key', (await connected()) && (await noDialog()))
    await closeTab()

    await open('rdp-ask')
    const rdpAsk = await win.waitForSelector('.modal select[name=credential]', { timeout: 12000 }).then(() => true, () => false)
    const rdpAskOptions = rdpAsk ? await modal.locator('select[name=credential] option').allInnerTexts() : []
    check('RDP login dialog offers password credentials only', rdpAsk && rdpAskOptions.some((o) => o.includes('Win')) && !rdpAskOptions.some((o) => o.includes('Keyed')), rdpAskOptions.join(' | '))
    await closeTab()

    console.log('--- session dialog')
    await linkInForm('form-link', 'Ops (test)')
    await win.screenshot({ path: join(tmpdir(), 'nixi-credential-session.png') })
    check('username locked to the credential, password field gone', await modal.locator('input[name=username]').isDisabled() && (await modal.locator('input[name=username]').inputValue()) === 'test' && (await modal.locator('input[type=password]').count()) === 0)
    await modal.locator('.modal-footer button.primary').click()
    check('saved: connects without asking', (await connected()) && (await noDialog()))
    await closeTab()
    await wait()
    check('…only the link is stored', session('form-link').credentialId === credentialId('Ops') && !session('form-link').username)

    await linkInForm('other-link', 'Ops (test)')
    await modal.locator('.modal-footer button', { hasText: /^Save$/ }).click()
    await wait()

    await linkInForm('key-link', 'Keyed (test)')
    await modal.locator('.modal-footer button.primary').click()
    check('private key credential with a passphrase connects', (await connected()) && (await noDialog()))
    await closeTab()

    await linkInForm('jump', 'Ops (test)')
    await modal.locator('.modal-footer button', { hasText: /^Save$/ }).click()
    await wait()
    await linkInForm('via-jump', 'Ops (test)')
    await modal.locator('.modal-footer button.primary').click()
    check('jump host and target both log in through a credential', (await connected()) && (await noDialog()))
    await closeTab()

    await linkInForm('rdp-link', 'Win (CORP\\alice)')
    const rdpOptions = await modal.locator('select[name=credential] option').allInnerTexts()
    check('RDP offers no key credential', !rdpOptions.some((o) => o.includes('Keyed')))
    await modal.locator('.modal-footer button.primary').click()
    for (let i = 0; i < 40 && !(await win.evaluate(() => window.rdpConfigs.length)); i++) await wait(100)
    const rdp = await win.evaluate(() => window.rdpConfigs.at(-1))
    check('RDP gets user, domain and password from it', rdp?.Username === 'alice' && rdp?.ServerDomain === 'CORP' && rdp?.Password === 'good', JSON.stringify(rdp?.Username))
    await closeTab()

    await linkInForm('vnc-link', 'Ops (test)')
    await modal.locator('.modal-footer button.primary').click()
    const vncUp = await win.locator('.tab.active .dot.connected').waitFor({ timeout: 10000 }).then(() => true, () => false)
    check('VNC logs in with it', vncUp && (await noDialog()))
    await closeTab()

    console.log('--- changing a credential')
    await openManager()
    check('manager lists who uses it', /Used by:.*pick-save/.test(await (async () => {
      await modal.locator('.macro-row', { hasText: 'Ops' }).click()
      return modal.innerText()
    })()))
    await editCredential({ pick: 'Ops', secret: 'wrong' })
    await closeManager()
    await open('form-link')
    await loginDialog()
    check('wrong password in a credential: login asks, says rejected', /rejected/i.test(await modal.innerText()))
    await modal.locator('input[type=password]').fill('test')
    await modal.locator('label.check input').check()
    await modal.locator('button.primary').click()
    check('…typed password connects', await connected())
    await wait()
    const own = session('form-link')
    check('…Save gives this session its own login', !own.credentialId && own.username === 'test' && stored().secrets['form-link'] === 'test')
    check('…the credential and the others are untouched', secretOf('Ops') === 'wrong' && session('other-link').credentialId === credentialId('Ops'))
    await closeTab()
    await openManager()
    await editCredential({ pick: 'Ops', secret: 'test' })
    await closeManager()
    await open('other-link')
    check('fixing the credential fixes every session using it', (await connected()) && (await noDialog()))
    await closeTab()

    console.log('--- leaving a credential')
    await linkInForm('pick-save', '— none, this session has its own login —')
    check('unlinked in the form: username editable again, password field back', !(await modal.locator('input[name=username]').isDisabled()) && (await modal.locator('input[type=password]').count()) === 1)
    await win.keyboard.press('Escape')
    await wait()

    console.log('--- deleting a credential')
    const opsId = credentialId('Ops')
    await openManager()
    await modal.locator('.macro-row', { hasText: 'Ops' }).click()
    await modal.locator('button.danger', { hasText: 'Delete' }).click()
    const asking = win.locator('.modal', { hasText: 'Delete credential' })
    await asking.waitFor()
    const asked = await asking.innerText()
    await asking.locator('.modal-footer button', { hasText: 'Delete' }).click()
    await wait(500)
    check('warns how many sessions use it', /session\(s\)/.test(asked), asked)
    check('credential and its secret gone', !stored().credentials.some((c) => c.id === opsId) && !(`credential:${opsId}` in stored().secrets))
    const kept = session('other-link')
    check('sessions keep the login as their own', !kept.credentialId && kept.username === 'test' && stored().secrets['other-link'] === 'test')
    await closeManager()
    await open('other-link')
    check('…and still connect', (await connected()) && (await noDialog()))
    await closeTab()

    console.log('--- saved password at a password prompt (sudo-like)')
    const answered = join(userData, 'answered.txt')
    // The answer goes to a file: the screen doesn't echo it. Emptied here, not with rm (a dangerous command).
    const promptCmd = () => {
      writeFileSync(answered, '')
      return `printf 'Password: '; stty -echo; read P; stty echo; echo; echo "got-$P" > ${answered}\r`
    }
    const readAnswer = async () => {
      for (let i = 0; i < 30; i++) {
        const got = readFileSync(answered, 'utf8').trim()
        if (got) return got
        await wait(100)
      }
      return ''
    }
    const picker = win.locator('.macro-picker')
    const pickerItems = () => win.locator('.macro-picker-item').allInnerTexts().then((l) => l.map((t) => t.replace(/\s+/g, ' ').trim()))
    const menuCmd = (c) => app.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', cmd), c)

    await open('other-link')
    await connected()
    await wait(800)
    await menuCmd('macroPicker')
    await wait(300)
    check('no password prompt, no macros: no picker, says why', (await picker.count()) === 0 && (await win.locator('.toast', { hasText: 'No macros yet' }).count()) > 0)
    await win.keyboard.type(promptCmd())
    await wait(800)
    await menuCmd('macroPicker')
    await picker.waitFor({ timeout: 5000 })
    const offered = await pickerItems()
    await win.screenshot({ path: join(tmpdir(), 'nixi-credential-sudo.png') })
    check('at the prompt: the session password first, then credentials with a secret', /^Password of other-link/.test(offered[0] ?? '') && offered.some((t) => t.startsWith('Win')) && offered.some((t) => t.startsWith('Keyed')) && !offered.some((t) => t.startsWith('No password')), offered.join(' | '))
    check('…focus in the filter, first one selected', (await win.evaluate(() => document.activeElement?.closest('.macro-picker') !== null)) && /^Password of/.test(await win.locator('.macro-picker-item.selected').innerText()))
    await win.keyboard.press('Enter')
    check('Enter types the session password and Enter', (await readAnswer()) === 'got-test')
    check('…picker closed, terminal has the keys again', (await picker.count()) === 0 && (await win.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))))
    await wait(300)
    await win.keyboard.type(promptCmd())
    await wait(800)
    await menuCmd('macroPicker')
    await picker.waitFor({ timeout: 5000 })
    await win.keyboard.type('win')
    await win.keyboard.press('Enter')
    check('filtering picks a credential: its password is typed', (await readAnswer()) === 'got-good')
    check('…the password never reaches the screen or the history', !(await win.evaluate(() => document.body.innerText)).includes('got-good') && !JSON.stringify(stored().commandHistory ?? {}).includes('good'))
    await closeTab()

    await open('pick-key-save')
    await connected()
    await wait(800)
    await win.keyboard.type(promptCmd())
    await wait(800)
    await menuCmd('macroPicker')
    await picker.waitFor({ timeout: 5000 })
    const linkedFirst = await pickerItems()
    check('a session using a credential: that credential first', /^Keyed passphrase · this session/.test(linkedFirst[0] ?? ''), linkedFirst.join(' | '))
    await win.keyboard.press('Escape')
    check('…Esc closes it, nothing typed', (await picker.count()) === 0 && (await readAnswer()) === '')
    await closeTab()

    console.log('--- export')
    const file = join(userData, 'export.json')
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
    }, file)
    await win.evaluate(() => window.api.exportSessions())
    const exported = readFileSync(file, 'utf8')
    check('export has credentials but no secret', exported.includes('"Keyed"') && !exported.includes('open-sesame') && !exported.includes('"good"'))
  })

  await withApp(async (app, win) => {
    const { open, connected, noDialog } = helpers(app, win)
    await open('key-link')
    check('after a restart the link still works', (await connected()) && (await noDialog()))
  })
} finally {
  sshd.kill()
  vncServer.close?.()
  rmSync(userData, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
