import { describe, expect, it } from 'vitest'
import { englishKey } from '../src/shared/keyboard'

const press = (key: string, code: string, shiftKey = false, capsLock = false): string | undefined => englishKey({ key, code, shiftKey, capsLock })

describe('englishKey', () => {
  it('keeps plain ASCII as it is', () => {
    expect(press('a', 'KeyA')).toBe('a')
    expect(press('A', 'KeyA', true)).toBe('A')
    expect(press('!', 'Digit1', true)).toBe('!')
    expect(press(' ', 'Space')).toBe(' ')
  })

  it('respects a layout that still types ASCII', () => {
    expect(press("'", 'KeyQ')).toBe("'") // Dvorak
    expect(press('q', 'KeyA')).toBe('q') // AZERTY
  })

  it('reads the physical key while an input method holds it', () => {
    expect(press('Process', 'KeyA')).toBe('a')
    expect(press('Process', 'KeyA', true)).toBe('A')
    expect(press('Unidentified', 'Digit1', true)).toBe('!')
    expect(press('Process', 'Space')).toBe(' ')
    expect(press('Dead', 'Quote')).toBe("'")
    expect(press('Dead', 'Quote', true)).toBe('"')
  })

  it('turns other alphabets into the US key', () => {
    expect(press('ф', 'KeyA')).toBe('a')
    expect(press('Ф', 'KeyA', true)).toBe('A')
    expect(press('â', 'KeyA')).toBe('a')
    expect(press('đ', 'Digit0')).toBe('0') // the Vietnamese layout's number row
    expect(press('ă', 'Digit1', true)).toBe('!')
    expect(press('ю', 'Period')).toBe('.')
  })

  it('follows Caps Lock for letters only', () => {
    expect(press('ф', 'KeyA', false, true)).toBe('A')
    expect(press('Ф', 'KeyA', true, true)).toBe('a')
    expect(press('Process', 'Digit1', false, true)).toBe('1')
  })

  it('drops text with no key behind it', () => {
    expect(press('â', '')).toBe('')
    expect(press('ệ', 'Unidentified')).toBe('')
  })

  it('leaves everything else to the terminal', () => {
    for (const [key, code] of [
      ['Enter', 'Enter'],
      ['Backspace', 'Backspace'],
      ['Tab', 'Tab'],
      ['ArrowUp', 'ArrowUp'],
      ['Escape', 'Escape'],
      ['F5', 'F5'],
      ['Process', 'Enter'],
      ['Shift', 'ShiftLeft']
    ])
      expect(press(key, code)).toBeUndefined()
  })
})
