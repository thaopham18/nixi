import { writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { shell } from 'electron'
import type { Session } from '@shared/types'

export function buildRdpFile(s: Session): string {
  const lines = [
    `full address:s:${s.host}:${s.port || 3389}`,
    `username:s:${s.rdpDomain ? `${s.rdpDomain}\\` : ''}${s.username ?? ''}`,
    'prompt for credentials:i:1',
    `screen mode id:i:${s.rdpWidth ? 1 : 2}`,
    ...(s.rdpWidth && s.rdpHeight ? [`desktopwidth:i:${s.rdpWidth}`, `desktopheight:i:${s.rdpHeight}`] : []),
    'dynamic resolution:i:1',
    // Let the native client pick codecs/quality from measured bandwidth (enables H.264/AVC on fast links).
    'connection type:i:7',
    'networkautodetect:i:1',
    'bandwidthautodetect:i:1',
    'session bpp:i:32',
    'compression:i:1',
    'autoreconnection enabled:i:1',
    'redirectclipboard:i:1',
    'audiomode:i:0'
  ]
  return lines.join('\r\n') + '\r\n'
}

/**
 * "Native client" mode: hand a generated .rdp file to the system handler
 * (Windows App / Microsoft Remote Desktop on macOS, mstsc on Windows).
 */
export async function openRdpExternal(s: Session): Promise<void> {
  const dir = join(tmpdir(), 'nixi-rdp')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${s.name.replace(/[^\w.-]+/g, '_') || 'session'}.rdp`)
  writeFileSync(file, buildRdpFile(s), 'utf8')
  const err = await shell.openPath(file)
  if (err) throw new Error(`${err}. Install "Windows App" from the Mac App Store to open RDP sessions.`)
}
