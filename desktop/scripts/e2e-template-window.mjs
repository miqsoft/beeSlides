#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Desktop template-window E2E (docs/DECISIONS.md 2026-09-28): a template
// file edited in its own window, bound to the file.
//
//   cd desktop && npx electron-vite build && node scripts/e2e-template-window.mjs
//   (needs slides/dist-single built; E2E_SHOW=1 shows the windows,
//   E2E_SHOTS=<dir> saves screenshots of the template window's UI)
//
// Same two-mode shape as e2e-autosave.mjs (see its header for why not
// playwright-core's _electron.launch): run with node it ORCHESTRATES — a
// throwaway profile and templates folder, one Electron launch per step, disk
// checks after each — and run by Electron it DRIVES the real built main
// process from inside, with native dialogs stubbed.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repo = resolve(desktopDir, '..')
const SHELL_PATH = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
const BLOCK_RE = /(<script[^>]*\bid=["']beeslides-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readDoc = (p) => JSON.parse(readFileSync(p, 'utf8').match(BLOCK_RE)[2].trim())

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) failures++
  try { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) } catch { /* pipe gone */ }
}

// No top-level await in Electron mode (an ESM entry that awaits holds `ready`).
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
  const { app, dialog, BrowserWindow, Menu, webContents, ipcMain } = await import('electron')
  const step = process.env.E2E_STEP
  const arg = JSON.parse(process.env.E2E_ARG || '{}')
  globalThis.__dialogs = []
  dialog.showMessageBox = async (_w, o) => { globalThis.__dialogs.push((o ?? _w)?.message ?? 'box'); return { response: 1 } }
  dialog.showSaveDialog = async () => ({ canceled: true })
  if (process.env.E2E_SHOTS) {
    // an invisible window counts as occluded and stops producing frames
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    app.commandLine.appendSwitch('disable-renderer-backgrounding')
  }
  if (!process.env.E2E_SHOW) {
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
  // document windows only: the start page's thumbnails render in hidden
  // BrowserWindows of their own (thumbs.ts), which come and go
  const docWindows = () => docWcs().length
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
  /** fire-and-forget: the page may be replaced before it could answer */
  const jsGo = (wc, fn, a) => { void js(wc, fn, a).catch(() => {}) }
  async function page(pred, ms) {
    return waitFor(async () => {
      for (const wc of docWcs()) {
        if (wc.isLoading()) continue
        if (await wc.executeJavaScript(`!!(${pred})`).catch(() => false)) return wc
      }
      return null
    }, ms)
  }
  const TEMPLATE_WINDOW = 'window.beeslides && window.beeslides.doc && document.querySelector(".ed-layoutmgr-overlay") && / — Layout$/.test(document.title)'
  const START_PAGE = 'window.slidomingoDesktop && document.querySelector(".ed-startpick .ed-sp-row")'
  /** Change the doc through the scripting API (an ordinary undoable edit). */
  const edit = (wc, fn) => js(wc, `(() => {
    const d = JSON.parse(JSON.stringify(window.beeslides.doc)); (${fn})(d)
    window.beeslides.loadDoc(JSON.stringify(d))
  })`)
  const menuItem = (label) => Menu.getApplicationMenu().items.find((i) => i.label === 'File').submenu.items.find((i) => i.label === label)
  async function shot(wc, name) {
    if (!process.env.E2E_SHOTS) return
    try {
      await waitFor(() => wc.executeJavaScript('!document.getElementById("beeslides-splash")'), 5000)
      wc.invalidate()
      await sleep(500)
      writeFileSync(join(process.env.E2E_SHOTS, `${name}.png`), (await wc.capturePage()).toPNG())
    } catch { /* best effort */ }
  }
  function report() { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const quit = () => { report(); clearTimeout(hardStop); app.quit() }

  const CHOOSER = 'document.querySelector(".ed-startpick-flowcard .ed-startpick-choice")'
  /** Click a chooser option by its name. */
  const choose = (wc, name) => js(wc, (n) => [...document.querySelectorAll('.ed-startpick-choice')].find((b) => b.querySelector('.ed-startpick-choice-name').textContent === n).click(), name)
  /** The next <input type=file> click picks `file` ({name, b64}) instead of
   *  opening the native dialog. */
  const stubFilePick = (wc, file) => js(wc, (f) => {
    const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))
    const click = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return click.call(this)
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], f.name))
      this.files = dt.files
      this.dispatchEvent(new Event('change'))
    }
  }, file)
  /** File ▸ New Layout… → the chooser, in a new window. */
  async function openChooser() {
    ok(!!await page(START_PAGE), 'a cold launch shows the start page')
    ok(!!menuItem('New Layout…'), 'File ▸ New Layout… exists')
    menuItem('New Layout…').click()
    const wc = await page(CHOOSER)
    ok(!!wc, 'File ▸ New Layout… opens the Create layout chooser')
    return wc
  }

  if (step === 'new-template') {
    const chooser = await openChooser()
    ok(await js(chooser, () => document.querySelector('.ed-sp-page').style.display === 'none'), 'over the start page')
    // Back lands on the start page; its "＋ Create layout…" opens the chooser again
    await js(chooser, () => document.querySelector('.ed-startpick-flowcard .ed-startpick-back').click())
    ok(await js(chooser, () => !document.querySelector('.ed-startpick-flowcard') && document.querySelector('.ed-sp-page').style.display === ''), '← Back lands on the start page')
    await js(chooser, () => [...document.querySelectorAll('.ed-startpick-folderlink')].find((b) => b.textContent === '＋ Create layout…').click())
    ok(await js(chooser, () => !!document.querySelector('.ed-startpick-flowcard .ed-startpick-choice')), '"＋ Create layout…" opens the same chooser')
    const labels = await js(chooser, () => [...document.querySelectorAll('.ed-startpick-choice-name')].map((n) => n.textContent))
    ok(JSON.stringify(labels) === '["Empty layout","Start from a built-in slide type","Describe it"]', `Empty first, then the other options (${JSON.stringify(labels)})`)
    await choose(chooser, 'Empty layout')
    const prompt = await page('document.querySelector("dialog.ed-tmpldialog[open]")')
    ok(!!prompt, 'Empty layout asks for the layout’s name')
    ok(await js(prompt, () => !document.querySelector('dialog.ed-tmpldialog fieldset')), 'name only — no "Include slides" for an empty template')
    jsGo(prompt, () => {
      const d = document.querySelector('dialog.ed-tmpldialog')
      d.querySelector('input[type=text]').value = 'Brand'
      d.querySelector('.ed-primary').click()
    })
    const wc = await page(TEMPLATE_WINDOW)
    ok(!!wc, 'the window becomes the template window, open in the Layout Manager')
    ok(docWindows() === 2, `in that same window (start page + template = ${docWindows()})`)
    const p = arg.path
    ok(existsSync(p), 'the template file is in the templates folder')
    const t0 = readDoc(p)
    ok(t0.template === true && !!t0.templateId && !('docId' in t0) && t0.templateSamples === false, 'it is a template (templateId, no docId, no samples)')
    ok((t0.layouts?.length ?? 0) >= 3, `starting from the built-in slide types (${t0.layouts?.length})`)
    ok(await js(wc, () => document.title) === 'Brand — Layout', `the window is titled by the template (${await js(wc, () => document.title)})`)
    ok(await js(wc, () => document.querySelector('.ed-layoutmgr-scope')?.textContent) === 'Layout: Brand', 'the Layout Manager names the template instead of "this deck"')
    ok(await js(wc, () => !document.querySelector('.ed-tmplmenu')), 'no "Save to template ▾" — the window IS the template')
    await shot(wc, 'template-window-lm')
    const done = await js(wc, () => [...document.querySelectorAll('.ed-layoutmgr-head .ed-btn')].map((b) => b.textContent))
    ok(done.includes('Sample slides') && done.includes('Rename…') && !done.includes('Done'), `head: ${JSON.stringify(done)}`)
    await edit(wc, (d) => { d.layouts.push({ id: 'ly-e2e', name: 'E2E Type', background: '#abcdef', transition: 'none', notes: '', elements: [] }) })
    ok(!!await waitFor(async () => readDoc(p).layouts?.some((l) => l.name === 'E2E Type'), 6000), 'a new slide type autosaves into the template file')
    const t1 = readDoc(p)
    ok(t1.template === true && t1.templateId === t0.templateId && !('docId' in t1) && !('basedOn' in t1), 'still a template, same templateId, no docId')
    // leaving the LM: the sample-slides view, with a banner back
    await js(wc, () => [...document.querySelectorAll('.ed-layoutmgr-head .ed-btn')].find((b) => b.textContent === 'Sample slides').click())
    ok(!!await waitFor(() => js(wc, () => !document.querySelector('.ed-layoutmgr-overlay') && document.querySelector('.ed-tmplbanner')?.textContent.includes('Brand'))),
      'Sample slides → the normal editor, with an "Editing template" banner')
    await shot(wc, 'template-window-samples')
    await js(wc, () => document.querySelector('.ed-tmplbanner .ed-btn-primary').click())
    ok(!!await waitFor(() => js(wc, () => !!document.querySelector('.ed-layoutmgr-overlay') && !document.querySelector('.ed-tmplbanner'))), 'Back to Layout Manager')
    const start = await page(START_PAGE)
    const metas = await js(start, () => window.slidomingoDesktop.listTemplateMeta())
    ok(metas.some((m) => m.name === 'Brand' && m.layoutCount === t1.layouts.length), 'the start page lists it, with the new slide type')
    const recent = await js(start, () => window.slidomingoDesktop.listRecent())
    ok(!recent.some((r) => r.path === p), 'a template never lands in Recent')
    await edit(wc, (d) => { d.layouts.find((l) => l.id === 'ly-e2e').background = '#123456' })
    for (const w of BrowserWindow.getAllWindows()) w.close()
    await waitFor(async () => BrowserWindow.getAllWindows().length === 0)
    ok(readDoc(p).layouts.find((l) => l.id === 'ly-e2e')?.background === '#123456', 'closing flushed the pending edit into the template')
    ok(globalThis.__dialogs.length === 0, `without any dialog (${JSON.stringify(globalThis.__dialogs)})`)
    quit()
  }

  if (step === 'chooser-template') {
    // one Create layout option, all the way to its template window
    const chooser = await openChooser()
    await choose(chooser, arg.option)
    if (arg.file) {
      await stubFilePick(chooser, arg.file)
      await js(chooser, () => [...document.querySelectorAll('.ed-startpick-flowcard .ed-startpick-btn')].find((b) => b.textContent === 'Choose file…').click())
    }
    if (arg.layout) {
      await js(chooser, (a) => {
        const item = [...document.querySelectorAll('.ed-startpick-layout-item')].find((i) => i.querySelector('.ed-startpick-layout-name').textContent === a.layout)
        item.click()
        document.querySelector(`.ed-startpick-swatch[title="${a.accent}"]`).click()
      }, arg)
    }
    if (arg.generated) {
      // Describe it, without launching Claude: main's generate handler
      // queues, and the result arrives the way terminalPanel.ts sends it
      const requests = []
      ipcMain.removeHandler('slidomingo:request-generate')
      ipcMain.handle('slidomingo:request-generate', async (_ev, r) => { requests.push(r); return { status: 'queued' } })
      await js(chooser, () => { document.querySelector('.ed-startpick-flowcard textarea').value = 'A crisp teal pitch deck' })
      await js(chooser, () => [...document.querySelectorAll('.ed-startpick-flowcard .ed-startpick-btn')].find((b) => b.textContent === 'Generate with Claude Code').click())
      ok(!!await waitFor(async () => requests.length === 1), 'Generate with Claude Code sends the request to main')
      chooser.send('slidomingo:generate-result', arg.generated)
      ok(!!await waitFor(() => js(chooser, () => !!document.querySelector('.ed-startpick-gen-stage svg, .ed-startpick-gen-stage canvas, .ed-startpick-gen-stage > :not(.ed-startpick-gen-empty)'))), 'the live preview shows the result')
    }
    const create = await waitFor(() => js(chooser, () => {
      const b = [...document.querySelectorAll('.ed-startpick-flowcard .ed-startpick-flow-actions .ed-startpick-btn')].pop()
      return b && !b.disabled ? b.textContent : null
    }))
    ok(create === 'Create layout', `the step's button says "Create layout" (${create})`)
    const fits = await js(chooser, () => {
      const btn = [...document.querySelectorAll('.ed-startpick-flowcard .ed-startpick-flow-actions .ed-startpick-btn')].pop().getBoundingClientRect()
      return btn.bottom <= document.querySelector('.ed-startpick-flowcard').getBoundingClientRect().bottom
    })
    ok(fits, 'and it is in view, without scrolling the step')
    await js(chooser, () => [...document.querySelectorAll('.ed-startpick-flowcard .ed-startpick-flow-actions .ed-startpick-btn')].pop().click())
    const prompt = await page('document.querySelector("dialog.ed-tmpldialog[open]")')
    ok(!!prompt, 'it asks for the layout’s name')
    const prefill = await js(prompt, () => document.querySelector('dialog.ed-tmpldialog input[type=text]').value)
    ok(prefill === (arg.prefill ?? ''), `pre-filled "${prefill}"`)
    jsGo(prompt, (name) => {
      const d = document.querySelector('dialog.ed-tmpldialog')
      d.querySelector('input[type=text]').value = name
      d.querySelector('.ed-primary').click()
    }, arg.name)
    const wc = await page(TEMPLATE_WINDOW)
    ok(!!wc, 'the window becomes the template window, open in the Layout Manager')
    ok(docWindows() === 2, `in that same window (start page + template = ${docWindows()})`)
    ok(await js(wc, () => document.querySelector('.ed-layoutmgr-scope')?.textContent) === `Layout: ${arg.name}`, `"Layout: ${arg.name}"`)
    await shot(wc, `chooser-${arg.name}`)
    quit()
  }

  if (step === 'pptx-layout') {
    // Layouts › From a file… with a PowerPoint: the structure step, then
    // the layout file — named after the file, no name prompt, no window change
    const start = await page(START_PAGE)
    await stubFilePick(start, arg.file)
    await js(start, () => {
      const line = [...document.querySelectorAll('.ed-sp-line')].find((l) => l.querySelector('.ed-sp-line-label').textContent === 'Layouts')
      ;[...line.querySelectorAll('button')].find((b) => b.textContent === 'From a file…').click()
    })
    const counts = await waitFor(() => js(start, () => document.querySelector('.ed-startpick-flowcard .ed-startpick-pptx-counts')?.textContent ?? null))
    ok(!!counts && /master/.test(counts) && /slide types/.test(counts), `it shows what the file holds first (${counts})`)
    const tree = await js(start, () => [...document.querySelectorAll('.ed-startpick-pptx-mastername')].map((x) => x.textContent))
    ok(tree.length >= 1, `each master heads its slide types (${JSON.stringify(tree)})`)
    await shot(start, 'pptx-layout-structure')
    const btn = await waitFor(() => js(start, () => { const b = [...document.querySelectorAll('.ed-startpick-flowcard .ed-startpick-flow-actions .ed-startpick-btn')].pop(); return b && !b.disabled ? b.textContent : null }))
    ok(btn === 'Add layout', `the step's button says "Add layout" (${btn})`)
    await js(start, () => [...document.querySelectorAll('.ed-startpick-flowcard .ed-startpick-flow-actions .ed-startpick-btn')].pop().click())
    ok(!!await waitFor(async () => existsSync(arg.path)), 'the layout file is in the templates folder')
    ok(!!await waitFor(() => js(start, (n) => !document.querySelector('.ed-startpick-flowcard') && [...document.querySelectorAll('.ed-sp-row .ed-sp-tile-name')].some((x) => x.textContent === n), arg.name)), 'back on the start page, with its tile')
    quit()
  }

  if (step === 'edit-from-startpage') {
    const p = arg.path
    const start = await page(START_PAGE)
    const templateId = readDoc(p).templateId
    // the tile's ⋯ → its options panel → ⋯ → Edit template
    await js(start, (path) => document.querySelector(`.ed-sp-tile[title="${path}"]`).parentElement.querySelector('.ed-sp-tile-opts').click(), p)
    ok(!!await waitFor(() => js(start, () => [...document.querySelectorAll('.ed-sp-menu .ed-btn, .ed-sp-menu button')].some((b) => b.textContent === 'Edit layout'))), 'the layout panel offers Edit layout')
    jsGo(start, () => [...document.querySelectorAll('.ed-sp-menu button, .ed-sp-menu .ed-btn')].find((b) => b.textContent === 'Edit layout').click())
    const wc = await page(TEMPLATE_WINDOW)
    ok(!!wc, 'it opens the template in a template window, in the Layout Manager')
    await sleep(500)
    ok(docWindows() === 1, 'in place of the start page, like every other pick there')
    await edit(wc, (d) => { d.layouts.find((l) => l.id === 'ly-e2e').name = 'E2E Saved' })
    await js(wc, () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })))
    ok(!!await waitFor(async () => readDoc(p).layouts.some((l) => l.name === 'E2E Saved'), 2000), '⌘S writes the template file at once')
    ok(readDoc(p).templateId === templateId, 'same templateId')
    // an ordinary open of the same template still starts a fresh deck
    jsGo(wc, () => window.slidomingoDesktop.newWindow())
    const start2 = await waitFor(async () => {
      for (const w of docWcs()) if (w !== wc && !w.isLoading() && await js(w, () => !!document.querySelector('.ed-startpick .ed-sp-row .ed-sp-tile[title]')).catch(() => false)) return w
      return null
    })
    ok(!!start2, 'a second window shows the start page')
    ok(!await js(start2, () => !!document.querySelector('.ed-sp-panel:not([hidden])')), 'no panel is open before the click')
    jsGo(start2, (path) => document.querySelector(`.ed-sp-tile[title="${path}"]`).click(), p) // one click: a deck
    const deck = await page('window.beeslides && window.beeslides.doc && window.beeslides.doc.title === "Untitled" && !/ — Layout$/.test(document.title)')
    ok(!!deck, 'opening the template normally still starts an "Untitled" deck')
    ok(await js(deck, () => window.beeslides.doc.basedOn?.templateId) === templateId, 'based on it (basedOn.templateId)')
    ok(await js(deck, () => !window.beeslides.doc.template && !window.beeslides.doc.templateId), 'and not a template itself')
    ok(await js(deck, () => document.querySelector('.ed-savestatus')?.textContent) === 'Draft', 'a new Draft')
    // an already-open template focuses its window instead of a second one
    const before = docWindows()
    await js(deck, (path) => window.slidomingoDesktop.editTemplate(path), p)
    await sleep(1200)
    ok(before === 2 && docWindows() === before, `Edit template on the open template focuses it — no second window (${before} → ${docWindows()})`)
    ok(await js(deck, () => window.slidomingoDesktop.editTemplate('/tmp/not-a-template.beeslides.html')) === false, 'Edit layout refuses a path outside the templates folder')
    quit()
  }

  if (step === 'deck-edit-template') {
    const p = arg.path
    const deck = await page('window.beeslides && window.beeslides.doc && window.beeslides.doc.title === "Based deck"')
    ok(!!deck, 'a deck based on the template opens')
    await js(deck, () => document.dispatchEvent(new CustomEvent('slidomingo:open-layout-manager', { detail: { tab: 'types', force: true } })))
    await waitFor(() => js(deck, () => !!document.querySelector('.ed-tmplmenu > .ed-btn')))
    await js(deck, () => document.querySelector('.ed-tmplmenu > .ed-btn').click())
    const items = await waitFor(() => js(deck, () => {
      const labels = [...document.querySelectorAll('.ed-tmplmenu .ed-menu .ed-btn span')].map((x) => x.textContent)
      return labels.length >= 3 ? labels : null
    }))
    ok(!!items?.includes('Edit “Brand” in its own window'), `its Layout Manager offers Edit “Brand” in its own window (${JSON.stringify(items)})`)
    await shot(deck, 'deck-lm-template-menu')
    await js(deck, () => [...document.querySelectorAll('.ed-tmplmenu .ed-menu .ed-btn')].find((b) => b.textContent.startsWith('Edit “')).click())
    const wc = await page(TEMPLATE_WINDOW)
    ok(!!wc, 'which opens the template window')
    ok(docWindows() === 2, 'in a NEW window — the deck stays open beside it')
    await edit(wc, (d) => { d.layouts.find((l) => l.id === 'ly-e2e').background = '#fedcba' })
    ok(!!await waitFor(async () => readDoc(p).layouts.find((l) => l.id === 'ly-e2e')?.background === '#fedcba', 6000), 'an edit there saves into the template')
    ok(await js(deck, () => !window.beeslides.doc.layouts?.some((l) => l.background === '#fedcba')), 'the deck does not change by itself')
    await js(deck, () => document.querySelector('.ed-tmplmenu > .ed-btn').click())
    await waitFor(() => js(deck, () => [...document.querySelectorAll('.ed-tmplmenu .ed-menu .ed-btn')].some((b) => b.textContent.startsWith('Update this deck'))))
    await js(deck, () => [...document.querySelectorAll('.ed-tmplmenu .ed-menu .ed-btn')].find((b) => b.textContent.startsWith('Update this deck')).click())
    ok(!!await waitFor(() => js(deck, () => window.beeslides.doc.layouts?.find((l) => l.id === 'ly-e2e')?.background === '#fedcba'), 5000),
      '"Update this deck from “Brand”" pulls the saved change in')
    quit()
  }

  if (step === 'rename') {
    const p = arg.path
    const next = arg.renamed
    const start = await page(START_PAGE)
    jsGo(start, (path) => window.slidomingoDesktop.editTemplate(path, { replace: true }), p)
    const wc = await page(TEMPLATE_WINDOW)
    ok(!!wc, 'the template window opens')
    await js(wc, () => { window.prompt = () => 'Brand Renamed' })
    await js(wc, () => [...document.querySelectorAll('.ed-layoutmgr-head .ed-btn')].find((b) => b.textContent === 'Rename…').click())
    ok(!!await waitFor(async () => existsSync(next) && !existsSync(p), 5000), 'Rename… renames the file')
    ok(!!await waitFor(() => js(wc, () => document.title === 'Brand Renamed — Layout'), 3000), `the window follows (${await js(wc, () => document.title)})`)
    ok(!!await waitFor(() => js(wc, () => document.querySelector('.ed-layoutmgr-scope')?.textContent === 'Layout: Brand Renamed'), 3000), 'and the Layout Manager head')
    await edit(wc, (d) => { d.layouts.find((l) => l.id === 'ly-e2e').name = 'After rename' })
    ok(!!await waitFor(async () => readDoc(next).layouts.some((l) => l.name === 'After rename'), 6000), 'later saves go to the new path')
    ok(!existsSync(p), 'and never recreate the old one')
    ok(await js(wc, () => document.querySelector('.ed-savestatus')?.textContent) === 'Saved', `no "moved or deleted" alarm (${await js(wc, () => document.querySelector('.ed-savestatus')?.textContent)})`)
    quit()
  }
}

// =================================================================================
// ORCHESTRATOR (node)
// =================================================================================
async function orchestrator() {
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron')
  if (!existsSync(SHELL_PATH)) { console.error('build slides first: cd slides && npm run build:single'); process.exit(2) }
  const shell = readFileSync(SHELL_PATH, 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-tw-'))
  const userData = join(root, 'userData')
  const templatesDir = join(root, 'templates')
  const work = join(root, 'work')
  for (const d of [userData, templatesDir, work]) mkdirSync(d, { recursive: true })
  const deckHtml = (doc) => shell.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`)

  function run(step, { open, arg = {} } = {}) {
    console.log(`\n# ${step}`)
    const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), ...(open ? ['--open', open] : [])], {
      cwd: desktopDir,
      env: {
        ...process.env, E2E_STEP: step, E2E_ARG: JSON.stringify(arg),
        SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: templatesDir,
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

  const brand = join(templatesDir, 'Brand.beeslides.html')
  run('new-template', { arg: { path: brand } })
  ok(readdirSync(templatesDir).filter((n) => n.endsWith('.beeslides.html')).length === 1, 'exactly one template file was written')

  run('edit-from-startpage', { arg: { path: brand } })

  const t = readDoc(brand)
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const based = Object.assign(newDoc(), {
    title: 'Based deck', basedOn: { templateId: t.templateId, name: 'Brand' },
    layouts: JSON.parse(JSON.stringify(t.layouts)),
  })
  const deckPath = join(work, 'Based deck.beeslides.html')
  writeFileSync(deckPath, deckHtml(based))
  run('deck-edit-template', { open: deckPath, arg: { path: brand } })

  const renamed = join(templatesDir, 'Brand Renamed.beeslides.html')
  run('rename', { arg: { path: brand, renamed } })
  const final = readDoc(renamed)
  ok(final.template === true && final.templateId === t.templateId && !('docId' in final), 'the renamed file is still the same template')

  // --- the other Create layout options write layout files too ------------
  const isTemplate = (d) => d.template === true && !!d.templateId && !('docId' in d) && !('basedOn' in d)
  const b64 = (bytes) => Buffer.from(bytes).toString('base64')

  const { fxMasters } = await import(join(repo, 'scripts/test-convert/_fixtures.ts'))
  run('pptx-layout', { arg: { file: { name: 'Corporate.potx', b64: b64(await fxMasters()) }, path: join(templatesDir, 'Corporate.beeslides.html'), name: 'Corporate' } })
  const corpPath = join(templatesDir, 'Corporate.beeslides.html')
  if (existsSync(corpPath)) {
    const corp = readDoc(corpPath)
    ok(isTemplate(corp) && corp.templateSamples === false, 'PowerPoint: a layout, slide types only (no samples)')
    const ids = (corp.layouts ?? []).map((l) => l.id)
    ok(ids.filter((id) => id.startsWith('pptx-layout-')).length >= 3 && ids.some((id) => id.startsWith('pptx-master-')), `PowerPoint: the extracted master → layout tree (${ids.join(', ')})`)
    ok((corp.layouts ?? []).filter((l) => l.id.startsWith('pptx-master-')).every((l) => l.parentOnly === true), 'PowerPoint: its masters are parents only')
    ok(corp.slides.length === 1 && corp.slides[0].layoutId === corp.defaultLayoutId, 'PowerPoint: one starter slide of the default type')
  }

  const ACCENT = '#2F6FED'
  run('chooser-template', { arg: { option: 'Start from a built-in slide type', layout: 'Two columns', accent: ACCENT, prefill: '', name: 'Blue' } })
  const bluePath = join(templatesDir, 'Blue.beeslides.html')
  ok(existsSync(bluePath), 'Built-in slide type: the template file is in the templates folder')
  if (existsSync(bluePath)) {
    const blue = readDoc(bluePath)
    ok(isTemplate(blue) && blue.templateSamples === false, 'Built-in slide type: a template, no samples')
    const two = blue.layouts?.find((l) => l.name === 'Two columns')
    ok((blue.layouts?.length ?? 0) >= 5 && blue.defaultLayoutId === two?.id, `Built-in slide type: every built-in slide type, the picked one the default (${blue.defaultLayoutId})`)
    const els = (blue.layouts ?? []).flatMap((l) => l.elements)
    ok(blue.theme.accent === ACCENT && els.some((e) => e.fill === ACCENT) && !els.some((e) => e.fill === '#9A5F00' || e.color === '#9A5F00'), 'Built-in slide type: the slide types carry the accent')
  }

  const generated = Object.assign(newDoc(), { title: 'Acme Pitch' })
  run('chooser-template', { arg: { option: 'Describe it', generated, prefill: 'Acme Pitch', name: 'Acme Pitch' } })
  const acmePath = join(templatesDir, 'Acme Pitch.beeslides.html')
  ok(existsSync(acmePath), 'Describe it: the template file is in the templates folder')
  if (existsSync(acmePath)) {
    const acme = readDoc(acmePath)
    ok(isTemplate(acme) && acme.templateSamples === true && acme.slides.length === generated.slides.length, 'Describe it: a template that keeps the designed slides as samples')
  }

  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
