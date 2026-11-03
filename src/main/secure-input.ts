import { app } from 'electron'
import { createRequire } from 'module'
import { join } from 'path'

interface Addon {
  enable(): void
  disable(): void
}

let addon: Addon | null | undefined
let enabled = false
/** a terminal that takes English only has focus inside the page */
let wanted = false
let windowFocused = false

/** native/secure-input.mm, built by scripts/build-native.mjs. null elsewhere or when the module is missing. */
function load(): Addon | null {
  if (addon !== undefined) return addon
  addon = null
  if (process.platform !== 'darwin') return null
  const file = app.isPackaged ? join(process.resourcesPath, 'nixi_secure_input.node') : join(app.getAppPath(), 'native', 'out', 'nixi_secure_input.node')
  try {
    addon = createRequire(__filename)(file) as Addon
  } catch (err) {
    console.warn('secure keyboard entry unavailable:', (err as Error).message)
  }
  return addon
}

/** It covers the whole login session, so it is never on while the user is in another app. */
function apply(): void {
  const on = wanted && windowFocused
  // macOS counts these calls, so only a real change reaches it.
  if (on === enabled) return
  const native = load()
  if (!native) return
  if (on) native.enable()
  else native.disable()
  enabled = on
}

export function setSecureInput(on: boolean): void {
  wanted = on
  apply()
}

export function setSecureInputWindowFocus(focused: boolean): void {
  windowFocused = focused
  apply()
}
