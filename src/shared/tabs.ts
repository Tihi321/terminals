import type { Pane } from './panes'

/** Pure helpers for tab order and the per-pane active tab. No DOM; shared by the renderer and the smoke checks. */

export interface TabRef {
  id: string
  locId: string
}

/** paneId -> tabId */
export type ActiveMap = Record<string, string>

/** Rewrites the folder's tabs in `order` into the slots the folder already occupies, so other folders' tabs keep their indexes. */
function reslot<T extends TabRef>(tabs: T[], slots: number[], order: T[]): T[] {
  if (order.every((t, i) => t === tabs[slots[i]])) return tabs
  const next = [...tabs]
  slots.forEach((slot, i) => (next[slot] = order[i]))
  return next
}

function slotsOf(tabs: TabRef[], locId: string): number[] {
  const slots: number[] = []
  tabs.forEach((t, i) => {
    if (t.locId === locId) slots.push(i)
  })
  return slots
}

/** Moves `id` directly before `beforeId` within its folder; null = after the folder's last tab. Same array when nothing changes,
 *  `id` is unknown, or `beforeId` belongs to another folder. Other folders' tabs keep their indexes. */
export function moveTab<T extends TabRef>(tabs: T[], id: string, beforeId: string | null): T[] {
  const tab = tabs.find((t) => t.id === id)
  if (!tab || beforeId === id) return tabs
  const slots = slotsOf(tabs, tab.locId)
  const list = slots.map((i) => tabs[i])
  const rest = list.filter((t) => t !== tab)
  let at = rest.length
  if (beforeId !== null) {
    at = rest.findIndex((t) => t.id === beforeId)
    if (at < 0) return tabs
  }
  rest.splice(at, 0, tab)
  return reslot(tabs, slots, rest)
}

/** One place left/right within its folder; no wrap; same array at an edge or for an unknown id. */
export function shiftTab<T extends TabRef>(tabs: T[], id: string, dir: -1 | 1): T[] {
  const tab = tabs.find((t) => t.id === id)
  if (!tab) return tabs
  const slots = slotsOf(tabs, tab.locId)
  const list = slots.map((i) => tabs[i])
  const from = list.indexOf(tab)
  const to = from + dir
  if (to < 0 || to >= list.length) return tabs
  const order = [...list]
  order[from] = list[to]
  order[to] = tab
  return reslot(tabs, slots, order)
}

/** Next tab of the same folder after `id`, else the previous, skipping `taken` and `id`; undefined when none. */
export function neighbourTab(tabs: TabRef[], id: string, taken: Set<string>): string | undefined {
  const tab = tabs.find((t) => t.id === id)
  if (!tab) return undefined
  const list = tabs.filter((t) => t.locId === tab.locId)
  const at = list.indexOf(tab)
  const ok = (t: TabRef): boolean => t.id !== id && !taken.has(t.id)
  for (let i = at + 1; i < list.length; i++) if (ok(list[i])) return list[i].id
  for (let i = at - 1; i >= 0; i--) if (ok(list[i])) return list[i].id
  return undefined
}

/** Id of tab n (1-based) among `locId`'s tabs in array order; n >= 9 means the last one; undefined when out of range. */
export function nthTabOfLoc(tabs: TabRef[], locId: string, n: number): string | undefined {
  const list = tabs.filter((t) => t.locId === locId)
  if (n < 1 || list.length === 0) return undefined
  return n >= 9 ? list[list.length - 1].id : list[n - 1]?.id
}

/** Tab ids active in any pane except `exceptPaneId`. */
export function takenBy(active: ActiveMap, exceptPaneId?: string): Set<string> {
  const out = new Set<string>()
  for (const [paneId, tabId] of Object.entries(active)) if (paneId !== exceptPaneId) out.add(tabId)
  return out
}

/** Pane id whose active tab is `tabId`, or undefined. */
export function paneOfTab(active: ActiveMap, tabId: string): string | undefined {
  return Object.keys(active).find((paneId) => active[paneId] === tabId)
}

/** Makes tabId active in paneId; the other pane that showed it gets neighbourTab(...) or loses its entry. Drops unknown panes. Pure. */
export function activateIn(panes: Pane[], tabs: TabRef[], active: ActiveMap, paneId: string, tabId: string): ActiveMap {
  const known = new Set(panes.map((p) => p.id))
  const next: ActiveMap = {}
  for (const [pid, tid] of Object.entries(active)) if (known.has(pid)) next[pid] = tid
  if (!known.has(paneId) || !tabs.some((t) => t.id === tabId)) return next
  const prev = paneOfTab(next, tabId)
  next[paneId] = tabId
  if (prev && prev !== paneId) {
    const n = neighbourTab(tabs, tabId, new Set(Object.values(next)))
    if (n) next[prev] = n
    else delete next[prev]
  }
  return next
}

/** Panes visited focused first, then left to right. Pass 1 keeps an entry whose tab exists, belongs to the pane's locId and is not taken.
 *  Pass 2 fills panes without an entry: lastByLoc[locId] if valid and free, else the folder's first free tab, else none.
 *  Unknown panes dropped. Returns `active` itself when the entries are unchanged. */
export function reconcileActive(
  panes: Pane[],
  focused: number,
  tabs: TabRef[],
  active: ActiveMap,
  lastByLoc: Record<string, string>
): ActiveMap {
  const order = panes.map((_, i) => i)
  const f = order.indexOf(focused)
  if (f > 0) order.unshift(...order.splice(f, 1))
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const used = new Set<string>()
  const next: ActiveMap = {}
  for (const i of order) {
    const p = panes[i]
    const tid = active[p.id]
    const tab = tid ? byId.get(tid) : undefined
    if (tab && tab.locId === p.locId && !used.has(tab.id)) {
      next[p.id] = tab.id
      used.add(tab.id)
    }
  }
  for (const i of order) {
    const p = panes[i]
    if (next[p.id] || !p.locId) continue
    const last = lastByLoc[p.locId]
    const lastTab = last ? byId.get(last) : undefined
    const pick =
      lastTab && lastTab.locId === p.locId && !used.has(lastTab.id) ? lastTab : tabs.find((t) => t.locId === p.locId && !used.has(t.id))
    if (pick) {
      next[p.id] = pick.id
      used.add(pick.id)
    }
  }
  const a = Object.keys(active)
  const b = Object.keys(next)
  return a.length === b.length && b.every((k) => active[k] === next[k]) ? active : next
}
