# Changelog

## 2026-11-18 REQ-0003 Admin (elevated) terminal tab

Outcome: a "New admin terminal" action (a chevron next to "+", or right-click on "+") starts the default shell elevated through gsudo, or through Windows sudo in inline mode, inside a normal in-app tab. Admin tabs come back after a restart as not-started placeholders. Typecheck, smoke, build and dist:dir pass. Elevation itself is untested.

### Repo terminals, branch `feature/admin-powershell-tab` (base `feature/tab-reorder-and-same-folder-split` a141882)

- `src/main/elevation.ts` (new):
  - Finds gsudo on PATH and in its known install dirs. If none, it falls back to `%SystemRoot%\System32\sudo.exe`, and only in `normal` mode. Otherwise it returns null. It is never cached.
  - `parseSudoMode` / `readSudoMode` read the mode with `reg query`.
  - `elevatedCommand` builds the fixed line `gsudo --direct <shell> [-NoLogo]` or `sudo <shell> [-NoLogo]`. It returns null for anything other than pwsh, powershell or cmd.
  - `checkElevatedRequest` rejects steps.
- `src/shared/elevation.ts` (new): `GSUDO_HINT`, plus `elevationFailed`, which is true for code 999 or 1223, or any non-zero exit within 4 s.
- `src/shared/types.ts`: adds `PtyCreateRequest.elevated`, `PersistedTab.elevated`, `ElevatorInfo` and `TerminalsApi.getElevator`.
- `src/shared/session.ts`: `elevated` is kept only when it is `true` on a shell tab, and it is carried through `toPersistedTabs`. The schema stays at v4.
- `src/main/pty.ts`: adds `spawnElevated(file, args, ...)`.
- `src/main/index.ts`:
  - The `pty:create` elevated branch runs in this order: reject steps, the 1500 ms per-renderer rate limit, resolve the elevator, build the command, spawn. Error texts are as in the plan.
  - New `pty:elevator` IPC. It returns availability, the tool and a hint; it never returns the path.
  - `elevatedIds` tracks elevated ptys.
  - `releasePty` closes ptys for `pty:kill` and `killPtysOf`. An elevated pty gets Ctrl+C and `exit`, then the kill 400 ms later (F1).
  - `onExit` acts only when the same pty instance is still registered under the id, so a reused id is safe.
  - `pty:write`, `pty:resize` and `pty:kill` require the sender to own the pty.
- `src/main/smoke.ts`: new `checkElevation` (resolution order, sudo-mode parsing, command line, step rejection, failure rule). `checkSession` gains elevated fixtures.
- `src/preload/index.ts`: adds `getElevator`.
- `src/renderer/src/TabBar.tsx`:
  - `Tab` gains `elevated`, `pending` and `attempt`.
  - The split "+" menu (chevron or right-click) calls `getElevator` each time it opens. When no elevator is found, the item is disabled with `New admin terminal — install gsudo: winget install gerardog.gsudo`.
  - Admin tabs get a shield icon, the `admin` tint and an "(administrator)" tooltip.
- `src/renderer/src/ContextMenu.tsx`: optional `title` tooltip on menu items.
- `src/renderer/src/App.tsx`:
  - `newAdminTab` creates the tab with the title `Admin <shell> n`.
  - `startAdmin` starts a restored placeholder, or retries an exited admin tab by remounting it through `attempt`.
  - Restore makes admin tabs placeholders and starts no process.
  - The placeholder pane shows a Start as admin button, disabled with the hint when no elevator is found. Exited admin tabs show a retry bar.
  - Snippet insertion skips admin and placeholder tabs, and the live-tab counts skip placeholders.
- `src/renderer/src/TerminalView.tsx`: passes `elevated: true` to `ptyCreate`, and nothing else.
- `src/renderer/src/termRegistry.ts`: entries record `elevated` and `startedAt`. A failed or cancelled elevation prints `Elevation was cancelled or failed (exit N). Use "Start as admin" to try again.`
- `src/renderer/src/styles.css`: styles for the admin tab, chevron, placeholder, hint and retry bar. They use theme variables only (`--danger`, `--danger-soft`).

### Deviations

- In `onExit`, the identity check means a pty already released by kill no longer sends `pty:exit`.
- `checkElevatedRequest` runs before the cwd checks.
- The rate-limit timestamp is recorded on every attempt that passes the limiter.
- No `.tab-new-menu` class was added, because the menu reuses `ContextMenu`. The retry button is also disabled when no elevator is found.
- The `gsudoCandidates` env lookup ignores case and skips relative PATH entries.
- User decisions: Q5, keep the MCP token in admin tabs. Q6, chevron plus right-click accepted.

### Verification

- `yarn typecheck`: exit 0.
- `yarn smoke`: exit 0, 12 PASS, including `elevation`, `session` and `migration`.
- `yarn build`: exit 0.
- `yarn dist:dir`: exit 0, giving `release/win-unpacked/Terminals.exe`.

Not run:

- A7/A8: run the app with gsudo absent to see the disabled item, the placeholder and no UAC at startup. These are UNTESTED: they were not inspected in the real app.
- A11 / M1-M7: UAC accept and cancel, orphan on close, Windows sudo fallback, snippets. These need gsudo and manual checks.

### Follow-ups

- Open questions Q1-Q4 are settled by manual checks M1-M3 and M6.
- If M3 finds an orphaned elevated shell, F2 (gsudo `--attached`) gets built.

Commit status: uncommitted.
