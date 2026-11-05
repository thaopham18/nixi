import { dialog, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import type { ChoiceQuestion } from '@shared/types'

/** Windows whose page is ready to answer. */
const ready = new WeakSet<WebContents>()
const waiting = new Map<number, { from: WebContents; resolve: (value: string | null) => void }>()
let count = 0

ipcMain.on('ask:ready', (e) => {
  ready.add(e.sender)
  // A reload forgets what was asked and everything that answers it.
  e.sender.once('did-start-loading', () => {
    ready.delete(e.sender)
    for (const [id, w] of waiting) {
      if (w.from !== e.sender) continue
      waiting.delete(id)
      w.resolve(null)
    }
  })
})

ipcMain.on('ask:answer', (e, id: number, value: string | null) => {
  const w = waiting.get(id)
  if (!w || w.from !== e.sender) return
  waiting.delete(id)
  w.resolve(value)
})

/**
 * A question in the app's own dialog, which works with the arrow keys, like every other one. The
 * system's own takes over when no page is there to ask, such as behind the lock screen.
 */
export async function askUser(win: BrowserWindow | undefined, question: ChoiceQuestion): Promise<string | null> {
  const page = win?.webContents
  if (page && !page.isDestroyed() && ready.has(page)) {
    return new Promise((resolve) => {
      const id = ++count
      waiting.set(id, { from: page, resolve })
      page.once('destroyed', () => {
        if (waiting.delete(id)) resolve(null)
      })
      win!.show()
      page.send('ask:question', id, question)
    })
  }
  const options = {
    type: 'question' as const,
    title: question.title,
    message: question.message,
    detail: question.items?.join('\n'),
    buttons: question.buttons.map((b) => b.label),
    defaultId: Math.max(0, question.buttons.findIndex((b) => b.primary)),
    cancelId: 0
  }
  const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return question.buttons[res.response]?.value ?? null
}
