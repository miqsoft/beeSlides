#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Desktop clipboard E2E: ⌘C / ⌘X / ⌘V / ⇧⌘V and the context menu's Copy/
// Paste, between two open decks (docs/DECISIONS.md 2026-09-30).
//
//   cd desktop && npx electron-vite build && node scripts/e2e-clipboard.mjs
//   (needs slides/dist-single built)
//
// Same two-mode shape as e2e-template-window.mjs. Two differences, both
// because a clipboard is only reachable from a FOCUSED document:
// - the windows are shown at opacity 0 and focused in turn, so the run
//   takes keyboard focus from whatever you are doing for a few seconds;
// - it uses the real system clipboard. Text, HTML and image contents are
//   saved first and written back at the end.
// Keys are sent to the page (sendInputEvent) and the Edit-menu role each
// accelerator runs is invoked on its webContents (copy/cut/paste/
// pasteAndMatchStyle), since synthetic input never reaches the macOS menu.
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
  const { app, dialog, BrowserWindow, Menu, webContents, clipboard } = await import('electron')
  const arg = JSON.parse(process.env.E2E_ARG || '{}')
  dialog.showMessageBox = async () => ({ response: 1 })
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  BrowserWindow.prototype.show = function () { this.setOpacity(0); this.showInactive() }
  app.dock?.hide()
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  // the user's clipboard, put back at the end
  const saved = { text: clipboard.readText(), html: clipboard.readHTML(), image: clipboard.readImage() }
  const restore = () => {
    const d = {}
    if (saved.text) d.text = saved.text
    if (saved.html) d.html = saved.html
    if (!saved.image.isEmpty()) d.image = saved.image
    if (Object.keys(d).length) clipboard.write(d); else clipboard.clear()
  }
  const hardStop = setTimeout(() => { ok(false, 'timed out'); restore(); report(); app.exit(3) }, 90000)
  const docWcs = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && /BeeSlides\.beeslides\.html/.test(w.getURL()))
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(150) }
  }
  const js = (wc, fn, a) => wc.executeJavaScript(`(${fn})(${JSON.stringify(a ?? null)})`)
  const deckPage = (title) => waitFor(async () => {
    for (const wc of docWcs()) {
      if (wc.isLoading()) continue
      if (await wc.executeJavaScript(`!!(window.beeslides && window.beeslides.doc && window.beeslides.doc.title === ${JSON.stringify(title)} && document.querySelector('.ed-stage [data-el-id]'))`).catch(() => false)) return wc
    }
    return null
  })
  const els = (wc) => js(wc, () => JSON.parse(JSON.stringify(window.beeslides.doc.slides[0].elements)))
  const toasts = (wc) => js(wc, () => [...document.querySelectorAll('[class*=toast]')].map((n) => n.textContent).join(' | '))
  const center = (wc, sel) => js(wc, (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }, sel)
  async function focus(wc) {
    const w = BrowserWindow.fromWebContents(wc) ?? BrowserWindow.getAllWindows().find((bw) => bw.contentView?.children?.some((v) => v.webContents === wc))
    w?.focus(); wc.focus()
    return waitFor(() => js(wc, () => document.hasFocus()), 3000)
  }
  async function click(wc, sel, button = 'left') {
    const { x, y } = await center(wc, sel)
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 })
    await sleep(90)
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 })
    await sleep(250)
  }
  const key = async (wc, keyCode, modifiers) => { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(50) }
  function report() { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch {} }

  const edit = Menu.getApplicationMenu().items.find((i) => i.label === 'Edit').submenu.items
  const pms = edit.find((i) => i.role?.toLowerCase() === 'pasteandmatchstyle')
  ok(!!pms && pms.accelerator === 'CmdOrCtrl+Shift+V' && pms.label === 'Paste without Design', `Edit ▸ Paste without Design (⇧⌘V) exists (${pms?.label} ${pms?.accelerator})`)

  const A = await deckPage('Deck A')
  ok(!!A, 'deck A opened')
  await js(A, (p) => window.slidomingoDesktop.openDocument(p, { newWindow: true }), arg.b)
  const B = await deckPage('Deck B')
  ok(!!B, 'deck B opened in a second window')
  await sleep(800)
  clipboard.clear()

  ok(!!await focus(A), 'window A can take focus')
  // ⌘C in A: the key reaches the page, the Edit menu's copy role fires the copy event
  await click(A, '.ed-stage [data-el-id="s-a"]')
  await key(A, 'C', ['meta'])
  A.copy() // what Edit ▸ Copy (role) does for the ⌘C accelerator
  const copied = await waitFor(async () => clipboard.readText().includes('"__slidomingo":"clip"'), 3000)
  ok(!!copied, '⌘C / Edit ▸ Copy put the BeeSlides payload on the system clipboard')

  // ⌘V in B (cross-deck)
  const b0 = (await els(B)).length
  ok(!!await focus(B), 'window B can take focus')
  await click(B, '.ed-stage [data-el-id="s-b"]')
  await js(B, () => document.activeElement?.blur())
  await key(B, 'V', ['meta'])
  B.paste()
  const pasted = await waitFor(async () => (await els(B)).length === b0 + 1 && (await els(B)), 3000)
  ok(!!pasted && pasted.at(-1).fill === '#FF0000' && pasted.at(-1).strokeWidth === 8, `⌘V pastes into the other deck with its design (${pasted?.at(-1)?.fill})`)

  // ⌘⇧V in B: keydown arms, the menu's pasteAndMatchStyle delivers the paste event
  await key(B, 'V', ['meta', 'shift'])
  await sleep(120) // main-process round trip of the menu accelerator
  B.pasteAndMatchStyle()
  const plain = await waitFor(async () => (await els(B)).length === b0 + 2 && (await els(B)), 3000)
  const p = plain?.at(-1)
  ok(!!p && p.fill === '#FFFFFF' && p.stroke === '#9E9E9E' && p.strokeWidth === 2 && !p.fillGradient, `⌘⇧V pastes without design (${JSON.stringify(p && [p.fill, p.stroke, p.strokeWidth])})`)
  await sleep(300)
  ok((await els(B)).length === b0 + 2, 'exactly one paste (no browser-fallback double in the desktop app)')

  // ⌘X in A
  await focus(A)
  await click(A, '.ed-stage [data-el-id="s-a"]')
  clipboard.clear()
  await key(A, 'X', ['meta'])
  A.cut()
  const cutOk = await waitFor(async () => (await els(A)).every((e) => e.id !== 's-a') && clipboard.readText().includes('"__slidomingo"'), 3000)
  ok(!!cutOk, '⌘X / Edit ▸ Cut removes the object and puts it on the clipboard')
  A.paste()
  ok(!!await waitFor(async () => (await els(A)).some((e) => e.fill === '#FF0000'), 3000), '⌘V restores the cut object')

  // context menu Copy (async clipboard API — needs clipboard-sanitized-write)
  clipboard.writeText('sentinel')
  const aEl = (await els(A)).find((e) => e.fill === '#FF0000')
  await click(A, `.ed-stage [data-el-id="${aEl.id}"]`)
  await click(A, `.ed-stage [data-el-id="${aEl.id}"]`, 'right')
  const hasMenu = await waitFor(() => js(A, () => [...document.querySelectorAll('button, [role=menuitem], div')].some((n) => n.textContent === 'Copy' && n.offsetParent)), 3000)
  ok(!!hasMenu, 'the context menu opens')
  await js(A, () => { const n = [...document.querySelectorAll('button, [role=menuitem], div')].filter((n) => n.textContent === 'Copy' && n.offsetParent).pop(); n.setAttribute('data-e2e', 'copy') })
  await click(A, '[data-e2e="copy"]')
  const ctxCopied = await waitFor(async () => clipboard.readText().includes('"kind":"elements"'), 3000)
  ok(!!ctxCopied, 'context-menu Copy wrote the payload')
  ok(!(await toasts(A)).includes('Couldn’t access the clipboard'), `no clipboard-access toast in A (${await toasts(A)})`)

  // context menu Paste in B (async read — needs clipboard-read)
  const b1 = (await els(B)).length
  await focus(B)
  const bEl = (await els(B))[0]
  await click(B, `.ed-stage [data-el-id="${bEl.id}"]`, 'right')
  await waitFor(() => js(B, () => [...document.querySelectorAll('button, [role=menuitem], div')].some((n) => n.textContent === 'Paste' && n.offsetParent)), 3000)
  await js(B, () => { const n = [...document.querySelectorAll('button, [role=menuitem], div')].filter((n) => n.textContent === 'Paste' && n.offsetParent).pop(); n.setAttribute('data-e2e', 'paste') })
  await click(B, '[data-e2e="paste"]')
  ok(!!await waitFor(async () => (await els(B)).length === b1 + 1, 3000), 'context-menu Paste in the other deck inserts it')
  ok(!(await toasts(B)).includes('Couldn’t access the clipboard'), `no clipboard-access toast in B (${await toasts(B)})`)

  restore()
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  report(); clearTimeout(hardStop); app.exit(0)
}

async function orchestrator() {
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron')
  if (!existsSync(SHELL_PATH)) { console.error('build slides first'); process.exit(2) }
  const shell = readFileSync(SHELL_PATH, 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-clip-'))
  const userData = join(root, 'userData'), templatesDir = join(root, 'templates'), work = join(root, 'work')
  for (const d of [userData, templatesDir, work]) mkdirSync(d, { recursive: true })
  const deckHtml = (doc) => shell.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`)
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const mk = (title, el) => { const d = newDoc(); d.title = title; d.slides = [{ ...d.slides[0], background: '#FFFFFF', elements: [el] }]; return d }
  const shape = (id, extra) => ({ id, type: 'shape', shape: 'rect', x: 200, y: 200, w: 300, h: 200, rotation: 0, opacity: 1, radius: 0, ...extra })
  const a = join(work, 'Deck A.beeslides.html'), b = join(work, 'Deck B.beeslides.html')
  writeFileSync(a, deckHtml(mk('Deck A', shape('s-a', { fill: '#FF0000', stroke: '#0000FF', strokeWidth: 8, fillGradient: { angle: 90, stops: [{ at: 0, color: '#FF0000' }, { at: 1, color: '#00FF00' }] } }))))
  writeFileSync(b, deckHtml(mk('Deck B', shape('s-b', { x: 700, fill: '#DDDDDD', stroke: 'transparent', strokeWidth: 0 }))))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', a], {
    cwd: desktopDir,
    env: { ...process.env, E2E_ARG: JSON.stringify({ b }), SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: templatesDir, ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '' },
    encoding: 'utf8', timeout: 120000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-20).join('\n')}`); process.exit(1) }
  console.log(`\n${Number(m[1]) - Number(m[2])}/${m[1]} checks passed`)
  process.exit(Number(m[2]) ? 1 : 0)
}
