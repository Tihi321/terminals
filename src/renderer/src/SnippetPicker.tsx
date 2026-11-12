import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Search } from 'lucide-react'
import type { Snippet } from '../../shared/types'

interface Props {
  snippets: Snippet[]
  onPick: (s: Snippet) => void
  onClose: () => void
}

/** Ctrl+Shift+P: filter saved prompts, Enter inserts the highlighted one into the active terminal. */
export function SnippetPicker({ snippets, onPick, onClose }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const items = useMemo(() => {
    const t = q.trim().toLowerCase()
    return snippets.filter((s) => !t || s.name.toLowerCase().includes(t) || s.body.toLowerCase().includes(t))
  }, [snippets, q])
  const cur = Math.min(idx, Math.max(0, items.length - 1))

  useEffect(() => {
    listRef.current?.querySelector('.picker-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [cur])

  return (
    <div className="modal-backdrop picker-backdrop" onMouseDown={onClose}>
      <div className="modal picker" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Insert prompt">
        <div className="picker-search">
          <Search size={16} />
          <input
            className="picker-input"
            autoFocus
            value={q}
            placeholder={snippets.length ? 'Filter prompts' : 'No saved prompts'}
            onChange={(e) => {
              setQ(e.target.value)
              setIdx(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx(Math.min(items.length - 1, cur + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx(Math.max(0, cur - 1))
              } else if (e.key === 'Enter' && items[cur]) {
                e.preventDefault()
                onPick(items[cur])
              }
            }}
          />
        </div>
        <div className="picker-list" ref={listRef}>
          {items.map((s, i) => (
            <div key={s.id} className={`picker-item ${i === cur ? 'active' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => onPick(s)}>
              <div className="cmd-name">{s.name}</div>
              <div className="cmd-sub">{s.body.replace(/\s+/g, ' ')}</div>
            </div>
          ))}
        </div>
        {items.length === 0 && (
          <div className="picker-empty">
            {snippets.length ? 'No prompts match.' : 'Save prompts in the Commands panel under Prompts, then insert them from here.'}
          </div>
        )}
        <div className="picker-foot">
          <span className="keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> select
          </span>
          <span className="keys">
            <kbd>Enter</kbd> insert
          </span>
          <span className="keys">
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
