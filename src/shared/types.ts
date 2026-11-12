/** Current on-disk schema version. Files without a `version` field are version 1. */
export const SCHEMA_VERSION = 3

export interface Settings {
  /** Shell executable. Empty string = auto (pwsh.exe if on PATH, else powershell.exe). */
  shell: string
  /** Editor executable resolved on PATH (default "zed"). Falls back to shell.openPath. */
  editor: string
  terminalFontSize: number
}

/** Side-by-side panes: location ids in order, width fractions (sum 1) and the focused index. */
export interface PersistedPanes {
  locIds: string[]
  fractions: number[]
  focused: number
}

export interface UiState {
  sidebarWidth: number
  panelWidth: number
  sidebarCollapsed: boolean
  /** Null until a layout has been saved; the renderer then starts with one pane on the selection. */
  panes: PersistedPanes | null
  panelOpen: boolean
  panelTab: 'files' | 'commands' | 'git'
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
  /** Parent-folder groups only. */
  path: string | null
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
  /** Absolute directory the steps run in. */
  cwd: string
  steps: string[]
}

export interface Command {
  id: string
  name: string
  /** Folder, child or group id. */
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

export interface AppState {
  folders: FolderView[]
  groups: GroupView[]
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
}

/** In-app file viewer payload: text, an image as a data URL, or a marker for binary/too-large files. */
export type FileContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary'; reason: 'binary' | 'large' }

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

export interface TerminalsApi {
  getState(): Promise<AppState>
  addFolder(): Promise<AppState>
  addParentGroup(): Promise<AppState>
  addGroup(name: string): Promise<AppState>
  removeFolder(id: string): Promise<AppState>
  removeGroup(id: string): Promise<AppState>
  renameFolder(id: string, name: string): Promise<AppState>
  renameGroup(id: string, name: string): Promise<AppState>
  /** Move a folder into a manual group (or out with null), optionally before another folder. */
  moveFolder(id: string, groupId: string | null, beforeId?: string): Promise<AppState>
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
  setUi(patch: Partial<UiState>): Promise<AppState>
  pickFolder(): Promise<string | null>

  openInWindowsTerminal(path: string): Promise<void>
  openInExplorer(path: string): Promise<void>
  openInEditor(path: string): Promise<void>
  openDefault(path: string): Promise<void>
  revealInExplorer(path: string): Promise<void>
  listDir(path: string, showIgnored: boolean): Promise<Result<{ entries: DirEntry[] }>>
  readFile(path: string): Promise<Result<{ content: FileContent }>>
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
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyKill(id: string): void
  onPtyData(cb: (id: string, data: string) => void): () => void
  onPtyExit(cb: (id: string, exitCode: number) => void): () => void
}
