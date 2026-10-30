import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  ConflictMode,
  ConnStatus,
  Macro,
  OpenConnRequest,
  OpenConnResult,
  RdpLaunch,
  RemoteFile,
  Session,
  SessionInput,
  Settings,
  Transfer,
  Tunnel,
  TunnelStatus
} from '@shared/types'
import type { MobaPreview, MobaReport } from '../main/import/mobaxterm'
import type { ServerStats } from '@shared/stats'

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** Main-process handlers return { ok, value | error } (see handle() in main/ipc.ts). */
async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (!res.ok) throw new Error(res.error)
  return res.value
}

export interface DbStatusInfo {
  state: 'none' | 'locked' | 'unlocked'
  path: string
  remembered: boolean
  /** data found from the previous storage format, imported on create */
  legacy?: { source: string; sessions: number; lostSecrets: number }
}

const api = {
  platform: process.platform,

  appInfo: (): Promise<{
    name: string
    version: string
    author: string
    email: string
    copyright: string
    electron: string
    chrome: string
    node: string
    platform: string
  }> => invoke('app:info'),
  showAbout: (): Promise<void> => invoke('app:about'),

  dbStatus: (): Promise<DbStatusInfo> => invoke('db:status'),
  dbCreate: (password: string, remember: boolean, path?: string): Promise<DbStatusInfo> => invoke('db:create', password, remember, path),
  dbUnlock: (password: string, remember: boolean): Promise<DbStatusInfo> => invoke('db:unlock', password, remember),
  dbLock: (): Promise<void> => invoke('db:lock'),
  dbCheckPassword: (password: string): Promise<boolean> => invoke('db:checkPassword', password),
  dbChangePassword: (oldPw: string, newPw: string): Promise<void> => invoke('db:changePassword', oldPw, newPw),
  dbSetRemember: (enabled: boolean): Promise<DbStatusInfo> => invoke('db:setRemember', enabled),
  dbPickNewPath: (): Promise<string | undefined> => invoke('db:pickNewPath'),
  dbOpen: (): Promise<DbStatusInfo> => invoke('db:open'),
  dbNew: (): Promise<DbStatusInfo> => invoke('db:new'),
  dbMoveTo: (): Promise<DbStatusInfo> => invoke('db:moveTo'),

  getSettings: (): Promise<Settings> => invoke('settings:get'),
  setSettings: (s: Settings): Promise<Settings> => invoke('settings:set', s),

  listSessions: (): Promise<Session[]> => invoke('sessions:list'),
  saveSession: (s: SessionInput): Promise<Session[]> => invoke('sessions:save', s),
  saveSessions: (s: Session[]): Promise<Session[]> => invoke('sessions:saveAll', s),
  deleteSession: (ids: string | string[]): Promise<Session[]> => invoke('sessions:delete', ids),
  importSshConfig: (): Promise<{ added: number; sessions: Session[] }> => invoke('sessions:importSshConfig'),
  importSessions: (): Promise<Session[]> => invoke('sessions:import'),
  exportSessions: (): Promise<boolean> => invoke('sessions:export'),
  pickMobaFile: (): Promise<MobaPreview | null> => invoke('moba:pick'),
  importMoba: (token: string, masterPassword?: string): Promise<{ report: MobaReport; sessions: Session[] }> =>
    invoke('moba:import', token, masterPassword),
  exportMoba: (): Promise<{ count: number; skipped: number } | null> => invoke('moba:export'),
  openRdpExternal:(id: string): Promise<void> => invoke('rdp:openExternal', id),
  prepareRdp: (id: string): Promise<RdpLaunch> => invoke('rdp:prepare', id),

  openConn: (req: OpenConnRequest): Promise<OpenConnResult> => invoke('conn:open', req),
  write: (id: string, data: string): void => ipcRenderer.send('conn:write', id, data),
  resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('conn:resize', id, cols, rows),
  closeConn: (id: string): void => ipcRenderer.send('conn:close', id),
  onData: (cb: (id: string, data: string) => void) => on('conn:data', cb),
  onStatus: (cb: (s: ConnStatus) => void) => on('conn:status', cb),
  /** resource monitor of an SSH connection (CPU / RAM / disk bar) */
  watchStats: (id: string, on: boolean): void => ipcRenderer.send('conn:stats', id, on),
  /** while on, the main process hands every key combination to onHotkeyCaptured (menu shortcuts too) */
  captureHotkeys: (on: boolean): void => ipcRenderer.send('hotkey:capture', on),
  onHotkeyCaptured: (cb: (combo: string) => void) => on('hotkey:captured', cb),
  onStats: (cb: (id: string, stats: ServerStats | null) => void) => on('conn:stats', cb),

  sftpRealpath: (id: string, p: string): Promise<string> => invoke('sftp:realpath', id, p),
  sftpList: (id: string, dir: string): Promise<RemoteFile[]> => invoke('sftp:list', id, dir),
  sftpMkdir: (id: string, p: string): Promise<void> => invoke('sftp:mkdir', id, p),
  sftpRename: (id: string, a: string, b: string): Promise<void> => invoke('sftp:rename', id, a, b),
  sftpChmod: (id: string, p: string, mode: number): Promise<void> => invoke('sftp:chmod', id, p, mode),
  sftpRemove: (id: string, paths: string[]): Promise<void> => invoke('sftp:remove', id, paths),
  sftpUpload: (id: string, local: string[], dir: string, mode?: ConflictMode): Promise<void> => invoke('sftp:upload', id, local, dir, mode),
  sftpPickUpload: (): Promise<string[]> => invoke('sftp:pickUpload'),
  /** folder picker opened on the download folder; null = cancelled */
  sftpPickDownloadDir: (): Promise<string | null> => invoke('sftp:pickDownloadDir'),
  /** into `dir` (default: the download folder); resolves to the folder used */
  sftpDownload: (id: string, paths: string[], mode?: ConflictMode, dir?: string): Promise<string> =>
    invoke('sftp:download', id, paths, mode, dir),
  /** top-level names that already exist where the transfer would put them */
  sftpConflicts: (id: string, direction: 'up' | 'down', names: string[], dir?: string): Promise<string[]> =>
    invoke('sftp:conflicts', id, direction, names, dir),
  sftpDragOut: (token: string, id: string, items: { path: string; name: string; isDir: boolean }[]): Promise<'drag' | 'saved' | 'cancelled'> =>
    invoke('sftp:dragOut', token, id, items),
  sftpDragReleased: (token: string): void => ipcRenderer.send('sftp:dragReleased', token),
  sftpCancel: (tid: string): Promise<void> => invoke('sftp:cancel', tid),
  sftpEdit: (id: string, p: string): Promise<void> => invoke('sftp:edit', id, p),
  onTransfer: (cb: (t: Transfer) => void) => on('sftp:transfer', cb),
  onEdited: (cb: (path: string) => void) => on('sftp:edited', cb),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),

  listTunnels: (): Promise<{ tunnels: Tunnel[]; statuses: TunnelStatus[] }> => invoke('tunnels:list'),
  saveTunnels: (t: Tunnel[]): Promise<Tunnel[]> => invoke('tunnels:save', t),
  startTunnel: (id: string): Promise<void> => invoke('tunnels:start', id),
  stopTunnel: (id: string): Promise<void> => invoke('tunnels:stop', id),
  onTunnelStatus: (cb: (s: TunnelStatus) => void) => on('tunnel:status', cb),

  listMacros: (): Promise<Macro[]> => invoke('macros:list'),
  listFolders: (): Promise<string[]> => invoke('folders:list'),
  saveFolders: (f: string[]): Promise<string[]> => invoke('folders:save', f),
  saveMacros: (m: Macro[]): Promise<Macro[]> => invoke('macros:save', m),

  readClipboard: (): Promise<string> => invoke('clipboard:read'),
  writeClipboard: (text: string): void => ipcRenderer.send('clipboard:write', text),
  pickFile: (): Promise<string | undefined> => invoke('dialog:pickFile'),
  pickDir: (): Promise<string | undefined> => invoke('dialog:pickDir'),

  onMenu: (cb: (cmd: string) => void) => on('menu:cmd', cb),
  onFullScreen: (cb: (on: boolean) => void) => on('window:fullscreen', cb)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
