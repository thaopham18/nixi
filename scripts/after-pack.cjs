// electron-builder afterPack hook (see electron-builder.yml).
// macOS: Chromium's UI translations live inside Electron Framework.framework (≈40 MB for ~55
// languages) where `electronLanguages` does not reach; keep only the ones in that list. Removing
// files breaks the framework's existing ad-hoc signature, so the app is re-signed ad hoc
// (unsigned builds only: with a Developer ID, electron-builder signs after this hook anyway).
const { execFileSync } = require('child_process')
const { readdirSync, rmSync } = require('fs')
const { join } = require('path')

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return
  const keep = new Set((ctx.packager.config.electronLanguages ?? ['en']).map((l) => l.replace('-', '_')))
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  const res = join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources')
  let removed = 0
  for (const dir of readdirSync(res)) {
    if (!dir.endsWith('.lproj')) continue
    const lang = dir.slice(0, -'.lproj'.length)
    if (keep.has(lang)) continue
    rmSync(join(res, dir), { recursive: true, force: true })
    removed++
  }
  console.log(`  • afterPack: removed ${removed} Chromium locales, kept ${[...keep].join(', ')}`)
  if (!ctx.packager.platformSpecificBuildOptions.identity && process.env.CSC_LINK === undefined) {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app])
    console.log('  • afterPack: ad-hoc signed')
  }
}
