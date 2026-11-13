# Research: settings dialog and themes

## Question
How do persistence, colours, xterm, shell choice and UI hooks work today, so a plan can add a persisted settings dialog (theme, font family, font size, cursor style, cursor blink, scrollback, default shell) and one-theme-drives-chrome-and-xterm themes with live apply?

## Answer
- A `Settings` object already exists and is persisted in terminals.json (`shell`, `editor`, `terminalFontSize`). The IPC path `settings:set` -> `store.setSettings(patch)` -> returns full `AppState` is in place. New options extend this, not a new channel.
- Chrome colours are already CSS custom properties on `:root` (styles.css:6-47), but about 30 hex and 27 rgba literals remain in the rules (listed below). No `.tsx` file has a hard-coded colour. There is no light mode and no `prefers-color-scheme`.
- xterm theme, font and options are hard-coded in one file, `termRegistry.ts`, which holds a `Map` of all live terminals. One registry function can push options to all of them. `setTerminalFontSize` already does this for the font size.
- Shell: `resolveShell()` in pty.ts:15 is already driven by `settings.shell` (empty = pwsh.exe, then powershell.exe). A default-shell UI only needs the setting exposed. New terminals pick it up, running ones do not change.
- There are no unit tests. Only `yarn smoke` (src/main/smoke.ts) exists, and it hard-codes the `Settings` shape (smoke.ts:313).

## 1. Persistence (all confirmed)
- File: `<userData>/terminals.json`; userData is pinned to `%APPDATA%\terminals` or `--data-dir=` / `TERMINALS_DATA_DIR` (index.ts:19-28; store.ts:160).
- Shape `Persisted` (store.ts:42-51): `version, folders, groups, commands, snippets, selectedId, settings, ui`. `SCHEMA_VERSION = 3` (types.ts:2).
- Defaults: `DEFAULT_SETTINGS = { shell:'', editor:'zed', terminalFontSize:15 }` (store.ts:53). `emptyData()` at store.ts:56.
- Load (store.ts:159-191):
  - A file with a newer version is not loaded, and the session writes to `terminals.json.incompatible-session` (store.ts:165-169).
  - An older version gets a `.v<N>.bak` copy and then `migrate()`, then a save.
  - A parse failure copies the file to `.corrupt.bak` and starts empty.
- `migrate()` (store.ts:104-157) rebuilds every field with validation. Settings are rebuilt field by field at store.ts:138-143 using `num(v, def, min, max)` (store.ts:75). Missing keys fall back to defaults WITHOUT a version bump. So adding optional settings keys needs no schema bump, but `migrate` must list each new key, otherwise it is dropped on load. Reminder: it rebuilds the object, so unknown keys are lost.
- Save (store.ts:193-205): the whole `data` is written to `.tmp` then renamed, synchronously, on every mutation.
- `setSettings(patch)` (store.ts:527-534) validates per key by hand, saves, and returns `getState()`. It does not push anything to other windows. There is a single window.
- `getState()` (store.ts:235-270) returns `settings`, `ui` and `resolvedShell`.
- IPC: `ipcMain.handle('settings:set', ...)` (index.ts:270); `state:get` (index.ts:240); main -> renderer push `state:changed` via `pushState()` (index.ts:216-218), used only after MCP changes. Preload: `setSettings: (patch) => inv('settings:set', patch)` (preload/index.ts:37). Types: `TerminalsApi.setSettings(patch: Partial<Settings>): Promise<AppState>` (types.ts:231). `preload/index.d.ts` only declares `window.api: TerminalsApi`; it needs no change.
- Renderer: App holds `AppState` in React state plus `stateRef` (App.tsx:76, 96-99). `onStateChanged` is subscribed at App.tsx:585. Initial load applies the font size at App.tsx:122. On window focus it re-fetches state (App.tsx:125).
- Adding a setting touches 4 places: `Settings` interface, `DEFAULT_SETTINGS`, the `migrate` settings block, and `setSettings`. The smoke.ts fake state at smoke.ts:313 also needs the new fields, otherwise typecheck fails (`npm run typecheck`, package.json scripts). Option for "easy to add": one table of `{key, default, validate}` in shared code, used by migrate and setSettings.
- The editor setting has no UI today (`openInEditor` in index.ts:284 reads `store.getEditor()`). A dialog can include it cheaply.

## 2. Colours (confirmed by grep)
- `:root` variables (styles.css:6-47): surfaces `--bg-inset/--bg-chrome/--bg-term/--bg-raised/--bg-overlay`, `--hover`, `--active`, `--line`, `--line-strong`, text `--text/-2/-3`, accent set (`--accent`, `-hover`, `-ink`, `-soft`, `-line`), `--success(-soft)`, `--danger(-soft)`, `--shadow-pop`, plus fonts `--font-ui` and `--font-mono` (styles.css:39-40). `color-scheme: dark` at styles.css:47. About 350 `var(--` uses.
- Hard-coded colours outside `:root` (styles.css line numbers >50): about 30 hex and 27 rgba. They are:
  - Hex and gradients: 113 (#3a3a41), 201 (amber gradient), 261-262, 876, 1099-1114 (file-icon colours `.ic-folder` etc.: #8f9db5, #74bfc4, #d9b469, #c49bd6, #d69a6c, #9d9da6), 1385, 1699, 1745, 2219 (checkerboard #222227/#1b1b1f).
  - rgba white-alpha overlays: 202, 278, 649, 866, 879, 1303, 1387, 1483, 1489.
  - rgba amber (accent alpha): 581, 1272, 1275, 1499.
  - rgba red/green alpha: 289, 455, 884, 2135, 2141.
  - Modal scrim and shadows: 1287 (scrim), 1513 (rgba(19,19,21,.82), a chrome-derived overlay).
  - Most of these need to become variables or `color-mix()` on the theme variables.
- `.tsx` inline styles: zero hex/rgb literals (grep over all `src/renderer/src/*.tsx`). DiffView and FileViewer only set `fontFamily: TERM_FONT` and `fontSize` inline (DiffView.tsx:162, FileViewer.tsx:316), so they follow the terminal font settings if `TERM_FONT` becomes dynamic. Diff/git colours use CSS variables.
- Colours outside the CSS: `TERM_BG`/`THEME` in termRegistry.ts:51-83 (the xterm palette), and main-process `BAR_COLOR='#131315'` and `WINDOW_BG='#18181b'` (index.ts:32-33) used for `backgroundColor` and `titleBarOverlay.color` and `symbolColor '#a4a4ad'` (index.ts:65-68). The title bar overlay (Windows caption buttons) colour is fixed at window creation. Live change needs `win.setTitleBarOverlay({color, symbolColor})` from main, so a new IPC (or have the main process apply theme on `settings:set`) is needed. The comments say "keep in sync" with the CSS (index.ts:31, termRegistry.ts:50), which is the duplication a theme must replace.
- Also `.term-host .xterm-viewport { background-color: var(--bg-term) !important }` (styles.css:847-849): terminal background and chrome are tied through `--bg-term`. A theme should set xterm `background` equal to `--bg-term`, or the viewport shows a different colour than the canvas.
- No `prefers-color-scheme` or `@media` anywhere in styles.css (grep). No `@font-face` (fonts come from the fontsource import in main.tsx:2). "Follow system" needs `window.matchMedia('(prefers-color-scheme: dark)')` in the renderer (works in Electron by default via `nativeTheme.themeSource = 'system'`) and possibly `nativeTheme` in main. Note `color-scheme` should be set per theme (scrollbars, form controls).
- Electron CSP (index.html): `style-src 'self' 'unsafe-inline'`, so setting CSS variables via `document.documentElement.style.setProperty` or a `data-theme` attribute works.
- Some xterm-related CSS: scrollbar slider colours are in the xterm theme object (termRegistry.ts:64-66), not CSS.

## 3. xterm (confirmed)
- Single creation site: `createTerm()` in termRegistry.ts:167-252. Options: `fontFamily: TERM_FONT` (`"'Cascadia Mono', 'Cascadia Code', Consolas, monospace"`, termRegistry.ts:52), `fontSize` (module var, default 15), `lineHeight: 1.2`, `cursorBlink: true`, `scrollback: 5000`, `allowProposedApi: true`, `theme: THEME`. `cursorStyle` is not set (xterm default is block). No other options such as `cursorInactiveStyle`.
- Registry: `const entries = new Map<string, TermEntry>()` (termRegistry.ts:25), with `getTerm(id)`, `createTerm`, and per-entry `dispose`. Terminals are created by App (`createTerm` import at App.tsx:36) for shell and command tabs, and live for the life of the tab, hidden with `display:none` (TerminalView.tsx:90).
- Existing live-update precedent: `setTerminalFontSize(size)` (termRegistry.ts:131-141) sets `e.term.options.fontSize` for every entry, then `e.fit.fit()` in try/catch (hidden terminals have zero size and fit throws or is skipped). `safeFit` (TerminalView.tsx:19-27) skips fit when the host has clientWidth/Height 0, and a hidden terminal refits when it becomes visible (TerminalView.tsx:58-68, in a rAF).
- Font-family live change: `remeasureAll()` (termRegistry.ts:89-100) documents that xterm re-measures only when the option value changes, so it assigns `fontFamily` twice (a different value first, then the real one) and refits. A font-family change from the dialog needs the same pattern. Also the font must be loaded (`document.fonts.load`, termRegistry.ts:101-106 only does this for Cascadia Mono at startup; `local()` system fonts are OK, but check availability first because an unavailable family silently falls back).
- xterm 6 detail (inferred from existing code and API): assign `term.options.theme = {...}` as a whole new object to trigger a repaint; mutating a nested key does not. Options `cursorStyle` ('block'|'underline'|'bar'), `cursorBlink`, `scrollback`, `fontFamily`, `fontSize` are all settable at runtime through `term.options.X = v`. Reducing `scrollback` trims the buffer immediately. xterm 6 has no canvas/webgl addon loaded here (only fit and web-links), so it uses the DOM renderer, and theme changes are cheap. Not verified in node_modules; treat as inferred.
- `TERM_FONT`/`TERM_BG`/`DEFAULT_FONT_SIZE` are imported elsewhere: DiffView.tsx:5, FileViewer.tsx:5, App.tsx:36 (font-size zoom, clamp 8-36 at App.tsx:465, store clamps 8-40, store.ts:142/531: mismatched ranges, harmless but the dialog should use one).
- Zoom (Ctrl +/-/0) writes `terminalFontSize` via `setSettings` (App.tsx:462-471). The dialog's font-size field and zoom must stay in sync (both write the same setting, so they do, as long as the dialog reads from state).
- The theme is also used for ANSI default colours of exit messages: `\x1b[90m` etc. in termRegistry.ts:116-124. With a light theme, bright-black or the greys still work because they come from the palette.

## 4. Shell (confirmed)
- `resolveShell(configured)` pty.ts:15-18: configured non-empty and not 'auto' is used verbatim; otherwise `pwsh.exe` on PATH, else `powershell.exe` (`findOnPath`, pty.ts:5-12).
- Used by `store.getShell()` (store.ts:272) which `pty:create` (index.ts:357-358) uses for both `spawnShell` and `spawnSteps`. `resolvedShell` is also sent in state for tab titles (`shellLabel`, App.tsx:48, 218).
- `buildRunArgs` (pty.ts:33-47) treats any shell matching `/pwsh|powershell/i` as PowerShell; anything else gets cmd-style `/d /s /c a && b`. So selecting bash/wsl.exe/nu would break command tabs (saved commands). The default-shell setting should either restrict to a list (pwsh, powershell, cmd, + custom) or the planner must decide how command runs handle other shells.
- An invalid configured shell path fails at pty spawn, shown as "Failed to start" in the terminal (TerminalView.tsx:41-50), not validated in the store.
- smoke.ts: `resolveShell('')` at smoke.ts:399, passed to the interactive/steps/env checks; `checkMigration()` (smoke.ts:78-97) calls `migrate()` on v1/v2 fixtures and asserts `SCHEMA_VERSION === 3` (smoke.ts:89): a schema bump breaks this assertion (update it). Fake `AppState` for MCP logic at smoke.ts:313 includes `settings: {shell,editor,terminalFontSize}`.
- Running terminals keep their shell; only new tabs use the new default. State this in the UI.

## 5. UI hooks (confirmed)
- Gear button: sidebar header `head-actions` icon row (Sidebar.tsx:~498-512, buttons `icon-btn` with lucide icons `FolderPlus, FolderTree, Group, RefreshCw`). There is no sidebar footer. Sidebar gets all callbacks as props from App.tsx:664+ (the planner must add `onOpenSettings`). Alternatives: TabBar (TabBar.tsx), or a titlebar zone (styles.css:182 drag region, 234/238 no-drag). The sidebar can be collapsed (`ui.sidebarCollapsed`), so the gear would vanish; Ctrl+, is the fallback.
- Shortcut: two places have to handle keys, because xterm swallows keys when focused.
  1. Window-level `keydown` in App.tsx:526-563 (bails on `defaultPrevented`).
  2. xterm `attachCustomKeyEventHandler` in termRegistry.ts:182-229, calling `hooks.*` from `TermHooks` (termRegistry.ts:28-45, set by `setTermHooks` at App.tsx:515-524). Adding `onOpenSettings` means: TermHooks field + default no-op + custom-key branch + the App.tsx hook + window handler. Ctrl+, is not currently used. Existing patterns: Ctrl+Shift+P opens the SnippetPicker (`pickerOpen` state, App.tsx:85, render at App.tsx:973).
- `Keys.tsx` is only a presentational key-cap component (`<Keys combo="Ctrl+Enter"/>`), not a shortcut registry.
- Modal pattern: `SnippetEditor.tsx` (123 lines) and `CommandEditor.tsx` (247 lines): `.modal-backdrop` (onMouseDown = cancel) > `.modal` (stopPropagation, `role="dialog"`) with `.modal-head` (h3 plus `icon-btn` X), `.modal-body` of `<label className="field"><span>..</span><input/select/textarea/></label>`, `.modal-foot` with `.hint`, `.btn`, `.btn.primary`. Escape handled via a window keydown effect (SnippetEditor.tsx:55-61). Ctrl+Enter saves. CSS at styles.css:1284-1350 (`--z-modal: 50`). App conditionally renders modals at the end of App's JSX (App.tsx:973-983). CommandEditor and SnippetEditor are rendered inside their panels (CommandsPanel), not in App, so a settings dialog should be rendered in App next to `SnippetPicker`.
- Dialog apply semantics: other editors save on a button. For live apply, the dialog can call `window.api.setSettings({key: v})` on each change and `setState(...)` with the result, plus a registry apply. A cancel/revert path requires holding the initial values.
- Icons: `lucide-react` (`Settings` icon is available there).

## 6. Fonts (confirmed)
- UI font: Geist Variable, bundled through `@fontsource-variable/geist` (package.json:18; imported `main.tsx:2` as `@fontsource-variable/geist/wght.css`). `--font-ui: 'Geist Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif` (styles.css:39).
- Terminal font: NOT bundled. `'Cascadia Mono', 'Cascadia Code', Consolas, monospace` is resolved from the user's installed system fonts (termRegistry.ts:52; CSS `--font-mono` styles.css:40 duplicates it). So the font-family setting is a free-text or list of system fonts. There is no API to enumerate installed fonts without `queryLocalFonts` (not verified to work in Electron's sandboxed renderer; inferred, so offer a text field with presets). The "follow `--font-mono` and `TERM_FONT`" duplication should be unified (CSS var set from the setting).
- `TERM_FONT` const is imported by DiffView and FileViewer, so it must become a live value, or those components must read from a variable; otherwise they will not follow the setting. Make them use `var(--font-mono)` and set the variable from settings, or pass the font from state.

## 7. Other
- `src/main/mcp.ts` / `mcpTools.ts`: use `store.getState()`, `saveCommand`, etc. They do not read `settings` (grep: no `settings` hits in mcp files; `locationById(store.getState(), ...)` in index.ts:225). MCP can't break from settings changes, and `pushState()` (index.ts:216) exists for main-initiated state change.
- Tests: no test runner, no `*.test.*` files, no test script in package.json. The only automated check is `yarn smoke` (`electron-vite build && electron . --smoke`), whose checks are in smoke.ts (checkMigration at 78, checkPanes 100, checkMcpLogic...). It imports `migrate` from store and `SCHEMA_VERSION`. A new smoke check for settings sanitising (e.g. migrate with garbage settings returns defaults) fits this pattern. Typecheck: `yarn typecheck`. I did not run anything.
- Main window uses `titleBarStyle: 'hidden'` with an overlay (index.ts:67-68), so theme changes must update the overlay (see section 2). The tray window hides on close (index.ts:86-91), so the renderer is long-lived.
- `focus` handler refreshes state (App.tsx:125), so a settings change from another source would propagate on focus; theme application should be in an effect keyed on `state.settings.*`, not only in the dialog's handler.
- Flash of unthemed content: the BrowserWindow `backgroundColor` is fixed (WINDOW_BG) before the renderer loads; with a saved light theme the window shows dark first. Mitigation: the main process reads the theme from the store when creating the window (store is loaded sync in main, `loadStore` before window). "Follow system" can use `nativeTheme.shouldUseDarkColors` in main.

## Risks / gotchas
1. `migrate()` rebuilds `settings` field by field (store.ts:138-143): any new key not added there is silently lost on restart. Same for `setSettings` (store.ts:527-534), which ignores unknown keys.
2. A new setting that has a default needs no schema bump, but if the plan adds a bump, `smoke.ts:89` asserts `SCHEMA_VERSION === 3` and the fake state at smoke.ts:313 is typed `AppState`, so both break.
3. Window caption-button overlay (`titleBarOverlay`) and window `backgroundColor` are set in main from constants (index.ts:32-33, 65-68); themes need main-process involvement (`setTitleBarOverlay`, `setBackgroundColor`) and an initial value read from the store.
4. About 57 colour literals stay in styles.css outside `:root`, and a light theme will look wrong unless they are converted (file-icon colours, white-alpha hovers/highlights, shadows, the checkerboard at 2219, the scrim). Counts were from grep, line list above.
5. Terminal viewport background is forced via `--bg-term` with `!important` (styles.css:847): the xterm `theme.background` must equal `--bg-term` from the same theme object.
6. Font family change requires the double-assign remeasure + refit trick (termRegistry.ts:89-100); hidden terminals cannot fit (0 size) and rely on the visible-effect refit (TerminalView.tsx:58-68). `TERM_FONT` is imported as a constant by DiffView/FileViewer and by the registry at creation: all would need to read the live value.
7. Font-size ranges disagree: zoom clamps 8-36 (App.tsx:465), store clamps 8-40 (store.ts:142, 531). Zoom keys and the dialog write the same setting. Keep one source.
8. Key handling is duplicated (xterm custom handler and window listener); a new Ctrl+, must be wired in both or it does not work when a terminal is focused.
9. Default shell: `buildRunArgs` only knows PowerShell vs cmd (`/pwsh|powershell/i`, pty.ts:35). Other shells would break saved-command runs. Existing terminals keep the old shell. No validation of the path exists.
10. `scrollback` lowered at runtime trims history; cursor style/blink also apply to command tabs; theme changes apply to every entry in the `entries` map, including hidden ones (fine, no fit needed for theme).
11. `setSettings` saves synchronously per call, so a slider or text input firing per keystroke writes the file each time; debounce in the renderer.
12. `yarn smoke` needs a build and spawns real ptys; not run for this research.

## Open questions
- Should "default shell" be a fixed list (pwsh/powershell/cmd) or free text? Command tabs (`buildRunArgs`) decide.
- Does `queryLocalFonts` work in this Electron renderer for a font picker (not tested)?
- Should theme definitions live in shared code (`src/shared`) so main (window colours) and the renderer (CSS + xterm) use one source? Likely yes, since main needs bar and background colours too.
- xterm 6 runtime-option behaviours above (new theme object, scrollback trim) were not verified against node_modules typings.
