# terminals

A small personal Windows desktop app, similar in spirit to Orca: a sidebar of saved folders and groups, embedded terminals (xterm.js on top of a ConPTY via `@lydell/node-pty`) per folder, a file explorer panel and saved multi-folder commands.

Stack: Electron + React + TypeScript, bundled with electron-vite. Icons from lucide-react. Yarn 4 with `nodeLinker: node-modules`.

## Run

```
yarn
yarn dev
```

## Build / check

```
yarn build       # electron-vite build -> out/
yarn start       # preview the built app
yarn typecheck   # tsc for main/preload/shared and renderer
yarn smoke       # headless PTY checks inside Electron; prints a PASS line per check, exits 0 (1 on failure)
```

`yarn smoke` runs two pty checks: an interactive shell echoing a marker, and a 2-step command (`Write-Output ('a'+'1')` then `exit 3`) whose output must contain `a1` and whose exit code must be 3. It also checks the MCP tool logic, the terminal text helpers (ANSI stripping, run markers), `run_command` against a real PowerShell (output, exit code, persistent state, busy, timeout), and the MCP HTTP endpoint with the "Allow MCP to run commands" toggle off and on. The agent-status checks cover the status state machine (with a fake clock), the hook-event mapping, installing and removing the hooks in a settings object, tab title cleaning, `POST /status` and `report_status` over HTTP, and the real `status-hook.cmd` run through `cmd.exe`.

## Build an .exe

```
yarn dist        # electron-vite build + electron-builder -> release/
yarn dist:dir    # unpacked app only: release/win-unpacked/Terminals.exe (quick testing)
yarn icon        # regenerate build/icon.png and build/icon.ico from build/icon.svg
```

`yarn dist` produces, in `release/` (git-ignored):

- `Terminals-Setup-<version>.exe`: NSIS installer, per-user (no admin), you choose the install directory, Start menu and desktop shortcuts, uninstaller.
- `Terminals-<version>-portable.exe`: single portable exe, no install.

Settings live in electron-builder.yml. x64 only. The native pty (`@lydell/node-pty*`, with `conpty.node`, `conpty.dll`, `OpenConsole.exe`) is shipped prebuilt and unpacked from the asar (`asarUnpack`), so nothing is rebuilt from source.

Data is the same as in dev: `%APPDATA%\terminals\terminals.json`. The main process pins `userData` to that folder, so the product name does not move it, and your saved folders show up in the packaged app. `--data-dir` / `TERMINALS_DATA_DIR` still override it.

The exe is not code signed, so Windows SmartScreen shows "Windows protected your PC" on first run: click "More info", then "Run anyway".

### Isolated data directory

`--data-dir=<path>` (or the env var `TERMINALS_DATA_DIR`) sets Electron's `userData` before the app is ready, so a test or dev run never touches `%APPDATA%\terminals`. A different data dir also gets its own single-instance lock, so it can run next to your normal instance.

```
electron . --data-dir=C:\temp\terminals-test --remote-debugging-port=9333
```

## Sidebar: folders and groups

- **Home** is pinned at the top of the sidebar. It is a real location: selectable, with its own tab list, and the Files, Git and Commands panels work on its directory as they do for a folder. It starts in your Documents folder; change it in Settings (Ctrl+,) under "Home folder". It cannot be renamed, removed or reordered.
- **Add folder** saves a standalone folder. Folders missing on disk are greyed out ("not found") and cannot open terminals.
- **Add parent folder** creates a parent-folder group. Its immediate subfolders are discovered automatically (names starting with `.` and `node_modules` are skipped). The list is rescanned when the window regains focus and with the refresh buttons. Child ids are derived from the path, so open terminals survive a rescan. Children with a `.git` entry show a git icon and the current branch as subtitle (read from `.git/HEAD`; for worktrees `.git` is a file and its `gitdir:` pointer is followed). The parent folder row itself is selectable and can open terminals.
- **Hide / show hidden**: hide a child from its context menu or the eye button; the group's eye toggle shows hidden children again (dimmed). Hidden paths are persisted.
- **New group** creates a manual group. Move folders in via the right-click "Move to group" submenu, or drag a folder onto the group header; drag a folder to the "Folders" area (or use "Remove from group") to take it out.
- Groups collapse with the chevron; the collapsed state is persisted. The badge on a group is the number of live terminals across its children.
- Right-click any folder or group: Open terminal, Open in Windows Terminal, Open in Explorer, Open in editor, Rename, Hide (children) / Remove, Copy path. Double-click a name to rename.
- The sidebar is resizable (drag its right edge); the width is persisted.

### Git worktrees

- **Worktree rows**: a saved folder or parent-group child whose `.git` is a directory lists its linked git worktrees under its row (name = folder name, subtitle = branch). A worktree row is selectable like a folder: the Files, Git and Commands panels work on it and terminal, diff and file tabs attach to it. Ids are derived from the path (`wt:<path>`), so open terminals survive a rescan and a restart. The list is read from git's own metadata on disk. Worktrees whose folder is gone are dimmed ("Folder not found") and can still be removed. Worktree rows show the agent status dot like other rows and count toward group status and Activity grouping; in Activity mode they stay with their repo row.
- **New worktree…** (right-click menu or the branch-plus button on a main working tree row): asks for a branch name and a base branch, runs `git worktree add`, selects the new worktree and opens a terminal in it. A branch name that already exists locally is checked out instead of created. The location comes from Settings > Git > "Worktree location": `<repo parent>\<repo>.worktrees\<branch>` (default) or `<repo parent>\<repo>-<branch>`. The base is remembered for the Git panel's Branch view.
- **Remove worktree…** (right-click on a worktree row): an in-app confirm dialog shows the number of uncommitted changes and requires ticking "Discard N uncommitted changes" before Remove is enabled (then `--force`). Locked worktrees are refused. "Also delete branch" (off by default) runs `git branch -d`, so an unmerged branch is kept and the refusal is shown. The worktree's tabs are closed first.
- If git removes a worktree but cannot delete its folder (usually a file is still in use), the folder is left in place and the dialog shows a message with its path. The app never deletes worktree folders itself; delete it yourself once nothing uses it.
- A worktree folder whose `.git` file is missing or does not point back at git's entry for it is not listed (security). Run `git worktree repair` (for a moved folder) or `git worktree prune` (for a gone one) to fix it.
- Parent-group scans hide a `<name>.worktrees` folder when a sibling `<name>` folder exists, so the default container does not appear as a child.
- Not covered: worktrees under Home or a parent-group root row, worktrees of a worktree, lock/unlock/prune UI.

## Files panel (Ctrl+Shift+E)

Right-hand panel with a **Files** and a **Commands** tab; resizable, collapsible, width and open state persisted.

- Lazy tree of the selected folder (directories load when expanded; directories first, case-insensitive). `.git` and `node_modules` are hidden unless "show ignored" is toggled. Expanded directories are watched with `fs.watch` (debounced) and refresh by themselves. The filter box filters entries that are already loaded.
- Click a file to open it in `settings.editor` (default `zed`, resolved on PATH; falls back to the OS default app if it is not found).
- Context menu: Open in editor, Open with default app, Reveal in Explorer (`explorer /select,`), Copy path, Copy relative path, and for directories "Open terminal here" (a new tab in the current folder's tab list with that cwd).
- The main process only lists or opens paths that are inside a saved folder or a parent-folder group root (resolved, case-insensitive prefix check).

## Git panel (Ctrl+Shift+G)

Changes, History and, when the current branch is not the base branch, **Branch**:

- **Branch view**: the files changed on the branch relative to `merge-base(HEAD, base)`, including uncommitted and untracked changes, with the number of commits ahead and `+added -deleted` totals. Clicking a file opens a diff tab ("vs merge-base abc1234"); untracked files open as untracked diffs. It works for any repo (worktree or not) and is hidden on the base branch and on a detached HEAD.
- **Base picker**: the `vs <base>` select lists local and remote branches and "Default (...)". The choice is stored per repo (per worktree for worktrees) in the app data and survives restarts.
- **Base resolution order** when none is set: the recorded base of a new worktree, else the local default branch (the name from `origin/HEAD`, then `main`, then `master`; the local branch is used so unpushed commits on it are not shown as branch changes), and only when no such local branch exists the remote target itself (for example `origin/main`). With none of these the view shows "No base branch found" together with the base picker, so a base can be chosen (the Branch tab is then shown on any branch other than main/master). The picker never offers the current branch; if the stored base happens to be the current branch, the Branch tab stays so it can be changed or cleared. "Default (...)" always shows the base that would apply.

## Saved commands (Ctrl+Shift+R)

A command is a name, a mode (`parallel` or `sequential`) and a list of targets, each a folder plus steps (one per line). Example: build three repos with `yarn build:services` / `yarn package:services`, `yarn build` / `yarn package`, `cargo build --release`, saved once and run with one click.

- The Commands tab lists the commands of the selected folder plus those of its group (a selected group shows the group's commands). Each row has a status (idle, running with spinner, success, failed with exit code or stopped), Run / Run again / Stop, edit, duplicate and delete.
- The editor picks each target's folder from the group's children, saved folders and parent folders, or a custom path with a folder picker.
- Run: every target opens a tab titled `▶ <name>` (`▶ <name> · <folder>` for several targets) in the currently selected folder's tab bar. Steps run in order and the first failing step stops that target (native exit codes propagate). The tab stays open with the output and a `✓ done` or `✗ failed (exit N)` line, and shows a status dot. Parallel starts all targets at once; sequential starts the next target only after the previous one succeeded and stops at the first failure. Stop kills the run's terminals. Run again (command row or the tab's button) replaces the previous run's tabs.
- Under PowerShell the steps are passed as an `-EncodedCommand`, so no quoting is needed, and your PowerShell profile is loaded, so steps see the same PATH as a normal tab. Under other shells they are joined with `&&`.

## Agent status

Tabs that run an agent show a live status, so you can see from the tab bar and the sidebar which agent works, which one waits for you and which one is done. Plain shells show nothing.

| State | Meaning | Tab | Sidebar row |
| --- | --- | --- | --- |
| Working | The agent is busy | pulsing dot before the title | pulsing dot |
| Done | It finished and you have not looked yet | blue dot | blue dot |
| Needs you | Blocked on a permission prompt or an input | orange `!` pill | orange `!` pill |
| Idle | Nothing to report | nothing | nothing |

- The tab tooltip names the state and where it came from (a report or the heuristic).
- A folder, child or group row shows the highest status of its tabs (needs-you, then done, then working). The tooltip lists the tabs.
- With the sidebar grouped by Activity, a **Needs you (N)** section sits above **Working**. Entries with a needs-you tab are listed there and not again under Working or Idle. The Working section itself is unchanged: an open shell still counts as working.
- The collapsed sidebar strip colours each dot with that status, and lists locations with a needs-you or done tab even when no shell is working.
- **Done becomes idle when you view the tab**: it is the active tab of a pane while the window has focus. A tab that finishes in the background stays blue until you look at it. Status is kept in the main process, so a tab that finishes while the window is hidden in the tray is still done when you open it again.
- Typing in a needs-you tab sets it to idle (any source). If you approve, the next report or output moves it on; if you reject with Esc, no Stop event follows and the tab would otherwise stay stuck.

### Where the status comes from

1. **Reports** (exact): [Claude Code hooks](#claude-code-hooks), the MCP tool `report_status { state, terminal? }`, or `POST /status` (below). Once a tab has received any report, the heuristic is off for that tab until a SessionEnd report or the shell exits.
2. **Heuristic** (fallback): the main process reads each terminal's ANSI-stripped output. A tab only gets a status once known agent text shows up in it. After that, new output means working, about 3 s of quiet after working means done, and a known permission prompt means needs-you. Output right after you typed (300 ms) or after a resize (700 ms) is ignored, and a shell prompt coming back (OSC 7 or OSC 9;9, or the stock `PS C:\x>` / `C:\x>` prompt at the end of the output) drops the agent state. Turning the heuristic off clears the states it set within a second; reported states stay.

The heuristic rules are one small table, `AGENT_RULES` in `src/main/agentStatus.ts`. Only Claude Code ships:

| Agent | Marks the tab as an agent | Needs you |
| --- | --- | --- |
| `claude` | `esc to interrupt` or `? for shortcuts` | `Do you want to (proceed\|make this edit\|create\|overwrite\|allow)`, `Would you like to proceed?` |

Add an entry (`agent`, `detect`, `needsYou`) to teach it another agent. Turn the heuristic off in Settings (Ctrl+,) > Agent status > "Detect agent status from terminal output" (`settings.agentHeuristics`, default on). Reports keep working when it is off.

### Claude Code hooks

Settings > Agent status > "Claude Code hooks" has three buttons:

- **Install** writes the hooks to `~/.claude/settings.json` (`%CLAUDE_CONFIG_DIR%\settings.json` when that variable is set) and writes the script `status-hook.cmd` into the data directory (`%APPDATA%\terminals`). The settings file is copied to `settings.json.terminals-backup` first, only when that backup does not exist yet, so it keeps your original through Install and Remove (delete it to take a fresh one). A UTF-8 BOM at the start of the settings file is dropped when it is rewritten. Installing twice changes nothing, and your other settings and hooks are left alone. An invalid settings file is reported and never overwritten.
- **Remove** takes out only the hooks that point at `status-hook.cmd`, with the same backup rule. The script stays on disk, harmless.
- **Copy JSON** puts the same config on the clipboard, with the absolute script path, to paste by hand. It does not write the script, so click Install once first.

Nothing is written to `~/.claude/settings.json` without a click. While any of the hooks are present (installed or outdated), the app rewrites `status-hook.cmd` at start, which keeps the script itself current. The hook entries in `settings.json` hold the absolute script path and the event list, so after an update that adds events (PreToolUse was added later) or a changed `--data-dir`, Settings shows "Installed (outdated) – Reinstall"; click Reinstall. Hooks are user-level only; project `.claude/settings.json` is never edited.

The config (the script path is in your data directory; PreToolUse, PostToolUse and PermissionRequest also carry `"matcher": "*"`):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "C:\\Users\\you\\AppData\\Roaming\\terminals\\status-hook.cmd"], "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "C:\\Users\\you\\AppData\\Roaming\\terminals\\status-hook.cmd"], "timeout": 5 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "C:\\Users\\you\\AppData\\Roaming\\terminals\\status-hook.cmd"], "timeout": 5 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "C:\\Users\\you\\AppData\\Roaming\\terminals\\status-hook.cmd"], "timeout": 5 }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "C:\\Users\\you\\AppData\\Roaming\\terminals\\status-hook.cmd"], "timeout": 5 }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "C:\\Users\\you\\AppData\\Roaming\\terminals\\status-hook.cmd"], "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "C:\\Users\\you\\AppData\\Roaming\\terminals\\status-hook.cmd"], "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "C:\\Users\\you\\AppData\\Roaming\\terminals\\status-hook.cmd"], "timeout": 5 }] }]
  }
}
```
Every event runs the same script, which POSTs the hook's own stdin JSON to `/status`; the mapping lives in the app:

| Event | Status |
| --- | --- |
| SessionStart | idle (the tab now counts as reporting) |
| UserPromptSubmit, PreToolUse, PostToolUse | working |
| PermissionRequest, Notification with `notification_type: permission_prompt` | needs-you |
| Stop | done |
| SessionEnd | cleared, the heuristic takes over again |
| Other Notification types (such as `idle_prompt`), other events | ignored |

Why HTTP and not an OSC sequence: Claude Code captures a hook's stdout, so it never reaches the terminal, and the stdout of UserPromptSubmit and SessionStart hooks is added to the model's context. Writing to the console from a hook subprocess is fragile under ConPTY. HTTP reuses the loopback server, the bearer token and the environment variables already in every terminal, and the endpoint always answers with an empty body, so nothing leaks into Claude's context.

Why exec form (`cmd.exe` with `args`) and not a shell command: on Windows Claude Code runs shell-form hooks under Git Bash, or PowerShell when Git Bash is missing, so no single command line works everywhere. Exec form involves no shell parsing.

`status-hook.cmd` needs `curl.exe`, which is built into Windows 10 and later. It prints nothing and always exits 0. Outside this app's terminals `TERMINALS_STATUS_URL` and `TERMINALS_TERM_ID` are not set and it does nothing.

### `POST /status`

A plain HTTP endpoint next to `/mcp`, for the hooks and for any script. Send the token and the terminal id (header `X-Terminals-Term: <id>`, or `?term=<id>`; it is the terminal's `TERMINALS_TERM_ID`), plus either a hook event JSON body (up to 4 MiB; larger gets 413) or `?state=working|done|needs-you|idle`:

```
curl.exe -s -X POST "$env:TERMINALS_STATUS_URL?state=done" -H "Authorization: Bearer $env:TERMINALS_MCP_TOKEN" -H "X-Terminals-Term: $env:TERMINALS_TERM_ID"
```

Apart from 401 / 403 it always answers with an empty body: 204 on success or for an ignored event, 400 for a missing terminal id, a bad body or a bad `state`, 404 for an unknown terminal, 405 for anything but POST, 413 for a body over the cap, and 401 / 403 as for `/mcp`. Those two (401 / 403) carry a small JSON-RPC error body, like `/mcp`, not an empty one.

## MCP server

The app runs a small [MCP](https://modelcontextprotocol.io) server so a Claude Code session in one of its terminals can manage the app: saved commands, saved prompts, groups and folders. Changes show up in the open window straight away and are saved to `terminals.json` like any change made in the UI. Tools that open, drive, read and close terminals exist too, but they are off until you turn on Settings > MCP > "Allow MCP to run commands" (see [Terminal control](#terminal-control)).

Transport: Streamable HTTP (stateless, JSON responses) at `http://127.0.0.1:<port>/mcp`, built on `@modelcontextprotocol/sdk`. The port is 47821, or `TERMINALS_MCP_PORT` when set; when that port is taken (for example the dev build and the installed build at once) the app falls back to a free port chosen by the OS. Terminals always get the actual URL. `--smoke` mode starts its own short-lived instance for its checks.

### Tools

| Tool | What it does |
| --- | --- |
| `get_context` | This terminal's location (id, name, path, kind, group) and the data directory |
| `list_locations` | All groups (parent groups with their subfolders), saved folders, git worktrees (kind `worktree`, id `wt:<path>`), ids, paths, group membership |
| `list_commands` | Commands of a location plus those inherited from its group (`inherited: true`) |
| `save_command` | Create (no `id`) or update a command. `steps` alone builds one target in the location's folder; `targets` = `[{ cwd, steps }]`; `scope: "group"` saves it on the location's group |
| `delete_command` | Delete a command |
| `list_prompts` | Prompts visible at a location: global, the location's own and its group's |
| `save_prompt` | Create or update a prompt; `scope` is `global` or a location (default: this terminal's location) |
| `delete_prompt` | Delete a prompt |
| `create_group` | New manual group; `folders` (absolute paths) not yet saved are added, saved ones are moved in. Reports per path |
| `add_parent_group` | Parent folder group for a directory whose subfolders are listed automatically |
| `rename_group` / `delete_group` | Rename / remove a group. Removing deletes the commands and prompts saved on the group and closes its terminals; a manual group's folders stay |
| `add_folders` | Save directories as folders, optionally into a manual group. Reports per path |
| `move_folder` | Into a manual group, or out of it with `group: null` |
| `rename_folder` / `remove_folder` | Rename / remove a folder. Removing deletes its commands and prompts and closes its terminals |
| `open_terminal` | Open a visible PowerShell tab (Bot icon) and return its id. `location` is an id, name or absolute path; default Home. `reveal: true` also shows and focuses the window, selects the location and activates the tab (default false: background). Needs the toggle |
| `run_command` | Run a command in an agent terminal's live shell; returns output, exit code, `timedOut`, `exited`. `timeoutSeconds` 1-600 (default 60). Needs the toggle |
| `send_input` | Type raw text into an agent terminal (`enter: true` appends Enter; Ctrl+C is `"\u0003"`). Needs the toggle |
| `read_terminal` | Last `lines` (1-2000, default 100) of any terminal's output, user tabs included. Needs the toggle |
| `wait_for_output` | Wait until a line of any terminal's output contains `pattern` (plain, case-sensitive; `regex: true` for a JS regex), up to `timeoutSeconds` 1-600 (default 30). `fromNow` (default true) counts only output after the call; false also searches the buffer. Returns `matched`, `line`, `timedOut`, `exited` and the last 20 lines (`tail`). Needs the toggle |
| `report_status` | Set a terminal's agent status: `state` is `working`, `done`, `needs-you` or `idle`; `terminal` defaults to the one the request came from (`X-Terminals-Term`). Not behind the toggle, it only sets tab metadata |
| `list_terminals` | All terminals: id, location, cwd, shell, alive, busy, `agent`, `status` (agent status, null for plain shells). Also reports whether control is on (`allowRun`). Always available |
| `close_terminal` | Close an agent terminal. Needs the toggle |

Folder-scoped tools take an optional `location`: a location id, an absolute path (a saved folder, a parent group, or a subfolder of a parent group) or a unique name (case-insensitive). Without it they use the terminal the request came from (the `X-Terminals-Location` header). Unknown paths are an error; nothing is added implicitly. Adding folders or groups through MCP never changes the selection in the UI.

### Terminal control

Off by default. Turn on Settings (Ctrl+,) > MCP > "Allow MCP to run commands" (`settings.allowMcpRun`). The setting is read at every tool call, so it takes effect without a restart. While it is off, `open_terminal`, `run_command`, `send_input`, `close_terminal`, `read_terminal` and `wait_for_output` return an error telling the agent to ask you to enable it; only `list_terminals` keeps working. There are no per-command prompts.

- **Agent terminals only.** `run_command`, `send_input` and `close_terminal` act only on terminals opened through `open_terminal`. `list_terminals` and `read_terminal` see every terminal, including the ones you opened. Writing into your tabs would break your work, and closing one would destroy its scrollback.
- **Never elevated.** `open_terminal` always starts a plain PowerShell (your configured shell when it is `pwsh` or `powershell`, otherwise the auto-detected one). There is no admin option, and elevated tabs refuse every write tool.
- **Where they open.** Without `location` a terminal opens under Home. A saved location opens there. Any other existing directory opens under Home with that directory as cwd, and nothing is added to the sidebar; a directory that does not exist is an error.
- **Visible and in the background.** An agent tab is a normal tab with a Bot icon that you can watch and type in. It opens without activating itself or taking focus (it only becomes active when the pane showing that location has no active tab). MCP never shows, raises or focuses the window, unless `open_terminal` is called with `reveal: true` (then the window is shown from the tray or minimized state and focused, the location is selected in the sidebar and the new tab is activated); with the window hidden in the tray the tab is created anyway and is there when you open it, with its full output. If the window does not answer within 5 s (still loading), the terminal is closed and the call fails. Agent tabs are restored after a restart with a new id and stay controllable; a restored Home tab falls back to the Home directory.
- **`run_command`** types one line into the tab's live interactive PowerShell, so `cd` and variables persist between calls. The line appears in the terminal (preceded by an `[agent] ...` line) and in PSReadLine history. The output is the raw stream between hidden begin and end markers, ANSI-stripped: no echoed input and no prompt, the last 100 KB at most. The exit code is 0 on success, the last native exit code when it is non-zero, and 1 for an error or Ctrl+C. Only one run per terminal at a time; a second call gets a "busy" error and is not queued. On timeout the call returns the partial output with `timedOut: true`; the command keeps running and the terminal stays busy until it finishes (use `read_terminal`, or `send_input` with `"\u0003"` to interrupt). If the terminal exits during a run, the call returns `exited: true`. A command that ends the run abnormally (Ctrl+C, or `exit`) is held for about 1.5 s to see whether the shell really exits, so those calls return after that delay; `exit N` reports `exited: true` with exit code N. Only PowerShell is supported.
- **`wait_for_output`** matches ANSI-stripped lines of the terminal's output, including the unfinished last line, so a pattern split across chunks still matches. Several waits can run on one terminal. If the terminal exits first it returns `exited: true, matched: false`.
- **`read_terminal`** reads the main process's per-terminal buffer (512 KiB of raw output), so it works while the window is hidden. Lines come from the ANSI-stripped stream, not the rendered screen, so full-screen programs (editors, TUIs) read back poorly.

### Per-terminal environment

Every terminal the app starts (shells and command runs) gets:

| Variable | Value |
| --- | --- |
| `TERMINALS_MCP_URL` | URL of this instance's MCP server |
| `TERMINALS_MCP_TOKEN` | Bearer token |
| `TERMINALS_LOC_ID` | Id of the folder, parent-group subfolder or group the terminal belongs to |
| `TERMINALS_LOC_PATH` | That location's directory (empty for a manual group) |
| `TERMINALS_TERM_ID` | This terminal's id (the tab), used to report its status |
| `TERMINALS_STATUS_URL` | `http://127.0.0.1:<port>/status`, the hooks endpoint |

They are always set (empty when unknown), so values inherited from another instance never leak through.

### Security

- Listens on 127.0.0.1 only.
- Every request needs `Authorization: Bearer <token>`, otherwise 401. The token is random, created once and stored as `mcp-token` in the data directory (next to `terminals.json`, so `--data-dir` gets its own). It is compared in constant time.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), and requests carrying an `Origin` header (browsers) are rejected with 403.
- `POST /status` follows the same token, Host and Origin rules, always replies with an empty body and only changes a tab's status, so it is not behind "Allow MCP to run commands". `report_status` is the same.
- Anything running as your user can read the token file; the server is a convenience for your own terminals, not a sandbox.
- Because of that, the "Allow MCP to run commands" toggle is the only barrier to running commands in terminals. `read_terminal` is behind it too, since terminal output can hold secrets (tokens, pasted passwords). `list_terminals` returns metadata only and stays open.
- An agent shell can run `gsudo`, and with gsudo's credential cache enabled that elevates without a UAC prompt, even though `open_terminal` itself never elevates.

### Register it in Claude Code (once)

```
claude mcp add-json --scope user terminals '{"type":"http","url":"${TERMINALS_MCP_URL:-http://127.0.0.1:1/mcp}","headers":{"Authorization":"Bearer ${TERMINALS_MCP_TOKEN:-}","X-Terminals-Location":"${TERMINALS_LOC_ID:-}","X-Terminals-Term":"${TERMINALS_TERM_ID:-}"}}'
```

Claude Code expands the variables when it starts, so the server only connects inside this app's terminals; elsewhere the URL falls back to an unreachable port and the server just shows as failed in `/mcp`. The `X-Terminals-Term` header tells `report_status` which tab is calling. A registration made before it existed lacks the header: re-add it (`claude mcp remove terminals`, then the command above), or pass `terminal` to `report_status` yourself.

## Data

Everything is stored in JSON at `%APPDATA%\terminals\terminals.json` (Electron `app.getPath('userData')`, or the `--data-dir`).

```json
{ "version": 2,
  "folders": [{ "id": "...", "path": "C:\\...", "name": "...", "order": 0, "groupId": null }],
  "groups": [{ "id": "...", "kind": "parent|manual", "name": "...", "path": "C:\\...", "order": 0, "collapsed": false, "showHidden": false, "hidden": ["c:\\..."] }],
  "commands": [{ "id": "...", "name": "...", "ownerId": "<folder|group|child id>", "mode": "parallel", "targets": [{ "cwd": "C:\\...", "steps": ["yarn build"] }] }],
  "selectedId": "...",
  "settings": { "shell": "", "editor": "zed", "terminalFontSize": 15, "homeDir": "", "allowMcpRun": false, "agentHeuristics": true },
  "ui": { "sidebarWidth": 260, "panelWidth": 340, "panelOpen": false, "panelTab": "files" } }
```

Files without a `version` field are version 1 (folders, selection and `settings.shell` only). They are migrated on load without losing anything, and a copy is kept next to the file as `terminals.json.v1.bak` first. A file with a newer version than the app supports is not loaded and never overwritten.

The MCP server's token is stored next to it as `mcp-token` (see [MCP server](#mcp-server)).

`settings.shell` is the shell executable. Empty means auto: `pwsh.exe` if it is on PATH, else `powershell.exe`. Settings are edited in the app (Ctrl+,).

`settings.homeDir` is the directory Home terminals start in. Empty (the default) means your Documents folder; otherwise it must be an absolute Windows path (invalid values are ignored). `settings.allowMcpRun` (default `false`) lets MCP clients open terminals, run commands, type into and read them (see [Terminal control](#terminal-control)). `settings.agentHeuristics` (default `true`) turns the output-based agent status fallback on or off (see [Agent status](#agent-status)). `settings.worktreeLayout` (`container` default, or `sibling`) is where new worktrees are created (see [Git worktrees](#git-worktrees)); the recorded Branch-view bases are stored as `repoBases` in `terminals.json`.

## Behaviour notes

- Terminals stay alive when you switch folders or tabs; inactive ones are only hidden.
- When a shell exits, its tab stays open marked "exited" (close it with the x). Exited tabs are not counted in the sidebar badge.
- Removing a folder or group kills its terminals and deletes the commands saved on it. Removing a manual group keeps its folders.
- All ptys are killed when the app quits; the terminals are started again on the next launch (see [Session restore](#session-restore)).
- Closing a running command tab stops the whole run.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Ctrl+Shift+T | New terminal in the selected folder |
| Ctrl+Shift+W | Close the active terminal |
| Ctrl+Shift+E | Toggle the Files panel |
| Ctrl+Shift+R | Toggle the Commands panel |
| Ctrl+= / Ctrl+- / Ctrl+0 | Terminal font zoom in / out / reset (15); persisted |
| Ctrl+C | Copy if there is a selection, otherwise sent to the shell |
| Ctrl+V | Paste from clipboard |
| Ctrl+Shift+C | Copy selection |
| Alt+Shift+Left / Alt+Shift+Right | Move the active tab one place left / right in its folder |
| Middle-click a tab | Close it |
| Double-click a tab | Rename it (Enter saves, Esc cancels; file and diff tabs still pin on double-click) |
| Right-click a tab | Menu: Rename tab, Use terminal title (after a rename), Close |
| Drag a tab within the tab bar | Reorder it |
| Drag a tab onto the left/right half of a pane | Split: opens the tab in a new pane (up to 4), also for a tab of the same folder |
| Double-click a folder/group name | Rename |
| Drag a folder | Reorder, or move into/out of a manual group |

## Session restore

The tabs, their order in each folder, the pane layout (including several panes of one folder) and each pane's active tab come back after a restart.

- Shell tabs start again in their folder, or in the directory they were opened in; the last directory is used only when the shell reports it (OSC 7 or OSC 9;9). Title and shell executable are kept. Shell tabs take their title from the terminal's own title (cleaned up, so a program like Claude Code names its tab); renaming a tab pins the name, and "Use terminal title" in the tab menu goes back to the automatic one. Renamed tabs keep their name after a restart.
- File viewer and diff tabs reopen, with their pinned/preview state.
- Command tabs are run again on launch, so a command that starts a server starts it again.
- Skipped: tabs of a folder that is gone or missing, file tabs whose file is gone, diff tabs whose folder is gone, and command tabs whose saved command was deleted.
- Scrollback and terminal output are not restored, and neither is agent status; it starts empty and fills in as agents report or are detected.
