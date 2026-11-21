import { useRef, useState } from 'react'
import { markSidebarClick } from './sidebarFocus'
import type { JSX, ReactNode } from 'react'
import {
  PanelRight,
  ChevronDown,
  ChevronRight,
  Copy,
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
  RefreshCw,
  Settings as SettingsIcon,
  SquareArrowOutUpRight,
  SquareTerminal,
  Code,
  Terminal,
  Trash2
} from 'lucide-react'
import type { AppState, ChildView, FolderView, GroupView } from '../../shared/types'
import { HOME_ID } from '../../shared/types'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { LOC_DRAG_TYPE, locDrag } from './TabBar'
import { childGroups, groupPath, nestError, nestTarget, removalSet, subtreeGroupIds } from '../../shared/groupTree'

interface Props {
  state: AppState
  counts: Record<string, number>
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
  count: number
  dropActive?: boolean
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
        r.dropActive ? 'drag-over' : ''
      ].join(' ')}
      style={{ paddingLeft: 8 + r.indent * 18 }}
      title={r.title}
      draggable={(!!r.drag || !!r.locId) && !r.editing}
      onClick={r.onClick}
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
          <div className="row-name" onDoubleClick={r.onDoubleClick}>
            {r.name}
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
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const dragId = useRef<string | null>(null)
  /** Id of the group header being dragged (nest / un-nest); separate from dragId so folder handlers ignore it. */
  const dragGroupId = useRef<string | null>(null)

  const folders = state.folders
  const standalone = folders.filter((f) => !f.groupId)
  const membersOf = (gid: string): FolderView[] => folders.filter((f) => f.groupId === gid)

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
    if (idx(-1)) items.push({ label: 'Move up', icon: <ArrowUp size={14} />, hint: 'Alt+Shift+Up', onClick: () => p.onNestMove(id, 'move', -1) })
    if (idx(1)) items.push({ label: 'Move down', icon: <ArrowDown size={14} />, hint: 'Alt+Shift+Down', onClick: () => p.onNestMove(id, 'move', 1) })
    if (nestTarget(state.groups, state.folders, id, 1) !== undefined)
      items.push({ label: 'Move into group above', icon: <ArrowRightToLine size={14} />, hint: 'Alt+Shift+Right', onClick: () => p.onNestMove(id, 'nest', 1) })
    if (nestTarget(state.groups, state.folders, id, -1) !== undefined)
      items.push({ label: 'Move out of group', icon: <ArrowLeftToLine size={14} />, hint: 'Alt+Shift+Left', onClick: () => p.onNestMove(id, 'nest', -1) })
    return items
  }

  const folderMenu = (f: FolderView): MenuItem[] => {
    const manual = state.groups.filter((g) => g.kind === 'manual')
    return [
      ...pathItems(f.id, f.path, f.missing),
      { separator: true },
      { label: 'Rename', icon: <Pencil size={14} />, onClick: () => startRename('folder', f.id, f.name) },
      ...arrangeItems(f.id),
      ...manual
        .filter((g) => g.id !== f.groupId)
        .map<MenuItem>((g) => ({
          label: `Move to group: ${groupPath(state.groups, g.id)}`,
          icon: <FolderInput size={14} />,
          onClick: () => p.onMoveFolder(f.id, g.id)
        })),
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
      ...state.groups
        .filter((x) => x.kind === 'manual' && x.id !== g.parentId && nestError(state.groups, g.id, x.id) === null)
        .map<MenuItem>((x) => ({
          label: `Move to group: ${groupPath(state.groups, x.id)}`,
          icon: <FolderInput size={14} />,
          onClick: () => p.onMoveGroup(g.id, x.id)
        })),
      ...(g.parentId
        ? [{ label: 'Move to top level', icon: <FolderMinus size={14} />, onClick: () => p.onMoveGroup(g.id, null) } as MenuItem]
        : [])
    ]
    if (g.kind === 'manual') {
      const newSub: MenuItem = {
        label: 'New subgroup',
        icon: <FolderPlus size={14} />,
        onClick: () => {
          if (g.collapsed) p.onToggleCollapse(g.id, false)
          setCreating({ parentId: g.id, name: '' })
        }
      }
      return [sideItem(g.id, false), { separator: true }, rename, newSub, ...moveItems, { separator: true }, remove]
    }
    const path = g.path as string
    return [
      ...pathItems(g.id, path, g.missing),
      { separator: true },
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

  const drop = (target: FolderView, e: React.DragEvent): void => {
    if (isOsDrag(e)) return osDrop(e, target.groupId, target.id)
    e.preventDefault()
    e.stopPropagation()
    const from = dragId.current
    dragId.current = null
    setDragOver(null)
    if (from && from !== target.id) p.onMoveFolder(from, target.groupId, target.id)
  }

  const folderRow = (f: FolderView, indent: number): JSX.Element => (
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
      count={p.counts[f.id] ?? 0}
      dropActive={dragOver === f.id}
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
          if (dragId.current || isOsDrag(e)) {
            e.preventDefault()
            e.stopPropagation()
            setDragOver(f.id)
          }
        },
        onDragLeave: () => setDragOver((d) => (d === f.id ? null : d)),
        onDrop: (e) => drop(f, e)
      }}
      actions={
        <button className="icon-btn" title="New terminal" disabled={f.missing} onClick={() => p.onOpenTerminal(f.id)}>
          <Terminal size={14} />
        </button>
      }
    />
  )

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
    const removal = removalSet(state.groups, state.folders, g.id)
    const total = removal.folderIds.length
    const subCount = removal.groupIds.length - 1
    const manualSubtitle = `${subCount > 0 ? `${subCount} ${subCount === 1 ? 'group' : 'groups'}, ` : ''}${total} ${total === 1 ? 'folder' : 'folders'}`
    const showEmpty = g.kind === 'manual' && members.length === 0 && subgroups.length === 0 && creating?.parentId !== g.id
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
            subtitle={g.missing ? 'Folder not found' : g.kind === 'parent' ? g.branch ?? g.path : manualSubtitle}
            subKind={g.missing ? 'missing' : g.kind === 'parent' ? (g.branch ? 'branch' : 'path') : 'text'}
            group
            title={g.path ? (g.missing ? `${g.path}\n(folder not found on disk)` : g.path) : g.name}
            selected={g.id === state.selectedId}
            locId={g.id}
            missing={g.missing}
            count={count}
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
            onDoubleClick={() => startRename('group', g.id, g.name)}
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
            {g.kind === 'manual' && creating?.parentId === g.id && creatingRow(depth + 1)}
            {g.kind === 'manual' && subgroups.map((c) => groupBlock(c, depth + 1, seen))}
            {showEmpty && (
              <div className="group-empty" style={{ paddingLeft: 50 + depth * 18 }}>
                Drag folders or groups here or use "Move to group"
              </div>
            )}
            {g.kind === 'manual' && members.map((f) => folderRow(f, depth + 1))}
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
            {g.kind === 'parent' &&
              visibleChildren.map((c) => (
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
              ))}
          </div>
        )}
      </div>
    )
  }

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
        {(() => {
          const seen = new Set<string>()
          return childGroups(state.groups, null).map((g) => (seen.has(g.id) ? null : groupBlock(g, 0, seen)))
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
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  )
}
