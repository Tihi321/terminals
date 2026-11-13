---
status: in-progress
request: REQ-0001
repos: [terminals]
branch: feature/settings-and-themes
updated: 2026-11-13
---
# Plan: settings dialog and themes

Built on `research.md` in this folder (re-checked against the code on 2026-11-13; line numbers below are from master `183e3c9`).
Reading chosen: the **full** one. Every listed option applies live to the UI and to every open terminal; the theme drives app chrome, the xterm palette and the native title bar; settings persist in terminals.json.

## 1. Scope

In scope:
- A settings dialog opened by a gear button in the sidebar head and by **Ctrl+,** (window and focused terminal; toggles). Options: theme, terminal font family, font size, cursor style, cursor blink, scrollback, default shell, plus the existing editor command (cheap, it had no UI).
- One shared settings schema (`src/shared/settings.ts`) that holds defaults and per-key validation, used by `migrate()`, `setSettings()` and the smoke check; the dialog is driven by a field table.
- Themes in one shared module (`src/shared/themes.ts`): each theme defines the chrome CSS variables, the xterm palette, and (derived) the window background and title bar overlay colours. Built-ins: **Dark** (current look), **Light**, **Fjord** (dark, cool blue-grey, Nord-style), **Sandstone** (light, warm, Solarized-light-style), plus **Follow system** that tracks the OS light/dark preference live (Dark/Light).
- Live apply to UI and every terminal (hidden terminals refit/remeasure when shown); no restart; persisted; no dark flash with a light theme (main knows the theme at window creation).
- Default shell picker limited to known shells; applies to new terminals only, stated in the dialog.
- `.claude/director/` added to `.gitignore`.

**Out of scope** (do not build):
- Custom, imported or user-edited themes; per-theme overrides of single colours; theme editor.
- Per-folder, per-group or per-tab settings; changing the shell of running terminals.
- Shells other than PowerShell 7, Windows PowerShell and cmd in the picker (bash, Git Bash, WSL, nu); per-shell run-argument builders.
- Font enumeration (`queryLocalFonts`), bundling new fonts, UI font / UI scale settings, line height, letter spacing.
- Keybinding customisation; settings import/export; settings sync between machines.
- Changing `nativeTheme.themeSource` (native menus/dialogs keep following the OS).
- A schema version bump (`SCHEMA_VERSION` stays 3).

## 2. Files and modules to touch

| File | Change | Task |
|---|---|---|
| `src/shared/settings.ts` (new) | settings schema, defaults, ranges, sanitize/patch, `fontStack` | T1 |
| `src/shared/themes.ts` (new) | `Theme` types, 4 built-in themes, `resolveThemeId`, `getTheme`, `windowColors` | T1 |
| `src/shared/types.ts` | extend `Settings`; add `ThemeId`, `ThemeSetting`, `CursorStyle`, `ShellOption`; `TerminalsApi.listShells`, `TerminalsApi.initialThemeId` | T1 |
| `src/main/store.ts` | use shared schema in `migrate` and `setSettings`; drop local `DEFAULT_SETTINGS`; add `getSettings()` | T1 |
| `src/main/pty.ts` | `listShells()`, `stepsShell()`, bare-name resolution in `resolveShell` | T1 |
| `src/main/index.ts` | theme-aware window creation, `applyWindowTheme()`, `nativeTheme` listener, IPC `theme:initial` (sync) and `settings:shells`, spawnSteps via `stepsShell` | T1 |
| `src/preload/index.ts` | `initialThemeId`, `listShells` | T1 |
| `src/main/smoke.ts` | fake state uses `DEFAULT_SETTINGS`; new `checkSettings()` | T1 |
| `.gitignore` | add `.claude/director/` | T1 |
| `src/renderer/src/appearance.ts` (new) | `applyTheme`, `useSystemDark`, `useAppearance` | T2 |
| `src/renderer/src/termRegistry.ts` | live options (`applyTerminalOptions`), hidden remeasure, `onOpenSettings` hook + Ctrl+, ; remove `TERM_BG`, `TERM_FONT`, `DEFAULT_FONT_SIZE`, `setTerminalFontSize`, `THEME` | T2 |
| `src/renderer/src/TerminalView.tsx` | call `refreshTerm(id)` when a terminal becomes visible | T2 |
| `src/renderer/src/styles.css` | remove colour values from `:root`; replace literals with theme variables / `color-mix()` | T2 |
| `src/renderer/src/main.tsx` | apply initial theme before `createRoot` | T2 |
| `src/renderer/src/DiffView.tsx`, `FileViewer.tsx` | `fontFamily: 'var(--font-mono)'` instead of `TERM_FONT` | T2 |
| `src/renderer/src/SettingsDialog.tsx` (new), `SettingsDialog.css` (new) | the dialog | T3 |
| `src/renderer/src/App.tsx` | dialog state/render, Ctrl+, in window handler, `onOpenSettings` term hook, `useAppearance`, zoom uses shared range | T3 |
| `src/renderer/src/Sidebar.tsx` | gear button + `onOpenSettings` prop | T3 |

Not touched: `src/preload/index.d.ts` (declares `window.api: TerminalsApi` only), `mcp.ts`, `mcpTools.ts` (they do not read settings), `index.html`.

## 3. Tasks

Order: **T1 first (alone)**. Then **T2 and T3 in parallel** (no shared files). Final verification (typecheck + smoke) after both. T3's code imports `useAppearance` from T2's `appearance.ts` and T2 removes exports App.tsx uses today, so `yarn typecheck` is only expected to pass once T2 and T3 are both done; each of T2/T3 runs typecheck at the end and may only report errors that belong to the other task's files.

Node: if `yarn`/`node` is not on PATH, run `fnm exec --using default yarn <script>`.

### Shared contract (written by T1, read by T2/T3; do not change names)

`src/shared/types.ts`:
```ts
export type ThemeId = 'dark' | 'light' | 'fjord' | 'sandstone'
export type ThemeSetting = ThemeId | 'system'
export type CursorStyle = 'block' | 'bar' | 'underline'

export interface Settings {
  /** Shell executable. '' = auto (pwsh.exe if on PATH, else powershell.exe). Applies to new terminals only. */
  shell: string
  /** Editor executable resolved on PATH (default "zed"). */
  editor: string
  terminalFontSize: number
  theme: ThemeSetting
  /** CSS font-family list for terminals, diff and file viewers. */
  terminalFontFamily: string
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
}

/** One entry of the default-shell picker. value '' = automatic. */
export interface ShellOption {
  value: string
  label: string
  /** False when the executable is not on PATH (shown disabled). Always true for ''. */
  available: boolean
}
```
`TerminalsApi` gains (keep `setSettings(patch: Partial<Settings>): Promise<AppState>` as is):
```ts
  /** Concrete theme main resolved when the window was created ('system' already resolved). Paints the first frame. */
  readonly initialThemeId: ThemeId
  /** Known shells for the default-shell picker, with PATH availability. */
  listShells(): Promise<ShellOption[]>
```

Settings table (defaults, valid values; `sanitize` returns `undefined` for invalid input):

| key | default | valid / normalisation |
|---|---|---|
| `shell` | `''` | any string, trimmed (no list enforcement in the store, so a hand-edited value survives) |
| `editor` | `'zed'` | non-empty after trim |
| `terminalFontSize` | `15` | finite number, rounded, clamped to `FONT_SIZE_MIN` 8 .. `FONT_SIZE_MAX` 36 |
| `theme` | `'dark'` | one of `THEME_IDS` or `'system'` |
| `terminalFontFamily` | `DEFAULT_TERMINAL_FONT` = `"'Cascadia Mono', 'Cascadia Code', Consolas, monospace"` | string, trimmed, length 1..200, must not match `/[;{}<>\\]/`; `''` sanitises to the default (so clearing the field resets it) |
| `cursorStyle` | `'block'` | `'block' \| 'bar' \| 'underline'` |
| `cursorBlink` | `true` | boolean only |
| `scrollback` | `5000` | finite number, rounded, clamped to `SCROLLBACK_MIN` 0 .. `SCROLLBACK_MAX` 100000 |

`src/shared/settings.ts` exports exactly:
```ts
export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 36
export const SCROLLBACK_MIN = 0
export const SCROLLBACK_MAX = 100000
export const DEFAULT_TERMINAL_FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, monospace"
export interface SettingField<T> { default: T; sanitize: (v: unknown) => T | undefined }
export const SETTINGS_SCHEMA: { [K in keyof Settings]: SettingField<Settings[K]> }
export const DEFAULT_SETTINGS: Settings            // built from SETTINGS_SCHEMA defaults
/** Full Settings from anything (file contents): each key = sanitize(raw[key]) ?? default; unknown keys dropped. */
export function sanitizeSettings(raw: unknown): Settings
/** New object: for each schema key present in patch, sanitize; invalid values keep cur's value; unknown keys ignored. */
export function patchSettings(cur: Settings, patch: unknown): Settings
/** Family list with a trailing generic: appends ", monospace" unless the list already ends with "monospace". */
export function fontStack(family: string): string
```
Implementation note for TS: iterate `Object.keys(SETTINGS_SCHEMA) as (keyof Settings)[]` and write through a generic helper `function field<K extends keyof Settings>(k: K, v: unknown): Settings[K] | undefined` and `(out as Record<keyof Settings, unknown>)[k] = ...`, so union types do not collapse to `never`. Adding an option later = one `Settings` field + one `SETTINGS_SCHEMA` entry + one `FIELDS` entry in the dialog + its apply code.

`src/shared/themes.ts` exports exactly:
```ts
export const UI_VARS = [ /* the 38 keys below, in this order */ ] as const
export type UiVar = (typeof UI_VARS)[number]
export interface TerminalPalette {
  background: string; foreground: string; cursor: string; cursorAccent: string
  selectionBackground: string; selectionInactiveBackground: string
  scrollbarSliderBackground: string; scrollbarSliderHoverBackground: string; scrollbarSliderActiveBackground: string
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string
}
export interface Theme {
  id: ThemeId
  name: string               // 'Dark' | 'Light' | 'Fjord' | 'Sandstone'
  kind: 'dark' | 'light'     // drives CSS color-scheme
  ui: Record<UiVar, string>  // written to :root as --<key>
  terminal: TerminalPalette  // terminal.background MUST equal ui['bg-term'], cursorAccent likewise
}
export const THEME_IDS: readonly ThemeId[]           // ['dark', 'light', 'fjord', 'sandstone']
export const THEMES: Record<ThemeId, Theme>
export function getTheme(id: ThemeId): Theme
/** 'system' -> systemDark ? 'dark' : 'light'; any ThemeId -> itself. */
export function resolveThemeId(setting: ThemeSetting, systemDark: boolean): ThemeId
/** Native window colours: background = ui['bg-term'], titleBar = ui['bg-chrome'], symbol = ui['text-2']. */
export function windowColors(t: Theme): { background: string; titleBar: string; symbol: string }
```
`UI_VARS` order: `bg-inset, bg-chrome, bg-term, bg-raised, bg-overlay, hover, active, line, line-strong, line-hover, control-border, control-hover, control-active, text, text-2, text-3, accent, accent-hover, accent-ink, accent-soft, accent-line, accent-grad, success, success-soft, danger, danger-soft, tint, scrim, tile-grad, checker-a, checker-b, ic-folder, ic-code, ic-json, ic-image, ic-archive, ic-text, shadow-pop`.

Renderer contract (written by T2, used by T3):
```ts
// src/renderer/src/appearance.ts
export function applyTheme(theme: Theme): void
export function useSystemDark(): boolean
/** Resolves the theme (tracking the OS when theme = 'system'), applies chrome + --font-mono + every terminal. No-op for undefined. */
export function useAppearance(settings: Settings | undefined): void
// src/renderer/src/termRegistry.ts
export interface TermHooks { /* existing fields */ onOpenSettings: () => void }
```

IPC: no new write channel. `settings:set` stays the only write path (main applies window colours inside that handler). New: `theme:initial` (`ipcMain.on`, synchronous, returns `ThemeId`) and `settings:shells` (`ipcMain.handle`, returns `ShellOption[]`).

### T1 - Shared schema, themes, store, main, preload, smoke (sequential, first)

Inputs: this plan; research.md sections 1, 2, 4.
Outputs: shared contract above implemented; main/preload/store wired; smoke extended; `.gitignore` line. T1 only adds fields and exports, so the unchanged renderer still compiles: `yarn typecheck` and `yarn smoke` must both pass at the end of T1.
Files owned: `src/shared/settings.ts` (new), `src/shared/themes.ts` (new), `src/shared/types.ts`, `src/main/store.ts`, `src/main/pty.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/main/smoke.ts`, `.gitignore`.

Steps:
1. `types.ts`: add the types and `TerminalsApi` members from the contract. Leave `SCHEMA_VERSION = 3`.
2. `settings.ts`: as in the contract. `shell` sanitize: `typeof v === 'string' ? v.trim() : undefined`. Number sanitizers: `typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v)) : undefined`.
3. `themes.ts`: the four themes with the exact values in "Theme values" below. Dark must reproduce today's colours exactly (values copied from `styles.css:6-47` and `termRegistry.ts:56-83`).
4. `store.ts`: delete `DEFAULT_SETTINGS` (store.ts:53) and import it from `../shared/settings`; `emptyData()` uses `{ ...DEFAULT_SETTINGS }`; in `migrate()` replace the settings block (store.ts:136-141) with `d.settings = sanitizeSettings(raw.settings)` (keep the comment about v1->v2); `setSettings(patch)` becomes `data.settings = patchSettings(data.settings, patch); save(); return getState()`; add `export function getSettings(): Settings { return data.settings }`. Note: stored font sizes 37-40 now clamp to 36 (accepted).
5. `pty.ts`:
   - `resolveShell(configured)`: when `configured` is non-empty, not `'auto'`, and contains no `/` or `\`, return `findOnPath(configured) ?? configured`; otherwise unchanged.
   - `export function isRunnableShell(shell: string): boolean` = `/pwsh|powershell/i.test(shell) || /(^|[\\/])cmd(\.exe)?$/i.test(shell)`.
   - `export function stepsShell(shell: string): string` = `isRunnableShell(shell) ? shell : resolveShell('')`.
   - `export function listShells(): ShellOption[]` returns, in order: `{ value: '', label: 'Automatic (PowerShell 7, else Windows PowerShell)', available: true }`, `{ value: 'pwsh.exe', label: 'PowerShell 7 (pwsh)', available: !!findOnPath('pwsh.exe') }`, `{ value: 'powershell.exe', label: 'Windows PowerShell', available: !!findOnPath('powershell.exe') }`, `{ value: 'cmd.exe', label: 'Command Prompt (cmd)', available: !!findOnPath('cmd.exe') }`.
6. `index.ts`:
   - Import `nativeTheme` from electron, `getTheme`, `resolveThemeId`, `windowColors` from `../shared/themes`, `listShells`, `stepsShell` from `./pty`.
   - Delete `BAR_COLOR`, `WINDOW_BG` and their "keep in sync" comment (index.ts:31-33).
   - `function currentTheme(): Theme { return getTheme(resolveThemeId(store.getSettings().theme, nativeTheme.shouldUseDarkColors)) }`.
   - `createWindow()`: `const c = windowColors(currentTheme())`; `backgroundColor: c.background`, `titleBarOverlay: { color: c.titleBar, symbolColor: c.symbol, height: 36 }`.
   - `function applyWindowTheme(): void` - if `win` alive: `const c = windowColors(currentTheme()); win.setBackgroundColor(c.background); try { win.setTitleBarOverlay({ color: c.titleBar, symbolColor: c.symbol, height: 36 }) } catch { /* overlay unsupported */ }`.
   - In `registerIpc()`: `ipcMain.handle('settings:set', (_e, patch) => { const s = store.setSettings(patch); applyWindowTheme(); return s })`; `ipcMain.handle('settings:shells', () => listShells())`; `ipcMain.on('theme:initial', (e) => { e.returnValue = resolveThemeId(store.getSettings().theme, nativeTheme.shouldUseDarkColors) })`.
   - In `app.whenReady()` (non-smoke branch, after `registerIpc()`): `nativeTheme.on('updated', applyWindowTheme)`. Do NOT set `nativeTheme.themeSource` (the renderer's `prefers-color-scheme` must keep following the OS).
   - `pty:create` handler: steps use `spawnSteps(stepsShell(store.getShell()), ...)`; interactive shells unchanged.
7. `preload/index.ts`: add `initialThemeId: ipcRenderer.sendSync('theme:initial') as ThemeId` (evaluated once when the preload runs) and `listShells: () => inv('settings:shells')`.
8. `smoke.ts`:
   - Fake `AppState` at smoke.ts:313: `settings: { ...DEFAULT_SETTINGS }`.
   - Add `function checkSettings(): CheckResult` and call it in `runSmoke` right after `checkMigration()`. It asserts, all in one check:
     a. `JSON.stringify(sanitizeSettings(undefined)) === JSON.stringify(DEFAULT_SETTINGS)`.
     b. `migrate({ version: 3, settings: { shell: ' cmd.exe ', terminalFontSize: 99, theme: 'nope', cursorStyle: 'bar', cursorBlink: false, scrollback: -5, terminalFontFamily: 'x;}', extra: 1 } } as never).settings` has `shell === 'cmd.exe'`, `terminalFontSize === 36`, `theme === 'dark'`, `cursorStyle === 'bar'`, `cursorBlink === false`, `scrollback === 0`, `terminalFontFamily === DEFAULT_TERMINAL_FONT`, `editor === 'zed'`, and no `extra` key.
     c. Round trip: `const p = patchSettings(DEFAULT_SETTINGS, { theme: 'light', scrollback: 12000.4, cursorBlink: 'yes', bogus: 1 })`; then `migrate({ version: 3, settings: JSON.parse(JSON.stringify(p)) } as never).settings` deep-equals `p` (by JSON.stringify), with `p.theme === 'light'`, `p.scrollback === 12000`, `p.cursorBlink === true`.
     d. Themes: for every id in `THEME_IDS`, every `UI_VARS` key is a non-empty string, `terminal.background === ui['bg-term']`, `terminal.cursorAccent === ui['bg-term']`; `resolveThemeId('system', true) === 'dark'` and `resolveThemeId('system', false) === 'light'`.
     e. `stepsShell('C:\\tools\\bash.exe') === resolveShell('')` and `stepsShell('cmd.exe') === 'cmd.exe'`.
     Message on pass: `settings: defaults, sanitising, round trip, themes and steps shell OK`; on failure include which letter failed.
   - Leave the `SCHEMA_VERSION === 3` assertion as is.
9. `.gitignore`: add a line `.claude/director/` after `.claude/temp/`.

**T1 status: DONE (2026-11-13).** Steps 1-9 implemented as written, no deviations. `yarn typecheck` exit 0; `yarn smoke` all PASS incl. `settings: defaults, sanitising, round trip, themes and steps shell OK`; `git check-ignore .claude/director/x` prints the path.

#### Theme values (T1 writes these verbatim)

Shared literal: `SHADOW_DARK = '0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 12px 32px -8px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.35)'`.

| UI var | Dark | Light | Fjord | Sandstone |
|---|---|---|---|---|
| bg-inset | #0e0e10 | #e8e8eb | #1f232b | #ece5d3 |
| bg-chrome | #131315 | #efeff1 | #232831 | #f1ead9 |
| bg-term | #18181b | #f9f9fa | #2a303b | #faf5e8 |
| bg-raised | #1e1e22 | #ffffff | #303744 | #fffaf0 |
| bg-overlay | #222227 | #ffffff | #353d4b | #fffbf3 |
| hover | rgba(255, 255, 255, 0.045) | rgba(0, 0, 0, 0.045) | rgba(236, 239, 244, 0.05) | rgba(60, 50, 30, 0.05) |
| active | rgba(255, 255, 255, 0.075) | rgba(0, 0, 0, 0.08) | rgba(236, 239, 244, 0.085) | rgba(60, 50, 30, 0.09) |
| line | #242428 | #e1e1e5 | #343b48 | #e3dac4 |
| line-strong | #303036 | #d2d2d8 | #3f4757 | #d6ccb3 |
| line-hover | #3a3a41 | #c3c3ca | #4a5366 | #c9bea3 |
| control-border | #44444c | #b4b4bc | #556074 | #b9ad90 |
| control-hover | #26262b | #e7e7ea | #343c4a | #ebe3cf |
| control-active | #2a2a30 | #ffffff | #3a4352 | #fffaf0 |
| text | #ececef | #1c1c21 | #e6e9ef | #2f3a3f |
| text-2 | #a4a4ad | #55555e | #b3bccb | #56646b |
| text-3 | #707079 | #84848d | #808a9c | #84908f |
| accent | #e8a54f | #b5690f | #86c1d4 | #2a7fb0 |
| accent-hover | #f0b468 | #9c5a0a | #9dd0e0 | #1f6d9b |
| accent-ink | #1d1407 | #ffffff | #12202a | #ffffff |
| accent-soft | rgba(232, 165, 79, 0.13) | rgba(181, 105, 15, 0.12) | rgba(134, 193, 212, 0.14) | rgba(42, 127, 176, 0.12) |
| accent-line | rgba(232, 165, 79, 0.5) | rgba(181, 105, 15, 0.45) | rgba(134, 193, 212, 0.5) | rgba(42, 127, 176, 0.45) |
| accent-grad | linear-gradient(160deg, #f1b866, #d9923a) | linear-gradient(160deg, #d08a2e, #b0640c) | linear-gradient(160deg, #9dd0e0, #6aa9be) | linear-gradient(160deg, #3a92c4, #2370a0) |
| success | #8cc792 | #2f8a3e | #a6c98f | #5d8a12 |
| success-soft | rgba(140, 199, 146, 0.12) | rgba(47, 138, 62, 0.12) | rgba(166, 201, 143, 0.13) | rgba(93, 138, 18, 0.12) |
| danger | #ee7d76 | #c73e36 | #d98890 | #c4413a |
| danger-soft | rgba(238, 125, 118, 0.12) | rgba(199, 62, 54, 0.1) | rgba(217, 136, 144, 0.13) | rgba(196, 65, 58, 0.1) |
| tint | #ffffff | #000000 | #ffffff | #000000 |
| scrim | rgba(8, 8, 10, 0.62) | rgba(20, 20, 26, 0.32) | rgba(15, 18, 24, 0.62) | rgba(60, 50, 30, 0.3) |
| tile-grad | linear-gradient(180deg, #232328, #1b1b1f) | linear-gradient(180deg, #ffffff, #efeff1) | linear-gradient(180deg, #353d4b, #2a303b) | linear-gradient(180deg, #fffaf0, #f1ead9) |
| checker-a | #222227 | #e8e8eb | #353d4b | #ece5d3 |
| checker-b | #1b1b1f | #f9f9fa | #2a303b | #faf5e8 |
| ic-folder | #8f9db5 | #5a6f94 | #93a8c8 | #5f7aa3 |
| ic-code | #74bfc4 | #24858c | #86c1d4 | #2a8a8a |
| ic-json | #d9b469 | #9a6f00 | #e5c88f | #a57900 |
| ic-image | #c49bd6 | #8a52a6 | #b997c4 | #8a5aa8 |
| ic-archive | #d69a6c | #b05d24 | #d6a07f | #b5602c |
| ic-text | #9d9da6 | #77777f | #a3abba | #7a8384 |
| shadow-pop | SHADOW_DARK | 0 1px 0 rgba(255, 255, 255, 0.7) inset, 0 12px 32px -8px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08) | SHADOW_DARK | 0 1px 0 rgba(255, 255, 255, 0.6) inset, 0 12px 32px -8px rgba(60, 50, 30, 0.25), 0 2px 6px rgba(60, 50, 30, 0.12) |

| Terminal key | Dark | Light | Fjord | Sandstone |
|---|---|---|---|---|
| background | #18181b | #f9f9fa | #2a303b | #faf5e8 |
| foreground | #dedee3 | #26262c | #dfe3ea | #3a464c |
| cursor | #e8a54f | #b5690f | #86c1d4 | #2a7fb0 |
| cursorAccent | #18181b | #f9f9fa | #2a303b | #faf5e8 |
| selectionBackground | #3a3a44 | #d6d9e3 | #46506a | #e6dcc2 |
| selectionInactiveBackground | #2c2c33 | #e5e6ec | #3a4252 | #efe7d3 |
| scrollbarSliderBackground | rgba(255, 255, 255, 0.08) | rgba(0, 0, 0, 0.12) | rgba(255, 255, 255, 0.08) | rgba(0, 0, 0, 0.12) |
| scrollbarSliderHoverBackground | rgba(255, 255, 255, 0.16) | rgba(0, 0, 0, 0.2) | rgba(255, 255, 255, 0.16) | rgba(0, 0, 0, 0.2) |
| scrollbarSliderActiveBackground | rgba(255, 255, 255, 0.22) | rgba(0, 0, 0, 0.28) | rgba(255, 255, 255, 0.22) | rgba(0, 0, 0, 0.28) |
| black | #2e2e34 | #26262c | #3b4252 | #3a464c |
| red | #ee7d76 | #c0392f | #d98890 | #c4413a |
| green | #93c88a | #3a7d2a | #a6c98f | #5d8a12 |
| yellow | #e3b462 | #8f6400 | #e5c88f | #9c7400 |
| blue | #80a8e2 | #2b5fb4 | #88a6cf | #2a7fb0 |
| magenta | #c69cd8 | #9a3ea8 | #b997c4 | #b0407a |
| cyan | #73c0c5 | #187c84 | #8cc8c8 | #2a8a8a |
| white | #c9c9d0 | #8c8c95 | #d6dae2 | #8a8f85 |
| brightBlack | #71717b | #6e6e78 | #737d91 | #7c8784 |
| brightRed | #f69d96 | #d0503f | #e6a0a7 | #d0603a |
| brightGreen | #b2dda4 | #4b9136 | #bcdba8 | #6f9c20 |
| brightYellow | #f1ca80 | #a67700 | #eed8a8 | #ad8500 |
| brightBlue | #a0bfee | #4274c8 | #a5bde0 | #4a73c4 |
| brightMagenta | #d9b7e8 | #ad55bb | #cdb0d6 | #7a5ab8 |
| brightCyan | #96d7da | #24909a | #a8d9d9 | #3a9a95 |
| brightWhite | #f4f4f6 | #5c5c66 | #eef0f4 | #5f6b6f |

(In the light themes `white`/`brightWhite` are mid-greys on purpose so text drawn in "white" stays readable on a light background.)

### T2 - Renderer theming and live terminal options (parallel with T3, after T1)

Inputs: this plan; T1's shared modules; research.md sections 2, 3, 6.
Outputs: chrome and terminals follow settings live; no literal theme colours left in `styles.css`; `appearance.ts` contract implemented; `TermHooks.onOpenSettings` + Ctrl+, inside terminals.
Files owned: `src/renderer/src/appearance.ts` (new), `src/renderer/src/termRegistry.ts`, `src/renderer/src/TerminalView.tsx`, `src/renderer/src/styles.css`, `src/renderer/src/main.tsx`, `src/renderer/src/DiffView.tsx`, `src/renderer/src/FileViewer.tsx`.

Steps:
1. `termRegistry.ts`:
   - Delete `TERM_BG`, `TERM_FONT`, `DEFAULT_FONT_SIZE`, `fontSize`, `THEME`, `setTerminalFontSize`, and the Cascadia preload block's use of `TERM_FONT` (keep the preload, see below).
   - Add:
     ```ts
     export interface TerminalOptions {
       fontFamily: string        // already a full stack (fontStack(settings.terminalFontFamily))
       fontSize: number
       cursorStyle: CursorStyle
       cursorBlink: boolean
       scrollback: number
       theme: TerminalPalette    // a THEMES[...].terminal object; compared by reference
     }
     let current: TerminalOptions = {
       fontFamily: fontStack(DEFAULT_SETTINGS.terminalFontFamily), fontSize: DEFAULT_SETTINGS.terminalFontSize,
       cursorStyle: DEFAULT_SETTINGS.cursorStyle, cursorBlink: DEFAULT_SETTINGS.cursorBlink,
       scrollback: DEFAULT_SETTINGS.scrollback, theme: getTheme(window.api.initialThemeId).terminal
     }
     export function applyTerminalOptions(o: TerminalOptions): void
     export function refreshTerm(id: string): void
     ```
   - `TermEntry` gains `remeasure: boolean` (init false).
   - `applyTerminalOptions(o)`: compute which fields differ from `current`, set `current = o`, then for every entry: assign only changed options (`term.options.fontSize`, `.cursorStyle`, `.cursorBlink`, `.scrollback`); theme as a **new object** `term.options.theme = { ...o.theme }`; on fontFamily change use the remeasure trick (`term.options.fontFamily = o.fontFamily + ', serif'` then `= o.fontFamily`). If fontFamily or fontSize changed: if the host is laid out (`term.element?.parentElement` has non-zero `clientWidth` and `clientHeight`) call `fit.fit()` in try/catch, else set `entry.remeasure = true`. After a fontFamily change also `void document.fonts.load(\`${o.fontSize}px ${o.fontFamily}\`).then(remeasureAll).catch(() => {})` so a lazily loaded local font re-measures.
   - `remeasureAll()` uses `current.fontFamily` with the same double-assign trick; hidden entries get `remeasure = true` instead of fit. Keep the startup `document.fonts.load` of Cascadia Mono (regular and bold, size `current.fontSize`).
   - `refreshTerm(id)`: if `entry.remeasure`, do the double-assign on `current.fontFamily` and clear the flag. (Fitting stays in TerminalView.)
   - `createTerm()` builds `new Terminal({ fontFamily: current.fontFamily, fontSize: current.fontSize, lineHeight: 1.2, cursorStyle: current.cursorStyle, cursorBlink: current.cursorBlink, scrollback: current.scrollback, allowProposedApi: true, theme: { ...current.theme } })`.
   - `TermHooks` gains `onOpenSettings: () => void` (default no-op). In the custom key handler, before the zoom branch: `if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key === ',') { ev.preventDefault(); hooks.onOpenSettings(); return false }`.
2. `TerminalView.tsx`: in the visible effect's rAF callback call `refreshTerm(id)` before `safeFit(id, el)`.
3. `appearance.ts`:
   - `applyTheme(theme)`: `const s = document.documentElement.style`; for each `k` of `UI_VARS` `s.setProperty('--' + k, theme.ui[k])`; `s.colorScheme = theme.kind`; `document.documentElement.dataset.theme = theme.id`.
   - `useSystemDark()`: state from `matchMedia('(prefers-color-scheme: dark)').matches`, updated by its `change` event (add/remove listener in an effect).
   - `useAppearance(settings)`: `const systemDark = useSystemDark()`; one `useEffect` with deps `[settings?.theme, settings?.terminalFontFamily, settings?.terminalFontSize, settings?.cursorStyle, settings?.cursorBlink, settings?.scrollback, systemDark]` (primitives, so the focus-time state refetch does not re-apply). If `settings` is undefined, return. Else: `const theme = getTheme(resolveThemeId(settings.theme, systemDark))`; `applyTheme(theme)`; `const stack = fontStack(settings.terminalFontFamily)`; `document.documentElement.style.setProperty('--font-mono', stack)`; `applyTerminalOptions({ fontFamily: stack, fontSize: settings.terminalFontSize, cursorStyle: settings.cursorStyle, cursorBlink: settings.cursorBlink, scrollback: settings.scrollback, theme: theme.terminal })`.
4. `main.tsx`: before `createRoot(...)`, `applyTheme(getTheme(window.api.initialThemeId))`.
5. `DiffView.tsx:162` and `FileViewer.tsx:316`: `fontFamily: 'var(--font-mono)'`; remove the `TERM_FONT` imports.
6. `styles.css`:
   - In `:root` delete every colour declaration (`--bg-*`, `--hover`, `--active`, `--line*`, `--text*`, `--accent*`, `--success*`, `--danger*`, `--shadow-pop`). Keep radii, `--font-ui`, `--font-mono` (default value; overridden inline), `--ease`, `--z-*`, `color-scheme: dark`. Add a comment: colours come from `src/shared/themes.ts` via `applyTheme`.
   - Replace literals (line numbers from master):
     - 113 `#3a3a41` and 262 `#3b3b42` -> `var(--line-hover)`; 1699 `#44444c` -> `var(--control-border)`; 261 `#26262b` -> `var(--control-hover)`; 1385 `#2a2a30` -> `var(--control-active)`.
     - 201 gradient -> `var(--accent-grad)`; 876 gradient -> `var(--tile-grad)`; 2219 -> `repeating-conic-gradient(var(--checker-a) 0% 25%, var(--checker-b) 0% 50%) 0 0 / 16px 16px`.
     - 1099-1114 `.ic-folder` .. `.ic-text` -> `var(--ic-folder)` .. `var(--ic-text)`; 1745 `.git-letter.ren` -> `var(--ic-folder)`.
     - 1287 scrim -> `var(--scrim)`; 1513 -> `color-mix(in srgb, var(--bg-chrome) 82%, transparent)`.
     - White-alpha surfaces -> `color-mix(in srgb, var(--tint) N%, transparent)`: 202 (8%, inside the inset box-shadow), 649 (2.5%), 866 (2.5%, inside the radial gradient), 1483 (8%), 1489 (16%).
     - Accent alpha -> `color-mix(in srgb, var(--accent) N%, transparent)`: 581 (5%), 1272 (28%), 1275 (22%), 1499 (4.5%).
     - Danger alpha -> `color-mix(in srgb, var(--danger) N%, transparent)`: 289 (45%), 455 (85%), 884 (30%), 2141 (11%). Success: 2135 -> `color-mix(in srgb, var(--success) 11%, transparent)`.
     - Keep as literals (theme-neutral): inset white edge highlights and black drop shadows at 278, 879, 1303, 1387.
   - With Dark these substitutions render identically (the colour-mix bases equal the old rgb values), except 262 which moves from #3b3b42 to #3a3a41 (accepted).

**T2 status: DONE (2026-11-13).** Steps 1-6 implemented. Deviation: the `select` chevron in `styles.css` was a data-URI SVG with stroke `#a4a4ad` (not in the plan's list; it broke A7), changed to the theme-neutral grey `#9a9aa4` (URL-encoded `%239a9aa4`); a data URI cannot use CSS variables. Verified: A6 and A7 greps empty; `yarn typecheck` leaves only App.tsx errors (missing `./SettingsDialog` module, implicit-any `patch`), all T3-owned.

### T3 - Settings dialog and entry points (parallel with T2, after T1)

Inputs: this plan; T1's shared modules; the `appearance.ts`/`TermHooks` contract from T2; modal pattern in `SnippetEditor.tsx` / `CommandEditor.tsx` (research section 5).
Outputs: working dialog, gear button, Ctrl+, from the window, App wiring.
Files owned: `src/renderer/src/SettingsDialog.tsx` (new), `src/renderer/src/SettingsDialog.css` (new), `src/renderer/src/App.tsx`, `src/renderer/src/Sidebar.tsx`.

Steps:
1. `SettingsDialog.tsx`:
   - `export function SettingsDialog({ settings, onChange, onClose }: { settings: Settings; onChange: (patch: Partial<Settings>) => void; onClose: () => void }): JSX.Element`. Import `./SettingsDialog.css`.
   - Field table drives the form:
     ```ts
     type FieldDef =
       | { key: 'theme' | 'cursorStyle' | 'shell'; kind: 'select'; label: string; hint?: string }
       | { key: 'terminalFontSize' | 'scrollback'; kind: 'number'; label: string; min: number; max: number; step: number; hint?: string }
       | { key: 'cursorBlink'; kind: 'toggle'; label: string; hint?: string }
       | { key: 'terminalFontFamily' | 'editor'; kind: 'text'; label: string; presets?: string[]; hint?: string }
     const SECTIONS: { title: string; fields: FieldDef[] }[]
     ```
     Sections and fields, in order:
     - Appearance: `theme` (select; options `Follow system` = 'system', then `THEME_IDS.map(id => THEMES[id].name)`), `terminalFontFamily` (text; presets via `<datalist>`: `DEFAULT_TERMINAL_FONT`, `'Cascadia Code'`, `Consolas`, `'JetBrains Mono'`, `'Fira Code'`, `'Courier New'`; hint "Any installed font. Unknown fonts fall back to monospace."), `terminalFontSize` (number, `FONT_SIZE_MIN`..`FONT_SIZE_MAX`, step 1; hint "Ctrl + / Ctrl - / Ctrl 0 also change it.").
     - Cursor: `cursorStyle` (select: Block / Bar / Underline), `cursorBlink` (toggle, a checkbox styled as a switch).
     - Terminal: `scrollback` (number, `SCROLLBACK_MIN`..`SCROLLBACK_MAX`, step 1000; hint "Lines kept per terminal. Lowering it trims open terminals."), `shell` (select; hint "Applies to new terminals. Open terminals keep their shell. Saved commands run with PowerShell or cmd.").
     - Integrations: `editor` (text; hint "Executable on PATH used by Open in editor.").
   - Shell options: `useEffect` on mount -> `window.api.listShells()`; render each option, `disabled` when `!available` with " (not found)" appended. If `settings.shell` is not one of the values, prepend an option `{ value: settings.shell, label: 'Custom: ' + settings.shell }` so a hand-edited value is shown and kept.
   - Apply semantics (live, no Cancel): select and toggle changes call `onChange({ [key]: value })` immediately. Text and number inputs keep a local draft; they commit after 400 ms without typing, on blur, on Enter, and on unmount (flush pending). Number drafts are parsed with `Number()`, ignored when `NaN`, clamped to the field's min/max before `onChange`. When `settings[key]` changes from outside (zoom keys, reset), the draft re-syncs unless the input is focused.
   - Footer: left `Reset to defaults` (`.btn`; calls `onChange` with the `DEFAULT_SETTINGS` values of every key except `shell` and `editor`; `title="Resets appearance, cursor and scrollback. Shell and editor are kept."`), right `Done` (`.btn.primary`, closes). A `.hint` line: "Changes apply immediately."
   - Structure and behaviour as the existing modals: `.modal-backdrop` (onMouseDown -> `onClose`) > `.modal.settings-modal` (stopPropagation, `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on the `h3` "Settings") > `.modal-head` (h3 + `icon-btn` with lucide `X`) / `.modal-body` / `.modal-foot`. Each field is `<label className="field">` with `<span>` label, control, and `<small className="settings-hint">` hint. Escape closes (window keydown effect, as SnippetEditor.tsx:55-61). Focus the theme select on open.
2. `SettingsDialog.css`: `.settings-modal { width: min(560px, calc(100vw - 32px)); }`, `.settings-modal .modal-body { max-height: min(70vh, 640px); overflow: auto; }`, section headings (`.settings-section h4`, uppercase 11px `var(--text-3)`), `.settings-hint` (`var(--text-3)`, 11.5px), and the switch for the toggle. Use only theme variables (`var(--...)`), no colour literals.
3. `Sidebar.tsx`: add `onOpenSettings: () => void` to `Props`; append to `.head-actions` after the Rescan button: `<button className="icon-btn" onClick={p.onOpenSettings} title="Settings (Ctrl+,)"><Settings size={16} /></button>` (import `Settings` from lucide-react, aliased if it clashes with the `Settings` type).
4. `App.tsx`:
   - Remove `setTerminalFontSize` and `DEFAULT_FONT_SIZE` from the termRegistry import (App.tsx:36) and the `setTerminalFontSize(...)` call at App.tsx:122.
   - Call `useAppearance(state?.settings)` (from `./appearance`) at the top level of `App`, after the state hooks.
   - `const [settingsOpen, setSettingsOpen] = useState(false)`.
   - `zoom` (App.tsx:461-470): `cur = stateRef.current?.settings.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize`; `next = dir === 0 ? DEFAULT_SETTINGS.terminalFontSize : Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, cur + dir))`; keep `if (next === cur) return`; then only `setState(await window.api.setSettings({ terminalFontSize: next }))` (terminals update through `useAppearance`).
   - `setTermHooks`: add `onOpenSettings: () => setSettingsOpen((o) => !o)`.
   - Window keydown handler: before the zoom branch add `else if (!e.shiftKey && k === ',') { e.preventDefault(); setSettingsOpen((o) => !o) }`.
   - Pass `onOpenSettings={() => setSettingsOpen(true)}` to `<Sidebar>`.
   - Render next to `SnippetPicker`: `{settingsOpen && state && <SettingsDialog settings={state.settings} onChange={(patch) => void window.api.setSettings(patch).then(setState)} onClose={() => setSettingsOpen(false)} />}`.

**T3 status: DONE (2026-11-13).** Steps 1-4 implemented as written. Minor choices: `useAppearance` is called right after the `settingsOpen` state; number fields normalise their shown value on blur/Enter (round + clamp); text-field commit skips `onChange` when the trimmed value equals the current setting. `yarn typecheck` exit 0 (with T2's appearance.ts present). `yarn smoke` not run by T3.

## 4. Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| A1 | Code compiles | `yarn typecheck` exits 0 |
| A2 | Existing smoke checks still pass, `SCHEMA_VERSION` still 3 | `yarn smoke` prints only PASS lines and exits 0 |
| A3 | New/old settings files load: defaults fill missing keys, invalid values fall back or clamp, unknown keys drop, a patched settings object survives save+reload | smoke `checkSettings` a-c |
| A4 | Every theme defines every UI variable and its terminal background equals `--bg-term`; "Follow system" resolves to Dark/Light | smoke `checkSettings` d |
| A5 | Saved commands never run in a shell `buildRunArgs` cannot handle | smoke `checkSettings` e |
| A6 | No theme colour literals left in styles.css | `grep -nE "#[0-9a-fA-F]{3,8}\b" src/renderer/src/styles.css` has no matches, and `grep -n "rgba(" src/renderer/src/styles.css \| grep -vE "rgba\((255, 255, 255\|0, 0, 0)," ` has no matches |
| A7 | One source for theme colours | `grep -rn "18181b\|131315\|a4a4ad" src/main src/renderer/src` has no matches (only `src/shared/themes.ts` has them) |
| A8 | `.claude/director/` ignored | `git check-ignore .claude/director/x` prints the path |
| A9 | Gear button and Ctrl+, open the dialog, from the window and from inside a focused terminal; Ctrl+, again or Esc closes | **User, in the running app** (`yarn dev`) |
| A10 | Changing theme, font family, font size, cursor style, cursor blink and scrollback restyles the chrome and every open terminal at once, including the title bar caption buttons; a terminal hidden in another tab shows the new font correctly sized when opened | **User, in the running app** |
| A11 | Dark looks exactly as before; Light, Fjord, Sandstone are readable (file icons, diff colours, modals, scrollbars, checkerboard) | **User, in the running app** |
| A12 | Follow system switches live when Windows changes between light and dark app mode (chrome, terminals and title bar) | **User, in the running app** |
| A13 | Settings survive a restart; with Light saved, the window opens without a dark flash | **User, in the running app** (quit from tray, restart) |
| A14 | Default shell picker lists Automatic / PowerShell 7 / Windows PowerShell / Command Prompt (missing ones disabled), states that it applies to new terminals; a new tab uses the new shell, open tabs keep theirs | **User, in the running app** |
| A15 | Typing in font family / scrollback does not write terminals.json on every keystroke | **User or reviewer**: code review of the 400 ms debounce in `SettingsDialog.tsx`; optionally watch the file's mtime while typing |

No other new tests (test-discipline): one smoke check covers the store/schema/themes/shell logic; the rest is visual.

## 5. Risks and how they are handled

| Risk (research #) | Handling |
|---|---|
| New keys silently dropped by `migrate`/`setSettings` (1) | Both go through `SETTINGS_SCHEMA` (`sanitizeSettings`, `patchSettings`); smoke a-c prove keys survive a round trip. |
| Schema bump breaks smoke (2) | No bump; optional keys with defaults need none. Fake state uses `DEFAULT_SETTINGS`. |
| Title bar overlay and window background fixed at creation (3) | `createWindow` reads the saved theme; `applyWindowTheme()` runs after every `settings:set` and on `nativeTheme` `updated`. `setTitleBarOverlay` wrapped in try/catch. |
| No dark flash with a light theme | Window `backgroundColor` comes from the theme; `:root` has no colour values, so the first frame before JS shows the theme-coloured native background; `main.tsx` applies the theme synchronously from `initialThemeId` (sync IPC, once) before React renders. |
| Hard-coded colours outside `:root` (4) | Every literal is listed in T2 step 6 with its replacement; A6 grep proves none remain except neutral white highlights / black shadows. |
| Terminal background vs `--bg-term` (5) | Both come from the same `Theme`; smoke d asserts equality. |
| Font family needs remeasure; hidden terminals cannot fit; `TERM_FONT` importers (6) | Double-assign trick in `applyTerminalOptions`; `remeasure` flag + `refreshTerm(id)` on show; `document.fonts.load` then re-measure; DiffView/FileViewer use `var(--font-mono)`, which `useAppearance` sets; `TERM_FONT` export removed so no stale importer can compile. |
| Font size range mismatch (7) | One range `FONT_SIZE_MIN`/`FONT_SIZE_MAX` (8..36) in `shared/settings.ts`, used by the store, zoom and the dialog. Stored 37-40 clamp to 36. |
| Keys handled in two places (8) | Ctrl+, added both in the xterm custom handler (`hooks.onOpenSettings`) and the window handler; same toggle. |
| Default shell vs `buildRunArgs` (9) | **Decision: limit the choice to known shells** (Automatic, pwsh, powershell, cmd). Why: saved commands are written as PowerShell/cmd steps and `buildRunArgs` has exact exit-code and output semantics for those two; correct runners for bash/WSL/nu need their own quoting and failure semantics with no test coverage. A hand-edited other shell in terminals.json is kept for interactive tabs, but `stepsShell()` runs saved commands with automatic PowerShell, so command tabs never get cmd-style args in a foreign shell. Open terminals keep their shell; the dialog says so. |
| Scrollback lowering trims history (10) | Accepted; hint in the dialog. Theme applies to hidden terminals too (no fit needed). |
| Synchronous save per change (11) | Text/number fields debounce 400 ms and commit on blur/Enter; selects/toggles are single events. |
| Follow system breaks if main pins `themeSource` | Main never sets `nativeTheme.themeSource`; renderer uses `matchMedia`, main uses `shouldUseDarkColors`, both fed by the OS. |
| Focus refetch re-applies options each time | `useAppearance` deps are primitive setting values; `applyTerminalOptions` only assigns changed options. |
| Smoke needs a build and real ptys (12) | Run `yarn smoke` once at the end of T1 and once in final verification. |
