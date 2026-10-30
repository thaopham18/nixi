import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'crypto'
import type { Macro, Session, Settings, Tunnel } from '@shared/types'

// File format of the Nixi database (see database.ts). Kept free of Electron so it can be tested.
// The format id "ezterm-db" dates from the app's first name (EZTERM). It is part of the encrypted
// data's AAD: changing it would make every existing database unreadable.
//   { format: "ezterm-db", version: 1,
//     kdf: { name: "scrypt", N, r, p, salt },          // base64 salt
//     cipher: { name: "aes-256-gcm", iv, tag },        // base64
//     data: "<base64 ciphertext>" }
// The format/version/kdf header is bound to the ciphertext as AES-GCM additional data.

export interface DbData {
  settings: Partial<Settings>
  sessions: Session[]
  tunnels: Tunnel[]
  macros: Macro[]
  /** session folders that exist on their own (a folder with sessions exists through them anyway) */
  folders: string[]
  knownHosts: Record<string, string>
  /** passwords / key passphrases by session id (plain here: the whole file is encrypted) */
  secrets: Record<string, string>
}

export interface Kdf {
  name: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
}

export interface DbFile {
  format: 'ezterm-db'
  version: 1
  kdf: Kdf
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string }
  data: string
}

export const emptyData = (): DbData => ({ settings: {}, sessions: [], tunnels: [], macros: [], folders: [], knownHosts: {}, secrets: {} })

export function newKdf(N = 2 ** 17): Kdf {
  // N = 2^17 → ~128 MB and a few hundred ms per unlock: slows down brute force of a stolen file.
  return { name: 'scrypt', N, r: 8, p: 1, salt: randomBytes(16).toString('base64') }
}

export function deriveKey(password: string, kdf: Kdf): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  )
}

const aad = (kdf: Kdf): Buffer => Buffer.from(JSON.stringify({ format: 'ezterm-db', version: 1, kdf }))

export function encryptDb(payload: DbData, key: Buffer, kdf: Kdf): DbFile {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aad(kdf))
  const enc = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()])
  return {
    format: 'ezterm-db',
    version: 1,
    kdf,
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') },
    data: enc.toString('base64')
  }
}

export function decryptDb(file: DbFile, key: Buffer): DbData {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'))
  d.setAAD(aad(file.kdf))
  d.setAuthTag(Buffer.from(file.cipher.tag, 'base64'))
  let plain: Buffer
  try {
    plain = Buffer.concat([d.update(Buffer.from(file.data, 'base64')), d.final()])
  } catch {
    throw new Error('Wrong master password (or the file is damaged)')
  }
  return { ...emptyData(), ...JSON.parse(plain.toString('utf8')) }
}

export function parseDbFile(text: string): DbFile {
  const file = JSON.parse(text) as DbFile
  if (file.format !== 'ezterm-db' || file.version !== 1 || file.kdf?.name !== 'scrypt') throw new Error('Not a Nixi database')
  return file
}
