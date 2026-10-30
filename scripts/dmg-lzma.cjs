// electron-builder afterAllArtifactBuild hook (see electron-builder.yml).
// electron-builder writes UDZO (zlib) disk images; LZMA (ULMO, macOS 10.15+, same minimum as
// Electron 33) makes the .dmg ~12% smaller. Re-encode each .dmg in place; the .blockmap is for
// auto-update (not used) and would no longer match, so it is removed.
const { execFileSync } = require('child_process')
const { renameSync, rmSync, statSync } = require('fs')

exports.default = async function dmgLzma(result) {
  for (const file of result.artifactPaths.filter((p) => p.endsWith('.dmg'))) {
    const tmp = file.replace(/\.dmg$/, '.lzma.dmg')
    rmSync(tmp, { force: true })
    const before = statSync(file).size
    execFileSync('hdiutil', ['convert', file, '-format', 'ULMO', '-o', tmp, '-quiet'])
    renameSync(tmp, file)
    rmSync(file + '.blockmap', { force: true })
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB'
    console.log(`  • dmg-lzma: ${file.split('/').pop()} ${mb(before)} → ${mb(statSync(file).size)}`)
  }
  return []
}
