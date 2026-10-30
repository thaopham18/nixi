import type { ITheme } from '@xterm/xterm'
import type { Settings } from '@shared/types'

export const termThemes: Record<Settings['theme'], ITheme> = {
  dark: {
    background: '#1e1f24',
    foreground: '#d8dee9',
    cursor: '#f0f0f0',
    selectionBackground: '#3b4252aa',
    black: '#3b4252',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#e5e9f0',
    brightBlack: '#5c6370',
    brightRed: '#ff7a85',
    brightGreen: '#b5e890',
    brightYellow: '#ffd68a',
    brightBlue: '#7cc4ff',
    brightMagenta: '#de9bf0',
    brightCyan: '#7fd8e2',
    brightWhite: '#ffffff'
  },
  light: {
    background: '#fbfbfb',
    foreground: '#2e3440',
    cursor: '#2e3440',
    selectionBackground: '#b4d5fe',
    black: '#2e3440',
    red: '#c0392b',
    green: '#2f8f3a',
    yellow: '#a87b00',
    blue: '#1f62c4',
    magenta: '#8e44ad',
    cyan: '#16808c',
    white: '#d0d4da',
    brightBlack: '#6b7280',
    brightRed: '#e74c3c',
    brightGreen: '#3aa34a',
    brightYellow: '#c99a00',
    brightBlue: '#2f7ae5',
    brightMagenta: '#a55bc6',
    brightCyan: '#1aa0ae',
    brightWhite: '#ffffff'
  },
  solarized: {
    background: '#002b36',
    foreground: '#93a1a1',
    cursor: '#93a1a1',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#93a1a1',
    brightYellow: '#839496',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3'
  }
}

/** The theme's terminal colors with the user's own text / background / cursor colors on top. */
export function termTheme(s: Settings): ITheme {
  const base = termThemes[s.theme]
  return {
    ...base,
    ...(s.termForeground ? { foreground: s.termForeground } : {}),
    ...(s.termBackground ? { background: s.termBackground } : {}),
    ...(s.termCursor ? { cursor: s.termCursor } : {})
  }
}

/** WCAG contrast ratio of two #rrggbb colors (1 = same, 21 = black on white). */
export function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
