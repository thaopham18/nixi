import { useState, type ReactNode } from 'react'
import type { Session, Tunnel, TunnelStatus, TunnelType } from '@shared/types'
import { api, isMac, uid } from '../api'
import { toast, useStore } from '../store'
import { Modal } from './Overlays'

const thisComputer = isMac ? 'This Mac' : 'This computer'
const inText = isMac ? 'this Mac' : 'this computer'

const types: { type: TunnelType; title: string; flag: string; text: string }[] = [
  { type: 'L', title: 'Reach a remote service', flag: '-L', text: `Open a port on ${inText} that leads to a host the server can reach.` },
  { type: 'D', title: 'Browse through the server', flag: '-D', text: `A SOCKS5 proxy on ${inText}; traffic leaves from the server.` },
  { type: 'R', title: 'Share a local service', flag: '-R', text: `Open a port on the server that leads back to ${inText}.` }
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
const sessionAddr = (s: Session | undefined): string =>
  s ? `${s.username ? s.username + '@' : ''}${s.host ?? ''}${s.port && s.port !== 22 ? ':' + s.port : ''}` : 'no session'

function describe(t: Tunnel, server: Session | undefined): string {
  if (t.type === 'D') return `SOCKS ${addr(t.bindHost, t.bindPort)} via ${server?.name ?? 'SSH'}`
  if (t.type === 'L') return `${addr(t.bindHost, t.bindPort)} → ${addr(t.destHost, t.destPort)} via ${server?.name ?? 'SSH'}`
  return `${server?.name ?? 'server'}:${t.bindPort} → ${addr(t.destHost, t.destPort)}`
}

/** The three hops in the order traffic flows, left to right. */
interface Hop {
  kind: 'local' | 'server' | 'dest'
  icon: string
  role: string
  main: string
  note?: string
}

function hopsOf(t: Tunnel, server: Session | undefined, jump: Session | undefined): Hop[] {
  const serverHop = (main: string, note?: string): Hop => ({
    kind: 'server',
    icon: '🖥',
    role: 'SSH server',
    main,
    note: note ?? (jump ? `${server?.name ?? ''} · via ${jump.name}` : server?.name)
  })
  if (t.type === 'L')
    return [
      { kind: 'local', icon: '💻', role: thisComputer, main: addr(t.bindHost, t.bindPort), note: 'listens here' },
      serverHop(sessionAddr(server)),
      { kind: 'dest', icon: '🎯', role: 'Destination', main: addr(t.destHost, t.destPort), note: 'as seen from the server' }
    ]
  if (t.type === 'D')
    return [
      { kind: 'local', icon: '💻', role: thisComputer, main: `socks5://${addr(t.bindHost, t.bindPort)}`, note: 'listens here' },
      serverHop(sessionAddr(server)),
      { kind: 'dest', icon: '🌐', role: 'Any host', main: 'chosen by each app', note: 'traffic leaves from the server' }
    ]
  return [
    serverHop(`${server?.host ?? 'server'}:${t.bindPort || '?'}`, `listens here (${t.bindHost || 'localhost'})`),
    { kind: 'local', icon: '💻', role: thisComputer, main: 'back through SSH', note: 'forwards the connection' },
    { kind: 'dest', icon: '🎯', role: 'Destination', main: addr(t.destHost, t.destPort), note: `as seen from ${inText}` }
  ]
}

/** Label on the arrow between two hops: what kind of link it is. */
function linkOf(t: Tunnel, i: number): { text: string; secure: boolean } {
  const ssh = { text: 'SSH, encrypted', secure: true }
  if (t.type === 'R') return i === 0 ? ssh : { text: 'TCP', secure: false }
  return i === 0 ? ssh : { text: t.type === 'D' ? 'TCP, any port' : 'TCP', secure: false }
}

function Flow({ t, server, jump, slots }: { t: Tunnel; server?: Session; jump?: Session; slots?: Partial<Record<Hop['kind'], ReactNode>> }): JSX.Element {
  const hops = hopsOf(t, server, jump)
  return (
    <div className={`tunnel-flow ${slots ? 'big' : ''}`}>
      {hops.map((h, i) => (
        <div className="tunnel-step" key={h.kind}>
          {i > 0 && (
            <div className={`tunnel-link ${linkOf(t, i - 1).secure ? 'secure' : ''}`}>
              <span>{linkOf(t, i - 1).text}</span>
            </div>
          )}
          <div className={`tunnel-hop ${h.kind}`}>
            <div className="hop-head">
              <span className="hop-icon">{h.icon}</span>
              <span className="hop-role">{h.role}</span>
            </div>
            {slots?.[h.kind] ?? (
              <>
                <div className="hop-main mono">{h.main}</div>
                {h.note && <div className="hop-note">{h.note}</div>}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
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
  const close = (): void => useStore.setState({ modal: null })
  const sessionOf = (id: string | undefined): Session | undefined => allSessions.find((s) => s.id === id)

  const persist = async (list: Tunnel[]): Promise<void> => {
    useStore.setState({ tunnels: await api.saveTunnels(list) })
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

  const saveEdit = async (): Promise<void> => {
    if (!edit) return
    if (!edit.sessionId) return toast('Pick an SSH session', true)
    if (!edit.bindPort) return toast('A listening port is required', true)
    if (edit.type !== 'D' && (!edit.destHost || !edit.destPort)) return toast('Destination is required', true)
    const t = { ...edit, name: edit.name || describe(edit, sessionOf(edit.sessionId)) }
    const exists = tunnels.some((x) => x.id === t.id)
    await persist(exists ? tunnels.map((x) => (x.id === t.id ? t : x)) : [...tunnels, t])
    setEdit(undefined)
  }

  const set = <K extends keyof Tunnel>(k: K, v: Tunnel[K]): void => setEdit((e) => (e ? { ...e, [k]: v } : e))

  if (edit) {
    const server = sessionOf(edit.sessionId)
    const jump = sessionOf(server?.jumpSessionId)
    const hostPort = (hostKey: 'bindHost' | 'destHost', portKey: 'bindPort' | 'destPort', hostLabel: string, portLabel: string): JSX.Element => (
      <div className="hop-fields">
        <label>
          <span>{hostLabel}</span>
          <input className="mono" value={edit[hostKey] ?? ''} onChange={(e) => set(hostKey, e.target.value)} />
        </label>
        <label className="port">
          <span>{portLabel}</span>
          <input className="mono" type="number" value={edit[portKey] ?? ''} onChange={(e) => set(portKey, Number(e.target.value))} />
        </label>
      </div>
    )
    const serverSlot = (
      <div className="hop-fields column">
        <select value={edit.sessionId} onChange={(e) => set('sessionId', e.target.value)}>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="hop-note mono">{sessionAddr(server)}</div>
        {jump && <div className="hop-note">via jump host {jump.name}</div>}
        {edit.type === 'R' && hostPort('bindHost', 'bindPort', 'Listen on (server)', 'Port')}
      </div>
    )
    const slots: Partial<Record<Hop['kind'], ReactNode>> = {
      server: serverSlot,
      local:
        edit.type === 'R' ? (
          <div className="hop-note">Receives the connection through SSH and opens it to the destination.</div>
        ) : (
          hostPort('bindHost', 'bindPort', 'Listen on', 'Port')
        ),
      dest:
        edit.type === 'D' ? (
          <div className="hop-note">Each app connecting through the proxy picks its own destination.</div>
        ) : (
          <>
            {hostPort('destHost', 'destPort', 'Host', 'Port')}
            <div className="hop-note">
              {edit.type === 'L'
                ? '"localhost" = the SSH server itself'
                : `"localhost" = ${inText}`}
            </div>
          </>
        )
    }
    const tryIt =
      edit.type === 'L'
        ? `Connect to ${addr(edit.bindHost, edit.bindPort)} on ${inText} → you reach ${addr(edit.destHost, edit.destPort)} as the server sees it.`
        : edit.type === 'D'
          ? `Set the browser / app proxy to SOCKS5 ${addr(edit.bindHost, edit.bindPort)}; sites see the server's address.`
          : `Whoever connects to port ${edit.bindPort || '?'} on ${server?.host ?? 'the server'} reaches ${addr(edit.destHost, edit.destPort)} from ${inText}.`

    return (
      <Modal title={tunnels.some((x) => x.id === edit.id) ? 'Edit tunnel' : 'New tunnel'} onClose={close} wide>
        <div className="tunnel-types">
          {types.map((k) => (
            <button key={k.type} className={edit.type === k.type ? 'active' : ''} onClick={() => set('type', k.type)}>
              <span className="tt-title">
                {k.title} <span className="tt-flag">{k.flag}</span>
              </span>
              <span className="tt-text">{k.text}</span>
            </button>
          ))}
        </div>
        <div className="tunnel-flow-caption">Traffic flows →</div>
        <Flow t={edit} server={server} jump={jump} slots={slots} />
        <p className="tunnel-try">{tryIt}</p>
        {edit.type === 'L' && (
          <div className="tunnel-presets">
            <span className="muted small">Common:</span>
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
                {p.label} <span className="muted">{p.port}</span>
              </button>
            ))}
          </div>
        )}
        <div className="grid2">
          <label className="field">
            <span>Name</span>
            <input value={edit.name} onChange={(e) => set('name', e.target.value)} placeholder={describe(edit, server)} />
          </label>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={edit.autoStart} onChange={(e) => set('autoStart', e.target.checked)} /> Start
            automatically when Nixi opens
          </label>
        </div>
        <div className="row end">
          <button onClick={() => setEdit(undefined)}>Back</button>
          <button className="primary" onClick={() => void saveEdit()}>
            Save tunnel
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="SSH tunnels" onClose={close} wide>
      <div className="tunnel-list">
        {tunnels.map((t) => {
          const st = status[t.id]
          const state = st?.state ?? 'stopped'
          const running = state === 'running' || state === 'starting'
          const server = sessionOf(t.sessionId)
          return (
            <div className={`tunnel-card ${state}`} key={t.id}>
              <div className="tunnel-card-head">
                <span className={`dot ${statusDot(st)}`} />
                <span className="tunnel-name">{t.name}</span>
                <span className="badge">{types.find((k) => k.type === t.type)?.flag}</span>
                {t.autoStart && <span className="badge">auto</span>}
                <span className="tunnel-status" title={st?.error}>
                  {state}
                  {state === 'running' ? ` · ${st!.connections} conn` : ''}
                </span>
                <span className="spacer" />
                {running ? (
                  <button onClick={() => void api.stopTunnel(t.id)}>Stop</button>
                ) : (
                  <button className="primary" onClick={() => void api.startTunnel(t.id)}>
                    Start
                  </button>
                )}
                <button onClick={() => setEdit(t)}>Edit</button>
                <button
                  className="danger"
                  title="Delete"
                  onClick={() => window.confirm(`Delete tunnel "${t.name}"?`) && void persist(tunnels.filter((x) => x.id !== t.id))}
                >
                  ✕
                </button>
              </div>
              <Flow t={t} server={server} jump={sessionOf(server?.jumpSessionId)} />
              {st?.error && <div className="error-line small">{st.error}</div>}
            </div>
          )
        })}
      </div>
      {!tunnels.length && (
        <div className="tunnel-empty">
          <p>A tunnel carries a connection through an SSH server:</p>
          <Flow t={blank()} server={sessions[0]} />
        </div>
      )}
      <button className="primary" disabled={!sessions.length} onClick={() => setEdit(blank())}>
        ＋ New tunnel
      </button>
      {!sessions.length && <p className="muted small">Create an SSH session first — tunnels run over a saved session.</p>}
    </Modal>
  )
}
