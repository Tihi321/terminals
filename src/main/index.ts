import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray, webContents } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import icon from '../../build/icon.png?asset'
import type { IPty } from '@lydell/node-pty'
import { HOME_ID, type AgentTabRequest, type Command, type PasteContent, type PtyCreateRequest, type Result, type Settings, type Snippet, type UiState } from '../shared/types'
import { listShells, resolveShell, spawnElevated, spawnShell, spawnSteps, stepsShell } from './pty'
import { checkElevatedRequest, elevatedCommand, readSudoMode, resolveElevator } from './elevation'
import { GSUDO_HINT } from '../shared/elevation'
import type { AppState, CopyResult, ElevatorInfo } from '../shared/types'
import { getTheme, resolveThemeId, windowColors, type Theme } from '../shared/themes'
import * as store from './store'
import { runSmoke } from './smoke'
import { copyIntoDir, createFolderIn } from './fsCopy'
import { DirWatcher, listDir, openInEditor, readFileContent, writeTextFile } from './fsops'
import * as gitcli from './gitcli'
import { isMainWorktree, readGit } from './git'
import * as worktree from './worktree'
import type { GitDiffRequest, LoginItemState } from '../shared/types'
import { startMcpServer, type McpInfo } from './mcp'
import { locationById, ToolError } from './mcpTools'
import { TerminalHost } from './terminalHost'
import { isTerminalReply } from './termText'
import * as claudeHooks from './claudeHooks'

// Must run before app is ready: lets tests/dev runs use an isolated data directory.
const dataDirArg = process.argv.find((a) => a.startsWith('--data-dir='))?.slice('--data-dir='.length)
const dataDir = dataDirArg || process.env.TERMINALS_DATA_DIR
if (dataDir) {
  const abs = resolve(dataDir)
  mkdirSync(abs, { recursive: true })
  app.setPath('userData', abs)
} else {
  // Pin to the dev location so a packaged build (productName "Terminals") keeps using %APPDATA%\terminals.
  app.setPath('userData', join(app.getPath('appData'), 'terminals'))
}

const SMOKE = process.argv.includes('--smoke') || process.env.TERMINALS_SMOKE === '1'

const ptys = new Map<string, IPty>()
/** webContents id -> ids of the ptys it created, so a reloaded or destroyed renderer does not leave shells behind. */
const owners = new Map<number, Set<string>>()
/** Null until the MCP server listens (or when it failed to start). */
let mcp: McpInfo | null = null
let win: BrowserWindow | null = null
let tray: Tray | null = null
/** True once the app is really quitting; until then closing the window only hides it. */
let quitting = false
const watcher = new DirWatcher((dir) => {
  if (win && !win.isDestroyed()) win.webContents.send('fs:changed', dir)
})

/** Ids whose output is forwarded to the renderer as pty:data: ptys main spawned for agent tabs, once the tab attached. */
const attached = new Set<string>()
/** Ptys registered with the terminal host -> owning webContents id, and whether main (not the renderer) spawned them. */
const hosted = new Map<string, { wc: number; byHost: boolean }>()
/** open_terminal round trips waiting for the renderer's reply. */
const pendingTabs = new Map<string, (r: Result) => void>()
const OPEN_TAB_TIMEOUT_MS = 5000

/** Ids of ptys running an elevated shell; they get a graceful exit before the console is closed. */
const elevatedIds = new Set<string>()
/** webContents id -> time of its last elevated create attempt (rate limit). */
const lastElevatedCreate = new Map<number, number>()

function killAllPtys(): void {
  for (const id of hosted.keys()) host.remove(id)
  hosted.clear()
  attached.clear()
  for (const p of ptys.values()) {
    try {
      p.kill()
    } catch {
      /* already dead */
    }
  }
  ptys.clear()
  owners.clear()
  elevatedIds.clear()
}

/**
 * Removes the pty from the maps at once (frees the id, drops further writes), then kills it. An elevated shell
 * first gets Ctrl+C and `exit` so it can quit on its own; the real kill follows 400 ms later.
 */
function releasePty(id: string): void {
  const p = ptys.get(id)
  ptys.delete(id)
  disown(id)
  host.remove(id)
  attached.delete(id)
  hosted.delete(id)
  const elevated = elevatedIds.delete(id)
  if (!p) return
  const kill = (): void => {
    try {
      p.kill()
    } catch {
      /* already dead */
    }
  }
  if (!elevated) return kill()
  try {
    p.write('\x03')
    p.write('exit\r')
  } catch {
    /* already dead */
  }
  setTimeout(kill, 400)
}

function disown(id: string): void {
  for (const [wc, set] of owners) {
    if (set.delete(id) && set.size === 0) owners.delete(wc)
  }
}

/** Kills and forgets every pty created by the given webContents. */
function killPtysOf(wcId: number): void {
  const set = owners.get(wcId)
  owners.delete(wcId)
  if (set) for (const id of [...set]) releasePty(id)
  host.forgetOwner(wcId)
  for (const [id, h] of hosted) if (h.wc === wcId) hosted.delete(id)
}

/** open_terminal reveal: selects the location (the renderer's panes follow) and brings the window to the front. */
function revealLocation(locId: string): void {
  store.select(locId)
  pushState()
  showWindow()
}

/**
 * Asks the renderer to show a tab for an agent pty main already spawned. Shows or focuses the window only with req.reveal.
 * Rejects with a ToolError when there is no window or the renderer does not answer in time.
 */
function openAgentTab(req: Omit<AgentTabRequest, 'reqId'>): Promise<Result> {
  const w = win
  if (!w || w.isDestroyed()) return Promise.reject(new ToolError('The Terminals window is not available.'))
  const reqId = randomUUID()
  return new Promise<Result>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pendingTabs.delete(reqId)
      reject(new ToolError('The Terminals window did not answer; it may still be loading. Try again.'))
    }, OPEN_TAB_TIMEOUT_MS)
    pendingTabs.set(reqId, (r) => {
      clearTimeout(timer)
      if (r.ok && req.reveal) revealLocation(req.locId)
      resolvePromise(r)
    })
    w.webContents.send('agent:openTab', { ...req, reqId })
  })
}

function closeAgentTab(id: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('agent:closeTab', id)
}

/** Spawns a plain (never elevated) shell for an agent tab, owned by the window. Output reaches the renderer once it attached. */
function spawnForHost(id: string, shellExe: string, locId: string, cwd: string, cols: number, rows: number): IPty {
  const w = win
  if (!w || w.isDestroyed()) throw new ToolError('The Terminals window is not available.')
  const wc = w.webContents
  const wcId = wc.id
  let spawned: IPty | null = null
  const p = spawnShell(
    shellExe,
    cwd,
    cols,
    rows,
    {
      onData: (data: string): void => {
        host.data(id, data)
        if (attached.has(id) && !wc.isDestroyed()) wc.send('pty:data', id, data)
      },
      onExit: (code: number): void => {
        const current = ptys.get(id)
        if (current !== undefined && current !== spawned) return
        if (current !== undefined) {
          ptys.delete(id)
          disown(id)
        }
        host.exit(id, code)
        if (attached.has(id) && !wc.isDestroyed()) wc.send('pty:exit', id, code)
      }
    },
    ptyEnv(locId, id)
  )
  spawned = p
  ptys.set(id, p)
  const mine = owners.get(wcId) ?? new Set<string>()
  mine.add(id)
  owners.set(wcId, mine)
  hosted.set(id, { wc: wcId, byHost: true })
  return p
}

const host = new TerminalHost({
  spawn: spawnForHost,
  openTab: openAgentTab,
  closeTab: closeAgentTab,
  release: (id) => releasePty(id),
  configuredShell: () => store.getShell(),
  ownerWc: () => (win && !win.isDestroyed() ? win.webContents.id : null),
  onStatus: (id, s) => {
    const h = hosted.get(id)
    const wc = h && webContents.fromId(h.wc)
    if (wc && !wc.isDestroyed()) wc.send('term:status', id, s)
  },
  heuristics: () => store.getSettings().agentHeuristics
})

/** The portable build runs from a temp extraction dir, so it must register the original exe instead of process.execPath. */
function loginItemPath(): { path?: string } {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  return portable ? { path: portable } : {}
}

/** Windows starts the login item with this flag so the app stays in the tray. It must match on set and get. */
const HIDDEN_ARG = '--hidden'
const startHidden = process.argv.includes(HIDDEN_ARG)

function loginItemQuery(): { path?: string; args: string[] } {
  return { ...loginItemPath(), args: [HIDDEN_ARG] }
}

/** Entries written before --hidden existed have no args; re-register them so login starts in the tray. */
function migrateLoginItem(): void {
  if (!app.isPackaged) return
  const old = app.getLoginItemSettings(loginItemPath())
  if (old.executableWillLaunchAtLogin ?? old.openAtLogin) app.setLoginItemSettings({ openAtLogin: true, ...loginItemQuery() })
}

/** "Open at login" as the OS reports it (the user may have changed it in Task Manager > Startup). */
function readLoginItem(): LoginItemState {
  if (!app.isPackaged) return { enabled: false, supported: false }
  // executableWillLaunchAtLogin also reflects Task Manager > Startup; openAtLogin only checks the Run key exists.
  const s = app.getLoginItemSettings(loginItemQuery())
  return { enabled: s.executableWillLaunchAtLogin ?? s.openAtLogin, supported: true }
}

function currentTheme(): Theme {
  return getTheme(resolveThemeId(store.getSettings().theme, nativeTheme.shouldUseDarkColors))
}

/** Re-colours the native window background and title bar overlay to match the current theme. */
function applyWindowTheme(): void {
  if (!win || win.isDestroyed()) return
  const c = windowColors(currentTheme())
  win.setBackgroundColor(c.background)
  try {
    win.setTitleBarOverlay({ color: c.titleBar, symbolColor: c.symbol, height: 36 })
  } catch {
    /* overlay unsupported */
  }
}

function createWindow(hidden = false): void {
  const c = windowColors(currentTheme())
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 440,
    title: 'Terminals',
    show: !hidden,
    icon,
    backgroundColor: c.background,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.titleBar, symbolColor: c.symbol, height: 36 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // A reload, a crashed renderer or a destroyed window ends that renderer's ptys (the restored session starts new ones).
  // The id is captured now because webContents.id cannot be read after destroy.
  const wcId = win.webContents.id
  win.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) killPtysOf(wcId)
  })
  win.webContents.on('render-process-gone', () => killPtysOf(wcId))
  win.webContents.on('destroyed', () => killPtysOf(wcId))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => {
    // Allow only the dev server reload; block everything else.
    if (!process.env.ELECTRON_RENDERER_URL || !e.url.startsWith(process.env.ELECTRON_RENDERER_URL)) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('close', (e) => {
    // Hide to the tray so the running terminals stay alive.
    if (quitting) return
    e.preventDefault()
    win?.hide()
  })
  win.on('closed', () => {
    win = null
    watcher.closeAll()
  })
}

/** Brings the window back from the tray or minimized state, recreating it if it was destroyed. */
function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Terminals')
  tray.on('click', () => {
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) win.hide()
    else showWindow()
  })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Terminals', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: (): void => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

const PASTE_DIR = (): string => join(app.getPath('temp'), 'terminals-paste')

/** Removes pasted clipboard images older than 24h. */
function prunePasteDir(): void {
  const dir = PASTE_DIR()
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* dir does not exist yet */
  }
}

/**
 * Electron 45 only has the async W3C-style clipboard (readImage/readBuffer are gone). Files copied in Explorer
 * show up as a "text/uri-list" entry of file: URLs.
 */
async function readClipboardFiles(items: Electron.ClipboardItem[]): Promise<string[]> {
  const out: string[] = []
  for (const it of items) {
    if (!it.types.includes('text/uri-list')) continue
    try {
      const text = await (await it.getType('text/uri-list')).text()
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('file:')) continue
        const p = fileURLToPath(line.trim())
        if (existsSync(p)) out.push(p)
      }
    } catch {
      /* unreadable entry */
    }
  }
  return out
}

async function readClipboardImage(items: Electron.ClipboardItem[]): Promise<Buffer | null> {
  for (const it of items) {
    const type = it.types.includes('image/png') ? 'image/png' : it.types.find((t) => t.startsWith('image/'))
    if (!type) continue
    try {
      const buf = Buffer.from(await ((await it.getType(type)) as Blob).arrayBuffer())
      if (type === 'image/png') return buf
      const img = nativeImage.createFromBuffer(buf)
      if (!img.isEmpty()) return img.toPNG()
    } catch {
      /* unreadable entry */
    }
  }
  return null
}

async function readForPaste(): Promise<PasteContent> {
  let items: Electron.ClipboardItem[] = []
  try {
    items = await clipboard.read()
  } catch {
    /* fall through to text */
  }
  const files = await readClipboardFiles(items)
  if (files.length > 0) return { kind: 'files', paths: files }
  const png = await readClipboardImage(items)
  if (png) {
    const dir = PASTE_DIR()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `paste-${Date.now()}.png`)
    writeFileSync(path, png)
    return { kind: 'image', path }
  }
  return { kind: 'text', text: await clipboard.readText() }
}

async function pickFolder(): Promise<string | null> {
  const opts = { properties: ['openDirectory' as const] }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

/** Sends the store's state to the renderer after a change it did not make itself (MCP tool calls). */
function pushState(): void {
  if (win && !win.isDestroyed()) win.webContents.send('state:changed', store.getState())
}

/**
 * Per-terminal MCP context. All six are always set (empty when unknown) so values inherited from a parent
 * process, e.g. this app started from another instance's terminal, never leak through.
 */
function ptyEnv(locId: unknown, termId: string): Record<string, string> {
  const loc = mcp && typeof locId === 'string' && locId ? locationById(store.getState(), locId) : null
  return {
    TERMINALS_MCP_URL: mcp?.url ?? '',
    TERMINALS_MCP_TOKEN: mcp?.token ?? '',
    TERMINALS_LOC_ID: loc?.id ?? '',
    TERMINALS_LOC_PATH: loc?.path ?? '',
    TERMINALS_TERM_ID: termId,
    TERMINALS_STATUS_URL: mcp?.statusUrl ?? ''
  }
}

/** Paths the renderer asks to list/open must be inside a saved folder or group root. */
function allowed(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && store.isInsideRoots(p)
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => store.getState())
  ipcMain.handle('state:select', (_e, id: string | null) => store.select(id))
  ipcMain.handle('folders:add', async () => {
    const p = await pickFolder()
    return p ? store.addFolder(p) : store.getState()
  })
  ipcMain.handle('groups:addParent', async () => {
    const p = await pickFolder()
    return p ? store.addParentGroup(p) : store.getState()
  })
  ipcMain.handle('groups:addManual', (_e, name: string, parentId?: string | null) =>
    store.addManualGroup(String(name ?? ''), typeof parentId === 'string' ? parentId : null)
  )
  ipcMain.handle('groups:move', (_e, id: string, parentId: string | null) =>
    store.moveGroup(String(id), typeof parentId === 'string' ? parentId : null)
  )
  ipcMain.handle('folders:remove', (_e, id: string) => store.removeFolder(id))
  ipcMain.handle('groups:remove', (_e, id: string) => store.removeGroup(id))
  ipcMain.handle('folders:rename', (_e, id: string, name: string) => store.renameFolder(id, String(name)))
  ipcMain.handle('groups:rename', (_e, id: string, name: string) => store.renameGroup(id, String(name)))
  ipcMain.handle('folders:move', (_e, id: string, groupId: string | null, beforeId?: string) =>
    store.moveFolder(id, groupId, beforeId)
  )
  ipcMain.handle('items:move', (_e, id: string, dir: number) => store.moveItem(String(id), dir === -1 ? -1 : 1))
  ipcMain.handle('items:nest', (_e, id: string, dir: number) => store.nestItem(String(id), dir === -1 ? -1 : 1))
  ipcMain.handle('items:pin', (_e, id: string, pinned: boolean) => store.setPinned(String(id), !!pinned))
  ipcMain.handle('groups:collapsed', (_e, id: string, c: boolean) => store.setGroupCollapsed(id, c))
  ipcMain.handle('groups:showHidden', (_e, id: string, s: boolean) => store.setShowHidden(id, s))
  ipcMain.handle('groups:childHidden', (_e, id: string, path: string, h: boolean) =>
    store.setChildHidden(id, String(path), h)
  )
  ipcMain.handle('commands:save', (_e, cmd: Command) => store.saveCommand(cmd))
  ipcMain.handle('commands:delete', (_e, id: string) => store.deleteCommand(id))
  ipcMain.handle('snippets:save', (_e, s: Snippet) => store.saveSnippet(s))
  ipcMain.handle('snippets:delete', (_e, id: string) => store.deleteSnippet(id))
  ipcMain.handle('commands:reorder', (_e, ids: string[]) => store.reorderCommands(ids))
  ipcMain.handle('snippets:reorder', (_e, ids: string[]) => store.reorderSnippets(ids))
  ipcMain.handle('folders:addPaths', (_e, paths: string[], groupId: string | null, beforeId?: string) =>
    store.addFolderPaths(Array.isArray(paths) ? paths : [], typeof groupId === 'string' ? groupId : null, beforeId)
  )
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const s = store.setSettings(patch)
    applyWindowTheme()
    return s
  })
  ipcMain.handle('settings:shells', () => listShells())
  ipcMain.handle('login:get', (): LoginItemState => readLoginItem())
  ipcMain.handle('login:set', (_e, enabled: boolean): LoginItemState => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!enabled, ...loginItemQuery() })
    return readLoginItem()
  })
  ipcMain.on('theme:initial', (e) => {
    e.returnValue = resolveThemeId(store.getSettings().theme, nativeTheme.shouldUseDarkColors)
  })
  ipcMain.handle('ui:set', (_e, patch: Partial<UiState>) => store.setUi(patch))
  ipcMain.handle('dialog:pickFolder', () => pickFolder())

  ipcMain.handle('shell:openWt', (_e, p: string) => {
    if (!allowed(p)) return
    const child = spawn('wt.exe', ['-d', p], { detached: true, stdio: 'ignore' })
    child.on('error', (err) => console.error('wt.exe failed', err))
    child.unref()
  })
  ipcMain.handle('shell:openExplorer', async (_e, p: string) => {
    if (allowed(p)) await shell.openPath(resolve(p))
  })
  ipcMain.handle('shell:openEditor', async (_e, p: string) => {
    if (allowed(p)) await openInEditor(store.getEditor(), resolve(p))
  })
  ipcMain.handle('shell:openDefault', async (_e, p: string) => {
    if (allowed(p)) await shell.openPath(resolve(p))
  })
  ipcMain.handle('shell:reveal', (_e, p: string) => {
    if (!allowed(p)) return
    // shell.showItemInFolder is equivalent, but the brief asks for `explorer /select,`.
    const child = spawn('explorer.exe', [`/select,${resolve(p)}`], { detached: true, stdio: 'ignore' })
    child.on('error', () => shell.showItemInFolder(resolve(p)))
    child.unref()
  })
  ipcMain.handle('fs:list', (_e, p: string, showIgnored: boolean) =>
    allowed(p) ? listDir(resolve(p), !!showIgnored) : { ok: false, error: 'Path is outside the saved folders' }
  )
  ipcMain.handle('fs:read', (_e, p: string) =>
    allowed(p) ? readFileContent(resolve(p)) : { ok: false as const, error: 'Path is outside the saved folders' }
  )
  ipcMain.handle('fs:write', (_e, p: string, text: string, mtimeMs: number, force: boolean) =>
    allowed(p)
      ? writeTextFile(resolve(p), String(text), Number(mtimeMs), !!force)
      : { ok: false as const, error: 'Path is outside the saved folders' }
  )
  ipcMain.on('fs:watch', (_e, paths: string[]) => {
    watcher.sync((Array.isArray(paths) ? paths : []).filter(allowed).map((p) => resolve(p)))
  })

  const notAllowed = { ok: false as const, error: 'Folder is not a saved folder' }
  ipcMain.handle('git:status', (_e, f: string) => (allowed(f) ? gitcli.gitStatus(f) : notAllowed))
  ipcMain.handle('git:diff', (_e, f: string, req: GitDiffRequest) => (allowed(f) ? gitcli.gitDiff(f, req) : notAllowed))
  ipcMain.handle('git:stage', (_e, f: string, paths: string[] | null) =>
    allowed(f) ? gitcli.gitStage(f, paths === null ? null : Array.isArray(paths) ? paths : []) : notAllowed
  )
  ipcMain.handle('git:unstage', (_e, f: string, paths: string[] | null) =>
    allowed(f) ? gitcli.gitUnstage(f, paths === null ? null : Array.isArray(paths) ? paths : []) : notAllowed
  )
  ipcMain.handle('git:commit', (_e, f: string, msg: string, tracked: boolean) =>
    allowed(f) ? gitcli.gitCommit(f, msg, !!tracked) : notAllowed
  )
  ipcMain.handle('git:log', (_e, f: string) => (allowed(f) ? gitcli.gitLog(f) : notAllowed))
  ipcMain.handle('git:commitFiles', (_e, f: string, hash: string) => (allowed(f) ? gitcli.gitCommitFiles(f, hash) : notAllowed))
  ipcMain.handle('git:fetch', (_e, f: string) => (allowed(f) ? gitcli.gitFetch(f) : notAllowed))
  ipcMain.handle('git:pull', (_e, f: string) => (allowed(f) ? gitcli.gitPull(f) : notAllowed))
  ipcMain.handle('git:push', (_e, f: string, publish?: boolean) => (allowed(f) ? gitcli.gitPush(f, !!publish) : notAllowed))
  ipcMain.handle('git:branches', (_e, f: string) => (allowed(f) ? gitcli.gitBranches(f) : notAllowed))
  ipcMain.handle('git:switch', (_e, f: string, name: string, opts?: { create?: boolean; track?: boolean }) =>
    allowed(f) ? gitcli.gitSwitch(f, name, { create: !!opts?.create, track: !!opts?.track }) : notAllowed
  )
  ipcMain.handle('git:baseChanges', async (_e, f: string) => {
    if (!allowed(f)) return notAllowed
    const rr = await gitcli.repoRoot(f)
    if (!rr.ok) return rr
    const rb = await worktree.resolveBase(rr.root, store.getRepoBase(rr.root))
    if (!rb.ok) return rb
    const r = await gitcli.gitBaseChanges(f, rb.base)
    return r.ok ? { ok: true as const, changes: { ...r.changes, baseIsSet: rb.baseIsSet } } : r
  })
  ipcMain.handle('git:setBase', async (_e, f: string, base: string | null) => {
    if (!allowed(f)) return store.getState()
    const rr = await gitcli.repoRoot(f)
    if (!rr.ok) return store.getState()
    if (base === null || base === undefined || base === '') return store.setRepoBase(rr.root, null)
    if (typeof base !== 'string' || base.startsWith('-') || base.includes('\0')) return store.getState()
    const ok = await gitcli.run(rr.root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
    return ok.code === 0 ? store.setRepoBase(rr.root, base) : store.getState()
  })

  // ---------- worktrees ----------
  ipcMain.handle('worktree:add', async (_e, repo: string, branch: string, base: string | null) => {
    if (!allowed(repo)) return { ok: false as const, error: 'Folder is not a saved folder' }
    if (!isMainWorktree(repo)) return { ok: false as const, error: 'Worktrees can only be created from a main working tree' }
    const baseRef = typeof base === 'string' && base.trim() ? base.trim() : null
    const r = await worktree.addWorktree(repo, String(branch ?? ''), baseRef, store.getSettings().worktreeLayout)
    if (!r.ok) return r
    // Remember what the branch was cut from (only when this call created it).
    if (r.created) {
      const cur = readGit(repo).branch
      const from = baseRef ?? (cur && !cur.startsWith('detached @') ? cur : null)
      if (from) store.setRepoBase(r.path, from)
    }
    return { ok: true as const, id: store.worktreeId(r.path), path: r.path, state: store.getState() }
  })
  ipcMain.handle('worktree:status', (_e, path: string) =>
    allowed(path) && store.findWorktree(path) ? worktree.worktreeStatus(path) : { ok: false as const, error: 'Not a known worktree' }
  )
  ipcMain.handle('worktree:remove', async (_e, path: string, opts: { force?: boolean; deleteBranch?: boolean }) => {
    const found = allowed(path) ? store.findWorktree(path) : null
    if (!found) return { ok: false as const, error: 'Not a known worktree' }
    const r = await worktree.removeWorktree(found.repo, path, { force: !!opts?.force, deleteBranch: !!opts?.deleteBranch })
    if (!r.ok) return r
    store.forgetWorktree(path, found.repoLocId)
    return { ok: true as const, state: store.getState(), ...(r.branchError ? { branchError: r.branchError } : {}) }
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:readForPaste', () => readForPaste())
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(String(text)))

  ipcMain.handle('groups:setFolder', (_e, id: string, folder: string | null) =>
    store.setGroupFolder(String(id), typeof folder === 'string' && folder ? folder : null)
  )
  ipcMain.handle('fs:createFolder', (_e, parentDir: string, name: string, groupId: string | null): Result<{ path: string; state: AppState }> => {
    if (!allowed(parentDir)) return { ok: false, error: 'That folder is not part of the workspace' }
    const r = createFolderIn(parentDir, String(name ?? ''))
    if (!r.ok) return r
    if (typeof groupId === 'string' && groupId) store.createFolders([r.path], groupId)
    return { ok: true, path: r.path, state: store.getState() }
  })
  ipcMain.handle('fs:copyInto', (_e, paths: string[], destDir: string): CopyResult => {
    if (!allowed(destDir)) return { ok: false, error: 'That folder is not part of the workspace' }
    return copyIntoDir(Array.isArray(paths) ? paths.filter((x) => typeof x === 'string') : [], destDir)
  })
  ipcMain.handle('fs:exists',(_e, paths: string[]) =>
    (Array.isArray(paths) ? paths.slice(0, 500) : []).map((p) => typeof p === 'string' && store.isInsideRoots(p) && existsSync(p))
  )

  ipcMain.handle('pty:elevator', (): ElevatorInfo => {
    const elev = resolveElevator({ env: process.env, exists: existsSync, sudoMode: readSudoMode })
    if (!elev) return { available: false, tool: null, hint: 'Install gsudo: ' + GSUDO_HINT }
    return { available: true, tool: elev.tool, hint: elev.tool === 'gsudo' ? 'Runs via gsudo' : 'Runs via Windows sudo' }
  })
  ipcMain.handle('pty:create', (e, req: PtyCreateRequest) => {
    const wantElevated = req?.elevated === true
    if (wantElevated) {
      const stepsError = checkElevatedRequest(req)
      if (stepsError) return { ok: false, error: stepsError }
    }
    const wantAgent = req?.agent === true && !wantElevated && !Array.isArray(req?.steps)
    // A restored agent tab under Home may sit in any existing directory (open_terminal accepts arbitrary ones).
    const homeAgent = wantAgent && req?.locId === HOME_ID
    const cwdError = (c: unknown): string | null => {
      if (typeof c !== 'string' || !existsSync(c) || !statSync(c).isDirectory()) return 'Folder does not exist'
      if (!homeAgent && !store.isInsideRoots(c) && !store.isCommandCwd(c)) return 'Folder is not a saved folder'
      return null
    }
    let cwd = req?.cwd
    const err = cwdError(cwd)
    if (err) {
      if (!Array.isArray(req?.steps) && typeof req?.fallbackCwd === 'string' && cwdError(req.fallbackCwd) === null) cwd = req.fallbackCwd
      else return { ok: false, error: err }
    }
    if (ptys.has(req.id)) return { ok: false, error: 'Duplicate terminal id' }
    // Only the configured shell or a known available one may be requested by the renderer.
    const configured = store.getShell()
    const wanted = typeof req.shell === 'string' ? req.shell.toLowerCase() : ''
    const shellOk =
      wanted !== '' &&
      (wanted === configured.toLowerCase() ||
        listShells().some((s) => s.available && s.value !== '' && resolveShell(s.value).toLowerCase() === wanted))
    const shellExe = shellOk ? (req.shell as string) : configured
    let elevatedCmd: { file: string; args: string[] } | null = null
    if (wantElevated) {
      const now = Date.now()
      const last = lastElevatedCreate.get(e.sender.id)
      if (last !== undefined && now - last < 1500) return { ok: false, error: 'Please wait before starting another admin terminal' }
      const elev = resolveElevator({ env: process.env, exists: existsSync, sudoMode: readSudoMode })
      if (!elev) return { ok: false, error: 'No elevator found. Install gsudo: ' + GSUDO_HINT }
      lastElevatedCreate.set(e.sender.id, now)
      elevatedCmd = elevatedCommand(resolveShell(shellExe), elev)
      if (!elevatedCmd) return { ok: false, error: 'Admin terminals need PowerShell or cmd as the shell' }
    }
    // Only the instance still registered under this id may clean up: a late exit of an old pty (delayed kill)
    // must not remove a newer pty that reuses the id.
    let spawned: IPty | null = null
    const handlers = {
      onData: (data: string): void => {
        host.data(req.id, data)
        if (!e.sender.isDestroyed()) e.sender.send('pty:data', req.id, data)
      },
      onExit: (code: number): void => {
        const current = ptys.get(req.id)
        // A different pty now owns the id (retry reused it): this is a stale exit, ignore it entirely.
        if (current !== undefined && current !== spawned) return
        // current === spawned: normal exit, clean up. current === undefined: released by kill; still report the exit.
        if (current !== undefined) {
          ptys.delete(req.id)
          disown(req.id)
          elevatedIds.delete(req.id)
        }
        host.exit(req.id, code)
        if (!e.sender.isDestroyed()) e.sender.send('pty:exit', req.id, code)
      }
    }
    const cols = Math.max(req.cols, 2)
    const rows = Math.max(req.rows, 1)
    try {
      const env = ptyEnv(req.locId, req.id)
      const p = elevatedCmd
        ? spawnElevated(elevatedCmd.file, elevatedCmd.args, cwd as string, cols, rows, handlers, env)
        : Array.isArray(req.steps)
          ? spawnSteps(stepsShell(store.getShell()), req.steps.map(String), cwd as string, cols, rows, handlers, env)
          : spawnShell(shellExe, cwd as string, cols, rows, handlers, env)
      spawned = p
      ptys.set(req.id, p)
      if (elevatedCmd) elevatedIds.add(req.id)
      hosted.set(req.id, { wc: e.sender.id, byHost: false })
      host.add(req.id, p, {
        locId: typeof req.locId === 'string' ? req.locId : '',
        cwd: cwd as string,
        shell: elevatedCmd ? resolveShell(shellExe) : Array.isArray(req.steps) ? stepsShell(store.getShell()) : shellExe,
        kind: Array.isArray(req.steps) ? 'command' : 'shell',
        agent: wantAgent,
        elevated: wantElevated,
        ownerWc: e.sender.id
      })
      const mine = owners.get(e.sender.id) ?? new Set<string>()
      mine.add(req.id)
      owners.set(e.sender.id, mine)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  const ownsPty = (wcId: number, id: unknown): id is string => typeof id === 'string' && !!owners.get(wcId)?.has(id)
  ipcMain.on('pty:write', (e, id: string, data: string) => {
    if (!ownsPty(e.sender.id, id)) return
    ptys.get(id)?.write(String(data))
    if (!isTerminalReply(String(data))) host.input(id)
  })
  ipcMain.on('pty:resize', (e, id: string, cols: number, rows: number) => {
    if (!ownsPty(e.sender.id, id)) return
    host.resized(id)
    try {
      if (cols > 0 && rows > 0) ptys.get(id)?.resize(Math.floor(cols), Math.floor(rows))
    } catch {
      /* pty may have just exited */
    }
  })
  ipcMain.on('pty:kill', (e, id: string) => {
    if (ownsPty(e.sender.id, id)) return releasePty(id)
    // An exited pty is already disowned: closing its tab only has to drop the host's leftover record.
    if (typeof id === 'string' && hosted.get(id)?.wc === e.sender.id) {
      host.remove(id)
      attached.delete(id)
      hosted.delete(id)
    }
  })
  // Agent tabs: the renderer attaches to a pty main spawned and gets its output so far. Synchronous, so no chunk is lost.
  ipcMain.handle('pty:attach', (e, id: string): Result<{ backlog: string }> => {
    const h = typeof id === 'string' ? hosted.get(id) : undefined
    if (!h || !h.byHost || h.wc !== e.sender.id) return { ok: false, error: 'Unknown terminal' }
    attached.add(id)
    return { ok: true, backlog: host.backlog(id) }
  })
  ipcMain.handle('term:statuses', () => host.statuses())
  ipcMain.on('term:seen', (e, id: string) => {
    if (typeof id === 'string' && hosted.get(id)?.wc === e.sender.id) host.seen(id)
  })
  ipcMain.handle('hooks:get', () => claudeHooks.getHooks())
  ipcMain.handle('hooks:install', () => claudeHooks.installHooks())
  ipcMain.handle('hooks:remove', () => claudeHooks.removeHooks())
  ipcMain.on('agent:openTab:reply', (e, reqId: string, result: Result) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return
    const done = typeof reqId === 'string' ? pendingTabs.get(reqId) : undefined
    if (!done) return
    pendingTabs.delete(reqId)
    const err = (result as { error?: unknown } | undefined)?.error
    done(result && result.ok === true ? { ok: true } : { ok: false, error: String(err ?? 'The window refused the tab') })
  })
}

if (SMOKE) {
  app.whenReady().then(runSmoke)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    store.loadStore()
    try {
      // Refresh the hook script after an update or a data-dir change; settings.json itself is never touched here.
      const h = claudeHooks.getHooks()
      if (h.ok && (h.installed || h.outdated)) claudeHooks.ensureHookScript()
    } catch (e) {
      console.error('Could not refresh the status hook script', e)
    }
    prunePasteDir()
    registerIpc()
    nativeTheme.on('updated', applyWindowTheme)
    // Before the window, so the first terminals already get the MCP env vars.
    try {
      mcp = await startMcpServer({
        dataDir: app.getPath('userData'),
        version: app.getVersion(),
        onChange: pushState,
        terminals: host,
        allowRun: () => store.getSettings().allowMcpRun
      })
      console.log(`MCP server listening on ${mcp.url}`)
    } catch (e) {
      console.error('MCP server failed to start', e)
    }
    // A second-instance launch during the await above may already have created it.
    if (!win) createWindow(startHidden)
    createTray()
    migrateLoginItem()
  })
  app.on('before-quit', () => {
    quitting = true
    killAllPtys()
  })
  app.on('will-quit', () => {
    tray?.destroy()
    tray = null
  })
  app.on('window-all-closed', () => {
    killAllPtys()
    app.quit()
  })
}
