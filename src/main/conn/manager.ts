import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { StringDecoder } from 'string_decoder'
import type { WebContents } from 'electron'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import * as pty from '@lydell/node-pty'
import type { OpenConnRequest, OpenConnResult, Session } from '@shared/types'
import { getSession, touchSession } from '../store/stores'
import { connectSsh, targetFromSession, type SshTarget } from '../ssh/connect'
import { connect as netConnect, type Socket } from 'net'
import { AutoLogin, TelnetClient } from '../telnet/protocol'
import { getSecret } from '../store/secrets'
import { StatsParser, STATS_SCRIPT } from '@shared/stats'

interface Conn {
  id: string
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  client?: Client
  sftp?: Promise<SFTPWrapper>
  /** exec channel running STATS_SCRIPT, while the renderer shows the stats bar */
  stats?: ClientChannel
}

const conns = new Map<string, Conn>()
let sink: WebContents | undefined

export function setSink(wc: WebContents): void {
  sink = wc
}

function emit(channel: string, ...args: unknown[]): void {
  if (sink && !sink.isDestroyed()) sink.send(channel, ...args)
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

// Apps started from Finder/Dock get no LANG; zsh then treats typed non-ASCII as raw bytes
// (shows <0087> instead of "ệ"). Terminal.app/iTerm set a UTF-8 locale, so do the same.
function localeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (process.platform === 'win32') return {}
  const current = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
  return /utf-?8/i.test(current) ? {} : { LANG: 'en_US.UTF-8' }
}

function openLocal(id: string, session: Session | undefined, cols: number, rows: number): Conn {
  const shell = session?.shell || defaultShell()
  const proc = pty.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: homedir(),
    env: { ...process.env, ...localeEnv(process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
  })
  proc.onData((d) => emit('conn:data', id, d))
  proc.onExit(({ exitCode }) => {
    conns.delete(id)
    emit('conn:status', { connId: id, state: 'closed', message: `exit code ${exitCode}` })
  })
  if (session?.startupCommand) proc.write(session.startupCommand + '\r')
  return {
    id,
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(Math.max(c, 1), Math.max(r, 1)),
    close: () => proc.kill()
  }
}

async function openSsh(
  id: string,
  target: SshTarget,
  startupCommand: string | undefined,
  cols: number,
  rows: number
): Promise<Conn> {
  const { client } = await connectSsh(target)
  const stream: ClientChannel = await new Promise((resolve, reject) =>
    client.shell({ term: 'xterm-256color', cols, rows }, { env: { COLORTERM: 'truecolor' } }, (err, s) =>
      err ? reject(err) : resolve(s)
    )
  )
  const out = new StringDecoder('utf8')
  const errOut = new StringDecoder('utf8')
  stream.on('data', (d: Buffer) => emit('conn:data', id, out.write(d)))
  stream.stderr.on('data', (d: Buffer) => emit('conn:data', id, errOut.write(d)))
  let closed = false
  const onClose = (message?: string): void => {
    if (closed) return
    closed = true
    conns.delete(id)
    client.end()
    emit('conn:status', { connId: id, state: 'closed', message })
  }
  stream.on('close', () => onClose())
  client.on('error', (e) => onClose(e.message))
  client.on('close', () => onClose())
  if (startupCommand) stream.write(startupCommand + '\n')

  const conn: Conn = {
    id,
    client,
    write: (d) => stream.write(d),
    resize: (c, r) => stream.setWindow(r, c, 0, 0),
    close: () => onClose()
  }
  return conn
}

interface TelnetTarget {
  host: string
  port: number
  username?: string
  password?: string
  startupCommand?: string
  encoding: 'utf8' | 'latin1'
}

async function openTelnet(id: string, t: TelnetTarget, cols: number, rows: number): Promise<Conn> {
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = netConnect(t.port, t.host)
    s.setTimeout(15000, () => s.destroy(new Error(`Connection to ${t.host}:${t.port} timed out`)))
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
  sock.setTimeout(0)
  sock.setNoDelay(true)
  sock.setKeepAlive(true, 30000)
  const telnet = new TelnetClient((bytes) => sock.write(bytes))
  telnet.resize(cols, rows)
  const decoder = new StringDecoder(t.encoding)
  const write = (text: string): void => {
    if (!sock.destroyed) sock.write(telnet.encode(text, t.encoding))
  }
  // Optional sign-in: answer the first login / password prompts, then run the startup command.
  let startupSent = !t.startupCommand
  const login = new AutoLogin(t.username, t.password, write)
  sock.on('data', (chunk: Buffer) => {
    const text = decoder.write(telnet.receive(chunk))
    if (!text) return
    emit('conn:data', id, text)
    login.feed(text)
    if (!startupSent && login.done && /[>#$%]\s*$/.test(text)) {
      startupSent = true
      write(t.startupCommand + '\r')
    }
  })
  let closed = false
  const onClose = (message?: string): void => {
    if (closed) return
    closed = true
    conns.delete(id)
    sock.destroy()
    emit('conn:status', { connId: id, state: 'closed', message })
  }
  sock.on('close', () => onClose())
  sock.on('error', (e) => onClose(e.message))
  return { id, write, resize: (c, r) => telnet.resize(c, r), close: () => onClose() }
}

export async function openConn(req: OpenConnRequest): Promise<OpenConnResult> {
  const id = randomUUID()
  let conn: Conn
  let isSsh = true
  const session = req.sessionId ? getSession(req.sessionId) : undefined
  if (req.sessionId && !session) throw new Error('Session not found')
  const title = session?.name ?? 'Local shell'
  if (!session || session.type === 'local') {
    isSsh = false
    conn = openLocal(id, session, req.cols, req.rows)
  } else if (session.type === 'ssh') {
    conn = await openSsh(id, targetFromSession(session, req.password), session.startupCommand, req.cols, req.rows)
  } else if (session.type === 'telnet') {
    if (!session.host) throw new Error(`Session "${session.name}" has no host`)
    isSsh = false
    conn = await openTelnet(
      id,
      {
        host: session.host,
        port: session.port || 23,
        username: session.username,
        password: req.password ?? getSecret(session.id),
        startupCommand: session.startupCommand,
        encoding: session.encoding ?? 'utf8'
      },
      req.cols,
      req.rows
    )
  } else {
    throw new Error('RDP sessions are opened with openRdp')
  }
  if (session) touchSession(session.id)
  conns.set(id, conn)
  emit('conn:status', { connId: id, state: 'connected' })
  return { connId: id, title, sessionId: req.sessionId, isSsh }
}

export function writeConn(id: string, data: string): void {
  conns.get(id)?.write(data)
}

export function resizeConn(id: string, cols: number, rows: number): void {
  conns.get(id)?.resize(cols, rows)
}

export function closeConn(id: string): void {
  conns.get(id)?.close()
  conns.delete(id)
}

export function closeAll(): void {
  for (const c of conns.values()) c.close()
  conns.clear()
}

/** Lazily open (and cache) an SFTP channel on an SSH connection. */
export function getSftp(connId: string): Promise<SFTPWrapper> {
  const conn = conns.get(connId)
  if (!conn?.client) return Promise.reject(new Error('Not an SSH connection'))
  if (!conn.sftp) {
    const client = conn.client
    conn.sftp = new Promise<SFTPWrapper>((resolve, reject) =>
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    )
    conn.sftp.catch(() => (conn.sftp = undefined))
  }
  return conn.sftp
}

/**
 * Start / stop the resource monitor of an SSH connection. Results arrive as 'conn:stats'
 * (connId, ServerStats | null); null = the server cannot run it (no sh, exec refused…).
 */
export function watchStats(connId: string, on: boolean): void {
  const conn = conns.get(connId)
  if (!conn?.client) return
  if (!on) {
    conn.stats?.close()
    conn.stats = undefined
    return
  }
  if (conn.stats) return
  conn.client.exec('sh -s', (err, ch) => {
    if (err) return emit('conn:stats', connId, null)
    if (!conns.has(connId)) return void ch.close()
    conn.stats = ch
    const parser = new StatsParser()
    const out = new StringDecoder('utf8')
    let got = false
    ch.on('data', (d: Buffer) => {
      for (const st of parser.feed(out.write(d))) {
        got = true
        emit('conn:stats', connId, st)
      }
    })
    ch.stderr.on('data', () => {})
    ch.on('close', () => {
      if (conn.stats === ch) conn.stats = undefined
      if (!got) emit('conn:stats', connId, null)
    })
    ch.end(STATS_SCRIPT)
  })
}
