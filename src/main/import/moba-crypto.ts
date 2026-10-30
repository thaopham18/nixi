import { createCipheriv, createDecipheriv, createHash } from 'crypto'

// MobaXterm master-password encryption: key = SHA512(master password)[:32], AES-256-CFB8.
// Newer versions store "_@" + 16-char IV + base64 (alphabet with "@_" or "+/"), sometimes behind an
// "em:" or "em:/" prefix; older versions use IV = AES-ECB(key, 0^16) over the whole base64 value.
// The layout differs between versions, so several candidates are tried and the one that decrypts
// to readable text wins. A wrong password yields no readable candidate.

function b64(s: string, alt: boolean): Buffer {
  return Buffer.from(alt ? s.replace(/@/g, '+').replace(/_/g, '/') : s, 'base64')
}

function cfb8(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const d = createDecipheriv('aes-256-cfb8', key, iv)
  return Buffer.concat([d.update(data), d.final()])
}

/** Share of characters that look like text a macro or password would contain. */
export function readability(buf: Buffer): number {
  if (!buf.length) return 0
  let s: string
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return 0
  }
  const ok = [...s].filter((c) => /[\t\r\n\x20-\x7e]/.test(c) || c.charCodeAt(0) > 0xa0).length
  return ok / [...s].length
}

export function mobaKey(masterPassword: string): Buffer {
  return createHash('sha512').update(masterPassword, 'utf8').digest().subarray(0, 32)
}

export function decryptMoba(value: string, masterPassword: string): string | null {
  const key = mobaKey(masterPassword)
  const v = value.replace(/^em:/, '')
  const candidates: Buffer[] = []
  const tryAdd = (fn: () => Buffer): void => {
    try {
      candidates.push(fn())
    } catch {
      /* malformed candidate */
    }
  }
  for (const s of [v, v.replace(/^\//, '')]) {
    if (s.startsWith('_@') && s.length > 18) {
      const iv = Buffer.from(s.slice(2, 18), 'latin1')
      for (const alt of [true, false]) {
        tryAdd(() => cfb8(key, iv, b64(s, alt).subarray(15)))
        tryAdd(() => cfb8(key, iv, b64(s.slice(18), alt)))
        tryAdd(() => cfb8(key, iv, b64(s.slice(20), alt)))
      }
    }
    const ecb = createCipheriv('aes-256-ecb', key, null)
    const legacyIv = Buffer.concat([ecb.update(Buffer.alloc(16)), ecb.final()]).subarray(0, 16)
    for (const alt of [true, false]) tryAdd(() => cfb8(key, legacyIv, b64(s, alt)))
  }
  let best: Buffer | undefined
  let bestScore = 0
  for (const c of candidates) {
    const score = readability(c)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  return best && bestScore >= 0.95 ? best.toString('utf8') : null
}

/** Inverse of the "_@" format, used by tests to produce known ciphertexts. */
export function encryptMobaForTest(plain: string, masterPassword: string, iv = 'abcdefghijklmnop'): string {
  const c = createCipheriv('aes-256-cfb8', mobaKey(masterPassword), Buffer.from(iv, 'latin1'))
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return 'em:_@' + iv + body.toString('base64')
}
