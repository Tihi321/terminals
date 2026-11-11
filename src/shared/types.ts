/** Current on-disk schema version. Files without a `version` field are version 1. */
export const SCHEMA_VERSION = 2

export interface Settings {
  /** Shell executable. Empty string = auto (pwsh.exe if on PATH, else powershell.exe). */
  shell: string
  /** Editor executable resolved on PATH (default "zed"). Falls back to shell.openPath. */
  editor: string
  terminalFontSize: number
}

export interface UiState {
  sidebarWidth: number
  panelWidth: number
  panelOpen: boolean
  panelTab: 'files' | 'commands'
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

export interface AppState {
  folders: FolderView[]
  groups: GroupView[]
  commands: Command[]
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

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

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
  setSettings(patch: Partial<Settings>): Promise<AppState>
  setUi(patch: Partial<UiState>): Promise<AppState>
  pickFolder(): Promise<string | null>

  openInWindowsTerminal(path: string): Promise<void>
  openInExplorer(path: string): Promise<void>
  openInEditor(path: string): Promise<void>
  openDefault(path: string): Promise<void>
  revealInExplorer(path: string): Promise<void>
  listDir(path: string, showIgnored: boolean): Promise<Result<{ entries: DirEntry[] }>>
  watchDirs(paths: string[]): void
  onFsChanged(cb: (dir: string) => void): () => void

  clipboardRead(): Promise<string>
  clipboardWrite(text: string): Promise<void>
  ptyCreate(req: PtyCreateRequest): Promise<Result>
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyKill(id: string): void
  onPtyData(cb: (id: string, data: string) => void): () => void
  onPtyExit(cb: (id: string, exitCode: number) => void): () => void
}
