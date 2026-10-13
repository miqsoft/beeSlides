#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon-server tokens in the desktop app (desktop/src/main/icontokens.ts,
// DECISIONS 2026-10-11 "icon tokens like AI keys"): the token lives
// encrypted in main, never in a page; main makes the icon-server requests.
//
//   cd desktop && npx electron-vite build && node scripts/e2e-icon-tokens.mjs
//   (needs slides/dist-single built)
//
// Checks, against two mock servers (S1 wants `Bearer t-good` and sends NO
// CORS headers; S2 only records what reaches it):
//  1. A deck partition holding an old inline token: the preload hands the
//     list to main, main moves the token into icon-tokens.bin (encrypted)
//     and every stored copy — app-settings.json, that window's localStorage —
//     is token-free.
//  2. A second deck window gets the same list (app-wide), and its Settings
//     card's Test passes through main: Bearer on every request, the
//     thumbnail shrunk to 128, no CORS needed — and the token is nowhere in
//     the page.
//  3. The token only goes where it was stored for: main refuses a URL
//     outside the source's root, a redirect to another server loses it, and
//     a source whose URL changed gets no token until it is typed again.
//  4. Settings: the card says a token is stored; typing a new one replaces
//     it (field emptied); "Remove stored token" forgets it.
//  5. Offline mode: main refuses, nothing reaches the server.
//  6. Removing the source drops its token from icon-tokens.bin.
//
// NO FOREGROUND WINDOWS — same rules as e2e-ui-profile.mjs (see its header).
// safeStorage is a reversible stand-in (no keychain prompt): the real OS
// encryption is the one aiprofilesStore.ts already uses.

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
const KEY = 'slidomingo-icon-sources'
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

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

/** S1: an icon server under /lib that wants `Bearer t-good`, sends no CORS
 *  headers at all, and redirects /lib/redir to S2. S2 records everything. */
async function startServers() {
  const hits = { s1: [], s2: [] }
  let s2Port = 0
  const s1 = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    hits.s1.push({ path: url.pathname, size: url.searchParams.get('size'), auth: req.headers.authorization ?? null })
    if (url.pathname === '/lib/redir') { res.writeHead(302, { location: `http://127.0.0.1:${s2Port}/steal` }).end(); return }
    if (req.headers.authorization !== 'Bearer t-good') { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"auth"}'); return }
    if (url.pathname === '/lib/api/search') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [{ relative_path: 'cloud.svg', display_name: 'Cloud', png_url: '/png/cloud.svg?size=512' }] }))
    } else if (url.pathname === '/lib/files/cloud.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG)
    } else if (url.pathname === '/lib/png/cloud.svg') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
    } else res.writeHead(404).end()
  })
  const s2 = createServer((req, res) => {
    hits.s2.push({ path: req.url, auth: req.headers.authorization ?? null })
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"results":[]}')
  })
  await new Promise((r) => s1.listen(0, '127.0.0.1', r))
  await new Promise((r) => s2.listen(0, '127.0.0.1', r))
  s2Port = s2.address().port
  return { hits, s1Root: `http://127.0.0.1:${s1.address().port}/lib`, s2Root: `http://127.0.0.1:${s2Port}`, close: () => { s1.close(); s2.close() } }
}

async function driver() {
  const { app, BrowserWindow, safeStorage, webContents } = await import('electron')
  // no keychain prompt in a test: a reversible stand-in for safeStorage (as
  // e2e-desktop-hardening.mjs) — reversed, so the token is never in clear
  safeStorage.isEncryptionAvailable = () => true
  safeStorage.encryptString = (s) => Buffer.from(`E2E:${[...s].reverse().join('')}`)
  safeStorage.decryptString = (b) => [...b.toString().replace(/^E2E:/, '')].reverse().join('')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  // ---- no foreground windows, ever (see e2e-ui-profile.mjs) ----
  const noop = function () {}
  const showInactive = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.show = function () { this.setIgnoreMouseEvents(true); this.setOpacity(0); showInactive.call(this) }
  BrowserWindow.prototype.showInactive = BrowserWindow.prototype.show
  BrowserWindow.prototype.focus = noop
  BrowserWindow.prototype.maximize = noop
  BrowserWindow.prototype.setFullScreen = noop
  BrowserWindow.prototype.moveTop = noop
  app.focus = noop
  app.dock?.hide()
  app.on('web-contents-created', (_e, wc) => {
    wc.focus = noop
    // a page error is a finding: printed as a debug line
    wc.on('console-message', (ev) => { if (ev.level === 'error') { try { console.log(`  debug console: ${String(ev.message).slice(0, 300)}`) } catch { /* */ } } })
  })
  const abort = (why) => { try { console.log(`  FAIL  aborted: ${why}`); console.log(`E2E_RESULT ${checks + 1} ${failures + 1}`) } catch { /* */ } app.exit(6) }
  app.on('browser-window-focus', () => abort('a window got focus'))
  app.on('did-become-active', () => abort('the app became active'))

  const { E2E_DECK_B: deckB, E2E_USERDATA: userData } = process.env
  const srv = await startServers()
  const { hits, s1Root, s2Root } = srv
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
      if (await wc.executeJavaScript('!!(window.slidomingo && document.querySelector(".ed-ribbon"))')) out.push(wc)
    }
    return out
  })
  const js = (wc, code) => wc.executeJavaScript(code)
  const settings = () => JSON.parse(readFileSync(join(userData, 'app-settings.json'), 'utf8'))
  const tokenFile = () => (existsSync(join(userData, 'icon-tokens.bin')) ? readFileSync(join(userData, 'icon-tokens.bin'), 'utf8') : '')
  const storedList = () => JSON.parse(settings().viewerPrefs?.[KEY] ?? 'null')
  const fetchVia = (wc, id, url) => js(wc, `window.slidomingoDesktop.iconFetch(${JSON.stringify(id)}, ${JSON.stringify(url)}).then((r) => ({ ...r, body: r.body ? new TextDecoder().decode(r.body) : undefined }))`)
  const setList = (wc, list) => js(wc, `(() => { const v = ${JSON.stringify(JSON.stringify(list))}; localStorage.setItem(${JSON.stringify(KEY)}, v); window.slidomingoDesktop.setViewerPref(${JSON.stringify(KEY)}, v); return true })()`)
  const pageHasToken = (wc, token) => js(wc, `JSON.stringify({ ...localStorage }).includes(${JSON.stringify(token)}) || document.documentElement.outerHTML.includes(${JSON.stringify(token)})`)
  const server = (id, url, extra = {}) => ({ id, kind: 'server', name: 'Lib', enabled: true, url, ...extra })

  let a = (await editors())?.[0]
  ok(!!a, 'window A opened its deck')
  if (!a) { report(); app.exit(1); return }

  // ---- 1. an old build's inline token in A's partition, adopted on load
  ok(!('viewerPrefs' in settings()) || !(KEY in (settings().viewerPrefs ?? {})), 'main has no icon-source list yet (an install from before this change)')
  await js(a, `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify([server('src_old', s1Root, { token: 't-good' })]))}); true`)
  const aId = a.id
  a.reload()
  a = await waitFor(async () => (await editors())?.find((wc) => wc.id === aId) ?? null, 20000)
  ok(!!a, 'window A reloaded (its preload ran against the old value)')
  if (!a) { report(); app.exit(1); return }
  const adopted = await waitFor(async () => (storedList()?.[0]?.id === 'src_old' ? storedList() : null), 8000)
  ok(!!adopted && adopted[0].url === s1Root, 'main adopted the window\'s list (a key newer than its store is not wiped)')
  ok(!JSON.stringify(settings()).includes('t-good'), 'app-settings.json holds no token')
  const bin = tokenFile()
  ok(/"src_old"/.test(bin) && bin.includes(JSON.stringify(s1Root)) && !bin.includes('t-good'), 'icon-tokens.bin holds it for that source and root, encrypted (not in clear)')
  const echoed = await waitFor(async () => (!(await js(a, `localStorage.getItem(${JSON.stringify(KEY)})`)).includes('t-good') ? true : null), 5000)
  ok(!!echoed, 'window A\'s own copy was cleaned too (main echoed the token-free value)')

  // ---- 2. window B: same list, Test through main, token never in the page
  await js(a, `window.slidomingoDesktop.openDocument(${JSON.stringify(deckB)}, { newWindow: true })`)
  const both = await waitFor(async () => { const l = await editors(); return l && l.length >= 2 ? l : null }, 20000)
  const b = both?.find((wc) => wc.id !== a.id)
  ok(!!b, 'window B opened a second deck')
  if (!b) { report(); app.exit(1); return }
  ok(JSON.parse(await js(b, `localStorage.getItem(${JSON.stringify(KEY)})`) ?? '[]')[0]?.id === 'src_old', 'window B has the same source list (app-wide, not per deck)')
  const status = await js(b, `window.slidomingoDesktop.iconTokenStatus([{ id: 'src_old', url: ${JSON.stringify(s1Root)} }])`)
  ok(status.src_old === true && Object.keys(status).length === 1, 'iconTokenStatus says a token is stored — and returns nothing but that')
  hits.s1.length = 0
  await js(b, `window.slidomingo.menu.run('app.settings'); true`)
  await waitFor(async () => js(b, `!!document.querySelector('.ed-settings-navitem')`))
  await js(b, `[...document.querySelectorAll('.ed-settings-navitem')].find((n) => n.textContent.includes('Icon library')).click(); true`)
  const card = await waitFor(async () => js(b, `!!document.querySelector('.ed-isrc[data-source-id="src_old"]')`))
  ok(!!card, 'Settings ▸ Icon library shows the source')
  const tokenInput = `document.querySelector('.ed-isrc[data-source-id="src_old"] input[type=password]')`
  const placeholder = await waitFor(async () => { const p = await js(b, `${tokenInput}.placeholder`); return /stored/.test(p) ? p : null }, 5000)
  ok(!!placeholder && (await js(b, `${tokenInput}.value`)) === '', `the token field is empty and says one is stored ("${placeholder}")`)
  ok(await js(b, `[...document.querySelectorAll('.ed-isrc[data-source-id="src_old"] button')].some((x) => x.textContent === 'Remove stored token' && x.style.display !== 'none')`), '"Remove stored token" is offered')
  const runTest = async () => {
    await js(b, `document.querySelector('.ed-isrc[data-source-id="src_old"] .ed-isrc-result').textContent = ''; [...document.querySelectorAll('.ed-isrc[data-source-id="src_old"] .ed-isrc-head button')].find((x) => x.textContent === 'Test').click(); true`)
    return waitFor(async () => { const t = await js(b, `document.querySelector('.ed-isrc[data-source-id="src_old"] .ed-isrc-result').textContent`); return t && !/^Testing/.test(t) ? t : null }, 15000)
  }
  const verdict = await runTest()
  ok(/^✓/.test(verdict ?? ''), `Test passes through main, with no CORS headers on the server (${verdict})`)
  ok(hits.s1.length >= 3 && hits.s1.every((h) => h.auth === 'Bearer t-good'), `every request carried the token (${hits.s1.map((h) => `${h.path}:${h.auth ? 'auth' : '-'}`).join(' ')})`)
  ok(hits.s1.some((h) => h.path === '/lib/png/cloud.svg' && h.size === '128'), 'the thumbnail came from png_url, shrunk to 128')
  ok(!(await pageHasToken(b, 't-good')) && !(await pageHasToken(a, 't-good')), 'the token is nowhere in either page (localStorage or DOM)')

  // ---- 3. the token only goes where it was stored for
  hits.s2.length = 0
  const outside = await fetchVia(b, 'src_old', `${s2Root}/lib/api/search?q=`)
  ok(outside.ok === false && hits.s2.length === 0, `main refuses a URL outside the source's root (${outside.error})`)
  const sibling = await fetchVia(b, 'src_old', `${s1Root}-evil/api/search?q=`)
  ok(sibling.ok === false, 'and a sibling path that only shares the prefix')
  const redir = await fetchVia(b, 'src_old', `${s1Root}/redir`)
  ok(redir.ok === true && hits.s2.length === 1 && hits.s2[0].auth === null, 'a redirect to another server is followed WITHOUT the token')
  hits.s2.length = 0
  await setList(b, [server('src_old', s2Root)])
  await waitFor(async () => (storedList()?.[0]?.url === s2Root ? true : null), 5000)
  const moved = await js(b, `window.slidomingoDesktop.iconTokenStatus([{ id: 'src_old', url: ${JSON.stringify(s2Root)} }])`)
  ok(moved.src_old === false, 'after the URL changes the source has no token (it was stored for the old server)')
  const toS2 = await fetchVia(b, 'src_old', `${s2Root}/api/search?q=`)
  ok(toS2.ok === true && hits.s2.length === 1 && hits.s2[0].auth === null, 'so the new server gets no Authorization header')
  await setList(b, [server('src_old', s1Root)])
  await waitFor(async () => (storedList()?.[0]?.url === s1Root ? true : null), 5000)
  const back = await js(b, `window.slidomingoDesktop.iconTokenStatus([{ id: 'src_old', url: ${JSON.stringify(s1Root)} }])`)
  ok(back.src_old === true, 'back on the original URL, the stored token applies again')

  // ---- 4. Settings: replace the token, then remove it
  const before = tokenFile()
  await js(b, `(() => { const i = ${tokenInput}; i.value = 't-wrong'; i.dispatchEvent(new Event('change')); return true })()`)
  const emptied = await waitFor(async () => ((await js(b, `${tokenInput}.value`)) === '' && tokenFile() !== before ? true : null), 5000)
  ok(!!emptied, 'a typed token is stored (icon-tokens.bin changed) and the field is emptied')
  ok(!tokenFile().includes('t-wrong') && !(await pageHasToken(b, 't-wrong')), '…encrypted, and not left in the page')
  hits.s1.length = 0
  const wrong = await runTest()
  ok(/rejected the API token/.test(wrong ?? '') && hits.s1.some((h) => h.auth === 'Bearer t-wrong'), `the new token is the one sent — the server rejects it (${wrong})`)
  await js(b, `[...document.querySelectorAll('.ed-isrc[data-source-id="src_old"] button')].find((x) => x.textContent === 'Remove stored token').click(); true`)
  const gone = await waitFor(async () => (!/"src_old"/.test(tokenFile()) ? true : null), 5000)
  ok(!!gone, '"Remove stored token" forgets it')
  ok(!!(await waitFor(async () => (/stored/.test(await js(b, `${tokenInput}.placeholder`)) ? null : true), 3000)), 'and the field no longer says one is stored')
  hits.s1.length = 0
  const none = await runTest()
  ok(/wants an API token/.test(none ?? '') && hits.s1.every((h) => h.auth === null), `without a token nothing is sent and the card says the server wants one (${none})`)

  // ---- 5. offline mode
  await js(b, `(() => { const i = ${tokenInput}; i.value = 't-good'; i.dispatchEvent(new Event('change')); return true })()`)
  await waitFor(async () => (/"src_old"/.test(tokenFile()) ? true : null), 5000)
  await js(b, `window.slidomingoDesktop.setViewerPref('slidomingo-offline', 'on'); true`)
  await waitFor(async () => (settings().viewerPrefs?.['slidomingo-offline'] === 'on' ? true : null), 5000)
  hits.s1.length = 0
  const off = await fetchVia(a, 'src_old', `${s1Root}/api/search?q=`)
  ok(off.ok === false && off.offline === true && hits.s1.length === 0, 'offline: main refuses and nothing reaches the server')
  await js(b, `window.slidomingoDesktop.setViewerPref('slidomingo-offline', 'off'); true`)

  // ---- 6. removing the source drops its token
  await setList(b, [])
  const pruned = await waitFor(async () => (!/"src_old"/.test(tokenFile()) ? true : null), 5000)
  ok(!!pruned, 'removing the source removes its token from icon-tokens.bin')

  clearTimeout(hardStop)
  srv.close()
  report()
  app.exit(0)
}

async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(import.meta.url)('electron')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-icontokens-'))
  const work = join(root, 'work')
  const home = join(root, 'home')
  const userData = join(root, 'userdata')
  for (const d of [work, home, userData]) mkdirSync(d, { recursive: true })
  // an install that already shares viewer prefs, from before the icon list was one
  writeFileSync(join(userData, 'app-settings.json'), JSON.stringify({ viewerPrefs: { 'slidomingo-theme': 'light' } }))
  const shellHtml = readFileSync(SHELL_PATH, 'utf8')
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const deckFile = (name, docId) => {
    const doc = Object.assign(newDoc(), { title: name, docId })
    const path = join(work, `${name}.beeslides.html`)
    writeFileSync(path, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
    return path
  }
  const deckA = deckFile('DeckA', '0a0a0a0a-0000-4000-8000-0000000c1a01')
  const deckB = deckFile('DeckB', '0a0a0a0a-0000-4000-8000-0000000c1a02')
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deckA], {
    cwd: desktopDir,
    env: {
      ...process.env, HOME: home, E2E_DECK_B: deckB, E2E_USERDATA: userData,
      SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'),
      SLIDOMINGO_NO_UI_PROFILE: '1', ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '',
    },
    encoding: 'utf8', timeout: 150000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL|debug)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL  no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); process.exit(1) }
  checks += Number(m[1]); failures += Number(m[2])
  console.log(`\n${checks - failures}/${checks} checks passed   (userData: ${userData})`)
  if (failures) process.exit(1)
}
