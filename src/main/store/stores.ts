import { app } from 'electron'
import type { Macro, Session, SessionInput, Settings, Tunnel } from '@shared/types'
import { DbStore } from './database'
import { deleteSecret, hasSecret, setSecret } from './secrets'

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

export function listSessions(): Session[] {
  return sessionStore.get().map((s) => ({ ...s, hasSecret: hasSecret(s.id) }))
}

export function getSession(id: string): Session | undefined {
  return sessionStore.get().find((s) => s.id === id)
}

export function saveSession(input: SessionInput): Session[] {
  const { secret, clearSecret, hasSecret: _ignored, ...session } = input
  const all = sessionStore.get().filter((s) => s.id !== session.id)
  all.push(session)
  sessionStore.set(all)
  if (clearSecret) deleteSecret(session.id)
  else if (secret) setSecret(session.id, secret)
  return listSessions()
}

export function saveSessions(sessions: Session[]): Session[] {
  sessionStore.set(sessions.map(({ hasSecret: _h, ...s }) => s))
  return listSessions()
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
