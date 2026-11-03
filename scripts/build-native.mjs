// Build native/*.mm → native/out/*.node (macOS only; elsewhere a no-op).
// One universal binary (x86_64 + arm64) built with N-API, so the same file loads in any Electron
// version and on both Mac kinds. Needs the Xcode command line tools (clang) and Node's headers.
//   node scripts/build-native.mjs
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

if (process.platform !== 'darwin') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = [
  { src: 'drag-promise.mm', name: 'nixi_drag', framework: 'AppKit', without: 'dragging SFTP items out falls back to temp-folder downloads' },
  { src: 'secure-input.mm', name: 'nixi_secure_input', framework: 'Carbon', without: 'tools like EVKey still reach SSH and Telnet terminals' }
]
const stale = MODULES.filter(({ src, name }) => {
  const out = join(root, 'native', 'out', `${name}.node`)
  return !existsSync(out) || statSync(out).mtimeMs <= statSync(join(root, 'native', src)).mtimeMs
})
if (!stale.length) process.exit(0)

const include = [join(dirname(process.execPath), '..', 'include', 'node'), join(root, 'node_modules', 'node-api-headers', 'include')].find((d) =>
  existsSync(join(d, 'node_api.h'))
)
if (!include) {
  for (const { without } of stale) console.warn(`build-native: node_api.h not found, ${without}`)
  process.exit(0)
}
mkdirSync(join(root, 'native', 'out'), { recursive: true })
for (const { src, name, framework, without } of stale) {
  const out = join(root, 'native', 'out', `${name}.node`)
  try {
    execFileSync(
      'clang++',
      [
        ...['-std=c++17', '-ObjC++', '-fobjc-arc', '-O2', '-Wall'],
        ...['-arch', 'x86_64', '-arch', 'arm64', '-mmacosx-version-min=11.0'],
        ...['-bundle', '-undefined', 'dynamic_lookup', `-DNODE_GYP_MODULE_NAME=${name}`],
        ...['-I', include, '-framework', framework, '-o', out, join(root, 'native', src)]
      ],
      { stdio: 'inherit' }
    )
    console.log('build-native: wrote', out)
  } catch (err) {
    // e.g. no Xcode command line tools (xcode-select --install): the app still works without it
    console.warn(`build-native: could not build ${src} (${err.message}); ${without}`)
  }
}
