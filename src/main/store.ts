import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  HOME_ID,
  SCHEMA_VERSION,
  type AppState,
  type ChildView,
  type Command,
  type Folder,
  type GroupView,
  type Snippet,
  type Settings,
  type UiState
} from '../shared/types'
import { sanitizePersisted } from '../shared/panes'
import { sanitizeTabs } from '../shared/session'
import { DEFAULT_SETTINGS, patchSettings, sanitizeSettings } from '../shared/settings'
import { childGroups, nestError, nestTarget, removalSet } from '../shared/groupTree'
import { applyOrder } from '../shared/order'
import { resolveShell } from './pty'
import { readGit } from './git'

interface PersistedGroup {
  id: string
  kind: 'parent' | 'manual'
  name: string
  path?: string
  /** Manual groups only: optional folder on disk where "New folder" creates folders. */
  folder?: string
  /** Containing manual group; absent or null = top level. */
  parentId?: string | null
  order: number
  collapsed: boolean
  showHidden: boolean
  /** Lower-cased absolute paths of hidden children (parent groups). */
  hidden: string[]
}

export interface Persisted {
  version: number
  folders: Folder[]
  groups: PersistedGroup[]
  /** Ids of pinned folders/groups, in the order they were pinned. Absent in older files. */
  pinned: string[]
  commands: Command[]
  snippets: Snippet[]
  selectedId: string | null
  settings: Settings
  ui: UiState
}

const DEFAULT_UI: UiState = { sidebarWidth: 260, panelWidth: 340, sidebarCollapsed: false, panes: null, panelOpen: false, panelTab: 'files', tabs: [], groupBy: 'none', idleCollapsed: false, idleOpen: [] }

function emptyData(): Persisted {
  return {
    version: SCHEMA_VERSION,
    folders: [],
    groups: [],
    pinned: [],
    commands: [],
    snippets: [],
    selectedId: null,
    settings: { ...DEFAULT_SETTINGS },
    ui: { ...DEFAULT_UI }
  }
}

let data: Persisted = emptyData()
let file = ''

export const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
export const childId = (p: string): string => 'child:' + norm(p)

function num(v: unknown, def: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def
}

function sanitizeCommand(c: Partial<Command>): Command | null {
  if (!c || typeof c.id !== 'string' || typeof c.ownerId !== 'string') return null
  return {
    id: c.id,
    name: String(c.name ?? '').trim() || 'Untitled command',
    ownerId: c.ownerId,
    mode: c.mode === 'sequential' ? 'sequential' : 'parallel',
    targets: (Array.isArray(c.targets) ? c.targets : []).map((t) => ({
      cwd: String(t?.cwd ?? ''),
      steps: (Array.isArray(t?.steps) ? t.steps : []).map((s) => String(s).trim()).filter(Boolean)
    }))
  }
}

function sanitizeSnippet(s: Partial<Snippet>): Snippet | null {
  if (!s || typeof s.id !== 'string') return null
  if (s.kind === 'shell') {
    return { id: s.id, name: String(s.name ?? '').trim() || 'Untitled shell command', body: String(s.body ?? ''), scope: 'global', kind: 'shell' }
  }
  return {
    id: s.id,
    name: String(s.name ?? '').trim() || 'Untitled prompt',
    body: String(s.body ?? ''),
    scope: typeof s.scope === 'string' && s.scope ? s.scope : 'global'
  }
}

/** Migrates any older shape (version missing = 1) into the current schema without dropping data. */
export function migrate(raw: Record<string, unknown>): Persisted {
  const d = emptyData()
  // v1 -> v2 added groups, commands, ui, settings.editor/terminalFontSize and folder.groupId.
  // Folders, selection and settings.shell are carried over unchanged.
  const folders = Array.isArray(raw.folders) ? (raw.folders as Partial<Folder>[]) : []
  d.folders = folders
    .filter((f) => typeof f?.id === 'string' && typeof f.path === 'string')
    .map((f, i) => ({
      id: f.id as string,
      path: f.path as string,
      name: f.name || basename(f.path as string) || (f.path as string),
      order: typeof f.order === 'number' ? f.order : i,
      groupId: typeof f.groupId === 'string' ? f.groupId : null
    }))
  d.groups = (Array.isArray(raw.groups) ? (raw.groups as Partial<PersistedGroup>[]) : [])
    .filter((g) => typeof g?.id === 'string')
    .map((g, i) => ({
      id: g.id as string,
      kind: g.kind === 'parent' ? 'parent' : 'manual',
      name: String(g.name ?? 'Group'),
      path: typeof g.path === 'string' ? g.path : undefined,
      folder: g.kind !== 'parent' && typeof g.folder === 'string' && g.folder ? g.folder : undefined,
      parentId: typeof g.parentId === 'string' ? g.parentId : null,
      order: typeof g.order === 'number' ? g.order : i,
      collapsed: !!g.collapsed,
      showHidden: !!g.showHidden,
      hidden: Array.isArray(g.hidden) ? g.hidden.map((h) => String(h).toLowerCase()) : []
    }))
  d.commands = (Array.isArray(raw.commands) ? (raw.commands as Partial<Command>[]) : [])
    .map(sanitizeCommand)
    .filter((c): c is Command => !!c)
  // v2 -> v3 added snippets (absent in older files, so they migrate to an empty list).
  d.snippets = (Array.isArray(raw.snippets) ? (raw.snippets as Partial<Snippet>[]) : [])
    .map(sanitizeSnippet)
    .filter((s): s is Snippet => !!s)
  d.selectedId = typeof raw.selectedId === 'string' ? raw.selectedId : null
  d.settings = sanitizeSettings(raw.settings)
  const u = (raw.ui ?? {}) as Partial<UiState>
  d.ui = {
    sidebarWidth: num(u.sidebarWidth, DEFAULT_UI.sidebarWidth, 180, 600),
    panelWidth: num(u.panelWidth, DEFAULT_UI.panelWidth, 220, 900),
    sidebarCollapsed: !!u.sidebarCollapsed,
    panes: sanitizePersisted(u.panes),
    panelOpen: !!u.panelOpen,
    panelTab: u.panelTab === 'commands' || u.panelTab === 'git' ? u.panelTab : 'files',
    // v3 -> v4 added ui.tabs (saved session) and panes.active
    tabs: sanitizeTabs(u.tabs),
    // Sidebar "Group by" prefs (absent in older files = defaults)
    groupBy: u.groupBy === 'activity' ? 'activity' : 'none',
    idleCollapsed: !!u.idleCollapsed,
    idleOpen: (Array.isArray(u.idleOpen) ? u.idleOpen : []).filter((x, i, a): x is string => typeof x === 'string' && a.indexOf(x) === i)
  }
  // Pins (added without a schema bump: absent = none). Keep only existing folder/group ids, once each.
  const pinnable = new Set([...d.folders.map((f) => f.id), ...d.groups.map((g) => g.id)])
  d.pinned = (Array.isArray(raw.pinned) ? raw.pinned : []).filter((x, i, a): x is string => typeof x === 'string' && pinnable.has(x) && a.indexOf(x) === i)
  // Drop dangling group references rather than losing the folder.
  const groupIds = new Set(d.groups.map((g) => g.id))
  for (const f of d.folders) if (f.groupId && !groupIds.has(f.groupId)) f.groupId = null
  // Only existing manual groups can be parents; a group is never its own parent.
  const byId = new Map(d.groups.map((g) => [g.id, g]))
  for (const g of d.groups) {
    if (!g.parentId) continue
    const p = byId.get(g.parentId)
    if (!p || p === g || p.kind !== 'manual') g.parentId = null
  }
  // Break cycles: walk up from each group and cut the link where a node is revisited.
  for (const g of d.groups) {
    const seen = new Set<string>([g.id])
    let cur: PersistedGroup = g
    while (cur.parentId) {
      if (seen.has(cur.parentId)) {
        cur.parentId = null
        break
      }
      seen.add(cur.parentId)
      cur = byId.get(cur.parentId) as PersistedGroup
    }
  }
  return d
}

export function loadStore(): void {
  file = join(app.getPath('userData'), 'terminals.json')
  if (!existsSync(file)) return
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const version = typeof raw.version === 'number' ? raw.version : 1
    if (version > SCHEMA_VERSION) {
      // Written by a newer build: run with an empty in-memory state and never overwrite the file.
      console.error(`terminals.json is version ${version}, newer than supported ${SCHEMA_VERSION}; not loading`)
      file = file + '.incompatible-session'
      return
    }
    if (version < SCHEMA_VERSION) {
      try {
        copyFileSync(file, `${file}.v${version}.bak`)
      } catch (e) {
        console.error('Could not back up old store', e)
      }
    }
    data = migrate(raw)
    if (version < SCHEMA_VERSION) save()
  } catch (e) {
    // Corrupt file: keep a copy so it is never silently overwritten, then start empty.
    console.error('Failed to read store', e)
    try {
      copyFileSync(file, `${file}.corrupt.bak`)
    } catch {
      /* ignore */
    }
  }
  data.folders.sort((a, b) => a.order - b.order)
  data.groups.sort((a, b) => a.order - b.order)
}

function save(): void {
  data.folders.forEach((f, i) => (f.order = i))
  data.groups.forEach((g, i) => (g.order = i))
  data.version = SCHEMA_VERSION
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, file)
  } catch (e) {
    console.error('Failed to save store', e)
  }
}

const IGNORED_CHILDREN = new Set(['node_modules'])

function scanChildren(dir: string, hidden: Set<string>): ChildView[] {
  let names: Dirent[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ChildView[] = []
  for (const ent of names) {
    if (ent.name.startsWith('.') || IGNORED_CHILDREN.has(ent.name.toLowerCase())) continue
    const p = join(dir, ent.name)
    let isDir = ent.isDirectory()
    if (!isDir && ent.isSymbolicLink()) {
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        isDir = false
      }
    }
    if (!isDir) continue
    const g = readGit(p)
    out.push({ id: childId(p), path: p, name: ent.name, isGit: g.isGit, branch: g.branch, hidden: hidden.has(norm(p)) })
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

export function getState(): AppState {
  const groups: GroupView[] = data.groups.map((g) => {
    const isParent = g.kind === 'parent' && !!g.path
    const missing = isParent ? !existsSync(g.path as string) : false
    const git = isParent && !missing ? readGit(g.path as string) : { isGit: false, branch: null }
    const children = isParent && !missing ? scanChildren(g.path as string, new Set(g.hidden)) : []
    return {
      id: g.id,
      kind: g.kind,
      name: g.name,
      parentId: g.parentId ?? null,
      path: g.path ?? null,
      folder: g.kind === 'manual' ? g.folder ?? null : null,
      order: g.order,
      collapsed: g.collapsed,
      showHidden: g.showHidden,
      missing,
      isGit: git.isGit,
      branch: git.branch,
      children,
      hiddenCount: children.filter((c) => c.hidden).length
    }
  })
  const homePath = getHomeDir()
  const homeMissing = !existsSync(homePath)
  const homeGit = homeMissing ? { isGit: false, branch: null } : readGit(homePath)
  return {
    home: {
      id: HOME_ID,
      name: 'Home',
      path: homePath,
      isDefault: data.settings.homeDir === '',
      missing: homeMissing,
      isGit: homeGit.isGit,
      branch: homeGit.branch
    },
    folders: data.folders.map((f) => {
      const missing = !existsSync(f.path)
      const git = missing ? { isGit: false, branch: null } : readGit(f.path)
      return { ...f, missing, isGit: git.isGit, branch: git.branch }
    }),
    groups,
    pinned: data.pinned,
    commands: data.commands,
    snippets: data.snippets,
    selectedId: data.selectedId,
    settings: data.settings,
    ui: data.ui,
    resolvedShell: resolveShell(data.settings.shell)
  }
}

/** Directory of the Home location: settings.homeDir, or the Documents folder when that is ''. */
export function getHomeDir(): string {
  return data.settings.homeDir || app.getPath('documents')
}

export function getSettings(): Settings {
  return data.settings
}

export function getShell(): string {
  return resolveShell(data.settings.shell)
}

export function getEditor(): string {
  return data.settings.editor
}

/** Absolute roots the renderer may browse/open: saved folders and parent-folder group roots. */
export function getRoots(): string[] {
  return [
    ...data.folders.map((f) => f.path),
    ...data.groups.filter((g) => g.path).map((g) => g.path as string),
    ...data.groups.filter((g) => g.kind === 'manual' && g.folder).map((g) => g.folder as string),
    getHomeDir()
  ]
}

export function isInsideRoots(p: string): boolean {
  const target = norm(p)
  return getRoots().some((root) => {
    const rel = relative(norm(root), target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

export function isCommandCwd(p: string): boolean {
  const target = norm(p)
  return data.commands.some((c) => c.targets.some((t) => t.cwd && norm(t.cwd) === target))
}

export function addFolder(path: string): AppState {
  const existing = data.folders.find((f) => norm(f.path) === norm(path))
  if (existing) {
    data.selectedId = existing.id
  } else {
    const f: Folder = { id: randomUUID(), path, name: basename(path) || path, order: data.folders.length, groupId: null }
    data.folders.push(f)
    data.selectedId = f.id
  }
  save()
  return getState()
}

/** Finds or creates the parent-folder group for `path` without saving or touching the selection. */
function upsertParentGroup(path: string): { id: string; existed: boolean } {
  const existing = data.groups.find((g) => g.kind === 'parent' && g.path && norm(g.path) === norm(path))
  if (existing) return { id: existing.id, existed: true }
  const g: PersistedGroup = {
    id: randomUUID(),
    kind: 'parent',
    name: basename(path) || path,
    path,
    order: data.groups.length,
    collapsed: false,
    showHidden: false,
    hidden: []
  }
  data.groups.push(g)
  return { id: g.id, existed: false }
}

export function addParentGroup(path: string): AppState {
  data.selectedId = upsertParentGroup(path).id
  save()
  return getState()
}

/** Like addParentGroup, but leaves the selection alone (used by the MCP server). */
export function createParentGroup(path: string): { id: string; existed: boolean } {
  const r = upsertParentGroup(path)
  if (!r.existed) save()
  return r
}

function pushManualGroup(name: string, parentId?: string | null): string {
  const g: PersistedGroup = {
    id: randomUUID(),
    kind: 'manual',
    name: name.trim() || 'New group',
    parentId: parentId && data.groups.some((x) => x.id === parentId && x.kind === 'manual') ? parentId : null,
    order: data.groups.length,
    collapsed: false,
    showHidden: false,
    hidden: []
  }
  data.groups.push(g)
  return g.id
}

export function addManualGroup(name: string, parentId?: string | null): AppState {
  data.selectedId = pushManualGroup(name, parentId)
  save()
  return getState()
}

/** Like addManualGroup, but leaves the selection alone and returns the new id (used by the MCP server). */
export function createManualGroup(name: string, parentId?: string | null): string {
  const id = pushManualGroup(name, parentId)
  save()
  return id
}

function fixSelection(d: Persisted): void {
  const s = d.selectedId
  if (!s || s === HOME_ID || s.startsWith('child:')) return
  if (!d.folders.some((f) => f.id === s) && !d.groups.some((g) => g.id === s)) {
    d.selectedId = d.folders[0]?.id ?? d.groups[0]?.id ?? HOME_ID
  }
}

export function removeFolder(id: string): AppState {
  data.folders = data.folders.filter((f) => f.id !== id)
  data.pinned = data.pinned.filter((x) => x !== id)
  data.commands = data.commands.filter((c) => c.ownerId !== id)
  data.snippets = data.snippets.filter((s) => s.scope !== id)
  fixSelection(data)
  save()
  return getState()
}

export interface RemovalSummary {
  groupIds: string[]
  folderIds: string[]
  commands: number
  prompts: number
}

/** Cascade-removes group `id` from `d`: subgroups, their folders, and owned commands/prompts. Touches only `d` (no disk, no save). */
export function removeGroupData(d: Persisted, id: string): RemovalSummary {
  const { groupIds, folderIds } = removalSet(d.groups, d.folders, id)
  const summary: RemovalSummary = { groupIds, folderIds, commands: 0, prompts: 0 }
  if (groupIds.length === 0) return summary
  const gset = new Set(groupIds)
  const fset = new Set(folderIds)
  // Direct children of removed parent-folder groups own commands/prompts under `child:` ids.
  const prefixes: string[] = []
  for (const g of d.groups) if (gset.has(g.id) && g.kind === 'parent' && g.path) prefixes.push(childId(g.path) + sep)
  const owned = (o: string): boolean =>
    gset.has(o) || fset.has(o) || prefixes.some((p) => o.startsWith(p) && !/[\\/]/.test(o.slice(p.length)))
  const sel = d.selectedId
  const selRemoved = !!sel && owned(sel)
  const cmds = d.commands.filter((c) => !owned(c.ownerId))
  const snips = d.snippets.filter((s) => !owned(s.scope))
  summary.commands = d.commands.length - cmds.length
  summary.prompts = d.snippets.length - snips.length
  d.commands = cmds
  d.snippets = snips
  d.groups = d.groups.filter((g) => !gset.has(g.id))
  d.folders = d.folders.filter((f) => !fset.has(f.id))
  d.pinned = d.pinned.filter((x) => !gset.has(x) && !fset.has(x))
  if (selRemoved) d.selectedId = d.folders[0]?.id ?? d.groups[0]?.id ?? HOME_ID
  else fixSelection(d)
  return summary
}

export function removeGroup(id: string): AppState {
  removeGroupData(data, id)
  save()
  return getState()
}

/** Cascade removal for the MCP server; returns what was removed. */
export function deleteGroup(id: string): RemovalSummary {
  const r = removeGroupData(data, id)
  if (r.groupIds.length > 0) save()
  return r
}

/** Nests group `id` under manual group `parentId` (null = top level) and makes it the last record. Returns the error or null. Pure on `d`. */
export function moveGroupData(d: Persisted, id: string, parentId: string | null): string | null {
  const err = nestError(d.groups, id, parentId)
  if (err) return err
  const g = d.groups.find((x) => x.id === id) as PersistedGroup
  if ((g.parentId ?? null) === parentId) return null // already there: no-op, no reorder
  g.parentId = parentId
  d.groups = d.groups.filter((x) => x !== g)
  d.groups.push(g)
  return null
}

export function moveGroup(id: string, parentId: string | null): AppState {
  if (moveGroupData(data, id, parentId) === null) save()
  return getState()
}

export function renameFolder(id: string, name: string): AppState {
  const f = data.folders.find((x) => x.id === id)
  if (f) {
    f.name = name.trim() || basename(f.path) || f.path
    save()
  }
  return getState()
}

export function renameGroup(id: string, name: string): AppState {
  const g = data.groups.find((x) => x.id === id)
  if (g) {
    g.name = name.trim() || (g.path ? basename(g.path) : '') || 'Group'
    save()
  }
  return getState()
}

export function moveFolder(id: string, groupId: string | null, beforeId?: string): AppState {
  const f = data.folders.find((x) => x.id === id)
  if (!f) return getState()
  if (groupId && !data.groups.some((g) => g.id === groupId && g.kind === 'manual')) groupId = null
  f.groupId = groupId
  data.folders = data.folders.filter((x) => x !== f)
  const at = beforeId ? data.folders.findIndex((x) => x.id === beforeId) : -1
  if (at >= 0) data.folders.splice(at, 0, f)
  else data.folders.push(f)
  save()
  return getState()
}

/** Swaps item `id` with its neighbour among siblings (same groupId for folders, same effective parent for groups). Pure on `d`. Returns true when something moved. */
export function moveItemData(d: Persisted, id: string, dir: -1 | 1): boolean {
  if (dir !== -1 && dir !== 1) return false
  const swap = <T extends { id: string }>(arr: T[], sibs: T[]): boolean => {
    const i = sibs.findIndex((x) => x.id === id)
    const other = sibs[i + dir]
    if (i < 0 || !other) return false
    const a = arr.indexOf(sibs[i])
    const b = arr.indexOf(other)
    ;[arr[a], arr[b]] = [arr[b], arr[a]]
    return true
  }
  const f = d.folders.find((x) => x.id === id)
  if (f) return swap(d.folders, d.folders.filter((x) => (x.groupId ?? null) === (f.groupId ?? null)))
  const g = d.groups.find((x) => x.id === id)
  if (g) {
    const parent = g.parentId && d.groups.some((x) => x.id === g.parentId) ? g.parentId : null
    return swap(d.groups, childGroups(d.groups, parent))
  }
  return false
}

export function moveItem(id: string, dir: -1 | 1): AppState {
  if (moveItemData(data, String(id), dir)) save()
  return getState()
}

/** Nests item `id` into the manual group above it (dir 1) or out of its group (dir -1); rules in nestTarget. Appends at the end of the new container. Pure on `d`. Returns true when something moved. */
export function nestItemData(d: Persisted, id: string, dir: -1 | 1): boolean {
  if (dir !== -1 && dir !== 1) return false
  const target = nestTarget(d.groups, d.folders, id, dir)
  if (target === undefined) return false
  const f = d.folders.find((x) => x.id === id)
  if (f) {
    f.groupId = target
    d.folders = d.folders.filter((x) => x !== f)
    d.folders.push(f)
    return true
  }
  const g = d.groups.find((x) => x.id === id) as PersistedGroup
  const oldParent = g.parentId
  g.parentId = target
  d.groups = d.groups.filter((x) => x !== g)
  if (dir === -1 && oldParent) d.groups.splice(d.groups.findIndex((x) => x.id === oldParent) + 1, 0, g)
  else d.groups.push(g)
  return true
}

export function nestItem(id: string, dir: -1 | 1): AppState {
  if (nestItemData(data, String(id), dir)) save()
  return getState()
}

/** Sets or clears (null) the folder of manual group `id`. Returns false when the group is missing or not manual. Pure on `d`. */
export function setGroupFolderData(d: Persisted, id: string, folder: string | null): boolean {
  const g = d.groups.find((x) => x.id === id)
  if (!g || g.kind !== 'manual') return false
  if (folder) g.folder = resolve(folder)
  else delete g.folder
  return true
}

export function setGroupFolder(id: string, folder: string | null): AppState {
  if (setGroupFolderData(data, String(id), typeof folder === 'string' && folder ? folder : null)) save()
  return getState()
}

/** Folder on disk of manual group `id`, or null. */
export function getGroupFolder(id: string): string | null {
  const g = data.groups.find((x) => x.id === id && x.kind === 'manual')
  return g?.folder ?? null
}

function withGroup(id: string, fn: (g: PersistedGroup) => void): AppState {
  const g = data.groups.find((x) => x.id === id)
  if (g) {
    fn(g)
    save()
  }
  return getState()
}

/** Pins (appended, so order = order pinned) or unpins a folder or group. Unknown ids are ignored. */
export function setPinned(id: string, pinned: boolean): AppState {
  const exists = data.folders.some((f) => f.id === id) || data.groups.some((g) => g.id === id)
  data.pinned = data.pinned.filter((x) => x !== id)
  if (pinned && exists) data.pinned.push(id)
  save()
  return getState()
}

export const setGroupCollapsed = (id: string, collapsed: boolean): AppState =>
  withGroup(id, (g) => (g.collapsed = !!collapsed))
export const setShowHidden = (id: string, show: boolean): AppState => withGroup(id, (g) => (g.showHidden = !!show))
export const setChildHidden = (id: string, path: string, hidden: boolean): AppState =>
  withGroup(id, (g) => {
    const key = norm(path)
    g.hidden = g.hidden.filter((h) => h !== key)
    if (hidden) g.hidden.push(key)
  })

export function select(id: string | null): AppState {
  data.selectedId = typeof id === 'string' ? id : null
  save()
  return getState()
}

export function saveCommand(cmd: Command): AppState {
  const c = sanitizeCommand(cmd)
  if (c) {
    const i = data.commands.findIndex((x) => x.id === c.id)
    if (i >= 0) data.commands[i] = c
    else data.commands.push(c)
    save()
  }
  return getState()
}

export function deleteCommand(id: string): AppState {
  data.commands = data.commands.filter((c) => c.id !== id)
  save()
  return getState()
}

/** Gives the saved commands named in `ids` that order, in the slots they already occupy. Ids are kept; unknown or repeated ids are ignored. */
export function reorderCommands(ids: string[]): AppState {
  const next = applyOrder(data.commands, ids)
  if (next !== data.commands) {
    data.commands = next
    save()
  }
  return getState()
}

/** Same as reorderCommands, for prompts and shell lines. */
export function reorderSnippets(ids: string[]): AppState {
  const next = applyOrder(data.snippets, ids)
  if (next !== data.snippets) {
    data.snippets = next
    save()
  }
  return getState()
}

export function saveSnippet(snip: Snippet): AppState {
  const s = sanitizeSnippet(snip)
  if (s) {
    const i = data.snippets.findIndex((x) => x.id === s.id)
    if (i >= 0) data.snippets[i] = s
    else data.snippets.push(s)
    save()
  }
  return getState()
}

export function deleteSnippet(id: string): AppState {
  data.snippets = data.snippets.filter((s) => s.id !== id)
  save()
  return getState()
}

/** Adds existing directories not yet saved and selects the first new one. */
export function addFolderPaths(paths: string[], groupId: string | null, beforeId?: string): AppState {
  const created = insertFolders(paths, groupId, beforeId)
  if (created.length === 0) return getState()
  data.selectedId = created[0].id
  save()
  return getState()
}

/** Like addFolderPaths, but leaves the selection alone and returns the new folders in input order (used by the MCP server). */
export function createFolders(paths: string[], groupId: string | null): Folder[] {
  const created = insertFolders(paths, groupId)
  if (created.length > 0) save()
  return created
}

/** Inserts existing directories not yet saved, without saving. Returns the new folders in input order. */
function insertFolders(paths: string[], groupId: string | null, beforeId?: string): Folder[] {
  if (groupId && !data.groups.some((g) => g.id === groupId && g.kind === 'manual')) groupId = null
  const created: Folder[] = []
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw) continue
    let isDir = false
    try {
      isDir = statSync(raw).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue
    const key = norm(raw)
    if (data.folders.some((f) => norm(f.path) === key) || created.some((f) => norm(f.path) === key)) continue
    const path = resolve(raw)
    created.push({ id: randomUUID(), path, name: basename(path) || path, order: 0, groupId })
  }
  if (created.length === 0) return created
  const at = beforeId ? data.folders.findIndex((x) => x.id === beforeId) : -1
  if (at >= 0) data.folders.splice(at, 0, ...created)
  else data.folders.push(...created)
  return created
}

export function setSettings(patch: Partial<Settings>): AppState {
  data.settings = patchSettings(data.settings, patch)
  save()
  return getState()
}

export function setUi(patch: Partial<UiState>): AppState {
  const u = data.ui
  if (patch.sidebarWidth !== undefined) u.sidebarWidth = num(patch.sidebarWidth, u.sidebarWidth, 180, 600)
  if (patch.panelWidth !== undefined) u.panelWidth = num(patch.panelWidth, u.panelWidth, 220, 900)
  if (patch.sidebarCollapsed !== undefined) u.sidebarCollapsed = !!patch.sidebarCollapsed
  if (patch.panes !== undefined) u.panes = sanitizePersisted(patch.panes)
  if (patch.tabs !== undefined) u.tabs = sanitizeTabs(patch.tabs)
  if (patch.groupBy === 'none' || patch.groupBy === 'activity') u.groupBy = patch.groupBy
  if (patch.idleCollapsed !== undefined) u.idleCollapsed = !!patch.idleCollapsed
  if (Array.isArray(patch.idleOpen)) u.idleOpen = patch.idleOpen.filter((x, i, a): x is string => typeof x === 'string' && a.indexOf(x) === i)
  if (patch.panelOpen !== undefined) u.panelOpen = !!patch.panelOpen
  if (patch.panelTab === 'files' || patch.panelTab === 'commands' || patch.panelTab === 'git') u.panelTab = patch.panelTab
  save()
  return getState()
}
