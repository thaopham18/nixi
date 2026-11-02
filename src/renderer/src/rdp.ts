import type { UserInteraction } from '@devolutions/iron-remote-desktop'
import { api, errorMessage } from './api'
import { splitDomainUser } from '@shared/parse'
import { findPane, promptLogin, useStore, type LoginAnswer } from './store'
import { forgetTypedPassword, keepLogin, typedLogin } from './login'

type RdpModule = typeof import('@devolutions/iron-remote-desktop-rdp')

// The RDP stack is ~6 MB of WASM: load it only when the first RDP tab opens.
let loading: Promise<RdpModule> | undefined
function loadRdp(): Promise<RdpModule> {
  loading ??= (async () => {
    const [rdp] = await Promise.all([
      import('@devolutions/iron-remote-desktop-rdp'),
      import('@devolutions/iron-remote-desktop') // registers <iron-remote-desktop>
    ])
    await rdp.init('WARN')
    return rdp
  })()
  return loading
}

// IronErrorKind: General, WrongPassword, LogonFailure, AccessDenied, RDCleanPath, ProxyConnect, NegotiationFailure
const AUTH_ERRORS = [1, 2, 3]
const friendly: Record<number, string> = {
  1: 'Wrong password.',
  2: 'Logon failed: check the username, password and domain.',
  3: 'Access denied: this account is not allowed to log on remotely.',
  4: 'Could not reach the RDP server (connection refused, timed out or certificate rejected).',
  5: 'Could not reach the RDP server.',
  6: 'The server refused the security protocol (it may require a different NLA/TLS setting).'
}

function describeError(err: unknown): { text: string; detail?: string; auth: boolean } {
  const e = err as { kind?: () => number; backtrace?: () => string }
  if (typeof e?.kind === 'function') {
    const kind = e.kind()
    const detail = typeof e.backtrace === 'function' ? e.backtrace().split('\n')[0] : undefined
    return { text: friendly[kind] ?? 'RDP error.', detail, auth: AUTH_ERRORS.includes(kind) }
  }
  return { text: errorMessage(err), auth: false }
}

/**
 * One embedded RDP connection per pane. It lives outside React so the session survives
 * when its pane is moved between tabs or splits; it ends only via disposeRdp().
 */
interface RdpConn {
  el?: HTMLElement
  ui?: UserInteraction
  /** bumped on every (re)connect; stale async work checks it and bails out */
  gen: number
  /** why the last login was rejected: ask again instead of reusing the saved one */
  rejected?: string
  /** username typed in the dialog, shown again if the server rejects the login */
  account?: string
  /** rejected logins in a row, so a wrong saved one doesn't loop forever */
  attempts: number
  host?: HTMLElement
  lastSize?: string
}

const conns = new Map<string, RdpConn>()

function setError(paneId: string, error?: { text: string; detail?: string }): void {
  useStore.setState((s) => {
    const paneErrors = { ...s.paneErrors }
    if (error) paneErrors[paneId] = error
    else delete paneErrors[paneId]
    return { paneErrors }
  })
}

function shutdown(c: RdpConn): void {
  try {
    c.ui?.shutdown()
  } catch {
    /* already closed */
  }
  c.ui = undefined
  c.el?.remove()
  c.el = undefined
}

async function connect(paneId: string, c: RdpConn): Promise<void> {
  const gen = ++c.gen
  const stale = (): boolean => c.gen !== gen || !conns.has(paneId)
  const pane = findPane(paneId)
  if (!pane?.sessionId) return
  const sessionId = pane.sessionId
  const update = (p: { state: 'connecting' | 'connected' | 'closed' }): void => useStore.getState().updatePane(paneId, p)
  shutdown(c)
  setError(paneId)
  update({ state: 'connecting' })
  try {
    const rdp = await loadRdp()
    if (stale()) return
    const el = document.createElement('iron-remote-desktop')
    el.setAttribute('scale', 'fit')
    el.setAttribute('flexcenter', 'true')
    el.setAttribute('verbose', 'false')
    ;(el as unknown as { module: unknown }).module = rdp.Backend
    const ready = new Promise<UserInteraction>((resolve) =>
      el.addEventListener('ready', (e) => resolve((e as CustomEvent).detail.irgUserInteraction), { once: true })
    )
    c.el = el
    c.host?.appendChild(el)
    const ui = await ready
    if (stale()) return
    c.ui = ui

    const launch = await api.prepareRdp(sessionId)
    const remembered = typedLogin(sessionId)
    const savedAccount = remembered.username ?? (launch.domain && launch.username ? `${launch.domain}\\${launch.username}` : launch.username)
    let account = c.account ?? savedAccount
    let password = c.rejected ? undefined : (remembered.password ?? launch.password)
    let typed: LoginAnswer | undefined
    if (!account || !password) {
      const asksUser = !account || Boolean(c.rejected)
      const answer = await promptLogin({
        title: `${asksUser ? 'Login' : 'Password'} for ${pane.title}`,
        hint: c.rejected,
        username: asksUser ? account : undefined,
        askPassword: !password
      })
      if (!answer) throw new Error('Cancelled')
      if (stale()) return
      typed = { ...answer, username: answer.username === savedAccount ? undefined : answer.username }
      account = answer.username ?? account
      c.account = account
      password = answer.password ?? password
    }
    // The ticket lasts a minute, and the dialog above can take longer than that.
    const { proxyAddress, authToken } = typed ? await api.prepareRdp(sessionId) : launch
    if (stale()) return
    const { username, domain } = splitDomainUser(account, launch.domain)
    const box = c.host?.getBoundingClientRect()
    const desktopSize = {
      width: launch.width || Math.max(640, Math.floor(box?.width ?? 1280)),
      height: launch.height || Math.max(480, Math.floor(box?.height ?? 800))
    }
    c.lastSize = `${desktopSize.width}x${desktopSize.height}`
    const config = ui
      .configBuilder()
      .withUsername(username)
      .withPassword(password ?? '')
      .withDestination(launch.destination)
      .withServerDomain(domain)
      .withProxyAddress(proxyAddress)
      .withAuthToken(authToken)
      .withDesktopSize(desktopSize)
      .withExtension(rdp.displayControl(true))
      .build()
    ui.setEnableClipboard(true)
    ui.setEnableAutoClipboard(true)
    ui.onWarningCallback((w) => console.warn('[rdp]', w))
    const info = await ui.connect(config)
    if (stale()) return
    c.rejected = undefined
    c.attempts = 0
    ui.setVisibility(true)
    update({ state: 'connected' })
    if (typed) void keepLogin(sessionId, typed)
    const end = await info.run()
    if (stale()) return
    update({ state: 'closed' })
    setError(paneId, { text: `Session ended: ${end.reason()}` })
  } catch (err) {
    if (stale()) return
    const d = describeError(err)
    if (d.auth) {
      c.rejected = d.text
      forgetTypedPassword(sessionId)
      if (c.attempts++ < 3) return void connect(paneId, c)
    }
    update({ state: 'closed' })
    setError(paneId, d)
  }
}

/** Show the pane's RDP session inside `host`, connecting on first use. */
export function attachRdp(paneId: string, host: HTMLElement): void {
  let c = conns.get(paneId)
  if (!c) {
    c = { gen: 0, attempts: 0, host }
    conns.set(paneId, c)
    void connect(paneId, c)
    return
  }
  c.host = host
  if (c.el && c.el.parentElement !== host) host.appendChild(c.el)
}

export function reconnectRdp(paneId: string): void {
  const c = conns.get(paneId)
  if (!c) return
  c.attempts = 0
  void connect(paneId, c)
}

export function disposeRdp(paneId: string): void {
  const c = conns.get(paneId)
  if (!c) return
  c.gen++
  shutdown(c)
  conns.delete(paneId)
  setError(paneId)
}

export function rdpUi(paneId: string): UserInteraction | undefined {
  return conns.get(paneId)?.ui
}

/** Follow the pane size with dynamic resolution (only when the size really changed). */
export function resizeRdp(paneId: string, width: number, height: number): void {
  const c = conns.get(paneId)
  const size = `${Math.floor(width)}x${Math.floor(height)}`
  if (!c?.ui || c.lastSize === size || findPane(paneId)?.state !== 'connected') return
  c.lastSize = size
  c.ui.resize(Math.floor(width), Math.floor(height))
}
