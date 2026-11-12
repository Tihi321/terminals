import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { resolveShell, spawnShell, spawnSteps } from './pty'
import { migrate } from './store'
import { SCHEMA_VERSION } from '../shared/types'
import { gitCommit, gitCommitFiles, gitDiff, gitLog, gitStage, gitStatus, gitUnstage } from './gitcli'

interface CheckResult {
  ok: boolean
  msg: string
}

/** Check 1: interactive shell, echo a marker, wait for it in the output. */
function checkInteractive(dir: string, shell: string, track: (p: IPty) => void): Promise<CheckResult> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const finish = (ok: boolean, msg: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      // Resolve outside the pty callback (tearing down from inside it can deadlock).
      setTimeout(() => resolve({ ok, msg }), 0)
    }
    const p = spawnShell(shell, dir, 80, 24, {
      onData: (d) => {
        output += d
        // The command below builds the marker by concatenation, so the echoed input line
        // (which PSReadLine redraws with escape codes) can never match; only real output does.
        if (output.includes('smoke-ok')) finish(true, `interactive: shell ${shell} printed smoke-ok in ${dir}`)
      },
      onExit: (code) => finish(false, `interactive: shell exited early with code ${code}`)
    })
    track(p)
    const timer = setTimeout(
      () => finish(false, `interactive: timeout waiting for smoke-ok. Output: ${JSON.stringify(output.slice(-300))}`),
      10000
    )
    const cmd = /pwsh|powershell/i.test(shell) ? "Write-Output ('smoke-' + 'ok')" : 'echo smoke-ok'
    setTimeout(() => p.write(cmd + '\r'), 1500)
  })
}

/** Check 2: a 2-step command; step 1 prints a1, step 2 exits 3. Expect output with a1 and exit code 3. */
function checkSteps(dir: string, shell: string, track: (p: IPty) => void): Promise<CheckResult> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const finish = (ok: boolean, msg: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      setTimeout(() => resolve({ ok, msg }), 0)
    }
    const p = spawnSteps(shell, ["Write-Output ('a'+'1')", 'exit 3'], dir, 80, 24, {
      onData: (d) => (output += d),
      onExit: (code) => {
        if (code === 3 && output.includes('a1')) finish(true, `steps: output contained a1 and exit code was 3`)
        else finish(false, `steps: exit code ${code}, output ${JSON.stringify(output.slice(-300))}`)
      }
    })
    track(p)
    const timer = setTimeout(
      () => finish(false, `steps: timeout. Output: ${JSON.stringify(output.slice(-300))}`),
      15000
    )
  })
}

/** Check 3: a v2 file migrates to the current schema, gets empty snippets and keeps folders/commands/v1 data. */
function checkMigration(): CheckResult {
  const v2 = {
    version: 2,
    folders: [{ id: 'f1', path: 'C:\a\proj', name: 'proj', order: 0, groupId: null }],
    commands: [{ id: 'c1', name: 'build', ownerId: 'f1', mode: 'parallel', targets: [{ cwd: 'C:\a\proj', steps: ['yarn build'] }] }],
    selectedId: 'f1'
  }
  const v1 = { folders: [{ id: 'f2', path: 'C:\b', name: 'b', order: 0 }] }
  const a = migrate(v2 as never)
  const b = migrate(v1 as never)
  const ok =
    SCHEMA_VERSION === 3 &&
    a.snippets.length === 0 &&
    a.folders.length === 1 &&
    a.commands.length === 1 &&
    a.selectedId === 'f1' &&
    b.snippets.length === 0 &&
    b.folders[0]?.groupId === null
  return { ok, msg: ok ? 'migration: v2 and v1 files migrate with snippets: [] and data kept' : 'migration: unexpected result ' + JSON.stringify({ a, b }) }
}

/** Check 4: the git status/diff/stage/commit/log layer against a throwaway repo. */
async function checkGit(): Promise<CheckResult> {
  const repo = mkdtempSync(join(tmpdir(), 'terminals-smoke-git-'))
  const git = (...a: string[]): void => void execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' })
  try {
    git('init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(repo, 'sp ace.txt'), 'x\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    writeFileSync(join(repo, 'new file.txt'), 'n1\nn2\nn3\n')
    const fail = (m: string): CheckResult => ({ ok: false, msg: 'git: ' + m })
    let r = await gitStatus(repo)
    if (!r.ok) return fail(r.error)
    const a = r.status.files.find((f) => f.path === 'a.txt')
    const n = r.status.files.find((f) => f.path === 'new file.txt')
    if (!a || a.unstaged !== 'M' || a.unstagedAdded !== 2 || a.unstagedDeleted !== 1) return fail('unexpected a.txt ' + JSON.stringify(a))
    if (!n || !n.untracked || n.unstagedAdded !== 3) return fail('unexpected untracked ' + JSON.stringify(n))
    const d = await gitDiff(repo, { mode: 'untracked', path: 'new file.txt' })
    if (!d.ok || !d.text.includes('+n3')) return fail('untracked diff ' + JSON.stringify(d).slice(0, 200))
    if (!(await gitStage(repo, ['a.txt'])).ok) return fail('stage failed')
    r = await gitStatus(repo)
    const a2 = r.ok ? r.status.files.find((f) => f.path === 'a.txt') : undefined
    if (!a2 || a2.staged !== 'M' || a2.unstaged !== null || a2.stagedAdded !== 2) return fail('after stage ' + JSON.stringify(a2))
    if (!(await gitUnstage(repo, ['a.txt'])).ok) return fail('unstage failed')
    const c = await gitCommit(repo, 'tracked change', true)
    if (!c.ok) return fail('commit tracked ' + c.error)
    const log = await gitLog(repo)
    if (!log.ok || log.commits.length !== 2 || log.commits[0].subject !== 'tracked change') return fail('log ' + JSON.stringify(log).slice(0, 200))
    const files = await gitCommitFiles(repo, log.commits[0].hash)
    if (!files.ok || files.files.length !== 1 || files.files[0].added !== 2) return fail('commit files ' + JSON.stringify(files))
    const empty = await gitCommit(repo, 'nothing', false)
    if (empty.ok) return fail('empty commit should fail')
    return { ok: true, msg: 'git: status counts, untracked diff, stage/unstage, commit tracked, log and commit files work' }
  } catch (err) {
    return { ok: false, msg: 'git: ' + String(err) }
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* read-only git objects can resist cleanup on Windows; the OS temp dir absorbs them */
    }
  }
}

export async function runSmoke(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'terminals-smoke-'))
  const shell = resolveShell('')
  const ptys: IPty[] = []
  const track = (p: IPty): void => void ptys.push(p)

  const results = [await checkInteractive(dir, shell, track), await checkSteps(dir, shell, track), checkMigration(), await checkGit()]
  for (const r of results) console.log(r.ok ? `PASS: ${r.msg}` : `FAIL: ${r.msg}`)
  const ok = results.every((r) => r.ok)

  for (const p of ptys) {
    try {
      p.kill()
    } catch {
      /* already gone */
    }
  }
  // process.exit rather than app.exit: Electron's quit path hangs while conpty handles are open.
  setTimeout(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    process.exit(ok ? 0 : 1)
  }, 500)
}
