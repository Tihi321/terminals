import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { AppState, GitBranch } from '../../shared/types'
import { worktreeTargetPath } from '../../shared/worktreePath'

/** Asks for a branch name and a base branch, then creates the worktree through main. */
export function NewWorktreeDialog({
  repoPath,
  layout,
  onCancel,
  onCreated
}: {
  repoPath: string
  layout: 'container' | 'sibling'
  onCancel: () => void
  onCreated: (id: string, state: AppState) => void
}): JSX.Element {
  const [branch, setBranch] = useState('')
  const [locals, setLocals] = useState<GitBranch[]>([])
  /** '' = the repo's current HEAD. */
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.gitBranches(repoPath).then((r) => {
      if (!alive || !r.ok) return
      const list = r.branches.filter((b) => !b.remote)
      setLocals(list)
      setBase(list.find((b) => b.current)?.name ?? '')
    })
    return () => {
      alive = false
    }
  }, [repoPath])

  const name = branch.trim()
  const exists = locals.some((b) => b.name === name)
  const target = name ? worktreeTargetPath(repoPath, name, layout) : ''
  const canCreate = !busy && name !== '' && target !== ''

  const submit = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.worktreeAdd(repoPath, name, exists || base === '' ? null : base)
      if (r.ok) onCreated(r.id, r.state)
      else setError(r.error)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
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
        className="modal wt-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wt-new-title"
      >
        <div className="modal-head">
          <h3 id="wt-new-title">New worktree</h3>
          <button className="icon-btn" title="Close" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>Branch name</span>
            <input
              autoFocus
              spellCheck={false}
              value={branch}
              placeholder="feature/my-task"
              onChange={(e) => {
                setBranch(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
          </label>
          <label className="field">
            <span>Base branch</span>
            <select value={base} disabled={exists} onChange={(e) => setBase(e.target.value)}>
              <option value="">Current HEAD</option>
              {locals.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.current ? ' (current)' : ''}
                </option>
              ))}
            </select>
            {exists && <small className="settings-hint">The branch already exists and is checked out in the new worktree.</small>}
          </label>
          <div className="wt-preview">
            {name && !target ? (
              <span className="wt-error">That name cannot be used as a folder name.</span>
            ) : target ? (
              <>
                Will be created at <code>{target}</code>
              </>
            ) : (
              <span className="hint">Enter a branch name.</span>
            )}
          </div>
          {error && (
            <div className="wt-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="hint" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canCreate} onClick={() => void submit()}>
            {busy ? 'Creating…' : exists ? 'Check out existing branch' : 'Create worktree'}
          </button>
        </div>
      </div>
    </div>
  )
}
