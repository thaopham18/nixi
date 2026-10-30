import type { Socket } from 'net'

export interface SocksRequest {
  host: string
  port: number
  /** bytes consumed from the buffer */
  length: number
}

/** Parse a SOCKS5 CONNECT request. Returns null if more data is needed; throws on unsupported input. */
export function parseSocks5Request(buf: Buffer): SocksRequest | null {
  if (buf.length < 5) return null
  if (buf[0] !== 5) throw new Error('Not SOCKS5')
  if (buf[1] !== 1) throw new Error('Only CONNECT is supported')
  const atyp = buf[3]
  let host: string
  let off: number
  if (atyp === 1) {
    if (buf.length < 10) return null
    host = Array.from(buf.subarray(4, 8)).join('.')
    off = 8
  } else if (atyp === 3) {
    const len = buf[4]
    if (buf.length < 5 + len + 2) return null
    host = buf.subarray(5, 5 + len).toString('utf8')
    off = 5 + len
  } else if (atyp === 4) {
    if (buf.length < 22) return null
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
    host = parts.join(':')
    off = 20
  } else {
    throw new Error(`Unsupported address type ${atyp}`)
  }
  return { host, port: buf.readUInt16BE(off), length: off + 2 }
}

/** Greeting: VER NMETHODS METHODS... Returns bytes consumed or null. */
export function parseSocks5Greeting(buf: Buffer): number | null {
  if (buf.length < 2) return null
  if (buf[0] !== 5) throw new Error('Not SOCKS5')
  const n = buf[1]
  if (buf.length < 2 + n) return null
  return 2 + n
}

export const SOCKS_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
export const SOCKS_FAIL = Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])

/** Run the SOCKS5 handshake on a socket, resolving the requested destination and any leftover bytes. */
export function socks5Handshake(sock: Socket): Promise<{ host: string; port: number; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    let stage: 'greet' | 'req' = 'greet'
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      try {
        if (stage === 'greet') {
          const used = parseSocks5Greeting(buf)
          if (used === null) return
          buf = buf.subarray(used)
          sock.write(Buffer.from([5, 0])) // no auth
          stage = 'req'
        }
        const req = parseSocks5Request(buf)
        if (!req) return
        sock.off('data', onData)
        resolve({ host: req.host, port: req.port, rest: buf.subarray(req.length) })
      } catch (err) {
        sock.off('data', onData)
        sock.destroy()
        reject(err)
      }
    }
    sock.on('data', onData)
    sock.once('error', reject)
  })
}
