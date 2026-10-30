// Macro picker at the cursor (menu "Run Macro at Cursor…" / user-chosen key), about line in the window footer,
// SFTP tab hidden without an SSH connection, macros typed into a password prompt, SFTP icons.
// Local shell + scripts/dev-ssh-server.mjs (started here on port 2298; macOS / Linux).
//   node scripts/e2e-macro.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-macro-'))
const work = mkdtempSync(join(tmpdir(), 'nixi-e2e-macro-out-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
const send = (text) => [{ kind: 'send', text }]
json('sessions.json', [
  { id: 'l1', name: 'shell', type: 'local', folder: '' },
  { id: 's1', name: 'ssh-no-pw', type: 'ssh', folder: '', host: '127.0.0.1', port: 2298, username: 'test', auth: 'password' }
])
const sshd = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', '2298'], { stdio: 'ignore' })
// Trust the dev server's host key up front (the server creates it on first start).
const keyFile = join(tmpdir(), 'nixi-dev-hostkey')
for (let i = 0; i < 50 && !existsSync(keyFile); i++) await new Promise((r) => setTimeout(r, 100))
const hostKey = ssh2.utils.parseKey(readFileSync(keyFile))
json('known_hosts.json', { '[127.0.0.1]:2298': 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '') })
json('macros.json', [
  { id: 'm1', name: 'first', steps: send(`echo one > ${join(work, 'one.txt')}\r`) },
  { id: 'm2', name: 'second', steps: send(`echo two > ${join(work, 'two.txt')}\r`), hotkey: 'Ctrl+Alt+2' },
  { id: 'm3', name: 'deploy app', steps: send(`echo three > ${join(work, 'three.txt')}\r`) },
  { id: 'm4', name: 'ssh password', steps: send('test\r') }
])

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFile = async (f) => {
  for (let i = 0; i < 30 && !existsSync(f); i++) await sleep(200)
  return existsSync(f) && readFileSync(f, 'utf8').trim()
}

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' } })
const menu = (cmd) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', c), cmd)
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')

  // About line: on the welcome screen under the buttons (no footer bar), not in the sidebar.
  const about = win.locator('.welcome .about-line')
  const vp = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  const aboutBox = await about.boundingBox()
  const actions = await win.locator('.welcome-actions').boundingBox()
  check('about line sits under the welcome buttons', aboutBox && aboutBox.y >= actions.y + actions.height && Math.abs(aboutBox.x + aboutBox.width / 2 - (actions.x + actions.width / 2)) <= 2)
  check('no footer bar', (await win.locator('.app-footer').count()) === 0)
  const aboutText = await about.innerText()
  check('about line is just "v… by Thao Pham"', /^v\d+\.\d+\.\d+ by Thao Pham$/.test(aboutText.trim()), JSON.stringify(aboutText))
  await about.locator('button').click()
  const popup = (await win.locator('.about-popup').innerText()).replace(/\s+/g, ' ')
  const once = (t) => popup.split(t).length === 2
  check('click shows the details, each once', once('Thao Pham') && once('thaopham.cyber@gmail.com') && once('Electron'), JSON.stringify(popup))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-macro-about.png') })
  await win.keyboard.press('Escape')
  check('Esc closes it', (await win.locator('.about-popup').count()) === 0)
  await about.locator('button').click()
  await win.mouse.click(vp.w / 2, 60)
  check('click outside closes it', (await win.locator('.about-popup').count()) === 0)
  const menuLabels = await app.evaluate(({ Menu }) => {
    const find = (m) => m.items.flatMap((i) => [i.label, ...(i.submenu ? find(i.submenu) : [])])
    return find(Menu.getApplicationMenu())
  })
  check('no Quick connect anywhere', (await win.locator('.toolbar input').count()) === 0 && !menuLabels.some((l) => /quick/i.test(l)) && !/quick/i.test(await win.locator('body').innerText()))
  check('app is called Nixi', (await win.title()) === 'Nixi' && menuLabels.includes('Nixi') && (await win.locator('.welcome h1').innerText()).startsWith('Nixi'))
  check('no about line in the sidebar', (await win.locator('.sidebar .about-line').count()) === 0)
  check('SFTP tab hidden with no tab open', (await win.locator('.sidebar-tabs button', { hasText: 'SFTP' }).count()) === 0)

  await win.locator('.tree-row', { hasText: 'shell' }).last().dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  check('SFTP tab hidden on a local shell', (await win.locator('.sidebar-tabs button', { hasText: 'SFTP' }).count()) === 0)
  await menu('toggleSftp')
  await sleep(200)
  check('toggle SFTP on a local shell keeps the session list', (await win.locator('.session-tree').count()) === 1)

  await sleep(1500)
  await win.locator('.tab-view:visible .term-container').click()
  await win.keyboard.type('clear; echo ready\r')
  await sleep(500)

  // Opens at the cursor, arrow keys + Enter run the 2nd macro.
  await menu('macroPicker')
  const picker = win.locator('.macro-picker')
  await picker.waitFor({ timeout: 5000 })
  const box = await picker.boundingBox()
  // xterm keeps its helper textarea on the cursor cell.
  const cursor = await win.locator('.tab-view:visible .xterm-helper-textarea').boundingBox()
  const dx = box.x - cursor.x
  const dy = box.y - (cursor.y + cursor.height)
  check('picker opens right under the cursor', Math.abs(dx) < 12 && dy >= 0 && dy < 12, `(dx ${Math.round(dx)}, dy ${Math.round(dy)})`)
  const items = await win.locator('.macro-picker-item .name').allInnerTexts()
  check('lists macros in their order', JSON.stringify(items) === '["first","second","deploy app","ssh password"]', JSON.stringify(items))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-macro-picker.png') })
  await win.keyboard.press('ArrowDown')
  check('arrow moves the selection', (await win.locator('.macro-picker-item.selected .name').innerText()) === 'second')
  await win.keyboard.press('Enter')
  check('Enter runs the selected macro', (await waitFile(join(work, 'two.txt'))) === 'two')
  check('picker closes after running', (await picker.count()) === 0)

  // Number key runs directly; focus is back in the terminal afterwards.
  await menu('macroPicker')
  await picker.waitFor()
  await win.keyboard.press('3')
  check('number key runs that macro', (await waitFile(join(work, 'three.txt'))) === 'three')
  await win.keyboard.type('echo back-in-terminal > ' + join(work, 'focus.txt') + '\r')
  check('focus returns to the terminal', (await waitFile(join(work, 'focus.txt'))) === 'back-in-terminal')

  // Typing filters; Escape closes without running anything.
  await menu('macroPicker')
  await picker.waitFor()
  await win.keyboard.type('dep')
  const filtered = await win.locator('.macro-picker-item .name').allInnerTexts()
  check('typing filters the list (numbers kept)', JSON.stringify(filtered) === '["deploy app"]' && (await win.locator('.macro-picker-item .num').innerText()) === '3')
  await win.keyboard.press('Escape')
  await sleep(300)
  check('Escape closes the picker', (await picker.count()) === 0)
  check('Escape did not run a macro', !existsSync(join(work, 'one.txt')))

  // The key that opens the list is the user's choice (Settings → Macros).
  const term = win.locator('.tab-view:visible .term-container')
  const def = process.platform === 'darwin' ? 'Meta+KeyJ' : 'Control+Shift+KeyJ'
  await term.click()
  await win.keyboard.press(def)
  await picker.waitFor({ timeout: 3000 }).catch(() => {})
  check(`default key ${def} opens the list`, (await picker.count()) === 1)
  await win.keyboard.press('Escape')
  await menu('settings')
  const field = win.locator('.modal label.field', { hasText: 'macro list at the cursor' }).locator('input')
  await field.click()
  await win.keyboard.press('Control+Alt+KeyK')
  check('settings records the new key', (await field.inputValue()) === 'Ctrl+Alt+K', await field.inputValue())
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-macro-settings.png') })
  await win.locator('.modal button', { hasText: 'Save' }).click()
  await sleep(300)
  const accel = await app.evaluate(({ Menu }) => {
    const find = (m) => m.items.flatMap((i) => [i, ...(i.submenu ? find(i.submenu) : [])])
    return find(Menu.getApplicationMenu()).find((i) => i.label.startsWith('Run Macro at Cursor'))?.accelerator
  })
  check('menu shows the new key', accel === 'Ctrl+Alt+K', String(accel))
  await term.click()
  await win.keyboard.press(def)
  await sleep(400)
  check('old key no longer opens it', (await picker.count()) === 0)
  await win.keyboard.press('Control+Alt+KeyK')
  await picker.waitFor({ timeout: 3000 }).catch(() => {})
  check('new key opens it', (await picker.count()) === 1)
  await win.keyboard.press('1')
  check('…and runs from there', (await waitFile(join(work, 'one.txt'))) === 'one')

  // Space works as the key too (with a modifier).
  await menu('settings')
  await field.click()
  await win.keyboard.press('Alt+Space')
  check('Alt+Space can be recorded', (await field.inputValue()) === 'Alt+Space', JSON.stringify(await field.inputValue()))
  await win.locator('.modal button', { hasText: 'Save' }).click()
  await sleep(300)
  await term.click()
  await win.keyboard.press('Alt+Space')
  await picker.waitFor({ timeout: 3000 }).catch(() => {})
  check('Alt+Space opens the list', (await picker.count()) === 1)
  await win.keyboard.press('Escape')

  // Any combination, even one the app menu uses (⌘W = Close Tab): recorded through the main
  // process, then the menu item gives the key up.
  const closeKey = process.platform === 'darwin' ? ['Meta+KeyW', 'Cmd+W'] : ['Control+Shift+KeyW', 'Ctrl+Shift+W']
  await menu('settings')
  await field.click()
  await win.evaluate(() => {
    window.__pageKeys = 0
    addEventListener('keydown', (e) => !['Meta', 'Control', 'Shift', 'Alt'].includes(e.key) && window.__pageKeys++, true)
  })
  // Native input (Playwright's own key events skip before-input-event, real keys do not).
  await app.evaluate(({ BrowserWindow }, mods) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: mods })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: mods })
  }, process.platform === 'darwin' ? ['meta'] : ['control', 'shift'])
  await sleep(300)
  check(`menu key ${closeKey[1]} can be recorded`, (await field.inputValue()) === closeKey[1], JSON.stringify(await field.inputValue()))
  check('the key went through the main process (page never saw it)', (await win.evaluate(() => window.__pageKeys)) === 0)
  await win.locator('.modal button', { hasText: 'Save' }).click()
  await sleep(300)
  const closeAccel = await app.evaluate(({ Menu }) => {
    const find = (m) => m.items.flatMap((i) => [i, ...(i.submenu ? find(i.submenu) : [])])
    const all = find(Menu.getApplicationMenu())
    return { close: all.find((i) => i.label === 'Close Tab')?.accelerator ?? null, picker: all.find((i) => i.label.startsWith('Run Macro'))?.accelerator }
  })
  check('Close Tab gives its shortcut up', closeAccel.close === null, JSON.stringify(closeAccel))
  const tabsBefore = await win.locator('.tab').count()
  await term.click()
  await win.keyboard.press(closeKey[0])
  await picker.waitFor({ timeout: 3000 }).catch(() => {})
  check(`${closeKey[1]} now opens the list`, (await picker.count()) === 1)
  check('…and the tab stays open', (await win.locator('.tab').count()) === tabsBefore)
  await win.keyboard.press('Escape')
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-macro.png') })

  // Macros work outside the terminal too: the password prompt of an SSH session.
  await win.locator('.tree-row', { hasText: 'ssh-no-pw' }).last().dblclick()
  const pw = win.locator('.modal input[type=password]')
  await pw.waitFor({ timeout: 15000 })
  await win.keyboard.press(closeKey[0])
  await picker.waitFor({ timeout: 3000 }).catch(() => {})
  const pBox = await picker.boundingBox().catch(() => null)
  const fBox = await pw.boundingBox()
  check('picker opens under the password field', !!pBox && Math.abs(pBox.x - fBox.x) < 12 && pBox.y >= fBox.y + fBox.height - 1, JSON.stringify({ pBox, fBox }))
  await win.keyboard.press('Escape')
  await sleep(200)
  check('Escape closes the picker, not the prompt', (await picker.count()) === 0 && (await pw.count()) === 1)
  check('focus goes back to the field', await pw.evaluate((e) => e === document.activeElement))
  await win.keyboard.press(closeKey[0])
  await picker.waitFor({ timeout: 3000 })
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-macro-prompt.png') })
  await win.keyboard.press('4')
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 10000 }).catch(() => {})
  check('macro typed the password and pressed Enter', (await pw.count()) === 0 && (await win.locator('.tab.active .dot.connected').count()) === 1)

  // SFTP list uses the same 2D folder icons as the session tree, toolbar line icons, no emoji.
  await win.locator('.sidebar-tabs button', { hasText: 'SFTP' }).click()
  await win.locator('.sftp-list tbody tr').nth(1).waitFor({ timeout: 10000 })
  const sftpText = await win.locator('.sftp').innerText()
  check('SFTP rows have svg icons', (await win.locator('.sftp-list td.name svg.ico').count()) >= 2)
  check('SFTP has no emoji icons', !/[📁📄🗑⬆⟳⤒⤓]/u.test(sftpText), JSON.stringify(sftpText.slice(0, 80)))
  check('SFTP toolbar uses line icons', (await win.locator('.sftp-toolbar svg.tool-ico').count()) === 7)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-macro-sftp.png') })
} catch (err) {
  check('unexpected error', false, err.message)
  await app.windows()[0]?.screenshot({ path: join(tmpdir(), 'nixi-e2e-macro-error.png') }).catch(() => {})
} finally {
  await app.close()
  sshd.kill()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}
console.log(`Screenshots: ${join(tmpdir(), 'nixi-e2e-macro*.png')}`)
process.exit(results.every(Boolean) ? 0 : 1)
