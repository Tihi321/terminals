import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { clearFind, findInTerm, getTerm, onFindResults } from './termRegistry'

interface Props {
  termId: string
  /** Bumped by App when Ctrl+Shift+F is pressed again: focus and select the input. */
  focusToken: number
  onClose: () => void
}

/** Ctrl+Shift+F: find in one terminal's scrollback. Enter / Shift+Enter next / previous, Alt+C match case, Esc closes. */
export function FindBar({ termId, focusToken, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<{ resultIndex: number; resultCount: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => onFindResults(termId, setResult), [termId])
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])
  // Leaving the bar (tab hidden or closed) removes the highlights it made.
  useEffect(() => () => clearFind(termId), [termId])

  const search = (q: string, dir: 1 | -1, cs: boolean, incremental = false): void => {
    if (!q) {
      clearFind(termId)
      setResult(null)
      return
    }
    findInTerm(termId, q, { caseSensitive: cs, dir, incremental })
  }
  const close = (): void => {
    clearFind(termId)
    onClose()
    getTerm(termId)?.term.focus()
  }

  const count = !query
    ? ''
    : !result || result.resultCount === 0
    ? 'No results'
    : result.resultIndex < 0
    ? '1000+'
    : `${result.resultIndex + 1} of ${result.resultCount}`

  return (
    <div className="find-bar" role="search" aria-label="Find in terminal">
      <input
        ref={inputRef}
        className="find-input"
        autoFocus
        value={query}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value)
          search(e.target.value, 1, caseSensitive, true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          } else if (e.key === 'Enter' || e.key === 'F3') {
            e.preventDefault()
            search(query, e.shiftKey ? -1 : 1, caseSensitive)
          } else if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'c') {
            e.preventDefault()
            setCaseSensitive(!caseSensitive)
            search(query, 1, !caseSensitive, true)
          }
        }}
      />
      <span className={`find-count ${query && count === 'No results' ? 'none' : ''}`}>{count}</span>
      <button
        className={`icon-btn find-case ${caseSensitive ? 'on' : ''}`}
        title="Match case (Alt+C)"
        aria-pressed={caseSensitive}
        onClick={() => {
          setCaseSensitive(!caseSensitive)
          search(query, 1, !caseSensitive, true)
          inputRef.current?.focus()
        }}
      >
        Aa
      </button>
      <button className="icon-btn" title="Previous match (Shift+Enter)" onClick={() => search(query, -1, caseSensitive)}>
        <ChevronUp size={14} />
      </button>
      <button className="icon-btn" title="Next match (Enter)" onClick={() => search(query, 1, caseSensitive)}>
        <ChevronDown size={14} />
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={close}>
        <X size={14} />
      </button>
    </div>
  )
}
