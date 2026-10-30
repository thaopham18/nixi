import type { Macro, MacroStep, Session } from './types'

// MobaXterm stores sessions in MobaXterm.ini / *.mxtsessions:
//   [Bookmarks] / [Bookmarks_N] sections, SubRep=Folder\Sub, ImgNum=41,
//   Name=<lead>#<icon>#<g1 %-separated>#<g2 terminal settings>#<start mode>#<comment>#<tab color>
// g1[0] is the session type: 0 SSH, 4 RDP (others are not supported here).
// Format reference: https://gist.github.com/Ruzgfpegk/ab597838e4abbe8de30d7224afd062ea

export interface MobaBookmark {
  name: string
  folder: string
  type: number
  icon: number
  g1: string[]
  color?: string
}

export interface MobaMacro {
  name: string
  /** raw value: plain text or "em:..." encrypted with the master password */
  value: string
  hotkey?: string
}

export interface MobaParseResult {
  bookmarks: MobaBookmark[]
  macros: MobaMacro[]
}

const escapes: [string, string][] = [
  ['__PTVIRG__', ';'],
  ['__DBLQUO__', '"'],
  ['__PIPE__', '|'],
  ['__PERCENT__', '%'],
  ['__DIEZE__', '#']
]

export function mobaUnescape(s: string): string {
  let out = s
  for (const [k, v] of escapes) out = out.split(k).join(v)
  return out.replace(/_CurrentDrive_/g, 'C:')
}

export function mobaEscape(s: string): string {
  let out = s
  for (const [k, v] of [...escapes].reverse()) out = out.split(v).join(k)
  return out
}

/** MobaXterm files are CP1252, MobaXterm.ini may be UTF-8: prefer UTF-8 when it decodes cleanly. */
export function decodeMobaFile(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1252').decode(buf)
  }
}

/** Decimal BGR-packed color (255 = red) → "#rrggbb". */
function mobaColor(v: string | undefined): string | undefined {
  const n = Number(v)
  if (!v || !Number.isFinite(n) || n < 0) return undefined
  const r = n & 0xff
  const g = (n >> 8) & 0xff
  const b = (n >> 16) & 0xff
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function toMobaColor(hex: string | undefined): string {
  const m = hex?.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return '-1'
  return String(parseInt(m[1], 16) | (parseInt(m[2], 16) << 8) | (parseInt(m[3], 16) << 16))
}

export function parseMobaIni(text: string): MobaParseResult {
  const bookmarks: MobaBookmark[] = []
  const macroValues = new Map<string, string>()
  const hotkeys = new Map<string, string>()
  let section = ''
  let folder = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) {
      section = sec[1]
      folder = ''
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (/^Bookmarks(_\d+)?$/.test(section)) {
      if (key === 'SubRep') folder = value.replace(/\\/g, '/')
      else if (key !== 'ImgNum') {
        const parts = value.split('#')
        if (parts.length < 3) continue
        const g1 = parts[2].split('%')
        bookmarks.push({
          name: mobaUnescape(key),
          folder,
          icon: Number(parts[1]),
          type: Number(g1[0]),
          g1,
          color: mobaColor(parts[6])
        })
      }
    } else if (section === 'Macros') {
      macroValues.set(key, value)
    } else if (section === 'MacrosHotkeys') {
      // Values 1..12 are function keys (F1..F12).
      const n = Number(value)
      if (n >= 1 && n <= 12) hotkeys.set(key, `F${n}`)
    }
  }
  const macros = [...macroValues].map(([name, value]) => ({ name, value, hotkey: hotkeys.get(name) }))
  return { bookmarks, macros }
}

export interface MobaImport {
  sessions: Session[]
  unsupported: Record<string, number>
}

const typeNames: Record<number, string> = { 2: 'Rsh', 3: 'Xdmcp', 5: 'VNC', 6: 'FTP', 7: 'SFTP', 8: 'Serial', 9: 'File', 10: 'Shell', 11: 'Browser', 12: 'Mosh', 13: 'AWS S3', 14: 'WSL' }

function expandKeyPath(p: string, home: string): string | undefined {
  if (!p) return undefined
  const path = mobaUnescape(p)
  const profile = path.match(/^(?:_ProfileDir_|~)[\\/]?(.*)$/)
  // Profile-relative keys (the common case) map onto this machine's home folder.
  return profile ? `${home}/${profile[1].replace(/\\/g, '/')}` : path
}

/**
 * Convert MobaXterm bookmarks to Nixi sessions under the "MobaXterm" folder.
 * SSH gateways become separate jump-host sessions (deduplicated).
 */
export function mobaToSessions(bookmarks: MobaBookmark[], newId: () => string, home = '~'): MobaImport {
  const sessions: Session[] = []
  const unsupported: Record<string, number> = {}
  const gateways = new Map<string, Session>()
  const base = (folder: string): string => ['MobaXterm', folder].filter(Boolean).join('/')

  for (const b of bookmarks) {
    const g = b.g1
    if (b.type === 0) {
      const keyPath = expandKeyPath(g[14] ?? '', home)
      const s: Session = {
        id: newId(),
        name: b.name,
        type: 'ssh',
        folder: base(b.folder),
        host: g[1],
        port: Number(g[2]) || 22,
        username: g[3] || undefined,
        auth: keyPath ? 'key' : g[33] === '-1' ? 'agent' : 'password',
        privateKeyPath: keyPath,
        startupCommand: g[7] ? mobaUnescape(g[7]) : undefined,
        color: b.color
      }
      // Gateway (first hop only; MobaXterm allows a "|"-separated chain).
      const gwHost = mobaUnescape(g[8] ?? '').split('|')[0]
      if (gwHost) {
        const gwPort = Number(mobaUnescape(g[9] ?? '').split('|')[0]) || 22
        const gwUser = mobaUnescape(g[10] ?? '').split('|')[0] || undefined
        const gwKey = expandKeyPath(mobaUnescape(g[15] ?? '').split('|')[0], home)
        const k = `${gwUser ?? ''}@${gwHost}:${gwPort}`
        let gw = gateways.get(k)
        if (!gw) {
          gw = {
            id: newId(),
            name: `gateway ${gwUser ? gwUser + '@' : ''}${gwHost}`,
            type: 'ssh',
            folder: 'MobaXterm/_gateways',
            host: gwHost,
            port: gwPort,
            username: gwUser,
            auth: gwKey ? 'key' : 'password',
            privateKeyPath: gwKey
          }
          gateways.set(k, gw)
          sessions.push(gw)
        }
        s.jumpSessionId = gw.id
      }
      sessions.push(s)
    } else if (b.type === 1) {
      // Telnet: only host and port are documented; the rest of the line is MobaXterm-specific.
      sessions.push({
        id: newId(),
        name: b.name,
        type: 'telnet',
        folder: base(b.folder),
        host: g[1],
        port: Number(g[2]) || 23,
        color: b.color
      })
    } else if (b.type === 4) {
      let username = g[3] || undefined
      let rdpDomain: string | undefined
      if (username?.includes('\\')) [rdpDomain, username] = username.split('\\', 2)
      sessions.push({
        id: newId(),
        name: b.name,
        type: 'rdp',
        folder: base(b.folder),
        host: g[1],
        port: Number(g[2]) || 3389,
        username,
        rdpDomain,
        color: b.color
      })
    } else {
      const t = typeNames[b.type] ?? `type ${b.type}`
      unsupported[t] = (unsupported[t] ?? 0) + 1
    }
  }
  return { sessions, unsupported }
}

// ---------------------------------------------------------------- export

const TERMINAL_SETTINGS =
  'MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%0%'

function sshLine(s: Session, all: Session[]): string {
  const jump = s.jumpSessionId ? all.find((x) => x.id === s.jumpSessionId) : undefined
  const g = Array<string>(39).fill('')
  Object.assign(g, {
    0: '0',
    1: s.host ?? '',
    2: String(s.port ?? 22),
    3: s.username ?? '',
    5: '-1',
    6: '0',
    7: mobaEscape(s.startupCommand ?? ''),
    8: jump?.host ?? '',
    9: jump ? String(jump.port ?? 22) : '',
    10: jump?.username ?? '',
    11: '0',
    12: s.username ? '0' : '-1',
    13: '0',
    14: s.auth === 'key' ? (s.privateKeyPath ?? '') : '',
    15: jump?.auth === 'key' ? (jump.privateKeyPath ?? '') : '',
    16: '-1',
    17: '-1',
    18: '0',
    19: '0',
    21: '1080',
    23: '0',
    24: '0',
    25: '1',
    27: '0',
    31: '0',
    32: '-1',
    33: s.auth === 'agent' ? '-1' : '0',
    34: '0',
    37: '0'
  })
  return `${mobaEscape(s.name)}=#109#${g.join('%')}#${TERMINAL_SETTINGS}#0# #${toMobaColor(s.color)}`
}

function rdpLine(s: Session): string {
  const user = s.rdpDomain ? `${s.rdpDomain}\\${s.username ?? ''}` : (s.username ?? '')
  const g = ['4', s.host ?? '', String(s.port ?? 3389), user, '0', '0', '0', '0', '-1', '0', '0', '-1', '', '', '', '', '0', '0', '', '-1', '', '-1', '-1', '0', '-1', '0', '-1', '0', '0', '0', '0', '']
  return `${mobaEscape(s.name)}=#91#${g.join('%')}#${TERMINAL_SETTINGS}#0# #${toMobaColor(s.color)}`
}

/** Serialize SSH and RDP sessions to the .mxtsessions format (CRLF; encode as CP1252). */
export function sessionsToMoba(sessions: Session[]): { text: string; skipped: number } {
  const exportable = sessions.filter((s) => s.type === 'ssh' || s.type === 'rdp')
  const byFolder = new Map<string, Session[]>()
  for (const s of exportable) byFolder.set(s.folder, [...(byFolder.get(s.folder) ?? []), s])
  const lines: string[] = ['[Bookmarks]', 'SubRep=', 'ImgNum=42']
  const line = (s: Session): string => (s.type === 'ssh' ? sshLine(s, sessions) : rdpLine(s))
  for (const s of byFolder.get('') ?? []) lines.push(line(s))
  let n = 1
  for (const [folder, list] of [...byFolder].filter(([f]) => f).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('', `[Bookmarks_${n++}]`, `SubRep=${folder.replace(/\//g, '\\')}`, 'ImgNum=41')
    for (const s of list) lines.push(line(s))
  }
  return { text: lines.join('\r\n') + '\r\n', skipped: sessions.length - exportable.length }
}

// ---------------------------------------------------------------- macros

/**
 * Best-effort conversion of a decrypted MobaXterm macro. Recorded macros are stored as
 * "__PIPE__"/"|"-separated entries like "12:2:0:text"; anything else is treated as typed text.
 * Every line becomes a "send" step, so the result can be reviewed and edited.
 */
export function mobaMacroToSteps(plain: string): MacroStep[] {
  const entries = plain.split(/__PIPE__|\|/)
  const structured = entries.filter((e) => /^\d+:\d+:\d+:/.test(e))
  let text: string
  if (structured.length && structured.length >= entries.filter(Boolean).length - 1) {
    text = structured.map((e) => e.replace(/^\d+:\d+:\d+:/, '')).join('\r')
  } else {
    text = plain
  }
  return text
    .replace(/\r\n|\n/g, '\r')
    .split('\r')
    .filter((l, i, arr) => l !== '' || i < arr.length - 1)
    .map((l) => ({ kind: 'send' as const, text: l + '\r' }))
}

export function mobaMacroToMacro(name: string, plain: string, hotkey: string | undefined, newId: () => string): Macro {
  return { id: newId(), name, steps: mobaMacroToSteps(plain), hotkey }
}
