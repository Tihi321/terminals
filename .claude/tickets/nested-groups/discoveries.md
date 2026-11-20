- 2026-11-20 implement: `.group-empty` keeps a hard-coded 50px left padding that is now always overridden inline per depth (src/renderer/src/styles.css:535) - suggested: drop the padding-left from the CSS rule

## From checker
- 2026-11-20 director-checker: the note above is wrong, the standalone placeholder in Sidebar.tsx:706 relies on this padding-left (src/renderer/src/styles.css:535) - suggested: keep the padding and correct the note
- 2026-11-20 director-checker: an Explorer drop on a nested parent-kind group bubbles to the enclosing manual group, and the comment there is stale (src/renderer/src/Sidebar.tsx:459-473) - suggested: fix the stale comment and decide the intended drop target
- 2026-11-20 director-checker: smoke has no self-parent case in migrate (src/main/smoke.ts) - suggested: add a self-parent case
- 2026-11-20 director-checker: smoke has no child: selection fallback case (src/main/smoke.ts) - suggested: add a selection fallback case
- 2026-11-20 director-checker: smoke has no parent group on a sub-path case (src/main/smoke.ts) - suggested: add a sub-path case
