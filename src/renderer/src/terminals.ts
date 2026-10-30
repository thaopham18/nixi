import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Macro, Settings } from '@shared/types'
import { MacroRecorder } from '@shared/macro'
import { api, errorMessage, isMac } from './api'
import { termTheme } from './themes'
import { allPanes, findPane, promptPassword, toast, useStore, type Pane } from './store'

interface Entry {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  paneId: string
}

const entries = new Map<string, Entry>()
const paneByConn = new Map<string, string>()
const outputListeners = new Map<string, Set<(data: string) => void>>()
let recorder: MacroRecorder | undefined

api.onData((connId, data) => {
  const paneId = paneByConn.get(connId)
  if (paneId) {
    entries.get(paneId)?.term.write(data)
    noteActivity(connId, paneId)
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
    entries
      .get(paneId)
      ?.term.write(`\r\n\x1b[33m[Session closed${s.message ? `: ${s.message}` : ''}. Press R to reconnect]\x1b[0m\r\n`)
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

function handleInput(paneId: string, data: string): void {
  const pane = findPane(paneId)
  if (!pane) return
  if (pane.state === 'closed' && (data === 'r' || data === 'R')) {
    connectPane(paneId)
    return
  }
  if (recorder) recorder.feed(data)
  for (const p of inputTargets(paneId))
    if (p.connId) {
      quiet(p.connId, 1000)
      api.write(p.connId, data)
    }
}

export async function pasteInto(paneId: string, text?: string): Promise<void> {
  const entry = entries.get(paneId)
  if (!entry) return
  const clip = text ?? (await api.readClipboard())
  if (!clip) return
  const settings = useStore.getState().settings
  const lines = clip.split(/\r?\n/).filter(Boolean).length
  if (settings?.warnMultilinePaste && lines > 1 && !window.confirm(`Paste ${lines} lines into the terminal?`)) return
  entry.term.paste(clip) // handles bracketed paste; goes through onData → handleInput
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
    return true
  })
  term.onData((d) => handleInput(paneId, d))
  term.onResize(({ cols, rows }) => {
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
    if (m) useStore.getState().updatePane(paneId, { cwd: decodeURIComponent(m[1]) })
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

  const entry = { term, fit, search, paneId }
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

/**
 * Passwords typed during this run, per session, so splits,
 * duplicates and reconnects of the same server don't ask again. Memory only.
 */
const typedPasswords = new Map<string, string>()
const passwordKey = (p: Pane): string => p.sessionId ?? ''

export async function connectPane(paneId: string): Promise<void> {
  const pane = findPane(paneId)
  const entry = entries.get(paneId)
  if (!pane || !entry) return
  const store = useStore.getState()
  const key = passwordKey(pane)
  store.updatePane(paneId, { state: 'connecting' })
  if (pane.sessionId) entry.term.write(`\x1b[90mConnecting to ${pane.title}…\x1b[0m\r\n`)

  let password = typedPasswords.get(key)
  let remember = false
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await api.openConn({ sessionId: pane.sessionId, password, cols: entry.term.cols, rows: entry.term.rows })
      if (!findPane(paneId)) {
        api.closeConn(res.connId) // pane closed while connecting
        return
      }
      paneByConn.set(res.connId, paneId)
      quiet(res.connId, 2500)
      store.updatePane(paneId, { connId: res.connId, state: 'connected', isSsh: res.isSsh })
      // The pane may have been resized while connecting (split, tile, sidebar): those resizes
      // were dropped, so send the real size now or the shell wraps lines at the wrong width.
      fitPane(paneId)
      api.resize(res.connId, entry.term.cols, entry.term.rows)
      if (password !== undefined) {
        typedPasswords.set(key, password)
        const session = useStore.getState().sessions.find((s) => s.id === pane.sessionId)
        if (remember && session) {
          useStore.setState({ sessions: await api.saveSession({ ...session, secret: password }) })
          toast(`Password for ${session.name} saved in the database`)
        }
      }
      const s = useStore.getState()
      if (res.isSsh && s.settings?.sftpAutoOpen) s.set({ sidebarOpen: true, sidebarTab: 'sftp' })
      entry.term.focus()
      return
    } catch (err) {
      const msg = errorMessage(err)
      if (isAuthError(msg) && attempt < 3) {
        const wrong = password !== undefined || Boolean(useStore.getState().sessions.find((s) => s.id === pane.sessionId)?.hasSecret)
        typedPasswords.delete(key)
        const answer = await promptPassword({
          title: `Password for ${pane.title}`,
          hint: wrong ? 'The server rejected the password. Try again.' : undefined,
          remember: Boolean(pane.sessionId)
        })
        if (answer) {
          password = answer.password
          remember = answer.remember
          continue
        }
      }
      store.updatePane(paneId, { state: 'closed' })
      const friendly = isAuthError(msg) ? 'Authentication failed' : msg
      entry.term.write(`\x1b[31m${friendly}\x1b[0m\r\n\x1b[33m[Press R to retry]\x1b[0m\r\n`)
      return
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

async function runOn(connId: string, macro: Macro): Promise<void> {
  for (const step of macro.steps) {
    if (step.kind === 'send') {
      quiet(connId, 1000)
      api.write(connId, step.text)
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
  const results = await Promise.allSettled(targets.map((p) => runOn(p.connId!, macro)))
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
  if (failed.length) toast(`Macro "${macro.name}": ${errorMessage(failed[0].reason)}`, true)
}
