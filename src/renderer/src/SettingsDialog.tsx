import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { FolderOpen, X } from 'lucide-react'
import type { LoginItemState, Settings, ShellOption } from '../../shared/types'
import {
  DEFAULT_SETTINGS,
  DEFAULT_TERMINAL_FONT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN
} from '../../shared/settings'
import { THEMES, THEME_IDS } from '../../shared/themes'
import './SettingsDialog.css'

type FieldDef =
  | { key: 'theme' | 'cursorStyle' | 'shell' | 'worktreeLayout'; kind: 'select'; label: string; hint?: string }
  | { key: 'terminalFontSize' | 'scrollback'; kind: 'number'; label: string; min: number; max: number; step: number; hint?: string }
  | { key: 'cursorBlink' | 'allowMcpRun' | 'agentHeuristics'; kind: 'toggle'; label: string; hint?: string }
  | { key: 'homeDir'; kind: 'path'; label: string; hint?: string }
  | { key: 'terminalFontFamily' | 'editor'; kind: 'text'; label: string; presets?: string[]; hint?: string }

const FONT_PRESETS = [DEFAULT_TERMINAL_FONT, "'Cascadia Code'", 'Consolas', "'JetBrains Mono'", "'Fira Code'", "'Courier New'"]

const SECTIONS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Appearance',
    fields: [
      { key: 'theme', kind: 'select', label: 'Theme' },
      {
        key: 'terminalFontFamily',
        kind: 'text',
        label: 'Terminal font',
        presets: FONT_PRESETS,
        hint: 'Any installed font. Unknown fonts fall back to monospace.'
      },
      {
        key: 'terminalFontSize',
        kind: 'number',
        label: 'Font size',
        min: FONT_SIZE_MIN,
        max: FONT_SIZE_MAX,
        step: 1,
        hint: 'Ctrl + / Ctrl - / Ctrl 0 also change it.'
      }
    ]
  },
  {
    title: 'Cursor',
    fields: [
      { key: 'cursorStyle', kind: 'select', label: 'Cursor style' },
      { key: 'cursorBlink', kind: 'toggle', label: 'Blinking cursor' }
    ]
  },
  {
    title: 'Terminal',
    fields: [
      {
        key: 'scrollback',
        kind: 'number',
        label: 'Scrollback (lines)',
        min: SCROLLBACK_MIN,
        max: SCROLLBACK_MAX,
        step: 1000,
        hint: 'Lines kept per terminal. Lowering it trims open terminals.'
      },
      {
        key: 'shell',
        kind: 'select',
        label: 'Default shell',
        hint: 'Applies to new terminals. Open terminals keep their shell. Saved commands run with PowerShell or cmd.'
      }
    ]
  },
  {
    title: 'Integrations',
    fields: [{ key: 'editor', kind: 'text', label: 'Editor', hint: 'Executable on PATH used by Open in editor.' }]
  },
  {
    title: 'Home',
    fields: [{ key: 'homeDir', kind: 'path', label: 'Home folder', hint: 'Where Home terminals start. Empty = your Documents folder.' }]
  },
  {
    title: 'Git',
    fields: [{ key: 'worktreeLayout', kind: 'select', label: 'Worktree location', hint: 'Applies to new worktrees.' }]
  },
  {
    title: 'Agent status',
    fields: [
      {
        key: 'agentHeuristics',
        kind: 'toggle',
        label: 'Detect agent status from terminal output',
        hint: 'Used for tabs whose agent does not report. Claude Code only.'
      }
    ]
  },
  {
    title: 'MCP',
    fields: [
      {
        key: 'allowMcpRun',
        kind: 'toggle',
        label: 'Allow MCP to run commands',
        hint: "Lets MCP clients with this app's token open terminals, run commands, type into and read them. Off by default."
      }
    ]
  }
]

const CURSOR_OPTIONS = [
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' },
  { value: 'underline', label: 'Underline' }
]

const DEBOUNCE_MS = 400

const clampNum = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(n)))

/** Text/number input with a local draft; commits 400 ms after the last keystroke, on blur, Enter and unmount. */
function DraftInput(p: {
  value: string | number
  numeric?: { min: number; max: number; step: number }
  list?: string
  placeholder?: string
  onCommit: (v: string | number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(p.value))
  const draftRef = useRef(draft)
  const pending = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const focused = useRef(false)
  const latest = useRef(p)
  latest.current = p

  /** Returns what should be shown after committing (normalised the way the store will). */
  const commit = (): string => {
    window.clearTimeout(timer.current)
    pending.current = false
    const { numeric, value, onCommit } = latest.current
    const text = draftRef.current
    if (numeric) {
      const n = Number(text)
      if (text.trim() === '' || Number.isNaN(n)) return String(value)
      const v = clampNum(n, numeric.min, numeric.max)
      if (v !== value) onCommit(v)
      return String(v)
    }
    const v = text.trim()
    if (v !== value) onCommit(v)
    return v
  }

  useEffect(() => {
    if (!focused.current) {
      draftRef.current = String(p.value)
      setDraft(draftRef.current)
    }
  }, [p.value])

  useEffect(
    () => () => {
      if (pending.current) commit()
      window.clearTimeout(timer.current)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  return (
    <input
      type={p.numeric ? 'number' : 'text'}
      min={p.numeric?.min}
      max={p.numeric?.max}
      step={p.numeric?.step}
      list={p.list}
      placeholder={p.placeholder}
      spellCheck={false}
      value={draft}
      onFocus={() => (focused.current = true)}
      onChange={(e) => {
        draftRef.current = e.target.value
        setDraft(e.target.value)
        pending.current = true
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(commit, DEBOUNCE_MS)
      }}
      onBlur={() => {
        focused.current = false
        const shown = commit()
        draftRef.current = shown
        setDraft(shown)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const shown = commit()
          draftRef.current = shown
          setDraft(shown)
        }
      }}
    />
  )
}

interface HooksState {
  installed: boolean
  outdated: boolean
  path: string
  config: object
}

/** Claude Code hooks: install / remove / copy. Nothing is written to ~/.claude/settings.json without a click. */
function ClaudeHooksRow(): JSX.Element {
  const [state, setState] = useState<HooksState | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)

  const load = async (): Promise<void> => {
    const r = await window.api.getClaudeHooks()
    if (r.ok) setState({ installed: r.installed, outdated: r.outdated, path: r.path, config: r.config })
    else setMsg({ text: r.error, error: true })
  }

  useEffect(() => {
    let alive = true
    window.api
      .getClaudeHooks()
      .then((r) => {
        if (!alive) return
        if (r.ok) setState({ installed: r.installed, outdated: r.outdated, path: r.path, config: r.config })
        else setMsg({ text: r.error, error: true })
      })
      .catch((e) => alive && setMsg({ text: String(e), error: true }))
    return () => {
      alive = false
    }
  }, [])

  const run = async (mode: 'install' | 'remove'): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await (mode === 'install' ? window.api.installClaudeHooks() : window.api.removeClaudeHooks())
      if (r.ok) {
        const verb = mode === 'install' ? 'Installed' : 'Removed'
        setMsg({ text: `${verb} in ${r.path}.${r.backup ? ` Backup: ${r.backup}` : ''}`, error: false })
      } else setMsg({ text: r.error, error: true })
      await load()
    } catch (e) {
      setMsg({ text: String(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (!state) return
    try {
      await window.api.clipboardWrite(JSON.stringify(state.config, null, 2))
      setMsg({ text: 'Hooks JSON copied.', error: false })
    } catch (e) {
      setMsg({ text: String(e), error: true })
    }
  }

  return (
    <div className="field">
      <span>Claude Code hooks</span>
      <div className="settings-path">
        <span className="hint">{state ? (state.installed ? 'Installed' : state.outdated ? 'Installed (outdated) – Reinstall' : 'Not installed') : 'Checking…'}</span>
        <button className="btn" disabled={busy || !state} onClick={() => void run('install')}>
          {state?.installed || state?.outdated ? 'Reinstall' : 'Install'}
        </button>
        <button className="btn" disabled={busy || !(state?.installed || state?.outdated)} onClick={() => void run('remove')}>
          Remove
        </button>
        <button className="btn" disabled={!state} onClick={() => void copy()}>
          Copy JSON
        </button>
      </div>
      {state && <small className="settings-hint">{state.path}</small>}
      <small className="settings-hint">
        Hooks report working, needs-you and done exactly. Install writes them to this file (the old one is backed up). Copy JSON alone does not
        create the script; click Install once.
      </small>
      {msg && (
        <small className="settings-hint" role={msg.error ? 'alert' : 'status'} style={msg.error ? { color: 'var(--danger, #e5534b)' } : undefined}>
          {msg.text}
        </small>
      )}
    </div>
  )
}

export function SettingsDialog({
  settings,
  homePath,
  onChange,
  onClose
}: {
  settings: Settings
  /** Resolved Home directory (shown as the placeholder when the setting is empty). */
  homePath: string
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}): JSX.Element {
  const [shells, setShells] = useState<ShellOption[]>([])
  // Read from the OS every time the dialog opens; it is not part of the saved settings.
  const [login, setLogin] = useState<LoginItemState | null>(null)

  useEffect(() => {
    let alive = true
    window.api
      .getLoginItem()
      .then((s) => alive && setLogin(s))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    window.api
      .listShells()
      .then((s) => alive && setShells(s))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const set = (key: keyof Settings, value: unknown): void => onChange({ [key]: value } as Partial<Settings>)

  const selectOptions = (key: 'theme' | 'cursorStyle' | 'shell' | 'worktreeLayout'): { value: string; label: string; disabled?: boolean }[] => {
    if (key === 'worktreeLayout')
      return [
        { value: 'container', label: 'Next to the repo in <repo>.worktrees\\<branch>' },
        { value: 'sibling', label: 'Next to the repo as <repo>-<branch>' }
      ]
    if (key === 'theme') return [{ value: 'system', label: 'Follow system' }, ...THEME_IDS.map((id) => ({ value: id, label: THEMES[id].name }))]
    if (key === 'cursorStyle') return CURSOR_OPTIONS
    const opts = shells.map((s) => ({
      value: s.value,
      label: s.available ? s.label : `${s.label} (not found)`,
      disabled: !s.available
    }))
    if (!opts.some((o) => o.value === settings.shell)) opts.unshift({ value: settings.shell, label: `Custom: ${settings.shell}`, disabled: false })
    return opts
  }

  const reset = (): void => {
    const {
      shell: _shell,
      editor: _editor,
      homeDir: _homeDir,
      allowMcpRun: _allowMcpRun,
      agentHeuristics: _agentHeuristics,
      ...rest
    } = DEFAULT_SETTINGS
    void _shell
    void _editor
    void _homeDir
    void _allowMcpRun
    void _agentHeuristics
    onChange(rest)
  }

  const renderField = (f: FieldDef): JSX.Element => {
    const hint = f.hint ? <small className="settings-hint">{f.hint}</small> : null
    switch (f.kind) {
      case 'select':
        return (
          <label className="field" key={f.key}>
            <span>{f.label}</span>
            <select autoFocus={f.key === 'theme'} value={settings[f.key]} onChange={(e) => set(f.key, e.target.value)}>
              {selectOptions(f.key).map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </select>
            {hint}
          </label>
        )
      case 'toggle':
        return (
          <label className="field settings-toggle" key={f.key}>
            <span>{f.label}</span>
            <input type="checkbox" role="switch" className="settings-switch" checked={settings[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
            {hint}
          </label>
        )
      case 'number':
        return (
          <label className="field" key={f.key}>
            <span>{f.label}</span>
            <DraftInput value={settings[f.key]} numeric={{ min: f.min, max: f.max, step: f.step }} onCommit={(v) => set(f.key, v)} />
            {hint}
          </label>
        )
      case 'path':
        return (
          <div className="field" key={f.key}>
            <span>{f.label}</span>
            <div className="settings-path">
              <DraftInput value={settings[f.key]} placeholder={homePath} onCommit={(v) => set(f.key, v)} />
              <button
                className="btn"
                onClick={() => {
                  void window.api.pickFolder().then((p) => p && set(f.key, p))
                }}
              >
                <FolderOpen size={14} /> Browse…
              </button>
              <button className="btn" disabled={settings[f.key] === ''} onClick={() => set(f.key, '')}>
                Use Documents
              </button>
            </div>
            {hint}
          </div>
        )
      case 'text':
        return (
          <label className="field" key={f.key}>
            <span>{f.label}</span>
            <DraftInput value={settings[f.key]} list={f.presets ? `settings-presets-${f.key}` : undefined} onCommit={(v) => set(f.key, v)} />
            {f.presets && (
              <datalist id={`settings-presets-${f.key}`}>
                {f.presets.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            )}
            {hint}
          </label>
        )
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal settings-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-head">
          <h3 id="settings-title">Settings</h3>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {SECTIONS.map((s) => (
            <section className="settings-section" key={s.title}>
              <h4>{s.title}</h4>
              {s.fields.map(renderField)}
              {s.title === 'Integrations' && (
                <label className="field settings-toggle">
                  <span>Open at Windows login</span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="settings-switch"
                    checked={login?.enabled ?? false}
                    disabled={!login?.supported}
                    onChange={(e) => {
                      void window.api
                        .setLoginItem(e.target.checked)
                        .then(setLogin)
                        .catch(() => {})
                    }}
                  />
                  {login && !login.supported && <small className="settings-hint">Only available in the installed app.</small>}
                </label>
              )}
              {s.title === 'Agent status' && <ClaudeHooksRow />}
            </section>
          ))}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={reset} title="Resets appearance, cursor and scrollback. Shell, editor, Home folder and MCP access are kept.">
            Reset to defaults
          </button>
          <span className="hint settings-foot-hint">Changes apply immediately.</span>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
