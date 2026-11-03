import { app } from 'electron'
import type { Credential, CredentialInput, Macro, Session, SessionInput, Settings, Tunnel } from '@shared/types'
import { DbStore } from './database'
import { deleteSecret, getSecret, hasSecret, setSecret } from './secrets'

const defaultSettings: Settings = {
  theme: 'dark',
  fontFamily: 'Menlo, Monaco, "Cascadia Mono", Consolas, monospace',
  fontSize: 13,
  scrollback: 10000,
  cursorStyle: 'bar',
  cursorBlink: true,
  gpuRendering: true,
  copyOnSelect: true,
  rightClickPaste: true,
  warnMultilinePaste: true,
  autoReconnect: true,
  warnDangerousCommands: true,
  dangerWatchList: [],
  downloadDir: '',
  sftpAutoOpen: true,
  macroPickerHotkey: process.platform === 'darwin' ? 'Cmd+J' : 'Ctrl+Shift+J',
  serverStats: true,
  termForeground: '',
  termBackground: '',
  termCursor: ''
}

// All of these live in the encrypted database file (see database.ts).
const settingsStore = new DbStore('settings', defaultSettings)
const sessionStore = new DbStore('sessions', [] as Session[])
const credentialStore = new DbStore('credentials', [] as Credential[])
export const tunnelStore = new DbStore('tunnels', [] as Tunnel[])
export const macroStore = new DbStore('macros', [] as Macro[])
export const folderStore = new DbStore('folders', [] as string[])
export const knownHostsStore = new DbStore('knownHosts', {} as Record<string, string>)

export function getSettings(): Settings {
  const s = { ...defaultSettings, ...settingsStore.get() }
  return { ...s, downloadDir: s.downloadDir || app.getPath('downloads') }
}

// The menu is rebuilt when keys the user picked change (settings, macro hotkeys).
const shortcutListeners: (() => void)[] = []
export function onShortcutsChange(fn: () => void): void {
  shortcutListeners.push(fn)
}
export function shortcutsChanged(): void {
  shortcutListeners.forEach((fn) => fn())
}

export function setSettings(s: Settings): Settings {
  settingsStore.set(s)
  shortcutsChanged()
  return getSettings()
}

const credentialSecretId = (id: string): string => `credential:${id}`

/** The credential a session logs in with. A key means nothing outside SSH; a link to one that's gone is no link. */
function credentialOf(session: Session): Credential | undefined {
  if (!session.credentialId) return undefined
  const c = credentialStore.get().find((x) => x.id === session.credentialId)
  return c && (c.kind === 'password' || session.type === 'ssh') ? c : undefined
}

/** A session as everything outside this file sees it: login fields come from its credential. */
function resolved(session: Session): Session {
  const c = credentialOf(session)
  if (!c) return session
  const { privateKeyPath: _own, ...rest } = session
  return {
    ...rest,
    username: c.username,
    ...(session.type === 'ssh' ? { auth: c.kind, privateKeyPath: c.privateKeyPath } : {})
  }
}

/** What gets stored: a linked session keeps no login of its own, or it would go stale. */
function stored(session: Session): Session {
  if (!credentialOf(session)) return session
  const { username: _u, auth: _a, privateKeyPath: _k, ...rest } = session
  return rest
}

/** The password or key passphrase of a session, from its credential if it has one. */
export function sessionSecret(session: Session): string | undefined {
  const c = credentialOf(session)
  return getSecret(c ? credentialSecretId(c.id) : session.id)
}

export function listSessions(): Session[] {
  return sessionStore.get().map((s) => {
    const c = credentialOf(s)
    return { ...resolved(s), hasSecret: hasSecret(c ? credentialSecretId(c.id) : s.id) }
  })
}

export function getSession(id: string): Session | undefined {
  const s = sessionStore.get().find((x) => x.id === id)
  return s && resolved(s)
}

export function saveSession(input: SessionInput): Session[] {
  const { secret, clearSecret, hasSecret: _ignored, ...session } = input
  const all = sessionStore.get().filter((s) => s.id !== session.id)
  all.push(stored(session))
  sessionStore.set(all)
  if (credentialOf(session) || clearSecret) deleteSecret(session.id)
  else if (secret) setSecret(session.id, secret)
  return listSessions()
}

export function saveSessions(sessions: Session[]): Session[] {
  sessionStore.set(sessions.map(({ hasSecret: _h, ...s }) => stored(s)))
  return listSessions()
}

export function listCredentials(): Credential[] {
  return credentialStore.get().map((c) => ({ ...c, hasSecret: hasSecret(credentialSecretId(c.id)) }))
}

export function saveCredential(input: CredentialInput): Credential[] {
  const { secret, clearSecret, hasSecret: _ignored, ...credential } = input
  const all = credentialStore.get()
  credentialStore.set(all.some((c) => c.id === credential.id) ? all.map((c) => (c.id === credential.id ? credential : c)) : [...all, credential])
  if (clearSecret) deleteSecret(credentialSecretId(credential.id))
  else if (secret) setSecret(credentialSecretId(credential.id), secret)
  return listCredentials()
}

/** Merge credentials from an exported file, secrets not included: existing ones are left as they are. */
export function importCredentials(list: Credential[]): void {
  const have = new Set(credentialStore.get().map((c) => c.id))
  credentialStore.set([...credentialStore.get(), ...list.filter((c) => !have.has(c.id)).map(({ hasSecret: _h, ...c }) => c)])
}

/** Fills a login field in the renderer, which then treats it like typed text. */
export function credentialSecret(id: string): string | undefined {
  return getSecret(credentialSecretId(id))
}

/** Delete a credential. Sessions using it keep working: they get its login as their own. */
export function deleteCredential(id: string): Credential[] {
  const secret = credentialSecret(id)
  const users = sessionStore.get().filter((s) => s.credentialId === id && credentialOf(s))
  for (const s of users) if (secret !== undefined) setSecret(s.id, secret)
  const own = new Map(users.map((s) => [s.id, resolved(s)]))
  sessionStore.set(
    sessionStore.get().map((s) => {
      if (s.credentialId !== id) return s
      const { credentialId: _gone, ...rest } = own.get(s.id) ?? s
      return rest
    })
  )
  credentialStore.set(credentialStore.get().filter((c) => c.id !== id))
  deleteSecret(credentialSecretId(id))
  return listCredentials()
}

/** Delete one or many sessions (e.g. a whole folder) and their stored secrets. */
export function deleteSession(ids: string | string[]): Session[] {
  const gone = new Set(Array.isArray(ids) ? ids : [ids])
  sessionStore.set(
    sessionStore
      .get()
      .filter((s) => !gone.has(s.id))
      // Sessions that used a deleted one as jump host now connect directly.
      .map((s) => (s.jumpSessionId && gone.has(s.jumpSessionId) ? { ...s, jumpSessionId: undefined } : s))
  )
  for (const id of gone) deleteSecret(id)
  return listSessions()
}

export function touchSession(id: string): void {
  const all = sessionStore.get().map((s) => (s.id === id ? { ...s, lastUsed: Date.now() } : s))
  sessionStore.set(all)
}
