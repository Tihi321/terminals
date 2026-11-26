# Changelog

## 2026-11-26 REQ-0010 Agent status per tab, status reporting, heuristics, auto tab titles

Outcome: terminal tabs show live agent status (working / done / needs-you) from Claude Code hooks, the `report_status` MCP tool, or a Claude Code output heuristic; rolled up in the sidebar, the Activity "Needs you" section and the collapsed strip. Shell tabs follow the terminal title and can be renamed.

### terminals (branch `feat/herdr-agent-workflow`)

- `src/shared/agentStatus.ts` (new): status types, priority, labels, `rollupOf` / `rollupStatus`, `statusFromHookEvent`, `parseReportedStatus`.
- `src/shared/claudeHooks.ts` (new): the `status-hook.cmd` script text, exec-form hook entry, config builder, idempotent install/remove merge, installed check.
- `src/shared/termTitle.ts` (new): `cleanTermTitle` drops spinner glyphs, control chars and shell exe-path titles.
- `src/shared/types.ts`, `settings.ts`, `session.ts`: `Settings.agentHeuristics` (default on), `PersistedTab.userTitle` (shell tabs), six new `TerminalsApi` methods.
- `src/main/agentStatus.ts` (new): `AGENT_RULES` table and `AgentStatusTracker` (heuristic + reports; reports win; input clears needs-you; quiet 3 s gives done).
- `src/main/terminalHost.ts`: a tracker per terminal, `input` / `resized` / `seen` / `report` / `statuses`, 1 s tick, `dispose()`, `TermInfo.status`.
- `src/main/mcp.ts`: `POST /status` (same token/Host/Origin checks, always empty body), `X-Terminals-Term` header, `McpInfo.statusUrl`.
- `src/main/mcpTools.ts`: `report_status` tool; `list_terminals` includes status.
- `src/main/claudeHooks.ts` (new): writes `<userData>\status-hook.cmd`, installs/removes hooks in `~/.claude/settings.json` (or `%CLAUDE_CONFIG_DIR%`) with a `.terminals-backup` copy; refuses invalid JSON.
- `src/main/index.ts`: per-pty `TERMINALS_TERM_ID` / `TERMINALS_STATUS_URL`, input/resize forwarding, `term:*` and `hooks:*` IPC, script refresh at start when installed.
- `src/preload/index.ts`: `onTermStatus`, `getTermStatuses`, `termSeen`, `getClaudeHooks`, `installClaudeHooks`, `removeClaudeHooks`.
- `src/renderer/src/App.tsx`: status state and subscription, seen logic, `tabStatus` / `agentByLoc` memos, rail dots, title-change and rename handlers.
- `src/renderer/src/TabBar.tsx`: status indicator and tooltip, inline rename (double-click), tab context menu (Rename, Use terminal title, Close).
- `src/renderer/src/Sidebar.tsx`: `agent` prop, row indicator with group roll-up, Activity "Needs you (N)" section.
- `src/renderer/src/termRegistry.ts`: `onTitle` hook from xterm `onTitleChange`.
- `src/renderer/src/SettingsDialog.tsx`: "Agent status" section (heuristic toggle, Claude Code hooks Install/Remove/Copy JSON).
- `src/renderer/src/styles.css`: indicator, pill, pulse (reduced-motion aware), Needs-you section, rail status dots, rename input.
- `src/main/smoke.ts`: `checkAgentStatus`; `checkMcpHttp` extended (/status, report_status, real hook script); `checkSession` extended (userTitle).
- `README.md`: Agent status and Claude Code hooks sections, `/status`, tools/env tables, registration header, security, session restore, keyboard table.

### Deviations

- Copy JSON uses `getClaudeHooks().config`; no separate `claudeHooksJson` preload method.
- TabBar takes an extra `statusSource` prop for the tooltip source.
- Hook-script smoke test uses async `spawn` (spawnSync blocks the in-process server).
- `/status` also returns 405 (non-POST) and 404 when no host exists.
- "Use terminal title" without a captured auto title keeps the current title; `userTitle` is restored for shell tabs only.
- Install button reads "Reinstall" when installed.

### Verification

- `yarn typecheck`: exit 0.
- `yarn smoke`: exit 0, 19 PASS lines, no FAIL.
- Not run: A10-A15 manual real-app checks (UNTESTED).

### Follow-ups

- See `discoveries.md` (Reset tooltip text, command-tab rename persistence).

Commit status: committed on `feat/herdr-agent-workflow` (see git log).
