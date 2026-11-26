import type { PersistedTab } from './types'

/** Pure helpers for saving and restoring the open tabs. No DOM; shared by main (sanitising) and the renderer (planning). */

export const MAX_SAVED_TABS = 200

const KINDS = new Set(['shell', 'command', 'diff', 'file'])
const DIFF_MODES = new Set(['unstaged', 'staged', 'untracked', 'commit'])

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function sanitizeTab(raw: unknown): PersistedTab | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!str(r.id) || !str(r.locId) || !str(r.cwd) || typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null
  const t: PersistedTab = {
    id: r.id,
    locId: r.locId,
    kind: r.kind as PersistedTab['kind'],
    title: typeof r.title === 'string' ? r.title : String(r.title ?? ''),
    cwd: r.cwd
  }
  if (t.kind === 'shell') {
    if (str(r.shell)) t.shell = r.shell
    if (str(r.startCwd)) t.startCwd = r.startCwd
    if (r.elevated === true) t.elevated = true
    if (r.agent === true && r.elevated !== true) t.agent = true
    if (r.userTitle === true) t.userTitle = true
  } else if (t.kind === 'diff') {
    const d = r.diff as Record<string, unknown> | undefined
    if (!d || typeof d !== 'object' || !str(d.folder) || !str(d.path) || typeof d.mode !== 'string' || !DIFF_MODES.has(d.mode)) return null
    if (d.mode === 'commit' && !str(d.hash)) return null
    t.diff = { folder: d.folder, mode: d.mode as NonNullable<PersistedTab['diff']>['mode'], path: d.path }
    if (d.mode === 'commit') t.diff.hash = d.hash as string
    if (r.preview === true) t.preview = true
  } else if (t.kind === 'file') {
    if (!str(r.file)) return null
    t.file = r.file
    if (r.preview === true) t.preview = true
  } else {
    const run = r.run as Record<string, unknown> | undefined
    if (!run || typeof run !== 'object' || !str(run.commandId) || !str(run.runId)) return null
    if (typeof run.target !== 'number' || !Number.isInteger(run.target) || run.target < 0) return null
    t.run = { commandId: run.commandId, runId: run.runId, target: run.target }
  }
  return t
}

/** Any input -> clean list: drops non-objects, unknown kinds, empty locId/cwd, duplicate ids, kind-specific missing fields
 *  (diff needs folder/path and a valid mode, commit needs hash; file needs file; command needs run.commandId/runId, run.target >= 0 integer);
 *  titles become strings; keeps at most MAX_SAVED_TABS; keeps order. */
export function sanitizeTabs(raw: unknown): PersistedTab[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: PersistedTab[] = []
  for (const item of raw) {
    if (out.length >= MAX_SAVED_TABS) break
    const t = sanitizeTab(item)
    if (!t || seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out
}

/** Structural input so it does not depend on the renderer Tab type. Live cwd (from OSC) wins over tab.cwd for shells. */
export interface SessionTab {
  id: string
  locId: string
  kind: PersistedTab['kind']
  title: string
  cwd: string
  shell?: string
  startCwd?: string
  diff?: PersistedTab['diff']
  file?: string
  preview?: boolean
  run?: { commandId: string; runId: string; target?: number }
  elevated?: boolean
  agent?: boolean
  userTitle?: boolean
}

export function toPersistedTabs(tabs: SessionTab[], liveCwd: Record<string, string>): PersistedTab[] {
  return sanitizeTabs(
    tabs.map((t) => ({
      id: t.id,
      locId: t.locId,
      kind: t.kind,
      title: t.title,
      cwd: t.kind === 'shell' ? liveCwd[t.id] || t.cwd : t.cwd,
      shell: t.shell,
      startCwd: t.startCwd,
      elevated: t.elevated,
      agent: t.agent,
      userTitle: t.userTitle,
      diff: t.diff,
      file: t.file,
      preview: t.preview,
      run: t.run ? { commandId: t.run.commandId, runId: t.run.runId, target: t.run.target ?? 0 } : undefined
    }))
  )
}

export interface RestoreCtx {
  locs: Map<string, { path: string | null; missing: boolean }>
  commandIds: Set<string>
  /** Result of pathsExist for the paths listed by restorePaths(). */
  exists: (path: string) => boolean
  mkId: () => string
}

/** Paths whose existence planRestore needs: file tabs' files, diff folders, shell cwds and startCwds. */
export function restorePaths(tabs: PersistedTab[]): string[] {
  const out = new Set<string>()
  for (const t of tabs) {
    if (t.kind === 'file' && t.file) out.add(t.file)
    else if (t.kind === 'diff' && t.diff) out.add(t.diff.folder)
    else if (t.kind === 'shell') {
      out.add(t.cwd)
      if (t.startCwd) out.add(t.startCwd)
    }
  }
  return [...out]
}

export interface RestorePlan {
  /** Non-command tabs in saved global order, with fresh ids; shells carry cwd (already resolved to an existing dir) and fallbackCwd. */
  tabs: (PersistedTab & { newId: string; fallbackCwd?: string })[]
  /** One entry per saved run (first appearance order). anchor = newId of the next restored non-command tab of the same folder after the run's first tab, or null. */
  runs: { commandId: string; locId: string; anchor: string | null; snapshotIds: Record<number, string> }[]
  /** snapshot tab id -> new id, for non-command tabs. */
  idMap: Record<string, string>
}

export function planRestore(saved: PersistedTab[], ctx: RestoreCtx): RestorePlan {
  const tabs: RestorePlan['tabs'] = []
  const idMap: Record<string, string> = {}
  const runs: (RestorePlan['runs'][number] & { firstIndex: number; runId: string })[] = []
  const runIdsByCommand = new Map<string, string>()
  saved.forEach((t, index) => {
    const loc = ctx.locs.get(t.locId)
    if (!loc || loc.missing) return
    if (t.kind === 'command') {
      if (!t.run || !ctx.commandIds.has(t.run.commandId)) return
      const owner = runIdsByCommand.get(t.run.commandId)
      if (owner !== undefined && owner !== t.run.runId) return // a second run of one command is not restored
      runIdsByCommand.set(t.run.commandId, t.run.runId)
      let run = runs.find((r) => r.runId === t.run!.runId)
      if (!run) {
        run = { commandId: t.run.commandId, locId: t.locId, anchor: null, snapshotIds: {}, firstIndex: index, runId: t.run.runId }
        runs.push(run)
      }
      run.snapshotIds[t.run.target] = t.id
      return
    }
    if (t.kind === 'file' && !(t.file && ctx.exists(t.file))) return
    if (t.kind === 'diff' && !(t.diff && ctx.exists(t.diff.folder))) return
    const newId = ctx.mkId()
    if (t.kind === 'shell') {
      const cwd = ctx.exists(t.cwd) ? t.cwd : t.startCwd && ctx.exists(t.startCwd) ? t.startCwd : (loc.path ?? t.cwd)
      tabs.push({ ...t, cwd, newId, fallbackCwd: loc.path ?? undefined })
    } else {
      tabs.push({ ...t, newId })
    }
    idMap[t.id] = newId
  })
  const plan = runs.map((r) => {
    let anchor: string | null = null
    for (let i = r.firstIndex + 1; i < saved.length && anchor === null; i++) {
      const s = saved[i]
      if (s.locId === r.locId && s.kind !== 'command' && idMap[s.id]) anchor = idMap[s.id]
    }
    return { commandId: r.commandId, locId: r.locId, anchor, snapshotIds: r.snapshotIds }
  })
  return { tabs, runs: plan, idMap }
}
