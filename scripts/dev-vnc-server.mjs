// Fake VNC server for tests: real RFB handshakes for the security types of the common servers,
// one solid-color screen, and a record of the keys, clicks and clipboard it received.
//   node scripts/dev-vnc-server.mjs [--port 5999] [--security vnc] [--password test] [--username test] [--animate full|small]
// --animate keeps the screen changing, to judge smoothness by eye or measure it:
//   full = every pixel, every frame (video); small = a 200×40 box at 30 Hz (typing, moving a window).
// security: none | vnc | tight | ard | mslogon | plain | x509none | x509vnc | x509plain |
//           tigervnc (VeNCrypt with TLSVnc + VncAuth) | anon (VeNCrypt, anonymous TLS only) |
//           anon+vnc | ra2 (RealVNC RA2 only) | v33 (RFB 3.3 + VNC password) | apple (003.889 + ARD)
import { execFileSync } from 'child_process'
import { createCipheriv, createDecipheriv, createHash, getDiffieHellman, randomBytes } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { TLSSocket, createSecureContext } from 'tls'
import { pathToFileURL } from 'url'
import { constants as zc, createDeflate } from 'zlib'

export const COLOR = [224, 64, 32]

/** Self-signed certificate, made at start so no key lives in the repo. Needs the openssl CLI. */
export function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'nixi-vnc-cert-'))
  const [key, cert] = [join(dir, 'k'), join(dir, 'c')]
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=nixi-test'], { stdio: 'ignore' })
  const out = { key: readFileSync(key), cert: readFileSync(cert) }
  rmSync(dir, { recursive: true, force: true })
  return out
}

const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

const reverseBits = (key) => {
  for (let i = 0; i < key.length; i++) key[i] = parseInt(key[i].toString(2).padStart(8, '0').split('').reverse().join(''), 2)
  return key
}

/** Classic VNC auth: DES of the challenge, key = password with each byte's bits reversed. */
function vncResponse(password, challenge) {
  const key = Buffer.alloc(8)
  Buffer.from(password, 'latin1').copy(key, 0, 0, 8)
  reverseBits(key)
  // single DES is 3DES with one key repeated (plain des-ecb is gone from OpenSSL 3's default provider)
  const c = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(challenge), c.final()])
}

/** UltraVNC MS-Logon: DES-CBC, the IV is the secret and the key the same secret bit-reversed like VNC's. */
function desCbcDecrypt(secret, data) {
  const key = reverseBits(Buffer.from(secret))
  const d = createDecipheriv('des-ede3-cbc', Buffer.concat([key, key, key]), secret)
  d.setAutoPadding(false)
  return Buffer.concat([d.update(data), d.final()])
}

function modPow(base, exp, mod) {
  let out = 1n
  base %= mod
  while (exp > 0n) {
    if (exp & 1n) out = (out * base) % mod
    base = (base * base) % mod
    exp >>= 1n
  }
  return out
}
const toBig = (b) => BigInt('0x' + b.toString('hex'))
const toBuf = (n, len) => Buffer.from(n.toString(16).padStart(len * 2, '0'), 'hex')
const cstr = (b) => b.subarray(0, b.indexOf(0)).toString()

const VENCRYPT = { plain: [256], x509none: [260], x509vnc: [261], x509plain: [262], tigervnc: [258, 2], anon: [257, 258, 259], 'anon+vnc': [258] }
const TYPES = { none: [1], vnc: [2], tight: [16], ard: [30], apple: [30], mslogon: [113], ra2: [5], v33: [2], 'anon+vnc': [19, 2] }

export function startVncServer(opts = {}) {
  const { security = 'vnc', username = 'test', password = 'test', port = 0, tls } = opts
  const seen = { keys: [], pointer: [], clipboard: [], connections: 0, authFailures: 0, resizes: [], username: undefined, encodings: [] }
  const sockets = new Set()
  const greeting = security === 'v33' ? 'RFB 003.003\n' : security === 'apple' ? 'RFB 003.889\n' : 'RFB 003.008\n'

  function session(raw) {
    sockets.add(raw)
    raw.on('close', () => sockets.delete(raw))
    raw.on('error', () => {})
    seen.connections++
    let sock = raw
    let buf = Buffer.alloc(0)
    let want
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      pump()
    }
    const pump = () => {
      if (want && buf.length >= want.n) {
        const { n, resolve } = want
        want = undefined
        const out = buf.subarray(0, n)
        buf = buf.subarray(n)
        resolve(out)
      }
    }
    const read = (n) =>
      new Promise((resolve) => {
        want = { n, resolve }
        pump()
      })
    raw.on('data', onData)

    const result = async (ok, reason = 'Authentication failed') => {
      if (!ok) seen.authFailures++
      sock.write(u32(ok ? 0 : 1))
      if (!ok) {
        sock.write(Buffer.concat([u32(reason.length), Buffer.from(reason)]))
        sock.end()
      }
      return ok
    }
    const vncAuth = async () => {
      const challenge = randomBytes(16)
      sock.write(challenge)
      return (await read(16)).equals(vncResponse(password, challenge))
    }
    const plainAuth = async () => {
      const head = await read(8)
      const user = (await read(head.readUInt32BE(0))).toString()
      const pass = (await read(head.readUInt32BE(4))).toString()
      seen.username = user
      return user === username && pass === password
    }

    const vencrypt = async () => {
      sock.write(Buffer.from([0, 2]))
      await read(2)
      sock.write(Buffer.from([0]))
      const subs = VENCRYPT[security] ?? [261]
      sock.write(Buffer.concat([Buffer.from([subs.length]), ...subs.map(u32)]))
      const chosen = (await read(4)).readUInt32BE()
      if (chosen >= 257) {
        sock.write(Buffer.from([1]))
        raw.off('data', onData)
        const secure = new TLSSocket(raw, { isServer: true, secureContext: createSecureContext(tls) })
        secure.on('data', onData).on('error', () => {})
        sock = secure
      }
      if ([256, 259, 262].includes(chosen)) return plainAuth()
      if ([2, 258, 261].includes(chosen)) return vncAuth()
      return true
    }

    const authenticate = async (type) => {
      if (type === 1) return true
      if (type === 2) return vncAuth()
      if (type === 19) return vencrypt()
      if (type === 16) {
        sock.write(u32(0)) // no tunnels
        sock.write(Buffer.concat([u32(1), u32(2), Buffer.from('STDVVNCAUTH_')]))
        await read(4)
        return vncAuth()
      }
      if (type === 30) {
        const dh = getDiffieHellman('modp2')
        dh.generateKeys()
        const len = dh.getPrime().length
        sock.write(Buffer.concat([Buffer.from([0, 2]), Buffer.from([len >> 8, len & 255]), dh.getPrime(), toBuf(toBig(dh.getPublicKey()), len)]))
        const data = await read(128 + len)
        const secret = toBuf(toBig(dh.computeSecret(data.subarray(128))), len)
        const d = createDecipheriv('aes-128-ecb', createHash('md5').update(secret).digest(), null)
        d.setAutoPadding(false)
        const creds = Buffer.concat([d.update(data.subarray(0, 128)), d.final()])
        seen.username = cstr(creds.subarray(0, 64))
        return seen.username === username && cstr(creds.subarray(64)) === password
      }
      if (type === 113) {
        const p = 0xfffffffffffffc5n // a 60-bit prime
        const g = 2n
        const a = toBig(randomBytes(6))
        sock.write(Buffer.concat([toBuf(g, 8), toBuf(p, 8), toBuf(modPow(g, a, p), 8)]))
        const data = await read(8 + 256 + 64)
        const secret = toBuf(modPow(toBig(data.subarray(0, 8)), a, p), 8)
        seen.username = cstr(desCbcDecrypt(secret, data.subarray(8, 264)))
        return seen.username === username && cstr(desCbcDecrypt(secret, data.subarray(264))) === password
      }
      return false
    }

    let width = opts.width ?? 800
    let height = opts.height ?? 600
    let extendedSize = false
    let announceSize = false
    let fmt = { red: 16, green: 8, blue: 0 }

    // Precomputed so that drawing them costs the server next to nothing: the client is what gets measured.
    let tick = 0
    const animated = () => {
      const { width: w, height: h } = { width, height }
      const small = opts.animate === 'small'
      const rw = small ? 200 : w
      const rh = small ? 40 : h
      const px = Buffer.alloc(rw * rh * 4)
      const t = tick++
      for (let y = 0, i = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++, i += 4) {
          // gradient + noise: compresses about as badly as a photo
          const n = (x * 7 + y * 13 + t * 31) & 255
          const v = (x ^ (y + t * 5)) & 255
          px.writeUInt32LE(((v << fmt.red) | (n << fmt.green) | ((t * 3) << fmt.blue & (255 << fmt.blue))) >>> 0, i)
        }
      }
      const rect = Buffer.alloc(12)
      const x = small ? (t * 8) % (w - rw) : 0
      rect.writeUInt16BE(x, 0)
      rect.writeUInt16BE(small ? 100 : 0, 2)
      rect.writeUInt16BE(rw, 4)
      rect.writeUInt16BE(rh, 6)
      return { rect, px }
    }
    // 'small': the screen changes 30 times a second; each request gets the newest change, or waits for one.
    let pendingRequests = 0
    let changed = false
    if (opts.animate === 'small') {
      const clock = setInterval(() => {
        changed = true
        if (pendingRequests > 0 && !sock.destroyed) {
          pendingRequests--
          changed = false
          void sendAnimated()
        }
      }, 33)
      raw.on('close', () => clearInterval(clock))
    }
    let deflate
    // one at a time: frames share a single zlib stream, and requests can overlap
    let sending = Promise.resolve()
    const sendAnimated = () => (sending = sending.then(sendOneAnimated))
    const sendOneAnimated = async () => {
      const { rect, px } = animated()
      seen.frameSentAt = seen.frameSentAt ?? []
      let body = px
      if (opts.encoding === 'zlib') {
        deflate ??= createDeflate({ level: 1 })
        rect.writeInt32BE(6, 8)
        const chunks = []
        const onChunk = (c) => chunks.push(c)
        deflate.on('data', onChunk)
        await new Promise((resolve) => {
          deflate.write(px)
          deflate.flush(zc.Z_SYNC_FLUSH, resolve)
        })
        deflate.off('data', onChunk)
        const z = Buffer.concat(chunks)
        body = Buffer.concat([u32(z.length), z])
      }
      seen.frames = (seen.frames ?? 0) + 1
      seen.bytes = (seen.bytes ?? 0) + body.length
      seen.frameSentAt.push(Date.now())
      if (seen.frameSentAt.length > 2000) seen.frameSentAt.shift()
      sock.write(Buffer.concat([Buffer.from([0, 0, 0, 1]), rect, body]))
    }

    const sendFrame = () => {
      const pixel = Buffer.alloc(4)
      pixel.writeUInt32LE(((COLOR[0] << fmt.red) | (COLOR[1] << fmt.green) | (COLOR[2] << fmt.blue)) >>> 0)
      const rects = []
      if (announceSize) {
        announceSize = false
        const rect = Buffer.alloc(12 + 4 + 16)
        rect.writeUInt16BE(width, 4)
        rect.writeUInt16BE(height, 6)
        rect.writeInt32BE(-308, 8)
        rect[12] = 1
        rect.writeUInt16BE(width, 16 + 8)
        rect.writeUInt16BE(height, 16 + 10)
        rects.push(rect)
      }
      const head = Buffer.alloc(12)
      head.writeUInt16BE(width, 4)
      head.writeUInt16BE(height, 6)
      rects.push(head, Buffer.alloc(width * height * 4, pixel))
      const count = rects.length === 3 ? 2 : 1
      sock.write(Buffer.concat([Buffer.from([0, 0, 0, count]), ...rects]))
    }

    const serve = async () => {
      await read(1) // ClientInit
      const pf = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
      const name = Buffer.from(opts.name ?? 'nixi-test')
      const head = Buffer.alloc(4)
      head.writeUInt16BE(width, 0)
      head.writeUInt16BE(height, 2)
      // TightVNC clients expect the capability counts after the name
      sock.write(Buffer.concat([head, pf, u32(name.length), name, security === 'tight' ? Buffer.alloc(8) : Buffer.alloc(0)]))
      if (opts.sendClipboard) {
        const text = Buffer.from(opts.sendClipboard, 'latin1')
        setTimeout(() => sock.write(Buffer.concat([Buffer.from([3, 0, 0, 0]), u32(text.length), text])), 500)
      }
      let dirty = true
      for (;;) {
        const type = (await read(1))[0]
        if (type === 0) {
          const m = await read(19)
          fmt = { red: m[13], green: m[14], blue: m[15] }
          dirty = true
        } else if (type === 2) {
          const n = (await read(3)).readUInt16BE(1)
          const list = await read(n * 4)
          seen.encodings = Array.from({ length: n }, (_, i) => list.readInt32BE(i * 4))
          extendedSize = seen.encodings.includes(-308)
          announceSize = extendedSize
        } else if (type === 3) {
          const m = await read(9)
          if (m[0] === 0 || dirty || announceSize) {
            dirty = false
            sendFrame()
          } else if (opts.animate === 'full') {
            void sendAnimated()
          } else if (opts.animate === 'small') {
            if (changed) {
              changed = false
              void sendAnimated()
            } else pendingRequests++
          }
        } else if (type === 4) {
          const m = await read(7)
          if (m[0]) seen.keys.push(m.readUInt32BE(3))
        } else if (type === 5) {
          const m = await read(5)
          seen.pointer.push({ buttons: m[0], x: m.readUInt16BE(1), y: m.readUInt16BE(3) })
        } else if (type === 6) {
          const len = (await read(7)).readUInt32BE(3)
          seen.clipboard.push((await read(len)).toString('latin1'))
        } else if (type === 251) {
          const m = await read(7)
          const screens = m[5]
          await read(16 * screens)
          width = m.readUInt16BE(1)
          height = m.readUInt16BE(3)
          seen.resizes.push({ width, height })
          announceSize = true
          dirty = true
        } else {
          console.error('[vnc] unknown client message', type)
          sock.destroy()
          return
        }
      }
    }

    ;(async () => {
      sock.write(greeting)
      const client = (await read(12)).toString()
      seen.clientVersion = client.trim()
      if (security === 'v33') {
        sock.write(u32(2))
        if (await result(await vncAuth())) await serve()
        return
      }
      const types = TYPES[security] ?? [19]
      sock.write(Buffer.from([types.length, ...types]))
      const type = (await read(1))[0]
      seen.chosenType = type
      if (await result(await authenticate(type))) await serve()
    })().catch(() => raw.destroy())
  }

  const server = createServer(session)
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        seen,
        close() {
          for (const s of sockets) s.destroy()
          server.close()
        }
      })
    )
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : fallback
  }
  const security = arg('security', 'vnc')
  const s = await startVncServer({
    security,
    port: Number(arg('port', 5999)),
    username: arg('username', 'test'),
    password: arg('password', 'test'),
    tls: security.startsWith('x509') ? makeCert() : undefined,
    animate: arg('animate'),
    encoding: arg('encoding'),
    width: Number(arg('width', 1920)),
    height: Number(arg('height', 1080))
  })
  console.log(`Fake VNC server (${security}) on 127.0.0.1:${s.port}`)
}
