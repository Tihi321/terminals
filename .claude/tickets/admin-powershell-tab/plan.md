---
status: done
request: REQ-0003
repos: [C:/projects/Personal/terminals]
branch: feature/admin-powershell-tab
updated: 2026-11-18
---

# REQ-0003 Admin (elevated) terminal tab

Request: "add as well option to start poweshell as admin in case we need onw".
Reading chosen: the full one. An admin tab runs inside the app, in its own pty, using the default shell from Settings. It is not a separate elevated window.

Base: branch `feature/admin-powershell-tab`, created from `feature/tab-reorder-and-same-folder-split` (57bb800, REQ-0002). All file:line references below are to that commit. `research.md` was written against master. Its refs to `index.ts:360-387` are now `index.ts:397-442`.

## 1. Scope

- A per-tab action, **New admin terminal**, starts the default shell (Settings) elevated in a normal in-app tab.
- Main finds the elevator each time it is asked:
  1. gsudo, from PATH and from known install dirs.
  2. Otherwise Windows `sudo.exe`, only when it is enabled in normal (inline) mode.
  3. Otherwise none: the action is shown disabled with the hint `winget install gerardog.gsudo`.
- Elevated tabs are clearly marked: a lucide `ShieldAlert`/`Shield` icon in place of the terminal icon, an accent/danger tint, and the title `Admin <shell> n`.
- Session restore (REQ-0002 v4): an admin tab is saved with `elevated: true`. It comes back as a **placeholder** that starts no process. The pane shows a **Start as admin** button, and clicking it triggers the UAC prompt.
- UAC cancel or elevation failure: the tab goes to the exited state with a clear message, and the same pane offers **Start as admin** again (retry).
- Security: the renderer sends only `elevated: true`. Main builds the file and args from the validated shell and the resolved elevator. Elevated requests that carry `steps` are rejected.
  - Snippet/prompt insertion never auto-targets an elevated tab.
  - Only the renderer that created a pty may write to it, resize it or kill it.
  - Elevated creates are rate-limited.
- Mitigation for an orphaned elevated shell when a tab is closed (D8), plus manual checks.
- Smoke checks (pure logic only, nothing elevates, gsudo not needed) in `src/main/smoke.ts`.

## 2. Out of scope

- An "always elevated" default-shell setting, or elevating the whole app.
- Elevated saved commands/steps, and MCP-triggered elevation.
- gsudo credential cache (`gsudo cache on`) and new-window modes (`gsudo -n`, sudo `forceNewWindow`).
- Installing gsudo or enabling Windows sudo for the user.
- A keyboard shortcut for New admin terminal (could be added later; Ctrl+Shift+T stays a normal tab).
- A status row in SettingsDialog (the disabled menu item with its hint covers discoverability).
- Reading a fresh PATH from the registry. Known install dirs cover installs made after the app started.

## 3. Design decisions

**D1 Contract: one boolean from the renderer.**
- `PtyCreateRequest` (`src/shared/types.ts:155-168`) gains `elevated?: boolean`.
- The renderer never sends an elevator path or extra args.
- In `pty:create` (`src/main/index.ts:397-442`), when `req.elevated === true`:
  - (a) `Array.isArray(req.steps)` → return `{ ok: false, error: 'Admin terminals cannot run saved commands' }`.
  - (b) The shell is the existing D11-validated `shellExe` (`index.ts:411-417`), then resolved with `resolveShell`. It must pass `isRunnableShell` (`src/main/pty.ts:24-27`: pwsh, powershell or cmd), else `{ ok: false, error: 'Admin terminals need PowerShell or cmd as the shell' }`. This is "the default shell from Settings": new admin tabs send `shell = state.resolvedShell`, the same as normal tabs (`App.tsx:258`).
  - (c) The elevator is resolved now, at request time (D2). If none is found → `{ ok: false, error: 'No elevator found. Install gsudo: winget install gerardog.gsudo' }`.
  - (d) The spawn goes through `pty.spawn(file, args)` with an array. node-pty quotes args on Windows, so a shell path with spaces (`C:\Program Files\PowerShell\7\pwsh.exe`) is safe. There is no `cmd /c` and no string concatenation.
- `fallbackCwd`, `locId` and `ptyEnv` work as for normal shells.
- `ptyEnv` (`index.ts:272-280`) also goes to the admin shell. It holds the MCP URL and token for the same user. The MCP server cannot run commands (`mcp.ts:28`), so this gives no extra power. Kept, so `get_context` works from admin tabs.

**D2 Elevator resolution (new `src/main/elevation.ts`, pure apart from injected deps).**
```ts
export type ElevatorTool = 'gsudo' | 'sudo'
export interface Elevator { tool: ElevatorTool; path: string }
export interface ElevatorDeps {
  env: Record<string, string | undefined>          // process.env at request time
  exists: (p: string) => boolean                     // existsSync
  sudoMode: () => SudoMode                           // reads the registry (D3); injected so tests never touch it
}
export type SudoMode = 'disabled' | 'forceNewWindow' | 'disableInput' | 'normal' | 'unknown'
export function gsudoCandidates(env): string[]
export function resolveElevator(deps: ElevatorDeps): Elevator | null
```
- `gsudoCandidates` lists the places to look, in order:
  1. Every PATH entry + `gsudo.exe`, with quotes stripped as in `findOnPath` (`pty.ts:6-13`). The function takes `env.PATH`, so it can be tested.
  2. `%ProgramFiles%\gsudo\Current\gsudo.exe` (MSI/winget layout).
  3. `%ProgramFiles(x86)%\gsudo\Current\gsudo.exe` and `%ProgramFiles(x86)%\gsudo\gsudo.exe` (older installers).
  4. `%LOCALAPPDATA%\Microsoft\WinGet\Links\gsudo.exe`.
  5. `%SCOOP%\shims\gsudo.exe` when SCOOP is set, else `%USERPROFILE%\scoop\shims\gsudo.exe`.
  6. `%ChocolateyInstall%\bin\gsudo.exe`, else `%ProgramData%\chocolatey\bin\gsudo.exe`.
- A missing env var skips its candidate. Every candidate is an absolute path.
- `resolveElevator`:
  1. Use the first gsudo candidate that exists.
  2. Otherwise, if `%SystemRoot%\System32\sudo.exe` exists (absolute path, never from PATH) and `sudoMode() === 'normal'`, use sudo.
  3. Otherwise return `null`.
- It runs on every `pty:create` with `elevated` and on every `pty:elevator` call. It is never cached, so gsudo installed after app start is found as long as it is in a known dir.
- The research confirmed that gsudo is not installed and `sudo.exe` exists but is disabled (`research.md:13-14`).

**D3 Windows sudo mode.**
- Main runs `execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Sudo', '/v', 'Enabled'], { timeout: 2000, windowsHide: true })` and passes stdout to the pure `parseSudoMode(stdout)`.
- `parseSudoMode` matches `/Enabled\s+REG_DWORD\s+0x([0-9a-f]+)/i` and maps 0 → disabled, 1 → forceNewWindow, 2 → disableInput, 3 → normal, anything else → unknown.
- A thrown error (key or value missing) → `disabled`.
- Only `normal` counts as usable.
- The value mapping is from memory and NOT verified. Open question Q1 and manual check M6 confirm it with `sudo config`.

**D4 Elevated command line (pure, in `elevation.ts`).**
```ts
export function elevatedCommand(shell: string, elev: Elevator): { file: string; args: string[] } | null
```
- Returns `null` when `!isRunnableShell(shell)`.
- Shell args: `['-NoLogo']` for pwsh/powershell, `[]` for cmd.
- gsudo: `{ file: elev.path, args: ['--direct', shell, ...shellArgs] }`. `--direct` stops gsudo from wrapping the command in the shell it detects from its parent (Electron/node here).
- sudo: `{ file: elev.path, args: [shell, ...shellArgs] }`.
- Fixed flags only. Nothing comes from the renderer.
- The exact gsudo flag spelling is from memory. Q2 / M1 verify it; if `--direct` misbehaves, the fallback is no flag.
- The step-rejection logic is also pure: `checkElevatedRequest({ elevated, steps }): string | null` returns the error text for (a) in D1, so it can be tested.

**D5 Spawn path in `pty.ts`.**
- Add `export function spawnElevated(file: string, args: string[], cwd, cols, rows, handlers, extraEnv)`, which calls the private `spawnPty` (`pty.ts:73-92`).
- `spawnShell` and `spawnSteps` stay as they are (`smoke.ts:6` imports them).
- `index.ts` keeps `elevatedIds: Set<string>`, filled on a successful elevated spawn and cleared in `onExit` / kill.

**D6 Elevator status for the UI.**
- New IPC `pty:elevator` → `ElevatorInfo { available: boolean; tool: ElevatorTool | null; hint: string }`. Add the type to `types.ts` and `getElevator(): Promise<ElevatorInfo>` to `TerminalsApi`.
- The path is not sent to the renderer.
- `hint` text:
  - `'Runs via gsudo'` when gsudo is found.
  - `'Runs via Windows sudo'` when sudo is used.
  - `'Install gsudo: winget install gerardog.gsudo'` when nothing is found.
- The renderer calls it each time the "+" menu opens, so an install made while the app runs shows up without a restart (when it lands in a known dir).
- The hint constant `GSUDO_HINT = 'winget install gerardog.gsudo'` lives in a new `src/shared/elevation.ts`, which also holds `elevationFailed` (D9).

**D7 UI entry: a split "+" button (`TabBar.tsx:174-175`).**
- A small chevron button (`ChevronDown`, 12px) sits right after the "+". Clicking it, or right-clicking "+", opens the existing `ContextMenu` (`ContextMenu.tsx:4-11` already supports `disabled` and `icon`). It has two items:
  - "New terminal" (Terminal icon).
  - "New admin terminal" (Shield icon). When `!available` the item is disabled and its label becomes `New admin terminal — install gsudo: winget install gerardog.gsudo`.
- `ContextMenu` has no tooltip field, so the hint goes in the label. Optional: add `title?: string` to `MenuItem`. `ContextMenu.tsx` is owned by T3.
- Both buttons are disabled under the same condition as "+" (`p.loc.missing || !p.loc.path`).
- TabBar gets new props `onNewAdmin: () => void` and `getElevator: () => Promise<ElevatorInfo>`. Alternatively App passes the info in; T3 decides.
- Tab marker: `t.elevated` → `<ShieldAlert size={13} className="tab-icon admin" />` instead of `Terminal` (`TabBar.tsx:141`), plus a tab class `admin`. CSS gives it a tint from an existing danger/warn theme variable, so all four themes work. The tooltip (`TabBar.tsx:132`) gets `\n(administrator)`.

**D8 Orphan risk on tab close: investigation and mitigation.**
What node-pty does, verified in `node_modules/@lydell/node-pty-win32-x64/lib/windowsPtyAgent.js:193-222`, v1.2.0-beta.18:
- On `kill()`, without the conpty DLL, it forks `conpty_console_list_agent`, gets the console's process list, and calls `process.kill(pid)` on each.
- In the same tick it calls `_ptyNative.kill`, which is ClosePseudoConsole.
- `process.kill` on an elevated pid from the unelevated app fails with access denied, and node-pty swallows the error. So the elevated shell is NOT killed directly.
- ClosePseudoConsole: Microsoft documents that "client applications attached to the session will be terminated as well".

What gsudo does (from memory, unverified):
- In its default console mode (TokenSwitch/attached), the elevated shell is created attached to the caller's console, which is our ConPTY. That is how I/O and resize work inline.
- So closing the pseudoconsole should end the elevated pwsh as well. This is the expected primary mechanism.
- In gsudo's piped/VT modes, the elevated process lives in the gsudo service's own console. The service ends it when the client pipe closes, which happens when the unelevated gsudo dies (killed by node-pty).

Windows sudo (inline/normal mode) also attaches the elevated process to the caller's console. Same expectation.

Mitigation, built now because it is cheap and deterministic:
- **F1 graceful exit.** For a pty in `elevatedIds`, `pty:kill` and `killPtysOf` write `'\x03'` and then `'exit\r'` to the pty, and call `p.kill()` 400 ms later. An idle or Ctrl+C-interruptible shell quits by itself before the console closes.
- `killAllPtys` at quit (`index.ts:45-55`) stays synchronous and relies on ClosePseudoConsole.
- The pty is removed from `ptys`/`owners` at once, so the id is free and further writes are dropped.

Not built unless M3 fails:
- **F2.** Pass gsudo's explicit `--attached` flag so the elevated process is always a console client.
- **F3.** Document the limitation.

M3 is the proof: Task Manager / `Get-Process pwsh` after closing the tab, at an idle prompt and while `ping -t localhost` runs.

**D9 UAC cancel / failure message.**
- `pty:exit` already carries the code (`index.ts:422-426`), and the exit text is written in `termRegistry.ts:167-182`.
- `createTerm(id, { elevated: true })` records `elevated` and `startedAt = Date.now()` (set when `markReady` fires) on the entry.
- On exit, for elevated entries where `elevationFailed(code, msSinceStart)` holds, write in red: `Elevation was cancelled or failed (exit <code>). Use "Start as admin" to try again.`
- `elevationFailed` (shared, pure) = `code === 999 || code === 1223 || (code !== 0 && ms < 4000)`. 999 is gsudo's error code per the research; 1223 is ERROR_CANCELLED. Both are unverified (Q3, M2).
- Other elevated exits print the normal `[process exited with code N]`.
- A failed `ptyCreate` (no elevator, bad shell) already prints `Failed to start: <error>` (`TerminalView.tsx:47-52`) and dispatches `terminal-failed` (`App.tsx:736-737`). Kept.

**D10 Tab model, placeholder and retry (renderer).**
- `Tab` (`TabBar.tsx:8-29`) gains:
  - `elevated?: boolean`.
  - `pending?: boolean`: an admin placeholder with no term/pty yet. Not persisted.
  - `attempt?: number`: bumped on retry so the TerminalView remounts.
- `newAdminTab(locId, paneId)` in App, next to `newTab` (`App.tsx:247-262`):
  - Same location/cwd checks and shared counter.
  - Title `Admin ${shellLabel(st.resolvedShell)} ${n}`.
  - Calls `createTerm(id, { elevated: true })` and pushes `{ kind: 'shell', elevated: true, shell, startCwd, exited: false }`.
  - The TerminalView mounts, passes `elevated` to `ptyCreate`, and the UAC prompt appears. That is the user's click.
- Restore (`App.tsx:515-531`): when `t.elevated`, set `tab.elevated = true` and `tab.pending = true`, and do NOT call `createTerm`. The title counter logic stays.
- The TerminalView list (`App.tsx:1073-1099`) skips `t.pending` tabs. A new `AdminPlaceholder`, positioned with the same `style` calc, shows:
  - a Shield icon,
  - "Administrator terminal (not started)" and the cwd,
  - a **Start as admin** button, disabled with the hint when `getElevator()` reports unavailable.
- `startAdmin(id)`:
  - If the tab is `pending`: `createTerm(id, { elevated: true })`, then set `pending: false`.
  - If the tab is elevated and exited (retry): `getTerm(id)?.dispose()`, `createTerm(id, { elevated: true })`, then set `exited: false` and `attempt: (attempt ?? 0) + 1`. TerminalView `key={`${t.id}:${t.attempt ?? 0}`}`.
  - Main has already dropped the id on exit (`index.ts:423-424`), so re-using it is not a "Duplicate terminal id".
- For an exited elevated tab, a slim bar over the bottom of the pane (not a full cover, so the failure text stays readable) shows **Start as admin** again.
- Placeholders are not live:
  - `counts` (`App.tsx:746-753`) skips `pending` tabs.
  - `closeTab` (`App.tsx:426-433`) skips `ptyKill` and `dispose` when `pending`. Harmless anyway.

**D11 Snippet / prompt insertion.**
- `insertSnippet` (`App.tsx:631-657`) uses `live = t.locId === locId && t.kind === 'shell' && !t.exited` (`App.tsx:636`). Add `&& !t.elevated && !t.pending`.
- If the active tab is an admin tab, the snippet goes to another normal live tab of the folder, or a new normal tab is opened. Text is never auto-pasted (and possibly auto-Entered, `termRegistry.ts:204`) into an admin shell.
- Manual paste (Ctrl+V), drag-drop of paths and typing into an admin tab keep working. That is an explicit user act.
- The MCP server has no path that writes to ptys (verified: no `ptys.` use outside `index.ts`). Nothing to change there.

**D12 Persisted data: no schema bump.**
- `PersistedTab` (`types.ts:40-56`) gains `/** shell only: started elevated; restored as a not-started placeholder. */ elevated?: boolean`.
- `sanitizeTab` (`session.ts:23-25`, shell branch) adds `if (r.elevated === true) t.elevated = true`. Any other value, and the field on non-shell kinds, is dropped.
- `SessionTab` (`session.ts:64-76`) gets `elevated?: boolean`, and `toPersistedTabs` (`session.ts:78-94`) copies it.
- `planRestore` (`session.ts:151-154`) already spreads `...t`, so `elevated` reaches the plan with no change.
- Stay on `SCHEMA_VERSION = 4` (`types.ts:2`):
  - The field is optional and additive. Older v4 builds' `sanitizeTab` rebuilds objects field by field, so they drop the flag and restore the tab as a normal shell. This only matters on downgrade and is acceptable.
  - A bump would make older builds refuse the file entirely (`store.ts:163-166`), which is worse.
  - `migrate` already runs `sanitizeTabs` (`store.ts:149`).

**D13 IPC hardening (extends REQ-0002 D17).**
- `pty:write`, `pty:resize` and `pty:kill` (`index.ts:444-461`) act only if `owners.get(e.sender.id)?.has(id)`.
- There is only one window today, so behaviour does not change. A foreign or stale renderer, though, can no longer type into an admin shell.
- Rate limit: per webContents, an elevated `pty:create` within 1500 ms of the previous one returns `{ ok: false, error: 'Please wait before starting another admin terminal' }`. This stops a misbehaving renderer from spamming UAC prompts.

## 4. Files and modules to touch

| File | Change | Task |
|---|---|---|
| `src/main/elevation.ts` (new) | `gsudoCandidates`, `resolveElevator`, `parseSudoMode`, `readSudoMode` (reg via execFileSync), `elevatedCommand`, `checkElevatedRequest` (D2-D4) | T1 |
| `src/shared/elevation.ts` (new) | `GSUDO_HINT`, `elevationFailed(code, ms)` (D6, D9) | T1 |
| `src/shared/types.ts` | `PtyCreateRequest.elevated`, `PersistedTab.elevated`, `ElevatorInfo`, `TerminalsApi.getElevator` (D1, D6, D12) | T1 |
| `src/shared/session.ts` | sanitize/SessionTab/toPersistedTabs `elevated` (D12) | T1 |
| `src/main/smoke.ts` | new `checkElevation()`, extend `checkSession` (section 6) | T1 |
| `src/main/pty.ts` | `spawnElevated` (D5) | T2 |
| `src/main/index.ts` | `pty:create` elevated branch, `elevatedIds`, F1 kill, ownership checks, rate limit, `pty:elevator` IPC (D1, D5, D6, D8, D13) | T2 |
| `src/preload/index.ts` | `getElevator: () => inv('pty:elevator')` | T2 |
| `src/renderer/src/TabBar.tsx` | `Tab` fields, split "+" menu, shield marker (D7, D10) | T3 |
| `src/renderer/src/ContextMenu.tsx` | optional `title` on `MenuItem` | T3 |
| `src/renderer/src/App.tsx` | `newAdminTab`, `startAdmin`, restore placeholder, `AdminPlaceholder` rendering, retry bar, insertSnippet filter, counts (D10, D11) | T3 |
| `src/renderer/src/TerminalView.tsx` | `elevated` prop passed to `ptyCreate` | T3 |
| `src/renderer/src/termRegistry.ts` | `createTerm` opts `elevated`, `startedAt`, elevation-failed message (D9) | T3 |
| `src/renderer/src/styles.css` | `.tab.admin`, `.tab-icon.admin`, `.admin-placeholder`, `.admin-retry`, `.tab-new-menu` | T3 |

## 5. Tasks for workers

Order: **T1**, then **T2 ∥ T3** (they touch disjoint files), then **T4**. No two parallel tasks share a file.

### T1 Shared contracts, pure elevation logic, smoke checks

- **Inputs:** D1-D4, D6, D9, D12; `src/shared/types.ts`, `src/shared/session.ts`, `src/main/pty.ts:6-27` (`findOnPath`, `isRunnableShell`, which may be imported), `src/main/smoke.ts:272-317` (`checkSession`) and `571-589` (`runSmoke`).
- **Outputs:**
  - The files in the T1 rows above, with exactly the signatures in D2, D4 and D6.
  - `elevation.ts` must not import electron. It may import `node:child_process`, used only inside `readSudoMode`, which tests never call.
  - Smoke checks as in section 6.
- **Contract for T2/T3:**
  - `PtyCreateRequest.elevated?: boolean`
  - `ElevatorInfo { available: boolean; tool: 'gsudo' | 'sudo' | null; hint: string }`
  - `TerminalsApi.getElevator(): Promise<ElevatorInfo>`
  - `PersistedTab.elevated?: boolean`
  - `SessionTab.elevated?: boolean`
  - `GSUDO_HINT`
  - `elevationFailed(code: number, msSinceStart: number): boolean`
- **Verify:** `yarn typecheck` will fail until the preload implements `getElevator`. That is acceptable for T1 alone. T1 adds no preload stub; T2 owns preload. `yarn smoke` must pass for the new checks.

### T2 Main wiring (after T1)

- **Inputs:** D1, D5, D6, D8, D13; `src/main/index.ts` (`killAllPtys` 45-55, `killPtysOf` 65-75, `ptyEnv` 272-280, `settings:shells` 323, `pty:create` 397-442, write/resize/kill 444-461), `src/main/pty.ts:73-117`, `src/preload/index.ts:39, 74-77`.
- **Outputs:**
  - `spawnElevated` in `pty.ts`.
  - In `pty:create`, `if (req.elevated === true)` runs, in order:
    1. `checkElevatedRequest`
    2. the rate limit
    3. `resolveElevator({ env: process.env, exists: existsSync, sudoMode: readSudoMode })`
    4. `elevatedCommand(resolveShell(shellExe), elev)`
    5. `spawnElevated`
    6. `elevatedIds.add`
  - Any `req.elevated` value other than `true` means a normal shell.
  - F1 graceful kill for elevated ids in `pty:kill` and `killPtysOf`.
  - Owner checks on write/resize/kill.
  - `ipcMain.handle('pty:elevator', ...)` returns `ElevatorInfo`.
  - preload `getElevator`.
- **Contract:** error strings as in D1 and D13. They are shown verbatim through `Failed to start:`.
- **Verify:** `yarn typecheck` (main+preload), `yarn smoke`.

### T3 Renderer (after T1, parallel with T2)

- **Inputs:** D7, D9, D10, D11; `TabBar.tsx` (1-60, 125-176), `ContextMenu.tsx`, `App.tsx` (newTab 247-262, handleExit 384-393, closeTab 426-433, restore 515-531, insertSnippet 631-657, `act` 660-674, terminal-failed 736-737, counts 746-753, TabBar props 950-970, terminal list 1073-1099), `TerminalView.tsx`, `termRegistry.ts` (167-182, 200-207, 209, 311-322), `styles.css`.
- **Outputs:** as in section 4. Use lucide `Shield`/`ShieldAlert`/`ChevronDown`. Use theme CSS variables only, with no hard-coded colours.
- **Contract:** calls `window.api.getElevator()` and `ptyCreate({ ..., elevated: true })`. Never sends any other elevation data.
- **Verify:** `yarn typecheck` (the web half; preload types come from T2), `yarn build`.

### T4 Verification and integration (after T2 and T3)

- Run `yarn typecheck`, `yarn smoke` and `yarn build`, using `fnm exec --using default` if node is not on PATH.
- Optionally `yarn dist:dir`: per the global rule, "build it" means the Windows exe/installer for the user's manual test.
- Run the app with gsudo absent and confirm: the menu item is disabled with the hint; no UAC appears at startup; normal tabs, restore and snippets work as before.
- Elevation itself is left to the user (section 7).

## 6. Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| A1 | Elevator resolution order. gsudo on PATH wins over Windows sudo. gsudo is found in `%ProgramFiles%\gsudo\Current` with an empty PATH. sudo is used only in `normal` mode and only from `%SystemRoot%\System32`. Otherwise null. | smoke `checkElevation`: injected `env`/`exists`/`sudoMode`, 4 cases |
| A2 | `parseSudoMode` maps a `reg query` line `Enabled    REG_DWORD    0x3` → normal, `0x0` → disabled, and garbage → unknown | smoke `checkElevation` |
| A3 | `elevatedCommand`: for gsudo plus `C:\Program Files\PowerShell\7\pwsh.exe` it gives `{file: gsudoPath, args: ['--direct', shellPath, '-NoLogo']}`. cmd gets no `-NoLogo`. sudo has no gsudo flag. A non-runnable shell (`bash.exe`) → null. `checkElevatedRequest({elevated:true, steps:[]})` → error. | smoke `checkElevation` |
| A4 | `sanitizeTabs` keeps `elevated: true` on a shell tab. It drops `elevated: 'yes'` and `elevated` on a diff tab. `toPersistedTabs` and `planRestore` carry it through. | smoke `checkSession` (extended: one elevated shell plus two bad variants in the existing fixtures) |
| A5 | No schema bump: `SCHEMA_VERSION` stays 4, and the existing migration check still passes | `yarn smoke` (`checkMigration`) |
| A6 | Main never spawns a renderer-supplied executable for elevation. It rejects steps and non-runnable shells. Ownership checks are on write/resize/kill. | code review of the `index.ts` diff; `yarn typecheck` |
| A7 | gsudo missing → "New admin terminal" is disabled with the `winget install gerardog.gsudo` hint, and the restored placeholder's button is disabled with the hint | T4 run of the app (gsudo absent here); M5 |
| A8 | No UAC at app start; restored admin tabs are placeholders | T4 run with a saved session holding an elevated tab (hand-edit `terminals.json` or create via UI with a fake path); M4 |
| A9 | Snippet insertion never targets an admin tab | code review of `App.tsx` insertSnippet; manual M7 |
| A10 | Typecheck and build are clean | `yarn typecheck`, `yarn build` |
| A11 | UAC accept/cancel, no orphan on close, sudo fallback | manual M1-M3, M6 (UNTESTED until the user installs gsudo) |

Test discipline: one new check (`checkElevation`) plus a few added lines in `checkSession`. There is no test for UI, IPC wiring or rate limit, and no near-duplicates.

## 7. Manual checks for the user

First install gsudo: `winget install gerardog.gsudo`. If `gsudo` is not then found, restart Terminals.

- **M1 UAC accept.**
  1. Open the "+" chevron, then New admin terminal. One UAC prompt appears. Accept it.
  2. The tab shows the shield and "Admin pwsh n".
  3. Run `whoami /groups | findstr /i "High Mandatory"`. It must show the High Mandatory Level.
  4. Also check: `$env:TERMINALS_LOC_ID` is set; the cwd is the folder; resizing the window reflows the output; Ctrl+C interrupts `ping -t localhost`; `vim`/`edit` (if installed) draws correctly.
- **M2 UAC cancel.**
  1. New admin terminal, then press No.
  2. The tab shows `Elevation was cancelled or failed (exit N)`, is marked exited, and offers Start as admin.
  3. Note N, so Q3 can be closed.
  4. Retry and accept: it works in the same tab.
- **M3 No orphan.**
  1. Before you start, run `Get-Process pwsh, gsudo -ErrorAction SilentlyContinue | ft Id, ProcessName, StartTime` in a normal terminal. Alternatively, use Task Manager → Details with the "Elevated" column.
  2. Open an admin tab, then close it. Within about 2 s there is no extra elevated pwsh and no gsudo.
  3. Repeat while `ping -t localhost` runs in the admin tab.
  4. Repeat by quitting the app from the tray while an admin tab is open.
  5. If an orphan remains, report it. F2 (`--attached`) then gets built.
- **M4 Restore.**
  1. Keep an admin tab open and quit the app.
  2. Restart. No UAC appears at startup. The tab is back with its shield and title, and the pane shows "Administrator terminal (not started)" and Start as admin.
  3. Click Start as admin. UAC appears and the shell starts in the saved cwd.
- **M5 gsudo missing.**
  1. Uninstall gsudo (`winget uninstall gerardog.gsudo`), or test before installing it.
  2. "New admin terminal" is disabled with the hint, and a restored placeholder's button is disabled.
- **M6 Windows sudo fallback (optional).**
  1. With gsudo absent, enable sudo: Settings → System → Advanced → Enable sudo, mode "Inline".
  2. Run `sudo config` and `reg query HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo /v Enabled`, and note the value.
  3. New admin terminal works via sudo.
  4. Set the mode to "In a new window". The item becomes disabled.
- **M7 Snippets.** With an admin tab active, insert a saved prompt. It goes to a normal tab, or a new normal tab opens. It never goes into the admin tab.

## 8. Open questions

- **Q1** The Windows sudo registry mapping (`Enabled` 1/2/3 = new window/input disabled/inline) is from memory. M6 confirms it; if it is wrong, only `parseSudoMode` changes.
- **Q2** `gsudo --direct <exe> args`: is this the right form when the parent is Electron, or does gsudo already run the exe directly when given a full path? Checked in M1. The fallback is no flag.
- **Q3** The UAC-cancel exit codes (gsudo 999? sudo 1223?) are unverified. The <4 s non-zero rule covers both meanwhile.
- **Q4** Does ClosePseudoConsole end gsudo's elevated client in its default mode? This is expected from the ConPTY docs but unverified. M3 decides whether F2 is needed.
- **Q5** Should an elevated tab drop `TERMINALS_MCP_TOKEN` from its env? The plan keeps it (same user, and MCP cannot run commands). Say if you want it blanked for admin tabs.
- **Q6** Is the menu wording and placement acceptable: a chevron next to "+" plus right-click on "+", and no keyboard shortcut?

## T1 status (implementer)

DONE 2026-11-18: src/main/elevation.ts, src/shared/elevation.ts, types.ts, session.ts, smoke.ts (checkElevation + checkSession lines). yarn smoke: all PASS incl. elevation and session. yarn typecheck: only error is preload missing getElevator (T2). Deviation: none.

## T2 status (implementer)

DONE 2026-11-18: src/main/pty.ts (spawnElevated), src/main/index.ts (pty:create elevated branch in required order, elevatedIds, releasePty F1 graceful kill shared by pty:kill and killPtysOf, owner checks, 1500 ms rate limit, pty:elevator), src/preload/index.ts (getElevator). killAllPtys stays synchronous.
Verify: tsc node half exit 0; web half only error is App.tsx:944 missing onNewAdmin/getElevator props (T3 in progress). yarn smoke exit 0, all PASS.
Deviations: (1) onExit identity check (`ptys.get(id) === spawned`) per orchestrator; a pty already released by kill no longer forwards pty:exit. (2) checkElevatedRequest runs at the very top of pty:create, before cwd checks. (3) Rate-limit timestamp is recorded on every elevated attempt that passes the limiter, even if a later step fails.

## T3 status (orchestrator, from implementer report and review)

DONE 2026-11-18: TabBar.tsx (Tab.elevated/pending/attempt, chevron + right-click "+" menu with getElevator per open, shield marker, `admin` class, tooltip), ContextMenu.tsx (MenuItem.title), App.tsx (newAdminTab via newTab 4th arg, startAdmin placeholder start + retry, restore placeholder, closeTab/counts/insertSnippet filters, AdminPlaceholder + StartAdminButton, retry bar, key `${id}:${attempt}` on a display:contents wrapper), TerminalView.tsx (elevated prop), termRegistry.ts (elevated/startedAt, D9 message), styles.css (--danger/--danger-soft only).
Review round 1: D9 message was computed but not written; fixed. Deviations: no `.tab-new-menu` class (reuses ContextMenu); retry bar button also disabled with the hint when no elevator.

## T4 status (orchestrator)

2026-11-18: `yarn typecheck` exit 0; `yarn smoke` exit 0 (12 PASS incl. elevation, session, migration); `yarn build` exit 0; `yarn dist:dir` exit 0 -> release/win-unpacked/Terminals.exe.
A7/A8 (app run with gsudo absent) UNTESTED: the UI could not be inspected non-interactively; left to M4/M5. A11 UNTESTED (needs gsudo, M1-M3, M6).
