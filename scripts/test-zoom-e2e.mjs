#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Slide / Section / Summary Zoom in a real (headless) browser — present.ts's
// zoom stack, the camera (zoom.ts), the tile renderer and the editor side,
// which scripts/test-zoom.ts (pure logic) cannot see.
//
//   node scripts/test-zoom-e2e.mjs [editor-url] [--viewer viewer-file] [--shots dir]
//
// editor-url defaults to slides/dist-single/BeeSlides.beeslides.html;
// the viewer part runs the core flow again on
// slides/dist-viewer/BeeSlides_Viewer.beeslides.html (the doc is spliced
// into a temp copy, which boots straight into the show). Needs playwright-core
// ($PLAYWRIGHT_CORE, the package, or the npx cache); without one or without
// a build it SKIPS with exit 0 and says so.
//
// Editor shell (manual animation clock, "Present in this tab"):
//   tile click → the target is mid-zoom (a ghost of the overview under a
//   scaled target) → target current → → walks the range (hidden slides too)
//   → past the end zooms out to the overview with its click step restored;
//   ← on the range start zooms out; a jump out of the range drops the zoom;
//   nested zooms unwind one level at a time; returnToZoom:false carries on;
//   reduced motion cuts; Enter on a focused tile zooms; kiosk advances
//   through a zoom and back; loop still wraps; the speaker view previews
//   "Back to zoom". Editor: the tile renders a nested slide whose nodes carry
//   no data-el-id, a marquee selects only the tile, Insert ▸ Summary zoom adds
//   one overview slide (one undo step), deleting a target prunes its tile.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined }
const shots = opt('--shots')
const viewerArg = opt('--viewer')
if (shots) mkdirSync(shots, { recursive: true })

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

const skip = (why) => { console.log(`test-zoom-e2e: SKIP — ${why}`); process.exit(0) }
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const viewerFile = viewerArg ?? join(root, 'slides/dist-viewer/BeeSlides_Viewer.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : null)
if (!url) skip('no build (npm run build:single in slides/) and no url given')
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

// ---- the deck -----------------------------------------------------------------
// O  overview: a click-built note (step 1) + tiles: A (section, 3 slides incl. a
//    hidden one), D (slide, returnToZoom:false), N (section holding its own
//    tile into Z — a nested zoom)
// | A1 a2(hidden) A3 | D E | N M | Z
const text = (id, html, extra = {}) => ({
  id, type: 'text', x: 80, y: 60, w: 1120, h: 110, rotation: 0, opacity: 1, html, fontSize: 56,
  fontFamily: 'system-ui, sans-serif', fontWeight: 700, color: '#1D1119', align: 'left', valign: 'middle', lineHeight: 1.2, ...extra,
})
const tile = (id, target, x, extra = {}) => ({
  id, type: 'zoom', x, y: 300, w: 320, h: 180, rotation: 0, opacity: 1, target, stroke: '#888888', strokeWidth: 3, radius: 6, ...extra,
})
const slide = (id, bg, elements, extra = {}) => ({ id, background: bg, transition: 'fade', elements, notes: '', ...extra })
function buildDeck(base, mods = {}) {
  const d = JSON.parse(JSON.stringify(base))
  d.slides = [
    slide('O', '#FFFFFF', [
      text('t-O', 'Overview', { role: 'title' }),
      text('note', 'Pick a part', { y: 560, h: 80, fontSize: 32, fx: { step: 1 } }),
      tile('zA', { section: 'secA' }, 60),
      tile('zD', { slide: 'D' }, 480, { returnToZoom: false }),
      tile('zN', { section: 'secN' }, 900),
    ]),
    slide('A1', '#FDE2E4', [text('t-A1', 'A one', { role: 'title' })]),
    slide('a2', '#FAD2E1', [text('t-a2', 'A two (hidden)')], { hidden: true }),
    slide('A3', '#E2ECE9', [text('t-A3', 'A three')]),
    slide('D', '#BEE1E6', [text('t-D', 'D')]),
    slide('E', '#F0EFEB', [text('t-E', 'E')]),
    slide('N', '#DFE7FD', [text('t-N', 'N holds a zoom'), tile('zZ', { slide: 'Z' }, 480)]),
    slide('M', '#CDDAFD', [text('t-M', 'M')]),
    slide('Z', '#FFF1E6', [text('t-Z', 'Z')]),
  ]
  d.sections = [
    { id: 'secA', name: 'Part A', startSlideId: 'A1' },
    { id: 'secB', name: 'Part D', startSlideId: 'D' },
    { id: 'secN', name: 'Part N', startSlideId: 'N' },
    { id: 'secZ', name: 'Part Z', startSlideId: 'Z' },
  ]
  d.present = { ...(d.present ?? {}), ...mods }
  return d
}

// ---- show helpers (both shells) --------------------------------------------------
const cur = (p) => p.evaluate(() =>
  document.querySelector('.slidomingo-present-overlay section.present > .slidomingo-slide')?.getAttribute('data-slide-id') ?? null)
const ghost = (p) => p.evaluate(() => !!document.querySelector('.slidomingo-present-overlay .slidomingo-zoom-ghost'))
/** width of the present surface relative to its section (1 = at rest) */
const surfaceScale = (p) => p.evaluate(() => {
  const s = document.querySelector('.slidomingo-present-overlay section.present')
  const surf = s?.querySelector(':scope > .slidomingo-slide')
  if (!s || !surf) return null
  return surf.getBoundingClientRect().width / s.getBoundingClientRect().width
})
const noteVisible = (p) => p.evaluate(() => {
  const n = document.querySelector('.slidomingo-present-overlay section [data-slide-id="O"] [data-el-id="note"]')
  return n ? getComputedStyle(n).visibility !== 'hidden' : null
})
const clickTile = async (p, id) => {
  const box = await p.evaluate((tid) => {
    const n = document.querySelector(`.slidomingo-present-overlay section.present [data-el-id="${tid}"]`)
    const r = n?.getBoundingClientRect()
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
  }, id)
  if (!box) return false
  await p.mouse.click(box.x, box.y)
  return true
}

try {
  // ================================================================ editor shell
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(url)
  await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
  await p.waitForTimeout(600)
  // headless leaves the finished boot splash in the flow (same on main) — it only gets in the screenshots' way
  await p.evaluate(() => document.getElementById('slidomingo-splash')?.remove())
  const base = await p.evaluate(() => JSON.parse(JSON.stringify(window.slidomingo.doc)))
  const load = async (doc) => {
    await p.evaluate((json) => window.slidomingo.loadDoc(json), JSON.stringify(doc))
    await p.waitForTimeout(300)
  }
  await load(buildDeck(base))

  console.log('— editor: the tile')
  {
    const r = await p.evaluate(() => {
      const tileNode = document.querySelector('.ed-stage-scale [data-el-id="zA"]')
      const inner = tileNode?.querySelector('.slidomingo-zoom-inner')
      const nested = inner ? [...inner.querySelectorAll('*')] : []
      return {
        tile: !!tileNode,
        inner: !!inner,
        nestedHasText: !!inner?.textContent?.includes('A one'),
        noDataAttrs: nested.every((n) => ![...n.attributes].some((a) => a.name.startsWith('data-'))) && !!inner && ![...inner.attributes].some((a) => a.name.startsWith('data-')),
        inert: inner?.hasAttribute('inert') && inner.getAttribute('aria-hidden') === 'true',
        frame: !!tileNode?.querySelector('.slidomingo-zoom-frame'),
        missing: !!document.querySelector('.ed-stage-scale .slidomingo-zoom-missing'),
      }
    })
    check(r.tile && r.inner && r.nestedHasText, 'a tile renders its cover slide nested', r)
    check(r.noDataAttrs && r.inert, 'the nested picture carries no data-* attributes and is inert', r)
    check(r.frame && !r.missing, 'the frame is drawn; no "target missing" box', r)
    if (shots) {
      await p.evaluate(() => window.slidomingo.select?.([]))
      await p.screenshot({ path: join(shots, 'editor-overview-tiles.png') })
    }
  }

  console.log('— editor: a marquee selects only the tile')
  {
    const box = await p.evaluate(() => {
      const r = document.querySelector('.ed-stage-scale [data-el-id="zA"]')?.getBoundingClientRect()
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
    })
    if (box) {
      await p.mouse.move(box.x - 12, box.y - 12)
      await p.mouse.down()
      await p.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.6, { steps: 8 })
      await p.mouse.move(box.x + box.w + 10, box.y + box.h + 10, { steps: 8 })
      await p.mouse.up()
      await p.waitForTimeout(200)
    }
    const sel = await p.evaluate(() => window.slidomingo.selection)
    check(JSON.stringify(sel) === JSON.stringify(['zA']), 'marquee over a tile selects the tile, nothing nested', sel)
    if (shots && sel.length === 1) {
      // the properties panel for a zoom tile
      const head = await p.$('.ed-section[data-key="Zoom tile"] button')
      if (head && (await head.getAttribute('aria-expanded')) !== 'true') await head.click()
      await p.waitForTimeout(250)
      const panel = await p.$('.ed-props')
      if (panel) await panel.screenshot({ path: join(shots, 'zoom-properties-panel.png') })
    }
    const panelText = await p.evaluate(() => document.querySelector('.ed-props')?.textContent ?? '')
    check(/Section: Part A/.test(panelText) && /Return to zoom/.test(panelText) && !/Link to/.test(panelText),
      'the panel shows the target and Return to zoom, and no "Link to"', panelText.slice(0, 200))
  }

  console.log('— editor: Insert ▸ Summary zoom')
  {
    const before = await p.evaluate(() => window.slidomingo.doc.slides.length)
    await p.evaluate(() => window.slidomingo.menu.run('insert.summaryZoom'))
    await p.waitForSelector('.ed-zoompick', { timeout: 5000 })
    await p.click('.ed-zoompick-tabs button[data-tab="sections"]')
    await p.click('.ed-zoompick-card[data-key="section:secB"]')
    await p.click('.ed-zoompick-card[data-key="section:secZ"]')
    if (shots) await (await p.$('.ed-zoompick'))?.screenshot({ path: join(shots, 'zoom-picker.png') })
    await p.click('.ed-zoompick .ed-btn-primary')
    await p.waitForTimeout(400)
    const r = await p.evaluate(() => {
      const d = window.slidomingo.doc
      const i = d.slides.findIndex((s) => s.elements.filter((e) => e.type === 'zoom').length === 2 && s.id !== 'O')
      const s = d.slides[i]
      return {
        n: d.slides.length, at: i, nextId: d.slides[i + 1]?.id,
        targets: s?.elements.filter((e) => e.type === 'zoom').map((e) => e.target.section),
        section: (d.sections ?? []).find((x) => x.startSlideId === s?.id)?.name,
      }
    })
    check(r.n === before + 1 && r.nextId === 'D' && JSON.stringify(r.targets) === '["secB","secZ"]' && !!r.section,
      'one overview slide before the first picked section, one tile per section, its own section', r)
    await p.evaluate(() => window.slidomingo.undo())
    await p.waitForTimeout(200)
    const after = await p.evaluate(() => ({ n: window.slidomingo.doc.slides.length, secs: window.slidomingo.doc.sections.length }))
    check(after.n === before && after.secs === 4, 'one undo takes the whole summary zoom back', after)
  }

  console.log('— editor: deleting a target prunes its tile')
  {
    const r = await p.evaluate(() => {
      const d = JSON.parse(JSON.stringify(window.slidomingo.doc))
      return d.slides.find((s) => s.id === 'N').elements.some((e) => e.id === 'zZ')
    })
    // delete slide Z through the slide panel (focus the sidebar thumb, Delete; confirm the impact dialog)
    p.once('dialog', (dl) => dl.accept())
    const thumb = await p.$('.ed-sidebar [data-slide-id="Z"]')
    if (thumb) { await thumb.click(); await p.keyboard.press('Delete'); await p.waitForTimeout(300) }
    const after = await p.evaluate(() => {
      const d = window.slidomingo.doc
      return { z: d.slides.some((s) => s.id === 'Z'), tile: d.slides.find((s) => s.id === 'N')?.elements.some((e) => e.id === 'zZ') }
    })
    check(r && !after.z && after.tile === false, 'the slide is gone and so is the tile that zoomed into it', after)
    await p.evaluate(() => window.slidomingo.undo())
    await p.waitForTimeout(200)
  }

  // ---------------------------------------------------------------- the show
  const present = async (doc) => {
    await load(doc)
    await p.evaluate(() => { window.slidomingo.anim.setManual(true) })
    await p.evaluate(() => { try { localStorage.setItem('slidomingo-reduce-motion', 'off') } catch {} })
    await p.click('button[title="More ways to present"]:visible')
    await p.click('button:has-text("Present in this tab"):visible')
    await p.waitForSelector('.slidomingo-present-overlay section.present', { timeout: 10_000 })
    await p.waitForTimeout(400)
  }
  const tick = (s) => p.evaluate((sec) => window.slidomingo.anim.tick(sec), s)
  const key = async (k) => { await p.keyboard.press(k); await p.waitForTimeout(60) }
  const exitShow = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(300) }

  console.log('— show: zoom in, walk, zoom out')
  await present(buildDeck(base))
  {
    check(await cur(p) === 'O', 'the show starts on the overview')
    await key('ArrowRight') // click 1 on the overview
    await tick(1)
    check(await noteVisible(p) === true, 'the overview is at click 1')
    check(await clickTile(p, 'zA'), 'tile A is on screen')
    await p.waitForTimeout(80)
    check(await cur(p) === 'A1', 'a click on a section tile lands on its first slide')
    check(await ghost(p), 'a ghost of the overview is under the arriving slide')
    await tick(0.5)
    const mid = await surfaceScale(p)
    check(mid !== null && mid > 0.3 && mid < 0.95, 'mid-zoom the target is between tile size and full size', mid)
    if (shots) await p.screenshot({ path: join(shots, 'present-mid-zoom.png') })
    await tick(1)
    check(!(await ghost(p)) && Math.abs((await surfaceScale(p)) - 1) < 0.01, 'the zoom ends at rest, ghost gone', await surfaceScale(p))
    await key('ArrowRight')
    check(await cur(p) === 'a2', '→ walks into the hidden slide of the section')
    await key('ArrowRight')
    check(await cur(p) === 'A3', '→ again')
    await key('ArrowRight')
    check(await cur(p) === 'O' && await ghost(p), '→ past the end zooms back out to the overview')
    await tick(1.2)
    check(await noteVisible(p) === true, "the overview is back at the click it was left on")
    // ← at the start of a range
    await clickTile(p, 'zA')
    await tick(1.2)
    await key('ArrowLeft')
    check(await cur(p) === 'O', '← on the first slide of the range zooms out')
    await tick(1.2)
  }

  console.log('— show: leaving the range drops the zoom')
  {
    await clickTile(p, 'zA')
    await tick(1.2)
    await key('4'); await key('Enter') // slide number 4 = D
    await tick(1.2)
    check(await cur(p) === 'D', 'number + Enter jumps out of the range')
    await key('ArrowRight')
    check(await cur(p) === 'E', '→ carries on in the normal flow (the zoom is gone)')
    await key('ArrowLeft')
    check(await cur(p) === 'D', '← too')
  }

  console.log('— show: nested zoom, returnToZoom:false')
  {
    await key('Home'); await tick(1.2)
    // back on O (Reveal's Home); its click state may be anything — just zoom
    check(await cur(p) === 'O', 'Home goes back to the overview')
    await clickTile(p, 'zN'); await tick(1.2)
    check(await cur(p) === 'N', 'into section N')
    await clickTile(p, 'zZ'); await tick(1.2)
    check(await cur(p) === 'Z', 'a tile inside a zoomed range zooms again (nested)')
    await key('ArrowRight'); await tick(1.2)
    check(await cur(p) === 'N', '→ at the inner range end returns to the inner overview')
    await key('ArrowRight'); await tick(1.2)
    check(await cur(p) === 'M', '→ continues the outer range')
    await key('ArrowRight'); await tick(1.2)
    check(await cur(p) === 'O', '→ past the outer range returns to the outer overview')
    await clickTile(p, 'zD'); await tick(1.2)
    check(await cur(p) === 'D', 'returnToZoom:false still zooms in')
    await key('ArrowRight'); await tick(1.2)
    check(await cur(p) === 'E', '…and then simply carries on')
  }

  console.log('— show: Enter on a focused tile; speaker preview')
  {
    await key('Home'); await tick(1.2)
    await p.evaluate(() => document.querySelector('.slidomingo-present-overlay section.present [data-el-id="zA"]')?.focus())
    const role = await p.evaluate(() => {
      const n = document.activeElement
      return { role: n?.getAttribute('role'), label: n?.getAttribute('aria-label'), tab: n?.tabIndex }
    })
    check(role.role === 'button' && role.tab === 0 && /A one/.test(role.label ?? ''), 'a tile is a focusable button named after its target', role)
    await key('Enter'); await tick(1.2)
    check(await cur(p) === 'A1', 'Enter on a focused tile zooms')
    const popupP = p.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
    await key('s')
    const sv = await popupP
    if (sv) {
      await key('ArrowRight'); await key('ArrowRight') // → A3, the last slide of the range
      await p.waitForTimeout(200)
      const label = await sv.evaluate(() => document.querySelector('.sv-next-wrap .sv-label')?.textContent)
      check(label === 'Back to zoom', 'the speaker view previews "Back to zoom" on the range\'s last slide', label)
      const nextBg = await sv.evaluate(() => document.querySelector('.sv-nextbox .slidomingo-slide')?.getAttribute('data-slide-id'))
      check(nextBg === 'O', 'and shows the overview as the next slide', nextBg)
      await sv.close()
    } else check(false, 'the speaker view opens')
  }
  await exitShow()

  console.log('— show: reduced motion cuts')
  await present(buildDeck(base))
  {
    await key('m') // reduced motion on (toast)
    await clickTile(p, 'zA')
    await p.waitForTimeout(80)
    check(await cur(p) === 'A1' && !(await ghost(p)), 'with reduced motion the zoom is a cut (no ghost)')
    await key('ArrowLeft')
    check(await cur(p) === 'O' && !(await ghost(p)), 'and so is the way back')
    await key('m')
  }
  await exitShow()

  console.log('— show: kiosk and loop')
  await present(buildDeck(base, { autoAdvance: 2, loop: true }))
  {
    await clickTile(p, 'zN'); await tick(1.2)
    check(await cur(p) === 'N', 'kiosk deck: into section N')
    await tick(2.2)
    check(await cur(p) === 'M', 'the kiosk timer walks the range')
    await tick(2.2)
    check(await cur(p) === 'O', 'and zooms back out at its end')
    // loop: → from the last slide wraps (no zoom in play)
    await key('8'); await key('Enter'); await tick(1.2) // slide 8 = Z
    check(await cur(p) === 'Z', 'on the last slide')
    await key('ArrowRight'); await tick(1.2)
    check(await cur(p) === 'O', 'a looping deck still wraps to the first slide')
  }
  await exitShow()
  check(errors.length === 0, 'no page errors in the editor shell', errors)
  await ctx.close()

  // ================================================================ viewer shell
  console.log('— viewer shell: the core flow again')
  if (!existsSync(viewerFile)) check(false, 'viewer build exists (npm run build:viewer)', viewerFile)
  else {
    const html = readFileSync(viewerFile, 'utf8')
    const deck = buildDeck({ ...base, readonly: true })
    deck.slides.forEach((s) => s.elements.forEach((e) => { if (e.type === 'zoom') e.duration = 3 }))
    const json = JSON.stringify(deck).replace(/</g, '\\u003c')
    const spliced = html.replace(/(<script type="application\/slidomingo\+json" id="slidomingo-doc">)(<\/script>)/, `$1${json}$2`)
    check(spliced !== html, 'the doc splices into the viewer shell')
    const dir = mkdtempSync(join(tmpdir(), 'zoom-e2e-'))
    const file = join(dir, 'deck.beeslides.html')
    writeFileSync(file, spliced)
    const vctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const v = await vctx.newPage()
    const verr = []
    v.on('pageerror', (e) => verr.push(e.message))
    await v.addInitScript(() => { try { localStorage.setItem('slidomingo-reduce-motion', 'off') } catch {} })
    // the viewer opens on its start card (no autostart); "In a window" needs no fullscreen grant
    await v.addInitScript(() => { try { localStorage.setItem('slidomingo-present-mode', 'window') } catch {} })
    await v.goto(pathToFileURL(file).href)
    await v.click('.ed-playgo', { timeout: 20_000 })
    await v.waitForSelector('.slidomingo-present-overlay section.present', { timeout: 20_000 })
    await v.waitForTimeout(800)
    check(await cur(v) === 'O', 'the viewer starts the show on the overview')
    await clickTile(v, 'zA')
    await v.waitForTimeout(900)
    const mid = await surfaceScale(v)
    check(await cur(v) === 'A1' && await ghost(v) && mid > 0.2 && mid < 0.98, 'viewer: mid-zoom into section A', mid)
    await v.waitForTimeout(2600)
    check(!(await ghost(v)) && Math.abs((await surfaceScale(v)) - 1) < 0.01, 'viewer: the zoom lands')
    for (const k of ['ArrowRight', 'ArrowRight', 'ArrowRight']) { await v.keyboard.press(k); await v.waitForTimeout(120) }
    check(await cur(v) === 'O', 'viewer: → past the range zooms back out to the overview')
    await v.waitForTimeout(3200)
    await clickTile(v, 'zA')
    await v.waitForTimeout(3300)
    await v.keyboard.press('ArrowLeft')
    await v.waitForTimeout(120)
    check(await cur(v) === 'O', 'viewer: ← on the range start zooms out')
    check(verr.length === 0, 'no page errors in the viewer shell', verr)
    await vctx.close()
  }
} catch (e) {
  fails++
  console.log('FAIL (exception)', e?.stack ?? e)
} finally {
  await browser.close()
}
console.log(`\ntest-zoom-e2e: ${passes}/${passes + fails} checks passed`)
process.exit(fails ? 1 : 0)
