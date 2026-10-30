import { useCallback, useEffect, useState } from 'react'
import type { ConflictMode, RemoteFile } from '@shared/types'
import { baseName, formatMode, formatSize, joinRemote, parentRemote } from '@shared/parse'
import { formatBytes } from '@shared/stats'
import { api, errorMessage, uid } from '../api'
import { askChoice, promptText, showMenu, toast, useStore } from '../store'
import { FileIcon, FolderIcon, ToolIcon } from './Icons'

/** Remembers the last directory per connection while the panel is switched away. */
const lastDir = new Map<string, string>()

/** Files we dragged out ourselves live in a temp "nixi-drag" folder: dropping them back is a no-op. */
const ownDragFile = /[\\/]nixi-drag[\\/]/

/**
 * Before a transfer: if some of the items already exist at the destination, ask whether to
 * overwrite them or keep both (the new copy gets a random 5-digit suffix). null = cancelled.
 */
async function conflictMode(connId: string, direction: 'up' | 'down', names: string[], dir: string): Promise<ConflictMode | null> {
  const hits = await api.sftpConflicts(connId, direction, names, dir)
  if (!hits.length) return 'overwrite'
  const v = await askChoice({
    title: hits.length === 1 ? 'Item already exists' : `${hits.length} items already exist`,
    message: `${dir} already has ${hits.length === 1 ? 'an item' : 'items'} with the same name. “Keep both” adds a random 5-digit number to the new copy, e.g. report-48213.pdf.`,
    items: hits,
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Overwrite', value: 'overwrite' },
      { label: 'Keep both', value: 'rename', primary: true }
    ]
  })
  return v === 'overwrite' || v === 'rename' ? v : null
}

export function SftpPanel(): JSX.Element {
  const pane = useStore((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId)
    return t?.panes.find((p) => p.id === t.activePaneId)
  })
  const connId = pane?.isSsh && pane.state === 'connected' ? pane.connId : undefined
  const [dir, setDir] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [files, setFiles] = useState<RemoteFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [follow, setFollow] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [dropping, setDropping] = useState(false)
  /** folder row a drag hovers: dropping there uploads into it */
  const [dropDir, setDropDir] = useState<string>()

  const load = useCallback(
    async (target: string) => {
      if (!connId) return
      setLoading(true)
      setError(undefined)
      try {
        const real = await api.sftpRealpath(connId, target)
        const list = await api.sftpList(connId, real)
        setDir(real)
        setPathInput(real)
        setFiles(list)
        setSelected(new Set())
        lastDir.set(connId, real)
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [connId]
  )

  useEffect(() => {
    setFiles([])
    setDir('')
    if (connId) void load(lastDir.get(connId) ?? '.')
  }, [connId, load])

  useEffect(() => {
    if (follow && pane?.cwd && pane.cwd !== dir) void load(pane.cwd)
  }, [follow, pane?.cwd])

  useEffect(() => api.onEdited((p) => toast(`Uploaded ${p}`)), [])

  if (!connId)
    return <div className="empty">Focus a connected SSH terminal to browse its files over SFTP.</div>

  const run = async (fn: () => Promise<unknown>, reload = true): Promise<void> => {
    try {
      await fn()
      if (reload) await load(dir)
    } catch (err) {
      toast(errorMessage(err), true)
    }
  }

  const sel = files.filter((f) => selected.has(f.path))
  const visible = showHidden ? files : files.filter((f) => !f.name.startsWith('.'))

  const click = (e: React.MouseEvent, f: RemoteFile): void => {
    setSelected((prev) => {
      if (e.metaKey || e.ctrlKey) {
        const next = new Set(prev)
        next.has(f.path) ? next.delete(f.path) : next.add(f.path)
        return next
      }
      if (e.shiftKey && prev.size) {
        const idx = visible.findIndex((x) => prev.has(x.path))
        const to = visible.indexOf(f)
        const [a, b] = idx < to ? [idx, to] : [to, idx]
        return new Set(visible.slice(a, b + 1).map((x) => x.path))
      }
      return new Set([f.path])
    })
  }

  const actions = {
    open: (f: RemoteFile) => (f.isDir ? load(f.path) : run(() => api.sftpEdit(connId, f.path), false)),
    download: (targets: RemoteFile[]) =>
      run(async () => {
        const to = await api.sftpPickDownloadDir()
        if (!to) return
        const mode = await conflictMode(connId, 'down', targets.map((f) => f.name), to)
        if (!mode) return
        await api.sftpDownload(connId, targets.map((f) => f.path), mode, to)
        toast(`Downloaded ${targets.length === 1 ? targets[0].name : `${targets.length} items`} to ${to}`)
      }, false),
    upload: (paths: string[], target = dir) =>
      run(async () => {
        paths = paths.filter((p) => !ownDragFile.test(p))
        if (!paths.length) return
        const mode = await conflictMode(connId, 'up', paths.map(baseName), target)
        if (mode) await api.sftpUpload(connId, paths, target, mode)
      }),
    remove: (targets: RemoteFile[]) => {
      if (window.confirm(`Delete ${targets.map((f) => f.name).join(', ')}? This cannot be undone.`))
        void run(() => api.sftpRemove(connId, targets.map((f) => f.path)))
    },
    rename: async (f: RemoteFile) => {
      const name = await promptText({ title: 'Rename', value: f.name })
      if (name && name !== f.name) void run(() => api.sftpRename(connId, f.path, joinRemote(dir, name)))
    },
    chmod: async (f: RemoteFile) => {
      const v = await promptText({ title: `Permissions for ${f.name}`, label: 'Octal mode', value: (f.mode & 0o7777).toString(8) })
      if (v && /^[0-7]{3,4}$/.test(v)) void run(() => api.sftpChmod(connId, f.path, parseInt(v, 8)))
    },
    mkdir: async () => {
      const name = await promptText({ title: 'New folder', label: 'Name' })
      if (name) void run(() => api.sftpMkdir(connId, joinRemote(dir, name)))
    },
    copyPath: (f: RemoteFile) => api.writeClipboard(f.path),
    cdTerminal: (f: RemoteFile) => pane?.connId && api.write(pane.connId, `cd '${(f.isDir ? f.path : dir).replace(/'/g, "'\\''")}'\r`)
  }

  const fileMenu = (e: React.MouseEvent, f: RemoteFile): void => {
    const targets = selected.has(f.path) ? sel : [f]
    if (!selected.has(f.path)) setSelected(new Set([f.path]))
    showMenu(e, [
      { label: f.isDir ? 'Open' : 'Edit (local editor)', onClick: () => void actions.open(f) },
      { label: `Download${targets.length > 1 ? ` (${targets.length})` : ''}…`, onClick: () => void actions.download(targets) },
      ...(f.isDir ? [{ label: 'Upload here…', onClick: () => void api.sftpPickUpload().then((p) => actions.upload(p, f.path)) }] : []),
      { label: 'Rename…', onClick: () => void actions.rename(f) },
      { label: 'Permissions…', onClick: () => void actions.chmod(f) },
      { label: 'Copy path', onClick: () => actions.copyPath(f) },
      { label: 'cd here in terminal', onClick: () => actions.cdTerminal(f) },
      { label: '-', onClick: () => {} },
      { label: 'Delete', danger: true, onClick: () => actions.remove(targets) }
    ])
  }

  const droppedPaths = (e: React.DragEvent): string[] => {
    e.preventDefault()
    setDropping(false)
    setDropDir(undefined)
    return Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean)
  }
  const onDrop = (e: React.DragEvent): void => {
    const paths = droppedPaths(e)
    if (paths.length) void actions.upload(paths)
  }

  // Drag rows out to Finder / Explorer / the desktop (see dragOut in main/ssh/sftp.ts): on macOS
  // the files are downloaded where they are dropped, elsewhere through a temp folder first.
  const dragOut = (e: React.DragEvent, f: RemoteFile): void => {
    e.preventDefault()
    const targets = selected.has(f.path) ? sel : [f]
    if (!selected.has(f.path)) setSelected(new Set([f.path]))
    const token = uid()
    const released = (): void => api.sftpDragReleased(token)
    window.addEventListener('mouseup', released, { once: true })
    api
      .sftpDragOut(token, connId, targets.map(({ path, name, isDir }) => ({ path, name, isDir })))
      .then((r) => r === 'saved' && toast(`Saved to ${useStore.getState().settings?.downloadDir} (released before the download finished)`))
      .catch((err) => toast(errorMessage(err), true))
      .finally(() => window.removeEventListener('mouseup', released))
  }

  return (
    <div
      className={`sftp ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDropping(true)
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={onDrop}
    >
      <div className="sftp-toolbar">
        <button className="icon" title="Up" onClick={() => void load(parentRemote(dir))}>
          <ToolIcon name="up" />
        </button>
        <button className="icon" title="Home" onClick={() => void load('.')}>
          <ToolIcon name="home" />
        </button>
        <button className="icon" title="Refresh" onClick={() => void load(dir)}>
          <ToolIcon name="refresh" />
        </button>
        <button className="icon" title="New folder" onClick={() => void actions.mkdir()}>
          <ToolIcon name="folderPlus" />
        </button>
        <button className="icon" title="Upload files or folders" onClick={() => void api.sftpPickUpload().then((p) => actions.upload(p))}>
          <ToolIcon name="upload" />
        </button>
        <button className="icon" title="Download selected" disabled={!sel.length} onClick={() => void actions.download(sel)}>
          <ToolIcon name="download" />
        </button>
        <button className="icon" title="Delete selected" disabled={!sel.length} onClick={() => actions.remove(sel)}>
          <ToolIcon name="trash" />
        </button>
      </div>
      <form
        className="sftp-path"
        onSubmit={(e) => {
          e.preventDefault()
          void load(pathInput)
        }}
      >
        <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} />
      </form>
      <div className="sftp-options">
        <label title="Follow the terminal's current folder (needs the shell to emit OSC 7)">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow terminal
        </label>
        <label>
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Hidden
        </label>
      </div>
      {error && <div className="error-line">{error}</div>}
      <div className="sftp-list">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Modified</th>
              <th>Perms</th>
            </tr>
          </thead>
          <tbody>
            {dir !== '/' && (
              <tr onDoubleClick={() => void load(parentRemote(dir))}>
                <td colSpan={4} className="name">
                  <FolderIcon /> ..
                </td>
              </tr>
            )}
            {visible.map((f) => (
              <tr
                key={f.path}
                className={`${selected.has(f.path) ? 'selected' : ''} ${dropDir === f.path ? 'drop-into' : ''}`}
                draggable
                onDragStart={(e) => dragOut(e, f)}
                onDragOver={(e) => {
                  if (!f.isDir || !e.dataTransfer.types.includes('Files')) return
                  e.preventDefault()
                  e.stopPropagation()
                  setDropping(false)
                  setDropDir(f.path)
                }}
                onDragLeave={() => setDropDir((d) => (d === f.path ? undefined : d))}
                onDrop={(e) => {
                  if (!f.isDir) return
                  e.stopPropagation()
                  const paths = droppedPaths(e)
                  if (paths.length) void actions.upload(paths, f.path)
                }}
                onClick={(e) => click(e, f)}
                onDoubleClick={() => void actions.open(f)}
                onContextMenu={(e) => fileMenu(e, f)}
                title={f.path}
              >
                <td className="name">
                  {f.isDir ? <FolderIcon /> : <FileIcon />} {f.name}
                  {f.isLink ? ' ↪' : ''}
                </td>
                <td className="num">{f.isDir ? '' : formatSize(f.size)}</td>
                <td className="num">{new Date(f.mtime * 1000).toLocaleDateString(undefined, { year: '2-digit', month: '2-digit', day: '2-digit' })}</td>
                <td className="mono">{formatMode(f.mode, f.isDir)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="muted pad">Loading…</div>}
      </div>
      <TransferQueue />
    </div>
  )
}

function TransferQueue(): JSX.Element | null {
  const transfers = useStore((s) => s.transfers)
  const list = Object.values(transfers).reverse().slice(0, 8)
  if (!list.length) return null
  const clear = (): void =>
    useStore.setState((s) => ({
      transfers: Object.fromEntries(Object.entries(s.transfers).filter(([, t]) => t.state === 'running' || t.state === 'queued'))
    }))
  return (
    <div className="transfers">
      <div className="transfers-header">
        <span>Transfers</span>
        <button className="link" onClick={clear}>
          clear
        </button>
      </div>
      {list.map((t) => {
        const pct = t.total ? Math.round((t.done / t.total) * 100) : t.state === 'done' ? 100 : 0
        const running = t.state === 'running' || t.state === 'queued'
        return (
          <div key={t.id} className={`transfer ${t.state}`} title={t.error}>
            <ToolIcon name={t.direction === 'up' ? 'upload' : 'download'} />
            <div className="transfer-main">
              <div className="transfer-line">
                <span className="transfer-name">{t.name}</span>
                <span className="muted">
                  {running ? `${pct}%` : t.state === 'error' ? 'failed' : t.state}
                </span>
              </div>
              <div className="bar">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="transfer-detail muted">
                {t.files > 1 && <span>{running ? `${t.filesDone}/${t.files} files` : `${t.files} files`}</span>}
                <span>{running ? `${formatBytes(t.done)} / ${formatBytes(t.total)}` : formatBytes(t.total)}</span>
                {running && t.current && <span className="transfer-current">{t.current}</span>}
                {t.state === 'error' && <span className="transfer-current">{t.error}</span>}
              </div>
            </div>
            {running && (
              <button className="icon" onClick={() => void api.sftpCancel(t.id)} title="Cancel">
                ✕
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
