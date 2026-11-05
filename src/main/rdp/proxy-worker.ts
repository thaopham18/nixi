// Runs in an Electron utilityProcess so RDP traffic never waits on the main process
// (IPC, SSH terminals, SFTP). Talks to the main process over process.parentPort.
import { connect as netConnect, type Socket } from 'net'
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'tls'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  GENERAL_ERROR,
  NEGOTIATION_ERROR,
  RDCLEANPATH_VERSION,
  decodePdu,
  encodePdu,
  isNegotiationFailure,
  asTlsResponse,
  isStandardRdpSecurity,
  tpktLength
} from './rdcleanpath'
import { PLACEHOLDER_CERT, Framer, StandardSecurity } from './standard-security'
import { fixFastPathBitmaps, fixSlowPathBitmaps } from './bitmap'

/**
 * Local RDCleanPath gateway for the IronRDP WASM client running in the renderer:
 * WebSocket (renderer) ⇄ TCP + TLS (RDP server). The renderer can only reach targets
 * the main process issued a one-time ticket for, so it is not an open relay.
 */

export type ToWorker =
  | { type: 'ticket'; token: string; host: string; port: number }
  | { type: 'verify-result'; id: number; ok: boolean }
export type FromWorker =
  | { type: 'ready'; port: number }
  | { type: 'verify'; id: number; host: string; port: number; cert: string }
  | { type: 'log'; message: string }

interface Ticket {
  host: string
  port: number
  expires: number
}

interface ParentPort {
  on(event: 'message', cb: (e: { data: ToWorker }) => void): void
  postMessage(msg: FromWorker): void
}
const parent = (process as unknown as { parentPort: ParentPort }).parentPort

const tickets = new Map<string, Ticket>()
const verifications = new Map<number, (ok: boolean) => void>()
let nextVerify = 0

parent.on('message', ({ data }) => {
  if (data.type === 'ticket') tickets.set(data.token, { host: data.host, port: data.port, expires: Date.now() + 60_000 })
  else if (data.type === 'verify-result') {
    verifications.get(data.id)?.(data.ok)
    verifications.delete(data.id)
  }
})

/** Trust-on-first-use check of the server certificate, answered by the main process (it owns the dialog). */
function verifyCert(host: string, port: number, cert: Buffer): Promise<boolean> {
  const id = nextVerify++
  return new Promise((resolve) => {
    verifications.set(id, resolve)
    parent.postMessage({ type: 'verify', id, host, port, cert: cert.toString('base64') })
  })
}

const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 * 1024 * 1024 })
server.on('connection', (ws) => handle(ws))
server.once('listening', () => parent.postMessage({ type: 'ready', port: (server.address() as { port: number }).port }))

function sendError(ws: WebSocket, errorCode: number, x224?: Buffer, reason?: string): void {
  parent.postMessage({ type: 'log', message: `[rdp-proxy] error ${errorCode}: ${reason ?? ''}` })
  ws.send(encodePdu({ version: RDCLEANPATH_VERSION, error: { errorCode }, x224 }))
  ws.close()
}

function readTpkt(sock: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d])
      try {
        const len = tpktLength(buf)
        if (len === null) return
        cleanup()
        if (buf.length > len) sock.unshift(buf.subarray(len))
        resolve(buf.subarray(0, len))
      } catch (err) {
        cleanup()
        reject(err)
      }
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error('Server closed the connection during negotiation'))
    }
    const cleanup = (): void => {
      sock.off('data', onData)
      sock.off('close', onEnd)
      sock.off('error', onEnd)
    }
    sock.on('data', onData)
    sock.once('close', onEnd)
    sock.once('error', onEnd)
  })
}

function certChain(sock: TLSSocket): Buffer[] {
  const chain: Buffer[] = []
  let cert: PeerCertificate | undefined = sock.getPeerCertificate(true)
  const seen = new Set<string>()
  while (cert?.raw && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256)
    chain.push(cert.raw)
    cert = (cert as PeerCertificate & { issuerCertificate?: PeerCertificate }).issuerCertificate
  }
  return chain
}

/** TCP connect, X.224 negotiation, then TLS with the RDP server. */
async function negotiate(
  ticket: Ticket,
  x224Request: Buffer,
  rsaKeyExchange: boolean
): Promise<{ failure: Buffer } | { plain: Socket; x224Response: Buffer } | { secure: TLSSocket; tcp: Socket; x224Response: Buffer }> {
  const tcp = await new Promise<Socket>((resolve, reject) => {
    const s = netConnect(ticket.port, ticket.host)
    s.setNoDelay(true)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
    s.setTimeout(15000, () => s.destroy(new Error('Connection timed out')))
  })
  tcp.setTimeout(0)
  tcp.write(x224Request)
  const x224Response = await readTpkt(tcp)
  if (isNegotiationFailure(x224Response)) {
    tcp.destroy()
    return { failure: x224Response }
  }
  if (isStandardRdpSecurity(x224Response)) {
    return { plain: tcp, x224Response }
  }
  const secure = tlsConnect({
    socket: tcp,
    rejectUnauthorized: false,
    ...(rsaKeyExchange
      ? { maxVersion: 'TLSv1.2' as const, ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA:AES128-SHA' }
      : {})
  })
  try {
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve)
      secure.once('error', reject)
    })
  } catch (err) {
    secure.destroy()
    throw err
  }
  return { secure, tcp, x224Response }
}

/** What the server sends goes through here on its way to IronRDP. If it can't be followed, it just passes. */
function bitmapFixer(send: (d: Buffer) => void): (d: Buffer) => void {
  const framer = new Framer()
  let broken = false
  return (data) => {
    if (broken) return send(data)
    try {
      for (const pdu of framer.push(data)) {
        let fixed: Buffer[] | undefined
        try {
          fixed = pdu[0] === 3 ? fixSlowPathBitmaps(pdu) : [fixFastPathBitmaps(pdu)].flatMap((p) => (p ? [p] : []))
        } catch (err) {
          parent.postMessage({ type: 'log', message: `[rdp-proxy] bitmap left as it was: ${(err as Error).message}` })
        }
        if (fixed?.length) fixed.forEach(send)
        else send(pdu)
      }
    } catch {
      broken = true // not RDP framing after all
    }
  }
}

function handle(ws: WebSocket): void {
  let pending = Buffer.alloc(0)
  let tls: { write(data: Buffer): unknown; destroy(): unknown } | undefined
  let started = false
  const queued: Buffer[] = []

  ws.on('message', (data: Buffer) => {
    if (tls) return void tls.write(data)
    if (started) return void queued.push(data)
    pending = Buffer.concat([pending, data])
    let decoded
    try {
      decoded = decodePdu(pending)
    } catch (err) {
      return sendError(ws, GENERAL_ERROR, undefined, `bad RDCleanPath request: ${(err as Error).message}`)
    }
    if (!decoded) return
    started = true
    if (pending.length > decoded.size) queued.push(pending.subarray(decoded.size))
    void start(decoded.pdu.proxyAuth, decoded.pdu.x224)
  })
  ws.on('close', () => tls?.destroy())
  ws.on('error', () => tls?.destroy())

  /** A server without TLS: tell IronRDP it has TLS, and do the old security here. */
  function standardSecurity(tcp: Socket, x224Response: Buffer, ticket: Ticket): void {
    parent.postMessage({ type: 'log', message: '[rdp-proxy] server has no TLS, using standard RDP security' })
    const close = (reason: string): void => {
      parent.postMessage({ type: 'log', message: `[rdp-proxy] ${reason}` })
      tcp.destroy()
      ws.close()
    }
    const security = new StandardSecurity({
      toServer: (d) => void tcp.write(d),
      toClient: bitmapFixer((d) => ws.readyState === ws.OPEN && ws.send(d)),
      verify: (cert) => verifyCert(ticket.host, ticket.port, cert),
      fail: close
    })
    ws.send(
      encodePdu({
        version: RDCLEANPATH_VERSION,
        x224: asTlsResponse(x224Response),
        serverCertChain: [PLACEHOLDER_CERT],
        serverAddr: `${tcp.remoteAddress}:${tcp.remotePort}`
      })
    )
    tcp.on('data', (d: Buffer) => security.fromServer(d))
    tcp.on('close', () => ws.close())
    tcp.on('error', () => ws.close())
    tls = { write: (d) => security.fromClient(d), destroy: () => tcp.destroy() }
    for (const q of queued.splice(0)) security.fromClient(q)
  }

  async function start(token: string | undefined, x224Request: Buffer | undefined): Promise<void> {
    const ticket = token ? tickets.get(token) : undefined
    if (token) tickets.delete(token)
    if (!ticket || ticket.expires < Date.now()) return sendError(ws, GENERAL_ERROR, undefined, 'invalid or expired ticket')
    if (!x224Request) return sendError(ws, GENERAL_ERROR, undefined, 'missing X.224 request')

    try {
      let conn: Awaited<ReturnType<typeof negotiate>>
      try {
        conn = await negotiate(ticket, x224Request, false)
      } catch (err) {
        // Windows' self-signed RDP certificates often lack the digitalSignature key usage, which
        // BoringSSL requires for ECDHE. Retry with RSA key exchange, as mstsc effectively does.
        if (!/KEY_USAGE_BIT_INCORRECT/.test((err as Error).message)) throw err
        conn = await negotiate(ticket, x224Request, true)
      }
      if ('failure' in conn) {
        return sendError(ws, NEGOTIATION_ERROR, conn.failure, 'server refused the requested security protocol')
      }
      if ('plain' in conn) return standardSecurity(conn.plain, conn.x224Response, ticket as Ticket)
      const { secure, tcp, x224Response } = conn
      const chain = certChain(secure)
      // RDP servers mostly use self-signed certs: trust on first use, warn when it changes.
      if (!chain.length || !(await verifyCert(ticket.host, ticket.port, chain[0]))) {
        secure.destroy()
        return sendError(ws, GENERAL_ERROR, undefined, 'server certificate not trusted')
      }

      ws.send(
        encodePdu({
          version: RDCLEANPATH_VERSION,
          x224: x224Response,
          serverCertChain: chain,
          serverAddr: `${tcp.remoteAddress}:${tcp.remotePort}`
        })
      )
      tls = secure
      for (const q of queued.splice(0)) secure.write(q)
      const toClient = bitmapFixer((d) => ws.readyState === ws.OPEN && ws.send(d))
      secure.on('data', toClient)
      secure.on('close', () => ws.close())
      secure.on('error', () => ws.close())
    } catch (err) {
      sendError(ws, GENERAL_ERROR, undefined, (err as Error).message)
    }
  }
}
