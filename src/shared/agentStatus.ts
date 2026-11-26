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
  /** "<tab title>: <label>" per non-idle tab. */
  items: string[]
}

export function rollupOf(entries: { status: AgentStatus; title: string }[]): StatusRollup | undefined {
  let out: StatusRollup | undefined
  for (const e of entries) {
    if (e.status === 'idle') continue
    out ??= { top: null, needsYou: 0, done: 0, working: 0, items: [] }
    if (e.status === 'needs-you') out.needsYou++
    else if (e.status === 'done') out.done++
    else out.working++
    if (out.top === null || STATUS_PRIORITY[e.status] > STATUS_PRIORITY[out.top]) out.top = e.status
    out.items.push(`${e.title}: ${STATUS_LABEL[e.status]}`)
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
