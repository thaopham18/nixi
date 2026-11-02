import type { Duplex } from 'stream'
import { shell } from 'electron'
import type { Session } from '@shared/types'
import { connectSsh, targetFromSession } from '../ssh/connect'
import { getSession } from '../store/stores'

/** A channel to host:port as seen from a saved SSH session; the SSH connection ends with it. */
export async function openVncThroughSsh(sshSessionId: string, host: string, port: number): Promise<Duplex> {
  const session = getSession(sshSessionId)
  if (!session) throw new Error('SSH session not found')
  const { client, chain } = await connectSsh(targetFromSession(session))
  // Keys and update requests are tiny packets: don't let the socket hold them back to batch them.
  for (const c of [client, ...chain]) c.setNoDelay(true)
  const closeAll = (): void => {
    for (const c of [client, ...chain]) c.end()
  }
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) {
        closeAll()
        return reject(err)
      }
      stream.once('close', closeAll)
      resolve(stream)
    })
  })
}

/** Hand the address to the system's VNC app. The password is never put in the URL. */
export async function openVncExternal(s: Session): Promise<void> {
  if (!s.host) throw new Error('This session has no host')
  if (s.jumpSessionId) throw new Error('This session goes through SSH, which the external app cannot do. Use the Nixi tab.')
  const user = s.username ? `${encodeURIComponent(s.username)}@` : ''
  const host = s.host.includes(':') ? `[${s.host}]` : s.host
  try {
    await shell.openExternal(`vnc://${user}${host}:${s.port || 5900}`)
  } catch {
    throw new Error('No app on this computer opens vnc:// links. Install a VNC viewer, or use the Nixi tab.')
  }
}
