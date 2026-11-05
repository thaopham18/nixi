import { describe, expect, it } from 'vitest'
import { nextControl } from '../src/shared/nav'

const box = (el: string, left: number, top: number, w = 80, h = 28) => ({ el, left, top, right: left + w, bottom: top + h })

describe('nextControl', () => {
  const cancel = box('cancel', 100, 200)
  const ok = box('ok', 190, 200)
  const field = box('field', 100, 100, 170)
  const other = box('other', 100, 140, 170)

  it('walks a row and goes round', () => {
    expect(nextControl(cancel, [ok], 'ArrowRight')).toBe('ok')
    expect(nextControl(ok, [cancel], 'ArrowRight')).toBe('cancel')
    expect(nextControl(cancel, [ok], 'ArrowLeft')).toBe('ok')
  })
  it('up and down walk a row with nothing above or below it', () => {
    expect(nextControl(cancel, [ok], 'ArrowDown')).toBe('ok')
    expect(nextControl(ok, [cancel], 'ArrowUp')).toBe('cancel')
  })
  it('goes to the nearest thing that way', () => {
    expect(nextControl(cancel, [ok, field, other], 'ArrowUp')).toBe('other')
    expect(nextControl(field, [other, cancel, ok], 'ArrowDown')).toBe('other')
  })
  it('left and right never leave the row', () => {
    expect(nextControl(field, [other, cancel], 'ArrowRight')).toBeUndefined()
  })
  it('a list goes round top to bottom', () => {
    const rows = [box('a', 0, 0), box('b', 0, 30), box('c', 0, 60)]
    expect(nextControl(rows[2], rows.slice(0, 2), 'ArrowDown')).toBe('a')
    expect(nextControl(rows[0], rows.slice(1), 'ArrowUp')).toBe('c')
    expect(nextControl(rows[0], rows.slice(1), 'ArrowDown')).toBe('b')
  })
  it('prefers what lines up over what is merely close', () => {
    const under = box('under', 0, 100)
    const aside = box('aside', 300, 40)
    expect(nextControl(box('from', 0, 0), [under, aside], 'ArrowDown')).toBe('under')
  })
  it('nothing to go to', () => {
    expect(nextControl(cancel, [], 'ArrowDown')).toBeUndefined()
  })
})
