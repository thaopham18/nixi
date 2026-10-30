import { describe, expect, it } from 'vitest'
import { AutoLogin, DO, DONT, IAC, OPT_ECHO, OPT_NAWS, OPT_TTYPE, SB, SE, TelnetClient, WILL, WONT } from '../src/main/telnet/protocol'

function client(): { c: TelnetClient; sent: number[][] } {
  const sent: number[][] = []
  const c = new TelnetClient((b) => sent.push([...b]))
  return { c, sent }
}

describe('Telnet protocol', () => {
  it('strips negotiation and keeps data, even split across chunks', () => {
    const { c } = client()
    const a = c.receive(Buffer.from([0x68, 0x69, IAC]))
    const b = c.receive(Buffer.from([WILL, OPT_ECHO, 0x21, IAC, IAC, 0x0d, 0x00, 0x0a]))
    expect([...a, ...b]).toEqual([0x68, 0x69, 0x21, 0xff, 0x0d, 0x0a])
  })

  it('accepts ECHO/TTYPE/NAWS, refuses the rest, and does not loop', () => {
    const { c, sent } = client()
    c.resize(132, 43)
    c.receive(Buffer.from([IAC, WILL, OPT_ECHO, IAC, DO, OPT_TTYPE, IAC, DO, OPT_NAWS, IAC, DO, 39, IAC, WILL, 5]))
    expect(sent).toEqual([
      [IAC, DO, OPT_ECHO],
      [IAC, WILL, OPT_TTYPE],
      [IAC, WILL, OPT_NAWS],
      [IAC, SB, OPT_NAWS, 0, 132, 0, 43, IAC, SE],
      [IAC, WONT, 39],
      [IAC, DONT, 5]
    ])
    sent.length = 0
    c.receive(Buffer.from([IAC, WILL, OPT_ECHO, IAC, DO, OPT_NAWS])) // repeats: no answer
    expect(sent).toEqual([])
  })

  it('answers terminal type and window size updates', () => {
    const { c, sent } = client()
    c.receive(Buffer.from([IAC, DO, OPT_TTYPE, IAC, DO, OPT_NAWS]))
    sent.length = 0
    c.receive(Buffer.from([IAC, SB, OPT_TTYPE, 1, IAC, SE]))
    expect(Buffer.from(sent[0]).subarray(4, -2).toString()).toBe('XTERM-256COLOR')
    c.resize(255, 50) // 255 must be escaped inside the subnegotiation
    expect(sent[1]).toEqual([IAC, SB, OPT_NAWS, 0, IAC, IAC, 0, 50, IAC, SE])
  })

  it('encodes Enter as CR LF and escapes 0xFF', () => {
    const { c } = client()
    expect([...c.encode('ls\r')]).toEqual([0x6c, 0x73, 0x0d, 0x0a])
    expect([...c.encode('a\r\nb')]).toEqual([0x61, 0x0d, 0x0a, 0x62])
    expect([...c.encode('\xff', 'latin1')]).toEqual([IAC, IAC])
  })
})

describe('AutoLogin', () => {
  it('answers login then password once', () => {
    const typed: string[] = []
    const a = new AutoLogin('admin', 's3cret', (t) => typed.push(t))
    a.feed('Welcome\r\nUser Access Verification\r\n\r\nUsername: ')
    a.feed('admin\r\nPassword: ')
    a.feed('\r\nrouter> ')
    a.feed('Password: ')
    expect(typed).toEqual(['admin\r', 's3cret\r'])
    expect(a.done).toBe(true)
  })
})
