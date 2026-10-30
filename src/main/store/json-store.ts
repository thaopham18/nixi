import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export function dataPath(file: string): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, file)
}

/** Small JSON file store with atomic writes. */
export class JsonStore<T> {
  private path: string
  private value: T

  constructor(file: string, defaults: T) {
    this.path = dataPath(file)
    this.value = defaults
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
        this.value = Array.isArray(defaults) ? parsed : { ...defaults, ...parsed }
      } catch (err) {
        console.error(`Failed to read ${this.path}, using defaults`, err)
      }
    }
  }

  get(): T {
    return this.value
  }

  set(value: T): void {
    this.value = value
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }
}
