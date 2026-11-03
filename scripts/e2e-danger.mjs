// Dangerous command warning in a real local shell: Enter is held until the user answers. rm on a
// throwaway file shows whether the command really ran. POSIX shells only (not PowerShell yet).
//   npm run build && node scripts/e2e-danger.mjs
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  if (!ok) failed++
}

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-danger-'))
const work = mkdtempSync(join(tmpdir(), 'nixi-e2e-danger-work-'))
const victim = join(work, 'victim.txt')
const plant = () => writeFileSync(victim, 'x')
const marker = (name) => join(work, name)

writeFileSync(join(userData, 'sessions.json'), JSON.stringify([{ id: 'local', name: 'local-box', type: 'local', folder: '', shell: '/bin/bash' }]))
writeFileSync(
  join(userData, 'macros.json'),
  JSON.stringify([
    { id: 'm-safe', name: 'safe-macro', steps: [{ kind: 'send', text: `touch ${marker('safe-macro')}\r` }] },
    { id: 'm-bad', name: 'bad-macro', steps: [{ kind: 'send', text: `rm -f ${victim}\r` }] }
  ])
)

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master' } })
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')
  const dialog = win.locator('.modal', { hasText: 'Dangerous command' })
  const wait = (ms = 400) => win.waitForTimeout(ms)
  const shown = () => dialog.waitFor({ timeout: 2500 }).then(() => true, () => false)
  const none = async () => {
    await wait()
    return (await dialog.count()) === 0
  }
  const answer = async (label) => {
    await dialog.locator('button', { hasText: label }).click()
    await wait()
  }
  const type = async (text) => win.keyboard.type(text)
  const enter = () => win.keyboard.press('Enter')
  const clearLine = () => win.keyboard.press('Control+U')

  await win.locator('.tree-row', { hasText: 'local-box' }).dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 10000 })
  await wait(800)

  console.log('--- typed commands')
  await type(`touch ${marker('safe')}`)
  await enter()
  await wait()
  check('harmless command runs without a dialog', existsSync(marker('safe')) && (await none()))

  plant()
  await type(`rm -f ${victim}`)
  await enter()
  check('rm -f: asks', await shown())
  const text = await dialog.innerText()
  await win.screenshot({ path: join(tmpdir(), 'nixi-danger.png') })
  check('…says why, where, and shows the command', /Deletes files/.test(text) && text.includes('local-box') && text.includes(`rm -f ${victim}`))
  check('…nothing ran yet', existsSync(victim))
  check('…Cancel has the focus, so a second Enter is safe', (await win.evaluate(() => document.activeElement?.textContent)) === 'Cancel')
  await enter()
  await wait()
  check('…Enter on the dialog cancels', (await dialog.count()) === 0 && existsSync(victim))
  check('…focus is back in the terminal', await win.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')))

  await enter()
  check('the command is still on the prompt: Enter asks again', await shown())
  await answer('Run anyway')
  check('Run anyway runs it', !existsSync(victim))

  plant()
  await type(`rm -f ${victim}`)
  await enter()
  await shown()
  await win.keyboard.press('Escape')
  await wait()
  check('Esc cancels', existsSync(victim))
  await clearLine()

  console.log('--- commands the keystrokes do not show')
  await type(`rm -f ${victim}`)
  await win.keyboard.press('Control+C')
  await wait()
  await type(`touch ${marker('after-ctrl-c')}`)
  await enter()
  await wait()
  check('Ctrl-C drops the line: the next command runs', existsSync(marker('after-ctrl-c')) && (await none()))

  await type(`printf 'rm -f ${victim}' > /dev/null`)
  await enter()
  await wait()
  check('printf naming it: no dialog', await none())

  plant()
  await type(`rm -f ${victim}`)
  await enter()
  await shown()
  await answer('Run anyway')
  plant()
  await win.keyboard.press('ArrowUp')
  await wait()
  await enter()
  check('recalled from history (keystrokes show nothing): asks', await shown())
  check('…nothing ran', existsSync(victim))
  await answer('Cancel')
  await clearLine()

  await type('rm \\')
  await enter()
  await wait()
  check('first line of a continued command runs nothing yet: no dialog', await none())
  await type(`-f ${victim}`)
  await enter()
  check('command continued with a backslash: asks on the last line', await shown())
  await answer('Cancel')
  await win.keyboard.press('Control+C')
  await wait()

  console.log('--- full-screen programs')
  await type(`printf '\\033[?1049h'; read x; printf '\\033[?1049l'; touch ${marker('alt-done')}`)
  await enter()
  await wait()
  await type(`rm -f ${victim}`)
  await enter()
  check('in the alternate screen Enter goes straight through', (await none()) && existsSync(marker('alt-done')) && existsSync(victim))

  console.log('--- paste')
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), `rm -f ${victim}\n`)
  await win.locator('.tab-view:visible .xterm').click({ button: 'right' })
  check('pasted line that would run at once: asks', await shown())
  await answer('Cancel')
  check('…Cancel drops the paste', existsSync(victim))
  await clearLine()

  console.log('--- macros')
  const runMacro = async (name) => {
    await win.locator('.toolbar button[title=Macros]').click()
    await win.locator('.context-menu .item', { hasText: name }).click()
  }
  await runMacro('safe-macro')
  await wait()
  check('harmless macro runs', existsSync(marker('safe-macro')) && (await none()))
  await runMacro('bad-macro')
  check('dangerous macro: asks', await shown())
  await answer('Cancel')
  check('…Cancel: nothing sent', existsSync(victim))
  await runMacro('bad-macro')
  await shown()
  await answer('Run anyway')
  check('…Run anyway runs it', !existsSync(victim))

  console.log('--- multi-exec')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'splitRight'))
  await win.locator('.tab-view:visible .xterm').nth(1).waitFor({ timeout: 5000 })
  await wait(800)
  await win.locator('.toolbar button', { hasText: 'Multi-exec' }).click()
  await win.locator('.tab-view:visible .xterm').first().click()
  plant()
  await type(`rm -f ${victim}`)
  await enter()
  check('multi-exec: asks', await shown())
  const multiText = await dialog.innerText()
  check('…says how many terminals', multiText.includes('2 terminals: local-box'), multiText.split('\n').slice(1, 3).join(' / '))
  await answer('Cancel')
  check('…Cancel: goes nowhere', existsSync(victim))
  await clearLine()
  await win.locator('.toolbar button', { hasText: 'Multi-exec' }).click()

  console.log('--- settings')
  const settings = async (edit) => {
    await win.locator('.toolbar button[title=Settings]').click()
    await win.locator('.settings-nav button', { hasText: 'Command Safety' }).click()
    await edit(win.locator('.modal'))
    await win.locator('.modal .modal-footer button.primary').click()
    await wait()
  }
  await settings((m) => m.locator('textarea[name=dangerWatchList]').fill('deploy prod\n\n  '))
  await win.locator('.tab-view:visible .xterm').first().click()
  await type(`true DEPLOY   prod; touch ${marker('watch')}`)
  await enter()
  check('watch list word: asks', await shown())
  check('…names the word', /watch list: deploy prod/.test(await dialog.innerText()))
  await answer('Run anyway')
  check('…then runs', existsSync(marker('watch')))

  await settings((m) => m.locator('label.check', { hasText: 'hard to undo' }).locator('input').uncheck())
  await win.locator('.tab-view:visible .xterm').first().click()
  plant()
  await type(`rm -f ${victim}`)
  await enter()
  await wait()
  check('turned off in Settings: no dialog, it runs', (await none()) && !existsSync(victim))
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
