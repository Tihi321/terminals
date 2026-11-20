// Keeps keyboard focus in the sidebar tree after a row click, so Alt+Shift+Left/Right nest the selected item.
// Selecting a row makes TerminalView focus the terminal in a later frame; it asks here first.
let clickedAt = 0

/** Call when the user clicks inside the sidebar tree. */
export function markSidebarClick(): void {
  clickedAt = performance.now()
}

/** True while the sidebar tree holds focus because of a very recent click: a terminal must not steal it. */
export function sidebarKeepsFocus(): boolean {
  if (performance.now() - clickedAt > 800) return false
  return !!document.activeElement?.closest('.tree')
}
