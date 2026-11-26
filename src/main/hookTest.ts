// Settings > Agent status > Test. Runs the installed hook script for real against the app's /status with a throwaway
// `hooktest:` id. Read only: never writes settings.json or the script, never changes a tab. No electron import (smoke runs it).
// Async spawn only: the HTTP server lives in this process, so a blocking spawnSync would deadlock the request.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { classifyHookTest, hookScript, HOOK_TEST_PREFIX, type HookTestFacts, type HookTestResult } from '../shared/claudeHooks'
import { expectHookTest } from './mcp'

function curlOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const c = spawn('where.exe', ['curl.exe'], { windowsHide: true, stdio: 'ignore' })
      c.on('error', () => resolve(false))
      c.on('close', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

export async function runHookTest(o: {
  scriptPath: string
  statusUrl: string | null
  token: string
  hooks: { installed: boolean; outdated: boolean }
  timeoutMs?: number
}): Promise<HookTestResult> {
  const scriptExists = existsSync(o.scriptPath)
  let scriptCurrent = false
  if (scriptExists) {
    try {
      scriptCurrent = readFileSync(o.scriptPath, 'utf8') === hookScript()
    } catch {
      scriptCurrent = false
    }
  }
  const facts: HookTestFacts = { installed: o.hooks.installed, outdated: o.hooks.outdated, scriptExists, scriptCurrent, serverUp: !!o.statusUrl }
  if ((!facts.installed && !facts.outdated) || !scriptExists || !scriptCurrent || !facts.serverUp) return classifyHookTest(facts)

  const id = HOOK_TEST_PREFIX + randomUUID()
  const test = expectHookTest(id)
  const t0 = Date.now()
  let timer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  try {
    const settled = new Promise<'ok' | 'unauthorized' | 'bad-payload' | undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), o.timeoutMs ?? 6000)
      void test.hit.then(resolve)
      try {
        const child = spawn('cmd.exe', ['/d', '/c', o.scriptPath], {
          env: { ...process.env, TERMINALS_STATUS_URL: o.statusUrl ?? '', TERMINALS_MCP_TOKEN: o.token, TERMINALS_TERM_ID: id },
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'ignore']
        })
        child.stdin.on('error', () => {})
        child.stdin.end('{"hook_event_name":"Stop"}')
        child.on('error', () => resolve(undefined))
        // The request is answered before curl exits; give a late hit a moment after the script is gone.
        child.on('close', () => {
          graceTimer = setTimeout(() => resolve(undefined), 500)
        })
      } catch {
        resolve(undefined)
      }
    })
    const hit = await settled
    const ms = Date.now() - t0
    const curlFound = hit === undefined ? await curlOnPath() : undefined
    return classifyHookTest({ ...facts, hit, curlFound, ms })
  } finally {
    clearTimeout(timer)
    clearTimeout(graceTimer)
    test.dispose()
  }
}
