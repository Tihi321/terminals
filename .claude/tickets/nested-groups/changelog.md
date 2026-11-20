# Changelog: nested-groups

## 2026-11-20 - nested-groups (REQ-0005)
Manual groups can now contain groups, manual or parent-folder kind, to any depth. Removing a group cascades through its subgroups. Main, IPC, MCP and the renderer are all updated.

### Repo `terminals`, branch `nested-groups` (base `origin/master` edb7b84)
- `src/shared/groupTree.ts` (new): pure helpers `subtreeGroupIds`, `nestError`, `childGroups` and `removalSet`, with cycle-safe walks.
- `src/shared/types.ts`:
  - `GroupView.parentId` added.
  - `addGroup(name, parentId?)` changed, and `moveGroup(id, parentId)` added.
  - The `removeGroup` doc now says it cascades.
- `src/main/store.ts`:
  - Persisted groups carry `parentId`, and `Persisted` is exported.
  - `migrate` nulls dangling, self and non-manual parents and breaks cycles. The schema stays at v4.
  - `getState` exposes `parentId`. New manual groups accept a manual parent; any other parent falls back to top level.
  - New pure `moveGroupData` and `removeGroupData`. A removal takes the subtree's groups, their folders, and the commands and prompts owned by those groups, folders and the direct `child:` ids of removed parent groups. The selection then falls back to a remaining folder or group. Nothing on disk is touched.
  - `removeGroup` now cascades. New `deleteGroup` (MCP summary) and `moveGroup`. `fixSelection` takes `d`.
- `src/main/index.ts`: `groups:addManual` takes `parentId`; new `groups:move`.
- `src/preload/index.ts`: `addGroup(name, parentId)` and `moveGroup(id, parentId)`.
- `src/main/mcpTools.ts`:
  - `list_locations` returns `parentId`.
  - `create_group` takes an optional `parent`.
  - `delete_group` cascades and returns `groupsDeleted`, `foldersDeleted`, `commandsDeleted` and `promptsDeleted`, with no `foldersKept`.
  - New `move_group` turns a `nestError` into a `ToolError`.
- `src/renderer/src/Sidebar.tsx`:
  - The tree renders recursively: subgroups first, then member folders, with indent per depth.
  - Badge, subtitle (`M groups, N folders`) and empty hint count descendants.
  - Drag a group header onto a manual group to nest it, or onto the Folders zone to un-nest it. Only valid targets highlight.
  - Menu items "New subgroup", "Move to group: X", "Move to top level" and "Remove group…".
  - Inline subgroup name input.
  - Inline remove confirm with group and folder counts. Escape or blur cancels it.
- `src/renderer/src/App.tsx`:
  - Removing a group closes the tabs of every removed group, folder and parent-group child.
  - New `onAddGroup(name, parentId)` and `onMoveGroup`.
  - A group counts as empty only when it has no descendant folders and no subgroups, and the empty text is new.
- `src/renderer/src/styles.css`: `.confirm-row` styles; a comment on `.group-empty`.
- `src/main/smoke.ts`: the `group()` helper sets `parentId: null`. New `checkGroupTree` covers migration, move rules and cascade removal with counts.

### Deviations
- `removeGroupData` also treats a selected `child:` id of a removed parent group as removed, so the selection falls back.
- `deleteGroup` saves only when something was removed.
- Dropping a group onto its current parent is accepted and moves it last among its siblings, because `nestError` allows it.

### Verification
- `yarn typecheck`: exit 0.
- `yarn smoke`: 13 PASS, 0 FAIL, including `group tree`.
- Not run: the manual UI checks in `yarn dev` (acceptance 7-11) and the MCP client checks (12).

### Follow-ups
- See `discoveries.md`: the `.group-empty` CSS padding is redundant.

### Commit status
Uncommitted on branch `nested-groups`.
