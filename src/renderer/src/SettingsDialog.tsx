import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { Settings, ShellOption } from '../../shared/types'
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
  | { key: 'theme' | 'cursorStyle' | 'shell'; kind: 'select'; label: string; hint?: string }
  | { key: 'terminalFontSize' | 'scrollback'; kind: 'number'; label: string; min: number; max: number; step: number; hint?: string }
  | { key: 'cursorBlink'; kind: 'toggle'; label: string; hint?: string }
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

export function SettingsDialog({
  settings,
  onChange,
  onClose
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}): JSX.Element {
  const [shells, setShells] = useState<ShellOption[]>([])

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

  const selectOptions = (key: 'theme' | 'cursorStyle' | 'shell'): { value: string; label: string; disabled?: boolean }[] => {
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
    const { shell: _shell, editor: _editor, ...rest } = DEFAULT_SETTINGS
    void _shell
    void _editor
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
            </section>
          ))}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={reset} title="Resets appearance, cursor and scrollback. Shell and editor are kept.">
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
