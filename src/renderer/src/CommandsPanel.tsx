import { useState } from 'react'
import type { JSX } from 'react'
import { Check, Copy, FolderInput, Loader2, Pencil, Play, Plus, RotateCw, Square, Trash2, X, Zap } from 'lucide-react'
import type { AppState, Command, Snippet } from '../../shared/types'
import { CommandEditor } from './CommandEditor'
import { CopyToDialog, ownerInfo, remapCommandTargets } from './CopyToDialog'
import { PromptsPanel } from './PromptsPanel'
import { baseName } from './locations'
import type { Loc } from './locations'

export interface RunInfo {
  runId: string
  status: 'running' | 'success' | 'failed'
  /** First failing exit code, when there is one. */
  exitCode?: number
  stopped?: boolean
  /** Targets finished successfully / total. */
  done: number
  total: number
}

interface Props {
  state: AppState
  selected: Loc | null
  runs: Record<string, RunInfo>
  onRun: (cmd: Command) => void
  onStop: (cmd: Command) => void
  onSave: (cmd: Command) => void
  onDelete: (id: string) => void
  onDuplicate: (cmd: Command) => void
  onInsertSnippet: (body: string, enter: boolean) => void
  onSaveSnippet: (s: Snippet) => void
  onDeleteSnippet: (id: string) => void
  onCopy: (text: string) => void
}

function Status({ run }: { run?: RunInfo }): JSX.Element {
  if (!run) return <span className="cmd-status idle">Not run yet</span>
  if (run.status === 'running')
    return (
      <span className="cmd-status running">
        <Loader2 size={12} strokeWidth={2.5} className="spin" /> running {run.done}/{run.total}
      </span>
    )
  if (run.status === 'success')
    return (
      <span className="cmd-status success">
        <Check size={12} strokeWidth={2.5} /> success
      </span>
    )
  return (
    <span className={`cmd-status failed${run.stopped ? ' stopped' : ''}`}>
      {run.stopped ? <Square size={10} strokeWidth={2.5} /> : <X size={12} strokeWidth={2.5} />}{' '}
      {run.stopped ? 'stopped' : run.exitCode !== undefined ? `failed (exit ${run.exitCode})` : 'failed'}
    </span>
  )
}

export function CommandsPanel(p: Props): JSX.Element {
  const [sub, setSub] = useState<'commands' | 'prompts'>('commands')
  return (
    <div className="commands">
      <div className="sub-switch">
        <div className="segmented">
          <button className={sub === 'commands' ? 'active' : ''} onClick={() => setSub('commands')}>
            Commands
          </button>
          <button className={sub === 'prompts' ? 'active' : ''} onClick={() => setSub('prompts')}>
            Prompts
          </button>
        </div>
      </div>
      {sub === 'prompts' ? (
        <PromptsPanel
          state={p.state}
          selected={p.selected}
          onInsert={p.onInsertSnippet}
          onSave={p.onSaveSnippet}
          onDelete={p.onDeleteSnippet}
          onCopy={p.onCopy}
        />
      ) : (
        <CommandsList {...p} />
      )}
    </div>
  )
}

function CommandsList({ state, selected, runs, onRun, onStop, onSave, onDelete, onDuplicate }: Props): JSX.Element {
  const [editing, setEditing] = useState<Command | null>(null)
  const [copying, setCopying] = useState<Command | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  if (!selected) {
    return (
      <div className="panel-empty">
        <span className="empty-glyph">
          <Zap size={18} />
        </span>
        <div>Select a folder or group to see its commands</div>
      </div>
    )
  }

  const commands = state.commands.filter((c) => c.ownerId === selected.id || (selected.groupId && c.ownerId === selected.groupId))

  const create = (): void =>
    setEditing({
      id: crypto.randomUUID(),
      name: '',
      ownerId: selected.id,
      mode: 'parallel',
      targets: [{ cwd: selected.path ?? '', steps: [] }]
    })

  const ownerName = (id: string): string | null => {
    if (id === selected.id) return null
    return state.groups.find((g) => g.id === id)?.name ?? null
  }

  return (
    <>
      <div className="panel-toolbar">
        <span className="toolbar-title">
          Saved on <b>{selected.name}</b>
        </span>
        <button className="btn small primary" onClick={create} title="Create a saved command">
          <Plus size={14} /> New
        </button>
      </div>
      <div className="tree-scroll">
        {commands.length === 0 && (
          <div className="panel-empty">
            <span className="empty-glyph">
              <Zap size={18} />
            </span>
            <div>No saved commands yet. Create one to run steps in several folders with one click.</div>
          </div>
        )}
        {commands.map((c) => {
          const run = runs[c.id]
          const running = run?.status === 'running'
          const from = ownerName(c.ownerId)
          return (
            <div key={c.id} className={`cmd-row ${run ? (run.stopped && !running ? 'is-stopped' : `is-${run.status}`) : ''}`}>
              <div className="cmd-main">
                <div className="cmd-name">
                  <span className="cmd-title">{c.name}</span>
                  {from && <span className="cmd-owner">{from}</span>}
                </div>
                <div className="cmd-sub" title={c.targets.map((t) => `${t.cwd}\n  ${t.steps.join('\n  ')}`).join('\n')}>
                  <span className="mode">{c.mode}</span> · {c.targets.map((t) => `${baseName(t.cwd)} (${t.steps.length})`).join(', ')}
                </div>
              </div>
              <div className="cmd-foot">
                <Status run={run} />
                <div className="cmd-actions">
                  <button className="icon-btn" title="Edit" onClick={() => setEditing(c)}>
                    <Pencil size={14} />
                  </button>
                  <button className="icon-btn" title="Duplicate" onClick={() => onDuplicate(c)}>
                    <Copy size={14} />
                  </button>
                  <button className="icon-btn" title="Copy to…" onClick={() => setCopying(c)}>
                    <FolderInput size={14} />
                  </button>
                  {confirmDelete === c.id ? (
                    <button
                      className="btn small danger"
                      title="Click again to delete"
                      onClick={() => {
                        setConfirmDelete(null)
                        onDelete(c.id)
                      }}
                      onBlur={() => setConfirmDelete(null)}
                      autoFocus
                    >
                      Confirm
                    </button>
                  ) : (
                    <button className="icon-btn danger" title="Delete" onClick={() => setConfirmDelete(c.id)}>
                      <Trash2 size={14} />
                    </button>
                  )}
                  {running ? (
                    <button className="btn small danger" onClick={() => onStop(c)} title="Stop: kills this run's terminals">
                      <Square size={12} /> Stop
                    </button>
                  ) : (
                    <button
                      className="btn small primary"
                      onClick={() => onRun(c)}
                      title={run ? 'Run again' : 'Run'}
                      disabled={c.targets.length === 0}
                    >
                      {run ? <RotateCw size={13} /> : <Play size={13} />} {run ? 'Run again' : 'Run'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {copying && (
        <CopyToDialog
          noun="command"
          state={state}
          currentOwnerId={copying.ownerId}
          onCancel={() => setCopying(null)}
          onCopy={(destId) => {
            const src = copying
            setCopying(null)
            onSave({
              ...src,
              id: crypto.randomUUID(),
              ownerId: destId,
              targets: remapCommandTargets(src.targets, ownerInfo(state, src.ownerId), ownerInfo(state, destId))
            })
          }}
        />
      )}
      {editing && (
        <CommandEditor
          initial={editing}
          state={state}
          selected={selected}
          onCancel={() => setEditing(null)}
          onSave={(cmd) => {
            setEditing(null)
            onSave(cmd)
          }}
        />
      )}
    </>
  )
}
