// Per-terminal agent status: a small state machine fed by pty output, user input and agent reports (hooks / MCP).
// No electron import (smoke runs it directly). Every method takes `now` (epoch ms) so tests can use a fake clock and
// returns true when the public status (get()) changed.
import type { AgentStatus, HookOutcome, TermStatus } from '../shared/agentStatus'
import { stripAnsi } from './termText'

/**
 * Heuristic rules, matched against the ANSI-stripped output stream. Add an entry to teach the app another agent.
 * `detect` marks a tab as running that agent; `needsYou` marks a blocking prompt.
 */
export const AGENT_RULES: { agent: string; detect: RegExp; needsYou: RegExp[] }[] = [
  {
    agent: 'claude',
    // "esc to interrupt": the status line while Claude Code works. "? for shortcuts": its idle input hint.
    detect: /esc to interrupt|\? for shortcuts/i,
    needsYou: [
      // "Do you want to proceed / make this edit to x / create x / overwrite x / allow ..." permission dialogs.
      /Do you want to (proceed|make this edit|create|overwrite|allow)/i,
      // Plan approval and similar.
      /Would you like to proceed\?/i
    ]
  }
]

/** Output right after the user typed is mostly the echo. */
export const ECHO_MS = 300
/** Output right after a resize is a redraw. */
export const RESIZE_MS = 700
/** A heuristic-working tab with no output for this long counts as done. */
export const QUIET_MS = 3000
/** A shell-prompt-looking tail must persist this long before a heuristic status is cleared. */
export const PROMPT_CONFIRM_MS = 1000
const TAIL_CAP = 4096
// OSC 9;9 (ConPTY cwd) or OSC 7 (file cwd): the shell printed a prompt, so the agent program has exited.
const PROMPT_OSC_RE = /\u001b\](?:9;9;|7;)/
// Stock shells without cwd OSC: the ANSI-stripped tail ends with the default prompt (pwsh/powershell `PS C:\x> `, cmd `C:\x>`).
const SHELL_PROMPT_RES = [/(^|\n)PS [^\n]*> ?$/, /(^|\n)[A-Za-z]:\\[^\n]*> ?$/]

export class AgentStatusTracker {
  private agent: string | null = null
  private status: AgentStatus = 'idle'
  private source: TermStatus['source'] = 'heuristic'
  private since = 0
  private reported = false
  private tail = ''
  private lastOutputAt = 0
  private lastInputAt = -1e12
  private lastResizeAt = -1e12
  private promptSeenAt: number | null = null

  constructor(private readonly heuristics: () => boolean = () => true) {}

  get(): TermStatus | null {
    if (this.agent === null) return null
    return { status: this.status, source: this.source, since: this.since, agent: this.agent }
  }

  private key(): string {
    return `${this.agent}|${this.status}|${this.source}`
  }

  private mutate(now: number, fn: () => void): boolean {
    const before = this.key()
    fn()
    const changed = before !== this.key()
    if (changed) this.since = now
    return changed
  }

  output(chunk: string, now: number): boolean {
    if (this.reported || !this.heuristics()) return false
    return this.mutate(now, () => {
      const promptShown = (): boolean => SHELL_PROMPT_RES.some((re) => re.test(this.tail))
      if (this.agent !== null && PROMPT_OSC_RE.test(chunk)) {
        this.clear()
        return
      }
      const text = stripAnsi(chunk)
      if (text) this.tail = (this.tail + text).slice(-TAIL_CAP)
      if (this.agent === null) {
        const rule = AGENT_RULES.find((r) => r.detect.test(this.tail))
        if (!rule) return
        // Marker text in plain output (e.g. cat README.md) with the prompt back in the same chunk: not an agent.
        if (promptShown()) {
          this.clear()
          return
        }
        this.agent = rule.agent
        this.status = 'idle'
        this.source = 'heuristic'
      }
      // A prompt-looking tail only counts once it stays the tail for PROMPT_CONFIRM_MS (tick): a working TUI keeps redrawing.
      if (promptShown()) {
        this.promptSeenAt ??= now
        return
      }
      this.promptSeenAt = null
      if (now - this.lastInputAt < ECHO_MS || now - this.lastResizeAt < RESIZE_MS) return
      const rule = AGENT_RULES.find((r) => r.agent === this.agent)
      if (rule?.needsYou.some((re) => re.test(this.tail))) this.status = 'needs-you'
      else {
        this.status = 'working'
        this.lastOutputAt = now
      }
    })
  }

  /** The user typed. A blocked tab is no longer blocked (approved, or rejected with Esc). */
  input(now: number): boolean {
    this.lastInputAt = now
    this.tail = ''
    this.promptSeenAt = null
    return this.mutate(now, () => {
      if (this.status === 'needs-you') this.status = 'idle'
    })
  }

  resized(now: number): void {
    this.lastResizeAt = now
  }

  tick(now: number): boolean {
    if (!this.heuristics()) {
      // Heuristics turned off: drop what they set; reported statuses stay.
      if (this.agent === null || this.reported) return false
      return this.mutate(now, () => this.clear())
    }
    if (this.agent !== null && !this.reported && this.promptSeenAt !== null && now - this.promptSeenAt >= PROMPT_CONFIRM_MS) {
      if (SHELL_PROMPT_RES.some((re) => re.test(this.tail))) return this.mutate(now, () => this.clear())
      this.promptSeenAt = null
    }
    if (this.agent === null || this.source !== 'heuristic' || this.status !== 'working') return false
    if (now - this.lastOutputAt < QUIET_MS) return false
    return this.mutate(now, () => {
      this.status = 'done'
    })
  }

  report(o: HookOutcome | AgentStatus, now: number): boolean {
    const outcome: HookOutcome = typeof o === 'string' ? { kind: 'set', status: o } : o
    if (outcome.kind === 'ignore') return false
    return this.mutate(now, () => {
      if (outcome.kind === 'clear') {
        this.clear()
        return
      }
      this.reported = true
      this.source = 'report'
      this.agent ??= 'claude'
      this.status = outcome.status
    })
  }

  /** The user viewed the tab. */
  seen(now: number): boolean {
    return this.mutate(now, () => {
      if (this.status === 'done') this.status = 'idle'
    })
  }

  private clear(): void {
    this.agent = null
    this.status = 'idle'
    this.source = 'heuristic'
    this.reported = false
    this.tail = ''
    this.promptSeenAt = null
  }
}
