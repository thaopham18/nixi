import { app } from 'electron'
import { createRequire } from 'module'
import { join } from 'path'

/** One promised item dropped somewhere: write it to `path` (full path, folder + name). */
export interface PromiseWrite {
  type: 'write'
  token: string
  index: number
  path: string
  requestId: string
}
export type PromiseEvent = PromiseWrite | { type: 'end'; token: string; dropped: boolean }

interface Addon {
  init(cb: (e: PromiseEvent) => void): void
  startDrag(nsView: Buffer, token: string, items: { name: string; isDir: boolean }[]): boolean
  /** finish one write; an error message fails it in Finder */
  complete(requestId: string, error?: string): void
}

let addon: Addon | null | undefined

/**
 * macOS file-promise drags (native/drag-promise.mm, built by scripts/build-native.mjs). null on
 * other systems or when the module is missing: callers fall back to temp-folder drags.
 */
export function promiseDragAddon(onEvent?: (e: PromiseEvent) => void): Addon | null {
  if (addon !== undefined) return addon
  addon = null
  if (process.platform !== 'darwin' || !onEvent || process.env.NIXI_NO_PROMISE_DRAG) return null
  const file = app.isPackaged ? join(process.resourcesPath, 'nixi_drag.node') : join(app.getAppPath(), 'native', 'out', 'nixi_drag.node')
  try {
    const mod = createRequire(__filename)(file) as Addon
    mod.init(onEvent)
    addon = mod
  } catch (err) {
    console.warn('file-promise drags unavailable:', (err as Error).message)
  }
  return addon
}
