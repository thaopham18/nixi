import { randomBytes } from 'crypto'
import { connect as netConnect, isIP } from 'net'
import type { Duplex } from 'stream'
import { connect as tlsConnect } from 'tls'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { NOVNC_SECURITY_TYPES, SEC_VENCRYPT, VNC_PROXY_ERROR } from '@shared/vnc'

/**
 * Local gateway for the noVNC client in the renderer: WebSocket ⇄ TCP (or an SSH channel).
 * Reachable only with a one-time ticket from the main process, so it is not an open relay.
 *
 * Normally it just relays bytes, but it watches the RFB security handshake because noVNC cannot
 * do VeNCrypt with TLS. When a server offers VeNCrypt the proxy negotiates it, wraps the link in
 * TLS and then shows noVNC only the inner authentication (VNC password, Plain or None).
 */

export interface VncTarget {
  host: string
  port: number
  open(): Promise<Duplex>
  /** trust-on-first-use check of the server's TLS certificate (DER) */
  verifyCert(der: Buffer): Promise<boolean>
}

const X509_NONE = 260
const X509_VNC = 261
const X509_PLAIN = 262
const PLAIN = 256
const TLS_SUBTYPES = [X509_PLAIN, X509_VNC, X509_NONE]
/** what noVNC is told to run for each VeNCrypt subtype: 1 None, 2 VNC password, PLAIN username + password */
const INNER_AUTH: Record<number, number> = { [X509_NONE]: 1, [X509_VNC]: 2, [X509_PLAIN]: PLAIN, 1: 1, 2: 2, [PLAIN]: PLAIN }

const READ_TIMEOUT = 20_000
const HIGH_WATER = 16 * 1024 * 1024
const LOW_WATER = 1024 * 1024

class Failure extends Error {}

/** Exact-length reads over a stream of chunks. */
class Bytes {
  private buf: Buffer = Buffer.alloc(0)
  private waiting?: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }
  private ended?: Error

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    this.settle()
  }

  end(err: Error): void {
    this.ended ??= err
    this.settle()
  }

  read(n: number, timeoutMs?: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiting = { n, resolve, reject }
      if (timeoutMs) this.waiting.timer = setTimeout(() => this.end(new Failure('The server stopped answering during the handshake.')), timeoutMs)
      this.settle()
    })
  }

  private settle(): void {
    const w = this.waiting
    if (!w) return
    if (this.buf.length >= w.n) {
      this.waiting = undefined
      clearTimeout(w.timer)
      const out = this.buf.subarray(0, w.n)
      this.buf = this.buf.subarray(w.n)
      w.resolve(out)
    } else if (this.ended) {
      this.waiting = undefined
      clearTimeout(w.timer)
      w.reject(this.ended)
    }
  }

  /** Whatever arrived beyond the last read. */
  drain(): Buffer {
    const rest = this.buf
    this.buf = Buffer.alloc(0)
    return rest
  }
}

/** A server link during the handshake; release() hands the stream on, paused. */
function attach(stream: Duplex): { stream: Duplex; bytes: Bytes; release(): Buffer } {
  const bytes = new Bytes()
  const onData = (d: Buffer): void => bytes.push(d)
  const onEnd = (): void => bytes.end(new Failure('The server closed the connection during the handshake.'))
  const onError = (e: Error): void => bytes.end(new Failure(`Connection error: ${e.message}`))
  stream.on('data', onData).on('end', onEnd).on('close', onEnd).on('error', onError)
  return {
    stream,
    bytes,
    release() {
      stream.pause()
      stream.off('data', onData).off('end', onEnd).off('close', onEnd).off('error', onError)
      return bytes.drain()
    }
  }
}
type Link = ReturnType<typeof attach>

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

const minorVersion = (greeting: Buffer): number => Number(greeting.subarray(8, 11).toString())

async function readSecurityTypes(link: Link): Promise<number[]> {
  const count = (await link.bytes.read(1, READ_TIMEOUT))[0]
  if (count === 0) {
    const len = (await link.bytes.read(4, READ_TIMEOUT)).readUInt32BE()
    throw new Failure((await link.bytes.read(len, READ_TIMEOUT)).toString() || 'The server refused the connection.')
  }
  return [...(await link.bytes.read(count, READ_TIMEOUT))]
}

async function startTls(link: Link, target: VncTarget): Promise<Link> {
  const rest = link.release()
  if (rest.length) link.stream.unshift(rest)
  const secure = tlsConnect({
    socket: link.stream,
    rejectUnauthorized: false, // self-signed is the norm for VNC: checked below, trust on first use
    servername: isIP(target.host) ? undefined : target.host
  })
  await new Promise<void>((resolve, reject) => {
    secure.once('secureConnect', resolve).once('error', (e) => reject(new Failure(`TLS failed: ${e.message}`)))
  })
  const der = secure.getPeerCertificate().raw
  if (!der || !(await target.verifyCert(der))) {
    secure.destroy()
    throw new Failure('The server certificate was not trusted.')
  }
  return attach(secure)
}

function serve(ws: WebSocket, target: VncTarget): void {
  const client = new Bytes()
  let toServer: ((d: Buffer) => void) | undefined
  let server: Duplex | undefined
  let greeted = false
  ws.on('message', (d: RawData) => {
    const chunk = d as Buffer
    if (toServer) toServer(chunk)
    else client.push(chunk)
  })
  ws.on('close', () => {
    client.end(new Error('closed'))
    server?.destroy()
  })
  ws.on('error', () => server?.destroy())

  const dial = async (): Promise<Link> => {
    const link = attach(await target.open())
    server = link.stream
    return link
  }

  const relay = (link: Link): void => {
    const stream = link.stream
    const early = link.release()
    if (early.length) ws.send(early)
    const pending = client.drain()
    if (pending.length) stream.write(pending)
    toServer = (d) => void stream.write(d)
    let paused = false
    stream.on('data', (d: Buffer) => {
      ws.send(d, () => {
        if (paused && ws.bufferedAmount < LOW_WATER) {
          paused = false
          stream.resume()
        }
      })
      if (ws.bufferedAmount > HIGH_WATER) {
        paused = true
        stream.pause()
      }
    })
    stream.on('close', () => ws.close()).on('error', () => ws.close())
    stream.resume()
  }

  /** Pass the list on to noVNC, unless it could only fail on it. */
  const offer = (types: number[], link: Link): void => {
    if (!types.some((t) => NOVNC_SECURITY_TYPES.includes(t))) {
      throw new Failure(
        `The server requires a security type Nixi does not support (${types.join(', ')}). ` +
          'On RealVNC Server, set Encryption to "Prefer on" or lower it for this connection.'
      )
    }
    ws.send(Buffer.from([types.length, ...types]))
    relay(link)
  }

  const run = async (): Promise<void> => {
    let link = await dial()
    const greeting = await link.bytes.read(12, READ_TIMEOUT)
    if (!/^RFB \d{3}\.\d{3}\n$/.test(greeting.toString('latin1'))) throw new Failure('This port does not answer like a VNC server.')
    ws.send(greeting)
    greeted = true
    const version = await client.read(12)
    link.stream.write(version)
    // RFB 3.3: the server picks the security type by itself, nothing to choose.
    if (minorVersion(version) < 7) return relay(link)

    const types = await readSecurityTypes(link)
    if (!types.includes(SEC_VENCRYPT)) return offer(types, link)
    const others = types.filter((t) => t !== SEC_VENCRYPT && NOVNC_SECURITY_TYPES.includes(t))

    /** A security type cannot be taken back: use the other types over a new connection. */
    const withoutVeNCrypt = async (): Promise<void> => {
      link.stream.destroy()
      link = await dial()
      await link.bytes.read(12, READ_TIMEOUT)
      link.stream.write(version)
      offer((await readSecurityTypes(link)).filter((t) => t !== SEC_VENCRYPT), link)
    }

    link.stream.write(Buffer.from([SEC_VENCRYPT]))
    const [major, minor] = await link.bytes.read(2, READ_TIMEOUT)
    if (major !== 0 || minor < 2) {
      if (others.length) return withoutVeNCrypt()
      throw new Failure('The server only offers an old VeNCrypt version that Nixi does not support.')
    }
    link.stream.write(Buffer.from([0, 2]))
    if ((await link.bytes.read(1, READ_TIMEOUT))[0] !== 0) throw new Failure('The server rejected VeNCrypt 0.2.')
    const n = (await link.bytes.read(1, READ_TIMEOUT))[0]
    const list = await link.bytes.read(4 * n, READ_TIMEOUT)
    const subtypes = Array.from({ length: n }, (_, i) => list.readUInt32BE(i * 4))

    // Prefer TLS; without it another security type is no worse than VeNCrypt in the clear.
    let chosen = subtypes.find((t) => TLS_SUBTYPES.includes(t))
    if (chosen === undefined) {
      if (others.length) return withoutVeNCrypt()
      chosen = subtypes.find((t) => INNER_AUTH[t])
    }
    if (chosen === undefined) {
      // TLSNone/TLSVnc/TLSPlain use anonymous Diffie-Hellman, which Electron's BoringSSL does not have.
      throw new Failure(
        `The server only offers VeNCrypt with anonymous TLS (${subtypes.join(', ')}), which Nixi cannot do. ` +
          'Enable X509 or plain VNC authentication on the server, or reach it through an SSH jump host.'
      )
    }
    link.stream.write(u32(chosen))
    if (TLS_SUBTYPES.includes(chosen)) {
      if ((await link.bytes.read(1, READ_TIMEOUT))[0] !== 1) throw new Failure('The server could not start TLS.')
      link = await startTls(link, target)
      server = link.stream
    }

    const inner = INNER_AUTH[chosen]
    if (inner === PLAIN) {
      // noVNC only knows Plain as a VeNCrypt subtype, so play the server's part of that exchange.
      ws.send(Buffer.from([1, SEC_VENCRYPT]))
      await client.read(1)
      ws.send(Buffer.from([0, 2]))
      await client.read(2)
      ws.send(Buffer.from([0]))
      ws.send(Buffer.concat([Buffer.from([1]), u32(PLAIN)]))
      await client.read(4)
    } else {
      ws.send(Buffer.from([1, inner]))
      await client.read(1)
    }
    relay(link)
  }

  /** Tell noVNC in RFB terms, so the reason reaches the user instead of a bare closed socket. */
  const fail = async (reason: string): Promise<void> => {
    if (!greeted) {
      ws.send(Buffer.from('RFB 003.008\n'))
      await client.read(12)
    }
    const text = Buffer.from(VNC_PROXY_ERROR + reason)
    ws.send(Buffer.concat([Buffer.from([0]), u32(text.length), text]), () => ws.close())
  }

  run().catch((err: Error) => {
    server?.destroy()
    if (ws.readyState !== ws.OPEN) return
    fail(err instanceof Failure ? err.message : `Could not reach ${target.host}:${target.port} (${err.message}).`).catch(() => ws.close())
  })
}

interface Ticket {
  target: VncTarget
  expires: number
}

const tickets = new Map<string, Ticket>()
let listening: Promise<{ wss: WebSocketServer; port: number }> | undefined

function ensureServer(): Promise<{ wss: WebSocketServer; port: number }> {
  listening ??= new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      maxPayload: 64 * 1024 * 1024,
      verifyClient: ({ req }, done) => done(takeTicket(req.url, false) !== undefined)
    })
    wss.on('connection', (ws, req) => {
      const ticket = takeTicket(req.url, true)
      if (ticket) serve(ws, ticket.target)
      else ws.close()
    })
    wss.once('listening', () => resolve({ wss, port: (wss.address() as { port: number }).port }))
    wss.once('error', reject)
  })
  return listening
}

function takeTicket(url: string | undefined, consume: boolean): Ticket | undefined {
  const token = url?.split('/').pop() ?? ''
  const ticket = tickets.get(token)
  if (consume) tickets.delete(token)
  return ticket && ticket.expires > Date.now() ? ticket : undefined
}

/** A WebSocket URL for noVNC that works once, within a minute. */
export async function issueVncTicket(target: VncTarget): Promise<string> {
  const { port } = await ensureServer()
  const token = randomBytes(24).toString('hex')
  tickets.set(token, { target, expires: Date.now() + 60_000 })
  return `ws://127.0.0.1:${port}/vnc/${token}`
}

export function openTcp(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port, timeout: 15_000 })
    socket.setNoDelay(true)
    socket.once('timeout', () => socket.destroy(new Error('timed out')))
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      socket.setTimeout(0)
      resolve(socket)
    })
  })
}

export function stopVncProxy(): void {
  void listening?.then(({ wss }) => {
    for (const c of wss.clients) c.terminate()
    wss.close()
  })
  listening = undefined
  tickets.clear()
}
