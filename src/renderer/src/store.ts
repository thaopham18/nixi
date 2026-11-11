import type { AiChat } from './ai'
import { create } from 'zustand'
import type { ServerStats } from '@shared/stats'
import type { ConnState, Credential, Macro, Session, Settings, Transfer, Tunnel, TunnelStatus } from '@shared/types'
import { uid } from './api'

export interface Pane {
  id: string
  /** terminal (default), embedded RDP or VNC */
  kind?: 'term' | 'rdp' | 'vnc'
  /** what to (re)connect to */
  sessionId?: string
  connId?: string
  state: ConnState | 'idle'
  isSsh: boolean
  title: string
  /** remote folder, from OSC 7 or the prompt; may start with ~ */
  cwd?: string
  /** whose ~ that is, when it came from a prompt */
  cwdUser?: string
  /** relative size in a side-by-side / stacked split (flex-grow) */
  size?: number
}

/** row = side by side, column = stacked, grid = tiled */
export type Layout = 'row' | 'column' | 'grid'

export interface Tab {
  id: string
  title: string
  color?: string
  panes: Pane[]
  direction: Layout
  activePaneId: string
  /** pinned tabs stay at the left, compact, and survive "close others / left / right / all" */
  pinned?: boolean
}

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

export interface PromptRequest {
  title: string
  label?: string
  value?: string
  password?: boolean
  /** optional checkbox under the field, e.g. "Save password" */
  checkbox?: string
  /** small text under the title, e.g. "Wrong password, try again" */
  hint?: string
  /** also ask for a username, in a required field above the main one (starts with this text) */
  username?: string
  /** offer the saved credentials: picking one fills the fields */
  credentials?: boolean
  /** also offer key credentials (SSH): picking one logs in with its key, nothing to type */
  keys?: boolean
  resolve: (v: string | null, checked: boolean, username?: string, credentialId?: string) => void
}

export interface PasteReview {
  text: string
  /** where it goes */
  target: string
  /** the program takes a paste as one block, so its lines don't run by themselves */
  asBlock: boolean
  resolve: (text: string | null) => void
}

export interface ChoiceRequest {
  /** a new one gets a fresh dialog, with the focus on its first button */
  id?: number
  title: string
  message: string
  /** items listed under the message */
  items?: string[]
  buttons: { label: string; value: string; primary?: boolean; danger?: boolean }[]
  resolve: (value: string | null) => void
}

type Modal = 'session' | 'settings' | 'tunnels' | 'macros' | 'credentials' | null

export type SettingsPage = 'terminal' | 'keyboard' | 'connections' | 'safety' | 'ai' | 'macros' | 'sftp' | 'database'

interface State {
  settings?: Settings
  sessions: Session[]
  credentials: Credential[]
  /** folders that exist without sessions too (see buildTree) */
  folders: string[]
  /** closed folders of the session tree; kept here so switching to the SFTP tab doesn't reset them */
  collapsedFolders: Record<string, boolean>
  macros: Macro[]
  tunnels: Tunnel[]
  tunnelStatus: Record<string, TunnelStatus>
  transfers: Record<string, Transfer>

  tabs: Tab[]
  activeTabId?: string
  sidebarOpen: boolean
  sidebarTab: 'sessions' | 'sftp' | 'ai'
  /** AI conversations by pane; gone with the pane, or with a lock */
  aiChats: Record<string, AiChat>
  /** SFTP panel follows the terminal's folder */
  sftpFollow: boolean
  /** open Settings with this field in view */
  /** where Settings should open, for a button that sends the user there */
  settingsFocus?: { page: SettingsPage; field?: string }
  modal: Modal
  editingSession?: Partial<Session>
  multiExec: boolean
  /** panes excluded from multi-exec */
  multiExecExcluded: Record<string, boolean>
  recordingMacro: boolean
  searchOpen: boolean
  contextMenu?: { x: number; y: number; items: MenuItem[] }
  /** quick macro list opened at the terminal cursor (x/y = bottom-left of the cursor cell), or under a focused text field */
  /** `asksSecret`: the terminal waits for a password, so saved ones are offered first */
  macroPicker?: { paneId?: string; field?: HTMLInputElement | HTMLTextAreaElement; x: number; y: number; lineHeight: number; asksSecret?: boolean }
  prompt?: PromptRequest
  choice?: ChoiceRequest
  pasteReview?: PasteReview
  toast?: { text: string; error?: boolean }
  report?: { title: string; lines: string[] }
  /** tab or session being dragged, so tab views can offer split drop zones */
  dragging?: { kind: 'tab' | 'session'; id: string; /** every session in the drag, when several are selected */ ids?: string[] }
  /** why an RDP/VNC pane is not showing a session */
  paneErrors: Record<string, { text: string; detail?: string; retrying?: boolean }>
  /** latest resource stats per SSH connection; null = not available on that server */
  serverStats: Record<string, ServerStats | null>
  /** tabs (not the open one) whose terminals printed something since they were last open */
  activity: Record<string, true>

  set: (p: Partial<State>) => void
  addTab: (pane: Omit<Pane, 'id' | 'state'>, color?: string) => Tab
  closeTab: (tabId: string) => void
  updatePane: (paneId: string, p: Partial<Pane>) => void
  removePane: (paneId: string) => void
  splitActive: (direction: Layout) => Pane | undefined
  /** move all panes of `srcTabId` into `dstTabId` (split view) */
  mergeTab: (srcTabId: string, dstTabId: string, direction?: Layout, prepend?: boolean) => void
  /** add a new pane to a tab (opens a session as a split) */
  addPane: (tabId: string, pane: Omit<Pane, 'id' | 'state'>, direction?: Layout, prepend?: boolean) => void
  /** move a pane out of its split into a tab of its own */
  detachPane: (paneId: string) => void
  setLayout: (tabId: string, direction: Layout) => void
  resizePanes: (tabId: string, sizes: Record<string, number>) => void
}

/** Layout after adding panes: keep the user's choice for two panes, tile from three on. */
function layoutFor(count: number, current: Layout, requested?: Layout): Layout {
  if (requested) return requested
  return count > 2 ? 'grid' : current
}

export const useStore = create<State>((set, get) => ({
  sessions: [],
  credentials: [],
  folders: [],
  collapsedFolders: {},
  macros: [],
  tunnels: [],
  tunnelStatus: {},
  transfers: {},
  tabs: [],
  sidebarOpen: true,
  sidebarTab: 'sessions',
  aiChats: {},
  sftpFollow: false,
  modal: null,
  multiExec: false,
  multiExecExcluded: {},
  recordingMacro: false,
  searchOpen: false,
  paneErrors: {},
  serverStats: {},
  activity: {},

  set: (p) => set(p),

  addTab: (pane, color) => {
    const p: Pane = { ...pane, id: uid(), state: 'idle' }
    const tab: Tab = { id: uid(), title: pane.title, color, panes: [p], direction: 'row', activePaneId: p.id }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
    return tab
  },

  closeTab: (tabId) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId =
        s.activeTabId === tabId ? tabs[Math.min(idx, tabs.length - 1)]?.id : s.activeTabId
      return { tabs, activeTabId }
    }),

  updatePane: (paneId, p) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.panes.some((x) => x.id === paneId)
          ? { ...t, panes: t.panes.map((x) => (x.id === paneId ? { ...x, ...p } : x)) }
          : t
      )
    })),

  removePane: (paneId) => {
    const tab = get().tabs.find((t) => t.panes.some((p) => p.id === paneId))
    if (!tab) return
    if (tab.panes.length === 1) return get().closeTab(tab.id)
    const panes = tab.panes.filter((p) => p.id !== paneId)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id
          ? { ...t, panes, activePaneId: t.activePaneId === paneId ? panes[panes.length - 1].id : t.activePaneId }
          : t
      )
    }))
  },

  splitActive: (direction) => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId)
    if (!tab) return
    const src = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0]
    const pane: Pane = {
      id: uid(),
      kind: src.kind,
      sessionId: src.sessionId,
      state: 'idle',
      isSsh: src.isSsh,
      title: src.title
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id ? { ...t, direction, panes: [...t.panes, pane], activePaneId: pane.id } : t
      )
    }))
    return pane
  },

  mergeTab: (srcTabId, dstTabId, direction, prepend) => {
    if (srcTabId === dstTabId) return
    const src = get().tabs.find((t) => t.id === srcTabId)
    if (!src) return
    set((s) => ({
      tabs: s.tabs
        .filter((t) => t.id !== srcTabId)
        .map((t) => {
          if (t.id !== dstTabId) return t
          const panes = (prepend ? [...src.panes, ...t.panes] : [...t.panes, ...src.panes]).map((p) => ({ ...p, size: undefined }))
          return {
            ...t,
            panes,
            direction: layoutFor(panes.length, t.direction, direction),
            activePaneId: src.activePaneId
          }
        }),
      activeTabId: dstTabId
    }))
  },

  addPane: (tabId, pane, direction, prepend) => {
    const p: Pane = { ...pane, id: uid(), state: 'idle' }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              panes: (prepend ? [p, ...t.panes] : [...t.panes, p]).map((x) => ({ ...x, size: undefined })),
              direction: layoutFor(t.panes.length + 1, t.direction, direction),
              activePaneId: p.id
            }
          : t
      ),
      activeTabId: tabId
    }))
  },

  detachPane: (paneId) => {
    const tab = get().tabs.find((t) => t.panes.some((p) => p.id === paneId))
    if (!tab || tab.panes.length < 2) return
    const pane = tab.panes.find((p) => p.id === paneId)!
    const rest = tab.panes.filter((p) => p.id !== paneId)
    const created: Tab = { id: uid(), title: pane.title, panes: [{ ...pane, size: undefined }], direction: 'row', activePaneId: pane.id }
    set((s) => ({
      tabs: s.tabs.flatMap((t) =>
        t.id === tab.id
          ? [{ ...t, panes: rest, activePaneId: t.activePaneId === paneId ? rest[0].id : t.activePaneId }, created]
          : [t]
      ),
      activeTabId: created.id
    }))
  },

  setLayout: (tabId, direction) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, direction, panes: t.panes.map((p) => ({ ...p, size: undefined })) } : t))
    })),

  resizePanes: (tabId, sizes) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, panes: t.panes.map((p) => (p.id in sizes ? { ...p, size: sizes[p.id] } : p)) } : t
      )
    }))
}))

export function activeTab(): Tab | undefined {
  const s = useStore.getState()
  return s.tabs.find((t) => t.id === s.activeTabId)
}

/** Active pane of a state snapshot (usable inside a useStore selector). */
export function activePaneOf(s: { tabs: Tab[]; activeTabId?: string }): Pane | undefined {
  const t = s.tabs.find((x) => x.id === s.activeTabId)
  return t?.panes.find((p) => p.id === t.activePaneId)
}

export function activePane(): Pane | undefined {
  return activePaneOf(useStore.getState())
}

export function findPane(paneId: string): Pane | undefined {
  for (const t of useStore.getState().tabs) {
    const p = t.panes.find((x) => x.id === paneId)
    if (p) return p
  }
  return undefined
}

export function allPanes(): Pane[] {
  return useStore.getState().tabs.flatMap((t) => t.panes)
}

export function toast(text: string, error = false): void {
  useStore.setState({ toast: { text, error } })
  setTimeout(() => {
    if (useStore.getState().toast?.text === text) useStore.setState({ toast: undefined })
  }, error ? 6000 : 3000)
}

// Prompts are shown one at a time: several panes connecting at once each wait their turn
// instead of replacing each other's dialog.
let promptQueue: Promise<unknown> = Promise.resolve()

interface PromptAnswer {
  value: string | null
  checked: boolean
  username?: string
  credentialId?: string
}

function ask(opts: Omit<PromptRequest, 'resolve'>): Promise<PromptAnswer> {
  const next = promptQueue.then(
    () => new Promise<PromptAnswer>((resolve) =>
      useStore.setState({ prompt: { ...opts, resolve: (value, checked, username, credentialId) => resolve({ value, checked, username, credentialId }) } })
    )
  )
  promptQueue = next.catch(() => undefined)
  return next
}

export async function promptText(opts: Omit<PromptRequest, 'resolve' | 'checkbox'>): Promise<string | null> {
  return (await ask(opts)).value
}

export interface LoginAnswer {
  username?: string
  password?: string
  /** the user ticked Save: store it once the server has accepted it */
  remember: boolean
  /** filled from this saved credential; with `remember`, the session keeps using it */
  credentialId?: string
}

/**
 * One dialog for a whole login. `username` undefined = already known, don't ask;
 * `askPassword` false = only the username is missing.
 */
export async function promptLogin(opts: {
  title: string
  hint?: string
  username?: string
  askPassword?: boolean
  secretName?: string
  /** SSH: key credentials work here too, and a credential can stand in for a missing username */
  ssh?: boolean
}): Promise<LoginAnswer | null> {
  const asksSecret = opts.askPassword !== false
  const secret = opts.secretName ?? 'Password'
  const saved = [opts.username !== undefined && 'username', asksSecret && secret.toLowerCase()].filter(Boolean).join(' and ')
  const res = await ask({
    title: opts.title,
    label: asksSecret ? secret : undefined,
    hint: opts.hint,
    password: asksSecret,
    username: opts.username,
    // A passphrase belongs to the session's own key, so no credential stands in for it.
    credentials: secret === 'Password' && (asksSecret || Boolean(opts.ssh)),
    keys: opts.ssh,
    checkbox: `Save ${saved} (in the encrypted database)`
  })
  if (res.value === null) return null
  const kind = useStore.getState().credentials.find((c) => c.id === res.credentialId)?.kind
  // A key credential has nothing typed: its passphrase, if any, stays in main.
  const password = asksSecret && kind !== 'key' ? res.value : undefined
  return { username: res.username, password, remember: res.checked, credentialId: res.credentialId }
}

const waitingChoices: ChoiceRequest[] = []
let choiceCount = 0

/** One at a time: two servers can ask about their host keys at once, and neither may lose its answer. */
export function askChoice(opts: Omit<ChoiceRequest, 'resolve' | 'id'>): Promise<string | null> {
  return new Promise((resolve) => {
    const request = { ...opts, resolve, id: ++choiceCount }
    if (useStore.getState().choice) waitingChoices.push(request)
    else useStore.setState({ choice: request })
  })
}

export function answerChoice(value: string | null): void {
  const { choice } = useStore.getState()
  useStore.setState({ choice: waitingChoices.shift() })
  choice?.resolve(value)
}

/** Yes or no about something hard to take back. The focus starts on Cancel unless `safe`. */
export async function confirmAction(title: string, message: string, action: string, safe = true): Promise<boolean> {
  const answer = await askChoice({
    title,
    message,
    buttons: [
      { label: 'Cancel', value: 'cancel', primary: !safe },
      { label: action, value: 'yes', primary: safe, danger: !safe }
    ]
  })
  return answer === 'yes'
}

export function confirmDelete(title: string, message: string): Promise<boolean> {
  return confirmAction(title, message, 'Delete', false)
}

/** The text to paste after the user looked it over, or null if they called it off. */
export function askPaste(opts: Omit<PasteReview, 'resolve'>): Promise<string | null> {
  useStore.getState().pasteReview?.resolve(null)
  return new Promise((resolve) => useStore.setState({ pasteReview: { ...opts, resolve } }))
}

export function showMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]): void {
  e.preventDefault()
  useStore.setState({ contextMenu: { x: e.clientX, y: e.clientY, items } })
}

/** Opens Settings on the page that holds what needs setting up, on that field if one is named. */
export function openSettings(page: SettingsPage, field?: string): void {
  useStore.setState({ modal: 'settings', settingsFocus: { page, field } })
}
