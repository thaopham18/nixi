// Selecting several sessions and dragging them into folders; macros that are a long block of text.
//   npm run build && node scripts/e2e-organize.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'
import { readDb } from './read-db.mjs'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  if (!ok) failed++
}

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-organize-'))
const work = mkdtempSync(join(tmpdir(), 'nixi-e2e-organize-work-'))
// An empty ZDOTDIR: the user's own shell setup is not part of the test.
const zdot = mkdtempSync(join(tmpdir(), 'nixi-e2e-organize-zsh-'))
const shell = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash'
const local = (id, folder = '') => ({ id, name: id, type: 'local', folder, shell })
writeFileSync(join(userData, 'sessions.json'), JSON.stringify([local('s1'), local('s2'), local('s3'), local('s4'), local('s5'), local('kept', 'Target'), local('inside', 'Deep/Down')]))

// Ctrl+click is a right-click on macOS.
const toggle = process.platform === 'darwin' ? 'Meta' : 'Control'
const stored = () => readDb(join(userData, 'nixi.nxdb'), 'e2e-master')
const folderOf = (id) => stored().sessions.find((s) => s.id === id)?.folder

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master', ZDOTDIR: zdot } })
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')
  const wait = (ms = 300) => win.waitForTimeout(ms)
  const name = (n) => ({ has: win.locator('.tree-name', { hasText: new RegExp(`^${n}$`) }) })
  const row = (n) => win.locator('.tree-row:not(.folder)', name(n)).last()
  const folder = (n) => win.locator('.tree-row.folder', name(n))
  const selectedNames = () => win.locator('.tree-row.selected .tree-name').allInnerTexts()
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

  console.log('--- selecting')
  await row('s1').click()
  check('click selects one', same(await selectedNames(), ['s1']))
  await row('s3').click({ modifiers: [toggle] })
  check('Cmd/Ctrl+click adds', same(await selectedNames(), ['s1', 's3']))
  await row('s1').click({ modifiers: [toggle] })
  check('…and takes away', same(await selectedNames(), ['s3']))
  await row('s3').click()
  await row('s5').click({ modifiers: ['Shift'] })
  check('Shift+click selects the range', same(await selectedNames(), ['s3', 's4', 's5']))

  console.log('--- dragging')
  await row('s4').dragTo(folder('Target'))
  await wait()
  check('dragging one of the selection moves all of it', ['s3', 's4', 's5'].every((id) => folderOf(id) === 'Target'), JSON.stringify(stored().sessions.map((s) => [s.id, s.folder])))
  check('…others stay', folderOf('s1') === '' && folderOf('s2') === '' && folderOf('kept') === 'Target')
  check('…selection is kept', same(await selectedNames(), ['s3', 's4', 's5']))

  await row('s1').dragTo(folder('Target'))
  await wait()
  check('dragging an unselected row moves only that row', folderOf('s1') === 'Target' && folderOf('s2') === '' && folderOf('s3') === 'Target')
  check('…and selects it', same(await selectedNames(), ['s1']))

  await row('s3').click()
  await row('s4').click({ modifiers: [toggle] })
  await folder('Down').click() // collapse the target
  await row('s4').dragTo(folder('Down'))
  await wait()
  check('into a subfolder', folderOf('s3') === 'Deep/Down' && folderOf('s4') === 'Deep/Down')
  check('…a collapsed folder opens so they stay in sight', await row('s3').isVisible())

  await row('s3').click()
  await row('s4').click({ modifiers: [toggle] })
  await row('s4').dragTo(row('kept'))
  await wait()
  check('dropped on a session: goes to its folder', folderOf('s3') === 'Target' && folderOf('s4') === 'Target')

  await row('s3').click()
  await row('s4').click({ modifiers: [toggle] })
  const tree = await win.locator('.tree').boundingBox()
  await row('s4').dragTo(win.locator('.tree'), { targetPosition: { x: tree.width / 2, y: tree.height - 10 } })
  await wait()
  check('dropped on the empty area: top level', folderOf('s3') === '' && folderOf('s4') === '')

  await row('s3').click()
  await row('s4').click({ modifiers: [toggle] })
  await row('s4').dragTo(folder('Target'))
  await wait()
  await win.locator('.sidebar-search input').fill('s3')
  await wait(100)
  check('search hides a selected row: only what shows stays selected', same(await selectedNames(), ['s3']))
  const box = await win.locator('.tree').boundingBox()
  await row('s3').dragTo(win.locator('.tree'), { targetPosition: { x: box.width / 2, y: box.height - 10 } })
  await wait()
  check('…and a drag leaves the hidden one alone', folderOf('s3') === '' && folderOf('s4') === 'Target')
  await win.locator('.sidebar-search input').fill('')

  console.log('--- menu of a selection')
  await row('s1').click()
  await row('s2').click({ modifiers: [toggle] })
  await row('s2').click({ button: 'right' })
  const items = await win.locator('.context-menu .item').allInnerTexts()
  check('offers connect and delete for all', items.includes('Connect 2 sessions') && items.includes('Delete 2 sessions'), items.join(' | '))
  await win.locator('.context-menu .item', { hasText: 'Connect 2' }).click()
  await wait(500)
  check('…connects both', (await win.locator('.tab').count()) === 2)
  await app.evaluate(({ BrowserWindow }) => {
    const c = BrowserWindow.getAllWindows()[0].webContents
    c.send('menu:cmd', 'closeTab')
    c.send('menu:cmd', 'closeTab')
  })
  await wait()

  console.log('--- dragging several into a tab: split')
  await row('kept').dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 10000 })
  await row('s1').click()
  await row('s2').click({ modifiers: [toggle] })
  await row('s2').hover()
  await win.mouse.down()
  const view = await win.locator('.tab-view:visible').boundingBox()
  await win.mouse.move(view.x + 50, view.y + view.height / 2, { steps: 4 })
  await win.locator('.drop-zone').first().waitFor({ timeout: 3000 }).catch(() => {})
  await win.locator('.drop-zone.right').hover({ force: true }).catch(() => {})
  await win.mouse.up()
  await wait(800)
  check('both open next to the session in the tab', (await win.locator('.tab-view:visible .xterm').count()) === 3, String(await win.locator('.tab-view:visible .xterm').count()))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'closeTab'))
  await wait()

  console.log('--- text macro')
  const macroButton = win.locator('.toolbar button[title=Macros]')
  const manage = async () => {
    await macroButton.click()
    await win.locator('.context-menu .item', { hasText: 'Manage macros' }).click()
    await win.waitForSelector('.macro-layout')
  }
  const modal = win.locator('.modal')
  const closeModal = () => modal.locator('.modal-header button').click()
  const lines = ['#!/bin/sh', '', '    indented by four', '> not a step', 'wait 500', '# not a comment', "it's \"quoted\" $HOME \\n", ...Array.from({ length: 300 }, (_v, i) => `line ${i}`)]
  const text = lines.join('\n')

  const makeText = async (macroName, body, enter) => {
    await modal.locator('button', { hasText: 'New macro' }).click()
    await modal.locator('.macro-editor input').first().fill(macroName)
    await modal.locator('.type-picker button', { hasText: 'Text' }).click()
    await modal.locator('textarea[name=macroBody]').fill(body)
    if (enter) await modal.locator('label.check', { hasText: 'Press Enter' }).locator('input').check()
    await modal.locator('.row.end button', { hasText: /^Save$/ }).click()
    await wait()
  }
  const a = join(work, 'a')
  const b = join(work, 'b')
  await manage()
  await makeText('long', text, false)
  check('stored as one paste', JSON.stringify(stored().macros.at(-1).steps) === JSON.stringify([{ kind: 'paste', text }]))
  await makeText('script', `touch ${a}\ntouch ${b}`, false)
  await makeText('script-enter', `touch ${a}\ntouch ${b}`, true)
  await makeText('risky', `ls\nrm -f ${join(work, 'risky')}`, true)
  await modal.locator('.macro-row', { hasText: 'long' }).click()
  check('reopened in the Text view, text intact', (await modal.locator('textarea[name=macroBody]').inputValue()) === text)
  await win.screenshot({ path: join(tmpdir(), 'nixi-macro-text.png') })
  await modal.locator('.type-picker button', { hasText: 'Commands' }).click()
  check('Commands view shows it as a block', (await modal.locator('textarea[name=macroSteps]').inputValue()).startsWith('paste <<END\n#!/bin/sh\n'))
  await modal.locator('.macro-row', { hasText: 'script-enter' }).click()
  check('Enter checkbox comes back', await modal.locator('label.check', { hasText: 'Press Enter' }).locator('input').isChecked())
  await closeModal()
  await wait()

  const run = async (macroName) => {
    await macroButton.click()
    await win.locator('.context-menu .item', { hasText: new RegExp(`${macroName}$`) }).click()
    await wait(500)
  }
  await row('s1').dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 10000 })
  await wait(800)
  await run('script')
  check('in the shell: pasted, nothing runs yet', !existsSync(a) && !existsSync(b))
  await win.keyboard.press('Enter')
  await wait(500)
  check('…Enter runs all of it', existsSync(a) && existsSync(b))
  rmSync(a)
  rmSync(b)
  await run('script-enter')
  await wait(300)
  check('with "Press Enter after it": runs by itself', existsSync(a) && existsSync(b))

  await run('risky')
  check('dangerous text: the warning still asks', await win.locator('.modal', { hasText: 'Dangerous command' }).waitFor({ timeout: 2000 }).then(() => true, () => false))
  await win.locator('.modal button', { hasText: 'Cancel' }).click()
  await wait()

  const copy = join(work, 'copy')
  await win.keyboard.type(`cat > ${copy}`)
  await win.keyboard.press('Enter')
  await wait()
  await run('long')
  await wait(1500)
  await win.keyboard.press('Enter')
  await win.keyboard.press('Control+D')
  await wait(800)
  const got = existsSync(copy) ? readFileSync(copy, 'utf8') : ''
  check('300 lines into a program reading stdin: every byte arrives', got === text + '\n', `${got.length} of ${text.length + 1} bytes`)

  // Into a text field: a one-line field must not submit half of it.
  await row('s2').click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: /^Edit/ }).click()
  await win.waitForSelector('.modal input')
  const nameField = modal.locator('input').first()
  await nameField.fill('')
  await nameField.focus()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'macroPicker'))
  await win.waitForSelector('.macro-picker input')
  await win.keyboard.type('script')
  await win.keyboard.press('Enter')
  await wait(300)
  check('in a one-line field: lines joined, dialog stays open', (await nameField.inputValue()) === `touch ${a} touch ${b}` && (await modal.count()) === 1, await nameField.inputValue().catch(() => ''))
} finally {
  await app.close()
  for (const d of [userData, work, zdot]) rmSync(d, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
