import { useMemo, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import { buildTree, type FolderNode } from '@shared/parse'
import { api, uid } from '../api'
import { activePaneOf, promptText, showMenu, toast, useStore, type MenuItem } from '../store'
import { importFromMobaXterm, newSession, openRdpExternal, openSession, openSessionInSplit, openVncExternal } from '../actions'
import { SftpPanel } from './SftpPanel'
import { Caret, ClockIcon, FolderIcon, SessionIcon, ToolIcon } from './Icons'


export function Sidebar(): JSX.Element {
  // SFTP only makes sense on an SSH connection; the chosen tab comes back when one is focused again.
  const sftpAvailable = useStore((s) => !!activePaneOf(s)?.isSsh)
  const tab = useStore((s) => (sftpAvailable ? s.sidebarTab : 'sessions'))
  const [width, setWidth] = useState(280)
  const dragging = useRef(false)

  const startResize = (e: React.MouseEvent): void => {
    dragging.current = true
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent): void => setWidth(Math.min(600, Math.max(200, startW + ev.clientX - startX)))
    const up = (): void => {
      dragging.current = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-tabs">
        <button className={tab === 'sessions' ? 'active' : ''} onClick={() => useStore.setState({ sidebarTab: 'sessions' })}>
          Sessions
        </button>
        {sftpAvailable && (
          <button className={tab === 'sftp' ? 'active' : ''} onClick={() => useStore.setState({ sidebarTab: 'sftp' })}>
            SFTP
          </button>
        )}
      </div>
      {tab === 'sessions' ? <SessionTree /> : <SftpPanel />}
      <div className="resize-handle" onMouseDown={startResize} />
    </div>
  )
}

/** Is `folder` the folder `path` or inside it? */
const within = (folder: string, path: string): boolean => folder === path || folder.startsWith(path + '/')

function SessionTree(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const folders = useStore((s) => s.folders)
  const [filter, setFilter] = useState('')
  const collapsed = useStore((s) => s.collapsedFolders)
  const setCollapsed = (change: (c: Record<string, boolean>) => Record<string, boolean>): void =>
    useStore.setState((s) => ({ collapsedFolders: change(s.collapsedFolders) }))
  /** selected sessions; `anchor` is where a Shift+click range starts */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef<string>()
  /** the sessions being dragged inside this tree */
  const [dragIds, setDragIds] = useState<string[]>()
  /** folder under the pointer during a drag ('' = top level) */
  const [dropFolder, setDropFolder] = useState<string>()

  const filtered = useMemo(() => {
    const q = filter.toLowerCase()
    return q
      ? sessions.filter((s) => `${s.name} ${s.host ?? ''} ${s.username ?? ''} ${s.folder}`.toLowerCase().includes(q))
      : sessions
  }, [sessions, filter])
  // Empty folders only clutter search results.
  const tree = useMemo(() => buildTree(filtered, filter ? [] : folders), [filtered, folders, filter])
  const recent = useMemo(
    () => [...sessions].filter((s) => s.lastUsed).sort((a, b) => b.lastUsed! - a.lastUsed!).slice(0, 5),
    [sessions]
  )

  const save = async (list: Session[]): Promise<void> => useStore.setState({ sessions: await api.saveSessions(list) })
  const saveFolders = async (list: string[]): Promise<void> => useStore.setState({ folders: await api.saveFolders(list) })

  const newFolder = async (parent: string): Promise<void> => {
    const name = (await promptText({ title: parent ? `New folder in ${parent}` : 'New folder', label: 'Folder name' }))?.trim()
    if (!name) return
    const path = parent ? `${parent}/${name.replace(/\//g, '-')}` : name.replace(/\//g, '-')
    await saveFolders([...folders, path])
    setCollapsed((c) => ({ ...c, [parent]: false, [path]: false }))
  }

  /** "New session / New folder" (+ imports on the empty area), shared by every right-click menu. */
  const createItems = (folder: string): MenuItem[] => [
    { label: folder ? `New session in ${folder.split('/').pop()}…` : 'New session…', onClick: () => newSession(folder) },
    { label: folder ? `New folder in ${folder.split('/').pop()}…` : 'New folder…', onClick: () => void newFolder(folder) }
  ]

  const backgroundMenu = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('.tree-row')) return // rows have their own menu
    showMenu(e, [
      ...createItems(''),
      { label: '-', onClick: () => {} },
      {
        label: 'Import ~/.ssh/config',
        onClick: async () => {
          const { added, sessions } = await api.importSshConfig()
          useStore.setState({ sessions })
          toast(added ? `Imported ${added} host(s) from ~/.ssh/config` : 'No new hosts in ~/.ssh/config')
        }
      },
      { label: 'Import from MobaXterm…', onClick: () => void importFromMobaXterm() }
    ])
  }

  /** Sessions as listed on screen, top to bottom: what a Shift+click range covers. */
  const visibleIds = (f: FolderNode<Session>): string[] =>
    !f.path || !collapsed[f.path] || filter ? [...f.folders.flatMap(visibleIds), ...f.items.map((s) => s.id)] : []

  const clickRow = (e: React.MouseEvent, s: Session): void => {
    if (e.shiftKey && anchor.current) {
      const ids = visibleIds(tree)
      const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(s.id)]
      if (a >= 0 && b >= 0) return setSelected(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)))
    }
    anchor.current = s.id
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      if (!next.delete(s.id)) next.add(s.id)
      setSelected(next)
    } else setSelected(new Set([s.id]))
  }

  /** Move the dragged sessions into a folder, and open it so they stay in sight. */
  const dropInto = (folder: string): void => {
    const ids = dragIds
    setDragIds(undefined)
    setDropFolder(undefined)
    if (!ids) return
    const moved = new Set(ids)
    if (sessions.some((s) => moved.has(s.id) && s.folder !== folder)) void save(sessions.map((s) => (moved.has(s.id) ? { ...s, folder } : s)))
    // Every folder above it too, or the sessions would land out of sight.
    const parts = folder.split('/')
    setCollapsed((c) => ({ ...c, ...Object.fromEntries(parts.map((_p, i) => [parts.slice(0, i + 1).join('/'), false])) }))
    useStore.setState({ dragging: undefined })
  }

  const hoverDrop = (e: React.DragEvent, folder: string): void => {
    e.preventDefault()
    e.stopPropagation()
    if (dragIds && dropFolder !== folder) setDropFolder(folder)
  }

  /** The one thing a drag image must say: how many. */
  const dragBadge = (e: React.DragEvent, count: number): void => {
    const badge = document.createElement('div')
    badge.className = 'drag-badge'
    badge.textContent = `${count} sessions`
    document.body.appendChild(badge)
    e.dataTransfer.setDragImage(badge, 10, 10)
    setTimeout(() => badge.remove(), 0)
  }

  /** Menu of a row that is part of a multiple selection: acts on all of them. */
  const selectionMenu = (e: React.MouseEvent): void => {
    const chosen = sessions.filter((s) => selected.has(s.id))
    showMenu(e, [
      { label: `Connect ${chosen.length} sessions`, onClick: () => chosen.forEach((s) => openSession(s)) },
      { label: '-', onClick: () => {} },
      {
        label: `Delete ${chosen.length} sessions`,
        danger: true,
        onClick: async () => {
          if (!window.confirm(`Delete ${chosen.length} sessions?\nSaved passwords for them are removed too. This cannot be undone.`)) return
          useStore.setState({ sessions: await api.deleteSession(chosen.map((s) => s.id)) })
          setSelected(new Set())
        }
      }
    ])
  }

  const sessionMenu = (e: React.MouseEvent, s: Session): void =>
    showMenu(e, [
      { label: 'Connect', onClick: () => openSession(s) },
      {
        label: 'Open in split (current tab)',
        disabled: !useStore.getState().activeTabId,
        onClick: () => openSessionInSplit(s)
      },
      ...(s.type === 'rdp' ? [{ label: 'Open in external RDP app', onClick: () => openRdpExternal(s) }] : []),
      ...(s.type === 'vnc' ? [{ label: 'Open in external VNC app', onClick: () => openVncExternal(s) }] : []),
      { label: 'Edit…', onClick: () => useStore.setState({ modal: 'session', editingSession: s }) },
      {
        label: 'Duplicate',
        onClick: () => void save([...sessions, { ...s, id: uid(), name: `${s.name} (copy)`, lastUsed: undefined }])
      },
      { label: '-', onClick: () => {} },
      ...createItems(s.folder),
      { label: '-', onClick: () => {} },
      {
        label: 'Delete',
        danger: true,
        onClick: async () => {
          if (window.confirm(`Delete session "${s.name}"?`))
            useStore.setState({ sessions: await api.deleteSession(s.id) })
        }
      }
    ])

  const folderMenu = (e: React.MouseEvent, f: FolderNode<Session>): void =>
    showMenu(e, [
      ...createItems(f.path),
      { label: '-', onClick: () => {} },
      {
        label: 'Rename folder…',
        onClick: async () => {
          const name = await promptText({ title: 'Rename folder', value: f.name })
          if (!name || name === f.name) return
          const parent = f.path.split('/').slice(0, -1).join('/')
          const next = parent ? `${parent}/${name.replace(/\//g, '-')}` : name.replace(/\//g, '-')
          const move = (p: string): string => (within(p, f.path) ? next + p.slice(f.path.length) : p)
          void save(sessions.map((s) => ({ ...s, folder: move(s.folder) })))
          void saveFolders(folders.map(move))
        }
      },
      {
        label: 'Ungroup (move sessions up)',
        onClick: () => {
          const parent = f.path.split('/').slice(0, -1).join('/')
          const up = (p: string): string => (within(p, f.path) ? (parent + p.slice(f.path.length)).replace(/^\//, '') : p)
          void save(sessions.map((s) => ({ ...s, folder: up(s.folder) })))
          void saveFolders(folders.filter((p) => p !== f.path).map(up))
        }
      },
      { label: '-', onClick: () => {} },
      {
        label: 'Delete folder…',
        danger: true,
        onClick: async () => {
          const inside = sessions.filter((s) => within(s.folder, f.path))
          const msg = inside.length
            ? `Delete folder "${f.path}" and the ${inside.length} session(s) inside it, including subfolders?\nSaved passwords for them are removed too. This cannot be undone.`
            : `Delete the empty folder "${f.path}"?`
          if (!window.confirm(msg)) return
          if (inside.length) useStore.setState({ sessions: await api.deleteSession(inside.map((s) => s.id)) })
          await saveFolders(folders.filter((p) => !within(p, f.path)))
          toast(`Deleted folder "${f.name}" (${inside.length} sessions)`)
        }
      }
    ])

  // What the search hides is not selected: a drag or delete must not touch rows out of sight.
  const chosen = new Set(filtered.filter((s) => selected.has(s.id)).map((s) => s.id))

  const renderFolder = (f: FolderNode<Session>, depth: number): JSX.Element => (
    <div key={f.path || '__root'}>
      {f.path && (
        <div
          className={`tree-row folder ${dropFolder === f.path ? 'drop-into' : ''}`}
          aria-expanded={!collapsed[f.path] || !!filter}
          style={{ paddingLeft: 8 + (depth - 1) * 14 }}
          onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))}
          onContextMenu={(e) => folderMenu(e, f)}
          onDragOver={(e) => hoverDrop(e, f.path)}
          onDrop={(e) => {
            e.stopPropagation()
            dropInto(f.path)
          }}
        >
          <Caret open={!collapsed[f.path] || !!filter} />
          <FolderIcon open={!collapsed[f.path] || !!filter} />
          <span className="tree-name">{f.name}</span>
        </div>
      )}
      {(!collapsed[f.path] || filter) && (
        <>
          {f.folders.map((c) => renderFolder(c, depth + 1))}
          {f.items.map((s) => (
            <div
              key={s.id}
              className={`tree-row ${chosen.has(s.id) ? 'selected' : ''} ${dragIds?.includes(s.id) ? 'dragging' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              draggable
              onClick={(e) => clickRow(e, s)}
              onDragStart={(e) => {
                // A selected row takes the whole selection along; any other row goes alone.
                const ids = chosen.has(s.id) ? [...chosen] : [s.id]
                setDragIds(ids)
                e.dataTransfer.setData('application/x-nixi-session', s.id)
                if (ids.length > 1) dragBadge(e, ids.length)
                // Lets the open tab view show split drop zones for this session.
                setTimeout(() => {
                  setSelected(new Set(ids))
                  useStore.setState({ dragging: { kind: 'session', id: s.id, ids } })
                }, 0)
              }}
              onDragEnd={() => {
                setDragIds(undefined)
                setDropFolder(undefined)
                useStore.setState({ dragging: undefined })
              }}
              // Dropping on a session means its folder, so a full list still has somewhere to drop.
              onDragOver={(e) => hoverDrop(e, s.folder)}
              onDrop={(e) => {
                e.stopPropagation()
                dropInto(s.folder)
              }}
              onDoubleClick={() => openSession(s)}
              onContextMenu={(e) => (chosen.has(s.id) && chosen.size > 1 ? selectionMenu(e) : sessionMenu(e, s))}
              title={s.type === 'local' ? 'Local shell' : `${s.username ? s.username + '@' : ''}${s.host}:${s.port ?? ''}`}
            >
              <span className="color-chip" style={{ background: s.color || 'transparent' }} />
              <SessionIcon type={s.type} />
              <span className="tree-name">{s.name}</span>
              {s.type !== 'local' && <span className="muted tree-host">{s.host}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  )

  return (
    <div className="session-tree">
      <div className="sidebar-search">
        <input placeholder="Search sessions…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="icon" onClick={() => newSession()} title="New session">
          <ToolIcon name="plus" />
        </button>
      </div>
      <div
        className={`tree ${dropFolder === '' ? 'drop-into' : ''}`}
        onContextMenu={backgroundMenu}
        onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
        onDragOver={(e) => hoverDrop(e, '')}
        onDragLeave={(e) => e.target === e.currentTarget && setDropFolder(undefined)}
        onDrop={() => dropInto('')}
      >
        {!filter && recent.length > 0 && (
          <>
            <div className="tree-section">Recent</div>
            {recent.map((s) => (
              <div key={'r' + s.id} className="tree-row" style={{ paddingLeft: 8 }} onDoubleClick={() => openSession(s)}>
                <ClockIcon />
                <span className="tree-name">{s.name}</span>
              </div>
            ))}
            <div className="tree-section">All sessions</div>
          </>
        )}
        {renderFolder(tree, 0)}
        {!sessions.length && !folders.length && (
          <div className="empty">
            No saved sessions.
            <br />
            <button onClick={() => newSession()}>New session</button>
            <button
              onClick={async () => {
                const { sessions } = await api.importSshConfig()
                useStore.setState({ sessions })
              }}
            >
              Import ~/.ssh/config
            </button>
            <button onClick={() => void importFromMobaXterm()}>Import from MobaXterm</button>
          </div>
        )}
      </div>
    </div>
  )
}
