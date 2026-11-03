import { describe, expect, it } from 'vitest'
import { lastLines, MASK, redact } from '../src/shared/redact'

describe('redact', () => {
  it.each([
    ['AWS key', 'key AKIAABCDEFGHIJKLMNOP here', 'AKIAABCDEFGHIJKLMNOP'],
    ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz'],
    ['sk- key', 'export KEY=sk-ant-abcdefghijklmnop1234', 'sk-ant-abcdefghijklmnop1234'],
    ['Slack token', 'xoxb-123456789012-abcdefghijkl', 'xoxb-123456789012'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl', 'eyJzdWIiOiIxMjM0In0'],
    ['Bearer', 'curl -H "x: Bearer abcdef123456789"', 'abcdef123456789'],
    ['Authorization', 'Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['password=', 'password=hunter22', 'hunter22'],
    ['DB_PASSWORD=', 'DB_PASSWORD=hunter22', 'hunter22'],
    ['quoted JSON', '{"api_key": "abc 123"}', 'abc 123'],
    ['client-secret:', 'client-secret: topsecretvalue', 'topsecretvalue'],
    ['URL', 'mysql://root:hunter22@db.example:3306/app', 'hunter22'],
    ['mysql -p', 'mysql -uroot -phunter22 app', 'hunter22'],
    ['sshpass', 'sshpass -p hunter22 ssh web1', 'hunter22'],
    ['--password', 'tool --password hunter22', 'hunter22'],
    ['--password=', 'tool --password=hunter22', 'hunter22']
  ])('hides %s', (_name, text, secret) => {
    const out = redact(text)
    expect(out).not.toContain(secret)
    expect(out).toContain(MASK)
  })

  it('hides a whole private key block', () => {
    const out = redact('before\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----\nafter')
    expect(out).toBe(`before\n${MASK}\nafter`)
  })

  it('hides a private key cut off by the edge of the screen', () => {
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nabc\ndef')).toBe(MASK)
  })

  it('hides a private key whose top scrolled off the screen', () => {
    expect(redact('abc\ndef\n-----END RSA PRIVATE KEY-----\n$ ls')).toBe(`${MASK}\n$ ls`)
  })

  it('hides saved values wherever they appear, longest first', () => {
    expect(redact('login with Sup3rSecret! now', ['Sup3rSecret!'])).toBe(`login with ${MASK} now`)
    expect(redact('abcdefgh12', ['abcdefgh', 'abcdefgh12'])).toBe(MASK)
  })

  it('takes saved values literally', () => {
    expect(redact('a.b(c)d* and axb', ['a.b(c)d*'])).toBe(`${MASK} and axb`)
  })

  it('does not hide short saved values, which would blank ordinary words', () => {
    expect(redact('test the tester', ['test'])).toBe('test the tester')
  })

  it.each([
    'ls -la /etc/ssh',
    'total 48\ndrwxr-xr-x  5 root root 4096 Nov  3 10:00 logs',
    'Permission denied (publickey,password).',
    'Enter password:',
    'nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)',
    'mysql -h db -p',
    'mysql -p 3306',
    'ssh -p 2222 web1',
    'https://example.com:8443/path',
    'the secret of good logs is rotation',
    'tokens: 12 used'.replace('tokens', 'count')
  ])('leaves %s alone', (text) => {
    expect(redact(text)).toBe(text)
  })

  it('is stable when applied twice', () => {
    const once = redact('password=hunter22 Bearer abcdef123456789')
    expect(redact(once)).toBe(once)
  })
})

describe('lastLines', () => {
  it('keeps short text as it is', () => {
    expect(lastLines('a\nb', 2)).toEqual({ text: 'a\nb', dropped: 0 })
  })

  it('keeps the newest lines and says how many went', () => {
    expect(lastLines('a\nb\nc\nd', 2)).toEqual({ text: 'c\nd', dropped: 2 })
  })
})
