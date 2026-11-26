// Cleans a terminal title (OSC 0/2) for use as a tab title. Pure.

const MAX_LEN = 60
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
// Braille spinner frames, Claude Code's star glyphs, middle dots, bullets, circles and whitespace.
const LEADING_GLYPHS_RE = /^[⠀-⣿✰-✿·*•◐◓◑◒\s]+/
const SHELL_NAMES_RE = /^(windows powershell|administrator:.*|pwsh|powershell|cmd)$/i

/** Cleaned title, or null when empty or just the shell's own name/path (ConPTY sets that at start). */
export function cleanTermTitle(raw: string): string | null {
  let t = String(raw).replace(CONTROL_RE, '').replace(LEADING_GLYPHS_RE, '').trim()
  if (!t) return null
  if (/\.exe$/i.test(t) || /^[a-z]:\\/i.test(t) || SHELL_NAMES_RE.test(t)) return null
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN - 1).trimEnd() + '…'
  return t
}
