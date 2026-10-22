// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The part of Code Mode (agentexec.ts) that needs no Electron: the sandbox
// page, the runtime that gives a program its `deck`, the checks on what a
// program asks for, and the loop that runs one. agentexec.ts supplies the
// page (a hidden window) and the deck (agentbridge.ts); a rig supplies
// headless Chromium and a stand-in (scripts/test-agent-exec-e2e.ts).

import { isAgentChannel, type AgentChannel, type AgentResult } from './agentchannels.ts'

export const DEFAULT_BUDGET_S = 60
export const MAX_BUDGET_S = 300
/** The program's return value and its console output, as text, at most. */
export const MAX_VALUE_CHARS = 50_000
export const MAX_LOG_CHARS = 20_000

/** Verbs a program may not call: itself, the run's own bracket, and the
 *  app's (not the deck's) settings. */
export const DENIED_VERBS = new Set(['execute', 'program', 'ui_profile'])

export interface ProgramOutcome {
  ok: boolean
  /** JSON text of what the program returned. */
  value?: string
  logs: string[]
  error?: string
  /** deck calls the program made, and how many of them could change the deck. */
  calls: number
  writes: number
}

// ---- the page --------------------------------------------------------------

/** Everything the program sees besides the DOM: `deck` and `console`. Kept in
 *  step with API_REFERENCE in ../mcp/slides-mcp-server.mjs. */
export const RUNTIME = String.raw`
(() => {
  const queue = []
  const waiting = new Map()
  let wake = null
  let done = null
  let seq = 0
  const logs = []
  let logChars = 0
  const show = (v) => {
    if (typeof v === 'string') return v
    if (v && v.nodeType === 9) return v.documentElement.outerHTML
    if (v && v.nodeType === 1) return v.outerHTML
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  const line = (prefix) => (...a) => {
    if (logChars >= ${MAX_LOG_CHARS}) return
    const s = prefix + a.map(show).join(' ')
    logs.push(s.slice(0, ${MAX_LOG_CHARS} - logChars))
    logChars += s.length
  }
  const console = Object.freeze({ log: line(''), info: line(''), debug: line(''), warn: line('warn: '), error: line('error: ') })
  const notify = () => { if (wake) { const w = wake; wake = null; w() } }
  const host = (channel, payload) => new Promise((resolve) => {
    const id = String(++seq)
    waiting.set(id, resolve)
    queue.push({ id, channel, payload })
    notify()
  })
  const must = (r, what) => {
    if (!r || !r.ok) throw new Error(what + ': ' + ((r && r.error) || 'failed'))
    return r
  }
  const strip = (r) => { const { requestId, ok, toast, ...rest } = r; return rest }
  const query = async (verb, args = {}) => must(await host('agent-query', { verb, args }), verb).result
  const action = async (verb, args = {}) => strip(must(await host('agent-action', { verb, args }), verb))
  const op = async (tool, name, args = {}) => strip(must(await host('agent-action', { verb: tool, args: { ...args, op: name } }), tool + ' ' + name))

  const parse = (html, css) => {
    const d = new DOMParser().parseFromString('<!doctype html><html><head></head><body>' + html + '</body></html>', 'text/html')
    if (css) { const st = d.createElement('style'); st.textContent = css; d.head.append(st) }
    return d
  }
  /** A Document → the {html, css} slide_html writes: every <style> is the css. */
  const split = (doc) => {
    const d = doc.cloneNode(true)
    const css = [...d.querySelectorAll('style')].map((s) => { const t = s.textContent; s.remove(); return t }).join('\n')
    return { html: d.body.innerHTML, css }
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  const slide = (id) => {
    if (typeof id !== 'string' || !id) throw new TypeError('deck.slide(id): id is a slide id string')
    const ref = {
      id,
      get: async () => must(await host('slide-request', { slideId: id }), 'get_slide').slide,
      elements: async () => (await ref.get()).elements,
      html: async () => { const r = await op('slide_html', 'read', { slideId: id }); return { html: r.html || '', css: r.css || '' } },
      dom: async () => { const { html, css } = await ref.html(); return parse(html, css) },
      write: async (src, css, opts = {}) => {
        let html
        if (typeof src === 'string') html = src
        else if (src && src.nodeType === 9) ({ html, css } = split(src))
        else if (src && typeof src.html === 'string') ({ html, css } = src)
        else throw new TypeError('write(html, css?) | write(document) | write({html, css})')
        const args = { slideId: id, html }
        if (css) args.css = css
        if (opts.reflow === false) args.reflow = false
        return (await op('slide_html', 'write', args)).summary
      },
      update: (elementId, props, opts = {}) => action('update_element', { slideId: id, elementId, props, ...opts }),
      check: () => query('check_layout', { slideId: id }),
    }
    return Object.freeze(ref)
  }

  const deck = Object.freeze({
    info: () => query('doc_info'),
    outline: () => query('outline'),
    slides: async () => (await query('outline')).map((row) => ({ ...row, ref: slide(row.id) })),
    slide,
    find: (q, limit) => query('find_text', { query: q, ...(limit ? { limit } : {}) }),
    validate: async (opts = {}) => (await query('validate', opts)).findings,
    measure: (spec) => query('measure', { spec }),
    comments: () => query('comments'),
    op,
    query,
    action,
    parse,
    esc,
  })

  window.__bs = {
    start(code) {
      const AsyncFunction = (async () => {}).constructor
      let fn
      try { fn = new AsyncFunction('deck', 'console', '"use strict";\n' + code) } catch (e) {
        done = { ok: false, error: String(e), logs }
        return
      }
      Promise.resolve().then(() => fn(deck, console)).then(
        (v) => {
          let value = v === undefined ? 'null' : (v && (v.nodeType === 9 || v.nodeType === 1)) ? JSON.stringify(show(v)) : (() => { try { return JSON.stringify(v) } catch (e) { return JSON.stringify(String(v)) } })()
          if (value === undefined) value = 'null'
          done = { ok: true, value, logs }
          notify()
        },
        (e) => { done = { ok: false, error: (e && e.stack) ? String(e.stack).split('\n').slice(0, 4).join('\n') : String(e), logs }; notify() },
      )
    },
    next() {
      if (queue.length) return Promise.resolve({ calls: queue.splice(0) })
      if (done) return Promise.resolve({ done })
      return new Promise((r) => { wake = r }).then(() => window.__bs.next())
    },
    settle(id, result) {
      const r = waiting.get(id)
      waiting.delete(id)
      if (r) r(result)
    },
  }
})()
`

/** The page is empty: the runtime is put in with executeJavaScript (so no
 *  script tag is needed), and its CSP still governs what the program does. */
export const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:">
</head><body></body></html>`

export /** What a pending call from the page may be: one of the tool channels, any
 *  verb but the denied ones. Anything else is answered with an error. */
function checkCall(c: unknown): { id: string; channel: AgentChannel; payload: Record<string, unknown> } | { id: string; error: string } | null {
  const o = c as { id?: unknown; channel?: unknown; payload?: unknown } | null
  if (!o || typeof o.id !== 'string' || o.id.length > 20) return null
  if (!isAgentChannel(o.channel)) return { id: o.id, error: 'unknown channel' }
  const payload = o.payload && typeof o.payload === 'object' && !Array.isArray(o.payload) ? o.payload as Record<string, unknown> : null
  if (!payload) return { id: o.id, error: 'bad call' }
  if (typeof payload.verb === 'string' && DENIED_VERBS.has(payload.verb)) return { id: o.id, error: `${payload.verb} is not available inside a program` }
  return { id: o.id, channel: o.channel, payload }
}

export const isRead = (channel: AgentChannel, payload: Record<string, unknown>): boolean =>
  channel === 'slide-request' || channel === 'agent-query' || (payload.args as { op?: unknown } | undefined)?.op === 'read'

/** Where a program runs and what its deck calls reach. */
export interface ProgramHost {
  /** Load PAGE. */
  load(): Promise<unknown>
  /** Run JavaScript in the page; resolves with its (awaited) value. */
  inPage<T>(js: string): Promise<T>
  /** One deck call → the editor's answer. */
  call(channel: AgentChannel, payload: Record<string, unknown>): Promise<AgentResult>
  /** Still able to take a settle (the page not torn down). */
  alive(): boolean
}

/** Runs `code` on `host` until it finishes or `budgetMs` runs out. Never
 *  rejects; tearing the page down and the undo bracket are the caller's. */
export async function driveProgram(host: ProgramHost, code: string, budgetMs: number): Promise<ProgramOutcome> {
  const out: ProgramOutcome = { ok: false, logs: [], calls: 0, writes: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), budgetMs) })
  const inPage = <T>(js: string): Promise<T | 'timeout'> => Promise.race([host.inPage<T>(js), timedOut])
  // deck calls on their way: a program that returns without awaiting one
  // still has it land inside its run (and its undo step)
  const inFlight = new Set<Promise<void>>()
  const settle = (id: string, result: unknown): void => {
    if (host.alive()) void host.inPage(`__bs.settle(${JSON.stringify(id)}, ${JSON.stringify(result)})`).catch(() => {})
  }
  try {
    await host.load()
    await host.inPage(RUNTIME)
    if (await inPage(`__bs.start(${JSON.stringify(code)})`) === 'timeout') throw new Error('timeout')
    for (;;) {
      const step = await inPage<{ calls?: unknown[]; done?: { ok: boolean; value?: string; error?: string; logs?: unknown } }>('__bs.next()')
      if (step === 'timeout') throw new Error('timeout')
      if (step?.done) {
        const d = step.done
        out.ok = !!d.ok
        out.logs = Array.isArray(d.logs) ? d.logs.filter((l): l is string => typeof l === 'string') : []
        if (d.ok) out.value = typeof d.value === 'string' ? (d.value.length > MAX_VALUE_CHARS ? `${d.value.slice(0, MAX_VALUE_CHARS)}… (cut at ${MAX_VALUE_CHARS} characters)` : d.value) : 'null'
        else out.error = String(d.error ?? 'The program failed.')
        if (inFlight.size && await Promise.race([Promise.allSettled([...inFlight]), timedOut]) === 'timeout') throw new Error('timeout')
        break
      }
      // each call settles on its own, so a Promise.all in the program runs its calls together
      for (const raw of Array.isArray(step?.calls) ? step.calls : []) {
        const call = checkCall(raw)
        if (!call) continue
        if ('error' in call) {
          settle(call.id, { ok: false, error: call.error })
          continue
        }
        out.calls++
        if (!isRead(call.channel, call.payload)) out.writes++
        const p = host.call(call.channel, call.payload).then((result) => settle(call.id, result))
        inFlight.add(p)
        void p.finally(() => inFlight.delete(p))
      }
    }
  } catch (err) {
    out.ok = false
    out.error = (err as Error)?.message === 'timeout'
      ? `The program ran out of time (${budgetMs / 1000}s) and was stopped.`
      : `The program could not run: ${String((err as Error)?.message ?? err)}`
  } finally {
    if (timer) clearTimeout(timer)
  }
  return out
}

