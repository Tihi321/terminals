import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Bot, ChevronDown, Download, FileDiff, FileText, Pencil, Plus, RotateCw, Shield, ShieldAlert, Terminal, X, Zap } from 'lucide-react'
import type { Command, ElevatorInfo } from '../../shared/types'
import { GSUDO_HINT } from '../../shared/elevation'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import type { DiffSpec } from './gitUtil'
import type { Loc } from './locations'
import { STATUS_LABEL } from '../../shared/agentStatus'
import type { AgentStatus, StatusSource } from '../../shared/agentStatus'

export interface Tab {
  id: string
  /** Sidebar entry (folder, child or group) whose tab bar this belongs to. */
  locId: string
  cwd: string
  title: string
  kind: 'shell' | 'command' | 'diff' | 'file'
  /** Shell tabs: executable the shell was started with (restored on the next launch). */
  shell?: string
  /** Shell tabs: cwd the tab was started in; fallback when its last known cwd is gone. */
  startCwd?: string
  /** Shell tabs: the process ended. */
  exited: boolean
  /** Command tabs only. */
  steps?: string[]
  /** Diff tabs only: no pty behind them. */
  diff?: DiffSpec
  /** File tabs only: absolute path shown read-only. */
  file?: string
  /** Diff/file tabs: replaced by the next single-click diff (italic title) until pinned. */
  preview?: boolean
  /** Shell tabs: started (or to be started) as administrator. Saved in the session. */
  elevated?: boolean
  /** Shell tabs: opened by an MCP agent. Saved in the session. */
  agent?: boolean
  /** The user renamed this tab; terminal titles no longer replace it. Saved in the session. */
  userTitle?: boolean
  /** Shell tabs: the last cleaned title the terminal set itself. Runtime only. */
  autoTitle?: string
  /** Elevated shell restored from a session: no term/pty until "Start as admin" is clicked. Not saved. */
  pending?: boolean
  /** Bumped on an elevated retry so the TerminalView remounts. */
  attempt?: number
  run?: { commandId: string; runId: string; status: 'running' | 'success' | 'failed'; exitCode?: number; target?: number }
}

/** dataTransfer type for tab drags; distinct from the sidebar's folder drag and Explorer's 'Files'. */
export const TAB_DRAG_TYPE = 'application/x-terminals-tab'
/** dataTransfer type set by sidebar rows (folder, child, group) so a pane can take them. */
export const LOC_DRAG_TYPE = 'application/x-terminals-loc'
/** dataTransfer type set by file-tree rows; payload is a JSON array of absolute paths a terminal can take. */
export const PATHS_DRAG_TYPE = 'application/x-terminals-paths'
/** The sidebar location being dragged (dataTransfer data is unreadable during dragover). */
export const locDrag: { id: string | null } = { id: null }
/** The tab being dragged (dataTransfer data is unreadable during dragover). */
export const tabDrag: { tab: Tab | null } = { tab: null }

interface Props {
  loc: Loc
  tabs: Tab[]
  activeId: string | undefined
  commands: Command[]
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onPin: (id: string) => void
  /** A non-empty title renames the tab; null goes back to the terminal's own title. */
  onRename: (id: string, title: string | null) => void
  /** Agent status per tab id (non-idle only). */
  status: Record<string, AgentStatus>
  /** Where each tab's status came from, for the tooltip. */
  statusSource: Record<string, StatusSource>
  onRunAgain: (cmd: Command) => void
  onNew: () => void
  /** Start the default shell elevated (UAC prompt). */
  onNewAdmin: () => void
  /** Runs `winget install gerardog.gsudo` in a new tab; offered when no elevator is found. */
  onInstallGsudo: () => void
  /** Asked each time the new-terminal menu opens. */
  getElevator: () => Promise<ElevatorInfo>
  onDragEnd: () => void
  /** Tabs of this folder that are active in another pane. */
  shownElsewhere: Set<string>
  /** Drop on this bar: move `id` before `beforeId` (null = to the end). */
  onReorder: (id: string, beforeId: string | null) => void
  /** Called while this bar accepts a drag, so the pane-body split hint can clear. */
  onAcceptDrag?: () => void
}

/** One pane's tab strip: the tabs of a single location plus the new-terminal button. */
export function TabBar(p: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  const [marker, setMarker] = useState<{ x: number; beforeId: string | null } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const newDisabled = p.loc.missing || !p.loc.path
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null)
  const renameDone = useRef(false)

  const commitRename = (): void => {
    if (renameDone.current || !renaming) return
    renameDone.current = true
    const draft = renaming.draft.trim()
    const cur = p.tabs.find((t) => t.id === renaming.id)
    if (draft && cur && draft !== cur.title) p.onRename(renaming.id, draft)
    setRenaming(null)
  }
  const cancelRename = (): void => {
    renameDone.current = true
    setRenaming(null)
  }
  const startRename = (t: Tab): void => {
    renameDone.current = false
    setRenaming({ id: t.id, draft: t.title })
  }

  const openNewMenu = async (x: number, y: number): Promise<void> => {
    let info: ElevatorInfo | null = null
    try {
      info = await p.getElevator()
    } catch {
      info = null
    }
    const available = !!info?.available
    setMenu({
      x,
      y,
      items: [
        { label: 'New terminal', icon: <Terminal size={14} />, onClick: p.onNew },
        {
          label: available ? 'New admin terminal' : 'New admin terminal (needs gsudo)',
          icon: <Shield size={14} />,
          disabled: !available,
          title: info?.hint,
          onClick: p.onNewAdmin
        },
        ...(available
          ? []
          : [{ label: 'Install gsudo', icon: <Download size={14} />, title: `Runs: ${GSUDO_HINT}`, onClick: p.onInstallGsudo }])
      ]
    })
  }

  useEffect(() => {
    ref.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.activeId, p.tabs.length, p.tabs.map((t) => t.id).join()])

  const accepts = (): boolean => tabDrag.tab?.locId === p.loc.id

  /** Insertion point for a pointer at clientX: before the first tab whose midpoint is to the right. */
  const insertionAt = (clientX: number): { x: number; beforeId: string | null } => {
    const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('.tab[data-tab-id]') ?? [])
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (clientX < r.left + r.width / 2) return { x: el.offsetLeft, beforeId: el.dataset.tabId ?? null }
    }
    const last = els[els.length - 1]
    return { x: last ? last.offsetLeft + last.offsetWidth : 0, beforeId: null }
  }

  return (
    <div
      className="tabbar"
      ref={ref}
      onDragOver={(e) => {
        if (!accepts()) return
        e.preventDefault()
        e.stopPropagation()
        p.onAcceptDrag?.()
        e.dataTransfer.dropEffect = 'move'
        const m = insertionAt(e.clientX)
        setMarker((cur) => (cur && cur.x === m.x && cur.beforeId === m.beforeId ? cur : m))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMarker(null)
      }}
      onDrop={(e) => {
        const tab = tabDrag.tab
        if (!tab || !accepts()) return
        e.preventDefault()
        e.stopPropagation()
        const m = insertionAt(e.clientX)
        setMarker(null)
        p.onReorder(tab.id, m.beforeId)
      }}
    >
      {p.tabs.map((t) => {
        const status = t.kind === 'command' ? t.run?.status : t.exited ? 'exited' : undefined
        const finished = t.kind === 'command' && t.run?.status !== 'running'
        const agentSt = t.kind === 'shell' ? p.status[t.id] : undefined
        const agentTip = agentSt ? `\nAgent: ${STATUS_LABEL[agentSt]}${p.statusSource[t.id] ? ` (${p.statusSource[t.id]})` : ''}` : ''
        const renamable = t.kind === 'shell' || t.kind === 'command'
        const isRenaming = renaming?.id === t.id
        return (
          <div
            key={t.id}
            className={`tab ${t.id === p.activeId ? 'active' : ''} ${t.exited ? 'exited' : ''} ${t.elevated ? 'admin' : ''} ${t.preview ? 'preview' : ''} ${p.shownElsewhere.has(t.id) ? 'elsewhere' : ''}`}
            data-tab-id={t.id}
            draggable={!isRenaming}
            onDragStart={(e) => {
              tabDrag.tab = t
              e.dataTransfer.setData(TAB_DRAG_TYPE, t.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => {
              tabDrag.tab = null
              setMarker(null)
              p.onDragEnd()
            }}
            onClick={() => p.onActivate(t.id)}
            onDoubleClick={() => {
              if (renamable) startRename(t)
              else if (t.preview) p.onPin(t.id)
            }}
            onAuxClick={(e) => e.button === 1 && p.onClose(t.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              const items: MenuItem[] = []
              if (renamable) items.push({ label: 'Rename tab', icon: <Pencil size={14} />, onClick: () => startRename(t) })
              if (t.kind === 'shell' && t.userTitle)
                items.push({ label: 'Use terminal title', icon: <Terminal size={14} />, onClick: () => p.onRename(t.id, null) })
              if (items.length > 0) items.push({ separator: true })
              items.push({ label: 'Close', icon: <X size={14} />, onClick: () => p.onClose(t.id) })
              setMenu({ x: e.clientX, y: e.clientY, items })
            }}
            title={`${t.file ? t.file : t.diff ? `${t.diff.path}\n${t.cwd}` : `${t.title}\n${t.cwd}${status ? `\n(${status})` : ''}${t.elevated ? '\n(administrator)' : ''}`}${agentTip}${p.shownElsewhere.has(t.id) ? '\n(shown in another pane)' : ''}`}
          >
            {t.kind === 'command' ? (
              <Zap size={13} className="tab-icon" />
            ) : t.kind === 'diff' ? (
              <FileDiff size={13} className="tab-icon" />
            ) : t.kind === 'file' ? (
              <FileText size={13} className="tab-icon" />
            ) : t.elevated ? (
              t.pending ? <Shield size={13} className="tab-icon admin" /> : <ShieldAlert size={13} className="tab-icon admin" />
            ) : (
              <Terminal size={13} className="tab-icon" />
            )}
            {t.agent && (
              <span className="tab-agent" title="Opened by an agent (MCP)">
                <Bot size={12} />
              </span>
            )}
            {agentSt && (
              <span className={`agent-ind ${agentSt}`} title={STATUS_LABEL[agentSt]}>
                {agentSt === 'needs-you' ? '!' : null}
              </span>
            )}
            {isRenaming ? (
              <input
                className="tab-rename"
                autoFocus
                value={renaming?.draft ?? ''}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenaming({ id: t.id, draft: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') commitRename()
                  else if (e.key === 'Escape') cancelRename()
                }}
              />
            ) : (
              <span className="tab-title">{t.title}</span>
            )}
            {t.kind === 'command' && <span className={`dot ${t.run?.status}`} />}
            {t.exited && <span className="tab-exited">exited</span>}
            {finished && t.run && (
              <button
                className="tab-btn"
                title="Run again"
                disabled={!p.commands.some((c) => c.id === t.run?.commandId)}
                onClick={(e) => {
                  e.stopPropagation()
                  const cmd = p.commands.find((c) => c.id === t.run?.commandId)
                  if (cmd) p.onRunAgain(cmd)
                }}
              >
                <RotateCw size={13} />
              </button>
            )}
            <button
              className="tab-btn"
              title={t.kind === 'diff' ? 'Close diff' : t.kind === 'file' ? 'Close file' : 'Close terminal'}
              onClick={(e) => {
                e.stopPropagation()
                p.onClose(t.id)
              }}
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
      {marker && <div className="tab-drop-marker" style={{ left: marker.x }} />}
      <button
        className="tab-new"
        title="New terminal (Ctrl+Shift+T)"
        disabled={newDisabled}
        onClick={p.onNew}
        onContextMenu={(e) => {
          e.preventDefault()
          if (newDisabled) return
          const r = e.currentTarget.getBoundingClientRect()
          void openNewMenu(r.left, r.bottom + 2)
        }}
      >
        <Plus size={16} />
      </button>
      <button
        className="tab-new-more"
        title="New terminal options"
        disabled={newDisabled}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          void openNewMenu(r.left, r.bottom + 2)
        }}
      >
        <ChevronDown size={12} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
