// SFTP "Follow terminal" with a real bash over SSH: the folder comes from the prompt, or from OSC 7
// when the shell sends it. The dev server's SFTP is rooted at / here, so its paths are real paths.
// POSIX shells only.
//   npm run build && node scripts/e2e-follow.mjs
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
const PORT = 2291

const work = mkdtempSync(join(tmpdir(), 'nixi-e2e-follow-work-'))
for (const [dir, file] of [['one', 'in-one.txt'], ['two', 'in-two.txt'], ['my dir', 'in-spaced.txt']]) {
  mkdirSync(join(work, dir))
  writeFileSync(join(work, dir, file), 'x')
}
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-follow-'))
const sshd = spawn(process.execPath, ['scripts/dev-ssh-server.mjs', '--port', String(PORT), '--root', '/', '--no-seed'], { stdio: 'ignore' })
const keyFile = join(tmpdir(), 'nixi-dev-hostkey')
for (let i = 0; i < 50 && !existsSync(keyFile); i++) await sleep(100)
await sleep(500)
const hostKey = ssh2.utils.parseKey(readFileSync(keyFile))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
json('known_hosts.json', { [`[127.0.0.1]:${PORT}`]: 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '') })
json('sessions.json', [{ id: 's1', name: 'follow-srv', type: 'ssh', folder: '', host: '127.0.0.1', port: PORT, username: 'test', auth: 'password' }])
json('secrets.json', { s1: 'raw:' + Buffer.from('test').toString('base64') })
json('settings.json', { sftpAutoOpen: true, warnMultilinePaste: false })

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master' } })
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')
  const wait = (ms = 400) => win.waitForTimeout(ms)
  const poll = async (fn, ms = 6000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return true
      await wait(100)
    }
    return false
  }
  const run = async (text) => {
    await win.locator('.xterm-helper-textarea').first().focus()
    await win.keyboard.type(text)
    await win.keyboard.press('Enter')
    await wait(500)
  }
  const shows = (name) => poll(async () => (await win.locator('.sftp-list td.name', { hasText: name }).count()) > 0)
  const follow = win.locator('.sftp-options label', { hasText: 'Follow terminal' }).locator('input')
  const error = win.locator('.sidebar .error-line')
  const note = win.locator('.sftp-note')

  await win.locator('.tree-row', { hasText: 'follow-srv' }).dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  await follow.waitFor({ timeout: 5000 })
  await wait(800)
  await run('exec /bin/bash --norc')
  await run("PS1='test@srv:\\w\\$ '")

  console.log('--- off')
  await run(`cd "${join(work, 'one')}"`)
  await wait(800)
  check('unticked: the panel stays where it is', (await win.locator('.sftp-list td.name', { hasText: 'in-one.txt' }).count()) === 0)

  console.log('--- the prompt shows the folder (bash on Ubuntu)')
  await follow.check()
  check('ticking it goes to the current folder', await shows('in-one.txt'))
  await run(`cd "${join(work, 'two')}"`)
  check('cd: the panel follows', await shows('in-two.txt'))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-follow.png') })
  await run(`cd "${join(work, 'my dir')}"`)
  check('a folder with a space', await shows('in-spaced.txt'))

  console.log('--- not fooled')
  await run(`cd "${join(work, 'one')}"`)
  await shows('in-one.txt')
  await win.locator('.xterm-helper-textarea').first().focus()
  await win.keyboard.type(`cd "${join(work, 'two')}"`)
  await wait(800)
  check('a command being typed does not move it', (await win.locator('.sftp-list td.name', { hasText: 'in-one.txt' }).count()) === 1)
  await win.keyboard.press('Control+U')
  await run(`echo "me@evil:${join(work, 'two')}$ "`)
  await wait(800)
  check('a line of output that looks like a prompt does not move it', (await win.locator('.sftp-list td.name', { hasText: 'in-one.txt' }).count()) === 1)
  await run('less /etc/hosts')
  await wait(500)
  await win.keyboard.type('q')
  await wait(800)
  check('a full-screen program does not move it', (await win.locator('.sftp-list td.name', { hasText: 'in-one.txt' }).count()) === 1)

  console.log('--- another sidebar tab')
  await win.locator('.sidebar-tabs button', { hasText: 'Sessions' }).click()
  await run(`cd "${join(work, 'two')}"`)
  await win.locator('.sidebar-tabs button', { hasText: 'SFTP' }).click()
  await follow.waitFor({ timeout: 3000 })
  check('the tick survives', await follow.isChecked())
  check('…and it catches up with the terminal', await shows('in-two.txt'))

  console.log('--- a folder SFTP cannot open (sudo -i)')
  await run(`PS1='root@srv:/no/such/folder# '`)
  check('says so', await poll(async () => (await error.count()) > 0 && /Can't follow to \/no\/such\/folder/.test(await error.innerText())))
  check('…and keeps the list', (await win.locator('.sftp-list td.name', { hasText: 'in-two.txt' }).count()) === 1)
  await run(`PS1='test@srv:\\w\\$ '`)
  check('goes away on the next good folder', await poll(async () => (await error.count()) === 0))

  console.log('--- a prompt with only the last name (RHEL)')
  await run(`PS1='[test@srv \\W]\\$ '`)
  check('says it cannot tell, instead of showing a wrong folder', await poll(async () => (await note.count()) === 1))
  await run(`PS1='test@srv:\\w\\$ '`)
  check('the note goes away with a full path', await poll(async () => (await note.count()) === 0))

  console.log('--- OSC 7')
  await run(`PS1='plain$ '; PROMPT_COMMAND='printf "\\033]7;file://srv%s\\033\\\\" "$PWD"'`)
  await run(`cd "${join(work, 'one')}"`)
  check('a prompt with no folder: OSC 7 still works', await shows('in-one.txt'))
  await run(`PS1='test@srv:/no/such/folder$ '`)
  await run(`cd "${join(work, 'two')}"`)
  await wait(800)
  check('when both speak, the shell\'s own word wins over the prompt', (await win.locator('.sftp-list td.name', { hasText: 'in-two.txt' }).count()) === 1 && (await error.count()) === 0)
} catch (err) {
  console.log(`FAIL  unexpected error ${err?.message ?? err}`)
  failed++
  await app.windows()[0]?.screenshot({ path: join(tmpdir(), 'nixi-e2e-follow-failure.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
  sshd.kill()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
