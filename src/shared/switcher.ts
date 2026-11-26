import { AGENT_STATUSES, STATUS_PRIORITY } from './agentStatus'
import type { AgentStatus } from './agentStatus'

/** Pure ranking and query parsing for the quick switcher (Ctrl+Shift+K). No DOM; shared by the renderer and the smoke checks. */

export type StatusFilter = AgentStatus | null

export interface SwitcherItem {
  /** 'tab:<tabId>' | 'loc:<locId>' */
  key: string
  kind: 'tab' | 'loc'
  locId: string
  /** kind === 'tab' only. */
  tabId?: string
  /** Location display name (Loc.name). */
  folder: string
  /** Tab title; for kind 'loc', the location path or ''. */
  title: string
  /** Tab: its status (shell and command tabs without an agent entry are 'idle'; diff and file tabs have none). Loc: worstStatus of its tabs. */
  status?: AgentStatus
  /** Stable input order (tabs in tab order, then locs in sidebar order). */
  order: number
}

const PREFIX: Record<string, AgentStatus> = { n: 'needs-you', d: 'done', w: 'working', i: 'idle' }

/** Leading "n:", "d:", "w:", "i:" (case-insensitive, optional space after) sets the status; the rest is the text.
 *  A drive path such as "d:\src" is text, not a prefix. */
export function parseSwitcherQuery(q: string): { status: StatusFilter; text: string } {
  const m = /^\s*([ndwi]):(?![\\/])\s*([\s\S]*)$/i.exec(q)
  if (!m) return { status: null, text: q.trim() }
  return { status: PREFIX[m[1].toLowerCase()], text: m[2].trim() }
}

const WORD_START = ' -_/\\.:'

/** Subsequence score of needle in hay, case-insensitive; null when not a subsequence. Greedy left-to-right:
 *  +1 per matched char, +3 if the previous hay char was also matched, +2 if the char is at a word start
 *  (index 0 or previous char in " -_/\\.:"). */
export function fuzzyScore(needle: string, hay: string): number | null {
  const n = needle.toLowerCase()
  const h = hay.toLowerCase()
  let score = 0
  let ni = 0
  let prevMatched = false
  for (let hi = 0; hi < h.length && ni < n.length; hi++) {
    if (h[hi] === n[ni]) {
      score += 1
      if (prevMatched) score += 3
      if (hi === 0 || WORD_START.includes(h[hi - 1])) score += 2
      ni++
      prevMatched = true
    } else prevMatched = false
  }
  return ni === n.length ? score : null
}

/** Worst-first: needs-you > done > working > idle; undefined for an empty list (or only undefined entries). */
export function worstStatus(statuses: (AgentStatus | undefined)[]): AgentStatus | undefined {
  let top: AgentStatus | undefined
  for (const s of statuses) if (s && (top === undefined || STATUS_PRIORITY[s] > STATUS_PRIORITY[top])) top = s
  return top
}

/** Rank used for sorting: lower is worse-first; items without a status come last. */
function statusRank(s: AgentStatus | undefined): number {
  return s ? AGENT_STATUSES.indexOf(s) : AGENT_STATUSES.length
}

/** Filter + rank. Status: the query prefix wins over `chip`. A non-null status keeps tab and loc items whose `status` equals it
 *  (for loc items that is the rollup). Text: split on whitespace; every token must match; item score = sum over tokens of the best of
 *  title (+1), folder, and "folder title". Sort: score desc, then tab before loc, then status (needs-you first, none last), then `order`. */
export function rankSwitcher(items: SwitcherItem[], query: string, chip: StatusFilter): SwitcherItem[] {
  const parsed = parseSwitcherQuery(query)
  const status = parsed.status ?? chip
  const tokens = parsed.text.split(/\s+/).filter(Boolean)
  const scored: { item: SwitcherItem; score: number }[] = []
  for (const item of items) {
    if (status !== null && item.status !== status) continue
    let score = 0
    let ok = true
    for (const tok of tokens) {
      const t = fuzzyScore(tok, item.title)
      const best = [t === null ? null : t + 1, fuzzyScore(tok, item.folder), fuzzyScore(tok, `${item.folder} ${item.title}`)].reduce<number | null>(
        (a, b) => (b === null ? a : a === null || b > a ? b : a),
        null
      )
      if (best === null) {
        ok = false
        break
      }
      score += best
    }
    if (ok) scored.push({ item, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.item.kind === b.item.kind ? 0 : a.item.kind === 'tab' ? -1 : 1) ||
      statusRank(a.item.status) - statusRank(b.item.status) ||
      a.item.order - b.item.order
  )
  return scored.map((s) => s.item)
}
