#!/usr/bin/env node
// Table cells in a real browser: the editor interaction layer over
// src/tablespans.ts (editor/tablerange.ts + canvas.ts + editor.ts routing),
// which scripts/test-table-merge.ts (pure logic) cannot see.
//
//   node scripts/test-table-cells-e2e.mjs [url]
//
// url defaults to the built editor, slides/dist-single/BeeSlides.beeslides.html
// (npm run build:single first); pass http://localhost:<port>/ for a dev server.
// Needs playwright-core: $PLAYWRIGHT_CORE (path to its index.mjs), the
// package itself, or the npx cache. Without one (or without a build) it
// SKIPS with exit 0 and says so — it never fails for want of a browser.
//
// Checks: one click on an unselected table selects the TABLE (Delete deletes
// it, arrows nudge it, ⌘C copies the element); a click on the selected table
// picks a cell; Shift+arrows + Merge makes a real colspan/rowspan; one undo
// restores it; Esc hands the arrows back to the element; the context menu's
// Copy / Paste act on the cells (spans kept); pasting a huge block stops at
// the sanitizer's row/column ceiling.
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

const skip = (why) => { console.log(`test-table-cells-e2e: SKIP — ${why}`); process.exit(0) }

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
  if (ok) passes++
  else { fails++; console.log(`FAIL ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`) }
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const clipOk = await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).then(() => true, () => false)
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(url)
  await p.waitForFunction(() => !!window.beeslides?.loadDoc, null, { timeout: 30_000 })
  await p.waitForTimeout(800)

  const load = () => p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.beeslides.doc))
    const rows = Array.from({ length: 3 }, (_, r) => ({ cells: Array.from({ length: 3 }, (_, c) => ({ html: `r${r}c${c}` })) }))
    d.slides = [d.slides[0]]
    d.slides[0].elements = [{
      id: 'tb1', type: 'table', x: 200, y: 150, w: 800, h: 300, header: true, columns: [{ w: 1 }, { w: 1 }, { w: 1 }], rows,
      style: { headerBg: '#333', headerColor: '#fff', borderColor: '#999', borderWidth: 1, cellPadX: 8, cellPadY: 6, fontSize: 20, color: '#111', radius: 0 },
    }]
    window.beeslides.loadDoc(JSON.stringify(d))
  })
  // near a cell's top-left: a merged cell's middle has a column-resize handle over it
  const AT = { x: 12, y: 12 }
  const td = (r, c) => p.locator(`.ed-stage [data-el-id="tb1"] td[data-r="${r}"][data-c="${c}"]`)
  const state = () => p.evaluate(() => {
    const els = window.beeslides.doc.slides[0].elements
    const tb = els.find((e) => e.id === 'tb1')
    return {
      sel: [...window.beeslides.selection],
      cells: [...document.querySelectorAll('.ed-stage .beeslides-cell-sel')].map((t) => `${t.dataset.r},${t.dataset.c}`),
      n: els.length,
      types: els.map((e) => e.type),
      x: tb?.x,
      rows: tb?.rows.length,
      cols: tb?.columns.length,
      html: tb?.rows.map((r) => r.cells.map((c) => c.html)),
      spans: tb?.rows.flatMap((r, i) => r.cells.flatMap((c, j) => (c.colspan || c.rowspan ? [`${i},${j}:${c.rowspan ?? 1}x${c.colspan ?? 1}`] : []))),
    }
  })
  const blank = async () => {
    const box = await p.locator('.ed-stage').boundingBox()
    await p.mouse.click(box.x + 8, box.y + 8, { delay: 80 })
    await p.waitForTimeout(200)
  }
  const settle = () => p.waitForTimeout(250)

  // 1) first click selects the table; Delete deletes it
  await load(); await settle(); await blank()
  await td(1, 1).click({ delay: 80, position: AT }); await settle()
  let s = await state()
  check(s.sel.length === 1 && s.sel[0] === 'tb1', 'first click selects the table', s.sel)
  check(s.cells.length === 0, 'first click picks no cell', s.cells)
  await p.keyboard.press('Delete'); await settle()
  s = await state()
  check(s.n === 0, 'click + Delete deletes the table', s.types)

  // 1b) first click + ⌘C copies the ELEMENT: ⌘V on the empty canvas makes a second table
  await load(); await settle(); await blank()
  await td(1, 1).click({ delay: 80, position: AT }); await settle()
  await p.keyboard.press('Meta+c'); await settle()
  await blank()
  await p.keyboard.press('Meta+v'); await settle()
  s = await state()
  check(s.types.join() === 'table,table', 'click + ⌘C, ⌘V pastes a second table', s.types)

  // 2) first click + arrow nudges the table
  await load(); await settle(); await blank()
  await td(1, 1).click({ delay: 80, position: AT }); await settle()
  await p.keyboard.press('ArrowRight'); await settle()
  s = await state()
  check(s.x !== 200 && s.cells.length === 0, 'click + ArrowRight nudges the table', { x: s.x, cells: s.cells })

  // 3) second click picks a cell; Shift+arrows + Merge; undo; Esc
  await load(); await settle(); await blank()
  await td(1, 1).click({ delay: 80, position: AT }); await settle()
  await td(1, 1).click({ delay: 80, position: AT }); await settle()
  s = await state()
  check(s.cells.join() === '1,1', 'second click picks the cell', s.cells)
  await p.keyboard.press('Shift+ArrowRight'); await p.keyboard.press('Shift+ArrowDown'); await settle()
  s = await state()
  check(s.cells.length === 4, 'Shift+arrows extend the range', s.cells)
  const merge = p.locator('button[data-table-op="merge"]:visible').first()
  if (await merge.count()) await merge.click()
  else await p.evaluate(() => document.querySelector('button[data-table-op="merge"]')?.click())
  await settle()
  s = await state()
  check(s.spans.join() === '1,1:2x2', 'Merge writes the spans', s.spans)
  const dom = await p.evaluate(() => {
    const t = document.querySelector('.ed-stage [data-el-id="tb1"] td[data-r="1"][data-c="1"]')
    return { cs: t?.getAttribute('colspan'), rs: t?.getAttribute('rowspan'), n: document.querySelectorAll('.ed-stage [data-el-id="tb1"] td').length }
  })
  check(dom.cs === '2' && dom.rs === '2' && dom.n === 6, 'the canvas draws a real colspan/rowspan', dom)
  check(await p.evaluate(() => (window.beeslides.doc.requires ?? []).includes('table-merge')), "doc requires 'table-merge'")
  await p.keyboard.press('Meta+z'); await settle()
  s = await state()
  check(s.spans.length === 0 && s.html[1][1] === 'r1c1', 'one undo restores the table', s)
  await td(1, 1).click({ delay: 80, position: AT }); await settle()
  await p.keyboard.press('Escape'); await settle()
  s = await state()
  check(s.cells.length === 0 && s.sel[0] === 'tb1', 'Esc drops the cells, keeps the table', s)
  await p.keyboard.press('ArrowDown'); await settle()
  s = await state()
  check(s.cells.length === 0 && (await p.evaluate(() => window.beeslides.doc.slides[0].elements[0].y)) !== 150, 'after Esc the arrows nudge again')

  // 4) cells: Backspace clears, ⌘C/⌘V copy cells with their spans
  await load(); await settle(); await blank()
  await td(0, 0).click({ delay: 80, position: AT }); await settle()
  await td(0, 0).click({ delay: 80, position: AT }); await settle()
  await p.keyboard.press('Shift+ArrowRight'); await settle()
  await p.evaluate(() => document.querySelector('button[data-table-op="merge"]')?.click()); await settle()
  await p.keyboard.press('Meta+c'); await settle()
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await settle()
  await p.keyboard.press('Meta+v'); await settle()
  s = await state()
  check(s.spans.includes('2,0:1x2') && s.html[2][0].startsWith('r0c0') && s.n === 1, '⌘C/⌘V copies cells with their spans', s)

  // 5) context menu: Copy / Paste act on the cells
  if (clipOk) {
    await load(); await settle(); await blank()
    await td(0, 0).click({ delay: 80, position: AT }); await settle()
    await td(0, 0).click({ delay: 80, position: AT }); await settle()
    await p.keyboard.press('Shift+ArrowRight'); await settle()
    await p.evaluate(() => document.querySelector('button[data-table-op="merge"]')?.click()); await settle()
    const menuItem = async (label) => {
      await p.locator('.ed-ctx-menu button', { hasText: new RegExp(`^${label}$`) }).first().click()
      await settle()
    }
    await td(0, 0).click({ button: 'right', position: AT }); await settle()
    await menuItem('Copy')
    const clip = await p.evaluate(() => navigator.clipboard.readText())
    check(clip.startsWith('r0c0'), 'menu Copy writes the cells as text', clip.slice(0, 60))
    await td(2, 1).click({ button: 'right', position: AT }); await settle()
    s = await state()
    check(s.cells.join() === '2,1', 'right-click picks the cell under the pointer', s.cells)
    await menuItem('Paste')
    await p.waitForTimeout(300)
    s = await state()
    check(s.n === 1 && s.html[2][1].startsWith('r0c0') && s.spans.includes('2,1:1x2'), 'menu Paste lands in the cells (spans kept)', s)

    // 6) a huge paste stops at the sanitizer's ceiling
    await p.evaluate(() => navigator.clipboard.writeText(['x\t'.repeat(250), ...Array.from({ length: 2500 }, (_, i) => `a${i}`)].join('\n')))
    await td(0, 0).click({ button: 'right', position: AT }); await settle()
    const t0 = Date.now()
    await menuItem('Paste')
    await p.waitForFunction(() => window.beeslides.doc.slides[0].elements[0].rows.length > 3, null, { timeout: 30_000 })
    s = await state()
    check(s.rows === 2000 && s.cols === 200, 'a huge paste stops at 2000×200', { rows: s.rows, cols: s.cols, ms: Date.now() - t0 })
  } else console.log('test-table-cells-e2e: no clipboard permission — context-menu clipboard checks skipped')

  check(errors.length === 0, 'no page errors', errors)
} finally {
  await browser.close()
}

console.log(`test-table-cells-e2e: ${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
