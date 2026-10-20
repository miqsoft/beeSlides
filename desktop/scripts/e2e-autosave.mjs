#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Desktop disk-autosave E2E: "every deck is always saved".
//
//   cd desktop && npx electron-vite build && node scripts/e2e-autosave.mjs
//   (needs slides/dist-single built)
//   E2E_BIG_DECK=/path/to/a/COPY.beeslides.html also times a big deck and
//   checks an old-build file re-saves into the current shell.
//   Windows stay hidden (no Dock icon); E2E_SHOW=1 shows them, and
//   E2E_SHOTS=<dir> saves screenshots (from invisible, unfocused windows).
//
// TWO MODES IN ONE FILE. Run with node, it is the ORCHESTRATOR: it makes
// fixtures, launches Electron once per step (sharing one throwaway profile,
// SLIDOMINGO_USER_DATA, and templates folder, SLIDOMINGO_TEMPLATES_DIR — the
// user's own data is never touched), and checks the disk after each exit. Run
// by Electron (`process.versions.electron`), it is the DRIVER: it imports the
// real built main process and drives it from inside, with native dialogs
// stubbed. Not playwright-core's _electron.launch: against this app it times
// out after both inspectors connect, with a CommonJS entry too; cause not
// found.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repo = resolve(desktopDir, '..')
const SHELL_PATH = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
const rtOf = (h) => h.match(/id="beeslides-rt"[^>]*>([\s\S]*?)<\/script>/)?.[1]
const BLOCK_RE = /(<script[^>]*\bid=["']beeslides-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) failures++
  try { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) } catch { /* pipe gone */ }
}

// No top-level await in Electron mode: Electron holds its `ready` event until
// an ESM entry finishes evaluating, so awaiting whenReady() there deadlocks.
if (process.versions.electron) {
  driver().catch(async (err) => {
    ok(false, `driver error: ${err?.message ?? err}`)
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
  const { app, dialog, BrowserWindow, webContents } = await import('electron')
  if (process.env.E2E_SHOTS) {
    // an invisible window counts as occluded: without these, Chromium stops
    // producing frames and capturePage hands back a stale one
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    app.commandLine.appendSwitch('disable-renderer-backgrounding')
  }
  const step = process.env.E2E_STEP
  const arg = JSON.parse(process.env.E2E_ARG || '{}')
  globalThis.__dialogs = []
  dialog.showMessageBox = async (_w, o) => { globalThis.__dialogs.push((o ?? _w)?.message ?? 'box'); return { response: 1 } }
  // records what main offered, and answers with __nextSavePath when a step
  // saves more than once
  globalThis.__saveDefaults = []
  dialog.showSaveDialog = async (_w, o) => {
    globalThis.__saveDefaults.push((o ?? _w)?.defaultPath ?? '')
    const p = globalThis.__nextSavePath ?? arg.savePath
    return { canceled: !p, filePath: p }
  }
  // Stay out of the way: every step relaunches the app, so windows would pop
  // up (and steal focus) a dozen times per run. They stay hidden and the app
  // stays out of the Dock unless E2E_SHOW=1.
  if (!process.env.E2E_SHOW) {
    // With E2E_SHOTS a window must paint to be captured: show it fully
    // transparent and inactive — invisible, and it never takes focus.
    BrowserWindow.prototype.show = process.env.E2E_SHOTS
      ? function () { this.setOpacity(0); this.showInactive() }
      : function () {}
    BrowserWindow.prototype.focus = function () {}
    app.dock?.hide()
  }
  // Every step is a fresh launch: forget what the previous step's quit left
  // open, or a launch without --open would reopen it (restoreSession, index.ts).
  try {
    const sp = join(process.env.SLIDOMINGO_USER_DATA, 'app-settings.json')
    const s = JSON.parse(readFileSync(sp, 'utf8'))
    if (s.session) { delete s.session; writeFileSync(sp, JSON.stringify(s, null, 2)) }
  } catch { /* no settings yet */ }
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const hardStop = setTimeout(() => { ok(false, `step ${step} timed out`); report(); app.exit(3) }, 90000)

  const docWcs = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && /BeeSlides\.beeslides\.html/.test(w.getURL()))
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(150)
    }
  }
  const js = (wc, fn, a) => wc.executeJavaScript(`(${fn})(${JSON.stringify(a ?? null)})`)
  async function page(pred = 'window.beeslides && window.beeslides.doc && document.querySelector(".ed-root")') {
    return waitFor(async () => {
      for (const wc of docWcs()) {
        if (wc.isLoading()) continue
        if (await wc.executeJavaScript(`!!(${pred})`).catch(() => false)) return wc
      }
      return null
    })
  }
  const setTitle = (wc, title) => js(wc, (t) => {
    const d = JSON.parse(JSON.stringify(window.beeslides.doc)); d.title = t
    window.beeslides.loadDoc(JSON.stringify(d))
  }, title)
  const status = (wc) => js(wc, () => document.querySelector('.ed-savestatus')?.textContent ?? null)
  const readDoc = (p) => JSON.parse(readFileSync(p, 'utf8').match(BLOCK_RE)[2].trim())
  const deckHtml = (doc) => readFileSync(SHELL_PATH, 'utf8').replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`)
  /** E2E_SHOTS=<dir>: save a screenshot of `wc` for a visual check. */
  async function shot(wc, name) {
    if (!process.env.E2E_SHOTS) return
    try {
      wc.invalidate()
      await sleep(400)
      writeFileSync(join(process.env.E2E_SHOTS, `${name}.png`), (await wc.capturePage()).toPNG())
    } catch { /* best effort */ }
  }
  /** The next <input type=file> `wc` opens is answered with `paths` — real
   *  files through CDP (so webUtils.getPathForFile sees their paths), never
   *  the native chooser. */
  async function answerFilePick(wc, paths) {
    const dbg = wc.debugger
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      await dbg.sendCommand('Page.enable')
      await dbg.sendCommand('DOM.enable')
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      dbg.on('message', (_ev, method, params) => {
        if (method !== 'Page.fileChooserOpened') return
        const files = globalThis.__pickQueue?.shift() ?? []
        void dbg.sendCommand('DOM.setFileInputFiles', { files, backendNodeId: params.backendNodeId }).catch((e) => ok(false, `file pick: ${e.message}`))
      })
    }
    ;(globalThis.__pickQueue ??= []).push(paths)
  }
  /** Clicks the button labelled `label` on the start page line `line` — as
   *  a user gesture, which a file chooser needs to open at all. */
  const clickLine = (wc, line, label) => wc.executeJavaScript(`(${([line, label]) => {
    const l = [...document.querySelectorAll('.ed-sp-line')].find((x) => x.querySelector('.ed-sp-line-label').textContent === line)
    const b = [...l.querySelectorAll('button')].find((x) => x.textContent === label)
    b.click()
    return true
  }})(${JSON.stringify([line, label])})`, true)
  function report() { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const quit = () => { report(); clearTimeout(hardStop); app.quit() }

  if (step === 'open-edit-close') {
    const p = arg.path
    const before = statSync(p).mtimeMs
    const wc = await page()
    ok(!!wc, 'the deck window boots')
    ok(/\/slides\/dist-single\/BeeSlides\.beeslides\.html$/.test(wc.getURL()), 'it runs the CURRENT app shell, not the file')
    ok(await js(wc, () => window.beeslides.doc.title) === 'Alpha', 'the deck came over IPC')
    ok(await status(wc) === 'Saved', 'the indicator says Saved')
    ok(!!await waitFor(() => js(wc, () => !document.getElementById('beeslides-splash')), 6000), 'the boot splash goes away over a loaded deck')
    await shot(wc, 'editor-saved')
    await sleep(3500)
    ok(statSync(p).mtimeMs === before, 'an untouched open never rewrites the file')
    await setTitle(wc, 'Alpha edited')
    await sleep(3500)
    ok(readDoc(p).title === 'Alpha edited', 'an edit reaches the disk ~2.5s later, with no ⌘S')
    ok(await status(wc) === 'Saved', `the indicator is back to Saved (got ${await status(wc)})`)
    await setTitle(wc, 'Alpha closing')
    BrowserWindow.getAllWindows()[0].close()
    await waitFor(async () => BrowserWindow.getAllWindows().length === 0)
    ok(readDoc(p).title === 'Alpha closing', 'closing flushed the pending edit')
    ok(globalThis.__dialogs.length === 0, 'without any dialog')
    await sleep(300)
    const live = webContents.getAllWebContents().filter((w) => !w.isDestroyed()).length
    ok(live === 0, `no renderer leaked after close (${live} live)`)
    quit()
  }

  if (step === 'reopen-edited') {
    // A file the desktop app wrote is an editable file; it reopens in the
    // editor and an edit is written back into the same (editor) shell.
    const p = arg.path
    const wc = await page()
    ok(!!wc, 'a saved file opens in the editor window')
    ok(await js(wc, () => window.beeslides.doc.title) === 'Alpha closing', 'with its deck')
    await setTitle(wc, 'Alpha reopened')
    await sleep(3500)
    ok(readDoc(p).title === 'Alpha reopened', 'an edit reaches the disk')
    ok(rtOf(readFileSync(p, 'utf8')) === rtOf(readFileSync(SHELL_PATH, 'utf8')), 'and the file is still an editor file')
    BrowserWindow.getAllWindows()[0].close()
    await waitFor(async () => BrowserWindow.getAllWindows().length === 0)
    quit()
  }

  if (step === 'gated') {
    // The reader gate: a deck from a NEWER BeeSlides opens read-only, and no
    // path writes it — the orchestrator compares the file's bytes after exit.
    const wc = await page()
    ok(!!wc, 'a newer-format deck boots')
    ok(await js(wc, () => !!document.querySelector('.ed-gatebanner')), 'with the read-only banner')
    await js(wc, () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })))
    await sleep(400)
    ok(await js(wc, () => /Read-only/.test(document.querySelector('.ed-toast')?.textContent ?? '')), '⌘S says it is read-only')
    globalThis.__nextSavePath = arg.copyPath
    for (const id of ['file.saveCopy', 'file.duplicate', 'file.saveLayout']) wc.send('slidomingo:menu-command', id)
    const replaced = await js(wc, () => { const d = JSON.parse(JSON.stringify(window.beeslides.doc)); d.title = 'Changed'; return window.beeslides.loadDoc(JSON.stringify(d)) })
    ok(replaced === false, 'loadDoc refuses to replace it')
    await sleep(3500)
    ok(!existsSync(arg.copyPath), 'Save a copy… / Duplicate wrote nothing')
    ok(globalThis.__saveDefaults.length === 0, 'no save dialog was ever offered')
    BrowserWindow.getAllWindows()[0].close()
    ok(!!await waitFor(async () => BrowserWindow.getAllWindows().length === 0), 'the window closes')
    ok(globalThis.__dialogs.length === 0, 'without a "couldn’t save" dialog')
    quit()
  }

  if (step === 'store-roundtrip') {
    // The asset store: an edit rewrites the file with every picture once and
    // refs in the JSON; reopening gives back the identical assets.
    const wc = await page()
    ok(!!wc, 'a picture deck boots')
    const assets = await js(wc, () => window.beeslides.doc.assets)
    const keys = Object.keys(arg.assets)
    ok(keys.length === Object.keys(assets).length && keys.every((k) => assets[k] === arg.assets[k]), 'with every asset byte-equal to the file it was opened from')
    await setTitle(wc, arg.title)
    ok(!!await waitFor(async () => { try { return readDoc(arg.path).title === arg.title } catch { return false } }, 8000), 'the edit autosaves')
    quit()
  }

  if (step === 'optimize') {
    // Document properties ▸ Clean up ▸ Optimize pictures (lossless)…, clicked
    // for real: smaller files, reported, one undo restores every byte.
    const wc = await page()
    const before = await js(wc, () => JSON.stringify(window.beeslides.doc.assets))
    await js(wc, () => {
      window.confirm = () => true
      document.dispatchEvent(new CustomEvent('slidomingo:open-layout-manager', { detail: { tab: 'meta', force: true } }))
    })
    const clicked = await waitFor(() => js(wc, () => {
      const b = [...document.querySelectorAll('button')].find((x) => /Optimize pictures \(lossless\)/.test(x.textContent) && x.offsetParent)
      if (!b) return false
      b.click(); return true
    }), 8000)
    ok(!!clicked, 'Document properties offers "Optimize pictures (lossless)…"')
    const note = await waitFor(() => js(wc, () => {
      const t = [...document.querySelectorAll('.ed-hint, .ed-toast span')].map((e) => e.textContent).find((x) => /^Optimized \d+ picture/.test(x ?? ''))
      return t ?? null
    }), 80000)
    ok(!!note, `it reports what it saved (${note})`)
    const after = await js(wc, () => window.beeslides.doc.assets)
    const orig = JSON.parse(before)
    const changed = Object.keys(orig).filter((k) => after[k] !== orig[k])
    ok(changed.length >= 2 && changed.every((k) => after[k].length < orig[k].length), `the JPEG and PNG assets got smaller (${changed.join(', ')})`)
    ok(Object.keys(orig).every((k) => changed.includes(k) || after[k] === orig[k]), 'everything else is untouched')
    await js(wc, () => window.beeslides.undo())
    ok(await js(wc, () => JSON.stringify(window.beeslides.doc.assets)) === before, 'one undo restores the original bytes')
    quit()
  }

  if (step === 'quit-pending') {
    const wc = await page()
    await setTitle(wc, 'Beta quitting')
    quit() // the orchestrator checks the disk after exit
  }

  if (step === 'external') {
    const p = arg.path
    const wc = await page()
    await sleep(600)
    const ext = readDoc(p); ext.title = 'Gamma theirs'
    writeFileSync(p, deckHtml(ext))
    ok(!!await waitFor(() => js(wc, () => window.beeslides.doc.title === 'Gamma theirs'), 5000), 'a clean deck follows an external change by itself')
    await setTitle(wc, 'Gamma mine')
    const ext2 = readDoc(p); ext2.title = 'Gamma theirs again'
    writeFileSync(p, deckHtml(ext2))
    ok(!!await waitFor(() => js(wc, () => !!document.querySelector('.ed-diskbanner')), 5000), 'unsaved edits + an external change → conflict banner')
    await sleep(3500)
    ok(readDoc(p).title === 'Gamma theirs again', 'autosave does not clobber the external edit')
    ok(await status(wc) === 'Changed on disk', `the indicator says so (got ${await status(wc)})`)
    await js(wc, () => document.querySelector('.ed-diskbanner .ed-btn-primary').click()) // Keep mine
    await sleep(1000)
    ok(readDoc(p).title === 'Gamma mine', '"Keep mine" writes this version')
    ok(!await js(wc, () => !!document.querySelector('.ed-diskbanner')), 'and the banner goes away')
    quit()
  }

  if (step === 'blank-untouched') {
    ok(!!await page('document.querySelector(".ed-startpick")'), 'a fresh window shows the start page')
    quit()
  }

  if (step === 'blank-edit') {
    const pick = await page('document.querySelector(".ed-sp-row .ed-sp-tile")')
    await js(pick, () => document.querySelector('.ed-sp-row .ed-sp-tile').click()) // Blank
    const wc = await page()
    ok(await status(wc) === 'Draft', `a new deck is a Draft (got ${await status(wc)})`)
    await setTitle(wc, 'My draft')
    await sleep(3500)
    quit()
  }

  if (step === 'draft-reopen-saveas') {
    const blank = await page('window.slidomingoDesktop && document.querySelector(".ed-startpick")')
    const drafts = await js(blank, () => window.slidomingoDesktop.listDrafts())
    ok(drafts.length === 1 && drafts[0].title === 'My draft', `the draft survived the relaunch and is listed (${JSON.stringify(drafts.map((d) => d.title))})`)
    // not awaited: this page is replaced by the draft, so its
    // executeJavaScript promise may never settle
    void js(blank, (p) => { void window.slidomingoDesktop.openDocument(p); return true }, drafts[0].path).catch(() => {})
    const wc = await page('window.beeslides && window.beeslides.doc && window.beeslides.doc.title === "My draft"')
    ok(!!wc, 'the draft reopens with its content')
    await sleep(800)
    ok(docWcs().length === 1 && BrowserWindow.getAllWindows().length === 1, 'in the start page’s own window')
    await js(wc, () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })))
    await sleep(1500)
    ok(existsSync(arg.savePath) && readDoc(arg.savePath).title === 'My draft', '⌘S on a draft = Save as… to the chosen file')
    ok(!existsSync(drafts[0].path), 'the draft was moved, not copied')
    const recent = await js(wc, () => window.slidomingoDesktop.listRecent())
    ok(recent.some((r) => r.path === arg.savePath), 'the saved deck is in Recent')
    ok(await status(wc) === 'Saved', `the indicator switches to Saved (got ${await status(wc)})`)
    await setTitle(wc, 'Saved draft, edited')
    await sleep(3500)
    ok(readDoc(arg.savePath).title === 'Saved draft, edited', 'later edits autosave into the new file')
    quit()
  }

  if (step === 'title-saveas') {
    // Title vs. file name: offered with the title's own characters, adopted
    // only by a deck still titled Untitled, and never touched by a copy.
    // syncWindowTitle names the file, in the window title and the title bar's
    // file chip, only when it differs from the deck title.
    const named = (wc) => js(wc, () => (/ — (.+\.(?:beeslides|slidomingo)\.html)$/.exec(document.title) ?? [])[1] ?? null)
    const chip = (wc) => js(wc, () => {
      const c = document.querySelector('.ed-titlebar-title .ed-filechip')
      return c && c.offsetParent ? c.textContent : null
    })
    const pick = await page('document.querySelector(".ed-sp-row .ed-sp-tile")')
    await js(pick, () => document.querySelector('.ed-sp-row .ed-sp-tile').click()) // Blank
    let wc = await page()
    ok(await js(wc, () => window.beeslides.doc.title) === 'Untitled', 'a blank deck starts as Untitled')
    if (arg.title) {
      await setTitle(wc, arg.title)
      wc = await page(`window.beeslides && window.beeslides.doc && window.beeslides.doc.title === ${JSON.stringify(arg.title)}`)
    }
    await js(wc, () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })))
    ok(!!await waitFor(async () => existsSync(arg.savePath)), '⌘S saved the draft as the chosen file')
    const offered = basename(globalThis.__saveDefaults[0] ?? '')
    ok(offered === arg.offered, `the dialog offered ${JSON.stringify(arg.offered)} (got ${JSON.stringify(offered)})`)
    ok(!!await waitFor(() => js(wc, (t) => window.beeslides.doc.title === t, arg.expectTitle), 3000),
      `the title is ${JSON.stringify(arg.expectTitle)} (got ${JSON.stringify(await js(wc, () => window.beeslides.doc.title))})`)
    const shown = await named(wc)
    ok(shown === (arg.expectFile ?? null), arg.expectFile ? `the window names the file apart from the title (${shown})` : `title and file match, so no file is named (${shown})`)
    await shot(wc, `title-saveas-${basename(arg.savePath, '.beeslides.html')}`)
    const shownChip = await chip(wc)
    const wantChip = arg.expectFile ? arg.expectFile.replace(/\.(?:beeslides|slidomingo)\.html$/, '') : null
    ok(shownChip === wantChip, wantChip ? `the title bar's file chip shows ${JSON.stringify(wantChip)} (got ${JSON.stringify(shownChip)})` : `no file chip in the title bar (got ${JSON.stringify(shownChip)})`)
    await sleep(3500)
    ok(readDoc(arg.savePath).title === arg.expectTitle, `the file holds that title (${readDoc(arg.savePath).title})`)
    if (arg.copyPath) {
      globalThis.__nextSavePath = arg.copyPath
      wc.send('slidomingo:menu-command', 'file.saveCopy')
      ok(!!await waitFor(async () => existsSync(arg.copyPath)), 'Save a copy… wrote the copy')
      await sleep(500)
      ok(await js(wc, () => window.beeslides.doc.title) === arg.expectTitle, 'a copy leaves the title alone')
      await setTitle(wc, 'After copy')
      await sleep(3500)
      ok(readDoc(arg.savePath).title === 'After copy' && readDoc(arg.copyPath).title === arg.expectTitle,
        'and the window stays on the original file')
    }
    quit()
  }

  if (step === 'template-direct') {
    const wc = await page()
    await setTitle(wc, 'From template')
    await sleep(3500)
    const tdStatus = await status(wc)
    ok(tdStatus === 'Draft', `a template opened directly is a new Draft (got ${tdStatus})`)
    quit()
  }

  if (step === 'import-replace') {
    const wc = await page()
    const winId = BrowserWindow.getAllWindows()[0].id
    const doc = JSON.parse(JSON.stringify(await js(wc, () => window.beeslides.doc)))
    doc.title = 'Imported'; doc.docId = 'imported-1'
    void js(wc, (t) => { void window.slidomingoDesktop.openAsDraft(t); return true }, JSON.stringify(doc)).catch(() => {})
    const imp = await page('window.beeslides && window.beeslides.doc && window.beeslides.doc.title === "Imported"')
    ok(!!imp, 'open-as-draft boots the imported deck')
    await sleep(3500)
    const wins = BrowserWindow.getAllWindows()
    ok(wins.length === 1 && wins[0].id === winId && docWcs().length === 1, `in place of the deck it came from (${wins.length} windows, ${docWcs().length} doc views)`)
    ok(await status(imp) === 'Draft', `as a Draft (got ${await status(imp)})`)
    quit()
  }

  if (step === 'replace') {
    const wc = await page()
    const win = BrowserWindow.getAllWindows()[0]
    win.setBounds({ x: 40, y: 40, width: 1234, height: 777 })
    const bounds = JSON.stringify(win.getBounds())
    const liveBefore = webContents.getAllWebContents().filter((w) => !w.isDestroyed()).length
    await setTitle(wc, 'Alpha2 pending')
    // not awaited: this page goes away
    void js(wc, (p) => { void window.slidomingoDesktop.openDocument(p); return true }, arg.other).catch(() => {})
    const next = await page('window.beeslides && window.beeslides.doc && window.beeslides.doc.title === "Beta2"')
    ok(!!next, 'the doc view now shows the other deck')
    ok(readDoc(arg.path).title === 'Alpha2 pending', 'the pending edit was flushed to disk first')
    await sleep(500)
    const wins = BrowserWindow.getAllWindows()
    ok(wins.length === 1 && wins[0].id === win.id, `still one window, the same one (${wins.length})`)
    ok(JSON.stringify(wins[0].getBounds()) === bounds, 'with the same bounds')
    ok(wc.isDestroyed(), 'the old doc view’s renderer is closed')
    const live = webContents.getAllWebContents().filter((w) => !w.isDestroyed()).length
    ok(docWcs().length === 1 && live === liveBefore, `one doc webContents, nothing leaked (${live} live, ${liveBefore} before)`)
    ok(!!await waitFor(() => js(next, () => /Beta2/.test(document.querySelector('.ed-toast')?.textContent ?? '')), 4000), 'it says “Opened Beta2”')
    ok(await status(next) === 'Saved', `the new deck is a bound file (got ${await status(next)})`)
    await setTitle(next, 'Beta2 edited')
    await sleep(3500)
    ok(readDoc(arg.other).title === 'Beta2 edited', 'and autosaves into its own file')
    ok(readDoc(arg.path).title === 'Alpha2 pending', 'never into the one it replaced')
    ok(globalThis.__dialogs.length === 0, 'without any dialog')
    quit()
  }

  if (step === 'new-window-and-already-open') {
    const a = await page()
    const aWin = BrowserWindow.getAllWindows()[0]
    await js(a, (p) => window.slidomingoDesktop.openDocument(p, { newWindow: true }), arg.other)
    const b = await page('window.beeslides && window.beeslides.doc && window.beeslides.doc.title === "Beta2 edited"')
    ok(!!b && BrowserWindow.getAllWindows().length === 2, `newWindow: true opens a second window (${BrowserWindow.getAllWindows().length})`)
    ok(!a.isDestroyed() && await js(a, () => window.beeslides.doc.title) === 'Alpha2 pending', 'the first keeps its deck')
    await js(b, (p) => window.slidomingoDesktop.openDocument(p), arg.path)
    await sleep(1500)
    ok(!b.isDestroyed() && await js(b, () => window.beeslides.doc.title) === 'Beta2 edited', 'opening a deck open elsewhere does not swap this window')
    ok(!a.isDestroyed() && BrowserWindow.getAllWindows().length === 2 && docWcs().length === 2, 'nor opens a third — it focuses the window that has it')
    ok(!aWin.isDestroyed(), 'that window is still there')
    quit()
  }

  if (step === 'startpage-replace') {
    const blank = await page('window.slidomingoDesktop && document.querySelector(".ed-startpick")')
    // not getAllWindows()[0]: the start page's thumbnail renderer is a hidden window too
    const docWins = () => BrowserWindow.getAllWindows().filter((w) => w.isFocusable())
    const win = docWins()[0]
    const reg = JSON.parse(readFileSync(join(app.getPath('userData'), 'draft-partitions.json'), 'utf8'))
    const [partition] = Object.entries(reg).find(([, p]) => !existsSync(p)) ?? []
    const partDir = partition && join(app.getPath('userData'), 'Partitions', partition.replace(/^persist:/, ''))
    void js(blank, (p) => { void window.slidomingoDesktop.openDocument(p); return true }, arg.path).catch(() => {})
    const wc = await page('window.beeslides && window.beeslides.doc && window.beeslides.doc.title === "Alpha2 pending"')
    ok(!!wc, 'a Recent tile from the start page opens the deck')
    ok(docWins().length === 1 && docWins()[0].id === win.id, `in the same window (${docWins().map((w) => w.id)} vs ${win.id})`)
    ok(!!partDir && !!await waitFor(async () => !existsSync(partDir), 5000), `the blank’s never-written draft partition is dropped (${partition})`)
    quit()
  }

  if (step === 'home') {
    const wc = await page()
    const docWins = () => BrowserWindow.getAllWindows().filter((w) => w.isFocusable())
    const win = docWins()[0]
    ok(await js(wc, () => !!document.querySelector('.ed-titlebar-quick .ed-btn') && !!window.slidomingoDesktop.goHome), 'the title bar has a home button')
    await setTitle(wc, 'Home edited')
    // not awaited: this page goes away
    void js(wc, () => { void window.slidomingoDesktop.goHome(); return true }).catch(() => {})
    const home = await page('window.slidomingoDesktop && document.querySelector(".ed-startpick")')
    ok(!!home, 'going home shows the start page')
    ok(readDoc(arg.path).title === 'Home edited', 'the pending edit was flushed to disk first')
    ok(docWins().length === 1 && docWins()[0].id === win.id, `in the same window (${docWins().map((w) => w.id)} vs ${win.id})`)
    ok(docWcs().length === 1 && wc.isDestroyed(), 'with one doc view, the deck’s renderer closed')
    const recent = await js(home, () => window.slidomingoDesktop.listRecent())
    ok(recent.some((r) => r.path === arg.path), 'the deck is in Recent')
    ok(!!await waitFor(() => js(home, (p) => [...document.querySelectorAll('.ed-sp-recent')].some((t) => t.title === p), arg.path), 6000), 'and on the start page')
    quit()
  }

  if (step === 'import-pptx') {
    const sp = await page('window.slidomingoDesktop && document.querySelector(".ed-startpick .ed-sp-tile")')
    const offer = await js(sp, () => ({
      tiles: [...document.querySelectorAll('.ed-sp-row .ed-sp-tile-name')].map((x) => x.textContent),
      imports: [...document.querySelector('.ed-sp-col.is-new .ed-sp-line').querySelectorAll('.ed-sp-btn')].map((x) => x.textContent),
    }))
    ok(JSON.stringify(offer.imports) === '["PowerPoint with AI…","From a file…"]' && !offer.tiles.some((x) => /…$/.test(x)),
      `New deck's Import line offers PowerPoint with AI… and From a file…, as buttons, not tiles (${JSON.stringify(offer)})`)
    const b64 = readFileSync(arg.pptx).toString('base64')
    const dragged = await js(sp, (b) => {
      const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'Dropped.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }))
      const ov = document.querySelector('.ed-startpick')
      ov.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }))
      const lit = ov.classList.contains('is-drop')
      const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      ov.dispatchEvent(drop)
      const busy = document.querySelector('.ed-sp-line .ed-sp-btn.is-busy')
      return { lit, prevented: drop.defaultPrevented, off: !ov.classList.contains('is-drop'), busy: busy?.textContent ?? null }
    }, b64)
    ok(dragged.lit && dragged.off, 'dragging a file over the page highlights it, dropping clears it')
    ok(dragged.busy === 'Importing…', `the From a file… button shows it is importing (${dragged.busy})`)
    ok(dragged.prevented, 'the drop is preventDefault()ed (the window never navigates to the file)')
    const wc = await page('window.beeslides && window.beeslides.doc && window.beeslides.doc.title === "Dropped Deck"')
    ok(!!wc, 'a dropped .pptx becomes the deck')
    ok(await js(wc, () => window.beeslides.doc.slides.length) === 2, 'with its slides')
    ok(!!await waitFor(() => js(wc, () => /Import report/.test(document.querySelector('.ed-about-overlay')?.textContent ?? '')), 4000), 'the import report is shown')
    await sleep(3500)
    ok(await status(wc) === 'Draft', `as a Draft (got ${await status(wc)})`)
    quit()
  }

  if (step === 'import-md') {
    const sp = await page('window.slidomingoDesktop && document.querySelector(".ed-startpick .ed-sp-tile")')
    void js(sp, () => {
      const dt = new DataTransfer()
      dt.items.add(new File(['# Dropped md\n\n## One\n\n![a figure](figs/plot.png)\n\n## Two\n\nText\n'], 'talk.md', { type: 'text/markdown' }))
      dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], 'plot.png', { type: 'image/png' }))
      document.querySelector('.ed-startpick').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      return true
    }).catch(() => {})
    const wc = await page('window.beeslides && window.beeslides.doc && document.querySelector(".ed-about-overlay")')
    const d = wc && await js(wc, () => ({
      n: window.beeslides.doc.slides.length,
      img: JSON.stringify(window.beeslides.doc).includes('data:image/png'),
      report: document.querySelector('.ed-about-overlay')?.textContent ?? '',
    }))
    ok(!!d && d.n >= 2, `a dropped .md becomes a deck with its slides (${d?.n})`)
    ok(!!d && d.img && !/image-unresolved|not found/i.test(d.report), `its figure, dropped alongside it, is embedded (${d?.report.slice(0, 200)})`)
    quit()
  }

  if (step === 'import-file') {
    // Import › From a file…: the same converters as a drop, from a pick
    const sp = await page('window.slidomingoDesktop && document.querySelector(".ed-startpick .ed-sp-tile")')
    await answerFilePick(sp, [arg.pptx])
    void clickLine(sp, 'Import', 'From a file…').catch(() => {})
    const wc = await page('window.beeslides && window.beeslides.doc && window.beeslides.doc.title === "Dropped Deck"')
    ok(!!wc, 'Import › From a file… turns a picked .pptx into the deck')
    ok(!!wc && await js(wc, () => window.beeslides.doc.slides.length) === 2, 'with its slides')
    ok(!!wc && !!await waitFor(() => js(wc, () => /Import report/.test(document.querySelector('.ed-about-overlay')?.textContent ?? '')), 4000), 'and the import report')
    quit()
  }

  if (step === 'layout-import') {
    // Layouts › From a file…: a PowerPoint's design becomes a layout file
    const sp = await page('window.slidomingoDesktop && document.querySelector(".ed-startpick .ed-sp-tile")')
    const before = readdirSync(arg.templatesDir)
    await answerFilePick(sp, [arg.potx])
    await clickLine(sp, 'Layouts', 'From a file…')
    // a PowerPoint shows what it holds first; Add layout takes all of it
    const add = await waitFor(() => js(sp, () => { const b = [...document.querySelectorAll('.ed-startpick-flowcard .ed-startpick-flow-actions .ed-startpick-btn')].pop(); return b && !b.disabled ? b.textContent : null }), 15000)
    ok(add === 'Add layout', `a .potx opens the structure step first (${add})`)
    await js(sp, () => { [...document.querySelectorAll('.ed-startpick-flowcard .ed-startpick-flow-actions .ed-startpick-btn')].pop().click() })
    const added = await waitFor(async () => readdirSync(arg.templatesDir).find((n) => !before.includes(n)) ?? null, 15000)
    ok(added === 'Brand.beeslides.html', `a .potx adds a layout file named after it (${added})`)
    const t = added && readDoc(join(arg.templatesDir, added))
    ok(!!t && t.template === true && t.layouts?.length >= 1 && t.slides.length === 1 && !!t.templateId,
      `a layout: template, its slide designs, one starter slide (${t && JSON.stringify({ template: t.template, layouts: t.layouts?.length, slides: t.slides.length, title: t.title })})`)
    const tile = await waitFor(() => js(sp, () => [...document.querySelectorAll('.ed-sp-row .ed-sp-tile-name')].some((x) => x.textContent === 'Brand')), 6000)
    ok(!!tile, 'its tile appears on the start page')
    ok(/Added layout “Brand”/.test(await js(sp, () => document.querySelector('.ed-sp-toast')?.textContent ?? '')), 'with a toast saying so')
    // a BeeSlides file goes in as a layout too, keeping its identity
    const before2 = readdirSync(arg.templatesDir)
    await answerFilePick(sp, [arg.html])
    await clickLine(sp, 'Layouts', 'From a file…')
    const added2 = await waitFor(async () => readdirSync(arg.templatesDir).find((n) => !before2.includes(n)) ?? null, 15000)
    const t2 = added2 && readDoc(join(arg.templatesDir, added2))
    ok(added2 === 'Kept Layout.beeslides.html' && t2?.template === true && t2.templateId === 'kept-id', `a BeeSlides file is added as a layout, keeping its templateId (${added2}, ${t2?.templateId})`)
    quit()
  }

  if (step === 'ai-import') {
    // PowerPoint with AI…: the request reaches the terminal panel's context
    // dir; a result written there previews live, and Use takes it. ($SHELL
    // is a stub for this step: no real claude runs.)
    const sp = await page('window.slidomingoDesktop && document.querySelector(".ed-startpick .ed-sp-tile")')
    const deck = arg.target === 'deck'
    const before = readdirSync(arg.templatesDir)
    await answerFilePick(sp, [arg.pptx])
    await clickLine(sp, deck ? 'Import' : 'Layouts', 'PowerPoint with AI…')
    const heading = await waitFor(() => js(sp, () => document.querySelector('.ed-startpick-flowcard h1')?.textContent ?? null), 15000)
    ok(heading === (deck ? 'Rebuilding your deck…' : 'Rebuilding your layout…'), `a flow card opens (${heading})`)
    const win = BrowserWindow.getAllWindows().find((w) => w.isFocusable())
    const ctx = join(app.getPath('userData'), 'claude-workspaces', `untitled-${win.id}`, `.slidomingo-context-${win.id}`)
    const req = await waitFor(async () => existsSync(join(ctx, 'generate-request.json')) && JSON.parse(readFileSync(join(ctx, 'generate-request.json'), 'utf8')), 15000)
    ok(req?.kind === 'pptx' && req.target === arg.target && req.source === 'source.pptx' && !('baseline' in req) && !('sourcePath' in req),
      `generate-request.json: kind pptx, target ${arg.target}, the file by its copy's name, no baseline inline (${JSON.stringify(req)})`)
    ok(existsSync(join(ctx, 'source.pptx')) && readFileSync(join(ctx, 'source.pptx')).equals(readFileSync(arg.pptx)), 'source.pptx is a copy of the picked file')
    const conv = existsSync(join(ctx, 'pptx-converted.json')) && JSON.parse(readFileSync(join(ctx, 'pptx-converted.json'), 'utf8'))
    ok(!!conv && Array.isArray(conv.doc?.slides) && !!conv.report && (deck || conv.doc.layouts?.length >= 1), `pptx-converted.json holds the converter's draft and report (${conv && conv.doc.slides.length} slides, ${conv && conv.doc.layouts?.length} layouts)`)
    const said = await waitFor(() => js(sp, () => { const t = document.querySelector('.ed-startpick-flow-hint')?.textContent ?? ''; return /terminal panel/.test(t) ? t : null }), 15000)
    ok(!!said, `it says Claude Code is on it (${said})`)
    const useLabel = deck ? 'Use this deck' : 'Save this layout'
    ok(await js(sp, (l) => { const b = document.querySelector('.ed-startpick-flow-actions .ed-startpick-btn'); return b.textContent === l && b.disabled }, useLabel), `"${useLabel}" waits for a result`)
    writeFileSync(join(ctx, 'generate-result.json'), JSON.stringify(arg.result))
    const film = await waitFor(() => js(sp, () => !document.querySelector('.ed-startpick-flow-actions .ed-startpick-btn').disabled && document.querySelectorAll('.ed-startpick-gen-film-item').length), 15000)
    ok(film >= 1, `the result previews live, and "${useLabel}" enables (${film} in the filmstrip)`)
    await sleep(300)
    await shot(sp, `ai-flow-${arg.target}`)
    void js(sp, () => { document.querySelector('.ed-startpick-flow-actions .ed-startpick-btn').click(); return true }).catch(() => {})
    if (deck) {
      const wc = await page(`window.beeslides && window.beeslides.doc && window.beeslides.doc.title === ${JSON.stringify(arg.result.title)}`)
      ok(!!wc && await js(wc, () => window.beeslides.doc.slides.length) === arg.result.slides.length, 'Use this deck opens it')
    } else {
      const added = await waitFor(async () => readdirSync(arg.templatesDir).find((n) => !before.includes(n)) ?? null, 15000)
      const t = added && readDoc(join(arg.templatesDir, added))
      ok(added === 'Rebuild.beeslides.html' && t?.template === true && t.layouts?.length === arg.result.layouts.length && t.slides.length === 1,
        `Save this layout writes a layout file (${added}, ${t && JSON.stringify({ layouts: t.layouts?.length, slides: t.slides.length })})`)
      const back = await waitFor(() => js(sp, () => !document.querySelector('.ed-startpick-flowcard') && [...document.querySelectorAll('.ed-sp-row .ed-sp-tile-name')].some((x) => x.textContent === 'Rebuild')), 6000)
      ok(!!back, 'and the start page is back, with its tile')
    }
    quit()
  }

  if (step === 'cancel') {
    const wc = await page()
    const dir = dirname(arg.path)
    const docWcId = wc.id
    dialog.showMessageBox = async (_w, o) => { globalThis.__dialogs.push((o ?? _w)?.message ?? 'box'); return { response: 2 } } // Cancel
    chmodSync(dir, 0o555)
    try {
      await setTitle(wc, 'Zeta unsaveable')
      await js(wc, (p) => window.slidomingoDesktop.openDocument(p), arg.other)
      ok(!!await waitFor(async () => globalThis.__dialogs.length > 0, 20000), `a failing flush asks (${JSON.stringify(globalThis.__dialogs)})`)
      await sleep(800)
      ok(!wc.isDestroyed() && wc.id === docWcId, 'Cancel keeps the same doc view')
      ok(await js(wc, () => window.beeslides.doc.title) === 'Zeta unsaveable', 'with the unsaved edit still in it')
      ok(docWcs().length === 1 && BrowserWindow.getAllWindows().length === 1, 'and opens nothing else')
    } finally {
      chmodSync(dir, 0o755)
    }
    dialog.showMessageBox = async (_w, o) => { globalThis.__dialogs.push((o ?? _w)?.message ?? 'box'); return { response: 1 } }
    quit()
  }

  if (step === 'templates') {
    const wc = await page()
    await js(wc, () => { window.confirm = () => true })
    // Save as template… (the Layout Manager's "Save as new template…" fires this)
    await js(wc, () => document.dispatchEvent(new CustomEvent('slidomingo:save-as-template')))
    await waitFor(() => js(wc, () => !!document.querySelector('dialog.ed-tmpldialog')))
    await js(wc, () => {
      const d = document.querySelector('dialog.ed-tmpldialog')
      d.querySelector('input[type=text]').value = 'House Style'
      d.querySelector('.ed-primary').click()
    })
    const tmplPath = join(arg.templatesDir, 'House Style.beeslides.html')
    ok(!!await waitFor(async () => existsSync(tmplPath), 5000), 'Save as layout writes into the templates folder')
    const t1 = readDoc(tmplPath)
    ok(t1.template === true && t1.templateSamples === false && t1.slides.length === 1 && !!t1.templateId, 'a design-only template: 1 starter slide, templateId minted')
    ok(await js(wc, () => window.beeslides.doc.basedOn?.templateId) === t1.templateId, 'the deck now records basedOn')
    // edit a slide type in the Layout Manager, then Update "House Style"
    await js(wc, () => {
      const d = JSON.parse(JSON.stringify(window.beeslides.doc))
      d.layouts = d.layouts?.length ? d.layouts : [{ id: 'ly-e2e', name: 'E2E', background: '#fff', transition: 'none', notes: '', elements: [] }]
      d.layouts[0].background = '#abcdef'
      window.beeslides.loadDoc(JSON.stringify(d))
      document.dispatchEvent(new CustomEvent('slidomingo:open-layout-manager', { detail: { tab: 'types', force: true } }))
    })
    ok(!!await waitFor(() => js(wc, () => document.querySelector('.ed-layoutmgr-scope')?.textContent === 'Changes apply to this deck')), 'the Layout Manager says edits apply to this deck')
    await js(wc, () => document.querySelector('.ed-tmplmenu > .ed-btn').click())
    const items = await waitFor(() => js(wc, () => {
      const labels = [...document.querySelectorAll('.ed-tmplmenu .ed-menu .ed-btn span')].map((x) => x.textContent)
      return labels.length >= 2 ? labels : null
    }))
    await shot(wc, 'layoutmgr-template-menu')
    ok(!!items && items[0] === 'Update “House Style”' && items.includes('Save as new layout…'), `the menu offers Update “House Style” (${JSON.stringify(items)})`)
    await js(wc, () => document.querySelector('.ed-tmplmenu .ed-menu .ed-btn').click())
    ok(!!await waitFor(async () => readDoc(tmplPath).layouts?.[0]?.background === '#abcdef', 5000), 'Update writes the slide type into the template')
    ok(readDoc(tmplPath).templateId === t1.templateId, 'keeping the template’s identity')
    ok(statSync(arg.other).mtimeMs === arg.otherMtime, 'another deck made from it is not touched')
    quit()
  }

  if (step === 'startpage') {
    const wc = await page('document.querySelector(".ed-sp-recent")')
    ok(!!wc, 'a fresh window shows the start page with Recent & drafts')
    const info = await js(wc, () => {
      const col = (k) => document.querySelector(`.ed-sp-col.${k}`)
      const [n, c] = [col('is-new'), col('is-continue')].map((el) => el.getBoundingClientRect())
      return {
        cols: [...document.querySelectorAll('.ed-sp-col')].filter((el) => el.offsetParent).map((el) => el.querySelector('.ed-sp-col-head').textContent),
        sideBySide: c.left >= n.right && Math.abs(c.top - n.top) < 2,
        subs: [...col('is-continue').querySelectorAll('.ed-sp-section-head h2')].filter((h) => h.offsetParent).map((h) => h.textContent),
        contFirst: col('is-continue').querySelector('.ed-sp-recent') === document.querySelector('.ed-sp-continue'),
        cont: document.querySelector('.ed-sp-continue .ed-sp-recent-name')?.textContent,
        drafts: document.querySelectorAll('.ed-sp-badge').length,
        tiles: [...document.querySelectorAll('.ed-sp-row .ed-sp-tile-name')].map((x) => x.textContent),
        lines: [...col('is-new').querySelectorAll('.ed-sp-line')].map((l) => [l.querySelector('.ed-sp-line-label'), ...l.querySelector('.ed-sp-line-items').children].map((x) => x.textContent)),
        foot: !!document.querySelector('.ed-sp-foot'),
        example: [...document.querySelectorAll('.ed-startpick button')].some((x) => /example|showcase/i.test(x.textContent)),
        size: [n.width, c.width, n.height, c.height],
        contScrolls: getComputedStyle(col('is-continue')).overflowY,
        contOverflow: col('is-continue').scrollHeight > col('is-continue').clientHeight,
      }
    })
    // Figure got its own third column (e3ee0ef3)
    ok(JSON.stringify(info.cols) === '["New deck","Continue","Figure"]' && info.sideBySide, `New deck | Continue | Figure, New deck and Continue side by side (${JSON.stringify(info)})`)
    ok(info.contFirst && info.subs.includes('Recent & drafts'), `Continue leads with the latest deck, then Recent & drafts (${JSON.stringify(info.subs)})`)
    ok(!!info.cont, `the latest deck is the big Continue tile (${info.cont})`)
    ok(info.drafts >= 1, `drafts carry a Draft badge (${info.drafts})`)
    ok(info.tiles[0] === 'Blank' && info.tiles.includes('House Style') && !info.tiles.some((x) => /…$/.test(x)), `New deck's tiles = Blank + templates, no actions (${JSON.stringify(info.tiles)})`)
    ok(JSON.stringify(info.lines[0]) === '["Import","PowerPoint with AI…","From a file…"]', `the Import line: PowerPoint with AI…, From a file… (${JSON.stringify(info.lines[0])})`)
    ok(JSON.stringify(info.lines[1]) === '["Layouts","PowerPoint with AI…","From a file…","＋ Create layout…","Layouts folder"]', `the Layouts line: the same two, Create layout…, Layouts folder (${JSON.stringify(info.lines[1])})`)
    ok(!info.foot && !info.example, 'no footer, no example deck')
    const [nw, cw, nh, ch] = info.size
    ok(Math.abs(nw - cw) <= 1 && Math.abs(nh - ch) <= 1, `the two cards are the same size (${JSON.stringify(info.size)})`)
    ok(info.contScrolls === 'auto', `Continue scrolls inside its card (overflow-y ${info.contScrolls}, overflowing: ${info.contOverflow})`)
    const imgs = await waitFor(() => js(wc, () => document.querySelectorAll('.ed-sp-thumb img').length >= 3 ? document.querySelectorAll('.ed-sp-thumb img').length : 0), 20000)
    ok(!!imgs, `tiles get first-page thumbnails (${imgs})`)
    await js(wc, () => { document.documentElement.dataset.theme = 'light' })
    await sleep(3000) // let the thumbnail queue finish
    await shot(wc, 'startpage-light')
    await js(wc, () => { document.documentElement.dataset.theme = 'dark' })
    await sleep(200)
    await shot(wc, 'startpage-dark')
    await js(wc, () => { document.documentElement.dataset.theme = 'light' })
    // a narrow window stacks the columns, Continue first
    const win = BrowserWindow.fromWebContents(wc) ?? BrowserWindow.getAllWindows().find((w) => w.isFocusable())
    const [w0, h0] = win.getContentSize()
    win.setContentSize(760, h0)
    const stacked = await waitFor(() => js(wc, () => {
      const [n, c] = ['is-new', 'is-continue'].map((k) => document.querySelector(`.ed-sp-col.${k}`).getBoundingClientRect())
      return innerWidth < 820 && c.bottom <= n.top ? innerWidth : null
    }), 4000)
    ok(!!stacked, `a narrow window stacks the columns, Continue on top (${stacked})`)
    await shot(wc, 'startpage-narrow')
    win.setContentSize(w0, h0)
    await sleep(300)
    // ⋯ opens the options panel; a plain click (below) starts the deck
    const houseTile = () => [...document.querySelectorAll('.ed-sp-row .ed-sp-tile')].find((b) => b.textContent.includes('House Style'))
    // The window is never shown (or focused) here, and Chromium matches
    // :focus / :focus-within only in a focused page — emulate page focus
    // for this check, as a shown, focused window would have.
    try { wc.debugger.attach('1.3') } catch { /* already attached */ }
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await js(wc, `() => (${houseTile})().parentElement.querySelector('.ed-sp-tile-opts').focus()`)
    const optsShown = await waitFor(() => js(wc, () => document.activeElement.classList.contains('ed-sp-tile-opts') && getComputedStyle(document.activeElement).opacity === '1'), 3000)
    ok(!!optsShown, `a template tile's ⋯ shows when focused (${await js(wc, () => [document.activeElement.className, getComputedStyle(document.activeElement).opacity])})`)
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
    try { wc.debugger.detach() } catch { /* not attached */ }
    await shot(wc, 'startpage-tile-opts')
    await js(wc, `() => (${houseTile})().parentElement.querySelector('.ed-sp-tile-opts').click()`)
    const film = await waitFor(() => js(wc, () => document.querySelectorAll('.ed-sp-panel:not([hidden]) .ed-sp-film-item').length))
    ok(film >= 1, `⋯ opens the template panel with its slide types (${film})`)
    ok(await js(wc, () => document.querySelector('.ed-sp-panel .ed-sp-kicker')?.textContent) === 'Layout options', 'headed "Layout options"')
    ok(!await js(wc, () => !!document.querySelector('.ed-sp-check')), 'a design-only template offers no sample slides')
    await shot(wc, 'startpage-panel')
    await js(wc, () => document.querySelector('.ed-sp-panel .ed-sp-x').click())
    ok(await js(wc, () => document.querySelector('.ed-sp-panel').hidden), '✕ closes it')
    void js(wc, `() => { (${houseTile})().click(); return true }`).catch(() => {})
    const ed = await page()
    const d = await js(ed, () => ({ n: window.beeslides.doc.slides.length, based: window.beeslides.doc.basedOn, title: window.beeslides.doc.title, bg: window.beeslides.doc.layouts?.[0]?.background }))
    ok(d.n === 1 && d.based?.name === 'House Style' && !!d.based?.templateId, `one click on the tile gives one slide, basedOn set (${JSON.stringify(d)})`)
    ok(d.title === 'Untitled' && d.bg === '#abcdef', 'titled Untitled, with the template’s (updated) slide types')
    quit()
  }

  if (step === 'default-template') {
    const sp = await page('window.slidomingoDesktop && [...document.querySelectorAll(".ed-sp-tile")].some((b) => b.textContent.includes("House Style"))')
    ok(!!sp, 'the start page lists the House Style template')
    await js(sp, () => [...document.querySelectorAll('.ed-sp-row .ed-sp-tile')].find((b) => b.textContent.includes('House Style')).parentElement.querySelector('.ed-sp-tile-opts').click())
    await waitFor(() => js(sp, () => !!document.querySelector('.ed-sp-panel:not([hidden]) .ed-sp-more')))
    await js(sp, () => document.querySelector('.ed-sp-panel .ed-sp-more > .ed-sp-btn').click())
    const menu = await js(sp, () => [...document.querySelectorAll('.ed-sp-panel .ed-sp-menu button')].map((b) => b.textContent))
    ok(menu.includes('Use as default'), `the panel's ⋯ menu offers "Use as default" (${JSON.stringify(menu)})`)
    await js(sp, () => [...document.querySelectorAll('.ed-sp-panel .ed-sp-menu button')].find((b) => b.textContent === 'Use as default').click())
    const first = await waitFor(() => js(sp, () => {
      const tile = document.querySelector('.ed-sp-row .ed-sp-tile')
      return tile?.classList.contains('is-default') ? tile.querySelector('.ed-sp-tile-name').textContent : null
    }), 5000)
    ok(first === 'DefaultHouse Style', `the default template's tile comes first, badged (${first})`)
    await js(sp, () => { document.documentElement.dataset.theme = 'light'; document.querySelector('.ed-sp-row').scrollIntoView({ block: 'center' }) })
    await shot(sp, 'startpage-default-light')
    await js(sp, () => { document.documentElement.dataset.theme = 'dark' })
    await sleep(200)
    await shot(sp, 'startpage-default-dark')
    // Enter with nothing focused: a deck from it
    await js(sp, () => { document.activeElement?.blur?.(); document.querySelector('.ed-startpick').focus() })
    void js(sp, () => { document.querySelector('.ed-startpick').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true }).catch(() => {})
    const ed = await page()
    const d = ed && await js(ed, () => ({ based: window.beeslides.doc.basedOn, n: window.beeslides.doc.slides.length }))
    ok(d?.based?.name === 'House Style' && !!d?.based?.templateId && d.n === 1, `Enter creates a deck from it (${JSON.stringify(d)})`)
    quit()
  }

  if (step === 'default-intent') {
    const { Menu } = await import('electron')
    await page('window.slidomingoDesktop && document.querySelector(".ed-startpick")') // the launch window
    const before = docWcs().map((w) => w.id)
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    const item = file.submenu.items.find((i) => i.label === 'New from Default Layout')
    ok(!!item && item.accelerator === 'Alt+CmdOrCtrl+N', 'File ▸ New from Default Layout (⌥⌘N)')
    item.click()
    const wc = await waitFor(async () => {
      for (const w of docWcs()) {
        if (before.includes(w.id) || w.isLoading()) continue
        if (await js(w, () => !!(window.beeslides && window.beeslides.doc && document.querySelector('.ed-root'))).catch(() => false)) return w
      }
      return null
    })
    ok(!!wc, 'it opens a new window straight into a deck')
    const d = wc && await js(wc, () => ({ based: window.beeslides.doc.basedOn, picker: !!document.querySelector('.ed-startpick') }))
    ok(d?.based?.name === 'House Style' && !d.picker, `from the default template, with no start page (${JSON.stringify(d)})`)
    ok(docWcs().length === 2, 'the first window keeps its start page')
    quit()
  }

  if (step === 'first-slide-type') {
    const sp = await page('window.slidomingoDesktop && [...document.querySelectorAll(".ed-sp-tile")].some((b) => b.textContent.includes("Two Types"))')
    await js(sp, () => [...document.querySelectorAll('.ed-sp-row .ed-sp-tile')].find((b) => b.textContent.includes('Two Types')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 })))
    const ctx = await js(sp, () => [...document.querySelectorAll('.ed-sp-ctx button')].map((b) => b.textContent))
    ok(ctx[0] === 'Options…' && ctx.includes('Use as default'), `a template's right-click menu: Options…, Edit template, default (${JSON.stringify(ctx)})`)
    await js(sp, () => document.querySelector('.ed-sp-ctx button').click())
    const items = await waitFor(() => js(sp, () => {
      const els = [...document.querySelectorAll('.ed-sp-panel:not([hidden]) .ed-sp-film-item')]
      return els.length ? els.map((e) => e.getAttribute('aria-pressed')) : null
    }))
    ok(JSON.stringify(items) === '["true","false"]', `the panel's slide types are selectable, the default pre-selected (${JSON.stringify(items)})`)
    await js(sp, () => document.querySelectorAll('.ed-sp-panel .ed-sp-film-item')[1].click())
    await shot(sp, 'startpage-panel-pick')
    void js(sp, () => { document.querySelector('.ed-sp-panel .ed-startpick-btn').click(); return true }).catch(() => {})
    const ed = await page()
    const lid = ed && await js(ed, () => window.beeslides.doc.slides.map((s) => s.layoutId))
    ok(JSON.stringify(lid) === '["ly-b"]', `the deck's slide is the picked slide type (${JSON.stringify(lid)})`)
    quit()
  }

  if (step === 'startpage-keys') {
    const wc = await page('document.querySelector(".ed-sp-continue") && document.activeElement?.classList.contains("ed-sp-recent")')
    ok(!!wc, 'a returning user lands with the Continue tile focused')
    const focused = () => js(wc, () => {
      const a = document.activeElement
      return a === document.querySelector('.ed-sp-continue') ? 'continue' : a?.classList.contains('ed-sp-search') ? 'search'
        : (a?.querySelector?.('.ed-sp-recent-name, .ed-sp-tile-name')?.textContent ?? a?.tagName ?? null)
    })
    const key = (k, o = {}) => js(wc, ([k, o]) => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o })) }, [k, o])
    await key('ArrowRight')
    const right = await focused()
    ok(right && right !== 'continue', `→ moves to the next tile (${right})`)
    await key('ArrowLeft')
    ok(await focused() === 'continue', '← comes back')
    await key('ArrowDown')
    const below = await js(wc, () => {
      const c = document.querySelector('.ed-sp-continue').getBoundingClientRect()
      const a = document.activeElement.getBoundingClientRect()
      return a.top >= c.bottom - 2 && document.activeElement !== document.querySelector('.ed-sp-continue')
    })
    ok(below, '↓ jumps to a tile in the row below')
    await shot(wc, 'startpage-keys')
    // trusted typing: the letter lands in the search box and filters
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'B' })
    wc.sendInputEvent({ type: 'char', keyCode: 'b' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'B' })
    for (const ch of 'eta2') { wc.sendInputEvent({ type: 'keyDown', keyCode: ch.toUpperCase() }); wc.sendInputEvent({ type: 'char', keyCode: ch }); wc.sendInputEvent({ type: 'keyUp', keyCode: ch.toUpperCase() }) }
    await sleep(300)
    const typed = await js(wc, () => ({ q: document.querySelector('.ed-sp-search').value, active: document.activeElement === document.querySelector('.ed-sp-search') }))
    ok(typed.active && typed.q === 'beta2', `typing a letter focuses the search and types into it (${JSON.stringify(typed)})`)
    const shown = await js(wc, () => [...document.querySelectorAll('.ed-sp-recent, .ed-sp-tile')].filter((t) => t.offsetParent).map((t) => t.querySelector('.ed-sp-recent-name, .ed-sp-tile-name').textContent))
    ok(shown.length >= 1 && shown.every((n) => /beta2/i.test(n)), `and filters recents and templates to the matches (${JSON.stringify(shown)})`)
    await key('Escape')
    const cleared = await js(wc, () => ({ q: document.querySelector('.ed-sp-search').value, n: [...document.querySelectorAll('.ed-sp-recent, .ed-sp-tile')].filter((t) => t.offsetParent).length }))
    ok(cleared.q === '' && cleared.n > shown.length, `Escape clears the search (${JSON.stringify(cleared)})`)
    await js(wc, () => document.querySelector('.ed-startpick').focus())
    await key('f', { metaKey: true })
    ok(await focused() === 'search', '⌘F focuses the search')
    // Escape order: context menu first, then the template panel
    await js(wc, () => [...document.querySelectorAll('.ed-sp-row .ed-sp-tile')].find((b) => b.textContent.includes('Tmpl')).parentElement.querySelector('.ed-sp-tile-opts').click())
    await waitFor(() => js(wc, () => !!document.querySelector('.ed-sp-panel:not([hidden]) .ed-startpick-btn')))
    await js(wc, () => document.querySelector('.ed-sp-recent').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })))
    await key('Escape')
    const esc1 = await js(wc, () => ({ ctx: !!document.querySelector('.ed-sp-ctx'), panel: !document.querySelector('.ed-sp-panel').hidden }))
    ok(!esc1.ctx && esc1.panel, `Escape closes the context menu first, the panel stays (${JSON.stringify(esc1)})`)
    await key('Escape')
    ok(await js(wc, () => document.querySelector('.ed-sp-panel').hidden), 'the next Escape closes the template panel')
    await js(wc, () => [...document.querySelectorAll('.ed-sp-line button')].find((b) => b.textContent.includes('Create layout')).click())
    ok(await js(wc, () => !!document.querySelector('.ed-startpick-flowcard')), 'the Layouts line\'s Create layout… opens the create flow')
    await key('Escape')
    ok(await js(wc, () => !document.querySelector('.ed-startpick-flowcard') && document.querySelector('.ed-sp-page').style.display !== 'none'), 'Escape leaves the create flow')
    quit()
  }

  if (step === 'pin') {
    const wc = await page('document.querySelector(".ed-sp-continue")')
    const target = arg.path
    await js(wc, (p) => [...document.querySelectorAll('.ed-sp-recent')].find((t) => t.title === p).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 })), target)
    const items = await js(wc, () => [...document.querySelectorAll('.ed-sp-ctx button')].map((b) => b.textContent))
    ok(items[0] === 'Pin', `a Recent tile's menu offers Pin (${JSON.stringify(items)})`)
    await js(wc, () => [...document.querySelectorAll('.ed-sp-ctx button')].find((b) => b.textContent === 'Pin').click())
    const row = await waitFor(() => js(wc, (p) => {
      const heads = [...document.querySelectorAll('.ed-sp-section-head h2')].filter((h) => h.offsetParent).map((h) => h.textContent)
      const pinned = [...document.querySelectorAll('.ed-sp-section')].find((sec) => sec.querySelector('h2').textContent === 'Pinned')
      return heads[0] === 'Pinned' && [...pinned.querySelectorAll('.ed-sp-recent')].some((t) => t.title === p) ? heads : null
    }, target), 4000)
    ok(!!row && row[1] === 'Recent & drafts', `a "Pinned" row in Continue, above Recent & drafts, shows it (${JSON.stringify(row)})`)
    // 25 newer opens
    for (const f of arg.fillers) await js(wc, (p) => window.slidomingoDesktop.recordRecent(p), f)
    await sleep(500)
    quit()
  }

  if (step === 'pin-check') {
    const wc = await page('document.querySelector(".ed-sp-recent")')
    const r = await waitFor(() => js(wc, (p) => {
      const pinned = [...document.querySelectorAll('.ed-sp-section')].find((sec) => sec.querySelector('h2').textContent === 'Pinned')
      return pinned && pinned.offsetParent && [...pinned.querySelectorAll('.ed-sp-recent')].some((t) => t.title === p) ? true : null
    }, arg.path), 6000)
    ok(!!r, 'after a relaunch and 25 newer opens, the pinned deck is still in its row')
    await shot(wc, 'startpage-pinned-light')
    await js(wc, () => { document.documentElement.dataset.theme = 'dark' })
    await sleep(200)
    await shot(wc, 'startpage-pinned-dark')
    quit()
  }

  if (step === 'welcome') {
    const wc = await page('document.querySelector(".ed-sp-empty:not([hidden])")')
    ok(!!wc, 'a first launch shows the welcome in the Continue card')
    const w = wc && await js(wc, () => {
      const r = (k) => document.querySelector(`.ed-sp-col.${k}`).getBoundingClientRect()
      const [n, c] = [r('is-new'), r('is-continue')]
      const empty = document.querySelector('.ed-sp-empty')
      return {
        title: empty.querySelector('h3')?.textContent,
        open: [...empty.querySelectorAll('.ed-sp-btn')].map((b) => b.textContent),
        inContinue: !!empty.closest('.ed-sp-col.is-continue') && !!document.querySelector('.ed-sp-col.is-continue').offsetParent,
        focused: document.activeElement?.classList.contains('ed-sp-tile') ? document.activeElement.querySelector('.ed-sp-tile-name').textContent : null,
        size: [n.width, c.width, n.height, c.height].map(Math.round),
        same: Math.abs(n.width - c.width) <= 1 && Math.abs(n.height - c.height) <= 1,
        sideBySide: c.left >= n.right,
      }
    })
    ok(w?.inContinue && w.title === 'Welcome to BeeSlides' && JSON.stringify(w.open) === '["Open…"]', `the Continue card is there, with the welcome and Open… (${JSON.stringify(w)})`)
    ok(w?.same && w.sideBySide, `New deck | Continue side by side, the same size (${JSON.stringify(w?.size)})`)
    ok(w?.focused === 'Blank', `the first New deck tile is focused (${w?.focused})`)
    await js(wc, () => { document.documentElement.dataset.theme = 'light' })
    await shot(wc, 'welcome-light')
    await js(wc, () => { document.documentElement.dataset.theme = 'dark' })
    await sleep(200)
    await shot(wc, 'welcome-dark')
    quit()
  }

  if (step === 'big') {
    const wc = await page()
    const t0 = Date.now()
    await setTitle(wc, 'Big edited')
    const done = await waitFor(async () => { try { return readDoc(arg.path).title === 'Big edited' } catch { return false } }, 60000)
    ok(!!done, `the big deck autosaved (${Date.now() - t0}ms from edit to disk, incl. the 2.5s debounce)`)
    const ser = await js(wc, async () => { const t = performance.now(); await window.beeslides.serialize(); return Math.round(performance.now() - t) })
    try { console.log(`        serializeFile on this deck: ${ser}ms`) } catch { /* */ }
    quit()
  }
}

// =================================================================================
// ORCHESTRATOR (plain node)
// =================================================================================
async function orchestrator() {
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron')
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const shell = readFileSync(SHELL_PATH, 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-'))
  const userData = join(root, 'userData')
  const templatesDir = join(root, 'templates')
  const work = join(root, 'work')
  for (const d of [userData, templatesDir, work]) mkdirSync(d, { recursive: true })
  const draftsDir = join(userData, 'Drafts')
  const draftFiles = () => (existsSync(draftsDir) ? readdirSync(draftsDir).filter((n) => n.endsWith('.beeslides.html')) : [])

  const deckHtml = (doc) => shell.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`)
  const readDoc = (p) => JSON.parse(readFileSync(p, 'utf8').match(BLOCK_RE)[2].trim())
  function fixture(name, title, extra = {}) {
    const doc = Object.assign(newDoc(), { title }, extra)
    const p = join(work, name)
    writeFileSync(p, deckHtml(doc))
    return p
  }

  function run(step, { open, arg = {}, env = {} } = {}) {
    console.log(`\n# ${step}`)
    const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), ...(open ? ['--open', open] : [])], {
      cwd: desktopDir,
      env: {
        ...process.env, E2E_STEP: step, E2E_ARG: JSON.stringify(arg),
        SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: templatesDir,
        ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '', ...env,
      },
      encoding: 'utf8', timeout: 120000,
    })
    const out = res.stdout ?? ''
    for (const line of out.split('\n')) if (/^\s+(ok|FAIL)\s|^\s{8}\S/.test(line)) console.log(line)
    const m = out.match(/E2E_RESULT (\d+) (\d+)/)
    if (!m) { checks++; failures++; console.log(`  FAIL  step ${step} produced no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); return }
    checks += Number(m[1]); failures += Number(m[2])
  }

  /** Import › From a file…, Layouts › From a file…, and PowerPoint with AI…
   *  both ways. Self-contained (its own fixtures), so E2E_ONLY=imports runs
   *  just these. */
  async function importSteps() {
    const { buildPptx, slide: pSlide, sp: pSp, xfrm } = await import(join(repo, 'scripts/test-convert/_fixtures.ts'))
    const box = (id, text) => pSp(id, 'Box', `<p:spPr>${xfrm(914400, 914400, 2743200, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>${text}</a:t></a:r></a:p></p:txBody>`)
    const slides = [{ xml: pSlide(box(2, 'One')) }, { xml: pSlide(box(2, 'Two')) }]
    const core = '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Dropped Deck</dc:title></cp:coreProperties>'
    const pptx = join(work, 'Picked.pptx')
    writeFileSync(pptx, await buildPptx({ chain: false, core, slides }))
    const typeLayout = (id, name, bg) => ({ id, name, background: bg, transition: 'none', notes: '', elements: [] })
    run('import-file', { arg: { pptx } })
    // with the master → layout chain, so there are slide designs to take
    const chained = await buildPptx({ slides: [{ xml: pSlide(box(2, 'One')) }, { xml: pSlide(box(2, 'Two')) }] })
    const potx = join(work, 'Brand.potx')
    writeFileSync(potx, chained)
    const keptHtml = join(work, 'Kept Layout.beeslides.html')
    writeFileSync(keptHtml, deckHtml(Object.assign(newDoc(), { title: 'Kept', template: true, templateId: 'kept-id', docId: undefined })))
    run('layout-import', { arg: { templatesDir, potx, html: keptHtml } })
    // PowerPoint with AI…, both ways, against a stub shell (no real claude) and
    // a throwaway HOME (claudeTrust.ts would otherwise write ~/.claude.json)
    const fakeHome = join(root, 'home')
    mkdirSync(fakeHome, { recursive: true })
    const fakeShell = join(root, 'fake-shell')
    writeFileSync(fakeShell, '#!/bin/sh\n[ "$2" = env ] && exec /usr/bin/env\nexec sleep 300\n', { mode: 0o755 })
    const rebuild = join(work, 'Rebuild.pptx')
    writeFileSync(rebuild, chained)
    const aiDeck = Object.assign(newDoc(), { title: 'AI Deck' })
    aiDeck.slides = [aiDeck.slides[0], { ...aiDeck.slides[0], id: 'ai-2' }]
    const aiLayout = Object.assign(newDoc(), { title: 'AI Layout', layouts: [typeLayout('ai-a', 'Title', '#123456'), typeLayout('ai-b', 'Content', '#ffffff')], defaultLayoutId: 'ai-a' })
    const aiEnv = { SHELL: fakeShell, HOME: fakeHome }
    run('ai-import', { arg: { target: 'deck', pptx: rebuild, templatesDir, result: aiDeck }, env: aiEnv })
    run('ai-import', { arg: { target: 'layout', pptx: rebuild, templatesDir, result: aiLayout }, env: aiEnv })
  }

  if (process.env.E2E_ONLY === 'imports') {
    await importSteps()
    console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
    if (failures) process.exit(1)
    return
  }

  run('welcome')

  const alpha = fixture('Alpha.beeslides.html', 'Alpha')
  run('open-edit-close', { open: alpha, arg: { path: alpha } })
  const backups = existsSync(join(userData, 'Backups'))
    ? readdirSync(join(userData, 'Backups')).flatMap((d) => readdirSync(join(userData, 'Backups', d)).filter((n) => n.endsWith('.html')))
    : []
  ok(backups.length === 1, `the first write of the session kept a backup of the old bytes (${backups.length})`)

  // --- a saved deck is an EDITABLE file (DECISIONS 2026-10-09; the viewer-only shell is File ▸ Export)
  {
    const saved = readFileSync(alpha, 'utf8')
    ok(rtOf(saved) === rtOf(shell), 'a saved deck carries the EDITOR runtime')
    ok(/data-beeslides-preview/.test(saved) && /id="beeslides-static"/.test(saved), 'with its first-page preview and static layer')
    run('reopen-edited', { open: alpha, arg: { path: alpha } })
  }

  const gated = fixture('Gated.beeslides.html', 'Gated', { requires: ['x-from-the-future'], futureField: { kept: true } })
  const gatedBytes = readFileSync(gated, 'utf8')
  const templatesBefore = readdirSync(templatesDir).join('|')
  run('gated', { open: gated, arg: { path: gated, copyPath: join(work, 'Gated copy.beeslides.html') } })
  ok(readFileSync(gated, 'utf8') === gatedBytes, 'the newer-format file is byte-identical after the session')
  ok(readdirSync(templatesDir).join('|') === templatesBefore, 'and no template was written from it')

  // --- the asset store, through the real app
  const b64 = (p, mime) => `data:${mime};base64,` + readFileSync(join(repo, p)).toString('base64')
  const pics = {
    photo: b64('scripts/gallery-photos/thumbs/fairwide.jpg', 'image/jpeg'),
    bg: b64('scripts/gallery-photos/thumbs/stars.jpg', 'image/jpeg'),
    poster: b64('scripts/gallery-media/earth-poster.jpg', 'image/jpeg'),
  }
  const clip = b64('scripts/gallery-media/earth.mp4', 'video/mp4')
  const img = (id, src) => ({ id, type: 'image', src, fit: 'cover', radius: 0, x: 0, y: 0, w: 640, h: 360, rotation: 0, opacity: 1 })
  const picDoc = Object.assign(newDoc(), { title: 'Pictures', assets: { ...pics } })
  picDoc.slides[0].elements = [img('bg1', 'asset:bg'), img('p1', 'asset:photo')]
  picDoc.slides.push({ ...picDoc.slides[0], id: 'pics-2', elements: [img('bg1', 'asset:bg'), { id: 'v1', type: 'media', kind: 'video', src: clip, poster: 'asset:poster', fit: 'contain', x: 0, y: 0, w: 640, h: 360, rotation: 0, opacity: 1 }] })
  const pictures = join(work, 'Pictures.beeslides.html')
  writeFileSync(pictures, deckHtml(picDoc))
  const once = (html) => [...Object.values(pics), clip].every((u) => html.split(u.slice(3000, 3200)).length === 2)
  run('store-roundtrip', { open: pictures, arg: { path: pictures, assets: pics, title: 'Pictures edited' } })
  const stored = readFileSync(pictures, 'utf8')
  ok(/id="beeslides-assets"/.test(stored) && readDoc(pictures).requires?.includes('asset-store'), 'the autosave wrote an asset store and declared it')
  ok(once(stored), 'every picture and the video are in the file exactly once')
  ok(!JSON.stringify(readDoc(pictures)).includes(pics.photo.slice(3000, 3200)), 'the JSON refers to them instead of carrying them')
  run('store-roundtrip', { open: pictures, arg: { path: pictures, assets: pics, title: 'Pictures reopened' } })
  ok(once(readFileSync(pictures, 'utf8')), 'reopened and re-saved: still exactly once')

  // an uncompressed-ish PNG (zlib level 1, filter None): plenty to optimize
  const { deflateSync } = await import('node:zlib')
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const pngChunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
  const W = 240, H = 160, rows = []
  for (let y = 0; y < H; y++) { const r = Buffer.alloc(1 + W * 3); for (let x = 0; x < W; x++) { r[1 + x * 3] = x; r[2 + x * 3] = y; r[3 + x * 3] = (x * y) & 255 } rows.push(r) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 1 })), pngChunk('IEND', Buffer.alloc(0))])
  const optDoc = Object.assign(newDoc(), { title: 'Optimize me', assets: { ...pics, grad: 'data:image/png;base64,' + png.toString('base64') } })
  optDoc.slides[0].elements = [img('o1', 'asset:photo'), img('o2', 'asset:grad')]
  const optPath = join(work, 'Optimize.beeslides.html')
  writeFileSync(optPath, deckHtml(optDoc))
  run('optimize', { open: optPath })

  const beta = fixture('Beta.beeslides.html', 'Beta')
  run('quit-pending', { open: beta })
  ok(readDoc(beta).title === 'Beta quitting', 'quitting flushed the pending edit')

  const gamma = fixture('Gamma.beeslides.html', 'Gamma')
  run('external', { open: gamma, arg: { path: gamma } })

  run('blank-untouched')
  ok(draftFiles().length === 0, 'an untouched blank window leaves no draft behind')

  run('blank-edit')
  ok(draftFiles().length === 1, 'an edited blank is kept as a draft')

  const saveTarget = join(work, 'Saved Draft.beeslides.html')
  run('draft-reopen-saveas', { arg: { savePath: saveTarget } })
  const reg = existsSync(join(userData, 'draft-partitions.json')) ? JSON.parse(readFileSync(join(userData, 'draft-partitions.json'), 'utf8')) : {}
  const orphans = Object.entries(reg).filter(([, p]) => !existsSync(p))
  const orphanDirs = orphans.filter(([k]) => existsSync(join(userData, 'Partitions', k.replace(/^persist:/, ''))))
  ok(orphanDirs.length <= 1, `never-written draft partitions are cleaned up (${orphanDirs.length} left, ≤1 = the one from this last run, swept next launch)`)

  const titleCase = (name, extra) => run('title-saveas', { arg: { savePath: join(work, `${name}.beeslides.html`), ...extra } })
  titleCase('Q3 Review', { offered: 'Untitled.beeslides.html', expectTitle: 'Q3 Review', copyPath: join(work, 'Q3 Copy.beeslides.html') })
  titleCase('My Talk & Notes', { title: 'My Talk & Notes', offered: 'My Talk & Notes.beeslides.html', expectTitle: 'My Talk & Notes' })
  titleCase('pitch-v2', { title: 'Pitch', offered: 'Pitch.beeslides.html', expectTitle: 'Pitch', expectFile: 'pitch-v2.beeslides.html' })
  titleCase('ab c', { title: 'a/b: c?', offered: 'ab c.beeslides.html', expectTitle: 'a/b: c?', expectFile: 'ab c.beeslides.html' })

  const tmplPath = join(templatesDir, 'Tmpl.beeslides.html')
  writeFileSync(tmplPath, deckHtml(Object.assign(newDoc(), { title: 'Tmpl', template: true, docId: undefined })))
  const tmplBefore = readFileSync(tmplPath, 'utf8')
  run('template-direct', { open: tmplPath })
  ok(readFileSync(tmplPath, 'utf8') === tmplBefore, 'the template file itself is untouched')
  ok(draftFiles().some((n) => readDoc(join(draftsDir, n)).title === 'From template'), 'its edits went to a draft')

  const delta = fixture('Delta.beeslides.html', 'Delta')
  const deltaBefore = statSync(delta).mtimeMs
  run('import-replace', { open: delta })
  ok(statSync(delta).mtimeMs === deltaBefore, 'the original file is untouched by the import')
  ok(draftFiles().some((n) => readDoc(join(draftsDir, n)).title === 'Imported'), 'a seeded draft is written even without an edit')

  const alpha2 = fixture('Alpha2.beeslides.html', 'Alpha2')
  const beta2 = fixture('Beta2.beeslides.html', 'Beta2')
  run('replace', { open: alpha2, arg: { path: alpha2, other: beta2 } })
  run('new-window-and-already-open', { open: alpha2, arg: { path: alpha2, other: beta2 } })
  run('startpage-replace', { arg: { path: alpha2 } })

  const eta = fixture('Eta.beeslides.html', 'Eta')
  run('home', { open: eta, arg: { path: eta } })

  const { buildPptx, slide: pSlide, sp: pSp, xfrm } = await import(join(repo, 'scripts/test-convert/_fixtures.ts'))
  const box = (id, text) => pSp(id, 'Box', `<p:spPr>${xfrm(914400, 914400, 2743200, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>${text}</a:t></a:r></a:p></p:txBody>`)
  const pptx = join(work, 'Dropped.pptx')
  writeFileSync(pptx, await buildPptx({
    chain: false,
    core: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Dropped Deck</dc:title></cp:coreProperties>',
    slides: [{ xml: pSlide(box(2, 'One')) }, { xml: pSlide(box(2, 'Two')) }],
  }))
  run('import-pptx', { arg: { pptx } })
  ok(draftFiles().some((n) => { const d = readDoc(join(draftsDir, n)); return d.title === 'Dropped Deck' && d.slides.length === 2 }), 'the imported deck was written as a draft without an edit')

  run('import-md')

  mkdirSync(join(work, 'locked'), { recursive: true })
  const zeta = join(work, 'locked', 'Zeta.beeslides.html')
  writeFileSync(zeta, deckHtml(Object.assign(newDoc(), { title: 'Zeta' })))
  run('cancel', { open: zeta, arg: { path: zeta, other: beta2 } })
  ok(readDoc(zeta).title === 'Zeta unsaveable', 'once writable again, quitting saved the kept edit')

  const epsilon = fixture('Epsilon.beeslides.html', 'Epsilon')
  const other = fixture('Other.beeslides.html', 'Other', { basedOn: { name: 'House Style' } })
  run('templates', { open: epsilon, arg: { templatesDir, other, otherMtime: statSync(other).mtimeMs } })

  run('startpage')
  run('startpage-keys')
  const fillers = Array.from({ length: 25 }, (_, i) => fixture(`Filler ${i}.beeslides.html`, `Filler ${i}`))
  run('pin', { arg: { path: alpha2, fillers } })
  const rec = JSON.parse(readFileSync(join(userData, 'recent-files.json'), 'utf8'))
  ok(rec.filter((e) => !e.pinned).length === 20 && rec.some((e) => e.path === alpha2 && e.pinned), `Recent keeps 20 unpinned + the pinned one (${rec.length})`)
  run('pin-check', { arg: { path: alpha2 } })
  run('default-template')
  const settings = JSON.parse(readFileSync(join(userData, 'app-settings.json'), 'utf8'))
  ok(settings.defaultTemplate?.path === join(templatesDir, 'House Style.beeslides.html') && !!settings.defaultTemplate.templateId,
    `the default is stored in main's app settings, by templateId and path (${JSON.stringify(settings)})`)
  run('default-intent')
  const typeLayout = (id, name, bg) => ({ id, name, background: bg, transition: 'none', notes: '', elements: [] })
  writeFileSync(join(templatesDir, 'Two Types.beeslides.html'), deckHtml(Object.assign(newDoc(), {
    title: 'x', template: true, templateId: 'tt-1', templateSamples: false, docId: undefined,
    layouts: [typeLayout('ly-a', 'A', '#fff'), typeLayout('ly-b', 'B', '#000')], defaultLayoutId: 'ly-a',
  })))
  run('first-slide-type')

  await importSteps()

  if (process.env.E2E_BIG_DECK) {
    const big = join(work, 'Big.beeslides.html')
    let html = readFileSync(process.env.E2E_BIG_DECK, 'utf8')
    html = html.replace(BLOCK_RE, (_m, a, b, c) => {
      const d = JSON.parse(b.trim()); delete d.template; d.docId = d.docId || 'e2e-big-deck'
      return `${a}\n${JSON.stringify(d).replace(/</g, '\\u003c')}\n${c}`
    })
    writeFileSync(big, html)
    const rt = (h) => h.match(/id="beeslides-rt"[^>]*>([\s\S]{0,400})/)?.[1]
    const oldRt = rt(html)
    run('big', { open: big, arg: { path: big } })
    const after = readFileSync(big, 'utf8')
    ok(/data-beeslides-preview/.test(after), 'the old-build deck gained a fresh first-page preview')
    const current = shell
    ok(rt(after) === rt(current), `it now carries the current build's runtime (it had ${oldRt === rt(current) ? 'the same' : 'an older'} one)`)
  }

  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
