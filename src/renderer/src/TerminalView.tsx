import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import { formatPaths, getTerm } from './termRegistry'

interface Props {
  id: string
  cwd: string
  visible: boolean
  /** Visible in the focused pane: gets keyboard focus. */
  focused: boolean
  /** Position inside the pane area; panes are laid out by the parent so this element never changes parent. */
  style?: CSSProperties
  /** Set for command tabs: run these steps instead of an interactive shell. */
  steps?: string[]
}

function safeFit(id: string, el: HTMLElement): void {
  const entry = getTerm(id)
  if (!entry || el.clientWidth === 0 || el.clientHeight === 0) return
  try {
    entry.fit.fit()
  } catch {
    /* not laid out yet */
  }
}

/** Hosts a long-lived xterm instance. Mounted for the tab's whole life, hidden via CSS when inactive. */
export function TerminalView({ id, cwd, visible, focused, style, steps }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    const entry = getTerm(id)
    if (!el || !entry) return
    if (!entry.started) {
      entry.started = true
      entry.term.open(el)
      safeFit(id, el)
      void window.api
        .ptyCreate({ id, cwd, cols: entry.term.cols, rows: entry.term.rows, steps })
        .then((r) => {
          entry.markReady()
          if (!r.ok) {
            entry.term.write(`\x1b[31mFailed to start: ${r.error}\x1b[0m\r\n`)
            // Treat as exited so the tab is marked consistently.
            window.dispatchEvent(new CustomEvent('terminal-failed', { detail: id }))
          }
        })
    }
    const ro = new ResizeObserver(() => safeFit(id, el))
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd])

  useEffect(() => {
    const el = ref.current
    const entry = getTerm(id)
    if (!visible || !el || !entry) return
    // Wait a frame so display:block has been applied before measuring.
    const raf = requestAnimationFrame(() => {
      safeFit(id, el)
      if (focused) entry.term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, focused, id])

  const [dropping, setDropping] = useState(false)

  const onDrop = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDropping(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter(Boolean)
    const entry = getTerm(id)
    if (paths.length > 0 && entry) {
      entry.term.paste(formatPaths(paths))
      entry.term.focus()
    }
  }

  return (
    <div
      ref={ref}
      className={`term-host${dropping ? ' drop-target' : ''}`}
      style={{ ...style, display: visible ? 'block' : 'none' }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropping) setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={onDrop}
    />
  )
}
