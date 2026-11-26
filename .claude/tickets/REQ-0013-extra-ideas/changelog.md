# Changelog

## 2026-11-26 REQ-0013: done ages, hook Test button, lock icon, rollup counts, MRU switcher, 6B rollup

Repo C:/projects/Personal/terminals, branch `feat/herdr-agent-workflow`.

### Files
- `src/shared/agentStatus.ts`: `formatAgo`, `shortAgo`, `rollupSummary`; `StatusRollup.items` is structured `{title, status, since?}`.
- `src/shared/switcher.ts`: `SwitcherItem.lastUsed/since/counts`; with no text tokens tabs sort by status, then most recently used (current tab = -1, last of its status), then order; `rollupIdsFor` returns only the row itself for non-groups (6B).
- `src/shared/claudeHooks.ts`: `HOOK_TEST_PREFIX`, `HookTest*` types, pure `classifyHookTest`.
- `src/main/mcp.ts`: `expectHookTest` registry; 401 on `/status` notifies a registered test id; `hooktest:` ids answer 204 (registered) or 404 and never reach `terminals.report`.
- `src/main/hookTest.ts` (new): `runHookTest` runs the real `status-hook.cmd` via async `cmd.exe /d /c` with a Stop event and a test id, read-only, then classifies; checks `where.exe curl.exe` when no request arrived.
- `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`: IPC `hooks:test` / `testClaudeHooks()`.
- `src/renderer/src/SettingsDialog.tsx`: Test button (disabled when hooks absent or busy) with an inline OK/failure line.
- `src/renderer/src/useMinute.ts` (new): shared once-a-minute `useSyncExternalStore` clock; App does not subscribe.
- `src/renderer/src/App.tsx`: `tabStatusSince`, `since` in `agentByLoc`, runtime-only MRU stamps, switcher `lastUsed/since/counts`.
- `src/renderer/src/TabBar.tsx`: done tab tooltip and dot show the age.
- `src/renderer/src/QuickSwitcher.tsx`: badge `Done · 2m`, folder rows `2 need you · 1 done`.
- `src/renderer/src/Sidebar.tsx`: `AgentInd` (summary tooltip line, `N!` pill from 2, done ages); `locked` row prop with lock icon and tooltip.
- `src/renderer/src/WorktreeRows.tsx`: passes `locked`.
- `src/renderer/src/styles.css`: `.row-lock`, `.switcher-status` nowrap.
- `src/main/smoke.ts`: asserts S1-S4 inside existing checks.
- `README.md`: agent status, hook Test, switcher order/ages/counts, lock icon, smoke paragraph.

### Deviations
- `classifyHookTest` asserts placed in `checkMcpHttp` instead of `checkAgentStatus` (parallel workers kept disjoint smoke functions). Extra assert: unregistered `hooktest:` id gets 404.
- `bad-payload` message wording chosen by the implementer (plan gave none).

### Verification
- `yarn typecheck`: exit 0.
- `yarn smoke`: 21 PASS, 0 FAIL.
- Not run: manual M1-M6 in the real app (UNTESTED), including the App no-re-render-on-tick profile.

### Follow-ups
- None filed.

### Commit status
- Committed on `feat/herdr-agent-workflow` (see git log), not pushed.
