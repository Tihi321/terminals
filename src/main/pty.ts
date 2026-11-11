import { existsSync } from 'node:fs'
import { delimiter, join, basename } from 'node:path'
import * as pty from '@lydell/node-pty'

export function findOnPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir.replace(/^"|"$/g, ''), exe)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Resolve the configured shell. Empty/"auto" -> pwsh.exe if on PATH, else powershell.exe. */
export function resolveShell(configured: string): string {
  if (configured && configured !== 'auto') return configured
  return findOnPath('pwsh.exe') ?? findOnPath('powershell.exe') ?? 'powershell.exe'
}

export function shellLabel(shell: string): string {
  return basename(shell).replace(/\.exe$/i, '')
}

export interface PtyHandlers {
  onData: (data: string) => void
  onExit: (exitCode: number) => void
}

/**
 * Arguments that make `shell` run the steps in order and stop at the first failing one,
 * propagating that step's exit code. PowerShell gets an -EncodedCommand so no quoting can go wrong.
 */
export function buildRunArgs(shell: string, steps: string[]): string[] {
  const clean = steps.map((s) => s.trim()).filter(Boolean)
  if (/pwsh|powershell/i.test(shell)) {
    // Deliberately no `exit` after a failed step: PowerShell buffers formatted output (tables such as
    // Get-Location) until the script ends, and `exit` drops it. Break out of the loop and let the script
    // end naturally, then set the process exit code through the host.
    const body = clean
      .map((s) => `${s}\nif (-not $?) { $__c = if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }; break }`)
      .join('\n')
    const script = `$__c = 0\ndo {\n${body}\n} while ($false)\n$host.SetShouldExit($__c)\n`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded]
  }
  return ['/d', '/s', '/c', clean.join(' && ')]
}

function spawnPty(
  shell: string,
  args: string[],
  cwd: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers
): pty.IPty {
  const p = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as { [key: string]: string }
  })
  p.onData(handlers.onData)
  p.onExit((e) => handlers.onExit(e.exitCode))
  return p
}

/** Interactive shell. Single spawn path used by both the app and the smoke test. */
export function spawnShell(shell: string, cwd: string, cols: number, rows: number, handlers: PtyHandlers): pty.IPty {
  return spawnPty(shell, [], cwd, cols, rows, handlers)
}

/** Non-interactive run of a list of steps; exits with the failing step's code (or 0). */
export function spawnSteps(
  shell: string,
  steps: string[],
  cwd: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers
): pty.IPty {
  return spawnPty(shell, buildRunArgs(shell, steps), cwd, cols, rows, handlers)
}
