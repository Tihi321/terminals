// Pure text helpers for terminal control (no electron import): ANSI stripping, line reconstruction,
// the output ring buffer and the run sentinel. Shared by terminalHost.ts and the smoke test.
export { psShell } from './pty'

const ESC = '\u001b'
const BEL = '\u0007'

// Order matters: strings (OSC, DCS/SOS/PM/APC) first, then CSI, then nF/2-byte escapes, then stray controls.
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
const STRING_RE = /\u001b[PX^_][^\u001b]*(?:\u001b\\)?/g
const CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]?/g
const ESC_RE = /\u001b[ -/]*[0-~]?/g
// C0 controls except \b (08) \t (09) \n (0A) \r (0D), plus DEL.
const CTRL_RE = /[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/g

/** Removes CSI, OSC (BEL- or ST-terminated), DCS/SOS/PM/APC strings, 2-byte ESC sequences and C0 controls except \n \r \t \b. */
export function stripAnsi(s: string): string {
  return s.replace(OSC_RE, '').replace(STRING_RE, '').replace(CSI_RE, '').replace(ESC_RE, '').replace(CTRL_RE, '')
}

function applyBackspaces(line: string): string {
  if (!line.includes('\b')) return line
  const out: string[] = []
  for (const ch of line) {
    if (ch === '\b') out.pop()
    else out.push(ch)
  }
  return out.join('')
}

/** stripAnsi, then: CRLF/LF split; a lone \r keeps only the text after it (overwrite); \b deletes the previous char;
 *  trailing spaces trimmed per line; trailing empty lines dropped. */
export function toLines(raw: string): string[] {
  const lines = stripAnsi(raw)
    .split(/\r*\n/)
    .map((l) => {
      let line = l
      if (line.includes('\r')) {
        const parts = line.split('\r')
        // A trailing \r (nothing after it) must not erase the line: take the last non-empty part.
        line = [...parts].reverse().find((p) => p !== '') ?? ''
      }
      return applyBackspaces(line).replace(/[ \t]+$/, '')
    })
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Keeps the last `cap` chars of everything pushed. */
export class RingBuffer {
  private s = ''
  private readonly cap: number
  constructor(cap: number) {
    this.cap = cap
  }
  push(x: string): void {
    this.s += x
    // Trim lazily so a stream of small chunks does not copy the whole buffer every time.
    if (this.s.length > this.cap * 1.25) this.s = this.s.slice(-this.cap)
  }
  text(): string {
    if (this.s.length > this.cap) this.s = this.s.slice(-this.cap)
    return this.s
  }
  get length(): number {
    return Math.min(this.s.length, this.cap)
  }
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

/** Single-quoted PowerShell literal (all four quote characters PowerShell treats as quotes are normalised and doubled). */
function psQuote(s: string): string {
  return `'${s.replace(/[‘’‚‛']/g, "''")}'`
}

/**
 * The single line (ending in '\r') typed into PowerShell for one run. It carries only base64, never ESC, so neither the
 * echo nor PSReadLine's redraw can contain a marker. Dot-sourced at the prompt, so `cd` and variables persist.
 * Markers: begin `ESC]133;C;terminals=<nonce>BEL`, end `ESC]133;D;<code>;terminals=<nonce>BEL`.
 */
export function buildRunInput(command: string, nonce: string): string {
  const first = (command.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim().slice(0, 200)
  const wrapper = [
    `$__tr = @{ done = 0; code = 1; err0 = $(if ($Error.Count) { $Error[0] } else { $null }) }`,
    `Write-Host ('[agent] ' + ${psQuote(first)}) -ForegroundColor DarkGray`,
    `[Console]::Write([string][char]27 + ']133;C;terminals=${nonce}' + [char]7)`,
    `$global:LASTEXITCODE = 0`,
    `try {`,
    `  . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(command)}'))))`,
    `  $__tr.done = 1`,
    `  if ($global:LASTEXITCODE) { $__tr.code = $global:LASTEXITCODE }`,
    `  elseif ($Error.Count -and -not [object]::ReferenceEquals($Error[0], $__tr.err0)) { $__tr.code = 1 }`,
    `  else { $__tr.code = 0 }`,
    `} catch { $__tr.done = 1; $__tr.code = 1; $_ | Out-Host }`,
    `finally {`,
    `  $__c = 1; $__d = 0`,
    `  if ($__tr -is [hashtable]) { $__c = [int]$__tr.code; $__d = [int]$__tr.done }`,
    `  [Console]::Write([string][char]27 + ']133;D;' + $__c + $(if ($__d) { '' } else { 'x' }) + ';terminals=${nonce}' + [char]7)`,
    `  Remove-Variable __tr, __c, __d -Scope Global -ErrorAction SilentlyContinue`,
    `}`
  ].join('\n')
  return `. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(wrapper)}'))))\r`
}

/** Finds this run's markers in `buf` (searching from `from`). begin = index just after the begin marker; end = index of the end marker start. */
export function findMarkers(
  buf: string,
  nonce: string,
  from = 0
): { begin: number | null; end: { index: number; code: number; abnormal: boolean } | null } {
  const start = Math.max(0, from)
  const beginRe = new RegExp(`${ESC}\\]133;C;terminals=${nonce}(?:${BEL}|${ESC}\\\\)`, 'g')
  beginRe.lastIndex = start
  const b = beginRe.exec(buf)
  const begin = b ? b.index + b[0].length : null
  const endRe = new RegExp(`${ESC}\\]133;D;(-?\\d+)(x?);terminals=${nonce}(?:${BEL}|${ESC}\\\\)`, 'g')
  endRe.lastIndex = begin ?? start
  const e = endRe.exec(buf)
  return { begin, end: e ? { index: e.index, code: Number(e[1]), abnormal: e[2] === 'x' } : null }
}
