import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { FileDiff, FileText, Plus, RotateCw, Terminal, X, Zap } from 'lucide-react'
import type { Command } from '../../shared/types'
import type { DiffSpec } from './gitUtil'
import type { Loc } from './locations'

export interface Tab {
  id: string
  /** Sidebar entry (folder, child or group) whose tab bar this belongs to. */
  locId: string
  cwd: string
  title: string
  kind: 'shell' | 'command' | 'diff' | 'file'
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
  run?: { commandId: string; runId: string; status: 'running' | 'success' | 'failed'; exitCode?: number }
}

/** dataTransfer type for tab drags; distinct from the sidebar's folder drag and Explorer's 'Files'. */
export const TAB_DRAG_TYPE = 'application/x-terminals-tab'
/** dataTransfer type set by sidebar rows (folder, child, group) so a pane can take them. */
export const LOC_DRAG_TYPE = 'application/x-terminals-loc'
/** The sidebar location being dragged (dataTransfer data is unreadable during dragover). */
export const locDrag: { id: string | null } = { id: null }

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
  onDragStart: (e: React.DragEvent, tab: Tab) => void
  onDragEnd: () => void
}

/** One pane's tab strip: the tabs of a single location plus the new-terminal button. */
export function TabBar(p: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [p.activeId, p.tabs.length])

  return (
    <div className="tabbar" ref={ref}>
      {p.tabs.map((t) => {
        const status = t.kind === 'command' ? t.run?.status : t.exited ? 'exited' : undefined
        const finished = t.kind === 'command' && t.run?.status !== 'running'
        return (
          <div
            key={t.id}
            className={`tab ${t.id === p.activeId ? 'active' : ''} ${t.exited ? 'exited' : ''} ${t.preview ? 'preview' : ''}`}
            draggable
            onDragStart={(e) => p.onDragStart(e, t)}
            onDragEnd={p.onDragEnd}
            onClick={() => p.onActivate(t.id)}
            onDoubleClick={() => t.preview && p.onPin(t.id)}
            onAuxClick={(e) => e.button === 1 && p.onClose(t.id)}
            title={t.file ? t.file : t.diff ? `${t.diff.path}\n${t.cwd}` :`${t.title}\n${t.cwd}${status ? `\n(${status})` : ''}`}
          >
            {t.kind === 'command' ? (
              <Zap size={13} className="tab-icon" />
            ) : t.kind === 'diff' ? (
              <FileDiff size={13} className="tab-icon" />
            ) : t.kind === 'file' ? (
              <FileText size={13} className="tab-icon" />
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
      <button className="tab-new" title="New terminal (Ctrl+Shift+T)" disabled={p.loc.missing || !p.loc.path} onClick={p.onNew}>
        <Plus size={16} />
      </button>
    </div>
  )
}
