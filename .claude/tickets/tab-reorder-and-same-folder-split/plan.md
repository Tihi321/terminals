---
status: done
request: REQ-0002
repos: [C:/projects/Personal/terminals]
branch: feature/tab-reorder-and-same-folder-split
updated: 2026-11-18
---
# Plan: tab reorder, same-folder split and tab restore

User request: "i want to be able to change order of top tabs and i want to be able to split view on tabs in folder as well, not only tab from different folder to be in split view".
Revision 2: the user answered the first round of questions. They chose: restore tabs now, keep the empty source pane, a click focuses the other pane, and Alt+Shift+Left/Right moves tabs.

Line numbers are from master `7f0b669`. Reading chosen: the **full** one. Any tab can be split into its own pane, including in its own folder. Tabs are reordered by mouse and keyboard. All tabs, the pane layout and each pane's active tab come back after a restart.

## 1. Scope

- **R1 Same-folder split.** One folder may be shown in several panes (still at most 4 panes, `MAX_PANES`, `panes.ts:5`). Each pane has its own active tab. Dropping a tab on the left/right half of any pane's body (the terminal area, not the tab bar) opens a new pane with that tab. This includes dropping a tab of the pane's own folder on its own pane.
- **R2 Reorder by drag and drop** inside a tab bar, with a visible insertion marker. A drop on a tab bar only reorders; a drop on a pane-body half only splits.
- **R3 Alt+Shift+Left / Alt+Shift+Right** move the focused pane's active tab one place left/right in its folder's list. They work whether a terminal or anything else in the window has focus. Ctrl+Shift+PgUp/PgDn stay as they are: xterm scrolls the view (D13).
- **R4 Restore after restart.** Restored: every tab in its saved per-folder order, the pane layout (same-folder panes included) and each pane's active tab.
  - Shell tabs: title, shell executable, and the last known cwd (else their start cwd).
  - File viewer tabs and diff tabs.
  - Command-run tabs: these are **re-run** on launch. The user chose this knowingly; a re-run can start servers.
  - Skipped: tabs of a folder that is gone or missing on disk, file tabs whose file is gone, diff tabs whose folder is gone, and command tabs whose saved command was deleted.
  - The session is saved after changes (debounced) and written to disk right away. Schema v3 → v4 with a migration.
- README: shortcut rows, and a short section on splitting, reordering and restore (including the command re-run warning).

## 2. Out of scope (do not build)

- Restoring scrollback or terminal output, the exited/failed state of a tab, or the environment or history of a shell.
- Showing one tab in two panes at once (mirroring), or the same xterm in two DOM places.
- Moving a tab to another folder (dropping a tab of folder Y on a tab bar of folder X does nothing).
- Vertical splits, more than 4 panes, dragging pane headers to reorder panes.
- Ctrl+PgUp/PgDn or Ctrl+Tab tab switching, a split shortcut, wrap-around when moving a tab past an end.
- Sidebar "Open to side" or a sidebar folder drag creating a second pane for a folder already shown (both keep today's focus/move behaviour, `dropOnEdge`).
- Per-command "do not re-run on restore" options, or a confirmation prompt before re-running (see Q1).
- Tab context menu, dragging tabs to the sidebar or to a new window, MCP tool changes, a new test framework.

## 3. Design decisions (with evidence)

**D1 A tab is active in at most one pane.** An xterm is opened once (`TerminalView.tsx:167-169`, `entry.started`). All terminals are rendered once in a stable list and moved by positioning, never reparented (`App.tsx:863-885`). App positions each `TerminalView` over the one pane whose active tab it is.

**D2 Active tab per pane, plus memory per folder.** Today's `activeByLoc: Record<locId, tabId>` (`App.tsx:82`) cannot express two panes of one folder. It is replaced by:
- `activeByPane: Record<paneId, tabId>` (state);
- `lastByLoc: Record<locId, tabId>` (ref): the last tab activated per folder. A pane repointed to a folder by a sidebar click shows that tab, as today.
Every render computes the effective map with the pure `reconcileActive` (T1) and keeps it in `activeRef.current`. Rendering, shortcuts, drop handlers and saving read only that reconciled map.

**D3 Panes of the same folder share one ordered tab list.** The order is the order of `tabs` (`App.tsx:80`) filtered by `locId` (`App.tsx:748`). Every pane of folder X shows the same strip. A tab active in another pane gets class `elsewhere` (dimmed title, tooltip line "(shown in another pane)").

**D4 Clicking a tab that is active in another pane focuses that pane** (and with it that pane's terminal, through `TerminalView`'s `focused` effect, `TerminalView.tsx:188-199`). The tab is not moved. A reorder drop follows the same rule: the list is reordered, and the tab becomes active in the target pane only if no other pane has it active. If another pane has it active, it stays there.

**D5 A pane with nothing to show.**
- The folder has no tabs: today's "No terminals open here" (`App.tsx:844-858`).
- The folder has tabs, but all are active in other panes: a new empty state, "All terminals of this folder are shown in other panes.", with a New terminal button that creates a tab active in this pane, plus the Ctrl+Shift+T hint.
`reconcileActive` refills the pane as soon as a tab of its folder is free.

**D6 A tab drop on a pane-body half always adds a pane.** (The user rejected auto-closing the source pane.) `splitBeside` inserts a new pane beside the target, taking half the target's width, and focuses it. The dragged tab becomes active in the new pane (`activateIn`). The pane it was active in falls back to its next free tab; if it has none, it stays with the D5 empty state.
- At 4 panes a tab split is refused (no hint).
- Dropping a folder's only tab on the pane that shows it is a no-op (no hint).
- This changes today's behaviour for single-tab folders: dragging the only tab onto another pane used to *move* that folder's pane (`dropOnEdge`, `panes.ts:120-133`, via `App.tsx:743`). Now it adds a pane and leaves the source pane empty.
- Sidebar folder drags (`LOC_DRAG_TYPE`) keep `dropOnEdge`. Their "nothing to do" check becomes "the target pane already shows this folder" (`paneShows`), not `indexOfLoc(...) === index` (`App.tsx:208`), because `indexOfLoc` finds only the first pane of a folder.

**D7 What is persisted (schema v4).** Tabs are in-memory only today: `useState<Tab[]>([])` (`App.tsx:80`), no tab data in `UiState` (`types.ts:37-45`) or `migrate` (`store.ts:139-147`). New, in `src/shared/types.ts`:
```ts
export interface PersistedTab {
  /** Id inside the saved snapshot; restore gives every tab a fresh id. */
  id: string
  locId: string
  kind: 'shell' | 'command' | 'diff' | 'file'
  title: string
  /** shell: last known cwd, else start cwd; command: target cwd; diff: repo folder; file: the file path. */
  cwd: string
  /** shell only: executable it ran (AppState.resolvedShell at creation). */
  shell?: string
  /** shell only: cwd the tab was started in; fallback when `cwd` cannot be used. */
  startCwd?: string
  diff?: { folder: string; mode: 'unstaged' | 'staged' | 'untracked' | 'commit'; path: string; hash?: string }
  file?: string
  preview?: boolean
  run?: { commandId: string; runId: string; target: number }
}
```
- `UiState.tabs: PersistedTab[]` (default `[]`).
- `PersistedPanes.active?: (string | null)[]`: one entry per `locIds` entry, holding the snapshot tab id active in that pane. This is how the pane → active-tab mapping survives even though pane and tab ids are regenerated.
- `SCHEMA_VERSION` goes 3 → 4 (`types.ts:2`). `migrate` (`store.ts:104-150`) adds `ui.tabs = sanitizeTabs(u.tabs)`, which is `[]` for v1-v3 files. `loadStore` already backs up older files to `terminals.json.v3.bak` and refuses newer ones (`store.ts:159-174`).
- Duplicate `locIds` are now allowed in `sanitizePersisted`/`normalize`: remove the `seen` dedupe at `panes.ts:40-47` and `panes.ts:76-83`. The other rules stay (string, non-empty, valid, at most 4, fractions renormalised, focused remapped). `active` is cleaned to the same kept indexes; a non-string becomes null.
- Persisted ids are the runtime tab ids at save time. On restore every tab gets a new `crypto.randomUUID()`, so a renderer reload can never hit main's "Duplicate terminal id" (`index.ts:365`). The snapshot ids are used only to map pane actives and run anchors.

**D8 When to save.** App runs one debounced `saveSession()` (300 ms) after any change to `tabs`, the pane layout or the reconciled active map, and after a cwd report (D10). It sends `window.api.setUi({ panes: toPersisted(ps, active), tabs: toPersistedTabs(tabs, cwdById) })`. `setUi` already writes the file synchronously (`store.ts:532-541`, `save()` at 189-201). This replaces the immediate pane saves (`App.tsx:145-146`, `App.tsx:124-125`). The live divider drag still skips saving (`persist = false`).
- Saving is **disabled until restore has finished**, so an early save cannot wipe the saved session.
- On quit, at most the last 300 ms of changes can be lost. Before-quit kills the ptys (`index.ts:430-433`) and the renderer then marks tabs exited, but exit/status fields are not persisted, so that changes nothing saved. Closing the window only hides it to the tray (`index.ts:101-106`); the session is not touched.
- Divider widths go through the same path at drag end.

**D9 How to restore (renderer, at startup).** In the mount effect (`App.tsx:115-127`), after `getState()`:
1. Build the panes with `fromPersisted`, which now also returns the cleaned `active` ids aligned to the returned panes (T1 contract).
2. Ask main which paths exist: `window.api.pathsExist([...file paths, ...diff folders, ...shell cwds])` → `boolean[]` (new IPC; true only when `store.isInsideRoots(p) && existsSync(p)`).
3. Call the pure `planRestore` (T1). It returns the tabs to create in saved order with fresh ids, the runs to re-run, and the pane → tab mapping. Skips: locations missing from `buildLocs` or with `missing: true`; file tabs whose file is gone; diff tabs whose folder is gone; command tabs whose command no longer exists. A shell tab whose last cwd is gone uses `startCwd`, else the folder path.
4. Create all non-command tabs in one `commitTabs` (`createTerm(id)` for shells). Set `counters[locId]` to the highest trailing number found in the restored shell titles of that folder, so new tabs do not repeat titles (`App.tsx:220-222`).
5. Re-run each planned run with `runCommand(cmd, locId, anchor)`: the current definition of the saved command, in the saved folder, with the tabs inserted before `anchor`. The anchor is the new id of the next restored non-command tab that followed the run's first tab in that folder, or null for the end. Runs start in saved order. Sequential targets started later are appended as today. Pane actives that pointed at a command tab map to the new tab with the same `run.target`.
6. Set `activeByPane` from the mapping, then `lastByLoc` from it. Enable saving and save once.
ptys start when each `TerminalView` mounts (`TerminalView.tsx:163-181`), which happens after the panes exist, because panes are built first in the same effect. Hidden terminals start too; they are fitted when shown, as today.

**D10 cwd tracking.** None exists today: no OSC handler anywhere in `src`. Default PowerShell and cmd do not report their cwd, so in practice a shell restores at its start cwd: the folder, or the directory from "Open terminal here". T3 adds cheap xterm OSC handlers in `termRegistry.ts`: OSC 7 (`file://host/C:/path`, URL-decoded) and OSC 9;9 (`9;"C:\path"`, the ConEmu/Windows Terminal form that oh-my-posh and starship can emit). Each calls a new hook `onCwd(id, path)`. App keeps `cwdById` in a ref (no re-render) and schedules a save. Main's `pty:create` only accepts saved roots (`index.ts:361-364`), so the request gets a `fallbackCwd` (D11).

**D11 pty creation for restored shells.** `PtyCreateRequest` (`types.ts:132-141`) gains:
- `shell?: string`: main uses it only when it is the configured shell (`store.getShell()`) or the resolved path of an available `listShells()` entry (`pty.ts:35-42`), compared case-insensitively. Anything else falls back to `store.getShell()`, so the renderer cannot launch arbitrary executables.
- `fallbackCwd?: string`: used when `cwd` fails the existence/roots check and `fallbackCwd` passes it.
Command tabs ignore both (steps use `stepsShell`, `index.ts:378-380`). New shell tabs store `shell = state.resolvedShell` and `startCwd = cwd` on the `Tab` object.

**D12 Drop zones do not overlap.** `dropTargetAt` (`App.tsx:198-210`) returns null when the event target is inside `.pane-head`. The tab bar handles its own `dragover`/`drop` and calls `stopPropagation()` when it accepts. Terminal hosts sit below the head (`styles.css:797-800`).

**D13 Keyboard.**
- **Today:** there is no Electron app menu (`index.ts:414`, `Menu.setApplicationMenu(null)`). No Alt or Alt+Shift binding exists in `App.tsx`, `termRegistry.ts` or `Keys.tsx` (`Keys.tsx` only renders key caps). `FileViewer.tsx:227` ignores Alt.
- **What xterm does with the keys:** Ctrl+Shift+PgUp/PgDn stay a scroll by page, because xterm checks Shift before Ctrl (`node_modules/@xterm/xterm/src/common/input/Keyboard.ts:201-220`). Alt+Shift+Left/Right would reach the shell as `ESC[1;4D`/`ESC[1;4C`; PSReadLine has no default binding for them. Taking them is the accepted cost.
- **Inside a terminal:** `termRegistry.ts` gets a branch, before the others (`termRegistry.ts:219-271`): `ev.altKey && ev.shiftKey && !ev.ctrlKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')` → `ev.preventDefault()`, `hooks.onMoveTab(-1 | 1)`, `return false`.
- **Rest of the window:** the window listener (`App.tsx:531-532`) returns early on `!e.ctrlKey || e.altKey`, so the Alt+Shift branch must sit **before** that early return. It keeps the `defaultPrevented` guard, so the two handlers never both fire.
- **Windows risk:** Left Alt+Shift is the default input-language switch, which fires on release of the modifiers without another key. Check it manually (M7).
- Moving does not wrap.

**D14 Closing.**
- Closing a tab: the pane it was active in gets `neighbourTab` (skipping tabs active elsewhere) or the D5 state. `lastByLoc` moves to the neighbour or is deleted (replaces `App.tsx:400-409`).
- Removing a folder or group shown in two panes: `closeTabsOf` (`App.tsx:581-586`) closes its tabs. `normalize` then drops every pane of the location, falling back to one pane if none are left (`panes.ts:84-89`).
- Closing a pane (`App.tsx:188-195`) leaves its tabs in the folder's list.
- Closed tabs vanish from the next save, so they are not restored.

**D15 Where a new tab goes.** It is appended at the end of its folder's list (`App.tsx:223`). It becomes active in the first pane on this list that applies:
1. the caller's pane (the "+" button and the empty-state buttons pass theirs; Ctrl+Shift+T passes the focused pane);
2. the pane already showing it;
3. the focused pane, if it shows the folder;
4. the first pane that shows the folder;
5. none (only `lastByLoc` is set).
The `showTab` helper implements this and replaces every `setActiveByLoc` call: `App.tsx:224, 249, 257, 262, 276, 282, 287, 345, 495, 742, 766`.

**D17 A renderer reload kills that renderer's ptys.** Today ptys are killed only on `before-quit`/`window-all-closed` (`index.ts:430-441`). A dev reload, or a window recreated by `showWindow` (`index.ts:110-114`), would therefore keep the old shells alive while restore starts a second set, and command runs would be duplicated. Main tracks which webContents created each pty and kills them all when that webContents reloads/navigates (main frame), its render process is gone, or it is destroyed (T2).

**D16 `focusLoc` with duplicates.** `focusLoc` (`panes.ts:105-109`) returns `s` when the focused pane already shows the folder; otherwise it focuses the first pane that shows it; otherwise it repoints the focused pane. Without this, moving focus from a Y pane to the second X pane calls `select(X)` (`App.tsx:154`). The selection effect (`App.tsx:165-168`) then jumps focus to the first X pane.

## 4. Files and modules to touch

| File | Change | Task |
|---|---|---|
| `src/shared/types.ts` | `SCHEMA_VERSION = 4`; `PersistedTab`; `UiState.tabs`; `PersistedPanes.active?`; `PtyCreateRequest.shell?`, `fallbackCwd?`; `TerminalsApi.pathsExist` | T1 |
| `src/shared/panes.ts` | no dedupe; `active` carried in `sanitizePersisted`/`fromPersisted`/`toPersisted`; `focusLoc` (D16); `paneShows`, `splitBeside` | T1 |
| `src/shared/tabs.ts` (new) | tab order + active-tab helpers | T1 |
| `src/shared/session.ts` (new) | `sanitizeTabs`, `toPersistedTabs`, `planRestore` | T1 |
| `src/main/smoke.ts` | pure checks (`checkPanes` update, `checkTabs`, `checkSession`) and the fake state's `ui.tabs` | T1 |
| `src/main/store.ts` | `migrate` v4 (`ui.tabs`), `DEFAULT_UI.tabs`, `setUi` accepts `tabs` | T2 |
| `src/main/index.ts` | `pty:create` `shell`/`fallbackCwd` (D11); `fs:exists` IPC; pty ownership per webContents (D17) | T2 |
| `src/preload/index.ts` | `pathsExist` | T2 |
| `src/main/smoke.ts` | `checkMigration` update (v4) | T2 (after T1) |
| `src/renderer/src/TabBar.tsx` | `tabDrag`, own drag start/end, reorder drop + marker, `elsewhere`, `Tab.shell`/`startCwd`/`run.target` | T3 |
| `src/renderer/src/termRegistry.ts` | `onMoveTab` and `onCwd` hooks, Alt+Shift+Arrow branch, OSC 7 / 9;9 handlers | T3 |
| `src/renderer/src/TerminalView.tsx` | props `shell?`, `fallbackCwd?` passed to `ptyCreate` | T3 |
| `src/renderer/src/styles.css` | `.tabbar { position: relative }`, `.tab-drop-marker`, `.tab.elsewhere` | T3 |
| `README.md` | shortcuts, split/reorder/restore section | T3 |
| `src/renderer/src/App.tsx` | everything in D2-D6, D8-D9, D12-D16 | T4 |

Not touched: `Keys.tsx`, `Sidebar.tsx`, `pty.ts`, MCP files.

## 5. Tasks for workers

Order: **T1 alone** → **T2 and T3 in parallel** (disjoint files; T2 owns `smoke.ts` in that phase) → **T4 alone** (only task editing `App.tsx`). Final check after T4: `yarn typecheck` and `yarn smoke`. If node or yarn are not on PATH, run `fnm exec --using default yarn typecheck` / `... yarn smoke`. Expected interim failures: after T1, `store.ts` and `App.tsx` fail typecheck (new `UiState.tabs`, API member); after T2/T3 only `App.tsx` may fail. Each task reports only errors in files it does not own.

### T1 Shared types, pure logic, pure smoke checks

Inputs: `src/shared/types.ts`, `src/shared/panes.ts`, `src/main/smoke.ts` (`checkPanes` 142-185, fake state 357, `runSmoke` 446-456), D6, D7, D9, D16.

Contract (exact; T2-T4 rely on it):

`types.ts`: as in D7 and D11. Also add `pathsExist(paths: string[]): Promise<boolean[]>` to `TerminalsApi`.

`panes.ts`:
- `sanitizePersisted(raw): PersistedPanes | null`: no dedupe; `active` kept aligned to kept indexes (missing → all null); output always has `active` of length `locIds.length`.
- `toPersisted(s: PaneState, active?: Record<string, string>): PersistedPanes | null`: `active[i] = active?.[pane.id] ?? null`.
- `fromPersisted(p, valid, fallback, mkId): { state: PaneState; active: (string | null)[] }`. **Signature change**: `active` is aligned to `state.panes`, all null for the fallback pane. T4 updates the caller at `App.tsx:119`; T1 updates smoke callers.
- `normalize`: no dedupe; the rest unchanged.
- `focusLoc`: D16.
- `paneShows(s, index, locId): boolean`.
- `splitBeside(s, locId, target, side, mkId): PaneState`. Returns `s` when `target` is out of range or `s.panes.length >= MAX_PANES`. Otherwise inserts `{ id: mkId(), locId }` at `side === 'right' ? target + 1 : target`, halves the target's fraction between the two, and focuses the new pane (the caller reads it as `next.panes[next.focused]`).
- Other functions unchanged.

`tabs.ts` (no DOM; imports `type Pane`):
```ts
export interface TabRef { id: string; locId: string }
export type ActiveMap = Record<string, string> // paneId -> tabId
/** Moves `id` directly before `beforeId` within its folder; null = after the folder's last tab. Same array when nothing changes,
 *  `id` is unknown, or `beforeId` belongs to another folder. Other folders' tabs keep their indexes. */
export function moveTab<T extends TabRef>(tabs: T[], id: string, beforeId: string | null): T[]
/** One place left/right within its folder; no wrap; same array at an edge or for an unknown id. */
export function shiftTab<T extends TabRef>(tabs: T[], id: string, dir: -1 | 1): T[]
/** Next tab of the same folder after `id`, else the previous, skipping `taken` and `id`; undefined when none. */
export function neighbourTab(tabs: TabRef[], id: string, taken: Set<string>): string | undefined
/** Tab ids active in any pane except `exceptPaneId`. */
export function takenBy(active: ActiveMap, exceptPaneId?: string): Set<string>
/** Pane id whose active tab is `tabId`, or undefined. */
export function paneOfTab(active: ActiveMap, tabId: string): string | undefined
/** Makes tabId active in paneId; the other pane that showed it gets neighbourTab(...) or loses its entry. Drops unknown panes. Pure. */
export function activateIn(panes: Pane[], tabs: TabRef[], active: ActiveMap, paneId: string, tabId: string): ActiveMap
/** Panes visited focused first, then left to right. Pass 1 keeps an entry whose tab exists, belongs to the pane's locId and is not taken.
 *  Pass 2 fills panes without an entry: lastByLoc[locId] if valid and free, else the folder's first free tab, else none.
 *  Unknown panes dropped. Returns `active` itself when the entries are unchanged. */
export function reconcileActive(panes: Pane[], focused: number, tabs: TabRef[], active: ActiveMap, lastByLoc: Record<string, string>): ActiveMap
```

`session.ts` (no DOM):
```ts
export const MAX_SAVED_TABS = 200
/** Any input -> clean list: drops non-objects, unknown kinds, empty locId/cwd, duplicate ids, kind-specific missing fields
 *  (diff needs folder/path and a valid mode, commit needs hash; file needs file; command needs run.commandId/runId, run.target >= 0 integer);
 *  titles become strings; keeps at most MAX_SAVED_TABS; keeps order. */
export function sanitizeTabs(raw: unknown): PersistedTab[]
/** Structural input so it does not depend on the renderer Tab type. Live cwd (from OSC) wins over tab.cwd for shells. */
export interface SessionTab { id: string; locId: string; kind: PersistedTab['kind']; title: string; cwd: string; shell?: string; startCwd?: string;
  diff?: PersistedTab['diff']; file?: string; preview?: boolean; run?: { commandId: string; runId: string; target?: number } }
export function toPersistedTabs(tabs: SessionTab[], liveCwd: Record<string, string>): PersistedTab[]
export interface RestoreCtx {
  locs: Map<string, { path: string | null; missing: boolean }>
  commandIds: Set<string>
  /** Result of pathsExist for the paths listed by restorePaths(). */
  exists: (path: string) => boolean
  mkId: () => string
}
/** Paths whose existence planRestore needs: file tabs' files, diff folders, shell cwds and startCwds. */
export function restorePaths(tabs: PersistedTab[]): string[]
export interface RestorePlan {
  /** Non-command tabs in saved global order, with fresh ids; shells carry cwd (already resolved to an existing dir) and fallbackCwd. */
  tabs: (PersistedTab & { newId: string; fallbackCwd?: string })[]
  /** One entry per saved run (first appearance order). anchor = newId of the next restored non-command tab of the same folder after the run's first tab, or null. */
  runs: { commandId: string; locId: string; anchor: string | null; snapshotIds: Record<number, string> }[]
  /** snapshot tab id -> new id, for non-command tabs. */
  idMap: Record<string, string>
}
export function planRestore(saved: PersistedTab[], ctx: RestoreCtx): RestorePlan
```
Skip rules are as in D9 step 3. Shell cwd: `cwd` if it exists, else `startCwd` if it exists, else the folder path. `fallbackCwd` = the folder path. If two saved runs share a `commandId`, keep only the first.

Smoke, pure parts (test-discipline: few, important; extend, do not duplicate):
- `checkPanes`: dirty-layout expectation becomes `'a,b,a,c'` (focused 0) with `active` aligned. `fromPersisted` returns `{state, active}`, and active ids follow the kept panes when one pane is dropped. `normalize` keeps `a,a,b`. `focusLoc` keeps focus on a focused duplicate and focuses the first match from another folder. `splitBeside`: self-split `a` → `a,a`, 0.5/0.5, focused 1; a 5th pane returns the same object.
- New `checkTabs`: `moveTab` before, to the end, and ignoring another folder's `beforeId`, with an interleaved tab keeping its index. `shiftTab` at an edge returns the same array. `reconcileActive`: the focused pane wins a conflict, a taken-only folder pane gets no entry, `lastByLoc` is preferred, and a valid map returns the same reference. `activateIn` gives the old pane its neighbour.
- New `checkSession`: `sanitizeTabs` drops bad/duplicate/unknown-kind entries and keeps order. `planRestore` keeps per-folder order, skips a missing folder, a missing file and a deleted command, falls back from a gone cwd to `startCwd`, computes a run anchor, and maps ids.
- Fake state at `smoke.ts:357`: add `tabs: []`. Register `checkTabs()` and `checkSession()` in `runSmoke`.

Done when: `tsc -p tsconfig.node.json` errors exist only in `store.ts`/`index.ts`/`preload` (T2's files), and the new pure checks pass when run. They can be run once T2 compiles; otherwise T1 verifies them with a temporary script under `.claude/temp/` and deletes it.

T1 result: done. Contract implemented as written. Pure checks (`checkPanes`, `checkTabs`, `checkSession`) pass via a temporary transpile-and-run script (deleted). `tsc -p tsconfig.node.json` errors remain only in `store.ts` (`UiState.tabs`), `preload/index.ts` (`pathsExist`) and `smoke.ts:94` (`checkMigration` still expects `SCHEMA_VERSION === 3`, T2's job).

### T2 Main process and preload (after T1; parallel with T3)

Inputs: `src/main/store.ts` (`DEFAULT_UI` 54, `migrate` 104-150, `setUi` 532-541), `src/main/index.ts` (`pty:create` 360-387, IPC block 255-358), `src/preload/index.ts`, `src/main/smoke.ts` `checkMigration` (80-99), D7, D11.

Changes:
- `DEFAULT_UI.tabs = []`. `migrate`: `tabs: sanitizeTabs(u.tabs)`, with the comment `// v3 -> v4 added ui.tabs (saved session) and panes.active`. `setUi`: `if (patch.tabs !== undefined) u.tabs = sanitizeTabs(patch.tabs)`.
- `pty:create`: shell allow-list and `fallbackCwd` as in D11. Errors keep today's messages when both cwd candidates fail.
- pty ownership (D17): in `index.ts` keep `owners: Map<number, Set<string>>` (webContents id → pty ids), filled in `pty:create` (`e.sender.id`) and emptied in `onExit`/`pty:kill`. Add `killPtysOf(wcId)` (kills and removes that set from `ptys` and `owners`). In `createWindow`, hook `win.webContents`: `'did-start-navigation'` when `details.isMainFrame && !details.isSameDocument` (reload or navigation), `'render-process-gone'`, and `'destroyed'` → `killPtysOf(id)`. Capture the id at creation, because `webContents.id` cannot be read after destroy. `killAllPtys` also clears `owners`.
- `ipcMain.handle('fs:exists', (_e, paths: string[]) => paths.map(p => typeof p === 'string' && store.isInsideRoots(p) && existsSync(p)))`, capped at 500 entries. Preload: `pathsExist: (paths) => inv('fs:exists', paths)`.
- `checkMigration`: expect `SCHEMA_VERSION === 4`; a v3 file migrates with `ui.tabs` `[]` and its folders/commands/snippets kept. A v4 file with one valid and one garbage tab keeps exactly the valid one.

Done when: `tsc -p tsconfig.node.json` passes and `yarn smoke` passes every check. `App.tsx` errors in the web project are allowed.

T2 result: done. `tsc --noEmit -p tsconfig.node.json` passes; electron-vite build plus `electron . --smoke` passes all 11 checks (run as separate commands because `yarn` is not on the fnm PATH). Not run in the live app: pty reload kill (M13), `fs:exists`, shell/fallbackCwd.

### T3 Renderer pieces outside App.tsx (after T1; parallel with T2)

Inputs: `TabBar.tsx`, `termRegistry.ts`, `TerminalView.tsx`, `styles.css` (tabs 579-711, panes 740-800), `README.md` (163-178), D3, D4, D10, D12, D13.

Contract:
- `TabBar.tsx`:
  - `Tab` gains `shell?: string`, `startCwd?: string`, and `run.target?: number`.
  - `export const tabDrag: { tab: Tab | null } = { tab: null }`. TabBar's own `onDragStart` sets it, calls `setData(TAB_DRAG_TYPE, t.id)` and sets `effectAllowed = 'move'`. `onDragEnd` clears it and the marker, then calls `p.onDragEnd()`.
  - Props: remove `onDragStart`; add `shownElsewhere: Set<string>` and `onReorder: (id: string, beforeId: string | null) => void`.
  - Each tab gets `data-tab-id`. Tabs in `shownElsewhere` get class `elsewhere` and the tooltip line "(shown in another pane)".
  - `.tabbar` `onDragOver` accepts only when `tabDrag.tab?.locId === p.loc.id`. It then calls `preventDefault()` and `stopPropagation()`, sets `dropEffect = 'move'`, and sets the marker. `beforeId` is the first tab whose midpoint is right of `clientX`, with the marker x at its `offsetLeft`; with no such tab, `beforeId` is null and x is the last tab's right edge. Other drags are ignored.
  - `onDragLeave` (relatedTarget outside the bar) clears the marker. An accepted `onDrop` calls `preventDefault()` and `stopPropagation()`, clears the marker and always calls `p.onReorder(tab.id, beforeId)`.
  - Render `<div className="tab-drop-marker" style={{ left: x }} />` while the marker is set.
  - The scroll-into-view effect also depends on `p.tabs.map((t) => t.id).join()`.
- `termRegistry.ts`: add `onMoveTab(dir: -1 | 1)` and `onCwd(id: string, cwd: string)` to `TermHooks` and to the default hooks, plus the Alt+Shift+Arrow branch (D13). In `createTerm`, register `term.parser.registerOscHandler(7, ...)` (parse `file://<host>/<path>`, `decodeURIComponent`, strip the leading `/` before a drive letter, `/` → `\`) and `registerOscHandler(9, ...)` (only data starting `9;`, strip quotes). Each calls `hooks.onCwd(id, path)` and returns true; anything unparsable returns false.
- `TerminalView.tsx`: optional props `shell?: string` and `fallbackCwd?: string`, passed into `ptyCreate`. Nothing else changes.
- `styles.css`: `.tabbar { position: relative }`; `.tab-drop-marker { position: absolute; top: 6px; bottom: 6px; width: 2px; margin-left: -1px; background: var(--accent); pointer-events: none; z-index: 2 }`; `.tab.elsewhere .tab-title { opacity: 0.55 }`. Use theme variables only.
- `README.md`:
  - New shortcut rows: `Alt+Shift+Left / Alt+Shift+Right` (move active tab), `Drag a tab within the tab bar` (reorder), `Drag a tab onto the left/right half of a pane` (split, also for the same folder).
  - New "Session restore" paragraph: what is restored and what is skipped, that command tabs are re-run on launch, and that scrollback is not restored.
  - Replace the line "All ptys are killed when the app quits" with one that says terminals are restarted on the next launch.

Done when: `tsc -p tsconfig.web.json` errors are only in `App.tsx`.

T3 result: done as contracted; `tsc -p tsconfig.web.json` errors only in `App.tsx` (fromPersisted caller, TermHooks `onMoveTab`/`onCwd`, TabBar props). Visual/drag behaviour untested.

### T4 App integration and restore (after T1-T3)

Inputs: `src/renderer/src/App.tsx` (whole file), all T1-T3 contracts, D2-D6, D8, D9, D12-D16.

Changes:
1. **State.** Replace `activeByLoc` (82) with `activeByPane` state and a `lastByLoc` ref. Each render: `const active = reconcileActive(ps.panes, ps.focused, tabs, activeByPane, lastByLoc.current)`; `activeRef.current = active` (replaces 476-478). Writes go through `setActive(next)`. Remove `dragTab` (95) and use `tabDrag.tab`. Add a `cwdById` ref and `onCwd` (store, then `scheduleSave()`).
2. **`showTab(tabId, paneId?)`** per D15, using `activateIn`. Call it after `commitTabs`. It replaces every listed `setActiveByLoc` call. Parallel runs still only activate target 0 (345).
3. **`newTab(locId, cwdOverride?, paneId?)`** stores `shell: st.resolvedShell` and `startCwd: cwd` on the tab. The "+" and empty-state buttons pass `p.id`; `newSelected` passes the focused pane's id.
4. **`startTarget(runId, index, anchor?)`** sets `run.target = index`, and when `anchor` is given and still present inserts with `moveTab(t, id, anchor)`. **`runCommand(cmd, locId = selectedId, anchor?)`** passes the anchor to the first `startTarget` call(s). Global-command cwd filling uses `locId`'s path instead of the selected path (433). Normal UI calls are unchanged.
5. **`closeTab`** per D14. **`closeActive`** and **`insertSnippet`** use the focused pane's active tab (481-508, 511-515).
6. **Move shortcut.** `act.current.moveActive(dir)` shifts the focused pane's active tab with `shiftTab`. Wire it to `onMoveTab` in `setTermHooks` (517-528). Add an Alt+Shift+ArrowLeft/Right branch in `onKey`, placed **before** the `!e.ctrlKey || e.altKey` early return (532), with `!e.ctrlKey` and the `defaultPrevented` guard.
7. **`dropTargetAt`** (198-210) returns `{ index, side, locId, tabId? } | null`. It returns null when the target is inside `.pane-head`. For a tab drag it also returns null when `ps.panes.length >= MAX_PANES`, or when the tab is the folder's only tab and `paneShows(cur, index, tab.locId)`. For a folder drag it returns null on `paneShows(cur, index, locId)` or `!canAddPane`.
8. **`onDrop`** (734-744), tab drag: `next = splitBeside(cur, locId, index, side, mkId)`; if `next === cur`, return. Otherwise `commitPanes(next)`, set `lastByLoc`, and call `setActive(activateIn(next.panes, tabsRef.current, activeRef.current, next.panes[next.focused].id, tabId))`. A folder drag uses `dropOnEdge` as today. Clear `tabDrag.tab` and `locDrag.id`.
9. **Panes (746-862).** `paneActive = active[p.id]`. TabBar gets:
   - `shownElsewhere = takenBy(active, p.id)`;
   - `onActivate={(id) => { const other = paneOfTab(active, id); other && other !== p.id ? focusPane(index of other) : showTab(id, p.id) }}` (D4);
   - `onReorder={(id, before) => { commitTabs((t) => moveTab(t, id, before)); if (!paneOfTab(active, id) || paneOfTab(active, id) === p.id) showTab(id, p.id) }}`.
   Add the D5 "shown in other panes" empty state when `loc && !loc.missing && paneTabs.length > 0 && !paneActive`.
10. **Terminal list (864-885).** Replace `paneIndexOfLoc` (613-614) with a tab → pane-index map built from `active`. Pass `shell` and `fallbackCwd` (from restore; `undefined` for new tabs) to `TerminalView`.
11. **Save (D8).** `scheduleSave()` (300 ms debounce) writes `setUi({ panes: toPersisted(panesRef.current, activeRef.current), tabs: toPersistedTabs(tabsRef.current, cwdById.current) })`. Trigger it from an effect on `[tabs, paneState, active]`, but only after `restored.current === true`. `setPanes(next, persist)` calls `scheduleSave()` instead of `setUi` when `persist` is true. Remove the startup write at 124-125.
12. **Restore (D9)** in the mount effect, run once (guard with a ref). Missing-folder, missing-file and deleted-command tabs are skipped silently. If restore throws, log it and start with no tabs, but still enable saving.

Done when: `yarn typecheck` and `yarn smoke` pass and the code-readable acceptance criteria hold.

T4 result: done. `App.tsx` only. `tsc --noEmit` passes for tsconfig.node.json and tsconfig.web.json; electron-vite build plus `electron . --smoke` passes all 11 checks. Not run in the live app (M1-M13 untested). Deviation: restored shells' `fallbackCwd` is kept in an App ref (`fallbackById`) because the `Tab` type has no such field; the D5 empty state shows its New terminal button only when the folder has a path.

Orchestrator fix after T4: `sanitizeTab` in `src/shared/session.ts` dropped `preview` for diff tabs (M10 needs it); it now keeps `preview: true` for diff tabs as for file tabs. Final: `yarn typecheck` exit 0, `yarn smoke` 11/11 PASS.

## 6. Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| A1 | Same-folder panes and their `active` ids survive sanitize/load; invalid ids and >4 panes are cleaned | `yarn smoke` `checkPanes` |
| A2 | `focusLoc` does not jump focus between two panes of one folder | `checkPanes`; manual M3 |
| A3 | A tab split adds a pane (own folder included), is refused at 4 panes, and a folder's only tab on its own pane is a no-op | `checkPanes` `splitBeside`; manual M1, M2 |
| A4 | Reorder and move-by-one keep other folders' tabs in place and stop at the edges | `checkTabs`; manual M5, M6 |
| A5 | A tab is never active in two panes; panes refill from `lastByLoc` or the first free tab | `checkTabs` |
| A6 | A v3 file migrates to v4 with `ui.tabs: []` and keeps its data; garbage tabs are dropped | `yarn smoke` `checkMigration` (T2) |
| A7 | The restore plan keeps per-folder order, maps pane actives, anchors re-runs, and skips missing folder/file and deleted commands | `yarn smoke` `checkSession` |
| A8 | Types compile; no existing smoke check regresses | `yarn typecheck`; `yarn smoke` exits 0, all PASS |
| A9 | UI and restart behaviour | manual M1-M12 (UNTESTED until the user runs them) |
| A10 | A renderer reload leaves exactly one set of shells and command runs (old ptys killed) | manual M13 (UNTESTED until run) |

## 7. Manual checks (user, running app; for the restart checks quit from the tray menu and start again: `yarn dev`, or the built app)

- M1 Folder X with tabs A, B (B active). Drag B onto the right half of X's own pane: two X panes, A left and B right, right focused. Each pane types into its own shell.
- M2 Folder X with only tab A, next to a Y pane. Drag A onto Y's left half: a new X pane with A appears left of Y, and the old X pane stays with "All terminals of this folder are shown in other panes". Drag A onto the half of the pane that shows it: no blue hint, nothing happens. With 4 panes open, no hint at all.
- M3 X in two panes (A left, B right) plus a Y pane. Click in Y, then in the right X pane: focus stays on the right X pane.
- M4 In the left X pane click dimmed tab B: focus jumps to the right pane and its terminal takes keystrokes. B does not move.
- M5 Drag a tab along its bar: a 2px accent marker shows between tabs and after the last one, and the drop reorders it in both X panes. There is no split hint over the tab bar, but there is one over the terminal area. Dragging a Y tab over an X bar shows no marker and does nothing.
- M6 With a terminal focused, Alt+Shift+Left/Right move the active tab and stop at the ends, and the shell receives nothing. Same with a diff or file tab active. Ctrl+Shift+PgUp/PgDn and Shift+PgUp still scroll the terminal.
- M7 Press and release Alt+Shift alone, then use Alt+Shift+Left: check whether the Windows input language switches (only with several keyboard layouts installed).
- M8 Remove folder X while it is shown in two panes: both panes go away.
- M9 Restart: tab order per folder is as before the quit. A same-folder split comes back with the same widths, and each pane shows the tab it had active. Shell titles are kept and each shell starts in its folder (or in the "Open terminal here" directory). New tabs continue the title numbering.
- M10 Restart with a file tab, a diff tab and a pinned and a preview tab: all come back with the same pinned/preview state.
- M11 Restart with a finished command tab and a running one: both commands run again (the user accepted that this starts servers), in place in the tab order, with the run status in the Commands panel. A deleted command's tab does not come back.
- M12 Quit, then rename or delete a folder on disk and delete a file shown in a file tab, then start: that folder's tabs and that file tab are skipped, everything else is restored, and there is no error dialog.

- M13 In `yarn dev`, with two shells and a running command tab open, reload the renderer (Ctrl+R in DevTools, or save a renderer file to trigger HMR full reload). Afterwards Windows Task Manager shows one set of shell processes (not two), and the Commands panel shows one run. The shells are restored once.

## 8. Open questions

None open.

Resolved (user decisions):
- Q1 Command tabs re-run on every launch, accepted as-is. A per-command "restore without running" flag is a possible later ticket.
- Q2 A renderer reload or destroy kills that renderer's ptys: yes, built in T2 (D17, M13).
- Q3 Exited shell tabs come back as fresh, running shells: accepted.
- Q4 A saved shell that is no longer an available known shell falls back to the current default shell: accepted.
