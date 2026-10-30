import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import type { DbStatusInfo } from '../../../preload'
import { needsModifier } from '@shared/macro'
import { api, isMac } from '../api'
import { useStore } from '../store'
import { changeMasterPassword } from '../actions'
import { Modal } from './Overlays'
import { HotkeyInput } from './HotkeyInput'
import { contrast, termTheme } from '../themes'

export function SettingsDialog(): JSX.Element {
  const current = useStore((s) => s.settings)!
  const macros = useStore((s) => s.macros)
  const [s, setS] = useState<Settings>(current)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void => setS((x) => ({ ...x, [k]: v }))
  const close = (): void => useStore.setState({ modal: null })
  const save = async (): Promise<void> => {
    useStore.setState({ settings: await api.setSettings(s), modal: null })
  }
  const check = (k: 'copyOnSelect' | 'rightClickPaste' | 'warnMultilinePaste' | 'sftpAutoOpen', label: string): JSX.Element => (
    <label className="check">
      <input type="checkbox" checked={s[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  )
  return (
    <Modal
      title="Settings"
      onClose={close}
      footer={
        <>
          <button onClick={close}>Cancel</button>
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <h4>Terminal</h4>
      <div className="grid2">
        <label className="field">
          <span>Theme</span>
          <select value={s.theme} onChange={(e) => set('theme', e.target.value as Settings['theme'])}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="solarized">Solarized Dark</option>
          </select>
        </label>
        <label className="field">
          <span>Font size</span>
          <input type="number" min={8} max={32} value={s.fontSize} onChange={(e) => set('fontSize', Number(e.target.value))} />
        </label>
      </div>
      <label className="field">
        <span>Font family</span>
        <input value={s.fontFamily} onChange={(e) => set('fontFamily', e.target.value)} />
      </label>
      <label className="field">
        <span>Scrollback lines</span>
        <input type="number" value={s.scrollback} onChange={(e) => set('scrollback', Number(e.target.value))} />
      </label>
      <div className="grid2">
        <label className="field">
          <span>Cursor</span>
          <select value={s.cursorStyle ?? 'bar'} onChange={(e) => set('cursorStyle', e.target.value as Settings['cursorStyle'])}>
            <option value="bar">Bar │</option>
            <option value="block">Block █</option>
            <option value="underline">Underline _</option>
          </select>
        </label>
        <label className="check" style={{ alignSelf: 'end' }}>
          <input type="checkbox" checked={s.cursorBlink ?? true} onChange={(e) => set('cursorBlink', e.target.checked)} /> Blinking
          cursor
        </label>
      </div>
      <p className="muted small">Full-screen programs (vim, less…) may switch the cursor shape while they run.</p>
      <TerminalColors s={s} set={set} />
      <label className="check">
        <input type="checkbox" checked={s.gpuRendering ?? true} onChange={(e) => set('gpuRendering', e.target.checked)} /> GPU
        acceleration (WebGL)
      </label>
      <p className="muted small">Turn off if characters look scrambled on this computer. Applies to newly opened terminals.</p>
      <label className="check">
        <input type="checkbox" checked={s.serverStats ?? true} onChange={(e) => set('serverStats', e.target.checked)} /> Show
        server CPU / RAM / disk under SSH terminals
      </label>
      <h4>Copy &amp; paste</h4>
      {check('copyOnSelect', 'Copy text on selection')}
      {check('rightClickPaste', 'Right-click pastes')}
      {check('warnMultilinePaste', 'Warn before pasting multiple lines')}
      <h4>Macros</h4>
      <label className="field">
        <span>Show the macro list at the cursor (click, then press keys)</span>
        <HotkeyInput value={s.macroPickerHotkey ?? ''} onChange={(v) => set('macroPickerHotkey', v)} />
      </label>
      {(() => {
        const clash = macros.find((m) => m.hotkey && m.hotkey === s.macroPickerHotkey)
        if (clash)
          return <p className="error-line small">Macro "{clash.name}" already uses this key; the list will open instead of running it.</p>
        if (needsModifier(s.macroPickerHotkey))
          return <p className="error-line small">Add Cmd, Ctrl or Alt: on its own this key could no longer be typed in the terminal.</p>
        return (
          <p className="muted small">
            Any combination works; if an app shortcut (⌘T, ⌘W…) uses the same key, yours wins and that menu item loses its
            shortcut.
            {isMac && ' Keys macOS keeps for itself (⌘Space Spotlight, ⌃Space input source, ⌘Tab…) never reach the app.'}
          </p>
        )
      })()}
      <h4>SFTP</h4>
      {check('sftpAutoOpen', 'Show SFTP browser when an SSH session connects')}
      <label className="field">
        <span>Download folder</span>
        <div className="row">
          <input value={s.downloadDir} onChange={(e) => set('downloadDir', e.target.value)} />
          <button onClick={async () => set('downloadDir', (await api.pickDir()) ?? s.downloadDir)}>Browse…</button>
        </div>
      </label>
      <DatabaseSection />
    </Modal>
  )
}

// Ready-made text colors; anything else through the rainbow swatch (system color picker).
const TEXT_PRESETS = ['#ffffff', '#d8dee9', '#33ff66', '#ffb000', '#7cc4ff', '#ff8fa3']
const BG_PRESETS = ['#000000', '#1e1f24', '#0b1d2a', '#1a1526', '#fbfbfb']
const CURSOR_PRESETS = ['#f0f0f0', '#33ff66', '#ffb000', '#4f8cff']

/** Text, background and cursor colors of the terminal, each "Theme" (the theme's own) or a color. */
function TerminalColors({ s, set }: { s: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => void }): JSX.Element {
  const theme = termTheme(s)
  const fg = theme.foreground!
  const bg = theme.background!
  const ratio = contrast(fg, bg)
  return (
    <>
      <div className="term-colors">
        <ColorField label="Text color" value={s.termForeground} presets={TEXT_PRESETS} onChange={(v) => set('termForeground', v)} />
        <ColorField label="Background" value={s.termBackground} presets={BG_PRESETS} onChange={(v) => set('termBackground', v)} />
        <ColorField label="Cursor" value={s.termCursor} presets={CURSOR_PRESETS} onChange={(v) => set('termCursor', v)} />
      </div>
      <div className="term-preview mono" style={{ color: fg, background: bg, fontSize: s.fontSize, fontFamily: s.fontFamily }}>
        <div>
          user@server:~$ <span>ls -la</span>
        </div>
        <div>
          total 24 drwxr-xr-x 5 user staff 160 Oct 30 09:12 .
        </div>
        <div>
          user@server:~$ <span className="term-preview-cursor" style={{ background: theme.cursor }} />
        </div>
      </div>
      {ratio < 3 && <p className="error-line small">Text and background are too close to read easily (contrast {ratio.toFixed(1)}:1).</p>}
      <p className="muted small">Colors programs print themselves (ls, prompts, vim…) keep the theme's palette.</p>
    </>
  )
}

function ColorField(props: { label: string; value: string; presets: string[]; onChange: (v: string) => void }): JSX.Element {
  const { value, presets, onChange } = props
  const custom = !!value && !presets.includes(value)
  return (
    <div className="field color-field">
      <span>{props.label}</span>
      <div className="row colors">
        <button className={`swatch-default ${value ? '' : 'active'}`} onClick={() => onChange('')} title="The theme's own color">
          Theme
        </button>
        {presets.map((c) => (
          <button
            key={c}
            className={`swatch ${value === c ? 'active' : ''}`}
            style={{ background: c }}
            onClick={() => onChange(c)}
            title={c}
          />
        ))}
        <label className={`swatch custom ${custom ? 'active' : ''}`} style={custom ? { background: value } : undefined} title="Custom color…">
          <input type="color" value={value || '#d8dee9'} onChange={(e) => onChange(e.target.value)} />
        </label>
        {custom && <span className="mono muted small">{value}</span>}
      </div>
    </div>
  )
}

function DatabaseSection(): JSX.Element | null {
  const [db, setDb] = useState<DbStatusInfo>()
  useEffect(() => {
    api.dbStatus().then(setDb)
  }, [])
  if (!db) return null
  return (
    <>
      <h4>Database</h4>
      <p className="muted small">
        Everything (sessions, passwords, macros, tunnels, settings) is stored encrypted in one file. Copy it or keep it in a
        synced folder to use it on another computer.
      </p>
      <div className="lock-path" title={db.path}>
        <span className="mono">{db.path}</span>
      </div>
      <label className="check">
        <input type="checkbox" checked={db.remembered} onChange={async (e) => setDb(await api.dbSetRemember(e.target.checked))} />
        Unlock automatically on this computer
      </label>
      <div className="row">
        <button onClick={() => void changeMasterPassword()}>Change master password…</button>
        <button onClick={async () => setDb(await api.dbMoveTo())}>Move file…</button>
        <button onClick={() => void api.dbLock()}>Lock now</button>
      </div>
    </>
  )
}
