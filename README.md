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
