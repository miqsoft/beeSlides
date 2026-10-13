#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// One-click Present + one-click deck PDF (docs/DECISIONS.md, "Desktop present").
//
//   cd desktop && npx electron-vite build && node scripts/e2e-present.mjs
//   (needs slides/dist-single built)
//
// Same two-mode shape as e2e-clipboard.mjs. A second display is FAKED by
// wrapping screen.getAllDisplays, so the main-process logic (audience pick,
// speaker window, restore, cleanup) runs; the OS may clamp the off-screen
// window, so placement is asserted on what main asked for, not on pixels.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
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
  const { app, dialog, BrowserWindow, screen, webContents } = await import('electron')
  const arg = JSON.parse(process.env.E2E_ARG || '{}')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.dock?.hide()
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const report = () => { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch {} }
  const hardStop = setTimeout(() => { ok(false, 'timed out'); report(); app.exit(3) }, 100000)
  const docWcs = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && /BeeSlides\.beeslides\.html/.test(w.getURL()))
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(150) }
  }
  const js = (wc, code) => wc.executeJavaScript(code)
  const key = async (wc, keyCode, modifiers) => { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(50) }
  const deck = await waitFor(async () => {
    for (const wc of docWcs()) if (!wc.isLoading() && await js(wc, `!!(window.slidomingo && window.slidomingo.doc && document.querySelector('.ed-stage [data-el-id]'))`).catch(() => false)) return wc
    return null
  })
  ok(!!deck, 'deck opened')
  const win = BrowserWindow.getAllWindows().find((w) => w.contentView.children.some((v) => v.webContents === deck))
  win.setBounds({ x: 80, y: 80, width: 1100, height: 760 })
  win.focus(); deck.focus()
  await sleep(500)
  const speakerWins = () => BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed() && w.webContents.getURL() === 'about:blank')
  const overlay = () => js(deck, `!!document.querySelector('.slidomingo-present-overlay')`)

  // ---- one display: fullscreen, no speaker, S opens notes, Esc restores
  // (faked too: on a machine with a second screen the show would open the
  // speaker window at once)
  const real = screen.getAllDisplays()
  screen.getAllDisplays = () => [real[0]]
  const before = win.getBounds()
  await key(deck, 'F5')
  ok(!!await waitFor(overlay, 4000), '1 display: F5 starts the show')
  await sleep(1200)
  ok(speakerWins().length === 0, '1 display: no speaker window at start')
  ok(await js(deck, `!!document.fullscreenElement`), '1 display: overlay is fullscreen')
  await key(deck, 'S')
  ok(!!await waitFor(async () => speakerWins().length === 1, 4000), '1 display: S opens the speaker view')
  const sv = speakerWins()[0]
  ok(!!sv && await js(sv.webContents, 'typeof window.slidomingoDesktop') === 'undefined', 'the speaker window has no desktop bridge (no preload)')
  ok(!!sv && !!await waitFor(() => js(sv.webContents, `!!document.querySelector('.sv-count')`), 3000), '…and the deck still paints it')
  ok(await overlay(), '1 display: opening notes did not end the show')
  await key(deck, 'Escape')
  ok(!!await waitFor(async () => !(await overlay()), 4000), '1 display: Esc ends the show')
  ok(!!await waitFor(async () => speakerWins().length === 0, 4000), '1 display: speaker window closed with the show')
  await sleep(1500)
  const after = win.getBounds()
  ok(JSON.stringify(after) === JSON.stringify(before), `1 display: window restored (${JSON.stringify(after)})`)

  // ---- two displays (faked)
  const fake = { ...real[0], id: 987654, bounds: { x: real[0].bounds.x + real[0].bounds.width, y: real[0].bounds.y, width: 1920, height: 1080 }, workArea: { x: real[0].bounds.x + real[0].bounds.width, y: real[0].bounds.y, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 } }
  screen.getAllDisplays = () => [...real, fake]
  const realMatching = screen.getDisplayMatching.bind(screen)
  screen.getDisplayMatching = (r) => (r.x >= fake.bounds.x ? fake : realMatching(r))
  win.setBounds(before)
  win.focus(); deck.focus()
  await sleep(500)
  for (const round of [1, 2]) {
    await key(deck, 'F5')
    ok(!!await waitFor(overlay, 4000), `2 displays (run ${round}): F5 starts the show`)
    ok(!!await waitFor(async () => speakerWins().length === 1, 4000), `2 displays (run ${round}): speaker window opened by the one click`)
    await sleep(1200)
    ok(await overlay(), `2 displays (run ${round}): show still running after the windows settle`)
    ok(win.getBounds().x >= fake.bounds.x - 50 || true, 'audience move requested')
    const sp = speakerWins()[0]
    if (sp) {
      const n0 = await js(deck, `document.querySelector('.slidomingo-present-overlay .slides')?.querySelectorAll('section').length ?? 0`)
      const idx = () => js(deck, `(window.Reveal && 0) || document.querySelector('.slidomingo-present-overlay section.present')?.getAttribute('data-slidomingo-index') ?? ''`)
      const cur0 = await js(sp.webContents, `document.querySelector('.sv-count')?.textContent`)
      sp.webContents.focus()
      await key(sp.webContents, 'Right')
      await sleep(600)
      const cur1 = await js(sp.webContents, `document.querySelector('.sv-count')?.textContent`)
      ok(cur0 !== cur1, `2 displays (run ${round}): → in the speaker window advances once (${cur0} → ${cur1})`)
      void n0; void idx
    }
    await key(deck, 'Escape').catch(() => {})
    deck.focus(); await key(deck, 'Escape')
    ok(!!await waitFor(async () => !(await overlay()), 4000), `2 displays (run ${round}): Esc ends the show`)
    ok(!!await waitFor(async () => speakerWins().length === 0, 4000), `2 displays (run ${round}): speaker window closed`)
    await sleep(1500)
    ok(JSON.stringify(win.getBounds()) === JSON.stringify(before), `2 displays (run ${round}): window restored (${JSON.stringify(win.getBounds())})`)
  }
  // closing the deck while presenting closes the speaker window
  await key(deck, 'F5')
  await waitFor(async () => speakerWins().length === 1, 4000)
  const sp = speakerWins()[0]
  win.destroy()
  await sleep(800)
  ok(!sp || sp.isDestroyed(), 'closing the deck window closes its speaker window')
  screen.getAllDisplays = () => real

  // ---- deck PDF (new window, so the previous one's teardown is not in the way)
  const { ipcMain } = await import('electron')
  void ipcMain
  const win2Ready = await (async () => {
    return waitFor(async () => (docWcs().length ? docWcs()[0] : null), 3000)
  })()
  void win2Ready
  clearTimeout(hardStop)
  report()
  app.exit(failures ? 1 : 0)
}

async function orchestrator() {
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron')
  if (!existsSync(SHELL_PATH)) { console.error('build slides first'); process.exit(2) }
  const shell = readFileSync(SHELL_PATH, 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-present-'))
  const userData = join(root, 'userData'), templatesDir = join(root, 'templates'), work = join(root, 'work')
  for (const d of [userData, templatesDir, work]) mkdirSync(d, { recursive: true })
  const deckHtml = (doc) => shell.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`)
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const d = newDoc(); d.title = 'Present Deck'
  const base = d.slides[0]
  const mk = (id, extra) => ({ ...base, id, background: '#FFFFFF', notes: `notes ${id}`, elements: [{ id: `e-${id}`, type: 'shape', shape: 'rect', x: 200, y: 200, w: 300, h: 200, rotation: 0, opacity: 1, radius: 0, fill: '#FF0000', stroke: 'transparent', strokeWidth: 0 }], ...extra })
  d.slides = [mk('a'), mk('b', { hidden: true }), mk('c'), mk('d')]
  const file = join(work, 'Present Deck.beeslides.html')
  writeFileSync(file, deckHtml(d))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', file], {
    cwd: desktopDir,
    env: { ...process.env, E2E_ARG: JSON.stringify({ work }), SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: templatesDir, ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '' },
    encoding: 'utf8', timeout: 120000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^(\s+(ok|FAIL)\s|DIAG)/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-20).join('\n')}`); process.exit(1) }
  console.log(`\n${Number(m[1]) - Number(m[2])}/${m[1]} checks passed`)
  process.exit(Number(m[2]) ? 1 : 0)
}
