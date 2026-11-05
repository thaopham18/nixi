// The app without a mouse: arrows and Enter on rows, buttons and dialogs; the paste review dialog.
// POSIX shells only.
//   npm run build && node scripts/e2e-keys.mjs
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-keys-'))
const SSH = 2286
const sshd = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', String(SSH)], { stdio: 'ignore' })
for (let i = 0; i < 100; i++) {
  const open = await new Promise((r) => {
    const c = connect(SSH, '127.0.0.1')
    c.once('connect', () => (c.destroy(), r(true)))
    c.once('error', () => r(false))
  })
  if (open) break
  await sleep(100)
}
writeFileSync(join(userData, 'secrets.json'), JSON.stringify({ s: 'raw:' + Buffer.from('test').toString('base64'), t: 'raw:' + Buffer.from('test').toString('base64') }))
writeFileSync(
  join(userData, 'sessions.json'),
  JSON.stringify([
    { id: 'f1', name: 'inner', type: 'local', folder: 'Group' },
    { id: 'l', name: 'shell', type: 'local', folder: '' },
    { id: 's', name: 'remote', type: 'ssh', folder: '', host: '127.0.0.1', port: SSH, username: 'test', auth: 'password' },
    { id: 't', name: 'remote2', type: 'ssh', folder: '', host: '127.0.0.1', port: SSH, username: 'test', auth: 'password' }
  ])
)
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ gpuRendering: false, warnMultilinePaste: true, rightClickPaste: true }))
const env = { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' }

const app = await electron.launch({ args: ['.'], env })
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')
  const key = (k) => win.keyboard.press(k)
  const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) return false
      await sleep(60)
    }
  }
  const text = () => win.evaluate(() => [...document.querySelectorAll('.xterm-rows')].find((e) => e.getBoundingClientRect().width > 0)?.innerText ?? '')
  const sees = (re, ms) => until(async () => re.test(await text()), ms)
  const focusText = () => win.evaluate(() => document.activeElement?.innerText?.trim().split('\n')[0] ?? '')
  const focusIs = (want) => until(async () => (await focusText()) === want, 1500)
  const inTerminal = () => until(() => win.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), 1500)
  const cmd = (name) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', c), name)
  const modal = win.locator('.modal')
  const modalGone = () => until(async () => (await modal.count()) === 0, 2000)

  console.log('--- the session list')
  await win.locator('.tree-row', { hasText: /^Group/ }).focus()
  check('a folder row takes the focus', (await focusText()) === 'Group', await focusText())
  await key('ArrowLeft')
  await until(() => win.locator('.tree-row[aria-expanded="false"]').count())
  check('← closes the folder', (await win.locator('.tree-row[aria-expanded="false"]').count()) === 1)
  await key('ArrowRight')
  await until(() => win.locator('.tree-row[aria-expanded="true"]').count())
  check('→ opens it', (await win.locator('.tree-row[aria-expanded="true"]').count()) === 1)
  await key('ArrowDown')
  check('↓ goes to the row under it', await focusIs('inner'), await focusText())
  await key('ArrowDown')
  check('↓ again', await focusIs('remote'), await focusText())
  await key('ArrowUp')
  await key('ArrowUp')
  await key('ArrowUp')
  check('↑ from the top row reaches the search box', await until(() => win.evaluate(() => document.activeElement?.placeholder === 'Search sessions…'), 1000))
  await key('ArrowDown')
  check('↓ from the search box comes back', await focusIs('Group'), await focusText())
  await key('ArrowDown')
  await key('ArrowDown')
  await key('Shift+F10')
  await win.locator('.context-menu').waitFor()
  check('Shift+F10 opens the row menu', (await win.locator('.context-menu .item').count()) > 1)
  await key('Escape')
  await key('Tab')
  check('Tab leaves the list instead of stopping on every row', !/^(remote|remote2|inner|Group)$/.test(await focusText()), await focusText())
  await win.locator('.tree-row', { hasText: /^shell/ }).focus()
  await key(' ')
  await until(() => win.locator('.tree-row.selected', { hasText: /^shell/ }).count())
  check('Space selects', (await win.locator('.tree-row.selected', { hasText: /^shell/ }).count()) === 1)
  await key('Enter')
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  check('Enter opens the session', true)
  await win.locator('.tab-view:visible .term-container').first().click()
  await sleep(400)
  await win.keyboard.type("exec bash --norc --noprofile\n")
  await sleep(300)
  await win.keyboard.type("PS1='$ '\nclear\n")
  await sleep(300)

  console.log('--- moving between areas')
  await cmd('nextArea')
  check('Next Area leaves the terminal for the toolbar', await until(() => win.evaluate(() => !!document.activeElement?.closest('.toolbar')), 1500))
  const firstButton = await focusText()
  await key('ArrowRight')
  check('→ walks the toolbar', (await focusText()) !== firstButton, await focusText())
  await key('Escape')
  check('Esc goes back to the terminal', await inTerminal())
  await cmd('nextArea')
  await cmd('nextArea')
  check('…then the sidebar', await until(() => win.evaluate(() => !!document.activeElement?.closest('.sidebar')), 1500))
  await cmd('nextArea')
  check('…then the tabs', await until(() => win.evaluate(() => !!document.activeElement?.closest('.tabbar')), 1500))
  await cmd('nextArea')
  check('…then the terminal again', await inTerminal())

  console.log('--- a dialog opened from the terminal')
  await cmd('settings')
  await modal.waitFor()
  check('takes the keys away from the terminal', await until(() => win.evaluate(() => !!document.activeElement?.closest('.modal')), 1500))
  await key('Escape')
  await modalGone()
  check('closing gives them back', await inTerminal())
  await sleep(100)

  console.log('--- pasting several lines')
  const clip = (t) => app.evaluate(({ clipboard }, x) => clipboard.writeText(x), t)
  const pasteBox = win.locator('.paste-dialog textarea')
  const rightClick = () => win.locator('.tab-view:visible .term-container').first().click({ button: 'right' })
  await clip('echo single-line-ok')
  await rightClick()
  check('one line: no dialog', await sees(/\$ echo single-line-ok/))
  check('…no dialog came', (await modal.count()) === 0)
  await key('Control+U')
  await clip('echo line-one\necho line-two\n')
  await rightClick()
  await pasteBox.waitFor()
  check('several lines: shown in a dialog', (await pasteBox.inputValue()) === 'echo line-one\necho line-two\n', await pasteBox.inputValue())
  check('…counted', /Paste 2 lines/.test(await win.locator('.modal-header').innerText()))
  check('…saying where it goes', /Into shell/.test(await modal.innerText()), await modal.innerText())
  check('…ready to edit', await win.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-paste.png') })
  check('nothing has gone to the terminal yet', !/line-one/.test(await text()))
  await key('Escape')
  await modalGone()
  check('Esc: nothing pasted', !/line-one/.test(await text()), await text())
  check('…keys back in the terminal', await inTerminal())
  await rightClick()
  await pasteBox.waitFor()
  await pasteBox.fill('echo edited-one\necho edited-two\necho edited-three\n')
  check('the title follows the edit', /Paste 3 lines/.test(await win.locator('.modal-header').innerText()))
  await key(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  await modalGone()
  check('the edited text is what runs', await sees(/^edited-three\s*$/m), await text())
  check('…not what was on the clipboard', !/line-one/.test(await text()))
  await rightClick()
  await pasteBox.waitFor()
  await pasteBox.fill('')
  check('emptied: Paste is off', await win.locator('.modal-footer button', { hasText: 'Paste' }).isDisabled())
  await pasteBox.fill('echo by-button-a\necho by-button-b\n')
  await key('Tab')
  await key('Tab')
  check('Tab reaches the buttons', /Cancel|Paste/.test(await focusText()), await focusText())
  await win.locator('.modal-footer button', { hasText: 'Cancel' }).focus()
  await key('ArrowRight')
  check('→ goes to Paste', await focusIs('Paste'), await focusText())
  await key('Enter')
  await modalGone()
  check('Paste button works by keyboard', await sees(/^by-button-b\s*$/m), await text())

  console.log('--- yes or no')
  await cmd('macros')
  await modal.first().waitFor()
  await win.locator('.modal button', { hasText: 'New macro' }).click().catch(() => {})
  await win.locator('.modal input').first().fill('to-delete')
  await win.locator('.modal-footer button, .modal button', { hasText: /^Save$/ }).first().click()
  await until(() => win.locator('.macro-row', { hasText: 'to-delete' }).count())
  await win.locator('.modal button.danger', { hasText: 'Delete' }).click()
  const asks = win.locator('.modal', { hasText: 'Delete macro "to-delete"' })
  await asks.waitFor()
  check('delete asks in the app dialog, on Cancel', await focusIs('Cancel'), await focusText())
  await key('Tab')
  check('Tab stays in the top dialog', await win.evaluate(() => !!document.activeElement?.closest('.modal')?.innerText.includes('to-delete')))
  await win.locator('.modal-footer button', { hasText: 'Cancel' }).last().focus()
  await key('Escape')
  await until(async () => (await asks.count()) === 0, 1000)
  check('Esc closes only that one', (await modal.count()) === 1, String(await modal.count()))
  await win.locator('.modal button.danger', { hasText: 'Delete' }).click()
  await asks.waitFor()
  await key('ArrowRight')
  check('→ to Delete', await focusIs('Delete'), await focusText())
  await key('Enter')
  await until(async () => (await win.locator('.macro-row', { hasText: 'to-delete' }).count()) === 0)
  check('Enter deletes', (await win.locator('.macro-row', { hasText: 'to-delete' }).count()) === 0)
  await key('Escape')
  await modalGone()

  console.log('--- host keys ask in the app too')
  const unknown = win.locator('.modal', { hasText: "can't be established" })
  // Both at once, before the first one's question covers the list.
  await win.evaluate(() => {
    for (const row of document.querySelectorAll('.tree-row[title*="@127.0.0.1"]')) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await unknown.waitFor({ timeout: 15000 })
  check('unknown host: on the Trust button', await focusIs('Trust & connect'), await focusText())
  check('…shows the fingerprint', /SHA256:/.test(await unknown.innerText()))
  await key('ArrowLeft')
  check('← to Cancel', await focusIs('Cancel'), await focusText())
  await key('ArrowRight')
  await key('Enter')
  check('a second asking is not lost', await until(async () => (await unknown.count()) === 1 || (await win.locator('.tab.active .dot.connected').count()) === 1, 5000))
  if (await unknown.count()) await key('Enter')
  check('Trust by keyboard connects', await until(async () => (await win.locator('.tab.active .dot.connected').count()) === 1, 15000))

  console.log('--- turned off')
  await cmd('settings')
  await modal.waitFor()
  await win.locator('.modal [role=tab]', { hasText: 'Keyboard' }).click()
  await win.locator('.modal label', { hasText: 'Show multiple lines before pasting' }).click()
  await win.locator('.modal-footer button', { hasText: /^Save/ }).click()
  await modalGone()
  await win.locator('.tab-view:visible .term-container').first().click()
  await clip('echo direct-one\necho direct-two\n')
  await rightClick()
  check('setting off: goes straight in', await sees(/direct-two/))
  check('…with no dialog', (await pasteBox.count()) === 0)
} catch (err) {
  failed++
  console.log('FAIL  stopped:', err.message)
  await (await app.firstWindow()).screenshot({ path: join(tmpdir(), 'nixi-e2e-keys-fail.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
  sshd.kill()
  rmSync(userData, { recursive: true, force: true })
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
