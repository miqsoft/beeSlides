#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The presenting modes in a real (headless) browser, from a file:// URL:
// the start card of a present-only file (player.ts) and the F / S / K switches
// inside the show (present.ts).
//
//   node scripts/test-present-modes-e2e.mjs [--viewer viewer-file] [--editor editor-file]
//
// Runs the same flow on both shells that boot into the card: the viewer-only
// build (dist-viewer, what File ▸ Export writes on
// desktop) and the editor build with `doc.readonly` (what the web editor
// writes). Needs playwright-core ($PLAYWRIGHT_CORE, the package, or the npx
// cache); without one or without a build it SKIPS with exit 0 and says so.
//
// Per shell: the card shows and nothing autostarts; four modes, the last one
// is remembered; In a window starts a show that is not fullscreen; F swaps
// fullscreen and window without ending the show (where headless grants
// fullscreen); Esc lands back on the card; K turns kiosk on and off mid-show;
// Kiosk from the card advances by itself, loops and remembers its seconds;
// Presenter view is two clicks (speaker window opens idle, then Start adopts
// it), S closes and reopens the speaker window, Esc leaves it idle for the
// next run; `#present` still starts the show at once.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined }
const viewerFile = opt('--viewer') ?? join(root, 'slides/dist-viewer/BeeSlides_Viewer.beeslides.html')
const editorFile = opt('--editor') ?? join(root, 'slides/dist-single/BeeSlides.beeslides.html')

async function loadChromium() {
  const tries = []
  if (process.env.PLAYWRIGHT_CORE) tries.push(pathToFileURL(process.env.PLAYWRIGHT_CORE).href)
  tries.push('playwright-core')
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) {
    for (const d of readdirSync(npx)) {
      const p = join(npx, d, 'node_modules/playwright-core/index.mjs')
      if (existsSync(p)) tries.push(pathToFileURL(p).href)
    }
  }
  for (const spec of tries) {
    try { return (await import(spec)).chromium } catch { /* next */ }
  }
  return null
}

const skip = (why) => { console.log(`test-present-modes-e2e: SKIP — ${why}`); process.exit(0) }
if (!existsSync(editorFile) || !existsSync(viewerFile)) skip('no build (npm run build:single in slides/)')
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')
let browser
try { browser = await chromium.launch() } catch (e) { skip(`no browser: ${String(e.message).split('\n')[0]}`) }

let fails = 0
let passes = 0
const check = (ok, label, detail) => {
  if (ok) { passes++; console.log(`  ok    ${label}`) }
  else { fails++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`) }
}

// ---- the deck: three slides with notes ----------------------------------------------
const text = (id, html) => ({
  id, type: 'text', x: 80, y: 60, w: 1120, h: 110, rotation: 0, opacity: 1, html, fontSize: 56,
  fontFamily: 'system-ui, sans-serif', fontWeight: 700, color: '#1D1119', align: 'left', valign: 'middle', lineHeight: 1.2,
})
const slide = (id, bg, notes) => ({ id, background: bg, transition: 'none', elements: [text(`t-${id}`, id)], notes })
function buildDeck(base) {
  const d = JSON.parse(JSON.stringify(base))
  d.title = 'Modes deck'
  d.readonly = true
  d.slides = [slide('S1', '#FDE2E4', 'notes one'), slide('S2', '#E2ECE9', 'notes two'), slide('S3', '#BEE1E6', 'notes three')]
  d.sections = []
  d.present = {}
  return d
}
const splice = (html, deck) => {
  const json = JSON.stringify(deck).replace(/</g, '\\u003c')
  const out = html.replace(/(<script type="application\/slidomingo\+json" id="slidomingo-doc">)([\s\S]*?)(<\/script>)/, `$1${json}$3`)
  if (out === html) throw new Error('doc block not found in shell')
  return out
}

// ---- helpers ----------------------------------------------------------------------
const cur = (p) => p.evaluate(() =>
  document.querySelector('.slidomingo-present-overlay section.present > .slidomingo-slide')?.getAttribute('data-slide-id') ?? null)
const inShow = (p) => p.evaluate(() => !!document.querySelector('.slidomingo-present-overlay'))
const cardShown = (p) => p.evaluate(() => {
  const c = document.querySelector('.ed-player')
  return !!c && getComputedStyle(c).display !== 'none'
})
const fs = (p) => p.evaluate(() => !!document.fullscreenElement)
const toast = (p) => p.evaluate(() => {
  const t = document.querySelector('.slidomingo-present-toast')
  return t ? t.textContent : null
})
const pickMode = (p, m) => p.click(`.ed-playmode[data-mode="${m}"]`)
const goLabel = (p) => p.evaluate(() => document.querySelector('.ed-playgo')?.textContent?.replace(/\s+/g, ' ').trim())
const startShow = async (p) => {
  await p.click('.ed-playgo')
  await p.waitForSelector('.slidomingo-present-overlay section.present', { timeout: 20_000 })
  await p.waitForTimeout(500)
}
const press = async (p, k) => { await p.keyboard.press(k); await p.waitForTimeout(250) }
const leaveShow = async (p) => {
  if (await fs(p)) { await press(p, 'Escape') } // Esc ends the show; a fullscreen exit does too
  if (await inShow(p)) await press(p, 'Escape')
  await p.waitForTimeout(300)
}

async function runShell(name, file) {
  console.log(`— ${name}`)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(pathToFileURL(file).href)
  await p.waitForSelector('.ed-playercard', { timeout: 30_000 })
  await p.waitForTimeout(400)
  await p.evaluate(() => document.getElementById('slidomingo-splash')?.remove())

  // the card
  check(await cardShown(p) && !(await inShow(p)), 'opens on the start card, nothing autostarts')
  check((await p.locator('.ed-playmode').count()) === 4, 'four modes are offered')
  check(await p.getAttribute('.ed-playmode[data-mode="fullscreen"]', 'aria-checked') === 'true', 'Full screen is the first-run default')
  check((await goLabel(p)).includes('Start'), 'the primary button starts', await goLabel(p))
  check(await p.locator('.ed-playkiosk').isHidden(), 'the kiosk row is hidden until Kiosk is picked')
  await pickMode(p, 'kiosk')
  check(await p.locator('.ed-playkiosk').isVisible(), 'picking Kiosk reveals seconds + loop')
  check(await p.inputValue('.ed-playsecs') === '10' && await p.isChecked('.ed-playloop'), 'kiosk defaults: 10 s, loop on')

  // in a window
  await pickMode(p, 'window')
  await startShow(p)
  check(await cur(p) === 'S1' && !(await fs(p)), 'In a window: the show runs, not fullscreen')
  await press(p, 'ArrowRight')
  check(await cur(p) === 'S2', '→ advances')

  // F: fullscreen <-> window, show survives (when the browser grants fullscreen)
  await press(p, 'f')
  await p.waitForTimeout(300)
  if (await fs(p)) {
    check(true, 'F enters fullscreen')
    check((await toast(p)) === 'Full screen', 'and says so', await toast(p))
    await press(p, 'f')
    await p.waitForTimeout(400)
    check(!(await fs(p)) && await inShow(p) && await cur(p) === 'S2', 'F again leaves fullscreen WITHOUT ending the show')
    check((await toast(p)) === 'In a window', 'and says so', await toast(p))
  } else {
    console.log('  skip  headless refused fullscreen — F toggle not checked')
  }

  // K: kiosk on / off mid-show
  await press(p, 'k')
  check(/^Kiosk on/.test((await toast(p)) ?? ''), 'K turns kiosk on', await toast(p))
  await p.waitForTimeout(10_800)
  check(await cur(p) === 'S3', 'kiosk advances by itself (10 s default)', await cur(p))
  await press(p, 'k')
  check((await toast(p)) === 'Kiosk off', 'K turns it off again', await toast(p))
  await p.waitForTimeout(500)

  // Esc -> the card
  await leaveShow(p)
  check(!(await inShow(p)) && await cardShown(p), 'Esc lands back on the start card')

  // kiosk from the card (1 s, loop), remembered
  await pickMode(p, 'kiosk')
  await p.fill('.ed-playsecs', '1')
  await startShow(p)
  check(await cur(p) === 'S1', 'Kiosk starts on slide 1')
  // sample the slide on screen every 50 ms for 4.4 s: S1 → S2 → S3 → S1, about a second apart
  const changes = await p.evaluate(() => new Promise((resolve) => {
    const t0 = performance.now()
    const seen = []
    let last = document.querySelector('.slidomingo-present-overlay section.present > .slidomingo-slide')?.getAttribute('data-slide-id')
    const iv = setInterval(() => {
      const id = document.querySelector('.slidomingo-present-overlay section.present > .slidomingo-slide')?.getAttribute('data-slide-id')
      if (id && id !== last) { seen.push([id, Math.round(performance.now() - t0)]); last = id }
    }, 50)
    setTimeout(() => { clearInterval(iv); resolve(seen) }, 4400)
  }))
  check(changes.map((c) => c[0]).slice(0, 3).join(',') === 'S2,S3,S1',
    'Kiosk advances by itself through the deck and loops to the first slide', changes)
  check(changes.length >= 3 && changes.slice(1).every((c, i) => { const gap = c[1] - changes[i][1]; return gap > 800 && gap < 1300 }),
    'at about one second per slide', changes)
  await leaveShow(p)
  check(await cardShown(p), 'Esc from kiosk lands on the card')
  await p.reload()
  await p.waitForSelector('.ed-playercard')
  check(await p.getAttribute('.ed-playmode[data-mode="kiosk"]', 'aria-checked') === 'true', 'the last mode is remembered across reloads')
  check(await p.inputValue('.ed-playsecs') === '1', 'and so are the kiosk seconds')

  // presenter view: ONE click opens the speaker window and starts the show; S toggles the speaker window
  await pickMode(p, 'presenter')
  const popupP = p.waitForEvent('popup', { timeout: 8000 }).catch(() => null)
  await p.click('.ed-playgo')
  const sv = await popupP
  check(!!sv, 'Presenter view: one click opens the speaker window …')
  await p.waitForSelector('.slidomingo-present-overlay section.present', { timeout: 20_000 }).catch(() => {})
  await p.waitForTimeout(600)
  check(await inShow(p) && await cur(p) === 'S1', '… and starts the show in the same click (no second click)')
  if (sv) {
    check(await sv.evaluate(() => !!document.querySelector('.sv-count')?.textContent?.includes('1 / 3')), 'the show drives the speaker window',
      await sv.evaluate(() => document.querySelector('.sv-count')?.textContent))
    check(await sv.evaluate(() => document.body.textContent.includes('notes one')), 'it shows the slide notes')
    await press(p, 'ArrowRight')
    await p.waitForTimeout(300)
    check(await sv.evaluate(() => document.querySelector('.sv-count')?.textContent?.includes('2 / 3') ?? false), 'the speaker window follows the audience window')
    // S closes it …
    await press(p, 's')
    await p.waitForTimeout(400)
    check(sv.isClosed(), 'S closes the speaker window (back to one window)')
    check((await toast(p)) === 'Speaker view off', 'and says so', await toast(p))
    // … and opens a fresh one
    const again = p.waitForEvent('popup', { timeout: 8000 }).catch(() => null)
    await press(p, 's')
    const sv2 = await again
    check(!!sv2, 'S opens it again')
    if (sv2) {
      await p.waitForTimeout(400)
      check(await sv2.evaluate(() => !!document.querySelector('.sv-count')), 'the new window is live')
      await leaveShow(p)
      await p.waitForTimeout(300)
      check(await cardShown(p), 'Esc lands back on the card')
      await sv2.close().catch(() => {})
    }
  } else {
    await leaveShow(p)
  }

  // the card must not keep a speaker window for the other modes
  await pickMode(p, 'window')
  await startShow(p)
  check(await cur(p) === 'S1', 'back to In a window: starts normally')
  await leaveShow(p)

  check(errors.length === 0, `no page errors (${name})`, errors)
  await ctx.close()

  // #present still starts the show at once
  const hctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const h = await hctx.newPage()
  await h.goto(pathToFileURL(file).href + '#present')
  await h.waitForSelector('.slidomingo-present-overlay section.present', { timeout: 30_000 })
  check(await cur(h) === 'S1', '#present starts the show without the card')
  await hctx.close()
}

/** File ▸ Export: the exported file must open on the start card.
 *  With the desktop bridge's viewer shell it is a viewer-only file; without, the editor shell + `readonly`. */
async function runExport(withViewerShell) {
  const name = withViewerShell ? 'export with the desktop viewer shell' : 'export on the web (no bridge)'
  console.log(`— ${name}`)
  const viewerHtml = readFileSync(viewerFile, 'utf8')
  const rtOf = (h) => h.match(/id="slidomingo-rt"[^>]*>([\s\S]*?)<\/script>/)?.[1]
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.addInitScript(() => { delete window.showSaveFilePicker }) // force the download fallback
  await p.goto(pathToFileURL(editorFile).href)
  await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
  await p.waitForTimeout(800)
  if (withViewerShell) await p.evaluate((html) => { window.slidomingoDesktop = { getViewerShell: async () => html } }, viewerHtml)
  await p.click('.ed-split-caret:visible')
  const download = p.waitForEvent('download', { timeout: 15_000 }).catch(() => null)
  await p.locator('.ed-save-menu button').filter({ hasText: /^Export$/ }).click()
  const dl = await download
  check(!!dl, 'Present-only file… writes a file')
  if (dl) {
    // Playwright keeps downloads under an extension-less name, which Chrome will not render as HTML
    const path = join(mkdtempSync(join(tmpdir(), 'present-modes-export-')), 'exported.beeslides.html')
    await dl.saveAs(path)
    const html = readFileSync(path, 'utf8')
    const editorRt = rtOf(readFileSync(editorFile, 'utf8'))
    check(withViewerShell ? rtOf(html) === rtOf(viewerHtml) : rtOf(html) === editorRt,
      withViewerShell ? 'it carries the VIEWER runtime' : 'it carries this page\'s own runtime', { len: html.length })
    check(/"readonly":\s*true/.test(html), 'and the deck is read-only (player file)')
    const v = await ctx.newPage()
    const verr = []
    v.on('pageerror', (e) => verr.push(e.message))
    await v.goto(pathToFileURL(path).href)
    await v.waitForSelector('.ed-playercard', { timeout: 30_000 })
    check(await cardShown(v) && !(await inShow(v)), 'the exported file opens on the start card')
    check(verr.length === 0, 'no page errors in the exported file', verr)
  }
  check(errors.length === 0, `no page errors (${name})`, errors)
  await ctx.close()
}

/** Desktop: Present-only must go through main's native Save dialog (`saveDocumentAs`, mode 'copy') —
 *  the browser file picker does not exist in Electron, which is how this once failed there. */
async function runDesktopExport() {
  console.log('— export through the desktop save dialog')
  const viewerHtml = readFileSync(viewerFile, 'utf8')
  const rtOf = (h) => h.match(/id="slidomingo-rt"[^>]*>([\s\S]*?)<\/script>/)?.[1]
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.addInitScript(() => { delete window.showSaveFilePicker }) // as in Electron: no web picker to fall back on
  await p.goto(pathToFileURL(editorFile).href)
  await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
  await p.waitForTimeout(800)
  await p.evaluate((html) => {
    window.__saveReq = null
    window.slidomingoDesktop = {
      getViewerShell: async () => html,
      saveDocumentAs: async (req) => { window.__saveReq = req; return { ok: true, path: '/tmp/x.beeslides.html', name: 'x.beeslides.html' } },
    }
  }, viewerHtml)
  await p.click('.ed-split-caret:visible')
  let downloaded = false
  p.on('download', () => { downloaded = true })
  await p.locator('.ed-save-menu button').filter({ hasText: /^Export$/ }).click()
  await p.waitForFunction(() => !!window.__saveReq, null, { timeout: 10_000 }).catch(() => {})
  const req = await p.evaluate(() => window.__saveReq)
  check(!!req, 'it asks main for the native Save dialog')
  if (req) {
    check(req.mode === 'copy', "as a copy (this window stays on its own file)", req.mode)
    check(/presentonly/.test(req.suggestedName) && /\.beeslides\.html$/.test(req.suggestedName), 'with a Present-only file name', req.suggestedName)
    check(rtOf(req.html) === rtOf(viewerHtml) && /"readonly":\s*true/.test(req.html), 'and the viewer-only shell carrying a read-only deck')
    check(/^\s*<!doctype html/i.test(req.html) && /<\/html>\s*$/i.test(req.html), "in a form main's looksLikeShell accepts")
  }
  check(!downloaded, 'nothing is pushed through the browser download path')
  const toastText = await p.evaluate(() => document.querySelector('.ed-toast')?.textContent ?? null)
  check(!toastText || !/couldn.t save|saving failed/i.test(toastText), 'no failure toast', toastText)
  check(errors.length === 0, 'no page errors (desktop export)', errors)
  await ctx.close()
}

try {
  // the base doc comes from the editor shell
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(pathToFileURL(editorFile).href)
  await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
  const base = await p.evaluate(() => JSON.parse(JSON.stringify(window.slidomingo.doc)))
  await ctx.close()
  const deck = buildDeck(base)
  const dir = mkdtempSync(join(tmpdir(), 'present-modes-e2e-'))
  const viewerCopy = join(dir, 'viewer.beeslides.html')
  const editorCopy = join(dir, 'editor.beeslides.html')
  writeFileSync(viewerCopy, splice(readFileSync(viewerFile, 'utf8'), deck))
  writeFileSync(editorCopy, splice(readFileSync(editorFile, 'utf8'), deck))
  await runShell('viewer-only shell', viewerCopy)
  await runShell('editor shell, readonly doc', editorCopy)
  await runExport(true)
  await runExport(false)
  await runDesktopExport()
} catch (e) {
  fails++
  console.log('FAIL (exception)', e?.stack ?? e)
} finally {
  await browser.close()
}
console.log(`\ntest-present-modes-e2e: ${passes}/${passes + fails} checks passed`)
process.exit(fails ? 1 : 0)
