# REQ-0009 herdr feature research

Legend: **[doc]** = stated in herdr's own docs/site/repo (fetched 2026-11-26). **[inf]** = my inference. Nothing below was run or installed.

## 1. What herdr is

- **[doc]** "The runtime your coding agents live on": a workspace/terminal manager for running many AI coding agents (Claude Code, Codex, Cursor, OpenCode, etc.) side by side, with per-agent status (working / blocked / done / idle).
- **[doc]** Two products share the name. The repo `herdrdev/herdr` is the original TUI: one Rust binary, tmux-style, runs inside an existing terminal, Apache-2.0, latest v0.9.5 (2026-10-14). herdr.dev now leads with a newer native desktop app (macOS, Linux, Windows) plus iOS/Android apps, built on an open-source `herdr-core` server (repos `herdr-app`, `herdr-core`). The TUI and the app do not share sessions.
- **[doc]** Target user: a developer running several agents across repos and machines who wants to see which one needs them. Windows is supported (ConPTY, v0.9.x, "generally available" with caveats).
- **[doc]** Stack: Rust, server/client split. Not Electron. Ours is Electron, so nothing is copyable as code, only as ideas.

## 2. Feature inventory (herdr's own docs)

Sources: R = https://github.com/herdrdev/herdr (README), H = https://herdr.dev/, C = /docs/concepts/, S = /docs/socket-api/, SS = /docs/session-state/, A = /docs/agents/, K = /docs/keyboard/, CF = /docs/configuration/, P = /docs/plugins/, M = /docs/connecting-machines/, SK = /docs/agent-skill/, W = /docs/windows-beta/ (all under herdr.dev).

| # | Feature | Description | Source |
|---|---|---|---|
| 1 | Detach / background server | Server owns terminals; closing the client or losing SSH keeps processes running; reattach restores live output | R, C, SS |
| 2 | Layout restore after restart | Workspaces, tabs, panes, cwds, splits, focus restored as fresh shells; failed pane stays in layout with error | SS |
| 3 | Native agent session resume | After restart, uses session refs from agent integrations to resume Claude Code/Codex/OpenCode etc. (on by default) | SS |
| 4 | Pane screen history replay | Experimental: saves recent terminal contents and replays after server restart | SS |
| 5 | Session backups and layout snapshots | Corrupt session.json preserved (3 copies); up to 48 layout snapshots, one per 15 min | SS |
| 6 | Live handoff on update | Experimental: transfer live panes to the new server during update (not on Windows) | SS, W |
| 7 | Agent state per pane | working / blocked / done (unseen) / idle / unknown, shown in sidebar and tabs; "done" clears when viewed | C, H |
| 8 | Screen-manifest detection | Finds the agent process, reads the bottom of the pane, rules map screen text to state; strict "blocked" only on known approval UI | A |
| 9 | Integrations / self-report | `herdr integration install <agent>` gives reliable state and session ids; open OSC 7501 status protocol so any script can report status with one printf | A, H |
| 10 | `agent explain` | Shows final state, matched rule and manifest source for debugging detection | A |
| 11 | ~25 agents recognised | Claude Code, Codex, Copilot CLI, Cursor, OpenCode, Pi, Droid, Devin, Kimi, Kilo, Hermes, Qwen, Grok, Antigravity, Amp, Kiro, Gemini CLI, Cline... | A |
| 12 | Workspace / tab / pane model | Workspace = project, tab = view (agents, logs, server, review), pane = real terminal; split right/down, zoom, swap, resize, rename | C, K |
| 13 | Sidebar of agents and spaces | Agent panel and space panel with row layouts, tokens, conditional rules, per-agent overrides, dot or symbol status indicators | CF, C |
| 14 | Goto picker | `prefix+g` lists every agent/terminal grouped by workspace, `/` search, filter by status (b/w/i/d) | K |
| 15 | Keybind help with filter | `prefix+?` lists all bindings, `/` filters | K |
| 16 | Copy mode | Vim/tmux-style scrollback navigation, literal search with n/N, select and yank, output stays live | K |
| 17 | Indexed jumps | Bindings for tabs, workspaces, agents 1..9 | CF |
| 18 | Custom key commands | Bindings of type popup, pane, shell, plugin_action | CF |
| 19 | Worktrees | Create/open/delete git worktree checkouts from the sidebar, grouped under the source workspace; also API methods and events | CF, S |
| 20 | Notifications and sounds | Toasts (in-app, terminal, system), custom mp3 for finished / needs-input, per-agent overrides | CF, W |
| 21 | Themes | Built-in themes, follow host terminal, light/dark auto-switch, per-colour overrides | CF |
| 22 | Window title template | Outer title with tokens for host, workspace, tab, pane | CF |
| 23 | Tab bar status area | Configurable right side: zoom, hostname, datetime, text, command output | CF |
| 24 | New-pane cwd policy | `new_cwd`: follow, home, current, fixed path | CF |
| 25 | CLI + socket API | JSON socket API and `herdr` CLI covering workspaces, tabs, panes, agents, layouts, events | S |
| 26 | Pane read / send / wait | `pane.read`, `send_text`, `send_keys`, `wait_for_output`, `agent.wait`, `agent.prompt` (with wait), `agent.start` | S, SK |
| 27 | Event subscription | `events.subscribe` stream: pane.agent_status_changed, pane.output_matched, pane.exited, workspace/tab/layout events | S |
| 28 | Agent-to-agent orchestration | `hc run --bg codex "..."`, `hc send t3 "..."`: spawn helper agents, reports/exits/help requests return into the parent's input | H |
| 29 | Agent skill | Skill text teaching an agent to drive herdr via CLI only when `HERDR_ENV=1` | SK |
| 30 | Layout export/apply | `layout.export`, `layout.apply`, `layout.set_split_ratio`; layouts as files | S, H |
| 31 | Plugins and marketplace | `herdr-plugin.toml` manifest; startup and event hooks, actions, panes (overlay, popup, split, tab, zoomed); marketplace of GitHub repos tagged `herdr-plugin` | P |
| 32 | Multi-machine via SSH | Saved SSH hosts in one sidebar, independent reconnect with backoff, dimmed stale state, attention badges for auth failures | M |
| 33 | Mobile apps | iPhone/iPad/Android: inbox sorted by agents needing you, open real terminal, reply by typing/paste/voice, direct SSH or Tailscale | H |
| 34 | Mouse and keyboard parity | Click, drag borders, right-click menus; optional tmux prefix keys | C, R |
| 35 | Named sessions | Fully separate server namespaces | C |
| 36 | Prompt-built customisation (new app) | Config dir with AGENTS.md, settings.json, keys.json, layouts/, mods/, themes/; user asks the agent to modify the app; gallery of mods | H (marketing, unverified) |
| 37 | Wrapper hint | `HERDR_AGENT=<agent>` env var tells detection which manifest to use under sandbox wrappers | A |
| 38 | Hot reload config | `server reload-config` applies without restarting panes | CF |
| 39 | Windows specifics | ConPTY, cmd.exe panes, Git/worktree detection, system notifications; caveats: cwd after `cd` unreliable without OSC 7, no signed binaries | W |
| 40 | Blue "done" dot per agent in sidebar | Finished-but-unseen agents get a blue dot until clicked | video (~0:40) |
| 41 | "Needs you" label with exclamation mark | Blocked agents are pulled out and labelled "needs you" in the sidebar so none is forgotten | video (~0:55) |
| 42 | Parent/child agent reporting | An agent spawns another agent (e.g. Claude starts Codex in a side pane via the `hc` CLI); the child reports findings back to the parent, which decides next steps | video (~3:20) |
| 43 | Agent edits the app itself | Asking the running agent to change layout/colours live (sidebar moved to the right); it reads `AGENTS.md` in the herdr config dir to learn what it may change | video (~5:00) |
| 44 | Layout and mod gallery | Install community layouts (e.g. a T3-code-style layout with purple theme, iPhone-simulator layout) and mods (agent trail/plan view) by telling the agent to fetch them from GitHub | video (~6:00) |
| 45 | "auto title" mod | Mod that titles each tab from the running agent's context (herdr has no native auto title, per the author) | video (~7:00) |
| 46 | One worktree per task tab | Author's convention: one space per project, one tab per task, each tab an agent on its own git worktree | video (~0:30) |
| 47 | Quit app, agents survive | Cmd+Q the window, reopen, all agents and the active window are as before (herdr-core server) | video (~3:00) |

## 2b. How herdr is used in practice (video)

Source: transcript of "You SHOULD Copy My Agentic Dev Setup" (wJcYhpX_fEQ), a YouTube video where the author shows his daily setup. The transcript has no timestamps; the ones below are my estimates from position in the text (about 24k characters, roughly 13 min). Everything here is **[video]**, the author's own account; a sponsor segment (SerpApi) is ignored. Mac-based (Cmd+Q, M1 Max), using the new herdr desktop app v0.9.5.

Workflow, step by step:

1. **Scale (~0:00).** "There are six agents running in here across three different projects." One builds a feature, one fixes a bug, one reviews code written by another. "A year ago my setup was a mess ... I kept losing track of which agent was done and which one had been waiting for me for the last 10 minutes."
2. **Organisation (~0:30).** "One space per project and one tab per task." Each tab is an agent on "its separate work tree".
3. **Tracking status (~0:35-1:20).** The sidebar shows each agent as working, idle/finished, or waiting. "When an agent is done ... it's marked with this blue dot." Blocked agents: "it brings that up right into your face, says needs you ... with this exclamation mark." It replaces the pain of forgetting a blocked agent for 20 minutes.
4. **Switching.** Click an agent in the sidebar. No keyboard flow is shown: no prefix keys, goto picker or shortcuts.
5. **Notifications.** None shown. Attention is entirely the sidebar labels (dot, exclamation mark, "needs you"). Sounds and toasts from the docs are not mentioned.
6. **Durability (~3:00).** "If I click Cmd+Q to quit ... and bring it back, I got all my agents exactly as they are ... even the window that was active." Agents run in herdr-core, not the UI.
7. **Agents starting agents (~3:20).** From Claude Code: "start a new Codex ... agent to verify the light theme changes ... in a side pane." Claude calls the `hc` CLI, Codex opens in a side pane and reports back to the parent: "it's not going to fix it by itself ... it's going to bring all the intelligence back to Claude, and Claude will decide what to do next." Caveat: the author had to tell Claude to use the `hc` CLI explicitly ("not sure why ... usually it just works").
8. **Customising by asking (~5:00).** Asks Claude (running inside herdr) to move the sidebar to the right. First attempt failed ("version 0.9.5 has no setting for sidebar"); it worked after he pointed it at `AGENTS.md` in the herdr config directory.
9. **Gallery (~6:00).** Layouts and mods installed by telling the agent to copy them from GitHub. He installed a T3-code-style layout, and an "auto title" mod because herdr has no tab auto-titling.
10. **Voice input (~8:00).** He does not type prompts. A local open-source Whisper app is bound to a hotkey (Option+1), toggle to start/stop. Complaint: its LLM clean-up step needs an API key, not his existing subscription.
11. **Review (~11:00).** VS Code is open all day "only to read the code": checks files and directory layout across worktrees, and uses the Claude Code VS Code extension for rare small edits on the same session.
12. **Browser for agents (~13:00).** Claude browser extension in a Chromium browser (Helium); the agent drives tabs, which are put in a "Claude" tab group so he can see which tabs are agent-controlled. Used to verify UI fixes instead of computer use.
13. **Closing rule.** "One agent, your editor is fine. Two or more, get a runtime. Typing every prompt, try talking to them. Agents building UI, give them a browser in its own profile." Also: read the parts that cost money yourself.

What the video stresses: status visibility and durable agents ("what changed my day the most was the runtime and the review loop around it"). Absent from the video: notifications, keyboard prefix flow, copy mode, remote machines, mobile.

Non-herdr parts worth copying into our app (my inference on fit):
- **Auto tab titles (S-M).** Title each tab from the shell/agent title (xterm `onTitleChange`, OSC 0/2) or the first prompt. Cheap and the author relies on a mod for it.
- **Mark agent-driven things visibly (done).** The "Claude" tab group idea matches our Bot icon on MCP agent tabs; nothing new.
- **Review across worktrees (M).** He needs an external editor for this. We already have a file viewer with inline edit, diff tabs and a Git panel, so a per-worktree changed-files view in the Git panel is the gap.
- **Dictation hotkey (M-L).** Global hotkey, local Whisper process (whisper.cpp), type into the focused terminal. Works on Windows but a large scope for a terminal app; lowest priority.
- **Agent hint (S).** Ship an AGENTS.md/skill telling agents which MCP tools to use; the video shows an agent ignoring a CLI until told.

## 3. Comparison with our app

Evidence: `README.md` sections and `src/` greps (no notification API, no terminal search addon, "worktree" only parsed in `src/main/git.ts` for branch reading).

| herdr feature | We have it? | Useful for us? | Effort | Notes |
|---|---|---|---|---|
| Detach / background server (#1) | Partial: tray + close-to-tray keeps ptys alive (commit 6aadbb6) but ptys die on quit ("All ptys are killed when the app quits") | Medium | L | Would need a separate pty-host process that outlives Electron. Big change. |
| Layout restore (#2) | Yes: README "Session restore" (tabs, panes, cwd, command tabs re-run) | n/a | - | Already on par. |
| Native agent session resume (#3) | No | High for Claude Code users | M | After restore, run `claude --resume <id>` in agent tabs. Needs session id capture. |
| Screen history replay (#4) | No ("Scrollback ... not restored") | Medium | M | Persist last N KB per tab, write to xterm on restore. |
| Session backups/snapshots (#5) | Partial: only `terminals.json.v1.bak` migration backup | Low-Med | S | Rolling copies of terminals.json. |
| Agent state per pane (#7) | Partial: Activity sidebar counts busy shells/commands as working (commits 049cb2e, 10ae50f); no blocked/done-unseen or agent awareness; `agent` flag only marks MCP tabs | High | M | Core herdr value. |
| Screen-manifest detection (#8) | No | High | M | Regex on xterm buffer tail per agent. |
| Hook/OSC status reporting (#9) | No | High | S-M | Claude Code hooks (Notification/Stop) can printf OSC or call our MCP. |
| Agent explain (#10) | No | Low | S | Debug aid. |
| Workspace/tab/pane model (#12) | Yes: folders, tabs, up to 4 panes, split by drag | n/a | - | Missing: pane zoom, keyboard split/focus-direction. |
| Sidebar agents panel (#13) | Partial: Activity grouping + slim strip + finished dot (7b639f3) | Medium | S-M | A flat "agents needing me" list is missing. |
| Goto picker (#14) | No (no palette/quick switcher found) | High | S-M | Ctrl+K style switcher over folders and tabs with status filter. |
| Keybind help (#15) | Partial: shortcuts table in README only | Low-Med | S | In-app cheat sheet. |
| Copy mode / scrollback search (#16) | No search addon found in package.json/src | High | S | `@xterm/addon-search` + Ctrl+F bar. |
| Indexed jumps (#17) | No (only new/close/zoom keys) | Medium | S | Ctrl+1..9 for tabs. |
| Custom key commands (#18) | Partial: saved commands/prompts/Shell tab, no key binding | Medium | S | Assign hotkeys to saved commands. |
| Worktrees (#19) | No (git panel, branch picker exist; worktrees only read) | High for parallel agents | M | `git worktree add` + auto-add as folder. |
| Notifications and sounds (#20) | No Notification/flashFrame use in src | High | S | Electron Notification + taskbar flash on blocked/done. |
| Themes (#21) | Yes: settings and themes (c5a36ba) | n/a | - | Light/dark auto-switch unverified. |
| Window title template (#22) | No | Low | S | |
| Status-area widgets (#23) | No | Low | S | |
| New-pane cwd policy (#24) | Partial: terminals start in folder or last cwd | Low | S | |
| CLI + socket API (#25) | Yes in spirit: MCP server (README "MCP server") | n/a | - | We have MCP only, no CLI. Fine. |
| Pane read/send/wait (#26) | Yes: `read_terminal`, `send_input`, `wait_for_output`, `run_command` | n/a | - | On par. We lack `agent.prompt` that waits for a turn to finish. |
| Event subscription (#27) | No (MCP is request/response) | Medium | M | MCP notifications or SSE for status changes. |
| Agent-to-agent orchestration (#28) | Partial: `open_terminal` + `send_input` + `wait_for_output` | Medium | S-M | An `agent_start`/`agent_wait` tool with state would complete it. |
| Agent skill (#29) | No skill file; README has `claude mcp add-json` | Medium | S | Ship a SKILL.md that teaches MCP usage. |
| Layout export/apply (#30) | No | Low-Med | M | Named workspace layouts. |
| Plugins (#31) | No | Low (personal app) | L | Skip. |
| Multi-machine SSH (#32) | No | Low | L | Windows ssh.exe tab per host is a cheap substitute (S). |
| Mobile apps (#33) | No | Low | L | Skip. |
| Mouse + keyboard (#34) | Yes mouse, partial keyboard | Medium | S | See #14, #17. |
| Named sessions (#35) | Partial: `--data-dir` | Low | - | |
| Prompt-built mods (#36) | No | Low | L | Marketing claim, skip. |
| Config hot reload (#38) | Partial: settings apply live | Low | - | |

### Shown in real use in the video vs docs only

| herdr feature | Video | Note |
|---|---|---|
| Agent state in sidebar: working / idle / done (blue dot) / needs you (!) (#7, 40, 41) | Shown in real use, the main selling point | We are partial (Activity grouping only) |
| One space per project, one tab per task, worktree per tab (#12, 19, 46) | Convention described, worktree creation UI not shown | We have no worktrees |
| Background server / quit-and-reattach (#1, 47) | Shown live (Cmd+Q demo) | Ours: ptys die on quit |
| Agent-to-agent via `hc` CLI (#28, 42) | Shown live; agent did not use the CLI until told | Ours: partial via MCP |
| Agent edits app / AGENTS.md (#36, 43) | Shown live, first attempt failed | |
| Gallery layouts and mods, auto-title (#36, 44, 45) | Shown | |
| Notifications / sounds (#20) | Not shown | Docs only |
| Goto picker, keybinds, copy mode, indexed jumps (#14-18) | Not shown | Docs only; author uses mouse and voice |
| Layout restore, native agent resume, history replay (#2-4) | Not shown | Docs only |
| Multi-machine SSH, mobile (#32, 33), plugins (#31) | Not mentioned | Docs/site only |

## 4. Ranked recommendations

Ranking is my inference from the comparison, weighted by value to someone running several agents on Windows in this app.

1. **Agent status per tab (working / blocked / done-unseen / idle).** Why: herdr's central idea, and our Activity view only knows "shell busy". Approach: in `terminalHost.ts` keep a screen-tail matcher per tab (last ~30 lines of the xterm/ANSI-stripped buffer, which `termText.ts` already supports) with a small rule table for Claude Code (permission prompt text, "esc to interrupt" spinner line), plus OSC title changes. Add `blocked` and `done` (unseen until tab activated) to the existing working-state rollup in `App.tsx`/`Sidebar.tsx`. Fits Windows. Caveat: rules break when agent UIs change, so keep them editable data and mimic herdr's "blocked only on known UI, else idle".
2. **Desktop notifications and taskbar flash when an agent becomes blocked or done.** Why: removes the "hunt for the stuck one" problem. Approach: Electron `Notification` + `win.flashFrame` + tray badge, driven by item 1; settings toggle and optional sound. Effort S once item 1 exists.
3. **Hook-based status reporting (OSC or MCP).** Why: more reliable than screen scraping, and herdr treats integrations as the preferred source. Approach: document a Claude Code hook snippet that calls a new MCP tool `report_status` (we already inject `TERMINALS_MCP_URL`/token/`TERMINALS_LOC_ID` env) or prints a custom OSC. Windows fine.
4. **Quick switcher / Goto picker (Ctrl+K) with status filter.** Why: with many folders and agents, finding the blocked one fast is the payoff. Approach: React modal over folders/tabs, fuzzy filter, status chips. Effort S-M. Also add Ctrl+1..9 tab jumps.
5. **Scrollback search (Ctrl+F).** Why: basic gap (no search addon found). herdr's copy mode is a TUI answer; ours is `@xterm/addon-search`. Effort S.
6. **Git worktree support.** Why: herdr groups worktrees under the source workspace, the standard way to run parallel agents on one repo. Approach: in `git.ts` add list/create/remove via `git worktree`; show worktrees as children of the folder in the sidebar (reuse parent-group child model and the existing `.git` file pointer reading). Effort M.
7. **Agent resume on restore.** Why: layout restore exists but an agent tab comes back as an empty shell. Approach: capture Claude's session id (via hook from item 3 or `~/.claude/projects` scan), store in tab session, run `claude --resume <id>` on restore. Effort M. Needs care: only for tabs the user marked as agent.
8. **Persist scrollback tail per tab (screen history replay).** Why: README states output is not restored; herdr offers this as opt-in because it can hold secrets. Approach: serialize last ~200 lines via `@xterm/addon-serialize` to the data dir, off by default. Effort M.
9. **Ship an agent skill and an `agent_wait` / prompt-and-wait MCP tool.** Why: completes orchestration on top of our existing MCP tools. Effort S.
10. **Rolling backups of terminals.json.** Why: cheap safety, copies herdr's session-backups idea. Effort S.

### Re-rank after the video (supersedes the order above where they differ)

The video confirms status visibility (blue dot, "needs you") as the reason the author uses herdr, so items 1 and 3 stay on top. Changes: **worktree per task tab** moves up to 2 (it is his central convention and the reason he needs an editor to review); **agent hint/skill plus agent_start and report-back** moves up to 4 (the video shows an agent ignoring a CLI until told); **notifications** move down to 6 (never shown in the video; the sidebar does the job); **auto tab titles** is new at 7.

1. Agent status per tab incl. unseen-done blue dot and a "needs you" section/label in the sidebar.
2. Worktree per task tab: create/list/remove, shown as children of the project.
3. Hook/OSC status reporting as the reliable source for 1.
4. Agents starting agents with report-back: MCP `agent_start`/`agent_wait`, plus a shipped skill/AGENTS.md hint.
5. Quick switcher with status filter and Ctrl+1..9.
6. Notifications and taskbar flash (optional follow-up of 1).
7. Auto tab titles from OSC title or first prompt.
8. Scrollback search.
9. Agent resume on restore.
10. Dictation hotkey (large scope, last).

Quit-survival (#47) stays "skip for now": it needs a pty daemon (L); the tray already keeps ptys alive on close.

Does not fit or skip: detach-to-background server (needs a separate pty daemon, large; the tray already covers the common case), SSH multi-machine, mobile apps, plugin marketplace, prompt-built mods, live handoff (herdr itself says unsupported on Windows), Unix-only items (systemd shutdown protection, SSH ControlPersist).

## 5. Could not verify / caveats

- Video claims (herdr features, timestamps) are the author's account, not herdr docs; timestamps are my estimates from transcript position. Version/model names in the transcript look auto-caption garbled in places ("Hurder", "Codex GPT 6.2").
- Not read: `/docs/integrations/`, `/docs/add-herdr-support/`, `/docs/quick-start/`, `/docs/persistence-remote/`, herdr.dev `/guide/`, `/core/`, `/mobile/`, `/gallery/`, the `herdr-app` and `herdr-core` repos, and the full SKILL.md. `/docs/*` pages describe the TUI repo; whether the new desktop app has all the same features is not confirmed.
- Marketing-only claims (from herdr.dev home, not verified): the 312 layouts / 576 mods / 533 people gallery figures, "shape the app by asking", mobile app behaviour, "no account, terminals don't pass through herdr servers", the `hc` command set (seen only on the home page, not in the docs I read).
- herdr.dev home says there is no dedicated docs or plugin page, while the README links `/docs/` and `/plugins/`; the `/docs/*` pages did load. `/plugins/` marketplace itself was not fetched.
- Open issues (sampled, 25 most recent) show agent-state detection is a recurring bug source (false idle, stale busy titles, new prompt styles read as idle). This supports building item 1 as editable rules, not hard-coded.
- Our app: I confirmed absence of notifications, search addon and worktree creation only by grep of `src/` and `package.json` mentions, not by running the app.
