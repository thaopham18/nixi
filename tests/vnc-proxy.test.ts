// The proxy between noVNC and the server, driven as noVNC would: raw RFB over a WebSocket.
import { execFileSync } from 'child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { issueVncTicket, openTcp, stopVncProxy } from '../src/main/vnc/proxy'
import { VNC_PROXY_ERROR } from '../src/shared/vnc'
// @ts-expect-error plain JS helper
import { makeCert, startVncServer } from '../scripts/dev-vnc-server.mjs'

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** A WebSocket with exact-length reads. */
async function dial(url: string): Promise<{ read(n: number): Promise<Buffer>; send(b: Buffer | string): void; ws: WebSocket }> {
  const ws = new WebSocket(url)
  let buf = Buffer.alloc(0) as Buffer
  let wake = (): void => {}
  ws.on('message', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    wake()
  })
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject))
  return {
    ws,
    send: (b) => ws.send(b),
    read: async (n) => {
      while (buf.length < n) await new Promise<void>((r) => (wake = r))
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      return out
    }
  }
}

async function open(server: { port: number }, verifyCert: (der: Buffer) => Promise<boolean> = async () => true) {
  const host = '127.0.0.1'
  return dial(await issueVncTicket({ host, port: server.port, open: () => openTcp(host, server.port), verifyCert }))
}

async function reason(c: Awaited<ReturnType<typeof dial>>): Promise<string> {
  expect((await c.read(1))[0]).toBe(0)
  const len = (await c.read(4)).readUInt32BE()
  return (await c.read(len)).toString()
}

describe('VNC proxy', () => {
  const servers: { close(): void }[] = []
  const start = async (opts: object) => {
    const s = await startVncServer(opts)
    servers.push(s)
    return s
  }
  afterAll(() => {
    servers.forEach((s) => s.close())
    stopVncProxy()
  })

  it('passes ordinary security types through untouched', async () => {
    const c = await open(await start({ security: 'none' }))
    expect((await c.read(12)).toString()).toBe('RFB 003.008\n')
    c.send('RFB 003.008\n')
    expect([...(await c.read(2))]).toEqual([1, 1])
    c.send(Buffer.from([1]))
    expect((await c.read(4)).readUInt32BE()).toBe(0)
    c.ws.close()
  })

  it('leaves RFB 3.3 alone: the server picks the type', async () => {
    const c = await open(await start({ security: 'v33' }))
    expect((await c.read(12)).toString()).toBe('RFB 003.003\n')
    c.send('RFB 003.003\n')
    expect((await c.read(4)).readUInt32BE()).toBe(2)
    c.ws.close()
  })

  it('a ticket works only once', async () => {
    const s = await start({ security: 'none' })
    const host = '127.0.0.1'
    const url = await issueVncTicket({ host, port: s.port, open: () => openTcp(host, s.port), verifyCert: async () => true })
    await dial(url)
    await expect(dial(url)).rejects.toThrow()
  })

  it('explains an unreachable server in RFB terms', async () => {
    const s = await start({ security: 'none' })
    s.close()
    const c = await open(s)
    expect((await c.read(12)).toString()).toBe('RFB 003.008\n')
    c.send('RFB 003.008\n')
    expect(await reason(c)).toMatch(new RegExp(`^\\${VNC_PROXY_ERROR}Could not reach`))
  })

  it('refuses a security type noVNC could only fail on', async () => {
    const c = await open(await start({ security: 'ra2' }))
    await c.read(12)
    c.send('RFB 003.008\n')
    expect(await reason(c)).toContain('RealVNC')
  })

  it('reports anonymous-TLS-only VeNCrypt', async () => {
    const c = await open(await start({ security: 'anon' }))
    await c.read(12)
    c.send('RFB 003.008\n')
    expect(await reason(c)).toContain('anonymous TLS')
  })

  it('falls back to the other types when VeNCrypt has nothing usable', async () => {
    const s = await start({ security: 'anon+vnc' })
    const c = await open(s)
    await c.read(12)
    c.send('RFB 003.008\n')
    expect([...(await c.read(2))]).toEqual([1, 2])
    expect(s.seen.connections).toBe(2)
    c.ws.close()
  })

  it.runIf(hasOpenssl)('does X509None over TLS and shows noVNC plain None', async () => {
    const seenCerts: Buffer[] = []
    const s = await start({ security: 'x509none', tls: makeCert() })
    const c = await open(s, async (der) => {
      seenCerts.push(der)
      return true
    })
    await c.read(12)
    c.send('RFB 003.008\n')
    expect([...(await c.read(2))]).toEqual([1, 1])
    c.send(Buffer.from([1]))
    expect((await c.read(4)).readUInt32BE()).toBe(0)
    expect(seenCerts.length).toBe(1)
    c.ws.close()
  })

  it.runIf(hasOpenssl)('stops when the certificate is not trusted', async () => {
    const c = await open(await start({ security: 'x509vnc', tls: makeCert() }), async () => false)
    await c.read(12)
    c.send('RFB 003.008\n')
    expect(await reason(c)).toContain('not trusted')
  })
})
