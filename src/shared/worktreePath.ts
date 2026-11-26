/** Pure path rule for new worktrees (no Node imports, so the renderer dialog can preview it). Paths use `\` joins. */

/** Branch name -> a single folder name: path separators, Windows-reserved characters and whitespace become `-`. */
export function safeDirName(branch: string): string {
  return branch
    .replace(/[/\\<>:"|?*\s]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

const split = (p: string): { dir: string; name: string } => {
  const t = p.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'))
  return { dir: i < 0 ? '' : t.slice(0, i), name: t.slice(i + 1) }
}

/**
 * Where a worktree for `branch` of `repo` goes. container: `<repo parent>\<repo>.worktrees\<branch>`;
 * sibling: `<repo parent>\<repo>-<branch>`. Returns '' when the branch yields no usable folder name.
 */
export function worktreeTargetPath(repo: string, branch: string, layout: 'container' | 'sibling'): string {
  const safe = safeDirName(branch)
  if (!safe) return ''
  const { dir, name } = split(repo)
  const join = (a: string, b: string): string => (a ? `${a}\\${b}` : b)
  return layout === 'sibling' ? join(dir, `${name}-${safe}`) : join(join(dir, `${name}.worktrees`), safe)
}
