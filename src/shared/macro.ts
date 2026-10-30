import type { MacroStep } from './types'

// Text format for editing macros:
//   > ls -la          send "ls -la" + Enter
//   >> y\n            send raw text, escapes: \n \r \t \e \\ \xNN
//   wait 500          sleep 500 ms
//   expect \$ 5000    wait until output matches regex (timeout ms, default 10000)
//   # comment

function unescape(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_m, c: string) => {
    if (c[0] === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16))
    return { n: '\n', r: '\r', t: '\t', e: '\x1b', '\\': '\\' }[c] ?? c
  })
}

function escape(s: string): string {
  return s.replace(/[\\\x00-\x1f\x7f]/g, (c) => {
    const named: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\x1b': '\\e' }
    return named[c] ?? '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')
  })
}

export function parseMacro(text: string): MacroStep[] {
  const steps: MacroStep[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trimEnd()
    if (!line.trim() || line.trimStart().startsWith('#')) return
    if (line.startsWith('>> ')) steps.push({ kind: 'send', text: unescape(line.slice(3)) })
    else if (line.startsWith('> ')) steps.push({ kind: 'send', text: line.slice(2) + '\r' })
    else if (line === '>') steps.push({ kind: 'send', text: '\r' })
    else {
      const wait = line.match(/^wait\s+(\d+)$/i)
      const expect = line.match(/^expect\s+(.+?)(?:\s+(\d+))?$/i)
      if (wait) steps.push({ kind: 'wait', ms: Number(wait[1]) })
      else if (expect) {
        new RegExp(expect[1]) // validate
        steps.push({ kind: 'waitFor', pattern: expect[1], timeoutMs: expect[2] ? Number(expect[2]) : 10000 })
      } else throw new Error(`Line ${i + 1}: cannot parse "${line}"`)
    }
  })
  return steps
}

export function serializeMacro(steps: MacroStep[]): string {
  return steps
    .map((s) => {
      if (s.kind === 'wait') return `wait ${s.ms}`
      if (s.kind === 'waitFor') return `expect ${s.pattern} ${s.timeoutMs}`
      const body = s.text.slice(0, -1)
      if (s.text.endsWith('\r') && !/[\x00-\x1f\x7f\\]/.test(body)) return body ? `> ${body}` : '>'
      return `>> ${escape(s.text)}`
    })
    .join('\n')
}

/** Turns raw terminal keystrokes into macro steps, one "send" per Enter. */
export class MacroRecorder {
  private line = ''
  steps: MacroStep[] = []

  feed(data: string): void {
    for (const ch of data) {
      if (ch === '\x7f' || ch === '\b') {
        this.line = this.line.slice(0, -1)
      } else if (ch === '\r') {
        this.steps.push({ kind: 'send', text: this.line + '\r' })
        this.line = ''
      } else {
        this.line += ch
      }
    }
  }

  finish(): MacroStep[] {
    if (this.line) this.steps.push({ kind: 'send', text: this.line })
    this.line = ''
    return this.steps
  }
}

const acceleratorKeys: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  '+': 'Plus'
}

/** hotkeyOf() string → Electron accelerator, to show it in the menu; undefined if it has no equivalent. */
export function toAccelerator(hotkey: string): string | undefined {
  if (!hotkey) return undefined
  const parts = hotkey.split('+')
  // hotkeyOf() writes the + key itself as "Cmd++".
  const key = hotkey.endsWith('++') ? '+' : parts[parts.length - 1]
  const mods = (hotkey.endsWith('++') ? parts.slice(0, -2) : parts.slice(0, -1)).map((m) => (m === 'Cmd' ? 'Command' : m))
  const k = /^[A-Z0-9]$|^F\d{1,2}$/.test(key) ? key : /^[-=[\];',./`\\]$/.test(key) ? key : acceleratorKeys[key]
  return k ? [...mods, k].join('+') : undefined
}

// Physical keys by KeyboardEvent.code: e.key is " " for Space (invisible in the field) and, with
// Option on macOS, a different character altogether (Option+Space = no-break space, Option+; = "…").
const codeKeys: Record<string, string> = {
  Space: 'Space',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

const modOrder = ['Cmd', 'Ctrl', 'Alt', 'Shift']
const modAlias: Record<string, string> = { Command: 'Cmd', Cmd: 'Cmd', Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift' }

/** Canonical form of an Electron accelerator ("CmdOrCtrl+Shift+T" → "Cmd+Shift+T" on macOS). */
export function normalizeAccelerator(accel: string, mac: boolean): string {
  const parts = accel.split('+')
  const key = accel.endsWith('++') ? 'Plus' : parts[parts.length - 1]
  const mods = (accel.endsWith('++') ? parts.slice(0, -2) : parts.slice(0, -1)).map((m) =>
    m === 'CmdOrCtrl' || m === 'CommandOrControl' ? (mac ? 'Cmd' : 'Ctrl') : (modAlias[m] ?? m)
  )
  return [...modOrder.filter((m) => mods.includes(m)), key.length === 1 ? key.toUpperCase() : key].join('+')
}

/** Does a menu accelerator fire on this hotkeyOf() string? Then the user's key should win. */
export function sameShortcut(accel: string | undefined, hotkey: string, mac: boolean): boolean {
  const a = toAccelerator(hotkey)
  return !!accel && !!a && normalizeAccelerator(accel, mac) === normalizeAccelerator(a, mac)
}

/** Normalised hotkey string for a KeyboardEvent, e.g. "Ctrl+Shift+1", "Alt+Space". */
export function hotkeyOf(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; key: string; code: string }): string {
  const mods = [e.metaKey && 'Cmd', e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean)
  let key = e.code.startsWith('Digit') ? e.code.slice(5) : e.code.startsWith('Key') ? e.code.slice(3) : codeKeys[e.code] ?? e.key
  if (/^F\d+$/.test(e.code)) key = e.code
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+')
}

/** A hotkey without Cmd / Ctrl / Alt (F-keys aside) would swallow normal typing in the terminal. */
export function needsModifier(hotkey: string): boolean {
  return !!hotkey && !/(^|\+)(Cmd|Ctrl|Alt)\+/.test(hotkey) && !/(^|\+)F\d+$/.test(hotkey)
}
