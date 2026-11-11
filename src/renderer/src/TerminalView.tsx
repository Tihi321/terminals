import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { getTerm } from './termRegistry'

interface Props {
  id: string
  cwd: string
  visible: boolean
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
export function TerminalView({ id, cwd, visible, steps }: Props): JSX.Element {
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
      entry.term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, id])

  return <div ref={ref} className="term-host" style={{ display: visible ? 'block' : 'none' }} />
}
