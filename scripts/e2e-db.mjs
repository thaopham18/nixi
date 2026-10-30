// Database (lock screen, migration, lock/unlock, remember) + tab duplicate/name + about line.
// Uses the local shell only, no SSH server needed.
//   node scripts/e2e-db.mjs
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'
import { readDb } from './read-db.mjs'

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-db-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
// Data in the old (pre-database) format, to be migrated.
json('sessions.json', [
  { id: 'l1', name: 'shell-one', type: 'local', folder: 'Local' },
  { id: 'x1', name: 'legacy-ssh', type: 'ssh', folder: 'Old', host: '10.9.8.7', username: 'root', auth: 'password' }
])
json('secrets.json', { x1: 'raw:' + Buffer.from('old-secret-pw').toString('base64') })
json('macros.json', [{ id: 'm1', name: 'hello', steps: [{ kind: 'send', text: 'echo hi\r' }] }])

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData } })
const dbFile = join(userData, 'nixi.nxdb')

let app = await launch()
app.process().stderr.on('data', (d) => process.env.DEBUG && process.stdout.write('[main] ' + d))
try {
  let win = await app.firstWindow()
  win.on('console', (m) => process.env.DEBUG && console.log('[renderer]', m.type(), m.text()))
  await win.waitForSelector('.lock-card:has-text("Create your database")')
  check('first run shows "create database"', true)
  check('it mentions the data to migrate', (await win.locator('.lock-card').innerText()).includes('2 sessions'))
  await win.locator('.lock-card input[type=password]').nth(0).fill('master-123')
  await win.locator('.lock-card input[type=password]').nth(1).fill('master-123')
  await win.locator('.lock-card button[type=submit]').click()
  await win.waitForSelector('.tree-row:has-text("legacy-ssh")', { timeout: 15000 })
  check('old sessions migrated into the database', true)
  await sleep(300)
  const raw = readFileSync(dbFile, 'utf8')
  check('database file is encrypted', !raw.includes('legacy-ssh') && !raw.includes('old-secret-pw') && !raw.includes('10.9.8.7'))
  const content = readDb(dbFile, 'master-123')
  check('passwords and macros migrated', content.secrets.x1 === 'old-secret-pw' && content.macros[0]?.name === 'hello')

  check('about line shows the author', (await win.locator('.welcome .about-line').innerText()).includes('Thao Pham'))

  // Tabs: duplicate keeps the name; splitting does not rename.
  await win.locator('.tree-row', { hasText: 'shell-one' }).last().dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  await win.locator('.tab.active .tab-dup').click()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  const titles = await win.locator('.tab .tab-title').allInnerTexts()
  check('duplicate button opens a second tab with the same name', titles.length === 2 && titles.every((t) => t === 'shell-one'), JSON.stringify(titles))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'tileAll'))
  await sleep(500)
  const after = await win.locator('.tab .tab-title').allInnerTexts()
  check('tab name unchanged after tiling', after.length === 1 && after[0] === 'shell-one', JSON.stringify(after))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-db-app.png') })

  // Change master password: a wrong current password is reported at once (before the new one is
  // asked), a mismatched repeat is asked again.
  const field = win.locator('.modal .field')
  const answer = async (text) => {
    await win.locator('.modal .field input').fill(text)
    await win.locator('.modal .field input').press('Enter')
    await sleep(700) // scrypt
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'dbChangePassword'))
  await field.waitFor()
  await answer('wrong-one')
  const afterWrong = await win.locator('.modal').innerText()
  check('wrong current password reported right away', afterWrong.includes('Current master password') && afterWrong.includes('Wrong master password'), JSON.stringify(afterWrong))
  await answer('master-123')
  check('right current password moves on to the new one', (await win.locator('.modal').innerText()).includes('New master password'))
  await answer('master-456')
  await answer('master-45x')
  check('mismatched repeat is asked again', (await win.locator('.modal').innerText()).includes('Does not match'))
  await answer('master-456')
  await win.locator('.toast', { hasText: 'Master password changed' }).waitFor({ timeout: 10000 })
  check('master password changed', readDb(dbFile, 'master-456').macros[0]?.name === 'hello')

  // Lock → wrong password → right password (+ remember).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'dbLock'))
  await win.waitForSelector('.lock-card:has-text("Unlock database")', { timeout: 10000 })
  check('Lock returns to the unlock screen', (await win.locator('.tab').count()) === 0)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-db-lock.png') })
  await win.locator('.lock-card input[type=password]').fill('nope')
  await win.locator('.lock-card button[type=submit]').click()
  await win.waitForSelector('.lock-card .error-line:has-text("Wrong master password")', { timeout: 10000 })
  check('wrong master password is rejected', true)
  await win.locator('.lock-card input[type=password]').fill('master-456')
  await win.locator('.lock-card label.check input').check()
  await win.locator('.lock-card button[type=submit]').click()
  await win.waitForSelector('.tree-row:has-text("legacy-ssh")', { timeout: 15000 })
  check('right master password unlocks', true)
  await app.close()

  // Relaunch: remembered key unlocks without asking.
  app = await launch()
  win = await app.firstWindow()
  await win.waitForSelector('.tree-row:has-text("legacy-ssh"), .lock-card', { timeout: 15000 })
  check('"remember on this computer" unlocks on next start', (await win.locator('.lock-card').count()) === 0)
  check('backup copy kept next to the database', existsSync(dbFile + '.bak'))
} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  await app.close()
}
process.exit(results.every(Boolean) ? 0 : 1)
