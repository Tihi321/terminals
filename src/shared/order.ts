/** Pure helpers for reordering saved commands / prompts. A list shown in the panel is a filtered view of one stored array. */

/** Moves `id` directly before `beforeId` in `ids`; null = to the end. Same array when nothing changes, `id` is unknown or `beforeId` is not in the list. */
export function moveId(ids: string[], id: string, beforeId: string | null): string[] {
  if (!ids.includes(id) || beforeId === id) return ids
  const rest = ids.filter((x) => x !== id)
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId)
  if (at < 0) return ids
  rest.splice(at, 0, id)
  return rest.every((x, i) => x === ids[i]) ? ids : rest
}

/** One place up/down in `ids`; no wrap; same array at an edge or for an unknown id. */
export function shiftId(ids: string[], id: string, dir: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + dir
  if (from < 0 || to < 0 || to >= ids.length) return ids
  const out = [...ids]
  out[from] = ids[to]
  out[to] = id
  return out
}

/** Gives the items named in `orderedIds` that order, in the slots those items already occupy; every other item keeps its index.
 *  Same array when `orderedIds` has an unknown or repeated id, or already matches. */
export function applyOrder<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const byId = new Map(items.map((x) => [x.id, x]))
  if (new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !byId.has(id))) return items
  const named = new Set(orderedIds)
  const queue = orderedIds.map((id) => byId.get(id) as T)
  const out = items.map((x) => (named.has(x.id) ? (queue.shift() as T) : x))
  return out.every((x, i) => x === items[i]) ? items : out
}
