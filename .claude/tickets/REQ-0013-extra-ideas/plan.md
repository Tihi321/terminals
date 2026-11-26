---
status: in-progress
request: REQ-0013
repos: [C:/projects/Personal/terminals]
branch: feat/herdr-agent-workflow
updated: 2026-11-26
---

# REQ-0013: Extra agent-workflow ideas (done age, hook Test button, lock icon, rollup counts, MRU switcher, rollup alignment)

Builds on REQ-0010 (agent status), REQ-0011 (worktrees) and REQ-0012 (switcher). Full reading of all five features, plus feature 6 as 6B (the user's pick).

## Scope

1. **Done age.** A `done` status shows how long ago it finished: in the tab tooltip (tab element and its `agent-ind` dot), in the sidebar row's agent-indicator tooltip (one line per tab), and as a short label in the switcher row badge (`Done · 2m`). Source: `TermStatus.since` (set by `AgentStatusTracker.mutate` whenever agent/status/source changes, so for `done` it is the moment it became done). Updates once a minute through a shared minute ticker that only the components showing ages subscribe to (TabBar, sidebar agent indicator, QuickSwitcher). App does not re-render on the tick.
2. **Settings > Agent status > Test button.** Runs the real installed `status-hook.cmd` through `cmd.exe /d /c`, stdin = `{"hook_event_name":"Stop"}`, env = the live `TERMINALS_STATUS_URL` / `TERMINALS_MCP_TOKEN` plus `TERMINALS_TERM_ID=hooktest:<uuid>`. The `/status` handler recognises a registered `hooktest:` id, records the hit and answers 204 without calling `terminals.report`, so no real tab changes. Reports OK (with ms) or one named failure: not installed, outdated entries, script missing, script out of date, server not running, curl missing, 401, no request arrived, bad payload.
3. **Lock icon** on locked worktree rows (`WorktreeView.locked`), with tooltip "Locked worktree: git refuses to remove it until you run git worktree unlock".
4. **Rollup counts.** Sidebar rows with a status indicator (folder, child, worktree, Home, group) show the needs-you count inside the orange pill when it is 2 or more (`2!`; 1 stays `!`). Done and working stay dots. The indicator tooltip starts with a summary line, e.g. `2 need you, 1 done, 3 working`. Switcher folder rows show the summary as their badge text (`2 need you · 1 done`) instead of only the worst status label.
5. **MRU switcher.** With no text tokens in the query (empty query, or only a status prefix/chip), tab rows sort by status (needs-you, done, working, idle, none), then most recently activated first, then tab order. Folder rows stay after tab rows (unchanged). The tab the user is in (focused pane's active tab) sorts last within its status, so Enter on the first row goes somewhere else. Activation times live in a renderer ref (runtime only, never saved). A typed query ranks exactly as today.
6. **Rollup alignment (6B).** Switcher folder rows for non-group locations count only their own tabs (what the sidebar does now); group rows keep the whole-subtree rollup including worktrees.

## Out of scope

- Ages for needs-you / working ("waiting 5m"), and ages in the collapsed rail strip.
- Second-granularity ages; persisting MRU across restarts; MRU for folder rows.
- Lock/unlock/prune actions (README still lists them as not covered).
- Changing the hook script, the hook event mapping, or `settings.json` from the Test button (the Test button never writes settings or the script; it only reads them and runs the script).
- Counts on tab-bar indicators (one tab = one status).

## Files and modules to touch

| File | Change | Task |
| --- | --- | --- |
| `src/shared/agentStatus.ts` | `formatAgo`, `rollupSummary`; `rollupOf` entries take `since?`; `StatusRollup.items` becomes structured | T1 |
| `src/shared/switcher.ts` | `SwitcherItem.lastUsed?`, `since?`, `counts?`; MRU tiebreak in `rankSwitcher` | T1 |
| `src/shared/claudeHooks.ts` | `HOOK_TEST_PREFIX`, `HookTestKind`, `HookTestResult`, pure `classifyHookTest` | T1 |
| `src/main/smoke.ts` | a few asserts in `checkSwitcher`, `checkAgentStatus`, `checkMcpHttp` | T1, T4, T5 |
| `src/main/hookTest.ts` (new, no electron import) | `runHookTest` | T4 |
| `src/main/mcp.ts` | test-id registry, 401 notification, 204 short-circuit | T4 |
| `src/main/index.ts` | IPC `hooks:test` | T4 |
| `src/preload/index.ts`, `src/shared/types.ts` | `testClaudeHooks()` | T4 |
| `src/renderer/src/SettingsDialog.tsx` | Test button + result line | T4 |
| `src/renderer/src/useMinute.ts` (new) | shared minute ticker hook | T2 |
| `src/renderer/src/App.tsx` (shared) | since/counts/lastUsed plumbing, MRU stamps | T2 (and T5 comment only for 6B) |
| `src/renderer/src/TabBar.tsx` | done age in tooltips | T2 |
| `src/renderer/src/QuickSwitcher.tsx` | badge label with age / counts | T2 |
| `src/renderer/src/Sidebar.tsx` (shared) | `AgentInd` component (age lines, summary, count pill), `locked` row prop | T3 |
| `src/renderer/src/WorktreeRows.tsx` | pass `locked` | T3 |
| `src/renderer/src/styles.css` | `.row-lock`, switcher badge age text | T2, T3 |
| `README.md` | docs | T6 |

**Shared-file ordering:** App.tsx is edited by T2 (and T5, comment only); Sidebar.tsx by T3. Run **T1 → T2 → T3 → T5 → T6** in sequence. **T4** touches none of App/Sidebar/TabBar/QuickSwitcher and may run in parallel with T2/T3 after T1; it shares `smoke.ts` with T1/T5, so its smoke edit must land after T1's (edit only `checkMcpHttp` and add the `classifyHookTest` asserts at the end of `checkAgentStatus`).

## Tasks for workers

### T1: Shared pure helpers and their smoke asserts

Inputs: `src/shared/agentStatus.ts`, `src/shared/switcher.ts`, `src/shared/claudeHooks.ts`, `src/main/smoke.ts` (`checkSwitcher`, `checkAgentStatus`).

Outputs and contracts:

- `src/shared/agentStatus.ts`
  - `export function formatAgo(since: number, now: number): string`: `d = max(0, now - since)`; `< 60_000` → `'just now'`; `< 3_600_000` → `` `${floor(d/60000)}m ago` ``; `< 86_400_000` → `` `${floor(d/3600000)}h ago` ``; else `` `${floor(d/86400000)}d ago` ``.
  - `export function shortAgo(since, now): string`: same buckets without " ago" (`'now'`, `'2m'`, `'3h'`, `'1d'`), for the switcher badge.
  - `rollupOf(entries: { status; title; since?: number }[])`.
  - `StatusRollup.items: { title: string; status: AgentStatus; since?: number }[]` (was `string[]`). `rollupStatus` concatenates as now. Only consumer of `items` today is `agentTitle` in Sidebar.tsx (T3 rewrites it); App.tsx does not read items. Keep the build green in T1 by updating `agentTitle` to `a.items.map(i => \`${i.title}: ${STATUS_LABEL[i.status]}\`)` (T3 replaces it).
  - `export function rollupSummary(r: { needsYou: number; done: number; working: number }, sep = ', '): string`: nonzero parts in order `N need(s) you`, `N done`, `N working` (`1 needs you`, `2 need you`), joined by `sep`; `''` when all zero.
- `src/shared/switcher.ts`
  - `SwitcherItem` gains `lastUsed?: number` (tab only; epoch ms of last activation, `-1` for the current tab, absent = never), `since?: number` (tab with status `done` only), `counts?: { needsYou: number; done: number; working: number }` (loc only; sum over the same ids the loc status uses; absent when all zero).
  - `rankSwitcher`: when `tokens.length === 0`, sort = tab before loc, then status rank, then `(b.lastUsed ?? 0) - (a.lastUsed ?? 0)` (desc), then `order`. When tokens exist, the sort is unchanged (score desc, tab before loc, status, order). Update the doc comment.
- `src/shared/claudeHooks.ts`
  - `export const HOOK_TEST_PREFIX = 'hooktest:'`.
  - `export type HookTestKind = 'not-installed' | 'outdated' | 'script-missing' | 'script-outdated' | 'server-off' | 'curl-missing' | 'unauthorized' | 'no-request' | 'bad-payload'`.
  - `export type HookTestResult = { ok: true; ms: number } | { ok: false; kind: HookTestKind; message: string }`.
  - `export interface HookTestFacts { installed: boolean; outdated: boolean; scriptExists: boolean; scriptCurrent: boolean; serverUp: boolean; hit?: 'ok' | 'unauthorized' | 'bad-payload'; curlFound?: boolean; ms?: number }`.
  - `export function classifyHookTest(f: HookTestFacts): HookTestResult`, first match wins: `!installed && !outdated` → not-installed ("Hooks are not installed: click Install."); `!scriptExists` → script-missing ("status-hook.cmd is missing from the data folder: click Reinstall."); `!scriptCurrent` → script-outdated ("status-hook.cmd is out of date: click Reinstall."); `!serverUp` → server-off ("The app's local server is not running (see the MCP section), so hooks cannot reach it."); `hit === 'unauthorized'` → unauthorized ("The app answered 401: the token the script sent was not accepted."); `hit === 'bad-payload'` → bad-payload; `hit === undefined && curlFound === false` → curl-missing ("curl.exe was not found on PATH; it ships with Windows 10 and later."); `hit === undefined` → no-request ("curl ran but no request reached the app (a proxy setting such as HTTP_PROXY without NO_PROXY=127.0.0.1?)."); `hit === 'ok' && outdated` → outdated ("The script reached the app, but the hook entries in settings.json are outdated: click Reinstall."); else `{ ok: true, ms }`.
- `src/main/smoke.ts` (asserts only, inside existing checks, no new check functions):
  - `checkAgentStatus`: `formatAgo(0, 30_000) === 'just now'`, `formatAgo(0, 125_000) === '2m ago'`, `formatAgo(0, 2*3_600_000) === '2h ago'`; `rollupSummary({ needsYou: 2, done: 1, working: 0 }) === '2 need you, 1 done'`.
  - `checkSwitcher`: give `tab(1, 'web', 'Agent 1', 'working')` a second working tab `tab(6, 'api', 'build', 'working')` with `lastUsed: 2000` and `Agent 1` with `lastUsed: 1000`; assert `rankSwitcher(items, '', 'working')` lists `api/build` before `web/Agent 1`; assert the existing typed query `'api cl'` result is unchanged. Update the existing `'working chip'` / prefix asserts' expected strings to the new order rather than adding near-duplicates.

Verify: `yarn typecheck` (or the repo's lint/typecheck script) and `yarn smoke`.

### T2: Renderer plumbing, minute ticker, tab tooltip, switcher (App.tsx, TabBar.tsx, QuickSwitcher.tsx)

Inputs: T1 output; `src/renderer/src/App.tsx` (statuses effect ~L764, `tabStatus`/`agentByLoc`/`switcherItems` memos ~L1104-1149, `active`/`activeKey` ~L746, `<TabBar>` props ~L1439, `<QuickSwitcher>` ~L1714), `TabBar.tsx` (~L190-250), `QuickSwitcher.tsx`.

Outputs and contracts:

- New `src/renderer/src/useMinute.ts`: `export function useMinute(): number`, implemented with `useSyncExternalStore`; one module-level `setInterval(60_000)` started on the first subscriber and cleared when the last unsubscribes; snapshot = `Date.now()` captured at each tick (and at subscribe). Components that do not call it never re-render from it.
- App.tsx:
  - `tabStatusSince = useMemo(...)`: `Record<tabId, number>` for tabs whose status is `done` (from `statuses[id].since`). Pass to TabBar as new prop `statusSince`.
  - `agentByLoc`: push `{ status, title, since: s === 'done' ? statuses[t.id].since : undefined }`.
  - MRU: `const usedAt = useRef<Record<string, number>>({})`, `prevActive = useRef<Set<string>>()`. In a `useEffect` on `[activeKey, paneState?.focused]`: stamp `Date.now()` on every tab id in `Object.values(active)` not in `prevActive`, then stamp the focused pane's active tab (so focus changes count), then store the set. Delete ids of closed tabs lazily (skip ids not in `tabs` when building items).
  - `switcherItems`: add `switcherOpen` to the memo deps; tab items get `lastUsed: id === focusedActiveTabId ? -1 : usedAt.current[id]`, `since` for done tabs; loc items get `counts` = needs-you/done/working counts over the same `idsFor(l.id)` ids used for `status` (non-idle tab statuses only).
- TabBar.tsx: new prop `statusSince: Record<string, number>`; call `useMinute()` once in TabBar; when `agentSt === 'done'` and a since exists, `agentTip` becomes `\nAgent: Done (report), 2m ago` and the dot's `title` becomes `Done, 2m ago`.
- QuickSwitcher.tsx: call `useMinute()`; `Badge` takes the item: tab with `since` → text `Done · 2m` (via `shortAgo`), title `Done, 2m ago`; loc with `counts` → text `rollupSummary(counts, ' · ')`, indicator colour from `it.status`, title `rollupSummary(counts)`; otherwise as today.
- styles.css: only if the longer badge text needs it (e.g. `white-space: nowrap` on `.switcher-status`).

Verify: typecheck, `yarn smoke`; then manual checks M1, M4b, M5 below.

### T3: Sidebar indicator, counts and lock icon (Sidebar.tsx, WorktreeRows.tsx, styles.css)

Inputs: T1 + T2 output; `Sidebar.tsx` (`agentTitle` ~L71, `RowProps` ~L140, `Row` indicator ~L268, pinned icon ~L248), `WorktreeRows.tsx`, `styles.css` (`.row-pin` ~L484, `.agent-ind` ~L2495).

Outputs and contracts:

- In Sidebar.tsx replace the inline indicator with `function AgentInd({ a }: { a: StatusRollup }): JSX.Element` that calls `useMinute()` and renders `<span className={\`agent-ind ${a.top}\`} title={...}>`; content `!` when `a.top === 'needs-you'`, `${a.needsYou}!` when `a.needsYou >= 2`. Tooltip: `Agent status: ${rollupSummary(a)}` then one line per item (max 6, then `…`): `${title}: ${label}` plus `, ${formatAgo(since, now)}` for done items. Only rows with a rollup mount `AgentInd`, so only they subscribe to the ticker.
- `RowProps.locked?: boolean`; `Row` renders `<Lock size={11} strokeWidth={2.25} className="row-lock" aria-label="Locked" />` wrapped in a `<span title="Locked worktree: git refuses to remove it until you run git worktree unlock">` after the name (same place as the pin icon). Import `Lock` from lucide-react.
- WorktreeRows.tsx: pass `locked={w.locked && !w.missing}`; keep the existing `\n(locked)` suffix in the row title.
- styles.css: `.row-lock` same as `.row-pin` (margin-left 6px, vertical-align -1px, color var(--text-3)).

Verify: typecheck, `yarn smoke`; manual M3, M4a.

### T4: Hook Test button (main + preload + Settings)

Inputs: T1's `classifyHookTest` / `HOOK_TEST_PREFIX`; `src/main/mcp.ts` (`handle` ~L103, `handleStatus` ~L167), `src/main/claudeHooks.ts` (`getHooks`, `scriptPath`, `hookScript`), `src/main/index.ts` (IPC ~L781, `mcp` variable), `src/preload/index.ts` L133-135, `src/shared/types.ts` L516-518, `SettingsDialog.tsx` `ClaudeHooksRow` (~L215), smoke `checkMcpHttp` (~L1170-1215).

Outputs and contracts:

- `src/main/mcp.ts`:
  - Module-level `const hookTests = new Map<string, (hit: 'ok' | 'unauthorized' | 'bad-payload') => void>()` and `export function expectHookTest(id: string): { hit: Promise<'ok' | 'unauthorized' | 'bad-payload'>; dispose(): void }` (registers, resolves on first hit, `dispose` removes).
  - In `handle`, after the Host and Origin checks and before the token check returns 401: if the path is `/status`, read the `X-Terminals-Term` header; if it is a registered test id and `tokenMatches` fails, call its callback with `'unauthorized'`, then send the same 401 as today. No other ordering change.
  - In `handleStatus`, right after computing `outcome` (before `if (!terminals)`): if `id.startsWith(HOOK_TEST_PREFIX)`: registered → callback `outcome.kind === 'set' && outcome.status === 'done' ? 'ok' : 'bad-payload'`, reply 204; not registered → reply 404. `terminals.report` is never called for a `hooktest:` id.
- New `src/main/hookTest.ts` (no electron import):
  `export async function runHookTest(o: { scriptPath: string; statusUrl: string | null; token: string; hooks: { installed: boolean; outdated: boolean }; timeoutMs?: number }): Promise<HookTestResult>`:
  1. `scriptExists = existsSync(scriptPath)`, `scriptCurrent = scriptExists && readFileSync(scriptPath, 'utf8') === hookScript()`, `serverUp = !!statusUrl`. If `(!installed && !outdated) || !scriptExists || !scriptCurrent || !serverUp`, return `classifyHookTest(facts)` at once without running anything.
  2. `id = HOOK_TEST_PREFIX + randomUUID()`, `expectHookTest(id)`, start `t0`.
  3. Async `spawn('cmd.exe', ['/d', '/c', scriptPath], { env: { ...process.env, TERMINALS_STATUS_URL: statusUrl, TERMINALS_MCP_TOKEN: token, TERMINALS_TERM_ID: id }, windowsHide: true })`, `stdin.end('{"hook_event_name":"Stop"}')`. Never `spawnSync` (the server runs in this process; see the existing smoke comment).
  4. Wait for the hit or (child close + 500 ms grace) or `timeoutMs` (default 6000), whichever first; `ms = Date.now() - t0`.
  5. No hit → `curlFound` = `spawn('where.exe', ['curl.exe'])` exit code 0.
  6. `dispose()`; return `classifyHookTest({ ...facts, hit, curlFound, ms })`.
- `src/main/index.ts`: `ipcMain.handle('hooks:test', async () => { const h = claudeHooks.getHooks(); if (!h.ok) return { ok: false, kind: 'not-installed', message: h.error }; return runHookTest({ scriptPath: claudeHooks.scriptPath(), statusUrl: mcp?.statusUrl ?? null, token: mcp?.token ?? '', hooks: h }) })`.
- Preload `testClaudeHooks: () => inv('hooks:test')`; `src/shared/types.ts` `testClaudeHooks(): Promise<HookTestResult>`.
- `SettingsDialog.tsx` `ClaudeHooksRow`: a **Test** button after Remove, disabled while `busy` or when neither installed nor outdated; sets `busy`, clears `msg`, then shows `Hook test OK: the script reached the app in N ms.` (status) or the result's `message` (alert style, as existing errors).
- Smoke `checkMcpHttp` (it already writes the real `hookScript()` to `dir` and has a live server and terminal `o.id`): after the existing hook run, assert `runHookTest({ scriptPath: script, statusUrl: info.statusUrl, token: info.token, hooks: { installed: true, outdated: false } })` is `ok` **and** `statusOf()` is still `'working'` (unchanged real tab); and that the same call with `token: 'wrong'` returns `kind === 'unauthorized'`. Plus in `checkAgentStatus`: `classifyHookTest({ installed: true, outdated: false, scriptExists: true, scriptCurrent: true, serverUp: true, curlFound: false }).kind === 'curl-missing'` and the same with `installed: false` → `'not-installed'`.

Verify: typecheck, `yarn smoke`; manual M2.

### T5: Feature 6, 6B (run after T3)

- `src/shared/switcher.ts` `rollupIdsFor`: for an id that is not a group, return `[id]` (drop `withWt` for that branch). For groups keep `withWt(c.id)` for every member (the sidebar's `groupAgent` includes worktrees via `agentOf`). Update the doc comment: "A folder, child or worktree row is its own tabs only; a group is itself plus every member and their worktrees through its whole subtree."
- `App.tsx` comment above `switcherItems` (~L1130): same wording. No logic change in App (counts follow `idsFor`).
- Smoke `checkSwitcher`: change the existing `ru('f1')` expectation to `'f1'`; the `ru('p')` expectation stays `'p,child:p:c,wt:c,m,f2'`.

Verify: typecheck, `yarn smoke`; manual M6.

### T6: README

- Agent status section: after the tooltip bullet add "A done tab's tooltip says how long ago it finished (`Done, 2m ago`, updated every minute)." Change the folder/group bullet to describe the summary line and the `2!` count pill, and state which rows roll up what: "A folder, child or worktree row shows its own tabs; a group row rolls up its whole subtree including worktrees".
- Claude Code hooks: add a **Test** bullet: runs the installed script with a fake Stop event against the app's `/status` with a test id, never changes a tab, and names the failure (not installed, outdated, script missing/out of date, server not running, curl missing, 401, no request arrived).
- Quick switcher: "With nothing typed, tabs are ordered needs-you, done, working, idle, then most recently used; the tab you are in comes last of its group. Done tabs show their age; folder rows show counts (`2 need you · 1 done`)." Change the "worst status" sentence to: a folder row shows its own tabs; a group row its whole subtree including worktrees.
- Git worktrees: "Locked worktrees show a lock icon."
- Build/check paragraph (L23): mention the relative-time formatter, MRU order and the hook Test (OK path leaves the tab untouched, wrong token gives 401).

## Acceptance criteria with tests

Automated (`yarn smoke`, all inside existing checks):

- S1 `checkAgentStatus`: `formatAgo` buckets (`just now`, `2m ago`, `2h ago`) and `rollupSummary` text. (T1)
- S2 `checkSwitcher`: empty query with the working chip orders two working tabs by `lastUsed` desc; typed `'api cl'` ranking unchanged. (T1)
- S3 `checkMcpHttp`: `runHookTest` with the real script returns `ok` and the live terminal's status is unchanged; a wrong token returns `unauthorized`. `checkAgentStatus`: `classifyHookTest` gives `curl-missing` and `not-installed`. (T4)
- S4 `checkSwitcher`: `rollupIdsFor('f1')` is `f1`. (T5)
- Typecheck/lint passes.

Manual, in the real app (mark UNTESTED in the final summary if not run):

- M1 (T2/T3): run Claude in a tab, let it stop, switch away: tab tooltip and sidebar indicator tooltip show `Done, just now`, then `1m ago` after a minute without any interaction; switcher shows `Done · 1m`. React DevTools Profiler (or a console.count in App) confirms App does not re-render on the tick.
- M2 (T4): Settings > Agent status > Test with hooks installed shows OK and no tab's status changes. Rename `status-hook.cmd` → "missing" message; restore. With hooks removed the Test button is disabled.
- M3 (T3): `git worktree lock <path>` then refresh: the worktree row shows a lock icon with the tooltip; unlock removes it.
- M4a (T3): two needs-you tabs in one folder: sidebar pill shows `2!`, tooltip first line `Agent status: 2 need you`; a group containing it shows the summed counts.
- M4b (T2): switcher folder row for that folder shows `2 need you`.
- M5 (T2): open tabs A, B, C, activate C then A then B; Ctrl+Shift+K with nothing typed lists A, C before B (B is current, last); typing text gives the old ranking.
- M6 (T5): a needs-you tab in a worktree: the repo's switcher folder row shows no status, the group row does.

## Decisions

- Feature 6: 6B (chosen by the user). Switcher folder rows for non-group locations count only their own tabs; groups keep the subtree rollup.
- MRU: the current tab sorts last within its status (confirmed by the director).

## Progress (implement, 2026-11-26)

- [x] T1 helpers + smoke asserts (S1, S2): done.
- [x] T2 minute ticker, tab tooltip age, switcher badge/MRU/counts: done (focused pane id is `curPaneId` in App.tsx; a `focusedPaneId` function already existed).
- [x] T3 `AgentInd` (summary, `N!` pill, done ages), lock icon on locked worktree rows: done.
- [x] T4 hook Test button: done. Deviation: the `classifyHookTest` asserts live in `checkMcpHttp` (not `checkAgentStatus`) so the two parallel workers had disjoint smoke functions; smoke also asserts an unregistered `hooktest:` id gets 404. `bad-payload` message wording was not in the plan: "The app received the request but did not understand the hook payload."
- [x] T5 6B rollup (S4): done.
- [x] T6 README: done.
- Verification: `yarn typecheck` exit 0; `yarn smoke` 21 PASS, 0 FAIL.
- Manual M1-M6: UNTESTED (not run in the real app).
