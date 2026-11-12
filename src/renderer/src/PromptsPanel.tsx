import { useState } from 'react'
import type { JSX } from 'react'
import { Check, ClipboardCopy, CornerDownLeft, FileText, Pencil, Plus, TextCursorInput, Trash2 } from 'lucide-react'
import type { AppState, Snippet } from '../../shared/types'
import type { Loc } from './locations'
import { SnippetEditor, scopeLabel, visibleSnippets } from './SnippetEditor'
import { Keys } from './Keys'

interface Props {
  state: AppState
  selected: Loc | null
  onInsert: (body: string, enter: boolean) => void
  onSave: (s: Snippet) => void
  onDelete: (id: string) => void
  onCopy: (text: string) => void
}

export function PromptsPanel({ state, selected, onInsert, onSave, onDelete, onCopy }: Props): JSX.Element {
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const snippets = visibleSnippets(state, selected)
  const canPaste = !!selected?.path && !selected.missing

  const create = (): void => setEditing({ id: crypto.randomUUID(), name: '', body: '', scope: 'global' })

  return (
    <>
      <div className="panel-toolbar">
        <span className="toolbar-title">
          {selected ? (
            <>
              Global and <b>{selected.name}</b>
            </>
          ) : (
            <b>Global</b>
          )}
        </span>
        <button className="btn small primary" onClick={create} title="Create a saved prompt">
          <Plus size={14} /> New
        </button>
      </div>
      <div className="tree-scroll">
        {snippets.length === 0 && (
          <div className="panel-empty">
            <span className="empty-glyph">
              <FileText size={18} />
            </span>
            <div>
              Prompts are saved text snippets, such as a handoff prompt or a note. Insert one into the active terminal with a click, or press{' '}
              <Keys combo="Ctrl+Shift+P" />.
            </div>
          </div>
        )}
        {snippets.map((s) => (
          <div key={s.id} className="cmd-row">
            <div className="cmd-main">
              <div className="cmd-name">
                <span className="cmd-title">{s.name}</span>
                {s.scope !== 'global' && <span className="cmd-owner">{scopeLabel(state, s.scope)}</span>}
              </div>
              <div className="cmd-preview">{s.body.replace(/\s+/g, ' ')}</div>
            </div>
            <div className="cmd-foot">
              <div className="cmd-actions">
                <button
                  className="icon-btn"
                  title="Copy"
                  onClick={() => {
                    onCopy(s.body)
                    setCopied(s.id)
                    setTimeout(() => setCopied((c) => (c === s.id ? null : c)), 1200)
                  }}
                >
                  {copied === s.id ? <Check size={14} /> : <ClipboardCopy size={14} />}
                </button>
                <button className="icon-btn" title="Edit" onClick={() => setEditing(s)}>
                  <Pencil size={14} />
                </button>
                {confirmDelete === s.id ? (
                  <button
                    className="btn small danger"
                    title="Click again to delete"
                    onClick={() => {
                      setConfirmDelete(null)
                      onDelete(s.id)
                    }}
                    onBlur={() => setConfirmDelete(null)}
                    autoFocus
                  >
                    Confirm
                  </button>
                ) : (
                  <button className="icon-btn danger" title="Delete" onClick={() => setConfirmDelete(s.id)}>
                    <Trash2 size={14} />
                  </button>
                )}
                <button className="btn small" disabled={!canPaste} title="Insert and press Enter" onClick={() => onInsert(s.body, true)}>
                  <CornerDownLeft size={13} /> Send
                </button>
                <button
                  className="btn small primary"
                  disabled={!canPaste}
                  title="Insert into the active terminal (no Enter)"
                  onClick={() => onInsert(s.body, false)}
                >
                  <TextCursorInput size={13} /> Insert
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <SnippetEditor
          initial={editing}
          state={state}
          selected={selected}
          onCancel={() => setEditing(null)}
          onSave={(s) => {
            setEditing(null)
            onSave(s)
          }}
        />
      )}
    </>
  )
}
