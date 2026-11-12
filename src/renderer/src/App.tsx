import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, FolderTree, FolderX, GitBranch, Group, PanelLeftClose, PanelLeftOpen, PanelRightClose, Plus, SquareTerminal, Terminal, X, Zap } from 'lucide-react'
import type { AppState, Command, GitDiffRequest } from '../../shared/types'
import { Sidebar } from './Sidebar'
import { TerminalView } from './TerminalView'
import { FileTree } from './FileTree'
import { CommandsPanel } from './CommandsPanel'
import { GitPanel } from './GitPanel'
import { DiffView } from './DiffView'
import { diffTitle } from './gitUtil'
import type { DiffSpec } from './gitUtil'
import { SnippetPicker } from './SnippetPicker'
import { TabBar, TAB_DRAG_TYPE, LOC_DRAG_TYPE, locDrag } from './TabBar'
import type { Tab } from './TabBar'
import {
  canAddPane,
  closePane,
  dragDivider,
  dropOnEdge,
  focusLoc,
  fromPersisted,
  indexOfLoc,
  normalize,
  openToSide,
  paneAt,
  startOf,
  toPersisted
} from '../../shared/panes'
import type { PaneState, Side } from '../../shared/panes'
import { Keys } from './Keys'
import { visibleSnippets } from './SnippetEditor'
import type { RunInfo } from './CommandsPanel'
import { baseName, buildLocs } from './locations'
import { createTerm, getTerm, pasteInto, setTermHooks, setTerminalFontSize, DEFAULT_FONT_SIZE } from './termRegistry'

interface RunCtl {
  cmd: Command
  locId: string
  nextIndex: number
  stopped: boolean
}

const MIN_PANE_PX = 240
const mkId = (): string => crypto.randomUUID()

function shellLabel(shell: string): string {
  const base = shell.split(/[\\/]/).pop() ?? shell
  return base.replace(/\.exe$/i, '') || 'shell'
}

function ResizeHandle({ onDrag, onEnd }: { onDrag: (clientX: number) => void; onEnd: () => void }): JSX.Element {
  return (
    <div
      className="resize-handle"
      onMouseDown={(e) => {
        e.preventDefault()
        document.body.classList.add('resizing')
        const move = (ev: MouseEvent): void => onDrag(ev.clientX)
        const up = (): void => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          document.body.classList.remove('resizing')
          onEnd()
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
    />
  )
}

export function App(): JSX.Element {
  const [state, setStateRaw] = useState<AppState | null>(null)
  const stateRef = useRef<AppState | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const tabsRef = useRef<Tab[]>([])
  const [activeByLoc, setActiveByLoc] = useState<Record<string, string>>({})
  const [runs, setRunsRaw] = useState<Record<string, RunInfo>>({})
  const runsRef = useRef<Record<string, RunInfo>>({})
  const runCtl = useRef(new Map<string, RunCtl>())
  const latestRun = useRef<Record<string, string>>({})
  const counters = useRef<Record<string, number>>({})
  const [pickerOpen, setPickerOpen] = useState(false)
  const [paneState, setPaneState] = useState<PaneState | null>(null)
  const panesRef = useRef<PaneState | null>(null)
  const panesEl = useRef<HTMLDivElement>(null)
  const lastSelected = useRef<string | null>(null)
  const dragTab = useRef<Tab | null>(null)
  const [dropHint, setDropHint] = useState<{ index: number; side: Side } | null>(null)
  const [widths, setWidths] = useState<{ sb: number; panel: number } | null>(null)
  const widthsRef = useRef(widths)
  widthsRef.current = widths

  const setState = useCallback((s: AppState) => {
    stateRef.current = s
    setStateRaw(s)
  }, [])
  const commitTabs = useCallback((fn: (t: Tab[]) => Tab[]) => {
    tabsRef.current = fn(tabsRef.current)
    setTabs(tabsRef.current)
  }, [])
  const setRuns = useCallback((fn: (r: Record<string, RunInfo>) => Record<string, RunInfo>) => {
    runsRef.current = fn(runsRef.current)
    setRunsRaw(runsRef.current)
  }, [])
  const refresh = useCallback(async () => setState(await window.api.getState()), [setState])

  useEffect(() => {
    void window.api.getState().then((s) => {
      setState(s)
      const valid = new Set(buildLocs(s).keys())
      let ps = fromPersisted(s.ui.panes, valid, s.selectedId, mkId)
      if (s.selectedId && valid.has(s.selectedId)) ps = focusLoc(ps, s.selectedId)
      lastSelected.current = s.selectedId
      panesRef.current = ps
      setPaneState(ps)
      const stored = toPersisted(ps)
      if (stored && JSON.stringify(stored) !== JSON.stringify(s.ui.panes)) void window.api.setUi({ panes: stored })
      setWidths({ sb: s.ui.sidebarWidth, panel: s.ui.panelWidth })
      setTerminalFontSize(s.settings.terminalFontSize)
    })
    // Rescan parent folders and re-check existence when coming back to the window.
    const onFocus = (): void => void window.api.getState().then(setState)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [setState])

  const selectedId = state?.selectedId ?? null
  const locs = useMemo(() => (state ? buildLocs(state) : new Map()), [state])
  const selected = (selectedId && locs.get(selectedId)) || null

  const select = useCallback(async (id: string | null) => setState(await window.api.select(id)), [setState])

  /** Applies a new pane layout; the layout is persisted unless it is a transient drag step. */
  const setPanes = useCallback((next: PaneState, persist = true) => {
    panesRef.current = next
    setPaneState(next)
    if (!persist) return
    const p = toPersisted(next)
    if (p) void window.api.setUi({ panes: p })
  }, [])

  /** Applies a layout and makes the store's selection follow the focused pane (selectedId == focused pane's location). */
  const commitPanes = useCallback(
    (next: PaneState) => {
      setPanes(next)
      const loc = next.panes[next.focused].locId
      if (loc && loc !== stateRef.current?.selectedId) void select(loc)
    },
    [setPanes, select]
  )

  // Keep the layout valid when locations disappear, and follow selection changes (sidebar click, new folder, removal).
  useEffect(() => {
    const cur = panesRef.current
    if (!state || !cur) return
    const valid = new Set(locs.keys())
    let next = normalize(cur, valid, state.selectedId, mkId)
    if (state.selectedId !== lastSelected.current) {
      lastSelected.current = state.selectedId
      if (state.selectedId && valid.has(state.selectedId)) next = focusLoc(next, state.selectedId)
    }
    if (next !== cur) setPanes(next)
  }, [state, locs, setPanes])

  const focusPane = useCallback(
    (index: number) => {
      const cur = panesRef.current
      if (cur && cur.focused !== index) commitPanes({ ...cur, focused: index })
    },
    [commitPanes]
  )

  const openLocToSide = useCallback(
    (locId: string) => {
      const cur = panesRef.current
      if (cur) commitPanes(openToSide(cur, locId, mkId))
    },
    [commitPanes]
  )

  const closePaneById = useCallback(
    (paneId: string) => {
      const cur = panesRef.current
      if (!cur) return
      commitPanes(closePane(cur, cur.panes.findIndex((p) => p.id === paneId)))
    },
    [commitPanes]
  )

  /** Which pane a tab drag is over and on which half, or null when dropping there would do nothing. */
  const dropTargetAt = (e: React.DragEvent): { index: number; side: Side; locId: string; tabId?: string } | null => {
    const el = panesEl.current
    const cur = panesRef.current
    if (!el || !cur) return null
    const types = e.dataTransfer.types
    const tab = types.includes(TAB_DRAG_TYPE) ? dragTab.current : null
    const locId = tab ? tab.locId : types.includes(LOC_DRAG_TYPE) ? locDrag.id : null
    if (!locId) return null
    const r = el.getBoundingClientRect()
    const { index, within } = paneAt(cur.fractions, (e.clientX - r.left) / r.width)
    if (indexOfLoc(cur, locId) === index || !canAddPane(cur, locId)) return null
    return { index, side: within < 0.5 ? 'left' : 'right', locId, tabId: tab?.id }
  }

  const newTab = useCallback(
    (locId: string, cwdOverride?: string): string | undefined => {
      const st = stateRef.current
      if (!st) return undefined
      const loc = buildLocs(st).get(locId)
      const cwd = cwdOverride ?? loc?.path
      if (!loc || !cwd || (loc.missing && !cwdOverride)) return undefined
      const id = crypto.randomUUID()
      const n = (counters.current[locId] = (counters.current[locId] ?? 0) + 1)
      createTerm(id)
      const title = cwdOverride ? baseName(cwdOverride) : `${shellLabel(st.resolvedShell)} ${n}`
      commitTabs((t) => [...t, { id, locId, cwd, title, kind: 'shell', exited: false }])
      setActiveByLoc((a) => ({ ...a, [locId]: id }))
      return id
    },
    [commitTabs]
  )

  const openTerminal = useCallback(
    async (id: string) => {
      await select(id)
      newTab(id)
    },
    [select, newTab]
  )

  /** Opens a diff tab for the selected folder: reuses a tab for the same file+mode, else replaces the preview tab. */
  const openDiff = useCallback(
    (folder: string, req: GitDiffRequest, pin: boolean) => {
      const locId = stateRef.current?.selectedId
      if (!locId) return
      const spec: DiffSpec = { ...req, folder }
      const same = (a: DiffSpec, b: DiffSpec): boolean =>
        a.folder === b.folder && a.mode === b.mode && a.path === b.path && (a.mode !== 'commit' || (b.mode === 'commit' && a.hash === b.hash))
      const existing = tabsRef.current.find((t) => t.locId === locId && t.diff && same(t.diff, spec))
      if (existing) {
        if (pin && existing.preview) commitTabs((all) => all.map((t) => (t.id === existing.id ? { ...t, preview: false } : t)))
        setActiveByLoc((a) => ({ ...a, [locId]: existing.id }))
        return
      }
      const preview = tabsRef.current.find((t) => t.locId === locId && t.diff && t.preview)
      if (preview) {
        commitTabs((all) =>
          all.map((t) => (t.id === preview.id ? { ...t, diff: spec, title: diffTitle(spec), cwd: folder, preview: !pin } : t))
        )
        setActiveByLoc((a) => ({ ...a, [locId]: preview.id }))
        return
      }
      const id = crypto.randomUUID()
      commitTabs((t) => [...t, { id, locId, cwd: folder, title: diffTitle(spec), kind: 'diff', exited: false, diff: spec, preview: !pin }])
      setActiveByLoc((a) => ({ ...a, [locId]: id }))
    },
    [commitTabs]
  )

  /** A diff tab changed what it shows (e.g. after staging). */
  const updateDiff = useCallback(
    (id: string, spec: DiffSpec) => {
      commitTabs((all) => all.map((t) => (t.id === id ? { ...t, diff: spec, title: diffTitle(spec) } : t)))
    },
    [commitTabs]
  )

  /** Recompute a run's aggregate status from its tabs. */
  const refreshRun = useCallback(
    (runId: string) => {
      const ctl = runCtl.current.get(runId)
      if (!ctl) return
      const rt = tabsRef.current.filter((t) => t.run?.runId === runId)
      const failed = rt.find((t) => t.run?.status === 'failed')
      const running = rt.some((t) => t.run?.status === 'running')
      const pending = ctl.cmd.mode === 'sequential' && !failed && !ctl.stopped && ctl.nextIndex < ctl.cmd.targets.length
      const status: RunInfo['status'] = running || pending ? 'running' : failed || ctl.stopped ? 'failed' : 'success'
      const info: RunInfo = {
        runId,
        status,
        exitCode: failed?.run?.exitCode,
        stopped: ctl.stopped,
        done: rt.filter((t) => t.run?.status === 'success').length,
        total: ctl.cmd.targets.length
      }
      setRuns((r) => (r[ctl.cmd.id]?.runId === runId ? { ...r, [ctl.cmd.id]: info } : r))
    },
    [setRuns]
  )

  const startTarget = useCallback(
    (runId: string, index: number) => {
      const ctl = runCtl.current.get(runId)
      if (!ctl) return
      const target = ctl.cmd.targets[index]
      ctl.nextIndex = index + 1
      const id = crypto.randomUUID()
      createTerm(id, { command: true })
      const title = ctl.cmd.targets.length > 1 ? `${ctl.cmd.name} · ${baseName(target.cwd)}` : ctl.cmd.name
      commitTabs((t) => [
        ...t,
        {
          id,
          locId: ctl.locId,
          cwd: target.cwd,
          title,
          kind: 'command',
          exited: false,
          steps: target.steps,
          run: { commandId: ctl.cmd.id, runId, status: 'running' }
        }
      ])
      setActiveByLoc((a) => (ctl.cmd.mode === 'sequential' || index === 0 ? { ...a, [ctl.locId]: id } : a))
    },
    [commitTabs]
  )

  const handleExit = useCallback(
    (id: string, code: number) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      if (tab.kind === 'shell') {
        commitTabs((all) => all.map((t) => (t.id === id ? { ...t, exited: true } : t)))
        return
      }
      if (!tab.run || tab.run.status !== 'running') return
      const { runId } = tab.run
      const ctl = runCtl.current.get(runId)
      const ok = code === 0 && !ctl?.stopped
      commitTabs((all) =>
        all.map((t) => (t.id === id && t.run ? { ...t, run: { ...t.run, status: ok ? 'success' : 'failed', exitCode: code } } : t))
      )
      if (ctl && ok && ctl.cmd.mode === 'sequential' && ctl.nextIndex < ctl.cmd.targets.length) startTarget(runId, ctl.nextIndex)
      refreshRun(runId)
    },
    [commitTabs, refreshRun, startTarget]
  )

  const stopRun = useCallback(
    (commandId: string) => {
      const runId = latestRun.current[commandId]
      const ctl = runId ? runCtl.current.get(runId) : undefined
      if (!runId || !ctl) return
      ctl.stopped = true
      const running = tabsRef.current.filter((t) => t.run?.runId === runId && t.run.status === 'running')
      for (const t of running) {
        const e = getTerm(t.id)
        if (e) e.stopped = true // the "stopped" line is printed when the pty exit event arrives
        window.api.ptyKill(t.id)
      }
      const ids = new Set(running.map((t) => t.id))
      commitTabs((all) => all.map((t) => (ids.has(t.id) && t.run ? { ...t, run: { ...t.run, status: 'failed' } } : t)))
      refreshRun(runId)
    },
    [commitTabs, refreshRun]
  )

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      if (tab.run?.status === 'running') stopRun(tab.run.commandId)
      if (tab.kind !== 'diff') {
        window.api.ptyKill(id)
        getTerm(id)?.dispose()
      }
      const all = tabsRef.current
      setActiveByLoc((a) => {
        if (a[tab.locId] !== id) return a
        const siblings = all.filter((t) => t.locId === tab.locId)
        const idx = siblings.findIndex((t) => t.id === id)
        const next = siblings[idx + 1] ?? siblings[idx - 1]
        const copy = { ...a }
        if (next) copy[tab.locId] = next.id
        else delete copy[tab.locId]
        return copy
      })
      commitTabs((t) => t.filter((x) => x.id !== id))
      if (tab.run && !tabsRef.current.some((t) => t.run?.runId === tab.run?.runId)) {
        const { runId, commandId } = tab.run
        runCtl.current.delete(runId)
        setRuns((r) => {
          if (r[commandId]?.runId !== runId) return r
          const copy = { ...r }
          delete copy[commandId]
          return copy
        })
      }
    },
    [commitTabs, setRuns, stopRun]
  )

  const runCommand = useCallback(
    (cmd: Command) => {
      const st = stateRef.current
      const locId = st?.selectedId
      if (!locId || cmd.targets.length === 0) return
      if (runsRef.current[cmd.id]?.status === 'running') return
      // Replace the previous run's finished tabs.
      const prev = latestRun.current[cmd.id]
      if (prev) for (const t of tabsRef.current.filter((x) => x.run?.runId === prev)) closeTab(t.id)
      const runId = crypto.randomUUID()
      runCtl.current.set(runId, { cmd, locId, nextIndex: 0, stopped: false })
      latestRun.current[cmd.id] = runId
      setRuns((r) => ({ ...r, [cmd.id]: { runId, status: 'running', done: 0, total: cmd.targets.length } }))
      if (cmd.mode === 'parallel') cmd.targets.forEach((_, i) => startTarget(runId, i))
      else startTarget(runId, 0)
    },
    [closeTab, setRuns, startTarget]
  )

  const togglePanel = useCallback(
    async (tab: 'files' | 'commands' | 'git') => {
      const ui = stateRef.current?.ui
      if (!ui) return
      const open = ui.panelOpen && ui.panelTab === tab
      setState(await window.api.setUi({ panelOpen: !open, panelTab: tab }))
    },
    [setState]
  )

  const toggleSidebar = useCallback(async () => {
    const ui = stateRef.current?.ui
    if (!ui) return
    setState(await window.api.setUi({ sidebarCollapsed: !ui.sidebarCollapsed }))
  }, [setState])

  const zoom = useCallback(
    async (dir: -1 | 0 | 1) => {
      const cur = stateRef.current?.settings.terminalFontSize ?? DEFAULT_FONT_SIZE
      const next = dir === 0 ? DEFAULT_FONT_SIZE : Math.min(36, Math.max(8, cur + dir))
      if (next === cur) return
      setTerminalFontSize(next)
      setState(await window.api.setSettings({ terminalFontSize: next }))
    },
    [setState]
  )

  const activeTabId = selectedId ? activeByLoc[selectedId] : undefined
  const activeRef = useRef(activeByLoc)
  activeRef.current = activeByLoc

  /** Paste a saved prompt into the selected folder's active shell tab, opening one first when needed. */
  const insertSnippet = useCallback(
    async (body: string, enter: boolean) => {
      const locId = stateRef.current?.selectedId
      if (!locId) return
      const live = (t: Tab): boolean => t.locId === locId && t.kind === 'shell' && !t.exited
      const activeId = activeRef.current[locId]
      const tab = tabsRef.current.find((t) => t.id === activeId && live(t)) ?? tabsRef.current.find(live)
      let id = tab?.id
      let fresh = false
      if (!id) {
        id = newTab(locId)
        fresh = true
      } else if (id !== activeId) {
        const target = id
        setActiveByLoc((a) => ({ ...a, [locId]: target }))
      }
      if (!id) return
      const entry = getTerm(id)
      if (!entry) return
      if (fresh) {
        // Let the pty start and the shell draw its prompt before pasting.
        await entry.ready
        await new Promise((r) => setTimeout(r, 600))
      }
      pasteInto(id, body, enter)
    },
    [newTab]
  )

  // Latest-handler indirection so the registry hooks and the window listener never go stale.
  const act = useRef({ newSelected: () => {}, closeActive: () => {} })
  act.current = {
    newSelected: () => selectedId && newTab(selectedId),
    closeActive: () => activeTabId && closeTab(activeTabId)
  }

  useEffect(() => {
    setTermHooks({
      onNewTab: () => act.current.newSelected(),
      onCloseTab: () => act.current.closeActive(),
      onExit: handleExit,
      onZoom: (d) => void zoom(d),
      onTogglePanel: (t) => void togglePanel(t),
      onSnippetPicker: () => setPickerOpen(true),
      onToggleSidebar: () => void toggleSidebar()
    })
  }, [handleExit, zoom, togglePanel, toggleSidebar])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (e.shiftKey && k === 't') {
        e.preventDefault()
        act.current.newSelected()
      } else if (e.shiftKey && k === 'w') {
        e.preventDefault()
        act.current.closeActive()
      } else if (e.shiftKey && (k === 'e' || k === 'r' || k === 'g')) {
        e.preventDefault()
        void togglePanel(k === 'e' ? 'files' : k === 'r' ? 'commands' : 'git')
      } else if (e.shiftKey && k === 'b') {
        e.preventDefault()
        void toggleSidebar()
      } else if (e.shiftKey && k === 'p') {
        e.preventDefault()
        setPickerOpen(true)
      } else if (k === '=' || k === '+' || k === '-' || k === '0') {
        e.preventDefault()
        void zoom(k === '0' ? 0 : k === '-' ? -1 : 1)
      }
    }
    // A drop that misses every target must never navigate the window to the dropped file.
    const stop = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    const onFailed = (e: Event): void => handleExit((e as CustomEvent<string>).detail, 1)
    window.addEventListener('keydown', onKey)
    window.addEventListener('terminal-failed', onFailed)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('terminal-failed', onFailed)
    }
  }, [handleExit, togglePanel, toggleSidebar, zoom])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const t of tabs) {
      const live = t.kind === 'shell' ? !t.exited : t.run?.status === 'running'
      if (live) c[t.locId] = (c[t.locId] ?? 0) + 1
    }
    return c
  }, [tabs])

  const closeTabsOf = useCallback(
    (ids: string[]) => {
      for (const t of tabsRef.current.filter((t) => ids.includes(t.locId))) closeTab(t.id)
    },
    [closeTab]
  )

  if (!state || !widths || !paneState) return <div className="app" />

  const ui = state.ui
  const ps = paneState
  const multi = ps.panes.length > 1
  const paneIndexOfLoc = new Map<string, number>()
  ps.panes.forEach((p, i) => p.locId && paneIndexOfLoc.set(p.locId, i))
  const startPct = (i: number): number => startOf(ps.fractions, i) * 100

  const addFolder = async (): Promise<void> => setState(await window.api.addFolder())

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-left">
          <button
            className={`icon-btn ${ui.sidebarCollapsed ? '' : 'active'}`}
            title="Toggle sidebar (Ctrl+Shift+B)"
            onClick={() => void toggleSidebar()}
          >
            {ui.sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <span className="titlebar-mark">
            <Terminal size={13} strokeWidth={2.75} />
          </span>
          <span className="titlebar-name">Terminals</span>
          {selected && (
            <>
              <span className="titlebar-sep">/</span>
              <span className="titlebar-path" title={selected.path ?? selected.name}>
                <bdi>{selected.path ?? selected.name}</bdi>
              </span>
            </>
          )}
        </div>
        <div className="titlebar-right">
          <button
            className={`icon-btn ${ui.panelOpen && ui.panelTab === 'files' ? 'active' : ''}`}
            title="Files (Ctrl+Shift+E)"
            onClick={() => void togglePanel('files')}
          >
            <FolderTree size={16} />
          </button>
          <button
            className={`icon-btn ${ui.panelOpen && ui.panelTab === 'commands' ? 'active' : ''}`}
            title="Commands (Ctrl+Shift+R)"
            onClick={() => void togglePanel('commands')}
          >
            <Zap size={16} />
          </button>
          <button
            className={`icon-btn ${ui.panelOpen && ui.panelTab === 'git' ? 'active' : ''}`}
            title="Git changes (Ctrl+Shift+G)"
            onClick={() => void togglePanel('git')}
          >
            <GitBranch size={16} />
          </button>
        </div>
      </header>
      <div className="body">
        {!ui.sidebarCollapsed && (
        <>
        <div className="sidebar-wrap" style={{ width: widths.sb }}>
          <Sidebar
            state={state}
            counts={counts}
            onSelect={(id) => void select(id)}
            onOpenTerminal={(id) => void openTerminal(id)}
            onOpenToSide={openLocToSide}
            canOpenToSide={(id) => canAddPane(ps, id)}
            onAddFolder={() => void addFolder()}
            onAddParent={async () => setState(await window.api.addParentGroup())}
            onAddGroup={async (name) => setState(await window.api.addGroup(name))}
            onRemoveFolder={async (id) => {
              closeTabsOf([id])
              setState(await window.api.removeFolder(id))
            }}
            onRemoveGroup={async (id) => {
              const g = state.groups.find((x) => x.id === id)
              closeTabsOf([id, ...(g?.kind === 'parent' ? g.children.map((c) => c.id) : [])])
              setState(await window.api.removeGroup(id))
            }}
            onRenameFolder={async (id, name) => setState(await window.api.renameFolder(id, name))}
            onRenameGroup={async (id, name) => setState(await window.api.renameGroup(id, name))}
            onMoveFolder={async (id, gid, before) => setState(await window.api.moveFolder(id, gid, before))}
            onDropPaths={async (paths, gid, before) => setState(await window.api.addFolderPaths(paths, gid, before))}
            onToggleCollapse={async (id, c) => setState(await window.api.setGroupCollapsed(id, c))}
            onToggleShowHidden={async (id, s) => setState(await window.api.setShowHidden(id, s))}
            onHideChild={async (gid, path, h) => setState(await window.api.setChildHidden(gid, path, h))}
            onRefresh={() => void refresh()}
            onOpenWt={(p) => void window.api.openInWindowsTerminal(p)}
            onOpenExplorer={(p) => void window.api.openInExplorer(p)}
            onOpenEditor={(p) => void window.api.openInEditor(p)}
            onCopy={(t) => void window.api.clipboardWrite(t)}
          />
        </div>
        <ResizeHandle
          onDrag={(x) => setWidths((w) => (w ? { ...w, sb: Math.min(600, Math.max(180, x)) } : w))}
          onEnd={() => widthsRef.current && void window.api.setUi({ sidebarWidth: widthsRef.current.sb })}
        />
        </>
        )}
        <main className="main">
          <div
            className={`panes ${multi ? 'multi' : ''}`}
            ref={panesEl}
            onMouseDownCapture={(e) => {
              const el = panesEl.current
              if (!el || (e.target as HTMLElement).closest('.pane-divider')) return
              const r = el.getBoundingClientRect()
              focusPane(paneAt(ps.fractions, (e.clientX - r.left) / r.width).index)
            }}
            onDragOver={(e) => {
              const h = dropTargetAt(e)
              if (!h) {
                if (dropHint) setDropHint(null)
                return
              }
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (!dropHint || dropHint.index !== h.index || dropHint.side !== h.side) setDropHint(h)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHint(null)
            }}
            onDrop={(e) => {
              const h = dropTargetAt(e)
              dragTab.current = null
              locDrag.id = null
              setDropHint(null)
              const cur = panesRef.current
              if (!h || !cur) return
              e.preventDefault()
              if (h.tabId) setActiveByLoc((a) => ({ ...a, [h.locId]: h.tabId as string }))
              commitPanes(dropOnEdge(cur, h.locId, h.index, h.side, mkId))
            }}
          >
            {ps.panes.map((p, i) => {
              const loc = (p.locId && locs.get(p.locId)) || null
              const paneTabs = tabs.filter((t) => t.locId === p.locId)
              const paneActive = p.locId ? activeByLoc[p.locId] : undefined
              const diff = paneTabs.find((t) => t.id === paneActive && t.kind === 'diff')
              const members = loc?.kind === 'manual' ? state.folders.filter((f) => f.groupId === loc.id).length : 0
              return (
                <div
                  key={p.id}
                  className={`pane ${i === ps.focused ? 'focused' : ''}`}
                  style={{ left: `${startPct(i)}%`, width: `${ps.fractions[i] * 100}%` }}
                >
                  {loc && (
                    <div className="pane-head">
                      <TabBar
                        loc={loc}
                        tabs={paneTabs}
                        activeId={paneActive}
                        commands={state.commands}
                        onActivate={(id) => setActiveByLoc((a) => ({ ...a, [loc.id]: id }))}
                        onClose={closeTab}
                        onPin={(id) => commitTabs((all) => all.map((x) => (x.id === id ? { ...x, preview: false } : x)))}
                        onRunAgain={runCommand}
                        onNew={() => newTab(loc.id)}
                        onDragStart={(e, t) => {
                          dragTab.current = t
                          e.dataTransfer.setData(TAB_DRAG_TYPE, t.id)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => {
                          dragTab.current = null
                          setDropHint(null)
                        }}
                      />
                      {multi && (
                        <button className="pane-close" title="Close pane" onClick={() => closePaneById(p.id)}>
                          <PanelRightClose size={15} />
                        </button>
                      )}
                    </div>
                  )}
                  <div className="term-area">
                    {diff?.diff && (
                      <DiffView
                        key={diff.id}
                        spec={diff.diff}
                        fontSize={Math.max(11, state.settings.terminalFontSize - 2)}
                        onChangeSpec={(spec) => updateDiff(diff.id, spec)}
                      />
                    )}
                    {!loc && (
                      <div className="empty">
                        <span className="empty-icon">
                          <FolderTree size={24} strokeWidth={1.75} />
                        </span>
                        <h2>No folder selected</h2>
                        <p>Add a folder, or a parent folder whose subfolders are discovered automatically. You can also drag folders from Explorer onto the sidebar.</p>
                        <button className="btn primary" onClick={() => void addFolder()}>
                          <Plus size={15} /> Add folder
                        </button>
                      </div>
                    )}
                    {loc && loc.missing && (
                      <div className="empty">
                        <span className="empty-icon warn">
                          <FolderX size={24} strokeWidth={1.75} />
                        </span>
                        <h2>Folder not found</h2>
                        <p>
                          <span className="path-chip">{loc.path}</span> no longer exists on disk. Terminals cannot be opened here.
                        </p>
                      </div>
                    )}
                    {loc && !loc.missing && !loc.path && paneTabs.length === 0 && (
                      <div className="empty">
                        <span className="empty-icon">
                          <Group size={24} strokeWidth={1.75} />
                        </span>
                        <h2>{loc.name}</h2>
                        <p>
                          {members === 0
                            ? 'This group is empty. Drag folders onto it or use "Move to group".'
                            : 'Select one of the folders in this group to open a terminal.'}
                        </p>
                        <p className="hint">
                          Commands saved on this group are in the Commands panel <Keys combo="Ctrl+Shift+R" />
                        </p>
                      </div>
                    )}
                    {loc && !loc.missing && loc.path && paneTabs.length === 0 && (
                      <div className="empty">
                        <span className="empty-icon">
                          <SquareTerminal size={24} strokeWidth={1.75} />
                        </span>
                        <h2>{loc.name}</h2>
                        <p>No terminals open here.</p>
                        <button className="btn primary" onClick={() => newTab(loc.id)}>
                          <Plus size={15} /> New terminal
                        </button>
                        <p className="hint">
                          <Keys combo="Ctrl+Shift+T" />
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            {/* Every terminal lives in this one stable list whatever pane shows it: positioning, not reparenting, moves it. */}
            {tabs
              .filter((t) => t.kind !== 'diff')
              .map((t) => {
                const pi = paneIndexOfLoc.get(t.locId)
                const visible = pi !== undefined && activeByLoc[t.locId] === t.id
                return (
                  <TerminalView
                    key={t.id}
                    id={t.id}
                    cwd={t.cwd}
                    steps={t.steps}
                    visible={visible}
                    focused={visible && pi === ps.focused}
                    style={
                      pi === undefined
                        ? undefined
                        : { left: `calc(${startPct(pi)}% + 14px)`, width: `calc(${ps.fractions[pi] * 100}% - 16px)` }
                    }
                  />
                )
              })}
            {ps.panes.slice(0, -1).map((p, i) => (
              <div key={p.id} className="pane-divider" style={{ left: `${startPct(i + 1)}%` }}>
                <ResizeHandle
                  onDrag={(x) => {
                    const el = panesEl.current
                    const cur = panesRef.current
                    if (!el || !cur) return
                    const r = el.getBoundingClientRect()
                    const min = Math.min(MIN_PANE_PX / r.width, 1 / cur.panes.length)
                    setPanes({ ...cur, fractions: dragDivider(cur.fractions, i, (x - r.left) / r.width, min) }, false)
                  }}
                  onEnd={() => panesRef.current && setPanes(panesRef.current)}
                />
              </div>
            ))}
            {dropHint && (
              <div
                className="pane-drop"
                style={{
                  left: `${startPct(dropHint.index) + (dropHint.side === 'right' ? ps.fractions[dropHint.index] * 50 : 0)}%`,
                  width: `${ps.fractions[dropHint.index] * 50}%`
                }}
              />
            )}
          </div>
        </main>
        {ui.panelOpen && (
          <>
            <ResizeHandle
              onDrag={(x) => setWidths((w) => (w ? { ...w, panel: Math.min(900, Math.max(220, window.innerWidth - x)) } : w))}
              onEnd={() => widthsRef.current && void window.api.setUi({ panelWidth: widthsRef.current.panel })}
            />
            <aside className="panel" style={{ width: widths.panel }}>
              <div className="panel-tabs">
                <button
                  className={ui.panelTab === 'files' ? 'active' : ''}
                  onClick={async () => setState(await window.api.setUi({ panelTab: 'files' }))}
                  title="Files (Ctrl+Shift+E)"
                >
                  <FileText size={14} /> Files
                </button>
                <button
                  className={ui.panelTab === 'commands' ? 'active' : ''}
                  onClick={async () => setState(await window.api.setUi({ panelTab: 'commands' }))}
                  title="Commands (Ctrl+Shift+R)"
                >
                  <Zap size={14} /> Commands
                </button>
                <button
                  className={ui.panelTab === 'git' ? 'active' : ''}
                  onClick={async () => setState(await window.api.setUi({ panelTab: 'git' }))}
                  title="Git changes (Ctrl+Shift+G)"
                >
                  <GitBranch size={14} /> Git
                </button>
                <span className="spacer" />
                <button className="icon-btn" title="Close panel" onClick={async () => setState(await window.api.setUi({ panelOpen: false }))}>
                  <X size={15} />
                </button>
              </div>
              {ui.panelTab === 'files' ? (
                <FileTree
                  root={selected?.path ?? null}
                  rootMissing={!!selected?.missing}
                  onOpenTerminalHere={(dir) => selected && newTab(selected.id, dir)}
                />
              ) : ui.panelTab === 'git' ? (
                <GitPanel
                  root={selected?.path ?? null}
                  rootMissing={!!selected?.missing}
                  onOpenDiff={(folder, spec, pin) => openDiff(folder, spec, pin)}
                />
              ) : (
                <CommandsPanel
                  state={state}
                  selected={selected}
                  runs={runs}
                  onRun={runCommand}
                  onStop={(c) => stopRun(c.id)}
                  onSave={async (c) => setState(await window.api.saveCommand(c))}
                  onDelete={async (id) => setState(await window.api.deleteCommand(id))}
                  onDuplicate={async (c) =>
                    setState(await window.api.saveCommand({ ...c, id: crypto.randomUUID(), name: `${c.name} (copy)` }))
                  }
                  onInsertSnippet={(body, enter) => void insertSnippet(body, enter)}
                  onSaveSnippet={async (s) => setState(await window.api.saveSnippet(s))}
                  onDeleteSnippet={async (id) => setState(await window.api.deleteSnippet(id))}
                  onCopy={(t) => void window.api.clipboardWrite(t)}
                />
              )}
            </aside>
          </>
        )}
      </div>
      {pickerOpen && (
        <SnippetPicker
          snippets={visibleSnippets(state, selected)}
          onClose={() => setPickerOpen(false)}
          onPick={(s) => {
            setPickerOpen(false)
            void insertSnippet(s.body, false)
          }}
        />
      )}
    </div>
  )
}
