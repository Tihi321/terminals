import type { AppState, Command, Snippet } from '../../shared/types'
import { buildLocs } from './locations'

/** In-app clipboard for saved commands and prompts (in memory only). */
export type AppClipboard = { kind: 'command'; item: Command } | { kind: 'prompt'; item: Snippet } | null

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

/** Resolve an owner id to its path and whether it is a group (manual or parent folder). */
export function ownerInfo(state: AppState, id: string): { path: string | null; isGroup: boolean } {
  const loc = buildLocs(state).get(id)
  return { path: loc?.path ?? null, isGroup: loc?.kind === 'parent' || loc?.kind === 'manual' }
}
