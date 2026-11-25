import { useState } from 'react'
import type { DragEvent, JSX, KeyboardEvent } from 'react'
import { GripVertical } from 'lucide-react'
import { moveId, shiftId } from '../../shared/order'

/** The card being dragged (dataTransfer data is unreadable during dragover). `list` keeps a drag inside its own list. */
let current: { list: string; id: string } | null = null

/** Drag-to-reorder (grip handle) and Alt+Up/Down for the cards of one list. `ids` is the displayed order; `onOrder` gets the new one. */
export function useCardReorder(list: string, ids: string[], onOrder: (ids: string[]) => void) {
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)

  const commit = (next: string[]): void => {
    if (next !== ids) onOrder(next)
  }
  const accepts = (): boolean => current?.list === list

  const rowProps = (id: string) => ({
    'data-card-id': id,
    'data-card-list': list,
    tabIndex: 0,
    className: drop?.id === id ? (drop.after ? ' drop-after' : ' drop-before') : '',
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.target !== e.currentTarget) return
      e.preventDefault()
      const next = shiftId(ids, id, e.key === 'ArrowUp' ? -1 : 1)
      if (next === ids) return
      commit(next)
      // The re-render moves the node, which drops focus; put it back on the moved card.
      const row = e.currentTarget
      requestAnimationFrame(() => row.focus())
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!accepts()) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const r = e.currentTarget.getBoundingClientRect()
      const after = e.clientY >= r.top + r.height / 2
      setDrop((cur) => (cur && cur.id === id && cur.after === after ? cur : { id, after }))
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop((cur) => (cur?.id === id ? null : cur))
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!current || !accepts()) return
      e.preventDefault()
      const after = drop?.id === id ? drop.after : false
      const at = ids.indexOf(id)
      const beforeId = after ? (ids[at + 1] ?? null) : id
      const moved = current.id
      current = null
      setDrop(null)
      commit(moveId(ids, moved, beforeId))
    }
  })

  const grip = (id: string): JSX.Element => (
    <span
      className="card-grip"
      title="Drag to reorder (or focus the card and press Alt+Up / Alt+Down)"
      draggable
      onDragStart={(e) => {
        current = { list, id }
        e.dataTransfer.setData('application/x-terminals-card', id)
        e.dataTransfer.effectAllowed = 'move'
        const row = e.currentTarget.closest('.cmd-row')
        if (row) e.dataTransfer.setDragImage(row, 12, 12)
      }}
      onDragEnd={() => {
        current = null
        setDrop(null)
      }}
    >
      <GripVertical size={14} />
    </span>
  )

  return { rowProps, grip }
}
