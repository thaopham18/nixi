// The whole app works without a mouse: arrows walk between buttons and rows wherever the focus is,
// and rows that only know about clicks take Enter and Space too.
import { useEffect, useRef, type RefObject } from 'react'
import { nextControl, type Arrow, type Box } from '@shared/nav'
import { activePane } from './store'
import { focusTerminal } from './terminals'

const CONTROL = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [data-nav]'
/** Top-level areas: arrows stay inside the one they are in. */
const AREA = '.modal, .toolbar, .sidebar, .tabbar, .pane, .welcome'
/** Where the focus goes in turn with View → Next Area. */
const AREAS = ['.toolbar', '.sidebar', '.tabbar', '.terminal']
/** These use the arrows themselves. */
const OWN_ARROWS = new Set(['number', 'range', 'date', 'time', 'radio'])

const isArrow = (key: string): key is Arrow => key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'

function visible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
}

/** What arrows can land on. A button inside a row, or a dialog's close button (Esc does that), is only for Tab. */
function targets(area: ParentNode): HTMLElement[] {
  return [...area.querySelectorAll<HTMLElement>(CONTROL)].filter(
    (el) => visible(el) && !el.parentElement?.closest('[data-nav]') && !el.closest('.modal-header') && !el.closest('.xterm') && el.getAttribute('type') !== 'file'
  )
}

const openDialog = (): HTMLElement | null => {
  const all = document.querySelectorAll<HTMLElement>('.modal')
  return all[all.length - 1] ?? null
}

let lastArea: Element | null = null

function moveFocus(from: HTMLElement | null, key: Arrow): HTMLElement | undefined {
  const area = openDialog() ?? from?.closest(AREA) ?? (lastArea?.isConnected ? lastArea : null)
  if (!area) return undefined
  const all = targets(area)
  // The focused row went away (a folder opened, a list reloaded): start again in its area.
  if (!from || !from.isConnected) return all.find((el) => el.tabIndex === 0 && el.hasAttribute('data-nav')) ?? all[0]
  const others = all.filter((el) => el !== from)
  const box = (el: HTMLElement): Box & { el: HTMLElement } => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, el }
  }
  return nextControl(box(from), others.map(box), key)
}

function onArrow(e: KeyboardEvent, key: Arrow): void {
  const active = document.activeElement as HTMLElement | null
  const onBody = !active || active === document.body
  if (!onBody) {
    // A text area can be landed on, but inside it the arrows move the caret; Tab leaves it.
    if (!active.matches(CONTROL) || active instanceof HTMLTextAreaElement) return // also a list box, the terminal, a remote screen
    if (active.closest('.xterm, .ai-picker-menu')) return
    if (active instanceof HTMLInputElement) {
      if (OWN_ARROWS.has(active.type)) return
      // Left and right move the caret in a text box.
      if (active.type !== 'checkbox' && (key === 'ArrowLeft' || key === 'ArrowRight')) return
    }
  }
  // A folder row opens and closes with left and right.
  const expanded = active?.getAttribute('aria-expanded')
  if (active?.hasAttribute('data-nav') && ((key === 'ArrowRight' && expanded === 'false') || (key === 'ArrowLeft' && expanded === 'true'))) {
    e.preventDefault()
    active.click()
    return
  }
  const next = moveFocus(onBody ? null : active, key)
  if (!next) {
    if (!onBody) e.preventDefault()
    return
  }
  e.preventDefault()
  next.focus()
  if (e.shiftKey && next.hasAttribute('data-nav')) next.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
}

/** The menu of what has the focus, where the mouse would have opened it. */
function openContextMenu(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 12, clientY: r.bottom }))
}

/** Toolbar, sidebar, tabs, terminal, and round again. */
export function nextArea(): void {
  const active = document.activeElement
  const at = AREAS.findIndex((sel) => sel === '.terminal' ? active?.closest('.pane') : active?.closest(sel))
  for (let i = 1; i <= AREAS.length; i++) {
    const sel = AREAS[(at + i) % AREAS.length]
    if (sel === '.terminal') {
      const pane = activePane()
      if (!pane) continue
      if (!pane.kind || pane.kind === 'term') {
        focusTerminal(pane.id)
        return
      }
      const canvas = document.querySelector<HTMLElement>('.pane.active canvas, .pane.active [tabindex]')
      if (canvas) {
        canvas.focus()
        return
      }
      continue
    }
    const area = document.querySelector(sel)
    const all = area ? targets(area) : []
    const first = all.find((el) => el.hasAttribute('data-nav') && el.tabIndex === 0) ?? all[0]
    if (first) {
      first.focus()
      return
    }
  }
}

export function installKeyNav(): () => void {
  const trackArea = (e: FocusEvent): void => {
    lastArea = (e.target as Element).closest?.(AREA) ?? lastArea
    // Tab reaches a list once, at the row last used; arrows go through it.
    const row = (e.target as HTMLElement).closest?.('[data-nav]') as HTMLElement | null
    if (row && e.target === row) {
      row.closest('[data-nav-list]')?.querySelectorAll<HTMLElement>('[data-nav]').forEach((r) => (r.tabIndex = r === row ? 0 : -1))
    }
  }
  const late = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return
    const active = document.activeElement as HTMLElement | null
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey
    if (isArrow(e.key) && plain) return onArrow(e, e.key)
    if (!active || active === document.body || active.closest('.xterm')) return
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (!active.matches('[data-nav], button')) return
      e.preventDefault()
      openContextMenu(active)
    } else if (active.hasAttribute('data-nav') && plain && !e.shiftKey && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      // Enter does what a double click does on a row that opens something.
      if (e.key === 'Enter' && active.hasAttribute('data-open')) active.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      else active.click()
    } else if (e.key === 'Escape' && plain && !openDialog() && active.matches('[data-nav], button') && !active.closest('.ai-picker')) {
      const pane = activePane()
      if (pane && (!pane.kind || pane.kind === 'term')) focusTerminal(pane.id)
    }
  }
  window.addEventListener('focusin', trackArea)
  window.addEventListener('keydown', late)
  return () => {
    window.removeEventListener('focusin', trackArea)
    window.removeEventListener('keydown', late)
  }
}

/**
 * For a list of rows (`data-nav`, `tabIndex={-1}`): one of them is in the Tab order, so Tab doesn't
 * stop on every row. Put the ref on the element with `data-nav-list`.
 */
export function useNavList<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null)
  useEffect(() => {
    const rows = ref.current ? [...ref.current.querySelectorAll<HTMLElement>('[data-nav]')] : []
    if (rows.length && !rows.some((r) => r.tabIndex === 0)) rows[0].tabIndex = 0
  })
  return ref
}
