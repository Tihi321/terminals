---
status: done
request: REQ-0007
repos: [C:/projects/Personal/terminals]
branch: feat/open-requests
updated: 2026-11-27
---
# Plan: REQ-0007 extras, round 2

The REQ-0007 base (MCP terminal control, `run_command`, `wait_for_output`, ConciseView, `reveal`) is on master. This plan
covers the nine "not decided" extras from the request file, all at full reading. Each one is a separate task (E1-E9) plus
README (E10).

## Scope

1. **E1** `read_terminal` with `screen: true` returns the rendered visible screen, as the user sees it, from a headless
   xterm in the main process. It works with the window hidden in the tray.
2. **E2** The `run_command` wrapper line stays out of PSReadLine history, both in memory and in the history file.
3. **E3** An agent can get the final result of a run that timed out: `run_command` returns a `runId`, and a new
   `get_run_result` tool waits for or polls that run.
4. **E4** `wait_for_output` gets ReDoS guards: caps on pattern length, pattern count, tested line length and pending
   waiters, and an incremental line scan.
5. **E5** `wait_for_output` gets an `ignoreCase` option.
6. **E6** README: `wait_for_output` can match the echo of input the agent typed.
7. **E7** The run wrapper writes the end marker before it restores `$ErrorView`, the restore cannot throw, and a change
   the user makes to `$ErrorView` is kept.
8. **E8** `Write-Error` and other non-terminating errors in a run print cleanly, without the wrapper excerpt, in pwsh 7 and
   Windows PowerShell 5.1.
9. **E9** `wait_for_output` takes several patterns and returns which one matched.
10. **E10** README updates for E1-E9 (E6 included).

## Out of scope

- `run_command` under cmd.exe (the user skipped it).
- Agent badge or count in the sidebar (covered by REQ-0010).
- Server-to-client MCP notifications, sessions and an SSE stream (see E3 for why).
- Renderer changes. `src/renderer/src/termRegistry.ts` is not touched, because REQ-0004 is changing it on this branch.
- Screen reads of scrollback. `screen: true` returns the visible rows only.

## Files

| File | Tasks |
|---|---|
| `src/main/termText.ts` | E2 (`RUN_LINE_PREFIX`, `agentInitArgs`), E7 and E8 (`buildRunInput`) |
| `src/main/pty.ts` | E2 (`spawnShell` gets optional `args`) |
| `src/main/screen.ts` (new) | E1 (`ScreenMirror`) |
| `src/main/terminalHost.ts` | E1 (mirror, `screen()`, `resized(cols, rows)`), E2 (none; spawn is in deps), E3 (`runId`, finished map, `runResult()`), E4, E5 and E9 (waiters) |
| `src/main/index.ts` | E1 (cols/rows in meta, resize passes size), E2 (agent spawns pass `agentInitArgs`) |
| `src/main/mcpTools.ts` | E1 (`read_terminal.screen`), E3 (`get_run_result`, `run_command` description), E4, E5 and E9 (`compileWaitPatterns`, `wait_for_output` shape) |
| `src/main/mcp.ts` | E3 (INSTRUCTIONS mention `get_run_result` and `screen`) |
| `src/main/smoke.ts` | asserts for every task (see Acceptance) |
| `package.json`, `yarn.lock` | E1: new dependency **`@xterm/headless@^6.0.0`** (matches `@xterm/xterm` 6.0.0). REQ-0004 is also changing `package.json` on this branch: add only the one dependency line, rebase or merge carefully, and run `yarn install` so the lockfile is updated in the same commit. |
| `README.md` | E10 |

## Tasks

All tasks run in one repo and one branch, and most of them share `terminalHost.ts`, `mcpTools.ts` and `smoke.ts`. Run them
**sequentially, in this order, by one implementer, or by two workers on disjoint groups**:

- **Group A (wrapper, `termText.ts`, `pty.ts`, the spawn part of `index.ts`):** E7, then E2, then E8. E8 may reuse the
  agent init script from E2.
- **Group B (`terminalHost.ts`, `mcpTools.ts`, `screen.ts`, the resize part of `index.ts`, `package.json`):** E1, then
  E3, then E9, then E5, then E4. E9, E5 and E4 all rewrite the same matcher and waiter code, so they cannot run in
  parallel.
- Groups A and B both add asserts to `checkRunCommand` in `smoke.ts`. Whichever group goes second rebases onto the first.
  If they run as one sequence, do A then B.
- **E10 (README)** runs last.

### E1 Screen-exact `read_terminal`

**Mechanism: a headless xterm in main (`@xterm/headless`), fed by the same pty data that `host.data()` already receives.**
Why not ask the renderer:

- Agent tabs opened in the background may have no xterm instance mounted. The renderer can also be reloading, or the
  window can be hidden in the tray. Main always has every pty's data.
- A renderer round trip needs new IPC, a timeout and owner checks. It would also touch `termRegistry.ts`, which REQ-0004
  is changing.
- The same xterm parser is used on both sides, so the result matches what the user sees, given the same size (the
  resize contract below covers size).

Cost: every byte is parsed twice (renderer and main). With `scrollback: 0`, each mirror holds only `cols x rows` cells.
That is acceptable. A lazy mirror, built on the first screen read by replaying the 512 KiB ring, was rejected: it loses an
alternate-screen switch or mode change that happened earlier than the ring holds, so it is not exact.

Contract:

- New `src/main/screen.ts` with `class ScreenMirror`. It has no electron import, so smoke can use it.
  - `constructor(cols: number, rows: number)` creates `new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })`
    and loads `@xterm/addon-unicode11` with `unicode.activeVersion = '11'`, as the renderer does. This keeps wide-char
    columns identical. If the addon does not load under headless, the worker reports it and drops it.
  - `write(data: string): void`, `resize(cols, rows): void`, `dispose(): void`.
  - `async snapshot(): Promise<ScreenSnapshot>` flushes first with `term.write('', resolve)`, then reads
    `buffer.active` rows `viewportY .. viewportY + rows - 1` via `translateToString(true)`.
- `ScreenSnapshot = { cols: number; rows: number; cursor: { x: number; y: number }; altScreen: boolean; lines: string[] }`.
  `lines` always has exactly `rows` entries, right-trimmed (trailing empty rows kept, so row numbers match the cursor).
- `TermMeta` gets `cols: number; rows: number`. `Rec` gets `screen: ScreenMirror`, created in `add()` and disposed in
  `remove()`. `data()` calls `rec.screen.write(chunk)` first.
- `resized(id, cols, rows)`: the host resizes the mirror (when cols > 0 and rows > 0) as well as doing the existing
  status call. In `index.ts`, `pty:resize` passes the size. `pty:create` and the agent spawn put the real cols/rows in
  `meta` (agent spawn: 120x30, as today).
- `TerminalControl.screen(id: string): Promise<ScreenSnapshot & { id: string; alive: boolean }>` throws ToolError for an
  unknown id, like `read`.
- `read_terminal` shape: `screen: z.boolean().optional().describe('Return the visible screen as rendered (rows x cols) instead of the last lines of the stream. lines is ignored')`.
  The tool stays gated the same way. When `screen` is true it returns `terminals.screen(a.id)`. Update the description
  ("Full-screen programs read back poorly" becomes "use screen: true for full-screen programs").
- Package: `@xterm/headless@^6.0.0` goes in `dependencies`. electron-vite externalizes dependencies for main, and
  electron-builder ships them. The worker confirms that `out/main/index.js` either requires it or bundles it, and that
  the `dist:dir` build starts.

### E2 Keep the run line out of PSReadLine history

Mechanism: a PSReadLine `AddToHistoryHandler` that returns `$false` for lines starting with the wrapper prefix and chains
to any handler the user already has. A handler installed by line L does not see L, so it must be in place before the
first run line. That is why agent shells install it at spawn time.

Contract:

- `termText.ts` exports `RUN_LINE_PREFIX = ". ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"`.
  `buildRunInput` keeps starting with exactly this string, and checkTermText's existing echo assert keeps it honest.
- `termText.ts` exports `agentInitArgs(): string[]`, which returns `['-NoLogo', '-NoExit', '-EncodedCommand', <utf16le base64>]`
  of a script that:
  - if `Get-Command Set-PSReadLineOption` exists: saves `$h = (Get-PSReadLineOption).AddToHistoryHandler`, then calls
    `Set-PSReadLineOption -AddToHistoryHandler { param($l) if ($l.StartsWith(<prefix>)) { return $false }; if ($h) { & $h $l } else { $true } }.GetNewClosure()`;
  - sets `$global:__terminalsHist = 1`;
  - prints nothing.
- Fallback in the wrapper: if `$global:__terminalsHist` is not set, the wrapper installs the same handler. This covers a
  shell started without the init args, and only that shell's first run line leaks.
- `pty.ts` `spawnShell(shell, cwd, cols, rows, handlers, extraEnv = {}, args: string[] = [])`.
- `index.ts`: the `HostDeps.spawn` implementation, and `pty:create` when `wantAgent && !wantElevated && !req.steps`, pass
  `agentInitArgs()`, but only for pwsh or powershell. User tabs are unchanged.
- Spike first, in both pwsh 7 and 5.1 (PSReadLine 2.0): confirm that `-NoExit -EncodedCommand` runs after the profile, and
  that PSReadLine is loaded at that point so the handler is active at the first prompt. If PSReadLine is not loaded yet,
  `Import-Module PSReadLine` in the init script and re-check. Also confirm that a profile which itself sets a handler is
  chained, not replaced. Report the result.
- `makeSmokeHost` passes `agentInitArgs()` to `spawnShell`.

### E3 Result of a timed-out run (`runId` and `get_run_result`)

Decision: **polling or waiting through a new tool, not MCP notifications.** The server is stateless
(`sessionIdGenerator: undefined`, `enableJsonResponse: true`). It builds one `McpServer` per HTTP POST and rejects GET, so
there is no session and no stream on which to push a `notifications/message` after the `run_command` request has ended.
The SDK (1.32.2) supports logging notifications only over a live request stream or a stateful session's GET stream.
Making the server stateful would mean session management, a GET SSE stream and changes to the token and transport handling
in `mcp.ts`. Claude Code would also show such a notification as a log line, not as something the model can act on. A tool
the agent calls fits the existing transport and gives the model the data.

Contract:

- `RunResult` gets `runId: string`. The `nonce` can be reused as `runId`, since it is already random and unique per run.
- The final result is computed when the run actually ends (end marker, the shell exiting, or remove), even if the caller
  was already settled by the timeout. For that, drop the post-settle trimming of the body to 1024 characters in `feedRun`
  and keep the normal `RUN_BODY_CAP`, so the final output is the whole run (capped at 100 KB as today).
- Host-level `finished: Map<runId, { termId: string; result: RunResult }>` keeps the newest 32 entries, so results survive
  `close_terminal`. The final result has `timedOut: false` and `durationMs` is the full duration.
- `TerminalControl.runResult(id: string, runId: string, waitMs: number): Promise<{ id: string; runId: string; state: 'running' | 'done'; result: RunResult | null }>`:
  - `done`: the result comes from `finished`.
  - Still running and `waitMs` > 0: waits until the run ends or `waitMs` passes. Waits are capped like waiters (E4).
  - Unknown `runId` for that terminal: ToolError `Unknown runId ... (only the last 32 runs are kept)`.
- New tool `get_run_result`:
  - shape `{ id: termId, runId: z.string().min(1), waitSeconds: z.number().int().min(0).max(600).optional() }`, default
    wait 0;
  - `readOnly: true`, `mutates: false`, gated by the toggle like `read_terminal`;
  - description: "Result of a run_command that returned timedOut: true. state running|done; with waitSeconds waits for
    the end."
  - Update the `run_command` description: on timeout, use the returned `runId` with `get_run_result`.

### E9 `wait_for_output` with several patterns (before E5 and E4)

Contract (pure, in `mcpTools.ts`, exported for smoke):

- `interface WaitMatcher { source: string; test(line: string): boolean }`
- `compileWaitPatterns(a: { pattern?: string; patterns?: string[]; regex?: boolean; ignoreCase?: boolean }): WaitMatcher[]`
  throws ToolError when neither or both of `pattern` and `patterns` are given, and on an invalid regex. Later tasks add
  the E5 and E4 rules.
- Shape: `pattern` becomes optional, and `patterns: z.array(z.string().min(1)).min(1).max(8).optional()` is added.
- `TerminalControl.waitFor(id, matchers: WaitMatcher[], timeoutMs, fromNow)`. It tests each line against the matchers in
  order. The first line that matches any of them wins, and on that line the lowest index wins.
- `WaitResult` gets `patternIndex: number | null` and `pattern: string | null` (the matcher's `source`). Both are null
  when nothing matched.

### E5 `ignoreCase`

- Shape: `ignoreCase: z.boolean().optional().describe('Case-insensitive match. Default false')`.
- With `regex`, the flag `i` is used. Without it, the substring match compares `line.toLowerCase()` with the pattern
  lower-cased once, at compile time.

### E4 ReDoS and waiter caps

Constants in `mcpTools.ts` or `terminalHost.ts`, with the numbers fixed:

- `MAX_PATTERN_LEN = 256`. A longer pattern gets a ToolError.
- `MAX_PATTERNS = 8`, enforced by zod and by `compileWaitPatterns`.
- `MAX_TEST_LINE = 2000`. A regex matcher tests only `line.slice(0, MAX_TEST_LINE)`. A substring matcher tests the whole
  line, because it cannot backtrack.
- Waiters: at most 4 pending per terminal and 16 in total, `get_run_result` waits included. Over the cap: ToolError "Too
  many pending waits on this terminal (max 4); let one finish or time out."
- Incremental scan. Replace the "re-run `toLines` over the whole 64 KiB buffer on every chunk" logic with:
  - each waiter keeps `pending`, the raw text after the last `\n`, capped at 8 KiB;
  - on each chunk, take `s = pending + chunk`, test every line of `toLines(s.slice(0, lastNL + 1))` once, then keep the
    rest as `pending` and test its stripped form as the unfinished line.
  - The `fromNow: false` initial scan of the buffered 64 KiB runs once.
  - Matching behaviour (a pattern split across chunks, the unfinished last line) stays the same.
- README states the remaining risk: JS has no regex timeout, so a catastrophic regex can still stall the main process for
  a while within these caps. The toggle is the trust boundary.

### E7 Marker before the `$ErrorView` restore

In `buildRunInput`'s `finally` block:

1. compute `$__c` and `$__d`;
2. write the end marker;
3. then `try { if ($__tr.v7 -and $global:ErrorView -eq 'ConciseView') { $global:ErrorView = $__tr.ev } } catch {}`, so
   the value is restored only if the user's command did not change it;
4. then `Remove-Variable`.

The end marker therefore never depends on the restore. E8 may replace the ConciseView switch itself. If it does, it keeps
this order: marker first, then cleanup that cannot throw.

### E8 Clean `Write-Error` output

Goal: a run's non-terminating errors (`Write-Error 'boom'`, `Get-Item C:\nope`) print as `<Command>: <message>`, with no
`Line |`, `At line:` or `+ . ([ScriptBlock]::Create(` excerpt pointing at the wrapper, in pwsh 7 and 5.1. The following
must not change:

- the command keeps running after a non-terminating error;
- the error lands in `$Error`;
- the exit code is 1;
- native commands keep the real console, so the error stream must not be piped or redirected. `2>&1 | ...` is ruled out,
  because it takes the TTY away from native programs and, in 5.1, can throw under `$ErrorActionPreference = 'Stop'`.

Mechanism, spike first in both shells:

1. **Preferred: a capturing ErrorRecord view, installed once per agent shell by the E2 init script.**
   - Run `Update-FormatData -PrependPath <temp .ps1xml>` with a `System.Management.Automation.ErrorRecord` view. While
     `$global:__terminalsRun` is set (the wrapper sets it before the user code and clears it after the end marker), the
     view renders `"$($_.InvocationInfo.MyCommand.Name): $($_.Exception.Message)"`, or only the message when there is no
     command name, in red.
   - Otherwise it falls through to the built-in rendering. The spike must prove the fall-through without recursion, for
     example by clearing the flag and calling `$_ | Out-String` with the stock view selected via
     `Format-Custom -View`, or another method found in the spike.
   - The temp ps1xml lives under the app's temp dir and is written by main at spawn. Its path is passed into the encoded
     init script.
2. **Fallback for pwsh 7 only**, if (1) cannot fall through cleanly: put the user-code invocation on line 1 of the
   wrapper script block. ConciseView prints the position excerpt only when the invocation has a `ScriptName` or a line
   number above 1, which the spike confirms. Errors then render as `Write-Error: boom`. In 5.1, keep the current output
   and say so in the README.

The worker reports which mechanism shipped. If neither gives a clean 5.1 output, E8 is DONE for 7 and NOT DONE for 5.1,
with the reason.

### E10 README

In the MCP section (`README.md` around lines 199-262):

- **Tools table:** `read_terminal` `screen`; `get_run_result` (new row); `run_command` `runId`; `wait_for_output`
  `patterns`, `ignoreCase`, `patternIndex` and `pattern`, plus the caps.
- **Terminal control bullets:**
  - `run_command`: "The line appears in the terminal and in PSReadLine history" becomes "...appears in the terminal but
    is kept out of PSReadLine history". Add how a timed-out run is collected with `get_run_result`, and how errors print
    (E8 outcome per shell).
  - `wait_for_output` (E6): it can match the echo of text the agent typed with `send_input` (and the `[agent]` line of a
    run). Use a pattern the typed line cannot contain, for example by building the string (`'re'+'ady'`), or call it
    before typing with the default `fromNow: true` and match on something only the program prints. Also add the caps and
    the remaining ReDoS risk.
  - `read_terminal`: replace "full-screen programs read back poorly" with the `screen: true` option, which works while
    the window is hidden.
- **Build / check line 23:** mention the new smoke asserts briefly.

## Acceptance criteria and tests

Test discipline: no new smoke checks. Add the asserts below to `checkRunCommand` (real PowerShell through `TerminalHost`)
and `checkMcpLogic` (pure tool logic), and update their PASS messages.

| # | Criterion | Test |
|---|---|---|
| 1 | `screen` returns the rendered screen, not the stream | checkRunCommand: run `Write-Host ('abc' + [char]13 + 'X')`, then `host.screen(id)`: `lines.length === 30` and some line is `Xbc`, which the stream view (`toLines`) would show as `X`. One assert. |
| 2 | The run line is not in PSReadLine history | checkRunCommand, after two runs: run `@([Microsoft.PowerShell.PSConsoleReadLine]::GetHistoryItems() \| ? CommandLine -like '*FromBase64String*').Count` and require output `0`. If PSReadLine is not loaded the call fails, and that counts as a failure. |
| 3 | A timed-out run's final result can be fetched | checkRunCommand, at the existing `Start-Sleep 5` / 1000 ms timeout: `r3.runId` is set, and `host.runResult(t.id, r3.runId, 10000)` gives `state 'done'`, `result.exitCode 0`, `timedOut false`. This replaces nothing; the existing busy assert stays before it. |
| 4 | Caps refuse bad input | checkMcpLogic: `compileWaitPatterns` throws ToolError for a 257-char pattern and for `pattern` plus `patterns` together. Two asserts. The waiter cap is not smoke-tested (code review only). |
| 5 | `ignoreCase` | checkMcpLogic: `compileWaitPatterns({ pattern: 'READY', ignoreCase: true })[0].test('ready')` is true, and the same with `regex: true`. One combined assert. |
| 6 | README echo note | Review only. |
| 7 | Marker before restore; the user's `$ErrorView` is kept | checkRunCommand: run `$ErrorView = 'NormalView'`, then run `$ErrorView`, and require output `NormalView`. One assert. In 5.1 it passes trivially. |
| 8 | Clean `Write-Error` | checkRunCommand: run `Write-Error boom; 'after'`. Require output that contains `boom` and `after` and does not contain `ScriptBlock]::Create` or `FromBase64String`, with `exitCode 1`. One assert. The smoke runs the configured shell only; the worker runs the spike in the other shell by hand and reports it. |
| 9 | Several patterns | checkRunCommand: replace the existing `waitFor(t3.id, 'ready', ...)` with matchers for `['nope', 'ready']` and require `matched`, `patternIndex === 1`, `pattern === 'ready'`. This rewrites the existing assert; no new one. |

Also: both typechecks exit 0, `electron-vite build` exits 0, the full smoke run is all PASS, and `dist:dir` builds and
starts (for E1's dependency). Manual check (UNTESTED unless run): with the window hidden in the tray, an agent runs a
full-screen program (for example `edit` or `vim`) in an agent tab, and `read_terminal { screen: true }` shows its screen.

## Decisions

1. E8: if the 5.1 spike fails, ship the pwsh 7 part and report 5.1 as NOT DONE.
2. E2: also install the history handler for restored agent tabs (any pwsh/powershell tab spawned as an agent tab).
3. E1: mirror every terminal tab (scrollback 0). The mirror must use the same width rules as the renderer: REQ-0004 (66c88db) now loads @xterm/addon-unicode-graphemes 0.4.0 after unicode11; load the same in ScreenMirror (fallback '11').

## Results (implementer, 2026-11-26)

Checks: `yarn typecheck` exit 0; `yarn smoke` exit 0, 21 PASS, 0 FAIL; `yarn dist:dir` exit 0 (`out/main/index.js` requires `@xterm/headless`, the unicode addons are required too; `release/win-unpacked/resources/app.asar` lists `node_modules/@xterm/headless/lib-headless/xterm-headless.js`); the packaged `Terminals.exe --smoke` also exits 0 with 21 PASS (it loads the bundled headless module in the real main).

- **E7 DONE (deviation).** The wrapper writes the end marker first, then only cleanup that cannot throw. It no longer forces `ConciseView` or restores `$ErrorView` at all: the plan's assert 7 (run `$ErrorView = 'NormalView'`, then run `$ErrorView`, expect `NormalView`) cannot pass while the wrapper forces `ConciseView` for every run, because the second run would print `ConciseView`. So a user-set value stays, in both shells. Cost: a user whose profile sets `NormalView` gets the wrapper excerpt in `Write-Error` output (their choice).
- **E2 DONE.** `RUN_LINE_PREFIX`, `historyHandlerScript()`, `agentInitArgs()` in `termText.ts`; `spawnShell(..., args)` in `pty.ts`; both agent spawns in `index.ts` (host spawn and `pty:create` with `wantAgent`, so restored agent tabs too) pass them for pwsh/powershell only. The wrapper repeats the handler install when `$global:__terminalsHist` is unset (fallback). Spike result, both shells: `-NoExit -EncodedCommand` runs after the profile; PSReadLine is already loaded at that point (pwsh 7.6: 2.4.5; Windows PowerShell 5.1 with a clean `PSModulePath`: 2.0.0); a handler set earlier (blocking `OLDBLOCK`) is chained, and `SECRETRUN` lines are dropped from memory and from the history file. With the init args 0 run lines are added to history in 4 runs; without them exactly 1 (the first run line) leaks, in both shells. Smoke assert 2 deviates slightly: it compares the history count before the first run and after the runs (the user's history file may still hold run lines leaked by older builds, 320 here), instead of requiring `0`.
- **E8 DONE for pwsh 7, NOT DONE for 5.1.** Preferred mechanism (ErrorRecord format view via `Update-FormatData -PrependPath`, with fall-through) FAILED the spike in both shells: the view loads in 7 (listed first by `Get-FormatData`) but neither shell's host consults it for error display (a view that prints `MYVIEW` never showed up, flag on or off), and a view needs a default entry anyway; 5.1 has no ErrorRecord format data at all. Shipped fallback: the whole wrapper is one physical line, so the invocation is on line 1 of an unnamed script block and 7's ConciseView prints `Write-Error: boom` (also `Get-Item: Cannot find path ...`, `Exception: terminating`) with no `Line |` excerpt. Command keeps running, `$Error` filled, exit code 1, native commands keep the console (no redirection). 5.1 keeps its `At line:` excerpt (now `At line:1 char:<n>`); README says so. No temp ps1xml file, no `$global:__terminalsRun` flag.
- **E1 DONE (manual check UNTESTED).** `src/main/screen.ts` (`ScreenMirror`: `@xterm/headless`, scrollback 0, unicode11 then `@xterm/addon-unicode-graphemes` with fallback `'11'`, same as the renderer; verified active version `15-graphemes` and a ZWJ family as 2 columns). Every terminal gets a mirror in `add()`, fed first in `data()`, disposed in `remove()`; `TermMeta` has `cols`/`rows`; `pty:resize` passes the size to `host.resized(id, cols, rows)`; `read_terminal { screen: true }`. Not run: a full-screen program in an agent tab with the window hidden in the tray.
- **E3 DONE.** `runId` (= nonce), `finished` map (32, survives close), `runResult()`, `get_run_result`, final result computed at the real end (post-settle body trimming removed), descriptions and INSTRUCTIONS updated.
- **E9, E5, E4 DONE.** `compileWaitPatterns` and the caps in `mcpTools.ts`; `waitFor(id, matchers[], ...)` returns `patternIndex`/`pattern`; waiters scan incrementally (8 KiB `pending`, the buffered 64 KiB scanned once for `fromNow: false`); at most 4 pending waits per terminal and 16 in total (`get_run_result` waits count). The waiter cap is code-review only, as planned.
- **E10 DONE.** README tools table, terminal-control bullets, smoke paragraph.
- Smoke asserts added exactly as in the Acceptance table (1, 2, 3, 4, 5, 7, 8, 9) inside `checkRunCommand` / `checkMcpLogic`; plus one condition in checkTermText's existing echo assert (`startsWith(RUN_LINE_PREFIX)`, one line). Assert 8 runs before assert 7 in the file, because a user-set `NormalView` is sticky and would otherwise make `Write-Error` noisy.
