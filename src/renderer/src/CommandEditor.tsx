import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { FolderSearch, Plus, Trash2, X } from 'lucide-react'
import type { AppState, Command } from '../../shared/types'
import type { Loc } from './locations'

interface Props {
  initial: Command
  state: AppState
  /** Currently selected location, used to order the folder dropdown and pick defaults. */
  selected: Loc | null
  onSave: (cmd: Command) => void
  onCancel: () => void
}

interface DraftTarget {
  cwd: string
  steps: string
}

interface Option {
  label: string
  path: string
  section: string
}

const CUSTOM = '__custom__'
const lc = (p: string): string => p.toLowerCase().replace(/[\\/]+$/, '')

export function CommandEditor({ initial, state, selected, onSave, onCancel }: Props): JSX.Element {
  const [name, setName] = useState(initial.name)
  const [mode, setMode] = useState<Command['mode']>(initial.mode)
  const [targets, setTargets] = useState<DraftTarget[]>(
    initial.targets.map((t) => ({ cwd: t.cwd, steps: t.steps.join('\n') }))
  )

  const [ownerId, setOwnerId] = useState(initial.ownerId)
  const isGlobal = ownerId === 'global'

  const scopes: { id: string; label: string }[] = []
  const addScope = (id: string | null | undefined, label: string): void => {
    if (id && !scopes.some((s) => s.id === id)) scopes.push({ id, label })
  }
  if (selected) {
    addScope(selected.id, `This folder (${selected.name})`)
    if (selected.groupId) {
      const g = state.groups.find((x) => x.id === selected.groupId)
      addScope(selected.groupId, `Group ${g?.name ?? selected.groupId}`)
    }
  }
  if (initial.ownerId !== 'global') {
    const g = state.groups.find((x) => x.id === initial.ownerId)
    const f = state.folders.find((x) => x.id === initial.ownerId)
    addScope(initial.ownerId, `Only ${g?.name ?? f?.name ?? initial.ownerId}`)
  }
  addScope('global', 'Global (all folders)')

  const changeScope = (id: string): void => {
    setOwnerId(id)
    setTargets((ts) =>
      ts.map((t, i) => {
        if (id === 'global') return i === 0 ? { ...t, cwd: '' } : t
        return t.cwd === '' ? { ...t, cwd: selected?.path ?? '' } : t
      })
    )
  }

  const options = useMemo<Option[]>(() => {
    const out: Option[] = []
    const seen = new Set<string>()
    const add = (label: string, path: string | null, section: string): void => {
      if (!path || seen.has(lc(path))) return
      seen.add(lc(path))
      out.push({ label, path, section })
    }
    const gid = selected?.kind === 'parent' || selected?.kind === 'manual' ? selected.id : selected?.groupId
    const group = state.groups.find((g) => g.id === gid)
    if (group) {
      add(`${group.name} (group folder)`, group.path, `Group: ${group.name}`)
      for (const c of group.children) add(c.name, c.path, `Group: ${group.name}`)
      for (const f of state.folders.filter((f) => f.groupId === group.id)) add(f.name, f.path, `Group: ${group.name}`)
    }
    for (const f of state.folders) add(f.name, f.path, 'Saved folders')
    for (const g of state.groups) {
      if (g.path) add(`${g.name} (parent folder)`, g.path, 'Parent folders')
    }
    return out
  }, [state, selected])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onCancel])

  const update = (i: number, patch: Partial<DraftTarget>): void =>
    setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)))

  const addTarget = (): void => setTargets((ts) => [...ts, { cwd: selected?.path ?? options[0]?.path ?? '', steps: '' }])

  const parsed = targets.map((t) => ({
    cwd: t.cwd.trim(),
    steps: t.steps
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  }))
  const valid =
    name.trim().length > 0 && parsed.length > 0 && parsed.every((t, i) => (t.cwd || (isGlobal && i === 0)) && t.steps.length > 0)

  const sections = [...new Set(options.map((o) => o.section))]

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Edit command">
        <div className="modal-head">
          <h3>{initial.name ? 'Edit command' : 'New command'}</h3>
          <button className="icon-btn" title="Close" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>Name</span>
            <input autoFocus value={name} placeholder="Build all repos" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Available in</span>
            <select value={ownerId} onChange={(e) => changeScope(e.target.value)}>
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Mode</span>
            <div className="segmented">
              <button className={mode === 'parallel' ? 'active' : ''} onClick={() => setMode('parallel')} title="Start every target at once">
                Parallel
              </button>
              <button
                className={mode === 'sequential' ? 'active' : ''}
                onClick={() => setMode('sequential')}
                title="Start the next target only after the previous one succeeded"
              >
                Sequential
              </button>
            </div>
          </div>
          <div className="field">
            <span>Targets</span>
            <div className="targets">
              {targets.map((t, i) => {
                const selectedFolderTarget = isGlobal && i === 0
                const match = options.find((o) => lc(o.path) === lc(t.cwd))
                return (
                  <div key={i} className="target">
                    <div className="target-head">
                      {selectedFolderTarget ? (
                        <select value="" disabled>
                          <option value="">Selected folder</option>
                        </select>
                      ) : (
                      <select
                        value={match ? match.path : CUSTOM}
                        onChange={(e) => update(i, { cwd: e.target.value === CUSTOM ? '' : e.target.value })}
                      >
                        {sections.map((s) => (
                          <optgroup key={s} label={s}>
                            {options
                              .filter((o) => o.section === s)
                              .map((o) => (
                                <option key={o.path} value={o.path}>
                                  {o.label}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                        <option value={CUSTOM}>Custom path...</option>
                      </select>
                      )}
                      <button
                        className="icon-btn danger"
                        title="Remove target"
                        disabled={targets.length === 1}
                        onClick={() => setTargets((ts) => ts.filter((_, j) => j !== i))}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {selectedFolderTarget && <div className="target-path">Runs in the folder selected when you press Run</div>}
                    {!selectedFolderTarget && !match && (
                      <div className="target-custom">
                        <input
                          value={t.cwd}
                          placeholder="C:\path\to\folder"
                          onChange={(e) => update(i, { cwd: e.target.value })}
                        />
                        <button
                          className="btn small"
                          onClick={async () => {
                            const p = await window.api.pickFolder()
                            if (p) update(i, { cwd: p })
                          }}
                        >
                          <FolderSearch size={14} /> Browse
                        </button>
                      </div>
                    )}
                    {!selectedFolderTarget && match && <div className="target-path">{match.path}</div>}
                    <textarea
                      rows={3}
                      spellCheck={false}
                      value={t.steps}
                      placeholder={'One step per line, e.g.\nyarn build\nyarn package'}
                      onChange={(e) => update(i, { steps: e.target.value })}
                    />
                  </div>
                )
              })}
              <button className="btn small" onClick={addTarget}>
                <Plus size={14} /> Add target
              </button>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="hint">A failing step stops that target.</span>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!valid}
            onClick={() => onSave({ id: initial.id, ownerId, name: name.trim(), mode, targets: parsed })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
