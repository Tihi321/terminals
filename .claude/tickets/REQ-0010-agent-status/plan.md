---
status: done
request: REQ-0010
repos: [C:/projects/Personal/terminals]
branch: feat/herdr-agent-workflow
updated: 2026-11-26
---

# REQ-0010 Agent status per tab, status reporting, heuristics, auto tab titles

Background: `.claude/tickets/REQ-0009-herdr-feature-research/research.md` sections 2b, 3 and 4 (re-rank items 1, 3 and 7).

Reading: the full one. Live status on every terminal tab, from agent reports (MCP tool and Claude Code hooks) with a heuristic fallback, rolled up in the sidebar, plus auto tab titles. Live in the running app, not just in `list_terminals`.

## Scope

1. **Agent status per terminal tab**: `working`, `done` (finished and not yet seen), `needs-you` (blocked on input or a permission prompt), `idle`. A tab gets a status only once it is known to run an agent, either because a report arrived or the heuristic recognised one. Plain shells show nothing, as now.
   - TabBar: an indicator before the title. Working is a pulsing dot, done a blue dot, needs-you an orange `!` pill. Idle shows nothing. The tooltip names the state and where it came from (report or heuristic).
   - Sidebar: each folder/child/group row gets an agent indicator with the same priority roll-up as the existing `fin-dot` (needs-you > done > working). The tooltip lists the tabs.
   - Activity sidebar (`ui.groupBy === 'activity'`, it exists): a **Needs you (N)** section above **Working**. It holds the top-level entries whose subtree has a needs-you tab. Those entries are left out of Working and Idle.
   - Collapsed sidebar strip (`.active-rail` in App.tsx): `rail-dot` takes the roll-up status class, and locations with a needs-you or done tab are listed even if no shell is "working".
   - "Done" becomes "idle" when the user views the tab, meaning it is the active tab of some pane while the window has focus.
2. **Status reporting from agents**:
   - (a) New MCP tool `report_status { state, terminal? }`. The terminal comes from the new per-pty env var `TERMINALS_TERM_ID`, sent as the `X-Terminals-Term` header through the updated `claude mcp add-json` registration, or passed explicitly.
   - (b) Claude Code hooks (SessionStart, UserPromptSubmit, PostToolUse, PermissionRequest, Notification, Stop, SessionEnd) that POST the hook's own stdin JSON to a new plain HTTP endpoint `POST /status` on the existing MCP server.
     - Each hook is in exec form: `cmd.exe /d /c <userData>\status-hook.cmd`. The app writes that script itself.
     - Settings has "Install hooks", "Remove hooks" and "Copy hooks JSON" buttons. `~/.claude/settings.json` is only written on a button click.
3. **Heuristic fallback** in main, for tabs with no reports. Known agent text marks the tab as an agent. Output after that means working, quiet after working means done, and a known permission prompt means needs-you. The rules sit in one small table and are documented in the README. A setting turns the heuristic off.
4. **Auto tab titles** from the terminal's own title (xterm `onTitleChange`, OSC 0/2), for shell tabs, cleaned up. Tab rename (double-click, context menu) is new, since the app has no tab rename yet. A user-renamed tab (`userTitle: true`) is never overwritten. Both are persisted in the session.

### Key decisions

- **Hooks report over HTTP, not OSC.** Claude Code captures a hook's stdout. It never reaches the pty, so an OSC printed by a hook is lost. Worse, stdout of UserPromptSubmit and SessionStart hooks is added to the model's context. Writing to `CONOUT$` from a hook subprocess is fragile under ConPTY. HTTP also reuses what is already there: the 127.0.0.1-only server, the bearer token and the env vars injected into every pty. The `/status` endpoint takes the raw hook JSON (`--data-binary @-`), so one identical command serves every event, and the event-to-state mapping lives in our code (`statusFromHookEvent`), not in the user's settings. The endpoint always answers with an empty body, so nothing leaks into Claude's context.
- **The hook command is a script run in exec form.** On Windows, Claude Code runs shell-form hook commands under Git Bash, or under PowerShell when Git Bash is missing, so no single shell command works everywhere. Exec form (`{"type":"command","command":"cmd.exe","args":[...]}`) involves no shell parsing. Hooks inherit Claude's environment, and so the pty env vars.
  - The script `status-hook.cmd` lives in the app's userData folder. It is written on Install, and rewritten at app start when the hooks are installed.
  - It POSTs stdin with `curl.exe`, which is built into Windows 10+, prints nothing, and always `exit /b 0`.
- **The state machine lives in main (`TerminalHost`), not the renderer.** Main sees all pty output even while the window is hidden in the tray. It already parses OSC for the cwd, receives the reports, and serves `list_terminals`. The renderer only renders the status and reports "seen".
- **The Activity "Working" grouping (`isWorkingTab` in App.tsx) stays as it is**: an open shell counts as working (commit 10ae50f, which avoids flicker). Agent status is a separate per-tab field shown next to it and does not change that grouping. The only grouping change is the new Needs-you section on top. This builds on the existing roll-up pattern (`finished` / `mergeFinished`) instead of adding a second notion of "working".
- **Reports win.** Once a tab has received any report, the heuristic is off for that tab until a SessionEnd report or the pty exits.
- **Typing while the tab is needs-you sets it to idle, for either source.** If the user approves, PostToolUse (or more output) moves it on. If the user rejects with Esc, no Stop hook fires, and the tab would otherwise stay stuck at needs-you.

## Out of scope (explicit)

- Desktop notifications, taskbar flash, sounds (research item 6, a follow-up).
- An OSC status protocol for arbitrary scripts (herdr's OSC 7501). Scripts use `report_status` or `POST /status`.
- Rules for agents other than Claude Code, beyond the generic "esc to interrupt" marker. The rule table is extendable data, but only Claude Code rules ship.
- Rendered-screen (xterm buffer) matching. The heuristic reads the ANSI-stripped stream in main.
- Persisting agent status across restarts. Status is runtime-only, while titles are persisted.
- Agent session resume, `agent_start` / `agent_wait`, and status events over MCP (SSE).
- Ctrl+K switcher, Ctrl+1..9, Ctrl+F (REQ-0012) and worktrees (REQ-0011).
- Auto titles from the first prompt. The title comes only from OSC 0/2.
- Editing `~/.claude/settings.json` without a button click, and editing project-level `.claude/settings.json`.

## Contract for later plans (REQ-0011, REQ-0012)

Defined in **`src/shared/agentStatus.ts`** (new). Later plans import from there and do not redefine any of it:

```ts
export type AgentStatus = 'working' | 'done' | 'needs-you' | 'idle'
export const AGENT_STATUSES: readonly AgentStatus[]            // ['needs-you','done','working','idle'] (priority order)
export const STATUS_PRIORITY: Record<AgentStatus, number>      // needs-you 3, done 2, working 1, idle 0
export const STATUS_LABEL: Record<AgentStatus, string>         // 'Working', 'Done', 'Needs you', 'Idle'
export type StatusSource = 'report' | 'heuristic'
export interface TermStatus { status: AgentStatus; source: StatusSource; since: number /* epoch ms */; agent: string | null /* 'claude' | null */ }
export interface StatusRollup { top: AgentStatus | null; needsYou: number; done: number; working: number; items: string[] /* "<tab title>: <label>" */ }
export function rollupStatus(a: StatusRollup | undefined, b: StatusRollup | undefined): StatusRollup | undefined
export function rollupOf(entries: { status: AgentStatus; title: string }[]): StatusRollup | undefined
export type HookOutcome = { kind: 'set'; status: AgentStatus } | { kind: 'clear' } | { kind: 'ignore' }
export function statusFromHookEvent(payload: unknown): HookOutcome
export function parseReportedStatus(v: unknown): AgentStatus | null   // validates report_status / ?state=
```

Renderer, App.tsx (REQ-0012's switcher reads these, nothing else):
- `tabStatus: Record<string /* tab id */, AgentStatus>` is a `useMemo`. It holds only tabs that have a status, and an entry exists only when the status is not idle.
- `agentByLoc: Record<string /* locId */, StatusRollup>` is a `useMemo`, the per-location roll-up before group roll-up.
- Status filter order for UI chips: `AGENT_STATUSES`.

IPC (main <-> renderer): `term:status` (main -> renderer event, `(id: string, s: TermStatus | null)`), `term:statuses` (invoke, returns `Record<string, TermStatus>`), `term:seen` (renderer -> main send, `(id: string)`). Preload names: `onTermStatus`, `getTermStatuses`, `termSeen`.

Per-pty env (README table): `TERMINALS_TERM_ID` (the pty/tab id), `TERMINALS_STATUS_URL` (`http://127.0.0.1:<port>/status`).

Files REQ-0011 will also touch: `Sidebar.tsx` (this plan adds the `agent` prop, the row indicator and the Needs-you section) and `styles.css`. REQ-0012 touches `App.tsx` keyboard handling and `TerminalView.tsx`, and this plan does not touch `TerminalView.tsx`.

## Files and modules to touch

| File | Change |
| --- | --- |
| `src/shared/agentStatus.ts` (new) | The contract above. Pure, no DOM, no node. |
| `src/shared/claudeHooks.ts` (new) | `HOOK_SCRIPT_NAME`, `HOOK_MARKER`, `HOOK_EVENTS`, `hookScript()`, `hookEntry()`, `claudeHooksConfig(scriptPath)`, `mergeClaudeHooks(settings, mode, scriptPath)`, `hooksInstalled(settings)`. Pure. |
| `src/shared/termTitle.ts` (new) | `cleanTermTitle(raw: string): string \| null` |
| `src/shared/types.ts` | `Settings.agentHeuristics: boolean`; `PersistedTab.userTitle?: boolean`; `TerminalsApi` additions (below) |
| `src/shared/settings.ts` | `agentHeuristics` schema entry, default `true` |
| `src/shared/session.ts` | `userTitle` in `sanitizeTabs`, `SessionTab`, `toPersistedTabs` |
| `src/main/agentStatus.ts` (new) | `AgentStatusTracker` class and the `AGENT_RULES` table |
| `src/main/terminalHost.ts` | Tracker per `Rec`, `input` / `resized` / `report` / `seen` / `statuses`, tick timer, `TermInfo.status`, `HostDeps.onStatus` / `heuristics` |
| `src/main/mcp.ts` | `POST /status` route, `X-Terminals-Term` header -> `ToolContext.headerTerm`, `McpInfo.statusUrl` |
| `src/main/mcpTools.ts` | `report_status` tool, `ToolContext.headerTerm`, `INSTRUCTIONS` mention in mcp.ts |
| `src/main/claudeHooks.ts` (new) | Writes `<userData>\status-hook.cmd`; reads and writes `~/.claude/settings.json` (or `%CLAUDE_CONFIG_DIR%\settings.json`), with a backup |
| `src/main/index.ts` | `ptyEnv(locId, id)`; `pty:write` -> `host.input`; `pty:resize` -> `host.resized`; `term:*` and `hooks:*` IPC; `onStatus` -> `wc.send('term:status')` |
| `src/preload/index.ts` | `onTermStatus`, `getTermStatuses`, `termSeen`, `getClaudeHooks`, `installClaudeHooks`, `removeClaudeHooks`, `claudeHooksJson` |
| `src/renderer/src/termRegistry.ts` | `TermHooks.onTitle`; `term.onTitleChange` in `createTerm` |
| `src/renderer/src/App.tsx` | Status state and subscription, seen logic, `tabStatus` / `agentByLoc`, rail, title and rename handlers |
| `src/renderer/src/TabBar.tsx` | `Tab.userTitle` / `autoTitle`, `status` prop, indicator, inline rename, tab context menu |
| `src/renderer/src/Sidebar.tsx` | `agent` prop, `Row.agent`, group roll-up, Needs-you section |
| `src/renderer/src/SettingsDialog.tsx` | "Agent status" section: heuristics toggle and Claude Code hooks row |
| `src/renderer/src/styles.css` | `.agent-ind`, `.agent-dot`, `.needs-you-pill`, `.activity-section.needs-you`, `.rail-dot.<status>` |
| `src/main/smoke.ts` | `checkAgentStatus` (pure), extend `checkMcpHttp`, extend `checkSession` |
| `README.md` | See the README task |

## Tasks for workers

Order: T1, then T2, then T3. After T3, T4+T5 (one worker, since both touch App.tsx and TabBar.tsx) and T6 can run in parallel. T7 comes after T2/T3 (it can start with T4), and T8 comes last.

### T1. Shared contract and pure helpers

- **Inputs**: this plan (contract section), `src/shared/types.ts`, `src/shared/settings.ts`, `src/shared/session.ts`.
- **Outputs**:
  - `src/shared/agentStatus.ts`, exactly the contract above.
    - `rollupOf` returns `undefined` when there are no non-idle entries.
    - `top` is the highest-priority status present.
    - `statusFromHookEvent` reads `hook_event_name` and `notification_type` from the payload:

      | Event | Outcome |
      | --- | --- |
      | `SessionStart` | set `idle` (marks the tab as reported) |
      | `UserPromptSubmit` | set `working` |
      | `PostToolUse` | set `working` |
      | `PermissionRequest` | set `needs-you` |
      | `Notification` with `notification_type === 'permission_prompt'` | set `needs-you` |
      | Other `Notification` (e.g. `idle_prompt`) | ignore |
      | `Stop` | set `done` |
      | `SessionEnd` | clear |
      | Anything else or non-object | ignore |

    - `parseReportedStatus` accepts exactly the four strings.
  - `src/shared/termTitle.ts`: `cleanTermTitle(raw)`.
    - Strips C0/C1 control characters.
    - Strips a leading run of spinner/status glyphs (`/^[\u2800-\u28FF\u2730-\u273F\u00B7*•◐◓◑◒\s]+/`, so Claude Code's "✳ " and its braille spinner frames do not make the title flicker).
    - Trims and caps the length at 60 with "…".
    - Returns `null` for an empty result and for titles that are an executable path or name (`/\.exe$/i`, `/^[a-z]:\\/i`), or `Windows PowerShell`, `Administrator: …`, `pwsh`, `powershell`, `cmd`. ConPTY sets the title to the shell's path at start; that must not replace "pwsh 1".
  - `src/shared/claudeHooks.ts`:
    - `HOOK_SCRIPT_NAME = 'status-hook.cmd'` and `HOOK_MARKER = HOOK_SCRIPT_NAME`.
    - `HOOK_EVENTS = ['SessionStart','UserPromptSubmit','PostToolUse','PermissionRequest','Notification','Stop','SessionEnd']`.
    - `hookScript(): string` returns the CRLF script:
      ```
      @echo off
      if not defined TERMINALS_STATUS_URL exit /b 0
      if not defined TERMINALS_TERM_ID exit /b 0
      curl.exe -s -m 2 -o NUL -X POST "%TERMINALS_STATUS_URL%" -H "Authorization: Bearer %TERMINALS_MCP_TOKEN%" -H "X-Terminals-Term: %TERMINALS_TERM_ID%" -H "Content-Type: application/json" --data-binary @- >NUL 2>NUL
      exit /b 0
      ```
      It prints nothing and always exits 0. Outside the app's terminals the variables are undefined, so it does nothing.
    - `hookEntry(scriptPath: string)` returns `{ type: 'command', command: 'cmd.exe', args: ['/d', '/c', scriptPath], timeout: 5 }` (exec form, no shell parsing).
    - `claudeHooksConfig(scriptPath)` returns `{ hooks: { <each of HOOK_EVENTS>: [{ hooks: [hookEntry(scriptPath)] }] } }`, with `matcher: "*"` on PostToolUse and PermissionRequest.
    - `isOurHook(h)` is true when `h.command` or any of `h.args` contains `HOOK_MARKER`, compared case-insensitively.
    - `mergeClaudeHooks(settings, mode, scriptPath)` returns a new object.
      - `install` appends our matcher group to each event's array unless an `isOurHook` entry is already there, which makes it idempotent. An existing entry with a stale script path is replaced.
      - `remove` deletes only `isOurHook` entries, then drops matcher groups that became empty, then empty event arrays, then an empty `hooks` key.
      - All other keys and hooks are left untouched.
    - `hooksInstalled(settings)` is true when every event in `HOOK_EVENTS` has our hook.
  - `types.ts`:
    - `Settings.agentHeuristics: boolean` and `PersistedTab.userTitle?: boolean`.
    - `TerminalsApi` adds:
      - `onTermStatus(cb: (id: string, s: TermStatus | null) => void): () => void`
      - `getTermStatuses(): Promise<Record<string, TermStatus>>`
      - `termSeen(id: string): void`
      - `getClaudeHooks(): Promise<Result<{ installed: boolean; path: string }>>`
      - `installClaudeHooks(): Promise<Result<{ installed: boolean; path: string; backup: string | null }>>`
      - `removeClaudeHooks(): Promise<Result<{ installed: boolean; path: string; backup: string | null }>>`
  - `settings.ts`: `agentHeuristics: { default: true, sanitize: boolean }`.
  - `session.ts`: carry `userTitle` (boolean only) through `sanitizeTabs`, `SessionTab` and `toPersistedTabs`.
- **Interface to others**: everything above. Nothing else in the plan redefines these names.

### T2. Status tracker in main

- **Inputs**: T1, `src/main/terminalHost.ts`, `src/main/termText.ts` (`stripAnsi`).
- **Outputs**:
  - `src/main/agentStatus.ts`:
    - `export const AGENT_RULES: { agent: string; detect: RegExp; needsYou: RegExp[] }[]`, with a single entry `{ agent: 'claude', detect: /esc to interrupt|\? for shortcuts/i, needsYou: [/Do you want to (proceed|make this edit|create|overwrite|allow)/i, /Would you like to proceed\?/i] }`. Keep these as data and comment each regex with what UI text it matches.
    - `export class AgentStatusTracker`, with constants `ECHO_MS = 300`, `RESIZE_MS = 700` (the values commit 10ae50f removed from termRegistry) and `QUIET_MS = 3000`. Every method takes `now: number` and returns `true` when the public status changed:
      - `output(chunk: string, now)` feeds `stripAnsi(chunk)` into a 4 KiB text tail that is reset on input.
        - Not an agent yet and `detect` matches: becomes an agent with `idle`, and the same chunk is then evaluated.
        - Agent, heuristic source, not within ECHO_MS of input or RESIZE_MS of a resize: a `needsYou` match on the tail gives `needs-you`; otherwise `working`, recording `lastOutputAt`.
        - The chunk contains OSC 9;9 or OSC 7 (a shell prompt came back) and the source is heuristic: drop agent detection, status `null`.
      - `input(now)`: needs-you becomes idle (any source); clears the text tail.
      - `resized(now)`.
      - `tick(now)`: heuristic source, `working`, and `now - lastOutputAt >= QUIET_MS` gives `done`.
      - `report(o: HookOutcome | AgentStatus, now)`: `set` makes source `report`, the agent `'claude'` when unset, and sets the status. `clear` resets everything to non-agent (`null`).
      - `seen()`: done becomes idle.
      - `get(): TermStatus | null`: null for a non-agent tab.
      - The heuristic paths are skipped when the constructor flag `heuristics()` (a getter) returns false.
  - `terminalHost.ts`:
    - `Rec.status: AgentStatusTracker`.
    - `HostDeps.onStatus?(id: string, s: TermStatus | null): void` and `HostDeps.heuristics?(): boolean` (default true).
    - `data()` calls `rec.status.output(chunk, Date.now())` and emits on change.
    - New public methods `input(id)`, `resized(id)`, `seen(id)`, `report(id: string, o: HookOutcome | AgentStatus): TermStatus | null` (throws `ToolError` for an unknown id) and `statuses(): Record<string, TermStatus>`.
    - A single `setInterval(…, 1000).unref()` started in the constructor calls `tick` on all live recs. Add a `dispose()` method that clears it, for smoke.
    - `exit()` and `remove()` emit `null`.
    - `TermInfo.status: TermStatus | null` (so `list_terminals` shows it).
    - `TerminalControl` gains `report(...)`.
- **Interface**: `host.input` / `resized` / `seen` / `report` / `statuses` and `HostDeps.onStatus`, used by T3.

### T3. Main wiring: env, endpoint, MCP tool, IPC, hooks file

- **Inputs**: T1, T2, `src/main/index.ts`, `mcp.ts`, `mcpTools.ts`, `src/preload/index.ts`.
- **Outputs**:
  - `index.ts`:
    - `ptyEnv(locId, id)` adds `TERMINALS_TERM_ID: id` and `TERMINALS_STATUS_URL: mcp?.statusUrl ?? ''`. Update both call sites (`spawnForHost` and `pty:create`, with `req.id`).
    - `pty:write` also calls `host.input(id)`, and `pty:resize` calls `host.resized(id)`.
    - `new TerminalHost({..., onStatus: (id, s) => { const h = hosted.get(id); const wc = h && webContents.fromId(h.wc); if (wc && !wc.isDestroyed()) wc.send('term:status', id, s) }, heuristics: () => store.getSettings().agentHeuristics })`.
    - `ipcMain.handle('term:statuses', () => host.statuses())` and `ipcMain.on('term:seen', (e, id) => { if (hosted.get(id)?.wc === e.sender.id) host.seen(id) })`.
    - `ipcMain.handle('hooks:get' | 'hooks:install' | 'hooks:remove')`, delegating to `src/main/claudeHooks.ts`.
  - `mcp.ts`:
    - `McpInfo.statusUrl`.
    - In `handle()`, the same Host / Origin / token checks run first, then the path is routed: `/status` goes to `handleStatus(req, res, terminals)`.
    - `handleStatus` accepts POST only. The terminal id is `X-Terminals-Term` or `?term=`. The body is at most 64 KiB, read and parsed as JSON. With a `?state=` query it uses `parseReportedStatus`, otherwise `statusFromHookEvent(body)`. It then calls `terminals.report(id, outcome)`, skipping `ignore`.
    - It **always replies with an empty body**: 204 on success or ignore, 400 for a bad body or state, 404 for an unknown terminal, 401/403 as for `/mcp`.
    - `ToolContext.headerTerm` comes from the `x-terminals-term` header.
    - Add `report_status` to `INSTRUCTIONS`.
  - `mcpTools.ts`: tool `report_status`.
    - Shape: `{ state: z.enum(['working','done','needs-you','idle']), terminal: z.string().optional() }`.
    - It is not gated by `allowMcpRun`, since it only sets metadata on a tab. `mutates: false`, `readOnly: false`.
    - Missing terminal and missing `headerTerm` gives a `ToolError` telling the agent to pass `terminal` (`$env:TERMINALS_TERM_ID`) or re-register with the new header.
    - Returns `{ id, status }`.
    - `list_terminals` passes `status` through (from `TermInfo`).
  - `src/main/claudeHooks.ts`:
    - `settingsPath()` is `join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')`.
    - `getHooks()`, `installHooks()` and `removeHooks()` read the file; a missing file counts as `{}`. Invalid JSON gives `{ok:false, error}` and the file is never overwritten.
    - Before a write they copy the old file to `settings.json.terminals-backup`, apply `mergeClaudeHooks(…, scriptPath())` and write it with 2-space indent.
    - `scriptPath()` is `join(app.getPath('userData'), HOOK_SCRIPT_NAME)`. `ensureHookScript()` writes `hookScript()` there when the content differs.
    - `installHooks()` calls `ensureHookScript()` first. `removeHooks()` leaves the script on disk; it is harmless.
    - `getHooks()` also returns `scriptPath` and `config: claudeHooksConfig(scriptPath())`, which Copy JSON uses.
  - `index.ts` at startup, after `store.loadStore()`: when `getHooks()` reports installed, call `ensureHookScript()`. This refreshes the script after an update or a `--data-dir` change.
  - Preload: the `TerminalsApi` additions from T1. `getClaudeHooks()` returns `Result<{ installed: boolean; path: string; scriptPath: string; config: object }>`.
- **Interface**: IPC channel names exactly as in the contract section.

### T4. Renderer status UI (same worker as T5)

- **Inputs**: T1, T3 preload API, `App.tsx`, `TabBar.tsx`, `Sidebar.tsx`, `styles.css`.
- **Outputs**:
  - `App.tsx`:
    - `const [statuses, setStatuses] = useState<Record<string, TermStatus>>({})`, filled from `getTermStatuses()` on mount, then from `onTermStatus` (delete the key on null).
    - Seen logic, in `markSeen(ids)`, which calls `window.api.termSeen` for each id whose status is `done`:
      - on a `done` event for a tab that is `active[pane]` of some pane while `document.hasFocus()`;
      - on tab activation;
      - on window `focus` for all active tabs.
    - Memos `tabStatus` and `agentByLoc` (contract), the latter via `rollupOf`.
    - Pass `status={tabStatus}` to every `TabBar` and `agent={agentByLoc}` to `Sidebar`.
    - Rail: list `Object.keys({...working, ...agentByLoc})`, and add `rail-dot ${agentByLoc[id]?.top ?? ''}`.
  - `TabBar.tsx`:
    - Prop `status: Record<string, AgentStatus>`.
    - For `kind === 'shell'`, render `<span className={`agent-ind ${s}`} title={STATUS_LABEL[s]} />` before `.tab-title`. For `needs-you`, render the pill `!`.
    - The tab tooltip adds `\nAgent: <label>`.
  - `Sidebar.tsx`:
    - Prop `agent: Record<string, StatusRollup>`.
    - `Row` gets `agent?: StatusRollup`, rendered before `fin-dot` with the title from `items`.
    - In `groupBlock`, roll up via `rollupStatus` over `subtreeGroupIds`, the same as `finished`.
    - Activity mode: compute `needsYou(entry)` from the roll-up and render the `activity-section needs-you` "Needs you (N)" before Working. Those entries are excluded from `work` and `idle`.
  - `styles.css`: the classes listed in the files table. Use existing theme tokens; done = blue, needs-you = orange/warning, and working = a subtle pulse that respects `prefers-reduced-motion`.

### T5. Auto titles and tab rename (same worker as T4)

- **Inputs**: T1, `termRegistry.ts`, `App.tsx`, `TabBar.tsx`.
- **Outputs**:
  - `termRegistry.ts`: `TermHooks.onTitle: (id: string, title: string) => void`. In `createTerm`, `term.onTitleChange((t) => hooks.onTitle(id, t))`.
  - `TabBar.tsx` `Tab`: `userTitle?: boolean` and `autoTitle?: string` (runtime only).
    - Double-click on a shell or command tab starts an inline rename (input in place of `.tab-title`; Enter commits, Esc cancels). Preview diff/file tabs keep double-click = pin.
    - Tab `onContextMenu` shows the existing `ContextMenu` with "Rename tab", "Use terminal title" (shown when `userTitle`), and "Close".
    - New props `onRename(id, title | null)`.
  - `App.tsx`:
    - `onTitle` handler: shell tabs only. It computes `c = cleanTermTitle(t)`, returns when `c` is null, sets `autoTitle = c`, sets `title = c` unless `userTitle`, and does nothing when the value is unchanged (avoid re-renders).
    - `renameTab(id, title)`: a non-empty string sets `title` and `userTitle: true`. `null` clears `userTitle` and sets `title = autoTitle ?? default title`.
    - Session save passes `userTitle`, and restore applies it.
- **Interface**: `PersistedTab.userTitle` (T1).

### T6. Settings UI

- **Inputs**: T1, T3 preload API, `SettingsDialog.tsx`.
- **Outputs**: a new section "Agent status" in `SettingsDialog.tsx`.
  - Toggle `agentHeuristics`, labelled "Detect agent status from terminal output", with the hint "Used for tabs whose agent does not report. Claude Code only."
  - A custom row "Claude Code hooks". On open it calls `getClaudeHooks()` and shows "Installed" or "Not installed" plus the path.
  - Buttons:
    - **Install** calls `installClaudeHooks()`.
    - **Remove** calls `removeClaudeHooks()` and is disabled when not installed.
    - **Copy JSON** calls `clipboardWrite(JSON.stringify(config, null, 2))` with the `config` from `getClaudeHooks()`. It is the same config that Install writes, with the absolute script path. Copy JSON alone does not write the script; the hint text says to click Install once, or that the script appears in userData at the next start once hooks are installed.
  - Each result or error is shown inline, including the backup path.
  - The field union needs a `kind: 'custom'` entry, or the row is rendered outside the schema list.
  - Add `agentHeuristics` to the keys kept by "Reset" (the destructure at line 253), since it is not appearance.

### T7. Tests (smoke), following test-discipline

- **Inputs**: T1-T3, `src/main/smoke.ts`.
- **Outputs**, three checks and no more:
  1. New `checkAgentStatus()`, pure, with a fake clock. It covers:
     - an `AgentStatusTracker` sequence: plain output means no status; "esc to interrupt" means working; tick past QUIET_MS means done; `seen` means idle; output then a permission prompt means needs-you; `input` means idle; a `report` Stop gives done and later heuristic output does not change it; a SessionEnd clear returns null;
     - `statusFromHookEvent` for Stop, PermissionRequest, Notification permission_prompt, idle_prompt (ignore) and UserPromptSubmit;
     - `mergeClaudeHooks` install twice (idempotent), then remove, which keeps a pre-existing user hook and the other keys;
     - `cleanTermTitle` for `"✳ Fix login bug"` (gives "Fix login bug") and `C:\Program Files\PowerShell\7\pwsh.exe` (gives null).
  2. Extend `checkMcpHttp`. After `open_terminal`:
     - `POST info.statusUrl` with `X-Terminals-Term` and body `{"hook_event_name":"Stop"}` returns 204 and an empty body, and `host.list()` then has status `done`;
     - `report_status { state: 'needs-you', terminal: id }` returns needs-you;
     - `/status` without a token returns 401;
     - the real hook script: write `hookScript()` to the smoke dir and run `cmd.exe /d /c <script>` with `child_process.spawnSync`. Pass stdin `{"hook_event_name":"UserPromptSubmit"}` and env `TERMINALS_STATUS_URL` / `TERMINALS_MCP_TOKEN` / `TERMINALS_TERM_ID` for the smoke server and terminal. Assert exit code 0, empty stdout, and that `host.list()` status becomes `working`.
     - This stays inside the existing check; do not add a new one.
  3. Extend `checkSession` with one assertion: `userTitle: true` survives `toPersistedTabs` and `sanitizeTabs`, and a non-boolean is dropped.
  - Register `checkAgentStatus` in `runSmoke`. Call `host.dispose()` in the smoke host teardown.
  - Run `yarn typecheck` and `yarn smoke` (via `fnm exec --using default` if node is missing).

### T8. README update

- **Inputs**: everything above.
- **Outputs** in `README.md`:
  - A new section **"Agent status"** after "Saved commands":
    - the four states and how each looks (tab, sidebar, Needs-you section, collapsed strip);
    - when done becomes idle;
    - reports vs heuristic, with precedence and the input-clears-needs-you rule;
    - the heuristic rule table, with the file to edit (`src/main/agentStatus.ts`);
    - the Settings toggle.
  - A subsection **"Claude Code hooks"** covering:
    - what Install writes and where: `~/.claude/settings.json`, and the `status-hook.cmd` script in the data dir, which is refreshed at start;
    - the backup file, Remove and Copy JSON;
    - the full JSON (exec form, `cmd.exe /d /c …`) and the events, PermissionRequest included;
    - why HTTP rather than OSC, and why exec form rather than a shell command;
    - that it needs `curl.exe`, which is built into Windows 10 and later.
  - Tools table: add `report_status`; the `list_terminals` row mentions `status`.
  - Per-terminal environment table: add `TERMINALS_TERM_ID` and `TERMINALS_STATUS_URL`.
  - "Register it in Claude Code": add `"X-Terminals-Term":"${TERMINALS_TERM_ID:-}"` to the headers, and note that existing registrations must be re-added for `report_status` to work without `terminal`.
  - **Security**: `/status` uses the same token / Host / Origin rules, always returns an empty body, and changes only tab metadata, so it is not behind "Allow MCP to run commands".
  - **Session restore**: titles, renamed tabs keep their name, and status is not restored.
  - **Keyboard/mouse table**: double-click a tab to rename it, right-click a tab for the menu.
  - The `yarn smoke` paragraph mentions the agent-status checks.
  - Data example: `settings.agentHeuristics`.

## Acceptance criteria

| # | Criterion | Proof |
| --- | --- | --- |
| A1 | The status type and helpers exist in `src/shared/agentStatus.ts` with the contract signatures | `yarn typecheck`; used by T2-T4 |
| A2 | Heuristic: agent detection, working, done after quiet, needs-you on a permission prompt, input clears needs-you; plain shells stay without status | smoke `checkAgentStatus` |
| A3 | Reports win over the heuristic; SessionEnd clears | smoke `checkAgentStatus` |
| A4 | Hook events map to states (Stop, PermissionRequest, permission Notification, UserPromptSubmit, PostToolUse; idle_prompt ignored) | smoke `checkAgentStatus` |
| A5 | `POST /status` with the hook JSON sets the tab status, replies 204 with an empty body, needs the token; the real `status-hook.cmd` run via `cmd.exe` with stdin JSON changes the status, exits 0 and prints nothing | smoke `checkMcpHttp` (extended) |
| A6 | MCP `report_status` sets the status; `list_terminals` shows it | smoke `checkMcpHttp` (extended) |
| A7 | Hook install is idempotent, and remove leaves the user's other hooks and keys intact | smoke `checkAgentStatus` (`mergeClaudeHooks`) |
| A8 | `userTitle` survives session save and restore | smoke `checkSession` (extended) |
| A9 | Title cleaning drops ConPTY's exe-path title and spinner glyphs | smoke `checkAgentStatus` (`cleanTermTitle`) |
| A10 | Claude Code in a tab, hooks installed: tab shows working while it thinks, needs-you (orange `!`) at a permission prompt, blue dot when it finishes in a background tab, idle once that tab is viewed | **manual, real app** (`yarn dev`) |
| A11 | Same flow with hooks removed and the heuristic on: working, then done after about 3 s quiet, needs-you at a permission prompt; with the toggle off: no status | **manual, real app** |
| A12 | Sidebar roll-up: folder and group rows show the highest status; Activity mode shows "Needs you (N)" above Working; the collapsed strip shows status dots | **manual, real app** |
| A13 | Claude Code's title becomes the tab title; a renamed tab keeps its name through title changes and a restart; "Use terminal title" restores auto titles; a fresh pwsh tab still reads "pwsh 1" | **manual, real app** |
| A14 | Settings > Agent status: Install writes `status-hook.cmd` and `~/.claude/settings.json` with a backup, shows Installed; Remove reverts; Copy JSON puts the config on the clipboard; nothing is written without a click | **manual, real app** (check the file before and after) |
| A15 | Window hidden in the tray: a background agent finishing still shows done after reopening | **manual, real app** |
| A16 | README documents everything in T8 | review |

Results are reported as DONE / NOT DONE / UNTESTED per item, with A10-A15 UNTESTED unless run in the real app.

## Director decisions (former open questions)

1. **Hook shell.** Resolved by the exec form with `cmd.exe /d /c status-hook.cmd` (see Key decisions). A10 is the real-app confirmation.
2. **Permission prompts.** Hook stdin carries `notification_type`. `PermissionRequest` and `Notification` with `permission_prompt` both map to needs-you, and `idle_prompt` is ignored.
3. **Heuristic scope.** It applies only to tabs where agent text was detected, not to every shell.
4. **Hook install target.** Only the user-level `~/.claude/settings.json` (or `%CLAUDE_CONFIG_DIR%`); no project-level or `settings.local.json`.

## Progress (implement, 2026-11-26)

- [x] T1 shared contract and pure helpers. No `claudeHooksJson` preload method: Copy JSON uses `getClaudeHooks().config` (per T3).
- [x] T2 status tracker in main (`src/main/agentStatus.ts`, `terminalHost.ts`).
- [x] T3 main wiring. `/status` also answers 405 for non-POST and 404 when no terminal host exists; `report_status` throws a ToolError without a host.
- [x] T4 renderer status UI. Deviation: TabBar also takes a `statusSource` prop for the tooltip source. Colours use `var(--warning, #f59e0b)` / `var(--info, #3b82f6)` fallbacks (no such theme tokens).
- [x] T5 auto titles and rename. Deviation: "Use terminal title" with no captured auto title keeps the current title (the default name is not stored). `userTitle` is restored only for shell tabs.
- [x] T6 settings UI. Install reads "Reinstall" when already installed.
- [x] T7 smoke. Deviation: the hook-script test uses async `spawn`, not `spawnSync` (the server runs in-process, so spawnSync blocked it).
- [x] T8 README.
- Verification: `yarn typecheck` exit 0; `yarn smoke` exit 0, 19 PASS lines, no FAIL. A10-A15 UNTESTED (no real-app run).
