// Pure helpers for the nested group tree. No Node imports: used by main, MCP and the renderer.

export interface TreeGroup {
  id: string
  kind: 'parent' | 'manual'
  parentId?: string | null
}
export interface TreeFolder {
  id: string
  groupId: string | null
}

/** The id itself first, then all descendants (visited set, so a cycle cannot loop). [] if the id is unknown. */
export function subtreeGroupIds(groups: TreeGroup[], id: string): string[] {
  if (!groups.some((g) => g.id === id)) return []
  const out = [id]
  const seen = new Set<string>(out)
  for (let i = 0; i < out.length; i++) {
    for (const g of groups) {
      if (g.parentId === out[i] && !seen.has(g.id)) {
        seen.add(g.id)
        out.push(g.id)
      }
    }
  }
  return out
}

/** null when moving group `id` under `parentId` is allowed (parentId null = top level). Otherwise the reason. */
export function nestError(groups: TreeGroup[], id: string, parentId: string | null): string | null {
  if (!groups.some((g) => g.id === id)) return 'Group not found'
  if (parentId === null) return null
  const target = groups.find((g) => g.id === parentId)
  if (!target) return 'Target group not found'
  if (target.kind !== 'manual') return 'Only manual groups can contain groups'
  if (subtreeGroupIds(groups, id).includes(parentId)) return 'Cannot move a group into itself or its own subgroup'
  return null
}

/** Children of parentId (null = roots) in array order. A group whose parentId is unknown counts as a root. */
export function childGroups<G extends TreeGroup>(groups: G[], parentId: string | null): G[] {
  const ids = new Set(groups.map((g) => g.id))
  return groups.filter((g) => {
    const p = g.parentId && ids.has(g.parentId) ? g.parentId : null
    return p === parentId
  })
}

/** Full path of ancestor names joined by " / " (e.g. "A / B"). Visited set, so bad data cannot loop. */
export function groupPath(groups: (TreeGroup & { name: string })[], id: string): string {
  const names: string[] = []
  const seen = new Set<string>()
  let cur = groups.find((g) => g.id === id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    names.unshift(cur.name)
    const pid = cur.parentId
    cur = pid ? groups.find((g) => g.id === pid) : undefined
  }
  return names.join(' / ')
}

/** What a cascade removal of `id` takes away: subtreeGroupIds + folders whose groupId is in that set. */
export function removalSet(
  groups: TreeGroup[],
  folders: TreeFolder[],
  id: string
): { groupIds: string[]; folderIds: string[] } {
  const groupIds = subtreeGroupIds(groups, id)
  const set = new Set(groupIds)
  return { groupIds, folderIds: folders.filter((f) => f.groupId !== null && set.has(f.groupId)).map((f) => f.id) }
}

/**
 * Where Alt+Shift+Left/Right (or the "Move into group above" / "Move out of group" menu entries) would put item `id`.
 * Returns the new container (a manual group id, or null = top level) or undefined when nothing would change.
 * dir 1 = into the manual group rendered directly above at the same level: for a group the previous sibling group,
 * for a folder the last manual child group of its container (the sidebar renders subgroups before folders).
 * dir -1 = one level out: the container's own parent. Pure; used by main (authoritative) and the renderer (menu).
 */
export function nestTarget(groups: TreeGroup[], folders: TreeFolder[], id: string, dir: -1 | 1): string | null | undefined {
  const ids = new Set(groups.map((g) => g.id))
  const parentOf = (g: TreeGroup): string | null => (g.parentId && ids.has(g.parentId) ? g.parentId : null)
  const manual = (gid: string | null): boolean => gid === null || groups.some((g) => g.id === gid && g.kind === 'manual')
  const g = groups.find((x) => x.id === id)
  const f = g ? undefined : folders.find((x) => x.id === id)
  if (!g && !f) return undefined
  const cur = g ? parentOf(g) : f && f.groupId && ids.has(f.groupId) ? f.groupId : null
  let target: string | null | undefined
  if (dir === 1) {
    const sibs = childGroups(groups, cur)
    const above = g ? sibs[sibs.findIndex((x) => x.id === id) - 1] : [...sibs].reverse().find((x) => x.kind === 'manual')
    target = above && above.kind === 'manual' ? above.id : undefined
  } else {
    const parent = cur === null ? undefined : groups.find((x) => x.id === cur)
    target = parent ? parentOf(parent) : undefined
  }
  if (target === undefined || !manual(target)) return undefined
  if (g && nestError(groups, id, target) !== null) return undefined
  return target
}
