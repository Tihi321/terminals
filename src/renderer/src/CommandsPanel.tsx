import { useState } from 'react'
import type { JSX } from 'react'
import {
  Check,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Square,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import type { AppState, Command, Snippet } from '../../shared/types'
import { CommandEditor } from './CommandEditor'
import { ownerInfo, remapCommandTargets } from './copyPaste'
import type { AppClipboard } from './copyPaste'
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
  const [clipboard, setClipboard] = useState<AppClipboard>(null)
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
          clipboard={clipboard}
          setClipboard={setClipboard}
        />
      ) : (
        <CommandsList {...p} clipboard={clipboard} setClipboard={setClipboard} />
      )}
    </div>
  )
}

function CommandsList({
  state,
  selected,
  runs,
  onRun,
  onStop,
  onSave,
  onDelete,
  onDuplicate,
  clipboard,
  setClipboard
}: Props & { clipboard: AppClipboard; setClipboard: (c: AppClipboard) => void }): JSX.Element {
  const [editing, setEditing] = useState<Command | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
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

  const commands = state.commands.filter(
    (c) => c.ownerId === 'global' || c.ownerId === selected.id || (selected.groupId && c.ownerId === selected.groupId)
  )

  const create = (): void =>
    setEditing({
      id: crypto.randomUUID(),
      name: '',
      ownerId: selected.id,
      mode: 'parallel',
      targets: [{ cwd: selected.path ?? '', steps: [] }]
    })

  const clipped = clipboard?.kind === 'command' ? clipboard.item : null
  const paste = (): void => {
    if (!clipped) return
    if (clipped.ownerId === 'global') {
      // Pasting a global command onto a location: '' targets follow that location's folder.
      // Without a folder (manual group) the pasted copy has nowhere to run, so it stays global.
      const dest = selected.path
      onSave({
        ...clipped,
        id: crypto.randomUUID(),
        ownerId: dest ? selected.id : 'global',
        targets: clipped.targets.map((t) => ({ cwd: t.cwd || dest || '', steps: [...t.steps] }))
      })
      return
    }
    onSave({
      ...clipped,
      id: crypto.randomUUID(),
      ownerId: selected.id,
      targets: remapCommandTargets(clipped.targets, ownerInfo(state, clipped.ownerId), ownerInfo(state, selected.id))
    })
  }

  const ownerName = (id: string): string | null => {
    if (id === 'global') return 'Global'
    if (id === selected.id) return null
    return state.groups.find((g) => g.id === id)?.name ?? null
  }

  return (
    <>
      <div className="panel-toolbar">
        <span className="toolbar-title">
          Saved on <b>{selected.name}</b>
        </span>
        <button
          className="btn small"
          onClick={paste}
          disabled={!clipped}
          title={clipped ? `Paste "${clipped.name}" here` : 'Copy a command first'}
        >
          <ClipboardPaste size={14} /> Paste
        </button>
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
          const needsPath = c.targets.some((t) => !t.cwd)
          return (
            <div key={c.id} className={`cmd-row ${run ? (run.stopped && !running ? 'is-stopped' : `is-${run.status}`) : ''}`}>
              <div className="cmd-main">
                <div className="cmd-name">
                  <span className="cmd-title">{c.name}</span>
                  {from && <span className="cmd-owner">{from}</span>}
                </div>
                <div
                  className="cmd-sub"
                  title={c.targets.map((t) => `${t.cwd || 'Selected folder'}\n  ${t.steps.join('\n  ')}`).join('\n')}
                >
                  <span className="mode">{c.mode}</span> ·{' '}
                  {c.targets.map((t) => `${t.cwd ? baseName(t.cwd) : 'selected folder'} (${t.steps.length})`).join(', ')}
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
                  <button
                    className="icon-btn"
                    title="Copy"
                    onClick={() => {
                      setClipboard({ kind: 'command', item: c })
                      setCopied(c.id)
                      setTimeout(() => setCopied((x) => (x === c.id ? null : x)), 1200)
                    }}
                  >
                    {copied === c.id ? <Check size={14} /> : <ClipboardCopy size={14} />}
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
                      title={
                        needsPath && !selected.path
                          ? `${selected.name} has no folder of its own; select a folder to run this global command`
                          : run
                            ? 'Run again'
                            : 'Run'
                      }
                      disabled={c.targets.length === 0 || (needsPath && !selected.path)}
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
