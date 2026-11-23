import { cpSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CopyResult, Result } from '../shared/types'

// Kept free of electron imports so it can be exercised from plain node.

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Returns an error message for a name that cannot be a single Windows folder name, or null when it is fine. */
export function folderNameError(raw: string): string | null {
  const name = raw.trim()
  if (!name) return 'Enter a folder name'
  if (name === '.' || name === '..') return 'Invalid folder name'
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return 'A folder name cannot contain < > : " / \\ | ? *'
  if (/[. ]$/.test(name)) return 'A folder name cannot end with a dot or a space'
  if (RESERVED.test(name)) return `"${name}" is a reserved name on Windows`
  return null
}

const defaultExists = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** First free name in `dir`: "a.txt", then "a (2).txt", "a (3).txt" ... Folders get the counter after the whole name. */
export function uniqueName(dir: string, name: string, isDir: boolean, exists: (p: string) => boolean = defaultExists): string {
  if (!exists(join(dir, name))) return name
  const ext = isDir ? '' : extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!exists(join(dir, candidate))) return candidate
  }
}

const real = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/** True when `child` is `parent` itself or lies anywhere below it (case-insensitive, symlinks resolved when possible). */
export function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(real(parent).toLowerCase(), real(child).toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Creates one directory (not recursive) named `name` inside `parent`. Never touches an existing path. */
export function createFolderIn(parent: string, name: string): Result<{ path: string }> {
  const bad = folderNameError(name)
  if (bad) return { ok: false, error: bad }
  try {
    if (!statSync(parent).isDirectory()) return { ok: false, error: 'The parent is not a folder' }
  } catch {
    return { ok: false, error: 'The parent folder does not exist' }
  }
  const path = join(parent, name.trim())
  try {
    mkdirSync(path)
    return { ok: true, path }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return { ok: false, error: `"${name.trim()}" already exists` }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Copies files/folders into `destDir`. Never overwrites: a taken name becomes "name (2)". Refuses a folder into
 * itself or its own subfolder, and skips a source that already sits directly in `destDir`.
 */
export function copyIntoDir(paths: string[], destDir: string): CopyResult {
  try {
    if (!statSync(destDir).isDirectory()) return { ok: false, error: 'The destination is not a folder' }
  } catch {
    return { ok: false, error: 'The destination folder does not exist' }
  }
  const copied: string[] = []
  const skipped: string[] = []
  const failed: { name: string; error: string }[] = []
  for (const src of paths) {
    const name = basename(src)
    if (typeof src !== 'string' || !src || !name) continue
    try {
      const st = statSync(src)
      const isDir = st.isDirectory()
      if (isSameOrInside(dirname(src), destDir) && isSameOrInside(destDir, dirname(src))) {
        skipped.push(name)
        continue
      }
      if (isDir && isSameOrInside(destDir, src)) {
        failed.push({ name, error: 'Cannot copy a folder into itself' })
        continue
      }
      const target = join(destDir, uniqueName(destDir, name, isDir))
      cpSync(src, target, { recursive: true, errorOnExist: true, force: false })
      copied.push(basename(target))
    } catch (e) {
      failed.push({ name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { ok: true, copied, skipped, failed }
}
