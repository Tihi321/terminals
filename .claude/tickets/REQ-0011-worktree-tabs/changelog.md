# Changelog: REQ-0011 worktree tabs

## 2026-11-26: Git worktrees in the sidebar, and a Branch view in the Git panel

Repo `C:/projects/Personal/terminals`, branch `feat/herdr-agent-workflow`.

### Files

- `src/shared/types.ts`: new `WorktreeView`, `GitBaseFile`, `GitBaseChanges` and `WorktreeStatus` types. Folders and children gain `worktrees` and `isMainWorktree`. Also adds `Settings.worktreeLayout`, a `base` diff mode, and 5 new `TerminalsApi` methods.
- `src/shared/settings.ts`: `worktreeLayout` setting, default `container`.
- `src/shared/session.ts`: persisted diff tabs accept mode `base`, but only with a 40-hex `base`.
- `src/shared/worktreePath.ts` (new): `safeDirName` and `worktreeTargetPath`, pure functions so the dialog can show a preview.
- `src/main/git.ts`: `isMainWorktree` and `readWorktrees`. These read git's worktree metadata on disk and share the HEAD parsing with `readGit`.
- `src/main/gitcli.ts`:
  - Exports `run`, `failText` and `repoRoot`.
  - `gitDiff` gets a `base` mode.
  - New `gitBaseChanges`, which lists committed, uncommitted and untracked changes against the merge-base.
  - New `parseNameStatus` and `parseWorktreePorcelain`.
- `src/main/worktree.ts` (new): `addWorktree`, `worktreeStatus`, `removeWorktree` and `resolveBase`.
  - Remove refuses locked worktrees and refuses uncommitted changes unless forced.
  - Remove retries on Windows lock errors.
  - Deleting the branch uses safe `-d` only.
- `src/main/store.ts`:
  - Worktree views, with worktree paths added to the allowed roots.
  - Parent-group scans skip `<repo>.worktrees`.
  - `repoBases` is persisted.
  - New `worktreeId`, `findWorktree` and `forgetWorktree`.
- `src/main/index.ts`, `src/preload/index.ts`: channels `worktree:add`, `worktree:status`, `worktree:remove`, `git:setBase` and `git:baseChanges`.
- `src/main/mcpTools.ts`: new `worktree` location kind in `list_locations` and location lookup.
- `src/main/smoke.ts`: new `checkWorktree()` covering add, the cross-check against the porcelain list, base changes and diff, base resolution, and remove (dirty refused, forced, unmerged branch kept). Also a session assertion for `base` diff tabs.
- `src/renderer/src/locations.ts`: `Loc.kind` gains `'worktree'` and `Loc` gains `parentLocId`.
- `src/renderer/src/WorktreeRows.tsx` (new): worktree rows under their repo row, with a context menu.
- `src/renderer/src/NewWorktreeDialog.tsx`, `RemoveWorktreeDialog.tsx` (new): dialogs to create a worktree and to confirm removing one.
- `src/renderer/src/Sidebar.tsx`:
  - "New worktree…" in the menu, plus a `GitBranchPlus` button on main working trees.
  - Worktree rows render with their repo row, in Activity mode too.
  - The working, agent-status, count and finished roll-ups include worktree ids.
- `src/renderer/src/App.tsx`:
  - Dialog wiring. Create opens a terminal in the new worktree; remove closes the worktree's tabs first.
  - Base diff tabs are deduplicated and restored.
- `src/renderer/src/GitPanel.tsx`: Branch sub-view, shown when HEAD is not on the base branch. It has a base picker, ahead count and totals, and opens a diff per file.
- `src/renderer/src/DiffView.tsx`, `gitUtil.ts`: `base` diff mode (no stage controls) and its labels.
- `src/renderer/src/SettingsDialog.tsx`: Worktree location select.
- `src/renderer/src/styles.css`: dialog and base-select styles.
- `README.md`: worktrees, the Git panel Branch view, the setting, and the MCP kind.

### Deviations

- `addWorktree` returns an extra `created` flag, so the base is recorded only for new branches.
- `resolveBase` returns a result object instead of throwing.
- `forgetWorktree` takes an optional `repoLocId`.
- `git:setBase` ignores an invalid base.
- A branch-delete refusal after a remove is shown with `alert()`, because the sidebar note state is internal to Sidebar.
- The Branch tab stays visible while it is active and erroring, so the error can be shown.

### Verification

- `yarn typecheck`: passed.
- `yarn smoke`: passed, all PASS lines including `worktree:` and `session:`.
- Not run: manual acceptance criteria 3-11 in the real app (UNTESTED).

### Follow-ups

- See `discoveries.md`: tabs of worktrees removed outside the app stay open, and there is a possible react-refresh lint warning.

### Commit status

Committed on `feat/herdr-agent-workflow` (see the git log; not pushed).
