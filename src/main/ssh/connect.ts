import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { Client, type ConnectConfig } from 'ssh2'
import type { Session } from '@shared/types'
import { getSecret } from '../store/secrets'
import { getSession } from '../store/stores'
import { verifyHostKey } from '../store/known-hosts'

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

export function targetFromSession(session: Session, overridePassword?: string, depth = 0): SshTarget {
  if (!session.host) throw new Error(`Session "${session.name}" has no host`)
  let jump: SshTarget | undefined
  if (session.jumpSessionId && depth < 5) {
    const j = getSession(session.jumpSessionId)
    if (!j) throw new Error('Jump host session not found')
    jump = targetFromSession(j, undefined, depth + 1)
  }
  return {
    host: session.host,
    port: session.port || 22,
    username: session.username || process.env.USER || process.env.USERNAME || 'root',
    auth: session.auth || 'password',
    privateKeyPath: session.privateKeyPath,
    secret: overridePassword ?? getSecret(session.id),
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
    const j = await connectSsh(target.jump)
    chain.push(...j.chain, j.client)
    sock = await new Promise((resolve, reject) =>
      j.client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) =>
        err ? reject(err) : resolve(stream)
      )
    )
  }

  const client = new Client()
  const cfg: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: 20000,
    keepaliveInterval: (target.keepaliveSec ?? 30) * 1000,
    tryKeyboard: true,
    agent: target.auth === 'agent' ? defaultAgent() : undefined,
    hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
      verifyHostKey(target.host, target.port, key).then(verify, () => verify(false))
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
    client.once('ready', () => resolve())
    client.once('close', () => reject(new Error('Authentication required: no password given')))
    client.once('error', (err) => {
      chain.forEach((c) => c.end())
      client.end()
      reject(err)
    })
    try {
      client.connect(cfg)
    } catch (err) {
      reject(err)
    }
  })
  client.on('close', () => chain.forEach((c) => c.end()))
  return { client, chain }
}
