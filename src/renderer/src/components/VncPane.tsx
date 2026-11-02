import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errorMessage } from '../api'
import { toast, useStore, type Pane } from '../store'
import { attachVnc, focusVnc, reconnectVnc, sendCtrlAltDel, sendVncClipboard, setVncView, vncStatsLine, vncView, type VncQuality, type VncScale, type VncView } from '../vnc'

export function VncPane(props: { pane: Pane; visible: boolean; active: boolean; header?: ReactNode }): JSX.Element {
  const { pane, visible, active } = props
  const host = useRef<HTMLDivElement>(null)
  const error = useStore((s) => s.paneErrors[pane.id])
  const session = useStore((s) => s.sessions.find((x) => x.id === pane.sessionId))
  // A moved pane is mounted again: the live connection's view wins over the session's defaults.
  const [view, setView] = useState<VncView>(
    () => vncView(pane.id) ?? { scale: session?.vncScale ?? 'fit', quality: session?.vncQuality ?? 'balanced', viewOnly: Boolean(session?.vncViewOnly) }
  )

  // Connect on first mount; later mounts (pane moved to another split) re-attach the live session.
  useEffect(() => attachVnc(pane.id, host.current!, view), [pane.id])

  useEffect(() => {
    if (visible && active) focusVnc(pane.id)
  }, [visible, active, pane.id])

  const change = (next: Partial<VncView>): void => {
    setView((v) => ({ ...v, ...next }))
    setVncView(pane.id, next)
  }

  const [stats, setStats] = useState<string | null>(null)
  const showStats = stats !== null
  useEffect(() => {
    if (!showStats) return
    const timer = setInterval(() => setStats(vncStatsLine(pane.id)), 1000)
    return () => clearInterval(timer)
  }, [showStats, pane.id])

  const connected = pane.state === 'connected'
  return (
    <div className="rdp-pane">
      <div className="rdp-toolbar">
        {props.header ?? (
          <>
            <span className={`dot ${pane.state}`} />
            <span className="muted">{pane.title}</span>
          </>
        )}
        <div className="spacer" />
        <select value={view.scale} onChange={(e) => change({ scale: e.target.value as VncScale })} title="How the remote screen fits this tab">
          <option value="fit">Fit to tab</option>
          <option value="actual">Actual size</option>
          <option value="remote">Resize remote screen</option>
        </select>
        <select className="tb-medium" value={view.quality} onChange={(e) => change({ quality: e.target.value as VncQuality })} title="Picture quality vs. speed. Has an effect on servers that compress with JPEG (TigerVNC, TightVNC)">
          <option value="smooth">Smooth</option>
          <option value="balanced">Balanced</option>
          <option value="sharp">Sharp</option>
        </select>
        <button className={view.viewOnly ? 'active-toggle' : ''} onClick={() => change({ viewOnly: !view.viewOnly })} title="Watch only: keyboard and mouse are not sent">
          View only
        </button>
        {session?.vncSendClipboard === false && (
          <button disabled={!connected || view.viewOnly} onClick={() => void sendVncClipboard(pane.id)} title="Send this computer's clipboard text to the remote machine, once">
            Send clipboard
          </button>
        )}
        <button className="tb-medium" disabled={!connected || view.viewOnly} onClick={() => sendCtrlAltDel(pane.id)}>
          Ctrl+Alt+Del
        </button>
        <button
          className={`tb-wide ${showStats ? 'active-toggle' : ''}`}
          onClick={() => setStats(showStats ? null : vncStatsLine(pane.id))}
          title="Frames per second, data rate, decoding time and encoding in use"
        >
          Stats
        </button>
        <button className="tb-medium" onClick={() => reconnectVnc(pane.id)}>
          Reconnect
        </button>
        <button
          className="tb-wide"
          onClick={() => pane.sessionId && api.openVncExternal(pane.sessionId).catch((e) => toast(errorMessage(e), true))}
          title="Open in the system's VNC app (Screen Sharing on macOS)"
        >
          Open in native client
        </button>
      </div>
      <div className="rdp-screen">
        <div className="rdp-host" ref={host} />
        {showStats && <div className="vnc-stats">{stats}</div>}
        {pane.state === 'connecting' && !error && <div className="rdp-overlay">Connecting to {pane.title}…</div>}
        {error && (
          <div className="rdp-overlay error">
            <div>{error.text}</div>
            <button className="primary" onClick={() => reconnectVnc(pane.id)}>
              Reconnect
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
