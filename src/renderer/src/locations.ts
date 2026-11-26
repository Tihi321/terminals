import type { AppState, WorktreeView } from '../../shared/types'
import { HOME_ID } from '../../shared/types'

/** Anything a terminal can be attached to: a saved folder, a discovered child, or a group root. */
export interface Loc {
  id: string
  name: string
  /** Null for manual groups (no directory of their own). */
  path: string | null
  missing: boolean
  kind: 'folder' | 'child' | 'parent' | 'manual' | 'home' | 'worktree'
  /** Group this location belongs to (children and group members), or null. */
  groupId: string | null
  branch: string | null
  /** Worktrees only: id of the repo row this worktree hangs under. */
  parentLocId?: string
}

export function buildLocs(state: AppState): Map<string, Loc> {
  const m = new Map<string, Loc>()
  const h = state.home
  m.set(HOME_ID, { id: HOME_ID, name: 'Home', path: h.path, missing: h.missing, kind: 'home', groupId: null, branch: h.branch })
  const addWorktrees = (repoId: string, groupId: string | null, list: WorktreeView[]): void => {
    for (const w of list)
      m.set(w.id, { id: w.id, name: w.name, path: w.path, missing: w.missing, kind: 'worktree', groupId, branch: w.branch, parentLocId: repoId })
  }
  for (const f of state.folders) {
    m.set(f.id, { id: f.id, name: f.name, path: f.path, missing: f.missing, kind: 'folder', groupId: f.groupId, branch: f.branch })
    addWorktrees(f.id, f.groupId, f.worktrees)
  }
  for (const g of state.groups) {
    m.set(g.id, {
      id: g.id,
      name: g.name,
      path: g.path,
      missing: g.missing,
      kind: g.kind,
      groupId: null,
      branch: g.branch
    })
    for (const c of g.children) {
      m.set(c.id, { id: c.id, name: c.name, path: c.path, missing: false, kind: 'child', groupId: g.id, branch: c.branch })
      addWorktrees(c.id, g.id, c.worktrees)
    }
  }
  return m
}

export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

export function relPath(root: string, p: string): string {
  const r = root.replace(/[\\/]+$/, '')
  return p.toLowerCase().startsWith(r.toLowerCase()) ? p.slice(r.length).replace(/^[\\/]+/, '') || '.' : p
}
