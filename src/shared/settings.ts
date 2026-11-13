import { THEME_IDS } from './themes'
import type { CursorStyle, Settings } from './types'

export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 36
export const SCROLLBACK_MIN = 0
export const SCROLLBACK_MAX = 100000
export const DEFAULT_TERMINAL_FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, monospace"

export interface SettingField<T> {
  default: T
  /** Normalised value, or undefined when the input is invalid. */
  sanitize: (v: unknown) => T | undefined
}

function intIn(min: number, max: number): (v: unknown) => number | undefined {
  return (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined)
}

export const SETTINGS_SCHEMA: { [K in keyof Settings]: SettingField<Settings[K]> } = {
  shell: { default: '', sanitize: (v) => (typeof v === 'string' ? v.trim() : undefined) },
  editor: {
    default: 'zed',
    sanitize: (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  },
  terminalFontSize: { default: 15, sanitize: intIn(FONT_SIZE_MIN, FONT_SIZE_MAX) },
  theme: {
    default: 'dark',
    sanitize: (v) => (v === 'system' || (THEME_IDS as readonly unknown[]).includes(v) ? (v as Settings['theme']) : undefined)
  },
  terminalFontFamily: {
    default: DEFAULT_TERMINAL_FONT,
    sanitize: (v) => {
      if (typeof v !== 'string') return undefined
      const t = v.trim()
      if (!t) return DEFAULT_TERMINAL_FONT
      if (t.length > 200 || /[;{}<>\\]/.test(t)) return undefined
      return t
    }
  },
  cursorStyle: {
    default: 'block',
    sanitize: (v) => (v === 'block' || v === 'bar' || v === 'underline' ? (v as CursorStyle) : undefined)
  },
  cursorBlink: { default: true, sanitize: (v) => (typeof v === 'boolean' ? v : undefined) },
  scrollback: { default: 5000, sanitize: intIn(SCROLLBACK_MIN, SCROLLBACK_MAX) }
}

const KEYS = Object.keys(SETTINGS_SCHEMA) as (keyof Settings)[]

function field<K extends keyof Settings>(k: K, v: unknown): Settings[K] | undefined {
  return SETTINGS_SCHEMA[k].sanitize(v)
}

function defaults(): Settings {
  const out = {} as Record<keyof Settings, unknown>
  for (const k of KEYS) out[k] = SETTINGS_SCHEMA[k].default
  return out as unknown as Settings
}

export const DEFAULT_SETTINGS: Settings = defaults()

/** Full Settings from anything (file contents): each key = sanitize(raw[key]) ?? default; unknown keys dropped. */
export function sanitizeSettings(raw: unknown): Settings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out = {} as Record<keyof Settings, unknown>
  for (const k of KEYS) out[k] = field(k, src[k]) ?? SETTINGS_SCHEMA[k].default
  return out as unknown as Settings
}

/** New object: for each schema key present in patch, sanitize; invalid values keep cur's value; unknown keys ignored. */
export function patchSettings(cur: Settings, patch: unknown): Settings {
  const src = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const out = { ...cur } as Record<keyof Settings, unknown>
  for (const k of KEYS) {
    if (!(k in src)) continue
    const v = field(k, src[k])
    if (v !== undefined) out[k] = v
  }
  return out as unknown as Settings
}

/** Family list with a trailing generic: appends ", monospace" unless the list already ends with "monospace". */
export function fontStack(family: string): string {
  const f = family.trim()
  return /(^|,)\s*monospace\s*$/i.test(f) ? f : `${f}, monospace`
}
