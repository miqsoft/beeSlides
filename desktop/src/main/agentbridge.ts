// The one path an agent's tool call takes into a document window, whatever
// carried it here: a terminal tab's request file (terminalPanel.ts
// startSlideWatcher/startAgentWatcher) or a client of the local agent
// endpoint (agentendpoint.ts). Each request is forwarded to the window's
// editor over its IPC channel; the editor's answer comes back on the matching
// response channel below and is handed to the reply the caller registered —
// a file write for a terminal tab, a socket line for an endpoint client.

import type { BrowserWindow, IpcMainEvent, NativeImage } from 'electron'
import { type AgentChannel, type AgentResult } from './agentchannels.ts'
import { writeBlocked } from './programrun.ts'
import { onFrom } from './ipcguard.ts'
import { captureSlideSnapshot, isSnapshotRequest } from './slidesnapshot.ts'
import { uiProfileToolResult } from './uiprofile.ts'
import { docWebContentsFor, windowForDocWebContents } from './windows.ts'

export { isAgentChannel, type AgentChannel, type AgentResult } from './agentchannels.ts'
export type AgentReply = (result: AgentResult) => void

const IPC_OUT: Record<AgentChannel, string> = {
  'slide-request': 'slidomingo:slide-request',
  'slide-write': 'slidomingo:apply-slide-write',
  'agent-query': 'slidomingo:agent-query',
  'agent-action': 'slidomingo:agent-action',
}

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(id)
}

interface Pending {
  reply: AgentReply
  /** The window the request went to — only its doc view may answer it. */
  winId: number
  /** render_preview / review_slide: the editor's answer is a validation stub
   *  and main adds the screenshot (see slidomingo:agent-query-response). */
  capture: boolean
  timer: NodeJS.Timeout
}

/** requestId → who is waiting for it. requestIds are crypto.randomUUID()s
 *  minted by the MCP server. An entry whose answer never comes (the window
 *  closed mid-flight) is dropped well past the server's own longest wait
 *  (20s for icons/slide_html), so the late answer is not lost either. */
const pending = new Map<string, Pending>()
const PENDING_TTL_MS = 60_000

/** agent-action verbs main answers itself instead of the editor (agentexec.ts
 *  `execute`). Registered rather than imported: those modules call back into
 *  forwardAgentRequest. */
type MainVerb = (win: BrowserWindow, sessionId: string, args: unknown) => Promise<Record<string, unknown>>
const mainVerbs = new Map<string, MainVerb>()

export function registerMainVerb(verb: string, run: MainVerb): void {
  mainVerbs.set(verb, run)
}

/** Windows running an agent program (agentexec.ts). While one runs, its run
 *  is the deck's only writer: the program's undo group would otherwise take
 *  in another agent's write (a subagent's, another tab's), and a rollback
 *  would throw that write away with the program's own. Such a write is
 *  refused at once, never held: the MCP server stops waiting after a few
 *  seconds, and a held write landing after that would surprise its sender. */
const programRunning = new Set<number>()
export function setProgramRunning(winId: number, on: boolean): void {
  if (on) programRunning.add(winId)
  else programRunning.delete(winId)
}
export const PROGRAM_BUSY = 'A program is running on this deck right now, so this edit was NOT applied. Try it again in a moment, or put it in an execute program (programs wait their turn).'

/** Sends one request to `win`'s editor; `reply` is called exactly once with
 *  the answer, or never if the window goes away first (the caller's own
 *  timeout covers that). `sessionId` is whose slide locks a write takes
 *  (store.ts) — a terminal tab's id, or an endpoint client's. `program`:
 *  the call comes from the running program itself (agentexec.ts). */
export function forwardAgentRequest(win: BrowserWindow, sessionId: string, channel: AgentChannel, payload: unknown, reply: AgentReply, opts: { program?: boolean } = {}): void {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const requestId = body.requestId
  if (!isSafeId(requestId)) return
  // ui_profile customizes the APP, not this deck: main answers it (uiprofile.ts)
  if (channel === 'agent-action' && body.verb === 'ui_profile') {
    reply({ requestId, ...uiProfileToolResult(body.args) } as AgentResult)
    return
  }
  const own = channel === 'agent-action' && typeof body.verb === 'string' ? mainVerbs.get(body.verb) : undefined
  if (own) {
    void own(win, sessionId, body.args).then(
      (r) => reply({ ...r, requestId } as AgentResult),
      (err) => reply({ requestId, ok: false, error: String((err as Error)?.message ?? err) }),
    )
    return
  }
  if (writeBlocked(programRunning.has(win.id), !!opts.program, channel, body)) {
    reply({ requestId, ok: false, error: PROGRAM_BUSY })
    return
  }
  const wc = docWebContentsFor(win)
  if (!wc) {
    reply({ requestId, ok: false, error: 'no-document' })
    return
  }
  const capture = channel === 'agent-query' && (body.verb === 'render_preview' || body.verb === 'review_slide')
  const timer = setTimeout(() => pending.delete(requestId), PENDING_TTL_MS)
  pending.set(requestId, { reply, winId: win.id, capture, timer })
  wc.send(IPC_OUT[channel], { ...body, sessionId })
}

/** The waiting entry for an answer from doc view `senderId`, removed — null
 *  for an unknown requestId or one that went to a different window. */
function take(senderId: number, requestId: unknown): { win: BrowserWindow; entry: Pending } | null {
  if (!isSafeId(requestId)) return null
  const entry = pending.get(requestId)
  const win = windowForDocWebContents(senderId)
  if (!entry || !win || win.id !== entry.winId) return null
  pending.delete(requestId)
  clearTimeout(entry.timer)
  return { win, entry }
}

/** The screenshot render_preview / review_slide answer with: the renderer
 *  only checks the slide and says where it is (editor.ts prepareCapture /
 *  snapshotFor); capturePage() must run here, against the doc view's own
 *  webContents, which the renderer has no access to. */
async function withCapture(win: BrowserWindow, result: AgentResult): Promise<AgentResult> {
  try {
    const { offscreen, ...rest } = (result.result ?? {}) as { offscreen?: unknown; rect?: { x: number; y: number; width: number; height: number } | null }
    let image: NativeImage
    if (offscreen !== undefined) {
      // A slide that is not on the canvas: the renderer sent a standalone
      // page of it (editor.ts snapshotFor), shot in a hidden window.
      if (!isSnapshotRequest(offscreen)) throw new Error('bad snapshot')
      image = await captureSlideSnapshot(offscreen)
    } else {
      const wc = docWebContentsFor(win)
      if (!wc) throw new Error('no doc view')
      // The renderer reports where the slide is (editor.ts prepareCapture,
      // CSS px of the doc view): crop to it, so the image is the slide
      // alone, without the editor around it. capturePage takes DIPs, which
      // are CSS px times the page zoom — with UI zoom (⌘±) set, an unscaled
      // rect cut off part of the slide and took in editor chrome.
      const rect = rest.rect
      const z = wc.getZoomFactor()
      const crop = rect && [rect.x, rect.y, rect.width, rect.height].every((v) => Number.isFinite(v)) && rect.width > 1 && rect.height > 1
        ? { x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.round(rect.width * z), height: Math.round(rect.height * z) }
        : undefined
      image = await (crop ? wc.capturePage(crop) : wc.capturePage())
    }
    const data = image.toPNG().toString('base64')
    return { ...result, result: { ...rest, image: { data, mimeType: 'image/png' } } }
  } catch (err) {
    return { requestId: result.requestId, ok: false, error: `capture-failed: ${String((err as Error)?.message ?? err)}` }
  }
}

export function registerAgentBridgeIpc(): void {
  // get_slide, write_slide and the agent-action write verbs: the editor's
  // answer is final. (Spelled out: test-desktop-ipc-guard.mjs finds handlers
  // by their literal channel names.)
  const settle = (ev: IpcMainEvent, result: AgentResult): void => {
    const hit = take(ev.sender.id, result?.requestId)
    if (hit) hit.entry.reply(result)
  }
  onFrom('app-shell', 'slidomingo:slide-response', settle)
  onFrom('app-shell', 'slidomingo:apply-slide-write-result', settle)
  onFrom('app-shell', 'slidomingo:agent-action-result', settle)
  // The agent-query read verbs — final too, except render_preview and
  // review_slide, which get their screenshot here first. Async (an
  // ipcMain.on listener may be); every path still replies exactly once.
  onFrom('app-shell', 'slidomingo:agent-query-response', async (ev, result: AgentResult) => {
    const hit = take(ev.sender.id, result?.requestId)
    if (!hit) return
    hit.entry.reply(hit.entry.capture && result.ok ? await withCapture(hit.win, result) : result)
  })
}
