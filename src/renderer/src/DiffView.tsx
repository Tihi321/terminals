import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { ExternalLink, Minus, Plus } from 'lucide-react'
import type { GitDiffRequest, GitFile, GitStatus } from '../../shared/types'
import { absPath, diffModeLabel, parseDiff, splitPath } from './gitUtil'
import type { DiffLine, DiffSpec } from './gitUtil'

interface Props {
  spec: DiffSpec
  fontSize: number
  onChangeSpec: (spec: DiffSpec) => void
}

const LINE_CAP = 5000
const POLL_MS = 3000

const Rows = memo(function Rows({ lines }: { lines: DiffLine[] }): JSX.Element {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className={`dl ${l.kind}`}>
          <span className="dn">{l.oldNo ?? ''}</span>
          <span className="dn">{l.newNo ?? ''}</span>
          <span className="ds">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
          <span className="dt">{l.text === '' ? ' ' : l.text}</span>
        </div>
      ))}
    </>
  )
})

/** Read-only unified diff of one file. Not backed by a pty. */
export function DiffView({ spec, fontSize, onChangeSpec }: Props): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const specRef = useRef(spec)
  specRef.current = spec
  const inflight = useRef(false)
  const lastText = useRef<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (inflight.current) return
    inflight.current = true
    const s = specRef.current
    try {
      const req: GitDiffRequest = s.mode === 'commit' ? { mode: 'commit', path: s.path, hash: s.hash } : { mode: s.mode, path: s.path }
      const [d, st] = await Promise.all([window.api.gitDiff(s.folder, req), window.api.gitStatus(s.folder)])
      const cur = specRef.current
      if (cur.folder !== s.folder || cur.mode !== s.mode || cur.path !== s.path) return
      if (st.ok) setStatus(st.status)
      if (d.ok) {
        setError(null)
        if (d.text !== lastText.current) {
          lastText.current = d.text
          setText(d.text)
        }
        setTruncated(d.truncated)
      } else setError(d.error)
    } finally {
      inflight.current = false
    }
  }, [])

  const key = `${spec.folder}|${spec.mode}|${spec.path}|${spec.mode === 'commit' ? spec.hash : ''}`
  useEffect(() => {
    lastText.current = null
    setText(null)
    setError(null)
    setShowAll(false)
    inflight.current = false
    void load()
  }, [key, load])

  useEffect(() => {
    if (spec.mode === 'commit') return
    const go = (): void => void load()
    const poll = window.setInterval(() => {
      if (document.hasFocus() && !document.hidden) go()
    }, POLL_MS)
    window.addEventListener('focus', go)
    window.addEventListener('git-changed', go)
    return () => {
      window.clearInterval(poll)
      window.removeEventListener('focus', go)
      window.removeEventListener('git-changed', go)
    }
  }, [spec.mode, load])

  const parsed = useMemo(() => (text === null ? null : parseDiff(text)), [text])
  const file: GitFile | undefined = status?.files.find((f) => f.path === spec.path)
  const { name, dir } = splitPath(spec.path)
  const abs = status ? absPath(status.root, spec.path) : null
  const paths = file?.origPath ? [spec.path, file.origPath] : [spec.path]

  const stageAction = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (spec.mode === 'staged') {
        const r = await window.api.gitUnstage(spec.folder, paths)
        if (!r.ok) return void setError(r.error)
        const st = await window.api.gitStatus(spec.folder)
        const untracked = st.ok && st.status.files.some((f) => f.path === spec.path && f.untracked)
        onChangeSpec({ ...spec, mode: untracked ? 'untracked' : 'unstaged' })
      } else {
        const r = await window.api.gitStage(spec.folder, paths)
        if (!r.ok) return void setError(r.error)
        onChangeSpec({ ...spec, mode: 'staged' })
      }
      window.dispatchEvent(new Event('git-changed'))
    } finally {
      setBusy(false)
    }
  }

  const lines = parsed?.lines ?? []
  const capped = !showAll && lines.length > LINE_CAP
  const visible = capped ? lines.slice(0, LINE_CAP) : lines
  const otherMode =
    parsed && parsed.lines.length === 0 && !parsed.binary && file
      ? spec.mode === 'unstaged' && file.staged
        ? 'staged'
        : spec.mode === 'staged' && file.unstaged
          ? 'unstaged'
          : null
      : null

  return (
    <div className="diffview">
      <div className="diff-head">
        <div className="diff-path" title={spec.path}>
          <span className="diff-name">{name}</span>
          {dir && (
            <span className="git-dir">
              <bdi>{dir}</bdi>
            </span>
          )}
        </div>
        <span className="diff-mode">{diffModeLabel(spec)}</span>
        {parsed && !parsed.binary && (
          <span className="git-stat">
            <span className="plus">+{parsed.added}</span>
            <span className="minus">−{parsed.deleted}</span>
          </span>
        )}
        <span className="git-fill" />
        {spec.mode !== 'commit' && (
          <button className="btn small" disabled={busy} onClick={() => void stageAction()}>
            {spec.mode === 'staged' ? <Minus size={13} /> : <Plus size={13} />}
            {spec.mode === 'staged' ? 'Unstage' : 'Stage'}
          </button>
        )}
        <button className="btn small" disabled={!abs} onClick={() => abs && void window.api.openInEditor(abs)}>
          <ExternalLink size={13} /> Open in editor
        </button>
      </div>
      <div className="diff-scroll" style={{ fontFamily: 'var(--font-mono)', fontSize }}>
        {error ? (
          <div className="diff-msg error">{error}</div>
        ) : parsed === null ? (
          <div className="diff-msg">Loading…</div>
        ) : parsed.binary ? (
          <div className="diff-msg">Binary file: no text diff to show.</div>
        ) : parsed.lines.length === 0 ? (
          <div className="diff-msg">
            {parsed.meta.length > 0 ? parsed.meta.join('\n') : 'No changes to show for this view.'}
            {otherMode && (
              <div>
                <button className="btn small" onClick={() => onChangeSpec({ ...spec, mode: otherMode })}>
                  Show {otherMode} changes
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="diff-lines">
            {parsed.meta.length > 0 && <div className="diff-meta">{parsed.meta.join('  ·  ')}</div>}
            <Rows lines={visible} />
            {capped && (
              <div className="diff-more">
                Showing the first {LINE_CAP} of {lines.length} lines.
                <button className="btn small" onClick={() => setShowAll(true)}>
                  Show all
                </button>
              </div>
            )}
            {truncated && <div className="diff-more">The diff was cut off at 12 MB.</div>}
          </div>
        )}
      </div>
    </div>
  )
}
