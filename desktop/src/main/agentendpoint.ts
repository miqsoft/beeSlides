// The local endpoint AI apps outside BeeSlides (Claude Desktop, Claude Code in
// a terminal, Cursor, …) reach the open decks through. They run the same MCP
// server the chat panel does, as `slides-mcp-server.mjs --endpoint <agentDir>`;
// it connects here instead of writing request files. No network port: a unix
// socket (a named pipe on Windows) in userData, and a per-install token in a
// file only this user can read.
//
// Wire format: one JSON object per line each way.
//   → {"type":"hello","token":"…","client":"…"}
//   ← {"type":"hello","ok":true,"sessionId":"…"}  (or ok:false and the socket closes)
//   → {"type":"request","channel":"agent-query","payload":{"requestId":"…",…}}
//   ← {"type":"response","result":{"requestId":"…","ok":…,…}}
// Each request goes to a document window through agentbridge.ts, exactly like
// a terminal tab's request file.
//
// Off until the user turns it on (Settings ▸ AI chat ▸ Advanced, AppSettings.
// agentEndpoint). Any program running as this user can read the token, so the
// first connection of an app the user has not allowed yet waits for a yes
// (agentconsent.ts); BEESLIDES_AGENT_ENDPOINT=1 forces the endpoint on and
// skips that question (tests, e2e).

import { app, BrowserWindow, dialog } from 'electron'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forwardAgentRequest, isAgentChannel } from './agentbridge.ts'
import { clientLabel, consentBox, consentStrings, isAllowedClient, rememberClient, type ConsentStrings } from './agentconsent.ts'
import { writeFileAtomic } from './fsutil.ts'
import { handleFrom } from './ipcguard.ts'
import { readSettings, updateSettings } from './settings.ts'
import { mcpServerSource } from './terminalPanel.ts'
import { allDocumentWindows, docWebContentsFor, focusedDocumentWindow } from './windows.ts'

/** Forced on for this run (tests, e2e): the setting can't turn it off and
 *  nobody is asked. */
const endpointFromEnv = (): boolean => process.env.BEESLIDES_AGENT_ENDPOINT === '1'

export function agentEndpointEnabled(): boolean {
  return endpointFromEnv() || readSettings().agentEndpoint === true
}

/** A request line may carry a whole slide (write_slide); anything this big is
 *  not one, and the connection is dropped rather than buffered further. */
const MAX_LINE_BYTES = 32 * 1024 * 1024

/** Where the endpoint's address, token and the MCP server script live. */
export function agentDir(): string {
  return join(app.getPath('userData'), 'agent')
}

/** unix socket paths are limited to ~104 bytes (macOS); a long userData path
 *  falls back to the temp folder, under a name derived from it. */
function socketPath(): string {
  const id = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
  if (process.platform === 'win32') return `\\\\.\\pipe\\beeslides-agent-${id}`
  const inUserData = join(agentDir(), 'beeslides.sock')
  return Buffer.byteLength(inUserData) < 100 ? inUserData : join(tmpdir(), `beeslides-agent-${id}.sock`)
}

/** The install's token, made on first use. Only this user can read the file. */
function ensureToken(): string {
  const file = join(agentDir(), 'token')
  try {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(t)) return t
  } catch { /* first start */ }
  const t = randomBytes(32).toString('hex')
  writeFileSync(file, t, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* Windows: the folder's ACL applies */ }
  return t
}

function tokenMatches(expected: string, got: unknown): boolean {
  if (typeof got !== 'string' || got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

/** How the MCP server starts BeeSlides when it isn't running: the way it was
 *  started this time (an unpackaged run also needs its app path). */
function launchInfo(): { command: string; args: string[] } {
  return { command: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }
}

/** The document window a request goes to: the one this client already works
 *  in while it is open, else the focused one, else the last one focused. */
let lastFocusedDocWinId: number | null = null

function targetWindow(boundWinId: number | null): BrowserWindow | null {
  const open = allDocumentWindows()
  const bound = boundWinId != null ? open.find((w) => w.id === boundWinId) : undefined
  return bound ?? focusedDocumentWindow() ?? open.find((w) => w.id === lastFocusedDocWinId) ?? open[0] ?? null
}

/** The renderer's translations for the question (setConsentStrings). */
let strings: ConsentStrings = {}
/** One question per app at a time: a client that reconnects while it is
 *  open waits for the same answer. */
const asking = new Map<string, Promise<boolean>>()

/** Whether `client` may connect: allowed before, or the user says yes now.
 *  The box comes up in front of the app — something just asked to work on
 *  the user's decks. */
function mayConnect(client: string): Promise<boolean> {
  if (endpointFromEnv() || isAllowedClient(readSettings().agentClients, client)) return Promise.resolve(true)
  let answer = asking.get(client)
  if (!answer) {
    answer = (async () => {
      const win = focusedDocumentWindow() ?? allDocumentWindows()[0] ?? null
      try { app.focus({ steal: true }) } catch { /* not supported here */ }
      const box = consentBox(strings, client)
      const opts = { type: 'question' as const, message: box.message, detail: box.detail, buttons: box.buttons, defaultId: 1, cancelId: 1, noLink: true }
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (response !== 0) return false
      updateSettings({ agentClients: rememberClient(readSettings().agentClients, client) })
      return true
    })().catch(() => false).finally(() => asking.delete(client))
    asking.set(client, answer)
  }
  return answer
}

/** Connected clients, closed when the endpoint is switched off. */
const sockets = new Set<Socket>()

function serveClient(socket: Socket, token: string): void {
  const sessionId = `ext-${randomUUID()}`
  // new → asking (token fine, waiting for the user) → ready
  let state: 'new' | 'asking' | 'ready' = 'new'
  let winId: number | null = null
  let buf = ''
  const send = (msg: unknown): void => {
    if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n')
  }
  socket.setEncoding('utf8')
  sockets.add(socket)
  socket.on('error', () => { /* the client went away; 'close' follows */ })
  socket.on('close', () => {
    sockets.delete(socket)
    // Its slides are no longer being worked on (store.ts locks).
    const win = winId != null ? BrowserWindow.fromId(winId) : null
    if (win && !win.isDestroyed()) docWebContentsFor(win)?.send('slidomingo:agent-session-closed', { sessionId })
  })
  socket.on('data', (chunk: string) => {
    buf += chunk
    // Before the hello, nothing but a short line is expected.
    if (buf.length > (state === 'ready' ? MAX_LINE_BYTES : 4096)) { socket.destroy(); return }
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let msg: { type?: unknown; token?: unknown; channel?: unknown; payload?: unknown }
      try { msg = JSON.parse(line) } catch { continue }
      if (state === 'asking') continue // nothing is sent before the answer
      if (state === 'new') {
        if (msg.type !== 'hello' || !tokenMatches(token, msg.token)) {
          send({ type: 'hello', ok: false, error: 'bad-token' })
          socket.end()
          return
        }
        state = 'asking'
        void mayConnect(clientLabel((msg as { client?: unknown }).client)).then((ok) => {
          if (socket.destroyed) return
          if (!ok) { send({ type: 'hello', ok: false, error: 'denied' }); socket.end(); return }
          state = 'ready'
          send({ type: 'hello', ok: true, sessionId })
        })
        continue
      }
      if (msg.type !== 'request' || !isAgentChannel(msg.channel)) continue
      const requestId = (msg.payload as { requestId?: unknown } | null)?.requestId
      const win = targetWindow(winId)
      if (!win) {
        send({ type: 'response', result: { requestId, ok: false, error: 'No deck is open in BeeSlides.' } })
        continue
      }
      winId = win.id
      forwardAgentRequest(win, sessionId, msg.channel, msg.payload, (result) => send({ type: 'response', result }))
    }
  })
}

let server: Server | null = null

/** Opens the endpoint and writes what the MCP server needs to find it:
 *  <agentDir>/endpoint.json, token, beeslides-mcp.mjs. Best effort — the app
 *  works without it, only outside AI apps can't connect. */
let watchingFocus = false

export function startAgentEndpoint(): void {
  if (server || !agentEndpointEnabled()) return
  if (!watchingFocus) {
    watchingFocus = true
    app.on('browser-window-focus', (_ev, win) => {
      if (allDocumentWindows().includes(win)) lastFocusedDocWinId = win.id
    })
  }
  let token: string
  const path = socketPath()
  try {
    mkdirSync(agentDir(), { recursive: true, mode: 0o700 })
    token = ensureToken()
    writeFileAtomic(join(agentDir(), 'beeslides-mcp.mjs'), mcpServerSource())
    // A single-instance app: a socket file left here is a crashed run's.
    if (process.platform !== 'win32') rmSync(path, { force: true })
  } catch {
    return
  }
  const s = createServer((socket) => serveClient(socket, token))
  s.on('error', () => { server = null })
  s.listen(path, () => {
    if (process.platform !== 'win32') { try { chmodSync(path, 0o600) } catch { /* best effort */ } }
    try { writeFileAtomic(join(agentDir(), 'endpoint.json'), JSON.stringify({ socket: path, launch: launchInfo() }, null, 2)) } catch { /* best effort */ }
  })
  server = s
}

/** Rewrites the server outside AI apps start, after Code Mode flipped
 *  (their next start gets the new tool list). No-op while the endpoint is off. */
export function refreshAgentEndpointServer(): void {
  if (!server) return
  try { writeFileAtomic(join(agentDir(), 'beeslides-mcp.mjs'), mcpServerSource()) } catch { /* best effort */ }
}

/** Closes the endpoint. `forget` (the user switched it off) also drops the
 *  token and endpoint.json: a client connected before can't come back, and
 *  the MCP server tells its model the app is not set up instead of starting
 *  it. The server script stays, so outside apps still list the tools. */
export function stopAgentEndpoint(opts: { forget?: boolean } = {}): void {
  const path = server ? socketPath() : null
  try { server?.close() } catch { /* already closed */ }
  server = null
  for (const s of sockets) s.destroy()
  sockets.clear()
  if (!opts.forget) return
  for (const f of ['endpoint.json', 'token']) { try { rmSync(join(agentDir(), f), { force: true }) } catch { /* best effort */ } }
  if (path && process.platform !== 'win32') { try { rmSync(path, { force: true }) } catch { /* best effort */ } }
}

type EndpointState = { on: boolean; forced: boolean; clients: string[] }

function endpointState(): EndpointState {
  const clients = readSettings().agentClients
  return { on: agentEndpointEnabled(), forced: endpointFromEnv(), clients: Array.isArray(clients) ? clients.filter((c) => typeof c === 'string') : [] }
}

/** Settings ▸ AI chat ▸ Advanced: the switch, the allowed apps, and the
 *  renderer's translations for the question. */
export function registerAgentEndpointIpc(): void {
  handleFrom('app-shell', 'slidomingo:agent-endpoint-get', () => endpointState())
  handleFrom('app-shell', 'slidomingo:agent-endpoint-set', (_ev, on: unknown) => {
    if (typeof on !== 'boolean') return { refused: true, error: 'on must be a boolean' }
    updateSettings({ agentEndpoint: on || undefined })
    if (on) startAgentEndpoint()
    else if (!endpointFromEnv()) stopAgentEndpoint({ forget: true })
    return endpointState()
  })
  handleFrom('app-shell', 'slidomingo:agent-endpoint-forget', () => {
    updateSettings({ agentClients: undefined })
    return endpointState()
  })
  handleFrom('app-shell', 'slidomingo:agent-consent-strings', (_ev, raw: unknown) => {
    strings = consentStrings(raw)
    return { ok: true }
  })
}
