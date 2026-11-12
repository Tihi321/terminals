import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { resolveShell, spawnShell, spawnSteps } from './pty'
import { migrate } from './store'
import { SCHEMA_VERSION } from '../shared/types'
import { canAddPane, closePane, dragDivider, dropOnEdge, fromPersisted, normalize, openToSide } from '../shared/panes'
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

/** Check: the pane layout migrates (old files load without it, bad data is cleaned) and the pure helpers behave. */
function checkPanes(): CheckResult {
  let n = 0
  const mk = (): string => `p${n++}`
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'panes: ' + m })
  const old = migrate({ ui: { sidebarWidth: 300 } } as never)
  if (old.ui.panes !== null) return fail('old file should have panes: null')
  const dirty = migrate({
    ui: { panes: { locIds: ['a', 'b', 'a', 5, 'c', 'd', 'e'], fractions: [1, 1, 1, 1, 1, 1, 1], focused: 3 } }
  } as never)
  const dp = dirty.ui.panes
  if (!dp || dp.locIds.join() !== 'a,b,c,d' || dp.focused !== 0 || Math.abs(dp.fractions.reduce((x, y) => x + y, 0) - 1) > 1e-9)
    return fail('dirty layout not cleaned ' + JSON.stringify(dp))
  if (migrate({ ui: { panes: 'nope' } } as never).ui.panes !== null) return fail('garbage should become null')

  const valid = new Set(['a', 'b', 'c', 'd', 'e'])
  const loaded = fromPersisted({ locIds: ['a', 'gone', 'b'], fractions: [0.2, 0.3, 0.5], focused: 2 }, valid, 'a', mk)
  if (loaded.panes.map((p) => p.locId).join() !== 'a,b' || loaded.focused !== 1 || Math.abs(loaded.fractions[0] - 0.2 / 0.7) > 1e-9)
    return fail('fromPersisted ' + JSON.stringify(loaded))
  const fallback = fromPersisted(null, valid, 'c', mk)
  if (fallback.panes.length !== 1 || fallback.panes[0].locId !== 'c') return fail('fallback pane')

  let s = fromPersisted(null, valid, 'a', mk)
  s = openToSide(s, 'b', mk)
  if (s.panes.map((p) => p.locId).join() !== 'a,b' || s.focused !== 1 || s.fractions.join() !== '0.5,0.5') return fail('openToSide ' + JSON.stringify(s))
  s = openToSide(s, 'a', mk)
  if (s.panes.length !== 2 || s.focused !== 0) return fail('open existing should focus')
  s = dropOnEdge(s, 'c', 0, 'left', mk)
  if (s.panes.map((p) => p.locId).join() !== 'c,a,b' || s.focused !== 0) return fail('dropOnEdge new left ' + JSON.stringify(s))
  s = dropOnEdge(s, 'c', 2, 'right', mk)
  if (s.panes.map((p) => p.locId).join() !== 'a,b,c' || s.focused !== 2) return fail('dropOnEdge move ' + JSON.stringify(s))
  s = openToSide(openToSide(s, 'd', mk), 'e', mk)
  if (s.panes.length !== 4 || canAddPane(s, 'e') || !canAddPane(s, 'a')) return fail('cap at 4 ' + JSON.stringify(s))
  const full = openToSide(s, 'x', mk)
  if (full !== s) return fail('fifth pane should be refused')
  const closed = closePane(s, s.focused)
  if (closed.panes.length !== 3 || Math.abs(closed.fractions.reduce((x, y) => x + y, 0) - 1) > 1e-9) return fail('closePane')
  if (closePane({ panes: [{ id: 'z', locId: 'a' }], fractions: [1], focused: 0 }, 0).panes.length !== 1) return fail('last pane closed')
  const dd = dragDivider([0.5, 0.5], 0, 0.99, 0.2)
  if (Math.abs(dd[0] - 0.8) > 1e-9 || Math.abs(dd[1] - 0.2) > 1e-9) return fail('dragDivider clamp ' + JSON.stringify(dd))
  const gone = normalize(s, new Set(['a']), 'a', mk)
  if (gone.panes.length !== 1 || gone.panes[0].locId !== 'a') return fail('normalize drop')
  return { ok: true, msg: 'panes: migrate cleans/defaults the layout; open/drop/close/divider/normalize helpers behave' }
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

  const results = [await checkInteractive(dir, shell, track), await checkSteps(dir, shell, track), checkMigration(), checkPanes(), await checkGit()]
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
