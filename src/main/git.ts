import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface GitInfo {
  isGit: boolean
  branch: string | null
}

/** Reads the current branch from .git/HEAD, following `gitdir:` pointers for worktrees/submodules. */
export function readGit(dir: string): GitInfo {
  try {
    const dotGit = join(dir, '.git')
    if (!existsSync(dotGit)) return { isGit: false, branch: null }
    let gitDir = dotGit
    if (statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
      if (!m) return { isGit: true, branch: null }
      const target = m[1].trim()
      gitDir = isAbsolute(target) ? target : resolve(dirname(dotGit), target)
    }
    return { isGit: true, branch: parseHead(readFileSync(join(gitDir, 'HEAD'), 'utf8')) }
  } catch {
    return { isGit: true, branch: null }
  }
}

/** Branch short name, `detached @ abc1234`, or null from the contents of a HEAD file. */
function parseHead(content: string): string | null {
  const head = content.trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  if (ref) return ref[1]
  if (/^[0-9a-f]{7,}$/i.test(head)) return `detached @ ${head.slice(0, 7)}`
  return null
}

/** `<dir>/.git` is a directory: dir is a main working tree (not a linked worktree or submodule). */
export function isMainWorktree(dir: string): boolean {
  try {
    return statSync(join(dir, '.git')).isDirectory()
  } catch {
    return false
  }
}

export interface WorktreeEntry {
  path: string
  branch: string | null
  locked: boolean
  /** Directory no longer exists (prunable). */
  missing: boolean
}

/** Linked worktrees of a main working tree, read from `<repo>/.git/worktrees/*`. Never throws. Sorted by path. */
export function readWorktrees(repoDir: string): WorktreeEntry[] {
  try {
    if (!isMainWorktree(repoDir)) return []
    const base = join(repoDir, '.git', 'worktrees')
    if (!existsSync(base)) return []
    const out: WorktreeEntry[] = []
    for (const name of readdirSync(base)) {
      try {
        const dir = join(base, name)
        if (!statSync(dir).isDirectory()) continue
        const gitdir = readFileSync(join(dir, 'gitdir'), 'utf8').split(/\r?\n/)[0].trim()
        if (!gitdir) continue
        const path = dirname(resolve(gitdir))
        let branch: string | null = null
        try {
          branch = parseHead(readFileSync(join(dir, 'HEAD'), 'utf8'))
        } catch {
          branch = null
        }
        out.push({ path, branch, locked: existsSync(join(dir, 'locked')), missing: !existsSync(path) })
      } catch {
        /* skip unreadable entry */
      }
    }
    return out.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
  } catch {
    return []
  }
}
