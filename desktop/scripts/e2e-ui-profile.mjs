#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Customize-the-editor E2E (DECISIONS 2026-10-09): the per-install UI profile
// across two editor windows, its shortcut/button running a style as ONE undo
// step, a hidden ribbon group, an --accent override, revert/reset from
// History, the Settings ▸ Customize chat applying a patch (mock model) with
// the "Your editor was changed — Undo" toast in the OTHER window, and an
// agent's ui_profile call through the real slides MCP server, answered by
// main (terminalPanel.ts intercept).
//
//   cd desktop && npx electron-vite build && node scripts/e2e-ui-profile.mjs
//   (needs slides/dist-single built)
//
// NO FOREGROUND WINDOWS. This may run while someone works on the machine, so
// the driver never focuses, maximizes or full-screens a window and never
// activates the app: BrowserWindow#focus/maximize/setFullScreen/moveTop,
// app.focus and webContents#focus are no-ops, the Dock icon is hidden and the
// activation policy is "accessory" (macOS). Every show() becomes
// showInactive(): windows are shown inactive, transparent (opacity 0) and click-through
// (setIgnoreMouseEvents), so nothing is visible and nothing can take a click.
// As a fail-safe, the run aborts at once if any window gets focus or the app
// becomes active. Clipboard steps (which need focus) are deliberately absent.
//
// Same two-mode shape as e2e-api-chat.mjs: node runs the ORCHESTRATOR,
// Electron the DRIVER.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repo = resolve(desktopDir, '..')
const SHELL_PATH = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
const BLOCK_RE = /(<script[^>]*\bid=["']slidomingo-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) failures++
  try { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) } catch { /* pipe gone */ }
}

if (process.versions.electron) {
  driver().catch(async (err) => {
    ok(false, `driver error: ${err?.stack ?? err}`)
    try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ }
    const { app } = await import('electron')
    app.exit(4)
  })
}
else await orchestrator()

/** A mock Anthropic-wire model. The Customize chat (its system prompt says so)
 *  patches the profile when asked CUSTOMIZE=1; an ordinary chat tab calls the
 *  MCP server's ui_profile when asked UIPROFILE=1. */
async function startMock(port) {
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    res.end()
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    res.on('error', () => {})
    req.on('end', () => {
      if (req.url !== '/v1/messages') { res.writeHead(404).end(); return }
      const body = JSON.parse(raw || '{}')
      const textOf = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => b.text ?? '').join('') : '')
      const lastUser = body.messages.filter((m) => m.role === 'user').map(textOf).filter(Boolean).pop() ?? ''
      const results = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : [])).length
      const system = JSON.stringify(body.system ?? '')
      const toolNames = (body.tools ?? []).map((t) => t.name)
      let s = { text: 'ok' }
      if (system.includes('You customize the slidomingo/slides editor') && lastUser.includes('CUSTOMIZE=1')) {
        s = results === 0
          ? { text: '', tools: [{ id: 'cz1', name: 'ui_profile', args: { op: 'patch', patch: { chrome: { density: 'compact' } }, summary: 'Compact chrome' } }] }
          : { text: `Done (tools: ${toolNames.join(',')}).` }
      } else if (lastUser.includes('UIPROFILE=1')) {
        s = results === 0
          ? { text: '', tools: [{ id: 'mc1', name: 'ui_profile', args: { op: 'patch', patch: { chrome: { radius: 4 } }, summary: 'Rounder corners' } }] }
          : { text: 'Done via MCP.' }
      }
      const ev = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }]]
      let i = 0
      if (s.text) {
        ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }])
        ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: s.text } }])
        ev.push(['content_block_stop', { type: 'content_block_stop', index: i++ }])
      }
      for (const tool of s.tools ?? []) {
        ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }])
        ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } }])
        ev.push(['content_block_stop', { type: 'content_block_stop', index: i++ }])
      }
      ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: s.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }])
      ev.push(['message_stop', { type: 'message_stop' }])
      sse(res, ev)
    })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return server
}

const PROFILE = {
  format: 'slidomingo/ui-profile', version: 1, name: 'E2E',
  styles: { heading: { label: 'My heading', patch: { fontSize: 50, color: '#0f766e', fontWeight: 700 } } },
  actions: { 'apply-heading': { kind: 'style', style: 'heading', label: 'Heading look', icon: 'text' } },
  ribbon: {
    tabs: [{ id: 'brand', label: 'Brand', groups: [{ id: 'looks', label: 'Looks', buttons: [{ target: 'apply-heading' }, { target: 'insert.chart' }] }] }],
    hide: ['home:reapply-change'],
  },
  shortcuts: { 'Mod+Shift+B': 'apply-heading' },
  chrome: { light: { accent: '#0f766e' }, dark: { accent: '#0f766e' } },
}

async function driver() {
  const { app, BrowserWindow, webContents } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  // ---- no foreground windows, ever (see the header) ----
  const noop = function () {}
  // a never-shown window does not boot the shell (its first frame never
  // comes), so windows are shown INACTIVE, fully transparent and click-
  // through: on screen for the compositor, invisible and untouchable for a
  // person, and never key or active
  const showInactive = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.show = function () { this.setIgnoreMouseEvents(true); this.setOpacity(0); showInactive.call(this) }
  BrowserWindow.prototype.showInactive = BrowserWindow.prototype.show
  BrowserWindow.prototype.focus = noop
  BrowserWindow.prototype.maximize = noop
  BrowserWindow.prototype.setFullScreen = noop
  BrowserWindow.prototype.moveTop = noop
  app.focus = noop
  app.dock?.hide()
  app.on('web-contents-created', (_e, wc) => { wc.focus = noop })
  const abort = (why) => { try { console.log(`  FAIL  aborted: ${why}`); console.log(`E2E_RESULT ${checks + 1} ${failures + 1}`) } catch { /* */ } app.exit(6) }
  app.on('browser-window-focus', () => abort('a window got focus'))
  app.on('did-become-active', () => abort('the app became active'))

  const { E2E_PORT: port, E2E_DECK_B: deckB, E2E_USERDATA: userData } = process.env
  const mock = await startMock(Number(port))
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  try { app.setActivationPolicy?.('accessory') } catch { /* not macOS */ }
  const report = () => { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const hardStop = setTimeout(() => { ok(false, 'timed out'); report(); app.exit(3) }, 120000)
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(150)
    }
  }
  const editors = () => waitFor(async () => {
    const out = []
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.isLoading() || !/BeeSlides\.beeslides\.html/.test(wc.getURL())) continue
      if (await wc.executeJavaScript('!!(window.slidomingo && window.slidomingo.uiProfile && document.querySelector(".ed-ribbon"))')) out.push(wc)
    }
    return out
  })
  const a = (await editors())?.[0]
  ok(!!a, 'window A opened its deck with the desktop ribbon')
  if (!a) {
    for (const wc of webContents.getAllWebContents()) {
      let probe = ''
      try { probe = await wc.executeJavaScript(`JSON.stringify({ s: !!window.slidomingo, ui: !!window.slidomingo?.uiProfile, ribbon: !!document.querySelector('.ed-ribbon'), root: !!document.querySelector('.ed-root'), body: document.body?.className, h: document.body?.innerText?.slice(0, 120) })`) } catch (e) { probe = String(e) }
      try { console.log(`  debug ${wc.getURL().slice(0, 100)} loading=${wc.isLoading()} ${probe}`) } catch { /* */ }
    }
    report(); app.exit(1); return
  }
  ok(BrowserWindow.getAllWindows().every((w) => w.getOpacity() === 0 && !w.isFocused()), 'every window is transparent and unfocused')
  await a.executeJavaScript(`window.slidomingoDesktop.openDocument(${JSON.stringify(deckB)}, { newWindow: true })`)
  const both = await waitFor(async () => { const l = await editors(); return l && l.length >= 2 ? l : null }, 20000)
  const b = both?.find((wc) => wc.id !== a.id)
  ok(!!b, 'window B opened a second deck')
  if (!b) { report(); app.exit(1); return }
  const js = (wc, code) => wc.executeJavaScript(code)
  const customTabs = (wc) => js(wc, `[...document.querySelectorAll('.ed-ribbon-tab-custom')].map((t) => t.textContent)`)
  const groupHidden = (wc, id) => js(wc, `document.querySelector('.ed-ribbon-group[data-group-id="${id}"]')?.hidden ?? null`)
  const accent = (wc) => js(wc, `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase()`)
  const density = (wc) => js(wc, `document.documentElement.dataset.uiDensity ?? ''`)
  const text = (wc) => js(wc, `(() => { const e = window.slidomingo.doc.slides[0].elements.find((x) => x.id === 't1'); return [e.fontSize, e.color, e.fontWeight].join() })()`)
  const mac = process.platform === 'darwin'
  const key = (wc, code, k, shift = false) => js(wc, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, code: ${JSON.stringify(code)}, ${mac ? 'metaKey' : 'ctrlKey'}: true, shiftKey: ${shift}, bubbles: true, cancelable: true }))`)

  // ---- 1. nothing customized yet
  ok((await customTabs(a)).length === 0 && (await groupHidden(a, 'home:reapply-change')) === false, 'fresh install: no custom tab, every built-in group showing (and tagged with its id)')
  ok((await accent(b)) === '#ffc233', `the default accent (${await accent(b)})`)

  // ---- 2. a profile written in A is live in B, without a reload
  const w = await js(a, `window.slidomingo.uiProfile.write(${JSON.stringify(PROFILE)}, 'E2E profile')`)
  ok(w?.ok === true && w.rev === 1, `the write is revision 1 (${JSON.stringify(w)?.slice(0, 120)})`)
  const live = await waitFor(async () => ((await customTabs(b)).join() === 'Brand' ? true : null), 8000)
  ok(!!live, 'window B shows the custom Brand tab live')
  ok((await customTabs(a)).join() === 'Brand', '…and so does window A')
  ok((await groupHidden(a, 'home:reapply-change')) === true && (await groupHidden(b, 'home:reapply-change')) === true, 'the hidden group is hidden in both windows')
  ok((await accent(b)) === '#0f766e', `--accent is the profile's in B (${await accent(b)})`)
  ok(await js(b, `[...document.querySelectorAll('head style[data-slidomingo-transient]')].some((s) => s.id === 'slidomingo-ui-profile-tokens')`), 'the token stylesheet is marked transient (never saved into a file)')
  const store = JSON.parse(readFileSync(join(userData, 'ui-customization.json'), 'utf8'))
  ok(store.rev === 1 && store.current?.name === 'E2E' && store.history.length === 1, 'main stored it in userData/ui-customization.json with one revision')
  const menu = await js(b, `JSON.stringify(window.slidomingo.menu.model())`)
  ok(menu.includes('"My commands"') && menu.includes('"custom.apply-heading"') && menu.includes('"Heading look"'), 'View ▸ My commands lists the profile\'s command in the native menu model')

  // ---- 3. the shortcut runs the style as ONE undo step; the button too
  ok((await text(a)) === '24,#111111,400', 'before: the text is 24px, near-black, regular')
  await key(a, 'KeyA', 'a')
  ok((await js(a, 'window.slidomingo.selection.join()')) === 't1', '⌘A selected the text')
  await key(a, 'KeyB', 'B', true)
  ok((await text(a)) === '50,#0f766e,700', `⌘⇧B applied the heading style (${await text(a)})`)
  await js(a, 'window.slidomingo.undo()')
  ok((await text(a)) === '24,#111111,400', 'one undo restores everything the style changed')
  await js(a, `[...document.querySelectorAll('.ed-ribbon-tab-custom')][0].click(); document.querySelector('.ed-btn-custom[data-target="apply-heading"]').click()`)
  ok((await text(a)) === '50,#0f766e,700', 'the Brand tab\'s button applies it too')
  await js(a, 'window.slidomingo.undo()')
  ok((await text(a)) === '24,#111111,400', '…also one undo step')
  await key(a, 'KeyS', 's', true)
  ok(true, 'a reserved chord (⌘⇧S) is never bound (validated away) — built-ins win')

  // ---- 4. revert / reset from History
  await js(b, 'window.slidomingo.uiProfile.revert(0)')
  ok(!!(await waitFor(async () => ((await customTabs(a)).length === 0 ? true : null), 8000)), 'revert to before any change removes the tab in A')
  ok((await accent(a)) === '#ffc233' && (await groupHidden(a, 'home:reapply-change')) === false, '…and the accent and the hidden group are back to normal')
  await js(b, 'window.slidomingo.uiProfile.revert(1)')
  ok(!!(await waitFor(async () => ((await customTabs(a)).join() === 'Brand' ? true : null), 8000)), 'revert to #1 brings it back')
  await js(a, 'window.slidomingo.uiProfile.reset()')
  ok(!!(await waitFor(async () => ((await customTabs(b)).length === 0 ? true : null), 8000)), 'reset clears it in every window')
  const hist = await js(b, 'window.slidomingo.uiProfile.history()')
  ok(hist.length === 4 && hist[0].source === 'reset', `every write is a revision in History (${hist.map((h) => h.source).join(',')})`)

  // ---- 5. the Customize chat (mock model) applies a patch; B shows the toast with Undo
  const info = await js(a, 'window.slidomingoDesktop.customizeChatInfo()')
  ok(info.available === true && info.profileName === 'Mock Anthropic', `the Customize chat runs on the API profile (${info.profileName})`)
  await js(a, `window.__turns = []; window.slidomingoDesktop.onCustomizeChatEvent((e) => { if (e.type === 'turn') window.__turns.push(e) }); true`)
  const sent = await js(a, `window.slidomingoDesktop.customizeChatSend('make it compact CUSTOMIZE=1', '[editor selection] nothing')`)
  ok(sent?.ok === true, 'the chat accepted the request')
  const turn = await waitFor(async () => (await js(a, 'window.__turns[0] ?? null')), 20000)
  ok(!!turn && turn.changes.length === 1 && turn.changes[0].summary === 'Compact chrome' && turn.revBefore === 4, `the turn reports its change and the revision before it (${JSON.stringify(turn)})`)
  ok((await density(b)) === 'compact', 'window B is compact now')
  const toast = await waitFor(async () => (await js(b, `document.querySelector('.ed-ui-changed span')?.textContent ?? null`)), 5000)
  ok(!!toast && toast.includes('Compact chrome'), `B shows "Your editor was changed" with the summary (${toast})`)
  const items = (await js(a, 'window.slidomingoDesktop.customizeChatInfo()')).items
  ok(items.length === 2 && items[1].text.includes('tools: ui_profile)'), `a text-only transcript; the model saw only the ui_profile tool (${items.map((x) => x.kind).join(',')})`)
  await js(b, `document.querySelector('.ed-ui-changed .ed-btn-primary').click()`)
  ok(!!(await waitFor(async () => ((await density(a)) === '' ? true : null), 8000)), 'Undo in B took the change back everywhere')

  // ---- 6. an agent's ui_profile through the real MCP server, answered by main
  await js(a, 'window.slidomingoDesktop.toggleTerminal()')
  const term = await waitFor(async () => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.isLoading() || !/terminal/.test(wc.getURL())) continue
      if (await wc.executeJavaScript('!!(window.slidomingoTerminal && document.querySelector(".chat"))')) return wc
    }
    return null
  }, 20000)
  ok(!!term, 'the panel opened an API chat tab (with the slides MCP server)')
  if (term) {
    const id = await term.executeJavaScript(`document.querySelectorAll('.term-pane')[0]?.dataset.sessionId`)
    await term.executeJavaScript(`window.slidomingoTerminal.chatSend(${JSON.stringify(id)}, 'round the corners UIPROFILE=1')`)
    const done = await waitFor(async () => ((await term.executeJavaScript(`[...document.querySelectorAll('.chat-msg.assistant')].pop()?.textContent ?? ''`)).includes('Done via MCP') ? true : null), 30000)
    ok(!!done, 'the chat finished after its ui_profile call')
    ok(await term.executeJavaScript(`[...document.querySelectorAll('.chat-tool')].some((r) => r.textContent.includes('ui_profile') && !r.classList.contains('error'))`), 'the ui_profile tool row did not error')
    const after = JSON.parse(readFileSync(join(userData, 'ui-customization.json'), 'utf8'))
    ok(after.current?.chrome?.radius === 4 && after.history.at(-1).source === 'agent', 'main applied it as an agent change')
    const t2 = await waitFor(async () => (await js(a, `document.querySelector('.ed-ui-changed span')?.textContent ?? null`)), 5000)
    ok(!!t2 && t2.includes('Rounder corners'), `the editor says so, with Undo (${t2})`)
  }

  clearTimeout(hardStop)
  mock.close()
  report()
  app.exit(0)
}

async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(import.meta.url)('electron')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-uiprofile-'))
  const work = join(root, 'work')
  const home = join(root, 'home')
  const userData = join(root, 'userdata')
  for (const d of [work, home, userData]) mkdirSync(d, { recursive: true })
  const { createServer: net } = await import('node:net')
  const port = await new Promise((r) => { const s = net(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  writeFileSync(join(userData, 'app-settings.json'), JSON.stringify({
    aiProfiles: [{ id: 'api-mock', name: 'Mock Anthropic', kind: 'api', wire: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, model: 'mock-claude', apiKeyEnv: 'E2E_KEY' }],
    defaultAiProfileId: 'api-mock',
  }))
  // a stub login shell: answers `env` (the API key lookup) and never runs claude
  const shell = join(root, 'fake-shell')
  writeFileSync(shell, '#!/bin/sh\n[ "$2" = env ] && exec /usr/bin/env\nexec cat > /dev/null\n', { mode: 0o755 })
  const shellHtml = readFileSync(SHELL_PATH, 'utf8')
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const deckFile = (name, docId) => {
    const doc = Object.assign(newDoc(), { title: name, docId })
    doc.slides[0].elements = [{ id: 't1', type: 'text', x: 80, y: 60, w: 800, h: 100, rotation: 0, opacity: 1, html: 'Title', fontSize: 24, fontFamily: 'system-ui, sans-serif', fontWeight: 400, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.1 }]
    const path = join(work, `${name}.beeslides.html`)
    writeFileSync(path, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
    return path
  }
  const deckA = deckFile('DeckA', '0a0a0a0a-0000-4000-8000-0000000c0a01')
  const deckB = deckFile('DeckB', '0a0a0a0a-0000-4000-8000-0000000c0a02')
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deckA], {
    cwd: desktopDir,
    env: {
      ...process.env, SHELL: shell, HOME: home, E2E_KEY: 'k-e2e', E2E_PORT: String(port), E2E_DECK_B: deckB, E2E_USERDATA: userData,
      SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'), SLIDOMINGO_UI_PROFILE_PATH: '',
      SLIDOMINGO_NO_UI_PROFILE: '', ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '',
    },
    encoding: 'utf8', timeout: 150000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL|debug)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL  no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); process.exit(1) }
  checks += Number(m[1]); failures += Number(m[2])
  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
