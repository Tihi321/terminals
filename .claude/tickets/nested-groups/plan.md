---
status: done
request: REQ-0005
repos: [C:/projects/Personal/terminals]
branch: nested-groups
updated: 2026-11-20
---
# Plan: nested groups

Sources: `.claude/director/requests/REQ-0005-nested-groups.md`, `research.md` (same folder). Line numbers are from master `edb7b84`.

## Scope
Full reading: manual groups contain groups (manual or parent-folder kind) to any depth, built from an optional `parentId` on the flat group list.
- Data: `parentId: string | null` on persisted groups and `GroupView`. `AppState.groups` stays flat and in array order. No `SCHEMA_VERSION` bump (stays 4). `migrate` carries `parentId` and nulls dangling, non-manual, self and cyclic parents.
- Only `kind === 'manual'` groups can be parents. Parent-folder groups can be nested inside a manual group, but they contain no groups.
- Nesting: drag a group header onto a manual group header. Drag it onto the "Folders" (top-level) zone to un-nest it. Two more ways in the group context menu: "New subgroup" (manual groups only), and "Move to group: X" / "Move to top level". Main rejects a move into the group itself or into a descendant.
- Each group collapses on its own, using the existing `collapsed` field (no change).
- Cascade remove, from the sidebar only and never on disk. It removes the group, all descendant groups and every folder whose `groupId` is in that set. It also deletes commands (`ownerId`) and snippets (`scope`) owned by any removed group, any removed folder, or any `child:` id of a removed parent group. The renderer closes the tabs for the same id set. Selection falls back to a remaining folder or group. Applies to flat groups too: the "Remove group (keeps folders)" item goes away.
- In-app confirm (not `window.confirm`) before any group removal, stating how many groups and folders go.
- Counts include descendants: the header badge, the "N folders" subtitle and the App.tsx empty-group check.
- MCP: `list_locations` exposes `parentId`. `create_group` takes an optional `parent`. `delete_group` is rewritten for the cascade. A new `move_group` tool is added, because `nestError` plus `store.moveGroup` make it about 15 lines.

## Out of scope
- Command or prompt inheritance beyond the direct group. `locations.ts` `buildLocs` keeps `groupId: null` for groups, and folders inherit only from their own group. CommandsPanel, SnippetEditor, CommandEditor and the mcpTools scope logic are not touched.
- Reordering groups among siblings (no `beforeId` on `moveGroup`). A moved group goes to the end of `data.groups`, so it becomes the last child of its new parent.
- Parent-folder groups containing groups.
- Mixed ordering of subgroups and folders inside a group. A group renders its subgroups first, then its member folders.
- Killing ptys in main on removal. Closing tabs stays renderer-side, as today.

## Files and modules to touch
| File | Change | Task |
|---|---|---|
| `src/shared/groupTree.ts` (new) | pure tree helpers used by main, MCP and renderer | T1 |
| `src/shared/types.ts` | `GroupView.parentId` (98-113); `TerminalsApi.addGroup`/`moveGroup`/`removeGroup` doc (268-275) | T1 |
| `src/main/store.ts` | `PersistedGroup.parentId` (32-42), export `Persisted` type, `migrate` (119-130, 151-153), `getState` (233-268), `pushManualGroup`/`addManualGroup`/`createManualGroup` (344-369), cascade `removeGroup` (388-396), new `moveGroup` | T1 |
| `src/main/index.ts` | `groups:addManual` takes parentId (326), new `groups:move` (near 334) | T1 |
| `src/preload/index.ts` | `addGroup` passes parentId (15), new `moveGroup` (near 21) | T1 |
| `src/main/mcpTools.ts` | `list_locations` (389-411), `create_group` (509-522), `delete_group` (549-565), new `move_group` | T2 |
| `src/renderer/src/Sidebar.tsx` | recursive `groupBlock`, group DnD, menus, subgroup input, confirm, counts | T3 |
| `src/renderer/src/App.tsx` | handlers (906-938), cascade `closeTabsOf` (921-925), `members` (995) + empty text (1084-1093) | T3 |
| `src/renderer/src/styles.css` | confirm row styles; `.group-empty` padding (535) becomes inline per depth | T3 |
| `src/main/smoke.ts` | `group()` helper gets `parentId: null` (492); new `checkGroupTree()` added to the list (626-634) | T4 |

## Tasks for workers
Order: T1 first, because it holds the contract. T2, T3 and T4 then run in parallel against the contract below, and each worker runs `yarn typecheck` before handing back.

### Contract (fixed; every task codes against this)
`src/shared/groupTree.ts` (no Node imports, so the renderer can use it):
```ts
export interface TreeGroup { id: string; kind: 'parent' | 'manual'; parentId?: string | null }
export interface TreeFolder { id: string; groupId: string | null }
/** The id itself first, then all descendants (visited set, so a cycle cannot loop). [] if the id is unknown. */
export function subtreeGroupIds(groups: TreeGroup[], id: string): string[]
/** null when moving group `id` under `parentId` is allowed (parentId null = top level). Otherwise the reason:
 *  'Group not found' | 'Target group not found' | 'Only manual groups can contain groups' | 'Cannot move a group into itself or its own subgroup' */
export function nestError(groups: TreeGroup[], id: string, parentId: string | null): string | null
/** Children of parentId (null = roots) in array order. A group whose parentId is unknown counts as a root. */
export function childGroups<G extends TreeGroup>(groups: G[], parentId: string | null): G[]
/** What a cascade removal of `id` takes away: subtreeGroupIds + folders whose groupId is in that set. */
export function removalSet(groups: TreeGroup[], folders: TreeFolder[], id: string): { groupIds: string[]; folderIds: string[] }
```
Types (`src/shared/types.ts`):
- `GroupView.parentId: string | null` (required; always set by `getState`).
- `TerminalsApi`:
  - `addGroup(name: string, parentId?: string | null): Promise<AppState>` creates a manual group. A parent that is unknown or not manual falls back to top level. The new group is selected.
  - `moveGroup(id: string, parentId: string | null): Promise<AppState>` makes no change when `nestError` is non-null.
  - `removeGroup(id: string): Promise<AppState>` now cascades (update its doc comment).

IPC channels: `groups:addManual` `(name: string, parentId?: string | null)`; `groups:move` `(id: string, parentId: string | null)`.

Store exports (`src/main/store.ts`):
```ts
export type Persisted                                     // now exported (for smoke)
export interface RemovalSummary { groupIds: string[]; folderIds: string[]; commands: number; prompts: number }
export function removeGroupData(d: Persisted, id: string): RemovalSummary   // pure on d, no save
export function moveGroupData(d: Persisted, id: string, parentId: string | null): string | null // error or null; pure
export function removeGroup(id: string): AppState         // removeGroupData(data) + save + getState
export function deleteGroup(id: string): RemovalSummary   // same + save, for MCP
export function moveGroup(id: string, parentId: string | null): AppState
export function addManualGroup(name: string, parentId?: string | null): AppState
export function createManualGroup(name: string, parentId?: string | null): string
```

### T1 Main: shared helpers, types, store, IPC, preload
**Status: DONE (2026-11-20).** `yarn typecheck`: only error is `src/main/smoke.ts(492,124)` missing `parentId` (T4 fixes). Deviation: `removeGroupData` also treats a selected `child:` id of a removed parent group as removed (selection falls back); `deleteGroup` saves only when something was removed.
- Inputs: the contract above, and `research.md` sections "Store" and "IPC wiring".
- Outputs:
  1. `src/shared/groupTree.ts`, as in the contract.
  2. In `types.ts`: `GroupView.parentId` and the API changes.
  3. In `store.ts`: `PersistedGroup.parentId?: string | null`.
     - `migrate` maps `parentId` (a string, else null).
     - After building groups, null any `parentId` that is unknown, equals its own id, or points to a non-manual group. Then walk up from each group with a visited set and set `parentId = null` on the group where a revisit is found. Ordering of the final `return` is unchanged.
     - `getState` adds `parentId: g.parentId ?? null`.
     - `pushManualGroup(name, parentId?)` keeps `parentId` only if a manual group with that id exists.
     - `moveGroupData` uses `nestError`. On success it sets `parentId`, then moves the record to the end of `d.groups`.
     - `removeGroupData` uses `removalSet`. It also computes child prefixes for removed parent groups as `childId(g.path) + sep` (sep from `path`). An owner/scope matches when it starts with a prefix and has no further separator after it (direct children only, so a parent group nested on a sub-path is not swept).
     - `removeGroupData` filters `d.groups`, `d.folders`, `d.commands` (`ownerId`) and `d.snippets` (`scope`) by removed group ids, folder ids and child matches. Then the selection: if `selectedId` was one of those ids, set it to the first remaining folder, else the first group, else null. Otherwise call `fixSelection` logic on `d`, so `fixSelection` must take `d` as a parameter.
  4. `index.ts`:
     - `groups:addManual` → `store.addManualGroup(String(name ?? ''), typeof parentId === 'string' ? parentId : null)`.
     - `groups:move` → `store.moveGroup(String(id), typeof parentId === 'string' ? parentId : null)`.
  5. `preload/index.ts`: `addGroup: (name, parentId) => inv('groups:addManual', name, parentId)` and `moveGroup: (id, parentId) => inv('groups:move', id, parentId)`.
- Interface with others: exactly the contract. `moveFolder` and `insertFolders` are unchanged, because their manual-only check still holds.

### T2 MCP tools (`src/main/mcpTools.ts`)
- Inputs: the contract, plus `findLocation`, `groupRef`, `ToolError`, `requireName` in the same file.
- Outputs:
  - `list_locations`: add `parentId` to both the manual and the parent group objects. Update the description to say groups nest through `parentId`.
  - `create_group`: add `parent: groupRef('Parent manual group').optional()`. Resolve it with `findLocation(s, a.parent, ['manual'])`, call `store.createManualGroup(name, parentId)` and return `parentId`.
  - `delete_group`:
    - New description: removes the group, all its subgroups at any depth and every folder in them from the app. Also deletes their commands and prompts (including those on a removed parent group's subfolders) and closes their terminals. Nothing on disk is deleted. Keep `destructive: true`.
    - Call `store.deleteGroup(g.id)`. Return `{ deleted, name, kind, groupsDeleted: summary.groupIds.slice(1), foldersDeleted: summary.folderIds, commandsDeleted: summary.commands, promptsDeleted: summary.prompts }`, with no `foldersKept`.
  - New `move_group`:
    - Shape: `{ group: groupRef('Group to move'), parent: groupRef('Target manual group; omit to move to the top level').optional() }`, `mutates: true`.
    - Resolve the group with `['manual','parent']` and the parent with `['manual']`. If `nestError(s.groups, g.id, parentId)` is non-null, throw `ToolError(err)`. Otherwise call `store.moveGroup` and return `{ id, name, parentId }`.
- Interface: uses only the store exports and `nestError`. No renderer change is needed: the existing `onStateChanged` diff (App.tsx:826-838) already closes tabs for every folder or group missing from the next state, including a removed parent group's children.

### T3 Renderer (`Sidebar.tsx`, `App.tsx`, `styles.css`)
- Inputs: the contract, and the research sections "Sidebar rendering and DnD" and "Other consumers".
- Outputs:
  - **Props**:
    - `onAddGroup(name: string, parentId?: string | null)`.
    - New `onMoveGroup(id: string, parentId: string | null)`.
    - `onRemoveGroup(id)` is unchanged; the Sidebar confirms first, so App removes without asking.
  - **Tree**:
    - `groupBlock(g, depth, seen: Set<string>)`. Header `indent={depth}`. Children `indent={depth + 1}`: first `childGroups(state.groups, g.id).map(c => groupBlock(c, depth+1, seen))` (manual only), then the member folders.
    - The top level renders `childGroups(state.groups, null)` and skips ids already in `seen`.
    - `.group-empty` gets `style={{ paddingLeft: 50 + depth * 18 }}` instead of the fixed CSS padding.
    - The empty hint shows only when a manual group has no member folders and no subgroups.
  - **Counts**:
    - Badge = own count + the counts of every group in `subtreeGroupIds`, plus those groups' member folders and parent-group children.
    - Manual subtitle = `removalSet(...).folderIds.length` folders. Prefix `M groups, ` when there are subgroups.
    - In App.tsx `members` (995): descendant folders + descendant groups. The empty text becomes "This group is empty. Drag folders or groups onto it or use "Move to group"."
  - **DnD**:
    - New `dragGroupId` ref, set in the group Row `onDragStart` for both kinds (the `locId`/`LOC_DRAG_TYPE` behaviour for pane drops stays) and cleared in `onDragEnd`.
    - `isOsDrag` also requires `!dragGroupId.current`. The folder drop handlers ignore a group drag.
    - A manual group header accepts the drop (`preventDefault` + `dragOver` highlight) only when `nestError(state.groups, dragged, g.id) === null`. Drop calls `onMoveGroup(dragged, g.id)`.
    - The `.standalone` zone accepts a group drag and calls `onMoveGroup(dragged, null)`. It renders when `standalone.length > 0 || state.groups.some(g => g.kind === 'manual' || g.parentId)`.
  - **Menus** (`groupMenu`):
    - Manual groups get "New subgroup", which expands the group if collapsed and sets `creating = { parentId: g.id, name: '' }`.
    - All groups get "Move to group: X" for every manual group X where `nestError(groups, g.id, X.id) === null` and `X.id !== g.parentId`, plus "Move to top level" when `g.parentId`.
    - The remove label becomes "Remove group…" for both kinds and opens the confirm.
  - **Subgroup input**: `creating` becomes `{ parentId: string | null; name: string } | null`. The input row renders at the top of the tree for `parentId === null` (today's behaviour) and at the top of the parent's children otherwise. Enter calls `onAddGroup(name, parentId)`.
  - **Confirm**:
    - State `confirmRemove: string | null`. When set, the header row of that group is replaced by an inline row like the CommandsPanel delete confirm (CommandsPanel.tsx:243-257).
    - Text: `Remove "<name>"` + (`, N subgroups` if N>0) + (`, M folders` if M>0) + `? Nothing is deleted on disk.` N and M come from `removalSet`, with N excluding the group itself.
    - Buttons: Remove (danger) and Cancel. Escape or blur cancels. The confirm row needs CSS in `styles.css`.
  - **App.tsx**:
    - `onAddGroup={async (name, parentId) => setState(await window.api.addGroup(name, parentId))}`.
    - `onMoveGroup={async (id, parentId) => setState(await window.api.moveGroup(id, parentId))}`.
    - `onRemoveGroup`: `const { groupIds, folderIds } = removalSet(state.groups, state.folders, id)`, then `closeTabsOf([...groupIds, ...folderIds, ...groupIds.flatMap(gid => state.groups.find(x => x.id === gid)?.children.map(c => c.id) ?? [])])`, then `setState(await window.api.removeGroup(id))`.
- Interface: only `window.api` from the contract and the `groupTree` helpers. The `folderMenu` and folder DnD keep their behaviour.

### T4 Smoke checks (`src/main/smoke.ts`)
- Inputs: the contract (`migrate`, `removeGroupData`, `moveGroupData`, `childId`, type `Persisted`), the existing `checkMigration` style, and the `test-discipline` skill.
- Outputs:
  - Fix the `group()` helper (492) to set `parentId: null`.
  - Add one `checkGroupTree(): CheckResult` to the results list. It works only on `migrate()` output, with no disk and no `data` global. It covers:
    1. **Old flat state**: a v4 file whose groups have no `parentId` migrates with every `parentId === null` and the folders' `groupId` kept. A file with a dangling parent, a parent that is a `parent`-kind group, and a cycle a↔b yields null for the first two and leaves no cycle (`subtreeGroupIds` of every group stays finite and a does not contain itself as a descendant).
    2. **moveGroup**:
       - Rejected: `moveGroupData(d, 'a', 'c')`, where c is a descendant of a, `moveGroupData(d, 'a', 'a')`, and a move into a parent-kind group. Each returns an error string and leaves `parentId` unchanged.
       - Allowed: moving a parent-kind group into a manual one, and `moveGroupData(d, 'b', null)`.
    3. **Cascade**: tree a > b > c (manual) with a parent-kind group p nested in b (path `p('repos')`).
       - Folders: one in a, one in c, plus a standalone folder s.
       - Commands owned by a, c, the c folder, `childId(p('repos','one'))`, and s. Snippets scoped to a and s. `selectedId` is the folder in c.
       - After `removeGroupData(d, 'a')`: only s remains in folders, no groups remain, only s's command and snippet remain, `selectedId === 's'`, and the summary counts match (groupIds 4, folderIds 2, commands 4, prompts 1).
- Interface: runs after T1. Verification is `yarn typecheck` and `yarn smoke` (use `fnm exec --using default yarn ...` if yarn is missing).

## Acceptance criteria
| # | Criterion | Proof |
|---|---|---|
| 1 | An old flat `terminals.json` loads unchanged: groups top level, folders in their groups, version stays 4 | smoke `checkGroupTree` (1); existing `checkMigration` still passes (`SCHEMA_VERSION === 4`) |
| 2 | Dangling, non-manual, self and cyclic `parentId` are nulled on load | smoke `checkGroupTree` (1) |
| 3 | Main rejects moving a group into itself, its descendant, or a non-manual group; parent-kind groups can go into a manual group; un-nest works | smoke `checkGroupTree` (2) |
| 4 | Removing a group removes all descendant groups and their folders, plus the commands and snippets of the group, its folders and the `child:` ids of removed parent groups; selection falls back | smoke `checkGroupTree` (3) |
| 5 | Nothing on disk is deleted | code review: `removeGroupData` touches only `d` (no fs calls) |
| 6 | Types, IPC, preload, MCP and renderer agree | `yarn typecheck` |
| 7 | Drag a group header onto a manual group nests it; dragging onto "Folders" un-nests; invalid targets show no highlight; dragging a group onto a pane still opens it there | manual check in `yarn dev` |
| 8 | "New subgroup", "Move to group: X" (no self, descendants or non-manual groups) and "Move to top level" work | manual check |
| 9 | Each group collapses independently and stays collapsed after restart | manual check (collapse a nested group, restart the app) |
| 10 | Removal shows the in-app confirm with the correct group and folder counts; Cancel or Escape keeps everything; Remove closes the tabs of all removed locations | manual check |
| 11 | The badge, the "N folders" subtitle and the group placeholder count descendants; a group holding only subgroups is not "empty" | manual check |
| 12 | MCP: `list_locations` shows `parentId`; `create_group` with `parent` nests; `move_group` rejects cycles with an error; `delete_group` reports `groupsDeleted`/`foldersDeleted` and the renderer closes their tabs | manual check through an MCP client in an app terminal; the cycle rejection path is shared with criterion 3 (`nestError`) |
| 13 | Whole suite still green | `yarn smoke` all PASS |

## Implementation status (implement, 2026-11-20)
- T1 DONE (see note under T1).
- T2 DONE: `list_locations` parentId, `create_group` parent, cascading `delete_group`, new `move_group`. Runtime MCP calls UNTESTED.
- T3 DONE: recursive tree, descendant counts, group DnD, menus, subgroup input, inline remove confirm, App handlers. Deviation: dropping a group on its current parent is accepted and moves it last among siblings (allowed by `nestError`). Manual UI checks (criteria 7-11) UNTESTED.
- T4 DONE: `group()` helper `parentId: null`, new `checkGroupTree`; expected counts matched the contract with no change.
- Verification: `yarn typecheck` exit 0; `yarn smoke` 13 PASS, 0 FAIL (incl. `group tree`).
- Acceptance: 1-6, 13 proven by typecheck/smoke/code review; 7-12 UNTESTED (need `yarn dev` and an MCP client).
