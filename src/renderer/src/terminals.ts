import { Terminal, type IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Macro, Session, Settings } from '@shared/types'
import { MacroRecorder } from '@shared/macro'
import { asksForSecret, looksLikePrompt } from '@shared/ai'
import { parsePrompt } from '@shared/parse'
import { commandOnScreen, findDanger, InputLine, macroLines } from '@shared/danger'
import { endsSession, isNetworkError, Retry, RETRY_LIMIT } from '@shared/reconnect'
import { api, errorMessage, isMac } from './api'
import { termTheme } from './themes'
import { allPanes, askChoice, askPaste, findPane, promptLogin, toast, useStore, type LoginAnswer, type Pane } from './store'
import { forgetTypedPassword, keepLogin, typedLogin } from './login'
import { englishKey } from '@shared/keyboard'
import { commandFromLine, commandToKeep, longerCommand, suggestRest } from '@shared/history'
import { keepCommand, loadCommandHistory, historyLists } from './history'

interface Entry {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  paneId: string
  /** what was typed since the last Enter, for the dangerous command check */
  typed: InputLine
  retry: Retry
  /** when the user last asked to end the session (exit, Ctrl-D): closing then is no drop */
  leftAt?: number
  /** the try under way belongs to the reconnect loop */
  reconnecting?: boolean
  /** when the shell last reported its folder itself (OSC 7) */
  osc7At?: number
  promptTimer?: ReturnType<typeof setTimeout>
  lastOutputAt?: number
  /** the grey command suggestion over the terminal */
  ghost?: HTMLDivElement
  /** something was pressed since the last Enter: there's a line being edited */
  editing?: boolean
  /** where the prompt ended when the first key of the line was pressed */
  lineStart?: { marker: IMarker; x: number }
  /** how much of `typed` came before the last Tab: only what's after it must show on screen */
  typedBeforeTab?: number
}

/** A full-screen program that lost its connection can't switch these back itself. */
const RESET_MODES = '\x1b[?1l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m'
/** Only when one is open: this also restores the saved cursor, which on the normal screen sends
 *  the next text back over old output. */
const LEAVE_ALT_SCREEN = '\x1b[?1049l'

const entries = new Map<string, Entry>()
const paneByConn = new Map<string, string>()
const outputListeners = new Map<string, Set<(data: string) => void>>()
let recorder: MacroRecorder | undefined

api.onData((connId, data) => {
  const paneId = paneByConn.get(connId)
  if (paneId) {
    const entry = entries.get(paneId)
    entry?.term.write(data)
    if (entry) entry.lastOutputAt = Date.now()
    noteActivity(connId, paneId)
    watchPrompt(paneId)
  }
  outputListeners.get(connId)?.forEach((fn) => fn(data))
})

// Output in a tab that is not open marks it (its title breathes softly in the tab bar) until it
// is opened. Output we caused ourselves does not count: the echo of typing (multi-exec, macros),
// the shell redrawing after a resize, and the login banner right after connecting.
const quietUntil = new Map<string, number>()
export function quiet(connId: string, ms: number): void {
  quietUntil.set(connId, Math.max(quietUntil.get(connId) ?? 0, Date.now() + ms))
}
function noteActivity(connId: string, paneId: string): void {
  if (Date.now() < (quietUntil.get(connId) ?? 0)) return
  const s = useStore.getState()
  const tab = s.tabs.find((t) => t.panes.some((p) => p.id === paneId))
  if (!tab || tab.id === s.activeTabId || s.activity[tab.id]) return
  useStore.setState({ activity: { ...s.activity, [tab.id]: true } })
}
useStore.subscribe((s, prev) => {
  if (s.activeTabId !== prev.activeTabId && s.activeTabId && s.activity[s.activeTabId]) {
    const { [s.activeTabId]: _seen, ...activity } = s.activity
    useStore.setState({ activity })
  }
  // closed tabs
  if (s.tabs !== prev.tabs && Object.keys(s.activity).some((id) => !s.tabs.some((t) => t.id === id)))
    useStore.setState({ activity: Object.fromEntries(Object.keys(s.activity).filter((id) => s.tabs.some((t) => t.id === id)).map((id) => [id, true])) })
})

// Most shells don't report their folder (bash on Ubuntu has no OSC 7 unless configured), but a prompt
// usually shows it. Read once output settles. Right after an OSC 7 the shell's own word wins.
const PROMPT_SETTLE_MS = 120
const OSC7_WINS_MS = 2000
function watchPrompt(paneId: string): void {
  const entry = entries.get(paneId)
  if (!entry || !findPane(paneId)?.isSsh) return
  clearTimeout(entry.promptTimer)
  entry.promptTimer = setTimeout(() => {
    const pane = findPane(paneId)
    if (!pane || !entries.has(paneId) || entry.term.buffer.active.type === 'alternate') return
    if (Date.now() - (entry.osc7At ?? 0) < OSC7_WINS_MS) return
    const prompt = parsePrompt(screenCommand(entry.term))
    if (!prompt) return
    // A prompt with only the last name: the old folder is no longer known to be right.
    const cwd = prompt.path ?? undefined
    if (cwd !== pane.cwd || prompt.user !== pane.cwdUser) useStore.getState().updatePane(paneId, { cwd, cwdUser: prompt.user })
  }, PROMPT_SETTLE_MS)
}

api.onStats((connId, stats) => useStore.setState((s) => ({ serverStats: { ...s.serverStats, [connId]: stats } })))

api.onStatus((s) => {
  const paneId = paneByConn.get(s.connId)
  if (!paneId) return
  const store = useStore.getState()
  if (s.state === 'closed' || s.state === 'error') {
    paneByConn.delete(s.connId)
    useStore.setState((st) => {
      const { [s.connId]: _gone, ...serverStats } = st.serverStats
      return { serverStats }
    })
    store.updatePane(paneId, { state: 'closed', connId: undefined })
    const entry = entries.get(paneId)
    if (!entry) return
    entry.term.write((entry.term.buffer.active.type === 'alternate' ? LEAVE_ALT_SCREEN : '') + RESET_MODES)
    entry.typed = new InputLine()
    endLine(entry)
    entry.retry.down()
    const left = entry.leftAt !== undefined && Date.now() - entry.leftAt < 5000
    if (s.lost && !left && store.settings?.autoReconnect !== false && findPane(paneId)?.sessionId) {
      entry.term.write(`\r\n\x1b[33m[Connection lost${s.message ? `: ${s.message}` : ''}]\x1b[0m\r\n`)
      waitToReconnect(paneId)
    } else {
      entry.term.write(`\r\n\x1b[33m[Session closed${s.message ? `: ${s.message}` : ''}. Press R to reconnect]\x1b[0m\r\n`)
    }
  }
})

export function getEntry(paneId: string): Entry | undefined {
  return entries.get(paneId)
}

function termOptions(s: Settings): ConstructorParameters<typeof Terminal>[0] {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    scrollback: s.scrollback,
    theme: termTheme(s),
    cursorStyle: s.cursorStyle ?? 'bar',
    cursorInactiveStyle: 'outline',
    cursorBlink: s.cursorBlink ?? true,
    allowProposedApi: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: true
  }
}

/** Panes that receive input typed into `paneId` (multi-exec aware). */
function inputTargets(paneId: string): Pane[] {
  const s = useStore.getState()
  const self = findPane(paneId)
  if (!self) return []
  if (!s.multiExec || s.multiExecExcluded[paneId]) return [self]
  return allPanes().filter((p) => !s.multiExecExcluded[p.id])
}

function sendInput(paneId: string, data: string): void {
  if (recorder) recorder.feed(data)
  for (const p of inputTargets(paneId))
    if (p.connId) {
      quiet(p.connId, 1000)
      api.write(p.connId, data)
    }
}

/** The command line under the cursor as the terminal shows it: covers history, completion and programs like mysql. */
function screenCommand(term: Terminal): string {
  const buf = term.buffer.active
  const rowsOf = (y: number): [number, number] => {
    let first = y
    let last = y
    while (first > 0 && buf.getLine(first)?.isWrapped) first--
    while (buf.getLine(last + 1)?.isWrapped) last++
    return [first, last]
  }
  return commandOnScreen((back) => {
    let y = buf.baseY + buf.cursorY
    for (let i = 0; i < back; i++) y = rowsOf(y)[0] - 1
    if (y < 0) return undefined
    const [first, last] = rowsOf(y)
    let text = ''
    for (let r = first; r <= last; r++) text += buf.getLine(r)?.translateToString(r === last) ?? ''
    return text
  })
}

interface DangerHit {
  text: string
  reasons: string[]
}

function dangerIn(candidates: string[]): DangerHit[] {
  const settings = useStore.getState().settings
  if (settings?.warnDangerousCommands === false) return []
  return candidates.map((text) => ({ text, reasons: findDanger(text, settings?.dangerWatchList) })).filter((h) => h.reasons.length)
}

/** True = run it anyway. */
async function askDanger(paneId: string, hits: DangerHit[], targets = inputTargets(paneId)): Promise<boolean> {
  const watchList = useStore.getState().settings?.dangerWatchList
  const names = [...new Set(targets.map((p) => p.title))].join(', ')
  const answer = await askChoice({
    title: 'Dangerous command',
    message: `${[...new Set(hits.flatMap((h) => h.reasons))].join('. ')}. It will run on ${
      targets.length > 1 ? `${targets.length} terminals: ${names}` : names
    }.`,
    // The first candidate is what was typed, which reads better than the screen line with its prompt.
    items: hits[0].text.split('\n').filter((l) => findDanger(l, watchList).length).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)),
    buttons: [
      { label: 'Cancel', value: 'cancel', primary: true },
      { label: 'Run anyway', value: 'run', danger: true }
    ]
  })
  entries.get(paneId)?.term.focus()
  return answer === 'run'
}

const askingDanger = new Set<string>()

function handleInput(paneId: string, data: string): void {
  const pane = findPane(paneId)
  if (!pane) return
  const entry = entries.get(paneId)
  // Esc stops the reconnect loop, also while a try is under way.
  if (data === '\x1b' && entry && !pane.connId && (entry.retry.waiting || (pane.state === 'connecting' && entry.reconnecting))) {
    entry.retry.stop()
    entry.term.write('\r\x1b[2K\x1b[33m[Stopped reconnecting. Press R to reconnect]\x1b[0m\r\n')
    return
  }
  if (pane.state === 'closed' && (data === 'r' || data === 'R')) {
    if (entry?.retry.waiting) {
      entry.retry.skip()
      entry.term.write('\r\x1b[2K')
      void connectPane(paneId, true)
    } else {
      entry?.retry.stop()
      void connectPane(paneId)
    }
    return
  }
  if (entry && data === '\x04') entry.leftAt = Date.now()
  const lines = entry?.typed.feed(data)
  if (entry?.term.buffer.active.type === 'alternate') entry.typed.clear() // keys for vim or less, not a command line
  // Full-screen programs (vim, less…) have no command line: Enter there runs nothing.
  if (!entry || !lines || !pane.connId || entry.term.buffer.active.type === 'alternate') return sendInput(paneId, data)
  if (askingDanger.has(paneId)) return // the dialog is up; a late Enter must not slip through
  const onScreen = screenCommand(entry.term)
  if (endsSession(lines[lines.length - 1] ?? '') || endsSession(onScreen)) entry.leftAt = Date.now()
  const hits = dangerIn([lines.join('\n'), onScreen])
  if (!hits.length) {
    if (lines.length === 1 && useStore.getState().settings?.commandSuggestions !== false) {
      const command = commandToKeep(onScreen, lines[0], fromLineStart(entry))
      if (command) keepCommand(pane.sessionId, command)
    }
    return sendInput(paneId, data)
  }
  askingDanger.add(paneId)
  void askDanger(paneId, hits).then((ok) => {
    askingDanger.delete(paneId)
    if (!ok) return
    sendInput(paneId, data)
    endLine(entry)
  })
}

function endLine(entry: Entry): void {
  entry.lineStart?.marker.dispose()
  entry.lineStart = undefined
  entry.editing = false
  entry.typedBeforeTab = 0
}

/** Keeps track of the line being edited: called with each key before it goes anywhere. */
function noteKeys(entry: Entry): void {
  if (entry.editing) return
  entry.editing = true
  const { term } = entry
  const marker = term.buffer.active.type === 'normal' ? term.registerMarker(0) : undefined
  if (marker) entry.lineStart = { marker, x: term.buffer.active.cursorX }
}

/** What is on the line between where the first key was pressed and the cursor. Knows no prompts, so ➜ is fine. */
function fromLineStart(entry: Entry): string | undefined {
  const mark = entry.lineStart
  const buf = entry.term.buffer.active
  if (!mark || mark.marker.isDisposed || mark.marker.line < 0) return undefined
  const y = buf.baseY + buf.cursorY
  if (mark.marker.line > y) return undefined
  for (let r = y; r > mark.marker.line; r--) if (!buf.getLine(r)?.isWrapped) return undefined // it's no longer that line
  let text = ''
  for (let r = mark.marker.line; r <= y; r++) text += buf.getLine(r)?.translateToString(false, r === mark.marker.line ? mark.x : 0, r === y ? buf.cursorX : undefined) ?? ''
  return text
}

/** The rest of the command history suggests for what is on the prompt, if the prompt is plain to see. */
function suggestionFor(entry: Entry): string | undefined {
  if (!entry.editing || useStore.getState().settings?.commandSuggestions === false) return undefined
  const pane = findPane(entry.paneId)
  const buf = entry.term.buffer.active
  if (!pane?.connId || buf.type === 'alternate' || askingDanger.has(entry.paneId) || inputTargets(entry.paneId).length > 1) return undefined
  const y = buf.baseY + buf.cursorY
  const line = buf.getLine(y)
  if (!line) return undefined
  let first = y
  while (first > 0 && buf.getLine(first)?.isWrapped) first--
  let before = ''
  for (let r = first; r <= y; r++) before += buf.getLine(r)?.translateToString(false, 0, r === y ? buf.cursorX : undefined) ?? ''
  // Text after the cursor means the shell is editing or suggesting by itself.
  if (line.translateToString(true, buf.cursorX) || asksForSecret(before)) return undefined
  // What the screen says, not the keys: Tab and ↑ put text there that was never typed.
  const typed = entry.typed.value
  const command = longerCommand(commandFromLine(before), fromLineStart(entry)) ?? (before.endsWith(typed) ? typed : undefined)
  if (!command) return undefined
  // The echo of the last keys is still on its way: what's on screen is about to change.
  if (!command.endsWith(typed.slice(entry.typedBeforeTab ?? 0))) return undefined
  return suggestRest(command, ...historyLists(pane.sessionId))
}

function drawSuggestion(entry: Entry): void {
  const rest = suggestionFor(entry)
  const { term } = entry
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  const buf = term.buffer.active
  const row = buf.baseY + buf.cursorY - buf.viewportY
  if (!rest || !screen || !screen.offsetWidth || row < 0 || row >= term.rows) {
    if (entry.ghost) entry.ghost.hidden = true
    return
  }
  if (!entry.ghost) {
    entry.ghost = document.createElement('div')
    entry.ghost.className = 'term-suggestion'
    entry.ghost.setAttribute('aria-hidden', 'true')
  }
  const ghost = entry.ghost
  if (ghost.parentElement !== screen) screen.appendChild(ghost)
  const cellW = screen.offsetWidth / term.cols
  const cellH = screen.offsetHeight / term.rows
  ghost.hidden = false
  ghost.textContent = rest
  ghost.style.left = `${buf.cursorX * cellW}px`
  ghost.style.top = `${row * cellH}px`
  ghost.style.width = `${(term.cols - buf.cursorX) * cellW}px`
  ghost.style.height = ghost.style.lineHeight = `${cellH}px`
  ghost.style.fontFamily = term.options.fontFamily ?? ''
  ghost.style.fontSize = `${term.options.fontSize}px`
  ghost.style.color = term.options.theme?.foreground ?? ''
}

export async function pasteInto(paneId: string, text?: string): Promise<void> {
  const entry = entries.get(paneId)
  if (!entry) return
  const clip = text ?? (await api.readClipboard())
  if (!clip) return
  const settings = useStore.getState().settings
  const lines = clip.split(/\r\n?|\n/).filter((l) => l.trim()).length
  if (!settings?.warnMultilinePaste || lines < 2) return entry.term.paste(clip) // handles bracketed paste; goes through onData → handleInput
  const targets = inputTargets(paneId)
  const edited = await askPaste({
    text: clip,
    target: targets.length > 1 ? `${targets.length} terminals` : (findPane(paneId)?.title ?? 'the terminal'),
    asBlock: entry.term.modes.bracketedPasteMode
  })
  if (!entries.has(paneId)) return
  entry.term.focus()
  if (edited) entry.term.paste(edited)
}

/** Screen position of the terminal cursor (bottom-left of its cell), for popups like the macro picker. */
export function cursorPoint(paneId: string): { x: number; y: number; lineHeight: number } | undefined {
  const term = entries.get(paneId)?.term
  const screen = term?.element?.querySelector('.xterm-screen')
  if (!term || !screen) return undefined
  const r = screen.getBoundingClientRect()
  if (!r.width || !r.height) return undefined
  const cellW = r.width / term.cols
  const cellH = r.height / term.rows
  const buf = term.buffer.active
  // cursorY counts from the bottom page; the user may have scrolled up from it.
  const row = Math.min(Math.max(buf.baseY + buf.cursorY - buf.viewportY, 0), term.rows - 1)
  return { x: r.left + buf.cursorX * cellW, y: r.top + (row + 1) * cellH, lineHeight: cellH }
}

export function focusTerminal(paneId: string): void {
  entries.get(paneId)?.term.focus()
}

export function copySelection(paneId: string): void {
  const sel = entries.get(paneId)?.term.getSelection()
  if (sel) api.writeClipboard(sel)
}

/**
 * xterm's WebGL renderer shares one glyph texture atlas between terminals with the same
 * font settings. Creating/removing a terminal (or a GPU/DPR change) can repack that atlas
 * while other terminals still reference old glyph positions: their existing text turns into
 * garbage until it is redrawn. Rebuild the atlas and repaint every terminal at those moments.
 */
let healTimer: ReturnType<typeof setTimeout> | undefined
export function repaintAll(): void {
  clearTimeout(healTimer)
  healTimer = setTimeout(() => {
    for (const e of entries.values()) {
      try {
        e.term.clearTextureAtlas()
        e.term.refresh(0, e.term.rows - 1)
      } catch {
        /* disposed meanwhile */
      }
    }
  }, 30)
}

window.addEventListener('focus', repaintAll)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && repaintAll())
// Screen scaling change (window moved to another monitor, OS zoom): re-arm the query each time.
const watchDpr = (): void => {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      repaintAll()
      watchDpr()
    },
    { once: true }
  )
}
watchDpr()

/** SSH and Telnet get the keys as pressed, whatever input method the computer is using. */
function englishOnly(paneId: string): boolean {
  const s = useStore.getState()
  if (s.settings?.terminalEnglishOnly === false) return false
  const sessionId = findPane(paneId)?.sessionId
  const type = sessionId && s.sessions.find((x) => x.id === sessionId)?.type
  return type === 'ssh' || type === 'telnet'
}

let secureFor: string | undefined

function watchKeyboard(paneId: string, box: HTMLTextAreaElement): void {
  // A read-only field makes Chromium turn the input method off, on every system.
  box.readOnly = englishOnly(paneId)
  box.addEventListener('focus', () => {
    box.readOnly = englishOnly(paneId)
    secureFor = box.readOnly ? paneId : undefined
    void api.setSecureInput(box.readOnly)
  })
  box.addEventListener('blur', () => {
    secureFor = undefined
    void api.setSecureInput(false)
  })
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend'])
    box.addEventListener(type, (e) => box.readOnly && e.stopImmediatePropagation(), true)
}

useStore.subscribe((s, prev) => {
  if (s.settings?.terminalEnglishOnly === prev.settings?.terminalEnglishOnly) return
  for (const [paneId, entry] of entries) if (entry.term.textarea) entry.term.textarea.readOnly = englishOnly(paneId)
})

export function createTerminal(paneId: string, container: HTMLElement): Entry {
  const existing = entries.get(paneId)
  if (existing) {
    // The pane moved (split/merge/detach): carry the live terminal over to the new container.
    const el = existing.term.element
    if (el && el.parentElement !== container) container.appendChild(el)
    return existing
  }
  const settings = useStore.getState().settings!
  const term = new Terminal(termOptions(settings))
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))
  term.open(container)
  if (settings.gpuRendering !== false) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        // GPU reset / too many contexts: fall back to the DOM renderer for this terminal.
        webgl.dispose()
        repaintAll()
      })
      term.loadAddon(webgl)
    } catch {
      /* falls back to the DOM renderer */
    }
  }
  repaintAll() // the shared glyph atlas may have been repacked for this new terminal
  // If the font was still loading at open(), cell widths were measured with a fallback font
  // and the cursor drifts away from the text. Re-measure once fonts are ready.
  void document.fonts.ready.then(() => {
    if (!entries.has(paneId)) return
    term.clearTextureAtlas()
    fitPane(paneId)
  })

  // Let app shortcuts (Cmd+… on mac, Ctrl+Shift+… elsewhere) reach the menu instead of the shell.
  term.attachCustomKeyEventHandler((e) => {
    if (isMac && e.metaKey) return false
    if (!isMac && e.ctrlKey && e.shiftKey && /^[A-Z]$/.test(e.key.toUpperCase()) && e.key.length === 1) return false
    if (e.type === 'keydown' && (e.key === 'ArrowRight' || e.key === 'End') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const entry = entries.get(paneId)
      const rest = entry && suggestionFor(entry)
      if (rest) {
        e.preventDefault()
        term.input(rest, true)
        return false
      }
    }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && englishOnly(paneId)) {
      if (e.type === 'keypress') return false
      const typed = e.type === 'keydown' ? englishKey({ key: e.key, code: e.code, shiftKey: e.shiftKey, capsLock: e.getModifierState('CapsLock') }) : undefined
      if (typed !== undefined) {
        e.preventDefault()
        if (typed) term.input(typed, true)
        return false
      }
    }
    return true
  })
  if (term.textarea) watchKeyboard(paneId, term.textarea)
  term.onData((d) => {
    const entry = entries.get(paneId)
    if (entry) noteKeys(entry)
    handleInput(paneId, d)
    if (!entry) return
    if (d.includes('\t')) entry.typedBeforeTab = entry.typed.value.length
    // The line is over; an Enter held back by the danger warning isn't, the text stays on the prompt.
    // eslint-disable-next-line no-control-regex
    if (/[\r\n\x03\x04\x0c]/.test(d) && !d.startsWith('\x1b[200~') && !askingDanger.has(paneId)) endLine(entry)
    // Typing updates the suggestion when the echo comes; a line that's gone takes it away now.
    if (!entry.editing) drawSuggestion(entry)
  })
  const redrawSuggestion = (): void => {
    const entry = entries.get(paneId)
    if (entry && (entry.editing || entry.ghost?.hidden === false)) drawSuggestion(entry)
  }
  term.onWriteParsed(redrawSuggestion)
  term.onScroll(redrawSuggestion)
  term.onResize(({ cols, rows }) => {
    // The rows just got re-flowed: where the line started is anyone's guess now.
    const resized = entries.get(paneId)
    if (resized?.lineStart) {
      resized.lineStart.marker.dispose()
      resized.lineStart = undefined
    }
    // Exposed for debugging/tests: what size the shell should be using.
    if (term.element?.parentElement) term.element.parentElement.dataset.size = `${cols}x${rows}`
    const p = findPane(paneId)
    if (p?.connId) {
      quiet(p.connId, 1000)
      api.resize(p.connId, cols, rows)
    }
  })
  term.onSelectionChange(() => {
    if (useStore.getState().settings?.copyOnSelect && term.hasSelection()) api.writeClipboard(term.getSelection())
  })
  // OSC 7: file://host/path — lets SFTP follow the terminal folder.
  term.parser.registerOscHandler(7, (data) => {
    const m = data.match(/^file:\/\/[^/]*(\/.*)$/)
    if (m) {
      const entry = entries.get(paneId)
      if (entry) entry.osc7At = Date.now()
      useStore.getState().updatePane(paneId, { cwd: decodeURIComponent(m[1]), cwdUser: undefined })
    }
    return true
  })
  // Listeners live on the xterm element so they follow it when the pane moves.
  const el = term.element!
  el.addEventListener('contextmenu', (e) => {
    if (!useStore.getState().settings?.rightClickPaste) return
    e.preventDefault()
    if (term.hasSelection() && !useStore.getState().settings?.copyOnSelect) copySelection(paneId)
    else pasteInto(paneId)
  })
  // Intercept native paste (menu / Cmd+V) to apply the multi-line warning and multi-exec.
  el.addEventListener(
    'paste',
    (e) => {
      e.preventDefault()
      e.stopPropagation()
      pasteInto(paneId, e.clipboardData?.getData('text/plain') ?? '')
    },
    true
  )

  loadCommandHistory()
  const entry: Entry = { term, fit, search, paneId, typed: new InputLine(), retry: new Retry() }
  entries.set(paneId, entry)
  return entry
}

export function disposeTerminal(paneId: string): void {
  const entry = entries.get(paneId)
  const pane = findPane(paneId)
  if (pane?.connId) {
    api.closeConn(pane.connId)
    paneByConn.delete(pane.connId)
  }
  entry?.retry.stop()
  clearTimeout(entry?.promptTimer)
  if (secureFor === paneId) {
    secureFor = undefined
    void api.setSecureInput(false)
  }
  entry?.term.dispose()
  entries.delete(paneId)
  if (entry) repaintAll()
}

export function fitPane(paneId: string): void {
  const e = entries.get(paneId)
  if (!e || !e.term.element?.offsetParent) return
  try {
    e.fit.fit()
  } catch {
    /* not visible */
  }
}

export function applySettings(s: Settings): void {
  for (const e of entries.values()) {
    e.term.options.fontFamily = s.fontFamily
    e.term.options.fontSize = s.fontSize
    e.term.options.scrollback = s.scrollback
    e.term.options.theme = termTheme(s)
    e.term.options.cursorStyle = s.cursorStyle ?? 'bar'
    e.term.options.cursorBlink = s.cursorBlink ?? true
    fitPane(e.paneId)
  }
}

function isAuthError(msg: string): boolean {
  return /authentication|auth methods|All configured/i.test(msg)
}

function isPassphraseError(msg: string): boolean {
  return /passphrase|encrypted private key/i.test(msg)
}

/** Count down to the next try on the terminal's last line, unless it is time to give up. */
function waitToReconnect(paneId: string): void {
  const entry = entries.get(paneId)
  if (!entry) return
  const line = '\r\x1b[2K\x1b[33m'
  const waiting = entry.retry.next(
    (left, n) => entry.term.write(`${line}[Reconnecting in ${left}s, try ${n}. R: now, Esc: stop]\x1b[0m`),
    () => {
      entry.term.write('\r\x1b[2K')
      void connectPane(paneId, true)
    }
  )
  if (!waiting) {
    const why = entry.retry.stopped ? 'Stopped reconnecting' : `No connection after ${RETRY_LIMIT} tries`
    entry.term.write(`${line}[${why}. Press R to reconnect]\x1b[0m\r\n`)
  }
}

/** `auto`: a try of the reconnect loop, which keeps quiet and takes nobody's focus. */
export async function connectPane(paneId: string, auto = false): Promise<void> {
  const pane = findPane(paneId)
  const entry = entries.get(paneId)
  if (!pane || !entry) return
  const store = useStore.getState()
  const sessionId = pane.sessionId
  const session = (): Session | undefined => useStore.getState().sessions.find((s) => s.id === sessionId)
  const fail = (text: string): void => {
    store.updatePane(paneId, { state: 'closed' })
    entry.term.write(`\x1b[31m${text}\x1b[0m\r\n\x1b[33m[Press R to retry]\x1b[0m\r\n`)
  }
  store.updatePane(paneId, { state: 'connecting' })
  entry.reconnecting = auto
  if (sessionId) entry.term.write(auto ? `\r\x1b[2K\x1b[90mReconnecting to ${pane.title}…\x1b[0m` : `\x1b[90mConnecting to ${pane.title}…\x1b[0m\r\n`)

  let { username, password } = sessionId ? typedLogin(sessionId) : ({} as { username?: string; password?: string })
  let typed: LoginAnswer | undefined
  let secretName = 'Password'

  // Keys and agents can fall back to the local account name like ssh does; a password can't.
  const start = session()
  if (start?.type === 'ssh' && !start.username && !username && (start.auth || 'password') === 'password') {
    typed = (await promptLogin({ title: `Login for ${pane.title}`, username: '', askPassword: password === undefined && !start.hasSecret })) ?? undefined
    if (!typed) return fail('Cancelled')
    if (!findPane(paneId)) return
    username = typed.username
    password = typed.password ?? password
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await api.openConn({ sessionId, username, password, cols: entry.term.cols, rows: entry.term.rows })
      if (!findPane(paneId)) {
        api.closeConn(res.connId) // pane closed while connecting
        return
      }
      paneByConn.set(res.connId, paneId)
      entry.retry.up()
      entry.reconnecting = false
      entry.leftAt = undefined
      if (auto) entry.term.write('\r\x1b[2K\x1b[32m[Reconnected]\x1b[0m\r\n')
      quiet(res.connId, 2500)
      store.updatePane(paneId, { connId: res.connId, state: 'connected', isSsh: res.isSsh })
      // The pane may have been resized while connecting (split, tile, sidebar): those resizes
      // were dropped, so send the real size now or the shell wraps lines at the wrong width.
      fitPane(paneId)
      api.resize(res.connId, entry.term.cols, entry.term.rows)
      if (typed && sessionId) await keepLogin(sessionId, typed, secretName)
      if (auto) return
      const s = useStore.getState()
      if (res.isSsh && s.settings?.sftpAutoOpen) s.set({ sidebarOpen: true, sidebarTab: 'sftp' })
      entry.term.focus()
      return
    } catch (err) {
      const msg = errorMessage(err)
      if (!findPane(paneId)) return
      // connectSsh reports a link that closed before the login as a missing password.
      const dropped = /no password given/.test(msg) && (password !== undefined || Boolean(session()?.hasSecret))
      if (auto && (isNetworkError(msg) || dropped)) {
        store.updatePane(paneId, { state: 'closed' })
        return waitToReconnect(paneId)
      }
      if (auto) entry.term.write('\r\x1b[2K')
      entry.reconnecting = false
      // A jump host's failure says so: this server's password wouldn't help.
      const viaJump = msg.startsWith('Jump host')
      const needsPassphrase = !viaJump && isPassphraseError(msg)
      const rejected = !viaJump && !needsPassphrase && isAuthError(msg)
      if (rejected && session()?.auth === 'key') return fail('Authentication failed: the server did not accept this key.')
      if ((rejected || needsPassphrase) && sessionId && attempt < 3) {
        const known = session()
        const wrong = needsPassphrase ? /bad passphrase/i.test(msg) : password !== undefined || Boolean(known?.hasSecret)
        const account = username ?? known?.username ?? ''
        forgetTypedPassword(sessionId)
        secretName = needsPassphrase ? 'Passphrase' : 'Password'
        const answer = await promptLogin({
          title: `${secretName} for ${pane.title}`,
          secretName,
          hint: !wrong ? undefined : needsPassphrase ? 'Wrong passphrase. Try again.' : 'The server rejected the login. Try again.',
          // After a rejection the username may be what's wrong, so it can be fixed here too.
          username: rejected && (wrong || !account) ? account : undefined
        })
        if (answer && !findPane(paneId)) return
        if (answer) {
          typed = answer
          username = answer.username ?? username
          password = answer.password
          continue
        }
      }
      return fail(viaJump ? msg : rejected ? 'Authentication failed' : needsPassphrase ? 'Passphrase required' : msg)
    }
  }
}

// ---------------------------------------------------------------- macros

export function startRecording(): void {
  recorder = new MacroRecorder()
  useStore.setState({ recordingMacro: true })
}

export function stopRecording(): Macro['steps'] {
  const steps = recorder?.finish() ?? []
  recorder = undefined
  useStore.setState({ recordingMacro: false })
  return steps
}

function waitForOutput(connId: string, pattern: string, timeoutMs: number): Promise<void> {
  const re = new RegExp(pattern)
  return new Promise((resolve, reject) => {
    let buf = ''
    const set = outputListeners.get(connId) ?? new Set()
    outputListeners.set(connId, set)
    const done = (err?: Error): void => {
      clearTimeout(timer)
      set.delete(fn)
      err ? reject(err) : resolve()
    }
    // eslint-disable-next-line no-control-regex
    const fn = (d: string): void => {
      buf = (buf + d.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-4096)
      if (re.test(buf)) done()
    }
    const timer = setTimeout(() => done(new Error(`Timed out waiting for /${pattern}/`)), timeoutMs)
    set.add(fn)
  })
}

/** What a terminal receives for a pasted block: whole, so the shell doesn't run it line by line if it can help it. */
function pasteData(pane: Pane, text: string): string {
  const body = text.replace(/\r?\n/g, '\r')
  return entries.get(pane.id)?.term.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body
}

async function runOn(pane: Pane, macro: Macro): Promise<void> {
  const connId = pane.connId!
  for (const step of macro.steps) {
    if (step.kind === 'send' || step.kind === 'paste') {
      quiet(connId, 1000)
      api.write(connId, step.kind === 'send' ? step.text : pasteData(pane, step.text))
    }
    else if (step.kind === 'wait') await new Promise((r) => setTimeout(r, step.ms))
    else await waitForOutput(connId, step.pattern, step.timeoutMs)
  }
}

/** The focused text field (password prompt, search box, form…), if any: macros can type there too. */
export function focusedField(): HTMLInputElement | HTMLTextAreaElement | undefined {
  const el = document.activeElement
  const ok =
    (el instanceof HTMLTextAreaElement && !el.classList.contains('xterm-helper-textarea')) ||
    (el instanceof HTMLInputElement && ['text', 'password', 'search', 'email', 'url', 'tel', 'number'].includes(el.type))
  if (!ok || el.readOnly || el.disabled || el.closest('.macro-picker')) return undefined
  return el
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * Type a macro into a text field as if typed: line breaks press Enter (so a password macro ending
 * in Enter submits the prompt), waits are kept, "wait for output" steps are skipped.
 */
export async function typeIntoField(field: HTMLInputElement | HTMLTextAreaElement, macro: Macro): Promise<void> {
  field.focus()
  for (const step of macro.steps) {
    if (step.kind === 'wait') await new Promise((r) => setTimeout(r, step.ms))
    if (step.kind === 'paste') {
      if (!field.isConnected) return
      // A one-line field can't hold line breaks, and Enter there would submit half of it.
      document.execCommand('insertText', false, field instanceof HTMLInputElement ? step.text.replace(/\n+/g, ' ') : step.text)
      await tick()
    }
    if (step.kind !== 'send') continue
    const lines = step.text.split(/\r\n|\r|\n/)
    for (const [i, line] of lines.entries()) {
      if (!field.isConnected) return
      // eslint-disable-next-line no-control-regex
      const text = line.replace(/\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x1f\x7f]/g, '')
      // insertText goes through the normal input path: React sees it and undo works.
      if (text) document.execCommand('insertText', false, text)
      if (i === lines.length - 1) continue
      await tick() // let React commit the value before an Enter handler reads it
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      await tick()
    }
  }
}

/** Run on the active pane, or on every multi-exec target when multi-exec is on. */
export async function runMacro(macro: Macro, paneId: string): Promise<void> {
  const targets = inputTargets(paneId).filter((p) => p.connId)
  if (!targets.length) return toast('No connected terminal to run the macro on', true)
  const sends = macro.steps.flatMap((step) => (step.kind === 'send' ? [step.text] : step.kind === 'paste' ? [step.text + '\n'] : []))
  const hits = dangerIn([macroLines(sends)])
  if (hits.length && !(await askDanger(paneId, hits))) return
  entries.get(paneId)?.term.focus() // started from a toolbar menu: what comes next is typed in the terminal
  const results = await Promise.allSettled(targets.map((p) => runOn(p, macro)))
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
  if (failed.length) toast(`Macro "${macro.name}": ${errorMessage(failed[0].reason)}`, true)
}

// ---------------------------------------------------------------- AI assistant

/** Lines `from`..`to` of a buffer, with lines the terminal wrapped joined back up. */
function bufferText(buf: Terminal['buffer']['active'], from: number, to: number): string {
  let out = ''
  for (let y = from; y <= to; y++) {
    const line = buf.getLine(y)
    if (!line) break
    if (y > from && !line.isWrapped) out += '\n'
    out += line.translateToString(!buf.getLine(y + 1)?.isWrapped)
  }
  return out.replace(/\s+$/, '')
}

/** What a message to the AI can carry: the selection if there is one, otherwise the screen. */
export function attachableText(paneId: string): { paneId: string; raw: string; source: 'screen' | 'selection' } | undefined {
  const term = entries.get(paneId)?.term
  if (!term) return undefined
  const selection = term.getSelection().trim()
  if (selection) return { paneId, raw: selection, source: 'selection' }
  const buf = term.buffer.active
  return { paneId, raw: bufferText(buf, buf.baseY, buf.baseY + term.rows - 1), source: 'screen' }
}

/** Why a proposed command can't be typed into this pane right now. */
export function runBlock(paneId: string): string | undefined {
  const entry = entries.get(paneId)
  const pane = findPane(paneId)
  if (!entry || !pane) return 'This pane has no terminal to run it in.'
  if (!pane.connId) return 'This terminal is not connected.'
  if (entry.term.buffer.active.type === 'alternate') return 'A full-screen program is open in this terminal. Close it first.'
  if (entry.typed.pending) return 'There is unfinished text at the prompt. Clear it first, so it does not join the command.'
  if (asksForSecret(screenCommand(entry.term))) return 'This terminal is waiting for a password. Answer it first.'
  return undefined
}

export interface ProposedRun {
  /** what it has printed so far */
  read(): string
  /** Settle on how far it got, for when nobody is watching. */
  settle(cancelled: () => boolean, onHold: (holding: boolean) => void): Promise<'finished' | 'running' | 'fullscreen' | 'cancelled'>
}

const SETTLE_QUIET_MS = 400
/** With no prompt and no output for this long, tell the AI it is still going rather than hold everything up. */
const SILENT_MS = 10_000
const LONGEST_MS = 120_000

/**
 * Type a command into this one pane, multi-exec or not. Undefined = it did not run. `focus`: the
 * user clicked Run; in automatic mode they may be typing elsewhere.
 */
export async function runProposed(paneId: string, command: string, focus = true): Promise<ProposedRun | undefined> {
  const before = runBlock(paneId)
  if (before) throw new Error(before)
  const self = findPane(paneId)!
  const hits = dangerIn([command])
  if (hits.length && !(await askDanger(paneId, hits, [self]))) return undefined
  // The dialog took time: the terminal may have changed.
  const after = runBlock(paneId)
  if (after) throw new Error(after)
  const entry = entries.get(paneId)!
  const connId = findPane(paneId)!.connId!
  const marker = entry.term.registerMarker(0)
  if (endsSession(command)) entry.leftAt = Date.now()
  const startRow = marker?.line ?? 0
  quiet(connId, 1000)
  api.write(connId, command + '\r')
  if (focus) entry.term.focus()
  let last = ''
  return {
    read: () => {
      // Keep the last text once the pane is gone, so it can still be sent.
      const term = entries.get(paneId)?.term
      if (!term) return last
      const buf = term.buffer.normal
      // A marker scrolled out of the history, or wiped by `clear`, reads from the top.
      last = bufferText(buf, Math.max(marker?.line ?? 0, 0), buf.length - 1)
      return last
    },
    settle: async (cancelled, onHold) => {
      let since = Date.now()
      let held = false
      for (;;) {
        await new Promise((r) => setTimeout(r, 200))
        if (cancelled()) return 'cancelled'
        const e = entries.get(paneId)
        if (!e || !findPane(paneId)?.connId) return 'finished' // connection gone: nothing more will come
        const buf = e.term.buffer.active
        if (buf.type === 'alternate') return 'fullscreen'
        const line = screenCommand(e.term)
        // sudo and the like: only the user can answer, and the clock stops meanwhile.
        const holding = asksForSecret(line)
        if (holding !== held) onHold((held = holding))
        if (holding) {
          since = Date.now()
          continue
        }
        const now = Date.now()
        const silent = now - Math.max(since, e.lastOutputAt ?? 0)
        // A newer row than the command's own: on a slow link the old prompt is still under the cursor at first.
        if (silent >= SETTLE_QUIET_MS && buf.baseY + buf.cursorY > startRow && looksLikePrompt(line)) return 'finished'
        if (silent >= SILENT_MS || now - since >= LONGEST_MS) return 'running'
      }
    }
  }
}
