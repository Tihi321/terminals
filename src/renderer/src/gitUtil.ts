import type { GitDiffRequest } from '../../shared/types'

/** Diff tab target. `folder` is the folder the git calls run in. */
export type DiffSpec = GitDiffRequest & { folder: string }

export interface DiffLine {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note'
  text: string
  oldNo?: number
  newNo?: number
}

export interface ParsedDiff {
  lines: DiffLine[]
  added: number
  deleted: number
  binary: boolean
  /** Header facts worth showing (rename from/to, mode changes, new/deleted file). */
  meta: string[]
}

/** Parses the output of a single-file `git diff` / `git show` into display rows. */
export function parseDiff(text: string): ParsedDiff {
  const out: ParsedDiff = { lines: [], added: 0, deleted: 0, binary: false, meta: [] }
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      oldNo = m ? Number(m[1]) : 0
      newNo = m ? Number(m[2]) : 0
      inHunk = true
      out.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (!inHunk || line.startsWith('diff --git')) {
      if (line.startsWith('diff --git')) inHunk = false
      if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) out.binary = true
      else if (/^(rename from|rename to|copy from|copy to|new file mode|deleted file mode|old mode|new mode)/.test(line)) out.meta.push(line)
      continue
    }
    if (line.startsWith('+')) {
      out.added++
      out.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
    } else if (line.startsWith('-')) {
      out.deleted++
      out.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
    } else if (line.startsWith('\\')) {
      out.lines.push({ kind: 'note', text: line })
    } else if (line.startsWith(' ')) {
      out.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return out
}

export function splitPath(p: string): { name: string; dir: string } {
  const i = p.lastIndexOf('/')
  return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i) }
}

export function diffTitle(spec: GitDiffRequest): string {
  const { name } = splitPath(spec.path)
  if (spec.mode === 'staged') return `${name} (staged)`
  if (spec.mode === 'commit') return `${name} @${spec.hash.slice(0, 7)}`
  return name
}

export function diffModeLabel(spec: GitDiffRequest): string {
  if (spec.mode === 'commit') return `commit ${spec.hash.slice(0, 7)}`
  return spec.mode
}

/** "3 hours ago" style age from unix seconds. */
export function relativeAge(unixSeconds: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor(now / 1000 - unixSeconds))
  const units: [number, string][] = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute']
  ]
  for (const [n, label] of units) {
    if (s >= n) {
      const v = Math.floor(s / n)
      return `${v} ${label}${v === 1 ? '' : 's'} ago`
    }
  }
  return 'just now'
}

/** Joins a repo-relative path onto the repo root with the OS separator Windows tools expect. */
export function absPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}`
}
