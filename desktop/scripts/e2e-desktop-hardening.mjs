#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Desktop hardening E2E: one step per bug a review found on main (2026-10-08).
//
//   cd desktop && npx electron-vite build && node scripts/e2e-desktop-hardening.mjs
//   (needs slides/dist-single built; E2E_ONLY=<step> runs one step)
//
//   legacy        a foreign .html opens WITHOUT the slidomingoDesktop bridge,
//                 and cannot navigate its view anywhere; only a link the user
//                 really clicked goes to the browser (a script's can't)
//   shell         the app shell can't be navigated away from either (a deck's
//                 svg <a href="https://…">), the bridge survives; external
//                 links leave only from a trusted click (window.open is
//                 denied); the speaker window has no bridge; a stored API
//                 key goes only to the baseUrl its profile was SAVED with
//   ipc-guard     a page that is not the app shell (here: one given the doc
//                 preload anyway) is refused by every slidomingo:* channel,
//                 a non-terminal page by every terminal:* one; any new
//                 webContents can neither open windows nor leave its page
//   present-link  in the player, a clicked rich-text link goes to the browser
//                 through the bridge (window.open is denied) and the show
//                 stays where it is
//   second-instance  a second launch focuses a DOCUMENT window, never a
//                 stray non-document window that happens to be first
//   prefs         a viewer pref set in one window reaches every other open
//                 deck as a `storage` event (offline mode, kernel net.ts)
//   menu-focus    a focused terminal pop-out is not a document window: the
//                 terminal menu items are disabled and do nothing; closing the
//                 pop-out leaves exactly one terminal renderer, not two
//   save-as       Save As asks before overwriting a deck whose name the app
//                 added `.beeslides.html` to (the panel never checked it)
//   launch-missing  `--open` of a missing file still opens a window
//
// Same two-mode shape as e2e-autosave.mjs: node runs the ORCHESTRATOR (one
// Electron launch per step, throwaway userData), Electron the DRIVER.

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

// =================================================================================
// DRIVER (inside Electron)
// =================================================================================
async function driver() {
  const { app, dialog, shell, safeStorage, BrowserWindow, Menu, webContents } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  BrowserWindow.prototype.show = function () { this.setOpacity(0); this.showInactive() }
  globalThis.__focused = []
  BrowserWindow.prototype.focus = function () { globalThis.__focused.push(this) }
  // a non-document window older than every document window (second-instance):
  // a 'ready' listener registered before main's whenReady().then runs first
  let stray = null
  if (process.env.E2E_STEP === 'second-instance') app.once('ready', () => { stray = new BrowserWindow({ show: false, width: 200, height: 200 }) })
  app.dock?.hide()
  const step = process.env.E2E_STEP
  const arg = JSON.parse(process.env.E2E_ARG || '{}')

  // nothing leaves the machine: links are recorded, not opened
  globalThis.__external = []
  shell.openExternal = async (url) => { globalThis.__external.push(url) }
  globalThis.__boxes = []
  globalThis.__boxAnswer = 1
  dialog.showMessageBox = async (_w, o) => { globalThis.__boxes.push(o ?? _w); return { response: globalThis.__boxAnswer } }
  dialog.showSaveDialog = async () => ({ canceled: !globalThis.__savePath, filePath: globalThis.__savePath })
  // no keychain prompt in a test: a reversible stand-in for safeStorage
  safeStorage.isEncryptionAvailable = () => true
  safeStorage.encryptString = (s) => Buffer.from(`E2E:${s}`)
  safeStorage.decryptString = (b) => b.toString().replace(/^E2E:/, '')

  // the mock API (shell step): records every request's path and auth header
  const seen = []
  let mock = null
  if (arg.port) {
    mock = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization ?? '' })
      req.resume()
      req.on('end', () => res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"mock"}}'))
    })
    await new Promise((r) => mock.listen(arg.port, '127.0.0.1', r))
  }

  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const report = () => { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const hardStop = setTimeout(() => { ok(false, `step ${step} timed out`); report(); app.exit(3) }, 90000)
  const quit = () => { report(); clearTimeout(hardStop); mock?.close(); app.exit(0) }

  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(150)
    }
  }
  const live = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed())
  const findWc = (test, ready = 'true', except = []) => waitFor(async () => {
    for (const wc of live()) {
      if (except.includes(wc) || wc.isLoading() || !test(wc.getURL())) continue
      if (await wc.executeJavaScript(`!!(${ready})`)) return wc
    }
    return null
  })
  const isShell = (u) => /BeeSlides\.beeslides\.html/.test(u)
  const EDITOR = 'window.slidomingo && window.slidomingo.doc && document.querySelector(".ed-root")'
  const js = (wc, src) => wc.executeJavaScript(src, true)
  const jsNoGesture = (wc, src) => wc.executeJavaScript(src, false)
  /** A real (trusted) left click at view coordinates. */
  const click = async (wc, x, y) => {
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(600)
  }

  if (step === 'legacy') {
    const legacyUrl = pathToFileURL(arg.path).href
    const wc = await findWc((u) => u === legacyUrl, 'window.__ran === 1')
    ok(!!wc, 'the foreign page loaded and its own script ran')
    if (!wc) return quit()
    ok(await js(wc, 'typeof window.slidomingoDesktop') === 'undefined', 'it has NO slidomingoDesktop bridge (no preload)')
    await js(wc, `location.href = 'https://example.invalid/from-legacy'; true`)
    await sleep(1000)
    ok(wc.getURL() === legacyUrl, `it cannot navigate its view to a remote site (${wc.getURL()})`)
    ok(!globalThis.__external.includes('https://example.invalid/from-legacy'), 'and a script\'s navigation is not handed to the browser either')
    await js(wc, `document.getElementById('out').click(); true`)
    await sleep(800)
    ok(!globalThis.__external.includes('https://example.invalid/clicked'), 'nor a scripted click on a link')
    await click(wc, 40, 30)
    ok(wc.getURL() === legacyUrl, 'a real click on a link does not navigate the view')
    ok(globalThis.__external.includes('https://example.invalid/clicked'), `…it opens in the browser (${JSON.stringify(globalThis.__external)})`)
    const n = globalThis.__external.length
    await click(wc, 40, 130)
    ok(globalThis.__external.length === n, 'a clicked link whose page script goes elsewhere is not handed over')
    await sleep(1100)
    await js(wc, `window.open('https://example.invalid/scripted-open', '_blank'); true`)
    await sleep(600)
    ok(!globalThis.__external.includes('https://example.invalid/scripted-open'), 'a script\'s window.open is not handed over')
    await click(wc, 40, 230)
    ok(globalThis.__external.includes('https://example.invalid/blank'), 'a clicked target=_blank link is')
    ok(BrowserWindow.getAllWindows().length === 1, '…and opens no app window')
    await js(wc, `location.href = ${JSON.stringify(pathToFileURL(arg.other).href)}; true`)
    await sleep(800)
    ok(wc.getURL() === legacyUrl, 'nor to another local file')
    ok(!globalThis.__external.some((u) => u.startsWith('file:')), 'and a file: URL is never handed to the OS')
    return quit()
  }

  if (step === 'shell') {
    const wc = await findWc(isShell, EDITOR)
    ok(!!wc, 'the deck opened in the app shell')
    if (!wc) return quit()
    const shellUrl = wc.getURL()
    ok(await js(wc, 'typeof window.slidomingoDesktop.getAiProfiles') === 'function', 'the app shell has the bridge')
    // what a deck's sanitized svg keeps: a remote link, clicked in present mode
    await js(wc, `(() => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      const a = document.createElementNS('http://www.w3.org/2000/svg', 'a')
      a.setAttribute('href', 'https://example.invalid/from-deck')
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      r.setAttribute('width', '10'); r.setAttribute('height', '10')
      a.appendChild(r); svg.appendChild(a); document.body.appendChild(svg)
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return true
    })()`)
    await sleep(1200)
    ok(wc.getURL() === shellUrl, `a deck's svg link does not navigate the doc view (${wc.getURL().slice(0, 60)})`)
    ok(!globalThis.__external.includes('https://example.invalid/from-deck'), 'a scripted click on it opens nothing')
    // …a real click on one does (the preload's click handler → main)
    await js(wc, `(() => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('style', 'position:fixed;left:0;top:0;width:80px;height:80px;z-index:2147483647')
      const a = document.createElementNS('http://www.w3.org/2000/svg', 'a')
      a.setAttribute('href', 'https://example.invalid/clicked-svg')
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      r.setAttribute('width', '80'); r.setAttribute('height', '80')
      a.appendChild(r); svg.appendChild(a); svg.id = 'e2e-link'; document.body.appendChild(svg)
      return true
    })()`)
    await click(wc, 40, 40)
    ok(globalThis.__external.includes('https://example.invalid/clicked-svg'), `a trusted click on a deck link opens it in the browser (${JSON.stringify(globalThis.__external)})`)
    ok(wc.getURL() === shellUrl, '…without navigating the doc view')
    await js(wc, `document.getElementById('e2e-link').remove(); true`)
    ok(await js(wc, `!!(${EDITOR}) && typeof window.slidomingoDesktop.getAiProfiles === 'function'`), 'the editor and its bridge are still there')

    // window.open never opens a link (or an app window), click or not
    await sleep(1100) // past the hand-off gap
    const wins0 = BrowserWindow.getAllWindows().length
    const opened = await js(wc, `!!window.open('https://example.invalid/window-open', '_blank')`)
    await sleep(600)
    ok(!opened && BrowserWindow.getAllWindows().length === wins0, 'window.open of a link opens no window')
    ok(!globalThis.__external.includes('https://example.invalid/window-open'), '…and nothing in the browser')
    // the explicit bridge call: a user activation, http(s)/mailto only
    ok(await jsNoGesture(wc, `window.slidomingoDesktop.openExternal('https://example.invalid/no-gesture')`) === false &&
      !globalThis.__external.includes('https://example.invalid/no-gesture'), 'openExternal without a user activation is refused')
    ok(await js(wc, `window.slidomingoDesktop.openExternal('https://example.invalid/gesture')`) === true &&
      globalThis.__external.includes('https://example.invalid/gesture'), 'openExternal during a click opens the link')
    await sleep(1100)
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'slidomingo://x', 'not a url']) {
      ok(await js(wc, `window.slidomingoDesktop.openExternal(${JSON.stringify(bad)})`) === false && !globalThis.__external.includes(bad), `openExternal refuses ${bad}`)
    }
    ok(await js(wc, `window.slidomingoDesktop.openExternal('mailto:someone@example.invalid')`) === true, 'a mailto: link is allowed')

    // the speaker window: allowed by name, scriptable by the deck, no bridge
    const before = new Set(BrowserWindow.getAllWindows())
    await js(wc, `window.__sp = window.open('about:blank', 'slidomingo-speaker', 'width=400,height=300'); !!window.__sp`)
    const sp = await waitFor(async () => BrowserWindow.getAllWindows().find((w) => !before.has(w) && !w.isDestroyed()) ?? null, 5000)
    ok(!!sp, 'the speaker window opens')
    if (sp) {
      await js(wc, `window.__sp.document.body.innerHTML = '<p id="sv">notes</p>'; true`)
      ok(await sp.webContents.executeJavaScript(`document.getElementById('sv')?.textContent`) === 'notes', 'the deck paints into it')
      ok(await sp.webContents.executeJavaScript('typeof window.slidomingoDesktop') === 'undefined', 'it has NO desktop bridge (no preload)')
      sp.destroy()
    }

    // a stored key goes only where its profile was saved to go
    const base = `http://127.0.0.1:${arg.port}`
    const profile = { id: 'api-x', name: 'X', kind: 'api', wire: 'openai', baseUrl: `${base}/saved`, model: 'm' }
    const saved = await js(wc, `window.slidomingoDesktop.saveAiProfiles(${JSON.stringify([profile])}, 'api-x')`)
    ok(saved?.profiles?.some((p) => p.id === 'api-x'), 'the shell can save profiles (sender check lets it through)')
    const setKey = await js(wc, `window.slidomingoDesktop.setAiProfileKey('api-x', 'sk-e2e-secret')`)
    ok(setKey?.ok === true, 'and store a key')
    const moved = await js(wc, `window.slidomingoDesktop.testAiProfile(${JSON.stringify({ ...profile, baseUrl: `${base}/elsewhere` })})`)
    await sleep(300)
    ok(moved?.ok === false && /save the profile first/i.test(moved.message), `testing the saved id against another address is refused (${moved?.message})`)
    ok(!seen.some((r) => r.auth.includes('sk-e2e-secret')), 'and the stored key was sent nowhere')
    const same = await js(wc, `window.slidomingoDesktop.testAiProfile(${JSON.stringify(profile)})`)
    ok(same && typeof same.message === 'string', 'testing it as saved runs')
    ok(seen.some((r) => r.url.startsWith('/saved') && r.auth.includes('sk-e2e-secret')), `…and sends the key to the saved address only (${JSON.stringify(seen.map((r) => r.url))})`)
    ok(!seen.some((r) => r.url.startsWith('/elsewhere')), 'nothing ever reached the other address')
    // a new, unsaved profile tests with the key just typed for it
    const fresh = { ...profile, id: 'api-new', baseUrl: `${base}/fresh` }
    await js(wc, `window.slidomingoDesktop.setAiProfileKey('api-new', 'sk-typed')`)
    await js(wc, `window.slidomingoDesktop.testAiProfile(${JSON.stringify(fresh)})`)
    ok(seen.some((r) => r.url.startsWith('/fresh') && r.auth.includes('sk-typed')), 'an unsaved profile still tests with the key typed for it')
    return quit()
  }

  if (step === 'prefs') {
    const a = await findWc(isShell, EDITOR)
    ok(!!a, 'deck A opened')
    if (!a) return quit()
    app.emit('open-file', { preventDefault() {} }, arg.second)
    const b = await findWc(isShell, EDITOR, [a])
    ok(!!b, 'deck B opened in a second window')
    if (!b) return quit()
    const listen = `window.__seen = []; addEventListener('storage', (e) => window.__seen.push(e.key + '=' + e.newValue)); true`
    await js(a, listen)
    await js(b, listen)
    ok(await js(b, `localStorage.getItem('slidomingo-offline')`) !== 'on', 'B starts with offline mode off')
    // what kernel/src/storage.ts lsSet does when the switch is flipped in A
    await js(a, `localStorage.setItem('slidomingo-offline', 'on'); window.slidomingoDesktop.setViewerPref('slidomingo-offline', 'on'); true`)
    const got = await waitFor(async () => (await js(b, `window.__seen.includes('slidomingo-offline=on')`)) || null, 5000)
    ok(!!got, 'B got a `storage` event for it in its page (what kernel net.ts listens to)')
    ok(await js(b, `localStorage.getItem('slidomingo-offline')`) === 'on', 'and B\'s localStorage holds the new value')
    ok((await js(a, 'window.__seen')).length === 0, 'the window that made the change gets no event (storage semantics)')
    await js(a, `localStorage.removeItem('slidomingo-offline'); window.slidomingoDesktop.setViewerPref('slidomingo-offline', null); true`)
    const gone = await waitFor(async () => (await js(b, `window.__seen.includes('slidomingo-offline=null') && localStorage.getItem('slidomingo-offline') === null`)) || null, 5000)
    ok(!!gone, 'clearing it reaches B too')
    return quit()
  }

  if (step === 'menu-focus') {
    const wc = await findWc(isShell, EDITOR)
    ok(!!wc, 'the deck opened')
    if (!wc) return quit()
    const docWin = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    const terminals = () => live().filter((w) => /\/terminal\//.test(w.getURL()))
    await js(wc, 'window.slidomingoDesktop.toggleTerminal()')
    const term = await findWc((u) => /\/terminal\//.test(u), '!!(window.slidomingoTerminal && document.querySelector(".chat"))')
    ok(!!term, 'the panel opened (an API chat tab: no pty)')
    if (!term) return quit()
    const before = new Set(BrowserWindow.getAllWindows())
    await js(term, 'window.slidomingoTerminal.popOut(); true')
    const popout = await waitFor(async () => BrowserWindow.getAllWindows().find((w) => !before.has(w) && !w.isDestroyed()) ?? null)
    ok(!!popout, 'the panel popped out into its own window')
    if (!popout) return quit()
    await waitFor(async () => (terminals().length === 1 && !terminals()[0].isLoading()) || null)
    ok(terminals().length === 1, `one terminal renderer while popped out (${terminals().length})`)

    const item = () => {
      const walk = (items) => {
        for (const it of items) {
          if (it.label === 'Claude Code Terminal') return it
          const f = it.submenu && walk(it.submenu.items)
          if (f) return f
        }
        return null
      }
      return walk(Menu.getApplicationMenu()?.items ?? [])
    }
    const realFocused = BrowserWindow.getFocusedWindow
    BrowserWindow.getFocusedWindow = () => popout
    app.emit('browser-window-focus', {}, popout)
    await sleep(200)
    ok(item() && item().enabled === false, 'with the pop-out focused, View ▸ Claude Code Terminal is disabled')
    const n0 = terminals().length
    item()?.click()
    await sleep(1500)
    ok(terminals().length === n0, `…and choosing it anyway starts no second panel (${terminals().length} terminal renderers)`)
    BrowserWindow.getFocusedWindow = () => docWin
    app.emit('browser-window-focus', {}, docWin)
    await sleep(200)
    ok(item() && item().enabled === true, 'with the deck focused it is enabled again')
    BrowserWindow.getFocusedWindow = realFocused

    // closing the pop-out docks the panel back; its old renderer must go
    popout.close()
    const docked = await waitFor(async () => (popout.isDestroyed() && terminals().length >= 1 && !terminals().some((w) => w.isLoading())) || null)
    ok(!!docked, 'closing the pop-out docks the panel back')
    await sleep(1500)
    ok(terminals().length === 1, `exactly one terminal renderer after the dock (${terminals().length}) — the pop-out's is closed`)
    return quit()
  }

  if (step === 'save-as') {
    const wc = await findWc(isShell, EDITOR)
    ok(!!wc, 'the deck opened')
    if (!wc) return quit()
    const html = readFileSync(arg.path, 'utf8')
    const strings = { replaceMessage: 'R? {name}', replaceDetail: 'D', replace: 'Yes', cancel: 'No' }
    const saveAs = () => js(wc, `window.slidomingoDesktop.saveDocumentAs(${JSON.stringify({ html, suggestedName: 'Report', mode: 'copy', strings })})`)
    const before = readFileSync(arg.existing, 'utf8')

    // typed `Report` → the panel returns Report.html, written as Report.beeslides.html
    globalThis.__savePath = arg.typed
    globalThis.__boxAnswer = 1
    const r1 = await saveAs()
    ok(r1?.cancelled === true, `the user is asked before an existing deck is replaced — and Cancel cancels (${JSON.stringify(r1)})`)
    const box = globalThis.__boxes.at(-1)
    ok(box?.message === 'R? Report.beeslides.html' && box?.buttons?.join() === 'Yes,No', `the box uses the renderer's strings and names the real file (${box?.message})`)
    ok(readFileSync(arg.existing, 'utf8') === before, 'the existing deck is untouched')
    globalThis.__boxAnswer = 0
    const r2 = await saveAs()
    ok(r2?.ok === true && r2.path === arg.existing, 'Replace writes it')
    ok(readFileSync(arg.existing, 'utf8') === html, '…with the new bytes')
    // the panel already confirmed a name it returned unchanged: no second box
    const boxes = globalThis.__boxes.length
    globalThis.__savePath = arg.existing
    const r3 = await saveAs()
    ok(r3?.ok === true && globalThis.__boxes.length === boxes, 'a name the panel itself confirmed is not asked about twice')
    // a fresh name: nothing to confirm
    globalThis.__savePath = arg.fresh
    const r4 = await saveAs()
    ok(r4?.ok === true && globalThis.__boxes.length === boxes && existsSync(arg.fresh.replace(/\.html$/, '.beeslides.html')), 'a new name is written without a box')
    // the editor's own Save a copy… sends its translated strings
    await js(wc, `window.slidomingo.i18n.setLocale('de'); true`)
    globalThis.__savePath = arg.typed
    globalThis.__boxAnswer = 1
    wc.send('slidomingo:menu-command', 'file.saveCopy')
    const de = await waitFor(async () => (globalThis.__boxes.length > boxes ? globalThis.__boxes.at(-1) : null), 8000)
    ok(de?.message === '„Report.beeslides.html“ ist bereits vorhanden. Ersetzen?' && de?.buttons?.join() === 'Ersetzen,Abbrechen',
      `the editor's Save a copy… asks in the UI language (${de?.message} / ${de?.buttons?.join()})`)
    return quit()
  }

  if (step === 'ipc-guard') {
    const wc = await findWc(isShell, EDITOR)
    ok(!!wc, 'the deck opened')
    if (!wc) return quit()
    // a page that is NOT the app shell, given the doc preload anyway (what a
    // navigated-away or misconfigured view would be)
    const fake = new BrowserWindow({ show: false, webPreferences: { preload: join(desktopDir, 'out/preload/index.mjs'), contextIsolation: true, sandbox: false } })
    await fake.loadURL('data:text/html,<p>not the app</p>')
    const fwc = fake.webContents
    ok(await js(fwc, 'typeof window.slidomingoDesktop') === 'object', 'the impostor page got the bridge object (its preload ran without hanging on the sync prefs call)')
    const refused = (r) => !!r && r.refused === true && /only BeeSlides's own app shell/.test(r.error)
    const profiles = await js(fwc, 'window.slidomingoDesktop.getAiProfiles()')
    ok(refused(profiles), `getAiProfiles is refused (${JSON.stringify(profiles)?.slice(0, 100)})`)
    ok(refused(await js(fwc, 'window.slidomingoDesktop.listRecent()')), 'listRecent is refused')
    ok(refused(await js(fwc, `window.slidomingoDesktop.readLaunchDocument()`)), 'readLaunchDocument is refused')
    ok(refused(await js(fwc, `window.slidomingoDesktop.openExternal('https://example.invalid/impostor')`)) && !globalThis.__external.length, 'openExternal is refused')
    await js(fwc, `window.slidomingoDesktop.recordRecent && window.slidomingoDesktop.recordRecent(${JSON.stringify(arg.recent)}); true`)
    await sleep(400)
    ok(!(await js(wc, 'window.slidomingoDesktop.listRecent()')).some((r) => r.path === arg.recent), 'a fire-and-forget send (record-recent) is ignored')
    ok(Array.isArray(await js(wc, 'window.slidomingoDesktop.listRecent()')), 'the real app shell is still served')
    // the terminal preload outside a terminal view
    const fakeTerm = new BrowserWindow({ show: false, webPreferences: { preload: join(desktopDir, 'out/preload/terminal.mjs'), contextIsolation: true, sandbox: false } })
    await fakeTerm.loadURL('data:text/html,<p>not the terminal</p>')
    const lp = await js(fakeTerm.webContents, 'window.slidomingoTerminal.listProfiles()')
    ok(lp?.refused === true && /terminal panel/.test(lp.error), `terminal:list-profiles is refused (${JSON.stringify(lp)?.slice(0, 100)})`)
    ok((await js(fakeTerm.webContents, 'window.slidomingoTerminal.newTab()'))?.refused === true, 'terminal:new-tab is refused')
    // deny by default: ANY new webContents, not just the ones main configures
    const n = BrowserWindow.getAllWindows().length
    await js(fwc, `window.open('data:text/html,popup', '_blank'); true`)
    await sleep(600)
    ok(BrowserWindow.getAllWindows().length === n, 'a plain new webContents cannot open a window')
    const u0 = fwc.getURL()
    await js(fwc, `location.href = 'https://example.invalid/away'; true`)
    await sleep(800)
    ok(fwc.getURL() === u0, `…nor navigate off its page (${fwc.getURL().slice(0, 40)})`)
    fake.destroy(); fakeTerm.destroy()
    return quit()
  }

  if (step === 'present-link') {
    const wc = await findWc(isShell, EDITOR)
    ok(!!wc, 'the deck opened')
    if (!wc) return quit()
    const overlay = () => js(wc, `!!document.querySelector('.slidomingo-present-overlay section.present a[href]')`)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'F5' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'F5' })
    ok(!!await waitFor(overlay, 8000), 'F5 starts the show, the link is live')
    await sleep(1200) // the slide transition
    const r = await js(wc, `(() => { const b = document.querySelector('.slidomingo-present-overlay section.present a[href]').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()`)
    await sleep(1100) // past the hand-off gap of the key press
    const n0 = BrowserWindow.getAllWindows().length // (+ a speaker window on a 2-display machine)
    await click(wc, Math.round(r[0]), Math.round(r[1]))
    ok(globalThis.__external.includes('https://example.invalid/rich'), `a click on the rich-text link opens it in the browser (${JSON.stringify(globalThis.__external)})`)
    ok(await overlay(), 'and the show is still running')
    const n = BrowserWindow.getAllWindows().length
    ok(n === n0, `no app window was opened for it (${n0} → ${n} windows)`)
    return quit()
  }

  if (step === 'second-instance') {
    const wc = await findWc(isShell, EDITOR)
    ok(!!wc, 'the deck opened')
    if (!wc) return quit()
    // getAllWindows() has no defined order: put the stray first, as it may be
    const realAll = BrowserWindow.getAllWindows
    BrowserWindow.getAllWindows = () => { const all = realAll.call(BrowserWindow); return [stray, ...all.filter((w) => w !== stray)] }
    ok(BrowserWindow.getAllWindows()[0] === stray, 'a non-document window comes first in getAllWindows()')
    globalThis.__focused = []
    app.emit('second-instance', { preventDefault() {} }, [process.execPath], process.cwd())
    await sleep(300)
    const docWin = BrowserWindow.getAllWindows().find((w) => w !== stray && w.contentView.children.some((v) => v.webContents === wc))
    ok(globalThis.__focused.length > 0 && globalThis.__focused.every((w) => w === docWin), `a second launch focuses the document window (${globalThis.__focused.map((w) => w === stray ? 'stray' : w === docWin ? 'doc' : '?').join()})`)
    ok(!stray.isDestroyed() && BrowserWindow.getAllWindows().length === 2, 'and opens no new window')
    return quit()
  }

  if (step === 'launch-missing') {
    const wc = await findWc(isShell, 'document.readyState === "complete"')
    ok(!!wc, 'a missing --open file still leaves the app with a window (a new deck)')
    return quit()
  }

  ok(false, `unknown step ${step}`)
  quit()
}

// =================================================================================
// ORCHESTRATOR (node)
// =================================================================================
async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron')
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const shellHtml = readFileSync(SHELL_PATH, 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-hardening-'))
  const work = join(root, 'work')
  const home = join(root, 'home')
  mkdirSync(work, { recursive: true })
  mkdirSync(home, { recursive: true })
  const deck = (name, title) => {
    const p = join(work, name)
    const doc = Object.assign(newDoc(), { title })
    writeFileSync(p, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
    return p
  }
  const { createServer: net } = await import('node:net')
  const freePort = () => new Promise((r) => { const s = net(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  // a fake login shell: `env` answers, anything else (a pty) just idles
  const fakeShell = join(root, 'fake-shell')
  writeFileSync(fakeShell, '#!/bin/sh\n[ "$2" = env ] && exec /usr/bin/env\nexec cat > /dev/null\n', { mode: 0o755 })

  const only = process.env.E2E_ONLY
  function run(step, { open, arg = {}, settings } = {}) {
    if (only && only !== step) return
    console.log(`\n# ${step}`)
    const userData = join(root, `userdata-${step}`)
    mkdirSync(userData, { recursive: true })
    if (settings) writeFileSync(join(userData, 'app-settings.json'), JSON.stringify(settings))
    const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), ...(open ? ['--open', open] : [])], {
      cwd: desktopDir,
      env: {
        ...process.env, E2E_STEP: step, E2E_ARG: JSON.stringify(arg), SHELL: fakeShell, HOME: home,
        SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'),
        SLIDOMINGO_LIBRARY_PATH: join(root, 'Library.beeslides.html'),
        ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '',
      },
      encoding: 'utf8', timeout: 120000,
    })
    const out = res.stdout ?? ''
    for (const line of out.split('\n')) if (/^\s+(ok|FAIL)\s/.test(line)) console.log(line)
    const m = out.match(/E2E_RESULT (\d+) (\d+)/)
    if (!m) { checks++; failures++; console.log(`  FAIL  step ${step} produced no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); return }
    checks += Number(m[1]); failures += Number(m[2])
  }

  const legacy = join(work, 'foreign.html')
  writeFileSync(legacy, '<!doctype html><html><body style="margin:0">'
    + '<a id="out" href="https://example.invalid/clicked" style="position:fixed;left:0;top:0;width:120px;height:60px;display:block">out</a>'
    + '<a id="sly" href="https://example.invalid/shown" style="position:fixed;left:0;top:100px;width:120px;height:60px;display:block">sly</a>'
    + '<a id="blank" href="https://example.invalid/blank" target="_blank" style="position:fixed;left:0;top:200px;width:120px;height:60px;display:block">blank</a>'
    + '<script>window.__ran = 1; document.getElementById("sly").addEventListener("click", (e) => { e.preventDefault(); location.href = "https://example.invalid/hidden" })</script>'
    + '</body></html>')
  const other = join(work, 'other.html')
  writeFileSync(other, '<!doctype html><p>other</p>')
  run('legacy', { open: legacy, arg: { path: legacy, other } })

  run('shell', { open: deck('Shell.beeslides.html', 'Shell'), arg: { port: await freePort() } })

  run('prefs', { open: deck('A.beeslides.html', 'A'), arg: { second: deck('B.beeslides.html', 'B') } })

  run('menu-focus', {
    open: deck('Menu.beeslides.html', 'Menu'),
    settings: {
      aiProfiles: [{ id: 'api-idle', name: 'Idle', kind: 'api', wire: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'm' }],
      defaultAiProfileId: 'api-idle',
    },
  })

  const saveDir = join(work, 'save-as')
  mkdirSync(saveDir)
  const existing = join(saveDir, 'Report.beeslides.html')
  writeFileSync(existing, 'EXISTING DECK BYTES')
  run('save-as', {
    open: deck('Source.beeslides.html', 'Source'),
    arg: { path: join(work, 'Source.beeslides.html'), existing, typed: join(saveDir, 'Report.html'), fresh: join(saveDir, 'Fresh.html') },
  })

  run('ipc-guard', { open: deck('Guard.beeslides.html', 'Guard'), arg: { recent: deck('Impostor.beeslides.html', 'Impostor') } })

  const linkDeck = join(work, 'Link.beeslides.html')
  {
    const doc = Object.assign(newDoc(), { title: 'Link' })
    doc.requires = [...new Set([...(doc.requires ?? []), 'rich-text'])]
    doc.slides = [{ ...doc.slides[0], elements: [{ id: 'lnk', type: 'text', x: 100, y: 100, w: 900, h: 140, rotation: 0, opacity: 1,
      html: '<a href="https://example.invalid/rich">a web link</a>', fontSize: 72, fontFamily: '', fontWeight: 400, color: '#111111',
      align: 'left', valign: 'top', lineHeight: 1.2 }] }]
    writeFileSync(linkDeck, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
  }
  run('present-link', { open: linkDeck })

  run('second-instance', { open: deck('Second.beeslides.html', 'Second') })

  run('launch-missing', { open: join(work, 'does-not-exist.beeslides.html') })

  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
