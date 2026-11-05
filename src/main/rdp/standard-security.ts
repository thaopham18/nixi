// Standard RDP Security (MS-RDPBCGR 5.3): RSA key exchange + RC4, no TLS. xrdp falls back to it when
// it cannot read its private key, and native clients handle it. IronRDP only speaks TLS, so the proxy
// does this part: towards IronRDP the session looks like TLS with encryption level none (RDCleanPath
// carries plain RDP over the local WebSocket), towards the server it is standard security.
// Weak by today's standards; the server's key is still checked trust-on-first-use.
import { createHash, randomBytes, X509Certificate } from 'crypto'

const SEC_EXCHANGE = 0x0001
const SEC_ENCRYPT = 0x0008
const SEC_INFO = 0x0040
const SEC_LICENSE = 0x0080
/** Security flags that travel with their header even when encryption is off for the client. */
const SEC_KEEP_HEADER = 0x0002 | SEC_LICENSE | 0x0400 | 0x1000 | 0x4000
const METHOD_40 = 0x01
const METHOD_128 = 0x02
const METHOD_56 = 0x08
const METHOD_FIPS = 0x10

/** IronRDP needs a certificate to parse. No key exists for it and nothing is verified against it. */
export const PLACEHOLDER_CERT = Buffer.from('MIIDGTCCAgGgAwIBAgIUIlBr9T/gyP296e6sAAvl66WpqS4wDQYJKoZIhvcNAQELBQAwGzEZMBcGA1UEAwwQTml4aSBwbGFjZWhvbGRlcjAgFw0yNjExMDUxMTIwMDNaGA8yMTI2MTAxMjExMjAwM1owGzEZMBcGA1UEAwwQTml4aSBwbGFjZWhvbGRlcjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJsEBHm1X3H0QfFite47wqGT5d2X0JtkVk+u9oncDehLL6FOubWnLM32EFefCmoZWN36ICizOCGWkqXnE9WTMxdBhJIsPUGYZUt44qwlpfi2R+pXScvwgdPjj2A3HJQWar90MiDwPaKT1NvCaKmAnnmYooqcBDt5M9RfFnzIbvfhAPerCqYFDM4mDl7x0ImoPGU8iT/Rbw8SWCOkx018fW7f5XbHjHUOef2lz76820yhsVLKrGQq/5J759pCw76psZTvMfY2utVzVIuvoaTZD/s8iTwsiuqd+3LdWEm0xyOOWcnECfNMbqf7P7vFBPOxnE2h1T8tJIRTeBL6YxtGv7sCAwEAAaNTMFEwHQYDVR0OBBYEFPCkMEc9uN/Ku7a8cZnlcDtF93cKMB8GA1UdIwQYMBaAFPCkMEc9uN/Ku7a8cZnlcDtF93cKMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAIHjKz9+6rkO7FBaonwVe4ev1lQbxa1Lb1vt1l+fKC/aH5+l7UPqzEzeHgaMlzAhlg91Ab1qrWDgZiSFHMjsVqek9NPlWJYdgWSXndo6JxXns/4eXi4WzJWB7rEjg6DiHyhfsdWU/DMdgoKb77XhXc2R9RKeGCTl+sGo/TUKQrWtuk9dHUCfj3AGaMHod9EQN/Q5aKvbfaabM9VhZ6u+kPOx8qPp3ksjT0B5AGcl6W/QCa4CSzjdPB2UPaupXquCZLx+YHCRPgrbPo1/X208SU/yrevDfSWu1kwhQOXF/w9oyzGSPSrCca/m2zUdAAYnSCuCTIHaUJrw5P3Verfdzec=', 'base64')

const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest()
const sha1 = (...parts: Buffer[]): Buffer => createHash('sha1').update(Buffer.concat(parts)).digest()
const PAD1 = Buffer.alloc(40, 0x36)
const PAD2 = Buffer.alloc(48, 0x5c)

export class Rc4 {
  private s = new Uint8Array(256)
  private i = 0
  private j = 0
  constructor(key: Buffer) {
    for (let n = 0; n < 256; n++) this.s[n] = n
    for (let n = 0, j = 0; n < 256; n++) {
      j = (j + this.s[n] + key[n % key.length]) & 255
      ;[this.s[n], this.s[j]] = [this.s[j], this.s[n]]
    }
  }
  run(data: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length)
    const s = this.s
    let { i, j } = this
    for (let n = 0; n < data.length; n++) {
      i = (i + 1) & 255
      j = (j + s[i]) & 255
      const t = s[i]
      s[i] = s[j]
      s[j] = t
      out[n] = data[n] ^ s[(s[i] + s[j]) & 255]
    }
    this.i = i
    this.j = j
    return out
  }
}

export interface SessionKeys {
  mac: Buffer
  encrypt: Buffer
  decrypt: Buffer
}

function reduceKey(key: Buffer, method: number): Buffer {
  if (method === METHOD_128) return key.subarray(0, 16)
  const k = Buffer.from(key.subarray(0, 8))
  k[0] = 0xd1
  if (method === METHOD_40) {
    k[1] = 0x26
    k[2] = 0x9e
  }
  return k
}

/** The client's keys (MS-RDPBCGR 5.3.5). */
export function deriveKeys(clientRandom: Buffer, serverRandom: Buffer, method: number): SessionKeys {
  const salted = (secret: Buffer, label: string): Buffer =>
    md5(secret, sha1(Buffer.from(label), secret, clientRandom, serverRandom))
  const pre = Buffer.concat([clientRandom.subarray(0, 24), serverRandom.subarray(0, 24)])
  const master = Buffer.concat(['A', 'BB', 'CCC'].map((l) => salted(pre, l)))
  const blob = Buffer.concat(['X', 'YY', 'ZZZ'].map((l) => salted(master, l)))
  const final = (k: Buffer): Buffer => md5(k, clientRandom, serverRandom)
  return {
    mac: reduceKey(blob.subarray(0, 16), method),
    decrypt: reduceKey(final(blob.subarray(16, 32)), method),
    encrypt: reduceKey(final(blob.subarray(32, 48)), method)
  }
}

export function signature(macKey: Buffer, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32LE(data.length)
  return md5(macKey, PAD2, sha1(macKey, PAD1, length, data)).subarray(0, 8)
}

/** One direction of the RC4 stream: the key changes every 4096 packets. */
export class Cipher {
  private rc4: Rc4
  private current: Buffer
  private count = 0
  constructor(
    private readonly initial: Buffer,
    private readonly method: number
  ) {
    this.current = initial
    this.rc4 = new Rc4(initial)
  }
  run(data: Buffer): Buffer {
    if (this.count === 4096) {
      const hash = md5(this.initial, PAD2, sha1(this.initial, PAD1, this.current)).subarray(0, this.initial.length)
      this.current = reduceKey(new Rc4(hash).run(hash), this.method)
      this.rc4 = new Rc4(this.current)
      this.count = 0
    }
    this.count++
    return this.rc4.run(data)
  }
}

export interface RsaKey {
  /** Big endian. */
  modulus: Buffer
  exponent: Buffer
}

/** The public key in a server certificate: Microsoft's own format, or an X.509 chain (the last one is the server's). */
export function serverKey(cert: Buffer): RsaKey {
  const version = cert.readUInt32LE(0) & 0x7fffffff
  if (version === 1) {
    // dwVersion, dwSigAlgId, dwKeyAlgId, wPublicKeyBlobType, wPublicKeyBlobLen, then RSA1 blob
    const blob = cert.subarray(16)
    if (blob.toString('latin1', 0, 4) !== 'RSA1') throw new Error('Unknown server key format')
    const keyLength = blob.readUInt32LE(4)
    const bits = blob.readUInt32LE(8)
    const exponent = Buffer.from(blob.subarray(16, 20)).reverse()
    // The modulus has trailing zero padding: only bits / 8 bytes count.
    const modulus = Buffer.from(blob.subarray(20, 20 + Math.min(keyLength, bits / 8))).reverse()
    return { modulus, exponent }
  }
  if (version === 2) {
    const count = cert.readUInt32LE(4)
    let at = 8
    let last: Buffer | undefined
    for (let i = 0; i < count; i++) {
      const length = cert.readUInt32LE(at)
      last = cert.subarray(at + 4, at + 4 + length)
      at += 4 + length
    }
    if (!last) throw new Error('Server sent an empty certificate chain')
    const jwk = new X509Certificate(last).publicKey.export({ format: 'jwk' }) as { n?: string; e?: string }
    if (!jwk.n || !jwk.e) throw new Error('Server key is not RSA')
    return { modulus: Buffer.from(jwk.n, 'base64url'), exponent: Buffer.from(jwk.e, 'base64url') }
  }
  throw new Error(`Unknown server certificate version ${version}`)
}

const toBig = (b: Buffer): bigint => BigInt('0x' + (b.toString('hex') || '0'))

/** Textbook RSA as the protocol wants it: little endian in and out, no padding. */
export function encryptClientRandom(random: Buffer, key: RsaKey): Buffer {
  const n = toBig(key.modulus)
  let base = toBig(Buffer.from(random).reverse()) % n
  let e = toBig(key.exponent)
  let result = 1n
  while (e > 0n) {
    if (e & 1n) result = (result * base) % n
    base = (base * base) % n
    e >>= 1n
  }
  const hex = result.toString(16).padStart(key.modulus.length * 2, '0')
  return Buffer.from(hex, 'hex').reverse()
}

// ------------------------------------------------------------------ PDU helpers

function perLength(buf: Buffer, at: number): { length: number; size: number } {
  if (buf[at] & 0x80) return { length: buf.readUInt16BE(at) & 0x7fff, size: 2 }
  return { length: buf[at], size: 1 }
}

function encodePer(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const b = Buffer.alloc(2)
  b.writeUInt16BE(length | 0x8000)
  return b
}

function berLength(buf: Buffer, at: number): { length: number; size: number } {
  const first = buf[at]
  if (first < 0x80) return { length: first, size: 1 }
  const n = first & 0x7f
  return { length: buf.readUIntBE(at + 1, n), size: 1 + n }
}

function encodeBer(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  if (length < 0x100) return Buffer.from([0x81, length])
  const b = Buffer.alloc(3)
  b[0] = 0x82
  b.writeUInt16BE(length, 1)
  return b
}

function tpkt(body: Buffer): Buffer {
  const head = Buffer.from([3, 0, 0, 0])
  head.writeUInt16BE(body.length + 4, 2)
  return Buffer.concat([head, body])
}

function fastPath(header: number, body: Buffer): Buffer {
  const total = body.length + 2
  // The short form when it fits: lengths include the header and the length field itself.
  if (total <= 0x7f) return Buffer.concat([Buffer.from([header, total]), body])
  const out = Buffer.allocUnsafe(3)
  out[0] = header
  out.writeUInt16BE((total + 1) | 0x8000, 1)
  return Buffer.concat([out, body])
}

/** Splits a byte stream into TPKT and fast-path PDUs. */
export class Framer {
  private buf: Buffer = Buffer.alloc(0)
  push(data: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data
    const out: Buffer[] = []
    for (;;) {
      if (this.buf.length < 2) return out
      let length: number
      if (this.buf[0] === 3) {
        if (this.buf.length < 4) return out
        length = this.buf.readUInt16BE(2)
      } else if (this.buf[1] & 0x80) {
        if (this.buf.length < 3) return out
        length = this.buf.readUInt16BE(1) & 0x7fff
      } else length = this.buf[1]
      if (length < 2) throw new Error('Bad RDP packet length')
      if (this.buf.length < length) return out
      out.push(this.buf.subarray(0, length))
      this.buf = this.buf.subarray(length)
    }
  }
}

/** Client blocks: what TLS negotiation wrote becomes what standard security needs. Sizes stay the same. */
export function patchConnectInitial(pdu: Buffer): Buffer {
  const out = Buffer.from(pdu)
  const key = out.indexOf('Duca', 0, 'latin1')
  if (key < 0) throw new Error('No client data in MCS Connect Initial')
  const per = perLength(out, key + 4)
  let at = key + 4 + per.size
  const end = at + per.length
  while (at + 4 <= end) {
    const type = out.readUInt16LE(at)
    const length = out.readUInt16LE(at + 2)
    if (length < 4) break
    if (type === 0xc001 && length >= 216) out.writeUInt32LE(0, at + 212) // serverSelectedProtocol: standard security
    if (type === 0xc002 && length >= 12) {
      out.writeUInt32LE(METHOD_40 | METHOD_128 | METHOD_56, at + 4)
      out.writeUInt32LE(0, at + 8)
    }
    at += length
  }
  return out
}

export interface ServerSecurity {
  method: number
  level: number
  random: Buffer
  cert: Buffer
}

/** Reads SC_SECURITY and returns the response rewritten to say encryption none, for IronRDP. */
export function rewriteConnectResponse(pdu: Buffer): { security: ServerSecurity; pdu: Buffer } {
  if (pdu[7] !== 0x7f || pdu[8] !== 0x66) throw new Error('Expected MCS Connect Response')
  const key = pdu.indexOf('McDn', 0, 'latin1')
  if (key < 0) throw new Error('No server data in MCS Connect Response')
  const per = perLength(pdu, key + 4)
  const blocksAt = key + 4 + per.size
  const blocks: Buffer[] = []
  let security: ServerSecurity | undefined
  for (let at = blocksAt; at + 4 <= blocksAt + per.length; ) {
    const type = pdu.readUInt16LE(at)
    const length = pdu.readUInt16LE(at + 2)
    if (length < 4) break
    if (type === 0x0c02) {
      const method = pdu.readUInt32LE(at + 4)
      const level = pdu.readUInt32LE(at + 8)
      const randomLength = method || level ? pdu.readUInt32LE(at + 12) : 0
      const certLength = method || level ? pdu.readUInt32LE(at + 16) : 0
      security = {
        method,
        level,
        random: Buffer.from(pdu.subarray(at + 20, at + 20 + randomLength)),
        cert: Buffer.from(pdu.subarray(at + 20 + randomLength, at + 20 + randomLength + certLength))
      }
      blocks.push(Buffer.from([0x02, 0x0c, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    } else blocks.push(pdu.subarray(at, at + length))
    at += length
  }
  if (!security) throw new Error('No security data from the server')

  // Lengths nest, so they are written again from the inside out.
  const data = Buffer.concat(blocks)
  // Connect response: enumerated, integer, domain parameters, then user data as an octet string.
  const outer = berLength(pdu, 9)
  let at = 9 + outer.size
  while (pdu[at] !== 0x04) {
    const l = berLength(pdu, at + 1)
    at += 1 + l.size + l.length
    if (at >= pdu.length) throw new Error('Bad MCS Connect Response')
  }
  const user = berLength(pdu, at + 1)
  const gcc = at + 1 + user.size // 7 bytes of T.124 header, then the length of the connect PDU
  const inner = perLength(pdu, gcc + 7)
  const connectPdu = Buffer.concat([pdu.subarray(gcc + 7 + inner.size, key + 4), encodePer(data.length), data])
  const userData = Buffer.concat([pdu.subarray(gcc, gcc + 7), encodePer(connectPdu.length), connectPdu])
  const content = Buffer.concat([pdu.subarray(9 + outer.size, at), Buffer.from([0x04]), encodeBer(userData.length), userData])
  const body = Buffer.concat([pdu.subarray(4, 9), encodeBer(content.length), content])
  return { security, pdu: tpkt(body) }
}

const SEND_DATA_REQUEST = 0x64
const SEND_DATA_INDICATION = 0x68

interface SendData {
  /** X.224 + MCS bytes up to and including 0x70. */
  head: Buffer
  data: Buffer
}

function readSendData(pdu: Buffer, kind: number): SendData | undefined {
  if (pdu[0] !== 3 || pdu[5] !== 0xf0 || pdu[7] !== kind) return undefined
  const per = perLength(pdu, 13)
  return { head: pdu.subarray(4, 13), data: pdu.subarray(13 + per.size, 13 + per.size + per.length) }
}

const sendData = (head: Buffer, data: Buffer): Buffer => tpkt(Buffer.concat([head, encodePer(data.length), data]))

export interface StandardSecurityIo {
  toServer(data: Buffer): void
  toClient(data: Buffer): void
  /** Trust-on-first-use check of the server's certificate, as for TLS. */
  verify(cert: Buffer): Promise<boolean>
  fail(reason: string): void
}

export class StandardSecurity {
  private readonly fromIron = new Framer()
  private readonly fromServerFrames = new Framer()
  private security?: ServerSecurity
  private keys?: SessionKeys
  private encrypt?: Cipher
  private decrypt?: Cipher
  private readonly clientRandom = randomBytes(32)
  private exchanged = false
  private active = false
  private waiting: Buffer[] | undefined
  private failed = false

  constructor(private readonly io: StandardSecurityIo) {}

  private get encrypted(): boolean {
    return !!this.keys
  }

  fromClient(data: Buffer): void {
    this.guard(() => {
      for (const pdu of this.fromIron.push(data)) this.clientPdu(pdu)
    })
  }

  fromServer(data: Buffer): void {
    this.guard(() => {
      for (const pdu of this.fromServerFrames.push(data)) {
        if (this.waiting) this.waiting.push(pdu)
        else this.serverPdu(pdu)
      }
    })
  }

  private guard(run: () => void): void {
    if (this.failed) return
    try {
      run()
    } catch (err) {
      this.failed = true
      this.io.fail((err as Error).message)
    }
  }

  private seal(data: Buffer): Buffer {
    const keys = this.keys as SessionKeys
    return Buffer.concat([signature(keys.mac, data), (this.encrypt as Cipher).run(data)])
  }

  private clientPdu(pdu: Buffer): void {
    if (pdu[0] !== 3) {
      // Fast-path input
      if (!this.encrypted) return this.io.toServer(pdu)
      const header = pdu[0]
      const start = pdu[1] & 0x80 ? 3 : 2
      return this.io.toServer(fastPath(header | 0x80, this.seal(pdu.subarray(start))))
    }
    if (pdu[7] === 0x7f && pdu[8] === 0x65) return this.io.toServer(patchConnectInitial(pdu))
    const send = readSendData(pdu, SEND_DATA_REQUEST)
    if (!send || !this.encrypted) {
      // A server without any encryption still gets its exchange-free Client Info as is.
      return this.io.toServer(pdu)
    }
    const flags = send.data.length >= 4 ? send.data.readUInt16LE(0) : 0
    if (!this.exchanged) {
      if (!(flags & SEC_INFO)) return this.io.toServer(pdu) // nothing is encrypted before Client Info
      this.sendExchange(send.head)
      this.exchanged = true
      const header = Buffer.from(send.data.subarray(0, 4))
      header.writeUInt16LE(flags | SEC_ENCRYPT)
      return this.io.toServer(sendData(send.head, Buffer.concat([header, this.seal(send.data.subarray(4))])))
    }
    // Licensing keeps its own header and is not encrypted. It only happens before the first server data.
    if (!this.active && flags & SEC_LICENSE) return this.io.toServer(pdu)
    const header = Buffer.from([SEC_ENCRYPT, 0, 0, 0])
    this.io.toServer(sendData(send.head, Buffer.concat([header, this.seal(send.data)])))
  }

  private sendExchange(head: Buffer): void {
    const { cert } = this.security as ServerSecurity
    const key = serverKey(cert)
    const encrypted = encryptClientRandom(this.clientRandom, key)
    const header = Buffer.alloc(8)
    header.writeUInt16LE(SEC_EXCHANGE, 0)
    header.writeUInt32LE(encrypted.length + 8, 4)
    this.io.toServer(sendData(head, Buffer.concat([header, encrypted, Buffer.alloc(8)])))
  }

  private open(data: Buffer): Buffer {
    const body = (this.decrypt as Cipher).run(data.subarray(8))
    if (!signature((this.keys as SessionKeys).mac, body).equals(data.subarray(0, 8))) throw new Error('Bad RDP packet signature')
    return body
  }

  private serverPdu(pdu: Buffer): void {
    if (pdu[0] !== 3) {
      if (!this.encrypted) return this.io.toClient(pdu)
      const header = pdu[0]
      const start = pdu[1] & 0x80 ? 3 : 2
      const body = header & 0x80 ? this.open(pdu.subarray(start)) : pdu.subarray(start)
      this.active = true
      return this.io.toClient(fastPath(header & 0x3f, body))
    }
    if (pdu[7] === 0x7f && pdu[8] === 0x66) return this.connectResponse(pdu)
    const send = readSendData(pdu, SEND_DATA_INDICATION)
    if (!send || !this.encrypted) return this.io.toClient(pdu)
    const flags = send.data.readUInt16LE(0)
    const rest = send.data.subarray(4)
    const body = flags & SEC_ENCRYPT ? this.open(rest) : rest
    if (flags & SEC_KEEP_HEADER) {
      const header = Buffer.from(send.data.subarray(0, 4))
      header.writeUInt16LE(flags & ~SEC_ENCRYPT)
      return this.io.toClient(sendData(send.head, Buffer.concat([header, body])))
    }
    this.active = true
    this.io.toClient(sendData(send.head, body))
  }

  private connectResponse(pdu: Buffer): void {
    const { security, pdu: rewritten } = rewriteConnectResponse(pdu)
    if (security.method & METHOD_FIPS) throw new Error('The server requires FIPS encryption, which is not supported')
    if (!security.method) return this.io.toClient(rewritten) // no encryption at all: nothing else to do
    if (![METHOD_40, METHOD_56, METHOD_128].includes(security.method)) throw new Error(`Unknown RDP encryption method ${security.method}`)
    if (security.random.length !== 32 || !security.cert.length) throw new Error('The server sent no key')
    serverKey(security.cert) // fail now rather than at Client Info
    this.security = security
    this.waiting = []
    void this.io.verify(security.cert).then(
      (ok) => {
        if (!ok) {
          this.failed = true
          return this.io.fail('server certificate not trusted')
        }
        this.keys = deriveKeys(this.clientRandom, security.random, security.method)
        this.encrypt = new Cipher(this.keys.encrypt, security.method)
        // Low level: only the client encrypts, but the keys are the same.
        this.decrypt = new Cipher(this.keys.decrypt, security.method)
        this.io.toClient(rewritten)
        const waiting = this.waiting ?? []
        this.waiting = undefined
        this.guard(() => waiting.forEach((p) => this.serverPdu(p)))
      },
      (err: Error) => this.io.fail(err.message)
    )
  }
}
