import { describe, expect, it } from 'vitest'
import { decryptDb, deriveKey, emptyData, encryptDb, newKdf, parseDbFile } from '../src/main/store/db-crypto'

// Small scrypt cost so the tests stay fast; the app uses N = 2^17.
const kdf = newKdf(2 ** 10)

describe('Nixi database file', () => {
  it('round-trips with the right master password', async () => {
    const key = await deriveKey('correct horse', kdf)
    const data = { ...emptyData(), sessions: [{ id: 's', name: 'web', type: 'ssh' as const, folder: '', host: '10.1.2.3' }], secrets: { s: 'p@ss' } }
    const file = parseDbFile(JSON.stringify(encryptDb(data, key, kdf)))
    expect(decryptDb(file, key)).toEqual(data)
  })

  it('keeps nothing readable in the file', async () => {
    const key = await deriveKey('correct horse', kdf)
    const text = JSON.stringify(encryptDb({ ...emptyData(), secrets: { s: 'super-secret-pw' }, sessions: [] }, key, kdf))
    expect(text).not.toContain('super-secret-pw')
    expect(text).not.toContain('secrets')
  })

  it('rejects a wrong password and a tampered header', async () => {
    const key = await deriveKey('correct horse', kdf)
    const file = encryptDb(emptyData(), key, kdf)
    expect(() => decryptDb(file, Buffer.alloc(32, 1))).toThrow(/Wrong master password/)
    expect(() => decryptDb({ ...file, kdf: { ...file.kdf, N: 2 ** 4 } }, key)).toThrow(/Wrong master password/)
    expect(() => parseDbFile('{"format":"other"}')).toThrow(/Not a Nixi database/)
  })
})
