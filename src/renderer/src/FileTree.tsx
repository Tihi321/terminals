import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  ExternalLink,
  File as FileIcon,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  FileArchive,
  Folder as FolderIcon,
  FolderOpen,
  FolderSearch,
  Eye,
  EyeOff,
  RefreshCw,
  Search,
  Terminal,
  FolderX
} from 'lucide-react'
import type { DirEntry } from '../../shared/types'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { relPath } from './locations'

interface Props {
  root: string | null
  rootMissing: boolean
  onOpenTerminalHere: (dir: string) => void
  onOpenFile: (path: string, pin: boolean) => void
}

interface Row {
  entry: DirEntry
  depth: number
}

const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'go', 'py', 'cs', 'cpp', 'c', 'h', 'java', 'ps1', 'sh', 'bat', 'cmd', 'css', 'scss', 'html', 'vue', 'toml', 'yml', 'yaml', 'xml'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])
const ARCHIVE = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'nupkg'])
const TEXT = new Set(['md', 'txt', 'log', 'csv', 'lock', 'ini', 'env', 'gitignore'])

export function fileIcon(name: string): ReactNode {
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  if (ext === 'json' || ext === 'jsonc') return <FileJson size={15} className="ic-json" />
  if (CODE.has(ext)) return <FileCode size={15} className="ic-code" />
  if (IMAGE.has(ext)) return <FileImage size={15} className="ic-image" />
  if (ARCHIVE.has(ext)) return <FileArchive size={15} className="ic-archive" />
  if (TEXT.has(ext)) return <FileText size={15} className="ic-text" />
  return <FileIcon size={15} />
}

export function FileTree({ root, rootMissing, onOpenTerminalHere, onOpenFile }: Props): JSX.Element {
  const [entries, setEntries] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const showIgnoredRef = useRef(showIgnored)
  showIgnoredRef.current = showIgnored
  const rootRef = useRef(root)
  rootRef.current = root

  const load = useCallback(async (dir: string): Promise<void> => {
    const r = await window.api.listDir(dir, showIgnoredRef.current)
    if (rootRef.current === null) return
    if (r.ok) {
      setEntries((e) => ({ ...e, [dir]: r.entries }))
      if (dir === rootRef.current) setError(null)
    } else if (dir === rootRef.current) {
      setError(r.error)
    }
  }, [])

  // Reset when the root or the ignore toggle changes.
  useEffect(() => {
    setEntries({})
    setExpanded(new Set())
    setError(null)
    setFilter('')
    if (root && !rootMissing) void load(root)
  }, [root, rootMissing, showIgnored, load])

  // Watch the root and every expanded directory; reload a directory when it changes.
  useEffect(() => {
    if (!root || rootMissing) return
    window.api.watchDirs([root, ...expanded])
  }, [root, rootMissing, expanded])
  useEffect(() => {
    const off = window.api.onFsChanged((dir) => void load(dir))
    return () => {
      off()
      window.api.watchDirs([])
    }
  }, [load])

  const refresh = (): void => {
    if (!root) return
    void load(root)
    for (const d of expanded) void load(d)
  }

  const toggle = (dir: string): void => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(dir)) n.delete(dir)
      else {
        n.add(dir)
        void load(dir)
      }
      return n
    })
  }

  const rows = useMemo<Row[]>(() => {
    if (!root) return []
    const f = filter.trim().toLowerCase()
    const walk = (dir: string, depth: number): Row[] => {
      const out: Row[] = []
      for (const entry of entries[dir] ?? []) {
        const matches = !f || entry.name.toLowerCase().includes(f)
        const open = entry.isDir && (f ? !!entries[entry.path] : expanded.has(entry.path))
        const children = open ? walk(entry.path, depth + 1) : []
        if (matches || children.length > 0) out.push({ entry, depth }, ...children)
      }
      return out
    }
    return walk(root, 0)
  }, [root, entries, expanded, filter])

  const menuFor = (e: React.MouseEvent, entry: DirEntry): void => {
    e.preventDefault()
    const items: MenuItem[] = [
      { label: 'Open in editor', icon: <Code size={14} />, onClick: () => void window.api.openInEditor(entry.path) },
      { label: 'Open with default app', icon: <ExternalLink size={14} />, onClick: () => void window.api.openDefault(entry.path) },
      { label: 'Reveal in Explorer', icon: <FolderSearch size={14} />, onClick: () => void window.api.revealInExplorer(entry.path) },
      { separator: true },
      { label: 'Copy path', icon: <Copy size={14} />, onClick: () => void window.api.clipboardWrite(entry.path) },
      {
        label: 'Copy relative path',
        icon: <Copy size={14} />,
        onClick: () => void window.api.clipboardWrite(root ? relPath(root, entry.path) : entry.path)
      }
    ]
    if (entry.isDir) {
      items.push({ separator: true }, { label: 'Open terminal here', icon: <Terminal size={14} />, onClick: () => onOpenTerminalHere(entry.path) })
    }
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  if (!root) {
    return (
      <div className="panel-empty">
        <span className="empty-glyph">
          <FolderOpen size={18} />
        </span>
        <div>Select a folder to browse its files</div>
      </div>
    )
  }
  if (rootMissing) {
    return (
      <div className="panel-empty">
        <span className="empty-glyph">
          <FolderX size={18} />
        </span>
        <div>Folder not found on disk</div>
      </div>
    )
  }

  return (
    <div className="filetree">
      <div className="panel-toolbar">
        <div className="filter-box">
          <Search size={13} />
          <input placeholder="Filter loaded files" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button
          className={`icon-btn ${showIgnored ? 'active' : ''}`}
          title={showIgnored ? 'Hide .git and node_modules' : 'Show ignored (.git, node_modules)'}
          onClick={() => setShowIgnored((v) => !v)}
        >
          {showIgnored ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button className="icon-btn" title="Refresh" onClick={refresh}>
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="tree-scroll">
        {error && <div className="panel-error">{error}</div>}
        {!error && entries[root] && rows.length === 0 && <div className="panel-hint">{filter ? 'No matches' : 'Empty folder'}</div>}
        {rows.map(({ entry, depth }) => (
          <div
            key={entry.path}
            className="file-row"
            title={entry.path}
            onClick={() => (entry.isDir ? toggle(entry.path) : onOpenFile(entry.path, false))}
            onDoubleClick={() => !entry.isDir && onOpenFile(entry.path, true)}
            onContextMenu={(e) => menuFor(e, entry)}
          >
            {Array.from({ length: depth }, (_, i) => (
              <span key={i} className="guide" />
            ))}
            <span className="file-chevron">
              {entry.isDir && (expanded.has(entry.path) || filter ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
            </span>
            <span className="file-icon">
              {entry.isDir ? expanded.has(entry.path) ? <FolderOpen size={15} className="ic-folder" /> : <FolderIcon size={15} className="ic-folder" /> : fileIcon(entry.name)}
            </span>
            <span className="file-name">{entry.name}</span>
          </div>
        ))}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
