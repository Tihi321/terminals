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
