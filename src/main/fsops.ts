import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { DirEntry, FileContent, Result } from '../shared/types'
import { findOnPath } from './pty'

const IGNORED = new Set(['.git', 'node_modules'])

const TEXT_LIMIT = 2 * 1024 * 1024
const IMAGE_LIMIT = 8 * 1024 * 1024
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

/** Reads a file for the in-app viewer: text, a data-URL image, or a "binary/large" marker. */
export function readFileContent(path: string): Result<{ content: FileContent }> {
  try {
    const st = statSync(path)
    if (!st.isFile()) return { ok: false, error: 'Not a file' }
    const mime = IMAGE_MIME[extname(path).toLowerCase()]
    if (mime) {
      if (st.size > IMAGE_LIMIT) return { ok: true, content: { kind: 'binary', reason: 'large' } }
      const data = readFileSync(path)
      return { ok: true, content: { kind: 'image', dataUrl: `data:${mime};base64,${data.toString('base64')}` } }
    }
    if (st.size > TEXT_LIMIT) return { ok: true, content: { kind: 'binary', reason: 'large' } }
    const buf = readFileSync(path)
    if (buf.subarray(0, 8192).includes(0)) return { ok: true, content: { kind: 'binary', reason: 'binary' } }
    return { ok: true, content: { kind: 'text', text: buf.toString('utf8') } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function listDir(dir: string, showIgnored: boolean): Result<{ entries: DirEntry[] }> {
  try {
    const entries: DirEntry[] = []
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!showIgnored && IGNORED.has(ent.name.toLowerCase())) continue
      const path = join(dir, ent.name)
      let isDir = ent.isDirectory()
      if (!isDir && ent.isSymbolicLink()) {
        try {
          isDir = statSync(path).isDirectory()
        } catch {
          /* broken link: treat as file */
        }
      }
      entries.push({ name: ent.name, path, isDir })
    }
    entries.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    )
    return { ok: true, entries }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** Open a file or folder in the configured editor (resolved on PATH); falls back to the OS default. */
export async function openInEditor(editor: string, target: string): Promise<void> {
  const name = editor.trim() || 'zed'
  let exe: string | null = null
  if (/[\\/]/.test(name)) {
    exe = existsSync(name) ? name : null
  } else {
    const candidates = extname(name) ? [name] : [name + '.exe', name + '.cmd', name + '.bat', name]
    for (const c of candidates) {
      exe = findOnPath(c)
      if (exe) break
    }
  }
  if (!exe) {
    await shell.openPath(resolve(target))
    return
  }
  const isBatch = /\.(cmd|bat)$/i.test(exe)
  const child = spawn(isBatch ? `"${exe}"` : exe, [isBatch ? `"${target}"` : target], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: isBatch
  })
  child.on('error', (err) => {
    console.error('editor failed, falling back to shell.openPath', err)
    void shell.openPath(resolve(target))
  })
  child.unref()
}

/** Debounced non-recursive directory watchers, synced to the set of directories the renderer has expanded. */
export class DirWatcher {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private notify: (dir: string) => void) {}

  sync(dirs: string[]): void {
    const want = new Set(dirs)
    for (const [dir, w] of this.watchers) {
      if (!want.has(dir)) {
        w.close()
        this.watchers.delete(dir)
      }
    }
    for (const dir of want) {
      if (this.watchers.has(dir)) continue
      try {
        const w = watch(dir, { persistent: false }, () => this.schedule(dir))
        w.on('error', () => {
          w.close()
          this.watchers.delete(dir)
        })
        this.watchers.set(dir, w)
      } catch {
        /* directory vanished or is not watchable: ignore */
      }
    }
  }

  private schedule(dir: string): void {
    clearTimeout(this.timers.get(dir))
    this.timers.set(
      dir,
      setTimeout(() => {
        this.timers.delete(dir)
        this.notify(dir)
      }, 250)
    )
  }

  closeAll(): void {
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
