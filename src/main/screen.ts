// Headless xterm mirror of one pty: the rendered visible screen, as the user sees it. No electron import (smoke uses it).
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

export interface ScreenSnapshot {
  cols: number
  rows: number
  cursor: { x: number; y: number }
  altScreen: boolean
  /** Exactly `rows` entries, right-trimmed (trailing empty rows kept so row numbers match the cursor). */
  lines: string[]
}

export class ScreenMirror {
  private readonly term: Terminal
  private disposed = false

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols: Math.max(2, cols), rows: Math.max(1, rows), scrollback: 0, allowProposedApi: true })
    // Same width rules as the renderer (termRegistry.ts): unicode11, then grapheme-aware widths, fallback '11'.
    // The addons are typed against @xterm/xterm's Terminal; the headless one has the same addon surface.
    const t = this.term as unknown as { loadAddon(a: unknown): void; unicode: { activeVersion: string } }
    try {
      t.loadAddon(new Unicode11Addon())
      t.unicode.activeVersion = '11'
      try {
        t.loadAddon(new UnicodeGraphemesAddon())
      } catch {
        t.unicode.activeVersion = '11'
      }
    } catch {
      /* addons unavailable under headless: keep the default widths */
    }
  }

  write(data: string): void {
    if (!this.disposed) this.term.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || !(cols > 0) || !(rows > 0)) return
    try {
      this.term.resize(Math.floor(cols), Math.floor(rows))
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.term.dispose()
    } catch {
      /* ignore */
    }
  }

  async snapshot(): Promise<ScreenSnapshot> {
    // Flush: the write callback fires once everything queued before it was parsed.
    await new Promise<void>((resolve) => this.term.write('', resolve))
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let y = 0; y < this.term.rows; y++) {
      lines.push((buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
    }
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      cursor: { x: buf.cursorX, y: buf.cursorY },
      altScreen: buf.type === 'alternate',
      lines
    }
  }
}
