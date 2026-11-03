import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Session, Tunnel, TunnelServer, TunnelStatus, TunnelType } from '@shared/types'
import { formatSshAddress, parseSshAddress } from '@shared/parse'
import { api, isMac, uid } from '../api'
import { toast, useStore } from '../store'
import { Modal } from './Overlays'
import { ToolIcon } from './Icons'

const thisComputer = isMac ? 'This Mac' : 'This computer'
const inText = isMac ? 'this Mac' : 'this computer'

const types: { type: TunnelType; title: string; flag: string; text: string }[] = [
  { type: 'L', title: 'Reach a remote service', flag: '-L', text: `Open a port on ${inText} that leads to a host the server can reach.` },
  { type: 'R', title: 'Share a local service', flag: '-R', text: `Open a port on the server that leads back to ${inText}.` },
  { type: 'D', title: 'SOCKS proxy', flag: '-D', text: `A proxy on ${inText}. Apps using it reach the network from the server.` }
]

/** Common services for -L: sets the destination port (and the local one, if still the default). */
const presets: { label: string; port: number }[] = [
  { label: 'Web', port: 80 },
  { label: 'HTTPS', port: 443 },
  { label: 'MySQL', port: 3306 },
  { label: 'PostgreSQL', port: 5432 },
  { label: 'Redis', port: 6379 },
  { label: 'RDP', port: 3389 }
]

const addr = (host: string | undefined, port: number | undefined): string => `${host || '?'}:${port || '?'}`
const sessionAddr = (s: Session): string => formatSshAddress({ host: s.host ?? '', port: s.port || 22, username: s.username ?? '' })
const serverName = (t: Tunnel, session: Session | undefined): string => (t.server ? formatSshAddress(t.server) : (session?.name ?? 'no server'))

function describe(t: Tunnel, session: Session | undefined): string {
  const via = serverName(t, session)
  if (t.type === 'D') return `SOCKS ${addr(t.bindHost, t.bindPort)} via ${via}`
  if (t.type === 'L') return `${addr(t.bindHost, t.bindPort)} → ${addr(t.destHost, t.destPort)} via ${via}`
  return `${via} :${t.bindPort} → ${addr(t.destHost, t.destPort)}`
}

/** One line in the order traffic flows. The green arrow is the part SSH encrypts. */
function Route({ t, session }: { t: Tunnel; session?: Session }): JSX.Element {
  const server = serverName(t, session)
  const secure = <span className="route-arrow secure" title="SSH, encrypted" />
  const plain = <span className="route-arrow" title="Plain TCP, from there on" />
  const hop = (text: string, label?: string): JSX.Element => (
    <span className="route-hop" title={label ? `${label} ${text}` : text}>
      {label && <span className="route-label">{label}</span>}
      <span className="mono">{text}</span>
    </span>
  )
  if (t.type === 'R')
    return (
      <div className="tunnel-route">
        {hop(server, 'listens')}
        <span className="mono route-port">:{t.bindPort}</span>
        {secure}
        {hop(thisComputer)}
        {plain}
        {hop(addr(t.destHost, t.destPort))}
      </div>
    )
  return (
    <div className="tunnel-route">
      {hop(addr(t.bindHost, t.bindPort), t.type === 'D' ? 'SOCKS' : undefined)}
      {secure}
      {hop(server)}
      {plain}
      {hop(t.type === 'D' ? 'any host' : addr(t.destHost, t.destPort))}
    </div>
  )
}

/** Text box that also opens a list. Anything typed that isn't on the list stays what was typed. */
function ServerPicker(props: { value: string; sessions: Session[]; onChange: (text: string) => void }): JSX.Element {
  const { value, sessions, onChange } = props
  const [open, setOpen] = useState(false)
  // The arrow shows every session, typing narrows them down.
  const [narrow, setNarrow] = useState(false)
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' })
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const q = value.trim().toLowerCase()
  const shown = narrow && q ? sessions.filter((s) => s.name.toLowerCase().includes(q) || sessionAddr(s).toLowerCase().includes(q)) : sessions
  const pick = (s: Session): void => {
    onChange(s.name)
    setOpen(false)
    input.current?.focus()
  }

  // Fixed, so the dialog's scroll area doesn't cut it off.
  useLayoutEffect(() => {
    if (!open || !box.current) return
    const r = box.current.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12
    const maxHeight = Math.max(below, Math.min(r.top - 12, 240))
    setPlace(below >= Math.min(160, r.top) ? { left: r.left, width: r.width, top: r.bottom + 4, maxHeight: Math.min(below, 240) } : { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4, maxHeight })
  }, [open, shown.length])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])

  return (
    <div className="combo" ref={box}>
      <input
        ref={input}
        className="server-input"
        role="combobox"
        aria-expanded={open}
        aria-label="SSH server"
        value={value}
        spellCheck={false}
        placeholder="Saved session, or user@host:port"
        onChange={(e) => {
          onChange(e.target.value)
          setNarrow(true)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open) return setOpen(true)
            if (shown.length) setActive((active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length)
          } else if (e.key === 'Enter' && open) {
            e.preventDefault()
            if (shown[active]) pick(shown[active])
            else setOpen(false)
          } else if (e.key === 'Escape' && open) {
            // Only the list: the dialog below stays open.
            e.stopPropagation()
            setOpen(false)
          }
        }}
      />
      <button
        type="button"
        className="icon combo-arrow"
        tabIndex={-1}
        title="Saved sessions"
        aria-label="Show saved sessions"
        onClick={() => {
          setNarrow(false)
          setActive(Math.max(0, sessions.findIndex((s) => s.name === value)))
          setOpen(!open)
          input.current?.focus()
        }}
      >
        <ToolIcon name="chevDown" />
      </button>
      {open && shown.length > 0 && (
        <div className="combo-list" role="listbox" style={place}>
          {shown.map((s, i) => (
            <button
              type="button"
              key={s.id}
              role="option"
              aria-selected={s.name === value}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              // Before the input loses focus.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
            >
              <span className="combo-name">{s.name}</span>
              <span className="combo-note mono">{sessionAddr(s)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** One stop on the way, with the line that leads on to the next one. */
function Stop(props: { label: string; link?: { text: string; secure?: boolean }; children: ReactNode }): JSX.Element {
  return (
    <div className="tunnel-stop">
      <div className="stop-rail">
        <span className="stop-dot" />
        {props.link && <span className={`stop-line ${props.link.secure ? 'secure' : ''}`} />}
      </div>
      <div className="stop-body">
        <div className="stop-label">{props.label}</div>
        {props.children}
        {props.link && <div className={`stop-link ${props.link.secure ? 'secure' : ''}`}>{props.link.text}</div>}
      </div>
    </div>
  )
}

function stateText(st: TunnelStatus | undefined): string {
  const state = st?.state ?? 'stopped'
  if (state === 'running') return st!.connections ? `Running · ${st!.connections} ${st!.connections === 1 ? 'connection' : 'connections'}` : 'Running'
  return state === 'starting' ? (st?.error ? 'Reconnecting…' : 'Connecting…') : state === 'error' ? 'Failed' : 'Stopped'
}

function statusDot(st: TunnelStatus | undefined): string {
  const state = st?.state ?? 'stopped'
  return state === 'running' ? 'connected' : state === 'starting' ? 'connecting' : state === 'error' ? 'error' : 'closed'
}

export function TunnelManager(): JSX.Element {
  const tunnels = useStore((s) => s.tunnels)
  const status = useStore((s) => s.tunnelStatus)
  const allSessions = useStore((s) => s.sessions)
  const sessions = allSessions.filter((s) => s.type === 'ssh')
  const [edit, setEdit] = useState<Tunnel>()
  const [serverText, setServerText] = useState('')
  const [password, setPassword] = useState('')
  const close = (): void => useStore.setState({ modal: null })
  const sessionOf = (id: string | undefined): Session | undefined => allSessions.find((s) => s.id === id)

  const persist = async (list: Tunnel[], passwords?: Record<string, string>): Promise<void> => {
    useStore.setState({ tunnels: await api.saveTunnels(list, passwords) })
  }

  const open = (t: Tunnel): void => {
    setEdit(t)
    setServerText(t.server ? formatSshAddress(t.server) : (sessionOf(t.sessionId)?.name ?? ''))
    setPassword('')
  }

  const blank = (): Tunnel => ({
    id: uid(),
    name: '',
    sessionId: sessions[0]?.id ?? '',
    type: 'L',
    bindHost: '127.0.0.1',
    bindPort: 8080,
    destHost: 'localhost',
    destPort: 80,
    autoStart: false
  })

  const set = <K extends keyof Tunnel>(k: K, v: Tunnel[K]): void => setEdit((e) => (e ? { ...e, [k]: v } : e))

  /** A saved session's name or address means that session, so its login is used. Anything else is typed by hand. */
  const typeServer = (text: string): void => {
    setServerText(text)
    const q = text.trim().toLowerCase()
    const session = sessions.find((s) => s.name.toLowerCase() === q) ?? sessions.find((s) => sessionAddr(s).toLowerCase() === q)
    const server: TunnelServer | undefined = session ? undefined : parseSshAddress(text)
    setEdit((e) => (e ? { ...e, sessionId: session?.id ?? '', server } : e))
  }

  const saved = edit && tunnels.find((x) => x.id === edit.id)
  const wasRunning = !!saved && ['running', 'starting'].includes(status[saved.id]?.state ?? '')

  const saveEdit = async (): Promise<void> => {
    if (!edit) return
    if (!edit.sessionId && !edit.server) return toast('Pick a saved session, or type the server as user@host:port', true)
    if (edit.server && password && !edit.server.username) return toast('A password needs a user name: type the server as user@host', true)
    if (!edit.bindPort) return toast('A listening port is required', true)
    if (edit.type !== 'D' && (!edit.destHost || !edit.destPort)) return toast('Destination is required', true)
    const t = { ...edit, name: edit.name || describe(edit, sessionOf(edit.sessionId)) }
    await persist(saved ? tunnels.map((x) => (x.id === t.id ? t : x)) : [...tunnels, t], password ? { [t.id]: password } : undefined)
    // A running tunnel would carry on with the old settings while the card shows the new ones.
    if (wasRunning) await api.startTunnel(t.id)
    setEdit(undefined)
  }

  if (edit) {
    const session = sessionOf(edit.sessionId)
    const jump = sessionOf(session?.jumpSessionId)
    const hostPort = (hostKey: 'bindHost' | 'destHost', portKey: 'bindPort' | 'destPort', name: string): JSX.Element => (
      <div className="host-port">
        <input className="mono" aria-label={`${name} host`} value={edit[hostKey] ?? ''} onChange={(e) => set(hostKey, e.target.value)} />
        <span className="muted">:</span>
        <input className="mono port" aria-label={`${name} port`} type="number" value={edit[portKey] || ''} onChange={(e) => set(portKey, Number(e.target.value))} />
      </div>
    )
    const samePassword = saved?.hasSecret && saved.server && edit.server && formatSshAddress(saved.server) === formatSshAddress(edit.server)
    const server = (
      <>
        <ServerPicker value={serverText} sessions={sessions} onChange={typeServer} />
        {session && (
          <div className="stop-note mono">
            {sessionAddr(session)}
            {jump ? ` · via ${jump.name}` : ''}
          </div>
        )}
        {edit.server && (
          <input
            className="server-password"
            type="password"
            aria-label="Server password"
            autoComplete="off"
            value={password}
            placeholder={samePassword ? 'Password saved. Type to change it' : 'Password. Leave empty to use your SSH key or agent'}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
        {!session && !edit.server && serverText.trim() !== '' && <div className="stop-note warn">Not a saved session, and not an address like user@host:port</div>}
      </>
    )
    const destination = (
      <>
        {hostPort('destHost', 'destPort', 'Destination')}
        <div className="stop-note">{edit.type === 'L' ? '"localhost" here means the SSH server itself' : `"localhost" here means ${inText}`}</div>
      </>
    )
    const presetRow = edit.type === 'L' && (
      <div className="tunnel-presets">
        {presets.map((p) => (
          <button
            key={p.port}
            className={edit.destPort === p.port ? 'active' : ''}
            onClick={() =>
              setEdit((e) =>
                e ? { ...e, destPort: p.port, bindPort: e.bindPort === 8080 || presets.some((x) => x.port + 10000 === e.bindPort) ? p.port + 10000 : e.bindPort } : e
              )
            }
          >
            {p.label}
          </button>
        ))}
      </div>
    )
    const secure = { text: 'SSH, encrypted', secure: true }
    const plain = { text: 'Plain TCP from here on' }
    const tryIt =
      edit.type === 'L'
        ? `Connect to ${addr(edit.bindHost, edit.bindPort)} on ${inText} to reach ${addr(edit.destHost, edit.destPort)} as the server sees it.`
        : edit.type === 'D'
          ? `Set the browser or app to use SOCKS5 proxy ${addr(edit.bindHost, edit.bindPort)}. Sites see the server's address.`
          : `Whoever connects to port ${edit.bindPort || '?'} on the server reaches ${addr(edit.destHost, edit.destPort)} from ${inText}.`

    return (
      <Modal title={saved ? 'Edit tunnel' : 'New tunnel'} onClose={close} className="tunnel-editor">
        <div className="type-picker tunnel-kind">
          {types.map((k) => (
            <button key={k.type} className={edit.type === k.type ? 'active' : ''} onClick={() => set('type', k.type)}>
              {k.title}
            </button>
          ))}
        </div>
        <p className="tunnel-kind-text">
          {types.find((k) => k.type === edit.type)?.text} <span className="mono muted">ssh {edit.type === 'R' ? '-R' : edit.type === 'L' ? '-L' : '-D'}</span>
        </p>
        <div className="tunnel-path">
          {edit.type === 'R' ? (
            <>
              <Stop label="SSH server" link={secure}>
                {server}
                <div className="stop-sub">Listens on</div>
                {hostPort('bindHost', 'bindPort', 'Listen')}
              </Stop>
              <Stop label={thisComputer} link={plain}>
                <div className="stop-note">Takes the connection back through SSH and opens it to the destination.</div>
              </Stop>
              <Stop label="Destination">{destination}</Stop>
            </>
          ) : (
            <>
              <Stop label={`${thisComputer} listens on`} link={secure}>
                {hostPort('bindHost', 'bindPort', 'Listen')}
              </Stop>
              <Stop label="SSH server" link={plain}>
                {server}
              </Stop>
              {edit.type === 'L' ? (
                <Stop label="Destination">
                  {destination}
                  {presetRow}
                </Stop>
              ) : (
                <Stop label="Destination">
                  <div className="stop-note">Any host. Each app using the proxy picks its own.</div>
                </Stop>
              )}
            </>
          )}
        </div>
        <p className="tunnel-try">{tryIt}</p>
        <label className="field">
          <span>Name</span>
          <input value={edit.name} onChange={(e) => set('name', e.target.value)} placeholder={describe(edit, session)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={edit.autoStart} onChange={(e) => set('autoStart', e.target.checked)} /> Start automatically when Nixi opens
        </label>
        <div className="row end">
          <button onClick={() => setEdit(undefined)}>Back</button>
          <button className="primary" onClick={() => void saveEdit()}>
            {wasRunning ? 'Save and restart' : 'Save tunnel'}
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="SSH tunnels" onClose={close} wide>
      {tunnels.length > 0 ? (
        <div className="tunnel-list">
          {tunnels.map((t) => {
            const st = status[t.id]
            const state = st?.state ?? 'stopped'
            const live = state === 'running' || state === 'starting'
            return (
              <div className={`tunnel-card ${state}`} key={t.id}>
                <div className="tunnel-card-head">
                  <span className={`dot ${statusDot(st)}`} />
                  <span className="tunnel-name" title={t.name}>
                    {t.name}
                  </span>
                  {t.autoStart && <span className="badge">auto</span>}
                  <span className="spacer" />
                  <span className="tunnel-status">{stateText(st)}</span>
                  {live ? (
                    <button onClick={() => void api.stopTunnel(t.id)}>Stop</button>
                  ) : (
                    <button className="primary" onClick={() => void api.startTunnel(t.id)}>
                      Start
                    </button>
                  )}
                  <button onClick={() => open(t)}>Edit</button>
                  <button
                    className="danger square"
                    title="Delete"
                    onClick={() => window.confirm(`Delete tunnel "${t.name}"?`) && void persist(tunnels.filter((x) => x.id !== t.id))}
                  >
                    <ToolIcon name="trash" />
                  </button>
                </div>
                <Route t={t} session={sessionOf(t.sessionId)} />
                {st?.error && <div className="error-line small">{st.error}</div>}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="tunnel-empty">A tunnel carries a connection through an SSH server, so you can reach what only that server can reach, or let it reach something on {inText}.</p>
      )}
      <button className="primary" onClick={() => open(blank())}>
        <ToolIcon name="plus" />
        New tunnel
      </button>
    </Modal>
  )
}
