// Installs/removes the status hooks in the user's Claude Code settings. Only runs on an explicit button click
// (plus rewriting the hook script at start when the hooks are already installed).
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { claudeHooksConfig, hookScript, hooksInstalled, hooksPresent, HOOK_SCRIPT_NAME, mergeClaudeHooks, type ClaudeSettings } from '../shared/claudeHooks'
import type { Result } from '../shared/types'

export function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
}

export function scriptPath(): string {
  return join(app.getPath('userData'), HOOK_SCRIPT_NAME)
}

/** Writes the hook script when missing or different. */
export function ensureHookScript(): string {
  const p = scriptPath()
  const want = hookScript()
  let cur: string | null = null
  try {
    cur = readFileSync(p, 'utf8')
  } catch {
    /* missing */
  }
  if (cur !== want) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, want)
  }
  return p
}

function readSettings(): Result<{ settings: ClaudeSettings }> {
  const file = settingsPath()
  let text: string
  try {
    // A UTF-8 BOM would make JSON.parse fail; it is dropped here and not written back.
    text = readFileSync(file, 'utf8').replace(/^﻿/, '')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, settings: {} }
    return { ok: false, error: `Could not read ${file}: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!text.trim()) return { ok: true, settings: {} }
  try {
    const v: unknown = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `${file} is not a JSON object; nothing was changed.` }
    return { ok: true, settings: v as ClaudeSettings }
  } catch (e) {
    return { ok: false, error: `${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); nothing was changed.` }
  }
}

export function getHooks(): Result<{ installed: boolean; outdated: boolean; path: string; scriptPath: string; config: object }> {
  const r = readSettings()
  if (!r.ok) return r
  const installed = hooksInstalled(r.settings, scriptPath())
  return { ok: true, installed, outdated: !installed && hooksPresent(r.settings), path: settingsPath(), scriptPath: scriptPath(), config: claudeHooksConfig(scriptPath()) }
}

function change(mode: 'install' | 'remove'): Result<{ installed: boolean; path: string; backup: string | null }> {
  const r = readSettings()
  if (!r.ok) return r
  const file = settingsPath()
  try {
    if (mode === 'install') ensureHookScript()
    const next = mergeClaudeHooks(r.settings, mode, scriptPath())
    let backup: string | null = null
    if (existsSync(file)) {
      backup = file + '.terminals-backup'
      // Keep the first backup: it is the user's original, which Install then Remove must not overwrite.
      if (!existsSync(backup)) copyFileSync(file, backup)
    } else mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
    return { ok: true, installed: hooksInstalled(next, scriptPath()), path: file, backup }
  } catch (e) {
    return { ok: false, error: `Could not write ${file}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export const installHooks = (): ReturnType<typeof change> => change('install')
export const removeHooks = (): ReturnType<typeof change> => change('remove')
