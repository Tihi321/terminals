import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { resolveShell, spawnShell, spawnSteps, stepsShell } from './pty'
import { childId, migrate, moveGroupData, moveItemData, nestItemData, removeGroupData, setGroupFolderData, type Persisted } from './store'
import { copyIntoDir, createFolderIn, uniqueName } from './fsCopy'
import { subtreeGroupIds } from '../shared/groupTree'
import { readFileContent, writeTextFile } from './fsops'
import { SCHEMA_VERSION, type AppState } from '../shared/types'
import { DEFAULT_SETTINGS, DEFAULT_TERMINAL_FONT, patchSettings, sanitizeSettings } from '../shared/settings'
import { THEME_IDS, THEMES, UI_VARS, resolveThemeId } from '../shared/themes'
import { contextLocation, findLocation, planCommand, planPrompt, resolveOpenTarget, RUN_DISABLED_ERROR, ToolError, visibleCommands } from './mcpTools'
import { hostAllowed, startMcpServer, tokenMatches } from './mcp'
import { TerminalHost } from './terminalHost'
import { buildRunInput, findMarkers, toLines } from './termText'
import { canAddPane, closePane, dragDivider, dropOnEdge, focusLoc, fromPersisted, normalize, openToSide, splitBeside, toPersisted } from '../shared/panes'
import { applyOrder, moveId, shiftId } from '../shared/order'
import { activateIn, moveTab, reconcileActive, shiftTab } from '../shared/tabs'
import { planRestore, restorePaths, sanitizeTabs, toPersistedTabs, type RestoreCtx } from '../shared/session'
import { checkElevatedRequest, elevatedCommand, gsudoCandidates, parseSudoMode, resolveElevator } from './elevation'
import { elevationFailed } from '../shared/elevation'
import type { PersistedTab } from '../shared/types'
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
  const v4 = {
    version: 4,
    ui: {
      tabs: [
        { id: 't1', locId: 'f1', kind: 'shell', title: 'PowerShell 1', cwd: 'C:\\a\\proj' },
        { id: 't2', locId: 'f1', kind: 'bogus', title: 'x', cwd: 'C:\\a\\proj' }
      ]
    }
  }
  const a = migrate(v2 as never)
  const b = migrate(v1 as never)
  const c = migrate(v4 as never)
  const ok =
    SCHEMA_VERSION === 4 &&
    a.ui.tabs.length === 0 &&
    c.ui.tabs.length === 1 &&
    c.ui.tabs[0]?.id === 't1' &&
    a.snippets.length === 0 &&
    a.folders.length === 1 &&
    a.commands.length === 1 &&
    a.selectedId === 'f1' &&
    b.snippets.length === 0 &&
    b.folders[0]?.groupId === null
  return { ok, msg: ok ? 'migration: v2 and v1 files migrate (v4, ui.tabs) with snippets: [] and data kept' : 'migration: unexpected result ' + JSON.stringify({ a, b }) }
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
    ui: {
      panes: {
        locIds: ['a', 'b', 'a', 5, 'c', 'd', 'e'],
        fractions: [1, 1, 1, 1, 1, 1, 1],
        focused: 3,
        active: ['t1', 't2', 't3', 't4', 5, 't6', 't7']
      }
    }
  } as never)
  const dp = dirty.ui.panes
  if (
    !dp ||
    dp.locIds.join() !== 'a,b,a,c' ||
    dp.focused !== 0 ||
    Math.abs(dp.fractions.reduce((x, y) => x + y, 0) - 1) > 1e-9 ||
    (dp.active ?? []).map((a) => a ?? '-').join() !== 't1,t2,t3,-'
  )
    return fail('dirty layout not cleaned ' + JSON.stringify(dp))
  if (migrate({ ui: { panes: 'nope' } } as never).ui.panes !== null) return fail('garbage should become null')

  const valid = new Set(['a', 'b', 'c', 'd', 'e'])
  const loadedAll = fromPersisted({ locIds: ['a', 'gone', 'b'], fractions: [0.2, 0.3, 0.5], focused: 2, active: ['t1', 't2', 't3'] }, valid, 'a', mk)
  const loaded = loadedAll.state
  if (
    loaded.panes.map((p) => p.locId).join() !== 'a,b' ||
    loaded.focused !== 1 ||
    Math.abs(loaded.fractions[0] - 0.2 / 0.7) > 1e-9 ||
    loadedAll.active.join() !== 't1,t3'
  )
    return fail('fromPersisted ' + JSON.stringify(loadedAll))
  const fallback = fromPersisted(null, valid, 'c', mk)
  if (fallback.state.panes.length !== 1 || fallback.state.panes[0].locId !== 'c' || fallback.active.join() !== '') return fail('fallback pane')
  const dupes = fromPersisted({ locIds: ['a', 'a'], fractions: [0.5, 0.5], focused: 1, active: ['t1', 't2'] }, valid, 'a', mk)
  const rt = toPersisted(dupes.state, { [dupes.state.panes[1].id]: 'x' })
  if (dupes.state.panes.length !== 2 || dupes.active.join() !== 't1,t2' || !rt || rt.active?.join() !== ',x') return fail('same-folder panes ' + JSON.stringify({ dupes, rt }))

  let s = fromPersisted(null, valid, 'a', mk).state
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
  const twin = normalize({ panes: [{ id: 'x', locId: 'a' }, { id: 'y', locId: 'a' }, { id: 'z', locId: 'b' }], fractions: [0.25, 0.25, 0.5], focused: 0 }, valid, 'a', mk)
  if (twin.panes.map((p) => p.locId).join() !== 'a,a,b') return fail('normalize keeps duplicates')
  const two = { panes: [{ id: 'x', locId: 'a' }, { id: 'y', locId: 'a' }, { id: 'z', locId: 'b' }], fractions: [0.25, 0.25, 0.5], focused: 1 }
  if (focusLoc(two, 'a') !== two) return fail('focusLoc should keep a focused duplicate')
  if (focusLoc({ ...two, focused: 2 }, 'a').focused !== 0) return fail('focusLoc should focus the first match')
  const self = splitBeside({ panes: [{ id: 'x', locId: 'a' }], fractions: [1], focused: 0 }, 'a', 0, 'right', mk)
  if (self.panes.map((p) => p.locId).join() !== 'a,a' || self.fractions.join() !== '0.5,0.5' || self.focused !== 1) return fail('splitBeside own folder ' + JSON.stringify(self))
  const four = { panes: [0, 1, 2, 3].map((i) => ({ id: 'q' + i, locId: 'a' })), fractions: [0.25, 0.25, 0.25, 0.25], focused: 0 }
  if (splitBeside(four, 'a', 0, 'left', mk) !== four) return fail('splitBeside fifth pane should be refused')
  return { ok: true, msg: 'panes: migrate cleans/defaults the layout and active ids; open/drop/close/divider/normalize/focus/split helpers behave' }
}

const ids = (t: { id: string }[]): string => t.map((x) => x.id).join()

/** Check: tab reorder keeps other folders in place, shifting stops at the edges, and the per-pane active map reconciles. */
function checkTabs(): CheckResult {
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'tabs: ' + m })
  const tabs = [
    { id: 'a1', locId: 'A' },
    { id: 'b1', locId: 'B' },
    { id: 'a2', locId: 'A' },
    { id: 'b2', locId: 'B' },
    { id: 'a3', locId: 'A' }
  ]
  if (ids(moveTab(tabs, 'a3', 'a1')) !== 'a3,b1,a1,b2,a2') return fail('moveTab before ' + ids(moveTab(tabs, 'a3', 'a1')))
  if (ids(moveTab(tabs, 'a1', null)) !== 'a2,b1,a3,b2,a1') return fail('moveTab to the end ' + ids(moveTab(tabs, 'a1', null)))
  if (moveTab(tabs, 'a1', 'b2') !== tabs || moveTab(tabs, 'nope', null) !== tabs) return fail('moveTab foreign beforeId / unknown id')
  if (shiftTab(tabs, 'a1', -1) !== tabs || shiftTab(tabs, 'a3', 1) !== tabs) return fail('shiftTab at an edge')
  if (ids(shiftTab(tabs, 'a2', 1)) !== 'a1,b1,a3,b2,a2') return fail('shiftTab ' + ids(shiftTab(tabs, 'a2', 1)))

  const panes = [
    { id: 'p0', locId: 'A' },
    { id: 'p1', locId: 'A' },
    { id: 'p2', locId: 'B' }
  ]
  const same = { p0: 'a1', p1: 'a1', p2: 'b1' }
  const r = reconcileActive(panes, 1, tabs, same, {})
  if (r.p1 !== 'a1' || r.p0 !== 'a2' || r.p2 !== 'b1') return fail('focused pane should win a conflict ' + JSON.stringify(r))
  const solo = reconcileActive([panes[0], panes[1]], 0, [tabs[0]], {}, {})
  if (solo.p0 !== 'a1' || 'p1' in solo) return fail('taken-only folder pane should get no entry ' + JSON.stringify(solo))
  const pref = reconcileActive(panes, 0, tabs, {}, { A: 'a3' })
  if (pref.p0 !== 'a3' || pref.p1 !== 'a1') return fail('lastByLoc should be preferred ' + JSON.stringify(pref))
  const valid = { p0: 'a1', p1: 'a2', p2: 'b1' }
  if (reconcileActive(panes, 0, tabs, valid, {}) !== valid) return fail('valid map should keep its reference')
  const moved = activateIn(panes, tabs, valid, 'p0', 'a2')
  if (moved.p0 !== 'a2' || moved.p1 !== 'a3') return fail('activateIn should give the old pane its neighbour ' + JSON.stringify(moved))
  return { ok: true, msg: 'tabs: moveTab/shiftTab keep other folders in place; reconcileActive and activateIn keep a tab in one pane' }
}

/** Check: reordering saved items moves one id, keeps ids, and leaves items outside the visible list in place. */
function checkOrder(): CheckResult {
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'order: ' + m })
  const abc = ['a', 'b', 'c']
  if (moveId(abc, 'c', 'a').join() !== 'c,a,b') return fail('moveId before')
  if (moveId(abc, 'a', null).join() !== 'b,c,a') return fail('moveId to the end')
  if (moveId(abc, 'b', 'b') !== abc || moveId(abc, 'a', 'b') !== abc || moveId(abc, 'x', null) !== abc || moveId(abc, 'a', 'x') !== abc)
    return fail('moveId no-ops should keep the reference')
  if (shiftId(abc, 'a', -1) !== abc || shiftId(abc, 'c', 1) !== abc || shiftId(abc, 'x', 1) !== abc) return fail('shiftId edge / unknown')
  if (shiftId(abc, 'b', -1).join() !== 'b,a,c' || shiftId(abc, 'b', 1).join() !== 'a,c,b') return fail('shiftId')
  const items = [{ id: 'g1' }, { id: 'f1' }, { id: 'g2' }, { id: 'f2' }, { id: 'g3' }]
  if (ids(applyOrder(items, ['g3', 'g1', 'g2'])) !== 'g3,f1,g1,f2,g2') return fail('applyOrder subset ' + ids(applyOrder(items, ['g3', 'g1', 'g2'])))
  if (ids(applyOrder(items, ['f2', 'f1'])) !== 'g1,f2,g2,f1,g3') return fail('applyOrder other subset')
  if (applyOrder(items, ['g1', 'g2']) !== items || applyOrder(items, ['g1', 'nope']) !== items || applyOrder(items, ['g1', 'g1']) !== items)
    return fail('applyOrder same order / unknown / repeated id should keep the reference')
  return { ok: true, msg: 'order: moveId/shiftId/applyOrder reorder a visible subset and keep everything else in place' }
}

/** Check: saved tabs are sanitised, and the restore plan keeps order, skips missing things, falls back cwd, anchors runs and maps ids. */
function checkSession(): CheckResult {
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'session: ' + m })
  const good: PersistedTab[] = [
    { id: 's1', locId: 'A', kind: 'shell', title: 'PS 1', cwd: 'C:\\gone', shell: 'pwsh.exe', startCwd: 'C:\\a\\sub' },
    { id: 'c1', locId: 'A', kind: 'command', title: 'build', cwd: 'C:\\a', run: { commandId: 'cmd1', runId: 'r1', target: 0 } },
    { id: 'f1', locId: 'A', kind: 'file', title: 'x.ts', cwd: 'C:\\a\\x.ts', file: 'C:\\a\\x.ts' },
    { id: 'f2', locId: 'A', kind: 'file', title: 'old.ts', cwd: 'C:\\a\\old.ts', file: 'C:\\a\\old.ts' },
    { id: 'd1', locId: 'B', kind: 'diff', title: 'diff', cwd: 'C:\\b', diff: { folder: 'C:\\b', mode: 'unstaged', path: 'z.ts' } },
    { id: 'z1', locId: 'Z', kind: 'shell', title: 'PS 1', cwd: 'C:\\z' },
    { id: 'c2', locId: 'A', kind: 'command', title: 'dead', cwd: 'C:\\a', run: { commandId: 'deleted', runId: 'r2', target: 0 } },
    { id: 's2', locId: 'A', kind: 'shell', title: 'PS 2', cwd: 'C:\\a' },
    { id: 'e1', locId: 'A', kind: 'shell', title: 'Admin PS 1', cwd: 'C:\\a', shell: 'pwsh.exe', elevated: true }
  ]
  const dirty = sanitizeTabs([
    ...good,
    null,
    'x',
    { ...good[0] },
    { ...good[0], id: 'k1', kind: 'weird' },
    { ...good[0], id: 'k2', cwd: '' },
    { id: 'k3', locId: 'A', kind: 'diff', title: 't', cwd: 'C:\\b', diff: { folder: 'C:\\b', mode: 'commit', path: 'p' } },
    { id: 'k4', locId: 'A', kind: 'command', title: 't', cwd: 'C:\\a', run: { commandId: 'c', runId: 'r', target: -1 } },
    { ...good[0], id: 'k5', elevated: 'yes' }
  ])
  if (ids(dirty) !== ids(good) + ',k5') return fail('sanitizeTabs kept ' + ids(dirty))
  const byId = (id: string): PersistedTab | undefined => dirty.find((t) => t.id === id)
  if (byId('e1')?.elevated !== true || byId('k5')?.elevated !== undefined) return fail('sanitizeTabs elevated: true kept, other values dropped')
  if (sanitizeTabs([{ ...good[2], elevated: true }])[0]?.elevated !== undefined) return fail('sanitizeTabs should drop elevated on a non-shell tab')
  if (toPersistedTabs([{ ...good[7], kind: 'shell', elevated: true }], {})[0]?.elevated !== true) return fail('toPersistedTabs should carry elevated')
  const existing = new Set(['C:\\a\\sub', 'C:\\a', 'C:\\a\\x.ts', 'C:\\b', 'C:\\z'])
  if (!restorePaths(good).includes('C:\\a\\x.ts')) return fail('restorePaths')
  let n = 0
  const ctx: RestoreCtx = {
    locs: new Map([
      ['A', { path: 'C:\\a', missing: false }],
      ['B', { path: 'C:\\b', missing: false }],
      ['Z', { path: 'C:\\z', missing: true }]
    ]),
    commandIds: new Set(['cmd1']),
    exists: (p) => existing.has(p),
    mkId: () => `n${n++}`
  }
  const plan = planRestore(good, ctx)
  const got = plan.tabs.map((t) => t.id).join()
  if (got !== 's1,f1,d1,s2,e1') return fail('plan tabs (order, missing folder/file, deleted command) ' + got)
  if (plan.tabs[0].cwd !== 'C:\\a\\sub' || plan.tabs[0].fallbackCwd !== 'C:\\a') return fail('shell should fall back to startCwd ' + JSON.stringify(plan.tabs[0]))
  if (plan.runs.length !== 1 || plan.runs[0].commandId !== 'cmd1' || plan.runs[0].anchor !== plan.idMap.f1 || plan.runs[0].snapshotIds[0] !== 'c1')
    return fail('run anchor ' + JSON.stringify(plan.runs))
  if (plan.idMap.s1 !== plan.tabs[0].newId || plan.idMap.f2 !== undefined) return fail('idMap ' + JSON.stringify(plan.idMap))
  if (plan.tabs[4].elevated !== true) return fail('planRestore should carry elevated ' + JSON.stringify(plan.tabs[4]))
  return { ok: true, msg: 'session: sanitizeTabs drops bad entries; planRestore keeps order, skips missing folder/file/command, falls back cwd, anchors runs' }
}

/** Check: elevator lookup order, sudo mode parsing, elevated command line and failure rule. Injected deps only; nothing elevates or reads the registry. */
function checkElevation(): CheckResult {
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'elevation: ' + m })
  const base = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }
  const gsudoPath = 'C:\\tools\\gsudo.exe'
  const sudoPath = 'C:\\Windows\\System32\\sudo.exe'
  const only = (...ps: string[]) => (p: string): boolean => ps.includes(p)
  const a = resolveElevator({ env: { ...base, PATH: 'C:\\x;"C:\\tools"' }, exists: only(gsudoPath, sudoPath), sudoMode: () => 'normal' })
  if (a?.tool !== 'gsudo' || a.path !== gsudoPath) return fail('gsudo on PATH should win over sudo ' + JSON.stringify(a))
  const b = resolveElevator({ env: { ...base, PATH: '' }, exists: only('C:\\Program Files\\gsudo\\Current\\gsudo.exe'), sudoMode: () => 'disabled' })
  if (b?.tool !== 'gsudo') return fail('gsudo in Program Files with an empty PATH ' + JSON.stringify(b))
  const c = resolveElevator({ env: base, exists: only(sudoPath), sudoMode: () => 'normal' })
  if (c?.tool !== 'sudo' || c.path !== sudoPath) return fail('sudo in normal mode ' + JSON.stringify(c))
  for (const mode of ['disabled', 'forceNewWindow', 'disableInput', 'unknown'] as const)
    if (resolveElevator({ env: base, exists: only(sudoPath), sudoMode: () => mode })) return fail('sudo must be unused in mode ' + mode)
  if (resolveElevator({ env: { ...base, PATH: 'C:\\x' }, exists: only('C:\\x\\sudo.exe'), sudoMode: () => 'normal' })) return fail('sudo must come only from System32')
  if (gsudoCandidates({ PATH: 'rel;C:\\p' }).some((p) => !/^[A-Za-z]:\\/.test(p))) return fail('candidates must be absolute')

  if (parseSudoMode('    Enabled    REG_DWORD    0x3\r\n') !== 'normal' || parseSudoMode('Enabled    REG_DWORD    0x0') !== 'disabled' || parseSudoMode('nope') !== 'unknown')
    return fail('parseSudoMode')

  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  const g = { tool: 'gsudo', path: gsudoPath } as const
  const cmd = elevatedCommand(pwsh, g)
  if (cmd?.file !== gsudoPath || cmd.args.join('|') !== `--direct|${pwsh}|-NoLogo`) return fail('gsudo command ' + JSON.stringify(cmd))
  if (elevatedCommand('cmd.exe', g)?.args.join('|') !== '--direct|cmd.exe') return fail('cmd gets no -NoLogo')
  if (elevatedCommand(pwsh, { tool: 'sudo', path: sudoPath })?.args.join('|') !== `${pwsh}|-NoLogo`) return fail('sudo has no gsudo flag')
  if (elevatedCommand('C:\\bin\\bash.exe', g) !== null) return fail('non-runnable shell must give null')
  if (elevatedCommand('C:\\x\\pwsh-tools\\payload.exe', g) !== null) return fail('lookalike shell basename must give null')
  if (!checkElevatedRequest({ elevated: true, steps: [] }) || checkElevatedRequest({ elevated: true }) !== null || checkElevatedRequest({ steps: ['x'] }) !== null)
    return fail('checkElevatedRequest')
  if (!elevationFailed(999, 60000) || !elevationFailed(1223, 60000) || !elevationFailed(1, 500) || elevationFailed(1, 60000) || elevationFailed(0, 100))
    return fail('elevationFailed')
  return { ok: true, msg: 'elevation: gsudo before sudo, sudo only in normal mode from System32, sudo mode parsing, fixed elevated command line, steps rejected, failure rule' }
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

/** Check: group folder (set/clear/persist), folder creation errors, copy-into with the "name (2)" rule and the self-copy guard. */
function checkGroupFolder(): CheckResult {
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'group folder: ' + m })
  const root = mkdtempSync(join(tmpdir(), 'terminals-smoke-gf-'))
  try {
    // Store: optional field, cleared, parent groups refuse it, survives migrate, old files without it load.
    const d = migrate({
      version: 4,
      groups: [
        { id: 'm', kind: 'manual', name: 'm', order: 0 },
        { id: 'p', kind: 'parent', name: 'p', path: join(root, 'p'), order: 1 }
      ]
    })
    if (d.groups.some((g) => g.folder !== undefined)) return fail('old state should load without a folder')
    if (!setGroupFolderData(d, 'm', join(root, 'target'))) return fail('set on manual group refused')
    if (setGroupFolderData(d, 'p', join(root, 'x')) || setGroupFolderData(d, 'nope', join(root, 'x'))) return fail('parent / unknown group should refuse a folder')
    const again = migrate(JSON.parse(JSON.stringify(d)) as Record<string, unknown>)
    if (again.groups.find((g) => g.id === 'm')?.folder !== join(root, 'target')) return fail('folder did not survive a save/load round trip')
    if (!setGroupFolderData(d, 'm', null) || d.groups.find((g) => g.id === 'm')?.folder !== undefined) return fail('clear did not remove the folder')

    // createFolderIn
    const made = createFolderIn(root, 'fresh')
    if (!made.ok || !statSync(join(root, 'fresh')).isDirectory()) return fail('create ' + JSON.stringify(made))
    const dup = createFolderIn(root, 'FRESH')
    if (dup.ok || !/already exists/.test(dup.error)) return fail('duplicate name should be refused ' + JSON.stringify(dup))
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'a:b', 'a*', 'q?', 'x.', 'con', '..']) {
      if (createFolderIn(root, bad).ok) return fail(`invalid name accepted: "${bad}"`)
    }
    if (createFolderIn(join(root, 'missing-parent'), 'x').ok) return fail('missing parent should be refused')
    if (existsSync(join(root, 'a'))) return fail('invalid name created something')

    // uniqueName
    const u = join(root, 'u')
    mkdirSync(u)
    writeFileSync(join(u, 'a.txt'), '1')
    writeFileSync(join(u, 'a (2).txt'), '2')
    mkdirSync(join(u, 'dir.v1'))
    if (uniqueName(u, 'a.txt', false) !== 'a (3).txt') return fail('a.txt -> ' + uniqueName(u, 'a.txt', false))
    if (uniqueName(u, 'b.txt', false) !== 'b.txt') return fail('free name should be kept')
    if (uniqueName(u, 'dir.v1', true) !== 'dir.v1 (2)') return fail('folder counter goes after the whole name: ' + uniqueName(u, 'dir.v1', true))

    // copyIntoDir
    const src = join(root, 'src')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'a.txt'), 'new')
    writeFileSync(join(src, 'sub', 'deep.txt'), 'deep')
    const r1 = copyIntoDir([join(src, 'a.txt'), join(src, 'sub')], u)
    if (!r1.ok || r1.copied.join('|') !== 'a (3).txt|sub' || r1.failed.length) return fail('copy ' + JSON.stringify(r1))
    if (readFileSync(join(u, 'a.txt'), 'utf8') !== '1') return fail('existing file was overwritten')
    if (readFileSync(join(u, 'sub', 'deep.txt'), 'utf8') !== 'deep') return fail('folder not copied recursively')
    const r2 = copyIntoDir([join(src, 'sub')], u)
    if (!r2.ok || r2.copied[0] !== 'sub (2)') return fail('second copy of a folder should be "sub (2)" ' + JSON.stringify(r2))
    // Self-copy guard and same-parent skip.
    const r3 = copyIntoDir([src], join(src, 'sub'))
    if (!r3.ok || r3.copied.length || r3.failed.length !== 1 || existsSync(join(src, 'sub', 'src'))) return fail('folder into its own subfolder must be refused ' + JSON.stringify(r3))
    const r4 = copyIntoDir([src], src)
    if (!r4.ok || r4.copied.length || r4.failed.length !== 1) return fail('folder into itself must be refused ' + JSON.stringify(r4))
    const r5 = copyIntoDir([join(src, 'a.txt')], src)
    if (!r5.ok || r5.copied.length || r5.skipped[0] !== 'a.txt' || existsSync(join(src, 'a (2).txt'))) return fail('source already in the destination should be skipped ' + JSON.stringify(r5))
    if (copyIntoDir([join(src, 'a.txt')], join(root, 'gone')).ok) return fail('missing destination should be refused')
    return { ok: true, msg: 'group folder: set/clear/persist, create (duplicate + invalid names refused), copy-into with "name (2)", self-copy and same-parent guards' }
  } catch (err) {
    return fail(String(err))
  } finally {
    rmSync(root, { recursive: true, force: true })
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

/** Check: nested groups: migration of parentId, moveGroupData rules and cascade removal. Pure, works on migrate() output. */
function checkGroupTree(): CheckResult {
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'group tree: ' + m })
  const root = join(tmpdir(), 'terminals-grouptree')
  const p = (...n: string[]): string => join(root, ...n)
  const g = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, kind: 'manual', name: id, order: 0, ...extra })
  const parentOf = (d: Persisted, id: string): string | null | undefined => d.groups.find((x) => x.id === id)?.parentId
  try {
    // 1. Old flat state, then dangling / non-manual / cyclic parents.
    const flat = migrate({
      version: 4,
      folders: [{ id: 'f1', path: p('f1'), groupId: 'a' }],
      groups: [g('a'), g('b', { kind: 'parent', path: p('b') })]
    })
    if (flat.groups.some((x) => x.parentId !== null) || flat.folders[0]?.groupId !== 'a') return fail('flat state should keep top level groups and folder membership')
    const bad = migrate({
      version: 4,
      groups: [
        g('x', { parentId: 'nope' }),
        g('pk', { kind: 'parent', path: p('pk') }),
        g('y', { parentId: 'pk' }),
        g('a', { parentId: 'b' }),
        g('b', { parentId: 'a' })
      ]
    })
    if (parentOf(bad, 'x') !== null) return fail('dangling parent should become null')
    if (parentOf(bad, 'y') !== null) return fail('parent-kind parent should become null')
    for (const x of bad.groups) {
      const sub = subtreeGroupIds(bad.groups, x.id)
      if (sub.length > bad.groups.length || sub.slice(1).includes(x.id)) return fail('cycle left behind for ' + x.id)
    }
    if (parentOf(bad, 'a') !== null && parentOf(bad, 'b') !== null) return fail('cycle a<->b was not cut')

    // 2. moveGroupData
    const tree = (): Persisted =>
      migrate({
        version: 4,
        groups: [g('a'), g('b', { parentId: 'a' }), g('c', { parentId: 'b' }), g('pk', { kind: 'parent', path: p('pk') }), g('m')]
      })
    const d = tree()
    for (const [id, to] of [['a', 'c'], ['a', 'a'], ['m', 'pk']] as const) {
      const before = parentOf(d, id)
      if (typeof moveGroupData(d, id, to) !== 'string' || parentOf(d, id) !== before) return fail(`move ${id} -> ${to} should be rejected and leave parentId alone`)
    }
    if (moveGroupData(d, 'pk', 'm') !== null || parentOf(d, 'pk') !== 'm') return fail('parent-kind group should move into a manual group')
    if (moveGroupData(d, 'b', null) !== null || parentOf(d, 'b') !== null) return fail('move to top level')
    if (d.groups[d.groups.length - 1]?.id !== 'b') return fail('moved group should go last')
    const orderBefore = d.groups.map((x) => x.id).join(',')
    if (moveGroupData(d, 'pk', 'm') !== null || d.groups.map((x) => x.id).join(',') !== orderBefore) return fail('moving a group to its current parent should leave the order unchanged')

    // 3. Cascade removal: a > b > c, parent-kind group pk nested in b, plus a standalone folder s.
    const r = migrate({
      version: 4,
      groups: [g('a'), g('b', { parentId: 'a' }), g('c', { parentId: 'b' }), g('pk', { kind: 'parent', path: p('repos'), parentId: 'b' })],
      folders: [
        { id: 'fa', path: p('fa'), groupId: 'a' },
        { id: 'fc', path: p('fc'), groupId: 'c' },
        { id: 's', path: p('s'), groupId: null }
      ],
      commands: ['a', 'c', 'fc', childId(p('repos', 'one')), 's'].map((o, i) => ({ id: 'k' + i, name: 'k' + i, ownerId: o, mode: 'parallel', targets: [] })),
      snippets: [
        { id: 'p1', name: 'p1', body: 'x', scope: 'a' },
        { id: 'p2', name: 'p2', body: 'x', scope: 's' }
      ],
      selectedId: 'fc'
    })
    const sum = removeGroupData(r, 'a')
    if (r.groups.length !== 0 || r.folders.map((f) => f.id).join() !== 's') return fail('cascade should leave only folder s: ' + JSON.stringify({ g: r.groups.length, f: r.folders.map((f) => f.id) }))
    if (r.commands.map((c) => c.ownerId).join() !== 's' || r.snippets.map((x) => x.scope).join() !== 's') return fail('cascade should leave only the commands/prompts of s')
    if (r.selectedId !== 's') return fail('selection should fall back to s, got ' + r.selectedId)
    if (sum.groupIds.length !== 4 || sum.folderIds.length !== 2 || sum.commands !== 4 || sum.prompts !== 1) return fail('summary counts ' + JSON.stringify(sum))
    // 4. moveItemData: swaps among siblings only, edges and unknown ids are no-ops.
    const mv = migrate({
      version: 4,
      folders: [
        { id: 's1', path: p('s1'), groupId: null },
        { id: 'a1', path: p('a1'), groupId: 'ga' },
        { id: 's2', path: p('s2'), groupId: null },
        { id: 'a2', path: p('a2'), groupId: 'ga' }
      ],
      groups: [g('ga'), g('gb'), g('sub', { parentId: 'ga' }), g('gc')]
    })
    const ids = (a: { id: string }[]): string => a.map((x) => x.id).join()
    if (!moveItemData(mv, 'a2', -1) || ids(mv.folders.filter((f) => f.groupId === 'ga')) !== 'a2,a1' || mv.folders.find((f) => f.id === 'a2')?.groupId !== 'ga') return fail('folder should swap within its group')
    if (ids(mv.folders.filter((f) => !f.groupId)) !== 's1,s2') return fail('standalone folders must not change when a grouped folder moves')
    if (moveItemData(mv, 'a2', -1) || moveItemData(mv, 's2', 1) || moveItemData(mv, 'nope', 1) || moveItemData(mv, 'child:x', 1)) return fail('edge / unknown moves should be no-ops')
    if (!moveItemData(mv, 'gc', -1) || ids(mv.groups.filter((x) => !x.parentId)) !== 'ga,gc,gb' || moveItemData(mv, 'sub', 1) || moveItemData(mv, 'sub', -1)) return fail('group should swap among top-level groups only; lone subgroup stays')
    // 5. nestItemData: into the manual group above, out one level, cycles / no target / non-manual are no-ops.
    const ns = migrate({
      version: 4,
      folders: [
        { id: 'f0', path: p('f0'), groupId: null },
        { id: 'fx', path: p('fx'), groupId: 'n2' },
        { id: 'f1', path: p('f1'), groupId: 'n1' },
        { id: 'f2', path: p('f2'), groupId: 'n1' }
      ],
      groups: [g('n1'), g('n2'), g('n3'), g('n1a', { parentId: 'n1' }), g('n1b', { parentId: 'n1' })]
    })
    const par = (id: string): string | null | undefined => ns.groups.find((x) => x.id === id)?.parentId
    if (nestItemData(ns, 'n1', 1) || nestItemData(ns, 'n1a', 1)) return fail('first sibling has no group above')
    if (!nestItemData(ns, 'n2', 1) || par('n2') !== 'n1' || ids(ns.groups.filter((x) => x.parentId === 'n1')) !== 'n1a,n1b,n2') return fail('group should nest into the previous sibling, at the end')
    if (!nestItemData(ns, 'n1b', 1) || par('n1b') !== 'n1a') return fail('subgroup should nest into previous sibling subgroup')
    if (nestItemData(ns, 'n1', -1) || nestItemData(ns, 'f0', -1)) return fail('top-level items cannot move out')
    if (!nestItemData(ns, 'n1b', -1) || par('n1b') !== 'n1' || ids(ns.groups).split(',')[ids(ns.groups).split(',').indexOf('n1a') + 1] !== 'n1b') return fail('group out should land right after its old parent, got ' + ids(ns.groups))
    if (!nestItemData(ns, 'f0', 1) || ns.folders.find((x) => x.id === 'f0')?.groupId !== 'n3' || ids(ns.folders).split(',').pop() !== 'f0') return fail('standalone folder should join the last top-level manual group')
    if (!nestItemData(ns, 'f1', -1) || ns.folders.find((x) => x.id === 'f1')?.groupId !== null) return fail('folder out of a top-level group becomes standalone')
    if (nestItemData(ns, 'nope', 1) || nestItemData(ns, 'child:x', -1)) return fail('unknown ids are no-ops')
    return { ok: true, msg: 'group tree: flat migration, move among siblings, nest / un-nest, dangling/non-manual/cyclic parents, move rules, cascade removal with commands, prompts and selection' }
  } catch (e) {
    return fail(String(e))
  }
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
    folder: null,
    parentId: null,
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
    pinned: [],
    home: { id: 'home', name: 'Home', path: dir, isDefault: false, missing: false, isGit: false, branch: null },
    selectedId: null,
    settings: { ...DEFAULT_SETTINGS },
    ui: { sidebarWidth: 260, panelWidth: 340, sidebarCollapsed: false, panes: null, panelOpen: false, panelTab: 'files', tabs: [], groupBy: 'none', idleCollapsed: false, idleOpen: [] },
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

    if (resolveOpenTarget(state, undefined).loc.id !== 'home') return fail('open_terminal default is Home')
    if (!err(() => resolveOpenTarget(state, p('nope')))?.includes('does not exist')) return fail('open_terminal non-existent path')
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

/** Check: pure terminal text helpers (ANSI/OSC stripping, marker parsing across chunks, echo never matches). */
function checkTermText(): CheckResult {
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'term text: ' + m })
  try {
    const raw = '\u001b]0;title\u0007\u001b[32mgreen\u001b[0m line\r\nprogress 10%\rprogress 100%\r\nabc\b\bx  \r\n\r\nPS C:\\> \u001b[K'
    const lines = toLines(raw)
    const want = ['green line', 'progress 100%', 'ax', '', 'PS C:\\>']
    if (JSON.stringify(lines) !== JSON.stringify(want)) return fail('toLines ' + JSON.stringify(lines))
    const nonce = '0123456789abcdef'
    const begin = `\u001b]133;C;terminals=${nonce}\u0007`
    const end = `\u001b]133;D;3;terminals=${nonce}\u0007`
    const a = begin + 'out\r\n' + end.slice(0, 20)
    const m1 = findMarkers(a, nonce)
    if (m1.begin !== begin.length || m1.end) return fail('begin found, end pending ' + JSON.stringify(m1))
    const joined = a + end.slice(20)
    const m2 = findMarkers(joined, nonce, Math.max(0, a.length - 64))
    if (!m2.end || m2.end.code !== 3 || joined.slice(m2.begin ?? 0, m2.end.index) !== 'out\r\n') return fail('split end marker ' + JSON.stringify(m2))
    const echo = buildRunInput('Write-Output hi', nonce)
    const m3 = findMarkers(echo, nonce)
    if (m3.begin !== null || m3.end !== null || echo.includes('\u001b') || !echo.endsWith('\r')) return fail('echoed input line must not contain a marker')
    return { ok: true, msg: 'term text: toLines strips ANSI/OSC and applies \\r and \\b, markers found across a chunk split, typed run line carries no marker' }
  } catch (e) {
    return fail(String(e))
  }
}

/** A TerminalHost wired to real ptys without a window (the renderer round trip is a no-op). */
function makeSmokeHost(track: (p: IPty) => void): TerminalHost {
  const live = new Map<string, IPty>()
  const host: TerminalHost = new TerminalHost({
    spawn: (id, sh, _locId, cwd, cols, rows) => {
      const p = spawnShell(sh, cwd, cols, rows, {
        onData: (d) => host.data(id, d),
        onExit: (c) => host.exit(id, c)
      })
      live.set(id, p)
      track(p)
      return p
    },
    openTab: async () => ({ ok: true }),
    closeTab: () => undefined,
    release: (id) => {
      const p = live.get(id)
      live.delete(id)
      try {
        p?.kill()
      } catch {
        /* already gone */
      }
      host.remove(id)
    },
    configuredShell: () => ''
  })
  return host
}

/** Race a check against a watchdog so a hung shell fails the check instead of the whole run. */
function withWatchdog(p: Promise<CheckResult>, ms: number, name: string): Promise<CheckResult> {
  const timeout = new Promise<CheckResult>((r) => setTimeout(() => r({ ok: false, msg: `${name}: timed out after ${ms} ms` }), ms))
  return Promise.race([p, timeout])
}

/** Check: run_command in a live PowerShell through TerminalHost (output, exit code, state, busy, timeout). */
async function checkRunCommand(dir: string, track: (p: IPty) => void): Promise<CheckResult> {
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'run command: ' + m })
  const host = makeSmokeHost(track)
  try {
    const t = await host.open({ locId: 'home', cwd: dir })
    if (!t.id || !t.alive || !t.agent) return fail('open ' + JSON.stringify(t))
    const r1 = await host.run(t.id, "Write-Output ('a'+'1'); cmd /c exit 3", 20000)
    if (r1.output !== 'a1' || r1.exitCode !== 3 || r1.success !== false || r1.timedOut || r1.exited) return fail('output/exit code ' + JSON.stringify(r1))
    await host.run(t.id, '$x = 41 + 1', 20000)
    const r2 = await host.run(t.id, '$x', 20000)
    if (r2.output !== '42' || r2.exitCode !== 0) return fail('state must persist between runs ' + JSON.stringify(r2))
    const slow = host.run(t.id, 'Start-Sleep 3', 20000)
    let busy = ''
    try {
      await host.run(t.id, '1', 1000)
    } catch (e) {
      busy = e instanceof ToolError ? e.message : 'non-ToolError ' + String(e)
    }
    if (!busy.includes('busy')) return fail('second run while busy must be rejected, got ' + JSON.stringify(busy))
    await slow
    const r3 = await host.run(t.id, 'Start-Sleep 5', 1000)
    const info = host.list().find((x) => x.id === t.id)
    if (!r3.timedOut || r3.exitCode !== null || !info?.alive || !info.busy) return fail('timeout keeps shell alive and busy ' + JSON.stringify({ r3, info }))
    await host.close(t.id)
    if (host.list().length) return fail('close must forget the terminal')
    const t2 = await host.open({ locId: 'home', cwd: dir })
    const r4 = await host.run(t2.id, 'exit 5', 20000)
    if (!r4.exited || r4.exitCode !== 5) return fail('exit 5 must resolve exited with code 5 ' + JSON.stringify(r4))
    await host.close(t2.id).catch(() => undefined)
    const t3 = await host.open({ locId: 'home', cwd: dir })
    host.send(t3.id, "Start-Sleep -Milliseconds 300; 're'+'ady'\r")
    const w = await host.waitFor(t3.id, 'ready', 5000, true)
    await host.close(t3.id).catch(() => undefined)
    if (!w.matched) return fail('wait_for_output must match later output ' + JSON.stringify(w))
    return { ok: true, msg: 'run command: live pwsh via TerminalHost gives a1 / exit 3, keeps state, rejects a second run while busy, times out with the shell still alive, reports `exit 5` as exited with code 5, waitFor matches later output' }
  } catch (e) {
    return fail(String(e))
  }
}

/** Check: the MCP HTTP endpoint with terminal control off, then on (open under Home, run, close). */
async function checkMcpHttp(dir: string, track: (p: IPty) => void): Promise<CheckResult> {
  const fail = (m: string): CheckResult => ({ ok: false, msg: 'mcp http: ' + m })
  const host = makeSmokeHost(track)
  let flag = false
  const info = await startMcpServer({ dataDir: join(dir, 'mcp-data'), version: 'smoke', onChange: () => undefined, terminals: host, allowRun: () => flag })
  let rpcId = 0
  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
    const res = await fetch(info.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    })
    const body = (await res.json()) as { result?: { isError?: boolean; content: { text: string }[] } }
    if (!body.result) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`)
    return { isError: body.result.isError === true, text: body.result.content[0]?.text ?? '' }
  }
  try {
    const off = await call('run_command', { id: 'x', command: 'echo' })
    if (!off.isError || off.text !== RUN_DISABLED_ERROR) return fail('run_command with the toggle off ' + JSON.stringify(off))
    const list = await call('list_terminals', {})
    if (list.isError || (JSON.parse(list.text) as { allowRun: boolean }).allowRun !== false) return fail('list_terminals with the toggle off ' + JSON.stringify(list))
    flag = true
    const opened = await call('open_terminal', { location: dir })
    if (opened.isError) return fail('open_terminal ' + opened.text)
    const o = JSON.parse(opened.text) as { id: string; location: { id: string } }
    if (o.location.id !== 'home') return fail('an unsaved directory must open under Home ' + opened.text)
    const run = await call('run_command', { id: o.id, command: "Write-Output ('h'+'i')" })
    const r = JSON.parse(run.text) as { output: string; exitCode: number }
    if (run.isError || r.output !== 'hi' || r.exitCode !== 0) return fail('run_command ' + run.text)
    const closed = await call('close_terminal', { id: o.id })
    if (closed.isError || host.list().length) return fail('close_terminal ' + closed.text)
    return { ok: true, msg: 'mcp http: toggle off refuses run_command but list_terminals works; toggle on opens under Home, runs hi / exit 0, closes' }
  } catch (e) {
    return fail(String(e))
  } finally {
    await info.close?.()
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
    checkGroupTree(),
    checkGroupFolder(),
    checkSettings(),
    checkPanes(),
    checkTabs(),
    checkOrder(),
    checkSession(),
    checkElevation(),
    checkWrite(),
    checkMcpLogic(dir),
    checkTermText(),
    await withWatchdog(checkRunCommand(dir, track), 60000, 'run command'),
    await withWatchdog(checkMcpHttp(dir, track), 60000, 'mcp http'),
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
