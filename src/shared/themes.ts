import type { ThemeId, ThemeSetting } from './types'

export const UI_VARS = [
  'bg-inset',
  'bg-chrome',
  'bg-term',
  'bg-raised',
  'bg-overlay',
  'hover',
  'active',
  'line',
  'line-strong',
  'line-hover',
  'control-border',
  'control-hover',
  'control-active',
  'text',
  'text-2',
  'text-3',
  'accent',
  'accent-hover',
  'accent-ink',
  'accent-soft',
  'accent-line',
  'accent-grad',
  'success',
  'success-soft',
  'danger',
  'danger-soft',
  'tint',
  'scrim',
  'tile-grad',
  'checker-a',
  'checker-b',
  'ic-folder',
  'ic-code',
  'ic-json',
  'ic-image',
  'ic-archive',
  'ic-text',
  'shadow-pop'
] as const
export type UiVar = (typeof UI_VARS)[number]

export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionInactiveBackground: string
  scrollbarSliderBackground: string
  scrollbarSliderHoverBackground: string
  scrollbarSliderActiveBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface Theme {
  id: ThemeId
  name: string
  /** Drives CSS color-scheme. */
  kind: 'dark' | 'light'
  /** Written to :root as --<key>. */
  ui: Record<UiVar, string>
  /** terminal.background and cursorAccent equal ui['bg-term']. */
  terminal: TerminalPalette
}

const SHADOW_DARK = '0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 12px 32px -8px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.35)'

const DARK: Theme = {
  id: 'dark',
  name: 'Dark',
  kind: 'dark',
  ui: {
    'bg-inset': '#0e0e10',
    'bg-chrome': '#131315',
    'bg-term': '#18181b',
    'bg-raised': '#1e1e22',
    'bg-overlay': '#222227',
    'hover': 'rgba(255, 255, 255, 0.045)',
    'active': 'rgba(255, 255, 255, 0.075)',
    'line': '#242428',
    'line-strong': '#303036',
    'line-hover': '#3a3a41',
    'control-border': '#44444c',
    'control-hover': '#26262b',
    'control-active': '#2a2a30',
    'text': '#ececef',
    'text-2': '#a4a4ad',
    'text-3': '#707079',
    'accent': '#e8a54f',
    'accent-hover': '#f0b468',
    'accent-ink': '#1d1407',
    'accent-soft': 'rgba(232, 165, 79, 0.13)',
    'accent-line': 'rgba(232, 165, 79, 0.5)',
    'accent-grad': 'linear-gradient(160deg, #f1b866, #d9923a)',
    'success': '#8cc792',
    'success-soft': 'rgba(140, 199, 146, 0.12)',
    'danger': '#ee7d76',
    'danger-soft': 'rgba(238, 125, 118, 0.12)',
    'tint': '#ffffff',
    'scrim': 'rgba(8, 8, 10, 0.62)',
    'tile-grad': 'linear-gradient(180deg, #232328, #1b1b1f)',
    'checker-a': '#222227',
    'checker-b': '#1b1b1f',
    'ic-folder': '#8f9db5',
    'ic-code': '#74bfc4',
    'ic-json': '#d9b469',
    'ic-image': '#c49bd6',
    'ic-archive': '#d69a6c',
    'ic-text': '#9d9da6',
    'shadow-pop': SHADOW_DARK
  },
  terminal: {
    background: '#18181b',
    foreground: '#dedee3',
    cursor: '#e8a54f',
    cursorAccent: '#18181b',
    selectionBackground: '#3a3a44',
    selectionInactiveBackground: '#2c2c33',
    scrollbarSliderBackground: 'rgba(255, 255, 255, 0.08)',
    scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.16)',
    scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.22)',
    black: '#2e2e34',
    red: '#ee7d76',
    green: '#93c88a',
    yellow: '#e3b462',
    blue: '#80a8e2',
    magenta: '#c69cd8',
    cyan: '#73c0c5',
    white: '#c9c9d0',
    brightBlack: '#71717b',
    brightRed: '#f69d96',
    brightGreen: '#b2dda4',
    brightYellow: '#f1ca80',
    brightBlue: '#a0bfee',
    brightMagenta: '#d9b7e8',
    brightCyan: '#96d7da',
    brightWhite: '#f4f4f6'
  }
}

const LIGHT: Theme = {
  id: 'light',
  name: 'Light',
  kind: 'light',
  ui: {
    'bg-inset': '#e8e8eb',
    'bg-chrome': '#efeff1',
    'bg-term': '#f9f9fa',
    'bg-raised': '#ffffff',
    'bg-overlay': '#ffffff',
    'hover': 'rgba(0, 0, 0, 0.045)',
    'active': 'rgba(0, 0, 0, 0.08)',
    'line': '#e1e1e5',
    'line-strong': '#d2d2d8',
    'line-hover': '#c3c3ca',
    'control-border': '#b4b4bc',
    'control-hover': '#e7e7ea',
    'control-active': '#ffffff',
    'text': '#1c1c21',
    'text-2': '#55555e',
    'text-3': '#84848d',
    'accent': '#b5690f',
    'accent-hover': '#9c5a0a',
    'accent-ink': '#ffffff',
    'accent-soft': 'rgba(181, 105, 15, 0.12)',
    'accent-line': 'rgba(181, 105, 15, 0.45)',
    'accent-grad': 'linear-gradient(160deg, #d08a2e, #b0640c)',
    'success': '#2f8a3e',
    'success-soft': 'rgba(47, 138, 62, 0.12)',
    'danger': '#c73e36',
    'danger-soft': 'rgba(199, 62, 54, 0.1)',
    'tint': '#000000',
    'scrim': 'rgba(20, 20, 26, 0.32)',
    'tile-grad': 'linear-gradient(180deg, #ffffff, #efeff1)',
    'checker-a': '#e8e8eb',
    'checker-b': '#f9f9fa',
    'ic-folder': '#5a6f94',
    'ic-code': '#24858c',
    'ic-json': '#9a6f00',
    'ic-image': '#8a52a6',
    'ic-archive': '#b05d24',
    'ic-text': '#77777f',
    'shadow-pop': '0 1px 0 rgba(255, 255, 255, 0.7) inset, 0 12px 32px -8px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08)'
  },
  terminal: {
    background: '#f9f9fa',
    foreground: '#26262c',
    cursor: '#b5690f',
    cursorAccent: '#f9f9fa',
    selectionBackground: '#d6d9e3',
    selectionInactiveBackground: '#e5e6ec',
    scrollbarSliderBackground: 'rgba(0, 0, 0, 0.12)',
    scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.2)',
    scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.28)',
    black: '#26262c',
    red: '#c0392f',
    green: '#3a7d2a',
    yellow: '#8f6400',
    blue: '#2b5fb4',
    magenta: '#9a3ea8',
    cyan: '#187c84',
    white: '#8c8c95',
    brightBlack: '#6e6e78',
    brightRed: '#d0503f',
    brightGreen: '#4b9136',
    brightYellow: '#a67700',
    brightBlue: '#4274c8',
    brightMagenta: '#ad55bb',
    brightCyan: '#24909a',
    brightWhite: '#5c5c66'
  }
}

const FJORD: Theme = {
  id: 'fjord',
  name: 'Fjord',
  kind: 'dark',
  ui: {
    'bg-inset': '#1f232b',
    'bg-chrome': '#232831',
    'bg-term': '#2a303b',
    'bg-raised': '#303744',
    'bg-overlay': '#353d4b',
    'hover': 'rgba(236, 239, 244, 0.05)',
    'active': 'rgba(236, 239, 244, 0.085)',
    'line': '#343b48',
    'line-strong': '#3f4757',
    'line-hover': '#4a5366',
    'control-border': '#556074',
    'control-hover': '#343c4a',
    'control-active': '#3a4352',
    'text': '#e6e9ef',
    'text-2': '#b3bccb',
    'text-3': '#808a9c',
    'accent': '#86c1d4',
    'accent-hover': '#9dd0e0',
    'accent-ink': '#12202a',
    'accent-soft': 'rgba(134, 193, 212, 0.14)',
    'accent-line': 'rgba(134, 193, 212, 0.5)',
    'accent-grad': 'linear-gradient(160deg, #9dd0e0, #6aa9be)',
    'success': '#a6c98f',
    'success-soft': 'rgba(166, 201, 143, 0.13)',
    'danger': '#d98890',
    'danger-soft': 'rgba(217, 136, 144, 0.13)',
    'tint': '#ffffff',
    'scrim': 'rgba(15, 18, 24, 0.62)',
    'tile-grad': 'linear-gradient(180deg, #353d4b, #2a303b)',
    'checker-a': '#353d4b',
    'checker-b': '#2a303b',
    'ic-folder': '#93a8c8',
    'ic-code': '#86c1d4',
    'ic-json': '#e5c88f',
    'ic-image': '#b997c4',
    'ic-archive': '#d6a07f',
    'ic-text': '#a3abba',
    'shadow-pop': SHADOW_DARK
  },
  terminal: {
    background: '#2a303b',
    foreground: '#dfe3ea',
    cursor: '#86c1d4',
    cursorAccent: '#2a303b',
    selectionBackground: '#46506a',
    selectionInactiveBackground: '#3a4252',
    scrollbarSliderBackground: 'rgba(255, 255, 255, 0.08)',
    scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.16)',
    scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.22)',
    black: '#3b4252',
    red: '#d98890',
    green: '#a6c98f',
    yellow: '#e5c88f',
    blue: '#88a6cf',
    magenta: '#b997c4',
    cyan: '#8cc8c8',
    white: '#d6dae2',
    brightBlack: '#737d91',
    brightRed: '#e6a0a7',
    brightGreen: '#bcdba8',
    brightYellow: '#eed8a8',
    brightBlue: '#a5bde0',
    brightMagenta: '#cdb0d6',
    brightCyan: '#a8d9d9',
    brightWhite: '#eef0f4'
  }
}

const SANDSTONE: Theme = {
  id: 'sandstone',
  name: 'Sandstone',
  kind: 'light',
  ui: {
    'bg-inset': '#ece5d3',
    'bg-chrome': '#f1ead9',
    'bg-term': '#faf5e8',
    'bg-raised': '#fffaf0',
    'bg-overlay': '#fffbf3',
    'hover': 'rgba(60, 50, 30, 0.05)',
    'active': 'rgba(60, 50, 30, 0.09)',
    'line': '#e3dac4',
    'line-strong': '#d6ccb3',
    'line-hover': '#c9bea3',
    'control-border': '#b9ad90',
    'control-hover': '#ebe3cf',
    'control-active': '#fffaf0',
    'text': '#2f3a3f',
    'text-2': '#56646b',
    'text-3': '#84908f',
    'accent': '#2a7fb0',
    'accent-hover': '#1f6d9b',
    'accent-ink': '#ffffff',
    'accent-soft': 'rgba(42, 127, 176, 0.12)',
    'accent-line': 'rgba(42, 127, 176, 0.45)',
    'accent-grad': 'linear-gradient(160deg, #3a92c4, #2370a0)',
    'success': '#5d8a12',
    'success-soft': 'rgba(93, 138, 18, 0.12)',
    'danger': '#c4413a',
    'danger-soft': 'rgba(196, 65, 58, 0.1)',
    'tint': '#000000',
    'scrim': 'rgba(60, 50, 30, 0.3)',
    'tile-grad': 'linear-gradient(180deg, #fffaf0, #f1ead9)',
    'checker-a': '#ece5d3',
    'checker-b': '#faf5e8',
    'ic-folder': '#5f7aa3',
    'ic-code': '#2a8a8a',
    'ic-json': '#a57900',
    'ic-image': '#8a5aa8',
    'ic-archive': '#b5602c',
    'ic-text': '#7a8384',
    'shadow-pop': '0 1px 0 rgba(255, 255, 255, 0.6) inset, 0 12px 32px -8px rgba(60, 50, 30, 0.25), 0 2px 6px rgba(60, 50, 30, 0.12)'
  },
  terminal: {
    background: '#faf5e8',
    foreground: '#3a464c',
    cursor: '#2a7fb0',
    cursorAccent: '#faf5e8',
    selectionBackground: '#e6dcc2',
    selectionInactiveBackground: '#efe7d3',
    scrollbarSliderBackground: 'rgba(0, 0, 0, 0.12)',
    scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.2)',
    scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.28)',
    black: '#3a464c',
    red: '#c4413a',
    green: '#5d8a12',
    yellow: '#9c7400',
    blue: '#2a7fb0',
    magenta: '#b0407a',
    cyan: '#2a8a8a',
    white: '#8a8f85',
    brightBlack: '#7c8784',
    brightRed: '#d0603a',
    brightGreen: '#6f9c20',
    brightYellow: '#ad8500',
    brightBlue: '#4a73c4',
    brightMagenta: '#7a5ab8',
    brightCyan: '#3a9a95',
    brightWhite: '#5f6b6f'
  }
}

export const THEME_IDS: readonly ThemeId[] = ['dark', 'light', 'fjord', 'sandstone']

export const THEMES: Record<ThemeId, Theme> = { dark: DARK, light: LIGHT, fjord: FJORD, sandstone: SANDSTONE }

export function getTheme(id: ThemeId): Theme {
  return THEMES[id] ?? THEMES.dark
}

/** 'system' -> systemDark ? 'dark' : 'light'; any ThemeId -> itself. */
export function resolveThemeId(setting: ThemeSetting, systemDark: boolean): ThemeId {
  if (setting === 'system') return systemDark ? 'dark' : 'light'
  return setting
}

/** Native window colours: background = ui['bg-term'], titleBar = ui['bg-chrome'], symbol = ui['text-2']. */
export function windowColors(t: Theme): { background: string; titleBar: string; symbol: string } {
  return { background: t.ui['bg-term'], titleBar: t.ui['bg-chrome'], symbol: t.ui['text-2'] }
}
