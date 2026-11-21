# Changelog

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
