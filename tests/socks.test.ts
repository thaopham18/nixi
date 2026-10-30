import { describe, expect, it } from 'vitest'
import { parseSocks5Greeting, parseSocks5Request } from '../src/main/ssh/socks'

describe('SOCKS5 parsing', () => {
  it('parses the greeting', () => {
    expect(parseSocks5Greeting(Buffer.from([5, 1]))).toBeNull()
    expect(parseSocks5Greeting(Buffer.from([5, 2, 0, 2]))).toBe(4)
  })

  it('parses IPv4 CONNECT', () => {
    const buf = Buffer.from([5, 1, 0, 1, 10, 0, 0, 5, 0x1f, 0x90])
    expect(parseSocks5Request(buf)).toEqual({ host: '10.0.0.5', port: 8080, length: 10 })
  })

  it('parses domain CONNECT and waits for more data', () => {
    const name = Buffer.from('example.com')
    const full = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([0, 80])])
    expect(parseSocks5Request(full.subarray(0, 8))).toBeNull()
    expect(parseSocks5Request(full)).toEqual({ host: 'example.com', port: 80, length: full.length })
  })

  it('rejects BIND', () => {
    expect(() => parseSocks5Request(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))).toThrow()
  })
})
