import { useState } from 'react'
import type { JSX } from 'react'
import { Check, Copy, Loader2, Pencil, Play, Plus, RotateCw, Square, Trash2, X, Zap } from 'lucide-react'
import type { AppState, Command } from '../../shared/types'
import { CommandEditor } from './CommandEditor'
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
}

function Status({ run }: { run?: RunInfo }): JSX.Element {
  if (!run) return <span className="cmd-status idle">idle</span>
  if (run.status === 'running')
    return (
      <span className="cmd-status running">
        <Loader2 size={13} className="spin" /> running {run.done}/{run.total}
      </span>
    )
  if (run.status === 'success')
    return (
      <span className="cmd-status success">
        <Check size={13} /> success
      </span>
    )
  return (
    <span className="cmd-status failed">
      <X size={13} /> {run.stopped ? 'stopped' : run.exitCode !== undefined ? `failed (exit ${run.exitCode})` : 'failed'}
    </span>
  )
}

export function CommandsPanel({ state, selected, runs, onRun, onStop, onSave, onDelete, onDuplicate }: Props): JSX.Element {
  const [editing, setEditing] = useState<Command | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  if (!selected) {
    return (
      <div className="panel-empty">
        <Zap size={28} />
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
    <div className="commands">
      <div className="panel-toolbar">
        <span className="toolbar-title">Commands for {selected.name}</span>
        <button className="btn small primary" onClick={create} title="Create a saved command">
          <Plus size={14} /> New
        </button>
      </div>
      <div className="tree-scroll">
        {commands.length === 0 && (
          <div className="panel-empty">
            <Zap size={28} />
            <div>No saved commands yet. Create one to run steps in several folders with one click.</div>
          </div>
        )}
        {commands.map((c) => {
          const run = runs[c.id]
          const running = run?.status === 'running'
          const from = ownerName(c.ownerId)
          return (
            <div key={c.id} className="cmd-row">
              <div className="cmd-main">
                <div className="cmd-name">
                  {c.name}
                  {from && <span className="cmd-owner">{from}</span>}
                </div>
                <div className="cmd-sub">
                  {c.mode} · {c.targets.map((t) => `${baseName(t.cwd)} (${t.steps.length})`).join(', ')}
                </div>
                <Status run={run} />
              </div>
              <div className="cmd-actions">
                {running ? (
                  <button className="btn small danger" onClick={() => onStop(c)} title="Stop: kills this run's terminals">
                    <Square size={13} /> Stop
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
                <button className="icon-btn" title="Edit" onClick={() => setEditing(c)}>
                  <Pencil size={14} />
                </button>
                <button className="icon-btn" title="Duplicate" onClick={() => onDuplicate(c)}>
                  <Copy size={14} />
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
              </div>
            </div>
          )
        })}
      </div>
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
    </div>
  )
}
