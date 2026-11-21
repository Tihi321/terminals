---
status: in-progress
request: REQ-0007
repos: [C:/projects/Personal/terminals]
branch: feat/agent-terminal-control
updated: 2026-11-21
---
# Plan: agent terminal control via MCP

Sources: `.claude/director/requests/REQ-0007-agent-terminal-control.md`, `research.md` (same folder). Line numbers are from master `37e0899`.

## Scope
Full reading. MCP clients can open, drive, read and close real PowerShell tabs in the app. A pinned Home location gives them a default place to open terminals.

- **Six new MCP tools** on the existing server: `open_terminal`, `run_command`, `send_input`, `read_terminal`, `list_terminals`, `close_terminal`. The input and output shapes are fixed in the contract below.
- **Guard.** New setting `allowMcpRun` ("Allow MCP to run commands"), off by default. Every gated tool reads it when it is called. When it is off, `open_terminal`, `run_command`, `send_input`, `close_terminal` **and `read_terminal`** return a `ToolError`. Only `list_terminals` stays available.
  - Why `read_terminal` is gated: terminal output can hold secrets (tokens, pasted passwords). README says any same-user process can read the MCP token, so the toggle is the only barrier.
  - Why `list_terminals` stays open: it returns metadata only (ids, locations, cwd, shell, alive). It also tells the agent whether control is on (`allowRun`), so it can ask the user to turn it on.
  - There are no per-command prompts.
- **What agents may write to.** `run_command`, `send_input` and `close_terminal` act only on **agent-opened** terminals. `list_terminals` and `read_terminal` see every terminal, user tabs included.
  - Why: the agent itself usually runs inside one of the user's tabs. Typing into user tabs would also break their work. Closing a user's tab would destroy their scrollback.
- **Agent tabs** are normal visible shell tabs under their location, with a Bot icon. The user can watch them and type in them. The persisted flag `agent: true` means a restored agent tab is again controllable by MCP (with a new id).
  - Agent tabs open **in the background**: they are not activated and take no focus. The one exception is a pane that shows that location and has no active tab; there the new tab becomes active. Why: a new agent tab must not steal the keystrokes of a user typing in a sibling tab.
- **Never elevated.** `open_terminal` has no admin option. The host always spawns a plain PowerShell: the configured shell when it is pwsh or powershell, otherwise `resolveShell('')`. Elevated terminals refuse all write tools.
- **Home** is a real location with id `home` and kind `'home'`. It is pinned at the top of the sidebar.
  - It is selectable and has its own tab list. The Files, Git and Commands panels work as they do for a folder: Home's directory is added to `store.getRoots()`.
  - Its directory is `settings.homeDir`. The setting holds `''` by default, which means `app.getPath('documents')`, computed at runtime. It can be changed in Settings with a folder picker.
  - It is the default when `open_terminal` gets no `location`. An existing directory that is not saved also opens under Home, with that cwd, and nothing is saved to the sidebar. A directory that does not exist is an error.
- **`run_command`** runs in the tab's LIVE interactive PowerShell, so state such as `cd` and variables persists between calls.
  - Completion comes from a hidden OSC end-marker that carries a per-run nonce and the exit code.
  - The output is the raw stream between the begin and end markers, ANSI-stripped. That range contains no echoed input and no prompt.
  - Only one run at a time per terminal: a second call gets a "busy" `ToolError`. Runs are not queued.
  - On timeout the call returns the partial output with `timedOut: true`, and the shell keeps running.
  - If the terminal exits during a run, the call returns `exited: true`.
- **Where the output buffer lives: in main.** Main keeps a ring buffer of the raw output of every pty (512 KiB of chars each). It feeds `read_terminal`, run capture and the backlog replay when a tab attaches. This works even while the window is hidden in the tray.
- **The PTY for an agent tab is spawned by main.** The renderer then shows a tab and attaches to the existing pty (`pty:attach` returns the backlog). So `open_terminal` does not depend on layout, fit or the visibility of the window.
- **The window is never shown or focused by MCP.** If it is hidden in the tray or minimised, the tab is created in the background and is there when the user opens the window. The open-tab round trip has a 5 s timeout. If the renderer does not answer (window still loading, or being reloaded), the pty is killed and the tool returns an error.
- Update the README MCP section, the "Data" settings notes and the `INSTRUCTIONS` string in `mcp.ts`.

## Out of scope
- Elevated or admin terminals through MCP, and any write tool on an elevated tab.
- MCP writing to, or closing, terminals the user opened (they can only be listed and read).
- `run_command` under cmd.exe or other shells. Agent terminals are always PowerShell.
- Per-command approval prompts, and an allow-list of commands.
- Queuing runs. A busy terminal is an error.
- Raising, showing or focusing the window, and changing the sidebar selection, from MCP.
- A screen-exact `read_terminal`: no xterm headless or serialize addon. Lines come from the ANSI-stripped raw stream. Full-screen TUIs read back poorly; this is documented.
- Keeping the injected run line out of PSReadLine history, and hiding its echo.
- Saving arbitrary `open_terminal` paths to the sidebar. Restoring the exact arbitrary cwd of a Home agent tab: on restore it falls back to the Home dir, because `pathsExist` only knows the roots.
- Changes to the saved-command runner (`spawnSteps` / `buildRunArgs`).
- Persisting the ring buffers or scrollback. Multi-window support.
- Renderer unit tests. The renderer is checked by hand in the real app.

## Files and modules to touch
| File | Change | Task |
|---|---|---|
| `src/shared/types.ts` | `HOME_ID`, `HomeView`, `AppState.home`, `Settings.homeDir/allowMcpRun`, `PersistedTab.agent`, `PtyCreateRequest.agent`, `AgentTabRequest`, `TerminalsApi` additions | T1 |
| `src/shared/settings.ts` | schema entries `homeDir`, `allowMcpRun` (20-47) | T1 |
| `src/shared/session.ts` | `agent` in `sanitizeTab` (shell branch, 25-28), `SessionTab`, `toPersistedTabs` | T1 |
| `src/preload/index.ts` | `ptyAttach`, `onAgentOpenTab`, `onAgentCloseTab` | T1 |
| `src/main/termText.ts` (new) | pure: `stripAnsi`, `toLines`, `RingBuffer`, `buildRunInput`, `findMarkers`, `psShell` | T2 |
| `src/main/terminalHost.ts` (new) | `TerminalHost` (records, ring buffers, run state machine), `TerminalControl`, `HostDeps`, `TermInfo`, `RunResult` | T2 |
| `src/main/store.ts` | `home` in `getState` (257-293), `getHomeDir()`, `getRoots` (308-310) adds Home, selection fallbacks (398-401, 443) to `HOME_ID` | T3 |
| `src/main/index.ts` | host wiring in `pty:create` (437-513), `releasePty`/`killPtysOf`/`killAllPtys`, `pty:kill`, new `pty:attach`, open/close tab bridge, `startMcpServer` opts (545), Home cwd rule (443-447) | T3 |
| `src/main/mcp.ts` | `await t.run` (76), `readOnly` annotation (72), opts `terminals` + `allowRun` through `startMcpServer` -> `handle` -> `buildServer` -> ctx, new `INSTRUCTIONS` (27-28) | T4 |
| `src/main/mcpTools.ts` | `LocKind` + `'home'`, `KIND_LABEL`, `buildLocations` adds Home (48-61), `ToolContext` additions, `ToolDef.run` async + `readOnly`, `resolveOpenTarget`, 6 new tools, `RUN_DISABLED_ERROR` | T4 |
| `src/renderer/src/locations.ts` | `Loc.kind` + `'home'`; `buildLocs` adds Home | T5 |
| `src/renderer/src/termRegistry.ts` | `createTerm(id, { attach })`, `TermEntry.attach` | T5 |
| `src/renderer/src/TerminalView.tsx` | attach path instead of `ptyCreate` (44-68); pass `agent` to `ptyCreate` | T5 |
| `src/renderer/src/TabBar.tsx` | `Tab.agent`, Bot icon | T5 |
| `src/renderer/src/App.tsx` | agent open/close listeners, `newAgentTab`, restore `agent` (578-606), `TerminalView` prop, Home in empty/selection paths | T5 |
| `src/renderer/src/Sidebar.tsx` | pinned Home row at the top of `.tree` (~710) | T5 |
| `src/renderer/src/SettingsDialog.tsx` (+ css) | `kind: 'path'` field for `homeDir` (Browse / Use Documents), new "MCP" section with the `allowMcpRun` toggle | T5 |
| `src/renderer/src/styles.css` | Home row, agent icon in tab | T5 |
| `src/main/smoke.ts` | 3 new checks; synthetic `AppState` gets `home` | T6 |
| `README.md` | MCP section, Home, settings, smoke note | T7 |

## Tasks for workers
Order:
1. **T1** first: shared types, settings, session and preload. It fixes the contract.
2. **T2, T3, T4 and T5** then run in parallel against the contract below. Their files do not overlap. T3 imports T2's exports by the names given here.
3. **T6** runs after T2 and T4 have landed (and T3 for `store.getState().home`).
4. **T7** can run any time after T1.

Every worker runs both typechecks before handing back:
`fnm exec --using default node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json` and the same with `-p tsconfig.web.json`.

### Contract (fixed; every task codes against this)

**`src/shared/types.ts` (T1)**
```ts
/** Id of the pinned Home location. Never a saved folder/group id (those are UUIDs or `child:` ids). */
export const HOME_ID = 'home'

// Settings additions
/** Directory Home terminals start in. '' = the user's Documents folder (resolved in main at runtime). */
homeDir: string
/** MCP clients may open terminals, run commands, type into and read terminals. Read at every call. */
allowMcpRun: boolean

export interface HomeView {
  id: typeof HOME_ID
  name: 'Home'
  /** Resolved directory: settings.homeDir, or Documents when that is ''. */
  path: string
  /** settings.homeDir is '' (Documents). */
  isDefault: boolean
  missing: boolean
  isGit: boolean
  branch: string | null
}
// AppState addition
home: HomeView

// PersistedTab addition (shell tabs only; never together with elevated)
/** Opened by an MCP agent; restored tabs stay controllable by MCP. */
agent?: boolean

// PtyCreateRequest addition
/** Restored agent tab. Ignored for steps and elevated requests. With locId === HOME_ID, any existing directory is accepted as cwd. */
agent?: boolean

/** main -> renderer: show a tab for an agent pty main already spawned. */
export interface AgentTabRequest {
  reqId: string
  /** pty id == tab id. */
  id: string
  locId: string
  cwd: string
  /** Resolved shell executable (for the tab title / restore). */
  shell: string
}

// TerminalsApi additions
/** Attaches this renderer to a pty main spawned (agent tabs); returns its output so far. Afterwards pty:data flows as usual. */
ptyAttach(id: string): Promise<Result<{ backlog: string }>>
/** Main asks for an agent tab. The callback runs synchronously; its result is sent back as the reply. */
onAgentOpenTab(cb: (req: AgentTabRequest) => Result): () => void
/** Main closed an agent terminal (close_terminal): drop its tab. */
onAgentCloseTab(cb: (id: string) => void): () => void
```

**Settings schema (T1, `src/shared/settings.ts`)**
- `homeDir`: default `''`. The sanitizer returns the trimmed string when it is `''` or matches `/^([a-zA-Z]:[\\/]|\\\\[^\\])/` (an absolute Windows path). Anything else gives `undefined`, so the old value is kept. Existence is not checked here: `HomeView.missing` covers that.
- `allowMcpRun`: default `false`, booleans only.
- No `SCHEMA_VERSION` bump.

**IPC channels**
| Channel | Direction | Payload | Reply |
|---|---|---|---|
| `agent:openTab` | main -> renderer (`webContents.send`) | `AgentTabRequest` | renderer sends `agent:openTab:reply` with `(reqId: string, result: Result)` via `ipcRenderer.send` |
| `agent:closeTab` | main -> renderer | `id: string` | none |
| `pty:attach` | renderer -> main (`invoke`) | `id: string` | `Result<{ backlog: string }>` |
| `pty:create` | unchanged channel | `PtyCreateRequest` (+ `agent`) | unchanged |

- Preload `onAgentOpenTab` wraps the callback in try/catch. A throw is sent back as `{ ok: false, error: String(e) }`.
- Main waits **5000 ms** for the reply. If none arrives, it releases the pty and throws `ToolError('The Terminals window did not answer; it may still be loading. Try again.')`.
- If `win` is null or destroyed, the error is immediate: `'The Terminals window is not available.'`

**`src/main/termText.ts` (T2, pure, no electron import)**
```ts
/** Removes CSI, OSC (BEL- or ST-terminated), DCS/SOS/PM/APC strings, 2-byte ESC sequences and C0 controls except \n \r \t \b. */
export function stripAnsi(s: string): string
/** stripAnsi, then: CRLF/LF split; a lone \r keeps only the text after it (overwrite); \b deletes the previous char;
 *  trailing spaces trimmed per line; trailing empty lines dropped. */
export function toLines(raw: string): string[]
/** Keeps the last `cap` chars of everything pushed. */
export class RingBuffer { constructor(cap: number); push(s: string): void; text(): string; get length(): number }
/** The single line (ending in '\r') typed into PowerShell for one run. See "Sentinel" below. */
export function buildRunInput(command: string, nonce: string): string
/** Finds this run's markers in `buf` (searching from `from`). begin = index just after the begin marker; end = index of the end marker start. */
export function findMarkers(buf: string, nonce: string, from?: number): { begin: number | null; end: { index: number; code: number } | null }
/** PowerShell for agent terminals: `configured` when it is pwsh/powershell, else resolveShell(''). */
export function psShell(configured: string): string
```
`psShell` may live in `pty.ts` if importing `resolveShell` into `termText.ts` is a problem. Either way `termText.ts` must stay electron-free.

**Sentinel (T2; the exact form, PowerShell 5.1 and 7 compatible)**
- The marker uses the FinalTerm shell-integration codes with our own parameter, so the user's own OSC 133 prompt marks never match:
  - begin: `ESC ] 133 ; C ; terminals=<nonce> BEL`
  - end: `ESC ] 133 ; D ; <code> ; terminals=<nonce> BEL`
  - `<nonce>` is 16 hex chars from `randomBytes(8)`.
- Line typed into the pty:
  ```
  . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('<B64 wrapper>'))))\r
  ```
  The typed line holds only base64, never ESC. So neither the echo nor PSReadLine's redraw can contain a marker (the smoke concatenation trick, made structural). Dot-sourcing at the prompt runs in global scope, so `$x = 1` and `cd` persist.
- Wrapper (UTF-8, then base64). `<B64 user>` is the base64 of the UTF-8 user command:
  ```powershell
  $__tr = @{ e = [char]27; b = [char]7; code = 1; err0 = $(if ($Error.Count) { $Error[0] } else { $null }) }
  Write-Host ('[agent] ' + <single-quoted first line of the command, '' escaped, max 200 chars>) -ForegroundColor DarkGray
  [Console]::Write($__tr.e + ']133;C;terminals=<nonce>' + $__tr.b)
  $global:LASTEXITCODE = 0
  try {
    . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('<B64 user>'))))
    if ($global:LASTEXITCODE) { $__tr.code = $global:LASTEXITCODE }
    elseif ($Error.Count -and -not [object]::ReferenceEquals($Error[0], $__tr.err0)) { $__tr.code = 1 }
    else { $__tr.code = 0 }
  } catch { $__tr.code = 1; $_ | Out-Host }
  finally {
    [Console]::Write($__tr.e + ']133;D;' + $__tr.code + ';terminals=<nonce>' + $__tr.b)
    Remove-Variable __tr -Scope Global -ErrorAction SilentlyContinue
  }
  ```
- Exit-code rule:
  - 0 on success.
  - The last native exit code when it is non-zero.
  - 1 when a terminating error was caught, or when new error records appeared.
  - 1 on Ctrl+C, because `code` starts at 1 and `finally` still runs.
  - A user `ScriptBlock` parse error throws inside the `try` and gives 1 with the error text as output.
- **Spike first (T2, before building the state machine).** In a throwaway script run under `electron .` or plain node, spawn pwsh through `spawnShell` and `[Console]::Write` an OSC 133 marker. Confirm it arrives intact in `onData`, since ConPTY re-renders output and may drop unknown OSC.
  - If OSC 133 is dropped, try `ESC ] 9 ; 9 ;` with a quoted fake path containing the nonce. The app already relies on 9;9 passing through.
  - If both are dropped, fall back to a **visible** dim footer line, `[agent-run <nonce8> exit <code>]`, printed with `Write-Host` and matched as plain text after `stripAnsi`. The begin marker becomes a visible line too, and the parser skips both lines.
  - Report the result as a deviation. The contract (`findMarkers`) stays the same.

**`src/main/terminalHost.ts` (T2, no electron import)**
```ts
import type { IPty } from '@lydell/node-pty'
export interface TermMeta {
  locId: string
  cwd: string
  shell: string
  kind: 'shell' | 'command'
  agent: boolean
  elevated: boolean
  /** webContents id that owns it (null in smoke). */
  ownerWc: number | null
}
export interface TermInfo {
  id: string
  locationId: string
  /** Last cwd reported by OSC 9;9 or OSC 7 in the output, else startCwd. */
  cwd: string
  startCwd: string
  shell: string
  kind: 'shell' | 'command'
  alive: boolean
  exitCode: number | null
  agent: boolean
  elevated: boolean
  busy: boolean
}
export interface RunResult {
  id: string
  exitCode: number | null
  success: boolean | null
  output: string
  truncated: boolean
  timedOut: boolean
  exited: boolean
  durationMs: number
}
export interface ReadResult { id: string; alive: boolean; lines: string[]; truncated: boolean }
/** What the MCP tools use. All methods throw ToolError (from mcpTools; type-only import cycle is fine) with a user-readable message. */
export interface TerminalControl {
  list(): TermInfo[]
  open(target: { locId: string; cwd: string }): Promise<TermInfo>
  run(id: string, command: string, timeoutMs: number): Promise<RunResult>
  send(id: string, text: string): void
  read(id: string, lines: number): ReadResult
  close(id: string): Promise<void>
}
export interface HostDeps {
  /** Spawns a non-elevated `shell` pty with ptyEnv(locId), registers it in index.ts's ptys/owners (owner = the window)
   *  and wires onData -> host.data / onExit -> host.exit. Must NOT call host.add. Throws on failure. */
  spawn(id: string, shell: string, locId: string, cwd: string, cols: number, rows: number): IPty
  /** Round trip to the renderer (see IPC). Resolves { ok:false } on renderer refusal; rejects/throws ToolError on timeout/no window. */
  openTab(req: Omit<AgentTabRequest, 'reqId'>): Promise<Result>
  closeTab(id: string): void
  /** index.ts releasePty (kills; calls host.remove). */
  release(id: string): void
  /** Configured shell (store.getShell()); the host applies psShell(). */
  configuredShell(): string
}
export class TerminalHost implements TerminalControl {
  constructor(deps: HostDeps)
  add(id: string, pty: IPty, meta: TermMeta): void
  data(id: string, chunk: string): void
  exit(id: string, code: number): void
  /** Forget the record (tab closed / pty released). A pending run resolves with exited: true. */
  remove(id: string): void
  /** Exited records owned by a renderer that is gone or closed the tab. */
  forgetOwner(wcId: number): void
  backlog(id: string): string
}
```
Host behaviour:
- **Ring:** 512 Ki chars per terminal. `data` also scans for `ESC]9;9;"path"` and `ESC]7;file://...` to update `cwd`.
- **`open`:**
  1. `id = randomUUID()`.
  2. `deps.spawn(id, psShell(...), locId, cwd, 120, 30)`, then `add(..., { agent: true, elevated: false, kind: 'shell', ownerWc })`.
  3. `await deps.openTab(...)`. If it fails, `deps.release(id)` and throw.
  4. Wait for readiness: first output and then 500 ms of silence, capped at 10 s. Return its `TermInfo`.
- **`run`:**
  1. Refuse when the terminal is unknown, not agent, not alive, elevated, not a shell kind, not PowerShell, or busy. Also refuse an empty command or one over 8000 chars.
  2. Write `buildRunInput`, then capture the following output in its own buffer (cap 2 Mi chars raw).
  3. Parse markers on every chunk. Search from `lastScan - 64` so a marker split across chunks is found.
  4. Output = `toLines(raw between begin and end).join('\n')`, keeping the last 100 KB (`truncated` when cut).
  5. **Timeout** resolves `timedOut: true` with the partial output and leaves the terminal **busy** until the end marker arrives, the terminal exits, or it is closed. The busy error text says to use `read_terminal`, or `send_input` with `"\u0003"` to interrupt.
  6. **Exit** resolves `exited: true` with the process exit code.
- **`send`:** agent, alive and not elevated only; max 8000 chars; written raw.
- **`read`:** `toLines(ring.text())`, last `lines` lines (1..2000).
- **`close`:** agent only. `deps.release(id)`, then `deps.closeTab(id)`, then `remove(id)`.
- **`list`:** every record (user and agent), in insertion order.

**`src/main/mcpTools.ts` (T4)**
```ts
export type LocKind = 'folder' | 'child' | 'parent' | 'manual' | 'home'
export interface ToolContext {
  headerLocation?: string
  dataDir: string
  /** Null when the server runs without a terminal host (logic tests). */
  terminals: TerminalControl | null
  /** settings.allowMcpRun, read per call. */
  allowRun: () => boolean
}
export const RUN_DISABLED_ERROR =
  'Terminal control is off. Ask the user to turn on Settings > MCP > "Allow MCP to run commands" in the Terminals app.'
// ToolDef: run returns unknown | Promise<unknown>; new optional `readOnly?: boolean` (annotation readOnlyHint = readOnly ?? !mutates)
/** location ref -> where open_terminal starts. undefined/'' -> Home. Saved location -> its path (manual group: error).
 *  Unsaved existing absolute dir -> Home with that cwd. Non-existent/non-dir absolute path -> ToolError. Home missing -> ToolError. */
export function resolveOpenTarget(state: AppState, ref: string | undefined): { loc: McpLoc; cwd: string }
```
- `buildLocations` appends Home **last**: `{ id: 'home', name: 'Home', path: state.home.path, kind: 'home', groupId: null, missing }`. A saved folder at the same path therefore wins.
- `KIND_LABEL.home = 'Home location'`.
- Existing tools that filter on kinds (`['folder']`, `['manual']` and so on) reject Home automatically.
- `list_locations` adds `home: { id, name, path, missing }`.

Tool shapes (zod). All six tools have `mutates: false`. `readOnly` is false except for list and read. `close_terminal` is `destructive: true`.
| Tool | Input | Output | Gate |
|---|---|---|---|
| `open_terminal` | `{ location?: string }`: "Location id, name or absolute path. A saved location opens there; any other existing directory opens under Home with that cwd. Default: Home." | `{ id, location: { id, name, kind }, cwd, shell, agent: true }` | toggle |
| `run_command` | `{ id: string, command: string, timeoutSeconds?: number (int 1..600, default 60) }` | `RunResult` | toggle, agent-only |
| `send_input` | `{ id: string, text: string, enter?: boolean }` (`enter` appends `\r`; Ctrl+C is `"\u0003"`) | `{ id, sent: number }` | toggle, agent-only |
| `read_terminal` | `{ id: string, lines?: number (int 1..2000, default 100) }` | `ReadResult` | toggle |
| `list_terminals` | `{}` | `{ allowRun: boolean, terminals: (TermInfo & { locationName: string \| null })[] }` | none |
| `close_terminal` | `{ id: string }` | `{ closed: id }` | toggle, agent-only |

Gate check order in every gated tool:
1. `if (!ctx.allowRun()) throw new ToolError(RUN_DISABLED_ERROR)`
2. `if (!ctx.terminals) throw new ToolError('Terminal control is not available in this process.')`

**`src/main/mcp.ts` (T4)**
- `startMcpServer(opts: { dataDir; version; onChange; terminals: TerminalControl | null; allowRun: () => boolean })`.
- `buildServer` awaits `t.run`.
- New `INSTRUCTIONS`:
  > Manages the Terminals app: saved folders, groups, saved commands and prompts, and (when the user has turned on "Allow MCP to run commands") its terminals. open_terminal opens a visible PowerShell tab (default: the Home location) and returns its id; run_command runs a command in that live shell and returns its output and exit code; send_input types raw text; read_terminal returns recent output; close_terminal closes it. Only terminals opened through MCP can be typed into or closed. "This folder" is the terminal's location from get_context.

### T1 Shared contract (`types.ts`, `settings.ts`, `session.ts`, `preload/index.ts`)
- Inputs: the contract above.
- Outputs: the types and schema entries exactly as above.
  - `sanitizeTab`: for a shell, `if (r.agent === true && r.elevated !== true) t.agent = true`.
  - `SessionTab.agent?: boolean`, copied in `toPersistedTabs`.
  - Preload: `ptyAttach: (id) => inv('pty:attach', id)`. `onAgentOpenTab` and `onAgentCloseTab` use `ipcRenderer.on`/`removeListener`. The open listener replies with `ipcRenderer.send('agent:openTab:reply', req.reqId, result)`.
- Check `src/preload/index.d.ts` still compiles (it re-exports the type).
- Placeholder: add `home` to `AppState` in the type only. T3 fills it in `getState`; until then the node typecheck fails in `store.ts`, which is expected and resolved by T3.

### T2 Terminal host and text helpers (`termText.ts`, `terminalHost.ts`, new files)
- Inputs: the contract above, plus `pty.ts` (`spawnShell`, `resolveShell`).
- Do the sentinel spike first, then the helpers, then the host.
- Outputs: the exports listed in the contract.
- No electron imports in either file: smoke instantiates `TerminalHost` with its own `HostDeps`.
- Resolve pending promises outside pty callbacks (`setTimeout(..., 0)`), as `smoke.ts:37-38` does (teardown inside the callback can deadlock).

### T3 Main wiring (`index.ts`, `store.ts`)
- `store.ts`:
  - `export function getHomeDir(): string`: `data.settings.homeDir || app.getPath('documents')`.
  - `getState().home`: `HomeView` with `missing = !existsSync(path)` and git from `readGit` when it is not missing.
  - `getRoots()` appends `getHomeDir()`.
  - When the selection is removed and nothing else is left, fall back to `HOME_ID` instead of `null` (398-401, 443).
  - `select(HOME_ID)` already works.
- `index.ts`:
  - `const host = new TerminalHost(deps)`. Implement `deps.spawn` with `spawnShell(shell, cwd, cols, rows, handlers, ptyEnv(locId))`.
    - Register it in `ptys` and in `owners` under `win.webContents.id`.
    - `onData`: `host.data(id, d)`, then, if `attached.has(id)`, send `pty:data` to `win.webContents`.
    - `onExit`: the same stale-exit guard as `pty:create`, then `host.exit(id, code)` and `pty:exit` to the window when attached.
  - `pty:create`:
    - After a successful spawn, `host.add(req.id, p, { locId, cwd, shell: shellExe or the steps shell, kind: steps ? 'command' : 'shell', agent: req.agent === true && !wantElevated && !steps, elevated: wantElevated, ownerWc: e.sender.id })`.
    - The handlers call `host.data` and `host.exit` before forwarding.
    - `cwdError` also accepts an existing directory when `req.locId === HOME_ID && req.agent === true`.
  - `pty:attach`: allowed only when `id` is an agent pty spawned by the host and owned by `e.sender.id`. It adds `id` to `attached` and returns `{ ok: true, backlog: host.backlog(id) }`, synchronously.
  - `releasePty` calls `host.remove(id)` and deletes from `attached`.
  - `pty:kill` for a non-owned id calls `host.forgetOwner`-style removal of that exited record when its `ownerWc === e.sender.id`. Exited terminals are disowned in `onExit`, so the tab's close would otherwise leave a stale record.
  - `killPtysOf(wcId)` also calls `host.forgetOwner(wcId)`; `killAllPtys` clears the host.
  - Open-tab bridge: `pendingTabs: Map<reqId, resolve>`, `ipcMain.on('agent:openTab:reply', ...)`, a 5 s timer, and the errors from the IPC table. `closeTab(id)` sends `agent:closeTab`.
  - `startMcpServer({ ..., terminals: host, allowRun: () => store.getSettings().allowMcpRun })`.
  - The window is never shown or focused by these paths.
- Outputs: none beyond the contract. Typecheck green after T2 and T4 merge.

### T4 MCP (`mcp.ts`, `mcpTools.ts`)
- Inputs: the contract above, and `TerminalControl` and the types from T2 (type-only import).
- Outputs: the six tools, `resolveOpenTarget`, `RUN_DISABLED_ERROR`, Home in `buildLocations`/`list_locations`, async `run`, the `readOnly` annotation, the new `INSTRUCTIONS`.
- `list_terminals` maps `locationName` through `locationById`.
- `open_terminal` resolves with `resolveOpenTarget(store.getState(), a.location)`, then calls `ctx.terminals.open({ locId: loc.id, cwd })`.
- Keep the existing tools unchanged apart from the `ToolContext` type.

### T5 Renderer (`App.tsx`, `TerminalView.tsx`, `termRegistry.ts`, `TabBar.tsx`, `Sidebar.tsx`, `locations.ts`, `SettingsDialog.tsx`, css)
- `locations.ts`: `Loc.kind` adds `'home'`. `buildLocs` adds `state.home` as `{ id: HOME_ID, name: 'Home', path, missing, kind: 'home', groupId: null, branch }`. Grep every `kind ===` / `.kind` use of `Loc` and treat `'home'` like `'folder'`. Home has no group.
- `termRegistry.ts`: `createTerm(id, { attach?: boolean })` stores `entry.attach = true`.
- `TerminalView.tsx`:
  - When `entry.attach`, call `window.api.ptyAttach(id)` instead of `ptyCreate`. On `ok`, `term.write(backlog)`, `markReady()`, then `ptyResize(id, term.cols, term.rows)`. Otherwise write the red error and dispatch `terminal-failed`.
  - New prop `agent?: boolean`, passed as `agent: true` in `ptyCreate` (restored agent tabs).
- `TabBar.tsx`: `Tab.agent?: boolean`. Render the lucide `Bot` icon (size 12) before the title, with `title="Opened by an agent (MCP)"`.
- `App.tsx`:
  - `newAgentTab(req: AgentTabRequest): Result`:
    1. The location must exist in `buildLocs(stateRef.current)`, else return `{ ok: false, error: 'Unknown location' }`.
    2. `createTerm(req.id, { attach: true })`.
    3. Title `Agent ${n}`, using `counters` per location.
    4. Append `{ kind: 'shell', agent: true, shell: req.shell, cwd, startCwd: cwd, exited: false }`.
    5. Call `showTab` **only** when some pane shows `req.locId` and has no active tab.
    6. `scheduleSave()`, then return `{ ok: true }`.
  - Register `window.api.onAgentOpenTab(newAgentTab)` and `onAgentCloseTab((id) => closeTab(id))` in an effect.
  - Session restore copies `t.agent` into the tab and passes `agent` to `TerminalView`.
- `Sidebar.tsx`: a pinned Home row above everything in `.tree`, above the "No folders yet" empty state.
  - It reuses `Row`, with the `House` icon, the name "Home", the path as subtitle, selection, `counts[HOME_ID]`, the missing style, and a "New terminal" button.
  - Context menu: Open terminal, Open in Explorer, Copy path. No rename, remove, drag or keyboard reorder.
- `SettingsDialog.tsx`:
  - Add a `kind: 'path'` FieldDef for `homeDir`, labelled "Home folder". It is a text input with the shared debounce, a "Browse…" button (`window.api.pickFolder()`) and "Use Documents" (sets `''`).
  - The placeholder shows the resolved path from a new prop `homePath` (`state.home.path`). Hint: "Where Home terminals start. Empty = your Documents folder."
  - New section "MCP" with a `toggle` for `allowMcpRun`, labelled "Allow MCP to run commands". Hint: "Lets MCP clients with this app's token open terminals, run commands, type into and read them. Off by default."
  - The Reset button must not touch `homeDir` or `allowMcpRun`.
- Outputs: the web typecheck is green.

### T6 Smoke (`src/main/smoke.ts`)
Follow `test-discipline`: three checks, added to `runSmoke`.
1. **`checkTermText()`** (pure):
   - `toLines` on a fixed sample with colour CSI, an OSC title, a lone `\r` overwrite and a trailing prompt gives the exact expected lines.
   - `findMarkers` finds begin and end (code 3) when the end marker is split across two pushes.
   - `findMarkers` finds nothing in the echoed `buildRunInput(...)` text itself.
2. **`checkRunCommand(dir, shell)`** (real pwsh through `TerminalHost` with smoke `HostDeps`: spawn = `spawnShell` + `host.data`/`host.exit`, `openTab` resolves `{ ok: true }`, release kills):
   - `open` returns an id.
   - `run("Write-Output ('a'+'1'); cmd /c exit 3")` gives output exactly `a1` and `exitCode` 3.
   - `run('$x = 41 + 1')` then `run('$x')` gives `42` (state persists).
   - A second `run` while `Start-Sleep 3` is running is rejected as busy.
   - `run('Start-Sleep 5', 1000)` gives `timedOut: true`.
   - `close`.
3. **`checkMcpHttp(dir)`**: `startMcpServer({ dataDir: <tmp>, terminals: host, allowRun: () => flag })`. Send raw `fetch` POSTs to `/mcp` with the bearer token, `Accept: application/json, text/event-stream`, and JSON-RPC `tools/call`.
   - With `flag = false`: `run_command` returns `isError` with `RUN_DISABLED_ERROR`, and `list_terminals` works with `allowRun: false`.
   - With `flag = true`: `open_terminal` (location = the tmp dir, unsaved, so it opens under Home), then `run_command` `Write-Output ('h'+'i')` gives `hi` and exit code 0, then `close_terminal`.
   - If the SDK needs an `initialize` first, send it in the same way.
   - Close the http server afterwards (`startMcpServer` may need to return a `close()`; if so add `close` to `McpInfo` as an optional field).
- Also add `home` to the synthetic `AppState` in `checkMcpLogic`, and extend it by one assertion: `resolveOpenTarget(state, undefined).loc.id === 'home'`, and a non-existent path throws.
- Run with `fnm exec --using default cmd /c "yarn smoke"`. If yarn cannot be spawned, use `fnm exec --using default node node_modules/electron-vite/bin/electron-vite.js build` followed by `fnm exec --using default node_modules/.bin/electron . --smoke`. Report all PASS lines.

### T7 README
- **MCP section:** replace "There is deliberately no tool that runs a command…" with the toggle and its default, the agent-only write rule and the never-elevated rule. Add the 6 tools to the table.
  - Add a short "Terminal control" subsection: Home default, arbitrary dirs, run semantics (live shell, exit-code rule, timeout leaves the shell busy, one run at a time, output from ANSI-stripped stream, full-screen programs read poorly, the run line appears in the terminal and in PSReadLine history).
  - Security: the toggle is the barrier, and `read_terminal` is gated.
- Remove "The server is not started in `--smoke` mode" (smoke starts its own instance), or reword it.
- **Sidebar:** Home entry.
- **Data / settings:** add `homeDir` and `allowMcpRun`, and replace "There is no settings UI" with a pointer to Settings (Ctrl+,).

## Acceptance criteria
| # | Criterion | Proof |
|---|---|---|
| 1 | Both typechecks pass | `tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json` exit 0 |
| 2 | `run_command` in a live pwsh returns the cleaned output (no echo, no prompt) and the exit code | smoke `checkRunCommand` (`a1`, 3) |
| 3 | Shell state persists between runs | smoke `checkRunCommand` (`$x` -> 42) |
| 4 | One run at a time; timeout returns partial output with `timedOut` and does not kill the shell | smoke `checkRunCommand` (busy, timedOut; the terminal is still alive in `list()`) |
| 5 | ANSI and OSC stripping, a marker split across chunks, and an echo that never matches | smoke `checkTermText` |
| 6 | Toggle off: gated tools refuse with the clear message, `list_terminals` works | smoke `checkMcpHttp` |
| 7 | Over HTTP with the toggle on: an unsaved dir opens under Home, run, close | smoke `checkMcpHttp` |
| 8 | Home is the default, and a non-existent path is an error | smoke `checkMcpLogic` addition |
| 9 | All existing smoke checks still pass | `yarn smoke` all PASS |
| 10 | Home row is pinned at the top, selectable, opens a terminal in Documents; changing the Home folder in Settings (Browse) moves new Home terminals there; "Use Documents" resets it | Manual, real app with `--data-dir` (README "Isolated data directory") |
| 11 | Settings shows "Allow MCP to run commands", off on a fresh data dir; turning it on takes effect on the next tool call without restart | Manual: from Claude Code in an app terminal, call `run_command` (error), toggle on, call again (works) |
| 12 | `open_terminal` from Claude Code makes a visible tab under Home with the Bot icon, does not steal focus or switch selection, and the user can type in it; `run_command` output appears in the tab live, with the `[agent]` line | Manual |
| 13 | With the window hidden in the tray, `open_terminal` and `run_command` work; the tab is there when the window is reopened, with the full output (backlog replay) | Manual |
| 14 | `send_input` with `"\u0003"` interrupts a long run, and the pending run ends (no longer busy) | Manual (Claude Code: `run_command` `Start-Sleep 60` with timeout 2, then `send_input`, then `list_terminals` busy=false) |
| 15 | `run_command`, `send_input` and `close_terminal` on a user-opened tab or an admin tab are refused; `read_terminal` on a user tab works | Manual |
| 16 | Restart the app: the agent tab is restored with the Bot icon and is controllable again (new id in `list_terminals`, `agent: true`) | Manual |
| 17 | The README MCP section and the `INSTRUCTIONS` string describe the new tools and the toggle | Review the diff |

## Implementation status (implement, 2026-11-21)
Commit `a1e8d97` on `feat/agent-terminal-control`.
- [x] T1 shared contract - done
- [x] T2 termText + terminalHost - done; sentinel spike: OSC 133 primary form arrives intact through ConPTY under pwsh 7 and Windows PowerShell 5.1 (no fallback)
- [x] T3 main wiring - done
- [x] T4 MCP tools - done
- [x] T5 renderer - done (not run in the real app)
- [x] T6 smoke - done; 16/16 PASS
- [x] T7 README - done
Deviations: `ToolError` moved to `src/main/toolError.ts` (re-exported from mcpTools) so terminalHost stays electron-free; `HostDeps.ownerWc?()` added; `hosted` map / `attached` set in index.ts; `findMarkers` also accepts ST terminator and negative codes; Home settings field in its own "Home" section; smoke run via `electron.exe . --smoke` because `yarn smoke` under fnm/cmd printed nothing.
Acceptance 1-9, 17: verified. 10-16: UNTESTED (manual, real app).
