import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { TOOLS, ToolError, type ToolContext } from './mcpTools'

/**
 * Built-in MCP server (Streamable HTTP, stateless, JSON responses) so a Claude Code session in one of the app's
 * terminals can manage folders, groups, commands and prompts. Bound to 127.0.0.1, bearer-token protected.
 */

export const DEFAULT_MCP_PORT = 47821
export const MCP_PATH = '/mcp'
/** Sent by the MCP client from the terminal's TERMINALS_LOC_ID; Node lower-cases header names. */
const LOCATION_HEADER = 'x-terminals-location'
const TOKEN_FILE = 'mcp-token'

export interface McpInfo {
  url: string
  token: string
  port: number
}

const INSTRUCTIONS =
  "Manages the Terminals app: saved folders, groups (manual and parent folder groups), saved commands and saved prompts. Changes show up in the app immediately. \"This folder\" is the terminal's location from get_context; folder-scoped tools default to it. Nothing here runs commands."

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
        annotations: { readOnlyHint: !t.mutates, destructiveHint: !!t.destructive, openWorldHint: false }
      },
      async (args) => {
        try {
          const result = t.run(args as Record<string, unknown>, ctx)
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
  onChange: () => void
): Promise<void> {
  if (!hostAllowed(req.headers.host, info.port)) return sendError(res, 403, 'Forbidden: bad Host header')
  // Browsers always send Origin on cross-origin requests; CLI MCP clients do not.
  if (req.headers.origin !== undefined) return sendError(res, 403, 'Forbidden: browser requests are not accepted')
  if (!tokenMatches(req.headers.authorization, info.token))
    return sendError(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' })
  if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== MCP_PATH) return sendError(res, 404, 'Not found')
  // Stateless JSON-only server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed', { Allow: 'POST' })

  const raw = req.headers[LOCATION_HEADER]
  const headerLocation = (Array.isArray(raw) ? raw[0] : raw) || undefined
  const server = buildServer({ headerLocation, dataDir }, version, onChange)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res)
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
export async function startMcpServer(opts: { dataDir: string; version: string; onChange: () => void }): Promise<McpInfo> {
  const token = loadOrCreateToken(opts.dataDir)
  const envPort = Number(process.env.TERMINALS_MCP_PORT)
  const wanted = Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : DEFAULT_MCP_PORT
  const info: McpInfo = { url: '', token, port: 0 }
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res, info, opts.dataDir, opts.version, opts.onChange).catch((e) => {
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
  return info
}
