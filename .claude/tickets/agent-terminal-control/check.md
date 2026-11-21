# Check round 1 — VERDICT: FAIL

Checker: director-checker (deep/high), commit a1e8d97, 2026-11-21. Saved by the director from the checker's report (the checker is read-only).

Automated: both typechecks exit 0; electron-vite build exit 0; smoke 16 PASS / 0 FAIL (exit 0).

Acceptance: 1-9 PASS, 17 PASS; 10-16 UNTESTED (manual, real app). Code reading supports all of them, and the checker saw no defect that would block one.

Requirement R1 FAIL (partial): `exit N` is misreported. All other requirements PASS.

## Security

- Every gated call reads the toggle.
- Write tools refuse user-opened and elevated tabs.
- MCP cannot spawn an elevated terminal.
- `pty:attach` checks the owner.
- The end marker can only be forged by code already running inside the agent's own command. This is acceptable.
- Residual risk: an agent shell can run gsudo, and with gsudo's credential cache on, that elevates without UAC. Consider a README line.

## Defects to fix

1. terminalHost.ts:394-397 with termText.ts:91-99: a top-level `exit N` gives exitCode 1 and exited:false. The contract says exited:true with the real exit code.
2. TerminalView.tsx:58-59 and 80-81: raw ESC bytes and a bare LF replaced the escaped `\x1b[31m...\x1b[0m\r\n` (a regression of "Failed to start").
3. index.ts:118-119: `killPtysOf` returns early and skips `host.forgetOwner` and the `hosted` cleanup. Exited records leak after a renderer reload.

## Nits

- Sidebar.tsx:427-428: the title template has a literal newline.
- CommandEditor.tsx:54: a Home-scoped command is labelled "Only home".
- `send_input`: `sent` does not count the appended `\r`.
- termText.ts:98: the end marker depends on the global `$__tr`, so `Remove-Variable` breaks it.
- A renderer reply that arrives after the 5 s timeout leaves a dead "Failed to attach" tab.
- An 8000-character command becomes a typed base64 line of about 44K characters. This is a documented limit.
- `TERMINALS_LOC_PATH` for a Home agent tab opened in another directory is the Home path.

Polish round 1 scope: defects 1-3, plus the Sidebar newline nit and the `$__tr` marker robustness nit.

# Check round 2 (delta a1e8d97..e0ad627) — VERDICT: PASS

The checker re-checked the polish commit e0ad627, 2026-11-21.

- Defects 1-3 and both nits are fixed.
- Typechecks exit 0. Build exit 0. Smoke 16 PASS, exit 0, including the new `exit 5` check (exited, code 5).
- Regressions were probed in pwsh:
  - `throw`, `Write-Error` and native exit codes resolve with no delay.
  - Ctrl+C, `break` and a removed `$__tr` resolve with code 1 about 1.5 s later, and the shell stays alive.
  - A timeout or a remove during the wait is handled correctly.
- Line endings: nothing to do. The committed files are LF; the working tree is CRLF via `core.autocrlf`.
- Acceptance criteria 10-16 are still UNTESTED (manual, real app).

## Nits (not blocking)

1. terminalHost.ts:403-413: the end-wait does not clear the run's timeout timer. If the deadline falls inside the 1.5 s window, the result is `timedOut:true` with `exitCode:null`.
2. The 1.5 s wait is a guess: a slow pwsh exit falls back to `exitCode:1, exited:false`.
3. A top-level `break` or a removed `$__tr` resolves 1 after 1.5 s, although the shell is fine.
4. The README does not mention the ~1.5 s Ctrl+C delay or how `exit` is reported.

# Check round 3 (extras, delta e0ad627..980bd0f) — VERDICT: PASS

- All five extras match the spec: timeout timer fix, `wait_for_output`, `reveal`, ConciseView, README.
- Typechecks exit 0. Build exit 0. Smoke 16 PASS, exit 0. No regressions; the default no-focus path is unchanged.
- No must-fix defects.

## Nits (not blocking)

1. `wait_for_output` regex. A user regex runs on every chunk over up to 64 KiB, so a bad regex could freeze the app (ReDoS). There is no cap on waiters, and each chunk re-runs `toLines` over the whole buffer. Suggestions: cap line length and waiter count, and scan from the last newline.
2. `wait_for_output` can match the echo of text the agent typed. Worth a README line.
3. Regexes take no flags, so there is no case-insensitive option.
4. A run always restores `$ErrorView`, so a user's own change to it is lost. In a contrived case, a read-only `ErrorView` plus `ErrorActionPreference=Stop` could skip the end marker. Fix: write the marker first, or try-wrap the restore.
5. README: after Ctrl+C, what clears ~1.5 s late is `busy`; the `run_command` call itself has already returned.
