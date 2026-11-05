import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, createPrivateKey } from 'crypto'
import { decompressRle, fixFastPathBitmaps, fixSlowPathBitmaps } from '../src/main/rdp/bitmap'
import { asTlsResponse, isNegotiationFailure, isStandardRdpSecurity } from '../src/main/rdp/rdcleanpath'
import {
  Cipher,
  Framer,
  Rc4,
  StandardSecurity,
  deriveKeys,
  encryptClientRandom,
  patchConnectInitial,
  rewriteConnectResponse,
  serverKey,
  signature
} from '../src/main/rdp/standard-security'

const hex = (s: string): Buffer => Buffer.from(s, 'hex')
const tpkt = (body: Buffer): Buffer => {
  const h = Buffer.from([3, 0, 0, 0])
  h.writeUInt16BE(body.length + 4, 2)
  return Buffer.concat([h, body])
}
const per = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n])
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n | 0x8000)
  return b
}
const X224 = hex('02f080')
const sendData = (kind: number, data: Buffer): Buffer =>
  tpkt(Buffer.concat([X224, Buffer.from([kind, 0x03, 0xef, 0x03, 0xeb, 0x70]), per(data.length), data]))
const dataOf = (pdu: Buffer): Buffer => pdu.subarray(13 + (pdu[13] & 0x80 ? 2 : 1))

/** MCS Connect Response the way a server shapes it, with a Microsoft-format key. */
function connectResponse(method: number, level: number, random: Buffer, cert: Buffer): Buffer {
  const core = hex('010c0c00040008000000000000')
  core.writeUInt16LE(12, 2)
  const coreBlock = core.subarray(0, 12)
  const sec = Buffer.alloc(20)
  sec.writeUInt16LE(0x0c02, 0)
  sec.writeUInt16LE(20 + random.length + cert.length, 2)
  sec.writeUInt32LE(method, 4)
  sec.writeUInt32LE(level, 8)
  sec.writeUInt32LE(random.length, 12)
  sec.writeUInt32LE(cert.length, 16)
  const netBlock = hex('030c0800eb030000')
  const blocks = Buffer.concat([coreBlock, sec, random, cert, netBlock])
  const inner = Buffer.concat([hex('14760a01010001c000'), Buffer.from('McDn'), per(blocks.length), blocks])
  const user = Buffer.concat([hex('000500147c0001'), per(inner.length), inner])
  const userLen = user.length < 0x80 ? Buffer.from([user.length]) : hex('82' + user.length.toString(16).padStart(4, '0'))
  const fields = Buffer.concat([hex('0a0100'), hex('020100'), hex('30020100'), Buffer.from([0x04]), userLen, user])
  const len = hex('82' + fields.length.toString(16).padStart(4, '0'))
  return tpkt(Buffer.concat([X224, hex('7f66'), len, fields]))
}

function rsaKey(): { cert: Buffer; decrypt: (le: Buffer) => Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const pub = publicKey.export({ format: 'jwk' }) as { n: string; e: string }
  const priv = createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })).export({ format: 'jwk' }) as { d: string }
  const n = Buffer.from(pub.n, 'base64url')
  const e = Buffer.alloc(4)
  Buffer.from(pub.e, 'base64url').reverse().copy(e)
  const blob = Buffer.alloc(20 + n.length + 8)
  blob.write('RSA1', 0, 'latin1')
  blob.writeUInt32LE(n.length + 8, 4)
  blob.writeUInt32LE(n.length * 8, 8)
  blob.writeUInt32LE(n.length - 1, 12)
  e.copy(blob, 16)
  Buffer.from(n).reverse().copy(blob, 20)
  const head = Buffer.alloc(16)
  head.writeUInt32LE(1, 0)
  head.writeUInt32LE(1, 4)
  head.writeUInt32LE(1, 8)
  head.writeUInt16LE(6, 12)
  head.writeUInt16LE(blob.length, 14)
  const toBig = (b: Buffer): bigint => BigInt('0x' + b.toString('hex'))
  const N = toBig(n)
  const D = toBig(Buffer.from(priv.d, 'base64url'))
  return {
    cert: Buffer.concat([head, blob, Buffer.alloc(72)]),
    decrypt: (le) => {
      let base = toBig(Buffer.from(le).reverse()) % N
      let d = D
      let r = 1n
      while (d > 0n) {
        if (d & 1n) r = (r * base) % N
        base = (base * base) % N
        d >>= 1n
      }
      return Buffer.from(r.toString(16).padStart(64, '0'), 'hex').reverse()
    }
  }
}

function connectInitial(): Buffer {
  const core = Buffer.alloc(216)
  core.writeUInt16LE(0xc001, 0)
  core.writeUInt16LE(216, 2)
  core.writeUInt32LE(1, 212) // says TLS was chosen
  const sec = Buffer.alloc(12)
  sec.writeUInt16LE(0xc002, 0)
  sec.writeUInt16LE(12, 2)
  const blocks = Buffer.concat([core, sec])
  const body = Buffer.concat([X224, hex('7f65'), hex('820000'), hex('000500147c0001'), per(blocks.length + 14), hex('0008001000010001'), Buffer.from('Duca'), per(blocks.length), blocks])
  return tpkt(body)
}

describe('standard RDP security', () => {
  it('RC4 matches the published test vector', () => {
    expect(new Rc4(Buffer.from('Key')).run(Buffer.from('Plaintext')).toString('hex').toUpperCase()).toBe('BBF316E8D940AF0AD3')
    const rc4 = new Rc4(Buffer.from('Wiki'))
    expect(rc4.run(Buffer.from('ped')).toString('hex').toUpperCase() + rc4.run(Buffer.from('ia')).toString('hex').toUpperCase()).toBe('1021BF0420')
  })

  it('RSA encrypts the client random the way the key can open it, little endian', () => {
    const { cert, decrypt } = rsaKey()
    const random = Buffer.alloc(32, 0x5a)
    random[0] = 1
    const out = encryptClientRandom(random, serverKey(cert))
    expect(out.length).toBe(128)
    expect(decrypt(out).subarray(0, 32).equals(random)).toBe(true)
  })

  it('keys differ per direction and have the right size', () => {
    const c = Buffer.alloc(32, 1)
    const s = Buffer.alloc(32, 2)
    const k128 = deriveKeys(c, s, 2)
    expect(k128.encrypt.length).toBe(16)
    expect(k128.encrypt.equals(k128.decrypt)).toBe(false)
    const k40 = deriveKeys(c, s, 1)
    expect(k40.encrypt.subarray(0, 3).toString('hex')).toBe('d1269e')
    expect(k40.encrypt.length).toBe(8)
    expect(deriveKeys(c, s, 8).encrypt[0]).toBe(0xd1)
  })

  it('renews the RC4 key after 4096 packets, the same on both ends', () => {
    const key = Buffer.alloc(16, 9)
    const a = new Cipher(key, 2)
    const b = new Cipher(key, 2)
    let last: Buffer = Buffer.alloc(0)
    for (let i = 0; i < 4100; i++) last = b.run(a.run(Buffer.from(`packet ${i}`)))
    expect(last.toString()).toBe('packet 4099')
    const fresh = new Cipher(key, 2)
    for (let i = 0; i < 4096; i++) fresh.run(Buffer.from([0]))
    expect(fresh.run(Buffer.from([0, 0, 0, 0])).equals(new Rc4(key).run(Buffer.from([0, 0, 0, 0])))).toBe(false)
  })

  it('tells IronRDP TLS was chosen, even if the server sent no negotiation data', () => {
    const none = hex('0300000b06d00000123400')
    for (const x224 of [none, hex('030000130ed000001234000201080000000000')]) {
      const out = asTlsResponse(x224)
      expect(out.readUInt16BE(2)).toBe(19)
      expect(out[4]).toBe(14)
      expect(out[11]).toBe(2)
      expect(out.readUInt32LE(15)).toBe(1)
      expect(isStandardRdpSecurity(out)).toBe(false)
      expect(isNegotiationFailure(out)).toBe(false)
    }
  })

  it('rewrites the client blocks without changing a length', () => {
    const before = connectInitial()
    const after = patchConnectInitial(before)
    expect(after.length).toBe(before.length)
    const key = after.indexOf('Duca')
    const blocks = key + 4 + 2
    expect(after.readUInt32LE(blocks + 212)).toBe(0)
    expect(after.readUInt32LE(blocks + 216 + 4)).toBe(0x0b)
  })

  it('turns the server security block into encryption none, nesting lengths right', () => {
    const { cert } = rsaKey()
    const random = Buffer.alloc(32, 7)
    const { security, pdu } = rewriteConnectResponse(connectResponse(2, 3, random, cert))
    expect(security.method).toBe(2)
    expect(security.level).toBe(3)
    expect(security.random.equals(random)).toBe(true)
    expect(security.cert.equals(cert)).toBe(true)
    expect(pdu.readUInt16BE(2)).toBe(pdu.length)
    expect(pdu.indexOf(cert.subarray(20, 60))).toBe(-1)
    const at = pdu.indexOf('McDn') + 4
    const size = pdu[at] & 0x80 ? 2 : 1
    const length = size === 2 ? pdu.readUInt16BE(at) & 0x7fff : pdu[at]
    expect(at + size + length).toBe(pdu.length)
    const blocks = pdu.subarray(at + size)
    expect(blocks.readUInt16LE(12)).toBe(0x0c02)
    expect(blocks.readUInt16LE(14)).toBe(12)
    expect(blocks.readUInt32LE(16)).toBe(0)
    expect(blocks.readUInt32LE(20)).toBe(0)
    expect(blocks.readUInt16LE(24)).toBe(0x0c03)
  })

  it('runs a whole session against a server that only has standard security', async () => {
    const { cert, decrypt } = rsaKey()
    const serverRandom = Buffer.alloc(32, 0x33)
    const toServer: Buffer[] = []
    const toClient: Buffer[] = []
    const verified: Buffer[] = []
    const failures: string[] = []
    const s = new StandardSecurity({
      toServer: (d) => void toServer.push(d),
      toClient: (d) => void toClient.push(d),
      verify: async (c) => (verified.push(c), true),
      fail: (r) => void failures.push(r)
    })
    s.fromClient(connectInitial())
    expect(toServer).toHaveLength(1)
    s.fromServer(connectResponse(2, 3, serverRandom, cert))
    await new Promise((r) => setTimeout(r, 0))
    expect(failures).toEqual([])
    expect(verified[0].equals(cert)).toBe(true)
    expect(toClient).toHaveLength(1)

    // Before Client Info nothing is encrypted: MCS attach and join pass through.
    const attach = tpkt(Buffer.concat([X224, hex('28')]))
    s.fromClient(attach)
    expect(toServer[1].equals(attach)).toBe(true)

    // Client Info: the key exchange goes first, then the Info, encrypted.
    toServer.length = 0
    const secret = Buffer.from('user and password')
    s.fromClient(sendData(0x64, Buffer.concat([hex('40000000'), secret])))
    expect(toServer).toHaveLength(2)
    const exchange = dataOf(toServer[0])
    expect(exchange.readUInt16LE(0) & 0x01).toBe(1)
    const cipherLength = exchange.readUInt32LE(4)
    expect(cipherLength).toBe(128 + 8)
    const clientRandom = decrypt(exchange.subarray(8, 8 + 128)).subarray(0, 32)
    const keys = deriveKeys(clientRandom, serverRandom, 2)
    const fromClient = new Cipher(keys.encrypt, 2)
    const toClientCipher = new Cipher(keys.decrypt, 2)
    const open = (d: Buffer): Buffer => {
      const body = fromClient.run(d.subarray(12))
      expect(signature(keys.mac, body).equals(d.subarray(4, 12))).toBe(true)
      return body
    }
    const info = dataOf(toServer[1])
    expect(info.readUInt16LE(0)).toBe(0x48)
    expect(open(info).equals(secret)).toBe(true)
    expect(toServer[1].indexOf(secret)).toBe(-1)

    // License from the server keeps its header for IronRDP; encrypted or not, it arrives readable.
    const license = hex('ff03100002000000')
    const sealed = (flags: string, body: Buffer): Buffer =>
      sendData(0x68, Buffer.concat([hex(flags), signature(keys.mac, body), toClientCipher.run(body)]))
    toClient.length = 0
    s.fromServer(sealed('88000000', license))
    expect(dataOf(toClient[0]).equals(Buffer.concat([hex('80000000'), license]))).toBe(true)

    // Share data loses the security header altogether, in both directions it is what IronRDP expects.
    toClient.length = 0
    const demand = Buffer.from('demand active pdu')
    s.fromServer(sealed('08000000', demand))
    expect(dataOf(toClient[0]).equals(demand)).toBe(true)

    toServer.length = 0
    const confirm = Buffer.from('confirm active pdu')
    s.fromClient(sendData(0x64, confirm))
    const sent = dataOf(toServer[0])
    expect(sent.readUInt16LE(0)).toBe(0x08)
    expect(open(sent).equals(confirm)).toBe(true)

    // Fast path, out and in.
    toClient.length = 0
    const update = Buffer.from('fast path update')
    const sig = signature(keys.mac, update)
    const enc = toClientCipher.run(update)
    s.fromServer(Buffer.concat([Buffer.from([0x80, 2 + 8 + enc.length]), sig, enc]))
    expect(toClient[0].equals(Buffer.concat([Buffer.from([0, 2 + update.length]), update]))).toBe(true)

    toServer.length = 0
    const events = Buffer.from('input')
    s.fromClient(Buffer.concat([Buffer.from([0x08, 2 + events.length]), events]))
    const fp = toServer[0]
    expect(fp[0]).toBe(0x88)
    expect(fp[1]).toBe(2 + 8 + events.length)
    const inBody = fromClient.run(fp.subarray(10))
    expect(signature(keys.mac, inBody).equals(fp.subarray(2, 10))).toBe(true)
    expect(inBody.equals(events)).toBe(true)

    // A tampered packet is refused.
    const bad = sealed('08000000', demand)
    bad[bad.length - 1] ^= 1
    s.fromServer(bad)
    expect(failures).toEqual(['Bad RDP packet signature'])
  })

  it('does not trust a key the user turned down, and refuses FIPS', async () => {
    const { cert } = rsaKey()
    const failures: string[] = []
    const toClient: Buffer[] = []
    const refuse = new StandardSecurity({ toServer: () => {}, toClient: (d) => void toClient.push(d), verify: async () => false, fail: (r) => void failures.push(r) })
    refuse.fromServer(connectResponse(2, 3, Buffer.alloc(32, 1), cert))
    await new Promise((r) => setTimeout(r, 0))
    expect(failures).toEqual(['server certificate not trusted'])
    expect(toClient).toHaveLength(0)

    const fips: string[] = []
    new StandardSecurity({ toServer: () => {}, toClient: () => {}, verify: async () => true, fail: (r) => void fips.push(r) }).fromServer(
      connectResponse(0x10, 4, Buffer.alloc(32, 1), cert)
    )
    expect(fips[0]).toMatch(/FIPS/)
  })

  it('splits a stream at any byte into whole packets', () => {
    const a = sendData(0x68, Buffer.alloc(300, 1))
    const b = Buffer.concat([Buffer.from([0x00, 0x05]), hex('010203')])
    const c = Buffer.concat([Buffer.from([0x00, 0x81, 0x83]), Buffer.alloc(0x180, 2)])
    const all = Buffer.concat([a, b, c])
    const framer = new Framer()
    const got: Buffer[] = []
    for (const byte of all) got.push(...framer.push(Buffer.from([byte])))
    expect(got.map((p) => p.length)).toEqual([a.length, 5, c.length])
  })
})

describe('xrdp bitmaps', () => {
  const pixels = (raw: Buffer): number[] => Array.from({ length: raw.length / 2 }, (_, i) => raw.readUInt16LE(i * 2))

  it('reads the RLE orders', () => {
    // color image of 2, then color run of 2
    expect(pixels(decompressRle(hex('82' + '1100' + '2200' + '62' + '3300'), 4, 1, 2))).toEqual([0x11, 0x22, 0x33, 0x33])
    // first row a color run, second a background run copies it
    expect(pixels(decompressRle(hex('62' + '0500' + '02'), 2, 2, 2))).toEqual([5, 5, 5, 5])
    // two background runs in a row: the second starts with a foreground pixel (white xor above)
    expect(pixels(decompressRle(hex('01' + '01'), 2, 1, 2))).toEqual([0, 0xffff])
    // white and black specials, a mega color run
    expect(pixels(decompressRle(hex('fd' + 'fe' + 'f3' + '0200' + '0900'), 4, 1, 2))).toEqual([0xffff, 0, 9, 9])
    // what xrdp really sends for a plain background: 1 pixel, then a mega run
    expect(pixels(decompressRle(hex('81' + '182b' + 'f3' + '0300' + '182b'), 2, 2, 2))).toEqual([0x2b18, 0x2b18, 0x2b18, 0x2b18])
    // dithered run
    expect(pixels(decompressRle(hex('e1' + '0100' + '0200'), 2, 1, 2))).toEqual([1, 2])
  })

  it('refuses data that runs out or overflows instead of drawing it', () => {
    expect(() => decompressRle(hex('62'), 2, 1, 2)).toThrow()
    expect(() => decompressRle(hex('63' + '0100'), 2, 1, 2)).toThrow()
  })

  const rect = (left: number, top: number, right: number, bottom: number, w: number, h: number, body: Buffer, flags = 0x401, bpp = 16): Buffer => {
    const head = Buffer.alloc(18)
    ;[left, top, right, bottom, w, h, bpp, flags, body.length].forEach((v, i) => head.writeUInt16LE(v, i * 2))
    return Buffer.concat([head, body])
  }
  const slowPath = (rects: Buffer[]): Buffer => {
    const body = Buffer.concat(rects)
    const header = Buffer.alloc(22)
    header.writeUInt16LE(22 + body.length, 0)
    header.writeUInt16LE(0x17, 2)
    header[14] = 2
    header.writeUInt16LE(1, 18)
    header.writeUInt16LE(rects.length, 20)
    return sendData(0x68, Buffer.concat([header, body]))
  }

  it('crops the padding off and pads rows to 4 bytes, as uncompressed data must be', () => {
    // 3 wanted of 4 pixels, 2 rows: 1 2 3 x / 4 5 6 x
    const rle = hex('84' + '0100' + '0200' + '0300' + '0a00' + '84' + '0400' + '0500' + '0600' + '0b00')
    const out = fixSlowPathBitmaps(slowPath([rect(10, 20, 12, 21, 4, 2, rle)]))
    expect(out).toHaveLength(1)
    const share = dataOf((out as Buffer[])[0])
    expect(share.readUInt16LE(0)).toBe(22 + 18 + 16)
    expect(share.readUInt16LE(12)).toBe(22 + 18 + 16 - 14)
    const at = 22
    expect([0, 2, 4, 6, 8, 10, 12, 14, 16].map((o) => share.readUInt16LE(at + o))).toEqual([10, 20, 12, 21, 3, 2, 16, 0, 16])
    expect(pixels(share.subarray(at + 18))).toEqual([1, 2, 3, 0, 4, 5, 6, 0])
    expect((out as Buffer[])[0].readUInt16BE(2)).toBe((out as Buffer[])[0].length)
  })

  it('splits what would not fit one packet, bottom part first, covering the rectangle', () => {
    const width = 1000
    const height = 40
    const rle = hex('f3' + (width * height).toString(16).padStart(4, '0').replace(/(..)(..)/, '$2$1') + '0900')
    const out = fixSlowPathBitmaps(slowPath([rect(0, 100, width - 1, 100 + height - 1, width, height, rle)])) as Buffer[]
    expect(out.length).toBeGreaterThan(1)
    let expected = 100 + height - 1
    for (const pdu of out) {
      expect(pdu.length).toBeLessThan(65535)
      const r = dataOf(pdu).subarray(22)
      expect(r.readUInt16LE(6)).toBe(expected)
      expected = r.readUInt16LE(2) - 1
    }
    expect(expected).toBe(99)
  })

  it('leaves alone what is not RLE, and other PDUs', () => {
    expect(fixSlowPathBitmaps(slowPath([rect(0, 0, 1, 0, 2, 1, hex('01000200'), 0)]))).toBeUndefined()
    expect(fixSlowPathBitmaps(slowPath([rect(0, 0, 0, 0, 1, 1, hex('00'), 0x401, 32)]))).toBeUndefined()
    expect(fixSlowPathBitmaps(sendData(0x68, Buffer.alloc(40)))).toBeUndefined()
    expect(fixSlowPathBitmaps(tpkt(Buffer.concat([X224, hex('2e')])))).toBeUndefined()
  })

  it('fixes fast-path updates too and keeps the others beside them', () => {
    const r = rect(0, 0, 0, 0, 4, 1, hex('84' + '0700' + '0000' + '0000' + '0000'))
    const data = Buffer.concat([hex('01000100'), r])
    const update = Buffer.alloc(3)
    update[0] = 1
    update.writeUInt16LE(data.length, 1)
    const pointer = hex('0a0000')
    const body = Buffer.concat([update, data, pointer])
    const out = fixFastPathBitmaps(Buffer.concat([Buffer.from([0, body.length + 2]), body])) as Buffer
    expect(out.readUInt16BE(1) & 0x7fff).toBe(out.length)
    const fixed = out.subarray(3 + 7)
    expect(fixed.readUInt16LE(8)).toBe(1)
    expect(fixed.readUInt16LE(14)).toBe(0)
    expect(pixels(fixed.subarray(18, 22))[0]).toBe(7)
    expect(out.subarray(-3).equals(pointer)).toBe(true)
    expect(fixFastPathBitmaps(hex('000a' + '0a0000' + '0a0000' + '0a00'))).toBeUndefined()
  })
})
