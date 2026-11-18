import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { ChevronDown, FileDiff, FileText, Plus, RotateCw, Shield, ShieldAlert, Terminal, X, Zap } from 'lucide-react'
import type { Command, ElevatorInfo } from '../../shared/types'
import { GSUDO_HINT } from '../../shared/elevation'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import type { DiffSpec } from './gitUtil'
import type { Loc } from './locations'

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
  onRunAgain: (cmd: Command) => void
  onNew: () => void
  /** Start the default shell elevated (UAC prompt). */
  onNewAdmin: () => void
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
          label: available ? 'New admin terminal' : `New admin terminal — install gsudo: ${GSUDO_HINT}`,
          icon: <Shield size={14} />,
          disabled: !available,
          title: info?.hint,
          onClick: p.onNewAdmin
        }
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
        return (
          <div
            key={t.id}
            className={`tab ${t.id === p.activeId ? 'active' : ''} ${t.exited ? 'exited' : ''} ${t.elevated ? 'admin' : ''} ${t.preview ? 'preview' : ''} ${p.shownElsewhere.has(t.id) ? 'elsewhere' : ''}`}
            data-tab-id={t.id}
            draggable
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
            onDoubleClick={() => t.preview && p.onPin(t.id)}
            onAuxClick={(e) => e.button === 1 && p.onClose(t.id)}
            title={`${t.file ? t.file : t.diff ? `${t.diff.path}\n${t.cwd}` : `${t.title}\n${t.cwd}${status ? `\n(${status})` : ''}${t.elevated ? '\n(administrator)' : ''}`}${p.shownElsewhere.has(t.id) ? '\n(shown in another pane)' : ''}`}
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
            <span className="tab-title">{t.title}</span>
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
