// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Code Mode: the `execute` tool runs an agent's JavaScript program against the
// open deck, so a multi-step or multi-slide job is one call instead of dozens,
// and only the program's result goes back into the model's context.
//
// Where it runs: a hidden window of its own (its own renderer process, like
// slidesnapshot.ts): a real DOM to build and edit slide HTML with, no Node, no
// preload, an in-memory session that refuses every request, a CSP with no
// network, no popups, no navigation. Main destroys the window when the time
// budget runs out, so a `while (true)` cannot hang anything.
//
// How it talks: it doesn't. The page can't call main; main PULLS. It runs
// `__bs.next()` in the page, which resolves with the program's pending `deck`
// calls (or its result), checks each call, sends it to the editor exactly
// like a tool call (agentbridge.ts), and hands the answer back with
// `__bs.settle(id, result)`. So the program can do nothing a tool call can't.
//
// Undo: the editor brackets the run (`program` begin/commit/rollback verbs,
// store.ts beginUndoGroup) — every edit of one run is ONE undo step, and a
// program that throws or runs out of time is rolled back whole.

import { BrowserWindow, session, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { forwardAgentRequest, registerMainVerb, setProgramRunning, type AgentChannel, type AgentResult } from './agentbridge.ts'
import { handleFrom } from './ipcguard.ts'
import { readSettings, updateSettings } from './settings.ts'
import { DEFAULT_BUDGET_S, MAX_BUDGET_S, PAGE, driveProgram, keyedQueue, type ProgramOutcome } from './programrun.ts'

/** Code Mode forced on for this run (tests, e2e); the setting can't turn it off. */
const codeModeFromEnv = (): boolean => process.env.BEESLIDES_CODE_MODE === '1'

/** Off unless Settings ▸ AI chat ▸ Advanced turns it on (or BEESLIDES_CODE_MODE=1)
 *  — a prototype, measured against the plain tools before it is on by default. */
export function codeModeEnabled(): boolean {
  return codeModeFromEnv() || readSettings().codeMode === true
}

let execSession: Session | null = null
function getSession(): Session {
  if (execSession) return execSession
  execSession = session.fromPartition('beeslides-agent-exec') // no persist: = in memory
  execSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('data:') }))
  execSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  return execSession
}

// ---- running ---------------------------------------------------------------

/** One program per document window at a time (the undo group is the
 *  editor's), the others wait their turn: subagents writing slides in
 *  parallel spend their time writing code, and a run's share is seconds. */
/** The longest a program waits for the one before it (the MCP server's wait
 *  for `execute` allows for it: slides-mcp-server.mjs PROGRAM_QUEUE_S). */
export const QUEUE_MAX_S = 120
const inTurn = keyedQueue(QUEUE_MAX_S * 1000)

/** The program's own calls: through the bridge, past the write gate its run set. */
function toEditor(win: BrowserWindow, sessionId: string, channel: AgentChannel, payload: Record<string, unknown>): Promise<AgentResult> {
  return new Promise((resolve) => forwardAgentRequest(win, sessionId, channel, { ...payload, requestId: randomUUID() }, resolve, { program: true }))
}

/** The run's bracket (begin/commit/rollback): answered at once by a live
 *  editor; one that never answers (its window went away) must not keep the
 *  deck marked as running. */
function bracket(win: BrowserWindow, sessionId: string, op: string, extra: Record<string, unknown> = {}): Promise<AgentResult> {
  return Promise.race([
    toEditor(win, sessionId, 'agent-action', { verb: 'program', args: { op, ...extra } }),
    new Promise<AgentResult>((resolve) => setTimeout(() => resolve({ requestId: '', ok: false, error: 'The deck did not answer.' }), 10_000)),
  ])
}

/** Runs `code` against `win`'s deck as session `sessionId`, after the
 *  programs already queued for it. Never rejects. */
export async function runProgram(win: BrowserWindow, sessionId: string, code: string, budgetS = DEFAULT_BUDGET_S): Promise<ProgramOutcome> {
  const none: ProgramOutcome = { ok: false, logs: [], calls: 0, writes: 0 }
  const out = await inTurn(win.id, () => win.isDestroyed() ? Promise.resolve({ ...none, error: 'The deck was closed.' }) : runNow(win, sessionId, code, budgetS))
  return out === 'late' ? { ...none, error: `Other programs kept this deck busy for ${QUEUE_MAX_S}s; this one did not run. Try again.` } : out
}

async function runNow(win: BrowserWindow, sessionId: string, code: string, budgetS: number): Promise<ProgramOutcome> {
  const none: ProgramOutcome = { ok: false, logs: [], calls: 0, writes: 0 }
  const budgetMs = Math.min(MAX_BUDGET_S, Math.max(1, budgetS || DEFAULT_BUDGET_S)) * 1000
  const begun = await bracket(win, sessionId, 'begin')
  if (!begun.ok) return { ...none, error: String(begun.error ?? 'The deck refused the program.') }
  setProgramRunning(win.id, true)
  try {
    return await runBracketed(win, sessionId, code, budgetMs)
  } finally {
    setProgramRunning(win.id, false)
  }
}

/** The run itself, between the editor's begin and its commit/rollback. */
async function runBracketed(win: BrowserWindow, sessionId: string, code: string, budgetMs: number): Promise<ProgramOutcome> {
  const sandbox = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: getSession(),
      backgroundThrottling: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      disableDialogs: true,
      autoplayPolicy: 'document-user-activation-required',
    },
  })
  const wc = sandbox.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.setAudioMuted(true)
  wc.on('will-navigate', (ev) => ev.preventDefault())

  const out = await driveProgram({
    load: () => wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`),
    inPage: (js) => wc.executeJavaScript(js),
    call: (channel, payload) => toEditor(win, sessionId, channel, payload),
    alive: () => !wc.isDestroyed(),
  }, code, budgetMs)
  // also what stops a program still running past its time
  if (!sandbox.isDestroyed()) sandbox.destroy()

  if (out.ok) {
    await bracket(win, sessionId, 'commit', { changed: out.writes > 0 })
  } else {
    const back = await bracket(win, sessionId, 'rollback')
    out.error = `${out.error}\n${back.ok ? (out.writes ? 'Nothing was changed: every edit of this run was rolled back.' : 'Nothing was changed.') : String(back.error)}`
  }
  return out
}

/** The `execute` tool's args → a run. */
export function runExecuteTool(win: BrowserWindow, sessionId: string, args: unknown): Promise<ProgramOutcome> {
  const a = (args && typeof args === 'object' ? args : {}) as { code?: unknown; timeoutSeconds?: unknown }
  if (!codeModeEnabled()) return Promise.resolve({ ok: false, logs: [], calls: 0, writes: 0, error: 'Code Mode is off (Settings ▸ AI chat ▸ Advanced).' })
  if (typeof a.code !== 'string' || !a.code.trim()) return Promise.resolve({ ok: false, logs: [], calls: 0, writes: 0, error: 'code is empty.' })
  return runProgram(win, sessionId, a.code, typeof a.timeoutSeconds === 'number' ? a.timeoutSeconds : DEFAULT_BUDGET_S)
}

/** `onChange` runs after the setting flips (agentendpoint.ts rewrites its
 *  server copy); chats opened from then on get the tools or lose them. */
export function registerAgentExec(onChange?: () => void): void {
  registerMainVerb('execute', async (win, sessionId, args) => ({ ...await runExecuteTool(win, sessionId, args) }))
  handleFrom('app-shell', 'slidomingo:code-mode-get', () => ({ on: codeModeEnabled(), forced: codeModeFromEnv() }))
  handleFrom('app-shell', 'slidomingo:code-mode-set', (_ev, on: unknown) => {
    if (typeof on !== 'boolean') return { refused: true, error: 'on must be a boolean' }
    updateSettings({ codeMode: on || undefined })
    onChange?.()
    return { on: codeModeEnabled(), forced: codeModeFromEnv() }
  })
}
