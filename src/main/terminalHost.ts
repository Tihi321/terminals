// Terminal host: output ring buffers and the `run_command` state machine for every pty. No electron import
// (smoke instantiates it with its own HostDeps).
import { randomBytes, randomUUID } from 'node:crypto'
import type { IPty } from '@lydell/node-pty'
import type { AgentTabRequest, Result } from '../shared/types'
import type { AgentStatus, HookOutcome, TermStatus } from '../shared/agentStatus'
import { AgentStatusTracker } from './agentStatus'
import { ToolError } from './toolError'
import { RingBuffer, buildRunInput, findMarkers, psShell, toLines } from './termText'
import { ScreenMirror, type ScreenSnapshot } from './screen'

export interface TermMeta {
  locId: string
  cwd: string
  shell: string
  kind: 'shell' | 'command'
  agent: boolean
  elevated: boolean
  /** webContents id that owns it (null in smoke). */
  ownerWc: number | null
  /** Size of the pty when it was created (the mirror starts there; pty:resize keeps it current). */
  cols: number
  rows: number
}

export interface TermInfo {
  id: string
  locationId: string
  /** Last cwd reported by OSC 9;9 or OSC 7 in the output, else startCwd. */
  cwd: string
  startCwd: string
  shell: string
  kind: 'shell' | 'command'
  alive: boolean
  exitCode: number | null
  agent: boolean
  elevated: boolean
  busy: boolean
  /** Agent status (report or heuristic); null for a plain shell. */
  status: TermStatus | null
}

export interface RunResult {
  id: string
  /** Identifies this run for get_run_result (the final result of a run that timed out). */
  runId: string
  exitCode: number | null
  success: boolean | null
  output: string
  truncated: boolean
  timedOut: boolean
  exited: boolean
  durationMs: number
}

export interface ReadResult {
  id: string
  alive: boolean
  lines: string[]
  truncated: boolean
}

export interface WaitResult {
  id: string
  matched: boolean
  /** The first matching line (ANSI-stripped), null when nothing matched. */
  line: string | null
  timedOut: boolean
  exited: boolean
  /** Index of the matcher that matched (the lowest one on the matching line), null when nothing matched. */
  patternIndex: number | null
  /** The `source` of that matcher, null when nothing matched. */
  pattern: string | null
  /** Last 20 lines of the terminal at the time the wait ended. */
  tail: string[]
}

/** A compiled wait_for_output pattern (compileWaitPatterns in mcpTools.ts). */
export interface WaitMatcher {
  source: string
  test(line: string): boolean
}

export interface RunLookup {
  id: string
  runId: string
  state: 'running' | 'done'
  result: RunResult | null
}

/** What the MCP tools use. All methods throw ToolError with a user-readable message. */
export interface TerminalControl {
  list(): TermInfo[]
  /** `reveal`: also show/focus the window and select the location (default false: background). */
  open(target: { locId: string; cwd: string; reveal?: boolean }): Promise<TermInfo>
  /** Waits for a line of the terminal's output to match one of `matchers`: the first matching line wins, and on it the lowest index. */
  waitFor(id: string, matchers: WaitMatcher[], timeoutMs: number, fromNow: boolean): Promise<WaitResult>
  run(id: string, command: string, timeoutMs: number): Promise<RunResult>
  /** Final result of a run_command (also one that timed out); waits up to `waitMs` while it still runs. */
  runResult(id: string, runId: string, waitMs: number): Promise<RunLookup>
  /** The visible screen as rendered (a headless xterm mirror of the pty), for any terminal. */
  screen(id: string): Promise<ScreenSnapshot & { id: string; alive: boolean }>
  send(id: string, text: string): void
  read(id: string, lines: number): ReadResult
  close(id: string): Promise<void>
  /** Sets the agent status of a terminal (from a hook or report_status). Returns the new status. */
  report(id: string, o: HookOutcome | AgentStatus): TermStatus | null
}

export interface HostDeps {
  /** Spawns a non-elevated `shell` pty with ptyEnv(locId), registers it in index.ts's ptys/owners (owner = the window)
   *  and wires onData -> host.data / onExit -> host.exit. Must NOT call host.add. Throws on failure. */
  spawn(id: string, shell: string, locId: string, cwd: string, cols: number, rows: number): IPty
  /** Round trip to the renderer. Resolves { ok:false } on renderer refusal; rejects/throws ToolError on timeout/no window. */
  openTab(req: Omit<AgentTabRequest, 'reqId'>): Promise<Result>
  closeTab(id: string): void
  /** index.ts releasePty (kills; calls host.remove). */
  release(id: string): void
  /** Configured shell (store.getShell()); the host applies psShell(). */
  configuredShell(): string
  /** webContents id that owns the ptys spawned by `spawn` (recorded as ownerWc). Omitted: null. */
  ownerWc?(): number | null
  /** The agent status of a terminal changed (null: no longer an agent tab). */
  onStatus?(id: string, s: TermStatus | null): void
  /** settings.agentHeuristics, read per use. Default true. */
  heuristics?(): boolean
}

const RING_CAP = 512 * 1024
const RUN_BODY_CAP = 2 * 1024 * 1024
const OUTPUT_CAP = 100 * 1024
const MAX_INPUT = 8000
const PRE_KEEP = 2048
const READY_QUIET_MS = 500
const READY_MAX_MS = 10_000
const EXIT_WAIT_MS = 1500
const FINISHED_KEEP = 32
/** Pending waits (wait_for_output and get_run_result) per terminal and in total. */
const MAX_WAITERS_PER_TERM = 4
const MAX_WAITERS_TOTAL = 16

interface Run {
  nonce: string
  startedAt: number
  /** Output before the begin marker (echo etc.), trimmed; only used to find the begin marker. */
  pre: string
  /** Output after the begin marker; null until it was seen. */
  body: string | null
  /** Where the next end-marker search starts in `body`. */
  scan: number
  bodyCut: boolean
  /** The caller's promise already resolved (timeout); the terminal stays busy until the end marker / exit / close. */
  settled: boolean
  resolve: (r: RunResult) => void
  timer: ReturnType<typeof setTimeout> | null
  /** get_run_result calls waiting for this run to end. */
  waits: RunWaiter[]
  /** The end marker showed the user code did not finish normally (`exit`, Ctrl+C): waiting briefly to see if the shell exits. */
  ending: { code: number; text: string; timer: ReturnType<typeof setTimeout> } | null
}

interface Rec {
  id: string
  pty: IPty
  meta: TermMeta
  ring: RingBuffer
  pushed: number
  cwd: string
  cwdTail: string
  alive: boolean
  exitCode: number | null
  lastDataAt: number
  run: Run | null
  waiters: Waiter[]
  status: AgentStatusTracker
  screen: ScreenMirror
}

interface Waiter {
  matchers: WaitMatcher[]
  /** Raw text after the last newline seen so far (capped): the unfinished line, rescanned as it grows. */
  pending: string
  timer: ReturnType<typeof setTimeout>
  resolve: (r: WaitResult) => void
}

interface RunWaiter {
  timer: ReturnType<typeof setTimeout>
  resolve: (l: RunLookup) => void
}

const WAIT_BUF_CAP = 64 * 1024
const PENDING_CAP = 8 * 1024
const TAIL_LINES = 20

const OSC99_RE = /\u001b\]9;9;"?([^"\u0007\u001b]+?)"?(?:\u0007|\u001b\\)/g
const OSC7_RE = /\u001b\]7;file:\/\/[^/\u0007\u001b]*\/([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g

function lastCwd(s: string): string | null {
  let best: { index: number; path: string } | null = null
  for (const m of s.matchAll(OSC99_RE)) best = { index: m.index, path: m[1] }
  for (const m of s.matchAll(OSC7_RE)) {
    if (best && m.index < best.index) continue
    let p = m[1]
    try {
      p = decodeURIComponent(p)
    } catch {
      /* keep raw */
    }
    best = { index: m.index, path: p.replace(/\//g, '\\') }
  }
  return best ? best.path : null
}

function later(fn: () => void): void {
  // Never settle promises inside a pty callback: teardown triggered from there can deadlock.
  setTimeout(fn, 0)
}

/** Index of the first matcher that matches `line`, or -1. */
function firstMatch(matchers: WaitMatcher[], line: string): number {
  for (let i = 0; i < matchers.length; i++) if (matchers[i].test(line)) return i
  return -1
}

function limitOutput(text: string, alreadyCut: boolean): { output: string; truncated: boolean } {
  if (text.length > OUTPUT_CAP) return { output: text.slice(-OUTPUT_CAP), truncated: true }
  return { output: text, truncated: alreadyCut }
}

export class TerminalHost implements TerminalControl {
  private readonly recs = new Map<string, Rec>()
  /** The newest FINISHED_KEEP run results by runId; they outlive close_terminal. */
  private readonly finished = new Map<string, { termId: string; result: RunResult }>()
  private readonly deps: HostDeps

  private readonly timer: ReturnType<typeof setInterval>

  constructor(deps: HostDeps) {
    this.deps = deps
    this.timer = setInterval(() => {
      const now = Date.now()
      for (const rec of this.recs.values()) if (rec.alive && rec.status.tick(now)) this.emitStatus(rec)
    }, 1000)
    this.timer.unref()
  }

  /** Stops the status timer (smoke). */
  dispose(): void {
    clearInterval(this.timer)
  }

  add(id: string, pty: IPty, meta: TermMeta): void {
    this.remove(id)
    this.recs.set(id, {
      id,
      pty,
      meta,
      ring: new RingBuffer(RING_CAP),
      pushed: 0,
      cwd: meta.cwd,
      cwdTail: '',
      alive: true,
      exitCode: null,
      lastDataAt: 0,
      run: null,
      waiters: [],
      status: new AgentStatusTracker(() => (this.deps.heuristics ? this.deps.heuristics() : true)),
      screen: new ScreenMirror(meta.cols, meta.rows)
    })
  }

  data(id: string, chunk: string): void {
    const rec = this.recs.get(id)
    if (!rec) return
    rec.screen.write(chunk)
    rec.ring.push(chunk)
    rec.pushed += chunk.length
    rec.lastDataAt = Date.now()
    if (chunk.includes('\u001b]')) {
      const joined = rec.cwdTail + chunk
      const c = lastCwd(joined)
      if (c) rec.cwd = c
      rec.cwdTail = joined.slice(-512)
    } else if (rec.cwdTail) {
      // Keep a possible split OSC prefix around for the next chunk.
      rec.cwdTail = (rec.cwdTail + chunk).slice(-512)
    }
    if (rec.status.output(chunk, rec.lastDataAt)) this.emitStatus(rec)
    if (rec.run) this.feedRun(rec, rec.run, chunk)
    if (rec.waiters.length) this.feedWaiters(rec, chunk)
  }

  exit(id: string, code: number): void {
    const rec = this.recs.get(id)
    if (!rec) return
    rec.alive = false
    rec.exitCode = code
    if (rec.status.report({ kind: 'clear' }, Date.now())) this.emitStatus(rec)
    this.endWaiters(rec, { exited: true })
    const run = rec.run
    if (run) {
      rec.run = null
      if (run.ending) clearTimeout(run.ending.timer)
      this.finish(rec, run, { exitCode: code, exited: true, text: run.ending?.text })
    }
  }

  /** Forget the record (tab closed / pty released). A pending run resolves with exited: true. */
  remove(id: string): void {
    const rec = this.recs.get(id)
    if (!rec) return
    this.recs.delete(id)
    if (rec.status.get()) this.deps.onStatus?.(id, null)
    this.endWaiters(rec, { exited: true })
    const run = rec.run
    if (run) {
      rec.run = null
      if (run.ending) clearTimeout(run.ending.timer)
      this.finish(rec, run, { exitCode: rec.exitCode, exited: true, text: run.ending?.text })
    }
    rec.screen.dispose()
  }

  /** Exited records owned by a renderer that is gone or closed the tab. */
  forgetOwner(wcId: number): void {
    for (const rec of [...this.recs.values()]) {
      if (rec.meta.ownerWc === wcId && !rec.alive) this.remove(rec.id)
    }
  }

  /** The user typed into the pty. */
  input(id: string): void {
    const rec = this.recs.get(id)
    if (rec && rec.status.input(Date.now())) this.emitStatus(rec)
  }

  /** The pty was resized (the redraw is not agent activity); the screen mirror follows the new size. */
  resized(id: string, cols?: number, rows?: number): void {
    const rec = this.recs.get(id)
    if (!rec) return
    rec.status.resized(Date.now())
    if (cols !== undefined && rows !== undefined && cols > 0 && rows > 0) rec.screen.resize(cols, rows)
  }

  /** The user viewed the tab: done -> idle. */
  seen(id: string): void {
    const rec = this.recs.get(id)
    if (rec && rec.status.seen(Date.now())) this.emitStatus(rec)
  }

  report(id: string, o: HookOutcome | AgentStatus): TermStatus | null {
    const rec = this.recs.get(id)
    if (!rec) throw new ToolError(`Unknown terminal id "${id}". Use list_terminals.`)
    if (rec.status.report(o, Date.now())) this.emitStatus(rec)
    return rec.status.get()
  }

  statuses(): Record<string, TermStatus> {
    const out: Record<string, TermStatus> = {}
    for (const rec of this.recs.values()) {
      const s = rec.status.get()
      if (s) out[rec.id] = s
    }
    return out
  }

  private emitStatus(rec: Rec): void {
    this.deps.onStatus?.(rec.id, rec.status.get())
  }

  backlog(id: string): string {
    return this.recs.get(id)?.ring.text() ?? ''
  }

  list(): TermInfo[] {
    return [...this.recs.values()].map((r) => this.info(r))
  }

  async open(target: { locId: string; cwd: string; reveal?: boolean }): Promise<TermInfo> {
    const id = randomUUID()
    const shell = psShell(this.deps.configuredShell())
    let pty: IPty
    try {
      pty = this.deps.spawn(id, shell, target.locId, target.cwd, 120, 30)
    } catch (e) {
      throw new ToolError(`Could not start the terminal: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.add(id, pty, {
      locId: target.locId,
      cwd: target.cwd,
      shell,
      kind: 'shell',
      agent: true,
      elevated: false,
      ownerWc: this.deps.ownerWc ? this.deps.ownerWc() : null,
      cols: 120,
      rows: 30
    })
    let res: Result
    try {
      res = await this.deps.openTab({ id, locId: target.locId, cwd: target.cwd, shell, ...(target.reveal ? { reveal: true } : {}) })
    } catch (e) {
      this.deps.release(id)
      throw e instanceof ToolError ? e : new ToolError(e instanceof Error ? e.message : String(e))
    }
    if (!res.ok) {
      this.deps.release(id)
      throw new ToolError(`The Terminals window refused the tab: ${res.error}`)
    }
    // Ready = first output, then a quiet period (the prompt is up), capped.
    const t0 = Date.now()
    for (;;) {
      const rec = this.recs.get(id)
      if (!rec) throw new ToolError('The terminal was closed while it was starting.')
      if (!rec.alive) throw new ToolError(`The shell exited while starting (exit code ${rec.exitCode}).`)
      const now = Date.now()
      if (rec.pushed > 0 && now - rec.lastDataAt >= READY_QUIET_MS) break
      if (now - t0 >= READY_MAX_MS) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const rec = this.recs.get(id)
    if (!rec) throw new ToolError('The terminal was closed while it was starting.')
    return this.info(rec)
  }

  run(id: string, command: string, timeoutMs: number): Promise<RunResult> {
    const rec = this.writable(id)
    if (rec.meta.kind !== 'shell' || !/pwsh|powershell/i.test(rec.meta.shell)) {
      throw new ToolError('run_command only works in PowerShell terminals.')
    }
    if (rec.run) {
      throw new ToolError(
        'This terminal is busy with a previous run_command. Use read_terminal to watch it, or send_input with "\\u0003" (Ctrl+C) to interrupt it.'
      )
    }
    if (!command.trim()) throw new ToolError('command is empty.')
    if (command.length > MAX_INPUT) throw new ToolError(`command is too long (max ${MAX_INPUT} characters).`)
    const nonce = randomBytes(8).toString('hex')
    const ms = Math.max(1, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : 60_000, 600_000))
    return new Promise<RunResult>((resolve) => {
      const run: Run = {
        nonce,
        startedAt: Date.now(),
        pre: '',
        body: null,
        scan: 0,
        bodyCut: false,
        settled: false,
        resolve,
        timer: null,
        waits: [],
        ending: null
      }
      run.timer = setTimeout(() => {
        if (run.settled) return
        // Leave rec.run in place: the shell is still busy until the end marker, exit or close. The final result is
        // recorded when the run really ends (finish) and fetched with get_run_result.
        run.timer = null
        run.settled = true
        const result = this.buildResult(rec, run, { exitCode: null, timedOut: true })
        later(() => run.resolve(result))
      }, ms)
      rec.run = run
      try {
        rec.pty.write(buildRunInput(command, nonce))
      } catch (e) {
        rec.run = null
        if (run.timer) clearTimeout(run.timer)
        throw new ToolError(`Could not write to the terminal: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }

  send(id: string, text: string): void {
    const rec = this.writable(id)
    if (text.length > MAX_INPUT) throw new ToolError(`text is too long (max ${MAX_INPUT} characters).`)
    try {
      rec.pty.write(text)
    } catch (e) {
      throw new ToolError(`Could not write to the terminal: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  read(id: string, lines: number): ReadResult {
    const rec = this.recs.get(id)
    if (!rec) throw new ToolError(`Unknown terminal id "${id}". Use list_terminals.`)
    const n = Number.isFinite(lines) ? Math.max(1, Math.min(2000, Math.floor(lines))) : 100
    const all = toLines(rec.ring.text())
    return {
      id,
      alive: rec.alive,
      lines: all.length > n ? all.slice(-n) : all,
      truncated: all.length > n || rec.pushed > RING_CAP
    }
  }

  waitFor(id: string, matchers: WaitMatcher[], timeoutMs: number, fromNow: boolean): Promise<WaitResult> {
    const rec = this.recs.get(id)
    if (!rec) throw new ToolError(`Unknown terminal id "${id}". Use list_terminals.`)
    if (!matchers.length) throw new ToolError('No pattern to wait for.')
    this.checkWaitRoom(rec)
    const ms = Math.max(1, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : 30_000, 600_000))
    return new Promise<WaitResult>((resolve) => {
      const w: Waiter = {
        matchers,
        pending: '',
        timer: setTimeout(() => this.finishWaiter(rec, w, { timedOut: true }), ms),
        resolve
      }
      rec.waiters.push(w)
      if (!fromNow) {
        // One scan of the buffered output (last 64 KiB); from then on only new output is scanned.
        const hit = this.scanText(w, rec.ring.text().slice(-WAIT_BUF_CAP))
        if (hit) return this.finishWaiter(rec, w, hit)
      }
      if (!rec.alive) this.finishWaiter(rec, w, { exited: true })
    })
  }

  /** Final result of a run (also one that timed out); with `waitMs` waits for a run that is still going. */
  runResult(id: string, runId: string, waitMs: number): Promise<RunLookup> {
    const done = this.finished.get(runId)
    if (done && done.termId === id) return Promise.resolve({ id, runId, state: 'done', result: done.result })
    const rec = this.recs.get(id)
    if (!rec) throw new ToolError(`Unknown terminal id "${id}". Use list_terminals.`)
    const run = rec.run
    if (!run || run.nonce !== runId) {
      throw new ToolError(`Unknown runId "${runId}" for this terminal (only the last ${FINISHED_KEEP} runs are kept).`)
    }
    const ms = Math.max(0, Math.min(Number.isFinite(waitMs) ? waitMs : 0, 600_000))
    if (ms === 0) return Promise.resolve({ id, runId, state: 'running', result: null })
    this.checkWaitRoom(rec)
    return new Promise<RunLookup>((resolve) => {
      const rw: RunWaiter = {
        timer: setTimeout(() => {
          const i = run.waits.indexOf(rw)
          if (i >= 0) run.waits.splice(i, 1)
          later(() => resolve({ id, runId, state: 'running', result: null }))
        }, ms),
        resolve
      }
      run.waits.push(rw)
    })
  }

  /** The visible screen of a terminal as the user sees it (headless xterm mirror fed with the same pty data). */
  async screen(id: string): Promise<ScreenSnapshot & { id: string; alive: boolean }> {
    const rec = this.recs.get(id)
    if (!rec) throw new ToolError(`Unknown terminal id "${id}". Use list_terminals.`)
    const snap = await rec.screen.snapshot()
    return { id, alive: rec.alive, ...snap }
  }

  async close(id: string): Promise<void> {
    const rec = this.recs.get(id)
    if (!rec) throw new ToolError(`Unknown terminal id "${id}". Use list_terminals.`)
    if (!rec.meta.agent || rec.meta.elevated) {
      throw new ToolError('Only terminals opened through MCP (open_terminal) can be closed.')
    }
    this.deps.release(id)
    this.deps.closeTab(id)
    this.remove(id)
  }

  private info(r: Rec): TermInfo {
    return {
      id: r.id,
      locationId: r.meta.locId,
      cwd: r.cwd,
      startCwd: r.meta.cwd,
      shell: r.meta.shell,
      kind: r.meta.kind,
      alive: r.alive,
      exitCode: r.exitCode,
      agent: r.meta.agent,
      elevated: r.meta.elevated,
      busy: r.run !== null,
      status: r.status.get()
    }
  }

  /** The record for a write tool: agent-opened, alive, not elevated. */
  private writable(id: string): Rec {
    const rec = this.recs.get(id)
    if (!rec) throw new ToolError(`Unknown terminal id "${id}". Use list_terminals.`)
    if (rec.meta.elevated) throw new ToolError('Elevated terminals cannot be controlled through MCP.')
    if (!rec.meta.agent) {
      throw new ToolError('Only terminals opened through MCP (open_terminal) can be written to. User terminals are read-only.')
    }
    if (!rec.alive) throw new ToolError(`Terminal ${id} has exited. Open a new one with open_terminal.`)
    return rec
  }

  /** Pending waits of a terminal: wait_for_output waiters plus get_run_result waits. */
  private checkWaitRoom(rec: Rec): void {
    const count = (r: Rec): number => r.waiters.length + (r.run ? r.run.waits.length : 0)
    if (count(rec) >= MAX_WAITERS_PER_TERM) {
      throw new ToolError(`Too many pending waits on this terminal (max ${MAX_WAITERS_PER_TERM}); let one finish or time out.`)
    }
    let total = 0
    for (const r of this.recs.values()) total += count(r)
    if (total >= MAX_WAITERS_TOTAL) {
      throw new ToolError(`Too many pending waits (max ${MAX_WAITERS_TOTAL} in total); let one finish or time out.`)
    }
  }

  /** Tests the complete lines of `text`, then its unfinished last line, against the waiter's matchers, each line once.
   *  The unfinished part (raw, capped) is kept as `pending` and rescanned together with the next chunk. */
  private scanText(w: Waiter, text: string): { line: string; index: number } | null {
    const nl = text.lastIndexOf('\n')
    const complete = nl >= 0 ? text.slice(0, nl + 1) : ''
    w.pending = nl >= 0 ? text.slice(nl + 1) : text
    if (w.pending.length > PENDING_CAP) w.pending = w.pending.slice(-PENDING_CAP)
    const lines = complete ? toLines(complete) : []
    if (w.pending) lines.push(...toLines(w.pending))
    for (const line of lines) {
      const index = firstMatch(w.matchers, line)
      if (index >= 0) return { line, index }
    }
    return null
  }

  private feedWaiters(rec: Rec, chunk: string): void {
    for (const w of [...rec.waiters]) {
      const hit = this.scanText(w, w.pending + chunk)
      if (hit) this.finishWaiter(rec, w, hit)
    }
  }

  private finishWaiter(rec: Rec, w: Waiter, r: { line?: string; index?: number; timedOut?: boolean; exited?: boolean }): void {
    const i = rec.waiters.indexOf(w)
    if (i < 0) return
    rec.waiters.splice(i, 1)
    clearTimeout(w.timer)
    const all = toLines(rec.ring.text())
    const result: WaitResult = {
      id: rec.id,
      matched: r.line !== undefined,
      line: r.line ?? null,
      timedOut: r.timedOut === true,
      exited: r.exited === true,
      patternIndex: r.index ?? null,
      pattern: r.index !== undefined ? w.matchers[r.index].source : null,
      tail: all.slice(-TAIL_LINES)
    }
    later(() => w.resolve(result))
  }

  /** Terminal exited or was removed: every pending wait ends with exited: true. */
  private endWaiters(rec: Rec, r: { exited: true }): void {
    for (const w of [...rec.waiters]) this.finishWaiter(rec, w, r)
  }

  /** Parses markers in the new chunk; finishes the run when its end marker arrived. */
  private feedRun(rec: Rec, run: Run, chunk: string): void {
    if (run.ending) return
    if (run.body === null) {
      const prev = run.pre
      const buf = prev + chunk
      // Search from 64 chars before the new data so a marker split across chunks is found.
      const m = findMarkers(buf, run.nonce, Math.max(0, prev.length - 64))
      if (m.begin === null) {
        run.pre = buf.length > PRE_KEEP ? buf.slice(-PRE_KEEP) : buf
        return
      }
      run.pre = ''
      run.body = buf.slice(m.begin)
      run.scan = 0
    } else {
      run.body += chunk
    }
    const body = run.body
    const m = findMarkers(body, run.nonce, Math.max(0, run.scan - 64))
    if (m.end) {
      const text = body.slice(0, m.end.index)
      if (m.end.abnormal) {
        // `exit N` (the shell is going away) and Ctrl+C both end up here; only an actual pty exit tells them apart.
        const code = m.end.code
        // The end marker arrived: the run can no longer time out, whatever the settle delay below does.
        if (run.timer) {
          clearTimeout(run.timer)
          run.timer = null
        }
        const timer = setTimeout(() => {
          if (rec.run !== run) return
          rec.run = null
          run.ending = null
          this.finish(rec, run, { exitCode: code, text })
        }, EXIT_WAIT_MS)
        run.ending = { code, text, timer }
        return
      }
      rec.run = null
      this.finish(rec, run, { exitCode: m.end.code, text })
      return
    }
    run.scan = body.length
    // Also after a timeout: the final result (get_run_result) is the whole run, capped.
    if (body.length > RUN_BODY_CAP) {
      const cut = body.length - RUN_BODY_CAP
      run.body = body.slice(cut)
      run.scan = Math.max(0, run.scan - cut)
      run.bodyCut = true
    }
  }

  /** The run really ended (end marker, shell exit, tab removed): records the final result, resolves the caller if it
   *  is still waiting, and wakes get_run_result waits. */
  private finish(rec: Rec, run: Run, r: { exitCode: number | null; exited?: boolean; text?: string }): void {
    if (run.timer) {
      clearTimeout(run.timer)
      run.timer = null
    }
    if (this.finished.has(run.nonce)) return
    const result = this.buildResult(rec, run, { ...r, timedOut: false })
    this.finished.set(run.nonce, { termId: rec.id, result })
    while (this.finished.size > FINISHED_KEEP) {
      const oldest = this.finished.keys().next().value
      if (oldest === undefined) break
      this.finished.delete(oldest)
    }
    if (!run.settled) {
      run.settled = true
      later(() => run.resolve(result))
    }
    for (const rw of run.waits.splice(0)) {
      clearTimeout(rw.timer)
      later(() => rw.resolve({ id: rec.id, runId: run.nonce, state: 'done', result }))
    }
  }

  /** A RunResult from what the run captured so far (`text` overrides the captured body). */
  private buildResult(
    rec: Rec,
    run: Run,
    r: { exitCode: number | null; timedOut?: boolean; exited?: boolean; text?: string }
  ): RunResult {
    const raw = r.text ?? run.body ?? ''
    const { output, truncated } = limitOutput(toLines(raw).join('\n'), run.bodyCut)
    return {
      id: rec.id,
      runId: run.nonce,
      exitCode: r.exitCode,
      success: r.exitCode === null ? null : r.exitCode === 0,
      output,
      truncated,
      timedOut: r.timedOut === true,
      exited: r.exited === true,
      durationMs: Date.now() - run.startedAt
    }
  }
}
