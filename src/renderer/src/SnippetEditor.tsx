import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { AppState, Snippet } from '../../shared/types'
import type { Loc } from './locations'
import { Keys } from './Keys'

interface Props {
  initial: Snippet
  state: AppState
  selected: Loc | null
  onSave: (s: Snippet) => void
  onCancel: () => void
}

/** Snippets shown for the selected owner: every global one plus those scoped to it (or to its group). */
export function visibleSnippets(state: AppState, selected: Loc | null): Snippet[] {
  return state.snippets.filter(
    (s) => s.scope === 'global' || (!!selected && (s.scope === selected.id || (!!selected.groupId && s.scope === selected.groupId)))
  )
}

export function scopeLabel(state: AppState, scope: string): string {
  if (scope === 'global') return 'Global'
  const known = state.folders.find((f) => f.id === scope)?.name ?? state.groups.find((g) => g.id === scope)?.name
  if (known) return known
  for (const g of state.groups) {
    const c = g.children.find((x) => x.id === scope)
    if (c) return c.name
  }
  return scope
}

export function SnippetEditor({ initial, state, selected, onSave, onCancel }: Props): JSX.Element {
  const [name, setName] = useState(initial.name)
  const [body, setBody] = useState(initial.body)
  const [scope, setScope] = useState(initial.scope)

  const scopes: { id: string; label: string }[] = [{ id: 'global', label: 'Global (all folders)' }]
  const add = (id: string | null | undefined, label: string): void => {
    if (id && !scopes.some((s) => s.id === id)) scopes.push({ id, label })
  }
  if (selected) {
    add(selected.id, `Only ${selected.name}`)
    if (selected.groupId) add(selected.groupId, `Group ${scopeLabel(state, selected.groupId)}`)
  }
  add(initial.scope, `Only ${scopeLabel(state, initial.scope)}`)

  const valid = name.trim().length > 0 && body.trim().length > 0
  const save = (): void => {
    if (valid) onSave({ id: initial.id, name: name.trim(), body, scope })
  }

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onCancel])

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault()
            save()
          }
        }}
        role="dialog"
        aria-label="Edit prompt"
      >
        <div className="modal-head">
          <h3>{initial.name ? 'Edit prompt' : 'New prompt'}</h3>
          <button className="icon-btn" title="Close" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>Name</span>
            <input autoFocus value={name} placeholder="Handoff prompt" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Available in</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Text</span>
            <textarea
              className="snippet-body"
              rows={12}
              spellCheck={false}
              value={body}
              placeholder="Text to paste into a terminal"
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        </div>
        <div className="modal-foot">
          <span className="hint">
            <Keys combo="Ctrl+Enter" /> to save
          </span>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
