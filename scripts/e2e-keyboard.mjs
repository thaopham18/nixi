// English-only typing in SSH and Telnet terminals, and the pages of Settings. A Telnet server here
// records the exact bytes the app sends; input method text goes in through CDP, the way Chromium
// receives it from the system. An event-tap tool like EVKey can only be tried by hand: this checks
// that macOS Secure Keyboard Entry is on when it should be, by asking ioreg. POSIX shells only.
//   npm run build && node scripts/e2e-keyboard.mjs
import { execFileSync, spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SSH_PORT = 2290

let received = Buffer.alloc(0)
const telnet = createServer((socket) => {
  socket.on('data', (d) => (received = Buffer.concat([received, d])))
  socket.on('error', () => {})
  socket.write('login-free> ')
})
await new Promise((r) => telnet.listen(0, '127.0.0.1', r))
const TELNET_PORT = telnet.address().port

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-keyboard-'))
const sshd = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', String(SSH_PORT)], { stdio: 'ignore' })
const keyFile = join(tmpdir(), 'nixi-dev-hostkey')
for (let i = 0; i < 50 && !existsSync(keyFile); i++) await sleep(100)
await sleep(500)
const hostKey = ssh2.utils.parseKey(readFileSync(keyFile))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
json('known_hosts.json', { [`[127.0.0.1]:${SSH_PORT}`]: 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '') })
json('sessions.json', [
  { id: 's1', name: 'ssh-box', type: 'ssh', folder: '', host: '127.0.0.1', port: SSH_PORT, username: 'test', auth: 'password' },
  { id: 's2', name: 'telnet-box', type: 'telnet', folder: '', host: '127.0.0.1', port: TELNET_PORT },
  { id: 's3', name: 'local-box', type: 'local', folder: '' }
])
json('secrets.json', { s1: 'raw:' + Buffer.from('test').toString('base64') })
json('settings.json', { gpuRendering: false, warnMultilinePaste: false, sftpAutoOpen: false })

// Whether macOS has Secure Keyboard Entry on, as the system itself reports it.
const secureOn = () => process.platform === 'darwin' && execFileSync('ioreg', ['-l', '-w', '0', '-d', '4', '-n', 'Root']).toString().includes('kCGSSessionSecureInputPID')

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master' } })
let savedClipboard
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')
  savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  const wait = (ms = 300) => win.waitForTimeout(ms)
  const poll = async (fn, ms = 6000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return true
      await wait(100)
    }
    return false
  }
  const cdp = await win.context().newCDPSession(win)
  const box = () => win.locator('.tab-view:visible .xterm-helper-textarea').first()
  const screen = () => win.locator('.tab-view:visible .xterm-rows').first().innerText()
  const open = async (name) => {
    await win.locator('.tree-row', { hasText: name }).dblclick()
    await poll(async () => (await win.locator('.tab-view:visible .xterm-rows').count()) > 0)
    await wait(1200)
    await box().focus()
  }
  const sent = async (fn) => {
    await wait(150)
    const start = received.length
    await fn()
    await wait(350)
    return received.subarray(start).toString('utf8')
  }
  // How the system hands text over from an input method: marked text, then the final string.
  const imeTypes = async (text) => {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }).catch(() => {})
    await wait(60)
    await cdp.send('Input.insertText', { text }).catch(() => {})
  }
  const fakeKey = (init) =>
    box().evaluate((el, init) => {
      for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))
    }, init)
  const settings = async (page) => {
    await win.locator('.toolbar button[title=Settings]').click()
    await win.locator('.settings-nav button', { hasText: page }).click()
  }

  console.log('--- telnet')
  await open('telnet-box')
  check('the input method is off in the terminal field', await box().evaluate((el) => el.readOnly))
  check('plain typing arrives as typed', (await sent(() => win.keyboard.type('hello World!'))) === 'hello World!')
  check('the input method composing and committing sends nothing', (await sent(() => imeTypes('â'))) === '')
  check('…nor does a whole word', (await sent(() => imeTypes('tiếng Việt'))) === '')
  check('typing goes on normally after it', (await sent(() => win.keyboard.type('ls'))) === 'ls')
  check('key held by an input method: the US key', (await sent(() => fakeKey({ key: 'Process', code: 'KeyA', keyCode: 229 }))) === 'a')
  check('another alphabet: the US key', (await sent(() => fakeKey({ key: 'ф', code: 'KeyF' }))) === 'f')
  check('…with Shift', (await sent(() => fakeKey({ key: 'Ф', code: 'KeyF', shiftKey: true }))) === 'F')
  check('Vietnamese layout number row: the digit', (await sent(() => fakeKey({ key: 'đ', code: 'Digit0' }))) === '0')
  check('text with no key behind it is dropped', (await sent(() => fakeKey({ key: 'â', code: '' }))) === '')
  check('Enter', (await sent(() => win.keyboard.press('Enter'))).startsWith('\r'))
  check('Backspace', (await sent(() => win.keyboard.press('Backspace'))) === '\x7f')
  check('Arrow up', (await sent(() => win.keyboard.press('ArrowUp'))) === '\x1b[A')
  check('Tab', (await sent(() => win.keyboard.press('Tab'))) === '\t')
  check('Ctrl+C', (await sent(() => win.keyboard.press('Control+c'))) === '\x03')

  await app.evaluate(({ clipboard }) => clipboard.writeText('dán tiếng Việt'))
  check('pasting from the menu keeps Vietnamese', (await sent(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste()))).includes('dán tiếng Việt'))
  await box().focus()
  const termBox = await win.locator('.tab-view:visible .xterm-screen').first().boundingBox()
  check('right-click paste keeps Vietnamese', (await sent(() => win.mouse.click(termBox.x + 40, termBox.y + 40, { button: 'right' }))).includes('dán tiếng Việt'))

  // Asks the system, so it needs this window to be the frontmost one.
  const front = await app.evaluate(async ({ app, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    app.focus({ steal: true })
    w.focus()
    await new Promise((r) => setTimeout(r, 500))
    return w.isFocused()
  })
  if (process.platform === 'darwin' && !front) console.log('SKIP  Secure Keyboard Entry: this window could not come to the front')
  if (process.platform === 'darwin' && front) {
    await box().focus()
    check('Secure Keyboard Entry is on while it has focus', await poll(secureOn))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur())
    check('…off while the user is in another app', await poll(() => !secureOn()))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
    await box().focus()
    check('…on again on coming back', await poll(secureOn))
    await win.locator('.sidebar input').first().focus()
    check('…off when focus moves to another field', await poll(() => !secureOn()))
    const typedThere = await win.locator('.sidebar input').first().evaluate((el) => el.readOnly)
    check('…and that field keeps the input method', !typedThere)
    await box().focus()
    await poll(secureOn)
    await win.locator('.toolbar button[title=Settings]').click()
    check('…off behind a dialog', await poll(() => !secureOn()))
    await win.locator('.modal-footer button', { hasText: 'Cancel' }).click()
  }

  console.log('--- ssh')
  await open('ssh-box')
  check('the input method is off', await box().evaluate((el) => el.readOnly))
  await win.keyboard.type('echo ssh-')
  await imeTypes('ệ')
  await win.keyboard.type('ok')
  await win.keyboard.press('Enter')
  check('a real shell gets the keys and not the composed text', await poll(async () => (await screen()).includes('ssh-ok')), (await screen()).slice(-80))
  check('…nothing of it shows', !(await screen()).includes('ệ'))

  console.log('--- local')
  await open('local-box')
  check('a local terminal keeps the input method', !(await box().evaluate((el) => el.readOnly)))
  await win.keyboard.type('echo local-')
  await cdp.send('Input.insertText', { text: 'â' })
  await win.keyboard.type('-end')
  await win.keyboard.press('Enter')
  check('…and input method text arrives', await poll(async () => /local-â-end\s/.test(await screen())), (await screen()).slice(-80))
  if (process.platform === 'darwin') check('…with Secure Keyboard Entry off', await poll(() => !secureOn()))

  console.log('--- the setting')
  await win.locator('.tab', { hasText: 'telnet-box' }).click()
  await wait()
  await settings('Keyboard')
  const englishBox = win.locator('input[name=terminalEnglishOnly]')
  check('on by default', await englishBox.isChecked())
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-keyboard-page.png') })
  await englishBox.uncheck()
  await win.locator('.modal-footer button.primary').click()
  await wait()
  await box().focus()
  check('turned off: the terminal accepts the input method', !(await box().evaluate((el) => el.readOnly)))
  check('…and sends what it composed', (await sent(() => cdp.send('Input.insertText', { text: 'â' }))) === 'â')
  check('…and other alphabets', (await sent(() => box().evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ф', code: 'KeyF', charCode: 0 }))))) !== 'f')
  if (process.platform === 'darwin') check('…with Secure Keyboard Entry off', await poll(() => !secureOn()))
  await settings('Keyboard')
  await englishBox.check()
  await win.locator('.modal-footer button.primary').click()
  await wait()
  check('turned on again: applies at once', await box().evaluate((el) => el.readOnly))

  console.log('--- settings pages')
  await win.locator('.toolbar button[title=Settings]').click()
  const tabs = win.locator('.settings-nav button')
  const names = await tabs.allInnerTexts()
  check('a page for each function', names.join('|') === 'Terminal|Keyboard & Paste|Connections|Command Safety|AI Assistant|Macros|SFTP|Database', names.join('|'))
  const sizes = new Set()
  const fields = {
    Terminal: 'Font family',
    'Keyboard & Paste': 'Copy text on selection',
    Connections: 'Reconnect by itself',
    'Command Safety': 'Also ask about',
    'AI Assistant': 'Anthropic API key',
    Macros: 'macro list at the cursor',
    SFTP: 'Download folder',
    Database: 'Unlock automatically'
  }
  for (const name of names) {
    await tabs.filter({ hasText: name }).click()
    await wait(80)
    const shown = await win.locator('.settings-page:visible').count()
    const text = await win.locator('.settings-content').innerText()
    const others = Object.entries(fields).filter(([page, field]) => page !== name && text.includes(field)).map(([page]) => page)
    check(`${name}: its own content, nothing else`, shown === 1 && text.includes(fields[name]) && text.startsWith(name) && others.length === 0, others.join(','))
    check(`${name}: marked as selected`, (await win.locator('.settings-nav button[aria-selected=true]').innerText()) === name)
    const fits = await win.locator('.settings-content').evaluate((el) => el.scrollWidth <= el.clientWidth)
    check(`${name}: nothing sticks out sideways`, fits)
    const b = await win.locator('.modal.settings').boundingBox()
    sizes.add(`${b.width}x${b.height}`)
    await win.screenshot({ path: join(tmpdir(), `nixi-e2e-settings-${name.split(' ')[0].toLowerCase()}.png`) })
  }
  check('the window does not jump between pages', sizes.size === 1, [...sizes].join(' '))
  const heights = new Set(await tabs.evaluateAll((els) => els.map((e) => `${e.offsetWidth}x${e.offsetHeight}`)))
  check('the tabs are all one size', heights.size === 1, [...heights].join(' '))

  await tabs.filter({ hasText: 'Macros' }).click()
  await win.keyboard.press('ArrowUp')
  await wait(60)
  check('arrow keys move between pages', (await win.locator('.settings-nav button[aria-selected=true]').innerText()) === 'AI Assistant')
  check('…and focus goes along', await win.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true'))

  const keyField = win.locator('input[name=aiKey]')
  await keyField.fill('half-typed-key')
  await tabs.filter({ hasText: 'Terminal' }).click()
  await win.locator('.settings-content label.field', { hasText: 'Font family' }).locator('input').fill('Menlo')
  await tabs.filter({ hasText: 'AI Assistant' }).click()
  check('moving between pages keeps what was typed', (await keyField.inputValue()) === 'half-typed-key')
  await win.locator('.modal-footer button', { hasText: 'Cancel' }).click()
  await wait()

  await win.locator('.toolbar button[title=Settings]').click()
  check('reopens on the page left last', (await win.locator('.settings-nav button[aria-selected=true]').innerText()) === 'AI Assistant')
  check('Cancel dropped the changes', (await keyField.inputValue()) === '' && (await win.evaluate(() => window.api.getSettings())).fontFamily !== 'Menlo')
  await win.locator('.settings-nav button', { hasText: 'Terminal' }).click()
  const resize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h])
  const before = await win.evaluate(() => [innerWidth, innerHeight])
  await resize(400, 300) // the window stops at its minimum size
  await wait(400)
  const small = await win.evaluate(() => {
    const m = document.querySelector('.modal.settings').getBoundingClientRect()
    const nav = document.querySelector('.settings-nav').getBoundingClientRect()
    const seen = document.querySelector('.settings-nav button:last-child').getBoundingClientRect()
    return { size: [innerWidth, innerHeight], fits: m.left >= 0 && m.top >= 0 && m.right <= innerWidth && m.bottom <= innerHeight, navBottom: seen.bottom, navLimit: nav.bottom }
  })
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-settings-narrow.png') })
  check('the smallest window: it fits, and every tab can be reached', small.fits && small.navBottom <= small.navLimit, JSON.stringify(small))
  await resize(before[0], before[1])
  await wait(300)
  await win.locator('.modal-footer button', { hasText: 'Cancel' }).click()
} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  if (savedClipboard !== undefined) await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedClipboard).catch(() => {})
  await app.close().catch(() => {})
  sshd.kill()
  telnet.close()
  rmSync(userData, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
