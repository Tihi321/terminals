import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { resolveShell, spawnShell, spawnSteps } from './pty'

interface CheckResult {
  ok: boolean
  msg: string
}

/** Check 1: interactive shell, echo a marker, wait for it in the output. */
function checkInteractive(dir: string, shell: string, track: (p: IPty) => void): Promise<CheckResult> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const finish = (ok: boolean, msg: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      // Resolve outside the pty callback (tearing down from inside it can deadlock).
      setTimeout(() => resolve({ ok, msg }), 0)
    }
    const p = spawnShell(shell, dir, 80, 24, {
      onData: (d) => {
        output += d
        // The command below builds the marker by concatenation, so the echoed input line
        // (which PSReadLine redraws with escape codes) can never match; only real output does.
        if (output.includes('smoke-ok')) finish(true, `interactive: shell ${shell} printed smoke-ok in ${dir}`)
      },
      onExit: (code) => finish(false, `interactive: shell exited early with code ${code}`)
    })
    track(p)
    const timer = setTimeout(
      () => finish(false, `interactive: timeout waiting for smoke-ok. Output: ${JSON.stringify(output.slice(-300))}`),
      10000
    )
    const cmd = /pwsh|powershell/i.test(shell) ? "Write-Output ('smoke-' + 'ok')" : 'echo smoke-ok'
    setTimeout(() => p.write(cmd + '\r'), 1500)
  })
}

/** Check 2: a 2-step command; step 1 prints a1, step 2 exits 3. Expect output with a1 and exit code 3. */
function checkSteps(dir: string, shell: string, track: (p: IPty) => void): Promise<CheckResult> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const finish = (ok: boolean, msg: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      setTimeout(() => resolve({ ok, msg }), 0)
    }
    const p = spawnSteps(shell, ["Write-Output ('a'+'1')", 'exit 3'], dir, 80, 24, {
      onData: (d) => (output += d),
      onExit: (code) => {
        if (code === 3 && output.includes('a1')) finish(true, `steps: output contained a1 and exit code was 3`)
        else finish(false, `steps: exit code ${code}, output ${JSON.stringify(output.slice(-300))}`)
      }
    })
    track(p)
    const timer = setTimeout(
      () => finish(false, `steps: timeout. Output: ${JSON.stringify(output.slice(-300))}`),
      15000
    )
  })
}

export async function runSmoke(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'terminals-smoke-'))
  const shell = resolveShell('')
  const ptys: IPty[] = []
  const track = (p: IPty): void => void ptys.push(p)

  const results = [await checkInteractive(dir, shell, track), await checkSteps(dir, shell, track)]
  for (const r of results) console.log(r.ok ? `PASS: ${r.msg}` : `FAIL: ${r.msg}`)
  const ok = results.every((r) => r.ok)

  for (const p of ptys) {
    try {
      p.kill()
    } catch {
      /* already gone */
    }
  }
  // process.exit rather than app.exit: Electron's quit path hangs while conpty handles are open.
  setTimeout(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    process.exit(ok ? 0 : 1)
  }, 500)
}
