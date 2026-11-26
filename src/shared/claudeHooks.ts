// Claude Code hooks that report agent status to the app. Pure helpers: the main process does the file IO.

export const HOOK_SCRIPT_NAME = 'status-hook.cmd'
export const HOOK_MARKER = HOOK_SCRIPT_NAME
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd'
] as const

export interface HookCommand {
  type: 'command'
  command: string
  args: string[]
  timeout: number
}

export interface HookGroup {
  matcher?: string
  hooks: HookCommand[]
}

export type ClaudeSettings = Record<string, unknown>

/** The script the hooks run (CRLF). Prints nothing and always exits 0; does nothing outside the app's terminals. */
export function hookScript(): string {
  return (
    [
      '@echo off',
      'if not defined TERMINALS_STATUS_URL exit /b 0',
      'if not defined TERMINALS_TERM_ID exit /b 0',
      'curl.exe -s -m 2 -o NUL -X POST "%TERMINALS_STATUS_URL%" -H "Authorization: Bearer %TERMINALS_MCP_TOKEN%" -H "X-Terminals-Term: %TERMINALS_TERM_ID%" -H "Content-Type: application/json" --data-binary @- >NUL 2>NUL',
      'exit /b 0'
    ].join('\r\n') + '\r\n'
  )
}

/** Exec form: no shell parsing. */
export function hookEntry(scriptPath: string): HookCommand {
  return { type: 'command', command: 'cmd.exe', args: ['/d', '/c', scriptPath], timeout: 5 }
}

const MATCHER_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse', 'PermissionRequest'])

function ourGroup(event: string, scriptPath: string): HookGroup {
  return { ...(MATCHER_EVENTS.has(event) ? { matcher: '*' } : {}), hooks: [hookEntry(scriptPath)] }
}

export function claudeHooksConfig(scriptPath: string): { hooks: Record<string, HookGroup[]> } {
  const hooks: Record<string, HookGroup[]> = {}
  for (const e of HOOK_EVENTS) hooks[e] = [ourGroup(e, scriptPath)]
  return { hooks }
}

function isOurHook(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false
  const o = h as { command?: unknown; args?: unknown }
  const marker = HOOK_MARKER.toLowerCase()
  if (typeof o.command === 'string' && o.command.toLowerCase().includes(marker)) return true
  return Array.isArray(o.args) && o.args.some((a) => typeof a === 'string' && a.toLowerCase().includes(marker))
}

function groupHooks(g: unknown): unknown[] {
  return g && typeof g === 'object' && Array.isArray((g as { hooks?: unknown }).hooks) ? (g as { hooks: unknown[] }).hooks : []
}

/** Returns a new settings object with our hooks installed or removed; everything else is left alone. */
export function mergeClaudeHooks(settings: ClaudeSettings, mode: 'install' | 'remove', scriptPath: string): ClaudeSettings {
  const out: ClaudeSettings = { ...settings }
  const rawHooks = settings.hooks
  const hooks: Record<string, unknown> = rawHooks && typeof rawHooks === 'object' && !Array.isArray(rawHooks) ? { ...(rawHooks as Record<string, unknown>) } : {}
  const events = mode === 'install' ? [...HOOK_EVENTS] : Object.keys(hooks)
  for (const e of events) {
    const cur = Array.isArray(hooks[e]) ? (hooks[e] as unknown[]) : []
    // Strip our entries (installing replaces a stale path), dropping groups that became empty because of it.
    const groups: unknown[] = []
    for (const g of cur) {
      const inner = groupHooks(g)
      const kept = inner.filter((h) => !isOurHook(h))
      if (kept.length === inner.length) groups.push(g)
      else if (kept.length > 0) groups.push({ ...(g as object), hooks: kept })
    }
    if (mode === 'install') groups.push(ourGroup(e, scriptPath))
    if (groups.length > 0) hooks[e] = groups
    else delete hooks[e]
  }
  if (Object.keys(hooks).length > 0) out.hooks = hooks
  else delete out.hooks
  return out
}

function eventGroups(settings: ClaudeSettings, e: string): unknown[] {
  const hooks = settings.hooks
  const groups = hooks && typeof hooks === 'object' ? (hooks as Record<string, unknown>)[e] : undefined
  return Array.isArray(groups) ? groups : []
}

/** True when any of our hooks is present, whatever the script path or event set (an outdated install). */
export function hooksPresent(settings: ClaudeSettings): boolean {
  return HOOK_EVENTS.some((e) => eventGroups(settings, e).some((g) => groupHooks(g).some(isOurHook)))
}

/** True only for a current install: every event has our hook pointing at exactly `scriptPath`. */
export function hooksInstalled(settings: ClaudeSettings, scriptPath: string): boolean {
  const want = scriptPath.toLowerCase()
  const current = (h: unknown): boolean =>
    isOurHook(h) && Array.isArray((h as { args?: unknown }).args) && (h as { args: unknown[] }).args.some((a) => typeof a === 'string' && a.toLowerCase() === want)
  return HOOK_EVENTS.every((e) => eventGroups(settings, e).some((g) => groupHooks(g).some(current)))
}
