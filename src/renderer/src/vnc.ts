import type RFB from '@novnc/novnc'
import type { VncCredentials } from '@novnc/novnc'
import type { Session } from '@shared/types'
import { VNC_PROXY_ERROR } from '@shared/vnc'
import { api, errorMessage } from './api'
import { findPane, promptLogin, useStore, type LoginAnswer } from './store'
import { forgetTypedPassword, keepLogin, typedLogin } from './login'

export type VncScale = NonNullable<Session['vncScale']>
export type VncQuality = NonNullable<Session['vncQuality']>
export interface VncView {
  scale: VncScale
  quality: VncQuality
  viewOnly: boolean
}

// noVNC's levels: JPEG quality 0–9, zlib effort 0–9 (balanced is its default).
const QUALITY: Record<VncQuality, { quality: number; compression: number }> = {
  smooth: { quality: 3, compression: 1 },
  balanced: { quality: 6, compression: 2 },
  sharp: { quality: 9, compression: 2 }
}

/**
 * One VNC connection per pane. Like RDP it lives outside React (the RFB screen is inside `el`,
 * which gets moved between panes), so moving a pane does not drop the session.
 */
interface VncConn extends VncView {
  rfb?: RFB
  el?: HTMLElement
  host: HTMLElement
  /** bumped on every (re)connect; stale events and async work check it and bail out */
  gen: number
  /** after a rejected password, ask again instead of reusing the saved one */
  askPassword: boolean
  attempts: number
  failure?: { text: string; auth: boolean }
  /** username typed in the dialog, shown again if the server rejects the login */
  account?: string
  /** clipboard text last exchanged with the server, so it isn't sent back */
  clip?: string
  stopClipboard?: () => void
}

const conns = new Map<string, VncConn>()

function setError(paneId: string, error?: { text: string }): void {
  useStore.setState((s) => {
    const paneErrors = { ...s.paneErrors }
    if (error) paneErrors[paneId] = error
    else delete paneErrors[paneId]
    return { paneErrors }
  })
}

function applyView(c: VncConn): void {
  if (!c.rfb) return
  c.rfb.viewOnly = c.viewOnly
  // 'remote' still scales down when the server can't change its resolution.
  c.rfb.scaleViewport = c.scale !== 'actual'
  c.rfb.resizeSession = c.scale === 'remote'
  c.rfb.qualityLevel = QUALITY[c.quality].quality
  c.rfb.compressionLevel = QUALITY[c.quality].compression
}

function shutdown(c: VncConn): void {
  c.stopClipboard?.()
  c.stopClipboard = undefined
  try {
    c.rfb?.disconnect()
  } catch {
    /* already closed */
  }
  c.rfb = undefined
  c.el?.remove()
  c.el = undefined
}

/**
 * noVNC asks for the next frame only after receiving the last one, so a link with a long round
 * trip caps the frame rate at 1/RTT even when the server has plenty to send. A couple of extra
 * requests stay in flight for the whole session, because noVNC answers each update with one new
 * request. A server that merges them just falls back to one at a time. Servers with continuous
 * updates (TigerVNC) don't use requests at all, so they are left alone.
 */
const EXTRA_FRAME_REQUESTS = 2
function pipelineRequests(rfb: RFB, RFBClass: typeof RFB, stale: () => boolean): void {
  setTimeout(() => {
    const internals = rfb as unknown as { _sock: unknown; _fbWidth: number; _fbHeight: number; _enabledContinuousUpdates: boolean }
    if (stale() || internals._enabledContinuousUpdates) return
    for (let i = 0; i < EXTRA_FRAME_REQUESTS; i++) {
      RFBClass.messages.fbUpdateRequest(internals._sock, true, 0, 0, internals._fbWidth, internals._fbHeight)
    }
  }, 1000)
}

/** Local → server: VNC has no "paste" request, so the text must be there before the user pastes. */
function watchClipboard(c: VncConn, rfb: RFB, el: HTMLElement, sessionId: string): () => void {
  const sync = (): void => {
    if (!el.contains(document.activeElement)) return
    if (useStore.getState().sessions.find((s) => s.id === sessionId)?.vncSendClipboard === false) return
    void api.readClipboard().then((text) => {
      if (text && text !== c.clip && c.rfb === rfb) {
        c.clip = text
        rfb.clipboardPasteFrom(text)
      }
    })
  }
  el.addEventListener('focusin', sync)
  window.addEventListener('focus', sync)
  return () => {
    el.removeEventListener('focusin', sync)
    window.removeEventListener('focus', sync)
  }
}

async function connect(paneId: string, c: VncConn): Promise<void> {
  const gen = ++c.gen
  const stale = (): boolean => c.gen !== gen || !conns.has(paneId)
  const pane = findPane(paneId)
  if (!pane?.sessionId) return
  const sessionId = pane.sessionId
  const update = (p: { state: 'connecting' | 'connected' | 'closed' }): void => useStore.getState().updatePane(paneId, p)
  shutdown(c)
  setError(paneId)
  update({ state: 'connecting' })
  c.failure = undefined
  try {
    const [{ default: RFBClass }, launch] = await Promise.all([import('@novnc/novnc'), api.prepareVnc(sessionId)])
    if (stale()) return
    const el = document.createElement('div')
    el.className = 'vnc-display'
    c.el = el
    c.host.appendChild(el)
    const rfb = new RFBClass(el, launch.url, { shared: true })
    rfb.background = '#000'
    // A pointer that answers at once even when the server draws its own into the picture,
    // which would otherwise lag by a whole round trip.
    rfb.showDotCursor = true
    c.rfb = rfb
    applyView(c)

    let typed: LoginAnswer | undefined
    let wasConnected = false

    // noVNC fires this again whenever more data arrives while it waits: only one dialog at a time.
    let asking = false
    rfb.addEventListener('credentialsrequired', (e) => {
      const types = (e as CustomEvent<{ types: string[] }>).detail.types
      if (asking) return
      asking = true
      void (async () => {
        const creds: VncCredentials = { target: '' }
        const remembered = typedLogin(sessionId)
        const wantsUser = types.includes('username')
        const wantsPassword = types.includes('password')
        const savedAccount = remembered.username ?? launch.username ?? ''
        const account = c.account ?? savedAccount
        const known = c.askPassword ? undefined : (typed?.password ?? remembered.password ?? launch.password)
        // After a rejection the username may be what's wrong, so it can be fixed in the same dialog.
        const asksUser = wantsUser && (!account || c.askPassword)
        const asksPassword = wantsPassword && known === undefined
        let answer: LoginAnswer | undefined
        if (asksUser || asksPassword) {
          const asked = await promptLogin({
            title: `${asksUser ? 'Login' : 'Password'} for ${pane.title}`,
            hint: c.askPassword ? 'The server rejected the login. Try again.' : asksUser ? 'This server asks for an account, e.g. the Mac or Windows login.' : undefined,
            username: asksUser ? account : undefined,
            askPassword: asksPassword
          })
          if (!asked) return cancel()
          answer = asked
          c.account = asked.username ?? c.account
          typed = {
            username: asked.username === undefined || asked.username === savedAccount ? typed?.username : asked.username,
            password: asked.password ?? typed?.password,
            remember: asked.remember || Boolean(typed?.remember)
          }
        }
        if (wantsUser) creds.username = answer?.username ?? account
        if (wantsPassword) creds.password = answer?.password ?? known
        asking = false
        if (!stale()) rfb.sendCredentials(creds)
      })()
    })
    const cancel = (): void => {
      c.failure = { text: 'Cancelled', auth: false }
      if (!stale()) rfb.disconnect()
    }

    rfb.addEventListener('securityfailure', (e) => {
      const reason = (e as CustomEvent<{ reason?: string }>).detail.reason
      if (reason?.startsWith(VNC_PROXY_ERROR)) c.failure = { text: reason.slice(VNC_PROXY_ERROR.length), auth: false }
      else if (reason && /too many|blacklist|locked/i.test(reason)) c.failure = { text: reason, auth: false }
      else c.failure = { text: reason || 'Authentication failed: check the username and password.', auth: true }
    })

    rfb.addEventListener('connect', () => {
      if (stale()) return
      wasConnected = true
      c.attempts = 0
      c.askPassword = false
      update({ state: 'connected' })
      c.stopClipboard = watchClipboard(c, rfb, el, sessionId)
      pipelineRequests(rfb, RFBClass, stale)
      if (typed) void keepLogin(sessionId, typed)
      if (findPane(paneId) && activeHere(paneId)) rfb.focus()
    })

    rfb.addEventListener('clipboard', (e) => {
      c.clip = (e as CustomEvent<{ text: string }>).detail.text
      api.writeClipboard(c.clip)
    })

    rfb.addEventListener('disconnect', (e) => {
      if (stale()) return
      const failure = c.failure
      if (failure?.auth && c.attempts < 3) {
        c.attempts++
        c.askPassword = true
        forgetTypedPassword(sessionId)
        void connect(paneId, c)
        return
      }
      const clean = (e as CustomEvent<{ clean: boolean }>).detail.clean
      update({ state: 'closed' })
      setError(paneId, {
        text: failure?.text ?? (wasConnected ? (clean ? 'The server ended the session.' : 'The connection was lost.') : 'Could not connect to the VNC server.')
      })
    })
  } catch (err) {
    if (stale()) return
    update({ state: 'closed' })
    setError(paneId, { text: errorMessage(err) })
  }
}

function activeHere(paneId: string): boolean {
  const s = useStore.getState()
  return s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId === paneId
}

/** Show the pane's VNC session inside `host`, connecting on first use. */
export function attachVnc(paneId: string, host: HTMLElement, view: VncView): void {
  const known = conns.get(paneId)
  if (known) {
    known.host = host
    if (known.el && known.el.parentElement !== host) host.appendChild(known.el)
    return
  }
  const c: VncConn = { gen: 0, askPassword: false, attempts: 0, host, ...view }
  conns.set(paneId, c)
  void connect(paneId, c)
}

export function reconnectVnc(paneId: string): void {
  const c = conns.get(paneId)
  if (!c) return
  c.attempts = 0
  void connect(paneId, c)
}

export function disposeVnc(paneId: string): void {
  const c = conns.get(paneId)
  if (!c) return
  c.gen++
  shutdown(c)
  conns.delete(paneId)
  setError(paneId)
}

export function vncView(paneId: string): VncView | undefined {
  return conns.get(paneId)
}

export function setVncView(paneId: string, view: Partial<VncView>): void {
  const c = conns.get(paneId)
  if (!c) return
  Object.assign(c, view)
  applyView(c)
}

export function focusVnc(paneId: string): void {
  conns.get(paneId)?.rfb?.focus()
}

/** Send this computer's clipboard once, for sessions that don't do it automatically. */
export async function sendVncClipboard(paneId: string): Promise<void> {
  const c = conns.get(paneId)
  const text = await api.readClipboard()
  if (!c?.rfb || !text) return
  c.clip = text
  c.rfb.clipboardPasteFrom(text)
  c.rfb.focus()
}

// ---------------------------------------------------------------- live numbers ("Stats" button)

const ENCODINGS: Record<number, string> = { 0: 'Raw', 1: 'CopyRect', 2: 'RRE', 5: 'Hextile', 6: 'Zlib', 7: 'Tight', 16: 'ZRLE', 21: 'JPEG', 50: 'H.264', [-260]: 'TightPNG' }

interface Counters {
  frames: number
  bytes: number
  decodeMs: number
  encodings: Map<number, number>
  at: number
}
const counters = new WeakMap<RFB, Counters>()

/** Counts through noVNC's internals, installed only once someone asks for the numbers. */
function watchCounters(rfb: RFB): Counters {
  const known = counters.get(rfb)
  if (known) return known
  const n: Counters = { frames: 0, bytes: 0, decodeMs: 0, encodings: new Map(), at: performance.now() }
  counters.set(rfb, n)
  type Decoder = { decodeRect(...args: unknown[]): unknown }
  const r = rfb as unknown as {
    _decoders: Record<number, Decoder>
    _display: { flip(...args: unknown[]): void }
    _sock: { _websocket?: WebSocket }
  }
  for (const [enc, decoder] of Object.entries(r._decoders)) {
    const decode = decoder.decodeRect
    decoder.decodeRect = (...args) => {
      const start = performance.now()
      try {
        return decode.apply(decoder, args)
      } finally {
        n.decodeMs += performance.now() - start
        n.encodings.set(Number(enc), (n.encodings.get(Number(enc)) ?? 0) + 1)
      }
    }
  }
  const flip = r._display.flip
  r._display.flip = (...args) => {
    if (!args[0]) n.frames++ // fromQueue = the same frame finishing later
    flip.apply(r._display, args)
  }
  r._sock._websocket?.addEventListener('message', (e: MessageEvent<ArrayBuffer>) => {
    n.bytes += e.data.byteLength
  })
  return n
}

/** "1440×900 · 28 fps · 3.1 MB/s · decode 120 ms/s · ZRLE", over the time since the last call. */
export function vncStatsLine(paneId: string): string {
  const rfb = conns.get(paneId)?.rfb
  if (!rfb) return 'Not connected'
  const n = watchCounters(rfb)
  const now = performance.now()
  const secs = Math.max((now - n.at) / 1000, 0.001)
  const { _fbWidth: w, _fbHeight: h } = rfb as unknown as { _fbWidth: number; _fbHeight: number }
  const used = [...n.encodings].sort((a, b) => b[1] - a[1]).map(([e]) => ENCODINGS[e] ?? e)
  const line = [
    `${w}×${h}`,
    `${(n.frames / secs).toFixed(0)} fps`,
    `${(n.bytes / secs / 1e6).toFixed(1)} MB/s`,
    `decode ${(n.decodeMs / secs).toFixed(0)} ms/s`,
    used.join(', ') || 'no updates'
  ].join(' · ')
  Object.assign(n, { frames: 0, bytes: 0, decodeMs: 0, encodings: new Map(), at: now })
  return line
}

export function sendCtrlAltDel(paneId: string): void {
  conns.get(paneId)?.rfb?.sendCtrlAltDel()
}
