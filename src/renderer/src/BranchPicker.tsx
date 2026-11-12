import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { GitBranch, Plus } from 'lucide-react'
import type { GitBranch as Branch } from '../../shared/types'
import { relativeAge } from './gitUtil'

interface Props {
  folder: string
  onClose: () => void
  onPick: (name: string, opts: { create?: boolean; track?: boolean }) => void
}

type Row = { kind: 'branch'; b: Branch } | { kind: 'create'; name: string }

/** Zed-style "All Branches" popover. Positioned by CSS above its (relative) parent. */
export function BranchPicker({ folder, onClose, onPick }: Props): JSX.Element {
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    void window.api.gitBranches(folder).then((r) => {
      if (!live) return
      if (r.ok) setBranches(r.branches)
      else setLoadError(r.error)
    })
    return () => {
      live = false
    }
  }, [folder])

  // Clicks inside the parent anchor (the branch button) are the button's own business.
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      const anchor = ref.current?.parentElement
      if (anchor && !anchor.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const rows = useMemo<Row[]>(() => {
    const q = query.trim()
    const lower = q.toLowerCase()
    const list = (branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(lower))
    const out: Row[] = list.map((b) => ({ kind: 'branch', b }))
    if (q && !(branches ?? []).some((b) => b.name === q)) out.push({ kind: 'create', name: q })
    return out
  }, [branches, query])

  useEffect(() => setSel(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.bp-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel, rows])

  const choose = (row: Row | undefined): void => {
    if (!row) return
    if (row.kind === 'create') onPick(row.name, { create: true })
    else if (row.b.current) onClose()
    else onPick(row.b.name, row.b.remote ? { track: true } : {})
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(rows.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(rows[sel])
    }
  }

  return (
    <div ref={ref} className="bp" onKeyDown={onKeyDown}>
      <div className="bp-title">All Branches</div>
      <div className="bp-list" ref={listRef}>
        {loadError ? (
          <div className="panel-error bp-msg">{loadError}</div>
        ) : branches === null ? (
          <div className="bp-msg bp-dim">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="bp-msg bp-dim">No branches</div>
        ) : (
          rows.map((row, i) =>
            row.kind === 'create' ? (
              <div key="create" className={`bp-row create ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(row)}>
                <Plus size={13} />
                <span className="bp-name">Create branch &lsquo;{row.name}&rsquo;</span>
              </div>
            ) : (
              <div
                key={(row.b.remote ? 'r:' : 'l:') + row.b.name}
                className={`bp-row ${row.b.current ? 'current' : ''} ${i === sel ? 'sel' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(row)}
              >
                <GitBranch size={13} />
                <div className="bp-main">
                  <div className="bp-name">{row.b.name}</div>
                  <div className="bp-meta">
                    {[row.b.author, row.b.date ? relativeAge(row.b.date) : '', row.b.subject].filter(Boolean).join(' • ')}
                  </div>
                </div>
              </div>
            )
          )
        )}
      </div>
      <input
        className="bp-input"
        autoFocus
        spellCheck={false}
        placeholder="Search or type to create a branch…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
    </div>
  )
}
