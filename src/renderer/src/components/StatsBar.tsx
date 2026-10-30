import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { diskPct, formatBytes, formatUptime, splitDisks, type DiskInfo, type ServerStats } from '@shared/stats'
import { api } from '../api'
import { useStore } from '../store'

/** CPU / RAM / disk / network of the SSH server, under its terminal (like MobaXterm). */
export function StatsBar({ connId }: { connId: string }): JSX.Element | null {
  const st = useStore((s) => s.serverStats[connId])

  useEffect(() => {
    api.watchStats(connId, true)
    return () => api.watchStats(connId, false)
  }, [connId])

  if (st === null) return null // the server cannot run the monitor script: no bar at all
  if (!st) return <div className="stats-bar loading">Reading server stats…</div>

  const memPct = st.memTotal ? (100 * (st.memUsed ?? 0)) / st.memTotal : undefined
  return (
    <div className="stats-bar">
      {st.host && (
        <span className="stat host" title="Host name">
          {st.host}
        </span>
      )}
      <Meter label="CPU" pct={st.cpu} text={st.cpu === undefined ? '…' : `${Math.round(st.cpu)}%`} title={st.load && `Load average ${st.load.join(' ')}`} />
      {memPct !== undefined && (
        <Meter
          label="RAM"
          pct={memPct}
          text={`${formatBytes(st.memUsed ?? 0)} / ${formatBytes(st.memTotal!)}`}
          short={`${Math.round(memPct)}%`}
          title={`${formatBytes(st.memUsed ?? 0)} / ${formatBytes(st.memTotal!)} (${Math.round(memPct)}% used)`}
        />
      )}
      <Disks st={st} />
      {st.rx !== undefined && (
        <span className="stat net" title="Network, all interfaces">
          <span className="net-down">↓</span> {formatBytes(st.rx)}/s <span className="net-up">↑</span> {formatBytes(st.tx ?? 0)}/s
        </span>
      )}
      {st.load && (
        <span className="stat load" title="Load average (1 / 5 / 15 min)">
          load {st.load[0].toFixed(2)}
        </span>
      )}
      {st.uptime !== undefined && <span className="stat uptime">up {formatUptime(st.uptime)}</span>}
      {!!st.users && (
        <span className="stat users" title="Logged-in sessions">
          👤 {st.users}
        </span>
      )}
    </div>
  )
}

const levelOf = (pct: number | undefined): string => (pct === undefined ? '' : pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low')

function Bar({ pct }: { pct?: number }): JSX.Element {
  return (
    <span className="meter-track">
      <span className="meter-fill" style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
    </span>
  )
}

/** Where a hover popup goes: above the hovered item, from its left edge. */
function useHoverPopup(enabled: boolean): [{ left: number; bottom: number } | undefined, React.HTMLAttributes<HTMLElement>] {
  const [at, setAt] = useState<{ left: number; bottom: number }>()
  return [
    at,
    {
      onMouseEnter: (e) => {
        if (!enabled) return
        const r = e.currentTarget.getBoundingClientRect()
        setAt({ left: r.left, bottom: window.innerHeight - r.top + 6 })
      },
      onMouseLeave: () => setAt(undefined)
    }
  ]
}

const MAX_DISKS = 5

/**
 * Every mount the user has (fullest first, up to MAX_DISKS) with its own bar and %; boot / EFI /
 * macOS system volumes and anything past MAX_DISKS only in the popup, which lists all of them.
 */
function Disks({ st }: { st: ServerStats }): JSX.Element | null {
  const { user, system } = splitDisks(st.disks)
  const [at, hover] = useHoverPopup(user.length > 0)
  if (!user.length) {
    // Server without a df listing: just "/" from the summary line.
    if (!st.diskTotal) return null
    const pct = (100 * (st.diskUsed ?? 0)) / st.diskTotal
    return <Meter label="Disk" pct={pct} text={`${Math.round(pct)}% of ${formatBytes(st.diskTotal)}`} short={`${Math.round(pct)}%`} />
  }
  const shown = user.slice(0, MAX_DISKS)
  return (
    <span className="stat disks has-popup" {...hover}>
      <span className="meter-label">Disk</span>
      {shown.map((d, i) => (
        <span key={d.mount} className={`disk-chip meter ${levelOf(diskPct(d))} ${i ? 'more' : ''}`}>
          <span className="disk-mount mono">{d.mount}</span>
          <Bar pct={diskPct(d)} />
          <span className="meter-text">{Math.round(diskPct(d))}%</span>
        </span>
      ))}
      {user.length > shown.length && <span className="disk-extra">+{user.length - shown.length}</span>}
      {at && (
        <Popup {...at}>
          <DiskTable user={user} system={system} />
        </Popup>
      )}
    </span>
  )
}

/** A labelled usage bar; `popup` shows above the stats bar while hovered (fixed, so the bar does not clip it). */
/** `short` replaces `text` when the bar is narrow (see .stats-bar container queries). */
function Meter(props: { label: string; pct?: number; text: ReactNode; short?: string; title?: string; popup?: ReactNode }): JSX.Element {
  const [at, hover] = useHoverPopup(!!props.popup)
  return (
    <span className={`stat meter ${levelOf(props.pct)} ${props.popup ? 'has-popup' : ''}`} title={props.title} {...hover}>
      <span className="meter-label">{props.label}</span>
      <Bar pct={props.pct} />
      <span className="meter-text">
        {props.short ? (
          <>
            <span className="long">{props.text}</span>
            <span className="short">{props.short}</span>
          </>
        ) : (
          props.text
        )}
      </span>
      {at && props.popup && <Popup {...at}>{props.popup}</Popup>}
    </span>
  )
}

/** Starts at the meter's left edge; slides left as needed to stay inside the window. */
function Popup({ left, bottom, children }: { left: number; bottom: number; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [x, setX] = useState(left)
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0
    setX(Math.max(8, Math.min(left, window.innerWidth - w - 8)))
  }, [left])
  return (
    <div ref={ref} className="stats-popup" style={{ left: x, bottom }}>
      {children}
    </div>
  )
}

function DiskRow({ d }: { d: DiskInfo }): JSX.Element {
  const pct = diskPct(d)
  return (
    <tr className={`meter ${levelOf(pct)}`}>
      <td className="mono mount">{d.mount}</td>
      <td className="mono muted">{d.source}</td>
      <td className="num">{formatBytes(d.total)}</td>
      <td className="num">{formatBytes(d.used)}</td>
      <td className="num">{formatBytes(d.total - d.used)}</td>
      <td>
        <span className="use">
          <Bar pct={pct} />
          <span className="meter-text">{Math.round(pct)}%</span>
        </span>
      </td>
    </tr>
  )
}

function DiskTable({ user, system }: { user: DiskInfo[]; system: DiskInfo[] }): JSX.Element {
  return (
    <table className="disk-table">
      <thead>
        <tr>
          <th>Mounted on</th>
          <th>Device</th>
          <th className="num">Size</th>
          <th className="num">Used</th>
          <th className="num">Free</th>
          <th>Use</th>
        </tr>
      </thead>
      <tbody>
        {user.map((d) => (
          <DiskRow key={d.mount} d={d} />
        ))}
      </tbody>
      {!!system.length && (
        <tbody className="system">
          <tr className="section">
            <td colSpan={6}>System</td>
          </tr>
          {system.map((d) => (
            <DiskRow key={d.mount} d={d} />
          ))}
        </tbody>
      )}
    </table>
  )
}
