import type { PersistedPanes } from './types'

/** Pure helpers for the side-by-side pane layout (columns only). Shared by the renderer and the store. */

export const MAX_PANES = 4

export interface Pane {
  id: string
  /** Sidebar location shown in this pane. Null only for the single pane when there are no locations at all. */
  locId: string | null
}

export interface PaneState {
  panes: Pane[]
  /** Width of each pane as a fraction of the pane area; sums to 1. */
  fractions: number[]
  focused: number
}

export type Side = 'left' | 'right'

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0)

/** Equal widths unless the given ones are usable; always sums to 1. */
export function normalizeFractions(fr: unknown, n: number): number[] {
  if (n <= 0) return []
  if (Array.isArray(fr) && fr.length === n && fr.every((f) => typeof f === 'number' && Number.isFinite(f) && f > 0)) {
    const total = sum(fr as number[])
    return (fr as number[]).map((f) => f / total)
  }
  return Array.from({ length: n }, () => 1 / n)
}

/** Validates stored data (any shape) into a clean persisted layout, or null when nothing usable is there. */
export function sanitizePersisted(raw: unknown): PersistedPanes | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<PersistedPanes>
  if (!Array.isArray(r.locIds)) return null
  const ids = r.locIds as unknown[]
  const keep: number[] = []
  const seen = new Set<string>()
  ids.forEach((id, i) => {
    if (typeof id === 'string' && id && !seen.has(id) && keep.length < MAX_PANES) {
      seen.add(id)
      keep.push(i)
    }
  })
  if (keep.length === 0) return null
  const locIds = keep.map((i) => ids[i] as string)
  const fr = Array.isArray(r.fractions) && r.fractions.length === ids.length ? keep.map((i) => (r.fractions as number[])[i]) : null
  const focusedOld = typeof r.focused === 'number' && Number.isInteger(r.focused) ? r.focused : 0
  const focusedNew = keep.indexOf(focusedOld)
  return {
    locIds,
    fractions: normalizeFractions(fr, locIds.length),
    focused: focusedNew >= 0 ? focusedNew : 0
  }
}

export function toPersisted(s: PaneState): PersistedPanes | null {
  const locIds = s.panes.map((p) => p.locId)
  if (locIds.some((l) => l === null)) return null
  return { locIds: locIds as string[], fractions: s.fractions, focused: s.focused }
}

export function fromPersisted(p: unknown, valid: Set<string>, fallback: string | null, mkId: () => string): PaneState {
  const clean = sanitizePersisted(p)
  const base: PaneState = clean
    ? { panes: clean.locIds.map((locId) => ({ id: mkId(), locId })), fractions: clean.fractions, focused: clean.focused }
    : { panes: [], fractions: [], focused: 0 }
  return normalize(base, valid, fallback, mkId)
}

/** Drops panes whose location is gone or duplicated, clamps to MAX_PANES, and guarantees at least one pane. */
export function normalize(s: PaneState, valid: Set<string>, fallback: string | null, mkId: () => string): PaneState {
  const seen = new Set<string>()
  const keep: number[] = []
  s.panes.forEach((p, i) => {
    if (p.locId && valid.has(p.locId) && !seen.has(p.locId) && keep.length < MAX_PANES) {
      seen.add(p.locId)
      keep.push(i)
    }
  })
  if (keep.length === 0) {
    // Nothing valid left: keep one pane (the old one's id, so it does not remount) on the fallback.
    const locId = fallback && valid.has(fallback) ? fallback : null
    if (s.panes.length === 1 && s.panes[0].locId === locId) return s
    return { panes: [{ id: s.panes[0]?.id ?? mkId(), locId }], fractions: [1], focused: 0 }
  }
  if (keep.length === s.panes.length && s.fractions.length === s.panes.length && Math.abs(sum(s.fractions) - 1) < 1e-6) return s
  const fr = s.fractions.length === s.panes.length ? keep.map((i) => s.fractions[i]) : null
  const focusedNew = keep.indexOf(s.focused)
  return {
    panes: keep.map((i) => s.panes[i]),
    fractions: normalizeFractions(fr, keep.length),
    focused: focusedNew >= 0 ? focusedNew : Math.min(s.focused, keep.length - 1)
  }
}

export function indexOfLoc(s: PaneState, locId: string): number {
  return s.panes.findIndex((p) => p.locId === locId)
}

/** The sidebar selection changed: focus the pane already showing that location, else repoint the focused pane. */
export function focusLoc(s: PaneState, locId: string): PaneState {
  const i = indexOfLoc(s, locId)
  if (i >= 0) return i === s.focused ? s : { ...s, focused: i }
  return { ...s, panes: s.panes.map((p, j) => (j === s.focused ? { ...p, locId } : p)) }
}

/** Whether openToSide/dropOnEdge can do anything for this location. */
export function canAddPane(s: PaneState, locId: string): boolean {
  return indexOfLoc(s, locId) >= 0 || s.panes.length < MAX_PANES
}

/**
 * Puts a location in a pane next to `target`. A location already open is moved (keeping its width);
 * a new one splits the target pane in half. Does nothing for a new location when MAX_PANES are open.
 */
export function dropOnEdge(s: PaneState, locId: string, target: number, side: Side, mkId: () => string): PaneState {
  const from = indexOfLoc(s, locId)
  if (from === target) return from === s.focused ? s : { ...s, focused: from }
  if (from >= 0) {
    const pane = s.panes[from]
    const f = s.fractions[from]
    const panes = s.panes.filter((_, i) => i !== from)
    const fractions = s.fractions.filter((_, i) => i !== from)
    const t = target > from ? target - 1 : target
    const at = side === 'right' ? t + 1 : t
    panes.splice(at, 0, pane)
    fractions.splice(at, 0, f)
    return { panes, fractions, focused: at }
  }
  if (s.panes.length >= MAX_PANES || target < 0 || target >= s.panes.length) return s
  const half = s.fractions[target] / 2
  const at = side === 'right' ? target + 1 : target
  const panes = [...s.panes]
  const fractions = [...s.fractions]
  fractions[target] = half
  panes.splice(at, 0, { id: mkId(), locId })
  fractions.splice(at, 0, half)
  return { panes, fractions, focused: at }
}

/** "Open to the side": focus the location's pane if it has one, else open a new pane right of the focused one. */
export function openToSide(s: PaneState, locId: string, mkId: () => string): PaneState {
  const i = indexOfLoc(s, locId)
  if (i >= 0) return i === s.focused ? s : { ...s, focused: i }
  return dropOnEdge(s, locId, s.focused, 'right', mkId)
}

/** Closes a pane (never the last one); its width goes to the left neighbour, or the right one for the first pane. */
export function closePane(s: PaneState, index: number): PaneState {
  if (s.panes.length <= 1 || index < 0 || index >= s.panes.length) return s
  const panes = s.panes.filter((_, i) => i !== index)
  const fractions = s.fractions.filter((_, i) => i !== index)
  const heir = index > 0 ? index - 1 : 0
  fractions[heir] += s.fractions[index]
  const focused = s.focused === index ? heir : s.focused > index ? s.focused - 1 : s.focused
  return { panes, fractions, focused }
}

/** Moves the divider after pane `i` to `boundary` (fraction of the pane area), keeping both sides >= minFrac. */
export function dragDivider(fr: number[], i: number, boundary: number, minFrac: number): number[] {
  if (i < 0 || i >= fr.length - 1) return fr
  const start = sum(fr.slice(0, i))
  const end = start + fr[i] + fr[i + 1]
  const lo = start + minFrac
  const hi = end - minFrac
  const b = lo > hi ? (start + end) / 2 : Math.min(hi, Math.max(lo, boundary))
  const next = [...fr]
  next[i] = b - start
  next[i + 1] = end - b
  return next
}

/** Which pane a point at `ratio` (0..1 across the pane area) falls in, plus the position inside it (0..1). */
export function paneAt(fr: number[], ratio: number): { index: number; within: number } {
  let acc = 0
  for (let i = 0; i < fr.length; i++) {
    if (ratio < acc + fr[i] || i === fr.length - 1) return { index: i, within: Math.min(1, Math.max(0, (ratio - acc) / fr[i])) }
    acc += fr[i]
  }
  return { index: 0, within: 0 }
}

export function startOf(fr: number[], i: number): number {
  return sum(fr.slice(0, i))
}
