// UI details: custom session color, flat 2D tree icons, toolbar collapsing in a narrow window,
// welcome heart, macro reordering, full screen (toolbar shifts left, app stays responsive).
// Local shell only.
//   node scripts/e2e-ui.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-ui-'))
const json = (f, v) => writeFileSync(join(userData, f), JSON.stringify(v))
json('sessions.json', [
  { id: 'a', name: 'web-01', type: 'ssh', folder: 'Prod', host: '10.0.0.1', username: 'root', auth: 'password' },
  { id: 'b', name: 'switch', type: 'telnet', folder: 'Prod', host: '10.0.0.2' },
  { id: 'c', name: 'shell', type: 'local', folder: '' }
])
const send = (text) => [{ kind: 'send', text }]
json('macros.json', [
  { id: 'm1', name: 'alpha', steps: send('a\r') },
  { id: 'm2', name: 'bravo', steps: send('b\r') },
  { id: 'm3', name: 'charlie', steps: send('c\r') }
])

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'x-test' } })
const resize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h])
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')

  // Welcome screen (no tab open): heart next to the name.
  check('welcome shows a heart next to Nixi', (await win.locator('.welcome h1').innerText()).trim() === 'Nixi' && (await win.locator('.welcome h1 svg.heart').isVisible()))
  // …and the welcome page is the open tab: a "Welcome" tab joined to the frame around it.
  const welcome = await win.locator('.tab.welcome-tab.active').evaluate((e) => ({
    text: e.textContent,
    touches: e.getBoundingClientRect().bottom >= document.querySelector('.tab-views').getBoundingClientRect().top + 1
  }))
  check('welcome page hangs from its own tab', welcome.text === 'Welcome' && welcome.touches, JSON.stringify(welcome))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ui-welcome.png') })

  // Macro order: drag charlie to the top, then ↓ on the selected one.
  const order = async () => (await win.evaluate(() => window.api.listMacros())).map((m) => m.name).join(',')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', 'macros'))
  await win.locator('.macro-row', { hasText: 'charlie' }).dragTo(win.locator('.macro-row', { hasText: 'alpha' }), { targetPosition: { x: 40, y: 3 } })
  await sleep(300)
  check('drag a macro to the top', (await order()) === 'charlie,alpha,bravo', await order())
  check('list shows the new numbers', (await win.locator('.macro-row .num').allInnerTexts()).join('') === '123' && (await win.locator('.macro-row .tree-name').first().innerText()) === 'charlie')
  await win.locator('.macro-row', { hasText: 'charlie' }).click()
  await win.locator('.macro-row.selected button[title="Move down"]').click()
  await sleep(300)
  check('↓ moves the selected macro down one', (await order()) === 'alpha,charlie,bravo', await order())
  await win.locator('.macro-row.selected button[title="Move up"]').click()
  await sleep(300)
  check('↑ moves it back up', (await order()) === 'charlie,alpha,bravo', await order())
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ui-macros.png') })
  await win.keyboard.press('Escape')
  await sleep(200)

  // Icons: SVG, no emoji left in the tree.
  check('folder rows use the folder icon', (await win.locator('.tree-row.folder svg.ico').count()) === 1)
  check('session rows use a type tile', (await win.locator('.tree-row:not(.folder) svg.ico').count()) === 3)
  check('no emoji icons in the tree', !/[\u{1F300}-\u{1FAFF}⌨]/u.test(await win.locator('.session-tree').innerText()))

  // Custom color: the rainbow swatch opens the color input; the color sticks to the session.
  await win.locator('.tree-row', { hasText: 'shell' }).last().click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Edit…' }).click()
  await win.locator('.swatch.custom input[type=color]').fill('#ff8800')
  check('custom swatch shows the picked color', (await win.locator('.swatch.custom.active').count()) === 1 && (await win.locator('.colors').innerText()).includes('#ff8800'))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ui-color.png') })
  await win.locator('.modal button', { hasText: /^Save$/ }).click()
  await sleep(300)
  const saved = (await win.evaluate(() => window.api.listSessions())).find((s) => s.id === 'c')
  check('custom color saved with the session', saved?.color === '#ff8800', saved?.color)
  const chip = await win.locator('.tree-row', { hasText: 'shell' }).last().locator('.color-chip').evaluate((e) => getComputedStyle(e).backgroundColor)
  check('tree shows the custom color', chip === 'rgb(255, 136, 0)', chip)
  await win.locator('.tree-row', { hasText: 'shell' }).last().dblclick()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 })
  check('welcome tab goes away with the first real tab', (await win.locator('.welcome-tab').count()) === 0 && (await win.locator('.tab').count()) === 1)
  // The session color is the bar on the tab; the outline around the open tab stays neutral.
  const tabColor = await win.locator('.tab.active .tab-color').evaluate((e) => getComputedStyle(e).backgroundColor)
  const frame = await win.locator('.tab-views').evaluate((e) => getComputedStyle(e).borderTopColor)
  check('tab uses the custom color, outline stays neutral', tabColor === 'rgb(255, 136, 0)' && frame !== tabColor, `${tabColor} ${frame}`)
  // Preset → custom → preset again.
  await win.locator('.tree-row', { hasText: 'shell' }).last().click({ button: 'right' })
  await win.locator('.context-menu .item', { hasText: 'Edit…' }).click()
  check('editing shows the custom color selected', (await win.locator('.swatch.custom.active').count()) === 1)
  await win.locator('.swatch:not(.custom)').nth(3).click()
  check('picking a preset deselects the custom swatch', (await win.locator('.swatch.custom.active').count()) === 0)
  await win.keyboard.press('Escape')

  // Window size: toolbar labels go away when narrow, nothing overflows.
  const overflow = () => win.evaluate(() => [...document.querySelectorAll('.toolbar, .tab-bar, .sidebar-tabs')].some((e) => e.scrollWidth > e.clientWidth + 1))
  await resize(1280, 800)
  await sleep(400)
  check('wide window: toolbar labels visible', await win.locator('.toolbar .label', { hasText: 'Tunnels' }).isVisible())
  await resize(720, 460)
  await sleep(400)
  check('narrow window: toolbar icons only', !(await win.locator('.toolbar .label', { hasText: 'Tunnels' }).isVisible()))
  check('narrow window: no bar overflows', !(await overflow()))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ui-narrow.png') })
  await resize(1280, 800)
  await sleep(400)
  check('back to wide: labels return', await win.locator('.toolbar .label', { hasText: 'Tunnels' }).isVisible())
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ui-wide.png') })

  // Full screen: buttons move to the left edge (no traffic lights), the app keeps responding.
  const firstX = async () => (await win.locator('.toolbar button').first().boundingBox()).x
  const xWindowed = await firstX()
  const setFs = (on) => app.evaluate(({ BrowserWindow }, on) => BrowserWindow.getAllWindows()[0].setFullScreen(on), on)
  await setFs(true)
  await win.waitForFunction(() => document.documentElement.classList.contains('fullscreen'), null, { timeout: 5000 }).catch(() => {})
  await sleep(1500)
  const xFull = await firstX()
  check('full screen: Session / Local move to the left', process.platform !== 'darwin' || (xWindowed > 60 && xFull < 20), `(${Math.round(xWindowed)} → ${Math.round(xFull)}px)`)
  const ping = await Promise.race([win.evaluate(() => 'ok'), sleep(3000).then(() => 'timeout')])
  await win.locator('.toolbar button', { hasText: 'Local' }).click()
  await win.locator('.tab.active .dot.connected').waitFor({ timeout: 15000 }).catch(() => {})
  check('full screen: app responsive, toolbar clickable', ping === 'ok' && (await win.locator('.tab').count()) === 2)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ui-fullscreen.png') })
  await setFs(false)
  await win.waitForFunction(() => !document.documentElement.classList.contains('fullscreen'), null, { timeout: 5000 }).catch(() => {})
  await sleep(1500)
  check('leaving full screen restores the traffic-light gap', Math.abs((await firstX()) - xWindowed) < 2, `(${Math.round(await firstX())}px)`)

  // Output in a tab that is not open: its title breathes until the tab is opened again. Typing
  // (echo) and resizing do not count.
  const tabEls = win.locator('.tab')
  const marked = async (i) => (await tabEls.nth(i).getAttribute('class')).includes('activity')
  await win.locator('.tab-view:visible .term-container').click()
  await win.keyboard.type('sleep 2; echo ping-from-background\r')
  await tabEls.nth(0).click()
  await sleep(600)
  check('own typing does not mark the tab', !(await marked(1)))
  await sleep(2500)
  const anim = await tabEls.nth(1).locator('.tab-title').evaluate((e) => getComputedStyle(e).animationName)
  check('output in a hidden tab makes its title breathe', (await marked(1)) && anim === 'tab-breathe' && !(await marked(0)), anim)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ui-activity.png') })
  await tabEls.nth(1).click()
  await sleep(200)
  check('opening the tab clears it', !(await marked(1)))
  await tabEls.nth(0).click()
  await resize(1100, 700)
  await sleep(1500)
  check('resizing the window does not mark hidden tabs', !(await marked(1)))
  await resize(1280, 800)

  // Terminal colors: Settings → text / background, with a warning when they are hard to read; the
  // real terminal pixels change (counted on a capture of the window), "Theme" brings them back.
  const menuCmd = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu:cmd', c), c)
  const field = (label) => win.locator('.color-field', { hasText: label })
  await menuCmd('settings')
  await field('Text color').locator('.swatch[title="#ffffff"]').click()
  await field('Background').locator('.swatch[title="#fbfbfb"]').click()
  check('hard-to-read colors are flagged', (await win.locator('.modal .error-line', { hasText: 'too close' }).count()) === 1)
  await field('Text color').locator('.swatch[title="#33ff66"]').click()
  await field('Background').locator('.swatch[title="#000000"]').click()
  const preview = await win.locator('.term-preview').evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor])
  check('preview shows the chosen colors', preview[0] === 'rgb(51, 255, 102)' && preview[1] === 'rgb(0, 0, 0)' && (await win.locator('.modal .error-line', { hasText: 'too close' }).count()) === 0, JSON.stringify(preview))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ui-colors.png') })
  await win.locator('.modal button', { hasText: /^Save$/ }).click()
  await win.locator('.tab-view:visible .term-container').click()
  await win.keyboard.type('echo color-check-color-check-color-check\r')
  await sleep(800)
  const box = await win.locator('.tab-view:visible .term-container').boundingBox()
  const pixels = () =>
    app.evaluate(async ({ BrowserWindow }, box) => {
      const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) })
      const bmp = img.toBitmap() // BGRA
      let green = 0
      let black = 0
      for (let i = 0; i < bmp.length; i += 4) {
        const [b, g, r] = [bmp[i], bmp[i + 1], bmp[i + 2]]
        if (r < 90 && g > 200 && b > 70 && b < 150) green++
        if (r < 8 && g < 8 && b < 8) black++
      }
      return { green, black, total: bmp.length / 4 }
    }, box)
  const px = await pixels()
  check('terminal draws the chosen text and background colors', px.green > 50 && px.black > px.total * 0.8, JSON.stringify(px))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ui-colors-term.png') })
  await menuCmd('settings')
  await field('Text color').locator('.swatch-default').click()
  await field('Background').locator('.swatch-default').click()
  await win.locator('.modal button', { hasText: /^Save$/ }).click()
  await sleep(500)
  const back = await pixels()
  const saved2 = await win.evaluate(() => window.api.getSettings())
  check('"Theme" restores the theme colors', back.green === 0 && back.black < 10 && saved2.termForeground === '' && saved2.termBackground === '', JSON.stringify(back))
} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
console.log(`Screenshots: ${join(tmpdir(), 'nixi-e2e-ui-*.png')}`)
process.exit(results.every(Boolean) ? 0 : 1)
