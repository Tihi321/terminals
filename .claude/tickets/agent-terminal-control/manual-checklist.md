# Manual checklist: agent terminal control (acceptance 10-16 + reveal, wait_for_output)

Build under test: `release\win-unpacked\Terminals.exe` (branch feat/agent-terminal-control, HEAD 980bd0f).

## 0. Setup

1. From `C:\projects\Personal\terminals`, start the app with isolated data (your real data is untouched; it runs next to a normal instance):
   `release\win-unpacked\Terminals.exe --data-dir=C:\temp\terminals-manual`
2. Register the MCP server once (skip if `claude mcp list` already shows `terminals`):
   ```
   claude mcp add-json --scope user terminals '{"type":"http","url":"${TERMINALS_MCP_URL:-http://127.0.0.1:1/mcp}","headers":{"Authorization":"Bearer ${TERMINALS_MCP_TOKEN:-}","X-Terminals-Location":"${TERMINALS_LOC_ID:-}"}}'
   ```
3. In the app, open a terminal on any location (a "user tab") and run `claude` in it, so the TERMINALS_MCP_* env vars are set. Run `/mcp` and confirm `terminals` is connected.
   (Claude Code outside the app terminals shows the server as failed; that is expected.)
4. Settings (Ctrl+,) > MCP > "Allow MCP to run commands" must start OFF on this fresh data dir (checked in section 11).

[ ] setup ok  notes:

## 10. Home row

1. Sidebar: a "Home" row is pinned at the top. Scroll the sidebar / add folders: it stays on top.
2. Click it: it selects, and opening a terminal there starts in your Documents folder (`Get-Location` shows `...\Documents`).
3. Settings > Home folder > Browse, pick `C:\temp`. Open a NEW Home terminal: it starts in `C:\temp`.
4. Settings > Home folder > "Use Documents": a new Home terminal starts in Documents again.

Expect: pinned, selectable, Documents by default, Browse moves new Home terminals, Use Documents resets.
[ ] pass / [ ] fail  notes:

## 11. Toggle off by default, on without restart

1. With the toggle OFF, tell Claude: "Use the terminals MCP: open_terminal with no location".
   Expect: an error telling it to ask you to enable "Allow MCP to run commands"; no new tab.
2. Tell Claude: "Use the terminals MCP: list_terminals". Expect: works, `allowRun: false`.
3. Turn the toggle ON in Settings (do not restart anything). Repeat step 1 in the same Claude session.
   Expect: it works now, a tab opens (see 12). list_terminals shows `allowRun: true`.

[ ] pass / [ ] fail  notes:

## 12. open_terminal: visible, background, typeable

1. Open two user tabs: A (where Claude runs) and B (a second tab, any location). Select B and start typing a long line in it (do not press Enter).
2. Meanwhile, from Claude in A: "Use the terminals MCP: open_terminal with no location, then run_command `Get-Location` in it". (Do not touch the mouse.)
   Expect while you keep typing in B: your typing is not interrupted, focus and selected tab/location do not change.
3. Afterwards look under Home: a new tab with a Bot icon exists. It shows an `[agent] ...` line and the `Get-Location` output (Documents) appeared live.
4. Click the Bot tab and type `echo hi` + Enter yourself. Expect: it works like a normal terminal.

[ ] pass / [ ] fail  notes:

## 13. Window hidden to tray

1. Hide the window to the tray (close/minimize-to-tray as the app does it).
2. In Claude (running in a tab of this app; it keeps running): "Use the terminals MCP: open_terminal, then run_command `1..3 | % { \"line $_\" }`".
   Expect: both calls succeed while hidden; the window does not pop up.
3. Reopen the window from the tray. Expect: the new Bot tab is there with the full output (line 1..3 and the `[agent]` line).

[ ] pass / [ ] fail  notes:

## 14. Interrupt with send_input

1. Tell Claude: "Use the terminals MCP: open_terminal, run_command `Start-Sleep 60` with timeoutSeconds 2".
   Expect: returns after ~2 s with `timedOut: true`.
2. "list_terminals": that terminal has `busy: true`.
3. "send_input to it with text \u0003" (Ctrl+C, no enter).
4. Wait ~1.5 s, then "list_terminals". Expect: `busy: false`, and the tab shows the interrupt.

[ ] pass / [ ] fail  notes:

## 15. Refusals on user and admin tabs

Get the ids from "list_terminals" (user tabs have `agent: false`).
1. On a user tab id: "run_command `echo x`", "send_input text `x`", "close_terminal". Expect: all three refused with an error (agent terminals only); the tab is untouched and still open.
2. Open an admin (elevated) tab yourself from the app (UAC prompt). On it: run_command, send_input, close_terminal. Expect: all refused.
3. "read_terminal on the user tab id, lines 20". Expect: works, returns the tab's recent output.

[ ] pass / [ ] fail  notes:

## 16. Restart restores the agent tab

1. Make sure an agent (Bot) tab exists. Note its id from list_terminals.
2. Quit the app completely (tray > Quit) and start it again with the same `--data-dir=C:\temp\terminals-manual`. Open a terminal and run `claude` again.
3. Expect: the agent tab is back under Home with the Bot icon. "list_terminals" shows it with `agent: true` and a NEW id.
4. "run_command `Get-Location`" on the new id works.

[ ] pass / [ ] fail  notes:

## Extra A. open_terminal with reveal:true

1. Minimize the window (repeat once with the window hidden in the tray). Select some other location in the sidebar first.
2. Tell Claude: "Use the terminals MCP: open_terminal with reveal true".
3. Expect: the window is shown and focused, the location selected in the sidebar, the new Bot tab active.
4. Contrast: the same call without reveal must NOT show/focus the window.

[ ] pass / [ ] fail  notes:

## Extra B. wait_for_output

1. "open_terminal" (note id). Then ask Claude to start `Start-Sleep 2; 'do'+'ne'` with send_input (enter true) and immediately call wait_for_output on that id with pattern `done`, timeoutSeconds 10.
   (A run_command would finish first; send_input makes the wait overlap.)
2. Expect: `matched: true`, `line` contains `done`, `timedOut: false`, `tail` present. Typed input is `'do'+'ne'`, so only the output line `done` is a real match.
3. Also try pattern `zzz` with timeoutSeconds 2: `timedOut: true, matched: false`.

[ ] pass / [ ] fail  notes:

## Extra C. exit via run_command

1. "open_terminal", then "run_command `exit 7`".
2. Expect: returns after ~1.5 s with `exited: true` and exit code 7. The tab shows the process ended; list_terminals shows `alive: false`.

[ ] pass / [ ] fail  notes:

---
Report back: paste the pass/fail lines (or just the failures) to the director session.
