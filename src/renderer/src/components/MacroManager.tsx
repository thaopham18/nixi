import { useState } from 'react'
import type { Macro } from '@shared/types'
import { asTextMacro, parseMacro, serializeMacro, textMacroSteps } from '@shared/macro'
import { HotkeyInput } from './HotkeyInput'
import { api, errorMessage, uid } from '../api'
import { activePane, toast, useStore } from '../store'
import { runMacro } from '../terminals'
import { toggleRecording } from '../actions'
import { Modal } from './Overlays'

const help = `> command        send command + Enter
>> raw\\n         send raw text (escapes \\n \\r \\t \\e \\x03)
wait 500         pause 500 ms
expect \\$ 5000   wait for output matching a regex
paste <<END      paste the lines up to END as one block
# comment`

export function MacroManager(): JSX.Element {
  const macros = useStore((s) => s.macros)
  const recording = useStore((s) => s.recordingMacro)
  const [selectedId, setSelectedId] = useState<string | undefined>(macros[0]?.id)
  const selected = macros.find((m) => m.id === selectedId)
  const [name, setName] = useState(selected?.name ?? '')
  const [text, setText] = useState(selected ? serializeMacro(selected.steps) : '')
  const [hotkey, setHotkey] = useState(selected?.hotkey ?? '')
  const [error, setError] = useState<string>()
  // A text macro is one block, typed as is: the steps syntax doesn't apply and a line needs no ">".
  const asText = selected && asTextMacro(selected.steps)
  const [mode, setMode] = useState<'commands' | 'text'>(asText ? 'text' : 'commands')
  const [body, setBody] = useState(asText?.text ?? '')
  const [pressEnter, setPressEnter] = useState(asText?.pressEnter ?? false)
  const close = (): void => useStore.setState({ modal: null })

  const select = (m?: Macro): void => {
    setSelectedId(m?.id)
    setName(m?.name ?? '')
    setText(m ? serializeMacro(m.steps) : '')
    setHotkey(m?.hotkey ?? '')
    const block = m && asTextMacro(m.steps)
    setMode(block ? 'text' : 'commands')
    setBody(block?.text ?? '')
    setPressEnter(block?.pressEnter ?? false)
    setError(undefined)
  }

  const persist = async (list: Macro[]): Promise<void> => useStore.setState({ macros: await api.saveMacros(list) })

  // Order = the numbers in the macro list at the cursor (1–9) and the toolbar menu.
  const [drag, setDrag] = useState<{ id: string; to?: number }>()
  const moveTo = (id: string, to: number): void => {
    const from = macros.findIndex((m) => m.id === id)
    if (from < 0) return
    const list = macros.filter((m) => m.id !== id)
    const at = Math.max(0, Math.min(list.length, to > from ? to - 1 : to))
    if (at === from) return
    list.splice(at, 0, macros[from])
    void persist(list)
  }

  const save = async (): Promise<Macro | undefined> => {
    try {
      if (mode === 'text' && !body) throw new Error('The text is empty')
      const steps = mode === 'text' ? textMacroSteps(body, pressEnter) : parseMacro(text)
      const m: Macro = { id: selectedId ?? uid(), name: name.trim() || 'Untitled macro', steps, hotkey: hotkey || undefined }
      const clash = macros.find((x) => x.hotkey && x.hotkey === m.hotkey && x.id !== m.id)
      if (clash) throw new Error(`Hotkey already used by "${clash.name}"`)
      await persist(macros.some((x) => x.id === m.id) ? macros.map((x) => (x.id === m.id ? m : x)) : [...macros, m])
      setSelectedId(m.id)
      setError(undefined)
      return m
    } catch (err) {
      setError(errorMessage(err))
      return undefined
    }
  }

  return (
    <Modal title="Macros" onClose={close} wide>
      <div className="macro-layout">
        <div className="macro-list">
          {macros.map((m, i) => (
            <div
              key={m.id}
              className={`tree-row macro-row ${m.id === selectedId ? 'selected' : ''} ${drag?.id === m.id ? 'dragging' : ''} ${
                drag && drag.to === i ? 'drop-before' : ''
              } ${drag && drag.to === i + 1 && i === macros.length - 1 ? 'drop-after' : ''}`}
              draggable
              onClick={() => select(m)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setDrag({ id: m.id })
              }}
              onDragOver={(e) => {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const to = e.clientY < r.top + r.height / 2 ? i : i + 1
                if (drag && drag.to !== to) setDrag({ ...drag, to })
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (drag?.to !== undefined) moveTo(drag.id, drag.to)
                setDrag(undefined)
              }}
              onDragEnd={() => setDrag(undefined)}
              title="Drag to reorder"
            >
              <span className="grip">⋮⋮</span>
              <span className="num">{i + 1}</span>
              <span className="tree-name">{m.name}</span>
              {m.hotkey && <span className="badge">{m.hotkey}</span>}
              {m.id === selectedId && (
                <span className="order-buttons">
                  <button
                    className="icon"
                    title="Move up"
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation()
                      moveTo(m.id, i - 1)
                    }}
                  >
                    ↑
                  </button>
                  <button
                    className="icon"
                    title="Move down"
                    disabled={i === macros.length - 1}
                    onClick={(e) => {
                      e.stopPropagation()
                      moveTo(m.id, i + 2)
                    }}
                  >
                    ↓
                  </button>
                </span>
              )}
            </div>
          ))}
          <button onClick={() => select(undefined)}>＋ New macro</button>
          <button
            className={recording ? 'recording' : ''}
            onClick={() => {
              close()
              void toggleRecording()
            }}
          >
            {recording ? '■ Stop recording' : '● Record from terminal'}
          </button>
        </div>
        <div className="macro-editor">
          <div className="grid2">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Hotkey (click, then press keys)</span>
              <HotkeyInput value={hotkey} onChange={setHotkey} />
            </label>
          </div>
          <div className="type-picker">
            <button
              className={mode === 'commands' ? 'active' : ''}
              onClick={() => {
                // Show the text as a step, so nothing is lost by looking at it this way.
                if (mode === 'text' && body) setText(serializeMacro(textMacroSteps(body, pressEnter)))
                setMode('commands')
              }}
            >
              Commands
            </button>
            <button
              className={mode === 'text' ? 'active' : ''}
              onClick={() => {
                try {
                  const block = asTextMacro(parseMacro(text))
                  if (block) {
                    setBody(block.text)
                    setPressEnter(block.pressEnter)
                  }
                } catch {
                  /* steps with an error stay where they are, under Commands */
                }
                setMode('text')
              }}
            >
              Text
            </button>
          </div>
          {mode === 'text' ? (
            <>
              <label className="field">
                <span>Text, as many lines as you like</span>
                <textarea name="macroBody" className="mono" rows={12} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
              </label>
              <label className="check">
                <input type="checkbox" checked={pressEnter} onChange={(e) => setPressEnter(e.target.checked)} /> Press Enter after it
              </label>
              <p className="muted small">
                Goes in as one paste, without pressing Enter between lines where the shell supports it (zsh, bash 5…). Other programs get
                it line by line, like any paste.
              </p>
            </>
          ) : (
            <>
              <label className="field">
                <span>Steps</span>
                <textarea name="macroSteps" className="mono" rows={12} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
              </label>
              <pre className="help">{help}</pre>
            </>
          )}
          {error && <div className="error-line">{error}</div>}
          <div className="row end">
            {selected && (
              <button
                className="danger"
                onClick={() => {
                  if (!window.confirm(`Delete macro "${selected.name}"?`)) return
                  void persist(macros.filter((m) => m.id !== selected.id))
                  select(undefined)
                }}
              >
                Delete
              </button>
            )}
            <button onClick={() => void save().then((m) => m && toast('Macro saved'))}>Save</button>
            <button
              className="primary"
              onClick={async () => {
                const m = await save()
                const pane = activePane()
                if (!m) return
                if (!pane) return toast('No active terminal', true)
                close()
                void runMacro(m, pane.id)
              }}
            >
              Save & run
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
