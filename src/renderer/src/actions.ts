import type { Session } from '@shared/types'
import { api, errorMessage } from './api'
import { activePane, promptText, toast, useStore, type Layout, type Pane } from './store'
import { copySelection, cursorPoint, disposeTerminal, focusedField, getEntry, pasteInto, connectPane, startRecording, stopRecording } from './terminals'
import { disposeRdp, reconnectRdp } from './rdp'
import { uid } from './api'

function paneFor(session: Session): Omit<Pane, 'id' | 'state'> {
  return {
    sessionId: session.id,
    kind: session.type === 'rdp' ? 'rdp' : 'term',
    isSsh: session.type === 'ssh',
    title: session.name
  }
}

export function openSession(session: Session): void {
  if (session.type === 'rdp' && session.rdpClient === 'native') return openRdpExternal(session)
  useStore.getState().addTab(paneFor(session), session.color)
}

/** Open a session as a new split inside a tab (the active one by default). */
export function openSessionInSplit(
  session: Session,
  tabId = useStore.getState().activeTabId,
  layout?: Layout,
  prepend = false
): void {
  if (!tabId || (session.type === 'rdp' && session.rdpClient === 'native')) return openSession(session)
  useStore.getState().addPane(tabId, paneFor(session), layout, prepend)
}

/** Put every open tab into one tiled view, to watch them all at once. */
export function tileAllTabs(): void {
  const { tabs, activeTabId, mergeTab } = useStore.getState()
  const target = activeTabId ?? tabs[0]?.id
  if (!target) return
  for (const t of tabs) if (t.id !== target) mergeTab(t.id, target, 'grid')
  useStore.getState().setLayout(target, 'grid')
}

/** Undo tiling: every pane of the tab gets its own tab again. */
export function untileTab(tabId: string): void {
  const tab = useStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab) return
  for (const p of tab.panes.slice(1)) useStore.getState().detachPane(p.id)
  useStore.setState({ activeTabId: tabId })
}

function disposePane(paneId: string): void {
  disposeTerminal(paneId)
  disposeRdp(paneId)
}

export function openRdpExternal(session: Session): void {
  api.openRdpExternal(session.id).catch((e) => toast(errorMessage(e), true))
}

export function openLocal(): void {
  useStore.getState().addTab({ isSsh: false, title: 'Local shell' })
}

export function closePane(paneId: string): void {
  disposePane(paneId)
  useStore.getState().removePane(paneId)
}

export function closeActiveTab(): void {
  const pane = activePane()
  if (pane) closePane(pane.id)
}

export function closeTab(tabId: string): void {
  const tab = useStore.getState().tabs.find((t) => t.id === tabId)
  tab?.panes.forEach((p) => disposePane(p.id))
  useStore.getState().closeTab(tabId)
}

/** Close tabs relative to `tabId`; pinned tabs are kept (close them one by one). */
export function closeTabsAround(tabId: string, which: 'others' | 'left' | 'right' | 'all'): void {
  const { tabs } = useStore.getState()
  const at = tabs.findIndex((t) => t.id === tabId)
  tabs
    .filter((t, i) => !t.pinned && (which === 'all' || (which === 'others' ? i !== at : which === 'left' ? i < at : i > at)))
    .forEach((t) => closeTab(t.id))
  if (which !== 'all' && useStore.getState().tabs.some((t) => t.id === tabId)) useStore.setState({ activeTabId: tabId })
}

/** Pin / unpin; pinned tabs are kept in front of the others. */
export function togglePin(tabId: string): void {
  useStore.setState((s) => {
    const tabs = s.tabs.map((t) => (t.id === tabId ? { ...t, pinned: !t.pinned } : t))
    return { tabs: [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)] }
  })
}

/**
 * Open the same tab again with fresh connections: same name, color, panes and layout.
 * Defaults to the active tab.
 */
export function duplicateTab(tabId = useStore.getState().activeTabId): void {
  const src = useStore.getState().tabs.find((t) => t.id === tabId)
  if (!src) return
  const panes: Pane[] = src.panes.map((p) => ({
    id: uid(),
    kind: p.kind,
    sessionId: p.sessionId,
    isSsh: p.isSsh,
    title: p.title,
    size: p.size,
    state: 'idle'
  }))
  const activeIndex = Math.max(0, src.panes.findIndex((p) => p.id === src.activePaneId))
  const copy = { ...src, id: uid(), panes, activePaneId: panes[activeIndex].id }
  useStore.setState((s) => {
    const tabs = [...s.tabs]
    tabs.splice(tabs.findIndex((t) => t.id === src.id) + 1, 0, copy) // right next to the original
    return { tabs, activeTabId: copy.id }
  })
}

export function cycleTab(delta: number): void {
  const { tabs, activeTabId, set } = useStore.getState()
  if (!tabs.length) return
  const i = tabs.findIndex((t) => t.id === activeTabId)
  set({ activeTabId: tabs[(i + delta + tabs.length) % tabs.length].id })
}

export function changeFontSize(delta: number | 'reset'): void {
  const s = useStore.getState().settings
  if (!s) return
  const fontSize = delta === 'reset' ? 13 : Math.min(32, Math.max(8, s.fontSize + delta))
  api.setSettings({ ...s, fontSize }).then((settings) => useStore.setState({ settings }))
}

export function newSession(folder = ''): void {
  useStore.setState({
    modal: 'session',
    editingSession: { id: uid(), name: '', type: 'ssh', folder, port: 22, auth: 'password' }
  })
}

export function toggleRecording(): Promise<void> | void {
  const s = useStore.getState()
  if (!s.recordingMacro) {
    if (!activePane()?.connId) return toast('Focus a connected terminal first', true)
    startRecording()
    return toast('Recording macro… type in the terminal, then press Stop')
  }
  const steps = stopRecording()
  if (!steps.length) return toast('Nothing recorded')
  return promptText({ title: 'Save recorded macro', label: 'Macro name', value: `Macro ${s.macros.length + 1}` }).then(
    async (name) => {
      if (!name) return
      const macros = await api.saveMacros([...useStore.getState().macros, { id: uid(), name, steps }])
      useStore.setState({ macros })
      toast(`Saved macro "${name}"`)
    }
  )
}

export async function importFromMobaXterm(): Promise<void> {
  try {
    const preview = await api.pickMobaFile()
    if (!preview) return
    const summary = [
      `${preview.ssh} SSH, ${preview.rdp} RDP and ${preview.telnet} Telnet sessions`,
      preview.other ? `${preview.other} other sessions (not supported, skipped)` : '',
      preview.macros ? `${preview.macros} macros` : ''
    ].filter(Boolean)
    if (!window.confirm(`Import from ${preview.file}?\n\n${summary.join('\n')}\n\nSessions go to the "MobaXterm" folder. Passwords are not imported.`)) return
    let master: string | undefined
    if (preview.encryptedMacros) {
      const pw = await promptText({
        title: 'MobaXterm master password',
        label: `${preview.encryptedMacros} macros are encrypted with your MobaXterm master password. Leave empty to skip them.`,
        password: true
      })
      master = pw || undefined
    }
    const { report, sessions } = await api.importMoba(preview.token, master)
    const macros = await api.listMacros()
    const unsupported = Object.entries(report.unsupported).map(([t, n]) => `${n} ${t}`)
    useStore.setState({
      sessions,
      macros,
      report: {
        title: 'MobaXterm import',
        lines: [
          `Sessions imported: ${report.sessionsAdded}` + (report.sessionsSkipped ? ` (${report.sessionsSkipped} already existed)` : ''),
          ...(unsupported.length ? [`Skipped unsupported session types: ${unsupported.join(', ')}`] : []),
          ...(report.macrosAdded.length
            ? [`Macros imported: ${report.macrosAdded.join(', ')}. Review them in Macros before running them; they are stored unencrypted.`]
            : []),
          ...report.macrosFailed.map((m) => `Macro not imported: ${m}`)
        ]
      }
    })
  } catch (err) {
    toast(errorMessage(err), true)
  }
}

export async function exportToMobaXterm(): Promise<void> {
  try {
    const res = await api.exportMoba()
    if (res) toast(`Exported ${res.count} sessions${res.skipped ? ` (${res.skipped} local/Telnet sessions skipped)` : ''}. Passwords and macros are not exported.`)
  } catch (err) {
    toast(errorMessage(err), true)
  }
}

// Each step is checked as soon as it is entered and asked again on a mistake, so a wrong current
// password shows up before typing the new one twice.
export async function changeMasterPassword(): Promise<void> {
  const title = 'Change master password'
  let current: string | null = null
  for (let hint: string | undefined; ; hint = 'Wrong master password, try again') {
    current = await promptText({ title, label: 'Current master password', password: true, hint })
    if (current === null) return
    try {
      if (await api.dbCheckPassword(current)) break
    } catch (err) {
      return toast(errorMessage(err), true)
    }
  }
  let next: string | null = null
  for (let hint: string | undefined; ; hint = 'Use at least 4 characters') {
    next = await promptText({ title, label: 'New master password', password: true, hint })
    if (next === null) return
    if (next.length >= 4) break
  }
  for (let hint: string | undefined; ; hint = 'Does not match the new password, try again') {
    const again = await promptText({ title, label: 'Repeat the new master password', password: true, hint })
    if (again === null) return
    if (again === next) break
  }
  try {
    await api.dbChangePassword(current, next)
    toast('Master password changed')
  } catch (err) {
    toast(errorMessage(err), true)
  }
}

export function handleMenu(cmd: string): void {
  const s = useStore.getState()
  const pane = activePane()
  switch (cmd) {
    case 'newSession':
      return newSession()
    case 'newLocal':
      return openLocal()
    case 'duplicateTab':
      return duplicateTab()
    case 'reconnect':
      if (pane?.kind === 'rdp') reconnectRdp(pane.id)
      else if (pane && pane.state !== 'connected' && pane.state !== 'connecting') void connectPane(pane.id)
      return
    case 'closeTab':
      return closeActiveTab()
    case 'importSshConfig':
      api.importSshConfig().then(({ added, sessions }) => {
        s.set({ sessions })
        toast(added ? `Imported ${added} host(s) from ~/.ssh/config` : 'No new hosts in ~/.ssh/config')
      })
      return
    case 'importSessions':
      api.importSessions().then(async (sessions) => {
        const [{ tunnels }, macros, folders] = await Promise.all([api.listTunnels(), api.listMacros(), api.listFolders()])
        s.set({ sessions, tunnels, macros, folders })
      })
      return
    case 'dbLock':
      void api.dbLock()
      return
    case 'dbChangePassword':
      void changeMasterPassword()
      return
    case 'dbMove':
      api
        .dbMoveTo()
        .then((st) => toast(`Database is now at ${st.path}`))
        .catch((e) => toast(errorMessage(e), true))
      return
    case 'dbOpen':
      // Switching file locks the current one; the lock screen then asks for the other's password.
      void api.dbOpen()
      return
    case 'importMoba':
      void importFromMobaXterm()
      return
    case 'exportMoba':
      void exportToMobaXterm()
      return
    case 'exportSessions':
      api.exportSessions().then((ok) => ok && toast('Sessions exported (passwords are not included)'))
      return
    case 'settings':
      return s.set({ modal: 'settings' })
    case 'tunnels':
      return s.set({ modal: 'tunnels' })
    case 'macros':
      return s.set({ modal: 'macros' })
    case 'macroPicker':
      return openMacroPicker()
    case 'copy':
      if (pane) copySelection(pane.id)
      return
    case 'paste':
      if (pane) void pasteInto(pane.id)
      return
    case 'find':
      return s.set({ searchOpen: !s.searchOpen })
    case 'clear':
      if (pane) getEntry(pane.id)?.term.clear()
      return
    case 'splitRight':
      s.splitActive('row')
      return
    case 'splitDown':
      s.splitActive('column')
      return
    case 'tileAll':
      return tileAllTabs()
    case 'untile':
      if (s.activeTabId) untileTab(s.activeTabId)
      return
    case 'layoutRow':
    case 'layoutColumn':
    case 'layoutGrid':
      if (s.activeTabId) s.setLayout(s.activeTabId, ({ layoutRow: 'row', layoutColumn: 'column', layoutGrid: 'grid' } as const)[cmd])
      return
    case 'toggleSidebar':
      return s.set({ sidebarOpen: !s.sidebarOpen })
    case 'toggleSftp':
      if (!activePane()?.isSsh) return toast('SFTP is available on SSH connections', true)
      return s.set({ sidebarOpen: true, sidebarTab: s.sidebarTab === 'sftp' ? 'sessions' : 'sftp' })
    case 'multiExec':
      return s.set({ multiExec: !s.multiExec })
    case 'fontUp':
      return changeFontSize(1)
    case 'fontDown':
      return changeFontSize(-1)
    case 'fontReset':
      return changeFontSize('reset')
    case 'nextTab':
      return cycleTab(1)
    case 'prevTab':
      return cycleTab(-1)
  }
}

/** Pop the macro list up where the terminal cursor is (or under the focused text field); arrows + Enter pick one. */
export function openMacroPicker(): void {
  const s = useStore.getState()
  if (!s.macros.length) return toast('No macros yet: record one or add it in Macros…', true)
  const field = focusedField()
  if (field) {
    const r = field.getBoundingClientRect()
    return s.set({ macroPicker: { field, x: r.left, y: r.bottom, lineHeight: r.height } })
  }
  const pane = activePane()
  if (!pane || pane.kind === 'rdp' || !pane.connId) return toast('Focus a connected terminal or a text field first', true)
  const at = cursorPoint(pane.id)
  const box = document.querySelector('.tab-views')?.getBoundingClientRect()
  const fallback = { x: (box?.left ?? 0) + 40, y: (box?.top ?? 0) + 40, lineHeight: 16 }
  s.set({ macroPicker: { paneId: pane.id, ...(at ?? fallback) } })
}
