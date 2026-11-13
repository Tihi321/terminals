import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { ExternalLink, Pencil } from 'lucide-react'
import type { FileContent } from '../../shared/types'
import { TERM_FONT } from './termRegistry'
import { splitPath } from './gitUtil'
import { relPath } from './locations'

interface Props {
  /** Absolute path. */
  path: string
  /** Folder the tab belongs to, for the muted relative path. */
  root: string | null
  fontSize: number
}

const LINE_CAP = 5000
const LINE_HEIGHT = 1.5

type TextContent = Extract<FileContent, { kind: 'text' }>
type Notice = { kind: 'conflict' } | { kind: 'error'; msg: string }

/**
 * Unsaved drafts by absolute path, so they survive the viewer unmounting (tab switch, preview tab reuse, close and reopen).
 * `mtimeMs` is the mtime of the file content the draft was based on, so a later save still detects outside changes.
 */
const drafts = new Map<string, { draft: string; mtimeMs: number }>()

const Rows = memo(function Rows({ lines }: { lines: string[] }): JSX.Element {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className="dl">
          <span className="dn">{i + 1}</span>
          <span className="dt">{l === '' ? ' ' : l}</span>
        </div>
      ))}
    </>
  )
})

/** Splits file text into the editable body (BOM removed, `\n` endings) plus what is needed to restore it on save. */
function analyse(text: string): { body: string; bom: boolean; crlf: boolean; tabs: boolean } {
  const bom = text.charCodeAt(0) === 0xfeff
  const raw = bom ? text.slice(1) : text
  const crlfCount = (raw.match(/\r\n/g) ?? []).length
  const lfCount = (raw.match(/\n/g) ?? []).length - crlfCount
  const tabLines = (raw.match(/^\t/gm) ?? []).length
  const spaceLines = (raw.match(/^ {2,}\S/gm) ?? []).length
  return { body: raw.replace(/\r\n/g, '\n'), bom, crlf: crlfCount > lfCount, tabs: tabLines > spaceLines }
}

/** File viewer tab: line-numbered text (no diff colouring), an image, or a binary/large notice. Text files open read-only; Edit (or `i`) switches to a plain-textarea editor with Save. */
export function FileViewer({ path, root, fontSize }: Props): JSX.Element {
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const pathRef = useRef(path)
  pathRef.current = path
  const scrollRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  /** Set when switching modes: the scroll offset (px) and caret line to land on, applied in the layout effect. */
  const pending = useRef<{ top: number; line: number } | null>(null)
  /** mtime of the content the current draft is based on; sent as the expected mtime on save. */
  const baseMtime = useRef(0)
  const lineH = fontSize * LINE_HEIGHT

  const resetEdit = (): void => {
    setEditing(false)
    setDraft('')
    setSaving(false)
    setNotice(null)
    setConfirmDiscard(false)
  }

  useEffect(() => {
    let live = true
    setContent(null)
    setError(null)
    setShowAll(false)
    resetEdit()
    pending.current = null
    void window.api.readFile(path).then((r) => {
      if (!live) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      setContent(r.content)
      // The only way a file opens in edit mode: an unsaved draft from an earlier visit.
      const saved = drafts.get(path)
      if (saved && r.content.kind === 'text') {
        baseMtime.current = saved.mtimeMs
        pending.current = { top: 0, line: 0 }
        setDraft(saved.draft)
        setEditing(true)
      } else drafts.delete(path)
    })
    return () => {
      live = false
    }
  }, [path])

  const info = useMemo(() => (content?.kind === 'text' ? analyse(content.text) : null), [content])
  const lines = useMemo(() => (content?.kind === 'text' ? content.text.replace(/\r\n/g, '\n').split('\n') : []), [content])
  // A trailing newline does not start another line.
  const all = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  const capped = !showAll && all.length > LINE_CAP
  const visible = capped ? all.slice(0, LINE_CAP) : all
  const dirty = editing && info !== null && draft !== info.body
  const draftLines = useMemo(() => (editing ? draft.split('\n').length : 0), [editing, draft])

  const enterEdit = useCallback(() => {
    if (!info || editing) return
    const top = scrollRef.current?.scrollTop ?? 0
    pending.current = { top, line: Math.round(top / lineH) }
    baseMtime.current = content?.kind === 'text' ? content.mtimeMs : 0
    setDraft(info.body)
    setNotice(null)
    setConfirmDiscard(false)
    setEditing(true)
  }, [info, content, editing, lineH])

  /** Updates the draft and mirrors it into the module-level store (removed again when it matches the file). */
  const changeDraft = (v: string): void => {
    setDraft(v)
    if (info && v !== info.body) drafts.set(path, { draft: v, mtimeMs: baseMtime.current })
    else drafts.delete(path)
  }

  // Every exit (save, discard, reload, clean cancel) means the draft is gone for good.
  const leaveEdit = useCallback(() => {
    const ta = areaRef.current
    pending.current = { top: ta ? Math.round(ta.scrollTop / lineH) * lineH : 0, line: -1 }
    drafts.delete(path)
    resetEdit()
  }, [lineH, path])

  useLayoutEffect(() => {
    const p = pending.current
    if (!p) return
    pending.current = null
    if (editing) {
      const ta = areaRef.current
      if (!ta) return
      ta.focus({ preventScroll: true })
      let off = 0
      for (let i = 0; i < p.line; i++) {
        const nl = ta.value.indexOf('\n', off)
        if (nl < 0) break
        off = nl + 1
      }
      ta.setSelectionRange(off, off)
      ta.scrollTop = p.top
      if (gutterRef.current) gutterRef.current.scrollTop = p.top
    } else if (scrollRef.current) {
      scrollRef.current.scrollTop = p.top
      scrollRef.current.focus({ preventScroll: true })
    }
  }, [editing])

  const cancel = (): void => {
    if (dirty) setConfirmDiscard(true)
    else leaveEdit()
  }

  const save = async (force: boolean): Promise<void> => {
    if (content?.kind !== 'text' || !info || saving) return
    if (!force && !dirty) {
      leaveEdit()
      return
    }
    setSaving(true)
    setNotice(null)
    const text = (info.bom ? '\uFEFF' : '') + (info.crlf ? draft.replace(/\n/g, '\r\n') : draft)
    const r = await window.api.writeFile(path, text, baseMtime.current, force)
    if (pathRef.current !== path) return
    setSaving(false)
    if (r.ok) {
      const next: TextContent = { kind: 'text', text, mtimeMs: r.mtimeMs }
      setContent(next)
      leaveEdit()
    } else if (r.conflict) setNotice({ kind: 'conflict' })
    else setNotice({ kind: 'error', msg: r.error })
  }

  const reload = (): void => {
    const p = path
    void window.api.readFile(p).then((r) => {
      if (pathRef.current !== p) return
      if (r.ok) {
        setContent(r.content)
        setError(null)
        leaveEdit()
      } else setNotice({ kind: 'error', msg: r.error })
    })
  }

  const onAreaKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (confirmDiscard) setConfirmDiscard(false)
      else cancel()
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      if (e.shiftKey) return
      const ta = e.currentTarget
      const indent = info?.tabs ? '\t' : '  '
      // execCommand keeps the textarea's own undo history; setRangeText is the fallback.
      if (!document.execCommand('insertText', false, indent)) {
        ta.setRangeText(indent, ta.selectionStart, ta.selectionEnd, 'end')
        changeDraft(ta.value)
      }
    }
  }

  const onViewKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key !== 'i') return
    if (!info) return
    e.preventDefault()
    enterEdit()
  }

  const { name } = splitPath(path.replace(/\\/g, '/'))
  const rel = root ? relPath(root, path).replace(/\\/g, '/') : path
  const dir = splitPath(rel).dir

  return (
    <div className="diffview">
      <div className="diff-head">
        <div className="diff-path" title={path}>
          <span className="diff-name">{name}</span>
          {dir && (
            <span className="git-dir">
              <bdi>{dir}</bdi>
            </span>
          )}
        </div>
        {dirty && (
          <span className="diff-dirty" title="Unsaved changes">
            ●
          </span>
        )}
        {editing && <span className="diff-hint">-- INSERT --</span>}
        <span className="git-fill" />
        {editing ? (
          <>
            {confirmDiscard ? (
              <>
                <span className="diff-prompt">Discard changes?</span>
                <button className="btn small danger" onClick={leaveEdit} autoFocus>
                  Discard
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    setConfirmDiscard(false)
                    areaRef.current?.focus({ preventScroll: true })
                  }}
                >
                  Keep editing
                </button>
              </>
            ) : (
              <>
                <button className="btn small primary" disabled={!dirty || saving} title="Save (Ctrl+S)" onClick={() => void save(false)}>
                  Save
                </button>
                <button className="btn small" title="Cancel (Esc)" onClick={cancel}>
                  Cancel
                </button>
              </>
            )}
          </>
        ) : (
          info && (
            <button className="btn small" title="Edit (i)" onClick={enterEdit}>
              <Pencil size={13} /> Edit
            </button>
          )
        )}
        <button className="btn small" onClick={() => void window.api.openInEditor(path)}>
          <ExternalLink size={13} /> Open in editor
        </button>
      </div>
      {notice && (
        <div className="diff-notice">
          {notice.kind === 'conflict' ? (
            <>
              <span>The file changed on disk since you opened it.</span>
              <button className="btn small" disabled={saving} onClick={() => void save(true)}>
                Overwrite
              </button>
              <button className="btn small" onClick={reload}>
                Reload
              </button>
            </>
          ) : (
            <span>{notice.msg}</span>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        className={'diff-scroll' + (editing ? ' editing' : '')}
        style={{ fontFamily: TERM_FONT, fontSize }}
        tabIndex={editing ? -1 : 0}
        onKeyDown={editing ? undefined : onViewKey}
      >
        {error ? (
          <div className="diff-msg error">{error}</div>
        ) : content === null ? (
          <div className="diff-msg">Loading…</div>
        ) : content.kind === 'binary' ? (
          <div className="diff-msg">
            Binary or large file — Open in editor
            <div>
              <button className="btn small" onClick={() => void window.api.openInEditor(path)}>
                <ExternalLink size={13} /> Open in editor
              </button>
            </div>
          </div>
        ) : content.kind === 'image' ? (
          <div className="file-image">
            <img src={content.dataUrl} alt={name} />
          </div>
        ) : editing ? (
          <>
            <div ref={gutterRef} className="edit-gutter" aria-hidden>
              {Array.from({ length: draftLines }, (_, i) => i + 1).join('\n')}
            </div>
            <textarea
              ref={areaRef}
              className="edit-area"
              wrap="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => changeDraft(e.target.value)}
              onKeyDown={onAreaKey}
              onScroll={(e) => {
                if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop
              }}
            />
          </>
        ) : (
          <div className="diff-lines">
            <Rows lines={visible} />
            {capped && (
              <div className="diff-more">
                Showing the first {LINE_CAP} of {all.length} lines.
                <button className="btn small" onClick={() => setShowAll(true)}>
                  Show all
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
