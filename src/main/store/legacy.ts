import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import type { DbData } from './database'

// Data from before the single-file database: separate JSON files in the app data folder
// (also under the old "MacTerm" app name).

/**
 * The app was called EZTERM before Nixi: its data folder was …/EZTERM with ezterm.local.json
 * (database location + remembered key) and, by default, ezterm.ezdb. On the first Nixi start,
 * take that over: point at the same database file, or copy the default one into the Nixi folder.
 * The old folder is left untouched. The remembered key may not decrypt under the new app name
 * (Keychain item "Nixi Safe Storage"); then the master password is asked once.
 */
export function migrateFromEzterm(): void {
  if (process.env.NIXI_USER_DATA) return // test profiles
  const dir = app.getPath('userData')
  const old = join(app.getPath('appData'), 'EZTERM')
  if (existsSync(join(dir, 'nixi.local.json')) || existsSync(join(dir, 'nixi.nxdb')) || !existsSync(old)) return
  const cfg = readJson<{ dbPath?: string; remembered?: { path: string; salt: string; key: string } }>(old, 'ezterm.local.json', {})
  const oldDefault = join(old, 'ezterm.ezdb')
  mkdirSync(dir, { recursive: true })
  if (!cfg.dbPath && existsSync(oldDefault)) {
    const target = join(dir, 'nixi.nxdb')
    copyFileSync(oldDefault, target)
    if (existsSync(oldDefault + '.bak')) copyFileSync(oldDefault + '.bak', target + '.bak')
    if (cfg.remembered?.path === oldDefault) cfg.remembered.path = target
  }
  writeFileSync(join(dir, 'nixi.local.json'), JSON.stringify(cfg, null, 2))
}

export interface LegacyImport {
  data: DbData
  source: string
  sessions: number
  /** saved passwords that could not be decrypted (they were tied to the old app's keychain entry) */
  lostSecrets: number
}

function readJson<T>(dir: string, file: string, fallback: T): T {
  try {
    return existsSync(join(dir, file)) ? (JSON.parse(readFileSync(join(dir, file), 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

export function findLegacyData(): LegacyImport | undefined {
  const appData = app.getPath('appData')
  // A separate profile (NIXI_USER_DATA, used by tests) only migrates its own folder.
  const dirs = process.env.NIXI_USER_DATA
    ? [app.getPath('userData')]
    : [app.getPath('userData'), join(appData, 'MacTerm'), join(appData, 'macterm')]
  const dir = dirs.find((d) => existsSync(join(d, 'sessions.json')) || existsSync(join(d, 'settings.json')))
  if (!dir) return undefined

  let lostSecrets = 0
  const secrets: Record<string, string> = {}
  for (const [id, v] of Object.entries(readJson<Record<string, string>>(dir, 'secrets.json', {}))) {
    try {
      const raw = Buffer.from(v.slice(4), 'base64')
      secrets[id] = v.startsWith('enc:') ? safeStorage.decryptString(raw) : raw.toString('utf8')
    } catch {
      lostSecrets++
    }
  }
  const data: DbData = {
    settings: readJson(dir, 'settings.json', {}),
    sessions: readJson(dir, 'sessions.json', []),
    tunnels: readJson(dir, 'tunnels.json', []),
    macros: readJson(dir, 'macros.json', []),
    folders: [],
    knownHosts: readJson(dir, 'known_hosts.json', {}),
    secrets
  }
  return { data, source: dir, sessions: data.sessions.length, lostSecrets }
}
