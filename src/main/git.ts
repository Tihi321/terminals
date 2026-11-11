import { existsSync, readFileSync, statSync } from 'node:fs'
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
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    if (ref) return { isGit: true, branch: ref[1] }
    if (/^[0-9a-f]{7,}$/i.test(head)) return { isGit: true, branch: `detached @ ${head.slice(0, 7)}` }
    return { isGit: true, branch: null }
  } catch {
    return { isGit: true, branch: null }
  }
}
