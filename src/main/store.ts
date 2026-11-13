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
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
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
import { resolveShell } from './pty'
import { readGit } from './git'

interface PersistedGroup {
  id: string
  kind: 'parent' | 'manual'
  name: string
  path?: string
  order: number
  collapsed: boolean
  showHidden: boolean
  /** Lower-cased absolute paths of hidden children (parent groups). */
  hidden: string[]
}

interface Persisted {
  version: number
  folders: Folder[]
  groups: PersistedGroup[]
  commands: Command[]
  snippets: Snippet[]
  selectedId: string | null
  settings: Settings
  ui: UiState
}

const DEFAULT_SETTINGS: Settings = { shell: '', editor: 'zed', terminalFontSize: 15 }
const DEFAULT_UI: UiState = { sidebarWidth: 260, panelWidth: 340, sidebarCollapsed: false, panes: null, panelOpen: false, panelTab: 'files' }

function emptyData(): Persisted {
  return {
    version: SCHEMA_VERSION,
    folders: [],
    groups: [],
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
  const s = (raw.settings ?? {}) as Partial<Settings>
  d.settings = {
    shell: typeof s.shell === 'string' ? s.shell : '',
    editor: typeof s.editor === 'string' && s.editor.trim() ? s.editor.trim() : DEFAULT_SETTINGS.editor,
    terminalFontSize: num(s.terminalFontSize, DEFAULT_SETTINGS.terminalFontSize, 8, 40)
  }
  const u = (raw.ui ?? {}) as Partial<UiState>
  d.ui = {
    sidebarWidth: num(u.sidebarWidth, DEFAULT_UI.sidebarWidth, 180, 600),
    panelWidth: num(u.panelWidth, DEFAULT_UI.panelWidth, 220, 900),
    sidebarCollapsed: !!u.sidebarCollapsed,
    panes: sanitizePersisted(u.panes),
    panelOpen: !!u.panelOpen,
    panelTab: u.panelTab === 'commands' || u.panelTab === 'git' ? u.panelTab : 'files'
  }
  // Drop dangling group references rather than losing the folder.
  const groupIds = new Set(d.groups.map((g) => g.id))
  for (const f of d.folders) if (f.groupId && !groupIds.has(f.groupId)) f.groupId = null
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
      path: g.path ?? null,
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
  return {
    folders: data.folders.map((f) => {
      const missing = !existsSync(f.path)
      const git = missing ? { isGit: false, branch: null } : readGit(f.path)
      return { ...f, missing, isGit: git.isGit, branch: git.branch }
    }),
    groups,
    commands: data.commands,
    snippets: data.snippets,
    selectedId: data.selectedId,
    settings: data.settings,
    ui: data.ui,
    resolvedShell: resolveShell(data.settings.shell)
  }
}

export function getShell(): string {
  return resolveShell(data.settings.shell)
}

export function getEditor(): string {
  return data.settings.editor
}

/** Absolute roots the renderer may browse/open: saved folders and parent-folder group roots. */
export function getRoots(): string[] {
  return [...data.folders.map((f) => f.path), ...data.groups.filter((g) => g.path).map((g) => g.path as string)]
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

function pushManualGroup(name: string): string {
  const g: PersistedGroup = {
    id: randomUUID(),
    kind: 'manual',
    name: name.trim() || 'New group',
    order: data.groups.length,
    collapsed: false,
    showHidden: false,
    hidden: []
  }
  data.groups.push(g)
  return g.id
}

export function addManualGroup(name: string): AppState {
  data.selectedId = pushManualGroup(name)
  save()
  return getState()
}

/** Like addManualGroup, but leaves the selection alone and returns the new id (used by the MCP server). */
export function createManualGroup(name: string): string {
  const id = pushManualGroup(name)
  save()
  return id
}

function fixSelection(): void {
  const s = data.selectedId
  if (!s || s.startsWith('child:')) return
  if (!data.folders.some((f) => f.id === s) && !data.groups.some((g) => g.id === s)) {
    data.selectedId = data.folders[0]?.id ?? data.groups[0]?.id ?? null
  }
}

export function removeFolder(id: string): AppState {
  data.folders = data.folders.filter((f) => f.id !== id)
  data.commands = data.commands.filter((c) => c.ownerId !== id)
  data.snippets = data.snippets.filter((s) => s.scope !== id)
  fixSelection()
  save()
  return getState()
}

export function removeGroup(id: string): AppState {
  data.groups = data.groups.filter((g) => g.id !== id)
  for (const f of data.folders) if (f.groupId === id) f.groupId = null
  data.commands = data.commands.filter((c) => c.ownerId !== id)
  data.snippets = data.snippets.filter((s) => s.scope !== id)
  fixSelection()
  save()
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

function withGroup(id: string, fn: (g: PersistedGroup) => void): AppState {
  const g = data.groups.find((x) => x.id === id)
  if (g) {
    fn(g)
    save()
  }
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
  const s = data.settings
  if (typeof patch.shell === 'string') s.shell = patch.shell
  if (typeof patch.editor === 'string' && patch.editor.trim()) s.editor = patch.editor.trim()
  if (patch.terminalFontSize !== undefined) s.terminalFontSize = num(patch.terminalFontSize, s.terminalFontSize, 8, 40)
  save()
  return getState()
}

export function setUi(patch: Partial<UiState>): AppState {
  const u = data.ui
  if (patch.sidebarWidth !== undefined) u.sidebarWidth = num(patch.sidebarWidth, u.sidebarWidth, 180, 600)
  if (patch.panelWidth !== undefined) u.panelWidth = num(patch.panelWidth, u.panelWidth, 220, 900)
  if (patch.sidebarCollapsed !== undefined) u.sidebarCollapsed = !!patch.sidebarCollapsed
  if (patch.panes !== undefined) u.panes = sanitizePersisted(patch.panes)
  if (patch.panelOpen !== undefined) u.panelOpen = !!patch.panelOpen
  if (patch.panelTab === 'files' || patch.panelTab === 'commands' || patch.panelTab === 'git') u.panelTab = patch.panelTab
  save()
  return getState()
}
