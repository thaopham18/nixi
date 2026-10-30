import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Macro, OpenConnRequest, Session, SessionInput, Settings, Tunnel } from '@shared/types'
import { parseSshConfig } from '@shared/parse'
import {
  deleteSession,
  getSession,
  getSettings,
  listSessions,
  macroStore,
  folderStore,
  saveSession,
  saveSessions,
  setSettings,
  shortcutsChanged,
  tunnelStore
} from './store/stores'
import * as db from './store/database'
import { findLegacyData } from './store/legacy'
import { APP_NAME, AUTHOR, AUTHOR_EMAIL, copyright } from '@shared/about'
import { closeConn, openConn, resizeConn, watchStats, writeConn } from './conn/manager'
import * as sftp from './ssh/sftp'
import { saveTunnels, startTunnel, stopTunnel, tunnelStatuses } from './ssh/tunnels'
import { openRdpExternal } from './rdp/rdp-file'
import { issueTicket } from './rdp/proxy'
import { exportMoba, importMoba, pickMobaFile } from './import/mobaxterm'
import { getSecret } from './store/secrets'

function win(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

/**
 * ipcMain.handle that returns failures as values: expected errors (wrong password, host
 * unreachable…) reach the UI without Electron logging "Error occurred in handler" each time.
 * The preload unwraps the result and rethrows in the renderer.
 */
function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return { ok: true, value: await fn(e, ...args) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

async function pickDbPath(save: boolean, title: string): Promise<string | undefined> {
  const w = win()
  // .ezdb: files made before the app was renamed from EZTERM (same format).
  const filters = [{ name: 'Nixi database', extensions: save ? [db.DB_EXTENSION] : [db.DB_EXTENSION, 'ezdb'] }]
  if (save) {
    const opts = { title, defaultPath: db.dbPath(), filters }
    const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    return res.canceled ? undefined : res.filePath
  }
  const opts = { title, defaultPath: db.dbPath(), filters, properties: ['openFile' as const] }
  const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
  return res.canceled ? undefined : res.filePaths[0]
}

export function registerIpc(): void {
  // app info
  handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    author: AUTHOR,
    email: AUTHOR_EMAIL,
    copyright: copyright(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`
  }))
  handle('app:about', () => app.showAboutPanel())

  // database (single encrypted file)
  handle('db:status', () => {
    const s = db.status()
    const legacy = s.state === 'none' ? findLegacyData() : undefined
    return { ...s, legacy: legacy && { source: legacy.source, sessions: legacy.sessions, lostSecrets: legacy.lostSecrets } }
  })
  handle('db:create', async (_e, password: string, remember: boolean, path?: string) => {
    // First database on this machine: bring over data from the previous storage format.
    const legacy = findLegacyData()
    await db.create(password, remember, path, legacy?.data)
    return db.status()
  })
  handle('db:unlock', async (_e, password: string, remember: boolean) => {
    await db.unlock(password, remember)
    return db.status()
  })
  handle('db:lock', () => db.lock())
  handle('db:checkPassword', (_e, pw: string) => db.checkPassword(pw))
  handle('db:changePassword', (_e, oldPw: string, newPw: string) => db.changePassword(oldPw, newPw))
  handle('db:setRemember', (_e, enabled: boolean) => {
    db.setRemember(enabled)
    return db.status()
  })
  handle('db:pickNewPath', () => pickDbPath(true, 'Where to create the Nixi database'))
  handle('db:new', async () => {
    const path = await pickDbPath(true, 'Create a new Nixi database')
    if (path) db.useFile(path)
    return db.status()
  })
  handle('db:open', async () => {
    const path = await pickDbPath(false, 'Open a Nixi database')
    if (path) db.useFile(path)
    return db.status()
  })
  handle('db:moveTo', async () => {
    const path = await pickDbPath(true, 'Move the database to…')
    if (path) db.moveTo(path)
    return db.status()
  })

  // settings
  handle('settings:get', () => getSettings())
  handle('settings:set', (_e, s: Settings) => setSettings(s))

  // sessions
  handle('sessions:list', () => listSessions())
  handle('sessions:save', (_e, s: SessionInput) => saveSession(s))
  handle('sessions:saveAll', (_e, s: Session[]) => saveSessions(s))
  handle('sessions:delete', (_e, ids: string | string[]) => deleteSession(ids))
  handle('sessions:importSshConfig', () => {
    const file = join(homedir(), '.ssh', 'config')
    if (!existsSync(file)) return { added: 0, sessions: listSessions() }
    const existing = listSessions()
    const names = new Set(existing.filter((s) => s.folder === 'ssh_config').map((s) => s.name))
    const hosts = parseSshConfig(readFileSync(file, 'utf8')).filter((h) => !names.has(h.alias))
    const added: Session[] = hosts.map((h) => ({
      id: randomUUID(),
      name: h.alias,
      type: 'ssh',
      folder: 'ssh_config',
      host: h.hostName ?? h.alias,
      port: h.port ?? 22,
      username: h.user,
      auth: h.identityFile ? 'key' : 'agent',
      privateKeyPath: h.identityFile
    }))
    // Resolve ProxyJump aliases to imported sessions.
    hosts.forEach((h, i) => {
      if (!h.proxyJump) return
      const jumpName = h.proxyJump.split(',')[0].replace(/^.*@/, '').replace(/:\d+$/, '')
      const j = [...existing, ...added].find((s) => s.name === jumpName)
      if (j) added[i].jumpSessionId = j.id
    })
    return { added: added.length, sessions: saveSessions([...existing, ...added]) }
  })
  handle('sessions:export', async () => {
    const w = win()
    const opts = { defaultPath: 'nixi-sessions.json', filters: [{ name: 'JSON', extensions: ['json'] }] }
    const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return false
    const data = {
      sessions: listSessions().map(({ hasSecret: _h, ...s }) => s),
      folders: folderStore.get(),
      tunnels: tunnelStore.get(),
      macros: macroStore.get()
    }
    writeFileSync(res.filePath, JSON.stringify(data, null, 2))
    return true
  })
  handle('sessions:import', async () => {
    const w = win()
    const opts = { properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return listSessions()
    const data = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
    const byId = new Map(listSessions().map((s) => [s.id, s]))
    for (const s of (data.sessions ?? []) as Session[]) byId.set(s.id, s)
    if (Array.isArray(data.tunnels)) tunnelStore.set(data.tunnels)
    if (Array.isArray(data.macros)) macroStore.set(data.macros)
    if (Array.isArray(data.folders)) folderStore.set([...new Set([...folderStore.get(), ...(data.folders as string[])])])
    return saveSessions([...byId.values()])
  })
  handle('moba:pick', () => pickMobaFile())
  handle('moba:import', (_e, token: string, masterPassword?: string) => importMoba(token, masterPassword))
  handle('moba:export', () => exportMoba())
  handle('rdp:openExternal', (_e, id: string) => {
    const s = getSession(id)
    if (!s) throw new Error('Session not found')
    return openRdpExternal(s)
  })
  // Everything the embedded IronRDP client needs. The password has to reach the renderer
  // because the RDP stack (incl. CredSSP) runs there as WASM.
  handle('rdp:prepare', async (_e, id: string) => {
    const s = getSession(id)
    if (!s?.host) throw new Error('Session not found')
    const port = s.port || 3389
    let username = s.username ?? ''
    let domain = s.rdpDomain ?? ''
    if (!domain && username.includes('\\')) [domain, username] = username.split('\\', 2)
    return {
      ...(await issueTicket(s.host, port)),
      destination: `${s.host}:${port}`,
      username,
      domain,
      password: getSecret(s.id),
      width: s.rdpWidth,
      height: s.rdpHeight
    }
  })

  // terminals
  handle('conn:open', (_e, req: OpenConnRequest) => openConn(req))
  ipcMain.on('conn:write', (_e, id: string, data: string) => writeConn(id, data))
  ipcMain.on('conn:resize', (_e, id: string, cols: number, rows: number) => resizeConn(id, cols, rows))
  ipcMain.on('conn:close', (_e, id: string) => closeConn(id))
  ipcMain.on('conn:stats', (_e, id: string, on: boolean) => watchStats(id, on))

  // sftp
  handle('sftp:realpath', (_e, id: string, p: string) => sftp.realpath(id, p))
  handle('sftp:list', (_e, id: string, dir: string) => sftp.list(id, dir))
  handle('sftp:mkdir', (_e, id: string, p: string) => sftp.mkdir(id, p))
  handle('sftp:rename', (_e, id: string, a: string, b: string) => sftp.rename(id, a, b))
  handle('sftp:chmod', (_e, id: string, p: string, mode: number) => sftp.chmod(id, p, mode))
  handle('sftp:remove', (_e, id: string, paths: string[]) => sftp.remove(id, paths))
  handle('sftp:upload', (_e, id: string, local: string[], dir: string, mode?: sftp.ConflictMode) => sftp.upload(id, local, dir, mode))
  handle('sftp:pickUpload', async () => {
    const w = win()
    const opts = { properties: ['openFile' as const, 'openDirectory' as const, 'multiSelections' as const] }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths
  })
  // Where to download: a folder picker that opens on the download folder from Settings.
  handle('sftp:pickDownloadDir', async () => {
    const w = win()
    const opts = {
      title: 'Download to',
      buttonLabel: 'Download here',
      defaultPath: getSettings().downloadDir,
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : res.filePaths[0]
  })
  handle('sftp:download', async (_e, id: string, paths: string[], mode?: sftp.ConflictMode, dir?: string) => {
    const to = dir || getSettings().downloadDir
    await sftp.download(id, paths, to, mode)
    return to
  })
  handle('sftp:conflicts', (_e, id: string, direction: 'up' | 'down', names: string[], dir?: string) =>
    sftp.conflicts(id, direction, names, dir || getSettings().downloadDir)
  )
  handle('sftp:dragOut', (e, token: string, id: string, items: sftp.DragItem[]) => sftp.dragOut(e.sender, token, id, items, getSettings().downloadDir))
  ipcMain.on('sftp:dragReleased', (_e, token: string) => sftp.dragReleased(token))
  handle('sftp:cancel', (_e, tid: string) => sftp.cancelTransfer(tid))
  handle('sftp:edit', (_e, id: string, p: string) => sftp.editRemote(id, p))

  // tunnels
  handle('tunnels:list', () => ({ tunnels: tunnelStore.get(), statuses: tunnelStatuses() }))
  handle('tunnels:save', (_e, t: Tunnel[]) => saveTunnels(t))
  handle('tunnels:start', (_e, id: string) => startTunnel(id))
  handle('tunnels:stop', (_e, id: string) => stopTunnel(id))

  // macros
  handle('folders:list', () => folderStore.get())
  handle('folders:save', (_e, f: string[]) => {
    folderStore.set([...new Set(f.filter(Boolean))])
    return folderStore.get()
  })
  handle('macros:list', () => macroStore.get())
  handle('macros:save', (_e, m: Macro[]) => {
    macroStore.set(m)
    shortcutsChanged()
    return m
  })

  // misc
  handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))
  handle('dialog:pickFile', async () => {
    const w = win()
    const opts = { properties: ['openFile' as const, 'showHiddenFiles' as const], defaultPath: join(homedir(), '.ssh') }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? undefined : res.filePaths[0]
  })
  handle('dialog:pickDir', async () => {
    const w = win()
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? undefined : res.filePaths[0]
  })
}
