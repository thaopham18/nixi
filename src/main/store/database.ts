import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { app, safeStorage } from 'electron'
import { JsonStore } from './json-store'
import { migrateFromEzterm } from './legacy'
import { decryptDb, deriveKey, emptyData, encryptDb, newKdf, parseDbFile, type DbData, type DbFile, type Kdf } from './db-crypto'

export type { DbData } from './db-crypto'

/**
 * Nixi database: one file (like a KeePass .kdbx) holding settings, sessions, tunnels,
 * macros, known hosts and passwords, encrypted with AES-256-GCM using a key derived from the
 * master password (scrypt). The file can be copied or synced (iCloud Drive, Dropbox…) and
 * opened anywhere with the master password. Format: see db-crypto.ts.
 */

export type DbStatus = { state: 'none' | 'locked' | 'unlocked'; path: string; remembered: boolean }

export const DB_EXTENSION = 'nxdb'

/** Per-machine settings that must not live in the database: where it is, and the remembered key. */
interface LocalConfig {
  dbPath?: string
  remembered?: { path: string; salt: string; key: string }
}
let local: JsonStore<LocalConfig> | undefined
const localConfig = (): JsonStore<LocalConfig> => {
  if (!local) {
    migrateFromEzterm() // must run before the local config is first read
    local = new JsonStore<LocalConfig>('nixi.local.json', {})
  }
  return local
}

let current: { path: string; key: Buffer; kdf: Kdf; data: DbData } | undefined
const listeners = { unlock: [] as (() => void)[], lock: [] as (() => void)[] }

export function onUnlock(fn: () => void): void {
  listeners.unlock.push(fn)
}
export function onLock(fn: () => void): void {
  listeners.lock.push(fn)
}

export function defaultDbPath(): string {
  return join(app.getPath('userData'), `nixi.${DB_EXTENSION}`)
}

export function dbPath(): string {
  return localConfig().get().dbPath ?? defaultDbPath()
}

function setDbPath(path: string): void {
  localConfig().set({ ...localConfig().get(), dbPath: path === defaultDbPath() ? undefined : path })
}

export function status(): DbStatus {
  const path = current?.path ?? dbPath()
  const remembered = localConfig().get().remembered?.path === path
  if (current) return { state: 'unlocked', path, remembered }
  return { state: existsSync(path) ? 'locked' : 'none', path, remembered }
}

export function data(): DbData {
  if (!current) throw new Error('The database is locked')
  return current.data
}

function readFile(path: string): DbFile {
  return parseDbFile(readFileSync(path, 'utf8'))
}

function writeFile(path: string, file: DbFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 1), 'utf8')
  // Keep the previous version next to it, like KeePass backups.
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  renameSync(tmp, path)
}

let saveTimer: NodeJS.Timeout | undefined
/** Write the database (batched: many store updates in one tick → one write). */
export function save(): void {
  if (!current) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, 50)
}

export function flush(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (current) writeFile(current.path, encryptDb(current.data, current.key, current.kdf))
}

function remember(enabled: boolean): void {
  const cfg = { ...localConfig().get() }
  if (enabled && current && safeStorage.isEncryptionAvailable()) {
    cfg.remembered = {
      path: current.path,
      salt: current.kdf.salt,
      key: safeStorage.encryptString(current.key.toString('base64')).toString('base64')
    }
  } else if (!enabled) {
    delete cfg.remembered
  }
  localConfig().set(cfg)
}

function opened(path: string, key: Buffer, kdf: Kdf, payload: DbData, rememberKey: boolean | undefined): void {
  current = { path, key, kdf, data: payload }
  setDbPath(path)
  if (rememberKey !== undefined) remember(rememberKey)
  listeners.unlock.forEach((fn) => fn())
}

export async function create(password: string, rememberKey: boolean, path = dbPath(), initial = emptyData()): Promise<void> {
  if (password.length < 4) throw new Error('Use a longer master password')
  if (existsSync(path)) throw new Error('A database already exists there; open it instead')
  const kdf = newKdf()
  const key = await deriveKey(password, kdf)
  writeFile(path, encryptDb(initial, key, kdf))
  opened(path, key, kdf, initial, rememberKey)
}

export async function unlock(password: string, rememberKey: boolean): Promise<void> {
  const path = dbPath()
  const file = readFile(path)
  const key = await deriveKey(password, file.kdf)
  opened(path, key, file.kdf, decryptDb(file, key), rememberKey)
}

/** Unlock with the key remembered in the OS keychain, if any. */
export function tryRememberedUnlock(): boolean {
  const path = dbPath()
  const r = localConfig().get().remembered
  if (!r || r.path !== path || !existsSync(path) || !safeStorage.isEncryptionAvailable()) return false
  try {
    const file = readFile(path)
    if (file.kdf.salt !== r.salt) return false // master password changed elsewhere
    const key = Buffer.from(safeStorage.decryptString(Buffer.from(r.key, 'base64')), 'base64')
    opened(path, key, file.kdf, decryptDb(file, key), undefined)
    return true
  } catch {
    return false
  }
}

export function lock(): void {
  if (!current) return
  flush()
  current = undefined
  listeners.lock.forEach((fn) => fn())
}

/** Whether this is the master password of the open database (checked before asking for a new one). */
export async function checkPassword(password: string): Promise<boolean> {
  if (!current) throw new Error('The database is locked')
  return (await deriveKey(password, current.kdf)).equals(current.key)
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  if (!current) throw new Error('The database is locked')
  if (!(await checkPassword(oldPassword))) throw new Error('The current master password is wrong')
  if (newPassword.length < 4) throw new Error('Use a longer master password')
  const wasRemembered = status().remembered
  current.kdf = newKdf()
  current.key = await deriveKey(newPassword, current.kdf)
  flush()
  remember(wasRemembered)
}

/** Switch to another database file (it will ask for its master password, or offer to create it). */
export function useFile(path: string): void {
  lock()
  setDbPath(path)
}

/** Move the open database to a new location (e.g. a synced folder) and keep using it there. */
export function moveTo(path: string): void {
  if (!current) throw new Error('The database is locked')
  const wasRemembered = status().remembered
  writeFile(path, encryptDb(current.data, current.key, current.kdf))
  current.path = path
  setDbPath(path)
  remember(wasRemembered)
}

export function setRemember(enabled: boolean): void {
  remember(enabled)
}

/** A store backed by one key of the open database, with the same get/set shape as JsonStore. */
export class DbStore<K extends keyof DbData> {
  constructor(
    private key: K,
    private defaults: DbData[K]
  ) {}

  get(): DbData[K] {
    const v = data()[this.key]
    if (Array.isArray(this.defaults)) return (v ?? this.defaults) as DbData[K]
    return { ...this.defaults, ...v } as DbData[K]
  }

  set(value: DbData[K]): void {
    data()[this.key] = value
    save()
  }
}
