import { create } from 'zustand'
import type { ServerStats } from '@shared/stats'
import type { ConnState, Macro, Session, Settings, Transfer, Tunnel, TunnelStatus } from '@shared/types'
import { uid } from './api'

export interface Pane {
  id: string
  /** terminal (default) or embedded RDP */
  kind?: 'term' | 'rdp'
  /** what to (re)connect to */
  sessionId?: string
  connId?: string
  state: ConnState | 'idle'
  isSsh: boolean
  title: string
  /** remote cwd reported via OSC 7 */
  cwd?: string
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
  resolve: (v: string | null, checked: boolean) => void
}

export interface ChoiceRequest {
  title: string
  message: string
  /** items listed under the message */
  items?: string[]
  buttons: { label: string; value: string; primary?: boolean }[]
  resolve: (value: string | null) => void
}

type Modal = 'session' | 'settings' | 'tunnels' | 'macros' | null

interface State {
  settings?: Settings
  sessions: Session[]
  /** folders that exist without sessions too (see buildTree) */
  folders: string[]
  macros: Macro[]
  tunnels: Tunnel[]
  tunnelStatus: Record<string, TunnelStatus>
  transfers: Record<string, Transfer>

  tabs: Tab[]
  activeTabId?: string
  sidebarOpen: boolean
  sidebarTab: 'sessions' | 'sftp'
  modal: Modal
  editingSession?: Partial<Session>
  multiExec: boolean
  /** panes excluded from multi-exec */
  multiExecExcluded: Record<string, boolean>
  recordingMacro: boolean
  searchOpen: boolean
  contextMenu?: { x: number; y: number; items: MenuItem[] }
  /** quick macro list opened at the terminal cursor (x/y = bottom-left of the cursor cell), or under a focused text field */
  macroPicker?: { paneId?: string; field?: HTMLInputElement | HTMLTextAreaElement; x: number; y: number; lineHeight: number }
  prompt?: PromptRequest
  choice?: ChoiceRequest
  toast?: { text: string; error?: boolean }
  report?: { title: string; lines: string[] }
  /** tab or session being dragged, so tab views can offer split drop zones */
  dragging?: { kind: 'tab' | 'session'; id: string }
  rdpErrors: Record<string, { text: string; detail?: string }>
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
  folders: [],
  macros: [],
  tunnels: [],
  tunnelStatus: {},
  transfers: {},
  tabs: [],
  sidebarOpen: true,
  sidebarTab: 'sessions',
  modal: null,
  multiExec: false,
  multiExecExcluded: {},
  recordingMacro: false,
  searchOpen: false,
  rdpErrors: {},
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

function ask(opts: Omit<PromptRequest, 'resolve'>): Promise<{ value: string | null; checked: boolean }> {
  const next = promptQueue.then(
    () => new Promise<{ value: string | null; checked: boolean }>((resolve) =>
      useStore.setState({ prompt: { ...opts, resolve: (value, checked) => resolve({ value, checked }) } })
    )
  )
  promptQueue = next.catch(() => undefined)
  return next
}

export async function promptText(opts: Omit<PromptRequest, 'resolve' | 'checkbox'>): Promise<string | null> {
  return (await ask(opts)).value
}

export async function promptPassword(opts: {
  title: string
  label?: string
  hint?: string
  remember?: boolean
}): Promise<{ password: string; remember: boolean } | null> {
  const res = await ask({
    title: opts.title,
    label: opts.label ?? 'Password',
    hint: opts.hint,
    password: true,
    checkbox: opts.remember ? 'Save password (in the encrypted database)' : undefined
  })
  return res.value === null ? null : { password: res.value, remember: res.checked }
}

/** A small dialog with several buttons; resolves to the button's value, null on Esc / close. */
export function askChoice(opts: Omit<ChoiceRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => useStore.setState({ choice: { ...opts, resolve } }))
}

export function showMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]): void {
  e.preventDefault()
  useStore.setState({ contextMenu: { x: e.clientX, y: e.clientY, items } })
}
