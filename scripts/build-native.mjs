// Build native/drag-promise.mm → native/out/nixi_drag.node (macOS only; elsewhere a no-op).
// One universal binary (x86_64 + arm64) built with N-API, so the same file loads in any Electron
// version and on both Mac kinds. Needs the Xcode command line tools (clang) and Node's headers.
//   node scripts/build-native.mjs
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

if (process.platform !== 'darwin') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'native', 'drag-promise.mm')
const out = join(root, 'native', 'out', 'nixi_drag.node')
if (existsSync(out) && statSync(out).mtimeMs > statSync(src).mtimeMs) process.exit(0)

const include = [join(dirname(process.execPath), '..', 'include', 'node'), join(root, 'node_modules', 'node-api-headers', 'include')].find((d) =>
  existsSync(join(d, 'node_api.h'))
)
if (!include) {
  console.warn('build-native: node_api.h not found, dragging SFTP items out falls back to temp-folder downloads')
  process.exit(0)
}
mkdirSync(dirname(out), { recursive: true })
try {
  execFileSync(
    'clang++',
    [
      ...['-std=c++17', '-ObjC++', '-fobjc-arc', '-O2', '-Wall'],
      ...['-arch', 'x86_64', '-arch', 'arm64', '-mmacosx-version-min=11.0'],
      ...['-bundle', '-undefined', 'dynamic_lookup', '-DNODE_GYP_MODULE_NAME=nixi_drag'],
      ...['-I', include, '-framework', 'AppKit', '-o', out, src]
    ],
    { stdio: 'inherit' }
  )
  console.log('build-native: wrote', out)
} catch (err) {
  // e.g. no Xcode command line tools (xcode-select --install): the app still works without it
  console.warn('build-native: could not build the drag module (' + err.message + '); dragging SFTP items out falls back to temp-folder downloads')
}
