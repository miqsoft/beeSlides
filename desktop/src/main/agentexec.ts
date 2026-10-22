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
import { forwardAgentRequest, registerMainVerb, type AgentChannel, type AgentResult } from './agentbridge.ts'
import { DEFAULT_BUDGET_S, MAX_BUDGET_S, PAGE, driveProgram, type ProgramOutcome } from './programrun.ts'

/** Off unless BEESLIDES_CODE_MODE=1 — a prototype, measured against the
 *  plain tools before it is offered by default. */
export function codeModeEnabled(): boolean {
  return process.env.BEESLIDES_CODE_MODE === '1'
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

/** One program per document window at a time: the undo group is the editor's. */
const running = new Set<number>()

function toEditor(win: BrowserWindow, sessionId: string, channel: AgentChannel, payload: Record<string, unknown>): Promise<AgentResult> {
  return new Promise((resolve) => forwardAgentRequest(win, sessionId, channel, { ...payload, requestId: randomUUID() }, resolve))
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

/** Runs `code` against `win`'s deck as session `sessionId`. Never rejects. */
export async function runProgram(win: BrowserWindow, sessionId: string, code: string, budgetS = DEFAULT_BUDGET_S): Promise<ProgramOutcome> {
  const none: ProgramOutcome = { ok: false, logs: [], calls: 0, writes: 0 }
  if (running.has(win.id)) return { ...none, error: 'Another program is still running on this deck.' }
  const budgetMs = Math.min(MAX_BUDGET_S, Math.max(1, budgetS || DEFAULT_BUDGET_S)) * 1000
  running.add(win.id)
  const begun = await bracket(win, sessionId, 'begin')
  if (!begun.ok) { running.delete(win.id); return { ...none, error: String(begun.error ?? 'The deck refused the program.') } }

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
  running.delete(win.id)
  return out
}

/** The `execute` tool's args → a run. */
export function runExecuteTool(win: BrowserWindow, sessionId: string, args: unknown): Promise<ProgramOutcome> {
  const a = (args && typeof args === 'object' ? args : {}) as { code?: unknown; timeoutSeconds?: unknown }
  if (!codeModeEnabled()) return Promise.resolve({ ok: false, logs: [], calls: 0, writes: 0, error: 'Code mode is off (BEESLIDES_CODE_MODE=1).' })
  if (typeof a.code !== 'string' || !a.code.trim()) return Promise.resolve({ ok: false, logs: [], calls: 0, writes: 0, error: 'code is empty.' })
  return runProgram(win, sessionId, a.code, typeof a.timeoutSeconds === 'number' ? a.timeoutSeconds : DEFAULT_BUDGET_S)
}

export function registerAgentExec(): void {
  registerMainVerb('execute', async (win, sessionId, args) => ({ ...await runExecuteTool(win, sessionId, args) }))
}
