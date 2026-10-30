import { useState } from 'react'
import type { DbStatusInfo } from '../../../preload'
import { api, errorMessage } from '../api'

/** Unlock the database, or create it on first run (KeePass-style master password). */
export function LockScreen({ status, onChange }: { status: DbStatusInfo; onChange: (s: DbStatusInfo) => void }): JSX.Element {
  const creating = status.state === 'none'
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(false)
  const [path, setPath] = useState(status.path)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setError(undefined)
    if (creating && password !== confirm) return setError('The two passwords do not match')
    setBusy(true)
    try {
      onChange(creating ? await api.dbCreate(password, remember, path) : await api.dbUnlock(password, remember))
    } catch (err) {
      setError(errorMessage(err))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lock-screen">
      <form
        className="lock-card"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="lock-logo">Nixi</div>
        <h2>{creating ? 'Create your database' : 'Unlock database'}</h2>
        <p className="muted small">
          {creating
            ? 'Sessions, passwords, macros and settings are kept in one encrypted file (AES-256, like KeePass). Pick a master password — it cannot be recovered.'
            : 'Enter the master password to open your sessions.'}
        </p>
        <div className="lock-path" title={path}>
          <span className="muted">File</span>
          <span className="mono">{path}</span>
          {creating && (
            <button type="button" className="link" onClick={async () => setPath((await api.dbPickNewPath()) ?? path)}>
              change
            </button>
          )}
        </div>
        <input
          autoFocus
          type="password"
          placeholder="Master password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {creating && (
          <input type="password" placeholder="Repeat master password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        )}
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this computer
          (key kept in the system keychain)
        </label>
        {creating && status.legacy && (
          <p className="muted small">
            Your existing data ({status.legacy.sessions} sessions) will be moved into the new database.
            {status.legacy.lostSecrets > 0 &&
              ` ${status.legacy.lostSecrets} saved password(s) belonged to the old app name and must be entered again.`}
          </p>
        )}
        {error && <div className="error-line">{error}</div>}
        <button className="primary" type="submit" disabled={busy || !password}>
          {busy ? 'Working…' : creating ? 'Create database' : 'Unlock'}
        </button>
        <div className="lock-links">
          <button type="button" className="link" onClick={async () => onChange(await api.dbOpen())}>
            Open another database…
          </button>
          {!creating && (
            <button type="button" className="link" onClick={async () => onChange(await api.dbNew())}>
              Create a new database…
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
