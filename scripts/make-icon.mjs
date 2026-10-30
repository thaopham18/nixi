// Render build/icon.svg into the app icons electron-builder picks up from build/:
//   icon.png (1024, Linux + dev Dock icon), icon.ico (Windows), icon.icns (macOS, needs iconutil).
//   npx electron scripts/make-icon.mjs
// Runs as an Electron main process: Chromium renders the SVG, so no extra image tooling is needed.
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { app, BrowserWindow } from 'electron'

const build = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const svg = readFileSync(join(build, 'icon.svg'), 'utf8')
const tmp = mkdtempSync(join(tmpdir(), 'nixi-icon-'))

/** Draw the SVG on a canvas at each size (per size, so small icons stay crisp) and read back PNGs. */
async function renderAll(sizes) {
  const win = new BrowserWindow({ show: false })
  const page = join(tmp, 'icon.html')
  writeFileSync(page, '<html><body></body></html>')
  await win.loadFile(page)
  const out = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}'
    await img.decode()
    const out = {}
    for (const size of ${JSON.stringify(sizes)}) {
      const c = document.createElement('canvas')
      c.width = c.height = size
      const g = c.getContext('2d')
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, 0, 0, size, size)
      out[size] = c.toDataURL('image/png').split(',')[1]
    }
    return out
  })()`)
  win.destroy()
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Buffer.from(v, 'base64')]))
}

/** ICO whose entries are PNGs (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = 6 + 16 * pngs.length
  const dir = pngs.map(({ size, png }) => {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    return e
  })
  return Buffer.concat([header, ...dir, ...pngs.map((p) => p.png)])
}

app.whenReady().then(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
  const png = await renderAll(sizes)

  writeFileSync(join(build, 'icon.png'), png[1024])
  writeFileSync(join(build, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png[size] }))))

  if (process.platform === 'darwin') {
    const set = join(build, 'icon.iconset')
    rmSync(set, { recursive: true, force: true })
    mkdirSync(set)
    for (const s of [16, 32, 128, 256, 512]) {
      writeFileSync(join(set, `icon_${s}x${s}.png`), png[s])
      writeFileSync(join(set, `icon_${s}x${s}@2x.png`), png[s * 2])
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', join(build, 'icon.icns')])
    rmSync(set, { recursive: true, force: true })
  } else {
    console.log('icon.icns skipped: iconutil only exists on macOS')
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log('wrote', ['icon.png', 'icon.ico', process.platform === 'darwin' && 'icon.icns'].filter(Boolean).join(', '), 'in', build)
  app.quit()
})
