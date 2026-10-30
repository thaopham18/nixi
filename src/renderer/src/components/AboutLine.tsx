import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

type Info = Awaited<ReturnType<typeof api.appInfo>>
let cached: Info | undefined

/**
 * Faded "v0.1.0 by Thao Pham" under the welcome buttons (the name is the heading right above).
 * A click opens a small card with the details, each shown once; click outside or Esc closes it.
 */
export function AboutLine({ className = '' }: { className?: string }): JSX.Element | null {
  const [info, setInfo] = useState(cached)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!cached) api.appInfo().then((i) => setInfo((cached = i)))
  }, [])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  if (!info) return null
  return (
    <div className={`about-line ${className}`} ref={ref}>
      <button className="about-trigger" onClick={() => setOpen(!open)} title={`About ${info.name}`}>
        v{info.version} by {info.author}
      </button>
      {open && (
        <div className="about-popup">
          <table className="disk-table">
            <tbody>
              <tr>
                <td className="muted">Version</td>
                <td>{info.version}</td>
              </tr>
              <tr>
                <td className="muted">Author</td>
                <td>{info.copyright}</td>
              </tr>
              <tr>
                <td className="muted">Contact</td>
                <td className="about-email">{info.email}</td>
              </tr>
              <tr className="section">
                <td colSpan={2}>Runtime</td>
              </tr>
              <tr>
                <td className="muted">Electron</td>
                <td>
                  {info.electron} <span className="muted">(Chromium {info.chrome}, Node {info.node})</span>
                </td>
              </tr>
              <tr>
                <td className="muted">System</td>
                <td>{info.platform}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
