# Changelog

## 2026-11-13 - settings-and-themes (REQ-0001)

Settings dialog (gear button, Ctrl+,) with live-applied theme, terminal font, cursor, scrollback, default shell and editor; four built-in themes plus Follow system, persisted in terminals.json.

### terminals - branch `feature/settings-and-themes` (from master 183e3c9)

- `src/shared/settings.ts` (new): settings schema with defaults and per-key sanitisers; `sanitizeSettings`, `patchSettings`, `fontStack`, font size 8-36 and scrollback 0-100000 ranges.
- `src/shared/themes.ts` (new): Dark (unchanged look), Light, Fjord and Sandstone themes. Each has 38 chrome variables and an xterm palette. Also `resolveThemeId` (Follow system resolves to Dark or Light) and `windowColors`.
- `src/shared/types.ts`: `Settings` gains theme, terminalFontFamily, cursorStyle, cursorBlink and scrollback. New types `ThemeId`, `ThemeSetting`, `CursorStyle`, `ShellOption`. `TerminalsApi` gains `initialThemeId` and `listShells`.
- `src/main/store.ts`: `migrate` and `setSettings` go through the shared schema, so unknown keys are dropped and invalid values fall back or clamp. Stored font sizes 37-40 now clamp to 36. Adds `getSettings()`.
- `src/main/pty.ts`: `listShells()` (Automatic, pwsh, powershell, cmd, each with a PATH availability flag). `stepsShell()` runs saved commands with automatic PowerShell when the configured shell is not PowerShell or cmd. A bare shell name resolves on PATH.
- `src/main/index.ts`: the window background and title bar overlay come from the saved theme at creation. They are re-applied after every `settings:set` and on `nativeTheme` `updated`. New IPC `theme:initial` (sync) and `settings:shells`. Saved-command steps use `stepsShell`.
- `src/preload/index.ts`: exposes `initialThemeId` and `listShells`.
- `src/main/smoke.ts`: the fake state uses `DEFAULT_SETTINGS`. New `checkSettings` covers defaults, sanitising, the round trip, themes and the steps shell.
- `.gitignore`: `.claude/director/`.
- `src/renderer/src/appearance.ts` (new): `applyTheme`, `useSystemDark` and `useAppearance`. Together they apply chrome variables, `--font-mono` and terminal options live.
- `src/renderer/src/termRegistry.ts`: hard-coded theme, font and size are removed. `applyTerminalOptions` assigns only changed options to every terminal and re-measures fonts. Hidden terminals are flagged and re-measured on show (`refreshTerm`). New `onOpenSettings` hook and Ctrl+, inside terminals.
- `src/renderer/src/TerminalView.tsx`: calls `refreshTerm` before fitting when a terminal becomes visible.
- `src/renderer/src/main.tsx`: applies the initial theme before React renders.
- `src/renderer/src/DiffView.tsx`, `FileViewer.tsx`: use `var(--font-mono)`.
- `src/renderer/src/styles.css`: no colour values in `:root`. Every theme colour literal is replaced with theme variables or `color-mix()`.
- `src/renderer/src/SettingsDialog.tsx`, `SettingsDialog.css` (new): a field-table-driven dialog in four sections.
  - Selects and the toggle apply at once.
  - Text and number fields debounce for 400 ms and also commit on blur, on Enter and on unmount.
  - The shell picker shows missing shells disabled and keeps a custom value.
  - "Reset to defaults" keeps shell and editor. Esc closes the dialog.
- `src/renderer/src/App.tsx`: wires up dialog state and rendering, Ctrl+, in the window handler, the `onOpenSettings` hook and `useAppearance`. Zoom uses the shared range and only persists.
- `src/renderer/src/Sidebar.tsx`: gear button "Settings (Ctrl+,)".

### Deviations

- T2: the `select` chevron data-URI SVG in styles.css had the stroke `#a4a4ad`. It was not in the plan's list, but it broke the A7 grep. It is now the neutral grey `#9a9aa4`, because a data URI cannot use CSS variables. On Dark it is very slightly different from before.
- Orchestrator: a whitespace fix in App.tsx (`'='||` to `'=' ||`), made after smoke ran. Typecheck was re-run afterwards: exit 0.

### Verification

- `yarn typecheck`: exit 0 (after T1, and again after T2+T3 and the whitespace fix).
- `yarn smoke`: exit 0. There are 9 PASS lines, including `PASS: settings: defaults, sanitising, round trip, themes and steps shell OK`, and no FAIL.
- A6: both greps on styles.css have no matches.
- A7: the grep for `18181b|131315|a4a4ad` in src/main and src/renderer/src has no matches.
- A8: `git check-ignore .claude/director/x` prints the path.
- Not run: A9-A15. They need the running app (`yarn dev`) or a user review.

### Follow-ups / limitations

- Native menus and dialogs keep following the OS theme (`themeSource` is not set), as planned.

### Commit status

Uncommitted.
