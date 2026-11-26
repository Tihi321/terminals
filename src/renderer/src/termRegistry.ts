import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { DEFAULT_SETTINGS, fontStack } from '../../shared/settings'
import { getTheme } from '../../shared/themes'
import type { TerminalPalette } from '../../shared/themes'
import type { CursorStyle } from '../../shared/types'
import { elevationFailed } from '../../shared/elevation'

/**
 * Non-React registry of live xterm instances. They live for the whole lifetime of a
 * terminal tab; React only attaches/detaches their container element.
 */
export interface TermEntry {
  id: string
  term: Terminal
  fit: FitAddon
  /** True once the xterm has been attached to a container and the pty requested. */
  started: boolean
  /** Command tabs print a done/failed line on exit instead of the generic exit message. */
  command: boolean
  /** Set when the user stopped the run, so the exit handler does not print a second line. */
  stopped: boolean
  /** Administrator shell: a fast or cancelled exit prints the elevation-failed message. */
  elevated: boolean
  /** Set when the pty request settles; elevated exits are judged against it. */
  startedAt: number
  /** Font changed while hidden: re-measure the cell size when shown. */
  remeasure: boolean
  /** The pty was spawned by main (agent tab): attach to it instead of creating one. */
  attach: boolean
  /** Resolves once the pty has been requested (success or failure). */
  ready: Promise<void>
  /** Set once the pty has produced any output (the shell started drawing). */
  gotOutput: boolean
  /** Called on every chunk of pty output; used by whenShellQuiet. */
  onOutput?: () => void
  markReady: () => void
  dispose: () => void
}

const entries = new Map<string, TermEntry>()
let listenersReady = false

export interface TermHooks {
  onNewTab: () => void
  onCloseTab: () => void
  onExit: (id: string, code: number) => void
  onZoom: (dir: -1 | 0 | 1) => void
  onTogglePanel: (tab: 'files' | 'commands' | 'git') => void
  onSnippetPicker: () => void
  onToggleSidebar: () => void
  onOpenSettings: () => void
  /** Alt+Shift+Left/Right: move the focused pane's active tab one place. */
  onMoveTab: (dir: -1 | 1) => void
  /** Alt+Shift+Up/Down: move the selected sidebar item one place among its siblings. */
  onMoveItem: (dir: -1 | 1) => void
  /** The shell reported its working directory (OSC 7 or OSC 9;9). */
  onCwd: (id: string, cwd: string) => void
  /** The terminal set its title (OSC 0/2). Raw; the app cleans it. */
  onTitle: (id: string, title: string) => void
}
let hooks: TermHooks = {
  onNewTab: () => {},
  onCloseTab: () => {},
  onExit: () => {},
  onZoom: () => {},
  onTogglePanel: () => {},
  onSnippetPicker: () => {},
  onToggleSidebar: () => {},
  onOpenSettings: () => {},
  onMoveTab: () => {},
  onMoveItem: () => {},
  onCwd: () => {},
  onTitle: () => {}
}
export function setTermHooks(h: TermHooks): void {
  hooks = h
}

export interface TerminalOptions {
  /** Already a full stack (fontStack(settings.terminalFontFamily)). */
  fontFamily: string
  fontSize: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  /** A THEMES[...].terminal object; compared by reference. */
  theme: TerminalPalette
}
let current: TerminalOptions = {
  fontFamily: fontStack(DEFAULT_SETTINGS.terminalFontFamily),
  fontSize: DEFAULT_SETTINGS.terminalFontSize,
  cursorStyle: DEFAULT_SETTINGS.cursorStyle,
  cursorBlink: DEFAULT_SETTINGS.cursorBlink,
  scrollback: DEFAULT_SETTINGS.scrollback,
  theme: getTheme(window.api.initialThemeId).terminal
}

/** xterm only re-measures the cell size when the font family value changes, so change it and change it back. */
function remeasureFont(e: TermEntry): void {
  e.term.options.fontFamily = `${current.fontFamily}, serif`
  e.term.options.fontFamily = current.fontFamily
}

function isLaidOut(e: TermEntry): boolean {
  const host = e.term.element?.parentElement
  return !!host && host.clientWidth > 0 && host.clientHeight > 0
}

/**
 * Local fonts (Cascadia) are loaded lazily by Chromium. A terminal opened before the font has loaded measures
 * the fallback font's cell width and draws widely spaced text, so load it up front and re-measure after.
 * Hidden terminals cannot be fitted; they are flagged and re-measured when shown (refreshTerm).
 */
function remeasureAll(): void {
  for (const e of entries.values()) {
    if (isLaidOut(e)) {
      remeasureFont(e)
      try {
        e.fit.fit()
      } catch {
        /* not measurable right now: refit when it becomes visible */
      }
    } else {
      e.remeasure = true
    }
  }
}
void Promise.all([
  document.fonts.load(`${current.fontSize}px 'Cascadia Mono'`),
  document.fonts.load(`bold ${current.fontSize}px 'Cascadia Mono'`)
])
  .then(remeasureAll)
  .catch(() => {})

/** Apply new options to every open terminal; only changed options are assigned. */
export function applyTerminalOptions(o: TerminalOptions): void {
  const fontFamilyChanged = o.fontFamily !== current.fontFamily
  const fontSizeChanged = o.fontSize !== current.fontSize
  const cursorStyleChanged = o.cursorStyle !== current.cursorStyle
  const cursorBlinkChanged = o.cursorBlink !== current.cursorBlink
  const scrollbackChanged = o.scrollback !== current.scrollback
  const themeChanged = o.theme !== current.theme
  current = o
  for (const e of entries.values()) {
    const t = e.term
    if (fontSizeChanged) t.options.fontSize = o.fontSize
    if (cursorStyleChanged) t.options.cursorStyle = o.cursorStyle
    if (cursorBlinkChanged) t.options.cursorBlink = o.cursorBlink
    if (scrollbackChanged) t.options.scrollback = o.scrollback
    if (themeChanged) t.options.theme = { ...o.theme }
    if (fontFamilyChanged) remeasureFont(e)
    if (fontFamilyChanged || fontSizeChanged) {
      if (isLaidOut(e)) {
        try {
          e.fit.fit()
        } catch {
          e.remeasure = true
        }
      } else e.remeasure = true
    }
  }
  if (fontFamilyChanged) {
    void document.fonts
      .load(`${o.fontSize}px ${o.fontFamily}`)
      .then(remeasureAll)
      .catch(() => {})
  }
}

/** Called when a terminal becomes visible: re-measures it if the font changed while it was hidden. */
export function refreshTerm(id: string): void {
  const e = entries.get(id)
  if (!e || !e.remeasure) return
  remeasureFont(e)
  e.remeasure = false
}

function ensureListeners(): void {
  if (listenersReady) return
  listenersReady = true
  window.api.onPtyData((id, data) => {
    const e = entries.get(id)
    if (!e) return
    e.gotOutput = true
    e.term.write(data)
    e.onOutput?.()
  })
  window.api.onPtyExit((id, code) => {
    const e = entries.get(id)
    if (e) {
      const elevFail = e.elevated && !e.stopped && elevationFailed(code, Date.now() - e.startedAt)
      // Written on exit (not at stop time) so it lands after any output still in flight from the pty.
      e.term.write(
        e.stopped
          ? '\r\n\x1b[1;31m✗ stopped\x1b[0m\r\n'
          : elevFail
          ? `\r\n\x1b[31mElevation was cancelled or failed (exit ${code}). Use "Start as admin" to try again.\x1b[0m\r\n`
          : e.command
          ? code === 0
            ? '\r\n\x1b[1;32m✓ done\x1b[0m\r\n'
            : `\r\n\x1b[1;31m✗ failed (exit ${code})\x1b[0m\r\n`
          : `\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`
      )
    }
    hooks.onExit(id, code)
  })
}

/** Paths as one pasted string: quoted when they contain spaces, space separated. */
export function formatPaths(paths: string[]): string {
  return paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
}

/** Paste the clipboard: text as-is; images (saved to a temp PNG) and copied files as paths. */
async function pasteClipboard(term: Terminal): Promise<void> {
  const c = await window.api.clipboardReadForPaste()
  if (c.kind === 'text') {
    if (c.text) term.paste(c.text)
  } else if (c.kind === 'image') term.paste(formatPaths([c.path]))
  else if (c.paths.length > 0) term.paste(formatPaths(c.paths))
}

/**
 * Resolves when a freshly started shell has drawn its prompt: the pty is up, it has produced output, and the output
 * has been quiet for `quietMs`. Gives up after `maxMs` so a silent shell still gets the text.
 */
export async function whenShellQuiet(id: string, quietMs = 350, maxMs = 8000): Promise<void> {
  const e = entries.get(id)
  if (!e) return
  await e.ready
  await new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      clearTimeout(quiet)
      clearTimeout(cap)
      e.onOutput = undefined
      resolve()
    }
    const cap = setTimeout(done, maxMs)
    const arm = (): void => {
      clearTimeout(quiet)
      quiet = setTimeout(done, quietMs)
    }
    e.onOutput = arm
    if (e.gotOutput) arm()
  })
}

/** Paste text into a terminal (bracketed paste), optionally pressing Enter, and focus it. */
export function pasteInto(id: string, text: string, enter = false): boolean {
  const e = entries.get(id)
  if (!e) return false
  e.term.paste(text)
  if (enter) window.api.ptyWrite(id, '\r')
  e.term.focus()
  return true
}

export function createTerm(id: string, opts: { command?: boolean; elevated?: boolean; attach?: boolean } = {}): TermEntry {
  ensureListeners()
  const term = new Terminal({
    fontFamily: current.fontFamily,
    fontSize: current.fontSize,
    lineHeight: 1.2,
    cursorStyle: current.cursorStyle,
    cursorBlink: current.cursorBlink,
    scrollback: current.scrollback,
    allowProposedApi: true,
    theme: { ...current.theme }
  })
  // Match modern TUIs (Claude Code etc.): wide emoji are 2 columns, not Unicode 6's 1.
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    const k = ev.key.toLowerCase()
    if (ev.altKey && ev.shiftKey && !ev.ctrlKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault()
      hooks.onMoveTab(ev.key === 'ArrowLeft' ? -1 : 1)
      return false
    }
    if (ev.altKey && ev.shiftKey && !ev.ctrlKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault()
      hooks.onMoveItem(ev.key === 'ArrowUp' ? -1 : 1)
      return false
    }
    if (ev.ctrlKey && ev.shiftKey && k === 't') {
      ev.preventDefault()
      hooks.onNewTab()
      return false
    }
    if (ev.ctrlKey && ev.shiftKey && k === 'w') {
      ev.preventDefault()
      hooks.onCloseTab()
      return false
    }
    if (ev.ctrlKey && ev.shiftKey && (k === 'e' || k === 'r' || k === 'g')) {
      ev.preventDefault()
      hooks.onTogglePanel(k === 'e' ? 'files' : k === 'r' ? 'commands' : 'git')
      return false
    }
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && k === 'b') {
      ev.preventDefault()
      hooks.onToggleSidebar()
      return false
    }
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && k === 'p') {
      ev.preventDefault()
      hooks.onSnippetPicker()
      return false
    }
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key === ',') {
      ev.preventDefault()
      hooks.onOpenSettings()
      return false
    }
    if (ev.ctrlKey && !ev.altKey && (k === '=' || k === '+' || k === '-' || k === '0')) {
      ev.preventDefault()
      hooks.onZoom(k === '0' ? 0 : k === '-' ? -1 : 1)
      return false
    }
    if (ev.ctrlKey && !ev.altKey && k === 'c' && (term.hasSelection() || ev.shiftKey)) {
      ev.preventDefault()
      if (term.hasSelection()) {
        void window.api.clipboardWrite(term.getSelection())
        term.clearSelection()
      }
      return false
    }
    if (ev.ctrlKey && !ev.altKey && k === 'v') {
      ev.preventDefault()
      void pasteClipboard(term)
      return false
    }
    return true
  })

  // Working-directory reports, used to restore a shell where it was. Default pwsh/cmd send neither.
  term.parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*(\/.*)$/i.exec(data)
    if (!m) return false
    let p: string
    try {
      p = decodeURIComponent(m[1])
    } catch {
      return false
    }
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
    p = p.replace(/\//g, '\\')
    if (!p) return false
    hooks.onCwd(id, p)
    return true
  })
  term.parser.registerOscHandler(9, (data) => {
    if (!data.startsWith('9;')) return false
    const p = data.slice(2).replace(/^"(.*)"$/, '$1')
    if (!p) return false
    hooks.onCwd(id, p)
    return true
  })

  term.onTitleChange((t) => hooks.onTitle(id, t))
  term.onData((d) => window.api.ptyWrite(id, d))
  term.onResize(({ cols, rows }) => window.api.ptyResize(id, cols, rows))

  let resolveReady = (): void => {}
  const ready = new Promise<void>((res) => (resolveReady = res))
  const entry: TermEntry = {
    id,
    term,
    fit,
    started: false,
    command: !!opts.command,
    stopped: false,
    elevated: !!opts.elevated,
    attach: !!opts.attach,
    startedAt: Date.now(),
    remeasure: false,
    gotOutput: false,
    ready,
    markReady: () => {
      entry.startedAt = Date.now()
      resolveReady()
    },
    dispose: () => {
      term.dispose()
      entries.delete(id)
    }
  }
  entries.set(id, entry)
  return entry
}

export function getTerm(id: string): TermEntry | undefined {
  return entries.get(id)
}
