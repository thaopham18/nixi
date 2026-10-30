import './env'
import { appendFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { registerIpc } from './ipc'
import { closeAll, setSink } from './conn/manager'
import { closeWatchers, setSftpSink } from './ssh/sftp'
import { autoStartTunnels, setTunnelSink, stopAllTunnels } from './ssh/tunnels'
import { stopRdpProxy } from './rdp/proxy'
import * as db from './store/database'
import { findLegacyData } from './store/legacy'
import { APP_NAME, AUTHOR_EMAIL, copyright } from '@shared/about'
import { hotkeyOf, sameShortcut, toAccelerator } from '@shared/macro'
import { getSettings, macroStore, onShortcutsChange } from './store/stores'

const isMac = process.platform === 'darwin'
let mainWindow: BrowserWindow | undefined

function sendCmd(cmd: string): void {
  mainWindow?.webContents.send('menu:cmd', cmd)
}

function buildMenu(): void {
  // On macOS Cmd is free for app shortcuts. Elsewhere Ctrl+<key> belongs to the shell
  // (Ctrl+R, Ctrl+D, Ctrl+W�), so app shortcuts move to Ctrl+Shift / Ctrl+Alt+Shift.
  const accel = (a: string): string => {
    if (isMac || !a.startsWith('CmdOrCtrl+')) return a
    return a.includes('Shift+') ? a.replace('CmdOrCtrl+', 'Ctrl+Alt+') : a.replace('CmdOrCtrl+', 'Ctrl+Shift+')
  }
  const item = (label: string, accelerator: string, cmd: string): MenuItemConstructorOptions => ({
    label,
    accelerator: accel(accelerator) || undefined,
    click: () => sendCmd(cmd)
  })
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              item('Settings…', 'Cmd+,', 'settings'),
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'Session',
      submenu: [
        item('New Session…', 'CmdOrCtrl+N', 'newSession'),
        item('New Local Terminal', 'CmdOrCtrl+T', 'newLocal'),
        { type: 'separator' },
        item('Duplicate Tab', 'CmdOrCtrl+Shift+T', 'duplicateTab'),
        item('Reconnect', 'CmdOrCtrl+R', 'reconnect'),
        item('Close Tab', 'CmdOrCtrl+W', 'closeTab'),
        { type: 'separator' },
        item('Import ~/.ssh/config', '', 'importSshConfig'),
        item('Import Sessions…', '', 'importSessions'),
        item('Export Sessions…', '', 'exportSessions'),
        { type: 'separator' },
        item('Import from MobaXterm…', '', 'importMoba'),
        item('Export to MobaXterm (.mxtsessions)…', '', 'exportMoba'),
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, item('Settings…', 'Ctrl+,', 'settings'), { role: 'quit' } as MenuItemConstructorOptions])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        // Native roles so text fields work; xterm handles the resulting copy/paste DOM events.
        // macOS only routes ⌘Z/⌘X to text fields when the menu has these items; elsewhere
        // Ctrl+Z/Ctrl+X belong to the shell.
        ...(isMac
          ? ([{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }] as MenuItemConstructorOptions[])
          : []),
        { role: 'copy',accelerator: isMac ? 'Cmd+C' : 'Ctrl+Shift+C' },
        { role: 'paste', accelerator: isMac ? 'Cmd+V' : 'Ctrl+Shift+V' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find…', 'CmdOrCtrl+F', 'find'),
        item('Clear Scrollback', 'CmdOrCtrl+K', 'clear')
      ]
    },
    {
      label: 'View',
      submenu: [
        item('Split Right', 'CmdOrCtrl+D', 'splitRight'),
        item('Split Down', 'CmdOrCtrl+Shift+D', 'splitDown'),
        item('Tile All Tabs', 'CmdOrCtrl+Shift+G', 'tileAll'),
        item('Untile (one tab per session)', '', 'untile'),
        {
          label: 'Split Layout',
          submenu: [
            item('Side by Side', '', 'layoutRow'),
            item('Stacked', '', 'layoutColumn'),
            item('Grid', '', 'layoutGrid')
          ]
        },
        { type: 'separator' },
        item('Toggle Sidebar', 'CmdOrCtrl+B', 'toggleSidebar'),
        item('Toggle SFTP Panel', 'CmdOrCtrl+Shift+F', 'toggleSftp'),
        item('Tunnels', 'CmdOrCtrl+Shift+U', 'tunnels'),
        item('Macros', 'CmdOrCtrl+Shift+M', 'macros'),
        {
          // The key is the user's choice (Settings) and handled by the renderer; the menu only shows it.
          label: 'Run Macro at Cursor…',
          accelerator: db.status().state === 'unlocked' ? toAccelerator(getSettings().macroPickerHotkey) : undefined,
          registerAccelerator: false,
          click: () => sendCmd('macroPicker')
        },
        item('Toggle Multi-Exec', 'CmdOrCtrl+Shift+I', 'multiExec'),
        { type: 'separator' },
        item('Bigger Font', 'CmdOrCtrl+=', 'fontUp'),
        item('Smaller Font', 'CmdOrCtrl+-', 'fontDown'),
        item('Reset Font', 'CmdOrCtrl+0', 'fontReset'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Database',
      submenu: [
        item('Lock', 'CmdOrCtrl+Shift+L', 'dbLock'),
        { type: 'separator' },
        item('Change Master Password…', '', 'dbChangePassword'),
        item('Move Database File…', '', 'dbMove'),
        item('Open Another Database…', '', 'dbOpen')
      ]
    },
    {
      label: 'Window',
      submenu: [
        item('Next Tab', 'Ctrl+Tab', 'nextTab'),
        item('Previous Tab', 'Ctrl+Shift+Tab', 'prevTab'),
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' }
      ]
    },
    ...(isMac ? [] : [{ label: 'Help', submenu: [{ label: `About ${APP_NAME}`, click: () => app.showAboutPanel() }] } as MenuItemConstructorOptions])
  ]
  yieldToUserKeys(template)
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Accelerators the roles bring on their own (not visible in the template).
const roleKeys: Partial<Record<string, string>> = {
  quit: 'Cmd+Q',
  hide: 'Cmd+H',
  hideOthers: 'Cmd+Alt+H',
  minimize: 'CmdOrCtrl+M',
  undo: 'CmdOrCtrl+Z',
  redo: 'Shift+CmdOrCtrl+Z',
  cut: 'CmdOrCtrl+X',
  selectAll: 'CmdOrCtrl+A',
  togglefullscreen: isMac ? 'Ctrl+Cmd+F' : 'F11',
  toggleDevTools: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I'
}

/**
 * Keys the user picked (macro list, macro hotkeys) beat the app's own shortcuts: a menu item
 * on the same key loses its accelerator, so the key reaches the renderer, which runs the macro.
 */
function yieldToUserKeys(items: MenuItemConstructorOptions[]): void {
  if (db.status().state !== 'unlocked') return
  const keys = [getSettings().macroPickerHotkey, ...macroStore.get().map((m) => m.hotkey)].filter((k): k is string => !!k)
  const taken = (accel: string | undefined): boolean => keys.some((k) => sameShortcut(accel, k, isMac))
  for (const it of items) {
    if (Array.isArray(it.submenu)) yieldToUserKeys(it.submenu)
    if (it.registerAccelerator === false) continue
    if (taken(typeof it.accelerator === 'string' ? it.accelerator : undefined)) {
      it.accelerator = undefined
      it.registerAccelerator = false
    } else if (!it.accelerator && it.role && taken(roleKeys[it.role])) {
      it.registerAccelerator = false
    }
  }
}

function logEvent(what: string): void {
  const line = `${new Date().toISOString()} ${what} fullscreen=${mainWindow?.isFullScreen() ?? '?'} bounds=${JSON.stringify(mainWindow?.getBounds())}\n`
  try {
    appendFileSync(join(app.getPath('userData'), 'nixi.log'), line)
  } catch {
    /* logging must never take the app down */
  }
  console.error(line.trim())
}

let capturingHotkey = false
ipcMain.on('hotkey:capture', (_e, on: boolean) => (capturingHotkey = on))

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 420,
    show: false,
    backgroundColor: '#1e1f24',
    // Windows / Linux dev runs: taskbar icon (packaged builds embed it).
    ...(!app.isPackaged && !isMac ? { icon: join(app.getAppPath(), 'build', 'icon.png') } : {}),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep RDP sessions and terminals rendering at full speed when the window is not focused.
      backgroundThrottling: false
    }
  })
  const wc = mainWindow.webContents
  setSink(wc)
  setSftpSink(wc)
  setTunnelSink(wc)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e) => e.preventDefault())
  // Full screen has no traffic lights and no window to drag: the renderer adjusts the toolbar.
  const sendFullScreen = (): void => wc.send('window:fullscreen', mainWindow?.isFullScreen() ?? false)
  mainWindow.on('enter-full-screen', sendFullScreen)
  mainWindow.on('leave-full-screen', sendFullScreen)
  wc.on('did-finish-load', sendFullScreen)
  // Hangs / crashes go to nixi.log in the data folder, so a freeze seen once can be diagnosed.
  wc.on('unresponsive', () => logEvent('renderer unresponsive'))
  wc.on('responsive', () => logEvent('renderer responsive again'))
  wc.on('render-process-gone', (_e, d) => logEvent(`renderer gone: ${d.reason} (exit ${d.exitCode})`))
  // While a hotkey field is recording, every combination goes to it, menu shortcuts (⌘W, ⌘Q…)
  // included: they would otherwise fire before the page sees the key.
  wc.on('before-input-event', (e, input) => {
    if (!capturingHotkey || input.type !== 'keyDown' || /^(Meta|Control|Alt|Shift|CapsLock|Fn)$/.test(input.key)) return
    e.preventDefault()
    const combo = hotkeyOf({ ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta, key: input.key, code: input.code })
    wc.send('hotkey:captured', combo)
  })

  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

// One instance per data folder: two processes writing the same database file would clobber it.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.focus()
})

app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  copyright: copyright(),
  credits: AUTHOR_EMAIL
})

// Things that need the database run once it is unlocked; locking drops every connection.
db.onUnlock(() => {
  autoStartTunnels()
  buildMenu()
})
onShortcutsChange(() => buildMenu())
db.onLock(() => {
  closeAll()
  stopAllTunnels()
  closeWatchers()
  // Start the UI over from a clean slate (lock screen). Done from here because page-initiated
  // navigation is blocked by the will-navigate guard.
  mainWindow?.webContents.reload()
})

async function openDatabase(): Promise<void> {
  if (db.tryRememberedUnlock()) return
  // Automated tests only: create/unlock without the lock screen.
  const testPassword = process.env.NIXI_TEST_PASSWORD
  if (!testPassword) return
  const s = db.status()
  if (s.state === 'none') await db.create(testPassword, false, s.path, findLegacyData()?.data)
  else if (s.state === 'locked') await db.unlock(testPassword, false)
}

app.whenReady().then(async () => {
  // Packaged builds get the icon from the bundle; `npm run dev` runs the stock Electron.app.
  const devIcon = join(app.getAppPath(), 'build', 'icon.png')
  if (!app.isPackaged && isMac && existsSync(devIcon)) app.dock?.setIcon(devIcon)
  registerIpc()
  buildMenu()
  await openDatabase().catch((err) => console.error('database:', err))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  closeAll()
  stopAllTunnels()
  closeWatchers()
  stopRdpProxy()
  db.flush()
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
