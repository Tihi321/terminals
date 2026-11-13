import { useEffect, useState } from 'react'
import { fontStack } from '../../shared/settings'
import { UI_VARS, getTheme, resolveThemeId } from '../../shared/themes'
import type { Theme } from '../../shared/themes'
import type { Settings } from '../../shared/types'
import { applyTerminalOptions } from './termRegistry'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Write the theme's chrome variables to :root and set the native colour scheme. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const k of UI_VARS) root.style.setProperty('--' + k, theme.ui[k])
  root.style.colorScheme = theme.kind
  root.dataset.theme = theme.id
}

/** Tracks the OS light/dark preference live. */
export function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = (): void => setDark(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

/** Resolves the theme (tracking the OS when theme = 'system'), applies chrome + --font-mono + every terminal. No-op for undefined. */
export function useAppearance(settings: Settings | undefined): void {
  const systemDark = useSystemDark()
  const theme = settings?.theme
  const family = settings?.terminalFontFamily
  const size = settings?.terminalFontSize
  const cursorStyle = settings?.cursorStyle
  const cursorBlink = settings?.cursorBlink
  const scrollback = settings?.scrollback
  useEffect(() => {
    if (
      theme === undefined ||
      family === undefined ||
      size === undefined ||
      cursorStyle === undefined ||
      cursorBlink === undefined ||
      scrollback === undefined
    )
      return
    const t = getTheme(resolveThemeId(theme, systemDark))
    applyTheme(t)
    const stack = fontStack(family)
    document.documentElement.style.setProperty('--font-mono', stack)
    applyTerminalOptions({ fontFamily: stack, fontSize: size, cursorStyle, cursorBlink, scrollback, theme: t.terminal })
  }, [theme, family, size, cursorStyle, cursorBlink, scrollback, systemDark])
}
