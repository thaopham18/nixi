// Telnet e2e with an in-process fake device (Cisco-like login).
//   node scripts/e2e-telnet.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'

const IAC = 255, DO = 253, WILL = 251, SB = 250, SE = 240
const seen = { ttype: '', naws: [], lines: [], logins: 0 }

// Fake device: negotiates TTYPE/NAWS/ECHO/SGA, asks Username/Password, then a prompt.
const server = createServer((sock) => {
  let stage = 'user'
  let line = ''
  let st = 'data'
  let sb = []
  sock.write(Buffer.from([IAC, DO, 24, IAC, DO, 31, IAC, WILL, 1, IAC, WILL, 3]))
  sock.write('\r\nUser Access Verification\r\n\r\nUsername: ')
  const onLine = (l) => {
    if (stage === 'user') {
      seen.user = l
      stage = 'pass'
      sock.write('\r\nPassword: ')
    } else if (stage === 'pass') {
      seen.pass = l
      stage = 'cli'
      seen.logins++
      sock.write(l === 'secret' ? '\r\nsw01#' : '\r\n% Login invalid\r\n\r\nUsername: ')
      if (l !== 'secret') stage = 'user'
    } else {
      seen.lines.push(l)
      sock.write(`\r\n${l}: ok\r\nsw01#`)
    }
  }
  sock.on('data', (buf) => {
    for (const b of buf) {
      if (st === 'data') {
        if (b === IAC) st = 'iac'
        else if (b === 13) {
          onLine(line)
          line = ''
        } else if (b !== 10 && b !== 0) {
          line += String.fromCharCode(b)
          if (stage !== 'pass') sock.write(Buffer.from([b])) // server-side echo
        }
      } else if (st === 'iac') st = b === SB ? 'sb' : b >= 251 ? 'opt' : 'data'
      else if (st === 'opt') {
        if (b === 24) sock.write(Buffer.from([IAC, SB, 24, 1, IAC, SE])) // TTYPE SEND
        st = 'data'
      } else if (st === 'sb') {
        if (b === IAC) st = 'sb-iac'
        else sb.push(b)
      } else if (st === 'sb-iac') {
        if (b === SE) {
          if (sb[0] === 24) seen.ttype = Buffer.from(sb.slice(2)).toString()
          if (sb[0] === 31) seen.naws.push([(sb[1] << 8) | sb[2], (sb[3] << 8) | sb[4]])
          sb = []
          st = 'data'
        } else st = 'sb'
      }
    }
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-telnet-'))
writeFileSync(
  join(userData, 'sessions.json'),
  JSON.stringify([
    { id: 't', name: 'core-switch', type: 'telnet', folder: 'Network', host: '127.0.0.1', port, username: 'admin', startupCommand: 'terminal length 0' }
  ])
)
writeFileSync(join(userData, 'secrets.json'), JSON.stringify({ t: 'raw:' + Buffer.from('secret').toString('base64') }))
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ sftpAutoOpen: false }))

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 8000) => {
  for (let t = 0; t < ms; t += 100) {
    if (fn()) return true
    await sleep(100)
  }
  return false
}

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' } })
try {
  const win = await app.firstWindow()
  await win.locator('.tree-row', { hasText: 'core-switch' }).last().dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  check('telnet session connects', true)
  check('auto-login answers Username/Password', await waitFor(() => seen.logins === 1 && seen.user === 'admin' && seen.pass === 'secret'))
  check('command after login is sent', await waitFor(() => seen.lines.includes('terminal length 0')))
  check('terminal type negotiated', seen.ttype === 'XTERM-256COLOR', `(${seen.ttype})`)
  const size = (await win.locator('.tab-view:visible .term-container').getAttribute('data-size')).split('x').map(Number)
  const last = () => seen.naws[seen.naws.length - 1]
  check('window size (NAWS) matches the pane', await waitFor(() => last()?.[0] === size[0] && last()?.[1] === size[1]), `(${JSON.stringify(last())} vs ${size})`)

  await win.locator('.tab-view:visible .term-container').click()
  await win.keyboard.type('show version\r')
  check('typed command reaches the device', await waitFor(() => seen.lines.includes('show version')))

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'toggleSidebar'))
  check('NAWS update after resize', await waitFor(() => seen.naws.length > 1 && last()[0] > size[0]), `(${JSON.stringify(seen.naws)})`)

  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-telnet.png') })
} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
}
process.exit(results.every(Boolean) ? 0 : 1)
