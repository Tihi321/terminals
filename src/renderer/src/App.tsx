import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileText, FolderTree, FolderX, GitBranch, Group, PanelLeftClose, PanelLeftOpen, PanelRightClose, Plus, Shield, SquareTerminal, Terminal, X, Zap } from 'lucide-react'
import type { AgentTabRequest, AppState, Command, ElevatorInfo, GitDiffRequest, Result } from '../../shared/types'
import { GSUDO_HINT, INSTALL_GSUDO_COMMAND } from '../../shared/elevation'
import { removalSet } from '../../shared/groupTree'
import { Sidebar } from './Sidebar'
import { TerminalView } from './TerminalView'
import { FileTree } from './FileTree'
import { CommandsPanel } from './CommandsPanel'
import { GitPanel } from './GitPanel'
import { DiffView } from './DiffView'
import { FileViewer } from './FileViewer'
import { diffTitle } from './gitUtil'
import type { DiffSpec } from './gitUtil'
import { SnippetPicker } from './SnippetPicker'
import { TabBar, TAB_DRAG_TYPE, LOC_DRAG_TYPE, locDrag, tabDrag } from './TabBar'
import type { Tab } from './TabBar'
import {
  canAddPane,
  closePane,
  dragDivider,
  dropOnEdge,
  focusLoc,
  fromPersisted,
  MAX_PANES,
  normalize,
  openToSide,
  paneAt,
  paneShows,
  splitBeside,
  startOf,
  toPersisted
} from '../../shared/panes'
import type { PaneState, Side } from '../../shared/panes'
import { activateIn, moveTab, neighbourTab, paneOfTab, reconcileActive, shiftTab, takenBy } from '../../shared/tabs'
import type { ActiveMap } from '../../shared/tabs'
import { planRestore, restorePaths, toPersistedTabs } from '../../shared/session'
import { Keys } from './Keys'
import { visibleSnippets } from './SnippetEditor'
import type { RunInfo } from './CommandsPanel'
import { baseName, buildLocs } from './locations'
import { createTerm, getTerm, pasteInto, setTermHooks } from './termRegistry'
import { SettingsDialog } from './SettingsDialog'
import { useAppearance } from './appearance'
import { DEFAULT_SETTINGS, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../shared/settings'

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

/** Button that starts an admin shell; disabled with the install hint when no elevator is available. Asks main on mount. */
function StartAdminButton({ onStart, onInstall, className }: { onStart: () => void; onInstall: () => void; className?: string }): JSX.Element {
  const [info, setInfo] = useState<ElevatorInfo | null>(null)
  useEffect(() => {
    let alive = true
    window.api
      .getElevator()
      .then((r) => alive && setInfo(r))
      .catch(() => alive && setInfo({ available: false, tool: null, hint: `Install gsudo: ${GSUDO_HINT}` }))
    return () => {
      alive = false
    }
  }, [])
  const unavailable = info !== null && !info.available
  return (
    <>
      <button className={className ?? 'btn primary'} disabled={info === null || unavailable} title={info?.hint} onClick={onStart}>
        <Shield size={14} /> Start as admin
      </button>
      {unavailable && (
        <button className="btn small" title={`Runs: ${GSUDO_HINT}`} onClick={onInstall}>
          <Download size={14} /> Install gsudo
        </button>
      )}
    </>
  )
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
  const [activeByPane, setActiveByPane] = useState<ActiveMap>({})
  /** Reconciled active tab per pane (D2); what rendering, shortcuts, drops and saving read. */
  const activeRef = useRef<ActiveMap>({})
  /** Last tab activated per folder; a pane repointed to a folder shows it. */
  const lastByLoc = useRef<Record<string, string>>({})
  /** Last cwd a shell reported through OSC 7 / 9;9. */
  const cwdById = useRef<Record<string, string>>({})
  /** Restored shells: folder path to fall back to when their cwd cannot be used. */
  const fallbackById = useRef<Record<string, string>>({})
  const restoreStarted = useRef(false)
  const restored = useRef(false)
  const saveTimer = useRef<number | undefined>(undefined)
  const [runs, setRunsRaw] = useState<Record<string, RunInfo>>({})
  const runsRef = useRef<Record<string, RunInfo>>({})
  const runCtl = useRef(new Map<string, RunCtl>())
  const latestRun = useRef<Record<string, string>>({})
  const counters = useRef<Record<string, number>>({})
  const [pickerOpen, setPickerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useAppearance(state?.settings)
  const [paneState, setPaneState] = useState<PaneState | null>(null)
  const panesRef = useRef<PaneState | null>(null)
  const panesEl = useRef<HTMLDivElement>(null)
  const lastSelected = useRef<string | null>(null)
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

  const setActive = useCallback((next: ActiveMap) => {
    activeRef.current = next
    setActiveByPane(next)
  }, [])

  /** Debounced session save (D8). Does nothing until the restore has finished, so an early save cannot wipe the saved session. */
  const scheduleSave = useCallback(() => {
    if (!restored.current) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const cur = panesRef.current
      if (!cur) return
      const panes = toPersisted(cur, activeRef.current)
      void window.api.setUi({ ...(panes ? { panes } : {}), tabs: toPersistedTabs(tabsRef.current, cwdById.current) })
    }, 300)
  }, [])

  /** Makes a tab active in the first pane that applies (D15); always remembers it as its folder's last tab. */
  const showTab = useCallback(
    (tabId: string, paneId?: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      const cur = panesRef.current
      if (!tab || !cur) return
      lastByLoc.current[tab.locId] = tabId
      const shows = (id: string | undefined): string | undefined =>
        id && cur.panes.some((p) => p.id === id && p.locId === tab.locId) ? id : undefined
      const target =
        shows(paneId) ??
        shows(paneOfTab(activeRef.current, tabId)) ??
        shows(cur.panes[cur.focused]?.id) ??
        cur.panes.find((p) => p.locId === tab.locId)?.id
      if (target) setActive(activateIn(cur.panes, tabsRef.current, activeRef.current, target, tabId))
    },
    [setActive]
  )

  const selectedId = state?.selectedId ?? null
  const locs = useMemo(() => (state ? buildLocs(state) : new Map()), [state])
  const selected = (selectedId && locs.get(selectedId)) || null

  const select = useCallback(async (id: string | null) => setState(await window.api.select(id)), [setState])

  /** Applies a new pane layout; the layout is persisted unless it is a transient drag step. */
  const setPanes = useCallback((next: PaneState, persist = true) => {
    panesRef.current = next
    setPaneState(next)
    if (persist) scheduleSave()
  }, [scheduleSave])

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
    // The tab bar is its own drop target (reorder); only the terminal area splits.
    if (e.target instanceof Element && e.target.closest('.pane-head')) return null
    const types = e.dataTransfer.types
    const tab = types.includes(TAB_DRAG_TYPE) ? tabDrag.tab : null
    const locId = tab ? tab.locId : types.includes(LOC_DRAG_TYPE) ? locDrag.id : null
    if (!locId) return null
    const r = el.getBoundingClientRect()
    const { index, within } = paneAt(cur.fractions, (e.clientX - r.left) / r.width)
    if (tab) {
      if (cur.panes.length >= MAX_PANES) return null
      if (paneShows(cur, index, locId) && tabsRef.current.filter((t) => t.locId === locId).length <= 1) return null
    } else if (paneShows(cur, index, locId) || !canAddPane(cur, locId)) return null
    return { index, side: within < 0.5 ? 'left' : 'right', locId, tabId: tab?.id }
  }

  const newTab = useCallback(
    (locId: string, cwdOverride?: string, paneId?: string, elevated?: boolean): string | undefined => {
      const st = stateRef.current
      if (!st) return undefined
      const loc = buildLocs(st).get(locId)
      const cwd = cwdOverride ?? loc?.path
      if (!loc || !cwd || (loc.missing && !cwdOverride)) return undefined
      const id = crypto.randomUUID()
      const n = (counters.current[locId] = (counters.current[locId] ?? 0) + 1)
      createTerm(id, elevated ? { elevated: true } : {})
      const title = elevated
        ? `Admin ${shellLabel(st.resolvedShell)} ${n}`
        : cwdOverride
          ? baseName(cwdOverride)
          : `${shellLabel(st.resolvedShell)} ${n}`
      commitTabs((t) => [
        ...t,
        { id, locId, cwd, title, kind: 'shell', exited: false, shell: st.resolvedShell, startCwd: cwd, ...(elevated ? { elevated: true } : {}) }
      ])
      showTab(id, paneId)
      return id
    },
    [commitTabs, showTab]
  )

  /** main spawned an agent (MCP) pty: show a tab that attaches to it. In the background unless req.reveal. */
  const newAgentTab = useCallback(
    (req: AgentTabRequest): Result => {
      const st = stateRef.current
      if (!st || !buildLocs(st).has(req.locId)) return { ok: false, error: 'Unknown location' }
      createTerm(req.id, { attach: true })
      const n = (counters.current[req.locId] = (counters.current[req.locId] ?? 0) + 1)
      commitTabs((t) => [
        ...t,
        {
          id: req.id,
          locId: req.locId,
          cwd: req.cwd,
          title: `Agent ${n}`,
          kind: 'shell',
          agent: true,
          exited: false,
          shell: req.shell,
          startCwd: req.cwd
        }
      ])
      // Only a pane that shows this location and has no active tab takes it; otherwise it stays in the background.
      // With reveal (open_terminal reveal: true) it is always activated.
      const cur = panesRef.current
      if (req.reveal || cur?.panes.some((p) => p.locId === req.locId && !activeRef.current[p.id])) showTab(req.id)
      scheduleSave()
      return { ok: true }
    },
    [commitTabs, showTab, scheduleSave]
  )

  /** New admin tab: the TerminalView mounts and requests an elevated pty (the click that opened the menu is the consent). */
  const newAdminTab = useCallback((locId: string, paneId?: string) => newTab(locId, undefined, paneId, true), [newTab])

  /** "Start as admin": starts a restored placeholder, or retries an elevated tab whose elevation failed. */
  const startAdmin = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab || !tab.elevated) return
      if (tab.pending) {
        createTerm(id, { elevated: true })
        commitTabs((all) => all.map((t) => (t.id === id ? { ...t, pending: false } : t)))
      } else if (tab.exited) {
        getTerm(id)?.dispose()
        createTerm(id, { elevated: true })
        commitTabs((all) => all.map((t) => (t.id === id ? { ...t, exited: false, attempt: (t.attempt ?? 0) + 1 } : t)))
      }
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
        showTab(existing.id)
        return
      }
      const preview = tabsRef.current.find((t) => t.locId === locId && t.diff && t.preview)
      if (preview) {
        commitTabs((all) =>
          all.map((t) => (t.id === preview.id ? { ...t, diff: spec, title: diffTitle(spec), cwd: folder, preview: !pin } : t))
        )
        showTab(preview.id)
        return
      }
      const id = crypto.randomUUID()
      commitTabs((t) => [...t, { id, locId, cwd: folder, title: diffTitle(spec), kind: 'diff', exited: false, diff: spec, preview: !pin }])
      showTab(id)
    },
    [commitTabs, showTab]
  )

  /** Opens a read-only file tab for the selected location; the same file focuses its existing tab. */
  const openFile = useCallback(
    (path: string, pin: boolean) => {
      const locId = stateRef.current?.selectedId
      if (!locId) return
      const name = path.split(/[\\/]/).pop() || path
      const existing = tabsRef.current.find((t) => t.locId === locId && t.file === path)
      if (existing) {
        if (pin && existing.preview) commitTabs((all) => all.map((t) => (t.id === existing.id ? { ...t, preview: false } : t)))
        showTab(existing.id)
        return
      }
      const preview = tabsRef.current.find((t) => t.locId === locId && t.file && t.preview)
      if (preview) {
        commitTabs((all) => all.map((t) => (t.id === preview.id ? { ...t, file: path, title: name, preview: !pin } : t)))
        showTab(preview.id)
        return
      }
      const id = crypto.randomUUID()
      commitTabs((t) => [...t, { id, locId, cwd: path, title: name, kind: 'file', exited: false, file: path, preview: !pin }])
      showTab(id)
    },
    [commitTabs, showTab]
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
    (runId: string, index: number, anchor?: string | null) => {
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
          run: { commandId: ctl.cmd.id, runId, status: 'running', target: index }
        }
      ])
      if (anchor) commitTabs((t) => (t.some((x) => x.id === anchor) ? moveTab(t, id, anchor) : t))
      if (ctl.cmd.mode === 'sequential' || index === 0) showTab(id)
    },
    [commitTabs, showTab]
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
      if ((tab.kind === 'shell' || tab.kind === 'command') && !tab.pending) {
        window.api.ptyKill(id)
        getTerm(id)?.dispose()
      }
      // The pane that showed it gets its neighbour (skipping tabs shown elsewhere) or the empty state (D14).
      const all = tabsRef.current
      const act = activeRef.current
      const pane = paneOfTab(act, id)
      if (pane) {
        const n = neighbourTab(all, id, takenBy(act, pane))
        const copy = { ...act }
        if (n) copy[pane] = n
        else delete copy[pane]
        setActive(copy)
      }
      if (lastByLoc.current[tab.locId] === id) {
        const n = neighbourTab(all, id, new Set())
        if (n) lastByLoc.current[tab.locId] = n
        else delete lastByLoc.current[tab.locId]
      }
      delete cwdById.current[id]
      delete fallbackById.current[id]
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
    [commitTabs, setActive, setRuns, stopRun]
  )

  const runCommand = useCallback(
    (cmd: Command, runLocId?: string | null, anchor?: string | null) => {
      const st = stateRef.current
      const locId = runLocId ?? st?.selectedId
      if (!locId || cmd.targets.length === 0) return
      if (runsRef.current[cmd.id]?.status === 'running') return
      // Targets with an empty cwd (global commands) run in the selected location's folder.
      if (cmd.targets.some((t) => !t.cwd)) {
        const locPath = st ? buildLocs(st).get(locId)?.path : null
        if (!locPath) return
        cmd = { ...cmd, targets: cmd.targets.map((t) => (t.cwd ? t : { ...t, cwd: locPath })) }
      }
      // Replace the previous run's finished tabs.
      const prev = latestRun.current[cmd.id]
      if (prev) for (const t of tabsRef.current.filter((x) => x.run?.runId === prev)) closeTab(t.id)
      const runId = crypto.randomUUID()
      runCtl.current.set(runId, { cmd, locId, nextIndex: 0, stopped: false })
      latestRun.current[cmd.id] = runId
      setRuns((r) => ({ ...r, [cmd.id]: { runId, status: 'running', done: 0, total: cmd.targets.length } }))
      if (cmd.mode === 'parallel') cmd.targets.forEach((_, i) => startTarget(runId, i, anchor))
      else startTarget(runId, 0, anchor)
    },
    [closeTab, setRuns, startTarget]
  )

  useEffect(() => {
    // Restore once; React StrictMode runs this effect twice in dev.
    if (!restoreStarted.current) {
      restoreStarted.current = true
      void (async () => {
        const s = await window.api.getState()
        setState(s)
        const locMap = buildLocs(s)
        const valid = new Set(locMap.keys())
        const r = fromPersisted(s.ui.panes, valid, s.selectedId, mkId)
        let ps = r.state
        if (s.selectedId && valid.has(s.selectedId)) ps = focusLoc(ps, s.selectedId)
        lastSelected.current = s.selectedId
        panesRef.current = ps
        setPaneState(ps)
        setWidths({ sb: s.ui.sidebarWidth, panel: s.ui.panelWidth })
        try {
          const saved = s.ui.tabs ?? []
          if (saved.length > 0) {
            const paths = restorePaths(saved)
            const flags = await window.api.pathsExist(paths)
            const existing = new Set(paths.filter((_, i) => flags[i]))
            const plan = planRestore(saved, {
              locs: locMap,
              commandIds: new Set(s.commands.map((c) => c.id)),
              exists: (p) => existing.has(p),
              mkId
            })
            const restoredTabs: Tab[] = plan.tabs.map((t) => {
              const tab: Tab = { id: t.newId, locId: t.locId, cwd: t.cwd, title: t.title, kind: t.kind, exited: false }
              if (t.kind === 'shell') {
                // An admin tab comes back as a placeholder: no process and no UAC until "Start as admin".
                if (t.elevated) {
                  tab.elevated = true
                  tab.pending = true
                } else createTerm(t.newId)
                tab.shell = t.shell
                tab.startCwd = t.startCwd
                if (t.agent) tab.agent = true
                if (t.fallbackCwd) fallbackById.current[t.newId] = t.fallbackCwd
                // New tabs continue the numbering ("PowerShell 3").
                const n = /\s(\d+)$/.exec(t.title)
                if (n) counters.current[t.locId] = Math.max(counters.current[t.locId] ?? 0, Number(n[1]))
              } else if (t.kind === 'diff' && t.diff) {
                const d = t.diff
                tab.diff =
                  d.mode === 'commit' && d.hash
                    ? { folder: d.folder, mode: 'commit', path: d.path, hash: d.hash }
                    : d.mode === 'commit'
                      ? undefined
                      : { folder: d.folder, mode: d.mode, path: d.path }
                tab.preview = t.preview
              } else if (t.kind === 'file') {
                tab.file = t.file
                tab.preview = t.preview
              }
              return tab
            })
            commitTabs((t) => [...t, ...restoredTabs])
            for (const run of plan.runs) {
              const cmd = s.commands.find((c) => c.id === run.commandId)
              if (cmd) runCommand(cmd, run.locId, run.anchor)
            }
            // Pane -> active tab. A command tab maps to the new tab of the same run target.
            const next: ActiveMap = {}
            lastByLoc.current = {} // the run starts above set it as a side effect of showTab
            r.active.forEach((snap, i) => {
              const pane = ps.panes[i]
              if (!snap || !pane) return
              let tid: string | undefined = plan.idMap[snap]
              if (!tid) {
                for (const run of plan.runs) {
                  const hit = Object.entries(run.snapshotIds).find(([, sid]) => sid === snap)
                  const runId = latestRun.current[run.commandId]
                  if (hit && runId) tid = tabsRef.current.find((t) => t.run?.runId === runId && t.run.target === Number(hit[0]))?.id
                }
              }
              if (!tid) return
              next[pane.id] = tid
              const tab = tabsRef.current.find((t) => t.id === tid)
              if (tab) lastByLoc.current[tab.locId] = tid
            })
            setActive(next)
          }
        } catch (err) {
          console.error('Session restore failed', err)
        } finally {
          restored.current = true
          scheduleSave()
        }
      })()
    }
    // Rescan parent folders and re-check existence when coming back to the window.
    const onFocus = (): void => void window.api.getState().then(setState)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [setState, commitTabs, runCommand, setActive, scheduleSave])

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
      const cur = stateRef.current?.settings.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize
      const next = dir === 0 ? DEFAULT_SETTINGS.terminalFontSize : Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, cur + dir))
      if (next === cur) return
      setState(await window.api.setSettings({ terminalFontSize: next }))
    },
    [setState]
  )

  // The effective active tab per pane (D2): every render reconciles the stored map against the panes and tabs.
  const active = paneState ? reconcileActive(paneState.panes, paneState.focused, tabs, activeByPane, lastByLoc.current) : activeByPane
  activeRef.current = active
  useEffect(() => {
    if (active !== activeByPane) setActiveByPane(active)
  }, [active, activeByPane])

  // Save the session after any change to the tabs, the layout or the active tabs (no-op until the restore has finished).
  const activeKey = JSON.stringify(active)
  useEffect(() => {
    scheduleSave()
  }, [tabs, paneState, activeKey, scheduleSave])

  const focusedPaneId = (): string | undefined => {
    const cur = panesRef.current
    return cur?.panes[cur.focused]?.id
  }

  /** Paste a saved prompt into the selected folder's active shell tab, opening one first when needed. */
  const insertSnippet = useCallback(
    async (body: string, enter: boolean) => {
      const locId = stateRef.current?.selectedId
      if (!locId) return
      const paneId = focusedPaneId()
      const live = (t: Tab): boolean => t.locId === locId && t.kind === 'shell' && !t.exited && !t.elevated && !t.pending
      const activeId = paneId ? activeRef.current[paneId] : undefined
      const tab = tabsRef.current.find((t) => t.id === activeId && live(t)) ?? tabsRef.current.find(live)
      let id = tab?.id
      let fresh = false
      if (!id) {
        id = newTab(locId, undefined, paneId)
        fresh = true
      } else if (id !== activeId && paneId && !paneOfTab(activeRef.current, id)) {
        showTab(id, paneId)
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
    [newTab, showTab]
  )

  // Latest-handler indirection so the registry hooks and the window listener never go stale.
  const act = useRef({ newSelected: () => {}, closeActive: () => {}, moveActive: (_dir: -1 | 1) => {}, moveItem: (_dir: -1 | 1) => {}, nestItem: (_dir: -1 | 1) => {} })
  act.current = {
    newSelected: () => selectedId && newTab(selectedId, undefined, focusedPaneId()),
    closeActive: () => {
      const paneId = focusedPaneId()
      const id = paneId ? activeRef.current[paneId] : undefined
      if (id) closeTab(id)
    },
    moveActive: (dir) => {
      const paneId = focusedPaneId()
      const id = paneId ? activeRef.current[paneId] : undefined
      if (id) commitTabs((t) => shiftTab(t, id, dir))
    },
    moveItem: (dir) => {
      const id = stateRef.current?.selectedId
      if (id && !id.startsWith('child:')) void window.api.moveItem(id, dir).then(setState)
    },
    nestItem: (dir) => {
      const id = stateRef.current?.selectedId
      if (id && !id.startsWith('child:')) void window.api.nestItem(id, dir).then(setState)
    }
  }

  useEffect(() => {
    setTermHooks({
      onNewTab: () => act.current.newSelected(),
      onCloseTab: () => act.current.closeActive(),
      onMoveTab: (dir) => act.current.moveActive(dir),
      onMoveItem: (dir) => act.current.moveItem(dir),
      onCwd: (id, cwd) => {
        cwdById.current[id] = cwd
        scheduleSave()
      },
      onExit: handleExit,
      onZoom: (d) => void zoom(d),
      onTogglePanel: (t) => void togglePanel(t),
      onSnippetPicker: () => setPickerOpen(true),
      onOpenSettings: () => setSettingsOpen((o) => !o),
      onToggleSidebar: () => void toggleSidebar()
    })
  }, [handleExit, zoom, togglePanel, toggleSidebar, scheduleSave])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      // Alt+Shift+Left/Right moves the focused pane's active tab; must precede the Ctrl-only early return below.
      if (e.altKey && e.shiftKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // Leave text editing alone (xterm's helper textarea is handled by termRegistry, which prevents default first).
        const el = e.target as HTMLElement | null
        if (el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
        e.preventDefault()
        // Sidebar focused: nest / un-nest the selected item. Otherwise (terminal etc.) move the active tab.
        const dir = e.key === 'ArrowLeft' ? -1 : 1
        if (el?.closest('.tree')) act.current.nestItem(dir)
        else act.current.moveActive(dir)
        return
      }
      if (e.altKey && e.shiftKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const el = e.target as HTMLElement | null
        if (el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
        e.preventDefault()
        act.current.moveItem(e.key === 'ArrowUp' ? -1 : 1)
        return
      }
      if (!e.ctrlKey || e.altKey) return
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
      } else if (!e.shiftKey && k === ',') {
        e.preventDefault()
        setSettingsOpen((o) => !o)
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
      const live = t.kind === 'shell' ? !t.exited && !t.pending : t.run?.status === 'running'
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

  // Agent (MCP) terminals: main spawns the pty and asks for a tab; close_terminal drops it again.
  useEffect(() => {
    const offOpen = window.api.onAgentOpenTab(newAgentTab)
    const offClose = window.api.onAgentCloseTab((id) => closeTab(id))
    return () => {
      offOpen()
      offClose()
    }
  }, [newAgentTab, closeTab])

  // State pushed by the main process (MCP server). A folder or group removed there gets the same cleanup as a
  // removal from the sidebar: its terminals (and a parent group's children's) are closed before the state applies.
  useEffect(
    () =>
      window.api.onStateChanged((next) => {
        const prev = stateRef.current
        if (prev) {
          const gone: string[] = []
          for (const f of prev.folders) if (!next.folders.some((x) => x.id === f.id)) gone.push(f.id)
          for (const g of prev.groups) {
            if (next.groups.some((x) => x.id === g.id)) continue
            gone.push(g.id, ...(g.kind === 'parent' ? g.children.map((c) => c.id) : []))
          }
          if (gone.length > 0) closeTabsOf(gone)
        }
        setState(next)
      }),
    [closeTabsOf, setState]
  )

  if (!state || !widths || !paneState) return <div className="app" />

  const ui = state.ui
  const ps = paneState
  const multi = ps.panes.length > 1
  // A tab is active in at most one pane; terminals are positioned over that pane.
  const paneIndexOfTab = new Map<string, number>()
  ps.panes.forEach((p, i) => active[p.id] && paneIndexOfTab.set(active[p.id], i))
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
            onOpenSettings={() => setSettingsOpen(true)}
            counts={counts}
            onSelect={(id) => void select(id)}
            onNestMove={(id, op, dir) =>
              void (op === 'move' ? window.api.moveItem(id, dir) : window.api.nestItem(id, dir)).then(setState)
            }
            onOpenTerminal={(id) => void openTerminal(id)}
            onOpenToSide={openLocToSide}
            canOpenToSide={(id) => canAddPane(ps, id)}
            onAddFolder={() => void addFolder()}
            onAddParent={async () => setState(await window.api.addParentGroup())}
            onAddGroup={async (name, parentId) => setState(await window.api.addGroup(name, parentId))}
            onMoveGroup={async (id, parentId) => setState(await window.api.moveGroup(id, parentId))}
            onRemoveFolder={async (id) => {
              closeTabsOf([id])
              setState(await window.api.removeFolder(id))
            }}
            onRemoveGroup={async (id) => {
              const { groupIds, folderIds } = removalSet(state.groups, state.folders, id)
              closeTabsOf([
                ...groupIds,
                ...folderIds,
                ...groupIds.flatMap((gid) => state.groups.find((x) => x.id === gid)?.children.map((c) => c.id) ?? [])
              ])
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
              tabDrag.tab = null
              locDrag.id = null
              setDropHint(null)
              const cur = panesRef.current
              if (!h || !cur) return
              e.preventDefault()
              if (h.tabId) {
                // A tab always opens a new pane beside the target (D6); the source pane keeps its place.
                const next = splitBeside(cur, h.locId, h.index, h.side, mkId)
                if (next === cur) return
                commitPanes(next)
                lastByLoc.current[h.locId] = h.tabId
                setActive(activateIn(next.panes, tabsRef.current, activeRef.current, next.panes[next.focused].id, h.tabId))
              } else {
                commitPanes(dropOnEdge(cur, h.locId, h.index, h.side, mkId))
              }
            }}
          >
            {ps.panes.map((p, i) => {
              const loc = (p.locId && locs.get(p.locId)) || null
              const paneTabs = tabs.filter((t) => t.locId === p.locId)
              const paneActive: string | undefined = active[p.id]
              const diff = paneTabs.find((t) => t.id === paneActive && t.kind === 'diff')
              const fileTab = paneTabs.find((t) => t.id === paneActive && t.kind === 'file')
              const removal = loc?.kind === 'manual' ? removalSet(state.groups, state.folders, loc.id) : null
              const members = removal ? removal.folderIds.length + removal.groupIds.length - 1 : 0
              const onlySubgroups = !!removal && removal.folderIds.length === 0 && removal.groupIds.length > 1
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
                        shownElsewhere={takenBy(active, p.id)}
                        onActivate={(id) => {
                          // A tab shown in another pane focuses that pane instead of moving (D4).
                          const other = paneOfTab(active, id)
                          if (other && other !== p.id) focusPane(ps.panes.findIndex((x) => x.id === other))
                          else showTab(id, p.id)
                        }}
                        onReorder={(id, before) => {
                          commitTabs((t) => moveTab(t, id, before))
                          const owner = paneOfTab(active, id)
                          if (!owner || owner === p.id) showTab(id, p.id)
                        }}
                        onAcceptDrag={() => setDropHint(null)}
                        onClose={closeTab}
                        onPin={(id) => commitTabs((all) => all.map((x) => (x.id === id ? { ...x, preview: false } : x)))}
                        onRunAgain={runCommand}
                        onNew={() => newTab(loc.id, undefined, p.id)}
                        onNewAdmin={() => newAdminTab(loc.id, p.id)}
                        onInstallGsudo={() => runCommand(INSTALL_GSUDO_COMMAND, loc.id)}
                        getElevator={() => window.api.getElevator()}
                        onDragEnd={() => {
                          tabDrag.tab = null
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
                    {fileTab?.file && (
                      <FileViewer
                        key={fileTab.id}
                        path={fileTab.file}
                        root={loc?.path ?? null}
                        fontSize={Math.max(11, state.settings.terminalFontSize - 2)}
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
                            ? 'This group is empty. Drag folders or groups onto it or use "Move to group".'
                            : onlySubgroups
                              ? 'This group only contains subgroups. Select a folder in one of them to open a terminal.'
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
                        <button className="btn primary" onClick={() => newTab(loc.id, undefined, p.id)}>
                          <Plus size={15} /> New terminal
                        </button>
                        <p className="hint">
                          <Keys combo="Ctrl+Shift+T" />
                        </p>
                      </div>
                    )}
                    {loc && !loc.missing && paneTabs.length > 0 && !paneActive && (
                      <div className="empty">
                        <span className="empty-icon">
                          <SquareTerminal size={24} strokeWidth={1.75} />
                        </span>
                        <h2>{loc.name}</h2>
                        <p>All terminals of this folder are shown in other panes.</p>
                        {loc.path && (
                          <>
                            <button className="btn primary" onClick={() => newTab(loc.id, undefined, p.id)}>
                              <Plus size={15} /> New terminal
                            </button>
                            <p className="hint">
                              <Keys combo="Ctrl+Shift+T" />
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            {/* Every terminal lives in this one stable list whatever pane shows it: positioning, not reparenting, moves it. */}
            {tabs
              .filter((t) => t.kind === 'shell' || t.kind === 'command')
              .map((t) => {
                const pi = paneIndexOfTab.get(t.id)
                const visible = pi !== undefined
                const style =
                  pi === undefined
                    ? undefined
                    : { left: `calc(${startPct(pi)}% + 14px)`, width: `calc(${ps.fractions[pi] * 100}% - 16px)` }
                if (t.pending) {
                  if (!visible) return null
                  return (
                    <div key={t.id} className="admin-placeholder" style={style}>
                      <span className="empty-icon warn">
                        <Shield size={24} strokeWidth={1.75} />
                      </span>
                      <h2>Administrator terminal (not started)</h2>
                      <p>
                        <span className="path-chip">{t.cwd}</span>
                      </p>
                      <StartAdminButton onStart={() => startAdmin(t.id)} onInstall={() => runCommand(INSTALL_GSUDO_COMMAND, t.locId)} />
                    </div>
                  )
                }
                return (
                  <div key={`${t.id}:${t.attempt ?? 0}`} style={{ display: 'contents' }}>
                    <TerminalView
                      id={t.id}
                      elevated={t.elevated}
                      agent={t.agent}
                      cwd={t.cwd}
                      shell={t.shell}
                      fallbackCwd={fallbackById.current[t.id]}
                      steps={t.steps}
                      locId={t.locId}
                      visible={visible}
                      focused={visible && pi === ps.focused}
                      style={style}
                    />
                    {t.elevated && t.exited && visible && (
                      <div className="admin-retry" style={style}>
                        <StartAdminButton className="btn small" onStart={() => startAdmin(t.id)} onInstall={() => runCommand(INSTALL_GSUDO_COMMAND, t.locId)} />
                      </div>
                    )}
                  </div>
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
                  onOpenFile={(path, pin) => openFile(path, pin)}
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
      {settingsOpen && state && (
        <SettingsDialog
          settings={state.settings}
          homePath={state.home.path}
          onChange={(patch) => void window.api.setSettings(patch).then(setState)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
