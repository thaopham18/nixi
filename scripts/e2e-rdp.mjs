// RDP handshake e2e: opens an embedded RDP tab against an RDP server with bogus credentials
// and expects the server to reject the logon (proves WASM client → proxy → TLS → CredSSP works
// without logging anyone in).
//   node scripts/e2e-rdp.mjs [host] [port]
import { createHash } from 'crypto'
import { mkdtempSync, writeFileSync } from 'fs'
import { connect as netConnect } from 'net'
import { connect as tlsConnect } from 'tls'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 3389)

// Fetch the server certificate to pre-trust it (skips the TOFU dialog).
async function serverCertFingerprint() {
  const tcp = netConnect(port, host)
  await new Promise((r, j) => tcp.once('connect', r).once('error', j))
  // X.224 Connection Request with RDP_NEG_REQ (TLS | CredSSP)
  // TPKT(03 00 00 13) + X.224 CR(0e e0 0000 0000 00) + RDP_NEG_REQ(01 00 0800 03000000)
  tcp.write(Buffer.from('03000013' + '0ee00000000000' + '0100080003000000', 'hex'))
  await new Promise((r) => tcp.once('data', r))
  const s = tlsConnect({ socket: tcp, rejectUnauthorized: false })
  await new Promise((r, j) => s.once('secureConnect', r).once('error', j))
  const raw = s.getPeerCertificate().raw
  s.destroy()
  return 'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')
}

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-rdp-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
json('known_hosts.json', { [`rdp [${host}]:${port}`]: await serverCertFingerprint() })
json('sessions.json', [{ id: 'r1', name: 'rdp-test', type: 'rdp', folder: '', host, port, username: 'nixi-no-such-user' }])
json('secrets.json', { r1: 'raw:' + Buffer.from('definitely-wrong').toString('base64') })

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master' } })
let ok = false
app.process().stderr.on('data', (d) => /rdp-proxy/.test(d) && process.stdout.write('[main] ' + d))
app.process().stdout.on('data', (d) => /rdp-proxy/.test(d) && process.stdout.write('[main] ' + d))
try {
  const win = await app.firstWindow()
  win.on('console', (m) => m.type() === 'error' && console.log('[renderer]', m.text()))
  await win.getByText('rdp-test').last().dblclick()
  const overlay = await win.waitForSelector('.rdp-overlay.error', { timeout: 60000 })
  const text = (await overlay.innerText()).trim()
  console.log('RDP result:', text.split('\n')[0])
  ok = /logon|password|access denied|credssp|authentication/i.test(text)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-rdp.png') })
} catch (err) {
  console.log('error:', err.message)
} finally {
  await app.close()
}
console.log(ok ? 'PASS  RDP handshake reached authentication' : 'FAIL')
process.exit(ok ? 0 : 1)
