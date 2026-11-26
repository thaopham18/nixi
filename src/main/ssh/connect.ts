import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { Client, type ConnectConfig } from 'ssh2'
import type { Session } from '@shared/types'
import { getSession, sessionSecret } from '../store/stores'
import { verifyHostKey } from '../store/known-hosts'
import { LOGIN_TIMEOUT_SEC, SSH_ALGORITHMS, TCP_TIMEOUT_SEC, explainHandshakeError, explainTimeout } from './algorithms'

export interface SshTarget {
  host: string
  port: number
  username: string
  auth: Session['auth']
  privateKeyPath?: string
  /** password, or passphrase for the key */
  secret?: string
  keepaliveSec?: number
  jump?: SshTarget
}

/** The running ssh-agent, if any. ssh2 aborts the whole login when the agent is unreachable. */
export function defaultAgent(): string | undefined {
  const sock =
    process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
  return sock && existsSync(sock) ? sock : undefined
}

function expandHome(p: string): string {
  return p.startsWith('~') ? homedir() + p.slice(1) : p
}

export function targetFromSession(session: Session, typed: { username?: string; password?: string } = {}, depth = 0): SshTarget {
  if (!session.host) throw new Error(`Session "${session.name}" has no host`)
  let jump: SshTarget | undefined
  if (session.jumpSessionId && depth < 5) {
    const j = getSession(session.jumpSessionId)
    if (!j) throw new Error('Jump host session not found')
    jump = targetFromSession(j, {}, depth + 1)
  }
  return {
    host: session.host,
    port: session.port || 22,
    username: typed.username || session.username || process.env.USER || process.env.USERNAME || 'root',
    auth: session.auth || 'password',
    privateKeyPath: session.privateKeyPath,
    secret: typed.password ?? sessionSecret(session),
    keepaliveSec: session.keepaliveSec,
    jump
  }
}

/** Try the user's default keys when no explicit auth is configured. */
function defaultKey(): Buffer | undefined {
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const p = `${homedir()}/.ssh/${name}`
    if (existsSync(p)) return readFileSync(p)
  }
  return undefined
}

/** Open an authenticated ssh2 client, going through the jump host chain if configured. */
export async function connectSsh(target: SshTarget): Promise<{ client: Client; chain: Client[] }> {
  const chain: Client[] = []
  let sock: NodeJS.ReadableStream | undefined
  if (target.jump) {
    // Named so the UI doesn't take it for this server's own login and ask the wrong password.
    const j = await connectSsh(target.jump).catch((err: Error) => {
      throw new Error(`Jump host ${target.jump?.host}: ${err.message}`)
    })
    chain.push(...j.chain, j.client)
    sock = await new Promise((resolve, reject) =>
      j.client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) =>
        err ? reject(err) : resolve(stream)
      )
    )
  }

  const client = new Client()
  // Where the login got to, for the timeout message (ssh2's own only says "handshake").
  const steps: string[] = []
  let loggedIn = false
  let askingHostKey = false
  const cfg: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: LOGIN_TIMEOUT_SEC * 1000,
    debug: (line: string) => {
      if (loggedIn || /^Handshake: \((local|remote)\)/.test(line)) return
      steps.push(line)
      if (steps.length > 8) steps.shift()
    },
    keepaliveInterval: (target.keepaliveSec ?? 30) * 1000,
    tryKeyboard: true,
    algorithms: SSH_ALGORITHMS,
    agent: target.auth === 'agent' ? defaultAgent() : undefined,
    hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
      askingHostKey = true
      const answer = (ok: boolean): void => {
        askingHostKey = false
        verify(ok)
      }
      verifyHostKey(target.host, target.port, key).then(answer, () => answer(false))
    }
  } as ConnectConfig
  if (sock) cfg.sock = sock as ConnectConfig['sock']
  if (target.auth !== 'key' && target.secret) cfg.password = target.secret
  if (target.auth === 'key') {
    const keyPath = target.privateKeyPath ? expandHome(target.privateKeyPath) : undefined
    cfg.privateKey = keyPath ? readFileSync(keyPath) : defaultKey()
    if (target.secret) cfg.passphrase = target.secret
  }
  if (target.auth !== 'password' && !cfg.privateKey && !target.privateKeyPath) {
    cfg.privateKey = defaultKey()
  }

  client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
    // Without a password, fail fast so the UI can ask for one instead of sending blanks.
    if (target.secret === undefined && prompts.length) return client.end()
    finish(prompts.map(() => target.secret ?? ''))
  })

  // ssh2 can emit several errors for one failed login; a missing listener crashes the main process.
  client.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    let tcp = false
    client.once('connect', () => (tcp = true))
    const tcpTimer = setTimeout(() => {
      if (tcp) return
      chain.forEach((c) => c.end())
      client.end()
      reject(new Error(`Timed out connecting to ${target.host}:${target.port} (no answer in ${TCP_TIMEOUT_SEC} s)`))
    }, TCP_TIMEOUT_SEC * 1000)
    client.once('ready', () => {
      loggedIn = true
      steps.length = 0
      clearTimeout(tcpTimer)
      resolve()
    })
    client.once('close', () => clearTimeout(tcpTimer))
    client.once('close', () => reject(new Error('Authentication required: no password given')))
    client.once('error', (err) => {
      chain.forEach((c) => c.end())
      client.end()
      clearTimeout(tcpTimer)
      if (/^Handshake failed/.test(err.message)) err.message = explainHandshakeError(err.message)
      else if (/^Timed out while waiting for handshake/.test(err.message)) err.message = explainTimeout(steps, askingHostKey)
      reject(err)
    })
    try {
      client.connect(cfg)
    } catch (err) {
      chain.forEach((c) => c.end())
      reject(err)
    }
  })
  client.on('close', () => chain.forEach((c) => c.end()))
  return { client, chain }
}
