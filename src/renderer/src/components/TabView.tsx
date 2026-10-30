import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { findPane, useStore, type Layout, type Pane, type Tab } from '../store'
import { connectPane, createTerminal, fitPane, getEntry, repaintAll } from '../terminals'
import { closePane, openSessionInSplit } from '../actions'
import { StatsBar } from './StatsBar'
import { RdpPane } from './RdpPane'

export function TabView({ tab, visible }: { tab: Tab; visible: boolean }): JSX.Element {
  const [zoomed, setZoomed] = useState<string>()
  const ref = useRef<HTMLDivElement>(null)
  const zoomedPane = zoomed && tab.panes.some((p) => p.id === zoomed) ? zoomed : undefined
  const n = tab.panes.length
  const grid = tab.direction === 'grid' && n > 1 && !zoomedPane
  const cols = Math.ceil(Math.sqrt(n))
  const style = grid
    ? { display: visible ? 'grid' : 'none', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: 'minmax(0, 1fr)' }
    : { display: visible ? 'flex' : 'none', flexDirection: tab.direction === 'column' ? ('column' as const) : ('row' as const) }

  const header = (p: Pane, extra?: ReactNode): ReactNode =>
    n > 1 ? (
      <PaneHeader
        pane={p}
        zoomed={zoomedPane === p.id}
        onZoom={() => setZoomed(zoomedPane === p.id ? undefined : p.id)}
        extra={extra}
      />
    ) : (
      extra && <PaneHeader pane={p} extra={extra} />
    )

  return (
    <div className={`tab-view ${grid ? 'grid' : ''} ${n > 1 && !zoomedPane ? 'split' : ''}`} style={style} ref={ref}>
      {tab.panes.map((p, i) => {
        const hidden = Boolean(zoomedPane && zoomedPane !== p.id)
        const flex = grid || zoomedPane ? undefined : `${p.size ?? 1} 1 0`
        return (
          <Fragment key={p.id}>
            {i > 0 && !grid && !zoomedPane && <Divider tab={tab} index={i} container={ref} />}
            <div
              className={`pane ${tab.activePaneId === p.id ? 'active' : ''}`}
              style={{ flex, display: hidden ? 'none' : undefined }}
              onMouseDown={() => focusPane(tab, p)}
            >
              {p.kind === 'rdp' ? (
                <RdpPane pane={p} visible={visible && !hidden} active={tab.activePaneId === p.id} header={header(p)} />
              ) : (
                <TerminalPane pane={p} tab={tab} visible={visible && !hidden} header={(extra) => header(p, extra)} />
              )}
            </div>
          </Fragment>
        )
      })}
      {visible && <DropZones tab={tab} />}
    </div>
  )
}

function focusPane(tab: Tab, pane: Pane): void {
  if (tab.activePaneId !== pane.id)
    useStore.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, activePaneId: pane.id } : t)) }))
}

function PaneHeader(props: { pane: Pane; zoomed?: boolean; onZoom?: () => void; extra?: ReactNode }): JSX.Element {
  const { pane } = props
  return (
    <div className="pane-header" onDoubleClick={props.onZoom}>
      <span className={`dot ${pane.state}`} />
      <span className="pane-title">{pane.title}</span>
      {props.extra}
      {props.onZoom && (
        <>
          <button className="icon" onClick={props.onZoom} title={props.zoomed ? 'Restore split' : 'Maximize this pane'}>
            {props.zoomed ? '🗗' : '🗖'}
          </button>
          <button className="icon" onClick={() => useStore.getState().detachPane(pane.id)} title="Move to its own tab">
            ⇱
          </button>
          <button className="icon" onClick={() => closePane(pane.id)} title="Close pane">
            ✕
          </button>
        </>
      )}
    </div>
  )
}

/** Drag handle between two panes of a side-by-side / stacked split. */
function Divider({ tab, index, container }: { tab: Tab; index: number; container: React.RefObject<HTMLDivElement> }): JSX.Element {
  const vertical = tab.direction !== 'column'
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const paneEls = Array.from(container.current!.children).filter((c) => c.classList.contains('pane')) as HTMLElement[]
    const aEl = paneEls[index - 1]
    const bEl = paneEls[index]
    const a = tab.panes[index - 1]
    const b = tab.panes[index]
    const aPx = vertical ? aEl.offsetWidth : aEl.offsetHeight
    const bPx = vertical ? bEl.offsetWidth : bEl.offsetHeight
    const weight = (a.size ?? 1) + (b.size ?? 1)
    const start = vertical ? e.clientX : e.clientY
    const move = (ev: MouseEvent): void => {
      const delta = (vertical ? ev.clientX : ev.clientY) - start
      const ratio = Math.min(0.9, Math.max(0.1, (aPx + delta) / (aPx + bPx)))
      useStore.getState().resizePanes(tab.id, { [a.id]: ratio * weight, [b.id]: (1 - ratio) * weight })
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return <div className={`divider ${vertical ? 'v' : 'h'}`} onMouseDown={onMouseDown} />
}

const zones: { id: string; layout: Layout; prepend: boolean; label: string }[] = [
  { id: 'left', layout: 'row', prepend: true, label: 'Left' },
  { id: 'right', layout: 'row', prepend: false, label: 'Right' },
  { id: 'top', layout: 'column', prepend: true, label: 'Top' },
  { id: 'bottom', layout: 'column', prepend: false, label: 'Bottom' },
  { id: 'center', layout: 'grid', prepend: false, label: 'Grid' }
]

/** While a tab or session is dragged, offer to drop it into this view as a split. */
function DropZones({ tab }: { tab: Tab }): JSX.Element | null {
  const dragging = useStore((s) => s.dragging)
  const [over, setOver] = useState<string>()
  if (!dragging || (dragging.kind === 'tab' && dragging.id === tab.id)) return null
  const drop = (z: (typeof zones)[number]): void => {
    const s = useStore.getState()
    s.set({ dragging: undefined })
    if (dragging.kind === 'tab') s.mergeTab(dragging.id, tab.id, z.layout, z.prepend)
    else {
      const session = s.sessions.find((x) => x.id === dragging.id)
      if (session) openSessionInSplit(session, tab.id, z.layout, z.prepend)
    }
  }
  return (
    <div className="drop-zones">
      {zones.map((z) => (
        <div
          key={z.id}
          className={`drop-zone ${z.id} ${over === z.id ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(z.id)
          }}
          onDragLeave={() => setOver(undefined)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(undefined)
            drop(z)
          }}
        >
          <span>{z.label}</span>
        </div>
      ))}
    </div>
  )
}

function TerminalPane(props: {
  pane: Pane
  tab: Tab
  visible: boolean
  header: (extra?: ReactNode) => ReactNode
}): JSX.Element {
  const { pane, tab, visible } = props
  const ref = useRef<HTMLDivElement>(null)
  const multiExec = useStore((s) => s.multiExec)
  const excluded = useStore((s) => Boolean(s.multiExecExcluded[pane.id]))
  const searchOpen = useStore((s) => s.searchOpen)
  const showStats = useStore((s) => s.settings?.serverStats ?? true)
  const isActive = tab.activePaneId === pane.id

  useEffect(() => {
    const el = ref.current!
    createTerminal(pane.id, el)
    const ro = new ResizeObserver(() => fitPane(pane.id))
    ro.observe(el)
    fitPane(pane.id)
    if (findPane(pane.id)?.state === 'idle') void connectPane(pane.id)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id])

  useEffect(() => {
    if (visible) {
      fitPane(pane.id)
      repaintAll() // coming back into view: redraw with a fresh glyph atlas
    }
  }, [visible, pane.id])

  useEffect(() => {
    if (visible && isActive) getEntry(pane.id)?.term.focus()
  }, [visible, isActive, pane.id])

  const sending = multiExec && !excluded
  const multiExecToggle = multiExec && (
    <label title="Include this terminal in multi-exec">
      <input
        type="checkbox"
        checked={!excluded}
        onChange={(e) =>
          useStore.setState((s) => ({
            multiExecExcluded: { ...s.multiExecExcluded, [pane.id]: !e.target.checked }
          }))
        }
      />
      multi-exec
    </label>
  )
  return (
    <div className={`term-pane ${sending ? 'sending' : ''}`}>
      {props.header(multiExecToggle || undefined)}
      {searchOpen && isActive && visible && <SearchBar paneId={pane.id} />}
      <div className="term-container" ref={ref} />
      {showStats && pane.isSsh && pane.state === 'connected' && pane.connId && <StatsBar connId={pane.connId} />}
    </div>
  )
}

function SearchBar({ paneId }: { paneId: string }): JSX.Element {
  const [q, setQ] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCase] = useState(false)
  const opts = { regex, caseSensitive, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#fc0', matchBackground: '#665500', activeMatchBackground: '#aa7700' } }
  const search = getEntry(paneId)?.search
  const close = (): void => {
    search?.clearDecorations()
    useStore.setState({ searchOpen: false })
    getEntry(paneId)?.term.focus()
  }
  return (
    <div className="search-bar">
      <input
        autoFocus
        placeholder="Find…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          search?.findNext(e.target.value, { ...opts, incremental: true })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.shiftKey ? search?.findPrevious(q, opts) : search?.findNext(q, opts)
          if (e.key === 'Escape') close()
        }}
      />
      <label>
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setCase(e.target.checked)} />
        Aa
      </label>
      <label>
        <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
        .*
      </label>
      <button className="icon" onClick={() => search?.findPrevious(q, opts)}>
        ↑
      </button>
      <button className="icon" onClick={() => search?.findNext(q, opts)}>
        ↓
      </button>
      <button className="icon" onClick={close}>
        ✕
      </button>
    </div>
  )
}
