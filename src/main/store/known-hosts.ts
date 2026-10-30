import { createHash } from 'crypto'
import { BrowserWindow, dialog } from 'electron'
import { knownHostsStore } from './stores'

export function fingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/**
 * Trust-on-first-use check for SSH host keys and RDP server certificates (DER).
 * Asks the user for unknown or changed keys.
 */
export async function verifyHostKey(host: string, port: number, key: Buffer, kind: 'ssh' | 'rdp' = 'ssh'): Promise<boolean> {
  const addr = port === 22 && kind === 'ssh' ? host : `[${host}]:${port}`
  const id = kind === 'rdp' ? `rdp ${addr}` : addr
  const what = kind === 'rdp' ? 'RDP certificate' : 'host key'
  const fp = fingerprint(key)
  const known = knownHostsStore.get()[id]
  if (known === fp) return true

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const changed = Boolean(known)
  const opts = {
    type: changed ? ('warning' as const) : ('question' as const),
    title: changed ? `${what.toUpperCase()} CHANGED` : 'Unknown host',
    message: changed
      ? `WARNING: the ${what} for ${addr} has changed!\nThis could be a man-in-the-middle attack.`
      : `The authenticity of ${kind === 'rdp' ? 'RDP server' : 'host'} ${addr} can't be established.`,
    detail: `${changed ? `Old: ${known}\nNew: ` : 'Fingerprint: '}${fp}\n\nTrust this host and continue?`,
    buttons: ['Cancel', changed ? 'Replace key & connect' : 'Trust & connect'],
    defaultId: changed ? 0 : 1,
    cancelId: 0
  }
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (res.response !== 1) return false
  knownHostsStore.set({ ...knownHostsStore.get(), [id]: fp })
  return true
}
