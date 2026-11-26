import type { JSX } from 'react'
import { Code, Copy, FolderOpen, GitBranch, SquareTerminal, Terminal, Trash2, PanelRight } from 'lucide-react'
import type { WorktreeView } from '../../shared/types'
import type { StatusRollup } from '../../shared/agentStatus'
import type { MenuItem } from './ContextMenu'
import type { Finished, RowProps } from './Sidebar'

/** A repo row's own id plus the ids of its worktrees (for working / status / finished roll-ups). */
export function withWorktrees(id: string, worktrees: WorktreeView[]): string[] {
  return [id, ...worktrees.map((w) => w.id)]
}

/** Worktree rows listed under their repo row: one selectable location per linked worktree. */
export function WorktreeRows(p: {
  worktrees: WorktreeView[]
  indent: number
  selectedId: string | null
  counts: Record<string, number>
  finished: Record<string, Finished>
  agent: Record<string, StatusRollup>
  RowComponent: (r: RowProps) => JSX.Element
  onSelect: (id: string) => void
  onOpenTerminal: (id: string) => void
  onOpenToSide: (id: string) => void
  canOpenToSide: (id: string) => boolean
  onOpenExplorer: (path: string) => void
  onOpenEditor: (path: string) => void
  onOpenWt: (path: string) => void
  onCopy: (text: string) => void
  onCloseFinished: (locIds: string[]) => void
  onRemove: (wt: WorktreeView) => void
  openMenu: (e: React.MouseEvent, items: MenuItem[]) => void
}): JSX.Element {
  const { RowComponent: Row } = p
  const menu = (w: WorktreeView): MenuItem[] => [
    { label: 'Open terminal', icon: <Terminal size={14} />, disabled: w.missing, onClick: () => p.onOpenTerminal(w.id) },
    { label: 'Open to the side', icon: <PanelRight size={14} />, disabled: w.missing || !p.canOpenToSide(w.id), onClick: () => p.onOpenToSide(w.id) },
    { label: 'Open in Windows Terminal', icon: <SquareTerminal size={14} />, disabled: w.missing, onClick: () => p.onOpenWt(w.path) },
    { label: 'Open in Explorer', icon: <FolderOpen size={14} />, disabled: w.missing, onClick: () => p.onOpenExplorer(w.path) },
    { label: 'Open in editor', icon: <Code size={14} />, disabled: w.missing, onClick: () => p.onOpenEditor(w.path) },
    { label: 'Copy path', icon: <Copy size={14} />, onClick: () => p.onCopy(w.path) },
    { separator: true },
    { label: 'Remove worktree…', icon: <Trash2 size={14} />, danger: true, onClick: () => p.onRemove(w) }
  ]
  return (
    <>
      {p.worktrees.map((w) => (
        <Row
          key={w.id}
          indent={p.indent}
          icon={<GitBranch size={16} />}
          name={w.name}
          subtitle={w.missing ? 'Folder not found' : w.branch}
          subKind={w.missing ? 'missing' : 'branch'}
          title={w.missing ? `${w.path}\n(folder not found on disk)` : `${w.path}${w.locked ? '\n(locked)' : ''}`}
          selected={w.id === p.selectedId}
          locId={w.id}
          missing={w.missing}
          dim={w.missing}
          count={p.counts[w.id] ?? 0}
          finished={p.finished[w.id]}
          agent={p.agent[w.id]}
          onCloseFinished={() => p.onCloseFinished([w.id])}
          onClick={() => p.onSelect(w.id)}
          onContext={(e) => p.openMenu(e, menu(w))}
          actions={
            <button className="icon-btn" title="New terminal" disabled={w.missing} onClick={() => p.onOpenTerminal(w.id)}>
              <Terminal size={14} />
            </button>
          }
        />
      ))}
    </>
  )
}
