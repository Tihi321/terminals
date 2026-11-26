import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileDiff,
  FolderSearch,
  GitBranch,
  GitCompare,
  Minus,
  RefreshCw
} from 'lucide-react'
import type { GitBaseChanges, GitBaseFile, GitBranch as GitBranchInfo, GitCommit, GitDiffRequest, GitFile, GitNumstat, GitStatus } from '../../shared/types'
import { BranchPicker } from './BranchPicker'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { fileIcon } from './FileTree'
import { absPath, splitPath } from './gitUtil'

interface Props {
  /** Selected folder's directory, or null when the selection has none (manual groups). */
  root: string | null
  rootMissing: boolean
  onOpenDiff: (folder: string, spec: GitDiffRequest, pin: boolean) => void
}

type Section = 'staged' | 'tracked' | 'untracked'

const POLL_MS = 3000

const num = (n: number | null): number => n ?? 0

function pathsOf(f: GitFile): string[] {
  return f.origPath ? [f.path, f.origPath] : [f.path]
}

function letterOf(f: GitFile, section: Section): { ch: string; cls: string; label: string } {
  if (section === 'untracked') return letterOfStatus('U')
  if (f.conflicted) return { ch: '!', cls: 'del', label: 'Conflict' }
  return letterOfStatus((section === 'staged' ? f.staged : f.unstaged) ?? 'M')
}

function letterOfStatus(c: string): { ch: string; cls: string; label: string } {
  switch (c) {
    case 'U':
      return { ch: 'U', cls: 'add', label: 'Untracked' }
    case 'A':
      return { ch: 'A', cls: 'add', label: 'Added' }
    case 'D':
      return { ch: 'D', cls: 'del', label: 'Deleted' }
    case 'R':
      return { ch: 'R', cls: 'ren', label: 'Renamed' }
    case 'C':
      return { ch: 'C', cls: 'ren', label: 'Copied' }
    case 'T':
      return { ch: 'T', cls: 'mod', label: 'Type changed' }
    default:
      return { ch: 'M', cls: 'mod', label: 'Modified' }
  }
}

function Stat({ added, deleted }: { added: number | null; deleted: number | null }): JSX.Element {
  if (added === null || deleted === null) return <span className="git-stat dim">bin</span>
  // Empty cell, not null: its auto margin still pushes the checkbox to the row end.
  if (added === 0 && deleted === 0) return <span className="git-stat" />
  return (
    <span className="git-stat">
      {added > 0 && <span className="plus">+{added}</span>}
      {deleted > 0 && <span className="minus">−{deleted}</span>}
    </span>
  )
}

function Check3({ state, onClick, title }: { state: 'on' | 'off' | 'mixed'; onClick: () => void; title: string }): JSX.Element {
  return (
    <button
      className={`git-check ${state}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {state === 'on' ? <Check size={11} strokeWidth={3} /> : state === 'mixed' ? <Minus size={11} strokeWidth={3} /> : null}
    </button>
  )
}

export function GitPanel({ root, rootMissing, onOpenDiff }: Props): JSX.Element {
  const [sub, setSub] = useState<'changes' | 'history' | 'branch'>('changes')
  const [baseInfo, setBaseInfo] = useState<GitBaseChanges | null>(null)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [branchList, setBranchList] = useState<GitBranchInfo[]>([])
  const [baseSpinning, setBaseSpinning] = useState(false)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<{ text: string; notRepo: boolean } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [spinning, setSpinning] = useState(false)
  const [message, setMessage] = useState('')
  const [commitError, setCommitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState<'fetch' | 'pull' | 'push' | 'publish' | 'switch' | null>(null)
  const [picker, setPicker] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [openHash, setOpenHash] = useState<string | null>(null)
  const [commitFiles, setCommitFiles] = useState<Record<string, GitNumstat[] | string>>({})

  const rootRef = useRef(root)
  rootRef.current = root
  const inflight = useRef(false)
  const subRef = useRef(sub)
  subRef.current = sub
  const lastStatus = useRef('')
  const lastLog = useRef('')

  const refresh = useCallback(async (manual = false): Promise<void> => {
    const folder = rootRef.current
    if (!folder || inflight.current) return
    inflight.current = true
    if (manual) setSpinning(true)
    try {
      const [s, l] = await Promise.all([
        window.api.gitStatus(folder),
        subRef.current === 'history' ? window.api.gitLog(folder) : Promise.resolve(null)
      ])
      if (rootRef.current !== folder) return
      const key = JSON.stringify(s)
      if (key !== lastStatus.current) {
        lastStatus.current = key
        if (s.ok) {
          setStatus(s.status)
          setError(null)
        } else {
          setStatus(null)
          setError({ text: s.error, notRepo: !!s.notRepo })
        }
      }
      if (l) {
        const lkey = JSON.stringify(l)
        if (lkey !== lastLog.current) {
          lastLog.current = lkey
          if (l.ok) setCommits(l.commits)
        }
      }
      setLoaded(true)
    } finally {
      inflight.current = false
      if (manual) setSpinning(false)
    }
  }, [])

  // Folder changed: drop everything that belonged to the previous one and load fresh.
  useEffect(() => {
    lastStatus.current = ''
    lastLog.current = ''
    setStatus(null)
    setError(null)
    setLoaded(false)
    setCommits(null)
    setOpenHash(null)
    setCommitFiles({})
    setCommitError(null)
    inflight.current = false
    void refresh()
  }, [root, refresh])

  useEffect(() => {
    void refresh()
  }, [sub, refresh])

  const baseInflight = useRef(false)
  const lastBase = useRef('')

  const loadBase = useCallback(async (manual = false): Promise<void> => {
    const folder = rootRef.current
    if (!folder || baseInflight.current) return
    baseInflight.current = true
    if (manual) setBaseSpinning(true)
    try {
      const r = await window.api.gitBaseChanges(folder)
      if (rootRef.current !== folder) return
      const key = JSON.stringify(r)
      if (key === lastBase.current) return
      lastBase.current = key
      if (r.ok) {
        setBaseInfo(r.changes)
        setBaseError(null)
      } else {
        setBaseInfo(null)
        setBaseError(r.error)
      }
    } finally {
      baseInflight.current = false
      if (manual) setBaseSpinning(false)
    }
  }, [])

  // Folder changed: forget the previous folder's branch comparison.
  useEffect(() => {
    lastBase.current = ''
    baseInflight.current = false
    setBaseInfo(null)
    setBaseError(null)
    setBranchList([])
    void loadBase()
  }, [root, loadBase])

  // Current branch changed (switch, new worktree checkout): recompute whether the Branch view applies.
  const curBranch = status?.detached ? null : (status?.branch ?? null)
  useEffect(() => {
    void loadBase()
  }, [curBranch, loadBase])

  // While the Branch view is open: poll like the status, and keep the branch list for the base select.
  useEffect(() => {
    if (sub !== 'branch') return
    const folder = root
    if (folder)
      void window.api.gitBranches(folder).then((r) => {
        if (rootRef.current === folder && r.ok) setBranchList(r.branches)
      })
    const go = (): void => void loadBase()
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
  }, [sub, root, loadBase])

  // The user landed on the base branch while viewing the Branch tab: it no longer applies.
  useEffect(() => {
    if (sub === 'branch' && baseInfo?.onBase && !(baseInfo.baseIsSet && baseInfo.branch)) setSub('changes')
  }, [sub, baseInfo])

  const changeBase = async (value: string): Promise<void> => {
    const folder = root
    if (!folder) return
    await window.api.setRepoBase(folder, value === '' ? null : value)
    lastBase.current = ''
    baseInflight.current = false
    void loadBase(true)
  }

  useEffect(() => {
    const onFocus = (): void => void refresh()
    const poll = window.setInterval(() => {
      if (document.hasFocus() && !document.hidden) void refresh()
    }, POLL_MS)
    window.addEventListener('focus', onFocus)
    window.addEventListener('git-changed', onFocus)
    return () => {
      window.clearInterval(poll)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('git-changed', onFocus)
    }
  }, [refresh])

  const groups = useMemo(() => {
    const files = status?.files ?? []
    return {
      staged: files.filter((f) => f.staged !== null),
      tracked: files.filter((f) => f.unstaged !== null && !f.untracked),
      untracked: files.filter((f) => f.untracked)
    }
  }, [status])

  const changeCount = status?.files.length ?? 0
  const totals = useMemo(() => {
    let a = 0
    let d = 0
    for (const f of status?.files ?? []) {
      a += num(f.stagedAdded) + num(f.unstagedAdded)
      d += num(f.stagedDeleted) + num(f.unstagedDeleted)
    }
    return { a, d }
  }, [status])

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await fn()
      if (!r.ok) setCommitError(r.error ?? 'Git command failed')
      else setCommitError(null)
    } finally {
      setBusy(false)
      lastStatus.current = ''
      lastLog.current = ''
      inflight.current = false
      window.dispatchEvent(new Event('git-changed'))
    }
  }

  const stage = (files: GitFile[] | null): Promise<void> =>
    act(() => window.api.gitStage(root as string, files ? files.flatMap(pathsOf) : null))
  const unstage = (files: GitFile[] | null): Promise<void> =>
    act(() => window.api.gitUnstage(root as string, files ? files.flatMap(pathsOf) : null))

  const closePicker = useCallback(() => setPicker(false), [])

  const sync = async (kind: 'fetch' | 'pull' | 'push' | 'publish'): Promise<void> => {
    if (!root || busy || syncing) return
    setSyncing(kind)
    try {
      await act(() =>
        kind === 'fetch'
          ? window.api.gitFetch(root)
          : kind === 'pull'
            ? window.api.gitPull(root)
            : window.api.gitPush(root, kind === 'publish')
      )
    } finally {
      setSyncing(null)
    }
  }

  const switchBranch = async (name: string, opts: { create?: boolean; track?: boolean }): Promise<void> => {
    setPicker(false)
    if (!root || busy) return
    setSyncing('switch')
    try {
      await act(() => window.api.gitSwitch(root, name, opts))
    } finally {
      setSyncing(null)
    }
  }

  const syncMain: { kind: 'fetch' | 'pull' | 'push' | 'publish'; label: string; icon: JSX.Element | null } = !status?.upstream
    ? { kind: 'publish', label: 'Publish', icon: <ArrowUp size={12} /> }
    : status.behind > 0
      ? { kind: 'pull', label: `Pull ↓${status.behind}`, icon: null }
      : status.ahead > 0
        ? { kind: 'push', label: `Push ↑${status.ahead}`, icon: null }
        : { kind: 'fetch', label: 'Fetch', icon: <RefreshCw size={12} /> }
  const syncTitle =
    syncMain.kind === 'publish'
      ? 'Publish branch: git push -u <remote> <branch>'
      : syncMain.kind === 'pull'
        ? 'git pull --ff-only'
        : syncMain.kind === 'push'
          ? 'git push'
          : 'git fetch --prune'

  const stagedCount = groups.staged.length
  const trackedCount = groups.tracked.length
  const commitTracked = stagedCount === 0
  const canCommit = !busy && message.trim().length > 0 && (stagedCount > 0 || trackedCount > 0)

  const commit = async (): Promise<void> => {
    if (!canCommit || !root) return
    setBusy(true)
    try {
      const r = await window.api.gitCommit(root, message, commitTracked)
      if (r.ok) {
        setMessage('')
        setCommitError(null)
      } else setCommitError(r.error)
    } finally {
      setBusy(false)
      lastStatus.current = ''
      lastLog.current = ''
      inflight.current = false
      window.dispatchEvent(new Event('git-changed'))
    }
  }

  const rowMenu = (e: React.MouseEvent, f: GitFile, section: Section): void => {
    e.preventDefault()
    e.stopPropagation()
    const abs = status ? absPath(status.root, f.path) : null
    const spec = specFor(f, section)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Open diff', icon: <FileDiff size={14} />, onClick: () => root && onOpenDiff(root, spec, true) },
        { separator: true },
        { label: 'Open in editor', icon: <ExternalLink size={14} />, disabled: !abs, onClick: () => abs && void window.api.openInEditor(abs) },
        { label: 'Reveal in Explorer', icon: <FolderSearch size={14} />, disabled: !abs, onClick: () => abs && void window.api.revealInExplorer(abs) },
        { label: 'Copy path', icon: <Copy size={14} />, disabled: !abs, onClick: () => abs && void window.api.clipboardWrite(abs) },
        { label: 'Copy relative path', icon: <Copy size={14} />, onClick: () => void window.api.clipboardWrite(f.path) }
      ]
    })
  }

  const toggleCommit = (c: GitCommit): void => {
    if (openHash === c.hash) {
      setOpenHash(null)
      return
    }
    setOpenHash(c.hash)
    if (commitFiles[c.hash] || !root) return
    const folder = root
    void window.api.gitCommitFiles(folder, c.hash).then((r) => {
      if (rootRef.current !== folder) return
      setCommitFiles((m) => ({ ...m, [c.hash]: r.ok ? r.files : r.error }))
    })
  }

  if (!root) {
    return (
      <div className="panel-empty">
        <span className="empty-glyph">
          <GitBranch size={20} strokeWidth={1.75} />
        </span>
        <div>
          <div className="empty-title">No folder selected</div>
          <div className="empty-note">Select a folder to see its git changes.</div>
        </div>
      </div>
    )
  }
  if (rootMissing) {
    return (
      <div className="panel-empty">
        <div className="empty-note">This folder no longer exists on disk.</div>
      </div>
    )
  }

  const renderRow = (f: GitFile, section: Section): JSX.Element => {
    const { name, dir } = splitPath(f.path)
    const l = letterOf(f, section)
    const added = section === 'staged' ? f.stagedAdded : f.unstagedAdded
    const deleted = section === 'staged' ? f.stagedDeleted : f.unstagedDeleted
    const abs = status ? absPath(status.root, f.path) : null
    return (
      <div
        key={`${section}:${f.path}`}
        className="git-row"
        title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
        onClick={() => onOpenDiff(root, specFor(f, section), false)}
        onDoubleClick={() => onOpenDiff(root, specFor(f, section), true)}
        onContextMenu={(e) => rowMenu(e, f, section)}
      >
        <span className={`git-letter ${l.cls}`} title={l.label}>
          {l.ch}
        </span>
        <span className="git-ficon">{fileIcon(name)}</span>
        <span className="git-name">{name}</span>
        {(f.origPath || dir) && (
          <span className="git-dir">
            <bdi>{f.origPath ? `← ${f.origPath}` : dir}</bdi>
          </span>
        )}
        <span className="git-fill" />
        <Stat added={added} deleted={deleted} />
        <button
          className="git-open"
          title="Open in editor"
          disabled={!abs}
          onClick={(e) => {
            e.stopPropagation()
            if (abs) void window.api.openInEditor(abs)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ExternalLink size={12} />
        </button>
        <Check3
          state={section === 'staged' ? 'on' : 'off'}
          title={section === 'staged' ? 'Unstage' : 'Stage'}
          onClick={() => void (section === 'staged' ? unstage([f]) : stage([f]))}
        />
      </div>
    )
  }

  const renderSection = (key: Section, title: string, files: GitFile[]): JSX.Element | null => {
    if (files.length === 0) return null
    const staged = key === 'staged'
    return (
      <div className="git-section" key={key}>
        <div className="git-section-head">
          <Check3
            state={staged ? 'on' : 'off'}
            title={staged ? 'Unstage all in section' : 'Stage all in section'}
            onClick={() => void (staged ? unstage(files) : stage(files))}
          />
          <span className="git-section-title">{title}</span>
          <span className="git-count">{files.length}</span>
        </div>
        {files.map((f) => renderRow(f, key))}
      </div>
    )
  }

  const hasUnstaged = groups.tracked.length + groups.untracked.length > 0
  // Also shown when no base could be found (so one can be picked) and when the stored base is the current branch (so it can be changed).
  const noBase = baseError !== null && /No base branch found/.test(baseError) && curBranch !== null && curBranch !== 'main' && curBranch !== 'master'
  const showBranchTab =
    (baseInfo !== null && (!baseInfo.onBase || (baseInfo.baseIsSet && baseInfo.branch !== null))) || (sub === 'branch' && baseError !== null) || noBase

  /** Base picker: the current branch is not offered (a branch cannot be its own base). */
  const baseSelect = (stored: string | null, fallback: string | null, current: string | null): JSX.Element => {
    const choices = branchList.filter((b) => b.name !== current)
    const known = choices.some((b) => b.name === stored)
    return (
      <select className="git-base-select" value={stored ?? ''} title="Base branch" onChange={(e) => void changeBase(e.target.value)}>
        <option value="">{fallback ? `Default (${fallback})` : 'Default'}</option>
        {stored && !known && <option value={stored}>{stored}</option>}
        {choices
          .filter((b) => !b.remote)
          .map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        {choices
          .filter((b) => b.remote)
          .map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
      </select>
    )
  }

  const renderBranch = (): JSX.Element => {
    if (baseError) {
      return (
        <>
          <div className="git-header">
            <span className="git-header-title">
              <GitCompare size={14} />
              <span>vs</span>
              {baseSelect(null, null, curBranch)}
            </span>
          </div>
          <div className="git-scroll">
            <div className="panel-error">{baseError}</div>
          </div>
        </>
      )
    }
    if (!baseInfo) return <div className="panel-hint">Loading…</div>
    const bi = baseInfo
    const a = bi.files.reduce((n, f) => n + num(f.added), 0)
    const d = bi.files.reduce((n, f) => n + num(f.deleted), 0)
    const specOf = (f: GitBaseFile): GitDiffRequest =>
      f.status === 'U' ? { mode: 'untracked', path: f.path } : { mode: 'base', path: f.path, base: bi.mergeBase }
    const row = (f: GitBaseFile): JSX.Element => {
      const { name, dir } = splitPath(f.path)
      const abs = status ? absPath(status.root, f.path) : null
      const l = letterOfStatus(f.status)
      return (
        <div
          key={f.path}
          className="git-row"
          title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
          onClick={() => onOpenDiff(root, specOf(f), false)}
          onDoubleClick={() => onOpenDiff(root, specOf(f), true)}
        >
          <span className={`git-letter ${l.cls}`} title={l.label}>
            {l.ch}
          </span>
          <span className="git-ficon">{fileIcon(name)}</span>
          <span className="git-name">{name}</span>
          {(f.origPath || dir) && (
            <span className="git-dir">
              <bdi>{f.origPath ? `← ${f.origPath}` : dir}</bdi>
            </span>
          )}
          <span className="git-fill" />
          <Stat added={f.added} deleted={f.deleted} />
          <button
            className="git-open"
            title="Open in editor"
            disabled={!abs}
            onClick={(e) => {
              e.stopPropagation()
              if (abs) void window.api.openInEditor(abs)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={12} />
          </button>
        </div>
      )
    }
    return (
      <>
        <div className="git-header">
          <span className="git-header-title">
            <GitCompare size={14} />
            <span>vs</span>
            {baseSelect(bi.baseIsSet ? bi.base : null, bi.fallback, bi.branch)}
            {bi.files.length > 0 && (
              <span className="git-stat">
                <span className="plus">+{a}</span>
                <span className="minus">−{d}</span>
              </span>
            )}
          </span>
          <span className="git-fill" />
          <span className="git-note">
            {bi.ahead} commit{bi.ahead === 1 ? '' : 's'} ahead
          </span>
          <button className="icon-btn" title="Refresh" onClick={() => void loadBase(true)}>
            <RefreshCw size={14} className={baseSpinning ? 'spin' : ''} />
          </button>
        </div>
        <div className="git-scroll">
          {bi.onBase ? (
            <div className="panel-empty">
              <div>
                <div className="empty-title">On the base branch</div>
                <div className="empty-note">The stored base is the current branch. Pick another base or Default.</div>
              </div>
            </div>
          ) : bi.files.length === 0 ? (
            <div className="panel-empty">
              <span className="empty-glyph">
                <Check size={20} strokeWidth={1.75} />
              </span>
              <div>
                <div className="empty-title">No changes vs {bi.base}</div>
              </div>
            </div>
          ) : (
            <div className="git-section">{bi.files.map(row)}</div>
          )}
        </div>
      </>
    )
  }

  return (
    <div className="gitpanel">
      <div className="sub-switch">
        <div className="segmented">
          <button className={sub === 'changes' ? 'active' : ''} onClick={() => setSub('changes')}>
            Changes{changeCount > 0 ? ` (${changeCount})` : ''}
          </button>
          <button className={sub === 'history' ? 'active' : ''} onClick={() => setSub('history')}>
            History
          </button>
          {showBranchTab && (
            <button className={sub === 'branch' ? 'active' : ''} onClick={() => setSub('branch')}>
              Branch
            </button>
          )}
        </div>
      </div>

      {error ? (
        error.notRepo ? (
          <div className="panel-empty">
            <span className="empty-glyph">
              <GitBranch size={20} strokeWidth={1.75} />
            </span>
            <div>
              <div className="empty-title">Not a git repository</div>
              <div className="empty-note">Run git init in this folder to start tracking changes.</div>
            </div>
          </div>
        ) : (
          <div className="git-scroll">
            <div className="panel-error">{error.text}</div>
          </div>
        )
      ) : !loaded || !status ? (
        <div className="panel-hint">Loading…</div>
      ) : sub === 'changes' ? (
        <>
          <div className="git-header">
            <span className="git-header-title">
              <GitCompare size={14} />
              <span>View changes</span>
              {changeCount > 0 && (
                <span className="git-stat">
                  <span className="plus">+{totals.a}</span>
                  <span className="minus">−{totals.d}</span>
                </span>
              )}
            </span>
            <span className="git-fill" />
            <button className="icon-btn" title="Refresh" onClick={() => void refresh(true)}>
              <RefreshCw size={14} className={spinning ? 'spin' : ''} />
            </button>
            {stagedCount > 0 && !hasUnstaged ? (
              <button className="btn small" disabled={busy} onClick={() => void unstage(null)}>
                Unstage All
              </button>
            ) : (
              <>
                {stagedCount > 0 && (
                  <button className="btn small" disabled={busy} onClick={() => void unstage(null)}>
                    Unstage All
                  </button>
                )}
                <button className="btn small" disabled={busy || !hasUnstaged} onClick={() => void stage(null)}>
                  Stage All
                </button>
              </>
            )}
          </div>
          <div className="git-scroll">
            {changeCount === 0 ? (
              <div className="panel-empty">
                <span className="empty-glyph">
                  <Check size={20} strokeWidth={1.75} />
                </span>
                <div>
                  <div className="empty-title">No changes</div>
                  <div className="empty-note">The working tree is clean.</div>
                </div>
              </div>
            ) : (
              <>
                {renderSection('staged', 'Staged', groups.staged)}
                {renderSection('tracked', 'Changes', groups.tracked)}
                {renderSection('untracked', 'Untracked', groups.untracked)}
              </>
            )}
          </div>
          <div className="git-commit">
            <div className="git-branch">
              <div className="git-branch-anchor">
                <button
                  className={`git-branch-btn ${picker ? 'open' : ''}`}
                  title={
                    (status.upstream ? `${status.branch} → ${status.upstream}\n` : '') + 'Switch branch'
                  }
                  disabled={busy}
                  onClick={() => setPicker((v) => !v)}
                >
                  <GitBranch size={13} />
                  <span className="git-branch-name">{status.detached ? 'detached HEAD' : (status.branch ?? 'no branch')}</span>
                </button>
                {picker && <BranchPicker folder={root} onClose={closePicker} onPick={(n, o) => void switchBranch(n, o)} />}
              </div>
              {!status.hasCommits && <span className="git-note">no commits yet</span>}
              {status.behind > 0 && status.ahead > 0 && (
                <span className="git-ab" title={`${status.ahead} commit(s) ahead of ${status.upstream}`}>
                  <ArrowUp size={12} />
                  {status.ahead}
                </span>
              )}
              <span className="git-fill" />
              {!status.detached && (
                <div className="git-sync">
                  <button
                    className="btn small git-sync-main"
                    disabled={busy || syncing !== null || (!status.hasCommits && !status.upstream)}
                    title={syncTitle}
                    onClick={() => void sync(syncMain.kind)}
                  >
                    {syncing !== null ? <RefreshCw size={12} className="spin" /> : syncMain.icon}
                    <span>{syncMain.label}</span>
                  </button>
                  <button
                    className="btn small git-sync-caret"
                    title="Fetch, pull or push"
                    disabled={busy || syncing !== null}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      setMenu({
                        x: r.right - 160,
                        y: r.top - 108,
                        items: [
                          { label: 'Fetch', icon: <RefreshCw size={14} />, onClick: () => void sync('fetch') },
                          { label: 'Pull', icon: <ArrowDown size={14} />, onClick: () => void sync('pull') },
                          { label: 'Push', icon: <ArrowUp size={14} />, onClick: () => void sync('push') }
                        ]
                      })
                    }}
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>
              )}
            </div>
            <textarea
              className="git-message"
              rows={3}
              placeholder="Commit message (Ctrl+Enter to commit)"
              value={message}
              spellCheck={false}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                  e.preventDefault()
                  void commit()
                }
              }}
            />
            {commitError && <div className="panel-error git-error">{commitError}</div>}
            <button className="btn primary git-commit-btn" disabled={!canCommit} onClick={() => void commit()}>
              {commitTracked ? 'Commit Tracked' : 'Commit'}
            </button>
          </div>
        </>
      ) : sub === 'branch' ? (
        renderBranch()
      ) : (
        <div className="git-scroll">
          {commits === null ? (
            <div className="panel-hint">Loading…</div>
          ) : commits.length === 0 ? (
            <div className="panel-hint">No commits yet.</div>
          ) : (
            commits.map((c) => {
              const open = openHash === c.hash
              const files = commitFiles[c.hash]
              return (
                <div key={c.hash} className="git-commit-item">
                  <div className={`git-commit-row ${open ? 'open' : ''}`} onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
                    onClick={(e) => e.detail <= 1 && toggleCommit(c)}
                    title={c.subject}
                  >
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <div className="git-commit-main">
                      <div className="git-commit-subject">{c.subject || '(no message)'}</div>
                      <div className="git-commit-meta">
                        <span className="git-hash">{c.short}</span>
                        <span>{c.author}</span>
                        <span>{c.date}</span>
                      </div>
                    </div>
                  </div>
                  {open && (
                    <div className="git-commit-files">
                      {files === undefined ? (
                        <div className="panel-hint">Loading…</div>
                      ) : typeof files === 'string' ? (
                        <div className="panel-error">{files}</div>
                      ) : files.length === 0 ? (
                        <div className="panel-hint">No file changes.</div>
                      ) : (
                        files.map((f) => {
                          const { name, dir } = splitPath(f.path)
                          return (
                            <div
                              key={f.path}
                              className="git-row"
                              title={f.path}
                              onClick={() => onOpenDiff(root, { mode: 'commit', hash: c.hash, path: f.path }, false)}
                              onDoubleClick={() => onOpenDiff(root, { mode: 'commit', hash: c.hash, path: f.path }, true)}
                            >
                              <span className="git-ficon">{fileIcon(name)}</span>
                              <span className="git-name">{name}</span>
                              {dir && (
                                <span className="git-dir">
                                  <bdi>{dir}</bdi>
                                </span>
                              )}
                              <span className="git-fill" />
                              <Stat added={f.added} deleted={f.deleted} />
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

function specFor(f: GitFile, section: Section): GitDiffRequest {
  return { mode: section === 'staged' ? 'staged' : section === 'untracked' ? 'untracked' : 'unstaged', path: f.path }
}
