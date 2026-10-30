// RDCleanPath PDU (IronRDP's WebSocket ↔ RDP proxy handshake), DER with explicit context tags:
//   RDCleanPathPdu ::= SEQUENCE {
//     version [0] INTEGER, error [1] RDCleanPathErr OPTIONAL, destination [2] UTF8String OPTIONAL,
//     proxy_auth [3] UTF8String OPTIONAL, server_auth [4] UTF8String OPTIONAL,
//     preconnection_blob [5] UTF8String OPTIONAL, x224_connection_pdu [6] OCTET STRING OPTIONAL,
//     server_cert_chain [7] SEQUENCE OF OCTET STRING OPTIONAL, server_addr [9] UTF8String OPTIONAL }
//   RDCleanPathErr ::= SEQUENCE { error_code [0] INTEGER, http_status_code [1] INTEGER OPTIONAL,
//     wsa_last_error [2] INTEGER OPTIONAL, tls_alert_code [3] INTEGER OPTIONAL }

export const RDCLEANPATH_VERSION = 3390
export const GENERAL_ERROR = 1
export const NEGOTIATION_ERROR = 2

export interface RDCleanPathErr {
  errorCode: number
  httpStatusCode?: number
  wsaLastError?: number
  tlsAlertCode?: number
}

export interface RDCleanPathPdu {
  version: number
  error?: RDCleanPathErr
  destination?: string
  proxyAuth?: string
  serverAuth?: string
  preconnectionBlob?: string
  x224?: Buffer
  serverCertChain?: Buffer[]
  serverAddr?: string
}

// ---------------------------------------------------------------- DER primitives

function encLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encLen(content.length), content])
}

function encInt(n: number): Buffer {
  const bytes: number[] = []
  do {
    bytes.unshift(n & 0xff)
    n = Math.floor(n / 256)
  } while (n > 0)
  if (bytes[0] & 0x80) bytes.unshift(0)
  return tlv(0x02, Buffer.from(bytes))
}

const ctx = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner)
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
const octets = (b: Buffer): Buffer => tlv(0x04, b)
const seq = (parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts))

interface Tlv {
  tag: number
  content: Buffer
  /** total encoded size */
  size: number
}

/** Read one TLV; returns null when the buffer does not hold the whole element yet. */
export function readTlv(buf: Buffer, off = 0): Tlv | null {
  if (buf.length < off + 2) return null
  const tag = buf[off]
  let len = buf[off + 1]
  let hdr = 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4) throw new Error('Unsupported DER length')
    if (buf.length < off + 2 + n) return null
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i]
    hdr += n
  }
  if (buf.length < off + hdr + len) return null
  return { tag, content: buf.subarray(off + hdr, off + hdr + len), size: hdr + len }
}

function children(buf: Buffer): Tlv[] {
  const out: Tlv[] = []
  for (let off = 0; off < buf.length; ) {
    const t = readTlv(buf, off)
    if (!t) throw new Error('Truncated DER')
    out.push(t)
    off += t.size
  }
  return out
}

function decInt(t: Tlv): number {
  if (t.tag !== 0x02) throw new Error('Expected INTEGER')
  let n = 0
  for (const b of t.content) n = n * 256 + b
  return n
}

/** Contents of an explicitly tagged field: the single inner element. */
function inner(t: Tlv): Tlv {
  const [c] = children(t.content)
  return c
}

// ---------------------------------------------------------------- PDU

export function encodePdu(p: RDCleanPathPdu): Buffer {
  const parts: Buffer[] = [ctx(0, encInt(p.version))]
  if (p.error) {
    const e: Buffer[] = [ctx(0, encInt(p.error.errorCode))]
    if (p.error.httpStatusCode !== undefined) e.push(ctx(1, encInt(p.error.httpStatusCode)))
    if (p.error.wsaLastError !== undefined) e.push(ctx(2, encInt(p.error.wsaLastError)))
    if (p.error.tlsAlertCode !== undefined) e.push(ctx(3, encInt(p.error.tlsAlertCode)))
    parts.push(ctx(1, seq(e)))
  }
  if (p.destination !== undefined) parts.push(ctx(2, utf8(p.destination)))
  if (p.proxyAuth !== undefined) parts.push(ctx(3, utf8(p.proxyAuth)))
  if (p.serverAuth !== undefined) parts.push(ctx(4, utf8(p.serverAuth)))
  if (p.preconnectionBlob !== undefined) parts.push(ctx(5, utf8(p.preconnectionBlob)))
  if (p.x224) parts.push(ctx(6, octets(p.x224)))
  if (p.serverCertChain) parts.push(ctx(7, seq(p.serverCertChain.map(octets))))
  if (p.serverAddr !== undefined) parts.push(ctx(9, utf8(p.serverAddr)))
  return seq(parts)
}

/** Decode a complete PDU; returns null if `buf` does not yet contain the whole PDU. */
export function decodePdu(buf: Buffer): { pdu: RDCleanPathPdu; size: number } | null {
  const outer = readTlv(buf)
  if (!outer) return null
  if (outer.tag !== 0x30) throw new Error('RDCleanPath PDU is not a SEQUENCE')
  const pdu: RDCleanPathPdu = { version: 0 }
  for (const f of children(outer.content)) {
    const n = f.tag & 0x1f
    const v = inner(f)
    switch (n) {
      case 0:
        pdu.version = decInt(v)
        break
      case 1: {
        const err: RDCleanPathErr = { errorCode: 0 }
        for (const e of children(v.content)) {
          const val = decInt(inner(e))
          const k = e.tag & 0x1f
          if (k === 0) err.errorCode = val
          else if (k === 1) err.httpStatusCode = val
          else if (k === 2) err.wsaLastError = val
          else if (k === 3) err.tlsAlertCode = val
        }
        pdu.error = err
        break
      }
      case 2:
        pdu.destination = v.content.toString('utf8')
        break
      case 3:
        pdu.proxyAuth = v.content.toString('utf8')
        break
      case 4:
        pdu.serverAuth = v.content.toString('utf8')
        break
      case 5:
        pdu.preconnectionBlob = v.content.toString('utf8')
        break
      case 6:
        pdu.x224 = Buffer.from(v.content)
        break
      case 7:
        pdu.serverCertChain = children(v.content).map((c) => Buffer.from(c.content))
        break
      case 9:
        pdu.serverAddr = v.content.toString('utf8')
        break
    }
  }
  return { pdu, size: outer.size }
}

/** Length of the TPKT packet at the start of `buf` (X.224 is carried in TPKT), or null if incomplete. */
export function tpktLength(buf: Buffer): number | null {
  if (buf.length < 4) return null
  if (buf[0] !== 3) throw new Error('Not a TPKT packet')
  const len = buf.readUInt16BE(2)
  return buf.length >= len ? len : null
}

/** RDP_NEG_FAILURE (type 0x03) in an X.224 Connection Confirm. */
export function isNegotiationFailure(x224: Buffer): boolean {
  // TPKT(4) + X.224 CC header(7) then RDP_NEG_* structure
  return x224.length >= 12 && x224[11] === 0x03
}
