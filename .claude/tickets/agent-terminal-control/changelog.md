# Changelog

## 2026-11-26 - agent-terminal-control (REQ-0007) extras round 2 (plan-extras-2.md)
Screen-exact reads, run lines kept out of PSReadLine history, results of timed-out runs, multi-pattern/ignoreCase waits with ReDoS caps, cleaner pwsh 7 errors.

### Repo terminals - branch `feat/open-requests`
- `src/main/screen.ts` (new): `ScreenMirror`, a headless xterm (scrollback 0, unicode11 + unicode-graphemes, fallback '11'); `snapshot()` returns cols, rows, cursor, altScreen and exactly `rows` right-trimmed lines.
- `src/main/terminalHost.ts`: every terminal gets a mirror fed in `data()`, resized by `resized(id, cols, rows)`, disposed in `remove()`; `screen(id)`; `runId` on results; final result recorded at the real end of a run (no 1024-char trim after timeout) in a 32-entry `finished` map that outlives close; `runResult()`; waiters take matchers, return `patternIndex`/`pattern`, scan incrementally (8 KiB pending, one initial 64 KiB scan); waits capped 4 per terminal / 16 total, `get_run_result` waits included.
- `src/main/mcpTools.ts`: `compileWaitPatterns` (pattern xor patterns, max 8, max 256 chars, regex tests first 2000 chars, `ignoreCase`); `wait_for_output` shape (`patterns`, `ignoreCase`); `read_terminal.screen`; new `get_run_result` tool; `run_command` description mentions `runId`.
- `src/main/mcp.ts`: instructions mention `get_run_result` and `screen`.
- `src/main/termText.ts`: `RUN_LINE_PREFIX`, `historyHandlerScript()` (PSReadLine AddToHistoryHandler that drops run lines and chains an existing handler), `agentInitArgs()`; `buildRunInput` is one physical line (pwsh 7 errors print as `Write-Error: boom`), writes the end marker before non-throwing cleanup, reinstalls the history handler when `$global:__terminalsHist` is unset, and no longer forces/restores `$ErrorView`.
- `src/main/pty.ts`: `spawnShell` takes optional `args`.
- `src/main/index.ts`: cols/rows in meta; `pty:resize` passes the size to the host; agent pwsh/powershell spawns (MCP open and restored agent tabs) pass `agentInitArgs()`.
- `src/main/smoke.ts`: plan acceptance asserts 1-5, 7-9 in `checkRunCommand` / `checkMcpLogic`; `RUN_LINE_PREFIX` check in `checkTermText`.
- `package.json`, `yarn.lock`: `@xterm/headless@^6.0.0`.
- `README.md`: tools table and terminal-control bullets for all of the above, echo-match note (E6), caps and remaining ReDoS risk, per-shell error output.

### Deviations
- E7: instead of restoring `$ErrorView` only when unchanged, the wrapper no longer touches `$ErrorView` at all (assert 7 cannot pass otherwise). A profile that sets NormalView gets the wrapper excerpt in pwsh 7.
- E8: the ErrorRecord format-view mechanism failed in both shells (pwsh 7 host ignores a prepended ErrorRecord view; 5.1 has no ErrorRecord format data). Shipped the plan's pwsh 7 fallback (invocation on line 1). 5.1 NOT DONE (Decision 1): it keeps its `At line:` excerpt. No temp ps1xml, no `__terminalsRun` flag.
- Assert 2 compares the PSReadLine history count before and after the runs rather than requiring 0, because this machine's history already holds run lines leaked by older builds.

### Verification
- Spikes: E2 handler works in pwsh 7.6 (PSReadLine 2.4.5) and Windows PowerShell 5.1 (PSReadLine 2.0.0); `-NoExit -EncodedCommand` runs after the profile with PSReadLine loaded; an existing handler is chained; 0 run lines added with init args, 1 without. E8 format view failed in both; one-line wrapper clean in pwsh 7 only.
- `yarn typecheck`: exit 0. `yarn smoke`: 21 PASS, 0 FAIL (re-run by the orchestrator).
- `yarn dist:dir`: exit 0; `out/main/index.js` requires `@xterm/headless`; `app.asar` contains `node_modules/@xterm/headless`; packaged `Terminals.exe --smoke` 21 PASS.
- Not run (UNTESTED): manual check of a full-screen program read with `screen: true` while the window is hidden in the tray.

### Follow-ups
- Windows PowerShell 5.1 error excerpt remains (possible `Write-Error` proxy, cmdlet errors not covered).

Commit status: committed on `feat/open-requests` (see git log).

## 2026-11-21 - agent-terminal-control (REQ-0007)
MCP clients can open, drive, read and close visible PowerShell tabs, behind an off-by-default toggle; a pinned Home location is their default.

### Repo terminals - branch `feat/agent-terminal-control`
- `src/shared/types.ts`: `HOME_ID`, `HomeView`, `AppState.home`, `Settings.homeDir` / `allowMcpRun`, `PersistedTab.agent`, `PtyCreateRequest.agent`, `AgentTabRequest`, `TerminalsApi.ptyAttach` / `onAgentOpenTab` / `onAgentCloseTab`.
- `src/shared/settings.ts`: `homeDir` (''/absolute Windows path) and `allowMcpRun` (boolean, default false).
- `src/shared/session.ts`: shell tabs persist `agent` (never with elevated).
- `src/preload/index.ts`: `pty:attach` invoke, `agent:openTab` listener that replies on `agent:openTab:reply` (throws become `{ok:false}`), `agent:closeTab` listener.
- `src/main/termText.ts` (new): `stripAnsi`, `toLines`, `RingBuffer`, `buildRunInput` (base64 dot-sourced wrapper, OSC 133 C/D markers with nonce and exit code), `findMarkers`, `psShell` (re-export).
- `src/main/terminalHost.ts` (new): `TerminalHost` - 512 Ki-char ring per pty, cwd tracking from OSC 9;9/7, open (spawn, tab round trip, readiness wait), run state machine (busy, timeout leaves busy, exited), send, read, close; write tools refuse user, elevated, exited and non-PowerShell terminals.
- `src/main/toolError.ts` (new): `ToolError` class.
- `src/main/pty.ts`: `psShell(configured)`.
- `src/main/store.ts`: `getHomeDir()`, `getState().home`, Home dir in `getRoots()`, selection falls back to `HOME_ID`.
- `src/main/index.ts`: host wiring for every pty (`host.add/data/exit/remove`), main-spawned agent ptys, `pty:attach` (owner-checked, returns backlog), open-tab bridge with 5 s timeout, close-tab, Home agent cwd rule in `pty:create`, `startMcpServer` gets `terminals` and `allowRun`.
- `src/main/mcpTools.ts`: Home in `buildLocations`/`list_locations`, `resolveOpenTarget`, `RUN_DISABLED_ERROR`, async `run`, `readOnly` annotation, six tools with the toggle gate (`list_terminals` ungated).
- `src/main/mcp.ts`: opts pass-through, awaited tool run, new `INSTRUCTIONS`, `McpInfo.close()`.
- `src/main/smoke.ts`: `checkTermText`, `checkRunCommand`, `checkMcpHttp`, `checkMcpLogic` Home/resolveOpenTarget assertions.
- Renderer (`App.tsx`, `TerminalView.tsx`, `termRegistry.ts`, `TabBar.tsx`, `Sidebar.tsx`, `locations.ts`, `SettingsDialog.tsx/.css`, `styles.css`): background agent tabs that attach to main's pty with backlog replay, Bot icon, pinned Home row (open terminal, Explorer, copy path), Settings "Home folder" (Browse / Use Documents) and "MCP" toggle; Reset keeps both.
- `README.md`: MCP tools table, Terminal control section, security note, Home in sidebar, settings in Data, smoke note.

### Deviations
- `ToolError` moved to `src/main/toolError.ts` (mcpTools imports store -> electron); re-exported from mcpTools.
- `HostDeps.ownerWc?()` added so agent records carry the window's webContents id.
- index.ts keeps a `hosted` map and `attached` set to back `pty:attach` and the per-id `pty:kill` cleanup.
- `findMarkers` also accepts the ST terminator and negative exit codes.
- Settings: "Home folder" sits in its own "Home" section.
- Sentinel: the planned OSC 133 form shipped; no fallback.

### Verification
- `tsc --noEmit -p tsconfig.node.json`: exit 0. `-p tsconfig.web.json`: exit 0.
- `electron-vite build` then `node_modules/electron/dist/electron.exe . --smoke`: 16 PASS, 0 FAIL, exit 0 (`yarn smoke` via `fnm exec ... cmd /c` printed nothing).
- Sentinel spike (worker scratch): pwsh 7 and Windows PowerShell 5.1 both give `a1`/3, persistent `$x`, throw/Write-Error -> 1.
- Not run: acceptance 10-16 (manual checks in the real app).

### Follow-ups / known limitations
- pwsh 7 `Write-Error` output includes a position excerpt pointing at the wrapper (cosmetic).
- `run_command 'exit 5'` returns exitCode 1, not `exited: true`.

### Commit status
Committed as `a1e8d97` on `feat/agent-terminal-control` (not pushed). Ticket folder not committed.
