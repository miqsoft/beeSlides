// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The bench's stand-in for the desktop app: a headless page running a
// checkout's slides editor (vite dev server) with a fake
// `window.slidomingoDesktop`, plus a relay that plays main's part of the MCP
// channel (terminalPanel.ts: startSlideWatcher/startAgentWatcher, the
// *-response IPC handlers, capturePage for render_preview/review_slide).
// See ../bench-agent-tools.mjs for how a run is put together.
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** playwright-core: the checkout's node_modules, $PLAYWRIGHT_CORE, or the npx cache. */
export async function loadPlaywright(repo) {
  const candidates = []
  if (process.env.PLAYWRIGHT_CORE) candidates.push(process.env.PLAYWRIGHT_CORE)
  for (const d of ['slides', 'desktop']) {
    try { candidates.push(createRequire(join(repo, d, 'package.json')).resolve('playwright-core')) } catch { /* not installed */ }
  }
  const npx = join(homedir(), '.npm/_npx')
  try {
    for (const h of readdirSync(npx)) {
      const p = join(npx, h, 'node_modules/playwright-core/index.mjs')
      if (existsSync(p)) candidates.push(p)
    }
  } catch { /* no npx cache */ }
  for (const c of candidates) {
    try {
      const mod = await import(pathToFileURL(c).href)
      return mod.chromium ?? mod.default?.chromium
    } catch { /* try the next */ }
  }
  throw new Error('playwright-core not found (set PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs)')
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** The checkout's slides dev server on a free port (never 5199/5198). */
export async function startVite(repo, log) {
  let port = await freePort()
  while (port === 5199 || port === 5198) port = await freePort()
  const bin = join(repo, 'slides/node_modules/.bin/vite')
  const child = spawn(bin, ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: join(repo, 'slides'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' },
  })
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += c })
  const url = `http://127.0.0.1:${port}/`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited: ${out}`)
    try {
      const res = await fetch(url)
      if (res.ok) { log?.(`vite up at ${url}`); return { url, child, stop: () => child.kill('SIGTERM') } }
    } catch { /* not yet */ }
    await sleep(250)
  }
  child.kill('SIGTERM')
  throw new Error(`vite did not come up: ${out}`)
}

/** Page-side fake bridge. `launchText` (a doc's JSON) boots straight into the
 *  editor through readLaunchDocument, like a desktop window bound to a file;
 *  null shows the start page. Every member the bench does not care about is a
 *  no-op that is callable, awaitable and catchable. */
function bridgeInit(launchText) {
  const noop = () => {
    const f = function () { return noop() }
    f.then = (res) => { try { res?.(undefined) } catch { /* */ } return Promise.resolve(undefined) }
    f.catch = () => Promise.resolve(undefined)
    f.finally = (cb) => { try { cb?.() } catch { /* */ } return Promise.resolve(undefined) }
    return f
  }
  const cbs = {}
  window.__benchCbs = cbs
  const on = (name) => (cb) => { cbs[name] = cb; return () => { if (cbs[name] === cb) delete cbs[name] } }
  const send = (channel) => (result) => { window.__benchSend(channel, JSON.parse(JSON.stringify(result))) }
  const impl = {
    readLaunchDocument: async () => (launchText == null ? null : {
      text: launchText, kind: 'draft', role: 'deck', path: '/tmp/bench-deck.beeslides.html', name: null, dir: null, mtimeMs: null,
    }),
    getAppShell: async () => null,
    writeSelectionContext: (json) => { window.__benchSelection(json) },
    onApplyEdit: on('applyEdit'),
    onSlideRequest: on('slideRequest'),
    onSlideWrite: on('slideWrite'),
    onAgentQuery: on('agentQuery'),
    onAgentAction: on('agentAction'),
    sendApplyEditResult: send('applyEditResult'),
    sendSlideResponse: send('slideResponse'),
    sendSlideWriteResult: send('slideWriteResult'),
    sendAgentQueryResponse: send('agentQueryResponse'),
    sendAgentActionResult: send('agentActionResult'),
  }
  window.slidomingoDesktop = new Proxy(impl, {
    get: (t, k) => (k in t ? t[k] : typeof k === 'symbol' ? undefined : noop()),
  })
}

/** Response file + request file per channel, as main writes/clears them. */
const CHANNELS = {
  slideResponse: { res: 'slide-response', req: 'slide-request' },
  slideWriteResult: { res: 'slide-write-result', req: 'slide-write' },
  agentQueryResponse: { res: 'agent-query-result', req: 'agent-query' },
  agentActionResult: { res: 'agent-action-result', req: 'agent-action' },
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/**
 * One editor page + the relay for one session dir. `onSelection(json)` gets
 * every selection.json the page writes. Events (requests, responses, timing)
 * go to `log`.
 */
export async function openEditor(browser, { url, launchText, viewport, dpr, sessionDir, onSelection, log }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)))
  const relay = new Relay(page, sessionDir, log)
  await page.exposeFunction('__benchSelection', (json) => onSelection?.(json))
  await page.exposeFunction('__benchSend', (channel, result) => relay.onResponse(channel, result))
  await page.addInitScript(bridgeInit, launchText)
  await page.goto(url)
  await page.waitForFunction(() => !!window.beeslides?.doc && !!window.__benchCbs?.agentQuery, null, { timeout: 60_000 })
  // the boot splash holds ~1.25s, then fades
  await page.waitForFunction(() => !document.getElementById('beeslides-splash'), null, { timeout: 10_000 }).catch(() => {})
  return { context, page, relay, pageErrors, close: async () => { relay.stop(); await context.close() } }
}

/** Boots the start page and picks "Blank" — the base for fixture authoring. */
export async function blankDoc(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await context.newPage()
  await page.exposeFunction('__benchSelection', () => {})
  await page.exposeFunction('__benchSend', () => {})
  await page.addInitScript(bridgeInit, null)
  await page.goto(url)
  const blank = page.locator('button:visible, [role=button]:visible, .ed-sp-tile:visible').filter({ hasText: /^\s*Blank/i }).first()
  await blank.click({ timeout: 30_000 })
  await page.waitForFunction(() => !!window.beeslides?.doc, null, { timeout: 30_000 })
  const doc = await page.evaluate(() => JSON.parse(JSON.stringify(window.beeslides.doc)))
  await context.close()
  return doc
}

class Relay {
  constructor(page, dir, log) {
    this.page = page
    this.dir = dir
    this.log = log ?? (() => {})
    this.handled = new Set()
    this.previews = new Set()
    this.local = new Map() // requestId → resolve, for the bench's own queries
    this.stats = { requests: 0, byKind: {} }
    this.watcher = null
    this.timer = null
    this.seq = 0
  }

  start() {
    const scan = () => { try { for (const f of readdirSync(this.dir)) this.claim(f) } catch { /* dir gone */ } }
    try { this.watcher = watch(this.dir, (_e, f) => { if (f) this.claim(f) }) } catch { /* poll only */ }
    this.timer = setInterval(scan, 100)
    scan()
  }

  stop() {
    try { this.watcher?.close() } catch { /* */ }
    clearInterval(this.timer)
  }

  claim(filename, retried = false) {
    let kind = null
    if (/^slide-request-.+\.json$/.test(filename)) kind = 'slideRequest'
    else if (/^slide-write-(?!result-).+\.json$/.test(filename)) kind = 'slideWrite'
    else if (/^agent-query-(?!result-).+\.json$/.test(filename)) kind = 'agentQuery'
    else if (/^agent-action-(?!result-).+\.json$/.test(filename)) kind = 'agentAction'
    if (!kind || this.handled.has(filename)) return
    let payload
    try { payload = JSON.parse(readFileSync(join(this.dir, filename), 'utf8')) } catch {
      if (!retried) setTimeout(() => this.claim(filename, true), 20)
      return
    }
    this.handled.add(filename)
    const id = payload?.requestId
    this.stats.requests++
    const key = payload?.verb ? `${kind}:${payload.verb}` : kind
    this.stats.byKind[key] = (this.stats.byKind[key] ?? 0) + 1
    this.log(`→ ${key} ${id}`)
    if (kind === 'agentAction' && payload?.verb === 'ui_profile') {
      // main answers ui_profile itself (uiprofile.ts); the bench has no app profile
      this.write('agent-action-result', 'agent-action', id, { requestId: id, ok: true, text: 'ui_profile is not available in the bench.', isError: true })
      return
    }
    if (kind === 'agentQuery' && (payload?.verb === 'render_preview' || payload?.verb === 'review_slide')) this.previews.add(id)
    this.dispatch(kind, { ...payload, sessionId: 'bench-session' })
  }

  dispatch(kind, payload) {
    return this.page.evaluate(([k, p]) => { window.__benchCbs[k]?.(p) }, [kind, payload]).catch((e) => this.log(`dispatch ${kind} failed: ${e}`))
  }

  async onResponse(channel, result) {
    const id = result?.requestId
    let final = result
    if (channel === 'agentQueryResponse' && (this.previews.delete(id) || this.local.get(id)?.capture) && result.ok) {
      final = await this.capture(result)
    }
    const local = this.local.get(id)
    if (local) { this.local.delete(id); local.resolve(final); return }
    const ch = CHANNELS[channel]
    if (!ch || typeof id !== 'string') { this.log(`← ${channel} (ignored)`); return }
    this.log(`← ${channel} ${id} ok=${final?.ok}${final?.ok ? '' : ` ${final?.error}`}`)
    this.write(ch.res, ch.req, id, final)
  }

  /** main's capturePage(rect), cropped to the slide. */
  async capture(result) {
    try {
      const rect = result.result?.rect
      const clip = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 1 && rect.height > 1
        ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        : undefined
      const buf = await this.page.screenshot(clip ? { clip } : {})
      return { ...result, result: { ...result.result, image: { data: buf.toString('base64'), mimeType: 'image/png' } } }
    } catch (err) {
      return { requestId: result.requestId, ok: false, error: `capture-failed: ${String(err?.message ?? err)}` }
    }
  }

  write(resPrefix, reqPrefix, id, obj) {
    try { writeAtomic(join(this.dir, `${resPrefix}-${id}.json`), JSON.stringify(obj, null, 2)) } catch (e) { this.log(`write failed: ${e}`) }
    try { rmSync(join(this.dir, `${reqPrefix}-${id}.json`), { force: true }) } catch { /* */ }
  }

  /** The bench's own query through the same page callback (never a file). */
  query(verb, args = {}, { capture = false, timeoutMs = 15_000 } = {}) {
    const requestId = `bench-${++this.seq}-${Date.now()}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.local.delete(requestId); resolve({ requestId, ok: false, error: 'timeout' }) }, timeoutMs)
      this.local.set(requestId, { capture, resolve: (r) => { clearTimeout(timer); resolve(r) } })
      void this.dispatch('agentQuery', { requestId, verb, args, sessionId: 'bench-final' })
    })
  }
}
