// Decrypt a Nixi database file (format: src/main/store/db-crypto.ts). Used by e2e tests;
// also handy to inspect your own file:  node scripts/read-db.mjs path/to/nixi.nxdb <master password>
import { createDecipheriv, scryptSync } from 'crypto'
import { readFileSync } from 'fs'
import { pathToFileURL } from 'url'

export function readDb(path, password) {
  const file = JSON.parse(readFileSync(path, 'utf8'))
  const { N, r, p, salt } = file.kdf
  const key = scryptSync(password, Buffer.from(salt, 'base64'), 32, { N, r, p, maxmem: 256 * 1024 * 1024 })
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'))
  d.setAAD(Buffer.from(JSON.stringify({ format: 'ezterm-db', version: 1, kdf: file.kdf })))
  d.setAuthTag(Buffer.from(file.cipher.tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(file.data, 'base64')), d.final()]).toString('utf8'))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(readDb(process.argv[2], process.argv[3]), null, 2))
}
