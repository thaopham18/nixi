// What a key press means when a terminal takes English only: the letter on a US keyboard, whatever
// the input method or layout turned it into.

const SYMBOLS: Record<string, [string, string]> = {
  Backquote: ['`', '~'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  Space: [' ', ' '],
  Digit1: ['1', '!'],
  Digit2: ['2', '@'],
  Digit3: ['3', '#'],
  Digit4: ['4', '$'],
  Digit5: ['5', '%'],
  Digit6: ['6', '^'],
  Digit7: ['7', '&'],
  Digit8: ['8', '*'],
  Digit9: ['9', '('],
  Digit0: ['0', ')']
}

const isAscii = (key: string): boolean => key.length === 1 && key >= ' ' && key <= '~'

export interface PressedKey {
  key: string
  code: string
  shiftKey: boolean
  capsLock?: boolean
}

/**
 * The text to send for a key pressed with no Ctrl, Alt or Cmd. '' drops it: text with no key behind
 * it. undefined leaves it to the terminal: Enter, arrows, F-keys.
 */
export function englishKey({ key, code, shiftKey, capsLock }: PressedKey): string | undefined {
  // Plain ASCII is already what the key says, and keeps layouts such as Dvorak working.
  if (isAscii(key)) return key
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return shiftKey !== !!capsLock ? letter[1] : letter[1].toLowerCase()
  const symbol = SYMBOLS[code]
  if (symbol) return symbol[shiftKey ? 1 : 0]
  return [...key].length === 1 ? '' : undefined
}
