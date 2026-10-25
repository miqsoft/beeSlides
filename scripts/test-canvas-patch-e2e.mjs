#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The editor canvas's incremental redraw (canvas.ts render('patch'),
// editor/canvaspatch.ts) in a real browser:
//   node scripts/test-canvas-patch-e2e.mjs [url]
// url defaults to the built editor, slides/dist-single/BeeSlides.beeslides.html
// (npm run build:single first); pass http://localhost:<port>/ for a dev server.
// Needs playwright-core: $PLAYWRIGHT_CORE (path to its index.mjs), the
// package itself, or the npx cache. Without one (or without a build) it
// SKIPS with exit 0 and says so.
//
// After every sequence below the canvas DOM must equal a FRESH full render of
// the same state (switching to another slide and back draws in full): a live
// colour drag (one step per frame and several), nudges of a shape, a
// container (its children follow) and a connector's end shape (the connector
// follows), a hover-reveal set, a table cell edit, a text edit, an equation
// edit, crop mode opened and cancelled, svg gradients (ids unique, every
// url(#…) resolves), undo/redo. Also: an edit keeps the slide surface (only
// element nodes are redrawn), an undo that switches slides draws the surface
// once (not twice).
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

const skip = (why) => { console.log(`test-canvas-patch-e2e: SKIP — ${why}`); process.exit(0) }

const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = process.argv[2] ?? (existsSync(built) ? pathToFileURL(built).href : null)
if (!url) skip('no build (npm run build:single in slides/) and no url given')
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')

let browser
try { browser = await chromium.launch() } catch (e) { skip(`no browser: ${String(e.message).split('\n')[0]}`) }

let fails = 0
let passes = 0
const check = (ok, label, detail) => {
  if (ok) { passes++; console.log(`  ok    ${label}`) }
  else { fails++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 600)}`) }
}

// ---- the deck: one busy slide (40 elements) + an empty second one --------------
function elements() {
  const B = { rotation: 0, opacity: 1 }
  const T = (id, x, y, w, h, html, extra = {}) => ({ id, type: 'text', x, y, w, h, ...B, html, fontSize: 20, fontFamily: '', fontWeight: 400, color: '#222222', align: 'left', valign: 'top', lineHeight: 1.2, ...extra })
  const S = (id, shape, x, y, w, h, fill, extra = {}) => ({ id, type: 'shape', shape, x, y, w, h, ...B, fill, stroke: '#333333', strokeWidth: 2, radius: 0, ...extra })
  const els = []
  els.push(S('bg', 'rect', 0, 0, 1280, 720, '#f4f6fb', { strokeWidth: 0, stroke: 'none' }))
  els.push(T('title', 60, 20, 900, 60, 'Canvas patch', { fontSize: 40, role: 'title' }))
  for (let i = 0; i < 8; i++) els.push(T(`t${i}`, 60 + (i % 4) * 290, 100 + Math.floor(i / 4) * 50, 270, 40, `Text <b>${i}</b> with some words`))
  for (let i = 0; i < 10; i++) {
    const g = i < 3 ? { fillGradient: { angle: 90, stops: [{ at: 0, color: '#ff8a00' }, { at: 1, color: '#e52e71' }] } } : {}
    els.push(S(`s${i}`, i % 3 === 1 ? 'ellipse' : 'rect', 60 + i * 115, 220, 90, 70, `hsl(${i * 36}, 70%, 60%)`, g))
  }
  els.push(S('g1', 'ellipse', 1060, 100, 60, 60, '#a855f7', { groupId: 'grp' }))
  els.push(S('g2', 'ellipse', 1180, 100, 60, 60, '#ec4899', { groupId: 'grp' }))
  els.push(S('conn', 'line', 1090, 130, 120, 1, 'transparent', { from: { el: 'g1' }, to: { el: 'g2' }, lineEnd: 'arrow' }))
  els.push(S('box', 'rect', 60, 330, 400, 200, '#ffffff', { container: true }))
  els.push(S('kid1', 'rect', 80, 350, 120, 60, '#3b82f6', { parentId: 'box', parentOffset: { relX: 0.05, relY: 0.1, relW: 0.3, relH: 0.3 } }))
  els.push(T('kid2', 80, 430, 300, 40, 'Child text', { parentId: 'box', parentOffset: { relX: 0.05, relY: 0.5, relW: 0.75, relH: 0.2 } }))
  const rows = Array.from({ length: 3 }, (_, r) => ({ cells: Array.from({ length: 3 }, (_, c) => ({ html: r === 1 && c === 1 ? '$x^2$' : `r${r}c${c}` })) }))
  els.push({ id: 'tbl', type: 'table', x: 500, y: 330, w: 360, h: 160, ...B, header: true, columns: [{ w: 1 }, { w: 1 }, { w: 1 }], rows,
    style: { headerBg: '#333', headerColor: '#fff', borderColor: '#999', borderWidth: 1, cellPadX: 6, cellPadY: 4, fontSize: 16, color: '#111', radius: 0 } })
  els.push({ id: 'chart', type: 'chart', x: 900, y: 330, w: 340, h: 200, ...B, preset: 'bar',
    option: { xAxis: { type: 'category', data: ['a', 'b', 'c'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [3, 5, 2] }] } })
  els.push({ id: 'eq', type: 'math', x: 60, y: 550, w: 260, h: 80, ...B, tex: '\\frac{a}{b}', fontSize: 36, color: '#1E3A8A' })
  els.push(T('pg', 340, 560, 300, 40, 'Page {{page}} of {{pages}}'))
  els.push(S('h1', 'rect', 680, 550, 100, 60, '#10b981', { showOnHover: 'a' }))
  els.push(S('h2', 'rect', 800, 550, 100, 60, '#f59e0b', { showOnHover: 'b' }))
  els.push(T('h3', 680, 620, 220, 40, 'Hover A text', { showOnHover: 'a' }))
  els.push({ id: 'art', type: 'svg', x: 940, y: 550, w: 120, h: 120, ...B,
    markup: '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><circle cx="5" cy="5" r="4" fill="url(#g1)"/></svg>' })
  const pic = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#6366f1"/></svg>'
  els.push({ id: 'pic', type: 'image', x: 1080, y: 550, w: 120, h: 90, ...B, fit: 'cover', radius: 6, src: 'data:image/svg+xml;base64,' + Buffer.from(pic).toString('base64') })
  let n = 0
  while (els.length < 40) { els.push(S(`f${n}`, 'rect', 940 + (n % 2) * 60, 20 + Math.floor(n / 2) * 25, 40, 18, '#94a3b8')); n++ }
  return els
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(url)
  await p.waitForFunction(() => !!window.beeslides?.loadDoc, null, { timeout: 60_000 })
  await p.waitForTimeout(800)
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.beeslides.doc))
    const s0 = d.slides[0]
    d.slides = [{ ...s0, id: 'S1', elements: els, notes: '' }, { ...s0, id: 'S2', elements: [], notes: '' }]
    window.beeslides.loadDoc(JSON.stringify(d))
  }, elements())
  const settle = (ms = 200) => p.waitForTimeout(ms)
  await settle(500)

  const model = (id) => p.evaluate((id) => {
    for (const s of window.beeslides.doc.slides) { const el = s.elements.find((e) => e.id === id); if (el) return el }
    return null
  }, id)
  const center = (id) => p.evaluate((id) => {
    const r = document.querySelector(`.ed-stage-scale .beeslides-el[data-el-id="${id}"]`).getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, id)
  const select = async (id) => { const c = await center(id); await p.mouse.click(c.x, c.y, { delay: 60 }); await settle() }
  const blank = async () => { const b = await p.locator('.ed-stage').boundingBox(); await p.mouse.click(b.x - 20, b.y + 8, { delay: 60 }); await settle() }

  /** The surface as markup, minus selection decoration; per-render svg ids
   *  (gradients, markers) numbered by first appearance. */
  const surfaceHtml = () => p.evaluate(() => {
    const s = document.querySelector('.ed-stage-scale > .beeslides-slide')
    const c = s.cloneNode(true)
    c.querySelectorAll('[data-sel]').forEach((n) => n.removeAttribute('data-sel'))
    c.querySelectorAll('.beeslides-col-handle').forEach((n) => n.remove())
    c.querySelectorAll('.beeslides-cell-sel').forEach((n) => n.classList.remove('beeslides-cell-sel'))
    c.querySelectorAll('[class=""]').forEach((n) => n.removeAttribute('class'))
    const ids = new Map()
    return c.outerHTML.replace(/beeslides-(grad|mark)-\d+/g, (m, kind) => {
      if (!ids.has(m)) ids.set(m, `${kind}-${ids.size}`)
      return ids.get(m)
    })
  })
  const thumb = (i) => p.locator(`.ed-sidebar .ed-thumb[data-index="${i}"]`).first()
  /** compare the canvas against a full render of the same state */
  const sameAsFull = async (label) => {
    const patched = await surfaceHtml()
    await thumb(1).click({ delay: 60 }); await settle(150)
    await thumb(0).click({ delay: 60 }); await settle(250)
    const full = await surfaceHtml()
    let at = 0
    while (at < patched.length && patched[at] === full[at]) at++
    check(patched === full, `${label}: canvas equals a fresh full render`,
      patched === full ? undefined : { at, patched: patched.slice(Math.max(0, at - 120), at + 200), full: full.slice(Math.max(0, at - 120), at + 200) })
  }
  const markSurface = () => p.evaluate(() => { document.querySelector('.ed-stage-scale > .beeslides-slide').__mark = 1 })
  const surfaceKept = () => p.evaluate(() => document.querySelector('.ed-stage-scale > .beeslides-slide').__mark === 1)
  const nodeFill = (id) => p.evaluate((id) => document.querySelector(`.ed-stage-scale .beeslides-el[data-el-id="${id}"] svg > rect, .ed-stage-scale .beeslides-el[data-el-id="${id}"] svg > ellipse`)?.getAttribute('fill'), id)

  await sameAsFull('fresh deck')

  // 1) a live colour drag ---------------------------------------------------------
  console.log('\ncolour drag')
  await select('s5')
  await markSurface()
  await p.locator('.ed-props .ed-color-trigger:visible').first().click()
  await settle()
  const live = await p.evaluate(async () => {
    const col = document.querySelector('.ed-color-pop input[type=color]')
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    const shown = []
    let k = 0
    for (const perFrame of [1, 1, 1, 4, 4, 4]) {
      await raf()
      for (let j = 0; j < perFrame; j++, k++) {
        col.value = '#' + ((k * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')
        col.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await raf()
      shown.push([col.value, document.querySelector('.ed-stage-scale .beeslides-el[data-el-id="s5"] svg > rect')?.getAttribute('fill')])
    }
    col.value = '#123456'
    col.dispatchEvent(new Event('change', { bubbles: true }))
    return shown
  })
  check(live.every(([want, got]) => want === got), 'every frame of the drag shows the live colour', live)
  check((await model('s5')).fill === '#123456' && await nodeFill('s5') === '#123456', 'the final colour lands in the model and on the canvas')
  check(await surfaceKept(), 'the drag redrew element nodes only (same slide surface)')
  await p.keyboard.press('Escape')
  await sameAsFull('after the colour drag')

  // 2) nudges: a shape, a container, a connector's end ------------------------------
  console.log('\nnudges')
  await select('s3')
  await markSurface()
  const x3 = (await model('s3')).x
  await p.keyboard.press('ArrowRight'); await settle(100)
  await p.keyboard.press('ArrowDown'); await settle(150)
  check((await model('s3')).x > x3, 'arrow keys moved the shape', [(await model('s3')).x, x3])
  check(await surfaceKept(), 'a nudge keeps the slide surface')
  await sameAsFull('after nudging a shape')
  // the container's own corner (its middle is under its children)
  const boxR = await p.evaluate(() => { const r = document.querySelector('.ed-stage-scale .beeslides-el[data-el-id="box"]').getBoundingClientRect(); return { x: r.right - 12, y: r.bottom - 12 } })
  await p.mouse.click(boxR.x, boxR.y, { delay: 60 }); await settle()
  check((await p.evaluate(() => window.beeslides.selection)).join() === 'box', 'the container is selected', await p.evaluate(() => window.beeslides.selection))
  const kidX = (await model('kid1')).x
  await p.keyboard.press('Shift+ArrowRight'); await settle(200)
  check((await model('kid1')).x > kidX, 'the container\'s child followed it', [(await model('kid1')).x, kidX])
  await sameAsFull('after nudging a container')
  // a mouse drag of the selected container: the children ride along live
  await p.mouse.click(boxR.x, boxR.y, { delay: 60 }); await settle()
  const kidLeft = () => p.evaluate(() => document.querySelector('.ed-stage-scale .beeslides-el[data-el-id="kid1"]').getBoundingClientRect().left)
  const k0 = await kidLeft()
  await p.mouse.move(boxR.x, boxR.y); await p.mouse.down()
  await p.mouse.move(boxR.x + 30, boxR.y + 5, { steps: 5 }); await settle(50)
  const kMid = await kidLeft()
  await p.mouse.move(boxR.x + 60, boxR.y + 10, { steps: 5 }); await p.mouse.up(); await settle()
  check(kMid > k0 + 10, 'the child follows the container live, mid-drag', [k0, kMid])
  check((await model('kid1')).x > kidX + 30, 'and its frame is committed with the container', [(await model('kid1')).x, kidX])
  await sameAsFull('after dragging a container')
  await select('g2')
  const conn0 = JSON.stringify(await model('conn'))
  await p.keyboard.press('Shift+ArrowDown'); await settle(200)
  check(JSON.stringify(await model('conn')) !== conn0, 'the connector was re-derived from its moved end shape')
  await sameAsFull('after moving a connector end (group)')

  // 3) hover-reveal set ---------------------------------------------------------------
  console.log('\nhover sets')
  const vis = () => p.evaluate(() => ['h1', 'h2', 'h3'].map((id) => document.querySelector(`.ed-stage-scale .beeslides-el[data-el-id="${id}"]`).style.display !== 'none'))
  check(JSON.stringify(await vis()) === JSON.stringify([true, false, true]), 'only the default hover set shows', await vis())
  await select('h1')
  await p.keyboard.press('ArrowLeft'); await settle(150)
  check(JSON.stringify(await vis()) === JSON.stringify([true, false, true]), 'a patched hover element keeps its set\'s visibility', await vis())
  await sameAsFull('after editing a hover-set element')

  // 4) table cell edit -----------------------------------------------------------------
  console.log('\ntable')
  await select('tbl')
  const td = p.locator('.ed-stage-scale [data-el-id="tbl"] td[data-r="2"][data-c="0"]')
  await td.click({ delay: 60, position: { x: 8, y: 8 } }); await settle()
  await td.dblclick({ delay: 60, position: { x: 8, y: 8 } }); await settle()
  await p.keyboard.press('End')
  await p.keyboard.type('Z')
  await blank()
  check((await model('tbl')).rows[2].cells[0].html.includes('Z'), 'the cell edit committed', (await model('tbl')).rows[2].cells[0].html)
  await sameAsFull('after a table cell edit')

  // 5) text edit ------------------------------------------------------------------------
  console.log('\ntext')
  await select('t1')
  const t1 = await center('t1')
  await p.mouse.dblclick(t1.x, t1.y, { delay: 60 }); await settle()
  await p.keyboard.press('End')
  await p.keyboard.type(' plus')
  await blank()
  check((await model('t1')).html.includes('plus'), 'the text edit committed', (await model('t1')).html)
  await sameAsFull('after a text edit')

  // 6) equation edit ------------------------------------------------------------------
  console.log('\nmath')
  await select('eq')
  const eqc = await center('eq')
  await p.mouse.dblclick(eqc.x, eqc.y, { delay: 60 })
  await p.waitForSelector('.ed-math-pop')
  await p.locator('.ed-math-pop textarea').fill('\\frac{a}{b} + c')
  await settle()
  // a preview on the canvas is DOM only: an unrelated edit meanwhile must not keep it
  await p.locator('.ed-math-pop .ed-btn-primary').click(); await settle(300)
  check((await model('eq')).tex === '\\frac{a}{b} + c', 'the equation edit committed')
  await sameAsFull('after an equation edit')
  await select('eq')
  await p.mouse.dblclick(eqc.x, eqc.y, { delay: 60 })
  await p.waitForSelector('.ed-math-pop')
  await p.locator('.ed-math-pop textarea').fill('\\sqrt{x}')
  await settle()
  await p.locator('.ed-math-pop .ed-btn:has-text("Cancel")').click(); await settle(300)
  check((await model('eq')).tex === '\\frac{a}{b} + c', 'a cancelled equation edit changes nothing')
  await sameAsFull('after a cancelled equation edit (its canvas preview is gone)')

  // 7) crop mode opened and cancelled ---------------------------------------------------
  console.log('\ncrop')
  await select('pic')
  const pc = await center('pic')
  await p.mouse.dblclick(pc.x, pc.y, { delay: 60 }); await settle(400)
  const cropping = await p.evaluate(() => !!document.querySelector('.ed-crop, .ed-crop-bar'))
  check(cropping, 'double-click opened crop mode')
  await p.keyboard.press('Escape'); await settle(300)
  await sameAsFull('after crop mode')

  // 8) svg gradients ------------------------------------------------------------------------
  console.log('\nsvg ids')
  const ids = await p.evaluate(() => {
    const all = [...document.querySelectorAll('[id]')].map((n) => n.id).filter((id) => /^beeslides-(grad|mark)-/.test(id))
    const dup = all.filter((id, i) => all.indexOf(id) !== i)
    const refs = [...document.querySelectorAll('.ed-stage-scale > .beeslides-slide [fill^="url(#"], .ed-stage-scale > .beeslides-slide [marker-end]')]
      .map((n) => (n.getAttribute('fill') || n.getAttribute('marker-end')).match(/url\(#([^)]+)\)/)?.[1]).filter(Boolean)
    return { n: all.length, dup, missing: refs.filter((id) => !document.getElementById(id)), refs: refs.length }
  })
  check(ids.n > 0 && !ids.dup.length && !ids.missing.length && ids.refs > 0, 'gradient/marker ids are unique and every url(#…) on the canvas resolves', ids)

  // 9) undo / redo ---------------------------------------------------------------------------
  console.log('\nundo')
  await markSurface()
  await p.evaluate(() => window.beeslides.undo()); await settle(150)
  await p.evaluate(() => window.beeslides.undo()); await settle(150)
  check(await surfaceKept(), 'an undo on the same slide keeps the surface (patched)')
  await sameAsFull('after two undos')
  await p.evaluate(() => window.beeslides.redo()); await settle(150)
  await sameAsFull('after a redo')
  // an edit on slide 2, then back on slide 1: undo switches slides — one surface draw
  await thumb(1).click({ delay: 60 }); await settle()
  await p.evaluate(() => window.beeslides.menu.run('insert.shape.0')); await settle(300)
  const s2n = await p.evaluate(() => window.beeslides.doc.slides[1].elements.length)
  check(s2n === 1, 'inserted a shape on slide 2', s2n)
  await thumb(0).click({ delay: 60 }); await settle(250)
  const draws = await p.evaluate(async () => {
    const host = document.querySelector('.ed-stage-scale')
    let n = 0
    const mo = new MutationObserver((rs) => { for (const r of rs) for (const a of r.addedNodes) if (a.classList?.contains('beeslides-slide')) n++ })
    mo.observe(host, { childList: true })
    window.beeslides.undo()
    await new Promise((r) => setTimeout(r, 50))
    mo.disconnect()
    return { n, slide: document.querySelector('.ed-stage-scale > .beeslides-slide').dataset.slideId }
  })
  check(draws.n === 1 && draws.slide === 'S2', 'an undo that switches slides draws the surface once', draws)
  await p.evaluate(() => window.beeslides.redo()); await settle(150)
  await thumb(0).click({ delay: 60 }); await settle(250)
  await sameAsFull('after undo/redo across slides')

  check(!errors.length, 'no page errors', errors.slice(0, 5))
} finally {
  await browser.close()
}

console.log(`\ntest-canvas-patch-e2e: ${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
