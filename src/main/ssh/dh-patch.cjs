// Diffie-Hellman fixes for ssh2 on old SSH servers. Runs as the banner of the main bundle (electron.vite.config.ts),
// before ssh2 loads, because ssh2 copies these crypto functions when it loads.
;(() => {
  const crypto = require('crypto')

  // 1. Electron's BoringSSL has no "modp2" group, so diffie-hellman-group1-sha1 (old Cisco / embedded servers)
  //    throws "Unknown DH group". Give it the group by value (RFC 2409, Oakley group 2, generator 2).
  const MODP2 =
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF'
  const originalGroup = crypto.createDiffieHellmanGroup
  let hasModp2 = true
  try {
    originalGroup('modp2')
  } catch {
    hasModp2 = false
  }
  if (!hasModp2) {
    const group = function (name) {
      return name === 'modp2' ? crypto.createDiffieHellman(Buffer.from(MODP2, 'hex'), Buffer.from([2])) : originalGroup.call(crypto, name)
    }
    crypto.createDiffieHellmanGroup = group
    crypto.getDiffieHellman = group
  }

  // 2. Group exchange (diffie-hellman-group-exchange-*): the server picks the prime. Node checks that a prime passed to
  //    createDiffieHellman is prime before anything else: 3.5 s at 4096 bits, 11 s at 6144, 30 s at 8192 (measured in
  //    Electron 33), over ssh2's 20 s handshake timeout. Old OpenSSH (5.x) answers with a group one size larger than
  //    asked. OpenSSH itself doesn't run that check: the group comes inside the key exchange the host key signs, so
  //    nobody in between can swap it, and a server that lies about its own group only hurts its own session.
  //    For primes over 2048 bits use plain BigInt math instead, with a 512-bit secret exponent like OpenSSH.
  //    BigInt is not constant-time; the exponent is used for this one handshake only.
  const toBig = (buf) => BigInt('0x' + (buf.toString('hex') || '0'))
  const toBuf = (n) => {
    const hex = n.toString(16)
    return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex')
  }
  const modPow = (base, exp, mod) => {
    let result = 1n
    base %= mod
    while (exp > 0n) {
      if (exp & 1n) result = (result * base) % mod
      exp >>= 1n
      base = (base * base) % mod
    }
    return result
  }
  class BigDiffieHellman {
    constructor(prime, generator) {
      this.p = toBig(prime)
      this.g = toBig(generator)
      if (this.g <= 1n || this.g >= this.p - 1n) throw new Error('Invalid DH generator')
    }
    generateKeys() {
      do this.x = toBig(crypto.randomBytes(64))
      while (this.x < 2n)
      this.y = modPow(this.g, this.x, this.p)
      return this.getPublicKey()
    }
    getPublicKey() {
      return toBuf(this.y)
    }
    computeSecret(other) {
      const f = toBig(other)
      if (f <= 1n || f >= this.p - 1n) throw new Error('Invalid DH public key')
      return toBuf(modPow(f, this.x, this.p))
    }
    getPrime() {
      return toBuf(this.p)
    }
    getGenerator() {
      return toBuf(this.g)
    }
  }
  const originalCreate = crypto.createDiffieHellman
  crypto.createDiffieHellman = function (prime, generator, ...rest) {
    // ssh2's group exchange passes (Buffer prime, Buffer generator); anything else goes to Node as before.
    if (Buffer.isBuffer(prime) && Buffer.isBuffer(generator) && !rest.length && prime.length > 257) return new BigDiffieHellman(prime, generator)
    return originalCreate.call(crypto, prime, generator, ...rest)
  }
})();
