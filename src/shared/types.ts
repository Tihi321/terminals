/** Current on-disk schema version. Files without a `version` field are version 1. */
export const SCHEMA_VERSION = 4

/** Id of the pinned Home location. Never a saved folder/group id (those are UUIDs or `child:` ids). */
export const HOME_ID = 'home'

export type ThemeId = 'dark' | 'light' | 'fjord' | 'sandstone'
export type ThemeSetting = ThemeId | 'system'
export type CursorStyle = 'block' | 'bar' | 'underline'

export interface Settings {
  /** Shell executable. '' = auto (pwsh.exe if on PATH, else powershell.exe). Applies to new terminals only. */
  shell: string
  /** Editor executable resolved on PATH (default "zed"). */
  editor: string
  terminalFontSize: number
  theme: ThemeSetting
  /** CSS font-family list for terminals, diff and file viewers. */
  terminalFontFamily: string
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  /** Directory Home terminals start in. '' = the user's Documents folder (resolved in main at runtime). */
  homeDir: string
  /** MCP clients may open terminals, run commands, type into and read terminals. Read at every call. */
  allowMcpRun: boolean
}

export interface LoginItemState {
  enabled: boolean
  /** false when the app is not packaged: registering electron.exe at login would be wrong. */
  supported: boolean
}

/** One entry of the default-shell picker. value '' = automatic. */
export interface ShellOption {
  value: string
  label: string
  /** False when the executable is not on PATH (shown disabled). Always true for ''. */
  available: boolean
}

/** Side-by-side panes: location ids in order, width fractions (sum 1) and the focused index. */
export interface PersistedPanes {
  locIds: string[]
  fractions: number[]
  focused: number
  /** One entry per `locIds` entry: id (in the saved `UiState.tabs` snapshot) of the tab active in that pane, or null. */
  active?: (string | null)[]
}

/** A tab saved for restore after a restart. */
export interface PersistedTab {
  /** Id inside the saved snapshot; restore gives every tab a fresh id. */
  id: string
  locId: string
  kind: 'shell' | 'command' | 'diff' | 'file'
  title: string
  /** shell: last known cwd, else start cwd; command: target cwd; diff: repo folder; file: the file path. */
  cwd: string
  /** shell only: executable it ran (AppState.resolvedShell at creation). */
  shell?: string
  /** shell only: cwd the tab was started in; fallback when `cwd` cannot be used. */
  startCwd?: string
  diff?: { folder: string; mode: 'unstaged' | 'staged' | 'untracked' | 'commit'; path: string; hash?: string }
  file?: string
  preview?: boolean
  run?: { commandId: string; runId: string; target: number }
  /** shell only: started elevated; restored as a not-started placeholder. */
  elevated?: boolean
  /** Opened by an MCP agent; restored tabs stay controllable by MCP. */
  agent?: boolean
}

export interface UiState {
  sidebarWidth: number
  panelWidth: number
  sidebarCollapsed: boolean
  /** Null until a layout has been saved; the renderer then starts with one pane on the selection. */
  panes: PersistedPanes | null
  panelOpen: boolean
  panelTab: 'files' | 'commands' | 'git'
  /** Saved session: every open tab, restored on the next launch. */
  tabs: PersistedTab[]
  /** Sidebar "Group by": 'activity' splits entries into Working / Idle. */
  groupBy: 'none' | 'activity'
  /** Activity mode: the top-level IDLE section is collapsed. */
  idleCollapsed: boolean
  /** Activity mode: ids of groups whose "Idle (N)" sub-row is expanded (collapsed by default). */
  idleOpen: string[]
}

export interface Folder {
  id: string
  path: string
  name: string
  order: number
  /** Manual group this folder belongs to, or null when standalone. */
  groupId: string | null
}

export interface FolderView extends Folder {
  /** True when the folder no longer exists on disk. */
  missing: boolean
  isGit: boolean
  branch: string | null
}

/** Auto-discovered subdirectory of a parent-folder group. Id is derived from the path so it is stable across rescans. */
export interface ChildView {
  id: string
  path: string
  name: string
  isGit: boolean
  branch: string | null
  hidden: boolean
}

export interface GroupView {
  id: string
  kind: 'parent' | 'manual'
  name: string
  /** Containing manual group, or null at the top level. */
  parentId: string | null
  /** Parent-folder groups only. */
  path: string | null
  /** Manual groups only: optional folder on disk new folders are created in. Null for parent groups. */
  folder: string | null
  order: number
  collapsed: boolean
  showHidden: boolean
  missing: boolean
  isGit: boolean
  branch: string | null
  /** Parent-folder groups only: discovered subfolders (hidden ones included, flagged). */
  children: ChildView[]
  hiddenCount: number
}

export interface CommandTarget {
  /** Absolute directory the steps run in. '' (global commands only) means the folder selected when the command runs. */
  cwd: string
  steps: string[]
}

export interface Command {
  id: string
  name: string
  /** Folder, child or group id, or 'global' for a command available in every folder. */
  ownerId: string
  mode: 'parallel' | 'sequential'
  targets: CommandTarget[]
}

/** Saved prompt / text snippet that can be pasted into a terminal. */
export interface Snippet {
  id: string
  name: string
  body: string
  /** 'global' or a folder, group or child id. */
  scope: string
}

export type PasteContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string }
  | { kind: 'files'; paths: string[] }

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

export interface AppState {
  home: HomeView
  folders: FolderView[]
  groups: GroupView[]
  /** Ids of pinned folders/groups, in the order they were pinned. */
  pinned: string[]
  commands: Command[]
  snippets: Snippet[]
  /** Selected folder, group or child id. */
  selectedId: string | null
  settings: Settings
  ui: UiState
  /** Resolved shell executable, used for tab titles. */
  resolvedShell: string
}

export interface PtyCreateRequest {
  id: string
  cwd: string
  cols: number
  rows: number
  /** When set, run these steps (stopping at the first failure) instead of an interactive shell. */
  steps?: string[]
  /** Folder, child or group id the terminal belongs to; exported to the shell as TERMINALS_LOC_ID for the MCP server. */
  locId?: string
  /** Shell executable to use. Main honours it only when it is the configured shell or an available known shell. */
  shell?: string
  /** Used when `cwd` fails the existence/roots check. */
  fallbackCwd?: string
  /** Start the shell elevated. Main builds the command from the validated shell and the elevator it finds; only `true` counts. */
  elevated?: boolean
  /** Restored agent tab. Ignored for steps and elevated requests. With locId === HOME_ID, any existing directory is accepted as cwd. */
  agent?: boolean
}

/** main -> renderer: show a tab for an agent pty main already spawned. */
export interface AgentTabRequest {
  reqId: string
  /** pty id == tab id. */
  id: string
  locId: string
  cwd: string
  /** Resolved shell executable (for the tab title / restore). */
  shell: string
  /** open_terminal reveal: true. The renderer also activates the new tab in a pane (main shows/focuses the window and selects the location). */
  reveal?: boolean
}

/** Elevator status for the UI. The path stays in main. */
export interface ElevatorInfo {
  available: boolean
  tool: 'gsudo' | 'sudo' | null
  hint: string
}

/** In-app file viewer payload: text, an image as a data URL, or a marker for binary/too-large files. */
export type FileContent =
  | { kind: 'text'; text: string; /** Modification time at read, handed back to `writeFile` to detect outside changes. */ mtimeMs: number }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary'; reason: 'binary' | 'large' }

/** Result of saving a text file; `conflict` means the file changed on disk since it was read (nothing was written). */
export type WriteResult = { ok: true; mtimeMs: number } | { ok: false; error: string; conflict?: boolean }

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

/** One changed file in `git status`. Paths are relative to the repository root. */
export interface GitFile {
  path: string
  /** Rename/copy source (renames only). */
  origPath?: string
  /** Index status letter (M A D R C T) or null when nothing is staged. */
  staged: string | null
  /** Worktree status letter (M D T ...) or null when there are no unstaged changes. */
  unstaged: string | null
  untracked: boolean
  conflicted: boolean
  /** Line counts; null = binary or unknown. */
  stagedAdded: number | null
  stagedDeleted: number | null
  unstagedAdded: number | null
  unstagedDeleted: number | null
}

export interface GitStatus {
  /** Absolute repository root; all file paths are relative to it. */
  root: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  hasCommits: boolean
  files: GitFile[]
}

export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  /** Relative date, e.g. "3 hours ago". */
  date: string
}

export interface GitBranch {
  /** Local name, or `<remote>/<branch>` for remote-tracking branches. */
  name: string
  remote: boolean
  current: boolean
  author: string
  /** Last commit time, unix seconds. */
  date: number
  subject: string
}

export interface GitNumstat {
  path: string
  origPath?: string
  added: number | null
  deleted: number | null
}

export type GitDiffRequest =
  | { mode: 'unstaged' | 'staged' | 'untracked'; path: string }
  | { mode: 'commit'; path: string; hash: string }

/** Git calls never throw: failures come back as `{ ok: false, error }`, with `notRepo` set when the folder is not in a repository. */
export type GitResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; notRepo?: boolean }

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string }

/** Outcome of copying dropped files/folders into a folder. Names are the final names in the destination. */
export type CopyResult =
  | { ok: true; copied: string[]; skipped: string[]; failed: { name: string; error: string }[] }
  | { ok: false; error: string }

export interface TerminalsApi {
  getState(): Promise<AppState>
  /** State changed outside the renderer's own calls (the MCP server). */
  onStateChanged(cb: (state: AppState) => void): () => void
  addFolder(): Promise<AppState>
  addParentGroup(): Promise<AppState>
  /** Creates a manual group (inside parentId when that is a manual group, else top level) and selects it. */
  addGroup(name: string, parentId?: string | null): Promise<AppState>
  removeFolder(id: string): Promise<AppState>
  /** Cascades: removes the group, all subgroups, their folders, and the commands/prompts they own. Nothing on disk. */
  removeGroup(id: string): Promise<AppState>
  /** Nest a group under a manual group (or null for top level). No change if the move is invalid. */
  moveGroup(id: string, parentId: string | null): Promise<AppState>
  renameFolder(id: string, name: string): Promise<AppState>
  renameGroup(id: string, name: string): Promise<AppState>
  /** Move a folder into a manual group (or out with null), optionally before another folder. */
  moveFolder(id: string, groupId: string | null, beforeId?: string): Promise<AppState>
  /** Move a folder or group one place up (-1) or down (1) among its siblings. No-op at the edges or for unknown ids. */
  moveItem(id: string, dir: -1 | 1): Promise<AppState>
  /** Alt+Shift+Right (1) nests a folder or group into the manual group above it; Left (-1) moves it out one level. No-op when not applicable. */
  nestItem(id: string, dir: -1 | 1): Promise<AppState>
  /** Sets (or clears with null) the optional folder on disk of a manual group. */
  setGroupFolder(id: string, folder: string | null): Promise<AppState>
  /**
   * Creates `name` (one level, never recursive) inside `parentDir`. When `groupId` is a manual group the new folder is
   * also saved in it. Fails on empty/invalid/existing names with a message to show inline.
   */
  createFolder(parentDir: string, name: string, groupId: string | null): Promise<Result<{ path: string; state: AppState }>>
  /** Copies dropped files/folders into `destDir` without overwriting ("name (2)"). */
  copyIntoFolder(paths: string[], destDir: string): Promise<CopyResult>
  /** Pins or unpins a folder or group (shown in the Pinned section at the top of the sidebar). */
  setPinned(id: string, pinned: boolean): Promise<AppState>
  setGroupCollapsed(id: string, collapsed: boolean): Promise<AppState>
  setShowHidden(groupId: string, show: boolean): Promise<AppState>
  setChildHidden(groupId: string, path: string, hidden: boolean): Promise<AppState>
  select(id: string | null): Promise<AppState>
  saveCommand(cmd: Command): Promise<AppState>
  deleteCommand(id: string): Promise<AppState>
  saveSnippet(s: Snippet): Promise<AppState>
  deleteSnippet(id: string): Promise<AppState>
  /** Add dropped directories (files are ignored, known paths skipped). Selects the first new one. */
  addFolderPaths(paths: string[], groupId: string | null, beforeId?: string): Promise<AppState>
  /** Real filesystem path of a dropped File (File.path is gone in Electron 32+). */
  getPathForFile(file: File): string
  setSettings(patch: Partial<Settings>): Promise<AppState>
  /** Concrete theme main resolved when the window was created ('system' already resolved). Paints the first frame. */
  readonly initialThemeId: ThemeId
  /** Known shells for the default-shell picker, with PATH availability. */
  listShells(): Promise<ShellOption[]>
  /** Windows "open at login" state, read from the OS. supported=false in dev (unpackaged) builds. */
  getLoginItem(): Promise<LoginItemState>
  /** Sets "open at login" in the OS and returns the state read back from it. */
  setLoginItem(enabled: boolean): Promise<LoginItemState>
  setUi(patch: Partial<UiState>): Promise<AppState>
  pickFolder(): Promise<string | null>
  /** Which paths exist and lie inside the saved roots (same order as the input). */
  pathsExist(paths: string[]): Promise<boolean[]>

  openInWindowsTerminal(path: string): Promise<void>
  openInExplorer(path: string): Promise<void>
  openInEditor(path: string): Promise<void>
  openDefault(path: string): Promise<void>
  revealInExplorer(path: string): Promise<void>
  listDir(path: string, showIgnored: boolean): Promise<Result<{ entries: DirEntry[] }>>
  readFile(path: string): Promise<Result<{ content: FileContent }>>
  /** Overwrites an existing text file. Refused with `conflict` when its mtime differs from `expectedMtimeMs`, unless `force`. */
  writeFile(path: string, text: string, expectedMtimeMs: number, force: boolean): Promise<WriteResult>
  watchDirs(paths: string[]): void
  onFsChanged(cb: (dir: string) => void): () => void

  gitStatus(folder: string): Promise<GitResult<{ status: GitStatus }>>
  gitDiff(folder: string, req: GitDiffRequest): Promise<GitResult<{ text: string; truncated: boolean }>>
  /** paths = null stages everything (`git add -A`). Include a rename's origPath to stage both halves. */
  gitStage(folder: string, paths: string[] | null): Promise<GitResult>
  gitUnstage(folder: string, paths: string[] | null): Promise<GitResult>
  /** stageTracked runs `git add -u` first ("Commit Tracked"). */
  gitCommit(folder: string, message: string, stageTracked: boolean): Promise<GitResult>
  gitLog(folder: string): Promise<GitResult<{ commits: GitCommit[] }>>
  gitCommitFiles(folder: string, hash: string): Promise<GitResult<{ files: GitNumstat[] }>>
  gitFetch(folder: string): Promise<GitResult>
  /** `git pull --ff-only`. */
  gitPull(folder: string): Promise<GitResult>
  /** publish = `git push -u <remote> <branch>` for a branch without upstream. */
  gitPush(folder: string, publish?: boolean): Promise<GitResult>
  gitBranches(folder: string): Promise<GitResult<{ branches: GitBranch[] }>>
  /** create = `switch -c`, track = `switch --track` (remote-tracking branch). */
  gitSwitch(folder: string, name: string, opts?: { create?: boolean; track?: boolean }): Promise<GitResult>

  clipboardRead(): Promise<string>
  clipboardReadForPaste(): Promise<PasteContent>
  clipboardWrite(text: string): Promise<void>
  ptyCreate(req: PtyCreateRequest): Promise<Result>
  getElevator(): Promise<ElevatorInfo>
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyKill(id: string): void
  /** Attaches this renderer to a pty main spawned (agent tabs); returns its output so far. Afterwards pty:data flows as usual. */
  ptyAttach(id: string): Promise<Result<{ backlog: string }>>
  /** Main asks for an agent tab. The callback runs synchronously; its result is sent back as the reply. */
  onAgentOpenTab(cb: (req: AgentTabRequest) => Result): () => void
  /** Main closed an agent terminal (close_terminal): drop its tab. */
  onAgentCloseTab(cb: (id: string) => void): () => void
  onPtyData(cb: (id: string, data: string) => void): () => void
  onPtyExit(cb: (id: string, exitCode: number) => void): () => void
}
