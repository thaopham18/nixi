import type { Api } from '../../preload'

declare global {
  interface Window {
    api: Api
  }
}

export const api = window.api
export const isMac = api.platform === 'darwin'
export const modKey = isMac ? '⌘' : 'Ctrl+Shift+'

export function uid(): string {
  return crypto.randomUUID()
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // ipcRenderer.invoke wraps errors: "Error invoking remote method 'x': Error: msg"
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
