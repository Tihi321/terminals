import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as z from 'zod'
import { parseReportedStatus } from '../shared/agentStatus'
import { HOME_ID, type AppState, type Command, type CommandTarget, type Snippet } from '../shared/types'
import { nestError } from '../shared/groupTree'
import * as store from './store'
import { ToolError } from './toolError'
import type { TerminalControl, WaitMatcher } from './terminalHost'

/**
 * Tool logic of the built-in MCP server. Location resolution and the command/prompt builders are pure functions
 * over an AppState; the tool `run` functions apply the result through the store (never by editing terminals.json).
 */

export type LocKind = 'folder' | 'child' | 'parent' | 'manual' | 'home' | 'worktree'

/** Anything a terminal can belong to: a saved folder, a parent group's subfolder, or a group. */
export interface McpLoc {
  id: string
  name: string
  /** Null for manual groups (no directory of their own). */
  path: string | null
  kind: LocKind
  /** Group the location belongs to (manual group members and parent-group children). */
  groupId: string | null
  missing: boolean
}

/** An error the caller can fix; its message is returned to the client as the tool result. */
export { ToolError }

export interface ToolContext {
  /** Value of the X-Terminals-Location header (the terminal's TERMINALS_LOC_ID), if any. */
  headerLocation?: string
  /** Value of the X-Terminals-Term header (the terminal's TERMINALS_TERM_ID), if any. */
  headerTerm?: string
  dataDir: string
  /** Null when the server runs without a terminal host (logic tests). */
  terminals: TerminalControl | null
  /** settings.allowMcpRun, read per call. */
  allowRun: () => boolean
}

export const RUN_DISABLED_ERROR =
  'Terminal control is off. Ask the user to turn on Settings > MCP > "Allow MCP to run commands" in the Terminals app.'

const KIND_LABEL: Record<LocKind, string> = {
  folder: 'saved folder',
  child: 'subfolder of a parent folder group',
  parent: 'parent folder group',
  manual: 'manual group',
  home: 'Home location',
  worktree: 'git worktree of a saved folder'
}

const HOW_TO =
  'Pass `location` as a location id or absolute path from list_locations, or a unique folder/group name.'

/** Folders first, then groups, then parent-group children, so a path that is both a saved folder and a child resolves to the folder. */
export function buildLocations(state: AppState): McpLoc[] {
  const out: McpLoc[] = state.folders.map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path,
    kind: 'folder',
    groupId: f.groupId,
    missing: f.missing
  }))
  for (const g of state.groups) out.push({ id: g.id, name: g.name, path: g.path, kind: g.kind, groupId: null, missing: g.missing })
  for (const g of state.groups)
    for (const c of g.children) out.push({ id: c.id, name: c.name, path: c.path, kind: 'child', groupId: g.id, missing: false })
  // Linked git worktrees of saved folders and parent-group children; they belong to their repo row's group.
  for (const f of state.folders)
    for (const w of f.worktrees) out.push({ id: w.id, name: w.name, path: w.path, kind: 'worktree', groupId: f.groupId, missing: w.missing })
  for (const g of state.groups)
    for (const c of g.children)
      for (const w of c.worktrees) out.push({ id: w.id, name: w.name, path: w.path, kind: 'worktree', groupId: g.id, missing: w.missing })
  // Last, so a saved folder at the same path wins.
  out.push({ id: HOME_ID, name: state.home.name, path: state.home.path, kind: 'home', groupId: null, missing: state.home.missing })
  return out
}

/** What list_locations returns. Worktrees are listed under their repo row (`repoId`). */
export function locationsPayload(state: AppState) {
  const wt = (repoId: string, w: { id: string; name: string; path: string; branch: string | null; missing: boolean }) => ({
    kind: 'worktree' as const,
    id: w.id,
    name: w.name,
    path: w.path,
    branch: w.branch,
    repoId,
    missing: w.missing
  })
  return {
    groups: state.groups.map((g) =>
      g.kind === 'manual'
        ? { id: g.id, kind: g.kind, name: g.name, parentId: g.parentId, folderIds: state.folders.filter((f) => f.groupId === g.id).map((f) => f.id) }
        : {
            id: g.id,
            kind: g.kind,
            name: g.name,
            parentId: g.parentId,
            path: g.path,
            missing: g.missing,
            children: g.children.map((c) => ({ id: c.id, name: c.name, path: c.path, hidden: c.hidden }))
          }
    ),
    folders: state.folders.map((f) => ({ id: f.id, name: f.name, path: f.path, groupId: f.groupId, missing: f.missing })),
    worktrees: [
      ...state.folders.flatMap((f) => f.worktrees.map((w) => wt(f.id, w))),
      ...state.groups.flatMap((g) => g.children.flatMap((c) => c.worktrees.map((w) => wt(c.id, w))))
    ],
    home: { id: state.home.id, name: state.home.name, path: state.home.path, missing: state.home.missing }
  }
}

export function locationById(state: AppState, id: string): McpLoc | null {
  return buildLocations(state).find((l) => l.id === id) ?? null
}

/** Absolute and, on Windows, drive- or UNC-qualified (`\foo` would silently land on the current drive). */
export function isAbs(p: string): boolean {
  return isAbsolute(p) && (process.platform !== 'win32' || /^([a-zA-Z]:[\\/]|\\\\[^\\])/.test(p))
}

function kindsLabel(kinds?: LocKind[]): string {
  return kinds ? kinds.map((k) => KIND_LABEL[k]).join(' or ') : 'location'
}

function wrongKind(ref: string, loc: McpLoc, kinds?: LocKind[]): ToolError {
  return new ToolError(`"${ref}" is a ${KIND_LABEL[loc.kind]} (${loc.id}), expected a ${kindsLabel(kinds)}`)
}

/** Resolves a location id, absolute path or unique case-insensitive name. Unknown paths are an error (never auto-added). */
export function findLocation(state: AppState, ref: string, kinds?: LocKind[]): McpLoc {
  const r = ref.trim()
  if (!r) throw new ToolError(`Empty location. ${HOW_TO}`)
  const all = buildLocations(state)
  const ok = (l: McpLoc): boolean => !kinds || kinds.includes(l.kind)
  const byId = all.find((l) => l.id === r)
  if (byId) {
    if (ok(byId)) return byId
    throw wrongKind(r, byId, kinds)
  }
  if (isAbs(r)) {
    const key = store.norm(r)
    const matches = all.filter((l) => l.path && store.norm(l.path) === key)
    const hit = matches.find(ok)
    if (hit) return hit
    if (matches[0]) throw wrongKind(r, matches[0], kinds)
    throw new ToolError(
      `${r} is not a saved folder, a parent folder group or a subfolder of one. Add it with add_folders or add_parent_group first, or see list_locations.`
    )
  }
  const lower = r.toLowerCase()
  const named = all.filter((l) => l.name.toLowerCase() === lower)
  const byName = named.filter(ok)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1)
    throw new ToolError(
      `"${r}" matches ${byName.length} locations: ${byName.map((l) => `${l.id} (${l.path ?? KIND_LABEL[l.kind]})`).join(', ')}. Use the id or path.`
    )
  if (named[0]) throw wrongKind(r, named[0], kinds)
  throw new ToolError(`No ${kindsLabel(kinds)} is called "${r}". ${HOW_TO}`)
}

/** The explicit `location` argument when given, else the terminal's location from the X-Terminals-Location header. */
export function contextLocation(state: AppState, ref: string | undefined, header: string | undefined, kinds?: LocKind[]): McpLoc {
  if (ref !== undefined && ref.trim()) return findLocation(state, ref, kinds)
  const h = header?.trim()
  if (!h)
    throw new ToolError(
      `No location given, and this request has no X-Terminals-Location header (it is sent from TERMINALS_LOC_ID inside the app's terminals). ${HOW_TO}`
    )
  const loc = locationById(state, h)
  if (!loc) throw new ToolError(`This terminal's location ${h} no longer exists in the app. ${HOW_TO}`)
  if (kinds && !kinds.includes(loc.kind)) throw wrongKind(h, loc, kinds)
  return loc
}

/**
 * Where open_terminal starts. undefined/'' -> Home. A saved location -> its path (a manual group has none: error).
 * An unsaved existing absolute directory -> Home with that cwd. A non-existent path -> error. Home missing -> error.
 */
export function resolveOpenTarget(state: AppState, ref: string | undefined): { loc: McpLoc; cwd: string } {
  const home = buildLocations(state).find((l) => l.id === HOME_ID) as McpLoc
  const useHome = (cwd: string): { loc: McpLoc; cwd: string } => {
    if (home.missing) throw new ToolError(`The Home folder ${home.path} does not exist. Ask the user to change it in Settings.`)
    return { loc: home, cwd }
  }
  const r = (ref ?? '').trim()
  if (!r) return useHome(home.path as string)
  let loc: McpLoc | null = null
  if (isAbs(r)) {
    const key = store.norm(r)
    loc = buildLocations(state).find((l) => l.path && store.norm(l.path) === key) ?? null
    if (!loc) {
      const abs = resolve(r)
      if (!isDir(abs)) throw new ToolError(`${r} does not exist or is not a directory`)
      return useHome(abs)
    }
  } else loc = findLocation(state, r)
  if (!loc.path) throw new ToolError(`${loc.name} (${loc.id}) is a manual group with no directory of its own; pick a folder in it`)
  if (loc.kind === 'home') return useHome(loc.path)
  if (loc.missing || !isDir(loc.path)) throw new ToolError(`${loc.path} does not exist`)
  return { loc, cwd: loc.path }
}

export function requireName(v: string | undefined, what: string): string {
  const n = (v ?? '').trim()
  if (!n) throw new ToolError(`${what} must not be empty`)
  return n
}

/** One step per line, like the command editor; blank lines dropped. */
export function cleanSteps(steps: string[], where: string): string[] {
  const out = steps
    .flatMap((s) => s.split(/\r?\n/))
    .map((s) => s.trim())
    .filter(Boolean)
  if (out.length === 0) throw new ToolError(`${where} needs at least one non-empty step`)
  return out
}

export function absPath(p: string, what: string): string {
  const t = p.trim()
  if (!isAbs(t)) throw new ToolError(`${what} must be an absolute path (got "${p}")`)
  return resolve(t)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export interface SaveCommandArgs {
  id?: string
  name?: string
  mode?: 'parallel' | 'sequential'
  location?: string
  scope?: 'location' | 'group' | 'global'
  steps?: string[]
  targets?: CommandTarget[]
}

/** Builds the command save_command stores, validated against the current state. Pure apart from existence checks for warnings. */
export function planCommand(
  state: AppState,
  a: SaveCommandArgs,
  header: string | undefined
): { command: Command; created: boolean; warnings: string[] } {
  const existing = a.id !== undefined ? state.commands.find((c) => c.id === a.id) : undefined
  if (a.id !== undefined && !existing) throw new ToolError(`Unknown command id ${a.id}. Omit id to create a new command.`)
  if (a.targets && a.steps) throw new ToolError('Pass either `steps` or `targets`, not both')
  const toGlobal = a.scope === 'global'
  const needLoc = !toGlobal && (!existing || a.location !== undefined || a.scope !== undefined)
  const loc = needLoc ? contextLocation(state, a.location, header) : null

  let ownerId = existing?.ownerId ?? ''
  if (toGlobal) ownerId = 'global'
  else if (loc) {
    if (a.scope === 'group' && loc.kind !== 'parent' && loc.kind !== 'manual') {
      if (!loc.groupId) throw new ToolError(`${loc.name} (${loc.id}) is not in a group; use scope "location"`)
      ownerId = loc.groupId
    } else ownerId = loc.id
  }
  const isGlobal = ownerId === 'global'

  const name = existing && a.name === undefined ? existing.name : requireName(a.name, 'Command name')
  const mode = a.mode ?? existing?.mode ?? 'sequential'

  let targets: CommandTarget[]
  if (a.targets) {
    if (a.targets.length === 0) throw new ToolError('`targets` must contain at least one target')
    targets = a.targets.map((t, i) => ({
      // Global commands may leave the first target's cwd empty: it runs in whichever folder is selected.
      cwd: isGlobal && i === 0 && t.cwd.trim() === '' ? '' : absPath(t.cwd, `targets[${i}].cwd`),
      steps: cleanSteps(t.steps, `targets[${i}]`)
    }))
  } else if (a.steps) {
    const steps = cleanSteps(a.steps, 'The command')
    let cwd: string
    if (isGlobal) {
      if (existing && a.location === undefined && existing.targets.length !== 1)
        throw new ToolError(`Command ${existing.id} has ${existing.targets.length} targets; pass \`targets\` to change its steps`)
      cwd = ''
    } else if (existing && a.location === undefined) {
      if (existing.targets.length !== 1)
        throw new ToolError(`Command ${existing.id} has ${existing.targets.length} targets; pass \`targets\` to change its steps`)
      cwd = existing.targets[0].cwd
    } else {
      const at = loc ?? contextLocation(state, a.location, header)
      if (!at.path) throw new ToolError(`${at.name} is a manual group with no directory of its own; pass \`targets\` with an explicit cwd`)
      cwd = at.path
    }
    targets = [{ cwd, steps }]
  } else if (existing) {
    targets = existing.targets.map((t) => ({ cwd: t.cwd, steps: [...t.steps] }))
    if (isGlobal) {
      if (targets.length > 0) targets[0].cwd = ''
    } else if (targets.some((t) => !t.cwd)) {
      // Moving a global command onto a location: '' targets follow that location's folder.
      const at = loc ?? contextLocation(state, a.location, header)
      if (!at.path) throw new ToolError(`${at.name} is a manual group with no directory of its own; pass \`targets\` with an explicit cwd`)
      for (const t of targets) if (!t.cwd) t.cwd = at.path
    }
  } else {
    throw new ToolError('Pass `steps` (run in the location\'s folder) or `targets` ([{ cwd, steps }])')
  }

  const warnings = targets.filter((t) => t.cwd && !isDir(t.cwd)).map((t) => `cwd does not exist (yet): ${t.cwd}`)
  return { command: { id: existing?.id ?? randomUUID(), name, ownerId, mode, targets }, created: !existing, warnings }
}

/** Commands visible at a location: its own, its group's and global ones, each tagged with scopeKind. */
export function visibleCommands(
  state: AppState,
  loc: { id: string; groupId?: string | null }
): (Command & { inherited: boolean; scopeKind: 'location' | 'group' | 'global' })[] {
  const own = state.commands.filter((c) => c.ownerId === loc.id).map((c) => ({ ...c, inherited: false, scopeKind: 'location' as const }))
  const inherited = loc.groupId
    ? state.commands.filter((c) => c.ownerId === loc.groupId).map((c) => ({ ...c, inherited: true, scopeKind: 'group' as const }))
    : []
  const global = state.commands.filter((c) => c.ownerId === 'global').map((c) => ({ ...c, inherited: true, scopeKind: 'global' as const }))
  return [...own, ...inherited, ...global]
}

export interface SavePromptArgs {
  id?: string
  name?: string
  body?: string
  scope?: string
}

/** Builds the prompt (snippet) save_prompt stores. Scope: 'global', a location reference, or by default this terminal's location. */
export function planPrompt(state: AppState, a: SavePromptArgs, header: string | undefined): { prompt: Snippet; created: boolean } {
  const existing = a.id !== undefined ? state.snippets.find((s) => s.id === a.id) : undefined
  if (a.id !== undefined && !existing) throw new ToolError(`Unknown prompt id ${a.id}. Omit id to create a new prompt.`)
  const name = existing && a.name === undefined ? existing.name : requireName(a.name, 'Prompt name')
  let body: string
  if (existing && a.body === undefined) body = existing.body
  else {
    body = a.body ?? ''
    if (!body.trim()) throw new ToolError('Prompt body must not be empty')
  }
  let scope: string
  if (a.scope !== undefined && a.scope.trim().toLowerCase() === 'global') scope = 'global'
  else if (a.scope !== undefined || !existing) scope = contextLocation(state, a.scope, header).id
  else scope = existing.scope
  return {
    prompt: { id: existing?.id ?? randomUUID(), name, body, scope, ...(existing?.kind ? { kind: existing.kind } : {}) },
    created: !existing
  }
}

type PathResult =
  | { path: string; status: 'added' | 'moved' | 'unchanged'; id: string; previousGroupId?: string | null }
  | { path: string; status: 'skipped'; reason: string; id?: string }

/**
 * Adds directories that are not saved yet (into `groupId`, or standalone). Already saved folders are moved into the
 * group when `moveExisting`, else reported as skipped. Leaves the UI selection alone.
 */
function addOrMove(paths: string[], groupId: string | null, moveExisting: boolean): PathResult[] {
  const folders = store.getState().folders
  const out: (PathResult | null)[] = []
  const seen = new Set<string>()
  const pending: { index: number; path: string }[] = []
  const skip = (path: string, reason: string, id?: string): void => void out.push({ path, status: 'skipped', reason, ...(id ? { id } : {}) })
  for (const [index, raw] of paths.entries()) {
    const p = raw.trim()
    if (!isAbs(p)) {
      skip(raw, 'not an absolute path')
      continue
    }
    const abs = resolve(p)
    const key = store.norm(abs)
    if (seen.has(key)) {
      skip(raw, 'listed twice')
      continue
    }
    seen.add(key)
    if (!existsSync(abs)) skip(raw, 'does not exist')
    else if (!isDir(abs)) skip(raw, 'not a directory')
    else {
      const saved = folders.find((f) => store.norm(f.path) === key)
      if (!saved) {
        out.push(null)
        pending.push({ index, path: abs })
      } else if (!moveExisting) skip(raw, 'already saved (use move_folder to change its group)', saved.id)
      else if (saved.groupId === groupId) out.push({ path: raw, status: 'unchanged', id: saved.id })
      else {
        store.moveFolder(saved.id, groupId)
        out.push({ path: raw, status: 'moved', id: saved.id, previousGroupId: saved.groupId })
      }
    }
  }
  const created = store.createFolders(
    pending.map((x) => x.path),
    groupId
  )
  for (const x of pending) {
    const f = created.find((c) => store.norm(c.path) === store.norm(x.path))
    out[x.index] = f
      ? { path: paths[x.index], status: 'added', id: f.id }
      : { path: paths[x.index], status: 'skipped', reason: 'could not be added' }
  }
  return out as PathResult[]
}

function describe(state: AppState, loc: McpLoc): Record<string, unknown> {
  const g = loc.groupId ? state.groups.find((x) => x.id === loc.groupId) : undefined
  return {
    id: loc.id,
    name: loc.name,
    path: loc.path,
    kind: loc.kind,
    missing: loc.missing,
    group: g ? { id: g.id, name: g.name, kind: g.kind } : null
  }
}

export interface ToolDef {
  name: string
  description: string
  shape: z.ZodRawShape
  /** Mutating tools push the new state to the renderer. */
  mutates: boolean
  destructive?: boolean
  /** readOnlyHint annotation; defaults to !mutates. */
  readOnly?: boolean
  run: (args: Record<string, unknown>, ctx: ToolContext) => unknown | Promise<unknown>
}

function defineTool<S extends z.ZodRawShape>(
  def: Omit<ToolDef, 'shape' | 'run'> & { shape: S; run: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => unknown | Promise<unknown> }
): ToolDef {
  return def as unknown as ToolDef
}

const locationArg = z
  .string()
  .optional()
  .describe("Location id, absolute path or unique name. Default: this terminal's location.")
const groupRef = (what: string): z.ZodString => z.string().describe(`${what}: group id or unique group name`)
const folderRef = z.string().describe('Saved folder: id, absolute path or unique name')
/** wait_for_output limits. A JS regex has no timeout, so these only bound the damage (see README). */
export const MAX_PATTERN_LEN = 256
export const MAX_PATTERNS = 8
/** A regex matcher tests only this many leading characters of a line. */
export const MAX_TEST_LINE = 2000

/** Compiles the `pattern` / `patterns` arguments of wait_for_output into matchers (case-insensitive with ignoreCase). */
export function compileWaitPatterns(a: { pattern?: string; patterns?: string[]; regex?: boolean; ignoreCase?: boolean }): WaitMatcher[] {
  if ((a.pattern === undefined) === (a.patterns === undefined)) throw new ToolError('Give exactly one of `pattern` or `patterns`.')
  const sources = a.pattern !== undefined ? [a.pattern] : (a.patterns as string[])
  if (sources.length === 0) throw new ToolError('`patterns` is empty.')
  if (sources.length > MAX_PATTERNS) throw new ToolError(`Too many patterns (max ${MAX_PATTERNS}).`)
  return sources.map((src): WaitMatcher => {
    if (!src) throw new ToolError('A pattern is empty.')
    if (src.length > MAX_PATTERN_LEN) throw new ToolError(`A pattern is too long (max ${MAX_PATTERN_LEN} characters).`)
    if (a.regex === true) {
      let re: RegExp
      try {
        re = new RegExp(src, a.ignoreCase === true ? 'i' : '')
      } catch (e) {
        throw new ToolError(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`)
      }
      return { source: src, test: (line) => re.test(line.length > MAX_TEST_LINE ? line.slice(0, MAX_TEST_LINE) : line) }
    }
    if (a.ignoreCase === true) {
      const low = src.toLowerCase()
      return { source: src, test: (line) => line.toLowerCase().includes(low) }
    }
    return { source: src, test: (line) => line.includes(src) }
  })
}

/** Gate for the terminal tools: the toggle first, then the host. */
function terminalsOrThrow(ctx: ToolContext): TerminalControl {
  if (!ctx.allowRun()) throw new ToolError(RUN_DISABLED_ERROR)
  if (!ctx.terminals) throw new ToolError('Terminal control is not available in this process.')
  return ctx.terminals
}
const termId = z.string().describe('Terminal id from open_terminal or list_terminals')

const stepsArg = z.array(z.string()).describe('Shell commands run in order, stopping at the first failure')

export const TOOLS: ToolDef[] = [
  defineTool({
    name: 'get_context',
    description: "This terminal's location in the app (id, name, path, kind, group) and the app's data directory.",
    shape: {},
    mutates: false,
    run: (_a, ctx) => {
      const state = store.getState()
      const h = ctx.headerLocation?.trim()
      const loc = h ? locationById(state, h) : null
      return {
        location: loc ? describe(state, loc) : null,
        ...(loc
          ? {}
          : {
              note: h
                ? `Location ${h} no longer exists.`
                : 'No X-Terminals-Location header: not called from one of the app\'s terminals, or the MCP client does not send it.'
            }),
        dataDir: ctx.dataDir,
        storeFile: join(ctx.dataDir, 'terminals.json')
      }
    }
  }),
  defineTool({
    name: 'list_locations',
    description:
      'All groups (manual and parent folder groups with their discovered subfolders), saved folders and their git worktrees (with branch and `repoId`), with ids, names, paths and group membership. Groups nest through `parentId` (null = top level); only manual groups can contain groups.',
    shape: {},
    mutates: false,
    run: () => locationsPayload(store.getState())
  }),
  defineTool({
    name: 'list_commands',
    description:
      "Saved commands visible at a location: its own, those inherited from its group (inherited: true) and global ones (scopeKind 'global'; their first target has cwd '' = the folder selected at run time).",
    shape: { location: locationArg },
    mutates: false,
    run: (a, ctx) => {
      const s = store.getState()
      const loc = contextLocation(s, a.location, ctx.headerLocation)
      return { location: { id: loc.id, name: loc.name }, commands: visibleCommands(s, loc) }
    }
  }),
  defineTool({
    name: 'save_command',
    description:
      'Create (no id) or update (id) a saved command. Give `steps` to run them in the location\'s folder, or `targets` for several folders. With scope "global" the command is available in every folder and `steps` run in whichever folder is selected when it is run (cwd ""). Omitted fields keep their value on update. Does not run anything.',
    shape: {
      id: z.string().optional().describe('Existing command id to update'),
      name: z.string().optional().describe('Required when creating'),
      mode: z.enum(['parallel', 'sequential']).optional().describe('How targets run. Default sequential (kept when updating)'),
      location: locationArg,
      scope: z
        .enum(['location', 'group', 'global'])
        .optional()
        .describe('Save on the location itself (default), on its group so every folder in the group sees it, or globally for every folder'),
      steps: stepsArg.optional(),
      targets: z
        .array(z.object({ cwd: z.string().describe('Absolute directory ("" for the first target of a global command: the selected folder)'), steps: stepsArg }))
        .optional()
        .describe('One entry per folder')
    },
    mutates: true,
    run: (a, ctx) => {
      const { command, created, warnings } = planCommand(store.getState(), a, ctx.headerLocation)
      store.saveCommand(command)
      return { id: command.id, created, ownerId: command.ownerId, name: command.name, mode: command.mode, targets: command.targets, ...(warnings.length ? { warnings } : {}) }
    }
  }),
  defineTool({
    name: 'delete_command',
    description: 'Delete a saved command by id.',
    shape: { id: z.string().describe('Command id') },
    mutates: true,
    destructive: true,
    run: (a) => {
      const c = store.getState().commands.find((x) => x.id === a.id)
      if (!c) throw new ToolError(`Unknown command id ${a.id}`)
      store.deleteCommand(c.id)
      return { deleted: c.id, name: c.name }
    }
  }),
  defineTool({
    name: 'list_prompts',
    description: "Saved prompts visible at a location: global ones, the location's own and its group's.",
    shape: { location: locationArg },
    mutates: false,
    run: (a, ctx) => {
      const s = store.getState()
      const loc = contextLocation(s, a.location, ctx.headerLocation)
      const prompts = s.snippets
        .filter((p) => p.kind !== 'shell')
        .filter((p) => p.scope === 'global' || p.scope === loc.id || (!!loc.groupId && p.scope === loc.groupId))
        .map((p) => ({ ...p, scopeKind: p.scope === 'global' ? 'global' : p.scope === loc.id ? 'location' : 'group' }))
      return { location: { id: loc.id, name: loc.name }, prompts }
    }
  }),
  defineTool({
    name: 'save_prompt',
    description: 'Create (no id) or update (id) a saved prompt. Omitted fields keep their value on update.',
    shape: {
      id: z.string().optional().describe('Existing prompt id to update'),
      name: z.string().optional().describe('Required when creating'),
      body: z.string().optional().describe('Prompt text. Required when creating'),
      scope: z
        .string()
        .optional()
        .describe("'global', or a location id, path or name. Default when creating: this terminal's location")
    },
    mutates: true,
    run: (a, ctx) => {
      const { prompt, created } = planPrompt(store.getState(), a, ctx.headerLocation)
      store.saveSnippet(prompt)
      return { id: prompt.id, created, name: prompt.name, scope: prompt.scope }
    }
  }),
  defineTool({
    name: 'delete_prompt',
    description: 'Delete a saved prompt by id.',
    shape: { id: z.string().describe('Prompt id') },
    mutates: true,
    destructive: true,
    run: (a) => {
      const p = store.getState().snippets.find((x) => x.id === a.id)
      if (!p) throw new ToolError(`Unknown prompt id ${a.id}`)
      store.deleteSnippet(p.id)
      return { deleted: p.id, name: p.name }
    }
  }),
  defineTool({
    name: 'create_group',
    description:
      'Create a manual group, optionally inside another manual group (`parent`). `folders`: absolute paths; unsaved ones are added to the group, saved ones are moved into it. Reports what happened per path.',
    shape: {
      name: z.string().describe('Group name'),
      parent: groupRef('Parent manual group').optional(),
      folders: z.array(z.string()).optional().describe('Absolute folder paths')
    },
    mutates: true,
    run: (a) => {
      const name = requireName(a.name, 'Group name')
      const parentId = a.parent !== undefined ? findLocation(store.getState(), a.parent, ['manual']).id : null
      const id = store.createManualGroup(name, parentId)
      return { groupId: id, name, parentId, folders: addOrMove(a.folders ?? [], id, true) }
    }
  }),
  defineTool({
    name: 'add_parent_group',
    description: 'Add a parent folder group: a directory whose immediate subfolders are listed automatically.',
    shape: { path: z.string().describe('Absolute directory path') },
    mutates: true,
    run: (a) => {
      const p = absPath(a.path, 'path')
      if (!isDir(p)) throw new ToolError(`${p} does not exist or is not a directory`)
      const r = store.createParentGroup(p)
      const g = store.getState().groups.find((x) => x.id === r.id)
      return { groupId: r.id, existed: r.existed, name: g?.name, children: g?.children.length ?? 0 }
    }
  }),
  defineTool({
    name: 'rename_group',
    description: 'Rename a group.',
    shape: { group: groupRef('Group'), name: z.string().describe('New name') },
    mutates: true,
    run: (a) => {
      const g = findLocation(store.getState(), a.group, ['manual', 'parent'])
      const name = requireName(a.name, 'Group name')
      store.renameGroup(g.id, name)
      return { id: g.id, name }
    }
  }),
  defineTool({
    name: 'delete_group',
    description:
      "Removes the group, all its subgroups at any depth and every folder in them from the app. Also deletes their commands and prompts (including those on a removed parent group's subfolders) and closes their terminals. Nothing on disk is deleted.",
    shape: { group: groupRef('Group') },
    mutates: true,
    destructive: true,
    run: (a) => {
      const g = findLocation(store.getState(), a.group, ['manual', 'parent'])
      const summary = store.deleteGroup(g.id)
      return {
        deleted: g.id,
        name: g.name,
        kind: g.kind,
        groupsDeleted: summary.groupIds.slice(1),
        foldersDeleted: summary.folderIds,
        commandsDeleted: summary.commands,
        promptsDeleted: summary.prompts
      }
    }
  }),
  defineTool({
    name: 'move_group',
    description: 'Move a group under a manual group, or to the top level when `parent` is omitted. Only manual groups can contain groups.',
    shape: {
      group: groupRef('Group to move'),
      parent: groupRef('Target manual group; omit to move to the top level').optional()
    },
    mutates: true,
    run: (a) => {
      const s = store.getState()
      const g = findLocation(s, a.group, ['manual', 'parent'])
      const parentId = a.parent !== undefined ? findLocation(s, a.parent, ['manual']).id : null
      const err = nestError(s.groups, g.id, parentId)
      if (err) throw new ToolError(err)
      store.moveGroup(g.id, parentId)
      return { id: g.id, name: g.name, parentId }
    }
  }),
  defineTool({
    name: 'add_folders',
    description:
      'Save directories as folders, optionally into a manual group. Already saved folders are skipped (use move_folder). Reports what happened per path.',
    shape: {
      paths: z.array(z.string()).min(1).describe('Absolute folder paths'),
      group: groupRef('Manual group to add them to').optional()
    },
    mutates: true,
    run: (a) => {
      const groupId = a.group !== undefined ? findLocation(store.getState(), a.group, ['manual']).id : null
      return { groupId, folders: addOrMove(a.paths, groupId, false) }
    }
  }),
  defineTool({
    name: 'move_folder',
    description: 'Move a saved folder into a manual group, or out of its group with group: null.',
    shape: {
      folder: folderRef,
      group: z.string().nullable().describe('Manual group id or unique name, or null to make it standalone')
    },
    mutates: true,
    run: (a) => {
      const s = store.getState()
      const f = findLocation(s, a.folder, ['folder'])
      const groupId = a.group === null ? null : findLocation(s, a.group, ['manual']).id
      store.moveFolder(f.id, groupId)
      return { id: f.id, groupId, previousGroupId: f.groupId }
    }
  }),
  defineTool({
    name: 'rename_folder',
    description: 'Rename a saved folder (display name only; nothing on disk changes).',
    shape: { folder: folderRef, name: z.string().describe('New name') },
    mutates: true,
    run: (a) => {
      const f = findLocation(store.getState(), a.folder, ['folder'])
      const name = requireName(a.name, 'Folder name')
      store.renameFolder(f.id, name)
      return { id: f.id, name }
    }
  }),
  defineTool({
    name: 'remove_folder',
    description:
      'Remove a saved folder from the app. Also deletes the commands and prompts saved on it and closes its terminals. Nothing on disk is deleted.',
    shape: { folder: folderRef },
    mutates: true,
    destructive: true,
    run: (a) => {
      const s = store.getState()
      const f = findLocation(s, a.folder, ['folder'])
      const commands = s.commands.filter((c) => c.ownerId === f.id).length
      const prompts = s.snippets.filter((p) => p.scope === f.id).length
      store.removeFolder(f.id)
      return { deleted: f.id, name: f.name, path: f.path, commandsDeleted: commands, promptsDeleted: prompts }
    }
  }),
  defineTool({
    name: 'open_terminal',
    description:
      'Open a visible PowerShell tab in the app and return its id. By default in the background (no focus or selection change); with reveal: true the window is shown and focused, the location selected and the tab activated. Needs "Allow MCP to run commands" in the app settings. Never elevated.',
    shape: {
      location: z
        .string()
        .optional()
        .describe(
          'Location id, name or absolute path. A saved location opens there; any other existing directory opens under Home with that cwd. Default: Home.'
        ),
      reveal: z.boolean().optional().describe('Show and focus the window, select the location and activate the new tab. Default false')
    },
    mutates: false,
    readOnly: false,
    run: async (a, ctx) => {
      const terminals = terminalsOrThrow(ctx)
      const { loc, cwd } = resolveOpenTarget(store.getState(), a.location)
      const t = await terminals.open({ locId: loc.id, cwd, reveal: a.reveal === true })
      return { id: t.id, location: { id: loc.id, name: loc.name, kind: loc.kind }, cwd: t.cwd, shell: t.shell, agent: true }
    }
  }),
  defineTool({
    name: 'run_command',
    description:
      'Run a command in a terminal opened with open_terminal, in its live PowerShell (cd and variables persist between calls). Returns the output (ANSI-stripped, without the echoed input or prompt), the exit code and a runId. One run at a time per terminal. On timeout the partial output is returned with timedOut: true and the shell keeps running (the terminal stays busy until the command ends): collect the final result with get_run_result using the returned runId, watch it with read_terminal, or send_input "\\u0003" to interrupt. Only for terminals opened through MCP.',
    shape: {
      id: termId,
      command: z.string().describe('PowerShell command or script text'),
      timeoutSeconds: z.number().int().min(1).max(600).optional().describe('Default 60')
    },
    mutates: false,
    readOnly: false,
    run: async (a, ctx) => {
      const terminals = terminalsOrThrow(ctx)
      return terminals.run(a.id, a.command, (a.timeoutSeconds ?? 60) * 1000)
    }
  }),
  defineTool({
    name: 'send_input',
    description:
      'Type raw text into a terminal opened with open_terminal (for prompts, interactive programs, Ctrl+C as "\\u0003"). With enter: true a carriage return is appended. Only for terminals opened through MCP.',
    shape: {
      id: termId,
      text: z.string().describe('Text to type, written raw'),
      enter: z.boolean().optional().describe('Append Enter (CR)')
    },
    mutates: false,
    readOnly: false,
    run: (a, ctx) => {
      const terminals = terminalsOrThrow(ctx)
      terminals.send(a.id, a.enter ? a.text + '\r' : a.text)
      return { id: a.id, sent: a.text.length }
    }
  }),
  defineTool({
    name: 'get_run_result',
    description:
      'Result of a run_command that returned timedOut: true. state running|done; with waitSeconds waits for the end. Needs "Allow MCP to run commands".',
    shape: {
      id: termId,
      runId: z.string().min(1).describe('runId returned by run_command'),
      waitSeconds: z.number().int().min(0).max(600).optional().describe('Wait up to this long for a run that is still going. Default 0 (just look)')
    },
    mutates: false,
    readOnly: true,
    run: (a, ctx) => terminalsOrThrow(ctx).runResult(a.id, a.runId, (a.waitSeconds ?? 0) * 1000)
  }),
  defineTool({
    name: 'read_terminal',
    description:
      "Recent output of any terminal (including the user's own tabs), as ANSI-stripped lines from the raw stream. For full-screen programs (editors, TUIs) use screen: true, which returns the visible screen as rendered, also while the window is hidden. Needs \"Allow MCP to run commands\" because output can hold secrets.",
    shape: {
      id: termId,
      lines: z.number().int().min(1).max(2000).optional().describe('Last N lines. Default 100'),
      screen: z
        .boolean()
        .optional()
        .describe('Return the visible screen as rendered (rows x cols) instead of the last lines of the stream. lines is ignored')
    },
    mutates: false,
    readOnly: true,
    run: (a, ctx) => {
      const terminals = terminalsOrThrow(ctx)
      return a.screen === true ? terminals.screen(a.id) : terminals.read(a.id, a.lines ?? 100)
    }
  }),
  defineTool({
    name: 'wait_for_output',
    description:
      "Waits until a line of a terminal's output (any terminal, ANSI-stripped, including the unfinished last line) contains `pattern` (plain substring, case-sensitive unless ignoreCase) or matches it (regex: true), or until the timeout or the terminal's exit. Give `patterns` (up to 8) instead of `pattern` to wait for any of several: the result says which one matched. Patterns are at most 256 characters, a regex tests only the first 2000 characters of a line, and at most 4 waits can be pending per terminal. By default only output arriving after the call counts; fromNow: false also searches the buffered output. Returns { matched, line, patternIndex, pattern, timedOut, exited, tail (last 20 lines) }. Needs \"Allow MCP to run commands\".",
    shape: {
      id: termId,
      pattern: z.string().min(1).optional().describe('Text to find in a line (use this or patterns)'),
      patterns: z.array(z.string().min(1)).min(1).max(8).optional().describe('Several texts; the first line matching any of them wins'),
      regex: z.boolean().optional().describe('Treat the pattern(s) as JavaScript regular expressions. Default false'),
      ignoreCase: z.boolean().optional().describe('Case-insensitive match. Default false'),
      timeoutSeconds: z.number().int().min(1).max(600).optional().describe('Default 30'),
      fromNow: z.boolean().optional().describe('Only output arriving after this call (default true); false also searches the current buffer')
    },
    mutates: false,
    readOnly: true,
    run: async (a, ctx) => {
      const terminals = terminalsOrThrow(ctx)
      const matchers = compileWaitPatterns({ pattern: a.pattern, patterns: a.patterns, regex: a.regex, ignoreCase: a.ignoreCase })
      return terminals.waitFor(a.id, matchers, (a.timeoutSeconds ?? 30) * 1000, a.fromNow !== false)
    }
  }),
  defineTool({
    name: 'list_terminals',
    description:
      "All terminals (the user's and those opened through MCP) with id, location, cwd, shell, alive, busy and agent status (null for a plain shell). allowRun tells whether terminal control is on; if not, ask the user to enable \"Allow MCP to run commands\".",
    shape: {},
    mutates: false,
    readOnly: true,
    run: (_a, ctx) => {
      const s = store.getState()
      const terminals = (ctx.terminals?.list() ?? []).map((t) => ({ ...t, locationName: locationById(s, t.locationId)?.name ?? null }))
      return { allowRun: ctx.allowRun(), terminals }
    }
  }),
  defineTool({
    name: 'report_status',
    description:
      "Sets the agent status shown on this terminal's tab in the app: working, done (finished, the user has not looked yet), needs-you (blocked on the user) or idle. The terminal is this one (X-Terminals-Term header) unless `terminal` is given. Only sets tab metadata; not gated by \"Allow MCP to run commands\".",
    shape: {
      state: z.enum(['working', 'done', 'needs-you', 'idle']),
      terminal: z.string().optional().describe('Terminal id (TERMINALS_TERM_ID). Default: the terminal this request comes from')
    },
    mutates: false,
    readOnly: false,
    run: (a, ctx) => {
      if (!ctx.terminals) throw new ToolError('Terminal control is not available in this process.')
      const id = (a.terminal ?? ctx.headerTerm ?? '').trim()
      if (!id)
        throw new ToolError(
          'No terminal given. Pass `terminal` ($env:TERMINALS_TERM_ID in PowerShell), or re-register the MCP server with the X-Terminals-Term header (see the README).'
        )
      const state = parseReportedStatus(a.state)
      if (!state) throw new ToolError('Invalid state')
      return { id, status: ctx.terminals.report(id, state) }
    }
  }),
  defineTool({
    name: 'close_terminal',
    description: 'Close a terminal opened with open_terminal (its tab disappears). Only for terminals opened through MCP.',
    shape: { id: termId },
    mutates: false,
    readOnly: false,
    destructive: true,
    run: async (a, ctx) => {
      await terminalsOrThrow(ctx).close(a.id)
      return { closed: a.id }
    }
  })
]
