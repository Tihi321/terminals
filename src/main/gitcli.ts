import { spawn } from 'node:child_process'
import { closeSync, openSync, readSync, statSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  GitCommit,
  GitDiffRequest,
  GitFile,
  GitNumstat,
  GitResult,
  GitStatus
} from '../shared/types'

/** Everything here shells out to the `git` CLI (no shell, args as arrays) and never throws. */

const MAX_OUT = 12 * 1024 * 1024
const TIMEOUT = 20000
const HASH_RE = /^[0-9a-f]{4,40}$/i
/** Untracked files above this size are not read for line counts. */
const COUNT_LIMIT = 1024 * 1024

interface RunOpts {
  input?: string
  maxBytes?: number
}
interface RunOut {
  code: number
  stdout: string
  stderr: string
  truncated: boolean
  /** git could not be started. */
  spawnError?: string
}

// --no-optional-locks: status polling must never take index.lock away from the user's own git commands.
const BASE = ['--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'core.safecrlf=false', '-c', 'color.ui=never']

function run(cwd: string, args: string[], opts: RunOpts = {}): Promise<RunOut> {
  return new Promise((resolveRun) => {
    const max = opts.maxBytes ?? MAX_OUT
    const stdout: Buffer[] = []
    let size = 0
    let stderr = ''
    let truncated = false
    let done = false
    const finish = (r: Partial<RunOut> & { code: number }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveRun({ stdout: Buffer.concat(stdout).toString('utf8'), stderr, truncated, ...r })
    }
    let child
    try {
      child = spawn('git', [...BASE, ...args], {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C.UTF-8' }
      })
    } catch (err) {
      resolveRun({ code: -1, stdout: '', stderr: '', truncated: false, spawnError: String(err) })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: -1, stderr: stderr + '\ngit timed out' })
    }, TIMEOUT)
    child.stdout.on('data', (d: Buffer) => {
      if (truncated) return
      size += d.length
      if (size > max) {
        truncated = true
        stdout.push(d.subarray(0, Math.max(0, d.length - (size - max))))
        child.kill()
        return
      }
      stdout.push(d)
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 20000) stderr += d.toString('utf8')
    })
    child.on('error', (err) => finish({ code: -1, spawnError: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'git is not installed or not on PATH' : String(err) }))
    child.on('close', (code) => finish({ code: code ?? -1 }))
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
}

function failText(r: RunOut): string {
  if (r.spawnError) return r.spawnError
  return (r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}`).slice(0, 4000)
}

const rootCache = new Map<string, string>()

/** Resolves the repository root for a folder (the folder may be a subdirectory of the repo). */
async function repoRoot(folder: string): Promise<GitResult<{ root: string }>> {
  const dir = resolve(folder)
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, error: 'Folder does not exist' }
  } catch {
    return { ok: false, error: 'Folder does not exist' }
  }
  const cached = rootCache.get(dir)
  if (cached && existsSync(cached)) return { ok: true, root: cached }
  const r = await run(dir, ['rev-parse', '--show-toplevel'])
  if (r.spawnError) return { ok: false, error: r.spawnError }
  if (r.code !== 0) {
    const notRepo = /not a git repository/i.test(r.stderr)
    return { ok: false, error: notRepo ? 'Not a git repository' : failText(r), notRepo }
  }
  const root = resolve(r.stdout.trim())
  rootCache.set(dir, root)
  return { ok: true, root }
}

const goodPaths = (p: unknown): p is string[] =>
  Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === 'string' && x.length > 0 && !x.includes('\0'))

// ---------- parsing (exported for the smoke test) ----------

/** Parses `git diff --numstat -z`. Keys are the new path. */
export function parseNumstat(out: string): GitNumstat[] {
  const parts = out.split('\0')
  const res: GitNumstat[] = []
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec)
    if (!m) continue
    const added = m[1] === '-' ? null : Number(m[1])
    const deleted = m[2] === '-' ? null : Number(m[2])
    if (m[3] === '') {
      // Rename: "a\td\t\0old\0new\0"
      const origPath = parts[++i]
      const path = parts[++i]
      if (path) res.push({ path, origPath, added, deleted })
    } else {
      res.push({ path: m[3], added, deleted })
    }
  }
  return res
}

interface Parsed {
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  hasCommits: boolean
  files: GitFile[]
}

const blank = (path: string): GitFile => ({
  path,
  staged: null,
  unstaged: null,
  untracked: false,
  conflicted: false,
  stagedAdded: 0,
  stagedDeleted: 0,
  unstagedAdded: 0,
  unstagedDeleted: 0
})

/** Parses `git status --porcelain=v2 -z --branch`. */
export function parseStatusV2(out: string): Parsed {
  const p: Parsed = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, hasCommits: true, files: [] }
  const recs = out.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    if (!r) continue
    if (r.startsWith('# ')) {
      const [key, ...rest] = r.slice(2).split(' ')
      const val = rest.join(' ')
      if (key === 'branch.oid') p.hasCommits = val !== '(initial)'
      else if (key === 'branch.head') {
        p.detached = val === '(detached)'
        p.branch = p.detached ? null : val
      } else if (key === 'branch.upstream') p.upstream = val
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val)
        if (m) {
          p.ahead = Number(m[1])
          p.behind = Number(m[2])
        }
      }
      continue
    }
    const kind = r[0]
    if (kind === '?') {
      const f = blank(r.slice(2))
      f.untracked = true
      f.unstagedAdded = null
      f.unstagedDeleted = 0
      p.files.push(f)
    } else if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI path        (8 spaces before path)
      // 2 XY sub mH mI mW hH hI Xscore path (9 spaces), then NUL origPath
      const n = kind === '1' ? 8 : 9
      const parts = splitN(r, n)
      const xy = parts[1] ?? '..'
      const f = blank(parts[n])
      f.staged = xy[0] === '.' ? null : xy[0]
      f.unstaged = xy[1] === '.' ? null : xy[1]
      if (kind === '2') f.origPath = recs[++i]
      p.files.push(f)
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path (10 spaces)
      const parts = splitN(r, 10)
      const f = blank(parts[10])
      f.conflicted = true
      f.staged = null
      f.unstaged = 'U'
      p.files.push(f)
    }
  }
  return p
}

/** Splits on the first n spaces; the remainder (a path that may contain spaces) is element n. */
function splitN(s: string, n: number): string[] {
  const out: string[] = []
  let start = 0
  for (let k = 0; k < n; k++) {
    const idx = s.indexOf(' ', start)
    if (idx < 0) break
    out.push(s.slice(start, idx))
    start = idx + 1
  }
  out.push(s.slice(start))
  return out
}

/** Line count of a file, or null for binary/too-large/unreadable files. */
export function countLines(file: string): number | null {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > COUNT_LIMIT) return null
    if (st.size === 0) return 0
    const fd = openSync(file, 'r')
    try {
      const head = Buffer.alloc(Math.min(8000, st.size))
      readSync(fd, head, 0, head.length, 0)
      if (head.includes(0)) return null
    } finally {
      closeSync(fd)
    }
    const buf = readFileSync(file)
    let n = 0
    for (const b of buf) if (b === 10) n++
    if (buf[buf.length - 1] !== 10) n++
    return n
  } catch {
    return null
  }
}

// ---------- public API ----------

export async function gitStatus(folder: string): Promise<GitResult<{ status: GitStatus }>> {
  const rr = await repoRoot(folder)
  if (!rr.ok) return rr
  const root = rr.root
  const [st, unstaged, staged] = await Promise.all([
    run(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
    run(root, ['diff', '--numstat', '-z', '--no-ext-diff']),
    run(root, ['diff', '--cached', '--numstat', '-z', '--no-ext-diff'])
  ])
  if (st.code !== 0) return { ok: false, error: failText(st) }
  const parsed = parseStatusV2(st.stdout)
  const un = new Map(parseNumstat(unstaged.code === 0 ? unstaged.stdout : '').map((n) => [n.path, n]))
  const sg = new Map(parseNumstat(staged.code === 0 ? staged.stdout : '').map((n) => [n.path, n]))
  for (const f of parsed.files) {
    if (f.untracked) {
      f.unstagedAdded = countLines(resolve(root, f.path))
      continue
    }
    const a = un.get(f.path)
    if (a) {
      f.unstagedAdded = a.added
      f.unstagedDeleted = a.deleted
    }
    const b = sg.get(f.path)
    if (b) {
      f.stagedAdded = b.added
      f.stagedDeleted = b.deleted
    }
  }
  return { ok: true, status: { root, ...parsed } }
}

export async function gitDiff(folder: string, req: GitDiffRequest): Promise<GitResult<{ text: string; truncated: boolean }>> {
  if (!req || typeof req.path !== 'string' || !req.path || req.path.includes('\0')) return { ok: false, error: 'Invalid path' }
  const rr = await repoRoot(folder)
  if (!rr.ok) return rr
  const common = ['--no-color', '--no-ext-diff', '--no-textconv']
  let args: string[]
  let okCodes = [0]
  switch (req.mode) {
    case 'unstaged':
      args = ['diff', ...common, '--', req.path]
      break
    case 'staged':
      args = ['diff', '--cached', ...common, '--', req.path]
      break
    case 'untracked':
      // git treats the pseudo-path /dev/null as the empty side on every platform, including Git for Windows.
      args = ['diff', '--no-index', ...common, '--', '/dev/null', req.path]
      okCodes = [0, 1]
      break
    case 'commit':
      if (typeof req.hash !== 'string' || !HASH_RE.test(req.hash)) return { ok: false, error: 'Invalid commit hash' }
      args = ['show', '--format=', '--first-parent', ...common, req.hash, '--', req.path]
      break
    default:
      return { ok: false, error: 'Invalid diff mode' }
  }
  let r = await run(rr.root, args)
  if (req.mode === 'untracked' && !okCodes.includes(r.code) && !r.spawnError) {
    r = await run(rr.root, args.map((a) => (a === '/dev/null' ? 'NUL' : a)))
  }
  if (!okCodes.includes(r.code) && !r.truncated) return { ok: false, error: failText(r) }
  return { ok: true, text: r.stdout, truncated: r.truncated }
}

async function changePaths(folder: string, paths: string[] | null, label: string): Promise<GitResult<{ root: string }>> {
  if (paths !== null && !goodPaths(paths)) return { ok: false, error: `${label}: invalid paths` }
  return repoRoot(folder)
}

export async function gitStage(folder: string, paths: string[] | null): Promise<GitResult> {
  const rr = await changePaths(folder, paths, 'Stage')
  if (!rr.ok) return rr
  const r = await run(rr.root, paths === null ? ['add', '-A'] : ['add', '--', ...paths])
  return r.code === 0 ? { ok: true } : { ok: false, error: failText(r) }
}

export async function gitUnstage(folder: string, paths: string[] | null): Promise<GitResult> {
  const rr = await changePaths(folder, paths, 'Unstage')
  if (!rr.ok) return rr
  const spec = paths === null ? ['.'] : paths
  const head = await run(rr.root, ['rev-parse', '--verify', '-q', 'HEAD'])
  // Without a HEAD there is nothing to restore from; `git reset` clears the index entries instead.
  const args = head.code === 0 ? ['restore', '--staged', '--', ...spec] : ['reset', '-q', '--', ...spec]
  const r = await run(rr.root, args)
  return r.code === 0 ? { ok: true } : { ok: false, error: failText(r) }
}

export async function gitCommit(folder: string, message: string, stageTracked: boolean): Promise<GitResult> {
  if (typeof message !== 'string' || !message.trim()) return { ok: false, error: 'Enter a commit message' }
  const rr = await repoRoot(folder)
  if (!rr.ok) return rr
  if (stageTracked) {
    const a = await run(rr.root, ['add', '-u'])
    if (a.code !== 0) return { ok: false, error: failText(a) }
  }
  const r = await run(rr.root, ['commit', '-F', '-'], { input: message.replace(/\r\n/g, '\n') })
  // Hook output goes to stderr, "nothing to commit" to stdout: show both.
  if (r.code === 0) return { ok: true }
  const text = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n')
  return { ok: false, error: (r.spawnError ?? (text || `git commit exited with code ${r.code}`)).slice(0, 4000) }
}

export async function gitLog(folder: string): Promise<GitResult<{ commits: GitCommit[] }>> {
  const rr = await repoRoot(folder)
  if (!rr.ok) return rr
  const head = await run(rr.root, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (head.code !== 0) return { ok: true, commits: [] }
  const r = await run(rr.root, ['log', '-n', '100', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1e'])
  if (r.code !== 0) return { ok: false, error: failText(r) }
  const commits: GitCommit[] = []
  for (const rec of r.stdout.split('\x1e')) {
    const [hash, short, subject, author, date] = rec.trim().split('\x1f')
    if (hash && HASH_RE.test(hash)) commits.push({ hash, short, subject: subject ?? '', author: author ?? '', date: date ?? '' })
  }
  return { ok: true, commits }
}

export async function gitCommitFiles(folder: string, hash: string): Promise<GitResult<{ files: GitNumstat[] }>> {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return { ok: false, error: 'Invalid commit hash' }
  const rr = await repoRoot(folder)
  if (!rr.ok) return rr
  const r = await run(rr.root, ['show', '--numstat', '--format=', '-z', '--first-parent', hash])
  if (r.code !== 0) return { ok: false, error: failText(r) }
  return { ok: true, files: parseNumstat(r.stdout) }
}
