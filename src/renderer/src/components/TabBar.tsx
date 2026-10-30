import { useEffect, useRef, useState } from 'react'
import { promptText, showMenu, useStore, type Tab } from '../store'
import { closeTab, closeTabsAround, duplicateTab, openLocal, tileAllTabs, togglePin, untileTab } from '../actions'
import { ToolIcon } from './Icons'

function tabState(t: Tab): string {
  if (t.panes.some((p) => p.state === 'connecting')) return 'connecting'
  if (t.panes.every((p) => p.state === 'connected')) return 'connected'
  return 'closed'
}

export function TabBar(): JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const activity = useStore((s) => s.activity)
  const [dragId, setDragId] = useState<string>()
  const strip = useRef<HTMLDivElement>(null)

  // ‹ › only when the tabs do not fit; each disabled at its end.
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false })
  const measure = (): void => {
    const el = strip.current
    if (!el) return
    const next = {
      overflow: el.scrollWidth > el.clientWidth + 1,
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    }
    setScroll((s) => (s.overflow === next.overflow && s.left === next.left && s.right === next.right ? s : next))
  }
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const scrollBy = (dir: -1 | 1): void => strip.current?.scrollBy({ left: dir * strip.current.clientWidth * 0.7, behavior: 'smooth' })

  // Keep the active tab in view when the strip scrolls (many tabs), with the strip's padding
  // (room for the open tab's curves) so the last tab reaches the end.
  useEffect(() => {
    const el = strip.current
    const tab = el?.querySelector<HTMLElement>('.tab.active')
    if (el && tab) {
      const pad = 12
      if (tab.offsetLeft - pad < el.scrollLeft) el.scrollLeft = tab.offsetLeft - pad
      else if (tab.offsetLeft + tab.offsetWidth + pad > el.scrollLeft + el.clientWidth)
        el.scrollLeft = tab.offsetLeft + tab.offsetWidth + pad - el.clientWidth
    }
    measure()
  }, [activeTabId, tabs.length])

  const rename = async (t: Tab): Promise<void> => {
    const title = await promptText({ title: 'Rename tab', value: t.title })
    if (title)
      useStore.setState((s) => ({
        tabs: s.tabs.map((x) => (x.id === t.id ? { ...x, title } : x))
      }))
  }

  const drop = (targetId: string): void => {
    if (!dragId || dragId === targetId) return
    useStore.setState((s) => {
      const tabs = [...s.tabs]
      const from = tabs.findIndex((t) => t.id === dragId)
      const [moved] = tabs.splice(from, 1)
      const to = tabs.findIndex((t) => t.id === targetId)
      tabs.splice(from <= to ? to + 1 : to, 0, moved)
      // A tab dropped among the pinned ones does not pin it (and vice versa): pinned stay first.
      return {
        tabs: [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]
      }
    })
  }

  return (
    <div className="tabbar">
      {scroll.overflow && (
        <div className="tab-nav">
          <button disabled={!scroll.left} onClick={() => scrollBy(-1)} title="Scroll tabs left">
            <ToolIcon name="chevLeft" />
          </button>
          <button disabled={!scroll.right} onClick={() => scrollBy(1)} title="Scroll tabs right">
            <ToolIcon name="chevRight" />
          </button>
        </div>
      )}
      <div
        className="tab-strip"
        ref={strip}
        onScroll={measure}
        onWheel={(e) => {
          // A plain mouse wheel scrolls the tabs sideways.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        {/* No tab open: the welcome page is itself the open tab, so the frame has a tab to hang
            from; it goes away by itself with the first real tab. */}
        {!tabs.length && (
          <div className="tab active welcome-tab" title="Welcome">
            <span className="tab-pin">
              <ToolIcon name="home" />
            </span>
            <span className="tab-title">Welcome</span>
          </div>
        )}
        {tabs.map((t, i) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? 'active' : ''} ${t.pinned ? 'pinned' : ''} ${activity[t.id] && t.id !== activeTabId ? 'activity' : ''}`}
            style={t.color ? ({ '--tab-color': t.color } as React.CSSProperties) : undefined}
            draggable
            onDragStart={(e) => {
              setDragId(t.id)
              e.dataTransfer.setData('application/x-nixi-tab', t.id)
              e.dataTransfer.effectAllowed = 'move'
              // Drop zones appear over the open tab view: drop there to split.
              setTimeout(() => useStore.setState({ dragging: { kind: 'tab', id: t.id } }), 0)
            }}
            onDragEnd={() => useStore.setState({ dragging: undefined })}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(t.id)}
            onClick={() => useStore.setState({ activeTabId: t.id })}
            onDoubleClick={() => void rename(t)}
            onAuxClick={(e) => e.button === 1 && !t.pinned && closeTab(t.id)}
            onContextMenu={(e) => {
              const others = tabs.filter((x) => x.id !== t.id)
              const s = useStore.getState()
              const closable = (list: Tab[]): boolean => list.some((x) => !x.pinned)
              showMenu(e, [
                {
                  label: t.pinned ? 'Unpin tab' : 'Pin tab',
                  onClick: () => togglePin(t.id)
                },
                { label: 'Duplicate', onClick: () => duplicateTab(t.id) },
                { label: 'Rename…', onClick: () => void rename(t) },
                { label: '-', onClick: () => {} },
                ...others.map((o) => ({
                  label: `Split with “${o.title}”`,
                  onClick: () => s.mergeTab(o.id, t.id, 'row')
                })),
                ...(others.length > 1
                  ? [
                      {
                        label: 'Tile all tabs here (grid)',
                        onClick: () => {
                          useStore.setState({ activeTabId: t.id })
                          tileAllTabs()
                        }
                      }
                    ]
                  : []),
                ...(t.panes.length > 1
                  ? [
                      ...(['row', 'column', 'grid'] as const).map((layout) => ({
                        label: `Layout: ${{ row: 'side by side', column: 'stacked', grid: 'grid' }[layout]}${t.direction === layout ? '  ✓' : ''}`,
                        onClick: () => {
                          s.setLayout(t.id, layout)
                          useStore.setState({ activeTabId: t.id })
                        }
                      })),
                      {
                        label: 'Untile (one tab per session)',
                        onClick: () => untileTab(t.id)
                      }
                    ]
                  : []),
                { label: '-', onClick: () => {} },
                { label: 'Close', onClick: () => closeTab(t.id) },
                {
                  label: 'Close others',
                  disabled: !closable(others),
                  onClick: () => closeTabsAround(t.id, 'others')
                },
                {
                  label: 'Close tabs to the left',
                  disabled: !closable(tabs.slice(0, i)),
                  onClick: () => closeTabsAround(t.id, 'left')
                },
                {
                  label: 'Close tabs to the right',
                  disabled: !closable(tabs.slice(i + 1)),
                  onClick: () => closeTabsAround(t.id, 'right')
                },
                {
                  label: 'Close all',
                  disabled: !closable(tabs),
                  onClick: () => closeTabsAround(t.id, 'all')
                }
              ])
            }}
            title={t.pinned ? `${t.title} (pinned)` : t.title}
          >
            {t.color && <span className="tab-color" />}
            <span className={`dot ${tabState(t)}`} />
            {t.pinned && (
              <span className="tab-pin" title="Pinned: right-click → Unpin">
                <ToolIcon name="pin" />
              </span>
            )}
            <span className="tab-title">{t.title}</span>
            {t.panes.length > 1 && (
              <span className="tab-count" title={`${t.panes.length} panes`}>
                {t.panes.length}
              </span>
            )}
            {!t.pinned && (
              <>
                <button
                  className="tab-dup"
                  title="Duplicate tab (new connection)"
                  onClick={(e) => {
                    e.stopPropagation()
                    duplicateTab(t.id)
                  }}
                >
                  ⧉
                </button>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.id)
                  }}
                >
                  ✕
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {/* Outside the scrolling strip: always at the right end, however many tabs there are. */}
      <button className="tab-add" onClick={openLocal} title="New local terminal">
        <ToolIcon name="plus" />
      </button>
    </div>
  )
}
