import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { GitResult, Result, WorktreeStatus } from '../shared/types'
import { worktreeTargetPath } from '../shared/worktreePath'
import { failText, run } from './gitcli'
import { isMainWorktree, readGit, readWorktrees } from './git'

/** `git worktree add` can run a long checkout. */
const ADD_TIMEOUT = 60000
const RETRY_RE = /Permission denied|being used|Directory not empty|Invalid argument/i

const key = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await run(cwd, ['rev-parse', '--verify', '--quiet', ref])).code === 0
}

/**
 * Creates a worktree of the main working tree `repo` for `branch`. An existing local branch is checked out as is (`base` ignored),
 * else the branch is created from `base` (null = HEAD). `created` tells which of the two happened.
 */
export async function addWorktree(
  repo: string,
  branch: string,
  base: string | null,
  layout: 'container' | 'sibling'
): Promise<Result<{ path: string; created: boolean }>> {
  const dir = resolve(repo)
  if (!isMainWorktree(dir)) return { ok: false, error: 'Worktrees can only be created from a main working tree' }
  const b = typeof branch === 'string' ? branch.trim() : ''
  if (!b || b.includes('\0')) return { ok: false, error: 'Enter a branch name' }
  const chk = await run(dir, ['check-ref-format', '--branch', b])
  if (chk.code !== 0 || b.startsWith('-')) return { ok: false, error: `'${b}' is not a valid branch name` }
  const rel = worktreeTargetPath(dir, b, layout)
  if (!rel) return { ok: false, error: `'${b}' cannot be used as a folder name` }
  const path = resolve(rel)
  if (existsSync(path)) return { ok: false, error: `${path} already exists` }
  const exists = await refExists(dir, `refs/heads/${b}`)
  let from = 'HEAD'
  if (!exists && base) {
    if (typeof base !== 'string' || base.startsWith('-') || base.includes('\0')) return { ok: false, error: 'Invalid base branch' }
    if (!(await refExists(dir, `${base}^{commit}`))) return { ok: false, error: `Base '${base}' was not found` }
    from = base
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (e) {
    return { ok: false, error: `Could not create ${dirname(path)}: ${String(e)}` }
  }
  const args = exists ? ['worktree', 'add', path, b] : ['worktree', 'add', '-b', b, path, from]
  const r = await run(dir, args, { timeoutMs: ADD_TIMEOUT })
  if (r.code !== 0) {
    // Drop the container folder made above when nothing ended up in it.
    try {
      if (!existsSync(path) && readdirSync(dirname(path)).length === 0) rmdirSync(dirname(path))
    } catch {
      /* leave it */
    }
    return { ok: false, error: failText(r) }
  }
  return { ok: true, path, created: !exists }
}

function countStatus(out: string): number {
  const recs = out.split('\0')
  let n = 0
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    if (!r) continue
    n++
    if (r[0] === 'R' || r[0] === 'C') i++ // rename/copy: the next record is the source path
  }
  return n
}

/** Uncommitted change count, branch and lock state of the worktree at `path`. */
export async function worktreeStatus(path: string): Promise<GitResult<{ status: WorktreeStatus }>> {
  const dir = resolve(path)
  if (!existsSync(dir)) return { ok: false, error: 'Folder does not exist' }
  const [st, common] = await Promise.all([
    run(dir, ['status', '--porcelain', '-z', '--untracked-files=normal']),
    run(dir, ['rev-parse', '--git-common-dir'])
  ])
  if (st.code !== 0) return { ok: false, error: failText(st) }
  let locked = false
  if (common.code === 0 && common.stdout.trim()) {
    const mainRepo = dirname(resolve(dir, common.stdout.trim()))
    locked = readWorktrees(mainRepo).some((w) => key(w.path) === key(dir) && w.locked)
  }
  return { ok: true, status: { changes: countStatus(st.stdout), branch: readGit(dir).branch, locked } }
}

/** Removes a linked worktree of `repo`. Refuses locked ones; without `force` also ones with uncommitted changes. */
export async function removeWorktree(
  repo: string,
  path: string,
  opts: { force: boolean; deleteBranch: boolean }
): Promise<Result<{ branchError?: string; warning?: string }>> {
  const repoDir = resolve(repo)
  const dir = resolve(path)
  const entry = readWorktrees(repoDir).find((w) => key(w.path) === key(dir))
  if (!entry) return { ok: false, error: 'Not a worktree of this repository' }
  if (entry.locked) return { ok: false, error: 'Worktree is locked: unlock it with git worktree unlock first' }
  const branch = entry.branch && !entry.branch.startsWith('detached @') ? entry.branch : null
  let warning: string | undefined
  if (entry.missing) {
    const pr = await run(repoDir, ['worktree', 'prune'])
    if (pr.code !== 0) return { ok: false, error: failText(pr) }
  } else {
    if (!opts.force) {
      const st = await worktreeStatus(dir)
      if (!st.ok) return st
      if (st.status.changes > 0) return { ok: false, error: `Worktree has ${st.status.changes} uncommitted changes` }
    }
    const args = ['worktree', 'remove', ...(opts.force ? ['--force'] : []), dir]
    let r = await run(repoDir, args, { timeoutMs: ADD_TIMEOUT })
    // Shells that just closed release the directory late on Windows.
    for (let i = 0; i < 3 && r.code !== 0 && RETRY_RE.test(r.stderr); i++) {
      await sleep(500)
      r = await run(repoDir, args, { timeoutMs: ADD_TIMEOUT })
    }
    if (r.code !== 0) {
      // git may have dropped its metadata and then failed to delete the folder: finish the job ourselves.
      if (readWorktrees(repoDir).some((w) => key(w.path) === key(dir))) return { ok: false, error: failText(r) }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
      } catch {
        /* reported below */
      }
      if (existsSync(dir)) warning = `folder could not be fully deleted: ${dir}`
    }
  }
  if (opts.deleteBranch && branch) {
    const br = await run(repoDir, ['branch', '-d', branch])
    if (br.code !== 0) return { ok: true, branchError: failText(br), ...(warning ? { warning } : {}) }
  }
  return { ok: true, ...(warning ? { warning } : {}) }
}

/**
 * Base branch for diffs: the stored one when it still resolves, else the local default branch (name from origin/HEAD, then
 * main, then master), and only when none exists locally origin/HEAD's target itself. Works for worktrees and main working trees.
 */
export async function resolveBase(
  folder: string,
  stored: string | undefined
): Promise<{ ok: true; base: string; baseIsSet: boolean } | { ok: false; error: string }> {
  const dir = resolve(folder)
  if (stored && !stored.startsWith('-') && (await refExists(dir, `${stored}^{commit}`))) return { ok: true, base: stored, baseIsSet: true }
  const oh = await run(dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
  if (oh.spawnError) return { ok: false, error: oh.spawnError }
  const o = oh.code === 0 ? oh.stdout.trim() : ''
  if (o) {
    const local = o.replace(/^origin\//, '')
    if (await refExists(dir, `refs/heads/${local}`)) return { ok: true, base: local, baseIsSet: false }
  }
  for (const name of ['main', 'master']) {
    if (await refExists(dir, `refs/heads/${name}`)) return { ok: true, base: name, baseIsSet: false }
  }
  if (o) return { ok: true, base: o, baseIsSet: false }
  return { ok: false, error: 'No base branch found' }
}
