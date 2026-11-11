import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, FolderTree, FolderX, Play, Plus, RotateCw, SquareTerminal, Terminal, X, Zap } from 'lucide-react'
import type { AppState, Command } from '../../shared/types'
import { Sidebar } from './Sidebar'
import { TerminalView } from './TerminalView'
import { FileTree } from './FileTree'
import { CommandsPanel } from './CommandsPanel'
import type { RunInfo } from './CommandsPanel'
import { baseName, buildLocs } from './locations'
import { createTerm, getTerm, setTermHooks, setTerminalFontSize, DEFAULT_FONT_SIZE } from './termRegistry'

interface Tab {
  id: string
  /** Sidebar entry (folder, child or group) whose tab bar this belongs to. */
  locId: string
  cwd: string
  title: string
  kind: 'shell' | 'command'
  /** Shell tabs: the process ended. */
  exited: boolean
  /** Command tabs only. */
  steps?: string[]
  run?: { commandId: string; runId: string; status: 'running' | 'success' | 'failed'; exitCode?: number }
}

interface RunCtl {
  cmd: Command
  locId: string
  nextIndex: number
  stopped: boolean
}

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

  const newTab = useCallback(
    (locId: string, cwdOverride?: string) => {
      const st = stateRef.current
      if (!st) return
      const loc = buildLocs(st).get(locId)
      const cwd = cwdOverride ?? loc?.path
      if (!loc || !cwd || (loc.missing && !cwdOverride)) return
      const id = crypto.randomUUID()
      const n = (counters.current[locId] = (counters.current[locId] ?? 0) + 1)
      createTerm(id)
      const title = cwdOverride ? baseName(cwdOverride) : `${shellLabel(st.resolvedShell)} ${n}`
      commitTabs((t) => [...t, { id, locId, cwd, title, kind: 'shell', exited: false }])
      setActiveByLoc((a) => ({ ...a, [locId]: id }))
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
      const title = ctl.cmd.targets.length > 1 ? `▶ ${ctl.cmd.name} · ${baseName(target.cwd)}` : `▶ ${ctl.cmd.name}`
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
      window.api.ptyKill(id)
      getTerm(id)?.dispose()
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
    async (tab: 'files' | 'commands') => {
      const ui = stateRef.current?.ui
      if (!ui) return
      const open = ui.panelOpen && ui.panelTab === tab
      setState(await window.api.setUi({ panelOpen: !open, panelTab: tab }))
    },
    [setState]
  )

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

  useEffect(() => {
    document.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

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
      onTogglePanel: (t) => void togglePanel(t)
    })
  }, [handleExit, zoom, togglePanel])

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
      } else if (e.shiftKey && (k === 'e' || k === 'r')) {
        e.preventDefault()
        void togglePanel(k === 'e' ? 'files' : 'commands')
      } else if (k === '=' || k === '+' || k === '-' || k === '0') {
        e.preventDefault()
        void zoom(k === '0' ? 0 : k === '-' ? -1 : 1)
      }
    }
    const onFailed = (e: Event): void => handleExit((e as CustomEvent<string>).detail, 1)
    window.addEventListener('keydown', onKey)
    window.addEventListener('terminal-failed', onFailed)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('terminal-failed', onFailed)
    }
  }, [handleExit, togglePanel, zoom])

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

  if (!state || !widths) return <div className="app" />

  const ui = state.ui
  const folderTabs = tabs.filter((t) => t.locId === selectedId)
  const manualMembers = selected?.kind === 'manual' ? state.folders.filter((f) => f.groupId === selected.id).length : 0

  const addFolder = async (): Promise<void> => setState(await window.api.addFolder())

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-left">
          <SquareTerminal size={16} className="titlebar-logo" />
          <span className="titlebar-name">Terminals</span>
          {selected && (
            <span className="titlebar-path" title={selected.path ?? selected.name}>
              {selected.path ?? selected.name}
            </span>
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
        </div>
      </header>
      <div className="body">
        <div className="sidebar-wrap" style={{ width: widths.sb }}>
          <Sidebar
            state={state}
            counts={counts}
            onSelect={(id) => void select(id)}
            onOpenTerminal={(id) => void openTerminal(id)}
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
        <main className="main">
          {selected && (
            <div className="tabbar">
              {folderTabs.map((t) => {
                const status = t.kind === 'command' ? t.run?.status : t.exited ? 'exited' : undefined
                const finished = t.kind === 'command' && t.run?.status !== 'running'
                return (
                  <div
                    key={t.id}
                    className={`tab ${t.id === activeTabId ? 'active' : ''} ${t.exited ? 'exited' : ''}`}
                    onClick={() => setActiveByLoc((a) => ({ ...a, [t.locId]: t.id }))}
                    onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                    title={`${t.title}\n${t.cwd}${status ? `\n(${status})` : ''}`}
                  >
                    {t.kind === 'command' ? <Zap size={13} className="tab-icon" /> : <Terminal size={13} className="tab-icon" />}
                    <span className="tab-title">{t.title}</span>
                    {t.kind === 'command' && <span className={`dot ${t.run?.status}`} />}
                    {t.exited && <span className="tab-exited">exited</span>}
                    {finished && t.run && (
                      <button
                        className="tab-btn"
                        title="Run again"
                        disabled={!state.commands.some((c) => c.id === t.run?.commandId)}
                        onClick={(e) => {
                          e.stopPropagation()
                          const cmd = state.commands.find((c) => c.id === t.run?.commandId)
                          if (cmd) runCommand(cmd)
                        }}
                      >
                        <RotateCw size={13} />
                      </button>
                    )}
                    <button
                      className="tab-btn"
                      title="Close terminal"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(t.id)
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )
              })}
              <button
                className="tab-new"
                title="New terminal (Ctrl+Shift+T)"
                disabled={selected.missing || !selected.path}
                onClick={() => newTab(selected.id)}
              >
                <Plus size={16} />
              </button>
            </div>
          )}
          <div className="term-area">
            {tabs.map((t) => (
              <TerminalView
                key={t.id}
                id={t.id}
                cwd={t.cwd}
                steps={t.steps}
                visible={t.locId === selectedId && t.id === activeTabId}
              />
            ))}
            {!selected && (
              <div className="empty">
                <FolderTree size={36} />
                <h2>No folder selected</h2>
                <p>Add a folder, or a parent folder whose subfolders are discovered automatically.</p>
                <button className="btn primary" onClick={() => void addFolder()}>
                  <Plus size={14} /> Add folder
                </button>
              </div>
            )}
            {selected && selected.missing && (
              <div className="empty">
                <FolderX size={36} />
                <h2 className="warn">Folder not found</h2>
                <p>{selected.path} no longer exists on disk. Terminals cannot be opened here.</p>
              </div>
            )}
            {selected && !selected.missing && !selected.path && folderTabs.length === 0 && (
              <div className="empty">
                <FolderTree size={36} />
                <h2>{selected.name}</h2>
                <p>
                  {manualMembers === 0
                    ? 'This group is empty. Drag folders onto it or use "Move to group".'
                    : 'Select one of the folders in this group to open a terminal.'}
                </p>
                <p className="hint">Commands saved on this group are in the Commands panel (Ctrl+Shift+R).</p>
              </div>
            )}
            {selected && !selected.missing && selected.path && folderTabs.length === 0 && (
              <div className="empty">
                <SquareTerminal size={36} />
                <h2>{selected.name}</h2>
                <p>No terminals open here.</p>
                <button className="btn primary" onClick={() => newTab(selected.id)}>
                  <Plus size={14} /> New terminal
                </button>
                <p className="hint">Ctrl+Shift+T</p>
              </div>
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
                />
              )}
            </aside>
          </>
        )}
      </div>
    </div>
  )
}
