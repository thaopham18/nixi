import { useEffect, useRef, useState, type ComponentProps } from 'react'
import type { Settings } from '@shared/types'
import type { DbStatusInfo } from '../../../preload'
import { needsModifier } from '@shared/macro'
import { api, isMac } from '../api'
import { useStore, type SettingsPage } from '../store'
import { ToolIcon } from './Icons'
import { changeMasterPassword } from '../actions'
import { Modal } from './Overlays'
import { HotkeyInput } from './HotkeyInput'
import { contrast, termTheme } from '../themes'
import { AI_PROVIDERS, aiModelOf, aiProviderInfo, parseAiBaseUrl, type AiModelInfo, type AiProviderId } from '@shared/ai'
import { errorMessage } from '../api'

type Draft = { provider: AiProviderId; baseUrl: string }

/** The key is saved on its own: it goes to the encrypted database, not with the other settings. */
function AiKeyField({ target, onSaved, onFinished }: { target: Draft; onSaved: (key: string | null) => void; onFinished: () => void }): JSX.Element {
  const info = aiProviderInfo(target.provider)
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [note, setNote] = useState<{ text: string; error?: boolean } | undefined>()
  // Came here from "Add API key": that is the only thing to do here, so finish it and go back.
  const cameForKey = useRef(useStore.getState().settingsFocus?.field === 'aiKey')
  useEffect(() => {
    setKey('')
    setNote(undefined)
    void api.aiHasKey(info.id).then(setHasKey)
  }, [info.id])
  const save = async (value: string | null): Promise<void> => {
    await api.aiSetKey(info.id, value)
    setKey('')
    setHasKey(value !== null)
    setNote({ text: value === null ? 'API key removed.' : 'API key saved.' })
    onSaved(value)
    if (value !== null && cameForKey.current) onFinished()
  }
  const test = async (): Promise<void> => {
    setNote({ text: 'Checking…' })
    try {
      await api.aiTestKey(target, key || undefined)
      setNote({ text: info.id === 'custom' ? 'This server answers.' : 'This key works.' })
    } catch (err) {
      setNote({ text: errorMessage(err), error: true })
    }
  }
  return (
    <>
      <label className="field">
        <span>
          {info.id === 'custom' ? 'API key' : `${info.label} API key`} {hasKey && <em className="muted">(saved)</em>}
        </span>
        <input
          name="aiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && key.trim()) void save(key)
          }}
          placeholder={hasKey ? 'Enter a new key to replace it' : info.keyHint}
        />
      </label>
      <div className="row end">
        {hasKey && (
          <button className="danger" onClick={() => void save(null)}>
            Remove key
          </button>
        )}
        <button disabled={!key && !hasKey && info.id !== 'custom'} onClick={() => void test()}>
          {info.id === 'custom' ? 'Test' : 'Test key'}
        </button>
        <button disabled={!key.trim()} onClick={() => void save(key)}>
          Save key
        </button>
      </div>
      {note && <p className={note.error ? 'error-line small' : 'muted small'}>{note.text}</p>}
      {!hasKey && !note && <p className="muted small">{info.keyHelp}</p>}
    </>
  )
}

const OTHER_MODEL = '\0other'

/** The provider's own list, so a new model shows up by itself; any other name can be typed. */
function AiModelField({ s, set, target, refresh }: { s: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => void; target: Draft; refresh: number }): JSX.Element {
  const info = aiProviderInfo(target.provider)
  const model = aiModelOf({ ...s, aiProvider: target.provider })
  const [fetched, setFetched] = useState<AiModelInfo[] | undefined>()
  const [status, setStatus] = useState<{ text: string; error?: boolean } | undefined>()
  const [typing, setTyping] = useState(false)
  const asked = useRef(0)
  const load = async (): Promise<void> => {
    const n = ++asked.current
    setStatus({ text: 'Getting the list of models…' })
    try {
      const models = await api.aiModels(target)
      if (n !== asked.current) return
      setFetched(models)
      setStatus({ text: models.length ? `${models.length} models available to this key.` : 'The server lists no models: type the name of one.' })
    } catch (err) {
      if (n !== asked.current) return
      setFetched(undefined)
      setStatus(/Enter (?:an API key|the address|a full)/.test(errorMessage(err)) ? undefined : { text: `Could not get the list: ${errorMessage(err)}`, error: true })
    }
  }
  useEffect(() => {
    setFetched(undefined)
    setStatus(undefined)
    setTyping(false)
    void load()
  }, [info.id, target.baseUrl, refresh])
  const setModel = (id: string): void => set('aiModels', { ...s.aiModels, [info.id]: id })
  const known = fetched?.length ? fetched : info.models
  const listed = known.some((m) => m.id === model)
  const free = typing || !known.length || (!!model && !listed)
  return (
    <>
      <div className="field">
        <span>Model</span>
        <div className="row">
          {known.length > 0 && (
            <select
              name="aiModel"
              value={free ? OTHER_MODEL : model}
              onChange={(e) => {
                setTyping(e.target.value === OTHER_MODEL)
                if (e.target.value !== OTHER_MODEL) setModel(e.target.value)
              }}
            >
              {known.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? m.id}
                </option>
              ))}
              <option value={OTHER_MODEL}>Other, type its name…</option>
            </select>
          )}
          <button onClick={() => void load()}>Refresh</button>
        </div>
      </div>
      {free && (
        <label className="field">
          <span>Model name</span>
          <input name={known.length ? 'aiModelName' : 'aiModel'} className="mono" spellCheck={false} value={s.aiModels?.[info.id] ?? ''} placeholder={info.id === 'custom' ? 'llama3.2' : model} onChange={(e) => setModel(e.target.value)} />
        </label>
      )}
      {status && <p className={status.error ? 'error-line small' : 'muted small'}>{status.text}</p>}
    </>
  )
}

/** Key, address and model all belong to the provider picked above them. */
function AiSection({ s, set, onFinished }: { s: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => void; onFinished: () => void }): JSX.Element {
  const info = aiProviderInfo(s.aiProvider)
  const [refresh, setRefresh] = useState(0)
  const target: Draft = { provider: info.id, baseUrl: info.id === 'custom' ? s.aiBaseUrl ?? '' : '' }
  const [baseUrl, setBaseUrl] = useState(s.aiBaseUrl ?? '')
  const bad = info.id === 'custom' && baseUrl.trim() ? parseAiBaseUrl(baseUrl) : undefined
  const where = info.id === 'custom' ? 'your server' : info.label
  return (
    <>
      <div className="field">
        <span>Provider</span>
        <div className="type-picker" role="radiogroup">
          {AI_PROVIDERS.map((p) => (
            <button key={p.id} role="radio" aria-checked={p.id === info.id} className={p.id === info.id ? 'active' : ''} onClick={() => set('aiProvider', p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {info.id === 'custom' && (
        <>
          <label className="field">
            <span>Server address</span>
            <input
              name="aiBaseUrl"
              className="mono"
              spellCheck={false}
              value={baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => set('aiBaseUrl', baseUrl.trim())}
            />
          </label>
          {bad && 'error' in bad ? (
            <p className="error-line small">{bad.error}</p>
          ) : (
            <p className="muted small">
              Any server with the OpenAI chat completions API and tool calling: OpenAI, OpenRouter, Groq, DeepSeek, Ollama (http://localhost:11434/v1), LM Studio
              (http://localhost:1234/v1)… Without tool calling it can still answer, but can't propose commands.
            </p>
          )}
        </>
      )}
      <AiKeyField target={target} onSaved={() => setRefresh((n) => n + 1)} onFinished={onFinished} />
      <AiModelField s={s} set={set} target={target} refresh={refresh} />
      <label className="check">
        <input name="aiAutoRun" type="checkbox" checked={s.aiAutoRun === true} onChange={(e) => set('aiAutoRun', e.target.checked)} /> Let AI run commands that only look, and read their output
      </label>
      <p className="muted small">
        Off: you click Run for each command. On: commands that only look (ls, cat, df, ps, systemctl status, SELECT…) run by themselves and their output goes to {where} with no
        review. Adding, changing or deleting anything, and any command it does not recognize, still waits for Run. It pauses after 20 commands in a row.
      </p>
      <p className="muted small">
        Keys stay in your encrypted database and are never exported. What you send goes to {where}
        {info.id === 'custom' ? '' : ' and is billed to your key'}. Common secrets and your saved passwords are hidden first, but check the preview: this can't catch everything.
      </p>
    </>
  )
}

const PAGES: { id: SettingsPage; label: string; icon: ComponentProps<typeof ToolIcon>['name'] }[] = [
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'keyboard', label: 'Keyboard & Paste', icon: 'keyboard' },
  { id: 'connections', label: 'Connections', icon: 'refresh' },
  { id: 'safety', label: 'Command Safety', icon: 'shield' },
  { id: 'ai', label: 'AI Assistant', icon: 'sparkle' },
  { id: 'macros', label: 'Macros', icon: 'bolt' },
  { id: 'sftp', label: 'SFTP', icon: 'folder' },
  { id: 'database', label: 'Database', icon: 'database' }
]

// Settings reopens where the user left it, until the app restarts.
let lastPage: SettingsPage = 'terminal'

export function SettingsDialog(): JSX.Element {
  const current = useStore((s) => s.settings)!
  const macros = useStore((s) => s.macros)
  const [s, setS] = useState<Settings>(current)
  const [focus] = useState(() => useStore.getState().settingsFocus)
  const [page, setPage] = useState<SettingsPage>(focus?.page ?? lastPage)
  const content = useRef<HTMLDivElement>(null)
  lastPage = page
  useEffect(() => {
    useStore.setState({ settingsFocus: undefined })
    const field = focus?.field && content.current?.querySelector<HTMLElement>(`[name="${focus.field}"]`)
    if (!field) return
    field.scrollIntoView({ block: 'center' })
    field.focus()
  }, [focus])
  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void => setS((x) => ({ ...x, [k]: v }))
  const close = (): void => useStore.setState({ modal: null })
  const save = async (): Promise<void> => {
    const dangerWatchList = (s.dangerWatchList ?? []).map((w) => w.trim()).filter(Boolean)
    useStore.setState({ settings: await api.setSettings({ ...s, dangerWatchList }), modal: null })
  }
  const check = (k: 'copyOnSelect' | 'rightClickPaste' | 'warnMultilinePaste' | 'autoReconnect' | 'warnDangerousCommands' | 'sftpAutoOpen' | 'terminalEnglishOnly', label: string): JSX.Element => (
    <label className="check">
      <input name={k} type="checkbox" checked={s[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  )
  // Every page stays mounted, so moving between them keeps what was typed, a new API key included.
  const pageOf = (id: SettingsPage): { className: string; hidden: boolean; role: string } => ({ className: 'settings-page', hidden: page !== id, role: 'tabpanel' })
  const moveBy = (nav: HTMLElement, step: number): void => {
    const at = PAGES.findIndex((x) => x.id === page) + step
    if (!PAGES[at]) return
    setPage(PAGES[at].id)
    ;(nav.children[at] as HTMLElement).focus()
  }
  return (
    <Modal
      title="Settings"
      className="settings"
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
      <nav
        className="settings-nav"
        role="tablist"
        aria-orientation="vertical"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          moveBy(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1)
        }}
      >
        {PAGES.map((p) => (
          <button key={p.id} role="tab" aria-selected={page === p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)} title={p.label}>
            <ToolIcon name={p.icon} />
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-content" ref={content}>
        <h3 className="settings-title">{PAGES.find((p) => p.id === page)?.label}</h3>

        <section {...pageOf('terminal')}>
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
          <h4>Colors</h4>
          <TerminalColors s={s} set={set} />
          <h4>Rendering</h4>
          <label className="check">
            <input type="checkbox" checked={s.gpuRendering ?? true} onChange={(e) => set('gpuRendering', e.target.checked)} /> GPU
            acceleration (WebGL)
          </label>
          <p className="muted small">Turn off if characters look scrambled on this computer. Applies to newly opened terminals.</p>
        </section>

        <section {...pageOf('keyboard')}>
          <h4>Typing</h4>
          {check('terminalEnglishOnly', 'Type only English in SSH and Telnet terminals')}
          <p className="muted small">
            Vietnamese and other input methods are ignored there, so commands and passwords go out as the keys you press. Local terminals, dialogs and
            other text boxes keep your input method, and pasted text is not changed.
          </p>
          {isMac ? (
            <p className="muted small">
              While such a terminal has focus, macOS Secure Keyboard Entry is on. That is what stops tools like EVKey, and it also pauses other apps that
              watch the keyboard, such as text expanders.
            </p>
          ) : (
            <p className="muted small">Tools that rewrite text after you type (Unikey, EVKey) can't be stopped on this system. Add Nixi to their list of excluded apps.</p>
          )}
          <h4>Copy &amp; paste</h4>
          {check('copyOnSelect', 'Copy text on selection')}
          {check('rightClickPaste', 'Right-click pastes')}
          {check('warnMultilinePaste', 'Warn before pasting multiple lines')}
        </section>

        <section {...pageOf('connections')}>
          {check('autoReconnect', 'Reconnect by itself when a connection drops (SSH, Telnet, RDP, VNC, tunnels)')}
          <label className="check">
            <input type="checkbox" checked={s.serverStats ?? true} onChange={(e) => set('serverStats', e.target.checked)} /> Show
            server CPU / RAM / disk under SSH terminals
          </label>
        </section>

        <section {...pageOf('safety')}>
          {check('warnDangerousCommands', 'Ask before running commands that are hard to undo')}
          <p className="muted small">
            rm -rf, DROP TABLE, DELETE without WHERE, mkfs, reboot, git push --force, kubectl delete, format c:… in terminals and macros. A
            safety net against slips: a command written in an unusual way can still get through.
          </p>
          <label className="field">
            <span>Also ask about (one per line)</span>
            <textarea
              name="dangerWatchList"
              className="mono"
              rows={3}
              spellCheck={false}
              placeholder={'deploy prod\nsystemctl stop'}
              disabled={s.warnDangerousCommands === false}
              value={(s.dangerWatchList ?? []).join('\n')}
              onChange={(e) => set('dangerWatchList', e.target.value.split('\n'))}
            />
          </label>
        </section>

        <section {...pageOf('ai')}>
          <AiSection s={s} set={set} onFinished={() => void save()} />
        </section>

        <section {...pageOf('macros')}>
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
        </section>

        <section {...pageOf('sftp')}>
          {check('sftpAutoOpen', 'Show SFTP browser when an SSH session connects')}
          <label className="field">
            <span>Download folder</span>
            <div className="row">
              <input value={s.downloadDir} onChange={(e) => set('downloadDir', e.target.value)} />
              <button onClick={async () => set('downloadDir', (await api.pickDir()) ?? s.downloadDir)}>Browse…</button>
            </div>
          </label>
        </section>

        <section {...pageOf('database')}>
          <DatabaseSection />
        </section>
      </div>
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
