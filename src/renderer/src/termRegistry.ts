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
  /** Resolves once the pty has been requested (success or failure). */
  ready: Promise<void>
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
  onTogglePanel: (tab: 'files' | 'commands') => void
  onSnippetPicker: () => void
}
let hooks: TermHooks = {
  onNewTab: () => {},
  onCloseTab: () => {},
  onExit: () => {},
  onZoom: () => {},
  onTogglePanel: () => {},
  onSnippetPicker: () => {}
}
export function setTermHooks(h: TermHooks): void {
  hooks = h
}

/** Matches --bg-term in styles.css and the window background in main. */
export const TERM_BG = '#18181b'
export const TERM_FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, monospace"
export const DEFAULT_FONT_SIZE = 15
let fontSize = DEFAULT_FONT_SIZE

/** Graphite + amber, tuned to the app chrome. Every colour keeps at least 4.5:1 on the background except brightBlack (dim text). */
const THEME = {
  background: TERM_BG,
  foreground: '#dedee3',
  cursor: '#e8a54f',
  cursorAccent: TERM_BG,
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

/**
 * Cascadia is a local font that Chromium loads lazily. A terminal opened before it has loaded measures
 * the fallback font's cell width and draws widely spaced text, so load it up front and re-measure after.
 */
function remeasureAll(): void {
  for (const e of entries.values()) {
    // xterm only re-measures when the option value changes.
    e.term.options.fontFamily = `${TERM_FONT}, monospace`
    e.term.options.fontFamily = TERM_FONT
    try {
      e.fit.fit()
    } catch {
      /* hidden terminal: refit when it becomes visible */
    }
  }
}
void Promise.all([
  document.fonts.load(`${DEFAULT_FONT_SIZE}px 'Cascadia Mono'`),
  document.fonts.load(`bold ${DEFAULT_FONT_SIZE}px 'Cascadia Mono'`)
])
  .then(remeasureAll)
  .catch(() => {})

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

/** Paste text into a terminal (bracketed paste), optionally pressing Enter, and focus it. */
export function pasteInto(id: string, text: string, enter = false): boolean {
  const e = entries.get(id)
  if (!e) return false
  e.term.paste(text)
  if (enter) window.api.ptyWrite(id, '\r')
  e.term.focus()
  return true
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
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && k === 'p') {
      ev.preventDefault()
      hooks.onSnippetPicker()
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

  term.onData((d) => window.api.ptyWrite(id, d))
  term.onResize(({ cols, rows }) => window.api.ptyResize(id, cols, rows))

  let markReady = (): void => {}
  const ready = new Promise<void>((res) => (markReady = res))
  const entry: TermEntry = {
    id,
    term,
    fit,
    started: false,
    command: !!opts.command,
    stopped: false,
    ready,
    markReady,
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
