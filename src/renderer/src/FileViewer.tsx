import { memo, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { ExternalLink } from 'lucide-react'
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

/** Read-only file viewer tab: line-numbered text (no diff colouring), an image, or a binary/large notice. */
export function FileViewer({ path, root, fontSize }: Props): JSX.Element {
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let live = true
    setContent(null)
    setError(null)
    setShowAll(false)
    void window.api.readFile(path).then((r) => {
      if (!live) return
      if (r.ok) setContent(r.content)
      else setError(r.error)
    })
    return () => {
      live = false
    }
  }, [path])

  const lines = useMemo(() => (content?.kind === 'text' ? content.text.replace(/\r\n/g, '\n').split('\n') : []), [content])
  // A trailing newline does not start another line.
  const all = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  const capped = !showAll && all.length > LINE_CAP
  const visible = capped ? all.slice(0, LINE_CAP) : all

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
        <span className="git-fill" />
        <button className="btn small" onClick={() => void window.api.openInEditor(path)}>
          <ExternalLink size={13} /> Open in editor
        </button>
      </div>
      <div className="diff-scroll" style={{ fontFamily: TERM_FONT, fontSize }}>
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
