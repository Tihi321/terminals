/** Pure helpers shared by main and the renderer for elevated (administrator) tabs. */

import type { Command } from './types'

export const GSUDO_HINT = 'winget install gerardog.gsudo'

/** Built-in one-step command that installs gsudo in a normal tab of the selected folder. */
export const INSTALL_GSUDO_COMMAND: Command = {
  id: 'builtin:install-gsudo',
  name: 'Install gsudo',
  ownerId: 'global',
  mode: 'sequential',
  targets: [{ cwd: '', steps: [GSUDO_HINT] }]
}

/** True when an elevated shell exit looks like a cancelled or failed elevation (999 gsudo, 1223 ERROR_CANCELLED, or a fast non-zero exit). */
export function elevationFailed(code: number, msSinceStart: number): boolean {
  return code === 999 || code === 1223 || (code !== 0 && msSinceStart < 4000)
}
