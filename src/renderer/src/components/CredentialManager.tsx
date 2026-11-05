import { useState } from 'react'
import type { Credential, CredentialInput } from '@shared/types'
import { api, errorMessage, uid } from '../api'
import { toast, useStore, confirmDelete } from '../store'
import { Modal } from './Overlays'
import { ToolIcon } from './Icons'

const blank = (): CredentialInput => ({ id: uid(), name: '', username: '', kind: 'password' })

export function CredentialManager(): JSX.Element {
  const credentials = useStore((s) => s.credentials)
  const sessions = useStore((s) => s.sessions)
  const [form, setForm] = useState<CredentialInput>(credentials[0] ?? blank())
  const [secret, setSecret] = useState('')
  const set = <K extends keyof CredentialInput>(k: K, v: CredentialInput[K]): void => setForm((f) => ({ ...f, [k]: v }))
  const close = (): void => useStore.setState({ modal: null })
  const isSaved = credentials.some((c) => c.id === form.id)
  const users = sessions.filter((s) => s.credentialId === form.id)
  // A session can't log in with a private key unless it is SSH.
  const blocked = form.kind === 'key' ? users.filter((s) => s.type !== 'ssh') : []

  const select = (c: Credential | CredentialInput): void => {
    setForm(c)
    setSecret('')
  }

  const save = async (): Promise<void> => {
    const name = form.name.trim() || form.username?.trim()
    if (!name) return toast('Name or username is required', true)
    if (blocked.length) return toast(`${blocked[0].name} is not SSH, so it can't use a private key`, true)
    try {
      const input: CredentialInput = { ...form, name, username: form.username?.trim() || undefined }
      if (input.kind === 'password') delete input.privateKeyPath
      if (secret) input.secret = secret
      const res = await api.saveCredential(input)
      useStore.setState(res)
      select(res.credentials.find((c) => c.id === input.id) ?? input)
      toast('Credential saved')
    } catch (err) {
      toast(errorMessage(err), true)
    }
  }

  const remove = async (): Promise<void> => {
    const note = users.length ? ` ${users.length} session(s) using it keep this login as their own.` : ''
    if (!(await confirmDelete('Delete credential', `Delete credential "${form.name}"?${note}`))) return
    try {
      const res = await api.deleteCredential(form.id)
      useStore.setState(res)
      select(res.credentials[0] ?? blank())
    } catch (err) {
      toast(errorMessage(err), true)
    }
  }

  const isKey = form.kind === 'key'
  return (
    <Modal title="Credentials" onClose={close} wide>
      <div className="macro-layout">
        <div className="macro-list">
          {credentials.map((c) => (
            <div key={c.id} data-nav tabIndex={0} className={`tree-row macro-row ${c.id === form.id ? 'selected' : ''}`} onClick={() => select(c)}>
              <span className="tree-name">{c.name}</span>
              {c.kind === 'key' && <span className="badge">key</span>}
            </div>
          ))}
          <button onClick={() => select(blank())}>
            <ToolIcon name="plus" />
            New credential
          </button>
        </div>
        <div className="macro-editor">
          <div className="grid2">
            <label className="field">
              <span>Name</span>
              <input name="credentialName" autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={form.username || 'e.g. Domain admin'} />
            </label>
            <label className="field">
              <span>Username</span>
              <input name="credentialUser" autoComplete="off" spellCheck={false} value={form.username ?? ''} onChange={(e) => set('username', e.target.value)} placeholder="e.g. admin or CORP\admin" />
            </label>
          </div>
          <div className="field">
            <span>Type</span>
            <div className="type-picker">
              <button className={!isKey ? 'active' : ''} onClick={() => set('kind', 'password')}>
                Password
              </button>
              <button className={isKey ? 'active' : ''} onClick={() => set('kind', 'key')}>
                Private key (SSH)
              </button>
            </div>
          </div>
          {isKey && (
            <label className="field">
              <span>Private key file</span>
              <div className="row">
                <input name="credentialKey" value={form.privateKeyPath ?? ''} onChange={(e) => set('privateKeyPath', e.target.value)} placeholder="~/.ssh/id_ed25519" />
                <button onClick={async () => set('privateKeyPath', (await api.pickFile()) ?? form.privateKeyPath)}>Browse…</button>
              </div>
            </label>
          )}
          <label className="field">
            <span>
              {isKey ? 'Key passphrase' : 'Password'} {form.hasSecret && !form.clearSecret && <em className="muted">(saved — leave blank to keep)</em>}
            </span>
            <div className="row">
              <input name="credentialSecret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={isKey ? 'optional' : 'leave empty to ask on connect'} />
              {form.hasSecret && (
                <label className="inline">
                  <input type="checkbox" checked={Boolean(form.clearSecret)} onChange={(e) => set('clearSecret', e.target.checked)} /> forget
                </label>
              )}
            </div>
          </label>
          <p className="muted small">
            {users.length
              ? `Used by: ${users.map((s) => s.name).join(', ')}. A change here applies to all of them.`
              : 'Pick it when editing a session, or in the login dialog. Kept in the encrypted database, never exported.'}
          </p>
          <div className="row end">
            {isSaved && (
              <button className="danger" onClick={() => void remove()}>
                Delete
              </button>
            )}
            <button className="primary" onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
