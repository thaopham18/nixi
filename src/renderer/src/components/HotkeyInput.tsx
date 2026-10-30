import { useEffect, useRef, useState } from 'react'
import { hotkeyOf } from '@shared/macro'
import { api } from '../api'

const clears = new Set(['Backspace', 'Escape'])

/**
 * Click, then press any key combination (app menu shortcuts like ⌘W included: the main process
 * routes keys here while the field is focused). Backspace / Escape on its own clears.
 */
export function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  const [recording, setRecording] = useState(false)
  const change = useRef(onChange)
  change.current = onChange

  useEffect(() => {
    if (!recording) return
    api.captureHotkeys(true)
    const off = api.onHotkeyCaptured((combo) => change.current(clears.has(combo) ? '' : combo))
    return () => {
      off()
      api.captureHotkeys(false)
    }
  }, [recording])

  return (
    <div className="row">
      <input
        readOnly
        className={recording ? 'recording-key' : ''}
        value={value}
        placeholder={recording ? 'Press keys…' : 'none'}
        onFocus={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          // Only reached when the main process is not capturing (e.g. focus raced the IPC).
          if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
          e.preventDefault()
          const combo = hotkeyOf(e.nativeEvent)
          onChange(clears.has(combo) ? '' : combo)
        }}
      />
      <button onClick={() => onChange('')}>Clear</button>
    </div>
  )
}
