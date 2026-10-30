// Minimal SSH server for developing Nixi without a real server.
// Supports: password auth, PTY shell, exec, SFTP (rooted at a folder), -L / -D (direct-tcpip), -R (tcpip-forward).
//
//   node scripts/dev-ssh-server.mjs [--port 2222] [--user test] [--password test] [--root <dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync, promises as fsp, openSync, closeSync, readSync, writeSync, fstatSync } from 'fs'
import { createServer as netServer, connect as netConnect } from 'net'
import { join, resolve, posix } from 'path'
import { tmpdir } from 'os'
import ssh2 from 'ssh2'
import * as pty from '@lydell/node-pty'
import { spawn } from 'child_process'

const { Server, utils } = ssh2
const { STATUS_CODE, OPEN_MODE } = utils.sftp

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}
const PORT = Number(arg('port', 2222))
const USER = arg('user', 'test')
const PASSWORD = arg('password', 'test')
const ROOT = resolve(arg('root', join(tmpdir(), 'nixi-dev-sftp')))
// Simulates a slow server/network: delay (ms) before accepting a login.
const AUTH_DELAY = Number(arg('auth-delay', 0))
mkdirSync(ROOT, { recursive: true })
if (!existsSync(join(ROOT, 'hello.txt'))) writeFileSync(join(ROOT, 'hello.txt'), 'Hello from the dev SSH server\n')
mkdirSync(join(ROOT, 'folder'), { recursive: true })

const keyFile = join(tmpdir(), 'nixi-dev-hostkey')
if (!existsSync(keyFile)) writeFileSync(keyFile, utils.generateKeyPairSync('ed25519').private)
const hostKey = readFileSync(keyFile)

const toLocal = (p) => join(ROOT, posix.normalize('/' + p).replace(/^\/+/, ''))
const attrsOf = (st) => ({
  mode: st.mode,
  uid: 0,
  gid: 0,
  size: st.size,
  atime: Math.floor(st.atimeMs / 1000),
  mtime: Math.floor(st.mtimeMs / 1000)
})

function handleSftp(sftp) {
  const handles = new Map()
  let next = 0
  const newHandle = (v) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(next++)
    handles.set(b.toString('hex'), v)
    return b
  }
  const get = (h) => handles.get(h.toString('hex'))
  const fail = (id, err) => sftp.status(id, err?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, err?.message)

  sftp
    .on('REALPATH', (id, p) => {
      const norm = posix.normalize('/' + (p === '.' ? '' : p))
      sftp.name(id, [{ filename: norm, longname: norm, attrs: {} }])
    })
    .on('STAT', (id, p) => fsp.stat(toLocal(p)).then((st) => sftp.attrs(id, attrsOf(st)), (e) => fail(id, e)))
    .on('LSTAT', (id, p) => fsp.lstat(toLocal(p)).then((st) => sftp.attrs(id, attrsOf(st)), (e) => fail(id, e)))
    .on('FSTAT', (id, h) => {
      const v = get(h)
      if (v?.fd === undefined) return fail(id)
      sftp.attrs(id, attrsOf(fstatSync(v.fd)))
    })
    .on('OPENDIR', (id, p) =>
      fsp.readdir(toLocal(p)).then((names) => sftp.handle(id, newHandle({ dir: toLocal(p), names, done: false })), (e) => fail(id, e))
    )
    .on('READDIR', async (id, h) => {
      const v = get(h)
      if (!v || v.done) return sftp.status(id, STATUS_CODE.EOF)
      v.done = true
      const list = []
      for (const name of v.names) {
        try {
          const st = await fsp.lstat(join(v.dir, name))
          list.push({ filename: name, longname: name, attrs: attrsOf(st) })
        } catch {}
      }
      sftp.name(id, list)
    })
    .on('OPEN', (id, p, flags) => {
      try {
        let mode = 'r'
        if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.APPEND ? 'a' : 'w'
        if (flags & OPEN_MODE.READ && flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.TRUNC ? 'w+' : 'r+'
        sftp.handle(id, newHandle({ fd: openSync(toLocal(p), mode) }))
      } catch (e) {
        fail(id, e)
      }
    })
    .on('READ', (id, h, offset, len) => {
      const v = get(h)
      const buf = Buffer.alloc(len)
      const n = readSync(v.fd, buf, 0, len, offset)
      n ? sftp.data(id, buf.subarray(0, n)) : sftp.status(id, STATUS_CODE.EOF)
    })
    .on('WRITE', (id, h, offset, data) => {
      writeSync(get(h).fd, data, 0, data.length, offset)
      sftp.status(id, STATUS_CODE.OK)
    })
    .on('CLOSE', (id, h) => {
      const v = get(h)
      if (v?.fd !== undefined) closeSync(v.fd)
      handles.delete(h.toString('hex'))
      sftp.status(id, STATUS_CODE.OK)
    })
    .on('MKDIR', (id, p) => fsp.mkdir(toLocal(p)).then(() => sftp.status(id, STATUS_CODE.OK), (e) => fail(id, e)))
    .on('RMDIR', (id, p) => fsp.rmdir(toLocal(p)).then(() => sftp.status(id, STATUS_CODE.OK), (e) => fail(id, e)))
    .on('REMOVE', (id, p) => fsp.unlink(toLocal(p)).then(() => sftp.status(id, STATUS_CODE.OK), (e) => fail(id, e)))
    .on('RENAME', (id, a, b) => fsp.rename(toLocal(a), toLocal(b)).then(() => sftp.status(id, STATUS_CODE.OK), (e) => fail(id, e)))
    .on('SETSTAT', (id, p, attrs) =>
      (attrs.mode !== undefined ? fsp.chmod(toLocal(p), attrs.mode) : Promise.resolve()).then(
        () => sftp.status(id, STATUS_CODE.OK),
        (e) => fail(id, e)
      )
    )
}

new Server({ hostKeys: [hostKey] }, (client) => {
  const remoteServers = new Map()
  client
    .on('authentication', (ctx) => {
      if (ctx.username === USER && ctx.method === 'password' && ctx.password === PASSWORD) return void setTimeout(() => ctx.accept(), AUTH_DELAY)
      ctx.reject(['password'])
    })
    .on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        let ptyInfo = { cols: 80, rows: 24 }
        let proc
        session.on('pty', (ok, _rej, info) => {
          ptyInfo = info
          ok?.()
        })
        session.on('window-change', (ok, _rej, info) => {
          proc?.resize(info.cols, info.rows)
          ok?.()
        })
        session.on('env', (ok) => ok?.())
        session.on('shell', (ok) => {
          const stream = ok()
          const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
          proc = pty.spawn(shell, [], { name: 'xterm-256color', cols: ptyInfo.cols, rows: ptyInfo.rows, cwd: ROOT, env: process.env })
          proc.onData((d) => stream.write(d))
          proc.onExit(({ exitCode }) => {
            stream.exit(exitCode)
            stream.end()
          })
          stream.on('data', (d) => proc.write(d.toString()))
          stream.on('close', () => proc.kill())
        })
        // exec (used by the server stats bar: "sh -s" + script on stdin). Not on Windows: no sh there.
        session.on('exec', (ok, reject, info) => {
          if (process.platform === 'win32') return reject?.()
          const stream = ok()
          const child = spawn('sh', ['-c', info.command], { cwd: ROOT })
          child.stdout.on('data', (d) => stream.write(d))
          child.stderr.on('data', (d) => stream.stderr.write(d))
          child.on('close', (code) => {
            stream.exit(code ?? 0)
            stream.end()
          })
          stream.on('data', (d) => child.stdin.write(d))
          stream.on('end', () => child.stdin.end())
          stream.on('close', () => child.kill())
        })
        session.on('sftp', (ok) => handleSftp(ok()))
      })
      // -L and -D
      client.on('tcpip', (accept, reject, info) => {
        const sock = netConnect(info.destPort, info.destIP)
        sock.once('connect', () => {
          const ch = accept()
          sock.pipe(ch).pipe(sock)
          sock.on('error', () => ch.close())
          ch.on('error', () => sock.destroy())
        })
        sock.once('error', () => reject())
      })
      // -R
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward') return reject?.()
        const srv = netServer((sock) => {
          client.forwardOut(info.bindAddr, info.bindPort, sock.remoteAddress, sock.remotePort, (err, ch) => {
            if (err) return sock.destroy()
            sock.pipe(ch).pipe(sock)
          })
        })
        srv.listen(info.bindPort, info.bindAddr || '127.0.0.1', () => {
          remoteServers.set(`${info.bindAddr}:${info.bindPort}`, srv)
          accept?.(srv.address().port)
        })
        srv.once('error', () => reject?.())
      })
    })
    .on('close', () => remoteServers.forEach((s) => s.close()))
    .on('error', () => {})
}).listen(PORT, '127.0.0.1', () => {
  console.log(`dev SSH server on 127.0.0.1:${PORT}  user=${USER} password=${PASSWORD}  sftp root=${ROOT}`)
})
