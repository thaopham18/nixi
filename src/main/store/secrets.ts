import { DbStore } from './database'

// Passwords / key passphrases. They live inside the encrypted database file, so they are
// stored as-is here (like entries in a KeePass database).
const store = new DbStore('secrets', {})

export function setSecret(id: string, secret: string): void {
  store.set({ ...store.get(), [id]: secret })
}

export function getSecret(id: string): string | undefined {
  return store.get()[id]
}

/** Every saved value, to hide them in text that leaves this computer. */
export function allSecrets(): string[] {
  return Object.values(store.get())
}

export function hasSecret(id: string): boolean {
  return id in store.get()
}

export function deleteSecret(id: string): void {
  const all = { ...store.get() }
  delete all[id]
  store.set(all)
}
