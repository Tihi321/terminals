import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { HOOK_TEST_PREFIX } from '../shared/claudeHooks'
import { parseReportedStatus, statusFromHookEvent, type HookOutcome } from '../shared/agentStatus'
import { TOOLS, ToolError, type ToolContext } from './mcpTools'
import type { TerminalControl } from './terminalHost'

/**
 * Built-in MCP server (Streamable HTTP, stateless, JSON responses) so a Claude Code session in one of the app's
 * terminals can manage folders, groups, commands and prompts. Bound to 127.0.0.1, bearer-token protected.
 */

export const DEFAULT_MCP_PORT = 47821
export const MCP_PATH = '/mcp'
/** Sent by the MCP client from the terminal's TERMINALS_LOC_ID; Node lower-cases header names. */
const LOCATION_HEADER = 'x-terminals-location'
/** Sent from the terminal's TERMINALS_TERM_ID (the pty/tab id). */
const TERM_HEADER = 'x-terminals-term'
export const STATUS_PATH = '/status'
const STATUS_BODY_CAP = 4 * 1024 * 1024
const TOKEN_FILE = 'mcp-token'

type HookTestHit = 'ok' | 'unauthorized' | 'bad-payload'
/** Settings > Agent status > Test: registered `hooktest:` ids waiting for their request. */
const hookTests = new Map<string, (hit: HookTestHit) => void>()

/** Registers a test id; `hit` resolves on its first request. Call `dispose` when done. */
export function expectHookTest(id: string): { hit: Promise<HookTestHit>; dispose(): void } {
  let resolveHit: (h: HookTestHit) => void = () => {}
  const hit = new Promise<HookTestHit>((r) => {
    resolveHit = r
  })
  hookTests.set(id, resolveHit)
  return { hit, dispose: () => void hookTests.delete(id) }
}

export interface McpInfo {
  url: string
  token: string
  port: number
  /** POST endpoint for agent status reports (Claude Code hooks): exported to terminals as TERMINALS_STATUS_URL. */
  statusUrl: string
  /** Stops listening (used by smoke). */
  close?: () => Promise<void>
}

const INSTRUCTIONS =
  "Manages the Terminals app: saved folders, groups, saved commands and prompts, and (when the user has turned on \"Allow MCP to run commands\") its terminals. open_terminal opens a visible PowerShell tab (default: the Home location) in the background and returns its id; the app window is never shown or focused unless open_terminal is called with reveal: true. report_status sets the agent status (working, done, needs-you, idle) shown on this terminal's tab. run_command runs a command in that live shell and returns its output, exit code and a runId (if it times out, get_run_result collects the final result); send_input types raw text; read_terminal returns recent output, or the rendered screen with screen: true (for full-screen programs); wait_for_output waits for a line of output to match one or several patterns; close_terminal closes it. Only terminals opened through MCP can be typed into or closed. \"This folder\" is the terminal's location from get_context."


/** Reads the token from the data dir, creating it on first use. */
export function loadOrCreateToken(dir: string): string {
  const file = join(dir, TOKEN_FILE)
  try {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(t)) return t
  } catch {
    /* first run */
  }
  const t = randomBytes(32).toString('hex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, t + '\n', { mode: 0o600 })
  return t
}

/** Constant-time check of an `Authorization: Bearer <token>` header (hashing first evens out the lengths). */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  const given = createHash('sha256').update(m ? m[1] : '').digest()
  const want = createHash('sha256').update(token).digest()
  return timingSafeEqual(given, want) && !!m && token.length > 0
}

/** Host must be 127.0.0.1 or localhost on our port: blocks DNS rebinding. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  const m = /^(127\.0\.0\.1|localhost):(\d+)$/i.exec(host ?? '')
  return !!m && Number(m[2]) === port
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

function buildServer(ctx: ToolContext, version: string, onChange: () => void): McpServer {
  const server = new McpServer({ name: 'terminals', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.shape,
        annotations: { readOnlyHint: t.readOnly ?? !t.mutates, destructiveHint: !!t.destructive, openWorldHint: false }
      },
      async (args) => {
        try {
          const result = await t.run(args as Record<string, unknown>, ctx)
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        } catch (e) {
          const text = e instanceof ToolError ? e.message : `Internal error: ${e instanceof Error ? e.message : String(e)}`
          if (!(e instanceof ToolError)) console.error(`MCP tool ${t.name} failed`, e)
          return { content: [{ type: 'text' as const, text }], isError: true }
        } finally {
          // Even a failed mutating call may have changed something before it threw.
          if (t.mutates) onChange()
        }
      }
    )
  }
  return server
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  info: McpInfo,
  dataDir: string,
  version: string,
  onChange: () => void,
  terminals: TerminalControl | null,
  allowRun: () => boolean
): Promise<void> {
  if (!hostAllowed(req.headers.host, info.port)) return sendError(res, 403, 'Forbidden: bad Host header')
  // Browsers always send Origin on cross-origin requests; CLI MCP clients do not.
  if (req.headers.origin !== undefined) return sendError(res, 403, 'Forbidden: browser requests are not accepted')
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (!tokenMatches(req.headers.authorization, info.token)) {
    if (pathname === STATUS_PATH) {
      const rawId = req.headers[TERM_HEADER]
      hookTests.get(((Array.isArray(rawId) ? rawId[0] : rawId) || '').trim())?.('unauthorized')
    }
    return sendError(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' })
  }
  if (pathname === STATUS_PATH) return handleStatus(req, res, terminals)
  if (pathname !== MCP_PATH) return sendError(res, 404, 'Not found')
  // Stateless JSON-only server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed', { Allow: 'POST' })

  const raw = req.headers[LOCATION_HEADER]
  const headerLocation = (Array.isArray(raw) ? raw[0] : raw) || undefined
  const rawTerm = req.headers[TERM_HEADER]
  const headerTerm = (Array.isArray(rawTerm) ? rawTerm[0] : rawTerm) || undefined
  const server = buildServer({ headerLocation, headerTerm, dataDir, terminals, allowRun }, version, onChange)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}

function reply(res: ServerResponse, status: number): void {
  // Always an empty body: a hook's stdout can end up in the model's context.
  res.writeHead(status)
  res.end()
}

const TOO_LARGE: unique symbol = Symbol('too-large')

function readBody(req: IncomingMessage): Promise<string | typeof TOO_LARGE | null> {
  // Resolves TOO_LARGE (after discarding the rest) when over the cap; null on a read error.
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > STATUS_BODY_CAP) {
        chunks.length = 0
        req.removeAllListeners('data')
        req.resume()
        resolvePromise(TOO_LARGE)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolvePromise(null))
  })
}

/** POST /status: a Claude Code hook's stdin JSON (or ?state=) sets the agent status of the terminal named by X-Terminals-Term / ?term=. */
async function handleStatus(req: IncomingMessage, res: ServerResponse, terminals: TerminalControl | null): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' })
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const raw = req.headers[TERM_HEADER]
  const id = ((Array.isArray(raw) ? raw[0] : raw) || url.searchParams.get('term') || '').trim()
  const text = await readBody(req)
  if (text === TOO_LARGE) {
    res.writeHead(413, { Connection: 'close' })
    res.end()
    return
  }
  if (text === null || !id) return reply(res, 400)
  let body: unknown = null
  if (text.trim()) {
    try {
      body = JSON.parse(text)
    } catch {
      return reply(res, 400)
    }
  }
  let outcome: HookOutcome
  const state = url.searchParams.get('state')
  if (state !== null) {
    const s = parseReportedStatus(state)
    if (!s) return reply(res, 400)
    outcome = { kind: 'set', status: s }
  } else {
    if (body === null || typeof body !== 'object') return reply(res, 400)
    outcome = statusFromHookEvent(body)
  }
  if (id.startsWith(HOOK_TEST_PREFIX)) {
    // The Settings Test button: record the hit, never touch a real terminal.
    const cb = hookTests.get(id)
    if (!cb) return reply(res, 404)
    cb(outcome.kind === 'set' && outcome.status === 'done' ? 'ok' : 'bad-payload')
    return reply(res, 204)
  }
  if (!terminals) return reply(res, 404)
  if (outcome.kind !== 'ignore') {
    try {
      terminals.report(id, outcome)
    } catch (e) {
      if (e instanceof ToolError) return reply(res, 404)
      throw e
    }
  }
  reply(res, 204)
}

function listen(port: number, onRequest: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const http = createServer(onRequest)
    http.once('error', reject)
    http.listen(port, '127.0.0.1', () => {
      http.off('error', reject)
      resolvePromise(http)
    })
  })
}

/**
 * Starts the server on TERMINALS_MCP_PORT (default 47821), falling back to an OS-assigned port when that one is
 * taken (e.g. the dev build and the installed build running at once).
 */
export async function startMcpServer(opts: {
  dataDir: string
  version: string
  onChange: () => void
  terminals: TerminalControl | null
  allowRun: () => boolean
}): Promise<McpInfo> {
  const token = loadOrCreateToken(opts.dataDir)
  const envPort = Number(process.env.TERMINALS_MCP_PORT)
  const wanted = Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : DEFAULT_MCP_PORT
  const info: McpInfo = { url: '', token, port: 0, statusUrl: '' }
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res, info, opts.dataDir, opts.version, opts.onChange, opts.terminals, opts.allowRun).catch((e) => {
      console.error('MCP request failed', e)
      if (!res.headersSent) sendError(res, 500, 'Internal server error')
      else res.end()
    })
  }
  let http: Server
  try {
    http = await listen(wanted, onRequest)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e
    console.warn(`MCP port ${wanted} unavailable (${code}); using a free port`)
    http = await listen(0, onRequest)
  }
  info.port = (http.address() as AddressInfo).port
  info.url = `http://127.0.0.1:${info.port}${MCP_PATH}`
  info.statusUrl = `http://127.0.0.1:${info.port}${STATUS_PATH}`
  const server = http
  info.close = () =>
    new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise())
      server.closeAllConnections()
    })
  return info
}
