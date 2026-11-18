import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'
import { isRunnableShell } from './pty'

/** Elevator lookup and elevated command line. Pure apart from the injected deps; `readSudoMode` is the only impure export. */

export type ElevatorTool = 'gsudo' | 'sudo'
export interface Elevator {
  tool: ElevatorTool
  path: string
}
export type SudoMode = 'disabled' | 'forceNewWindow' | 'disableInput' | 'normal' | 'unknown'
export interface ElevatorDeps {
  /** process.env at request time. */
  env: Record<string, string | undefined>
  exists: (p: string) => boolean
  /** Reads the registry; injected so tests never touch it. */
  sudoMode: () => SudoMode
}

/** Windows env names are case-insensitive; a plain object is not. */
function envVar(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name]) return env[name]
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? env[key] || undefined : undefined
}

/** Places to look for gsudo.exe, in order. Every entry is an absolute path. */
export function gsudoCandidates(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  const add = (base: string | undefined, ...rest: string[]): void => {
    if (base && win32.isAbsolute(base)) out.push(win32.join(base, ...rest))
  }
  for (const dir of (envVar(env, 'PATH') ?? '').split(';')) add(dir.replace(/^"|"$/g, ''), 'gsudo.exe')
  add(envVar(env, 'ProgramFiles'), 'gsudo', 'Current', 'gsudo.exe')
  const pf86 = envVar(env, 'ProgramFiles(x86)')
  add(pf86, 'gsudo', 'Current', 'gsudo.exe')
  add(pf86, 'gsudo', 'gsudo.exe')
  add(envVar(env, 'LOCALAPPDATA'), 'Microsoft', 'WinGet', 'Links', 'gsudo.exe')
  const scoop = envVar(env, 'SCOOP')
  const home = envVar(env, 'USERPROFILE')
  if (scoop) add(scoop, 'shims', 'gsudo.exe')
  else if (home) add(home, 'scoop', 'shims', 'gsudo.exe')
  const choco = envVar(env, 'ChocolateyInstall')
  if (choco) add(choco, 'bin', 'gsudo.exe')
  else add(envVar(env, 'ProgramData'), 'chocolatey', 'bin', 'gsudo.exe')
  return out
}

/** gsudo if found; else Windows sudo.exe (System32 only) when enabled in normal (inline) mode; else null. Never cached. */
export function resolveElevator(deps: ElevatorDeps): Elevator | null {
  for (const p of gsudoCandidates(deps.env)) if (deps.exists(p)) return { tool: 'gsudo', path: p }
  const root = envVar(deps.env, 'SystemRoot')
  if (root && win32.isAbsolute(root)) {
    const sudo = win32.join(root, 'System32', 'sudo.exe')
    if (deps.exists(sudo) && deps.sudoMode() === 'normal') return { tool: 'sudo', path: sudo }
  }
  return null
}

/** Maps `reg query ... /v Enabled` output to a sudo mode. */
export function parseSudoMode(stdout: string): SudoMode {
  const m = /Enabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout)
  if (!m) return 'unknown'
  switch (parseInt(m[1], 16)) {
    case 0:
      return 'disabled'
    case 1:
      return 'forceNewWindow'
    case 2:
      return 'disableInput'
    case 3:
      return 'normal'
    default:
      return 'unknown'
  }
}

/** Reads the Windows sudo mode from the registry. A missing key or value means disabled. Not used by smoke checks. */
export function readSudoMode(): SudoMode {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Sudo', '/v', 'Enabled'], {
      timeout: 2000,
      windowsHide: true,
      encoding: 'utf8'
    })
    return parseSudoMode(out)
  } catch {
    return 'disabled'
  }
}

/** File and args to spawn an elevated shell. Fixed flags only; null when the shell is not PowerShell or cmd. */
export function elevatedCommand(shell: string, elev: Elevator): { file: string; args: string[] } | null {
  if (!isRunnableShell(shell)) return null
  // Elevated: the basename must be exactly a known shell, not just contain its name.
  const base = win32.basename(shell).toLowerCase()
  if (base !== 'pwsh.exe' && base !== 'powershell.exe' && base !== 'cmd.exe') return null
  const shellArgs = base === 'cmd.exe' ? [] : ['-NoLogo']
  if (elev.tool === 'gsudo') return { file: elev.path, args: ['--direct', shell, ...shellArgs] }
  return { file: elev.path, args: [shell, ...shellArgs] }
}

/** Error text when an elevated request must be rejected (it carries steps), else null. */
export function checkElevatedRequest(req: { elevated?: boolean; steps?: unknown }): string | null {
  if (req.elevated === true && Array.isArray(req.steps)) return 'Admin terminals cannot run saved commands'
  return null
}
