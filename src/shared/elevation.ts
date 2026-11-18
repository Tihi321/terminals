/** Pure helpers shared by main and the renderer for elevated (administrator) tabs. */

export const GSUDO_HINT = 'winget install gerardog.gsudo'

/** True when an elevated shell exit looks like a cancelled or failed elevation (999 gsudo, 1223 ERROR_CANCELLED, or a fast non-zero exit). */
export function elevationFailed(code: number, msSinceStart: number): boolean {
  return code === 999 || code === 1223 || (code !== 0 && msSinceStart < 4000)
}
