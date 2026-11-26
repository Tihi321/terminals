import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Folder, Search, SquareTerminal } from 'lucide-react'
import { STATUS_LABEL } from '../../shared/agentStatus'
import type { AgentStatus } from '../../shared/agentStatus'
import { rankSwitcher } from '../../shared/switcher'
import type { StatusFilter, SwitcherItem } from '../../shared/switcher'

interface Props {
  items: SwitcherItem[]
  onPick: (i: SwitcherItem) => void
  onClose: () => void
}

const CHIPS: { id: StatusFilter; label: string }[] = [
  { id: null, label: 'All' },
  { id: 'needs-you', label: 'Needs you' },
  { id: 'done', label: 'Done' },
  { id: 'working', label: 'Working' }
]

const EMPTY: Record<AgentStatus, string> = {
  'needs-you': 'No tabs need you right now.',
  done: 'No tabs are done.',
  working: 'No tabs are working.',
  idle: 'No tabs are idle.'
}

function Badge({ status }: { status: AgentStatus }): JSX.Element {
  return (
    <span className={`switcher-status ${status}`} title={STATUS_LABEL[status]}>
      <span className={`agent-ind ${status}`}>{status === 'needs-you' ? '!' : null}</span>
      {STATUS_LABEL[status]}
    </span>
  )
}

/** Ctrl+Shift+K (and Ctrl+K outside a terminal): jump to any open tab or folder. Structure follows SnippetPicker. */
export function QuickSwitcher({ items, onPick, onClose }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [chip, setChip] = useState<StatusFilter>(null)
  const [idx, setIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const ranked = useMemo(() => rankSwitcher(items, q, chip), [items, q, chip])
  const cur = Math.min(idx, Math.max(0, ranked.length - 1))

  useEffect(() => {
    listRef.current?.querySelector('.picker-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [cur])

  const cycleChip = (dir: 1 | -1): void => {
    const at = CHIPS.findIndex((c) => c.id === chip)
    setChip(CHIPS[(at + dir + CHIPS.length) % CHIPS.length].id)
    setIdx(0)
  }

  return (
    <div className="modal-backdrop picker-backdrop" onMouseDown={onClose}>
      <div className="modal picker switcher" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Quick switcher">
        <div className="picker-search">
          <Search size={16} />
          <input
            className="picker-input"
            autoFocus
            value={q}
            placeholder="Jump to a tab or folder (n: d: w: i: filter by status)"
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
                setIdx(Math.min(ranked.length - 1, cur + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx(Math.max(0, cur - 1))
              } else if (e.key === 'Enter' && ranked[cur]) {
                e.preventDefault()
                onPick(ranked[cur])
              } else if (e.key === 'Tab') {
                e.preventDefault()
                cycleChip(e.shiftKey ? -1 : 1)
              }
              // Ctrl+K / Ctrl+Shift+K are left alone: the window handler toggles (closes) the switcher.
            }}
          />
        </div>
        <div className="switcher-chips">
          {CHIPS.map((c) => (
            <button
              key={c.label}
              tabIndex={-1}
              className={`switcher-chip ${chip === c.id ? 'on' : ''}`}
              onClick={() => {
                setChip(c.id)
                setIdx(0)
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="picker-list" ref={listRef}>
          {ranked.map((it, i) => (
            <div key={it.key} className={`picker-item switcher-row ${i === cur ? 'active' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => onPick(it)}>
              <span className="switcher-icon">{it.kind === 'tab' ? <SquareTerminal size={14} /> : <Folder size={14} />}</span>
              <div className="switcher-text">
                <div className="cmd-name">
                  {it.kind === 'tab' ? (
                    <>
                      <span className="switcher-folder">{it.folder}</span>
                      <span className="switcher-sep">/</span>
                      {it.title}
                    </>
                  ) : (
                    it.folder
                  )}
                </div>
                {it.kind === 'loc' && it.title && <div className="cmd-sub">{it.title}</div>}
              </div>
              {it.status && <Badge status={it.status} />}
            </div>
          ))}
        </div>
        {ranked.length === 0 && (
          <div className="picker-empty">
            {chip && !q.trim() ? EMPTY[chip] : 'No open tabs or folders match.'}
          </div>
        )}
        <div className="picker-foot">
          <span className="keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> select
          </span>
          <span className="keys">
            <kbd>Enter</kbd> switch
          </span>
          <span className="keys">
            <kbd>Tab</kbd> filter
          </span>
          <span className="keys">
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
