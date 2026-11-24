import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

export interface MenuItem {
  label?: string
  icon?: ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  /** Shortcut shown at the right edge. */
  hint?: string
  /** Native tooltip, e.g. why an item is disabled. */
  title?: string
  /** Opens a flyout with these items; the row shows a chevron instead of a hint. */
  submenu?: MenuItem[]
  /** Indent level (used for tree-shaped submenus). */
  depth?: number
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

const SUB_CLOSE_DELAY = 150

/** Flyout placed to the right of its parent row (left when it would overflow), clamped inside the window. */
function Flyout({ anchor, items, onClose }: { anchor: DOMRect; items: MenuItem[]; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let x = anchor.right - 2
    if (x + r.width > window.innerWidth - 4) x = Math.max(4, anchor.left - r.width + 2)
    const y = Math.max(4, Math.min(anchor.top - 5, window.innerHeight - r.height - 4))
    setPos({ x, y })
  }, [anchor])

  return (
    <div
      ref={ref}
      className="ctx-menu ctx-sub"
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden', maxHeight: window.innerHeight - 8 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={items} onClose={onClose} />
    </div>
  )
}

function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }): JSX.Element {
  const [open, setOpen] = useState<{ i: number; rect: DOMRect } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const enter = (i: number, it: MenuItem, row: HTMLElement): void => {
    window.clearTimeout(timer.current)
    if (it.submenu && !it.disabled) {
      setOpen({ i, rect: row.getBoundingClientRect() })
    } else if (open) {
      timer.current = window.setTimeout(() => setOpen(null), SUB_CLOSE_DELAY)
    }
  }

  return (
    <>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <div key={i} className="ctx-row" onMouseEnter={(e) => enter(i, it, e.currentTarget)}>
            <button
              className={`ctx-item ${it.danger ? 'danger' : ''} ${open?.i === i ? 'open' : ''}`}
              style={it.depth ? { paddingLeft: 8 + it.depth * 14 } : undefined}
              disabled={it.disabled}
              title={it.title}
              onClick={(e) => {
                if (it.submenu) {
                  setOpen({ i, rect: e.currentTarget.parentElement!.getBoundingClientRect() })
                  return
                }
                onClose()
                it.onClick?.()
              }}
            >
              <span className="ctx-icon">{it.icon}</span>
              <span className="ctx-label">{it.label}</span>
              {it.submenu ? <ChevronRight size={14} className="ctx-chevron" /> : it.hint && <span className="ctx-hint">{it.hint}</span>}
            </button>
            {it.submenu && open?.i === i && <Flyout anchor={open.rect} items={it.submenu} onClose={onClose} />}
          </div>
        )
      )}
    </>
  )
}

export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    })
  }, [x, y])

  useEffect(() => {
    const close = (): void => onClose()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', close)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={items} onClose={onClose} />
    </div>
  )
}
