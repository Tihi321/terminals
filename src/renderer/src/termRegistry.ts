import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

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
  dispose: () => void
}

const entries = new Map<string, TermEntry>()
let listenersReady = false

export interface TermHooks {
  onNewTab: () => void
  onCloseTab: () => void
  onExit: (id: string, code: number) => void
  onZoom: (dir: -1 | 0 | 1) => void
  onTogglePanel: (tab: 'files' | 'commands') => void
}
let hooks: TermHooks = {
  onNewTab: () => {},
  onCloseTab: () => {},
  onExit: () => {},
  onZoom: () => {},
  onTogglePanel: () => {}
}
export function setTermHooks(h: TermHooks): void {
  hooks = h
}

export const TERM_BG = '#16181d'
export const TERM_FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, monospace"
export const DEFAULT_FONT_SIZE = 15
let fontSize = DEFAULT_FONT_SIZE

const THEME = {
  background: TERM_BG,
  foreground: '#d4d4d8',
  cursor: '#e4e4e7',
  selectionBackground: '#3b4a6b',
  black: '#1e1f23',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#565f89',
  brightRed: '#ff899d',
  brightGreen: '#b9f27c',
  brightYellow: '#ffc777',
  brightBlue: '#9ab8ff',
  brightMagenta: '#d0b4ff',
  brightCyan: '#a4daff',
  brightWhite: '#eceff4'
}

function ensureListeners(): void {
  if (listenersReady) return
  listenersReady = true
  window.api.onPtyData((id, data) => entries.get(id)?.term.write(data))
  window.api.onPtyExit((id, code) => {
    const e = entries.get(id)
    if (e) {
      // Written on exit (not at stop time) so it lands after any output still in flight from the pty.
      e.term.write(
        e.stopped
          ? '\r\n\x1b[1;31m✗ stopped\x1b[0m\r\n'
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

/** Apply a new font size to every terminal and refit the ones that are currently laid out. */
export function setTerminalFontSize(size: number): void {
  fontSize = size
  for (const e of entries.values()) {
    e.term.options.fontSize = size
    try {
      e.fit.fit()
    } catch {
      /* hidden terminal: refit when it becomes visible */
    }
  }
}

export function createTerm(id: string, opts: { command?: boolean } = {}): TermEntry {
  ensureListeners()
  const term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: THEME
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    const k = ev.key.toLowerCase()
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
    if (ev.ctrlKey && ev.shiftKey && (k === 'e' || k === 'r')) {
      ev.preventDefault()
      hooks.onTogglePanel(k === 'e' ? 'files' : 'commands')
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
      void window.api.clipboardRead().then((t) => t && term.paste(t))
      return false
    }
    return true
  })

  term.onData((d) => window.api.ptyWrite(id, d))
  term.onResize(({ cols, rows }) => window.api.ptyResize(id, cols, rows))

  const entry: TermEntry = {
    id,
    term,
    fit,
    started: false,
    command: !!opts.command,
    stopped: false,
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
