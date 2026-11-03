import { connect as netConnect, createServer, type Server, type Socket } from 'net'
import type { WebContents } from 'electron'
import type { Client, ClientChannel } from 'ssh2'
import { isNetworkError, RETRY_LIMIT, RETRY_SECONDS } from '@shared/reconnect'
import type { Tunnel, TunnelServer, TunnelStatus } from '@shared/types'
import { deleteSecret, getSecret, hasSecret, setSecret } from '../store/secrets'
import { getSession, getSettings, tunnelStore } from '../store/stores'
import { connectSsh, targetFromSession, type SshTarget } from './connect'
import { SOCKS_FAIL, SOCKS_OK, socks5Handshake } from './socks'

interface Running {
  status: TunnelStatus
  client?: Client
  server?: Server
  sockets: Set<Socket>
  stopping: boolean
  retry?: NodeJS.Timeout
  /** tries since the connection was last up */
  tries: number
}

const running = new Map<string, Running>()
let sink: WebContents | undefined

export function setTunnelSink(wc: WebContents): void {
  sink = wc
}

/** Only the current run speaks: sockets of a stopped one close later, and would bring its old state back. */
function emit(r: Running): void {
  if (running.get(r.status.id) === r && sink && !sink.isDestroyed()) sink.send('tunnel:status', r.status)
}

export function tunnelStatuses(): TunnelStatus[] {
  return tunnelStore.get().map(
    (t) => running.get(t.id)?.status ?? { id: t.id, state: 'stopped', connections: 0 }
  )
}

function pipeBoth(sock: Socket, ch: ClientChannel, r: Running): void {
  if (r.stopping) {
    sock.destroy()
    ch.close()
    return
  }
  r.sockets.add(sock)
  r.status.connections++
  emit(r)
  sock.pipe(ch).pipe(sock)
  const done = (): void => {
    if (!r.sockets.delete(sock)) return
    r.status.connections--
    emit(r)
    sock.destroy()
    ch.close()
  }
  sock.on('close', done).on('error', done)
  ch.on('close', done).on('error', done)
}

function forwardOut(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) =>
    client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch)))
  )
}

const secretId = (id: string): string => `tunnel:${id}`

function targetOf(t: Tunnel): SshTarget {
  if (t.server) {
    const secret = getSecret(secretId(t.id))
    return {
      host: t.server.host,
      port: t.server.port,
      username: t.server.username || process.env.USER || process.env.USERNAME || 'root',
      auth: secret ? 'password' : 'agent',
      secret
    }
  }
  const session = getSession(t.sessionId)
  if (!session) throw new Error('Session not found')
  return targetFromSession(session)
}

async function start(t: Tunnel, r: Running): Promise<void> {
  const { client } = await connectSsh(targetOf(t))
  // Stopped during the login: it has nothing to tear down until now.
  if (r.stopping) {
    client.end()
    return
  }
  r.client = client
  client.on('close', () => {
    r.server?.close()
    r.server = undefined
    r.client = undefined
    // Taken out first, so their late closes don't count down from the next run's zero.
    const sockets = [...r.sockets]
    r.sockets.clear()
    sockets.forEach((s) => s.destroy())
    if (r.stopping) return
    if (getSettings().autoReconnect) return retryLater(t, r, 'Connection lost')
    clearTimeout(r.retry)
    r.stopping = true
    r.status = { id: t.id, state: 'error', connections: 0, error: 'Connection lost' }
    emit(r)
  })
  client.on('error', () => {})

  if (t.type === 'R') {
    await new Promise<void>((resolve, reject) =>
      client.forwardIn(t.bindHost || '127.0.0.1', t.bindPort, (err) => (err ? reject(err) : resolve()))
    )
    client.on('tcp connection', (_info, accept) => {
      const ch = accept()
      const sock = netConnect(t.destPort!, t.destHost || '127.0.0.1')
      sock.once('connect', () => pipeBoth(sock, ch, r))
      sock.once('error', () => ch.close())
    })
    return
  }

  const server = createServer((sock) => {
    if (t.type === 'L') {
      forwardOut(client, t.destHost!, t.destPort!).then(
        (ch) => pipeBoth(sock, ch, r),
        () => sock.destroy()
      )
      return
    }
    socks5Handshake(sock).then(
      async ({ host, port, rest }) => {
        try {
          const ch = await forwardOut(client, host, port)
          sock.write(SOCKS_OK)
          if (rest.length) ch.write(rest)
          pipeBoth(sock, ch, r)
        } catch {
          sock.end(SOCKS_FAIL)
        }
      },
      () => sock.destroy()
    )
  })
  r.server = server
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(t.bindPort, t.bindHost || '127.0.0.1', () => resolve())
  })
  // close() does nothing to a server that isn't listening yet, as when a host name is still resolving.
  if (r.stopping) server.close()
}

/** Wait for the next try. Shown as still starting, since Stop is what ends it. */
function retryLater(t: Tunnel, r: Running, why: string): void {
  clearTimeout(r.retry)
  if (r.tries >= RETRY_LIMIT) {
    r.stopping = true
    r.status = { id: t.id, state: 'error', connections: 0, error: `${why}. Gave up after ${RETRY_LIMIT} tries` }
    emit(r)
    return
  }
  r.status = { id: t.id, state: 'starting', connections: 0, error: why }
  emit(r)
  r.retry = setTimeout(() => {
    r.tries++
    launch(t, r, why)
  }, RETRY_SECONDS * 1000)
}

/** Worth another try while the server is away. A refused login isn't: repeating it can lock the account. */
function canRetry(t: Tunnel, err: Error): boolean {
  if (isNetworkError(err.message)) return true
  // The port of the lost connection can stay taken on the server for a while.
  if (/EADDRINUSE|unable to bind/i.test(err.message)) return true
  // The link closing before the login reads like this, but a saved password was there to send.
  if (!/no password given/.test(err.message)) return false
  try {
    return !!targetOf(t).secret
  } catch {
    return false
  }
}

/** lost: why this is a retry, and not the start the user asked for. That one reports its failure and ends. */
function launch(t: Tunnel, r: Running, lost?: string): void {
  r.status = { id: t.id, state: 'starting', connections: 0, ...(lost ? { error: lost } : {}) }
  emit(r)
  start(t, r).then(
    () => {
      if (r.stopping) return
      r.tries = 0
      r.status = { id: t.id, state: 'running', connections: 0 }
      emit(r)
    },
    (err: Error) => {
      if (r.stopping) return
      if (lost && canRetry(t, err)) {
        // A connection that got this far closes by itself, and that also lands in retryLater: one timer either way.
        r.client?.end()
        r.server?.close()
        retryLater(t, r, lost)
        return
      }
      r.stopping = true
      r.client?.end()
      r.server?.close()
      r.status = { id: t.id, state: 'error', connections: 0, error: err.message }
      emit(r)
    }
  )
}

export function startTunnel(id: string): void {
  const t = tunnelStore.get().find((x) => x.id === id)
  if (!t) return
  stopTunnel(id)
  const r: Running = { status: { id, state: 'starting', connections: 0 }, sockets: new Set(), stopping: false, tries: 0 }
  running.set(id, r)
  launch(t, r)
}

export function stopTunnel(id: string): void {
  const r = running.get(id)
  if (!r) return
  r.stopping = true
  clearTimeout(r.retry)
  for (const s of r.sockets) s.destroy()
  r.server?.close()
  r.client?.end()
  running.delete(id)
  if (sink && !sink.isDestroyed()) sink.send('tunnel:status', { id, state: 'stopped', connections: 0 })
}

export function listTunnels(): Tunnel[] {
  return tunnelStore.get().map((t) => (t.server ? { ...t, hasSecret: hasSecret(secretId(t.id)) } : t))
}

const sameServer = (a: TunnelServer | undefined, b: TunnelServer | undefined): boolean =>
  !!a && !!b && a.host === b.host && a.port === b.port && a.username === b.username

/** passwords: only for typed servers whose password was just typed. The renderer never gets them back. */
export function saveTunnels(tunnels: Tunnel[], passwords: Record<string, string> = {}): Tunnel[] {
  const ids = new Set(tunnels.map((t) => t.id))
  for (const id of running.keys()) if (!ids.has(id)) stopTunnel(id)
  const before = tunnelStore.get()
  for (const t of before) if (!ids.has(t.id)) deleteSecret(secretId(t.id))
  for (const t of tunnels) {
    const typed = t.server && passwords[t.id]
    if (typed) setSecret(secretId(t.id), typed)
    // A saved password must never go to a server other than the one it was typed for.
    else if (!sameServer(t.server, before.find((x) => x.id === t.id)?.server)) deleteSecret(secretId(t.id))
  }
  tunnelStore.set(tunnels.map(({ hasSecret: _ignored, ...t }) => t))
  return listTunnels()
}

export function autoStartTunnels(): void {
  for (const t of tunnelStore.get()) if (t.autoStart) startTunnel(t.id)
}

export function stopAllTunnels(): void {
  for (const id of [...running.keys()]) stopTunnel(id)
}
