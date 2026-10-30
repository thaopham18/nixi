import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { focusTerminal, runMacro, typeIntoField } from '../terminals'

/**
 * Macro list popped up at the terminal cursor (menu "Run Macro at Cursor…"), or under the focused
 * text field, e.g. a password prompt; there the macro is typed into the field.
 * ↑/↓ move, Enter runs, 1–9 run directly (while the filter is empty), typing filters, Esc closes.
 */
export function MacroPicker(): JSX.Element | null {
  const at = useStore((s) => s.macroPicker)
  if (!at) return null
  // Keyed so the filter and selection start fresh each time it opens.
  return <Picker key={`${at.paneId ?? 'field'}:${at.x}:${at.y}`} {...at} />
}

function Picker({ paneId, field, x, y, lineHeight }: NonNullable<ReturnType<typeof useStore.getState>['macroPicker']>): JSX.Element {
  const macros = useStore((s) => s.macros)
  const [filter, setFilter] = useState('')
  const [index, setIndex] = useState(0)
  const [pos, setPos] = useState({ left: x, top: y + 2, ready: false })
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  // Numbers follow the order in the macro list, also while filtering.
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return macros.map((m, i) => ({ m, n: i + 1 })).filter(({ m }) => !q || m.name.toLowerCase().includes(q))
  }, [macros, filter])
  const sel = Math.min(index, Math.max(shown.length - 1, 0))

  // Below the cursor line; above it when there is no room; never off the right edge.
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const top = y + 2 + r.height > window.innerHeight - 8 ? Math.max(8, y - lineHeight - 2 - r.height) : y + 2
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8))
    setPos({ left, top, ready: true })
  }, [x, y, lineHeight])

  // Take the keyboard from xterm once placed (a hidden element cannot take focus).
  useEffect(() => {
    if (pos.ready) input.current?.focus()
  }, [pos.ready])

  useLayoutEffect(() => {
    list.current?.children[sel]?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const close = (): void => {
    useStore.setState({ macroPicker: undefined })
    if (field) field.focus()
    else if (paneId) focusTerminal(paneId)
  }
  const run = (i: number): void => {
    const item = shown[i]
    if (!item) return
    close()
    if (field) void typeIntoField(field, item.m)
    else if (paneId) void runMacro(item.m, paneId)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    const move = (d: number): void => {
      e.preventDefault()
      if (shown.length) setIndex((sel + d + shown.length) % shown.length)
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) move(1)
    else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) move(-1)
    else if (e.key === 'Home') move(-sel)
    else if (e.key === 'End') move(shown.length - 1 - sel)
    else if (e.key === 'Enter') {
      e.preventDefault()
      run(sel)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // only the picker: a dialog under it (password prompt) stays open
      close()
    } else if (!filter && /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const i = shown.findIndex((s) => s.n === Number(e.key))
      if (i >= 0) run(i)
    }
  }

  return (
    <div className="macro-picker-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="macro-picker"
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        onKeyDown={onKey}
      >
        <input
          ref={input}
          placeholder="Run macro…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setIndex(0)
          }}
          onBlur={(e) => e.relatedTarget === null && e.target.focus()}
        />
        <div className="macro-picker-list" ref={list}>
          {shown.map(({ m, n }, i) => (
            <div
              key={m.id}
              className={`macro-picker-item ${i === sel ? 'selected' : ''}`}
              onMouseMove={() => i !== sel && setIndex(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(i)}
            >
              <span className="num">{n <= 9 ? n : ''}</span>
              <span className="name">{m.name}</span>
              {m.hotkey && <span className="hotkey">{m.hotkey}</span>}
            </div>
          ))}
          {!shown.length && <div className="macro-picker-empty">No macro matches</div>}
        </div>
        <div className="macro-picker-hint">↑↓ select · ↵ run · 1–9 · esc</div>
      </div>
    </div>
  )
}
