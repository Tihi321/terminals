import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { AppState, Command } from '../../shared/types'
import { buildLocs } from './locations'

interface Props {
  /** Shown in the title: "Copy command to..." / "Copy prompt to...". */
  noun: 'command' | 'prompt'
  state: AppState
  /** Current owner, left out of the list (Duplicate already covers it). */
  currentOwnerId: string
  onCopy: (destId: string) => void
  onCancel: () => void
}

interface Dest {
  id: string
  label: string
  path: string | null
}

const norm = (p: string): string => p.toLowerCase().replace(/[\\/]+$/, '').replace(/\\/g, '/')

/**
 * Copy a command to another owner: targets whose cwd is the source folder follow the destination folder.
 * Nothing is remapped when either side is a group or has no path.
 */
export function remapCommandTargets(
  targets: Command['targets'],
  source: { path: string | null; isGroup: boolean },
  dest: { path: string | null; isGroup: boolean }
): Command['targets'] {
  if (source.isGroup || dest.isGroup || !source.path || !dest.path) return targets.map((t) => ({ ...t, steps: [...t.steps] }))
  const from = norm(source.path)
  return targets.map((t) => ({ cwd: norm(t.cwd) === from ? dest.path! : t.cwd, steps: [...t.steps] }))
}

export function CopyToDialog({ noun, state, currentOwnerId, onCopy, onCancel }: Props): JSX.Element {
  const [destId, setDestId] = useState('')

  const { groups, folders } = useMemo(() => {
    const groups: Dest[] = []
    const folders: Dest[] = []
    for (const g of state.groups) {
      if (g.id !== currentOwnerId) groups.push({ id: g.id, label: g.name, path: g.path })
    }
    for (const f of state.folders) {
      if (f.id !== currentOwnerId) folders.push({ id: f.id, label: f.name, path: f.path })
    }
    for (const g of state.groups) {
      for (const c of g.children) {
        if (c.id !== currentOwnerId) folders.push({ id: c.id, label: `${c.name} (${g.name})`, path: c.path })
      }
    }
    return { groups, folders }
  }, [state, currentOwnerId])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onCancel])

  const text = `Copy ${noun} to...`
  const option = (d: Dest): JSX.Element => (
    <option key={d.id} value={d.id}>
      {d.path ? `${d.label} - ${d.path}` : d.label}
    </option>
  )

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={text}>
        <div className="modal-head">
          <h3>{text}</h3>
          <button className="icon-btn" title="Close" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>Destination</span>
            <select autoFocus value={destId} onChange={(e) => setDestId(e.target.value)}>
              <option value="" disabled>
                Choose a folder or group
              </option>
              {groups.length > 0 && <optgroup label="Groups">{groups.map(option)}</optgroup>}
              {folders.length > 0 && <optgroup label="Folders">{folders.map(option)}</optgroup>}
            </select>
          </label>
        </div>
        <div className="modal-foot">
          <span className="hint" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!destId} onClick={() => onCopy(destId)}>
            Copy
          </button>
        </div>
      </div>
    </div>
  )
}

/** Resolve an owner id to its path and whether it is a group (manual or parent folder). */
export function ownerInfo(state: AppState, id: string): { path: string | null; isGroup: boolean } {
  const loc = buildLocs(state).get(id)
  return { path: loc?.path ?? null, isGroup: loc?.kind === 'parent' || loc?.kind === 'manual' }
}
