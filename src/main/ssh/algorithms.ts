import type { ConnectConfig } from 'ssh2'

/**
 * Old servers (CentOS 5/6, old Cisco / Juniper / HP switches, embedded boxes) only speak algorithms that ssh2 leaves
 * out by default. Offer them after the modern ones, like MobaXterm and Termius do: the client's order decides, so a
 * modern server still picks what it picked before, and the whole offer is covered by the signed key exchange, so
 * nobody in between can strip the modern ones to force a weak one. A RegExp only adds what this build of crypto
 * can actually run (ssh2 checks), so Node and Electron each get what they support.
 *
 * Not offered: ssh-dss host keys. Electron's BoringSSL can't verify DSA signatures, so such a login would fail with
 * a confusing "signature verification failed"; `explainHandshakeError` says it plainly instead.
 */
export const SSH_ALGORITHMS: ConnectConfig['algorithms'] = {
  // diffie-hellman-group-exchange-sha1, -group14-sha1, -group1-sha1 (group1 and big group-exchange primes: dh-patch.cjs)
  kex: { append: [/-sha1$/] },
  // aes*-cbc, blowfish-cbc, 3des-cbc, arcfour*
  cipher: { append: [/-cbc$/, /^arcfour/] },
  // hmac-md5, hmac-sha1-96, hmac-ripemd160…
  hmac: { append: [/^hmac-/] }
} as unknown as ConnectConfig['algorithms'] // @types/ssh2 lacks RegExp; ssh2 1.x accepts it

/** ssh2's negotiation errors name the category but not why; say what an old server needs. */
export function explainHandshakeError(message: string): string {
  if (!/^Handshake failed: no matching/i.test(message)) return message
  if (/host key/i.test(message))
    return `${message}. The server only offers a host key type Nixi can't check (old DSA "ssh-dss" keys are not supported); add an RSA or ECDSA host key on the server.`
  return `${message}. The server only offers algorithms Nixi doesn't support, even among the old ones.`
}

/** How long the whole login may take once TCP is up. ssh2 counts key exchange *and* authentication in its
 * "handshake" timeout. Old RHEL / CentOS servers default to UseDNS and GSSAPIAuthentication, and when their DNS
 * can't resolve the client they stall the login for 20–40 s; OpenSSH and MobaXterm just wait. */
export const LOGIN_TIMEOUT_SEC = 90
/** No TCP connection by then: the host is unreachable, no point waiting for a login. */
export const TCP_TIMEOUT_SEC = 20

/** Turn ssh2's bare "Timed out while waiting for handshake" into where it stopped. `steps` are ssh2 debug lines. */
export function explainTimeout(steps: string[], askingHostKey: boolean): string {
  const last = steps.filter((s) => !/^Socket (ended|closed)/.test(s)).at(-1)
  const at = last ? ` Last step: ${last}.` : ''
  if (askingHostKey) return `Timed out while waiting for the host key to be accepted (${LOGIN_TIMEOUT_SEC} s).`
  if (steps.some((s) => /Handshake completed/.test(s)))
    return (
      `Timed out logging in: the connection is encrypted but the server did not finish the login in ${LOGIN_TIMEOUT_SEC} s.` +
      ' On old servers this is usually sshd looking up the client in DNS (UseDNS / GSSAPIAuthentication in sshd_config).' +
      at
    )
  return `Timed out during the key exchange (${LOGIN_TIMEOUT_SEC} s).${at}`
}
