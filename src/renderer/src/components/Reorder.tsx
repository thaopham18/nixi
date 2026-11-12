import { useState, type DragEvent, type ReactNode } from 'react'
import { ToolIcon } from './Icons'

/** Drag-and-drop plus ↑↓ ordering for a list kept in the order the user picked (macros, credentials). */
export function useReorder<T extends { id: string }>(list: T[], persist: (list: T[]) => void) {
  const [drag, setDrag] = useState<{ id: string; to?: number }>()

  const moveTo = (id: string, to: number): void => {
    const from = list.findIndex((x) => x.id === id)
    if (from < 0) return
    const rest = list.filter((x) => x.id !== id)
    const at = Math.max(0, Math.min(rest.length, to > from ? to - 1 : to))
    if (at === from) return
    rest.splice(at, 0, list[from])
    persist(rest)
  }

  /** Props and class names for row i. */
  const row = (item: T, i: number) => ({
    className: `${drag?.id === item.id ? 'dragging' : ''} ${drag && drag.to === i ? 'drop-before' : ''} ${
      drag && drag.to === i + 1 && i === list.length - 1 ? 'drop-after' : ''
    }`,
    draggable: true,
    title: 'Drag to reorder',
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'move'
      setDrag({ id: item.id })
    },
    onDragOver: (e: DragEvent) => {
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      const to = e.clientY < r.top + r.height / 2 ? i : i + 1
      if (drag && drag.to !== to) setDrag({ ...drag, to })
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      if (drag?.to !== undefined) moveTo(drag.id, drag.to)
      setDrag(undefined)
    },
    onDragEnd: () => setDrag(undefined)
  })

  /** The ↑↓ buttons shown on the selected row. */
  const buttons = (item: T, i: number): ReactNode => (
    <span className="order-buttons">
      <button
        className="icon"
        title="Move up"
        disabled={i === 0}
        onClick={(e) => {
          e.stopPropagation()
          moveTo(item.id, i - 1)
        }}
      >
        <ToolIcon name="up" />
      </button>
      <button
        className="icon"
        title="Move down"
        disabled={i === list.length - 1}
        onClick={(e) => {
          e.stopPropagation()
          moveTo(item.id, i + 2)
        }}
      >
        <ToolIcon name="down" />
      </button>
    </span>
  )

  return { row, buttons }
}
