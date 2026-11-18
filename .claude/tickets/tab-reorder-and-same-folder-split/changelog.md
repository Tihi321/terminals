# Changelog

## 2026-11-18 - tab-reorder-and-same-folder-split (REQ-0002)

Tabs can be reordered (drag, Alt+Shift+Left/Right), any tab can be split into its own pane (also within its own folder), and tabs, pane layout and per-pane active tabs are restored after a restart.

### Repo C:/projects/Personal/terminals, branch `feature/tab-reorder-and-same-folder-split` (from origin/master 69add63)

- `src/shared/types.ts`: `SCHEMA_VERSION` 4; `PersistedTab`; `UiState.tabs`; `PersistedPanes.active`; `PtyCreateRequest.shell`/`fallbackCwd`; `TerminalsApi.pathsExist`.
- `src/shared/panes.ts`: one folder may appear in several panes (dedupe removed); `active` ids carried through sanitize/`toPersisted`/`fromPersisted` (now returns `{ state, active }`); `focusLoc` keeps focus on a focused duplicate; new `paneShows`, `splitBeside`.
- `src/shared/tabs.ts` (new): `moveTab`, `shiftTab`, `neighbourTab`, `takenBy`, `paneOfTab`, `activateIn`, `reconcileActive`.
- `src/shared/session.ts` (new): `sanitizeTabs`, `toPersistedTabs`, `restorePaths`, `planRestore` (skips missing folders/files/deleted commands, shell cwd fallback, run anchors).
- `src/main/store.ts`: v3 -> v4 migration adds `ui.tabs`; `DEFAULT_UI.tabs`; `setUi` accepts sanitized `tabs`.
- `src/main/index.ts`: `pty:create` accepts `fallbackCwd` and a `shell` allow-listed to the configured or an available known shell; ptys tracked per webContents and killed on reload/navigation, renderer crash or destroy; new `fs:exists` IPC (roots-only, max 500 paths).
- `src/preload/index.ts`: `pathsExist`.
- `src/main/smoke.ts`: `checkPanes` updated; new `checkTabs`, `checkSession`; `checkMigration` expects v4 and drops garbage tabs.
- `src/renderer/src/TabBar.tsx`: own drag start (`tabDrag`), reorder drop with insertion marker, `elsewhere` class/tooltip, `shownElsewhere`/`onReorder` props; `Tab` gains `shell`, `startCwd`, `run.target`.
- `src/renderer/src/termRegistry.ts`: Alt+Shift+Arrow -> `onMoveTab`; OSC 7 and OSC 9;9 cwd reports -> `onCwd`.
- `src/renderer/src/TerminalView.tsx`: passes `shell`/`fallbackCwd` to `ptyCreate`.
- `src/renderer/src/styles.css`: `.tabbar` relative, `.tab-drop-marker`, `.tab.elsewhere`.
- `src/renderer/src/App.tsx`: per-pane active map (`activeByPane` + `lastByLoc`, reconciled every render); `showTab` placement rules; tab drop on a pane body half splits (`splitBeside`), tab bar drops only reorder; clicking a tab shown elsewhere focuses that pane; "shown in other panes" empty state; move shortcut in window and terminal; debounced (300 ms) session save, disabled until restore finishes; one-time restore at startup (re-runs command tabs in place).
- `README.md`: shortcut rows, "Session restore" section (command re-run warning, no scrollback), pty-on-quit line updated.

### Deviations
- Restored shells' `fallbackCwd` is held in an App ref (`fallbackById`), not on `Tab`.
- The "shown in other panes" empty state shows its New terminal button only for locations with a path (groups have none).
- Orchestrator fix: `sanitizeTab` dropped `preview` for diff tabs; it now keeps it (needed for M10).

### Verification
- `yarn typecheck`: exit 0.
- `yarn smoke`: exit 0, 11/11 PASS (interactive, steps, pty env, migration, settings, panes, tabs, session, write, mcp logic, git).
- Not run: manual checks M1-M13 in the running app (drag/split/reorder UI, Alt+Shift keys and Windows input-language risk M7, restart restore, renderer reload pty kill M13). UNTESTED.

### Follow-ups / limitations
- Default PowerShell/cmd do not emit OSC 7/9;9, so shells restore at their start cwd.
- Command tabs re-run on every launch (accepted, Q1).

### Commit status
Uncommitted on `feature/tab-reorder-and-same-folder-split`.
