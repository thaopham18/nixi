import { describe, expect, it } from 'vitest'
import { MacroRecorder, hotkeyOf, parseMacro, serializeMacro, toAccelerator, needsModifier, sameShortcut } from '../src/shared/macro'

describe('macro text format', () => {
  it('parses all step kinds', () => {
    const steps = parseMacro('# login\n> sudo -i\nexpect assword 3000\n>> secret\\r\nwait 200\n>')
    expect(steps).toEqual([
      { kind: 'send', text: 'sudo -i\r' },
      { kind: 'waitFor', pattern: 'assword', timeoutMs: 3000 },
      { kind: 'send', text: 'secret\r' },
      { kind: 'wait', ms: 200 },
      { kind: 'send', text: '\r' }
    ])
  })

  it('round-trips through serialize', () => {
    const text = '> ls -la\n>> \\x03\nwait 100\nexpect \\$ 10000'
    expect(serializeMacro(parseMacro(text))).toBe(text)
  })

  it('reports bad lines and bad regexes', () => {
    expect(() => parseMacro('hello')).toThrow(/Line 1/)
    expect(() => parseMacro('expect ([ 100')).toThrow()
  })
})

describe('MacroRecorder', () => {
  it('splits on Enter and applies backspace', () => {
    const r = new MacroRecorder()
    r.feed('lss')
    r.feed('\x7f -l\r')
    r.feed('pwd\r')
    r.feed('exi')
    expect(r.finish()).toEqual([
      { kind: 'send', text: 'ls -l\r' },
      { kind: 'send', text: 'pwd\r' },
      { kind: 'send', text: 'exi' }
    ])
  })
})

describe('hotkeyOf', () => {
  it('normalises key combos', () => {
    const base = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
    expect(hotkeyOf({ ...base, ctrlKey: true, shiftKey: true, key: '!', code: 'Digit1' })).toBe('Ctrl+Shift+1')
    expect(hotkeyOf({ ...base, metaKey: true, key: 'k', code: 'KeyK' })).toBe('Cmd+K')
    expect(hotkeyOf({ ...base, key: 'F5', code: 'F5' })).toBe('F5')
  })
})

describe('toAccelerator', () => {
  it('maps hotkeyOf() strings to Electron accelerators', () => {
    expect(toAccelerator('Cmd+J')).toBe('Command+J')
    expect(toAccelerator('Ctrl+Shift+J')).toBe('Ctrl+Shift+J')
    expect(toAccelerator('Alt+ArrowDown')).toBe('Alt+Down')
    expect(toAccelerator('Cmd+;')).toBe('Command+;')
    expect(toAccelerator('Cmd++')).toBe('Command+Plus')
    expect(toAccelerator('F5')).toBe('F5')
    expect(toAccelerator('Ctrl+Dead')).toBeUndefined()
    expect(toAccelerator('')).toBeUndefined()
  })
})

describe('hotkeyOf', () => {
  const ev = (code: string, key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
    code,
    key
  })
  it('names Space and punctuation by the physical key', () => {
    expect(hotkeyOf(ev('Space', ' ', { ctrlKey: true }))).toBe('Ctrl+Space')
    expect(hotkeyOf(ev('Space', '\u00a0', { altKey: true }))).toBe('Alt+Space') // macOS Option+Space
    expect(hotkeyOf(ev('Semicolon', '…', { altKey: true }))).toBe('Alt+;')
    expect(hotkeyOf(ev('KeyJ', 'j', { metaKey: true }))).toBe('Cmd+J')
    expect(hotkeyOf(ev('Digit1', '!', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+1')
    expect(hotkeyOf(ev('F5', 'F5'))).toBe('F5')
    expect(hotkeyOf(ev('ArrowDown', 'ArrowDown', { altKey: true }))).toBe('Alt+ArrowDown')
  })
  it('round-trips into a menu accelerator', () => {
    expect(toAccelerator('Alt+Space')).toBe('Alt+Space')
    expect(toAccelerator('Ctrl+Shift+Space')).toBe('Ctrl+Shift+Space')
  })
  it('flags keys that would block typing', () => {
    expect(needsModifier('Space')).toBe(true)
    expect(needsModifier('Shift+Space')).toBe(true)
    expect(needsModifier('Alt+Space')).toBe(false)
    expect(needsModifier('F5')).toBe(false)
    expect(needsModifier('')).toBe(false)
  })
})

describe('sameShortcut', () => {
  it('matches menu accelerators against recorded keys', () => {
    expect(sameShortcut('CmdOrCtrl+W', 'Cmd+W', true)).toBe(true)
    expect(sameShortcut('CmdOrCtrl+W', 'Cmd+W', false)).toBe(false)
    expect(sameShortcut('Ctrl+Alt+T', 'Ctrl+Alt+T', false)).toBe(true)
    expect(sameShortcut('CmdOrCtrl+Shift+T', 'Cmd+Shift+T', true)).toBe(true)
    expect(sameShortcut('CmdOrCtrl+Shift+T', 'Cmd+T', true)).toBe(false)
    expect(sameShortcut('Cmd+,', 'Cmd+,', true)).toBe(true)
    expect(sameShortcut('CmdOrCtrl+=', 'Cmd+=', true)).toBe(true)
    expect(sameShortcut('Ctrl+Tab', 'Ctrl+Tab', true)).toBe(true)
    expect(sameShortcut(undefined, 'Cmd+W', true)).toBe(false)
  })
})
