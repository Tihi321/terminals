# Research: nested groups

## Question
Where do groups live (model, store, IPC, sidebar DnD, other consumers) and what is the simplest way to let groups contain groups at any depth, with a cascade remove (updated requirement: removing a group removes all subgroups and folders inside, sidebar only, nothing on disk)?

## Answer
- Groups are a flat array, ordered by `order` (rewritten to array index on every save). Folders point to a group with `groupId`. There is no group reorder and no group-in-group concept today. All claims below confirmed by reading code.
- Simplest design: add optional `parentId: string | null` to `PersistedGroup` and `GroupView`. Keep `AppState.groups` a FLAT list (renderer, MCP, locations and commands all iterate it flat). The Sidebar builds the tree from `parentId`. No SCHEMA_VERSION bump is needed, because a missing `parentId` migrates to null.
- Cascade remove: collect the group id plus all descendant group ids, remove all folders whose `groupId` is in that set, and clean up per the table below.

## Path through the code

### Data model (src/shared/types.ts)
- `Folder` (72-79): `groupId: string | null`, "Manual group this folder belongs to". `FolderView` adds missing/isGit/branch.
- `GroupView` (98-113): id, kind 'parent'|'manual', name, path, order, collapsed, showHidden, missing, isGit, branch, children (ChildView[]), hiddenCount. No parent field.
- `AppState` (144-155): `folders: FolderView[]`, `groups: GroupView[]` (flat), commands, snippets, selectedId, settings, ui.
- API (262-337): `addGroup(name)` 268, `removeGroup(id)` 270, `renameGroup` 272, `moveFolder(id, groupId, beforeId?)` 274, `setGroupCollapsed` 275, `addFolderPaths(paths, groupId, beforeId?)` 284. No `moveGroup` or subgroup creation exists. `SCHEMA_VERSION = 4` at line 2.

### Store (src/main/store.ts)
- `PersistedGroup` 32-42: no parent field. `Persisted` 44-53.
- `migrate` 105-155: groups mapped at 119-130 (id, kind, name, path, order, collapsed, showHidden, hidden[]). Unknown fields are dropped, so `parentId` must be added here. Dangling `folder.groupId` is nulled at 151-153. Add the same for dangling or cyclic `parentId` (null them, walk up with a visited set).
- `loadStore` 157-189: sorts folders and groups by `order`. Backs up files older than the current version. A file with a newer version is refused (163-168). This is why not bumping the version is attractive: an old build would otherwise refuse the new file.
- `save` 191-203: `order = array index` for folders and groups. Group order is just array order, and groups are appended (`order: data.groups.length`, 322, 346).
- `getState` 233-268: builds `GroupView` per group (readGit and scanChildren for parent groups). Add `parentId` to the returned object.
- `upsertParentGroup` 314-329 and `pushManualGroup` 344-356: create groups with no parent. `addManualGroup(name)` 358 selects the new group. `createManualGroup` 365 (MCP) does not. Both need an optional `parentId` for "New subgroup".
- `removeGroup` 388-396: drops the group, sets `f.groupId = null` for members, deletes commands with `ownerId === id`, deletes snippets with `scope === id`, `fixSelection()`, save. It does not touch child groups (nothing to touch today).
- `removeFolder` 379-386: drops the folder, deletes commands where `ownerId === id`, snippets where `scope === id`, `fixSelection()`, save.
- `fixSelection` 371-377: only resets `selectedId` if it is not a `child:` id and matches no folder or group. It falls back to the first folder, then the first group.
- `moveFolder` 416-427: rejects a non-manual or unknown target by setting groupId null, then splices before `beforeId` or pushes to the end.
- `insertFolders` 505-527 (same manual-only check at 506). `getRoots` 283 (folder paths plus parent-group paths, used by `isInsideRoots`).
- `setGroupCollapsed` 438 (via `withGroup`) stores `collapsed` per group, so nested groups collapse independently with no change.

### What removing a folder or group cleans up today (for the cascade)
| Item | Where | Cleaned today |
|---|---|---|
| Folder entry | store.ts:380 | removed from `data.folders` |
| Commands scoped to the id | store.ts:381 / 391 | yes, `ownerId === id` (also the commands' targets go with them) |
| Prompts/snippets scoped to the id | store.ts:382 / 392 | yes, `scope === id` |
| selectedId | `fixSelection` 371 | yes, falls back to the first folder or group. A `child:` id is never reset |
| Open terminals and tabs with that locId | App.tsx:917-925 `closeTabsOf([id, ...children ids if parent group])` before the IPC call; App.tsx:822-840 does the same for removals pushed from main (MCP), diffing prev and next state | renderer-side only. Main never kills ptys on remove. For a group, children of a PARENT group are included (`g.children.map(c => c.id)`). Manual-group member folders are NOT closed today because they survive as standalone |
| Pane layout and last-tab refs referencing the loc | App.tsx:219-229 `normalize(cur, valid locs...)` | yes, automatically when the loc leaves `locs` (derived from state) |
| `collapsed` / `showHidden` / `hidden[]` | fields of the group record itself (store.ts:38-41) | vanish with the record. `hidden` for a parent group is a per-group list of lower-cased paths (`setChildHidden` 441), no separate store |
| Child-id commands/snippets | `child:<norm path>` ids (`childId` 74) can own commands (`ownerId`) | NOT cleaned: `removeGroup` only filters on the group id, so commands on child ids of a removed parent group stay orphaned. Existing gap. Decide whether the cascade also drops them |
| Persisted tabs `ui.tabs` | `sanitizeTabs` | tabs of removed locs are closed by `closeTabsOf`, which re-saves the session. Not verified in detail (inferred) |

For the cascade, the plan needs: (1) main store: compute descendant group ids (loop with visited set), remove those groups AND all folders whose `groupId` is in the set; filter commands (`ownerId`) and snippets (`scope`) by both group ids and removed folder ids (plus optionally child ids of removed parent groups); `fixSelection`. (2) renderer `onRemoveGroup` (App.tsx:921) must compute the same set from `state` to call `closeTabsOf` with group ids, removed folder ids, and parent-group child ids. (3) The onStateChanged diff (App.tsx:831) already closes tabs for any folder or group missing from the next state, but its `gone` list for a removed parent group adds children only from `prev` groups, so it works for nested ones too. (4) MCP `delete_group` (mcpTools.ts:549-565) says "A manual group's folders stay as standalone", computes `foldersKept`, and must be rewritten, and its description/return shape changed. (5) Confirmation UI: the cascade is destructive, and the sidebar currently has no confirm for removal.

### IPC wiring
- src/main/index.ts:322-344: `groups:addParent` 322, `groups:addManual` 326 (`addManualGroup(name)`), `groups:remove` 328, `groups:rename` 330, `folders:move` 331, `groups:collapsed` 334, `groups:showHidden` 335, `groups:childHidden` 336, `folders:addPaths` 343, `folders:remove` 327. Main pushes `state:changed` at index.ts:293 (MCP mutations).
- src/preload/index.ts:14-29 maps each API method to `inv(channel, ...)`.
- New IPC needed: `addGroup(name, parentId?)` (or a separate `addSubgroup`), `moveGroup(id, parentId|null, beforeId?)` with cycle check in the store (main must validate, as renderer input is untrusted), edits in `types.ts`, `preload`, `index.ts`.

### Sidebar rendering and DnD (src/renderer/src/Sidebar.tsx)
- `Row` 106-175: `indent` px = 8 + indent*18. Draggable if `drag` or `locId` is set. `onDragStart` sets `locDrag.id` and the `LOC_DRAG_TYPE` dataTransfer (for dropping onto panes) when `locId` set. Group rows pass `locId={g.id}`, so group rows are already draggable (for panes) but `drag` is undefined for parent groups and no-op handlers for manual groups (lines 408-429).
- Folder drag state is `dragId` ref (184) holding the dragged FOLDER id only. `isOsDrag` 281 = no `dragId` and `Files` in types. Group drag needs a separate marker (e.g. `dragGroupId` ref) so folder handlers and `isOsDrag` do not confuse them.
- `folderRow(f, indent)` 302-346: drop on a folder moves the dragged folder before it, in the target's group (`onMoveFolder(from, target.groupId, target.id)`).
- `groupBlock(g)` 348-494: always `indent={0}` for the header (376) and children at `indent 1` (453, 461). Members of a manual group = `folders.filter(f.groupId === g.id)` (188). The block `div.group` handles OS drops for manual groups only. Collapse chevron 393-404 calls `onToggleCollapse`. Subtitle for manual groups: `N folders` (379), so decide whether it should also count subgroups. Header count badge (351-353) sums `counts` of own and member folders, and must also sum descendants.
- Top level render: `state.groups.map(groupBlock)` at 565 (flat, all groups top-level, in array order), then a `Standalone` area (566-590) as the drop target for "ungroup" (`onMoveFolder(from, null)` 581). The tree wrapper (520-532) handles OS drops as standalone.
- Menus: `folderMenu` 223-243 builds "Move to group: X" for all manual groups other than the current one, plus "Remove from group". `groupMenu` 245-269: manual group menu is only Open to the side / Rename / Remove (253). Parent group menu has refresh/hidden/copy path/remove. Add "New subgroup", "Move to group: X" (excluding self and descendants), and "Move to top level" for any group.
- Parent-folder groups can be moved into manual groups (they are leaf-like: their children are discovered). They can't contain subgroups per the brief ("manual groups can contain other groups (manual or parent-folder kind)"). Nest rule: only `kind === 'manual'` can be a parent. Note the existing `moveFolder` validates `kind === 'manual'` (419), reuse that check for `parentId`.
- "New subgroup" needs a name input: the existing create-input (533-555) is only at the top of the tree via `creating` state, so it needs a parent target (state `creating` should hold `{parentId}`) rendered inside the parent group block.
- Props `Props` 35-62: add `onAddGroup(name, parentId?)`, `onMoveGroup(id, parentId|null, beforeId?)`.
- CSS styles.css: `.group` 543, `.group-children` 540, `.group-empty` 535 (padding-left 50px hard-coded, so nested empty hints need indent), `.drop-zone` 546, `.row.group-row .row-name` 467. Indent is inline style on `Row`, so nesting needs no new CSS except `.group-empty` padding.
- App.tsx wiring 906-938: handlers just call `window.api.*` and `setState`. Add the new ones here. `onRemoveGroup` 921 as described above.

### Other consumers of groups
- src/renderer/src/locations.ts:16-34 `buildLocs`: groups mapped with `groupId: null` (27); folders get `groupId: f.groupId`; parent-group children get `groupId: g.id`. Used for commands/snippets inheritance (see below). Nested manual groups would get `groupId: g.parentId` ... but note semantic below.
- Inheritance is ONE level: CommandsPanel.tsx:135 `c.ownerId === 'global' || selected.id || (selected.groupId && c.ownerId === selected.groupId)`; SnippetEditor.tsx:17-20 same; CommandEditor.tsx:46-48, 76-84 (scope choices and target suggestions use `selected.groupId` and group members); mcpTools.ts:161-184 (`scope: 'group'` uses `loc.groupId`, `loc.kind` check at 182), 235-243 `visibleCommands` (only `loc.groupId`), 465-473 snippets. Decision for the plan: either keep one-level inheritance (nested folders inherit only from the direct group; simplest, least risk) or walk ancestors. Walking ancestors requires touching all of these. Recommended: keep direct-group only unless the user asks.
- App.tsx:995 `members = loc.kind==='manual' ? state.folders.filter(f.groupId===loc.id).length` and 1084-1093 empty-group message: counts direct folders only. A group holding only subgroups would show "empty". Fix to count descendants.
- Selecting a manual group opens a placeholder view (no terminal). Group `locId` in panes/tabs works by id, unaffected.
- GitPanel `groups` (183) is unrelated (git file groups).
- mcpTools.ts: `findLocation` 46-58 builds from flat `state.groups` (fine). `list_locations` 389-411 returns manual groups with only `folderIds`: add `parentId`. `create_group` 509-522 (`store.createManualGroup(name)`: add optional parent). `delete_group` 549-565 (see above). `add_folders` 567-578 and `move_folder` 580-595 require `['manual']` groups (still fine with nesting). Probably add a `move_group` tool (optional). `rename_group` 537-547.
- mcp.ts: only 2 matches for "group", no group logic.
- index.ts:300-308 builds pty env: `TERMINALS_LOC_ID: loc?.id`. Unaffected (id-based). The `TERMINALS_LOC_ID` header flows to `mcpTools` as the location id. The mcpTools `locationInfo` (329-336) returns `group: {id,name,kind}` for the loc's `groupId`. Optionally add parent chain.
- smoke.ts: `checkMigration` 85-118 hard-codes `SCHEMA_VERSION === 4` (line 106) so bumping the version would require updating this. Lines 482-595 build fake `AppState` groups (492-516) for mcpTools pure-function checks. If `GroupView` gains a REQUIRED `parentId`, `group(...)` helper at 492 must add it (typecheck failure otherwise). Making it optional avoids that, but required is more explicit. Pick one.

## Reproduction
n/a (feature work, not a bug). Nothing was run.

## What the plan needs
1. Types: `GroupView.parentId: string | null`; new API methods (`addGroup(name, parentId?)`, `moveGroup`); update `TerminalsApi` doc comments.
2. Store: `PersistedGroup.parentId?: string|null`; `migrate` (default null; null out unknown/non-manual parent and cycles); `getState`; `pushManualGroup`/`addManualGroup`/`createManualGroup` with parent; `moveGroup(id, parentId, beforeId?)` with rules: target must exist and be `manual`, target must not be the group or any descendant; cascade `removeGroup`; helper `descendantGroupIds(id)` with a visited set. `moveFolder`/`insertFolders` unchanged (manual-only target check stays valid).
3. Group ordering: today only array order, with groups appended. For "drop a group before another" ordering `moveGroup` can splice `data.groups` like `moveFolder` does for folders (siblings keep relative array order, so rendering children = `groups.filter(g => g.parentId === x)` preserves order).
4. IPC: channels in index.ts, preload methods, `App.tsx` handlers; MCP: `list_locations` (+parentId), `create_group` (+parent), `delete_group` rewrite (cascade; report removed folder ids), optional `move_group`.
5. Sidebar: recursive `groupBlock(g, depth)` rendering, children = subgroups (`parentId === g.id`) + member folders, with `indent` = depth+1; top-level = groups with no `parentId`; drag a group row onto a manual group header = nest (new `dragGroupId` ref, separate from `dragId`); drop on the "Folders" standalone zone or a "top level" target = un-nest; menus ("New subgroup", "Move to group: X" listing manual groups excluding self and descendants, "Move to top level"); subgroup name input; descendant-aware count badge, "N folders" subtitle and empty hint; confirmation for cascade remove (suggested).
6. Cascade cleanup in main and renderer (see table above).
7. Tests: no unit-test framework. Only `yarn typecheck` and the smoke suite. Add smoke checks for: migration of old flat state (groups without `parentId`), cycle rejection in `moveGroup`, cascade remove (groups, folders, commands, snippets), and update the `SCHEMA_VERSION === 4` assertion only if the version is bumped.

## Tests and build (confirmed from package.json)
- `yarn typecheck` (tsc node + web projects).
- `yarn smoke` = `electron-vite build && electron . --smoke` (smoke.ts `runSmoke`, flag at index.ts:34; checks list at smoke.ts:626-634; checks are in-process and exercise `migrate`, panes, tabs, session, pty, mcpTools pure functions).
- `yarn dev` (electron-vite dev), `yarn build`, `yarn start` (preview), `yarn dist` / `dist:dir` (electron-builder Windows x64; the user's rule says "build the app" means the installer/exe).
- Per user's global rule, if `node`/`yarn` is missing from PATH use `fnm exec --using default <cmd>`.
- No UI automation exists for the drag and drop, so the sidebar DnD is UNTESTED unless run by hand in the app.

## Risks
- Cycles: the renderer can offer bad drops (self or descendant) and MCP could send anything. Validate in the store (`moveGroup`) and also guard in `migrate` (hand-edited or corrupt file) and in every tree walk (visited set) so a cycle can never hang the sidebar render. **inferred** (no cycle today because nesting does not exist).
- Rendering recursion: `state.groups.map(groupBlock)` (565) must change to roots-only. An orphan whose `parentId` points to a deleted group must be treated as top level (migrate should null it).
- Version bump: not bumping keeps old files loading and lets an older build open a new file (it will drop `parentId`, flattening the groups, and keep all folders). Bumping to 5 would make older builds refuse the file (store.ts:163) and needs smoke.ts:106 updated. Recommended: no bump (additive optional field).
- `fixSelection` and a selected folder or group that was removed by the cascade: falls back correctly, but tests for removing a selected nested folder are worth adding.
- Orphaned commands on `child:` ids already leak when a parent group is removed (existing gap, see table); with the cascade the leak grows to every removed parent-group descendant.
- Cascade remove is destructive for the sidebar entries and their commands/prompts, and the same flows run via MCP `delete_group` (it is flagged `destructive: true`, mcpTools.ts:555), which must be updated with its description.
- Terminals of removed folders are closed only by the renderer; main never kills the pty on removal, so an MCP removal relies on the renderer's `onStateChanged` diff at App.tsx:826-838 (works for any ids missing in `next`).
- One-level inheritance of commands/prompts (`groupId`) stays as is. A folder in a subgroup will not inherit commands from the grandparent group. Confirm with the user.
- Drag type confusion: `dragId` (folders) vs the OS drag detection `isOsDrag` (281) and `LOC_DRAG_TYPE` (group rows are already draggable to panes, so the nesting drop target must not break dropping group rows onto pane edges).
- `GroupView` field made required would break `smoke.ts:492` helper and any other literal constructors (typecheck will list them).
- Large Sidebar.tsx rewrite risk: `groupBlock` mixes manual and parent rendering, and the collapse state is per-group (fine for nesting).

## Open questions
- Should commands and prompts on a group be inherited by folders in nested subgroups (all ancestors) or only the direct group? (affects CommandsPanel, SnippetEditor, CommandEditor, mcpTools)
- Should the cascade also delete commands scoped to `child:` ids of removed parent groups (existing code does not)?
- Should the cascade remove ask for confirmation in the sidebar and show the counts?
- Can a parent-folder group be nested under a manual group by DnD (the brief says yes), and are parent-folder groups never containers (assumed: only manual groups contain)?
- Can a folder dragged from the group drop BEFORE a subgroup (mixed ordering of subgroups and folders within a group)? Today folders and groups are stored in separate arrays, so a group renders subgroups first and then folders (assumed simplest).
- Persisted `ui.tabs` cleanup on removal was not read in detail (`sanitizeTabs` in src/shared/session.ts).
- Is the version bump wanted for downgrade protection?
