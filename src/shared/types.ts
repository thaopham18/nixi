export type SessionType = 'ssh' | 'telnet' | 'local' | 'rdp'
export type AuthMethod = 'password' | 'key' | 'agent'

export interface Session {
  id: string
  name: string
  type: SessionType
  /** Folder path in the session tree, e.g. "Prod/DB". Empty = root. */
  folder: string
  host?: string
  port?: number
  username?: string
  auth?: AuthMethod
  privateKeyPath?: string
  /** Another saved SSH session used as ProxyJump. */
  jumpSessionId?: string
  keepaliveSec?: number
  startupCommand?: string
  color?: string
  /** Character set of the remote side (telnet: old network gear is often Latin-1). */
  encoding?: 'utf8' | 'latin1'
  /** Local shell override (type = local). */
  shell?: string
  /** RDP options */
  rdpWidth?: number
  rdpHeight?: number
  rdpDomain?: string
  /** embedded tab (IronRDP) or the system's native client (Windows App / mstsc) */
  rdpClient?: 'embedded' | 'native'
  /** Set by main: a password/passphrase is stored in the keychain. Never contains the secret. */
  hasSecret?: boolean
  lastUsed?: number
}

/** What the renderer sends when saving: may carry a new plaintext secret. */
export interface SessionInput extends Session {
  secret?: string
  clearSecret?: boolean
}

export interface Settings {
  theme: 'dark' | 'light' | 'solarized'
  fontFamily: string
  fontSize: number
  scrollback: number
  cursorStyle: 'bar' | 'block' | 'underline'
  cursorBlink: boolean
  /** WebGL terminal renderer; off = DOM renderer (slower, but immune to GPU driver issues) */
  gpuRendering: boolean
  copyOnSelect: boolean
  rightClickPaste: boolean
  warnMultilinePaste: boolean
  downloadDir: string
  sftpAutoOpen: boolean
  /** opens the macro list at the terminal cursor, hotkeyOf() format ("Cmd+J"); empty = menu only */
  macroPickerHotkey: string
  /** CPU / RAM / disk bar under SSH terminals */
  serverStats: boolean
  /** terminal colors chosen by the user (#rrggbb); '' = the theme's own */
  termForeground: string
  termBackground: string
  termCursor: string
}

export type TunnelType = 'L' | 'R' | 'D'

export interface Tunnel {
  id: string
  name: string
  sessionId: string
  type: TunnelType
  /** L/D: local bind; R: remote bind */
  bindHost: string
  bindPort: number
  /** L/R: forward destination (R: destination is on the local side) */
  destHost?: string
  destPort?: number
  autoStart: boolean
}

export interface TunnelStatus {
  id: string
  state: 'stopped' | 'starting' | 'running' | 'error'
  connections: number
  error?: string
}

export type MacroStep =
  | { kind: 'send'; text: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'waitFor'; pattern: string; timeoutMs: number }

export interface Macro {
  id: string
  name: string
  steps: MacroStep[]
  /** e.g. "Ctrl+Shift+1" */
  hotkey?: string
}

export type ConnState = 'connecting' | 'connected' | 'closed' | 'error'

export interface ConnStatus {
  connId: string
  state: ConnState
  message?: string
}

export interface OpenConnRequest {
  sessionId?: string
  /** one-off password typed in a prompt */
  password?: string
  cols: number
  rows: number
}

export interface OpenConnResult {
  connId: string
  title: string
  sessionId?: string
  isSsh: boolean
}

export interface RdpLaunch {
  proxyAddress: string
  authToken: string
  destination: string
  username: string
  domain: string
  password?: string
  width?: number
  height?: number
}

export interface RemoteFile {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  mtime: number
  mode: number
}

/** For items that already exist at a transfer's destination: replace them, or keep both (name-12345.ext). */
export type ConflictMode = 'overwrite' | 'rename'

export interface Transfer {
  id: string
  connId: string
  direction: 'up' | 'down'
  name: string
  /** bytes, all files of the batch */
  total: number
  done: number
  files: number
  filesDone: number
  /** relative path of the file being copied */
  current?: string
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  error?: string
}
