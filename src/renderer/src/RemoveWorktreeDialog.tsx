import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { WorktreeStatus, WorktreeView } from '../../shared/types'

/** Confirm dialog for removing a worktree: shows uncommitted changes and gates Remove behind an explicit discard checkbox. */
export function RemoveWorktreeDialog({
  wt,
  onCancel,
  onConfirm
}: {
  wt: WorktreeView
  onCancel: () => void
  /** Resolves to an error text, or null when the worktree is gone. */
  onConfirm: (opts: { force: boolean; deleteBranch: boolean }) => Promise<string | null>
}): JSX.Element {
  const [status, setStatus] = useState<WorktreeStatus | null>(null)
  const [loading, setLoading] = useState(!wt.missing)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [discard, setDiscard] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (wt.missing) return
    let alive = true
    window.api
      .worktreeStatus(wt.path)
      .then((r) => {
        if (!alive) return
        if (r.ok) setStatus(r.status)
        else setStatusError(r.error)
      })
      .catch((e) => alive && setStatusError(String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [wt.path, wt.missing])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onCancel, busy])

  const locked = status?.locked ?? wt.locked
  const changes = status?.changes ?? 0
  const branch = status?.branch ?? wt.branch
  // A detached head shows as "detached @ abc1234": there is no branch to delete.
  const hasBranch = !!branch && !branch.startsWith('detached')
  const needsDiscard = changes > 0
  const canRemove = !busy && !loading && !locked && (!needsDiscard || discard)

  const confirm = async (): Promise<void> => {
    if (!canRemove) return
    setBusy(true)
    setError(null)
    const err = await onConfirm({ force: needsDiscard && discard, deleteBranch: hasBranch && deleteBranch })
    // On success the parent unmounts this dialog.
    if (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div
        className="modal wt-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wt-remove-title"
      >
        <div className="modal-head">
          <h3 id="wt-remove-title">Remove worktree</h3>
          <button className="icon-btn" title="Close" disabled={busy} onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="wt-preview">
            <code>{wt.path}</code>
            {branch && (
              <div className="hint">
                Branch: <code>{branch}</code>
              </div>
            )}
          </div>
          {wt.missing && <div className="hint">The folder no longer exists. Removing only cleans up git's record of it.</div>}
          {loading && <div className="hint">Checking for uncommitted changes…</div>}
          {statusError && <div className="wt-error">{statusError}</div>}
          {locked && <div className="wt-error">This worktree is locked. Unlock it with `git worktree unlock` first.</div>}
          {!locked && needsDiscard && (
            <>
              <div className="wt-warn">
                {changes} uncommitted {changes === 1 ? 'change' : 'changes'} will be lost.
              </div>
              <label className="wt-check">
                <input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} />
                <span>Discard {changes} uncommitted {changes === 1 ? 'change' : 'changes'}</span>
              </label>
            </>
          )}
          {hasBranch && !wt.missing && (
            <label className="wt-check">
              <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
              <span>
                Also delete branch <code>{branch}</code>
              </span>
            </label>
          )}
          {hasBranch && wt.missing && (
            <label className="wt-check">
              <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
              <span>
                Also delete branch <code>{branch}</code>
              </span>
            </label>
          )}
          {deleteBranch && hasBranch && <small className="settings-hint">Only deleted when it is fully merged (git branch -d).</small>}
          {error && (
            <div className="wt-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="hint" />
          <button className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" disabled={!canRemove} onClick={() => void confirm()}>
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  )
}
