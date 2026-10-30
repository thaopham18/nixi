import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BrowserWindow, dialog } from 'electron'
import type { Session } from '@shared/types'
import { decodeMobaFile, mobaMacroToMacro, mobaToSessions, parseMobaIni, sessionsToMoba, type MobaParseResult } from '@shared/mobaxterm'
import { listSessions, macroStore, saveSessions } from '../store/stores'
import { decryptMoba } from './moba-crypto'

export interface MobaPreview {
  token: string
  file: string
  ssh: number
  rdp: number
  telnet: number
  other: number
  macros: number
  encryptedMacros: number
}

export interface MobaReport {
  sessionsAdded: number
  sessionsSkipped: number
  unsupported: Record<string, number>
  macrosAdded: string[]
  macrosFailed: string[]
}

const pending = new Map<string, MobaParseResult>()

function win(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function defaultMobaDir(): string | undefined {
  const candidates = [
    process.env.APPDATA && join(process.env.APPDATA, 'MobaXterm'),
    join(homedir(), 'Documents', 'MobaXterm')
  ].filter(Boolean) as string[]
  return candidates.find((d) => existsSync(d))
}

export async function pickMobaFile(): Promise<MobaPreview | null> {
  const w = win()
  const opts = {
    title: 'Import from MobaXterm',
    defaultPath: defaultMobaDir(),
    properties: ['openFile' as const],
    filters: [{ name: 'MobaXterm sessions', extensions: ['mxtsessions', 'ini'] }]
  }
  const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return null
  const file = res.filePaths[0]
  const parsed = parseMobaIni(decodeMobaFile(readFileSync(file)))
  const token = randomUUID()
  pending.set(token, parsed)
  return {
    token,
    file,
    ssh: parsed.bookmarks.filter((b) => b.type === 0).length,
    rdp: parsed.bookmarks.filter((b) => b.type === 4).length,
    telnet: parsed.bookmarks.filter((b) => b.type === 1).length,
    other: parsed.bookmarks.filter((b) => ![0, 1, 4].includes(b.type)).length,
    macros: parsed.macros.length,
    encryptedMacros: parsed.macros.filter((m) => m.value.startsWith('em:') || m.value.startsWith('_@')).length
  }
}

export function importMoba(token: string, masterPassword?: string): { report: MobaReport; sessions: Session[] } {
  const parsed = pending.get(token)
  if (!parsed) throw new Error('Import expired, pick the file again')
  pending.delete(token)

  const existing = listSessions()
  const key = (s: Pick<Session, 'name' | 'folder' | 'host'>): string => `${s.folder}\u0000${s.name}\u0000${s.host ?? ''}`
  const known = new Set(existing.map(key))
  const { sessions, unsupported } = mobaToSessions(parsed.bookmarks, randomUUID, homedir())
  const fresh = sessions.filter((s) => !known.has(key(s)))
  // Keep jump references valid when a gateway session already existed.
  const byKey = new Map(existing.map((s) => [key(s), s.id]))
  const idMap = new Map(sessions.filter((s) => known.has(key(s))).map((s) => [s.id, byKey.get(key(s))!]))
  for (const s of fresh) if (s.jumpSessionId && idMap.has(s.jumpSessionId)) s.jumpSessionId = idMap.get(s.jumpSessionId)

  const macrosAdded: string[] = []
  const macrosFailed: string[] = []
  const macros = [...macroStore.get()]
  for (const m of parsed.macros) {
    const encrypted = m.value.startsWith('em:') || m.value.startsWith('_@')
    let plain: string | null = m.value
    if (encrypted) plain = masterPassword ? decryptMoba(m.value, masterPassword) : null
    if (plain === null) {
      macrosFailed.push(`${m.name}: ${masterPassword ? 'could not decrypt (wrong master password?)' : 'encrypted, no master password given'}`)
      continue
    }
    if (macros.some((x) => x.name === m.name)) {
      macrosFailed.push(`${m.name}: a macro with this name already exists`)
      continue
    }
    const hotkeyTaken = m.hotkey && macros.some((x) => x.hotkey === m.hotkey)
    macros.push(mobaMacroToMacro(m.name, plain, hotkeyTaken ? undefined : m.hotkey, randomUUID))
    macrosAdded.push(m.name)
  }
  macroStore.set(macros)

  return {
    report: { sessionsAdded: fresh.length, sessionsSkipped: sessions.length - fresh.length, unsupported, macrosAdded, macrosFailed },
    sessions: saveSessions([...existing, ...fresh])
  }
}

export async function exportMoba(): Promise<{ count: number; skipped: number } | null> {
  const w = win()
  const opts = { defaultPath: 'Nixi.mxtsessions', filters: [{ name: 'MobaXterm sessions', extensions: ['mxtsessions'] }] }
  const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  const sessions = listSessions()
  const { text, skipped } = sessionsToMoba(sessions)
  // .mxtsessions is CP1252; characters outside Latin-1 cannot be represented.
  writeFileSync(res.filePath, Buffer.from(text.replace(/[^\x00-\xff]/g, '?'), 'latin1'))
  return { count: sessions.length - skipped, skipped }
}
