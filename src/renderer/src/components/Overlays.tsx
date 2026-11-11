import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Credential } from '@shared/types'
import { api, isMac } from '../api'
import { answerChoice, useStore, type MenuItem } from '../store'
import { ToolIcon } from './Icons'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

/** The next one along, going round. Starts from the ends when `from` isn't in the list. */
function around<T>(list: T[], from: T | undefined, step: 1 | -1): T | undefined {
  const at = from === undefined ? -1 : list.indexOf(from)
  if (at < 0) return list[step > 0 ? 0 : list.length - 1]
  return list[(at + step + list.length) % list.length]
}

/** A dialog keeps the keyboard: Tab goes round inside it. Arrows: see keynav.ts. */
function keepTabInside(e: KeyboardEvent, modal: HTMLElement): void {
  if (e.key !== 'Tab') return
  const active = document.activeElement as HTMLElement | null
  const all = [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
  if (!all.length) return
  const inside = active && modal.contains(active) ? active : undefined
  const atEdge = !inside || inside === all[e.shiftKey ? 0 : all.length - 1]
  if (!atEdge) return // the browser's own order is right in the middle
  e.preventDefault()
  around(all, inside, e.shiftKey ? -1 : 1)?.focus()
}

/** Open dialogs, newest last: only the one on top answers keys. */
const openModals: HTMLElement[] = []

export function Modal(props: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  className?: string
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!box.current || openModals[openModals.length - 1] !== box.current) return
      if (e.key === 'Escape') close.current()
      keepTabInside(e, box.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    const modal = box.current!
    openModals.push(modal)
    // The keys come here now, not to the terminal behind. What the dialog focuses by itself goes first.
    const before = document.activeElement as HTMLElement | null
    const start = setTimeout(() => {
      if (modal.contains(document.activeElement)) return
      const first =
        modal.querySelector<HTMLElement>('.modal-body input:not(:disabled), .modal-body select:not(:disabled), .modal-body textarea:not(:disabled)') ??
        modal.querySelector<HTMLElement>('.modal-footer .primary:not(:disabled), .modal-footer button:not(:disabled), .modal-body button:not(:disabled)')
      first?.focus()
    }, 0)
    return () => {
      clearTimeout(start)
      openModals.splice(openModals.indexOf(modal), 1)
      // Back to where the keys were, unless something else has already taken them.
      setTimeout(() => {
        const now = document.activeElement
        if (before?.isConnected && (!now || now === document.body)) before.focus()
      }, 0)
    }
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={box} className={`modal ${props.wide ? 'wide' : ''} ${props.className ?? ''}`}>
        <div className="modal-header">
          <span>{props.title}</span>
          <button className="icon" onClick={props.onClose} title="Close">
            <ToolIcon name="close" />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-footer">{props.footer}</div>}
      </div>
    </div>
  )
}

export function PromptDialog(): JSX.Element | null {
  const prompt = useStore((s) => s.prompt)
  const [value, setValue] = useState('')
  const [username, setUsername] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const userInput = useRef<HTMLInputElement>(null)
  const okButton = useRef<HTMLButtonElement>(null)
  const [checked, setChecked] = useState(false)
  const saved = useStore((s) => s.credentials)
  const credentials = prompt?.credentials ? saved.filter((c) => c.kind === 'password' || prompt.keys) : []
  const [picked, setPicked] = useState<Credential>()
  useEffect(() => {
    setValue(prompt?.value ?? '')
    setUsername(prompt?.username ?? '')
    setChecked(false)
    setPicked(undefined)
    // Start where there is something to type: a known username only needs its password.
    setTimeout(() => (prompt?.username === '' || (prompt?.username !== undefined && !prompt.password) ? userInput : input).current?.select(), 0)
  }, [prompt])
  if (!prompt) return null
  const asksUser = prompt.username !== undefined
  const finish = (v: string | null): void => {
    if (v !== null && asksUser && !username.trim()) return userInput.current?.focus()
    useStore.setState({ prompt: undefined })
    // A credential's account applies even where this dialog doesn't ask for one.
    prompt.resolve(v, checked, v === null ? undefined : asksUser ? username.trim() : picked?.username, v === null ? undefined : picked?.id)
  }
  const pick = async (id: string): Promise<void> => {
    const credential = credentials.find((c) => c.id === id)
    setPicked(credential)
    if (!credential) return
    if (credential.username) setUsername(credential.username)
    // A key logs in by itself: there is no password to fill or type.
    if (credential.kind === 'key') {
      setValue('')
      return void setTimeout(() => (asksUser && !credential.username ? userInput : okButton).current?.focus(), 0)
    }
    const secret = await api.credentialSecret(id)
    setValue(secret ?? '')
    setTimeout(() => (secret || !prompt.password ? okButton : input).current?.focus(), 0)
  }
  const submitUser = (): void => {
    if (username.trim() && prompt.password && !value) input.current?.focus()
    else finish(value)
  }
  return (
    <Modal
      title={prompt.title}
      onClose={() => finish(null)}
      footer={
        <>
          <button onClick={() => finish(null)}>Cancel</button>
          <button ref={okButton} className="primary" onClick={() => finish(value)}>
            OK
          </button>
        </>
      }
    >
      {credentials.length > 0 && (
        <label className="field">
          <span>Saved credential</span>
          <select name="credential" value={picked?.id ?? ''} onChange={(e) => void pick(e.target.value)}>
            <option value="">— type a login —</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.username ? ` (${c.username})` : ''}
              </option>
            ))}
          </select>
          {picked?.kind === 'key' ? (
            <span className="muted small">
              Logs in with the key {picked.privateKeyPath || 'in ~/.ssh'}
              {picked.hasSecret ? ' (passphrase saved)' : ''}
            </span>
          ) : (
            picked?.username && !asksUser && <span className="muted small">Logs in as {picked.username}</span>
          )}
        </label>
      )}
      {asksUser && (
        <label className="field">
          <span>Username</span>
          <input
            ref={userInput}
            name="username"
            autoComplete="off"
            spellCheck={false}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
              setPicked(undefined)
            }}
            onKeyDown={(e) => e.key === 'Enter' && submitUser()}
          />
        </label>
      )}
      {(!asksUser || prompt.password) && picked?.kind !== 'key' && (
        <label className="field">
          {prompt.label && <span>{prompt.label}</span>}
          <input
            ref={input}
            autoFocus={!asksUser}
            type={prompt.password ? 'password' : 'text'}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setPicked(undefined)
            }}
            onKeyDown={(e) => e.key === 'Enter' && finish(value)}
          />
        </label>
      )}
      {prompt.hint && <div className="error-line small">{prompt.hint}</div>}
      {prompt.checkbox && (
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {picked ? `Keep using ${picked.name} for this session` : prompt.checkbox}
        </label>
      )}
    </Modal>
  )
}

export function ChoiceDialog(): JSX.Element | null {
  const choice = useStore((s) => s.choice)
  if (!choice) return null
  const finish = answerChoice
  const shown = choice.items?.slice(0, 8) ?? []
  // Without a main button the first one takes the focus, so Enter and the arrows work straight away.
  const first = choice.buttons.find((b) => b.primary) ?? choice.buttons[0]
  return (
    <Modal
      key={choice.id}
      title={choice.title}
      onClose={() => finish(null)}
      footer={choice.buttons.map((b) => (
        <button key={b.value} className={b.primary ? 'primary' : b.danger ? 'danger' : ''} autoFocus={b === first} onClick={() => finish(b.value)}>
          {b.label}
        </button>
      ))}
    >
      <p className="choice-message">{choice.message}</p>
      {!!shown.length && (
        <ul className="choice-items mono">
          {shown.map((i) => (
            <li key={i}>{i}</li>
          ))}
          {choice.items!.length > shown.length && <li className="muted">…and {choice.items!.length - shown.length} more</li>}
        </ul>
      )}
    </Modal>
  )
}

const lineCount = (text: string): number => text.split('\n').filter((l) => l.trim()).length

/** Several lines are about to go into a terminal: see them first, change them if need be. */
export function PasteDialog(): JSX.Element | null {
  const review = useStore((s) => s.pasteReview)
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const pasteButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!review) return
    setText(review.text.replace(/\r\n?/g, '\n'))
    setEditing(false)
    // On the button, so Enter pastes straight away. ↑ goes to the text to change it.
    setTimeout(() => pasteButton.current?.focus(), 0)
  }, [review])
  if (!review) return null
  const finish = (value: string | null): void => {
    useStore.setState({ pasteReview: undefined })
    review.resolve(value)
  }
  const lines = lineCount(text)
  return (
    <Modal
      wide
      className="paste-dialog"
      title={`Paste ${lines} ${lines === 1 ? 'line' : 'lines'}`}
      onClose={() => finish(null)}
      footer={
        <>
          <span className="muted small paste-keys">{editing ? (isMac ? '⌘↩' : 'Ctrl+Enter') : 'Enter'} to paste, {editing ? '' : '↑ to edit, '}Esc to cancel</span>
          <button onClick={() => finish(null)}>Cancel</button>
          <button ref={pasteButton} className="primary" disabled={!text} onClick={() => finish(text)}>
            Paste
          </button>
        </>
      }
    >
      <p className="choice-message">
        Into {review.target}. {review.asBlock ? 'Nothing runs until you press Enter in the terminal.' : 'This shell runs each line as it arrives.'}
      </p>
      <textarea
        className="paste-text mono"
        name="pasteText"
        wrap="off"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey) && text) {
            e.preventDefault()
            finish(text)
          }
        }}
      />
    </Modal>
  )
}

export function ContextMenu(): JSX.Element | null {
  const menu = useStore((s) => s.contextMenu)
  const [active, setActive] = useState<number>()
  const box = useRef<HTMLDivElement>(null)
  const current = useRef(active)
  current.current = active
  useEffect(() => {
    setActive(undefined)
    if (!menu) return
    const close = (): void => useStore.setState({ contextMenu: undefined })
    const usable = menu.items.flatMap((item, i) => (item.label === '-' || item.disabled ? [] : [i]))
    const onKey = (e: KeyboardEvent): void => {
      // A shortcut is not for the menu: let it through and get out of the way.
      if (e.metaKey || e.ctrlKey || e.altKey) return close()
      // Nothing behind the menu sees these keys: not the terminal, not the dialog under it.
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') return close()
      if (e.key === 'ArrowDown' || e.key === 'Tab') setActive((a) => around(usable, a, e.key === 'Tab' && e.shiftKey ? -1 : 1))
      else if (e.key === 'ArrowUp') setActive((a) => around(usable, a, -1))
      else if (e.key === 'Home') setActive(usable[0])
      else if (e.key === 'End') setActive(usable[usable.length - 1])
      else if (e.key === 'Enter' || e.key === ' ') {
        if (current.current !== undefined) runItem(menu.items[current.current])
      } else if (e.key.length === 1) {
        // The first letter jumps there, and on to the next item that starts the same way.
        const letter = e.key.toLowerCase()
        const same = usable.filter((i) => menu.items[i].label.toLowerCase().startsWith(letter))
        if (same.length) setActive((a) => around(same, a, 1))
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])
  useEffect(() => {
    if (active !== undefined) box.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])
  if (!menu) return null
  const left = Math.min(menu.x, window.innerWidth - 200)
  const top = Math.min(menu.y, window.innerHeight - menu.items.length * 28 - 10)
  return (
    <div ref={box} className="context-menu" role="menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.items.map((item, i) =>
        item.label === '-' ? (
          <div key={i} className="sep" />
        ) : (
          <div
            key={i}
            role="menuitem"
            aria-disabled={item.disabled}
            className={`item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''} ${i === active ? 'active' : ''}`}
            onMouseEnter={() => !item.disabled && setActive(i)}
            onClick={() => runItem(item)}
          >
            {item.label}
          </div>
        )
      )}
    </div>
  )
}

function runItem(item: MenuItem): void {
  if (item.disabled) return
  useStore.setState({ contextMenu: undefined })
  item.onClick()
}

export function ReportDialog(): JSX.Element | null {
  const report = useStore((s) => s.report)
  if (!report) return null
  const close = (): void => useStore.setState({ report: undefined })
  return (
    <Modal
      title={report.title}
      onClose={close}
      footer={
        <button className="primary" onClick={close}>
          OK
        </button>
      }
    >
      <ul className="report">
        {report.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </Modal>
  )
}

export function Toast(): JSX.Element | null {
  const toast = useStore((s) => s.toast)
  if (!toast) return null
  return (
    <div className={`toast ${toast.error ? 'error' : ''}`} onClick={() => useStore.setState({ toast: undefined })}>
      {toast.text}
    </div>
  )
}
