import { connect as netConnect, createServer, type Server, type Socket } from 'net'
import type { WebContents } from 'electron'
import type { Client, ClientChannel } from 'ssh2'
import type { Tunnel, TunnelStatus } from '@shared/types'
import { getSession, tunnelStore } from '../store/stores'
import { connectSsh, targetFromSession } from './connect'
import { SOCKS_FAIL, SOCKS_OK, socks5Handshake } from './socks'

interface Running {
  status: TunnelStatus
  client?: Client
  server?: Server
  sockets: Set<Socket>
  stopping: boolean
  retry?: NodeJS.Timeout
}

const running = new Map<string, Running>()
let sink: WebContents | undefined

export function setTunnelSink(wc: WebContents): void {
  sink = wc
}

function emit(r: Running): void {
  if (sink && !sink.isDestroyed()) sink.send('tunnel:status', r.status)
}

export function tunnelStatuses(): TunnelStatus[] {
  return tunnelStore.get().map(
    (t) => running.get(t.id)?.status ?? { id: t.id, state: 'stopped', connections: 0 }
  )
}

function pipeBoth(sock: Socket, ch: ClientChannel, r: Running): void {
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

async function start(t: Tunnel, r: Running): Promise<void> {
  const session = getSession(t.sessionId)
  if (!session) throw new Error('Session not found')
  const { client } = await connectSsh(targetFromSession(session))
  r.client = client
  client.on('close', () => {
    r.server?.close()
    r.server = undefined
    r.client = undefined
    if (r.stopping) return
    // Auto-reconnect after an unexpected drop.
    r.status = { id: t.id, state: 'error', connections: 0, error: 'Connection lost, retrying…' }
    emit(r)
    r.retry = setTimeout(() => launch(t, r), 5000)
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
}

function launch(t: Tunnel, r: Running): void {
  r.status = { id: t.id, state: 'starting', connections: 0 }
  emit(r)
  start(t, r).then(
    () => {
      r.status = { id: t.id, state: 'running', connections: 0 }
      emit(r)
    },
    (err: Error) => {
      r.client?.end()
      r.server?.close()
      r.stopping = true
      r.status = { id: t.id, state: 'error', connections: 0, error: err.message }
      emit(r)
    }
  )
}

export function startTunnel(id: string): void {
  const t = tunnelStore.get().find((x) => x.id === id)
  if (!t) return
  stopTunnel(id)
  const r: Running = { status: { id, state: 'starting', connections: 0 }, sockets: new Set(), stopping: false }
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

export function saveTunnels(tunnels: Tunnel[]): Tunnel[] {
  const ids = new Set(tunnels.map((t) => t.id))
  for (const id of running.keys()) if (!ids.has(id)) stopTunnel(id)
  tunnelStore.set(tunnels)
  return tunnels
}

export function autoStartTunnels(): void {
  for (const t of tunnelStore.get()) if (t.autoStart) startTunnel(t.id)
}

export function stopAllTunnels(): void {
  for (const id of [...running.keys()]) stopTunnel(id)
}
