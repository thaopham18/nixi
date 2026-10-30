import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store'

export function Modal(props: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`}>
        <div className="modal-header">
          <span>{props.title}</span>
          <button className="icon" onClick={props.onClose} title="Close">
            ✕
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
  const input = useRef<HTMLInputElement>(null)
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    setValue(prompt?.value ?? '')
    setChecked(false)
    setTimeout(() => input.current?.select(), 0)
  }, [prompt])
  if (!prompt) return null
  const finish = (v: string | null): void => {
    useStore.setState({ prompt: undefined })
    prompt.resolve(v, checked)
  }
  return (
    <Modal
      title={prompt.title}
      onClose={() => finish(null)}
      footer={
        <>
          <button onClick={() => finish(null)}>Cancel</button>
          <button className="primary" onClick={() => finish(value)}>
            OK
          </button>
        </>
      }
    >
      <label className="field">
        {prompt.label && <span>{prompt.label}</span>}
        <input
          ref={input}
          autoFocus
          type={prompt.password ? 'password' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && finish(value)}
        />
      </label>
      {prompt.hint && <div className="error-line small">{prompt.hint}</div>}
      {prompt.checkbox && (
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {prompt.checkbox}
        </label>
      )}
    </Modal>
  )
}

export function ChoiceDialog(): JSX.Element | null {
  const choice = useStore((s) => s.choice)
  if (!choice) return null
  const finish = (v: string | null): void => {
    useStore.setState({ choice: undefined })
    choice.resolve(v)
  }
  const shown = choice.items?.slice(0, 8) ?? []
  return (
    <Modal
      title={choice.title}
      onClose={() => finish(null)}
      footer={choice.buttons.map((b) => (
        <button key={b.value} className={b.primary ? 'primary' : ''} autoFocus={b.primary} onClick={() => finish(b.value)}>
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

export function ContextMenu(): JSX.Element | null {
  const menu = useStore((s) => s.contextMenu)
  useEffect(() => {
    if (!menu) return
    const close = (): void => useStore.setState({ contextMenu: undefined })
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  if (!menu) return null
  const left = Math.min(menu.x, window.innerWidth - 200)
  const top = Math.min(menu.y, window.innerHeight - menu.items.length * 28 - 10)
  return (
    <div className="context-menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.items.map((item, i) =>
        item.label === '-' ? (
          <div key={i} className="sep" />
        ) : (
          <div
            key={i}
            className={`item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
            onClick={() => {
              if (item.disabled) return
              useStore.setState({ contextMenu: undefined })
              item.onClick()
            }}
          >
            {item.label}
          </div>
        )
      )}
    </div>
  )
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
