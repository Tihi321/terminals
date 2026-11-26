---
status: in-progress
request: REQ-0011
repos: [C:/projects/Personal/terminals]
branch: feat/herdr-agent-workflow
updated: 2026-11-26
---

# REQ-0011: Worktree tabs

Full reading: create, list, select and remove git worktrees from the sidebar, open terminals in them, and show a "changes vs base" view in the Git panel. This is the "one tab per task, each on its own worktree" workflow from REQ-0009 research section 2b.

Coordination: this lands on `feat/herdr-agent-workflow` **after REQ-0010** (agent status per tab: shared status type, status dots on tabs and sidebar rows, edits `Sidebar.tsx`, `TabBar.tsx`, `pty.ts`, `mcpTools.ts`) and **before REQ-0012** (Ctrl+K switcher). Rebase or read REQ-0010's final `Sidebar.tsx` / `mcpTools.ts` before starting T3 and T2.6. Sidebar changes are kept in a new file (`WorktreeRows.tsx`) plus a few hook-in lines in `Sidebar.tsx`.

## Scope

1. **New worktree…** on the context menu of a git folder row (saved folder or parent-group child whose `.git` is a directory, i.e. a main working tree) and as a row action button (`GitBranchPlus` icon) on those rows. An in-app dialog asks for a branch name and a base branch. Main creates it with `git worktree add` at a location chosen by a new setting, then the app selects the worktree and opens a terminal tab in it.
2. **Worktree rows** listed under their repo row in the sidebar (name = folder name, subtitle = branch). Selectable like folders: Files, Git and Commands panels work on them; terminals, diff and file tabs attach to them; ids are derived from the path (`wt:<normalised path>`), so open terminals survive a rescan and a restart.
3. **Remove worktree…** on a worktree row's context menu: in-app confirm dialog. Shows uncommitted changes and requires an explicit "Discard N uncommitted changes" checkbox before Remove is enabled (then `--force`). Refuses locked worktrees. Optional "Also delete branch `<name>`" checkbox, default off (`git branch -d`, safe delete only). Closes the worktree's tabs first.
4. **Git panel "Branch" view** for any repo (worktree or not) whose current branch is not its base branch (hidden on the base/default branch and on detached HEAD): files changed on the branch relative to `merge-base(HEAD, base)`, including uncommitted and untracked changes, each opening a diff tab (`DiffView`) in a new `base` diff mode.
5. Setting **Worktree location**: `container` = `<repo parent>/<repo>.worktrees/<branch>` (default), `sibling` = `<repo parent>/<repo>-<branch>`.
6. MCP: worktrees appear in `list_locations` / location lookup so agents running inside a worktree terminal (`TERMINALS_LOC_ID=wt:...`) resolve their location.
7. Worktree rows show the REQ-0010 status dot like every other folder row, and count toward group status/activity rollups.

## Out of scope

- Worktrees under the Home row or under a parent-group root row (only saved folders and parent-group children get worktree rows).
- Collapsing the worktree list under a repo (always shown; no new persisted UI state).
- Nested worktrees (a worktree of a worktree row): the "New worktree…" action is only on main working trees.
- Renaming/moving worktrees, `git worktree lock/unlock/prune` UI. Prunable (missing on disk) worktrees are shown dimmed with "missing" and can be removed (main then runs `git worktree prune`).
- Force-deleting an unmerged branch (`git branch -D`). If `-d` refuses, the message is shown and the branch is kept.
- Pinning worktree rows, dragging them to reorder, moving them into groups. (Dragging a worktree row onto a pane edge works for free via `locId`.)

## Key decisions

- **Listing reads git's own metadata from disk, not `git worktree list --porcelain`** (director-approved; keep the smoke cross-check). `store.getState()` is synchronous and runs on every state push (focus, every IPC mutation); spawning git per repo there would be slow. `git worktree list` reads exactly `<gitdir>/worktrees/<name>/{gitdir,HEAD,locked}`, which `readWorktrees()` reads too (same pattern as `readGit()`). The smoke check cross-checks the result against `git worktree list --porcelain` so the two cannot drift silently.
- **Main computes the worktree path**; the renderer only sends repo path + branch + base. No renderer-supplied paths outside the saved roots reach `git`.
- **Roots**: worktree paths of known repos are added to the allowed roots (cached list refreshed in `getState()`), so fs/git/pty IPC accepts them.
- **Base branch** (director decision) is stored in app data (`repoBases`, keyed by normalised repo top-level path: the worktree path for a worktree, the repo path for a main working tree). It is recorded at worktree creation and changeable in the Branch view. Fallback when unset: the **local** default branch: name taken from `origin/HEAD` (`refs/remotes/origin/HEAD` -> `origin/main` -> local `main`) when that local branch exists, else local `main`, else local `master`; only when none of these exists locally, `origin/HEAD`'s target itself (e.g. `origin/main`); else error `No base branch found`. Rationale: agent worktrees branch from local master; comparing against origin would show unpushed master commits.
- **Branch view visibility**: shown for any repo whose current branch differs from the resolved base; hidden when on the base branch or detached.
- Parent-group scans skip a `<name>.worktrees` directory when a sibling `<name>` directory exists, so the default container does not show up as a plain child folder.

## Contract

### Types (`src/shared/types.ts`)

```ts
/** A linked git worktree of a main working tree. Id derived from the path: 'wt:' + norm(path). */
export interface WorktreeView {
  id: string
  path: string
  /** Folder name (basename of path). */
  name: string
  /** Branch short name, `detached @ abc1234`, or null when HEAD cannot be read. */
  branch: string | null
  locked: boolean
  /** Directory no longer exists (prunable). */
  missing: boolean
}
```
- `FolderView` and `ChildView` gain `worktrees: WorktreeView[]` (empty unless `.git` is a directory with linked worktrees). Also `isMainWorktree: boolean` (`.git` is a directory) on both, used to decide whether "New worktree…" is offered.
- `Settings` gains `worktreeLayout: 'container' | 'sibling'`.
- `GitDiffRequest` gains `| { mode: 'base'; path: string; base: string }` where `base` is the merge-base commit hash (40 hex). `PersistedTab['diff']` gains `base?: string` and mode `'base'`.
- New:
```ts
export interface GitBaseFile {
  path: string
  origPath?: string
  /** A M D R C T, or 'U' for untracked. */
  status: string
  added: number | null
  deleted: number | null
}
export interface GitBaseChanges {
  /** Ref the merge-base was taken against, e.g. "main" or "origin/main". */
  base: string
  /** True when `base` came from repoBases (set by the user), false when it is the fallback. */
  baseIsSet: boolean
  /** Current branch short name (null = detached). */
  branch: string | null
  /** True when HEAD is detached or `branch` equals `base` (local name, or `base` minus `origin/`): the Branch view is hidden. When true, mergeBase/files are empty and no diff is computed. */
  onBase: boolean
  mergeBase: string
  /** Commits on HEAD not in base. */
  ahead: number
  files: GitBaseFile[]
}
export interface WorktreeStatus {
  /** Number of entries in `git status --porcelain` (tracked changes + untracked). */
  changes: number
  branch: string | null
  locked: boolean
}
```

### IPC channels (main `index.ts` handlers, preload `index.ts`, `TerminalsApi`)

| channel | api method | args | returns | main-side checks |
|---|---|---|---|---|
| `worktree:add` | `worktreeAdd(repo, branch, base)` | `repo: string` (main working tree path), `branch: string`, `base: string \| null` (null = repo HEAD; ignored when `branch` already exists locally) | `Result<{ id: string; path: string; state: AppState }>` | `allowed(repo)`; repo `.git` is a directory; `git check-ref-format --branch`; no leading `-`; target path must not exist; `base` checked with `rev-parse --verify --quiet <base>^{commit}` |
| `worktree:status` | `worktreeStatus(path)` | worktree path | `GitResult<{ status: WorktreeStatus }>` | `allowed(path)` and path is a known worktree |
| `worktree:remove` | `worktreeRemove(path, opts)` | `opts: { force: boolean; deleteBranch: boolean }` | `Result<{ state: AppState; branchError?: string }>` | path is a known worktree of a saved repo; refuses locked; without `force` refuses when `changes > 0` |
| `git:setBase` | `setRepoBase(folder, base)` | `base: string \| null` (null = clear, use fallback) | `AppState` | `allowed(folder)`; key = `norm(repoRoot(folder))`; base verified as a commit-ish |
| `git:baseChanges` | `gitBaseChanges(folder)` | any repo folder | `GitResult<{ changes: GitBaseChanges }>` | `allowed(folder)` |
| `git:diff` (existing) | `gitDiff(folder, req)` | new `mode: 'base'` | unchanged | `base` must match `HASH_RE` |

### Store shape (`src/main/store.ts`, `Persisted`)

- New optional field `repoBases: Record<string, string>` (key: `norm(repo top-level path)`, value: base ref name). `migrate()` defaults it to `{}`; no `SCHEMA_VERSION` bump (same as `pinned`, absent in older files).
- `settings.worktreeLayout` via `SETTINGS_SCHEMA` (default `'container'`), so `sanitizeSettings` handles old files.
- Module-level `let worktreeRoots: string[] = []` refreshed at the end of every `getState()`; `getRoots()` appends it.
- `export const worktreeId = (p: string): string => 'wt:' + norm(p)`.

### Location kind

- Renderer `Loc.kind` and MCP `LocKind` gain `'worktree'`. Renderer `Loc` gains `parentLocId?: string` (the repo row's id). `groupId` = the repo row's group (folder's `groupId`, or the parent group for a child).
- MCP `KIND_LABEL.worktree = 'git worktree of a saved folder'`.

## Files and modules to touch

| file | change |
|---|---|
| `src/shared/types.ts` | types above; `TerminalsApi` methods |
| `src/shared/settings.ts` | `worktreeLayout` field |
| `src/shared/session.ts` | `DIFF_MODES` + `'base'`, require `base` hash for it |
| `src/main/git.ts` | `readWorktrees(repoDir)` (sync), `isMainWorktree(dir)` |
| `src/main/gitcli.ts` | export `run`, `failText`, `repoRoot`; `base` diff mode; `gitBaseChanges`; `parseWorktreePorcelain` (smoke cross-check only) |
| `src/shared/worktreePath.ts` (new) | `safeDirName`, `worktreeTargetPath` (pure) |
| `src/main/worktree.ts` (new) | `addWorktree`, `worktreeStatus`, `removeWorktree`, `resolveBase` |
| `src/main/store.ts` | views, roots, `scanChildren` skip, `repoBases`, cleanup on remove |
| `src/main/index.ts` | 5 new handlers |
| `src/preload/index.ts` | 5 new methods |
| `src/main/mcpTools.ts` | `buildLocations` adds worktrees, `KIND_LABEL` |
| `src/main/smoke.ts` | `checkWorktree()`; one assertion in `checkSession()` |
| `src/renderer/src/locations.ts` | worktree locs |
| `src/renderer/src/WorktreeRows.tsx` (new) | worktree child rows + their context menu |
| `src/renderer/src/NewWorktreeDialog.tsx` (new) | create dialog |
| `src/renderer/src/RemoveWorktreeDialog.tsx` (new) | remove confirm dialog |
| `src/renderer/src/Sidebar.tsx` | export `Row`/`RowProps`; hook-in lines (menu item, action button, render `WorktreeRows`, rollups) |
| `src/renderer/src/App.tsx` | dialog state + wiring, close tabs, reselect |
| `src/renderer/src/GitPanel.tsx` | "Branch" sub-view |
| `src/renderer/src/DiffView.tsx` | `base` mode request, no stage controls |
| `src/renderer/src/gitUtil.ts` | `diffTitle` / `diffModeLabel` for `base` |
| `src/renderer/src/SettingsDialog.tsx` | Worktree location select |
| styles file used by the sidebar/modal (`src/renderer/src/*.css`, whichever holds `.modal` and `.row`) | minimal additions only if needed |
| `README.md` | docs |

## Tasks for workers

Order: T1 -> T2 -> (T3, T4 in parallel; disjoint files) -> T5 -> T6. T5 may run right after T2.

### T1. Shared types, settings, session

- Inputs: this plan's Contract section.
- Outputs:
  - `types.ts`: `WorktreeView`, `GitBaseFile`, `GitBaseChanges`, `WorktreeStatus`; `worktrees` and `isMainWorktree` on `FolderView` and `ChildView`; `Settings.worktreeLayout`; `GitDiffRequest` `base` variant; `PersistedTab.diff` `mode` union + `base?: string`; `TerminalsApi`: `worktreeAdd`, `worktreeStatus`, `worktreeRemove`, `setRepoBase`, `gitBaseChanges` with JSDoc.
  - `settings.ts`: `worktreeLayout: { default: 'container', sanitize: v => v === 'container' || v === 'sibling' ? v : undefined }`.
  - `session.ts`: `DIFF_MODES` adds `'base'`; for `base`, require `str(d.base) && /^[0-9a-f]{40}$/i.test(d.base)` else drop the tab; copy `base` into `t.diff`.
- Done when `yarn typecheck` fails only in files later tasks own (or passes with temporary stubs removed by T2/T3).

### T2. Main process

T2.1 `git.ts`
- `isMainWorktree(dir): boolean` = `<dir>/.git` exists and is a directory.
- `readWorktrees(repoDir): { path: string; branch: string | null; locked: boolean; missing: boolean }[]`: only when `isMainWorktree`. For each entry of `<repo>/.git/worktrees/*`: read `gitdir` (one line, absolute path to `<wt>/.git`, forward slashes possible), worktree path = `dirname(resolve(trimmed))`; branch from that entry's `HEAD` with the same parsing as `readGit` (factor the HEAD parsing into a shared helper); `locked` = file `locked` exists; `missing` = worktree path does not exist. Never throws (return `[]` on any error). Sort by path, case-insensitive.

T2.2 `gitcli.ts`
- `export` `run`, `failText`, `repoRoot` (no behaviour change).
- `gitDiff` case `'base'`: validate `req.base` with `HASH_RE` (must be full 40 hex); args `['diff', ...common, '-M', req.base, '--', req.path]` (working tree vs merge-base, so committed + uncommitted). If the path is untracked (not in that diff), the renderer opens it with mode `untracked` instead (see T4); main does not special-case.
- `gitBaseChanges(folder, base: string)`: `repoRoot`; `mergeBase = merge-base HEAD <base>` (fail with `No common history with <base>` on non-zero); `ahead = rev-list --count <base>..HEAD`; `diff --name-status -z -M <mb>` for status letters + `diff --numstat -z -M <mb>` (reuse `parseNumstat`) joined by path; untracked from `ls-files --others --exclude-standard -z` with `status: 'U'`, `added: countLines(...)`, `deleted: 0`. Before diffing: read the current branch (`symbolic-ref -q --short HEAD`); if detached or equal to `base` (or `base` without a leading `origin/`), return early with `onBase: true`, empty `files`, `mergeBase: ''`, `ahead: 0`. Returns `GitBaseChanges` minus `baseIsSet` (filled by caller). Add `parseNameStatus(out)` next to `parseNumstat`.
- `parseWorktreePorcelain(out): { path: string; branch: string | null }[]` for `worktree list --porcelain` (blocks separated by blank lines; `worktree <path>`, `branch refs/heads/<x>`, `detached`). Used only by the smoke check.

T2.3 `worktree.ts` (new; imports `run`, `failText` from `gitcli`, `readWorktrees` from `git`)
- Path rule lives in new pure module `src/shared/worktreePath.ts` (no Node imports, string ops with `\` joins, so the renderer dialog can preview it): `safeDirName(branch)` replaces `/` `\` `<>:"|?*` and whitespace with `-`, collapses repeats, trims `-` and `.` at the ends (empty -> `''`, caller errors); `worktreeTargetPath(repo, branch, layout)`: `container` -> `<dirname(repo)>\<basename(repo)>.worktrees\<safe>`; `sibling` -> `<dirname(repo)>\<basename(repo)>-<safe>`. `worktree.ts` calls it and `resolve()`s the result.
- `addWorktree(repo, branch, base, layout): Promise<Result<{ path: string }>>`: checks from the IPC table; branch exists locally (`rev-parse --verify --quiet refs/heads/<b>`) -> `['worktree', 'add', path, b]`; else `['worktree', 'add', '-b', b, path, base ?? 'HEAD']`. `mkdirSync(dirname(path), { recursive: true })` for the container first. Timeout `NET_TIMEOUT`-like (60 s; checkout can be slow). On failure return `failText`.
- `worktreeStatus(path)`: `status --porcelain -z --untracked-files=normal` entry count; branch via `readGit`; `locked` from `readWorktrees(mainRepo)` where `mainRepo = dirname(resolve(path, rev-parse --git-common-dir))`.
- `removeWorktree(repo, path, { force, deleteBranch })`: refuse locked (`Worktree is locked: unlock it with git worktree unlock first`). Missing worktree -> `worktree prune` only. Else, unless `force`, refuse when `changes > 0` (`Worktree has N uncommitted changes`). Run `['worktree', 'remove', ...(force ? ['--force'] : []), path]` from `repo`; on failure whose stderr matches `/Permission denied|being used|Directory not empty|Invalid argument/i` retry up to 3 times, 500 ms apart (shells closing release the directory late on Windows). Then, if `deleteBranch` and the worktree had a branch (not detached): `['branch', '-d', branch]` from `repo`; failure -> `branchError = failText(...)`, worktree removal still counts as success.
- `resolveBase(folder, stored: string | undefined): Promise<{ base: string; baseIsSet: boolean }>` (works for worktrees and main working trees; refs are shared): (1) `stored` and `rev-parse --verify --quiet <stored>^{commit}` succeeds -> it, `baseIsSet: true`; (2) `o = symbolic-ref -q --short refs/remotes/origin/HEAD` (e.g. `origin/main`); if set and `refs/heads/<o minus origin/>` exists -> that local name; (3) else `refs/heads/main` exists -> `main`; (4) else `refs/heads/master` -> `master`; (5) else `o` if set; (6) else error `No base branch found`.
- `addWorktree` records the base: the IPC handler calls `store.setRepoBase(path, base ?? <repo's current branch>)` after success (skipped when an existing branch was checked out and `base` is null).

T2.4 `store.ts`
- `getState()`: folders and children get `isMainWorktree` and `worktrees` built from `readWorktrees(path)` mapped to `WorktreeView` (`id: worktreeId(path)`, `name: basename(path)`). Skip a worktree whose `norm(path)` equals a saved folder path (it already has its own row). Collect every worktree path into `worktreeRoots`.
- `getRoots()`: append `worktreeRoots`.
- `scanChildren`: skip `ent.name` ending in `.worktrees` (case-insensitive) when `join(dir, name.slice(0, -10))` is a directory.
- `repoBases`: `migrate` defaults `{}` (keep only string->string entries); `getRepoBase(path)`, `setRepoBase(path, base | null): AppState`.
- `forgetWorktree(path)`: removes `repoBases[norm(path)]`, commands with `ownerId === worktreeId(path)`, snippets with `scope === worktreeId(path)`, pinned entry, and resets `selectedId` to the repo's row id when it was the worktree. Saves.
- `findWorktree(path): { repo: string; repoLocId: string } | null` over current folders/children (used by IPC checks).

T2.5 `index.ts` + `preload/index.ts`
- Handlers per the IPC table. `worktree:add`: after success, `getState()` (refreshes roots) then return `{ ok, id: worktreeId(path), path, state }`. `worktree:remove`: after success call `store.forgetWorktree(path)`, return fresh state. `git:baseChanges`: `repoRoot(folder)` -> `resolveBase(folder, store.getRepoBase(root))` -> `gitcli.gitBaseChanges(folder, base)`, add `baseIsSet`. Works for any repo; non-repo -> the usual `notRepo` result.
- Preload: `worktreeAdd: (r, b, base) => inv('worktree:add', r, b, base)` etc.

T2.6 `mcpTools.ts` (after REQ-0010's edits)
- `LocKind` + `'worktree'`, `KIND_LABEL.worktree`. `buildLocations`: after children, push each folder's and child's worktrees `{ id, name, path, kind: 'worktree', groupId: <repo row's group or null>, missing }`. Keep Home last.

### T3. Renderer: sidebar, dialogs, wiring

T3.1 `locations.ts`: add worktree locs for every folder's and child's `worktrees` (`kind: 'worktree'`, `parentLocId`, `groupId` as in Contract, `branch`, `missing`).

T3.2 `Sidebar.tsx` (keep the diff small; REQ-0010 also edits this file)
- `export` `Row` and `RowProps` (type).
- New props: `onNewWorktree(repoLocId: string, repoPath: string)`, `onRemoveWorktree(wt: WorktreeView, repoLocId: string, repoPath: string)`.
- Folder menu and child menu: when `isMainWorktree && !missing`, add `{ label: 'New worktree…', icon: <GitBranchPlus size={14} /> }` after "Open in editor". Row actions of such rows get the same icon button (title "New worktree").
- After each `folderRow(f, …)` and `childRow(g, c, …)` call site, render `<WorktreeRows … />` for `f.worktrees` / `c.worktrees` at `indent + 1`. In Activity mode render them with their repo row (same working/idle bucket as the repo row).
- Rollups: `isWorking(id)` for a folder/child row becomes true when the row or any of its worktrees is working; `groupWorking` and REQ-0010's group status rollup include worktree ids of members/children. Implement as one helper `withWorktrees(id): string[]` in `WorktreeRows.tsx` used by Sidebar.

T3.3 `WorktreeRows.tsx` (new)
- `export function WorktreeRows(p: { worktrees: WorktreeView[]; repoLocId; repoPath; indent; selectedId; counts; finished; <REQ-0010 status map prop, same type Sidebar receives>; RowComponent: (r: RowProps) => JSX.Element; onSelect; onOpenTerminal; onOpenToSide; canOpenToSide; onOpenExplorer; onOpenEditor; onOpenWt; onCopy; onRemove; openMenu })`.
- Each row: `locId = wt.id`, icon `GitBranch` (16), name `wt.name`, subtitle `wt.missing ? 'Folder not found' : wt.branch`, subKind `missing` / `branch`, title = path (+ `(locked)`), `dim` when missing, count/finished/status like other rows, action button "New terminal" (disabled when missing).
- Context menu: Open terminal, Open to the side, Open in Windows Terminal, Open in Explorer, Open in editor, Copy path, separator, `Remove worktree…` (danger; always enabled, the dialog explains locked/missing).

T3.4 `NewWorktreeDialog.tsx` (new; `modal-backdrop` / `modal` markup like `SettingsDialog`)
- Props: `repoPath`, `layout`, `onCancel`, `onCreated(id: string, state: AppState)`.
- Fields: Branch name (autofocus), Base branch `<select>` of local branches from `gitBranches(repoPath)` (default: current branch), live "Will be created at `<path>`" preview computed with `worktreeTargetPath` from `src/shared/worktreePath.ts` (T2.3).
- If the typed name equals an existing local branch: base select disabled, button reads "Check out existing branch".
- Enter submits, Escape cancels; main's error shown inline in the dialog; button disabled while busy.

T3.5 `RemoveWorktreeDialog.tsx` (new)
- Props: `wt: WorktreeView`, `onCancel`, `onConfirm(opts: { force: boolean; deleteBranch: boolean }): Promise<string | null>` (error text or null).
- On open calls `worktreeStatus(wt.path)` (skip when `wt.missing`). Shows path and branch. Locked: message + Remove disabled. `changes > 0`: warning "N uncommitted changes will be lost" + checkbox "Discard uncommitted changes" (Remove disabled until ticked; ticking sets `force`). Checkbox "Also delete branch `<branch>`" (default off; hidden when detached). Remove button `danger`.

T3.6 `App.tsx`
- State `newWt: { repoPath } | null`, `removeWt: { wt, repoLocId } | null`.
- `onCreated`: `setState(state)`, then `openTerminal(id)`.
- `onConfirm` for remove: `closeTabsOf([wt.id])`, wait for those ptys to exit (or 1500 ms max; reuse the pty exit events, or simply `await new Promise(r => setTimeout(r, 300))` before calling main, which retries anyway), call `worktreeRemove`, `setState(r.state)`; if `branchError`, show it through the existing sidebar note mechanism (pass a `note` prop or return it for the dialog to display before closing). Panes showing the removed loc fall back via the existing `valid` set logic (verify).
- `onStateChanged` cleanup: also treat worktree ids that disappear from `next` as gone (close their tabs) only when they were removed in-app; do **not** close tabs for a worktree that vanished on disk outside the app (consistent with children).

T3.7 `SettingsDialog.tsx`: "Worktree location" select: `Next to the repo in <repo>.worktrees\<branch>` / `Next to the repo as <repo>-<branch>`, with a hint "Applies to new worktrees".

### T4. Git panel Branch view and base diffs

- `GitPanel.tsx` (no new prop): call `gitBaseChanges(root)` when `root` changes and whenever the polled `status.branch` changes. The segmented control shows a third button `Branch` (sub `'branch'`) only when the result is ok and `onBase === false`; if the Branch sub is active and it becomes hidden (user switched to the base branch), fall back to `Changes`. While the Branch view is visible, poll `gitBaseChanges(root)` every `POLL_MS` (same pattern as status polling). Header: `vs <base>` with a small base `<select>` (local + remote branches from `gitBranches`, plus "Default (<fallback>)" which calls `setRepoBase(root, null)`), `ahead` count ("N commits ahead"), totals `+a −d`, refresh button. List rows reuse the existing row markup (icon, name, dir, letter, `Stat`); click opens `onOpenDiff(root, spec, false)`, double-click pins. `spec` = `status === 'U' ? { mode: 'untracked', path } : { mode: 'base', path, base: mergeBase }`. Empty state: "No changes vs <base>". Error state shows the message (e.g. no common history).
- `DiffView.tsx`: build `req` with `base` for mode `base`; include `base` in the reload key; hide the Stage/Unstage button and the "other mode" switch for `base`.
- `gitUtil.ts`: `diffTitle` for base -> `${name} (branch)`; `diffModeLabel` -> `vs merge-base ${base.slice(0, 7)}`.
- `App.tsx` `openDiff` `same()` compares `base` for mode `base` (one line; coordinate with T3 owner if run in parallel: T4 owns this line).

### T5. Smoke check (`src/main/smoke.ts`)

`checkWorktree()` (async, added to `runSmoke` results after `checkGit`):
1. Temp repo `git init -q -b main`, commit `a.txt`.
2. `addWorktree(repo, 'feat/x', 'main', 'container')` -> path `== join(dirname(repo), basename(repo) + '.worktrees', 'feat-x')` and exists.
3. `readWorktrees(repo)` has exactly that path with branch `feat/x`, and matches `parseWorktreePorcelain(git worktree list --porcelain)` minus the main entry (paths compared with `norm`).
4. In the worktree: commit `b.txt`, then modify `a.txt` and add untracked `c.txt`. `gitBaseChanges(wt, 'main')` -> `ahead === 1`, files contain `b.txt` (A), `a.txt` (M), `c.txt` (U). `gitDiff(wt, { mode: 'base', path: 'a.txt', base: mergeBase })` text contains the edited line.
4b. `resolveBase(wt, undefined)` returns `main` (local default, no remote) with `baseIsSet: false`; `gitBaseChanges(repo, 'main')` returns `onBase: true`.
5. `removeWorktree(repo, wt, { force: false, deleteBranch: true })` fails (uncommitted changes) and the folder still exists.
6. `removeWorktree(repo, wt, { force: true, deleteBranch: true })` ok, folder gone, `readWorktrees(repo)` empty, and `branchError` is set (branch has an unmerged commit, `-d` refuses) and `refs/heads/feat/x` still exists.
7. Cleanup in `finally` (both repo and `.worktrees` container).

`checkSession()`: one added assertion that a persisted diff tab with `mode: 'base'` and a 40-hex `base` survives `sanitizeTabs`, and one without `base` is dropped.

No renderer unit tests (none exist in the repo); UI is covered by the manual checks below.

### T6. README

- Folders section: worktree rows under a repo (subtitle = branch, selectable, tabs survive refresh, ids from path); "New worktree…" (menu + button, dialog, branch + base, where it is created, opens a terminal); "Remove worktree…" (uncommitted-changes gate, locked refusal, optional safe branch delete, tabs closed first); parent-group scans hide `<repo>.worktrees`.
- Git panel section: the Branch view (vs base, merge-base, includes uncommitted/untracked, base picker, default base resolution order).
- Settings section: Worktree location.
- MCP section: `worktree` location kind.

## Acceptance criteria

Automated (run `yarn typecheck` and `yarn smoke`; use `fnm exec --using default yarn …` if node is missing):

1. `yarn typecheck` passes.
2. `yarn smoke` passes, including the new `worktree:` line (steps 1-7 of T5) and the extended session check.

Manual, real app (mark UNTESTED if not run in `yarn dev` / the built exe):

3. Right-click a saved git folder -> "New worktree…" -> branch `test/wt1`, base `main` -> `<repo>.worktrees\test-wt1` exists, the sidebar shows a `test-wt1` row under the repo with subtitle `test/wt1`, it is selected and a terminal tab opens with that cwd.
4. With the worktree selected: Files panel lists its files; Git panel Changes works; Commands panel can save/run a command owned by the worktree.
5. Refresh (window focus / refresh button) and app restart: the worktree terminal tab stays attached to the worktree row (restored after restart).
6. Git panel Branch view: after committing a file in the worktree terminal and editing another, both appear; clicking opens a diff tab labelled "vs merge-base …"; untracked files open as untracked diffs; changing the base select updates the list and persists across restart. The Branch tab also appears for a plain saved repo on a feature branch, and disappears after `git switch main` there.
7. "Remove worktree…" with an uncommitted change: Remove is disabled until "Discard uncommitted changes" is ticked; after removal the row and its tabs are gone, the repo row is selected, the folder is deleted. With "Also delete branch" on a merged branch, the branch is deleted; on an unmerged branch the refusal message is shown and the branch stays.
8. Settings -> Worktree location = sibling: the next worktree is created at `<repo>-<branch>`.
9. A repo inside a parent-folder group: worktree rows appear under the child row, and the `<repo>.worktrees` container does not appear as its own child.
10. Worktree rows show the REQ-0010 status dot for an agent running in their terminal, and a group containing the repo rolls that status up; Activity mode keeps worktree rows with their repo row.
11. An MCP `list_locations` call from a worktree terminal lists it with kind `worktree`, and `open_terminal` with `location` = the worktree id opens there.

## Open questions

- None open. Resolved by the director: on-disk listing with a smoke cross-check; the Branch view shows for any repo off its base branch; the base is the recorded base, then the local default branch, with `origin/HEAD` only as the last fallback.

## Progress

### T1, T2, T5: DONE (worker 1, main process)

Verification: `npx tsc --noEmit -p tsconfig.node.json` passes. `tsc -p tsconfig.web.json` shows exactly 2 errors, both T4-owned (the new `base` diff mode needs `base` in `App.tsx` ~646 restore code and `DiffView.tsx` ~50 `req`). `yarn smoke` exit 0, all PASS including `PASS: worktree: ...` and the extended `session:` check.

- T1 done: `types.ts`, `settings.ts`, `session.ts` as in Contract.
- T2.1 `git.ts`: `isMainWorktree`, `readWorktrees` (+ shared private `parseHead`).
- T2.2 `gitcli.ts`: exports `run`, `failText`, `repoRoot`, `RunOut`; `gitDiff` mode `base`; `gitBaseChanges`; `parseNameStatus`; `parseWorktreePorcelain`.
- T2.3 `src/shared/worktreePath.ts` (`safeDirName`, `worktreeTargetPath`), `src/main/worktree.ts` (`addWorktree`, `worktreeStatus`, `removeWorktree`, `resolveBase`).
- T2.4 `store.ts`: views, `worktreeRoots`, `scanChildren` skip, `repoBases`, `getRepoBase`/`setRepoBase`/`findWorktree`/`forgetWorktree`, `worktreeId`.
- T2.5 `index.ts` + `preload/index.ts`: 5 channels / methods.
- T2.6 `mcpTools.ts`: `'worktree'` kind, `KIND_LABEL`, `buildLocations`.
- T5 `smoke.ts`: `checkWorktree()` (steps 1-7) + session assertion.

Deviations (all small, API-compatible):
- `addWorktree` returns `Result<{ path; created: boolean }>` (extra `created`, so the IPC handler records the base only when the branch was newly created).
- `resolveBase` returns `{ ok: true; base; baseIsSet } | { ok: false; error }` (error case from step 6 as a result, not a throw).
- `store.forgetWorktree(path, repoLocId?)` takes the repo row id as optional 2nd arg (git has already dropped the worktree, so the repo cannot be looked up afterwards; the handler calls `findWorktree` first). `fixSelection` now leaves `wt:` selections alone, like `child:`.
- `git:setBase` ignores (returns unchanged state for) an unknown/invalid base rather than erroring (contract returns `AppState`).
- Smoke `FolderView`/`ChildView` literals in `checkMcpLogic` got `isMainWorktree: false, worktrees: []`.

### T3, T6: DONE (worker 2, renderer sidebar/dialogs/App/README)

- `locations.ts` (`kind: 'worktree'`, `parentLocId`), new `WorktreeRows.tsx` (`WorktreeRows`, `withWorktrees`), `NewWorktreeDialog.tsx`, `RemoveWorktreeDialog.tsx`; `Sidebar.tsx` exports `Row`/`RowProps`, new props `onNewWorktree`/`onRemoveWorktree`, roll-ups via `rowIds()`/`agentOf()`; `App.tsx` dialog wiring, `same()` base compare, restore of base diff tabs; `SettingsDialog.tsx` Worktree location; `styles.css`; `README.md`.
- Deviations: `branchError` shown with `alert()` (the sidebar note state is internal to Sidebar); no `onStateChanged` cleanup for worktrees vanished outside the app (plan: in-app removal only).

### T4: DONE (worker 3, Git panel)

- `GitPanel.tsx` Branch sub-view, `DiffView.tsx` base mode, `gitUtil.ts` labels.
- Deviation: when the Branch tab is active and `gitBaseChanges` errors, the tab stays visible to show the error.

### Verification (orchestrator)

- `yarn typecheck`: exit 0. `yarn smoke`: exit 0, all PASS incl. `worktree:` and `session:`.
- Manual acceptance 3-11: UNTESTED (not run in the real app).
