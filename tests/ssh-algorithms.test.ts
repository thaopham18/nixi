import { describe, expect, it } from 'vitest'
import { createDiffieHellmanGroup } from 'crypto'
import { createRequire } from 'module'
import { explainHandshakeError, explainTimeout } from '../src/main/ssh/algorithms'

describe('explainHandshakeError', () => {
  it('says why a host key type is not accepted', () => {
    const m = explainHandshakeError('Handshake failed: no matching host key format')
    expect(m).toMatch(/ssh-dss/)
    expect(m).toMatch(/^Handshake failed: no matching host key format\./)
  })
  it('names old algorithms for the other categories', () => {
    expect(explainHandshakeError('Handshake failed: no matching cipher')).toMatch(/even among the old ones/)
  })
  it('leaves other errors alone', () => {
    expect(explainHandshakeError('All configured authentication methods failed')).toBe('All configured authentication methods failed')
  })
})

// 3072-bit MODP group (RFC 3526), generator 2: big enough for the BigInt path.
const P3072 =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF'

describe('dh-patch', () => {
  const req = createRequire(import.meta.url)
  const crypto = req('crypto')
  const nativeCreate = crypto.createDiffieHellman
  req('../src/main/ssh/dh-patch.cjs')

  it('leaves group1 alone where Node has it', () => {
    expect(createDiffieHellmanGroup('modp2').getPrime('hex').length).toBe(256)
  })

  it('agrees with native Diffie-Hellman on a big group-exchange prime', () => {
    const prime = Buffer.from(P3072, 'hex')
    const g = Buffer.from([2])
    const fast = crypto.createDiffieHellman(prime, g)
    expect(fast.constructor.name).toBe('BigDiffieHellman')
    const native = nativeCreate(prime, g)
    const fastPub = fast.generateKeys()
    const nativePub = native.generateKeys()
    expect(fast.computeSecret(nativePub).toString('hex').replace(/^0+/, '')).toBe(native.computeSecret(fastPub).toString('hex').replace(/^0+/, ''))
    expect(fast.getPrime().equals(prime)).toBe(true)
    expect(fast.getGenerator().equals(g)).toBe(true)
  })

  it('rejects a public value out of range', () => {
    const fast = crypto.createDiffieHellman(Buffer.from(P3072, 'hex'), Buffer.from([2]))
    fast.generateKeys()
    expect(() => fast.computeSecret(Buffer.from([1]))).toThrow(/Invalid DH public key/)
    expect(() => fast.computeSecret(Buffer.from(P3072, 'hex'))).toThrow(/Invalid DH public key/)
  })

  it('keeps native for small primes and other call shapes', () => {
    expect(crypto.createDiffieHellman(512).constructor.name).not.toBe('BigDiffieHellman')
    expect(crypto.createDiffieHellman(P3072, 'hex', Buffer.from([2])).constructor.name).not.toBe('BigDiffieHellman')
  })
})

describe('explainTimeout', () => {
  it('points at slow logins once the connection is encrypted', () => {
    const m = explainTimeout(['Socket connected', 'Handshake completed', 'Outbound: Sending SERVICE_REQUEST (ssh-userauth)', 'Socket closed'], false)
    expect(m).toMatch(/^Timed out logging in/)
    expect(m).toMatch(/UseDNS/)
    expect(m).toMatch(/Last step: Outbound: Sending SERVICE_REQUEST \(ssh-userauth\)\.$/)
  })
  it('says the key exchange stalled, and where', () => {
    expect(explainTimeout(['Socket connected', 'Outbound: Sending KEXDH_GEX_REQUEST'], false)).toBe(
      'Timed out during the key exchange (90 s). Last step: Outbound: Sending KEXDH_GEX_REQUEST.'
    )
  })
  it('blames an unanswered host key question', () => {
    expect(explainTimeout(['Handshake completed'], true)).toMatch(/host key to be accepted/)
  })
  it('still reads as a timeout, so auto reconnect retries it', () => {
    for (const m of [explainTimeout([], false), explainTimeout(['Handshake completed'], false)]) expect(m).toMatch(/timed out/i)
  })
})
