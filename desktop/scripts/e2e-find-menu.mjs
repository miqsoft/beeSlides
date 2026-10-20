#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Desktop E2E for find & replace in the native menu and the real keyboard
// path (DECISIONS 2026-10-08, "Find & replace").
//
//   cd desktop && npx electron-vite build && node scripts/e2e-find-menu.mjs
//   (needs slides/dist-single built)
//
// Checks, against the real app menu (Menu.getApplicationMenu()):
//  - Edit ▸ Find… (⌘F) and Find and replace… (⌥⌘F) exist with those
//    accelerators, display-only (the page owns the keys — no double fire);
//  - choosing them opens the find bar (with the replace row for the second);
//  - ⌘F typed into the window opens the bar too;
//  - ⌘Z typed into the replace field after "Replace all" undoes the DECK
//    (the native Edit menu must not turn it into the input's own undo);
//  - the labels follow the language (German: Suchen… / Suchen und ersetzen…).
// The window is shown at opacity 0 and focused (the menu follows the focused
// window), so the run takes keyboard focus for a few seconds.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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
let failures = 0, checks = 0
function ok(cond, msg) { checks++; if (!cond) failures++; try { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) } catch {} }

if (process.versions.electron) {
  driver().catch(async (err) => {
    ok(false, `driver error: ${err?.stack ?? err}`)
    try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch {}
    const { app } = await import('electron'); app.exit(4)
  })
} else await orchestrator()

async function driver() {
  const { app, dialog, BrowserWindow, Menu, webContents } = await import('electron')
  dialog.showMessageBox = async () => ({ response: 1 })
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  BrowserWindow.prototype.show = function () { this.setOpacity(0); this.showInactive() }
  app.dock?.hide()
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const hardStop = setTimeout(() => { ok(false, 'timed out'); report(); app.exit(3) }, 90000)
  function report() { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch {} }
  async function waitFor(fn, ms = 8000) {
    const end = Date.now() + ms
    for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(120) }
  }
  const docWcs = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && /BeeSlides\.beeslides\.html/.test(w.getURL()))
  const js = (wc, fn, a) => wc.executeJavaScript(`(${fn})(${JSON.stringify(a ?? null)})`)
  const winOf = (wc) => BrowserWindow.getAllWindows().find((bw) => bw.contentView?.children?.some((v) => v.webContents === wc))
  async function focus(wc) {
    // the menu follows BrowserWindow.getFocusedWindow(): a background-launched
    // app must take focus first, or menu clicks go nowhere
    app.focus({ steal: true })
    const w = winOf(wc); w?.focus(); wc.focus()
    return waitFor(() => js(wc, () => document.hasFocus()) && BrowserWindow.getFocusedWindow() === w, 3000)
  }
  const editorPage = () => waitFor(async () => {
    for (const wc of docWcs()) {
      if (wc.isLoading()) continue
      if (await wc.executeJavaScript(`!!(window.beeslides && window.beeslides.menu && document.querySelector('.ed-stage [data-el-id]'))`).catch(() => false)) return wc
    }
    return null
  }, 15000)
  const item = (...path) => {
    let cur = Menu.getApplicationMenu().items, it = null
    for (const label of path) { it = cur.find((i) => i.label === label); if (!it) return null; cur = it.submenu?.items ?? [] }
    return it
  }
  const key = (wc, keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  const bar = (wc) => js(wc, () => {
    const b = document.querySelector('.ed-findbar')
    return { open: !!b && !b.hidden, replace: !!b && !b.querySelector('.ed-findbar-replace').hidden, focus: document.activeElement?.className ?? '' }
  })
  const closeBar = (wc) => js(wc, () => document.querySelector('.ed-findbar .ed-findbar-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  const bodyHtml = (wc) => js(wc, () => window.beeslides.doc.slides[0].elements.find((e) => e.id === 't-1').html)

  const A = await editorPage()
  ok(!!A, 'the editor opened')
  ok(!!await focus(A), 'the editor window has focus (the menu follows it)')
  await waitFor(() => item('Edit', 'Find…')?.enabled)

  // ---- the items and their shortcuts
  const find = item('Edit', 'Find…'), repl = item('Edit', 'Find and replace…')
  ok(find?.accelerator === 'CmdOrCtrl+F' && find.registerAccelerator === false, `Edit ▸ Find… shows ⌘F, display-only (${find?.accelerator}, register ${find?.registerAccelerator})`)
  ok(repl?.accelerator === 'Alt+CmdOrCtrl+F' && repl.registerAccelerator === false, `Edit ▸ Find and replace… shows ⌥⌘F, display-only (${repl?.accelerator}, register ${repl?.registerAccelerator})`)
  const edit = item('Edit').submenu.items.map((i) => i.label || '—')
  ok(edit.indexOf('Find…') > edit.indexOf('Redo') && edit.indexOf('Find and replace…') === edit.indexOf('Find…') + 1, `in the Edit menu after Undo/Redo: ${edit.join(' | ')}`)

  // ---- choosing them
  repl.click()
  let s = await waitFor(async () => { const b = await bar(A); return b.open && b.replace ? b : null })
  ok(!!s, 'Edit ▸ Find and replace… opens the bar with the replace row')
  await closeBar(A)
  ok(!!await waitFor(async () => !(await bar(A)).open), 'the bar closes')
  item('Edit', 'Find…').click()
  s = await waitFor(async () => { const b = await bar(A); return b.open ? b : null })
  ok(!!s && /ed-findbar-input/.test(s.focus), 'Edit ▸ Find… opens it with the find field focused')
  await closeBar(A)
  await waitFor(async () => !(await bar(A)).open)

  // ---- the keyboard: ⌘F, then ⌘Z after Replace all
  await focus(A)
  await js(A, () => document.activeElement?.blur?.())
  key(A, 'F', [process.platform === 'darwin' ? 'meta' : 'control'])
  s = await waitFor(async () => { const b = await bar(A); return b.open ? b : null })
  ok(!!s, '⌘F typed into the window opens the bar (the page owns the key)')
  const before = await bodyHtml(A)
  await js(A, () => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    const b = document.querySelector('.ed-findbar')
    set(b.querySelector('.ed-findbar-input'), 'cat')
    if (b.querySelector('.ed-findbar-replace').hidden) b.querySelector('.ed-findbar-toggle').click()
    const r = b.querySelector('.ed-findbar-replace .ed-findbar-input')
    set(r, 'dog')
    r.focus()
  })
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  key(A, 'Return', [mod])
  const replaced = await waitFor(async () => { const h = await bodyHtml(A); return h !== before ? h : null })
  ok(replaced === 'The dog sat on the dog mat', `⌘Enter in the replace field replaces all (${replaced})`)
  ok(/ed-findbar-input/.test((await bar(A)).focus), 'focus stays in the replace field')
  key(A, 'Z', [mod])
  ok(!!replaced && !!await waitFor(async () => (await bodyHtml(A)) === before), '⌘Z there undoes the deck, not the field')
  ok((await js(A, () => document.querySelector('.ed-findbar-replace .ed-findbar-input').value)) === 'dog', 'and the field keeps its text')
  key(A, 'Z', [mod, 'shift'])
  ok(!!await waitFor(async () => (await bodyHtml(A)) === replaced), '⇧⌘Z redoes it')
  await closeBar(A)

  // ---- language
  await js(A, () => window.beeslides.menu.run('view.lang.de'))
  ok(!!await waitFor(() => !!item('Bearbeiten', 'Suchen…') && !!item('Bearbeiten', 'Suchen und ersetzen…')), 'German: Bearbeiten ▸ Suchen… / Suchen und ersetzen…')
  ok(item('Bearbeiten', 'Suchen und ersetzen…')?.accelerator === 'Alt+CmdOrCtrl+F', 'with the same accelerator')
  await js(A, () => window.beeslides.menu.run('view.lang.en'))
  ok(!!await waitFor(() => !!item('Edit', 'Find…')), 'and back to English')

  clearTimeout(hardStop)
  report()
  app.exit(failures ? 1 : 0)
}

async function orchestrator() {
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron')
  if (!existsSync(SHELL_PATH)) { console.error('build slides first'); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.error('build desktop first: npx electron-vite build'); process.exit(2) }
  const shell = readFileSync(SHELL_PATH, 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-find-'))
  const userData = join(root, 'userData'), templatesDir = join(root, 'templates'), work = join(root, 'work')
  for (const d of [userData, templatesDir, work]) mkdirSync(d, { recursive: true })
  const deckHtml = (doc) => shell.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`)
  const { newDoc, defaultText } = await import(join(repo, 'slides/src/model.ts'))
  const d = newDoc(); d.title = 'Find Deck'
  d.slides = [{ ...d.slides[0], background: '#FFFFFF', elements: [defaultText({ id: 't-1', x: 100, y: 100, w: 800, h: 200, html: 'The cat sat on the cat mat' })] }]
  const deck = join(work, 'Find Deck.beeslides.html')
  writeFileSync(deck, deckHtml(d))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deck], {
    cwd: desktopDir,
    env: { ...process.env, SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: templatesDir, ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '' },
    encoding: 'utf8', timeout: 120000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-20).join('\n')}`); process.exit(1) }
  console.log(`\n${Number(m[1]) - Number(m[2])}/${m[1]} checks passed`)
  process.exit(Number(m[2]) ? 1 : 0)
}
