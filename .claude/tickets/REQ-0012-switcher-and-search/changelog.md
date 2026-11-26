# Changelog: REQ-0012

## 2026-11-26 REQ-0012: quick switcher, Ctrl+1..9 tab jumps, scrollback find bar

All three features from the plan are implemented. Typecheck and smoke pass. The manual checks in the real app (criteria 4 to 10) were not run.

### C:/projects/Personal/terminals (branch `feat/herdr-agent-workflow`)

| File | Change |
| --- | --- |
| `package.json`, `yarn.lock` | Added the dependency `@xterm/addon-search@^0.16.0`. |
| `src/shared/switcher.ts` (new) | Pure switcher logic: `SwitcherItem`, `StatusFilter`, `parseSwitcherQuery`, `fuzzyScore`, `worstStatus` and `rankSwitcher`. |
| `src/shared/tabs.ts` | `nthTabOfLoc(tabs, locId, n)`. A value of 9 or more gives the last tab, and an out-of-range value gives `undefined`. |
| `src/main/smoke.ts` | New `checkSwitcher()`, plus two `nthTabOfLoc` asserts in `checkTabs()`. |
| `src/renderer/src/QuickSwitcher.tsx` (new) | The switcher overlay (see below). |
| `src/renderer/src/FindBar.tsx` (new) | The find bar (see below). |
| `src/renderer/src/termRegistry.ts` | Key handling, the search addon, the new hooks and the find helpers (see below). |
| `src/renderer/src/App.tsx` | Switcher and find wiring (see below). |
| `src/renderer/src/styles.css` | `.switcher-*` styles and `.find-layer` / `.find-bar` styles, using the existing theme tokens. |
| `README.md` | Shortcut rows for the new keys and for existing keys that were missing, a note on which keys reach the shell, and two new sections. |

**QuickSwitcher overlay**
- It uses SnippetPicker's structure.
- Chips: All, Needs you, Done and Working. Tab and Shift+Tab cycle them.
- Row badges reuse the `agent-ind` look.
- It has empty states and a footer listing the keys.

**FindBar**
- Typing searches incrementally.
- Enter or F3 goes to the next match. Shift+Enter or Shift+F3 goes to the previous one.
- Alt+C or the `Aa` button toggles match case.
- The count reads "N of M", "No results" or "1000+".
- Esc clears the highlights and gives focus back to the terminal.

**termRegistry.ts**
- Loads a SearchAddon for each terminal, and `TermEntry` has a new `search` field.
- New hooks: `onSwitcher`, `onJumpTab` and `onFind`.
- Key handling:
  - Ctrl+Shift+K opens the switcher. Plain Ctrl+K still goes to the shell.
  - Ctrl+Shift+F opens the find bar.
  - Ctrl+Digit1..9 jumps to a tab. It matches on `ev.code`, so it does not depend on the keyboard layout.
- New exports: `findInTerm`, `clearFind` and `onFindResults`. Match colours come from the theme's selectionBackground and yellow.

**App.tsx**
- New state: `switcherOpen`, `findFor` and `findToken`.
- Window key branches:
  - Ctrl+Shift+K and Ctrl+Shift+F.
  - Plain Ctrl+K, only when focus is outside `.xterm` and outside other input fields.
  - Ctrl+Digit, ignored while focus is in an input field.
- `act.current.jumpTab` and `act.current.find`.
- `jumpTo(item)` picks a pane in this order: the pane already showing the tab, then the focused pane if it shows that folder, then the first pane showing the folder. If none qualifies, it calls `select`. It then focuses the terminal in a `requestAnimationFrame`.
- The `switcherItems` memo builds all tabs, then all folders that have a path and are not missing. That includes worktrees.
- The find layer is rendered per visible tab.
- `findFor` is cleared when its tab closes, exits, or is no longer the active tab in any pane.

### Deviations

- REQ-0010 already has `rollupStatus(a, b)`, so the list rollup helper is named `worstStatus(statuses)` instead.
- Shell and command tabs with no `tabStatus` entry count as `idle`, so `i:` works. Diff and file tabs have no status.
- A drive path such as `d:\...` or `d:/...` in the query is read as text, not as the `d:` filter. There is a smoke assert for this.
- The find bar also closes when its tab stops being visible, which follows the plan's "not kept across tab switches".
- `fnm exec --using default yarn` could not find yarn, so `yarn` was called directly from PATH.

### Verification

Passed:
- `yarn typecheck` exited 0.
- `yarn smoke` exited 0 with every check PASS, including `switcher` and `tabs`.

Not run (UNTESTED):
- Manual criteria 4 to 10 in the real app.
- Ctrl+K and Ctrl+F reaching the shell under PSReadLine Emacs mode.
- `[Console]::ReadKey()` for Ctrl+Digit.
- Find in a split pane.
- Highlight readability in the light and dark themes.

### Follow-ups

- Run the manual checks above in the real app.

### Commit status

Committed on `feat/herdr-agent-workflow` (see git log, subject "Add quick switcher, Ctrl+1..9 tab jumps and terminal find bar").
