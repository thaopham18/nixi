export type SessionType = 'ssh' | 'telnet' | 'local' | 'rdp' | 'vnc'
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
  /** Saved credential this session logs in with: its username, password and key apply (main resolves them). */
  credentialId?: string
  /** Another saved SSH session used as ProxyJump (VNC: the connection goes through it). */
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
  /** VNC: fit the tab, 1:1 with scrollbars, or ask the server to change resolution */
  vncScale?: 'fit' | 'actual' | 'remote'
  /** picture quality vs. speed, for servers that compress with JPEG (Tight) */
  vncQuality?: 'smooth' | 'balanced' | 'sharp'
  vncViewOnly?: boolean
  /** false = this computer's clipboard goes to the server only when asked (toolbar button) */
  vncSendClipboard?: boolean
  /** Set by main: a password/passphrase is stored in the keychain. Never contains the secret. */
  hasSecret?: boolean
  lastUsed?: number
}

/** What the renderer sends when saving: may carry a new plaintext secret. */
export interface SessionInput extends Session {
  secret?: string
  clearSecret?: boolean
}

/** A login kept once and picked by many sessions. The secret stays in main, like a session's. */
export interface Credential {
  id: string
  name: string
  username?: string
  /** password, or private key (SSH only) with an optional passphrase */
  kind: 'password' | 'key'
  privateKeyPath?: string
  /** Set by main: a password/passphrase is stored. Never contains the secret. */
  hasSecret?: boolean
}

export interface CredentialInput extends Credential {
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
  /** try again by itself when a connection drops */
  autoReconnect: boolean
  /** ask before running commands that are hard to undo (rm -rf, DROP TABLE…) */
  warnDangerousCommands: boolean
  /** more words or commands to ask about, beyond the built-in rules */
  dangerWatchList: string[]
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
  /** a block of text put in as one paste: its line breaks don't run anything where the shell supports bracketed paste */
  | { kind: 'paste'; text: string }
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
  /** it dropped without anyone ending it: worth reconnecting */
  lost?: boolean
}

export interface OpenConnRequest {
  sessionId?: string
  /** one-off login typed in a prompt */
  username?: string
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

export interface VncLaunch {
  url: string
  username: string
  password?: string
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
