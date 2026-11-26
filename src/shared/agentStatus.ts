// Agent status contract shared by main (tracker, /status endpoint) and the renderer (tabs, sidebar). Pure: no DOM, no node.

export type AgentStatus = 'working' | 'done' | 'needs-you' | 'idle'

/** Priority order, highest first. */
export const AGENT_STATUSES: readonly AgentStatus[] = ['needs-you', 'done', 'working', 'idle']

export const STATUS_PRIORITY: Record<AgentStatus, number> = { 'needs-you': 3, done: 2, working: 1, idle: 0 }

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Working',
  done: 'Done',
  'needs-you': 'Needs you',
  idle: 'Idle'
}

export type StatusSource = 'report' | 'heuristic'

export interface TermStatus {
  status: AgentStatus
  source: StatusSource
  /** Epoch ms of the last change. */
  since: number
  /** 'claude' or null when unknown. */
  agent: string | null
}

export interface StatusRollup {
  /** Highest-priority non-idle status present. */
  top: AgentStatus | null
  needsYou: number
  done: number
  working: number
  /** One entry per non-idle tab; `since` is when its status last changed. */
  items: { title: string; status: AgentStatus; since?: number }[]
}

/** "just now", "2m ago", "3h ago", "1d ago". */
export function formatAgo(since: number, now: number): string {
  const d = Math.max(0, now - since)
  if (d < 60_000) return 'just now'
  return `${shortAgo(since, now)} ago`
}

/** Same buckets without " ago" ("now", "2m", "3h", "1d"), for the switcher badge. */
export function shortAgo(since: number, now: number): string {
  const d = Math.max(0, now - since)
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  return `${Math.floor(d / 86_400_000)}d`
}

/** "2 need you, 1 done, 3 working" (nonzero parts only; '' when all zero). */
export function rollupSummary(r: { needsYou: number; done: number; working: number }, sep = ', '): string {
  const parts: string[] = []
  if (r.needsYou > 0) parts.push(`${r.needsYou} ${r.needsYou === 1 ? 'needs' : 'need'} you`)
  if (r.done > 0) parts.push(`${r.done} done`)
  if (r.working > 0) parts.push(`${r.working} working`)
  return parts.join(sep)
}

export function rollupOf(entries: { status: AgentStatus; title: string; since?: number }[]): StatusRollup | undefined {
  let out: StatusRollup | undefined
  for (const e of entries) {
    if (e.status === 'idle') continue
    out ??= { top: null, needsYou: 0, done: 0, working: 0, items: [] }
    if (e.status === 'needs-you') out.needsYou++
    else if (e.status === 'done') out.done++
    else out.working++
    if (out.top === null || STATUS_PRIORITY[e.status] > STATUS_PRIORITY[out.top]) out.top = e.status
    out.items.push({ title: e.title, status: e.status, since: e.since })
  }
  return out
}

export function rollupStatus(a: StatusRollup | undefined, b: StatusRollup | undefined): StatusRollup | undefined {
  if (!a) return b
  if (!b) return a
  const top = a.top === null ? b.top : b.top === null ? a.top : STATUS_PRIORITY[a.top] >= STATUS_PRIORITY[b.top] ? a.top : b.top
  return {
    top,
    needsYou: a.needsYou + b.needsYou,
    done: a.done + b.done,
    working: a.working + b.working,
    items: [...a.items, ...b.items]
  }
}

export type HookOutcome = { kind: 'set'; status: AgentStatus } | { kind: 'clear' } | { kind: 'ignore' }

/** Maps a Claude Code hook payload (the hook's stdin JSON) to a status change. */
export function statusFromHookEvent(payload: unknown): HookOutcome {
  if (!payload || typeof payload !== 'object') return { kind: 'ignore' }
  const p = payload as Record<string, unknown>
  switch (p.hook_event_name) {
    case 'SessionStart':
      return { kind: 'set', status: 'idle' }
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return { kind: 'set', status: 'working' }
    case 'PermissionRequest':
      return { kind: 'set', status: 'needs-you' }
    case 'Notification':
      return p.notification_type === 'permission_prompt' ? { kind: 'set', status: 'needs-you' } : { kind: 'ignore' }
    case 'Stop':
      return { kind: 'set', status: 'done' }
    case 'SessionEnd':
      return { kind: 'clear' }
    default:
      return { kind: 'ignore' }
  }
}

/** Validates report_status / ?state=: exactly the four status strings. */
export function parseReportedStatus(v: unknown): AgentStatus | null {
  return v === 'working' || v === 'done' || v === 'needs-you' || v === 'idle' ? v : null
}
