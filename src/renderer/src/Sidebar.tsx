import { useRef, useState } from 'react'
import { markSidebarClick } from './sidebarFocus'
import type { JSX, ReactNode } from 'react'
import {
  PanelRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Activity,
  Check,
  Eye,
  EyeOff,
  Folder as FolderIcon,
  FolderGit2,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  FolderTree,
  FolderX,
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  GitBranch,
  Group,
  House,
  TriangleAlert,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Settings as SettingsIcon,
  SquareArrowOutUpRight,
  SquareTerminal,
  Code,
  Terminal,
  Trash2
} from 'lucide-react'
import type { AppState, ChildView, CopyResult, FolderView, GroupView } from '../../shared/types'
import { HOME_ID } from '../../shared/types'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { LOC_DRAG_TYPE, locDrag } from './TabBar'
import { childGroups, nestError, nestTarget, removalSet, subtreeGroupIds } from '../../shared/groupTree'
import { rollupStatus } from '../../shared/agentStatus'
import type { StatusRollup } from '../../shared/agentStatus'

/** Tabs that have finished (command done, shell exited) but are still open, per location or rolled up. */
export interface Finished {
  total: number
  failed: number
  ok: number
  items: string[]
}

function mergeFinished(a: Finished | undefined, b: Finished | undefined): Finished | undefined {
  if (!a) return b
  if (!b) return a
  return { total: a.total + b.total, failed: a.failed + b.failed, ok: a.ok + b.ok, items: [...a.items, ...b.items] }
}

function finishedTitle(f: Finished): string {
  const shown = f.items.slice(0, 4).join(', ')
  return `${f.total} finished ${f.total === 1 ? 'tab' : 'tabs'} still open: ${shown}${f.items.length > 4 ? ', …' : ''}
Middle-click to close finished tabs`
}

function agentTitle(a: StatusRollup): string {
  const shown = a.items.slice(0, 6).join('\n')
  return `Agent status\n${shown}${a.items.length > 6 ? '\n…' : ''}`
}

interface Props {
  state: AppState
  counts: Record<string, number>
  finished: Record<string, Finished>
  /** Agent status roll-up per location (non-idle tabs only). */
  agent: Record<string, StatusRollup>
  /** Working tabs (running commands) per location. */
  working: Record<string, number>
  groupBy: 'none' | 'activity'
  idleCollapsed: boolean
  /** Groups whose "Idle (N)" sub-row is expanded. */
  idleOpen: string[]
  onSetGroupBy: (mode: 'none' | 'activity') => void
  onSetIdleCollapsed: (collapsed: boolean) => void
  onSetIdleOpen: (ids: string[]) => void
  /** Close the finished tabs (command done, shell exited) of these locations. */
  onCloseFinished: (locIds: string[]) => void
  onSelect: (id: string) => void
  /** Move (up/down among siblings) or nest (into group above / out of group) a folder or group. */
  onNestMove: (id: string, op: 'move' | 'nest', dir: -1 | 1) => void
  onOpenTerminal: (id: string) => void
  /** Show this location in a pane next to the focused one (or focus its pane when it already has one). */
  onOpenToSide: (id: string) => void
  canOpenToSide: (id: string) => boolean
  onAddFolder: () => void
  onAddParent: () => void
  onAddGroup: (name: string, parentId?: string | null) => void
  onMoveGroup: (id: string, parentId: string | null) => void
  onRemoveFolder: (id: string) => void
  onRemoveGroup: (id: string) => void
  onRenameFolder: (id: string, name: string) => void
  onRenameGroup: (id: string, name: string) => void
  onMoveFolder: (id: string, groupId: string | null, beforeId?: string) => void
  /** Folders dragged in from the OS (Explorer). */
  onDropPaths: (paths: string[], groupId: string | null, beforeId?: string) => void
  /** Opens the folder picker and stores the choice as the group's folder. Resolves to the chosen path or null. */
  onPickGroupFolder: (id: string) => Promise<string | null>
  onClearGroupFolder: (id: string) => void
  /** Creates `name` in `parentDir` (and saves it in manual group `groupId`). Resolves to an error message, or null on success. */
  onCreateFolder: (parentDir: string, name: string, groupId: string | null) => Promise<string | null>
  /** Copies dropped OS files/folders into a folder on disk. */
  onCopyInto: (paths: string[], destDir: string) => Promise<CopyResult>
  onSetPinned: (id: string, pinned: boolean) => void
  onToggleCollapse: (id: string, collapsed: boolean) => void
  onToggleShowHidden: (id: string, show: boolean) => void
  onHideChild: (groupId: string, path: string, hidden: boolean) => void
  onRefresh: () => void
  onOpenWt: (path: string) => void
  onOpenExplorer: (path: string) => void
  onOpenEditor: (path: string) => void
  onCopy: (text: string) => void
  onOpenSettings: () => void
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

interface RowProps {
  /** Location this row stands for; makes the row draggable onto a pane edge. */
  locId?: string
  indent: number
  icon: ReactNode
  name: string
  subtitle?: string | null
  /** How the subtitle is drawn: a git branch, a path, a missing-folder warning or plain text. */
  subKind?: 'branch' | 'path' | 'missing' | 'text'
  /** Group header row (manual or parent group). */
  group?: boolean
  title: string
  selected: boolean
  missing?: boolean
  dim?: boolean
  pinned?: boolean
  count: number
  finished?: Finished
  agent?: StatusRollup
  /** Middle-click: close the finished tabs this row's dot counts. */
  onCloseFinished?: () => void
  dropActive?: boolean
  /** Highlighted as a target for copying dragged files into this folder. */
  copyActive?: boolean
  editing?: boolean
  draft?: string
  onDraft?: (v: string) => void
  onCommit?: () => void
  onCancel?: () => void
  onClick: () => void
  onContext: (e: React.MouseEvent) => void
  onDoubleClick?: () => void
  actions?: ReactNode
  drag?: {
    onDragStart: () => void
    onDragEnd: () => void
    onDragOver?: (e: React.DragEvent) => void
    onDragLeave?: () => void
    onDrop?: (e: React.DragEvent) => void
  }
  chevron?: ReactNode
}

function Row(r: RowProps): JSX.Element {
  return (
    <div
      className={[
        'row',
        r.group ? 'group-row' : '',
        r.selected ? 'selected' : '',
        r.missing ? 'missing' : '',
        r.dim ? 'dim' : '',
        r.dropActive ? 'drag-over' : '',
        r.copyActive ? 'copy-target' : ''
      ].join(' ')}
      style={{ paddingLeft: 8 + r.indent * 18 }}
      title={r.title}
      draggable={(!!r.drag || !!r.locId) && !r.editing}
      onClick={r.onClick}
      onMouseDown={(e) => {
        // Stop Windows autoscroll from starting on middle-click.
        if (e.button === 1 && r.onCloseFinished) e.preventDefault()
      }}
      onAuxClick={(e) => {
        if (e.button !== 1 || !r.onCloseFinished) return
        e.preventDefault()
        if (r.finished && r.finished.total > 0) r.onCloseFinished()
      }}
      onContextMenu={r.onContext}
      onDragStart={(e) => {
        r.drag?.onDragStart()
        if (r.locId) {
          locDrag.id = r.locId
          e.dataTransfer.setData(LOC_DRAG_TYPE, r.locId)
          e.dataTransfer.effectAllowed = 'copyMove'
        }
      }}
      onDragEnd={() => {
        locDrag.id = null
        r.drag?.onDragEnd()
      }}
      onDragOver={r.drag?.onDragOver}
      onDragLeave={r.drag?.onDragLeave}
      onDrop={r.drag?.onDrop}
    >
      <span className="row-chevron">{r.chevron}</span>
      <span className="row-icon">{r.icon}</span>
      <div className="row-main">
        {r.editing ? (
          <input
            className="rename-input"
            autoFocus
            value={r.draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => r.onDraft?.(e.target.value)}
            onBlur={r.onCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') r.onCommit?.()
              if (e.key === 'Escape') r.onCancel?.()
            }}
          />
        ) : (
          <div
            className="row-name"
            onMouseDown={(e) => {
              if (e.detail > 1 && r.onDoubleClick) e.preventDefault()
            }}
            onDoubleClick={
              r.onDoubleClick
                ? (e) => {
                    e.stopPropagation()
                    r.onDoubleClick?.()
                  }
                : undefined
            }
          >
            {r.name}
            {r.pinned && <Pin size={11} strokeWidth={2.25} className="row-pin" />}
          </div>
        )}
        {r.subtitle && !r.editing && (
          <div className={`row-sub ${r.subKind ?? 'text'}`}>
            {r.subKind === 'branch' && <GitBranch size={11} strokeWidth={2.25} />}
            {r.subKind === 'missing' && <TriangleAlert size={11} strokeWidth={2.25} />}
            <span>{r.subtitle}</span>
          </div>
        )}
      </div>
      {r.agent && r.agent.top && (
        <span className={`agent-ind ${r.agent.top}`} title={agentTitle(r.agent)}>
          {r.agent.top === 'needs-you' ? '!' : null}
        </span>
      )}
      {r.finished && r.finished.total > 0 && (
        <span
          className={`fin-dot ${r.finished.failed > 0 ? 'failed' : r.finished.ok > 0 ? 'success' : 'neutral'}`}
          title={finishedTitle(r.finished)}
        />
      )}
      {r.count > 0 && <span className="badge">{r.count}</span>}
      {r.actions && (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          {r.actions}
        </div>
      )}
    </div>
  )
}

export function Sidebar(p: Props): JSX.Element {
  const { state } = p
  const [editing, setEditing] = useState<{ kind: 'folder' | 'group'; id: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState<{ parentId: string | null; name: string } | null>(null)
  /** Inline "New folder" input under group `groupId`; `dir` is the folder it will be created in. */
  const [newFolder, setNewFolder] = useState<{ groupId: string; dir: string; name: string; error: string | null } | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showNote = (text: string, error: boolean): void => {
    clearTimeout(noteTimer.current)
    setNote({ text, error })
    noteTimer.current = setTimeout(() => setNote(null), error ? 8000 : 4000)
  }
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const dragId = useRef<string | null>(null)
  /** Id of the group header being dragged (nest / un-nest); separate from dragId so folder handlers ignore it. */
  const dragGroupId = useRef<string | null>(null)

  const folders = state.folders
  const pinnedIds = state.pinned ?? []
  const isPinned = (id: string): boolean => pinnedIds.includes(id)
  /** Pinned items in the order they were pinned. */
  type PinnedItem = { kind: 'folder'; f: FolderView } | { kind: 'group'; g: GroupView }
  const pinnedItems = pinnedIds.flatMap((id): PinnedItem[] => {
    const f = folders.find((x) => x.id === id)
    if (f) return [{ kind: 'folder', f }]
    const g = state.groups.find((x) => x.id === id)
    return g ? [{ kind: 'group', g }] : []
  })
  // A pinned standalone folder / top-level group is moved into Pinned; items nested in a group stay in place too.
  const standalone = folders.filter((f) => !f.groupId && !isPinned(f.id))
  const pinItem = (id: string): MenuItem =>
    isPinned(id)
      ? { label: 'Unpin', icon: <PinOff size={14} />, onClick: () => p.onSetPinned(id, false) }
      : { label: 'Pin to top', icon: <Pin size={14} />, onClick: () => p.onSetPinned(id, true) }
  const membersOf = (gid: string): FolderView[] => folders.filter((f) => f.groupId === gid)

  // Group by: Activity. "Working" = a location with an open shell or a running command (see isWorkingTab in App.tsx).
  const activity = p.groupBy === 'activity'
  const isWorking = (id: string): boolean => (p.working[id] ?? 0) > 0
  /** A group is working when it, or any folder/child in its subtree, has a working tab. */
  const groupWorking = (g: GroupView): boolean =>
    subtreeGroupIds(state.groups, g.id).some((gid) => {
      const x = state.groups.find((y) => y.id === gid)
      if (!x) return false
      return isWorking(x.id) || (x.kind === 'manual' ? membersOf(x.id) : x.children).some((c) => isWorking(c.id))
    })
  /** True when the selected location is this group or anything in its subtree (keeps the selection visible in Activity mode). */
  const groupHasSelected = (g: GroupView): boolean =>
    state.selectedId !== null &&
    subtreeGroupIds(state.groups, g.id).some((gid) => {
      const x = state.groups.find((y) => y.id === gid)
      if (!x) return false
      return x.id === state.selectedId || (x.kind === 'manual' ? membersOf(x.id) : x.children).some((c) => c.id === state.selectedId)
    })
  /** Agent status of a group: its own and its members' roll-ups, through the whole subtree (same walk as `finished`). */
  const groupAgent = (g: GroupView): StatusRollup | undefined =>
    subtreeGroupIds(state.groups, g.id).reduce<StatusRollup | undefined>((sum, gid) => {
      const x = state.groups.find((y) => y.id === gid)
      if (!x) return sum
      const kids = x.kind === 'manual' ? membersOf(x.id) : x.children
      return kids.reduce((s, c) => rollupStatus(s, p.agent[c.id]), rollupStatus(sum, p.agent[x.id]))
    }, undefined)
  const needsYou = (a: StatusRollup | undefined): boolean => (a?.needsYou ?? 0) > 0
  const idleIsOpen =(gid: string): boolean => p.idleOpen.includes(gid)
  const toggleIdleOpen = (gid: string): void =>
    p.onSetIdleOpen(idleIsOpen(gid) ? p.idleOpen.filter((x) => x !== gid) : [...p.idleOpen, gid])

  const startRename = (kind: 'folder' | 'group', id: string, name: string): void => {
    setDraft(name)
    setEditing({ kind, id })
  }
  const commitRename = (): void => {
    if (!editing) return
    if (editing.kind === 'folder') p.onRenameFolder(editing.id, draft)
    else p.onRenameGroup(editing.id, draft)
    setEditing(null)
  }
  const isEditing = (kind: 'folder' | 'group', id: string): boolean => editing?.kind === kind && editing.id === id

  const openMenu = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const sideItem = (id: string, missing: boolean): MenuItem => ({
    label: 'Open to the side',
    icon: <PanelRight size={14} />,
    disabled: missing || !p.canOpenToSide(id),
    onClick: () => p.onOpenToSide(id)
  })

  const pathItems = (id: string, path: string, missing: boolean): MenuItem[] => [
    { label: 'Open terminal', icon: <Terminal size={14} />, disabled: missing, onClick: () => p.onOpenTerminal(id) },
    sideItem(id, missing),
    { label: 'Open in Windows Terminal', icon: <SquareTerminal size={14} />, disabled: missing, onClick: () => p.onOpenWt(path) },
    { label: 'Open in Explorer', icon: <FolderOpen size={14} />, disabled: missing, onClick: () => p.onOpenExplorer(path) },
    { label: 'Open in editor', icon: <Code size={14} />, disabled: missing, onClick: () => p.onOpenEditor(path) }
  ]

  /** Move up/down/into group above/out of group, each only when it would do something (same rules as the shortcuts). */
  const arrangeItems = (id: string): MenuItem[] => {
    const folders = state.folders
    const idx = (dir: -1 | 1): boolean => {
      const f = folders.find((x) => x.id === id)
      const gs = state.groups
      const sibs = f
        ? folders.filter((x) => (x.groupId && gs.some((g) => g.id === x.groupId) ? x.groupId : null) === (f.groupId && gs.some((g) => g.id === f.groupId) ? f.groupId : null))
        : (() => {
            const me = gs.find((g) => g.id === id)
            return childGroups(gs, me?.parentId && gs.some((g) => g.id === me.parentId) ? me.parentId : null)
          })()
      const i = sibs.findIndex((x) => x.id === id)
      return i >= 0 && !!sibs[i + dir]
    }
    const items: MenuItem[] = []
    // Reordering is disabled in Activity mode: the visible order is sectioned, so up/down would be misleading.
    if (!activity && idx(-1)) items.push({ label: 'Move up', icon: <ArrowUp size={14} />, hint: 'Alt+Shift+Up', onClick: () => p.onNestMove(id, 'move', -1) })
    if (!activity && idx(1)) items.push({ label: 'Move down', icon: <ArrowDown size={14} />, hint: 'Alt+Shift+Down', onClick: () => p.onNestMove(id, 'move', 1) })
    if (nestTarget(state.groups, state.folders, id, 1) !== undefined)
      items.push({ label: 'Move into group above', icon: <ArrowRightToLine size={14} />, hint: 'Alt+Shift+Right', onClick: () => p.onNestMove(id, 'nest', 1) })
    if (nestTarget(state.groups, state.folders, id, -1) !== undefined)
      items.push({ label: 'Move out of group', icon: <ArrowLeftToLine size={14} />, hint: 'Alt+Shift+Left', onClick: () => p.onNestMove(id, 'nest', -1) })
    return items
  }

  /**
   * One "Move to group" item with a submenu of the group tree (parents before children, depth-indented).
   * A non-target group with target descendants is shown disabled; branches without targets are left out.
   * Returns [] when there is no target at all.
   */
  const moveToGroupItems = (isTarget: (id: string) => boolean, onPick: (id: string) => void): MenuItem[] => {
    const walk = (parentId: string | null, depth: number, seen: Set<string>): MenuItem[] =>
      childGroups(state.groups, parentId).flatMap((g) => {
        if (seen.has(g.id)) return []
        seen.add(g.id)
        const kids = walk(g.id, depth + 1, seen)
        const target = g.kind === 'manual' && isTarget(g.id)
        if (!target && kids.length === 0) return []
        return [{ label: g.name, depth, disabled: !target, onClick: () => onPick(g.id) } as MenuItem, ...kids]
      })
    const submenu = walk(null, 0, new Set())
    return submenu.length ? [{ label: 'Move to group', icon: <FolderInput size={14} />, submenu }] : []
  }

  const folderMenu = (f: FolderView): MenuItem[] => {
    return [
      ...pathItems(f.id, f.path, f.missing),
      { separator: true },
      pinItem(f.id),
      { label: 'Rename', icon: <Pencil size={14} />, onClick: () => startRename('folder', f.id, f.name) },
      ...arrangeItems(f.id),
      ...moveToGroupItems((id) => id !== f.groupId, (id) => p.onMoveFolder(f.id, id)),
      ...(f.groupId
        ? [{ label: 'Remove from group', icon: <FolderMinus size={14} />, onClick: () => p.onMoveFolder(f.id, null) } as MenuItem]
        : []),
      { label: 'Copy path', icon: <Copy size={14} />, onClick: () => p.onCopy(f.path) },
      { separator: true },
      { label: 'Remove', icon: <Trash2 size={14} />, danger: true, onClick: () => p.onRemoveFolder(f.id) }
    ]
  }

  /** A group drop is valid when nesting is allowed and the target is not the group's current parent. */
  const canDropGroup = (gid: string, parentId: string | null): boolean =>
    (state.groups.find((x) => x.id === gid)?.parentId ?? null) !== parentId && nestError(state.groups, gid, parentId) === null

  const groupMenu = (g: GroupView): MenuItem[] => {
    const rename: MenuItem = { label: 'Rename', icon: <Pencil size={14} />, onClick: () => startRename('group', g.id, g.name) }
    const remove: MenuItem = {
      label: 'Remove group…',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => setConfirmRemove(g.id)
    }
    const moveItems: MenuItem[] = [
      ...arrangeItems(g.id),
      ...moveToGroupItems(
        (id) => id !== g.parentId && nestError(state.groups, g.id, id) === null,
        (id) => p.onMoveGroup(g.id, id)
      ),
      ...(g.parentId
        ? [{ label: 'Move to top level', icon: <FolderMinus size={14} />, onClick: () => p.onMoveGroup(g.id, null) } as MenuItem]
        : [])
    ]
    const startNewFolder = (dir: string): void => {
      if (g.collapsed) p.onToggleCollapse(g.id, false)
      setCreating(null)
      setNewFolder({ groupId: g.id, dir, name: '', error: null })
    }
    if (g.kind === 'manual') {
      const newFolderItem: MenuItem = {
        label: 'New folder…',
        icon: <FolderPlus size={14} />,
        // Without a group folder there is nowhere to create it: ask for the group folder first.
        hint: g.folder ? undefined : 'asks for a group folder',
        onClick: () => {
          if (g.folder) return startNewFolder(g.folder)
          void p.onPickGroupFolder(g.id).then((dir) => dir && startNewFolder(dir))
        }
      }
      const folderItems: MenuItem[] = g.folder
        ? [
            { label: 'Change group folder…', icon: <FolderInput size={14} />, onClick: () => void p.onPickGroupFolder(g.id) },
            { label: 'Clear group folder', icon: <FolderX size={14} />, onClick: () => p.onClearGroupFolder(g.id) }
          ]
        : [{ label: 'Set group folder…', icon: <FolderInput size={14} />, onClick: () => void p.onPickGroupFolder(g.id) }]
      const newSub: MenuItem = {
        label: 'New subgroup',
        icon: <FolderPlus size={14} />,
        onClick: () => {
          if (g.collapsed) p.onToggleCollapse(g.id, false)
          setCreating({ parentId: g.id, name: '' })
        }
      }
      return [sideItem(g.id, false), { separator: true }, pinItem(g.id), rename, newSub, newFolderItem, ...folderItems, ...moveItems, { separator: true }, remove]
    }
    const path = g.path as string
    return [
      ...pathItems(g.id, path, g.missing),
      { separator: true },
      { label: 'New folder…', icon: <FolderPlus size={14} />, disabled: g.missing, onClick: () => startNewFolder(path) },
      pinItem(g.id),
      rename,
      ...moveItems,
      { label: 'Refresh', icon: <RefreshCw size={14} />, onClick: p.onRefresh },
      {
        label: g.showHidden ? 'Hide hidden children' : `Show hidden children (${g.hiddenCount})`,
        icon: g.showHidden ? <EyeOff size={14} /> : <Eye size={14} />,
        onClick: () => p.onToggleShowHidden(g.id, !g.showHidden)
      },
      { label: 'Copy path', icon: <Copy size={14} />, onClick: () => p.onCopy(path) },
      { separator: true },
      remove
    ]
  }

  const childMenu = (g: GroupView, c: ChildView): MenuItem[] => [
    ...pathItems(c.id, c.path, false),
    { separator: true },
    c.hidden
      ? { label: 'Unhide', icon: <Eye size={14} />, onClick: () => p.onHideChild(g.id, c.path, false) }
      : { label: 'Hide', icon: <EyeOff size={14} />, onClick: () => p.onHideChild(g.id, c.path, true) },
    { label: 'Copy path', icon: <Copy size={14} />, onClick: () => p.onCopy(c.path) }
  ]

  /** True for a drag coming from the OS (Explorer), as opposed to the internal folder reorder. */
  const isOsDrag = (e: React.DragEvent): boolean => !dragId.current && !dragGroupId.current && e.dataTransfer.types.includes('Files')
  const osDrop = (e: React.DragEvent, groupId: string | null, beforeId?: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(null)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter(Boolean)
    if (paths.length > 0) p.onDropPaths(paths, groupId, beforeId)
  }

  /** Files/folders dropped ONTO a folder row are copied into that folder on disk (never added to the list). */
  const copyDrop = (e: React.DragEvent, destDir: string, label: string): void => {
    e.preventDefault()
    e.stopPropagation() // keep the enclosing group's onDrop from also adding them as saved folders
    setDragOver(null)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    void p.onCopyInto(paths, destDir).then((r) => {
      if (!r.ok) {
        console.warn('copy failed:', r.error)
        return showNote(`Copy to ${label} failed: ${r.error}`, true)
      }
      for (const f of r.failed) console.warn(`copy failed: ${f.name}: ${f.error}`)
      const n = r.copied.length
      const parts: string[] = []
      if (n > 0) parts.push(`Copied ${n} ${n === 1 ? 'item' : 'items'} to ${label}`)
      if (r.skipped.length > 0) parts.push(`${r.skipped.length} already in the folder`)
      if (r.failed.length > 0) parts.push(`${r.failed.length} failed: ${r.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`)
      if (parts.length > 0) showNote(parts.join('. '), r.failed.length > 0)
    })
  }
  /** Drag handlers that make a row an OS-file copy target (not for missing folders: those bubble to the group). */
  const copyTargetDrag = (id: string, path: string, label: string): { onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void } => ({
    onDragOver: (e) => {
      if (!isOsDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver('copy:' + id)
    },
    onDragLeave: () => setDragOver((d) => (d === 'copy:' + id ? null : d)),
    onDrop: (e) => copyDrop(e, path, label)
  })

  const drop = (target: FolderView, e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const from = dragId.current
    dragId.current = null
    setDragOver(null)
    if (from && from !== target.id) p.onMoveFolder(from, target.groupId, target.id)
  }

  const folderRow = (f: FolderView, indent: number): JSX.Element => {
    const osCopy = copyTargetDrag(f.id, f.path, f.name)
    return (
    <Row
      key={f.id}
      indent={indent}
      icon={f.missing ? <FolderX size={16} /> : f.isGit ? <FolderGit2 size={16} /> : <FolderIcon size={16} />}
      name={f.name}
      subtitle={f.missing ? 'Folder not found' : f.branch ? f.branch : f.path}
      subKind={f.missing ? 'missing' : f.branch ? 'branch' : 'path'}
      title={f.missing ? `${f.path}\n(folder not found on disk)` : f.path}
      selected={f.id === state.selectedId}
      locId={f.id}
      missing={f.missing}
      pinned={isPinned(f.id)}
      count={p.counts[f.id] ?? 0}
      finished={p.finished[f.id]}
      agent={p.agent[f.id]}
      onCloseFinished={() => p.onCloseFinished([f.id])}
      dropActive={dragOver === f.id}
      copyActive={dragOver === 'copy:' + f.id}
      editing={isEditing('folder', f.id)}
      draft={draft}
      onDraft={setDraft}
      onCommit={commitRename}
      onCancel={() => setEditing(null)}
      onClick={() => p.onSelect(f.id)}
      onContext={(e) => openMenu(e, folderMenu(f))}
      onDoubleClick={() => startRename('folder', f.id, f.name)}
      drag={{
        onDragStart: () => (dragId.current = f.id),
        onDragEnd: () => {
          dragId.current = null
          setDragOver(null)
        },
        onDragOver: (e) => {
          if (isOsDrag(e)) {
            if (!f.missing) osCopy.onDragOver(e)
          } else if (dragId.current && !activity) {
            // Reordering by dropping on a folder is off in Activity mode (the list is sectioned).
            e.preventDefault()
            e.stopPropagation()
            setDragOver(f.id)
          }
        },
        onDragLeave: () => {
          setDragOver((d) => (d === f.id ? null : d))
          osCopy.onDragLeave()
        },
        onDrop: (e) => (isOsDrag(e) ? (f.missing ? undefined : osCopy.onDrop(e)) : drop(f, e))
      }}
      actions={
        <button className="icon-btn" title="New terminal" disabled={f.missing} onClick={() => p.onOpenTerminal(f.id)}>
          <Terminal size={14} />
        </button>
      }
    />
    )
  }

  /** Pinned Home location: selectable, has its own tabs; cannot be renamed, removed, dragged or reordered. */
  const homeRow = (): JSX.Element => {
    const h = state.home
    return (
      <Row
        key={HOME_ID}
        indent={0}
        icon={<House size={16} />}
        name="Home"
        subtitle={h.missing ? 'Folder not found' : h.branch ? h.branch : h.path}
        subKind={h.missing ? 'missing' : h.branch ? 'branch' : 'path'}
        title={h.missing ? `${h.path}\n(folder not found on disk)` : h.path}
        selected={HOME_ID === state.selectedId}
        missing={h.missing}
        count={p.counts[HOME_ID] ?? 0}
        finished={p.finished[HOME_ID]}
        agent={p.agent[HOME_ID]}
        onCloseFinished={() => p.onCloseFinished([HOME_ID])}
        onClick={() => p.onSelect(HOME_ID)}
        onContext={(e) =>
          openMenu(e, [
            { label: 'Open terminal', icon: <Terminal size={14} />, disabled: h.missing, onClick: () => p.onOpenTerminal(HOME_ID) },
            { label: 'Open in Explorer', icon: <FolderOpen size={14} />, disabled: h.missing, onClick: () => p.onOpenExplorer(h.path) },
            { label: 'Copy path', icon: <Copy size={14} />, onClick: () => p.onCopy(h.path) }
          ])
        }
        actions={
          <button className="icon-btn" title="New terminal" disabled={h.missing} onClick={() => p.onOpenTerminal(HOME_ID)}>
            <Terminal size={14} />
          </button>
        }
      />
    )
  }

  const creatingRow = (depth: number): JSX.Element | null =>
    creating === null ? null : (
      <div className="row creating" style={{ paddingLeft: 8 + depth * 18 }}>
        <span className="row-chevron" />
        <span className="row-icon">
          <Group size={16} />
        </span>
        <input
          className="rename-input"
          autoFocus
          placeholder="Group name"
          value={creating.name}
          onChange={(e) => setCreating({ parentId: creating.parentId, name: e.target.value })}
          onBlur={() => setCreating(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && creating.name.trim()) {
              p.onAddGroup(creating.name, creating.parentId)
              setCreating(null)
            }
            if (e.key === 'Escape') setCreating(null)
          }}
        />
      </div>
    )

  const commitNewFolder = async (): Promise<void> => {
    const nf = newFolder
    if (!nf) return
    const err = await p.onCreateFolder(nf.dir, nf.name, state.groups.find((x) => x.id === nf.groupId)?.kind === 'manual' ? nf.groupId : null)
    if (err) setNewFolder((cur) => (cur ? { ...cur, error: err } : cur))
    else setNewFolder(null)
  }

  const newFolderRow = (depth: number): JSX.Element | null =>
    newFolder === null ? null : (
      <div className="row creating creating-folder" style={{ paddingLeft: 8 + depth * 18 }}>
        <span className="row-chevron" />
        <span className="row-icon">
          <FolderPlus size={16} />
        </span>
        <input
          className="rename-input"
          autoFocus
          placeholder="New folder name"
          title={`Created in ${newFolder.dir}`}
          value={newFolder.name}
          onChange={(e) => setNewFolder({ ...newFolder, name: e.target.value, error: null })}
          onBlur={() => setNewFolder(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitNewFolder()
            if (e.key === 'Escape') setNewFolder(null)
          }}
        />
        {newFolder.error && <div className="row-error">{newFolder.error}</div>}
      </div>
    )

  const confirmRow = (g: GroupView, depth: number): JSX.Element => {
    const { groupIds, folderIds } = removalSet(state.groups, state.folders, g.id)
    const n = groupIds.length - 1
    const m = folderIds.length
    return (
      <div
        className="row confirm-row"
        style={{ paddingLeft: 8 + depth * 18 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setConfirmRemove(null)
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setConfirmRemove(null)
        }}
      >
        <span className="confirm-text">
          {`Remove "${g.name}"${n > 0 ? `, ${n} ${n === 1 ? 'subgroup' : 'subgroups'}` : ''}${m > 0 ? `, ${m} ${m === 1 ? 'folder' : 'folders'}` : ''}? Nothing is deleted on disk.`}
        </span>
        <button
          className="btn small danger"
          autoFocus
          onClick={() => {
            setConfirmRemove(null)
            p.onRemoveGroup(g.id)
          }}
        >
          Remove
        </button>
        <button className="btn small" onClick={() => setConfirmRemove(null)}>
          Cancel
        </button>
      </div>
    )
  }

  const groupBlock = (g: GroupView, depth: number, seen: Set<string>): JSX.Element => {
    seen.add(g.id)
    const members = g.kind === 'manual' ? membersOf(g.id) : []
    const subgroups = g.kind === 'manual' ? childGroups(state.groups, g.id).filter((c) => !seen.has(c.id)) : []
    const visibleChildren = g.children.filter((c) => g.showHidden || !c.hidden)
    const count = subtreeGroupIds(state.groups, g.id).reduce((sum, gid) => {
      const x = state.groups.find((y) => y.id === gid)
      if (!x) return sum
      const own =
        x.kind === 'manual'
          ? membersOf(x.id).reduce((n, f) => n + (p.counts[f.id] ?? 0), 0)
          : x.children.reduce((n, c) => n + (p.counts[c.id] ?? 0), 0)
      return sum + (p.counts[x.id] ?? 0) + own
    }, 0)
    const finishedIds: string[] = []
    const finished = subtreeGroupIds(state.groups, g.id).reduce<Finished | undefined>((sum, gid) => {
      const x = state.groups.find((y) => y.id === gid)
      if (!x) return sum
      const kids = x.kind === 'manual' ? membersOf(x.id) : x.children
      finishedIds.push(x.id, ...kids.map((c) => c.id))
      return kids.reduce((s, c) => mergeFinished(s, p.finished[c.id]), mergeFinished(sum, p.finished[x.id]))
    }, undefined)
    const removal = removalSet(state.groups, state.folders, g.id)
    const total = removal.folderIds.length
    const subCount = removal.groupIds.length - 1
    const manualSubtitle = `${subCount > 0 ? `${subCount} ${subCount === 1 ? 'group' : 'groups'}, ` : ''}${total} ${total === 1 ? 'folder' : 'folders'}`
    const folderLabel = g.folder ? g.folder.split(/[\\/]/).filter(Boolean).pop() ?? g.folder : null
    // Child entries in their original order (subgroups, then member folders / discovered children), tagged for Activity grouping.
    const sel = state.selectedId
    const kids: { el: JSX.Element; working: boolean; sel: boolean }[] = g.collapsed ? [] : [
      ...subgroups.map((c) => ({ el: groupBlock(c, depth + 1, seen), working: groupWorking(c), sel: groupHasSelected(c) })),
      ...members.map((f) => ({ el: folderRow(f, depth + 1), working: isWorking(f.id), sel: f.id === sel })),
      ...(g.kind === 'parent' ? visibleChildren.map((c) => ({ el: childRow(g, c, depth), working: isWorking(c.id), sel: c.id === sel })) : [])
    ]
    const idleKids = kids.filter((k) => !k.working)
    // Expanded on request, or forced open while the selection sits inside it (not persisted).
    const idleOpen = idleIsOpen(g.id) || idleKids.some((k) => k.sel)
    const showEmpty = g.kind === 'manual' && members.length === 0 && subgroups.length === 0 && creating?.parentId !== g.id && newFolder?.groupId !== g.id
    return (
      <div
        key={g.id}
        className="group"
        // Manual groups accept folders dragged in from Explorer; a drop on a parent-kind group (also when nested)
        // bubbles to the enclosing manual group, or to the sidebar (standalone) when there is none.
        onDragOver={
          g.kind === 'manual'
            ? (e) => {
                if (isOsDrag(e)) {
                  e.preventDefault()
                  e.stopPropagation()
                  setDragOver(g.id)
                }
              }
            : undefined
        }
        onDragLeave={g.kind === 'manual' ? (e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragOver((d) => (d === g.id ? null : d)) : undefined}
        onDrop={g.kind === 'manual' ? (e) => isOsDrag(e) && osDrop(e, g.id) : undefined}
      >
        {confirmRemove === g.id ? (
          confirmRow(g, depth)
        ) : (
          <Row
            indent={depth}
            icon={g.kind === 'manual' ? <Group size={16} /> : <FolderTree size={16} />}
            name={g.name}
            subtitle={g.missing ? 'Folder not found' : g.kind === 'parent' ? g.branch ?? g.path : folderLabel ? `${manualSubtitle} · ${folderLabel}` : manualSubtitle}
            subKind={g.missing ? 'missing' : g.kind === 'parent' ? (g.branch ? 'branch' : 'path') : 'text'}
            group
            title={g.path ? (g.missing ? `${g.path}\n(folder not found on disk)` : g.path) : g.folder ? `${g.name}\nGroup folder: ${g.folder}` : g.name}
            selected={g.id === state.selectedId}
            locId={g.id}
            missing={g.missing}
            pinned={isPinned(g.id)}
            count={count}
            finished={finished}
            agent={groupAgent(g)}
            onCloseFinished={() => p.onCloseFinished(finishedIds)}
            dropActive={dragOver === g.id}
            editing={isEditing('group', g.id)}
            draft={draft}
            onDraft={setDraft}
            onCommit={commitRename}
            onCancel={() => setEditing(null)}
            chevron={
              <button
                className="icon-btn chevron"
                title={g.collapsed ? 'Expand' : 'Collapse'}
                onClick={(e) => {
                  e.stopPropagation()
                  p.onToggleCollapse(g.id, !g.collapsed)
                }}
              >
                {g.collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              </button>
            }
            onClick={() => p.onSelect(g.id)}
            onContext={(e) => openMenu(e, groupMenu(g))}
            onDoubleClick={() => p.onToggleCollapse(g.id, !g.collapsed)}
            drag={{
              onDragStart: () => (dragGroupId.current = g.id),
              onDragEnd: () => {
                dragGroupId.current = null
                setDragOver(null)
              },
              onDragOver:
                g.kind === 'manual'
                  ? (e) => {
                      if (dragId.current) {
                        e.preventDefault()
                        setDragOver(g.id)
                      } else if (dragGroupId.current && canDropGroup(dragGroupId.current, g.id)) {
                        e.preventDefault()
                        e.stopPropagation()
                        setDragOver(g.id)
                      }
                    }
                  : undefined,
              onDragLeave: g.kind === 'manual' ? () => setDragOver((d) => (d === g.id ? null : d)) : undefined,
              onDrop:
                g.kind === 'manual'
                  ? (e) => {
                      e.preventDefault()
                      setDragOver(null)
                      if (dragGroupId.current) {
                        e.stopPropagation()
                        const gid = dragGroupId.current
                        dragGroupId.current = null
                        if (canDropGroup(gid, g.id)) p.onMoveGroup(gid, g.id)
                        return
                      }
                      const from = dragId.current
                      dragId.current = null
                      if (from) p.onMoveFolder(from, g.id)
                    }
                  : undefined
            }}
            actions={
              g.kind === 'parent' ? (
                <>
                  <button className="icon-btn" title="Rescan subfolders" onClick={p.onRefresh}>
                    <RefreshCw size={14} />
                  </button>
                  <button
                    className={`icon-btn ${g.showHidden ? 'active' : ''}`}
                    title={g.showHidden ? 'Hide hidden children' : `Show hidden children (${g.hiddenCount})`}
                    onClick={() => p.onToggleShowHidden(g.id, !g.showHidden)}
                  >
                    {g.showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                  <button className="icon-btn" title="New terminal in parent folder" disabled={g.missing} onClick={() => p.onOpenTerminal(g.id)}>
                    <Terminal size={14} />
                  </button>
                </>
              ) : undefined
            }
          />
        )}
        {!g.collapsed && (
          <div className="group-children">
            {newFolder?.groupId === g.id && newFolderRow(depth + 1)}
            {g.kind === 'manual' && creating?.parentId === g.id && creatingRow(depth + 1)}
            {showEmpty && (
              <div className="group-empty" style={{ paddingLeft: 50 + depth * 18 }}>
                Drag folders or groups here or use "Move to group"
              </div>
            )}
            {g.kind === 'parent' && g.missing && (
              <div className="group-empty" style={{ paddingLeft: 50 + depth * 18 }}>
                Parent folder not found
              </div>
            )}
            {g.kind === 'parent' && !g.missing && visibleChildren.length === 0 && (
              <div className="group-empty" style={{ paddingLeft: 50 + depth * 18 }}>
                {g.hiddenCount > 0 ? 'All subfolders are hidden' : 'No subfolders'}
              </div>
            )}
            {activity ? (
              <>
                {kids.filter((k) => k.working).map((k) => k.el)}
                {idleKids.length > 0 && (
                  <div
                    className="row idle-row"
                    style={{ paddingLeft: 8 + (depth + 1) * 18 }}
                    title={idleOpen ? 'Hide idle entries' : 'Show idle entries'}
                    onClick={() => toggleIdleOpen(g.id)}
                    onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
                  >
                    <span className="row-chevron">{idleOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                    <div className="row-main">
                      <div className="row-name">Idle ({idleKids.length})</div>
                    </div>
                  </div>
                )}
                {idleOpen && idleKids.map((k) => k.el)}
              </>
            ) : (
              kids.map((k) => k.el)
            )}
          </div>
        )}
      </div>
    )
  }

  /** Row for a child folder of a parent-kind group. */
  const childRow = (g: GroupView, c: ChildView, depth: number): JSX.Element => (
    <Row
      key={c.id}
      indent={depth + 1}
      icon={c.isGit ? <FolderGit2 size={16} /> : <FolderIcon size={16} />}
      name={c.name}
      subtitle={c.hidden ? 'hidden' : c.isGit ? c.branch ?? 'git' : null}
      subKind={c.hidden ? 'text' : 'branch'}
      title={c.path}
      selected={c.id === state.selectedId}
      locId={c.id}
      dim={c.hidden}
      count={p.counts[c.id] ?? 0}
      finished={p.finished[c.id]}
      agent={p.agent[c.id]}
      onCloseFinished={() => p.onCloseFinished([c.id])}
      copyActive={dragOver === 'copy:' + c.id}
      drag={{ onDragStart: () => undefined, onDragEnd: () => setDragOver(null), ...copyTargetDrag(c.id, c.path, c.name) }}
      onClick={() => p.onSelect(c.id)}
      onContext={(e) => openMenu(e, childMenu(g, c))}
      actions={
        <>
          <button className="icon-btn" title="New terminal" onClick={() => p.onOpenTerminal(c.id)}>
            <Terminal size={14} />
          </button>
          <button
            className="icon-btn"
            title={c.hidden ? 'Unhide' : 'Hide from this group'}
            onClick={() => p.onHideChild(g.id, c.path, !c.hidden)}
          >
            {c.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        </>
      }
    />
  )

  const empty = state.groups.length === 0 && standalone.length === 0 && creating === null

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="section-title">Workspace</span>
        <div className="head-actions">
          <button className="icon-btn" onClick={p.onAddFolder} title="Add folder">
            <FolderPlus size={16} />
          </button>
          <button className="icon-btn" onClick={p.onAddParent} title="Add parent folder (auto-discovers subfolders)">
            <FolderTree size={16} />
          </button>
          <button className="icon-btn" onClick={() => setCreating({ parentId: null, name: '' })} title="New group">
            <Group size={16} />
          </button>
          <button
            className={`icon-btn ${activity ? 'active' : ''}`}
            title={`Group by: ${activity ? 'Activity' : 'None'}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({
                x: r.left,
                y: r.bottom + 4,
                items: [
                  { label: 'Group by: None', icon: !activity ? <Check size={14} /> : <span style={{ width: 14 }} />, onClick: () => p.onSetGroupBy('none') },
                  { label: 'Group by: Activity (working / idle)', icon: activity ? <Check size={14} /> : <span style={{ width: 14 }} />, onClick: () => p.onSetGroupBy('activity') }
                ]
              })
            }}
          >
            <Activity size={16} />
          </button>
          <button className="icon-btn" onClick={p.onRefresh} title="Rescan folders">
            <RefreshCw size={16} />
          </button>
          <button className="icon-btn" onClick={p.onOpenSettings} title="Settings (Ctrl+,)">
            <SettingsIcon size={16} />
          </button>
        </div>
      </div>
      <div
        className={dragOver === 'standalone' ? 'tree drop-active' : 'tree'}
        tabIndex={-1}
        onClick={(e) => {
          // Keep keyboard focus in the tree after a row click (the selected terminal would otherwise grab it).
          if ((e.target as HTMLElement).closest('input, textarea')) return
          markSidebarClick()
          if (!e.currentTarget.contains(document.activeElement)) e.currentTarget.focus({ preventScroll: true })
        }}
        onDragOver={(e) => {
          if (isOsDrag(e)) {
            e.preventDefault()
            setDragOver('standalone')
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver((d) => (d === 'standalone' ? null : d))
        }}
        onDrop={(e) => isOsDrag(e) && osDrop(e, null)}
      >
        {homeRow()}
        {creating?.parentId === null && creatingRow(0)}
        {empty && (
          <div className="sidebar-empty">
            <span className="empty-glyph">
              <FolderPlus size={18} />
            </span>
            <div className="empty-title">No folders yet</div>
            <div>Add a folder or a parent folder with the buttons above, or drag folders here from Explorer.</div>
          </div>
        )}
        {pinnedItems.length > 0 && (
          <div className="pinned">
            <div className="section-label">Pinned</div>
            {pinnedItems.map((it) => (it.kind === 'folder' ? folderRow(it.f, 0) : groupBlock(it.g, 0, new Set<string>())))}
          </div>
        )}
        {activity ? (
          (() => {
            // Top-level entries (unpinned groups, then standalone folders) split into WORKING and IDLE, original order kept.
            const seen = new Set<string>()
            const entries = [
              ...childGroups(state.groups, null)
                .filter((g) => !isPinned(g.id))
                .map((g) => ({ working: groupWorking(g), needs: needsYou(groupAgent(g)), sel: groupHasSelected(g), el: (): JSX.Element | null => (seen.has(g.id) ? null : groupBlock(g, 0, seen)) })),
              ...standalone.map((f) => ({ working: isWorking(f.id), needs: needsYou(p.agent[f.id]), sel: f.id === state.selectedId, el: (): JSX.Element | null => folderRow(f, 0) }))
            ]
            const needs = entries.filter((e) => e.needs)
            const work = entries.filter((e) => !e.needs && e.working)
            const idle = entries.filter((e) => !e.needs && !e.working)
            // The toggle always wins, even when the selection is inside: a forced-open section could never be collapsed.
            const idleShown = !p.idleCollapsed
            return (
              <div
                className="standalone"
                onDragOver={(e) => {
                  if (dragId.current || (dragGroupId.current && canDropGroup(dragGroupId.current, null))) {
                    e.preventDefault()
                    setDragOver('standalone')
                  }
                }}
                onDragLeave={() => setDragOver((d) => (d === 'standalone' ? null : d))}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(null)
                  if (dragGroupId.current) {
                    const gid = dragGroupId.current
                    dragGroupId.current = null
                    if (canDropGroup(gid, null)) p.onMoveGroup(gid, null)
                    return
                  }
                  const from = dragId.current
                  dragId.current = null
                  if (from) p.onMoveFolder(from, null)
                }}
              >
                {needs.length > 0 && (
                  <div className="activity-section needs-you">
                    <div className="section-label">Needs you ({needs.length})</div>
                    {needs.map((e) => e.el())}
                  </div>
                )}
                {work.length > 0 && (
                  <div className="activity-section working">
                    <div className="section-label">Working ({work.length})</div>
                    {work.map((e) => e.el())}
                  </div>
                )}
                {idle.length > 0 && (
                  <div className="activity-section idle">
                    <div
                      className="section-label section-toggle"
                      title={idleShown ? 'Hide idle entries' : 'Show idle entries'}
                      onClick={() => p.onSetIdleCollapsed(idleShown)}
                      onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
                    >
                      {idleShown ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <span>Idle ({idle.length})</span>
                    </div>
                    {idleShown && idle.map((e) => e.el())}
                  </div>
                )}
              </div>
            )
          })()
        ) : (
          <>
            {(() => {
              const seen = new Set<string>()
              return childGroups(state.groups, null).map((g) => (seen.has(g.id) || isPinned(g.id) ? null : groupBlock(g, 0, seen)))
            })()}
            {(standalone.length > 0 || state.groups.some((g) => g.kind === 'manual' || g.parentId)) && (
              <div
                className="standalone"
                onDragOver={(e) => {
                  if (dragId.current || (dragGroupId.current && canDropGroup(dragGroupId.current, null))) {
                    e.preventDefault()
                    setDragOver('standalone')
                  }
                }}
                onDragLeave={() => setDragOver((d) => (d === 'standalone' ? null : d))}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(null)
                  if (dragGroupId.current) {
                    const gid = dragGroupId.current
                    dragGroupId.current = null
                    if (canDropGroup(gid, null)) p.onMoveGroup(gid, null)
                    return
                  }
                  const from = dragId.current
                  dragId.current = null
                  if (from) p.onMoveFolder(from, null)
                }}
              >
                {state.groups.length > 0 && <div className="section-label">Folders</div>}
                <div className={dragOver === 'standalone' ? 'drop-zone active' : 'drop-zone'}>
                  {standalone.map((f) => folderRow(f, 0))}
                  {standalone.length === 0 && <div className="group-empty">Drop a folder or group here to move it to the top level</div>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {note && <div className={`sidebar-note ${note.error ? 'error' : ''}`}>{note.text}</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  )
}
