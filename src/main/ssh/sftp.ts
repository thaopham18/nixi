import { randomUUID } from 'crypto'
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, watch, type FSWatcher } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { pipeline } from 'stream/promises'
import { app, BrowserWindow, shell, type WebContents } from 'electron'
import type { SFTPWrapper } from 'ssh2'
import type { ConflictMode, RemoteFile, Transfer } from '@shared/types'

export type { ConflictMode }
import { joinRemote, withRandomSuffix } from '@shared/parse'
import { getSftp } from '../conn/manager'
import { promiseDragAddon, type PromiseEvent, type PromiseWrite } from './drag-promise'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

let sink: WebContents | undefined
export function setSftpSink(wc: WebContents): void {
  sink = wc
}

function p<T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))))
}

export async function realpath(connId: string, path: string): Promise<string> {
  const sftp = await getSftp(connId)
  return p<string>((cb) => sftp.realpath(path, cb))
}

export async function list(connId: string, dir: string): Promise<RemoteFile[]> {
  const sftp = await getSftp(connId)
  const entries = await p<{ filename: string; attrs: { mode: number; size: number; mtime: number } }[]>((cb) =>
    sftp.readdir(dir, cb as never)
  )
  const files = await Promise.all(
    entries.map(async (e) => {
      const path = joinRemote(dir, e.filename)
      const type = e.attrs.mode & S_IFMT
      let isDir = type === S_IFDIR
      const isLink = type === S_IFLNK
      if (isLink) {
        // Follow symlinks so linked folders are browsable.
        try {
          const st = await p<{ mode: number }>((cb) => sftp.stat(path, cb as never))
          isDir = (st.mode & S_IFMT) === S_IFDIR
        } catch {
          /* dangling link */
        }
      }
      return { name: e.filename, path, isDir, isLink, size: e.attrs.size, mtime: e.attrs.mtime, mode: e.attrs.mode }
    })
  )
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
}

export async function mkdir(connId: string, path: string): Promise<void> {
  const sftp = await getSftp(connId)
  await p<void>((cb) => sftp.mkdir(path, cb))
}

export async function rename(connId: string, from: string, to: string): Promise<void> {
  const sftp = await getSftp(connId)
  await p<void>((cb) => sftp.rename(from, to, cb))
}

export async function chmod(connId: string, path: string, mode: number): Promise<void> {
  const sftp = await getSftp(connId)
  await p<void>((cb) => sftp.chmod(path, mode, cb))
}

async function removeRecursive(sftp: SFTPWrapper, path: string): Promise<void> {
  const st = await p<{ mode: number }>((cb) => sftp.lstat(path, cb as never))
  if ((st.mode & S_IFMT) === S_IFDIR) {
    const entries = await p<{ filename: string }[]>((cb) => sftp.readdir(path, cb as never))
    for (const e of entries) await removeRecursive(sftp, joinRemote(path, e.filename))
    await p<void>((cb) => sftp.rmdir(path, cb))
  } else {
    await p<void>((cb) => sftp.unlink(path, cb))
  }
}

export async function remove(connId: string, paths: string[]): Promise<void> {
  const sftp = await getSftp(connId)
  for (const path of paths) await removeRecursive(sftp, path)
}

// ---------------------------------------------------------------- transfers

const transfers = new Map<string, Transfer & { abort: AbortController }>()

function emitTransfer(t: Transfer): void {
  const { abort: _a, ...plain } = t as Transfer & { abort?: AbortController }
  if (sink && !sink.isDestroyed()) sink.send('sftp:transfer', plain)
}

/**
 * One transfer per batch: every file and folder picked (or dropped) together shows as a single
 * row with one progress bar, the file count and the file being copied.
 */
async function runTransfer(
  t: Transfer & { abort: AbortController },
  work: (onBytes: (n: number) => void, onFile: (rel?: string) => void, signal: AbortSignal) => Promise<void>
): Promise<void> {
  transfers.set(t.id, t)
  t.state = 'running'
  emitTransfer(t)
  let last = 0
  const tick = (force = false): void => {
    const now = Date.now()
    if (force || now - last > 150) {
      last = now
      emitTransfer(t)
    }
  }
  try {
    await work(
      (n) => {
        t.done += n
        tick()
      },
      (rel) => {
        if (rel === undefined) t.filesDone++
        else t.current = rel
        tick()
      },
      t.abort.signal
    )
    t.state = 'done'
    t.current = undefined
  } catch (err) {
    t.state = t.abort.signal.aborted ? 'cancelled' : 'error'
    t.error = (err as Error).message
  } finally {
    emitTransfer(t)
    transfers.delete(t.id)
  }
  if (t.state === 'error') throw new Error(t.error)
}

function newTransfer(connId: string, direction: 'up' | 'down', names: string[], total: number, files: number): Transfer & { abort: AbortController } {
  const name = names.length === 1 ? names[0] : `${names.length} items`
  return { id: randomUUID(), connId, direction, name, total, done: 0, files, filesDone: 0, state: 'queued', abort: new AbortController() }
}

export function cancelTransfer(id: string): void {
  transfers.get(id)?.abort.abort()
}

/** A free name: `name` itself unless it exists, then name-12345.ext (random 5 digits). */
async function freeName(name: string, isDir: boolean, exists: (n: string) => boolean | Promise<boolean>): Promise<string> {
  if (!(await exists(name))) return name
  for (let i = 0; i < 50; i++) {
    const n = withRandomSuffix(name, isDir)
    if (!(await exists(n))) return n
  }
  throw new Error(`No free name for ${name}`)
}

async function remoteExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  try {
    await p((cb) => sftp.lstat(path, cb as never))
    return true
  } catch {
    return false
  }
}

/** Names (top-level items of a transfer) that already exist in the destination folder. */
export async function conflicts(connId: string, direction: 'up' | 'down', names: string[], dir: string): Promise<string[]> {
  if (direction === 'down') return names.filter((n) => existsSync(join(dir, n)))
  const sftp = await getSftp(connId)
  const hits = await Promise.all(names.map((n) => remoteExists(sftp, joinRemote(dir, n))))
  return names.filter((_, i) => hits[i])
}

interface LocalEntry {
  local: string
  rel: string
  isDir: boolean
  size: number
}

function walkLocal(path: string, rel: string): LocalEntry[] {
  const st = statSync(path)
  if (!st.isDirectory()) return [{ local: path, rel, isDir: false, size: st.size }]
  const out: LocalEntry[] = [{ local: path, rel, isDir: true, size: 0 }]
  for (const name of readdirSync(path)) out.push(...walkLocal(join(path, name), `${rel}/${name}`))
  return out
}

export async function upload(connId: string, localPaths: string[], remoteDir: string, mode: ConflictMode = 'overwrite'): Promise<void> {
  const sftp = await getSftp(connId)
  const entries: LocalEntry[] = []
  const names: string[] = []
  for (const lp of localPaths) {
    const isDir = statSync(lp).isDirectory()
    const name = mode === 'rename' ? await freeName(basename(lp), isDir, (n) => remoteExists(sftp, joinRemote(remoteDir, n))) : basename(lp)
    names.push(name)
    entries.push(...walkLocal(lp, name))
  }
  const files = entries.filter((e) => !e.isDir)
  const t = newTransfer(connId, 'up', names, files.reduce((a, e) => a + e.size, 0), files.length)
  await runTransfer(t, async (onBytes, onFile, signal) => {
    for (const e of entries) {
      if (signal.aborted) throw new Error('Cancelled')
      const remote = joinRemote(remoteDir, e.rel)
      if (e.isDir) {
        await p<void>((cb) => sftp.mkdir(remote, (err) => cb(err && (err as { code?: number }).code !== 4 ? err : null)))
        continue
      }
      onFile(e.rel)
      const rs = createReadStream(e.local)
      rs.on('data', (c) => onBytes(c.length))
      await pipeline(rs, sftp.createWriteStream(remote), { signal })
      onFile()
    }
  })
}

interface RemoteEntry {
  remote: string
  rel: string
  isDir: boolean
  size: number
}

async function walkRemote(sftp: SFTPWrapper, path: string, rel: string): Promise<RemoteEntry[]> {
  const st = await p<{ mode: number; size: number }>((cb) => sftp.stat(path, cb as never))
  if ((st.mode & S_IFMT) !== S_IFDIR) return [{ remote: path, rel, isDir: false, size: st.size }]
  const out: RemoteEntry[] = [{ remote: path, rel, isDir: true, size: 0 }]
  const entries = await p<{ filename: string }[]>((cb) => sftp.readdir(path, cb as never))
  for (const e of entries) out.push(...(await walkRemote(sftp, joinRemote(path, e.filename), `${rel}/${e.filename}`)))
  return out
}

/**
 * Returns the local paths of the top-level items. `as` renames them at the destination (default:
 * their remote names).
 */
export async function download(
  connId: string,
  remotePaths: string[],
  localDir: string,
  mode: ConflictMode = 'overwrite',
  as?: string[]
): Promise<string[]> {
  const sftp = await getSftp(connId)
  const entries: RemoteEntry[] = []
  const names: string[] = []
  for (const [i, rp] of remotePaths.entries()) {
    const base = rp.split('/').filter(Boolean).pop() ?? 'download'
    const list = await walkRemote(sftp, rp, base)
    const want = as?.[i] ?? base
    const name = mode === 'rename' ? await freeName(want, list[0].isDir, (n) => existsSync(join(localDir, n))) : want
    names.push(name)
    entries.push(...list.map((e) => ({ ...e, rel: name + e.rel.slice(base.length) })))
  }
  const files = entries.filter((e) => !e.isDir)
  mkdirSync(localDir, { recursive: true })
  const t = newTransfer(connId, 'down', names, files.reduce((a, e) => a + e.size, 0), files.length)
  await runTransfer(t, async (onBytes, onFile, signal) => {
    for (const e of entries) {
      if (signal.aborted) throw new Error('Cancelled')
      const local = join(localDir, ...e.rel.split('/'))
      if (e.isDir) {
        mkdirSync(local, { recursive: true })
        continue
      }
      onFile(e.rel)
      const rs = sftp.createReadStream(e.remote)
      rs.on('data', (c: Buffer) => onBytes(c.length))
      await pipeline(rs, createWriteStream(local), { signal })
      onFile()
    }
  })
  return names.map((n) => join(localDir, n))
}

// ---------------------------------------------------------------- drag files out to Finder / Explorer

export interface DragItem {
  path: string
  name: string
  isDir: boolean
}

/**
 * macOS: file promises (native/drag-promise.mm). The drag starts right away; when the user drops,
 * Finder hands over the destination of each item and the download goes straight there. One
 * download batch (one progress row) per drop.
 */
interface PromisedDrag {
  connId: string
  items: DragItem[]
  writes: PromiseWrite[]
  timer?: NodeJS.Timeout
}
const promisedDrags = new Map<string, PromisedDrag>()

function onPromiseEvent(e: PromiseEvent): void {
  const addon = promiseDragAddon()!
  const d = promisedDrags.get(e.token)
  if (e.type === 'end') {
    if (!e.dropped) promisedDrags.delete(e.token)
    return
  }
  if (!d) return addon.complete(e.requestId, 'This drag has expired')
  // Finder asks for each item separately, within a few ms: gather them into one transfer.
  d.writes.push(e)
  clearTimeout(d.timer)
  d.timer = setTimeout(() => void writePromised(e.token), 80)
}

async function writePromised(token: string): Promise<void> {
  const addon = promiseDragAddon()!
  const d = promisedDrags.get(token)
  if (!d) return
  promisedDrags.delete(token)
  const byDir = new Map<string, PromiseWrite[]>()
  for (const w of d.writes) byDir.set(dirname(w.path), [...(byDir.get(dirname(w.path)) ?? []), w])
  for (const [dir, writes] of byDir) {
    let error: string | undefined
    try {
      // Finder normally picks a free name itself; if the name is still taken, keep both.
      await download(d.connId, writes.map((w) => d.items[w.index].path), dir, 'rename', writes.map((w) => basename(w.path)))
    } catch (err) {
      error = (err as Error).message
    }
    for (const w of writes) addon.complete(w.requestId, error)
  }
}

/** Other systems (and a Mac without the native module): download to a temp folder first. */
const dragRoot = join(tmpdir(), 'nixi-drag')
const pendingDrags = new Map<string, { released: boolean }>()

/**
 * Rows dragged out of the SFTP list. With file promises (macOS) the files go where they are
 * dropped. Otherwise the OS drag needs real files: download them to a temp folder, then start the
 * native drag; if the mouse was let go before the download finished there is nothing left to drop
 * on, so the files go to the download folder instead.
 */
export async function dragOut(wc: WebContents, token: string, connId: string, items: DragItem[], downloadDir: string): Promise<'drag' | 'saved' | 'cancelled'> {
  const addon = promiseDragAddon(onPromiseEvent)
  const win = BrowserWindow.fromWebContents(wc)
  if (addon && win) {
    promisedDrags.set(token, { connId, items, writes: [] })
    // Dropped somewhere that never asked for the files (or cancelled): forget it after a while.
    setTimeout(() => {
      const d = promisedDrags.get(token)
      if (d && !d.writes.length) promisedDrags.delete(token)
    }, 10 * 60_000).unref()
    if (addon.startDrag(win.getNativeWindowHandle(), token, items.map(({ name, isDir }) => ({ name, isDir })))) return 'drag'
    // Mouse already released (a very quick flick): no drag, and nothing to fall back to.
    promisedDrags.delete(token)
    return 'cancelled'
  }

  const state = { released: false }
  pendingDrags.set(token, state)
  try {
    const dir = join(dragRoot, randomUUID())
    const local = await download(connId, items.map((i) => i.path), dir)
    if (!state.released) {
      wc.startDrag({ file: local[0], files: local, icon: await app.getFileIcon(local[0]) })
      return 'drag'
    }
    mkdirSync(downloadDir, { recursive: true })
    for (const l of local) {
      const name = await freeName(basename(l), statSync(l).isDirectory(), (n) => existsSync(join(downloadDir, n)))
      cpSync(l, join(downloadDir, name), { recursive: true })
    }
    rmSync(dir, { recursive: true, force: true })
    return 'saved'
  } finally {
    pendingDrags.delete(token)
  }
}

export function dragReleased(token: string): void {
  const d = pendingDrags.get(token)
  if (d) d.released = true
}

// ---------------------------------------------------------------- edit in local editor

const watchers = new Map<string, FSWatcher>()

/** Download to a temp file, open it with the default app, re-upload on every save. */
export async function editRemote(connId: string, remotePath: string): Promise<void> {
  const sftp = await getSftp(connId)
  const dir = join(tmpdir(), 'nixi-edit', randomUUID())
  mkdirSync(dir, { recursive: true })
  const local = join(dir, basename(remotePath))
  await pipeline(sftp.createReadStream(remotePath), createWriteStream(local))
  let timer: NodeJS.Timeout | undefined
  const w = watch(local, () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        await pipeline(createReadStream(local), sftp.createWriteStream(remotePath))
        sink?.send('sftp:edited', remotePath)
      } catch (err) {
        console.error('re-upload failed', err)
      }
    }, 400)
  })
  watchers.get(local)?.close()
  watchers.set(local, w)
  const err = await shell.openPath(local)
  if (err) throw new Error(err)
}

export function closeWatchers(): void {
  for (const w of watchers.values()) w.close()
  watchers.clear()
  rmSync(dragRoot, { recursive: true, force: true }) // files dragged out were copied by the drop target long ago
}
