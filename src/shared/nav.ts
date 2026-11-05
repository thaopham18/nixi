/** Finding the next control for an arrow key, by where things are on screen. */
export type Arrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

const SLACK = 2

const overlap = (a: number, b: number, c: number, d: number): boolean => Math.min(b, d) - Math.max(a, c) > SLACK

/**
 * The nearest one that way, favouring what lines up. Left and right stay on the row. Past the edge
 * an arrow goes on round the row of buttons it is in, or else round the column.
 */
export function nextControl<T>(from: Box, all: (Box & { el: T })[], key: Arrow): T | undefined {
  const back = key === 'ArrowUp' || key === 'ArrowLeft'
  const across = key === 'ArrowLeft' || key === 'ArrowRight'
  const row = all.filter((c) => overlap(from.top, from.bottom, c.top, c.bottom))
  let best: T | undefined
  let bestScore = Infinity
  for (const c of across ? row : all) {
    const ahead = across ? (back ? from.left - c.right : c.left - from.right) : back ? from.top - c.bottom : c.top - from.bottom
    if (ahead < -SLACK) continue
    const sideways = across ? 0 : Math.max(0, c.left - from.right, from.left - c.right)
    const score = Math.max(0, ahead) + sideways * 3
    if (score < bestScore) {
      bestScore = score
      best = c.el
    }
  }
  if (best !== undefined) return best
  if (row.length) {
    const inOrder = [...row].sort((a, b) => a.left - b.left)
    if (back) return ([...inOrder].reverse().find((c) => c.right <= from.left + SLACK) ?? inOrder[inOrder.length - 1]).el
    return (inOrder.find((c) => c.left >= from.right - SLACK) ?? inOrder[0]).el
  }
  if (across || !all.length) return undefined
  const column = [...all].sort((a, b) => a.top - b.top)
  return (back ? column[column.length - 1] : column[0]).el
}
