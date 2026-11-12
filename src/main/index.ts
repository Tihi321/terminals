import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import icon from '../../build/icon.png?asset'
import type { IPty } from '@lydell/node-pty'
import type { Command, PasteContent, PtyCreateRequest, Settings, Snippet, UiState } from '../shared/types'
import { spawnShell, spawnSteps } from './pty'
import * as store from './store'
import { runSmoke } from './smoke'
import { DirWatcher, listDir, openInEditor } from './fsops'

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
/** Keep in sync with --bg-chrome and --bg-term in the renderer's styles.css. */
const BAR_COLOR = '#131315'
const WINDOW_BG = '#18181b'

const ptys = new Map<string, IPty>()
let win: BrowserWindow | null = null
const watcher = new DirWatcher((dir) => {
  if (win && !win.isDestroyed()) win.webContents.send('fs:changed', dir)
})

function killAllPtys(): void {
  for (const p of ptys.values()) {
    try {
      p.kill()
    } catch {
      /* already dead */
    }
  }
  ptys.clear()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 440,
    title: 'Terminals',
    icon,
    backgroundColor: WINDOW_BG,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BAR_COLOR, symbolColor: '#a4a4ad', height: 36 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
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
  win.on('closed', () => {
    win = null
    watcher.closeAll()
  })
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
  ipcMain.handle('groups:addManual', (_e, name: string) => store.addManualGroup(String(name ?? '')))
  ipcMain.handle('folders:remove', (_e, id: string) => store.removeFolder(id))
  ipcMain.handle('groups:remove', (_e, id: string) => store.removeGroup(id))
  ipcMain.handle('folders:rename', (_e, id: string, name: string) => store.renameFolder(id, String(name)))
  ipcMain.handle('groups:rename', (_e, id: string, name: string) => store.renameGroup(id, String(name)))
  ipcMain.handle('folders:move', (_e, id: string, groupId: string | null, beforeId?: string) =>
    store.moveFolder(id, groupId, beforeId)
  )
  ipcMain.handle('groups:collapsed', (_e, id: string, c: boolean) => store.setGroupCollapsed(id, c))
  ipcMain.handle('groups:showHidden', (_e, id: string, s: boolean) => store.setShowHidden(id, s))
  ipcMain.handle('groups:childHidden', (_e, id: string, path: string, h: boolean) =>
    store.setChildHidden(id, String(path), h)
  )
  ipcMain.handle('commands:save', (_e, cmd: Command) => store.saveCommand(cmd))
  ipcMain.handle('commands:delete', (_e, id: string) => store.deleteCommand(id))
  ipcMain.handle('snippets:save', (_e, s: Snippet) => store.saveSnippet(s))
  ipcMain.handle('snippets:delete', (_e, id: string) => store.deleteSnippet(id))
  ipcMain.handle('folders:addPaths', (_e, paths: string[], groupId: string | null, beforeId?: string) =>
    store.addFolderPaths(Array.isArray(paths) ? paths : [], typeof groupId === 'string' ? groupId : null, beforeId)
  )
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => store.setSettings(patch))
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
  ipcMain.on('fs:watch', (_e, paths: string[]) => {
    watcher.sync((Array.isArray(paths) ? paths : []).filter(allowed).map((p) => resolve(p)))
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:readForPaste', () => readForPaste())
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(String(text)))

  ipcMain.handle('pty:create', (e, req: PtyCreateRequest) => {
    if (typeof req?.cwd !== 'string' || !existsSync(req.cwd) || !statSync(req.cwd).isDirectory())
      return { ok: false, error: 'Folder does not exist' }
    if (!store.isInsideRoots(req.cwd) && !store.isCommandCwd(req.cwd))
      return { ok: false, error: 'Folder is not a saved folder' }
    if (ptys.has(req.id)) return { ok: false, error: 'Duplicate terminal id' }
    const handlers = {
      onData: (data: string): void => {
        if (!e.sender.isDestroyed()) e.sender.send('pty:data', req.id, data)
      },
      onExit: (code: number): void => {
        ptys.delete(req.id)
        if (!e.sender.isDestroyed()) e.sender.send('pty:exit', req.id, code)
      }
    }
    const cols = Math.max(req.cols, 2)
    const rows = Math.max(req.rows, 1)
    try {
      const p = Array.isArray(req.steps)
        ? spawnSteps(store.getShell(), req.steps.map(String), req.cwd, cols, rows, handlers)
        : spawnShell(store.getShell(), req.cwd, cols, rows, handlers)
      ptys.set(req.id, p)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.get(id)?.write(String(data)))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    try {
      if (cols > 0 && rows > 0) ptys.get(id)?.resize(Math.floor(cols), Math.floor(rows))
    } catch {
      /* pty may have just exited */
    }
  })
  ipcMain.on('pty:kill', (_e, id: string) => {
    const p = ptys.get(id)
    ptys.delete(id)
    try {
      p?.kill()
    } catch {
      /* already dead */
    }
  })
}

if (SMOKE) {
  app.whenReady().then(runSmoke)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    store.loadStore()
    prunePasteDir()
    registerIpc()
    createWindow()
  })
  app.on('before-quit', killAllPtys)
  app.on('window-all-closed', () => {
    killAllPtys()
    app.quit()
  })
}
