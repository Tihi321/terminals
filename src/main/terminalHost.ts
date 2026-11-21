// Terminal host: output ring buffers and the `run_command` state machine for every pty. No electron import
// (smoke instantiates it with its own HostDeps).
import { randomBytes, randomUUID } from 'node:crypto'
import type { IPty } from '@lydell/node-pty'
import type { AgentTabRequest, Result } from '../shared/types'
import { ToolError } from './toolError'
import { RingBuffer, buildRunInput, findMarkers, psShell, toLines } from './termText'

export interface TermMeta {
  locId: string
  cwd: string
  shell: string
  kind: 'shell' | 'command'
  agent: boolean
  elevated: boolean
  /** webContents id that owns it (null in smoke). */
  ownerWc: number | null
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
}

export interface RunResult {
  id: string
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

/** What the MCP tools use. All methods throw ToolError with a user-readable message. */
export interface TerminalControl {
  list(): TermInfo[]
  open(target: { locId: string; cwd: string }): Promise<TermInfo>
  run(id: string, command: string, timeoutMs: number): Promise<RunResult>
  send(id: string, text: string): void
  read(id: string, lines: number): ReadResult
  close(id: string): Promise<void>
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
}

const RING_CAP = 512 * 1024
const RUN_BODY_CAP = 2 * 1024 * 1024
const OUTPUT_CAP = 100 * 1024
const MAX_INPUT = 8000
const PRE_KEEP = 2048
const READY_QUIET_MS = 500
const READY_MAX_MS = 10_000

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
}

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

function limitOutput(text: string, alreadyCut: boolean): { output: string; truncated: boolean } {
  if (text.length > OUTPUT_CAP) return { output: text.slice(-OUTPUT_CAP), truncated: true }
  return { output: text, truncated: alreadyCut }
}

export class TerminalHost implements TerminalControl {
  private readonly recs = new Map<string, Rec>()
  private readonly deps: HostDeps

  constructor(deps: HostDeps) {
    this.deps = deps
  }

  add(id: string, pty: IPty, meta: TermMeta): void {
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
      run: null
    })
  }

  data(id: string, chunk: string): void {
    const rec = this.recs.get(id)
    if (!rec) return
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
    if (rec.run) this.feedRun(rec, rec.run, chunk)
  }

  exit(id: string, code: number): void {
    const rec = this.recs.get(id)
    if (!rec) return
    rec.alive = false
    rec.exitCode = code
    const run = rec.run
    if (run) {
      rec.run = null
      this.settle(rec, run, { exitCode: code, exited: true })
    }
  }

  /** Forget the record (tab closed / pty released). A pending run resolves with exited: true. */
  remove(id: string): void {
    const rec = this.recs.get(id)
    if (!rec) return
    this.recs.delete(id)
    const run = rec.run
    if (run) {
      rec.run = null
      this.settle(rec, run, { exitCode: rec.exitCode, exited: true })
    }
  }

  /** Exited records owned by a renderer that is gone or closed the tab. */
  forgetOwner(wcId: number): void {
    for (const rec of [...this.recs.values()]) {
      if (rec.meta.ownerWc === wcId && !rec.alive) this.remove(rec.id)
    }
  }

  backlog(id: string): string {
    return this.recs.get(id)?.ring.text() ?? ''
  }

  list(): TermInfo[] {
    return [...this.recs.values()].map((r) => this.info(r))
  }

  async open(target: { locId: string; cwd: string }): Promise<TermInfo> {
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
      ownerWc: this.deps.ownerWc ? this.deps.ownerWc() : null
    })
    let res: Result
    try {
      res = await this.deps.openTab({ id, locId: target.locId, cwd: target.cwd, shell })
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
        timer: null
      }
      run.timer = setTimeout(() => {
        if (run.settled) return
        // Leave rec.run in place: the shell is still busy until the end marker, exit or close.
        this.settle(rec, run, { exitCode: null, timedOut: true })
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
      busy: r.run !== null
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

  /** Parses markers in the new chunk; finishes the run when its end marker arrived. */
  private feedRun(rec: Rec, run: Run, chunk: string): void {
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
      rec.run = null
      this.settle(rec, run, { exitCode: m.end.code, text })
      return
    }
    run.scan = body.length
    if (run.settled) {
      // Nobody is waiting for the text any more: keep only what is needed to find the end marker.
      if (body.length > 1024) {
        run.body = body.slice(-1024)
        run.scan = run.body.length
      }
    } else if (body.length > RUN_BODY_CAP) {
      const cut = body.length - RUN_BODY_CAP
      run.body = body.slice(cut)
      run.scan = Math.max(0, run.scan - cut)
      run.bodyCut = true
    }
  }

  /** Resolve the caller (once). `text` defaults to what was captured so far. */
  private settle(
    rec: Rec,
    run: Run,
    r: { exitCode: number | null; timedOut?: boolean; exited?: boolean; text?: string }
  ): void {
    if (run.timer) {
      clearTimeout(run.timer)
      run.timer = null
    }
    if (run.settled) return
    run.settled = true
    const raw = r.text ?? run.body ?? ''
    const { output, truncated } = limitOutput(toLines(raw).join('\n'), run.bodyCut)
    const result: RunResult = {
      id: rec.id,
      exitCode: r.exitCode,
      success: r.exitCode === null ? null : r.exitCode === 0,
      output,
      truncated,
      timedOut: r.timedOut === true,
      exited: r.exited === true,
      durationMs: Date.now() - run.startedAt
    }
    later(() => run.resolve(result))
  }
}
