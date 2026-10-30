import { useMemo, useState } from 'react'
import type { Session, SessionInput } from '@shared/types'
import { api, errorMessage } from '../api'
import { toast, useStore } from '../store'
import { openSession } from '../actions'
import { Modal } from './Overlays'
import { SessionIcon } from './Icons'

const colors = ['', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd']

export function SessionDialog(): JSX.Element {
  const editing = useStore((s) => s.editingSession)!
  const sessions = useStore((s) => s.sessions)
  const isNew = !sessions.some((s) => s.id === editing.id)
  const [form, setForm] = useState<SessionInput>({ type: 'ssh', folder: '', name: '', ...editing } as SessionInput)
  const [secret, setSecret] = useState('')
  const customColor = !!form.color && !colors.includes(form.color)
  const emptyFolders = useStore((s) => s.folders)
  const folders = useMemo(
    () => [...new Set([...sessions.map((s) => s.folder), ...emptyFolders].filter(Boolean))].sort(),
    [sessions, emptyFolders]
  )
  const jumpCandidates = sessions.filter((s) => s.type === 'ssh' && s.id !== form.id)

  const set = <K extends keyof SessionInput>(k: K, v: SessionInput[K]): void => setForm((f) => ({ ...f, [k]: v }))
  const close = (): void => useStore.setState({ modal: null, editingSession: undefined })

  const save = async (connect: boolean): Promise<void> => {
    const name = form.name.trim() || form.host || (form.type === 'local' ? 'Local shell' : '')
    if (!name) return toast('Name or host is required', true)
    if (form.type !== 'local' && !form.host?.trim()) return toast('Host is required', true)
    try {
      const input: SessionInput = { ...form, name, host: form.host?.trim(), folder: form.folder.replace(/^\/+|\/+$/g, '') }
      if (secret) input.secret = secret
      const list = await api.saveSession(input)
      useStore.setState({ sessions: list })
      close()
      if (connect) openSession(list.find((s) => s.id === input.id) as Session)
    } catch (err) {
      toast(errorMessage(err), true)
    }
  }

  const usesKey = form.type === 'ssh' && form.auth === 'key'
  const secretField = (
    <label className="field">
      <span>
        {usesKey ? 'Key passphrase' : 'Password'}{' '}
        {form.hasSecret && !form.clearSecret && <em className="muted">(saved — leave blank to keep)</em>}
      </span>
      <div className="row">
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={usesKey ? 'optional' : 'leave empty to ask on connect'}
        />
        {form.hasSecret && (
          <label className="inline">
            <input type="checkbox" checked={Boolean(form.clearSecret)} onChange={(e) => set('clearSecret', e.target.checked)} /> forget
          </label>
        )}
      </div>
    </label>
  )
  return (
    <Modal
      title={isNew ? 'New session' : `Edit ${editing.name}`}
      onClose={close}
      footer={
        <>
          <button onClick={close}>Cancel</button>
          <button onClick={() => void save(false)}>Save</button>
          <button className="primary" onClick={() => void save(true)}>
            Save & connect
          </button>
        </>
      }
    >
      <div className="type-picker">
        {(['ssh', 'telnet', 'rdp', 'local'] as const).map((t) => (
          <button
            key={t}
            className={form.type === t ? 'active' : ''}
            onClick={() => setForm((f) => ({ ...f, type: t, port: { ssh: 22, telnet: 23, rdp: 3389, local: undefined }[t] }))}
          >
            <SessionIcon type={t} />
            {{ ssh: 'SSH', telnet: 'Telnet', local: 'Local shell', rdp: 'RDP' }[t]}
          </button>
        ))}
      </div>
      <div className="grid2">
        <label className="field">
          <span>Name</span>
          <input autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={form.host || 'My server'} />
        </label>
        <label className="field">
          <span>Folder</span>
          <input list="folders" value={form.folder} onChange={(e) => set('folder', e.target.value)} placeholder="e.g. Prod/DB" />
          <datalist id="folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
      </div>

      {form.type !== 'local' && (
        <>
          <div className="grid3">
            <label className="field span2">
              <span>Host</span>
              <input value={form.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.10 or example.com" />
            </label>
            <label className="field">
              <span>Port</span>
              <input type="number" value={form.port ?? ''} onChange={(e) => set('port', Number(e.target.value) || undefined)} />
            </label>
          </div>
          <div className="grid2">
            <label className="field">
              <span>Username{form.type === 'telnet' && ' (optional, auto-login)'}</span>
              <input value={form.username ?? ''} onChange={(e) => set('username', e.target.value)} />
            </label>
            {form.type === 'telnet' ? (
              <label className="field">
                <span>Character set</span>
                <select value={form.encoding ?? 'utf8'} onChange={(e) => set('encoding', e.target.value as Session['encoding'])}>
                  <option value="utf8">UTF-8</option>
                  <option value="latin1">Latin-1 (older devices)</option>
                </select>
              </label>
            ) : form.type === 'ssh' ? (
              <label className="field">
                <span>Authentication</span>
                <select value={form.auth ?? 'password'} onChange={(e) => set('auth', e.target.value as Session['auth'])}>
                  <option value="password">Password</option>
                  <option value="key">Private key</option>
                  <option value="agent">SSH agent</option>
                </select>
              </label>
            ) : (
              <label className="field">
                <span>Domain</span>
                <input value={form.rdpDomain ?? ''} onChange={(e) => set('rdpDomain', e.target.value)} />
              </label>
            )}
          </div>
        </>
      )}

      {form.type === 'telnet' && (
        <>
          {secretField}
          <label className="field">
            <span>Command after login (optional)</span>
            <input value={form.startupCommand ?? ''} onChange={(e) => set('startupCommand', e.target.value)} placeholder="e.g. terminal length 0" />
          </label>
          <p className="muted small">
            Telnet sends everything, passwords included, unencrypted. With a username/password set, Nixi answers the first
            login and password prompts for you.
          </p>
        </>
      )}

      {form.type === 'ssh' && (
        <>
          {form.auth === 'key' && (
            <label className="field">
              <span>Private key file</span>
              <div className="row">
                <input value={form.privateKeyPath ?? ''} onChange={(e) => set('privateKeyPath', e.target.value)} placeholder="~/.ssh/id_ed25519" />
                <button onClick={async () => set('privateKeyPath', (await api.pickFile()) ?? form.privateKeyPath)}>Browse…</button>
              </div>
            </label>
          )}
          {form.auth !== 'agent' && secretField}
          <details>
            <summary>Advanced</summary>
            <div className="grid2">
              <label className="field">
                <span>Jump host (ProxyJump)</span>
                <select value={form.jumpSessionId ?? ''} onChange={(e) => set('jumpSessionId', e.target.value || undefined)}>
                  <option value="">— none —</option>
                  {jumpCandidates.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Keepalive (seconds)</span>
                <input type="number" value={form.keepaliveSec ?? 30} onChange={(e) => set('keepaliveSec', Number(e.target.value))} />
              </label>
            </div>
            <label className="field">
              <span>Startup command</span>
              <input value={form.startupCommand ?? ''} onChange={(e) => set('startupCommand', e.target.value)} placeholder="e.g. sudo -i" />
            </label>
          </details>
        </>
      )}

      {form.type === 'local' && (
        <>
          <label className="field">
            <span>Shell</span>
            <input value={form.shell ?? ''} onChange={(e) => set('shell', e.target.value)} placeholder="default ($SHELL)" />
          </label>
          <label className="field">
            <span>Startup command</span>
            <input value={form.startupCommand ?? ''} onChange={(e) => set('startupCommand', e.target.value)} />
          </label>
        </>
      )}

      {form.type === 'rdp' && (
        <>
          {secretField}
          <div className="field">
            <span>Open with</span>
            <div className="type-picker">
              <button className={form.rdpClient !== 'native' ? 'active' : ''} onClick={() => set('rdpClient', 'embedded')}>
                Nixi tab
              </button>
              <button className={form.rdpClient === 'native' ? 'active' : ''} onClick={() => set('rdpClient', 'native')}>
                Native client (smoothest)
              </button>
            </div>
            <span className="muted small">
              {form.rdpClient === 'native'
                ? 'Opens in Windows App (macOS) or mstsc (Windows): hardware H.264 video, best for daily work and video.'
                : 'Runs inside a Nixi tab, can be split next to other sessions. Graphics are decoded in software, so it is less fluid than the native client for video or animations.'}
            </span>
          </div>
          <div className="grid2">
            <label className="field">
              <span>Width (empty = fit the tab)</span>
              <input type="number" value={form.rdpWidth ?? ''} onChange={(e) => set('rdpWidth', Number(e.target.value) || undefined)} />
            </label>
            <label className="field">
              <span>Height</span>
              <input type="number" value={form.rdpHeight ?? ''} onChange={(e) => set('rdpHeight', Number(e.target.value) || undefined)} />
            </label>
          </div>
          <p className="muted small">
            A user written as DOMAIN\user also works. On macOS the native client is the free “Windows App” from the
            App Store.
          </p>
        </>
      )}

      <div className="field">
        <span>Tab color</span>
        <div className="colors">
          {colors.map((c) => (
            <button
              key={c || 'none'}
              className={`swatch ${(form.color ?? '') === c ? 'active' : ''}`}
              style={{ background: c || 'transparent' }}
              onClick={() => set('color', c || undefined)}
              title={c || 'none'}
            />
          ))}
          {/* Any other color: the system color picker behind a rainbow swatch. */}
          <label
            className={`swatch custom ${customColor ? 'active' : ''}`}
            style={customColor ? { background: form.color } : undefined}
            title="Custom color…"
          >
            <input type="color" value={form.color || '#61afef'} onChange={(e) => set('color', e.target.value)} />
          </label>
          {customColor && <span className="mono muted small">{form.color}</span>}
        </div>
      </div>
    </Modal>
  )
}
