// MobaXterm import/export e2e in a throwaway profile.
//   node scripts/e2e-moba.mjs path/to/MobaXterm.ini
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'

const ini = process.argv[2]
if (!ini || !existsSync(ini)) throw new Error('usage: node scripts/e2e-moba.mjs <MobaXterm.ini|.mxtsessions>')
const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-moba-'))
const exportFile = join(userData, 'export.mxtsessions')

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master' } })
const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
try {
  // Native file dialogs cannot be scripted: stub them in the main process.
  await app.evaluate(({ dialog }, [open, save]) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [open] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: save })
  }, [ini, exportFile])
  const win = await app.firstWindow()
  win.on('dialog', (d) => d.accept())
  await win.click('button:has-text("Import from MobaXterm")')
  const pw = await win.waitForSelector('.modal input[type=password]', { timeout: 10000 }).catch(() => null)
  if (pw) await pw.press('Enter') // leave the master password empty
  const report = await win.waitForSelector('.modal .report', { timeout: 20000 })
  const text = await report.innerText()
  console.log(text.split('\n').map((l) => '   | ' + l).join('\n'))
  check('import report shown', /Sessions imported: \d+/.test(text))
  await win.click('.modal-footer button:has-text("OK")')
  const rows = await win.locator('.tree-row').count()
  check('session tree populated', rows > 1, `(${rows} rows)`)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-moba.png') })

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'exportMoba'))
  for (let i = 0; i < 30 && !existsSync(exportFile); i++) await new Promise((r) => setTimeout(r, 200))
  const exported = existsSync(exportFile) ? readFileSync(exportFile, 'latin1') : ''
  const lines = exported.split('\r\n').filter((l) => /=#(109|91)#/.test(l)).length
  check('export wrote .mxtsessions', lines > 0, `(${lines} session lines)`)
} catch (err) {
  await (await app.firstWindow()).screenshot({ path: join(tmpdir(), 'nixi-e2e-moba-fail.png') }).catch(() => {})
  check('unexpected error', false, err.message)
} finally {
  await app.close()
}
process.exit(results.every(Boolean) ? 0 : 1)
