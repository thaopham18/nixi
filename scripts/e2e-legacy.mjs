// Old SSH servers (CentOS 5/6, old Cisco / Juniper / HP): only SHA-1 key exchange, CBC / 3DES / arcfour ciphers,
// MD5 / SHA-1-96 MACs, ssh-rsa host keys. Nixi offers these after the modern ones, like MobaXterm / Termius.
// Starts its own dev-ssh-server per profile (ports 2280–2283). A modern server must still get modern algorithms.
// Plus a real OpenSSH sshd (port 2279, run as this user, key login) set up like an old CentOS 6 / OpenSSH 5.3 box:
// group exchange only, ssh-rsa host key, aes256-ctr, so the server sends an 8192-bit prime. Node's prime check on
// that took 30 s and the login timed out ("Timed out while waiting for handshake"); see src/main/ssh/dh-patch.cjs.
//   npm run build && node scripts/e2e-legacy.mjs
import { createHash } from 'crypto'
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright-core'

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-legacy-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
const fpOf = (pem) => 'SHA256:' + createHash('sha256').update(ssh2.utils.parseKey(pem).getPublicSSH()).digest('base64').replace(/=+$/, '')

// An RSA host key: old servers have no ed25519 / ecdsa key and sign with ssh-rsa (SHA-1).
const rsaFile = join(userData, 'rsa-hostkey')
writeFileSync(rsaFile, ssh2.utils.generateKeyPairSync('rsa', { bits: 2048 }).private)
const edFile = join(tmpdir(), 'nixi-dev-hostkey')

// diffie-hellman-group-exchange-sha1 is offered too, but ssh2's server side has no group exchange to test it with.
const servers = [
  { port: 2280, name: 'modern', args: [], key: edFile },
  { port: 2281, name: 'cisco-ios-12', args: ['--kex', 'diffie-hellman-group1-sha1', '--cipher', '3des-cbc', '--hmac', 'hmac-md5'], key: rsaFile },
  { port: 2282, name: 'centos-5', args: ['--kex', 'diffie-hellman-group14-sha1', '--cipher', 'aes256-cbc', '--hmac', 'hmac-sha1-96'], key: rsaFile },
  // Old RHEL/CentOS with UseDNS / GSSAPI and no DNS for the client: the login itself takes 25 s (was cut at 20 s).
  { port: 2278, name: 'slow-login', args: ['--auth-delay', '25000'], key: edFile },
  { port: 2283, name: 'old-switch', args: ['--kex', 'diffie-hellman-group1-sha1', '--cipher', 'aes128-cbc', '--hmac', 'hmac-md5-96'], key: rsaFile }
]

// Real sshd (skipped where there is none, e.g. Windows).
const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find(existsSync)
const sshdDir = join(userData, 'sshd')
let sshd
if (SSHD) {
  execFileSync('mkdir', ['-p', sshdDir])
  execFileSync('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-N', '', '-f', join(sshdDir, 'hostkey')])
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(sshdDir, 'client')])
  writeFileSync(join(sshdDir, 'authorized_keys'), readFileSync(join(sshdDir, 'client.pub')))
  writeFileSync(
    join(sshdDir, 'sshd_config'),
    [
      'Port 2279',
      'ListenAddress 127.0.0.1',
      `HostKey ${join(sshdDir, 'hostkey')}`,
      'HostKeyAlgorithms ssh-rsa',
      'KexAlgorithms diffie-hellman-group-exchange-sha256',
      'Ciphers aes256-ctr',
      `AuthorizedKeysFile ${join(sshdDir, 'authorized_keys')}`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'StrictModes no',
      `PidFile ${join(sshdDir, 'pid')}`,
      'LogLevel DEBUG1'
    ].join('\n')
  )
  sshd = spawn(SSHD, ['-D', '-f', join(sshdDir, 'sshd_config'), '-E', join(sshdDir, 'log')], { stdio: 'ignore' })
}

const logs = {}
const procs = []
for (const s of servers) {
  const args = ['scripts/dev-ssh-server.mjs', '--port', String(s.port), ...s.args]
  if (s.key === rsaFile) args.push('--host-key', rsaFile)
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  logs[s.name] = ''
  p.stdout.on('data', (d) => (logs[s.name] += d))
  p.stderr.on('data', (d) => (logs[s.name] += d))
  procs.push(p)
}
await sleep(1500)
if (!existsSync(edFile)) throw new Error('dev-ssh-server did not create its host key')

json('known_hosts.json', {
  ...Object.fromEntries(servers.map((s) => [`[127.0.0.1]:${s.port}`, fpOf(readFileSync(s.key))])),
  ...(SSHD ? { '[127.0.0.1]:2279': fpOf(readFileSync(join(sshdDir, 'hostkey'))) } : {})
})
json('sessions.json', [
  ...servers.map((s) => ({ id: s.name, name: s.name, type: 'ssh', folder: '', host: '127.0.0.1', port: s.port, username: 'test', auth: 'password' })),
  ...(SSHD
    ? [{ id: 'openssh-gex', name: 'openssh-gex', type: 'ssh', folder: '', host: '127.0.0.1', port: 2279, username: userInfo().username, auth: 'key', privateKeyPath: join(sshdDir, 'client') }]
    : []),
  // TEST-NET-1: nothing answers. Must fail after the 20 s TCP limit, not wait for the 90 s login limit.
  { id: 'no-answer', name: 'no-answer', type: 'ssh', folder: '', host: '192.0.2.1', port: 22, username: 'test', auth: 'password' }
])
json('secrets.json', Object.fromEntries(servers.map((s) => [s.name, 'raw:' + Buffer.from('test').toString('base64')])))
json('settings.json', { sftpAutoOpen: false, autoReconnect: false, gpuRendering: false })

const handshake = (name) => {
  const line = logs[name].split('\n').find((l) => l.startsWith('handshake '))
  return line && JSON.parse(line.slice('handshake '.length))
}

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master', SSH_AUTH_SOCK: '' } })
try {
  const win = await app.firstWindow()
  const open = (name) => win.locator('.tree-row', { has: win.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) }).last().dblclick()
  const closeTab = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'closeTab'))
  // Proves the shell works over the negotiated cipher, not just the handshake (the shell starts in the SFTP root).
  const echoes = async (marker, out = join(tmpdir(), 'nixi-dev-sftp', `e2e-legacy-${marker}.txt`)) => {
    rmSync(out, { force: true })
    await win.locator('.tab-view:visible .term-container').click()
    await win.keyboard.type(`echo ${marker}-$((6*7)) > '${out}'\r`)
    for (let i = 0; i < 30 && !existsSync(out); i++) await sleep(200)
    const ok = existsSync(out) && readFileSync(out, 'utf8').trim() === `${marker}-42`
    rmSync(out, { force: true })
    return ok
  }

  for (const s of servers) {
    console.log(`--- ${s.name}`)
    await open(s.name)
    const ok = await win.locator('.tab.active .dot.connected').waitFor({ timeout: s.name === 'slow-login' ? 40000 : 15000 }).then(() => true, () => false)
    const h = handshake(s.name)
    check(`${s.name}: connects`, ok, s.name === 'slow-login' ? '(login took 25 s)' : JSON.stringify(h))
    if (s.name === 'slow-login') {
      // nothing more: connecting at all is the point
    } else if (s.name === 'modern') {
      check('modern server still gets modern algorithms', h && /curve25519/.test(h.kex) && /gcm|ctr|chacha/.test(h.cipher) && h.hostKey === 'ssh-ed25519', JSON.stringify(h))
    } else {
      const want = Object.fromEntries([['kex', s.args[1]], ['cipher', s.args[3]], ['mac', s.args[5]]])
      check(`${s.name}: used ${want.kex} / ${want.cipher} / ${want.mac}`, h && h.kex === want.kex && h.cipher === want.cipher && h.mac === want.mac && h.hostKey === 'ssh-rsa', JSON.stringify(h))
    }
    if (ok) check(`${s.name}: shell works over it`, await echoes(s.name.replace(/\W/g, '')))
    await closeTab()
    await sleep(300)
  }

  {
    console.log('--- host that never answers')
    const text = () => win.evaluate(() => [...document.querySelectorAll('.xterm-rows')].find((e) => e.getBoundingClientRect().width > 0)?.innerText ?? '')
    const t = Date.now()
    await open('no-answer')
    let seen = ''
    while (Date.now() - t < 30000 && !/Press R/.test((seen = await text()))) await sleep(300)
    const took = Date.now() - t
    const msg = seen.replace(/\s+/g, ' ').match(/(Timed out[^\[]*|connect E[A-Z]+[^\[]*)/)?.[0]?.trim() ?? seen.slice(0, 200)
    check('gives up within ~20 s, not 90', /Press R/.test(seen) && took < 26000, `(${took} ms: ${msg})`)
    check('…and says so (TCP, not login)', /no answer in 20 s|EHOSTUNREACH|ENETUNREACH/.test(seen), msg)
    await closeTab()
    await sleep(300)
  }

  if (SSHD) {
    console.log('--- real OpenSSH, group exchange with an 8192-bit prime')
    const t = Date.now()
    await open('openssh-gex')
    const ok = await win.locator('.tab.active .dot.connected').waitFor({ timeout: 25000 }).then(() => true, () => false)
    const took = Date.now() - t
    if (!ok) await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-legacy-gex.png') })
    const log = existsSync(join(sshdDir, 'log')) ? readFileSync(join(sshdDir, 'log'), 'utf8') : ''
    check('connects, well under the 20 s handshake timeout', ok && took < 8000, `(${took} ms)`)
    check('…over diffie-hellman-group-exchange-sha256 with an ssh-rsa host key', /kex: algorithm: diffie-hellman-group-exchange-sha256/.test(log) && /host key algorithm: ssh-rsa/.test(log))
    if (ok) check('…shell works over it', await echoes('opensshgex', join(userData, 'gex-echo.txt')))
    await closeTab()
  } else console.log('--- no sshd here: real OpenSSH group exchange not tested')
} finally {
  if (process.env.KEEP_LOG && SSHD) console.log(readFileSync(join(sshdDir, 'log'), 'utf8').slice(-3000))
  await app.close()
  sshd?.kill()
  procs.forEach((p) => p.kill())
  rmSync(userData, { recursive: true, force: true })
}
const failed = results.filter((r) => !r).length
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nall ${results.length} passed`)
process.exit(failed ? 1 : 0)
