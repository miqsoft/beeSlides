#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Desktop native-menu E2E: one command registry feeds the menu bar
// (docs/DECISIONS.md 2026-10-06).
//
//   cd desktop && npx electron-vite build && node scripts/e2e-menu.mjs
//   (needs slides/dist-single built)
//
// Checks, against the real app menu (Menu.getApplicationMenu()):
//  - every command id in the model resolves to a registry command;
//  - renderer items show their shortcut but do not register it (no double
//    fire); main-owned items keep real accelerators;
//  - state follows the editor: Arrange is disabled with nothing selected and
//    enabled after ⌘A; View ▸ Safe Zone Guides toggles; File ▸ Export ▸ Copy
//    JSON copies the deck; File ▸ Save runs;
//  - the language switch relabels the native menu;
//  - a window without an editor (start page) shows the same menus, disabled.
// The window is shown at opacity 0 and focused (the menu follows the focused
// window), so the run takes keyboard focus for a few seconds. The system
// clipboard is saved and restored.
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
const BLOCK_RE = /(<script[^>]*\bid=["']slidomingo-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
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
  const { app, dialog, BrowserWindow, Menu, webContents, clipboard } = await import('electron')
  const arg = JSON.parse(process.env.E2E_ARG || '{}')
  dialog.showMessageBox = async () => ({ response: 1 })
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  BrowserWindow.prototype.show = function () { this.setOpacity(0); this.showInactive() }
  app.dock?.hide()
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const savedText = clipboard.readText()
  const hardStop = setTimeout(() => { ok(false, 'timed out'); clipboard.writeText(savedText); report(); app.exit(3) }, 90000)
  function report() { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch {} }
  async function waitFor(fn, ms = 8000) {
    const end = Date.now() + ms
    for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(120) }
  }
  const docWcs = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && /BeeSlides\.beeslides\.html/.test(w.getURL()))
  const js = (wc, fn, a) => wc.executeJavaScript(`(${fn})(${JSON.stringify(a ?? null)})`)
  const winOf = (wc) => BrowserWindow.getAllWindows().find((bw) => bw.contentView?.children?.some((v) => v.webContents === wc))
  async function focus(wc) {
    const w = winOf(wc); w?.focus(); wc.focus()
    return waitFor(() => js(wc, () => document.hasFocus()), 3000)
  }
  const editorPage = () => waitFor(async () => {
    for (const wc of docWcs()) {
      if (wc.isLoading()) continue
      if (await wc.executeJavaScript(`!!(window.slidomingo && window.slidomingo.menu && document.querySelector('.ed-stage [data-el-id]'))`).catch(() => false)) return wc
    }
    return null
  }, 15000)

  // ---- lookups in the live native menu
  const top = (label) => Menu.getApplicationMenu().items.find((i) => i.label === label)
  const find = (items, path) => {
    let cur = items
    let it = null
    for (const label of path) { it = cur.find((i) => i.label === label); if (!it) return null; cur = it.submenu?.items ?? [] }
    return it
  }
  const item = (...path) => find(Menu.getApplicationMenu().items, path)

  const A = await editorPage()
  ok(!!A, 'the editor opened')
  await focus(A)

  // ---- structure
  await waitFor(() => item('File', 'Save')?.enabled)
  const labels = Menu.getApplicationMenu().items.map((i) => i.label)
  const want = ['File', 'Edit', 'Insert', 'Slide', 'Arrange', 'View', 'Play', 'Window', 'Help']
  ok(want.every((l) => labels.includes(l)), `menu bar: ${labels.join(' | ')}`)

  const model = await js(A, () => window.slidomingo.menu.model())
  const ids = []
  const walk = (items) => { for (const it of items) { if (it.id) ids.push(it.id); if (it.submenu) walk(it.submenu) } }
  for (const m of model.menus) walk(m.items)
  const unknown = await js(A, (ids) => ids.filter((id) => !window.slidomingo.menu.has(id)), ids)
  ok(ids.length > 80 && unknown.length === 0, `every renderer command id in the model resolves to a registry command (${ids.length} ids, unknown: ${unknown.join(', ') || 'none'})`)
  ok((await js(A, () => window.slidomingo.menu.unresolved())).length === 0, 'every id the menu tree names is registered')

  // ---- one owner per shortcut
  const save = item('File', 'Save')
  ok(save?.accelerator === 'CmdOrCtrl+S' && save.registerAccelerator === false, 'File ▸ Save shows ⌘S but does not register it (the page owns the key)')
  const undo = item('Edit', 'Undo')
  ok(undo?.accelerator === 'CmdOrCtrl+Z' && undo.registerAccelerator === false, 'Edit ▸ Undo shows ⌘Z, display-only (no double undo)')
  const settings = Menu.getApplicationMenu().items.flatMap((t) => t.submenu?.items ?? []).find((i) => i.label === 'Settings…')
  ok(settings?.accelerator === 'CmdOrCtrl+,' && settings.registerAccelerator === false, 'Settings… shows ⌘, display-only (opens once)')
  const nw = item('File', 'New Window'), open = item('File', 'Open…')
  ok([nw, open].every((i) => i && i.accelerator && i.registerAccelerator !== false), 'main-owned New Window / Open… keep real accelerators')
  ok(item('Edit', 'Paste without Design')?.accelerator === 'CmdOrCtrl+Shift+V', 'Edit ▸ Paste without Design (⇧⌘V) exists (macOS runs the role itself)')
  ok(item('File', 'New from Default Layout')?.accelerator === 'Alt+CmdOrCtrl+N', 'File ▸ New from Default Layout keeps ⌥⌘N')
  ok(!!item('File', 'Export to…', 'Copy document JSON') && !!item('File', 'Import', 'Replace from JSON…') && !!item('View', 'Check slides') && !!item('View', 'Margin guides'),
    'Export ▸ Copy JSON, Import ▸ Replace from JSON, View ▸ Check slides / Margin guides are reachable')
  ok(!item('File', 'Export to…', 'Export figure as PDF…'), 'figure exports are hidden for a normal deck')

  // ---- state follows the editor
  ok(item('Arrange', 'Group')?.enabled === false && item('Insert', 'Save selection…')?.enabled === false, 'Arrange / Save selection are disabled with nothing selected')
  await js(A, () => { document.activeElement?.blur?.(); window.slidomingo.menu.run('arrange.group') }) // a disabled command must be a no-op
  A.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] }); A.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] })
  ok(!!await waitFor(() => item('Arrange', 'Group')?.enabled === true && item('Arrange', 'Align', 'Align left')?.enabled === true), 'Arrange is enabled once something is selected')
  ok(item('Insert', 'Save selection…')?.enabled === true, 'Insert ▸ Save selection… follows the selection too')

  // ---- Insert ▸ Shape: the basic shapes, then the preset gallery by category
  ok(!!item('Insert', 'Shape', 'Rectangle') && !!item('Insert', 'Shape', 'Preset shapes', 'Flowchart', 'Decision'),
    'Insert ▸ Shape lists the basic shapes and Preset shapes ▸ <category> ▸ preset')
  const countEls = () => js(A, () => window.slidomingo.doc.slides.reduce((n, s) => n + s.elements.length, 0))
  const n0 = await countEls()
  item('Insert', 'Shape', 'Preset shapes', 'Stars', '5-point star')?.click()
  const inserted = await waitFor(async () => (await countEls()) === n0 + 1, 5000)
  const last = await js(A, () => window.slidomingo.doc.slides.flatMap((s) => s.elements).find((e) => e.type === 'shape' && e.shape === 'path' && /^M /.test(e.d || '')) ?? null)
  ok(!!inserted && !!last, `choosing Stars ▸ 5-point star inserts it as a plain path shape (${n0} → ${await countEls()})`)

  // ---- running items through the real channel
  const safe0 = item('View', 'Margin guides')
  ok(safe0?.type === 'checkbox' && safe0.checked === false, 'View ▸ Margin guides is a checkbox, off')
  safe0.click()
  ok(!!await waitFor(() => item('View', 'Margin guides')?.checked === true), 'clicking it turns the guides on (state round-trips into the menu)')
  item('View', 'Margin guides').click()
  ok(!!await waitFor(() => item('View', 'Margin guides')?.checked === false), 'and off again')

  clipboard.clear()
  item('File', 'Export to…', 'Copy document JSON').click()
  const copied = await waitFor(() => /"title": ?"Menu Deck"/.test(clipboard.readText()), 5000)
  ok(!!copied, 'File ▸ Export ▸ Copy document JSON copies the deck')

  await js(A, () => { const e = document.querySelector('.ed-title'); e.value = 'Menu Deck Saved'; e.dispatchEvent(new Event('change')) })
  item('File', 'Save').click()
  const saved = await waitFor(() => /Menu Deck Saved/.test(readFileSync(arg.deck, 'utf8')), 6000)
  ok(!!saved, 'File ▸ Save writes the deck to disk')

  // ---- language relabels the native menu
  await js(A, () => window.slidomingo.menu.run('view.lang.de'))
  ok(!!await waitFor(() => !!top('Datei') && !!item('Datei', 'Speichern') && !!item('Datei', 'Neues Fenster')), 'switching to German relabels the menu bar, renderer and main-owned items alike')
  await js(A, () => window.slidomingo.menu.run('view.lang.en'))
  ok(!!await waitFor(() => !!top('File') && !!item('File', 'Save')), 'and back to English')

  // ---- a window without an editor: same menus, all disabled
  const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
  item('File', 'New Window').click()
  const nwWin = await waitFor(() => BrowserWindow.getAllWindows().find((w) => !before.has(w.id)))
  ok(!!nwWin, 'File ▸ New Window opens a window (start page)')
  const nwWc = await waitFor(() => docWcs().find((wc) => winOf(wc) === nwWin))
  ok(!!nwWc && !!await focus(nwWc), 'the new window takes focus')
  const disabled = await waitFor(() => item('File', 'Save')?.enabled === false && item('Insert', 'Text')?.enabled === false && item('View', 'Check slides')?.enabled === false, 6000)
  ok(!!disabled, 'on the start page File ▸ Save, Insert ▸ Text and View ▸ Check slides exist but are disabled')
  ok(item('File', 'Open…')?.enabled !== false && item('File', 'New Window')?.enabled !== false, 'while main-owned New/Open stay usable there')
  nwWin?.close()
  await focus(A)
  ok(!!await waitFor(() => item('File', 'Save')?.enabled === true), 'refocusing the editor window re-enables them')

  // ---- an icon set: the same registry, icon wording (DECISIONS 2026-10-16)
  const beforeIcons = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
  item('File', 'New Icon Set…').click()
  const iconWin = await waitFor(() => BrowserWindow.getAllWindows().find((w) => !beforeIcons.has(w.id)))
  const I = await waitFor(async () => {
    for (const wc of docWcs()) {
      if (winOf(wc) !== iconWin || wc.isLoading()) continue
      if (await js(wc, () => window.slidomingo?.doc?.kind === 'iconset' && !!window.slidomingo.menu && !!document.querySelector('.ed-iconset')).catch(() => false)) return wc
    }
    return null
  }, 15000)
  ok(!!I && !!await focus(I), 'File ▸ New Icon Set… opens the icon set editor')
  ok(!!await waitFor(() => !!top('Icons') && !top('Slide'), 6000), `the Slide menu is called Icons there (${Menu.getApplicationMenu().items.map((i) => i.label).join(' | ')})`)
  ok(!!item('View', 'All icons') && !!item('View', 'Icons') && !item('View', 'Slide Sorter') && !item('View', 'Check slides'), 'View ▸ All icons and Icons; no Slide Sorter or Check slides')
  ok(!!item('Arrange', 'Align', 'Center on canvas') && !!item('Arrange', 'Relative to canvas'), 'Arrange aligns to the canvas')
  ok(!item('Insert', 'Text') && !item('Insert', 'Image') && !item('Insert', 'Table') && !!item('Insert', 'Shape', 'Ellipse'), 'Insert keeps shapes only')
  iconWin?.close()
  await focus(A)
  ok(!!await waitFor(() => !!top('Slide') && !!item('View', 'Slide Sorter') && !!item('View', 'Check slides')), 'back in the deck, the deck wording returns')

  clearTimeout(hardStop)
  clipboard.writeText(savedText)
  report()
  app.exit(failures ? 1 : 0)
}

async function orchestrator() {
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron')
  if (!existsSync(SHELL_PATH)) { console.error('build slides first'); process.exit(2) }
  const shell = readFileSync(SHELL_PATH, 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-menu-'))
  const userData = join(root, 'userData'), templatesDir = join(root, 'templates'), work = join(root, 'work')
  for (const d of [userData, templatesDir, work]) mkdirSync(d, { recursive: true })
  const deckHtml = (doc) => shell.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`)
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const d = newDoc(); d.title = 'Menu Deck'
  d.slides = [{ ...d.slides[0], background: '#FFFFFF', elements: [{ id: 's-1', type: 'shape', shape: 'rect', x: 200, y: 200, w: 300, h: 200, rotation: 0, opacity: 1, radius: 0, fill: '#DDDDDD', stroke: 'transparent', strokeWidth: 0 }] }]
  const deck = join(work, 'Menu Deck.beeslides.html')
  writeFileSync(deck, deckHtml(d))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deck], {
    cwd: desktopDir,
    env: { ...process.env, E2E_ARG: JSON.stringify({ deck }), SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: templatesDir, ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '' },
    encoding: 'utf8', timeout: 120000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-20).join('\n')}`); process.exit(1) }
  console.log(`\n${Number(m[1]) - Number(m[2])}/${m[1]} checks passed`)
  process.exit(Number(m[2]) ? 1 : 0)
}
