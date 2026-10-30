import { useEffect, useState } from 'react'
import type { DbStatusInfo } from '../../preload'
import { LockScreen } from './components/LockScreen'
import { hotkeyOf } from '@shared/macro'
import { api, isMac } from './api'
import { activePane, useStore } from './store'
import { applySettings, focusedField, runMacro, typeIntoField } from './terminals'
import { handleMenu, openLocal, openMacroPicker } from './actions'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TabView } from './components/TabView'
import { Toolbar } from './components/Toolbar'
import { SessionDialog } from './components/SessionDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { TunnelManager } from './components/TunnelManager'
import { MacroManager } from './components/MacroManager'
import { AboutLine } from './components/AboutLine'
import { MacroPicker } from './components/MacroPicker'
import { HeartIcon } from './components/Icons'
import { ChoiceDialog, ContextMenu, PromptDialog, ReportDialog, Toast } from './components/Overlays'

export function App(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const modal = useStore((s) => s.modal)
  const multiExec = useStore((s) => s.multiExec)

  const [db, setDb] = useState<DbStatusInfo>()
  // On <html> so the lock screen (outside .app) sees it too.
  useEffect(() => api.onFullScreen((on) => document.documentElement.classList.toggle('fullscreen', on)), [])
  useEffect(() => {
    // Locking reloads the window (from the main process), which lands back here.
    api.dbStatus().then(setDb)
  }, [])

  useEffect(() => {
    if (db?.state !== 'unlocked') return
    Promise.all([api.getSettings(), api.listSessions(), api.listMacros(), api.listTunnels(), api.listFolders()]).then(
      ([settings, sessions, macros, { tunnels, statuses }, folders]) =>
        useStore.setState({
          settings,
          sessions,
          folders,
          macros,
          tunnels,
          tunnelStatus: Object.fromEntries(statuses.map((s) => [s.id, s]))
        })
    )
    const offs = [
      api.onMenu(handleMenu),
      api.onTunnelStatus((st) => useStore.setState((s) => ({ tunnelStatus: { ...s.tunnelStatus, [st.id]: st } }))),
      api.onTransfer((t) => useStore.setState((s) => ({ transfers: { ...s.transfers, [t.id]: t } })))
    ]
    return () => offs.forEach((off) => off())
  }, [db?.state])

  useEffect(() => {
    if (settings) {
      applySettings(settings)
      document.documentElement.dataset.theme = settings.theme
      // a custom terminal background also fills the pane padding and the open tab joined to it
      if (settings.termBackground) document.documentElement.style.setProperty('--term-bg', settings.termBackground)
      else document.documentElement.style.removeProperty('--term-bg')
    }
  }, [settings])

  // Macro hotkeys, checked before xterm sees the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      const el = e.target as HTMLElement
      // Text fields take macros too; other controls (checkboxes, the hotkey recorder…) keep their keys.
      const field = focusedField()
      if (!field && /INPUT|TEXTAREA|SELECT/.test(el.tagName) && !el.classList.contains('xterm-helper-textarea')) return
      const combo = hotkeyOf(e)
      const { settings, macroPicker } = useStore.getState()
      if (settings?.macroPickerHotkey && combo === settings.macroPickerHotkey && !macroPicker) {
        e.preventDefault()
        e.stopPropagation()
        return openMacroPicker()
      }
      const macro = useStore.getState().macros.find((m) => m.hotkey && m.hotkey === combo)
      if (macro && field) {
        e.preventDefault()
        e.stopPropagation()
        return void typeIntoField(field, macro)
      }
      const pane = activePane()
      if (!macro || !pane || pane.kind === 'rdp') return
      e.preventDefault()
      e.stopPropagation()
      void runMacro(macro, pane.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!db) return <div className="loading">Loading…</div>
  if (db.state !== 'unlocked') return <LockScreen status={db} onChange={setDb} />
  if (!settings) return <div className="loading">Loading…</div>

  return (
    <div className={`app ${isMac ? 'mac' : ''} ${multiExec ? 'multi-exec' : ''}`}>
      <Toolbar />
      <div className="main">
        {sidebarOpen && <Sidebar />}
        <div className="workspace">
          <TabBar />
          <div className="tab-views">
            {tabs.map((t) => (
              <TabView key={t.id} tab={t} visible={t.id === activeTabId} />
            ))}
            {!tabs.length && (
              <div className="welcome">
                <h1>
                  Nixi <HeartIcon />
                </h1>
                <p>Double-click a session in the sidebar, or</p>
                <div className="welcome-actions">
                  <button onClick={() => handleMenu('newSession')}>New session</button>
                  <button onClick={openLocal}>Local terminal</button>
                </div>
                <AboutLine className="welcome-about" />
              </div>
            )}
          </div>
        </div>
      </div>
      {modal === 'session' && <SessionDialog />}
      {modal === 'settings' && <SettingsDialog />}
      {modal === 'tunnels' && <TunnelManager />}
      {modal === 'macros' && <MacroManager />}
      <PromptDialog />
      <ChoiceDialog />
      <ReportDialog />
      <ContextMenu />
      <MacroPicker />
      <Toast />
    </div>
  )
}
