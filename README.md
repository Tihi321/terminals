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

`yarn smoke` runs two checks: an interactive shell echoing a marker, and a 2-step command (`Write-Output ('a'+'1')` then `exit 3`) whose output must contain `a1` and whose exit code must be 3.

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

- **Add folder** saves a standalone folder. Folders missing on disk are greyed out ("not found") and cannot open terminals.
- **Add parent folder** creates a parent-folder group. Its immediate subfolders are discovered automatically (names starting with `.` and `node_modules` are skipped). The list is rescanned when the window regains focus and with the refresh buttons. Child ids are derived from the path, so open terminals survive a rescan. Children with a `.git` entry show a git icon and the current branch as subtitle (read from `.git/HEAD`; for worktrees `.git` is a file and its `gitdir:` pointer is followed). The parent folder row itself is selectable and can open terminals.
- **Hide / show hidden**: hide a child from its context menu or the eye button; the group's eye toggle shows hidden children again (dimmed). Hidden paths are persisted.
- **New group** creates a manual group. Move folders in via the right-click "Move to group: ..." entries, or drag a folder onto the group header; drag a folder to the "Folders" area (or use "Remove from group") to take it out.
- Groups collapse with the chevron; the collapsed state is persisted. The badge on a group is the number of live terminals across its children.
- Right-click any folder or group: Open terminal, Open in Windows Terminal, Open in Explorer, Open in editor, Rename, Hide (children) / Remove, Copy path. Double-click a name to rename.
- The sidebar is resizable (drag its right edge); the width is persisted.

## Files panel (Ctrl+Shift+E)

Right-hand panel with a **Files** and a **Commands** tab; resizable, collapsible, width and open state persisted.

- Lazy tree of the selected folder (directories load when expanded; directories first, case-insensitive). `.git` and `node_modules` are hidden unless "show ignored" is toggled. Expanded directories are watched with `fs.watch` (debounced) and refresh by themselves. The filter box filters entries that are already loaded.
- Click a file to open it in `settings.editor` (default `zed`, resolved on PATH; falls back to the OS default app if it is not found).
- Context menu: Open in editor, Open with default app, Reveal in Explorer (`explorer /select,`), Copy path, Copy relative path, and for directories "Open terminal here" (a new tab in the current folder's tab list with that cwd).
- The main process only lists or opens paths that are inside a saved folder or a parent-folder group root (resolved, case-insensitive prefix check).

## Saved commands (Ctrl+Shift+R)

A command is a name, a mode (`parallel` or `sequential`) and a list of targets, each a folder plus steps (one per line). Example: build three repos with `yarn build:services` / `yarn package:services`, `yarn build` / `yarn package`, `cargo build --release`, saved once and run with one click.

- The Commands tab lists the commands of the selected folder plus those of its group (a selected group shows the group's commands). Each row has a status (idle, running with spinner, success, failed with exit code or stopped), Run / Run again / Stop, edit, duplicate and delete.
- The editor picks each target's folder from the group's children, saved folders and parent folders, or a custom path with a folder picker.
- Run: every target opens a tab titled `▶ <name>` (`▶ <name> · <folder>` for several targets) in the currently selected folder's tab bar. Steps run in order and the first failing step stops that target (native exit codes propagate). The tab stays open with the output and a `✓ done` or `✗ failed (exit N)` line, and shows a status dot. Parallel starts all targets at once; sequential starts the next target only after the previous one succeeded and stops at the first failure. Stop kills the run's terminals. Run again (command row or the tab's button) replaces the previous run's tabs.
- Under PowerShell the steps are passed as an `-EncodedCommand`, so no quoting is needed. Under other shells they are joined with `&&`.

## MCP server

The app runs a small [MCP](https://modelcontextprotocol.io) server so a Claude Code session in one of its terminals can manage the app: saved commands, saved prompts, groups and folders. Changes show up in the open window straight away and are saved to `terminals.json` like any change made in the UI. There is deliberately no tool that runs a command or types into a terminal.

Transport: Streamable HTTP (stateless, JSON responses) at `http://127.0.0.1:<port>/mcp`, built on `@modelcontextprotocol/sdk`. The port is 47821, or `TERMINALS_MCP_PORT` when set; when that port is taken (for example the dev build and the installed build at once) the app falls back to a free port chosen by the OS. Terminals always get the actual URL. The server is not started in `--smoke` mode.

### Tools

| Tool | What it does |
| --- | --- |
| `get_context` | This terminal's location (id, name, path, kind, group) and the data directory |
| `list_locations` | All groups (parent groups with their subfolders), saved folders, ids, paths, group membership |
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

Folder-scoped tools take an optional `location`: a location id, an absolute path (a saved folder, a parent group, or a subfolder of a parent group) or a unique name (case-insensitive). Without it they use the terminal the request came from (the `X-Terminals-Location` header). Unknown paths are an error; nothing is added implicitly. Adding folders or groups through MCP never changes the selection in the UI.

### Per-terminal environment

Every terminal the app starts (shells and command runs) gets:

| Variable | Value |
| --- | --- |
| `TERMINALS_MCP_URL` | URL of this instance's MCP server |
| `TERMINALS_MCP_TOKEN` | Bearer token |
| `TERMINALS_LOC_ID` | Id of the folder, parent-group subfolder or group the terminal belongs to |
| `TERMINALS_LOC_PATH` | That location's directory (empty for a manual group) |

They are always set (empty when unknown), so values inherited from another instance never leak through.

### Security

- Listens on 127.0.0.1 only.
- Every request needs `Authorization: Bearer <token>`, otherwise 401. The token is random, created once and stored as `mcp-token` in the data directory (next to `terminals.json`, so `--data-dir` gets its own). It is compared in constant time.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), and requests carrying an `Origin` header (browsers) are rejected with 403.
- Anything running as your user can read the token file; the server is a convenience for your own terminals, not a sandbox.

### Register it in Claude Code (once)

```
claude mcp add-json --scope user terminals '{"type":"http","url":"${TERMINALS_MCP_URL:-http://127.0.0.1:1/mcp}","headers":{"Authorization":"Bearer ${TERMINALS_MCP_TOKEN:-}","X-Terminals-Location":"${TERMINALS_LOC_ID:-}"}}'
```

Claude Code expands the variables when it starts, so the server only connects inside this app's terminals; elsewhere the URL falls back to an unreachable port and the server just shows as failed in `/mcp`.

## Data

Everything is stored in JSON at `%APPDATA%\terminals\terminals.json` (Electron `app.getPath('userData')`, or the `--data-dir`).

```json
{ "version": 2,
  "folders": [{ "id": "...", "path": "C:\\...", "name": "...", "order": 0, "groupId": null }],
  "groups": [{ "id": "...", "kind": "parent|manual", "name": "...", "path": "C:\\...", "order": 0, "collapsed": false, "showHidden": false, "hidden": ["c:\\..."] }],
  "commands": [{ "id": "...", "name": "...", "ownerId": "<folder|group|child id>", "mode": "parallel", "targets": [{ "cwd": "C:\\...", "steps": ["yarn build"] }] }],
  "selectedId": "...",
  "settings": { "shell": "", "editor": "zed", "terminalFontSize": 15 },
  "ui": { "sidebarWidth": 260, "panelWidth": 340, "panelOpen": false, "panelTab": "files" } }
```

Files without a `version` field are version 1 (folders, selection and `settings.shell` only). They are migrated on load without losing anything, and a copy is kept next to the file as `terminals.json.v1.bak` first. A file with a newer version than the app supports is not loaded and never overwritten.

The MCP server's token is stored next to it as `mcp-token` (see [MCP server](#mcp-server)).

`settings.shell` is the shell executable. Empty means auto: `pwsh.exe` if it is on PATH, else `powershell.exe`. There is no settings UI; edit the file with the app closed.

## Behaviour notes

- Terminals stay alive when you switch folders or tabs; inactive ones are only hidden.
- When a shell exits, its tab stays open marked "exited" (close it with the x). Exited tabs are not counted in the sidebar badge.
- Removing a folder or group kills its terminals and deletes the commands saved on it. Removing a manual group keeps its folders.
- All ptys are killed when the app quits.
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
| Middle-click a tab | Close it |
| Double-click a folder/group name | Rename |
| Drag a folder | Reorder, or move into/out of a manual group |
