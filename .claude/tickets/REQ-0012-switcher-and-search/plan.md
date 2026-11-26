---
status: done
request: REQ-0012
repos: [C:/projects/Personal/terminals]
branch: feat/herdr-agent-workflow
updated: 2026-11-26
---

# REQ-0012: Quick switcher (Ctrl+Shift+K), tab jumps (Ctrl+1..9), scrollback search (Ctrl+Shift+F)

Background: `.claude/tickets/REQ-0009-herdr-feature-research/research.md` (rows 14, 16, 17; recommendations 4 and 5).

Coordination: this lands LAST on `feat/herdr-agent-workflow`, after REQ-0010 (agent status) and REQ-0011 (git worktrees as sidebar children). The plan is written against an assumed interface, "AgentStatus from src/shared (REQ-0010)":

```ts
// assumed, adapt to what REQ-0010 actually landed
export type AgentStatus = 'working' | 'done' | 'needs-you' | 'idle'
// renderer: a per-tab status readable from App state, e.g. statusById[tabId] or tab.status
```

Task T0 replaces these names with the real ones before anything else is written.

## Scope

Full reading, all three items:

1. **Quick switcher: Ctrl+Shift+K everywhere, and Ctrl+K only when focus is not in a terminal.** A modal overlay that lists every open tab in every folder (shell, command, diff and file tabs), and after them every location you can jump to (Home, saved folders, group roots with a path, discovered children, and REQ-0011 worktree children). Each row shows the folder name, the tab title and the REQ-0010 agent status. A folder row shows its rolled-up status, worst first: needs-you > done > working > idle. Typing filters with a fuzzy match, and Enter switches to the highlighted row. Status filter: chips (All / Needs you / Done / Working) that Tab and Shift+Tab cycle, plus query prefixes `n:` `d:` `w:` `i:` (needs-you / done / working / idle), as in herdr's b/w/i/d. Pressing the opening key again or Esc closes it.
2. **Ctrl+1..9** jumps to tab N of the focused pane's folder, and Ctrl+9 goes to the last tab. Nothing happens when tab N does not exist.
3. **Ctrl+Shift+F find bar** in terminal scrollback, using `@xterm/addon-search@^0.16.0`. It has an input, next and previous, a case toggle, a match count, and Esc closes it.

### Key decisions

- **The switcher never steals Ctrl+K from a terminal (director decision).** Ctrl+Shift+K opens it from anywhere. It is unbound today, and it matches Ctrl+Shift+F and the app's Ctrl+Shift convention. Plain Ctrl+K opens it only when focus is not in a terminal (sidebar, panels, tab bar). Inside xterm, Ctrl+K goes to the shell, so kill-to-end-of-line in readline, PSReadLine Emacs mode and Claude Code keeps working.
- **Folder rows carry a rolled-up status (director decision).** It is the worst status of the folder's tabs: needs-you > done > working > idle. A folder with no status-bearing tabs has none. The status filter matches folders by this rollup. Use REQ-0010's rollup helper if it lands one; T0 maps the names.
- **Ctrl+1..9 is free.** It is not bound in `App.tsx` `onKey` or in the `termRegistry.ts` `attachCustomKeyEventHandler`. Only Ctrl+0 is used, for zoom reset, and that stays. In a terminal, Ctrl+2..8 send legacy control bytes (NUL, ESC, FS, GS, RS, US, DEL) that are typed directly almost never, and Ctrl+1 and Ctrl+9 send nothing. Browsers and VS Code use the same keys for tab jumps. Match on `ev.code` `Digit1`..`Digit9` (layout independent: AZERTY needs Shift for digits in `ev.key`) with Ctrl only, no Shift or Alt. The numpad is not bound.
- **Find uses Ctrl+Shift+F, not Ctrl+F, and has no setting.** Ctrl+F is forward-char in readline and PSReadLine Emacs mode, page-down in less and vim, and is used by nano and fzf, so taking it would break real shell use. Ctrl+Shift+F is unbound here, is Windows Terminal's default Find key, and follows this app's Ctrl+Shift+letter convention for app actions. Plain Ctrl+F still goes to the shell.
- **No generic picker refactor.** QuickSwitcher copies SnippetPicker's structure: the `modal-backdrop picker-backdrop` / `modal picker` / `picker-search` / `picker-list` / `picker-item` / `picker-foot` classes and its keyboard loop. SnippetPicker is not changed.
- **Ranking and parsing are pure code in `src/shared/switcher.ts`,** so `yarn smoke` can test them. This follows the existing `src/shared/tabs.ts` pattern.

## Out of scope

- Regex and whole-word search options. The addon supports them, but the bar only offers case.
- Persisting find state, or keeping the bar open across tab switches. The bar belongs to one tab and is shown only while that tab is visible.
- A vim-style copy mode (herdr #16).
- Rebinding shortcuts, and settings for any of these keys.
- Jumping to tabs in other panes with Ctrl+1..9. It always uses the focused pane's folder.
- Showing the switcher status anywhere other than the switcher. The sidebar status is REQ-0010's job.
- Search in diff and file tabs. FileViewer has its own editor.

## Files and modules to touch

| File | Change |
| --- | --- |
| `package.json`, `yarn.lock` | Add the dependency `@xterm/addon-search: ^0.16.0`. 0.16.0 is the latest release and matches xterm 6.0.0, released with addon-fit 0.11 and web-links 0.12. |
| `src/shared/switcher.ts` (new) | `SwitcherItem`, `StatusFilter`, `parseSwitcherQuery`, `fuzzyScore`, `rankSwitcher`. Pure, with no DOM. |
| `src/shared/tabs.ts` | `nthTabOfLoc(tabs, locId, n)`. |
| `src/main/smoke.ts` | New `checkSwitcher()`, added to the check list after `checkTabs()`. Two `nthTabOfLoc` asserts inside the existing `checkTabs()`. |
| `src/renderer/src/QuickSwitcher.tsx` (new) | The overlay component. |
| `src/renderer/src/FindBar.tsx` (new) | The find bar component. |
| `src/renderer/src/termRegistry.ts` | Load the SearchAddon per terminal. Add `search` to `TermEntry`. New hooks `onSwitcher`, `onJumpTab(n)`, `onFind`. Key handling for Ctrl+Shift+K (not plain Ctrl+K), Ctrl+Digit1-9 and Ctrl+Shift+F. Export the helpers `findInTerm` and `clearFind`. |
| `src/renderer/src/App.tsx` | `switcherOpen` and `findFor` state. Window `onKey` branches. `act.current.jumpTab` and `jumpTo`. Building the switcher items. Rendering QuickSwitcher and FindBar. |
| `src/renderer/src/styles.css` | `.switcher-*` (status chips, row layout, status badge) and `.find-layer` / `.find-bar`. Use the existing theme tokens only. |
| `README.md` | Shortcut table plus two short sections (see the last section). |

`Keys.tsx`, `SnippetPicker.tsx`, `SettingsDialog.tsx`, `src/shared/settings.ts` and `src/shared/types.ts` are read only. No new setting is added.

## Tasks for workers

Run the tasks in order: T0, T1, T2, T3, T4. T2 and T3 both edit `App.tsx` and `termRegistry.ts`, so they must not run in parallel.

### T0: Adapt to REQ-0010 and REQ-0011 as they landed (mandatory first step)

- **Inputs:** `.claude/tickets/REQ-0010-agent-status/plan.md` and `.claude/tickets/REQ-0011-*/plan.md` if they exist, plus `git log --oneline master..HEAD` and the diff on `feat/herdr-agent-workflow`.
- **Do:**
  - Find the real status type name and module. For example, `grep -rn "needs-you" src/`.
  - Find where the renderer keeps per-tab status (a `Tab` field, a map in App state, or a hook).
  - Find any status badge or dot component that REQ-0010 added. Reuse it in the switcher rows.
  - Find any per-folder rollup helper that REQ-0010 added (worst-first). If one exists, use it for folder rows instead of `rollupStatus` in T1.
  - Find how REQ-0011 worktree children appear in `buildLocs` (`src/renderer/src/locations.ts`): a `kind` value, an id prefix, and whether they are selectable.
- **Output:** a short "T0 adaptation" note appended to this plan file that lists the real names. Every later task uses those names in place of `AgentStatus` and `statusOf`.
- **Fallback if REQ-0010 has not landed:** stop and report. Do not invent a status source.

### T1: Pure logic and smoke checks

- **Inputs:** T0 names, `src/shared/tabs.ts`, the `src/main/smoke.ts` check pattern (`checkTabs`, and the `CheckResult` `{ ok, msg }` shape).
- **Output:** `src/shared/switcher.ts`, the addition to `src/shared/tabs.ts`, and the smoke checks.
- **Contracts:**

```ts
import type { AgentStatus } from './<REQ-0010 module>'

export type StatusFilter = AgentStatus | null

export interface SwitcherItem {
  key: string            // 'tab:<tabId>' | 'loc:<locId>'
  kind: 'tab' | 'loc'
  locId: string
  tabId?: string         // kind === 'tab' only
  folder: string         // location display name (Loc.name)
  title: string          // tab title; for kind 'loc', the location path or ''
  status?: AgentStatus   // tab: its status; loc: rollupStatus of its tabs (undefined when none)
  order: number          // stable input order (tabs in tab order, then locs in sidebar order)
}

/** Leading "n:", "d:", "w:", "i:" (case-insensitive, optional space after) sets the status; the rest is the text. */
export function parseSwitcherQuery(q: string): { status: StatusFilter; text: string }

/** Subsequence score of needle in hay, case-insensitive; null when not a subsequence. Greedy left-to-right:
 *  +1 per matched char, +3 if the previous hay char was also matched, +2 if the char is at a word start
 *  (index 0 or previous char in " -_/\\.:"). */
export function fuzzyScore(needle: string, hay: string): number | null

/** Worst-first rollup: needs-you > done > working > idle; undefined for an empty list. Replaced by REQ-0010's helper if it has one. */
export function rollupStatus(statuses: (AgentStatus | undefined)[]): AgentStatus | undefined

/** Filter + rank. Status: the query prefix wins over `chip`. A non-null status keeps tab and loc items whose
 *  `status` equals it (for loc items that is the rollup). Text: split on whitespace; every token must match `${folder} ${title}`; item score =
 *  sum over tokens of max(fuzzyScore(tok, title) + 1, fuzzyScore(tok, folder), fuzzyScore(tok, folder + ' ' + title)),
 *  skipping null terms (a token matching none fails the item). Sort: score desc (empty text = all score 0), then
 *  kind (tab before loc), then status priority needs-you < done < working < idle < none, then `order`. */
export function rankSwitcher(items: SwitcherItem[], query: string, chip: StatusFilter): SwitcherItem[]
```

```ts
// src/shared/tabs.ts
/** Id of tab n (1-based) among `locId`'s tabs in array order; n >= 9 means the last one; undefined when out of range. */
export function nthTabOfLoc(tabs: TabRef[], locId: string, n: number): string | undefined
```

- **Smoke checks (test-discipline: these are the only automated tests):**
  - `checkSwitcher()`, with fixture items: `api / Claude` needs-you, `web / Agent 1` working, `api / pwsh` idle, `api / cool log` done, and the loc items `docs` (no tabs) and `web` (rollup working). Each line below is one assert:
    - `parseSwitcherQuery('n: foo')` gives `{ status: 'needs-you', text: 'foo' }`.
    - `parseSwitcherQuery('foo')` gives status `null`.
    - Text `api cl` puts `api / Claude` first, before `api / cool log`, because of the consecutive bonus. `api / pwsh` is not in the result.
    - Empty query and `chip = null` gives `Claude` (needs-you) as the first tab, with the `docs` loc row last.
    - `chip = 'working'` gives `web / Agent 1` and the `web` loc row only. `w:` with chip `done` gives the same, because the prefix wins.
    - `rollupStatus(['working', 'done', 'idle'])` gives `'done'`, and `rollupStatus([])` gives `undefined`.
    - `xyz` gives an empty result.
  - In `checkTabs()`: `nthTabOfLoc` with n = 9 returns the folder's last tab even when it has fewer than 9 tabs, and n past the end returns `undefined`. Skip other folders' tabs in the fixture.

### T2: Quick switcher UI and Ctrl+Shift+K / Ctrl+K / Ctrl+1..9 wiring

- **Inputs:** T0 and T1 output, `SnippetPicker.tsx`, `App.tsx` (`showTab`, `select`, `lastByLoc`, `panesRef`, `commitPanes`, `act`, `setTermHooks`, `onKey`), and `termRegistry.ts` (`TermHooks`, the key handler).
- **Output:** `QuickSwitcher.tsx`, plus the edits to `termRegistry.ts`, `App.tsx` and `styles.css`.
- **Contracts:**
  - `TermHooks` gains `onSwitcher: () => void` and `onJumpTab: (n: number) => void`. The defaults in `let hooks` are no-ops.
  - termRegistry key handler, placed before the Ctrl+C and Ctrl+V branches:
    - `ctrl && shift && !alt && k === 'k'` calls `hooks.onSwitcher()`. Plain Ctrl+K is NOT handled here: it returns `true` and goes to the shell.
    - `ctrl && !shift && !alt && /^Digit[1-9]$/.test(ev.code)` calls `hooks.onJumpTab(Number(ev.code.slice(5)))`.
    - Both call `preventDefault` and return `false`.
  - App `onKey` mirrors these after `if (!e.ctrlKey || e.altKey) return`:
    - Ctrl+Shift+K toggles `switcherOpen`.
    - Plain Ctrl+K toggles it only when `e.target` is not inside `.xterm`. Inside a terminal the event never reaches here as an app key, but guard explicitly with `(e.target as HTMLElement | null)?.closest('.xterm')`. It also must not fire inside an `input` or `textarea` other than the switcher's own input.
    - Ctrl+Digit is ignored when `e.target` is inside `input, textarea, select, [contenteditable]`, so typing in a rename field or the FileViewer is unaffected. Otherwise it calls `act.current.jumpTab(n)`.
  - `act.current.jumpTab(n)`:
    1. Takes `paneId = focusedPaneId()` and the locId of that pane.
    2. Gets `id = nthTabOfLoc(tabsRef.current, locId, n)`.
    3. If there is an id, calls `showTab(id, paneId)`.
  - `jumpTo(item: SwitcherItem)` in App:
    - For `kind === 'tab'`: set `lastByLoc.current[locId] = tabId`. If a pane already shows `locId`, focus that pane (`commitPanes({...cur, focused: i})`) and call `showTab(tabId, paneId)`. Otherwise `await select(locId)`; the existing selection effect repoints the focused pane, and `reconcileActive` picks the tab from `lastByLoc`. After the switch, focus the terminal with `getTerm(tabId)?.term.focus()` in a `requestAnimationFrame`. This covers the case where the tab was already focused and `TerminalView`'s effect does not fire again.
    - For `kind === 'loc'`: `void select(locId)`.
    - Close the switcher first.
  - Items are built in App with `useMemo` over `tabs`, `locs` and the status source.
    - Tab rows are all tabs in `tabs` order. `folder` is `locs.get(t.locId)?.name ?? '?'`, and `status` comes from the REQ-0010 source for shell and command tabs.
    - Then loc rows: every location in `locs` that has a path and is not `missing`, in `buildLocs` order. `title` is the path, and `status` is the rollup of that location's tab statuses (REQ-0010's helper, or `rollupStatus`).
  - `QuickSwitcher` props: `{ items: SwitcherItem[]; onPick: (i: SwitcherItem) => void; onClose: () => void }`. It owns its query and chip state.
    - Input keys:
      - Esc closes.
      - Up and Down move the selection.
      - Enter picks the selected row.
      - Tab and Shift+Tab cycle the chips All, Needs you, Done, Working, with `preventDefault`.
      - Ctrl+Shift+K and Ctrl+K close it. The window handler sees them too: let it toggle, and do not double-handle.
    - A row shows the status badge (REQ-0010's component if one exists, else a `.switcher-status` pill with the status label), the folder name, and the tab title. Loc rows show a folder icon, their rollup badge when they have one, and the path in `cmd-sub`.
    - Empty states: "No open tabs or folders match." when nothing matches, and the chip name when a chip filters everything out.
    - Footer keys: ↑↓ select, Enter switch, Tab filter, Esc close.
  - Render as `{switcherOpen && state && <QuickSwitcher .../>}` next to the SnippetPicker render.

### T3: Scrollback find bar

- **Inputs:** `termRegistry.ts` (`createTerm`, `TermEntry`, `applyTerminalOptions`, `current.theme`), the App terminal render loop (the `admin-retry` overlay pattern around line 1351), and `styles.css` (`.term-host`, `.panes .term-host { top: 46px }`).
- **Output:** the `package.json` and `yarn.lock` dependency (`fnm exec --using default yarn add @xterm/addon-search@^0.16.0`), `FindBar.tsx`, and the edits to `termRegistry.ts`, `App.tsx` and `styles.css`.
- **Contracts:**
  - `createTerm` does `const search = new SearchAddon(); term.loadAddon(search)`, and `TermEntry` gains `search: SearchAddon`.
  - `TermHooks` gains `onFind: () => void`. The key handler maps `ctrl && shift && !alt && k === 'f'` to `hooks.onFind()` and returns `false`. App `onKey` adds the same branch, with `e.shiftKey && k === 'f'`.
  - Exports:
    - `findInTerm(id: string, query: string, opts: { caseSensitive: boolean; dir: 1 | -1; incremental?: boolean }): void` calls `findNext` or `findPrevious`. It always passes `decorations`, because the addon fires `onDidChangeResults` only when decorations are set. Colors come from `current.theme`:
      - `matchBackground: selectionBackground`
      - `activeMatchBackground: yellow`
      - `matchOverviewRuler: selectionBackground`
      - `activeMatchColorOverviewRuler: yellow`
      - All theme values are `#rrggbb`, and the addon requires that format.
    - `clearFind(id: string): void` calls `search.clearDecorations()` and `term.clearSelection()`.
    - `onFindResults(id, cb: (r: { resultIndex: number; resultCount: number }) => void): () => void` wraps `search.onDidChangeResults` and returns a dispose function.
  - App state `findFor: string | null`. `onFind`:
    - Let `id` be the focused pane's active tab. If it is not a shell or command tab with a term, do nothing.
    - If `findFor === id`, focus and select-all the bar input. A `focusToken` counter prop does this.
    - Otherwise `setFindFor(id)`.
  - Render: inside the terminal list, beside `admin-retry`, add `{findFor === t.id && visible && <div className="find-layer" style={style}><FindBar .../></div>}`. `.find-layer` is absolute, has `top: 46px` (the same as `.panes .term-host`), no bottom, `pointer-events: none`, and right-aligned flex content. `.find-bar` has `pointer-events: auto` and `z-index: 2`.
  - `FindBar` props: `{ termId: string; focusToken: number; onClose: () => void }`.
    - It holds `query`, `caseSensitive` and `result`.
    - Typing runs `findInTerm(..., { dir: 1, incremental: true })`. An empty query runs `clearFind`.
    - Enter or F3 goes to the next match. Shift+Enter or Shift+F3 goes to the previous match.
    - Alt+C or the `Aa` button toggles case and searches again.
    - Esc, or the X button, runs `clearFind(termId)`, then `onClose()`, then `getTerm(termId)?.term.focus()`.
    - The count reads "3 of 12", or "No results" when the count is 0 and the query is not empty. `resultIndex` is 0-based, so show it +1. The addon returns `resultIndex === -1` when the result count is above its highlight limit; show "1000+" then.
  - When the find tab closes (`closeTab`) or exits, set `findFor` to null if it is that tab.

### T4: README

- **Inputs:** the final keys from T2 and T3.
- **Output:** the `README.md` edits listed in the README update section below.

### Verification (each task)

- Run `fnm exec --using default yarn typecheck` and `fnm exec --using default yarn smoke`. Both must pass.

## Acceptance criteria with tests

Automated, in `yarn smoke` (T1):

1. `checkSwitcher` passes all its asserts: prefix parse, fuzzy order, status ordering on an empty query, chip filter, prefix over chip, folder rollup and its filter match, and no-match.
2. The `nthTabOfLoc` asserts in `checkTabs` pass: Ctrl+9 means last, and out of range is `undefined`.
3. `yarn typecheck` passes.

Manual, in the real app (`yarn dev` or the built exe). These are not automated, and anything not run is reported as UNTESTED:

4. With 3 folders and 2 or more tabs each, Ctrl+Shift+K from inside a focused terminal opens the switcher with the input focused. Typing part of a tab title in another folder and pressing Enter selects that folder, shows that tab, and puts the keyboard focus in its terminal.
5. Status shows per row and matches the sidebar (REQ-0010). `n:` and the Needs you chip each list only needs-you tabs. Tab cycles the chips. Esc and Ctrl+Shift+K each close the switcher. A folder row shows the worst status of its tabs, and `n:` lists a folder whose tab needs you.
5a. Ctrl+K: with focus in the sidebar it opens the switcher. In a focused pwsh terminal with `Set-PSReadLineOption -EditMode Emacs`, Ctrl+K deletes to the end of the line and the switcher does not open.
6. Picking a folder row with no tabs selects that folder. A REQ-0011 worktree child appears as a row.
7. Ctrl+1 / Ctrl+3 / Ctrl+9 in a terminal of a 4-tab folder activate tabs 1, 3 and 4. Ctrl+5 there does nothing. No characters reach the shell: run `[Console]::ReadKey()` in pwsh to check. Ctrl+0 still resets zoom. Ctrl+2 typed in a sidebar rename input does not jump.
8. Ctrl+Shift+F in a terminal with output opens the bar at the pane's top-right. Typing highlights matches and shows "N of M". Enter and Shift+Enter cycle the matches. `Aa` changes the count for mixed-case text. Esc removes the highlights and returns focus to the terminal. Plain Ctrl+F in pwsh with PSReadLine Emacs mode (`Set-PSReadLineOption -EditMode Emacs`) still moves the cursor.
9. The find bar works in a split pane: it sits over the right pane only, and switching tabs hides it.
10. Light and dark themes: the match highlights are readable in both.

## README update (shortcut list)

In `## Keyboard shortcuts`, add these rows and keep the table order sensible:

| Key | Action |
| --- | --- |
| Ctrl+Shift+K | Quick switcher: jump to any open tab or folder; filter by status with the chips (Tab) or `n:` / `d:` / `w:` / `i:` |
| Ctrl+K | Quick switcher too, when focus is not in a terminal (in a terminal, Ctrl+K goes to the shell) |
| Ctrl+1 … Ctrl+8 | Go to tab 1 to 8 of the focused pane's folder |
| Ctrl+9 | Go to the last tab of the focused pane's folder |
| Ctrl+Shift+F | Find in the terminal's scrollback (Enter / Shift+Enter next / previous, Alt+C match case, Esc close) |

Also add the shortcuts that already exist but are missing from the table, so the list is complete:

| Key | Action |
| --- | --- |
| Ctrl+Shift+G | Toggle the Git panel |
| Ctrl+Shift+B | Toggle the sidebar |
| Ctrl+Shift+P | Insert a saved prompt |
| Ctrl+, | Settings |
| Alt+Shift+Up / Down | Move the selected sidebar item |

Add a note under the table: "Ctrl+1..9 and the Ctrl+Shift shortcuts are taken by the app and are not sent to the shell. Plain Ctrl+K and Ctrl+F are sent to the shell while a terminal has focus, so kill-line and forward-char keep working. The switcher is Ctrl+Shift+K and find is Ctrl+Shift+F, as in Windows Terminal."

Add two short sections, each 2 or 3 sentences:

- `## Quick switcher (Ctrl+Shift+K)`: what it lists, folder rows with rolled-up status, the status filter, that Enter switches, and that Ctrl+K also opens it outside a terminal.
- `## Find in terminal (Ctrl+Shift+F)`: what it searches (the scrollback as configured by the Settings scrollback value), the keys, and that it is per tab.

## Open questions

None. The director decided both earlier questions: switcher keys (Ctrl+Shift+K; Ctrl+K only outside a terminal) and folder rollup status.

## T0 adaptation

Real names as landed (REQ-0010, REQ-0011):

- Status type and module: `AgentStatus` in `src/shared/agentStatus.ts`, with `AGENT_STATUSES` (priority order), `STATUS_PRIORITY`, `STATUS_LABEL`, `StatusRollup`, `rollupOf(entries)` and `rollupStatus(a, b)` (combines two `StatusRollup`s, not a list helper).
- Renderer source: `App.tsx` memos `tabStatus: Record<tabId, AgentStatus>` (non-idle shell tabs only), `tabStatusSource`, and `agentByLoc: Record<locId, StatusRollup>` (`.top`). TabBar shows `agent-ind <status>` (a "!" pill for needs-you); the switcher reuses these classes plus a `.switcher-status` label.
- Rollup: the plan's `rollupStatus(statuses[])` is named `worstStatus(statuses)` in `src/shared/switcher.ts` (built on `STATUS_PRIORITY`) so it does not clash with `agentStatus.rollupStatus`. The smoke assert uses `worstStatus`.
- Idle decision: `tabStatus` has no idle entries, so the switcher treats shell and command tabs without an entry as `idle` (makes `i:` work); diff and file tabs have no status. A folder's status is `worstStatus` over its tabs, so a folder with only shells is `idle` and a folder with no shell/command tabs has none.
- REQ-0011 worktrees: `Loc.kind === 'worktree'`, id `wt:<norm path>`, `parentLocId`, `branch`. They are in `buildLocs` output and selectable, so they appear as loc rows with no special casing.

## Implementation notes (T1 to T4)

- DONE T1: `src/shared/switcher.ts`, `nthTabOfLoc` in `src/shared/tabs.ts`, `checkSwitcher()` plus two `nthTabOfLoc` asserts in `checkTabs()` in `src/main/smoke.ts`. Evidence: `yarn smoke` printed `PASS: switcher ...` and `PASS: tabs ...`, exit 0.
- DONE T2: `QuickSwitcher.tsx`, `termRegistry.ts` hooks and keys, `App.tsx` wiring (`jumpTo`, `act.jumpTab`, `onKey`), `styles.css`. Typecheck passes; behaviour UNTESTED in the real app (criteria 4 to 7).
- DONE T3: `@xterm/addon-search@^0.16.0` added (package.json, yarn.lock), `FindBar.tsx`, `findInTerm` / `clearFind` / `onFindResults` in `termRegistry.ts`, `App.tsx` `findFor`. UNTESTED in the real app (criteria 8 to 10).
- DONE T4: README shortcut rows, note, and the two sections.
- Verification: `yarn typecheck` exit 0; `yarn smoke` exit 0 with every check PASS.

Deviations:

- `parseSwitcherQuery` treats `d:\...` and `d:/...` (a drive path) as text, not a done filter. Not in the plan; avoids breaking a path query.
- Extra find-bar behaviour: `findFor` is cleared when its tab is no longer the active tab of any pane (the plan says the bar is not kept across tab switches), and when the tab closes or exits.
- `jumpTo` first focuses the pane that already shows the target tab, then the focused pane if it shows that folder, then the first pane showing the folder; otherwise it calls `select`.
- Dependency was added with `yarn add` directly (the `fnm exec` wrapper could not find yarn from the shell here; yarn was on PATH).
- Manual criteria 4 to 10: UNTESTED.
