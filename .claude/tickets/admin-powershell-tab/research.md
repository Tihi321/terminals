# Research: admin (elevated) PowerShell tab

## Question
How can the app offer an in-app terminal tab running PowerShell elevated via gsudo (or Windows `sudo`), and where does it plug in?

## Answer
- Machine: gsudo is NOT installed; Windows `sudo.exe` exists but is DISABLED; pwsh 7 and Windows PowerShell exist; winget 1.29 exists. So nothing can elevate today without an install or a setting change.
- Best fit is gsudo (attached mode, runs inline in the ConPTY, one UAC prompt, with resize and I/O working). Windows sudo inline mode is a weaker fallback. Both behaviours below are from memory; neither tool is here to test.
- Plug-in: `listShells()` in `src/main/pty.ts` and `pty:create` in `src/main/index.ts`. Use an `elevated: true` flag on `PtyCreateRequest`; main builds the command line itself. The renderer never passes a command or path.
- REQ-0002 restore should restore admin tabs only on explicit user action (see options).

## Findings (machine state, verified by running commands)
- `where gsudo` -> not found; `gsudo --version` -> command not found (confirmed).
- `where sudo` -> `C:\Windows\System32\sudo.exe`. `sudo --help` prints "Sudo is disabled on this machine. To enable it, go to the Developer Settings page" (confirmed). The registry key `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo` has no values/subkeys readable (Get-ItemProperty gave nothing), consistent with disabled; mode not determinable. Enabling is a user/admin action (Settings > System > Advanced; itself needs UAC).
- `where pwsh` -> `C:\Program Files\PowerShell\7\pwsh.exe`; `where powershell` -> `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` (confirmed).
- `winget` v1.29.380 at `...\WindowsApps\winget.exe` (confirmed), so `winget install gerardog.gsudo` is possible (I did not run it).
- I did not elevate or trigger UAC.

## Behaviour of gsudo / sudo in a pty (from memory, NOT verified here)
gsudo:
- Default mode is "attached": gsudo (unelevated) starts an elevated service/host process after one UAC prompt, and relays the console of the elevated child to the caller's console. Under a ConPTY the caller's console is the pty, so output, input, colours, Ctrl+C and resize are relayed. This is the main reason to prefer it. Expect to rely on this but test it (M-test below).
- `gsudo` with no command starts an elevated shell (`gsudo` alone = elevated current shell). Useful forms: `gsudo pwsh -NoLogo`, or `gsudo -d "<cmd>"`. `-d`/`--direct` runs without wrapping in the shell.
- `--new` / `-n` (`--new-window`): opens a separate elevated console window, not in the pty. Not wanted here.
- Credentials cache (`gsudo cache on`) lets later calls in the same session skip UAC; off by default. Not needed for a tab.
- UAC cancelled: gsudo exits non-zero (documented as exit code 999 for gsudo errors, e.g. user cancelled elevation). Treat as "elevation failed", not shell exit. The existing `pty:exit` carries the code to the renderer (`index.ts:370-373` approx.), so the tab can show a "Elevation cancelled" message on code 999 (verify the exact code on a real install).
- gsudo needs to be reachable on PATH or by full path; the winget install adds it to PATH only for new processes, so Electron started before install will not see it (see Risks).
- Elevated child's cwd equals the caller's cwd (gsudo preserves it). Environment is mostly passed through, except some variables that gsudo resets (e.g. profile-related paths for the admin user) when the admin account differs from the user. For a same-user UAC elevation this is mostly fine. The TERMINALS_LOC_* env from `ptyEnv()` should survive; verify.
Windows sudo (24H2+, sudo.exe):
- Three modes in Settings: `forceNewWindow` (opens a new console window), `disableInput` (inline, output only, no stdin to the elevated process), `normal` (inline with input, since 24H2 build 26052+; this machine is 10.0.26300). Only `normal` is usable in a tab. Inline is documented as less capable than gsudo (no full TTY semantic guarantees; it can have problems with interactive full-screen apps). Per-command: `sudo pwsh` elevates one process; there is no cache like gsudo's.
- Disabled by default; this machine: disabled.

## Path through the code (how shells work today, confirmed)
- `src/main/pty.ts:15-22` `resolveShell(configured)`: empty/auto -> pwsh.exe on PATH else powershell.exe.
- `src/main/pty.ts:35-42` `listShells()` returns `ShellOption {value,label,available}` for Automatic, pwsh.exe, powershell.exe, cmd.exe.
- `src/main/pty.ts:70-92` `spawnPty(shell, args, cwd, ...)` calls `pty.spawn(shell, args, {env: process.env + extraEnv})`. `spawnShell` passes `[]` args; so an elevated spawn would be `spawnPty(gsudoPath, [shell, ...], ...)`. `spawnPty` is module-private; a new exported `spawnElevatedShell` is the natural addition.
- `src/main/index.ts:360-387` (master) `pty:create`: validates cwd, uses `store.getShell()` always (request carries no shell today); `Array.isArray(req.steps)` -> steps with `stepsShell(...)`. `settings:shells` handler at `index.ts:290`; preload `listShells` at `src/preload/index.ts:39`, `ptyCreate` at line 74.
- Renderer: `TerminalView.tsx:42` calls `ptyCreate({id,cwd,cols,rows,steps,locId})`. New tab: `App.tsx:210-227` `newTab(locId, cwdOverride)` titles it `${shellLabel(st.resolvedShell)} ${n}` and creates `{kind:'shell'}`; the "+" button is `TabBar.tsx:113` (`onNew`, single click, no menu, no shell choice). Default shell is chosen only in `SettingsDialog.tsx:67-70, 183-214` (select fed by `listShells()`, unavailable entries are shown disabled, see `selectOptions` at 206).
- `src/main/smoke.ts` (working tree modified by another worker): tests spawn via `spawnShell`; there is a CLI smoke harness, so a pure unit helper for building the elevated command line can be smoke-tested without elevating.
- REQ-0002 plan: D7 (persisted `Tab` data incl. `shell`, `startCwd`; plan.md:63) and D11 (plan.md:105-110): `PtyCreateRequest.shell?` accepted only if it equals `store.getShell()` or the resolved path of an available `listShells()` entry, else falls back; new shell tabs store `shell = state.resolvedShell`. These are still plans; the working tree is mid-change.

## Recommended design
1. Contract: add `elevated?: boolean` to `PtyCreateRequest` (alongside D11 `shell?`, `fallbackCwd?`). The renderer never sends an executable path for elevation. In main: `if (req.elevated)` then (a) reject if `Array.isArray(req.steps)` (no elevated saved commands; keep elevation to interactive tabs), (b) shell = the D11-validated allow-listed shell (pwsh/powershell only), (c) elevator = `resolveElevator()` in main: gsudo found by `findOnPath('gsudo.exe')` or the known install dirs (`%ProgramFiles%\gsudo\Current\gsudo.exe`, `%LOCALAPPDATA%\Microsoft\WinGet\Links\gsudo.exe`), (d) spawn `gsudo.exe <shellPath> -NoLogo` with args as an array (no string concatenation, no cmd). Fixed argument list only.
2. `listShells()` (or a new `settings:elevation` IPC) reports `{ available, tool: 'gsudo'|'sudo'|null, hint }`. Detect sudo by `sudo.exe` plus registry `Sudo\Enabled` (value 3 = normal, per memory; verify) via `reg query`/`execFile` with array args; treat anything other than normal mode as unavailable. Prefer gsudo when both exist.
3. UI: put the entry in the tab bar as a small dropdown next to "+" (or Ctrl+Shift+Alt+T) "New admin terminal". If the tool is missing: show the item disabled with hint "Install gsudo: winget install gerardog.gsudo (then restart Terminals)". Do not add it to the Default shell setting (an app that auto-elevates every tab is dangerous); keep it a per-tab action.
4. Tab: `Tab.elevated?: boolean`; title "Admin PowerShell n", a visible shield/red-tinted marker on the tab so it is obvious. Exit handling: code 999 or immediate exit within ~2 s of spawn shows an "Elevation cancelled or failed" line.
5. Restore (REQ-0002), options:
   - A (recommended): persist `elevated: true` but on restore create the tab as a placeholder "Admin terminal (click to start)" not spawning until the user clicks, so no surprise UAC prompt at app start and no unattended elevation.
   - B: restore as a normal non-admin shell, drop the flag (safe, loses intent).
   - C: auto-spawn with UAC at start (annoying; prompts on every launch; users may habitually approve).
   - D: do not persist admin tabs.
   D11 needs the allow-list extended: `elevated` only honoured when the validated shell is pwsh/powershell.
Alternatives for the mechanism: (i) Windows `sudo` only (no install, but disabled here and inline mode limited); (ii) `Start-Process -Verb RunAs` in a new window (not in-tab, no I/O capture); (iii) running the whole app elevated (breaks drag/drop from Explorer, security regression). Hide vs disable when missing: show disabled with the hint (discoverable); hiding gives no way to learn about the feature.

## Security notes
- Elevation must be user-intent-gated: UAC is the gate, but the renderer must not be able to start elevated arbitrary executables. With the contract above, the renderer can only trigger "elevated + allow-listed PowerShell", and only after UAC consent. Still, a compromised renderer could spawn unlimited UAC prompts; a rate limit (one pending elevation at a time) is cheap.
- Writes to an elevated pty (`pty:write`, `index.ts:~389`) go to an admin shell: this is the same renderer trust as today, but the blast radius is larger. Existing `pty:write` has no per-webContents ownership (REQ-0002 D17 adds it). Make D17 a prerequisite or do it together.
- Saved commands/MCP: check whether any MCP or "run command" path can reach an elevated tab (e.g. "paste prompt into active shell tab", `App.tsx:480-505`, pastes into the folder's active shell tab; it should skip elevated tabs, or at least the user should know). Confirmed that function matches `kind==='shell'` only (`App.tsx:485`); it would need an `!t.elevated` filter. Also `ptyEnv(locId)` env exposes MCP context to an admin shell: confirm no secrets.
- Spawn args as array, absolute gsudo path, no `shell: true`.

## Risks
- gsudo and winget PATH: a running Electron app doesn't see a newly installed PATH; hence the known-dir fallback and the "restart" hint.
- `gsudo` attached mode in ConPTY is from memory; resize, Ctrl+C and full-screen apps need a real test once installed (manual M-test: open tab, accept UAC, `whoami /groups`, `[Environment]::...`, run `vim`/resize window, Ctrl+C).
- Process kill: `p.kill()` on pty (`index.ts:~395`) kills the unelevated gsudo wrapper; the elevated child is owned by gsudo's service and a non-elevated process cannot kill an elevated one. Closing the tab may leave an orphan elevated pwsh unless gsudo cleans up on console close (it normally does when the pipe closes). Verify; this is the largest unknown.
- Elevated process cwd must be a directory the admin token can access (fine).
- Shared code: `pty.ts` is used by the smoke test (`smoke.ts`); keep `spawnShell` signature unchanged.
- REQ-0002 touches the same files (App.tsx, TabBar.tsx, index.ts, types.ts, store.ts). Do the admin ticket after REQ-0002 merges, or on top of its branch.
- Schema: `Tab.elevated` fits REQ-0002 v4 additively; no extra migration if optional.
- gsudo inside an already elevated app, or UAC disabled / policy "no prompt": gsudo then just runs in place; fine.

## Open questions for the user
1. gsudo only, or also Windows `sudo` (needs enabling in Developer Settings, normal mode)? Recommendation: gsudo only for v1.
2. Restore behaviour for admin tabs: A (placeholder, click to start), B, C or D?
3. Should the admin tab be pwsh 7 or Windows PowerShell, or follow the default shell (if it is pwsh/powershell)? Recommendation: follow resolved shell when it is a PowerShell, else pwsh/powershell.
4. Should saved commands or "paste prompt" ever target an admin tab? Recommendation: no.
5. May I install gsudo (`winget install gerardog.gsudo`) on this machine to verify the pty behaviour and exit codes before implementation?
6. UI: dropdown arrow on "+", or a shortcut only?
