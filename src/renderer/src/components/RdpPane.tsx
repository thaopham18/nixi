import { useEffect, useRef, type ReactNode } from 'react'
import { api, errorMessage } from '../api'
import { toast, useStore, type Pane } from '../store'
import { attachRdp, rdpUi, reconnectRdp, resizeRdp } from '../rdp'

export function RdpPane(props: { pane: Pane; visible: boolean; active: boolean; header?: ReactNode }): JSX.Element {
  const { pane, visible, active } = props
  const host = useRef<HTMLDivElement>(null)
  const error = useStore((s) => s.rdpErrors[pane.id])
  const fixedSize = useStore((s) => Boolean(s.sessions.find((x) => x.id === pane.sessionId)?.rdpWidth))

  // Connect on first mount; later mounts (pane moved to another split) re-attach the live session.
  useEffect(() => attachRdp(pane.id, host.current!), [pane.id])

  // Follow the pane size with dynamic resolution, unless the session pins a size.
  useEffect(() => {
    if (fixedSize) return
    const target = host.current!
    let timer: ReturnType<typeof setTimeout>
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const r = target.getBoundingClientRect()
        if (r.width > 100 && r.height > 100) resizeRdp(pane.id, r.width, r.height)
      }, 400)
    })
    ro.observe(target)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [pane.id, fixedSize])

  useEffect(() => {
    if (visible && active) (host.current?.querySelector('iron-remote-desktop') as HTMLElement | null)?.focus()
  }, [visible, active])

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
        <button disabled={!connected} onClick={() => rdpUi(pane.id)?.ctrlAltDel()}>
          Ctrl+Alt+Del
        </button>
        <button disabled={!connected} onClick={() => rdpUi(pane.id)?.metaKey()} title="Send the Windows key">
          ⊞ Win
        </button>
        <button onClick={() => reconnectRdp(pane.id)}>Reconnect</button>
        <button
          onClick={() => pane.sessionId && api.openRdpExternal(pane.sessionId).catch((e) => toast(errorMessage(e), true))}
          title="Open in the native client (Windows App / mstsc): smoother, hardware video decoding"
        >
          Open in native client
        </button>
      </div>
      <div className="rdp-screen">
        <div className="rdp-host" ref={host} />
        {pane.state === 'connecting' && !error && <div className="rdp-overlay">Connecting to {pane.title}…</div>}
        {error && (
          <div className="rdp-overlay error">
            <div>{error.text}</div>
            {error.detail && <div className="muted small">{error.detail}</div>}
            <button className="primary" onClick={() => reconnectRdp(pane.id)}>
              Reconnect
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
