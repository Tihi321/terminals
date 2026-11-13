import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { resolveShell, spawnShell, spawnSteps, stepsShell } from './pty'
import { childId, migrate } from './store'
import { readFileContent, writeTextFile } from './fsops'
import { SCHEMA_VERSION, type AppState } from '../shared/types'
import { DEFAULT_SETTINGS, DEFAULT_TERMINAL_FONT, patchSettings, sanitizeSettings } from '../shared/settings'
import { THEME_IDS, THEMES, UI_VARS, resolveThemeId } from '../shared/themes'
import { contextLocation, findLocation, planCommand, planPrompt, ToolError, visibleCommands } from './mcpTools'
import { hostAllowed, tokenMatches } from './mcp'
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

/** Check: settings schema defaults, sanitising, save/load round trip, theme completeness and the steps shell. */
function checkSettings(): CheckResult {
  const fail = (l: string): CheckResult => ({ ok: false, msg: `settings: check ${l} failed` })
  if (JSON.stringify(sanitizeSettings(undefined)) !== JSON.stringify(DEFAULT_SETTINGS)) return fail('a')
  const m = migrate({
    version: 3,
    settings: {
      shell: ' cmd.exe ',
      terminalFontSize: 99,
      theme: 'nope',
      cursorStyle: 'bar',
      cursorBlink: false,
      scrollback: -5,
      terminalFontFamily: 'x;}',
      extra: 1
    }
  } as never).settings
  const mOk =
    m.shell === 'cmd.exe' &&
    m.terminalFontSize === 36 &&
    m.theme === 'dark' &&
    m.cursorStyle === 'bar' &&
    m.cursorBlink === false &&
    m.scrollback === 0 &&
    m.terminalFontFamily === DEFAULT_TERMINAL_FONT &&
    m.editor === 'zed' &&
    !('extra' in m)
  if (!mOk) return fail('b')
  const p = patchSettings(DEFAULT_SETTINGS, { theme: 'light', scrollback: 12000.4, cursorBlink: 'yes', bogus: 1 })
  const back = migrate({ version: 3, settings: JSON.parse(JSON.stringify(p)) } as never).settings
  if (JSON.stringify(back) !== JSON.stringify(p) || p.theme !== 'light' || p.scrollback !== 12000 || p.cursorBlink !== true) return fail('c')
  for (const id of THEME_IDS) {
    const t = THEMES[id]
    if (UI_VARS.some((k) => typeof t.ui[k] !== 'string' || !t.ui[k])) return fail('d')
    if (t.terminal.background !== t.ui['bg-term'] || t.terminal.cursorAccent !== t.ui['bg-term']) return fail('d')
  }
  if (resolveThemeId('system', true) !== 'dark' || resolveThemeId('system', false) !== 'light') return fail('d')
  if (stepsShell('C:\\tools\\bash.exe') !== resolveShell('') || stepsShell('cmd.exe') !== 'cmd.exe') return fail('e')
  return { ok: true, msg: 'settings: defaults, sanitising, round trip, themes and steps shell OK' }
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

/** Check: writeTextFile saves in place, keeps CRLF/BOM text as given, refuses stale mtimes unless forced, and never creates files. */
function checkWrite(): CheckResult {
  const d = mkdtempSync(join(tmpdir(), 'terminals-smoke-write-'))
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'write: ' + m })
  try {
    const f = join(d, 'a.txt')
    writeFileSync(f, '\uFEFFone\r\ntwo\r\n')
    const read = readFileContent(f)
    if (!read.ok || read.content.kind !== 'text') return fail('read ' + JSON.stringify(read))
    const m0 = read.content.mtimeMs
    const crlf = '\uFEFFone\r\nTWO\r\nthree\r\n'
    const w = writeTextFile(f, crlf, m0, false)
    if (!w.ok) return fail('first write ' + JSON.stringify(w))
    if (readFileSync(f, 'utf8') !== crlf) return fail('CRLF/BOM did not round-trip')
    writeTextFile(f, 'short', w.mtimeMs, false)
    if (readFileSync(f, 'utf8') !== 'short') return fail('file not truncated')
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    const stale = writeTextFile(f, 'stale', w.mtimeMs, false)
    if (stale.ok || !stale.conflict || readFileSync(f, 'utf8') !== 'short') return fail('stale mtime should be refused ' + JSON.stringify(stale))
    const forced = writeTextFile(f, 'forced', w.mtimeMs, true)
    if (!forced.ok || readFileSync(f, 'utf8') !== 'forced') return fail('force should override ' + JSON.stringify(forced))
    const missing = join(d, 'nope.txt')
    if (writeTextFile(missing, 'x', 0, true).ok || existsSync(missing)) return fail('missing path should be refused and not created')
    if (writeTextFile(d, 'x', 0, true).ok) return fail('directory should be refused')
    return { ok: true, msg: 'write: in-place save, CRLF+BOM round-trip, stale mtime refused, force overrides, missing path refused' }
  } catch (err) {
    return fail(String(err))
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

/** Check: extra env vars given to spawnShell reach the shell and override inherited values (the MCP per-terminal context). */
function checkPtyEnv(dir: string, shell: string, track: (p: IPty) => void): Promise<CheckResult> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const finish = (ok: boolean, msg: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      setTimeout(() => resolve({ ok, msg }), 0)
    }
    process.env.TERMINALS_LOC_ID = 'inherited'
    const want = 'env=smoke-loc|c:\\x'
    const p = spawnShell(
      shell,
      dir,
      120,
      24,
      {
        onData: (d) => {
          output += d
          if (output.includes(want)) finish(true, 'pty env: TERMINALS_LOC_ID/TERMINALS_LOC_PATH reach the shell and override inherited values')
        },
        onExit: (code) => finish(false, `pty env: shell exited early with code ${code}`)
      },
      { TERMINALS_LOC_ID: 'smoke-loc', TERMINALS_LOC_PATH: 'c:\\x' }
    )
    delete process.env.TERMINALS_LOC_ID
    track(p)
    const timer = setTimeout(() => finish(false, `pty env: timeout. Output: ${JSON.stringify(output.slice(-300))}`), 10000)
    const cmd = /pwsh|powershell/i.test(shell)
      ? "Write-Output ('env=' + $env:TERMINALS_LOC_ID + '|' + $env:TERMINALS_LOC_PATH)"
      : 'echo env=%TERMINALS_LOC_ID%^|%TERMINALS_LOC_PATH%'
    setTimeout(() => p.write(cmd + '\r'), 1500)
  })
}

/** Check: MCP location resolution, command/prompt validation and the auth/host guards, against a synthetic state. */
function checkMcpLogic(dir: string): CheckResult {
  const p = (...n: string[]): string => join(dir, ...n)
  mkdirSync(p('alpha'), { recursive: true })
  const folder = (id: string, name: string, path: string, groupId: string | null): AppState['folders'][number] => ({
    id,
    name,
    path,
    order: 0,
    groupId,
    missing: false,
    isGit: false,
    branch: null
  })
  const group = (id: string, kind: 'manual' | 'parent', name: string, path: string | null): AppState['groups'][number] => ({
    id,
    kind,
    name,
    path,
    order: 0,
    collapsed: false,
    showHidden: false,
    missing: false,
    isGit: false,
    branch: null,
    children: [],
    hiddenCount: 0
  })
  const repos = group('g2', 'parent', 'repos', p('repos'))
  const childPath = p('repos', 'one')
  repos.children = [{ id: childId(childPath), path: childPath, name: 'one', isGit: false, branch: null, hidden: false }]
  const state: AppState = {
    folders: [
      folder('f1', 'alpha', p('alpha'), 'g1'),
      folder('f2', 'Beta', p('beta'), null),
      folder('f3', 'dup', p('dup1'), null),
      folder('f4', 'DUP', p('dup2'), null)
    ],
    groups: [group('g1', 'manual', 'Work', null), repos],
    commands: [
      { id: 'c1', name: 'build', ownerId: 'f1', mode: 'parallel', targets: [{ cwd: p('alpha'), steps: ['yarn build'] }] },
      {
        id: 'c2',
        name: 'all',
        ownerId: 'g1',
        mode: 'sequential',
        targets: [
          { cwd: p('alpha'), steps: ['a'] },
          { cwd: p('beta'), steps: ['b'] }
        ]
      }
    ],
    snippets: [{ id: 's1', name: 'hi', body: 'hello', scope: 'global' }],
    selectedId: null,
    settings: { ...DEFAULT_SETTINGS },
    ui: { sidebarWidth: 260, panelWidth: 340, sidebarCollapsed: false, panes: null, panelOpen: false, panelTab: 'files' },
    resolvedShell: ''
  }
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'mcp logic: ' + m })
  /** Returns the ToolError message, or null when fn did not throw one. */
  const err = (fn: () => unknown): string | null => {
    try {
      fn()
      return null
    } catch (e) {
      return e instanceof ToolError ? e.message : 'non-ToolError ' + String(e)
    }
  }
  try {
    if (findLocation(state, 'f2').id !== 'f2') return fail('by id')
    if (findLocation(state, p('BETA') + '\\').id !== 'f2') return fail('by path (case, trailing slash)')
    if (findLocation(state, 'beta').id !== 'f2') return fail('by name')
    if (findLocation(state, childPath).id !== childId(childPath)) return fail('child path should resolve to the child id')
    if (findLocation(state, 'Work', ['manual']).id !== 'g1') return fail('group by name')
    if (!err(() => findLocation(state, 'dup'))?.includes('matches 2')) return fail('ambiguous name not reported')
    if (!err(() => findLocation(state, p('nope')))?.includes('not a saved folder')) return fail('unknown path')
    if (!err(() => findLocation(state, 'f1', ['manual']))?.includes('expected a manual group')) return fail('wrong kind')
    if (!err(() => findLocation(state, '\\alpha'))?.includes('No location')) return fail('drive-less path must not count as absolute')
    if (!err(() => contextLocation(state, undefined, undefined))?.includes('X-Terminals-Location')) return fail('no location/header')
    if (!err(() => contextLocation(state, undefined, 'gone'))?.includes('no longer exists')) return fail('stale header')
    if (contextLocation(state, undefined, 'f1').id !== 'f1' || contextLocation(state, 'Beta', 'f1').id !== 'f2')
      return fail('header / explicit precedence')

    const c = planCommand(state, { name: ' test ', steps: ['yarn lint\nyarn test', '  '] }, 'f1')
    if (!c.created || c.command.ownerId !== 'f1' || c.command.name !== 'test' || c.command.mode !== 'sequential') return fail('new command defaults to sequential ' + JSON.stringify(c))
    if (c.command.targets.length !== 1 || c.command.targets[0].cwd !== p('alpha') || c.command.targets[0].steps.join('|') !== 'yarn lint|yarn test' || c.warnings.length)
      return fail('steps-only target ' + JSON.stringify(c.command.targets))
    if (planCommand(state, { name: 'x', steps: ['a'], scope: 'group' }, 'f1').command.ownerId !== 'g1') return fail('scope group')
    if (!err(() => planCommand(state, { name: 'x', steps: ['a'], scope: 'group' }, 'f2'))?.includes('not in a group')) return fail('scope group without group')
    if (!err(() => planCommand(state, { name: '  ', steps: ['a'] }, 'f1'))?.includes('must not be empty')) return fail('empty name')
    if (!err(() => planCommand(state, { name: 'x', targets: [{ cwd: 'rel\\dir', steps: ['a'] }] }, 'f1'))?.includes('absolute')) return fail('relative cwd')
    if (!err(() => planCommand(state, { name: 'x', targets: [{ cwd: p('alpha'), steps: [' '] }] }, 'f1'))?.includes('step')) return fail('empty steps')
    if (!err(() => planCommand(state, { name: 'x', steps: ['a'], targets: [] }, 'f1'))?.includes('not both')) return fail('steps and targets')
    if (!err(() => planCommand(state, { name: 'x', steps: ['a'] }, 'g1'))?.includes('manual group')) return fail('steps on a manual group')
    if (!err(() => planCommand(state, { id: 'nope', name: 'x' }, 'f1'))?.includes('Unknown command id')) return fail('unknown id')
    if (!err(() => planCommand(state, { name: 'x' }, 'f1'))?.includes('Pass `steps`')) return fail('no steps/targets')
    const u = planCommand(state, { id: 'c1', steps: ['yarn build:all'] }, undefined)
    if (u.created || u.command.ownerId !== 'f1' || u.command.name !== 'build' || u.command.targets[0].cwd !== p('alpha') || u.command.mode !== 'parallel') return fail('update keeps owner/name/cwd ' + JSON.stringify(u))
    if (!err(() => planCommand(state, { id: 'c2', steps: ['x'] }, undefined))?.includes('2 targets')) return fail('multi-target steps update')
    if (planCommand(state, { name: 'x', targets: [{ cwd: p('missing'), steps: ['a'] }] }, 'f1').warnings.length !== 1) return fail('missing cwd warning')

    const gl = planCommand(state, { name: 'lint', steps: ['yarn lint'], scope: 'global' }, 'f1')
    if (!gl.created || gl.command.ownerId !== 'global' || gl.command.targets.length !== 1 || gl.command.targets[0].cwd !== '' || gl.warnings.length)
      return fail('global save ' + JSON.stringify(gl))
    if (planCommand(state, { name: 'lint', steps: ['x'], scope: 'global' }, undefined).command.ownerId !== 'global') return fail('global needs no location')
    const glt = planCommand(state, { name: 'two', scope: 'global', targets: [{ cwd: '', steps: ['a'] }, { cwd: p('beta'), steps: ['b'] }] }, undefined)
    if (glt.command.targets[0].cwd !== '' || glt.command.targets[1].cwd !== p('beta')) return fail('global targets ' + JSON.stringify(glt.command.targets))
    if (!err(() => planCommand(state, { name: 'x', scope: 'global', targets: [{ cwd: p('beta'), steps: ['a'] }, { cwd: '', steps: ['b'] }] }, undefined))?.includes('absolute'))
      return fail('empty cwd only allowed on first global target')
    const withGlobal: AppState = { ...state, commands: [...state.commands, gl.command] }
    const gu = planCommand(withGlobal, { id: gl.command.id, steps: ['yarn lint:fix'] }, undefined)
    if (gu.command.ownerId !== 'global' || gu.command.targets[0].cwd !== '') return fail('global update keeps scope ' + JSON.stringify(gu))
    const moved = planCommand(withGlobal, { id: gl.command.id, location: 'f2' }, undefined)
    if (moved.command.ownerId !== 'f2' || moved.command.targets[0].cwd !== p('beta')) return fail('global moved to folder ' + JSON.stringify(moved))
    const vis = visibleCommands(withGlobal, { id: 'f1', groupId: 'g1' })
    const kinds = vis.map((x) => `${x.id}:${x.scopeKind}`).join(',')
    if (kinds !== `c1:location,c2:group,${gl.command.id}:global`) return fail('list includes global ' + kinds)
    if (visibleCommands(withGlobal, { id: 'f2', groupId: null }).map((x) => x.id).join(',') !== gl.command.id) return fail('list global only for ungrouped folder')

    if (planPrompt(state, { name: 'n', body: 'b' }, 'f2').prompt.scope !== 'f2') return fail('prompt default scope')
    if (planPrompt(state, { name: 'n', body: 'b', scope: 'GLOBAL' }, 'f2').prompt.scope !== 'global') return fail('prompt global scope')
    if (planPrompt(state, { name: 'n', body: 'b', scope: 'Work' }, 'f2').prompt.scope !== 'g1') return fail('prompt scope by name')
    if (!err(() => planPrompt(state, { name: 'n', body: ' ' }, 'f2'))?.includes('body')) return fail('empty prompt body')
    if (!err(() => planPrompt(state, { name: 'n', body: 'b', scope: 'nowhere' }, 'f2'))?.includes('No location')) return fail('unknown prompt scope')
    const pu = planPrompt(state, { id: 's1', body: 'new' }, 'f2')
    if (pu.created || pu.prompt.scope !== 'global' || pu.prompt.name !== 'hi') return fail('prompt update keeps scope/name')

    if (!hostAllowed('127.0.0.1:5000', 5000) || !hostAllowed('localhost:5000', 5000)) return fail('host allowed')
    if (hostAllowed('evil.example:5000', 5000) || hostAllowed('127.0.0.1:5001', 5000) || hostAllowed('127.0.0.1', 5000) || hostAllowed(undefined, 5000))
      return fail('host rejected')
    if (!tokenMatches('Bearer abc', 'abc') || !tokenMatches('bearer abc', 'abc')) return fail('token accepted')
    if (tokenMatches('Bearer abd', 'abc') || tokenMatches('abc', 'abc') || tokenMatches(undefined, 'abc') || tokenMatches('Bearer ', '')) return fail('token rejected')
    return { ok: true, msg: 'mcp logic: location by id/path/name/child, ambiguity and kind errors, header fallback, command/prompt validation, host and token guards' }
  } catch (e) {
    return fail(String(e))
  }
}

export async function runSmoke(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'terminals-smoke-'))
  const shell = resolveShell('')
  const ptys: IPty[] = []
  const track = (p: IPty): void => void ptys.push(p)

  const results = [
    await checkInteractive(dir, shell, track),
    await checkSteps(dir, shell, track),
    await checkPtyEnv(dir, shell, track),
    checkMigration(),
    checkSettings(),
    checkPanes(),
    checkWrite(),
    checkMcpLogic(dir),
    await checkGit()
  ]
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
