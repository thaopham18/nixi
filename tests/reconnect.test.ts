import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endsSession, isNetworkError, isRdpDrop, Retry, RETRY_LIMIT, STABLE_MS } from '../src/shared/reconnect'

describe('isNetworkError', () => {
  it.each(['connect ECONNREFUSED 10.0.0.1:22', 'read ECONNRESET', 'connect ETIMEDOUT', 'getaddrinfo ENOTFOUND x', 'Timed out while waiting for handshake', 'Could not reach 10.0.0.1:5900', 'Connection to h:23 timed out'])('retries %s', (m) => {
    expect(isNetworkError(m)).toBe(true)
  })
  it.each(['All configured authentication methods failed', 'Session not found', 'Session "x" has no host', 'Host key rejected', 'Cannot parse privateKey'])('gives up on %s', (m) => {
    expect(isNetworkError(m)).toBe(false)
  })
})

describe('isRdpDrop', () => {
  it('tells a drop from a logoff', () => {
    expect(isRdpDrop('connection reset by peer')).toBe(true)
    expect(isRdpDrop('WebSocket closed')).toBe(true)
    expect(isRdpDrop('user logged off')).toBe(false)
    expect(isRdpDrop('Disconnected by the administrator: connection closed')).toBe(false)
    expect(isRdpDrop('')).toBe(false)
  })
})

describe('endsSession', () => {
  it.each(['exit', 'logout', ' quit ', 'me@host:~$ exit', 'Router# exit', 'Router>logout', 'mysql> quit'])('%s ends it', (l) => {
    expect(endsSession(l)).toBe(true)
  })
  it.each(['reboot', 'exit-code.sh', 'ls exit.txt', 'echo done', ''])('%s does not', (l) => {
    expect(endsSession(l)).toBe(false)
  })
})

describe('Retry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('counts down, then fires', () => {
    const r = new Retry()
    const ticks: number[][] = []
    const fire = vi.fn()
    expect(r.next((left, n) => ticks.push([left, n]), fire)).toBe(true)
    expect(r.waiting).toBe(true)
    vi.advanceTimersByTime(2999)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fire).toHaveBeenCalledOnce()
    expect(r.waiting).toBe(false)
    expect(ticks).toEqual([[3, 1], [2, 1], [1, 1]])
  })

  it('gives up after the limit', () => {
    const r = new Retry()
    for (let i = 0; i < RETRY_LIMIT; i++) {
      expect(r.next(() => {}, () => {})).toBe(true)
      r.skip()
    }
    expect(r.next(() => {}, () => {})).toBe(false)
  })

  it('stop cancels the pause, and a try under way starts no new one', () => {
    const r = new Retry()
    const fire = vi.fn()
    r.next(() => {}, fire)
    r.stop()
    vi.advanceTimersByTime(60_000)
    expect(fire).not.toHaveBeenCalled()
    expect(r.next(() => {}, fire)).toBe(false)
  })

  it('a connection that held starts the tries over, one that fell at once does not', () => {
    const tries: number[] = []
    const tick = (_left: number, n: number): number => tries.push(n)
    const r = new Retry()
    r.next(tick, () => {})
    r.up(1000)
    r.down(1000 + STABLE_MS - 1)
    r.next(tick, () => {})
    r.up(5000)
    r.down(5000 + STABLE_MS)
    r.next(tick, () => {})
    expect(tries).toEqual([1, 2, 1])
    r.stop()
  })
})
