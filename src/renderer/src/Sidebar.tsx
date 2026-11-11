import { useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import {
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
  Group,
  Pencil,
  RefreshCw,
  SquareArrowOutUpRight,
  SquareTerminal,
  Code,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import type { AppState, ChildView, FolderView, GroupView } from '../../shared/types'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'

interface Props {
  state: AppState
  counts: Record<string, number>
  onSelect: (id: string) => void
  onOpenTerminal: (id: string) => void
  onAddFolder: () => void
  onAddParent: () => void
  onAddGroup: (name: string) => void
  onRemoveFolder: (id: string) => void
  onRemoveGroup: (id: string) => void
  onRenameFolder: (id: string, name: string) => void
  onRenameGroup: (id: string, name: string) => void
  onMoveFolder: (id: string, groupId: string | null, beforeId?: string) => void
  onToggleCollapse: (id: string, collapsed: boolean) => void
  onToggleShowHidden: (id: string, show: boolean) => void
  onHideChild: (groupId: string, path: string, hidden: boolean) => void
  onRefresh: () => void
  onOpenWt: (path: string) => void
  onOpenExplorer: (path: string) => void
  onOpenEditor: (path: string) => void
  onCopy: (text: string) => void
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

interface RowProps {
  indent: number
  icon: ReactNode
  name: string
  subtitle?: string | null
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
      className={['row', r.selected ? 'selected' : '', r.missing ? 'missing' : '', r.dim ? 'dim' : '', r.dropActive ? 'drag-over' : ''].join(' ')}
      style={{ paddingLeft: 8 + r.indent * 16 }}
      title={r.title}
      draggable={!!r.drag && !r.editing}
      onClick={r.onClick}
      onContextMenu={r.onContext}
      onDragStart={r.drag?.onDragStart}
      onDragEnd={r.drag?.onDragEnd}
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
        {r.subtitle && !r.editing && <div className="row-sub">{r.subtitle}</div>}
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
  const [creating, setCreating] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const dragId = useRef<string | null>(null)

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

  const pathItems = (id: string, path: string, missing: boolean): MenuItem[] => [
    { label: 'Open terminal', icon: <Terminal size={14} />, disabled: missing, onClick: () => p.onOpenTerminal(id) },
    { label: 'Open in Windows Terminal', icon: <SquareTerminal size={14} />, disabled: missing, onClick: () => p.onOpenWt(path) },
    { label: 'Open in Explorer', icon: <FolderOpen size={14} />, disabled: missing, onClick: () => p.onOpenExplorer(path) },
    { label: 'Open in editor', icon: <Code size={14} />, disabled: missing, onClick: () => p.onOpenEditor(path) }
  ]

  const folderMenu = (f: FolderView): MenuItem[] => {
    const manual = state.groups.filter((g) => g.kind === 'manual')
    return [
      ...pathItems(f.id, f.path, f.missing),
      { separator: true },
      { label: 'Rename', icon: <Pencil size={14} />, onClick: () => startRename('folder', f.id, f.name) },
      ...manual
        .filter((g) => g.id !== f.groupId)
        .map<MenuItem>((g) => ({
          label: `Move to group: ${g.name}`,
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

  const groupMenu = (g: GroupView): MenuItem[] => {
    const rename: MenuItem = { label: 'Rename', icon: <Pencil size={14} />, onClick: () => startRename('group', g.id, g.name) }
    const remove: MenuItem = {
      label: g.kind === 'manual' ? 'Remove group (keeps folders)' : 'Remove group',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => p.onRemoveGroup(g.id)
    }
    if (g.kind === 'manual') return [rename, { separator: true }, remove]
    const path = g.path as string
    return [
      ...pathItems(g.id, path, g.missing),
      { separator: true },
      rename,
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

  const drop = (target: FolderView, e: React.DragEvent): void => {
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
      icon={f.isGit ? <FolderGit2 size={16} /> : <FolderIcon size={16} />}
      name={f.name}
      subtitle={f.missing ? 'Folder not found' : f.branch ? f.branch : f.path}
      title={f.missing ? `${f.path}\n(folder not found on disk)` : f.path}
      selected={f.id === state.selectedId}
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
          if (dragId.current) {
            e.preventDefault()
            e.stopPropagation()
            setDragOver(f.id)
          }
        },
        onDragLeave: () => setDragOver((d) => (d === f.id ? null : d)),
        onDrop: (e) => drop(f, e)
      }}
      actions={
        <>
          <button className="icon-btn" title="New terminal" disabled={f.missing} onClick={() => p.onOpenTerminal(f.id)}>
            <Terminal size={14} />
          </button>
          <button className="icon-btn danger" title="Remove folder (closes its terminals)" onClick={() => p.onRemoveFolder(f.id)}>
            <X size={14} />
          </button>
        </>
      }
    />
  )

  const groupBlock = (g: GroupView): JSX.Element => {
    const members = g.kind === 'manual' ? membersOf(g.id) : []
    const visibleChildren = g.children.filter((c) => g.showHidden || !c.hidden)
    const count =
      (p.counts[g.id] ?? 0) +
      (g.kind === 'manual' ? members.reduce((n, f) => n + (p.counts[f.id] ?? 0), 0) : g.children.reduce((n, c) => n + (p.counts[c.id] ?? 0), 0))
    const total = g.kind === 'manual' ? members.length : visibleChildren.length
    return (
      <div key={g.id} className="group">
        <Row
          indent={0}
          icon={g.kind === 'manual' ? <Group size={16} /> : <FolderTree size={16} />}
          name={g.name}
          subtitle={g.missing ? 'Folder not found' : g.kind === 'parent' ? g.branch ?? g.path : `${total} ${total === 1 ? 'folder' : 'folders'}`}
          title={g.path ? (g.missing ? `${g.path}\n(folder not found on disk)` : g.path) : g.name}
          selected={g.id === state.selectedId}
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
          drag={
            g.kind === 'manual'
              ? {
                  onDragStart: () => {},
                  onDragEnd: () => {},
                  onDragOver: (e) => {
                    if (dragId.current) {
                      e.preventDefault()
                      setDragOver(g.id)
                    }
                  },
                  onDragLeave: () => setDragOver((d) => (d === g.id ? null : d)),
                  onDrop: (e) => {
                    e.preventDefault()
                    const from = dragId.current
                    dragId.current = null
                    setDragOver(null)
                    if (from) p.onMoveFolder(from, g.id)
                  }
                }
              : undefined
          }
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
        {!g.collapsed && (
          <div className="group-children">
            {g.kind === 'manual' && members.length === 0 && <div className="group-empty">Drag folders here or use "Move to group"</div>}
            {g.kind === 'manual' && members.map((f) => folderRow(f, 1))}
            {g.kind === 'parent' && g.missing && <div className="group-empty">Parent folder not found</div>}
            {g.kind === 'parent' && !g.missing && visibleChildren.length === 0 && (
              <div className="group-empty">{g.hiddenCount > 0 ? 'All subfolders are hidden' : 'No subfolders'}</div>
            )}
            {g.kind === 'parent' &&
              visibleChildren.map((c) => (
                <Row
                  key={c.id}
                  indent={1}
                  icon={c.isGit ? <FolderGit2 size={16} /> : <FolderIcon size={16} />}
                  name={c.name}
                  subtitle={c.hidden ? 'hidden' : c.isGit ? c.branch ?? 'git' : null}
                  title={c.path}
                  selected={c.id === state.selectedId}
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
          <button className="icon-btn" onClick={() => setCreating('')} title="New group">
            <Group size={16} />
          </button>
          <button className="icon-btn" onClick={p.onRefresh} title="Rescan folders">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div className="tree">
        {creating !== null && (
          <div className="row creating">
            <span className="row-chevron" />
            <span className="row-icon">
              <Group size={16} />
            </span>
            <input
              className="rename-input"
              autoFocus
              placeholder="Group name"
              value={creating}
              onChange={(e) => setCreating(e.target.value)}
              onBlur={() => setCreating(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && creating.trim()) {
                  p.onAddGroup(creating)
                  setCreating(null)
                }
                if (e.key === 'Escape') setCreating(null)
              }}
            />
          </div>
        )}
        {empty && (
          <div className="sidebar-empty">
            <FolderPlus size={28} />
            <div>Add a folder or a parent folder to get started</div>
          </div>
        )}
        {state.groups.map(groupBlock)}
        {(standalone.length > 0 || state.groups.some((g) => g.kind === 'manual')) && (
          <div
            className="standalone"
            onDragOver={(e) => {
              if (dragId.current) {
                e.preventDefault()
                setDragOver('standalone')
              }
            }}
            onDragLeave={() => setDragOver((d) => (d === 'standalone' ? null : d))}
            onDrop={(e) => {
              e.preventDefault()
              const from = dragId.current
              dragId.current = null
              setDragOver(null)
              if (from) p.onMoveFolder(from, null)
            }}
          >
            {state.groups.length > 0 && <div className="section-label">Folders</div>}
            <div className={dragOver === 'standalone' ? 'drop-zone active' : 'drop-zone'}>
              {standalone.map((f) => folderRow(f, 0))}
              {standalone.length === 0 && <div className="group-empty">Drop a folder here to ungroup it</div>}
            </div>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  )
}
