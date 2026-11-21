## A-001 Pick extra ideas to build (or none), and run manual acceptance checks 10-16 in the real app
- status: answered
- asked: 2026-11-21 --:--
- by: director
- why: re-check PASS on polish commit e0ad627; the extra ideas need the user's decision and checks 10-16 are untested
- default: no extra ideas built; manual checks 10-16 stay UNTESTED in the Outcome
- answer: User picked all four extras: re-check small fixes (timeout timer + README notes incl. gsudo), wait_for_output tool, reveal option on open_terminal, cleaner pwsh 7 errors (ConciseView). User will run manual checks 10-16 from a checklist with an unpacked exe (yarn dist:dir). (2026-11-21 --:--)

## A-002 Run manual-checklist.md against release/win-unpacked/Terminals.exe (980bd0f) and report pass/fail for checks 10-16 and extras A-C
- status: open
- asked: 2026-11-21 --:--
- by: director
- why: checks 10-16 and extras A-C are untested in the real app; the exe is built and the checklist is written
- default: checks 10-16 stay UNTESTED in the Outcome
- answer:
