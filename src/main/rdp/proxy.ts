import { randomBytes } from 'crypto'
import { join } from 'path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { verifyHostKey } from '../store/known-hosts'
import type { FromWorker, ToWorker } from './proxy-worker'

// Main-process side of the RDP proxy: starts proxy-worker in a utilityProcess on first use,
// hands it one-time tickets and answers its certificate trust questions.

let worker: UtilityProcess | undefined
let workerPort: Promise<number> | undefined

function ensureWorker(): Promise<number> {
  if (workerPort) return workerPort
  const child = utilityProcess.fork(join(__dirname, 'rdp-proxy-worker.js'), [], { serviceName: 'Nixi RDP proxy' })
  worker = child
  const send = (msg: ToWorker): void => child.postMessage(msg)
  workerPort = new Promise((resolve, reject) => {
    child.on('message', async (msg: FromWorker) => {
      if (msg.type === 'ready') resolve(msg.port)
      else if (msg.type === 'log') console.warn(msg.message)
      else if (msg.type === 'verify') {
        const ok = await verifyHostKey(msg.host, msg.port, Buffer.from(msg.cert, 'base64'), 'rdp').catch(() => false)
        send({ type: 'verify-result', id: msg.id, ok })
      }
    })
    child.once('exit', (code) => {
      reject(new Error(`RDP proxy exited (${code})`))
      // Restart on next use.
      worker = undefined
      workerPort = undefined
    })
  })
  return workerPort
}

export async function issueTicket(host: string, port: number): Promise<{ proxyAddress: string; authToken: string }> {
  const p = await ensureWorker()
  const token = randomBytes(24).toString('hex')
  worker!.postMessage({ type: 'ticket', token, host, port } satisfies ToWorker)
  return { proxyAddress: `ws://127.0.0.1:${p}/rdp`, authToken: token }
}

export function stopRdpProxy(): void {
  worker?.kill()
  worker = undefined
  workerPort = undefined
}
