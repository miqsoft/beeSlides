#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Copy special (editor/copyspecial.ts, copyspecialmenu.ts) in a real
// (headless) browser, reading the clipboard back:
//   right-click ▸ Copy special… and ⇧⌘C open the numbered popup; 1 Picture
//   = PNG at 2× the rotated, shadow-grown selection box (drawn, transparent
//   around) + an HTML <img> sized as on a 7.5 in slide + SVG; 2 PNG only;
//   3 SVG only; 4 the SVG as text; 5 HTML whose text keeps its font, size
//   and bold inline and whose shape is an <img>; Esc copies nothing;
//   Settings ▸ Copy special (resolution, background) changes the picture;
//   each format is also an Edit ▸ Copy as command; an empty-canvas
//   right-click copies the whole slide. What PowerPoint does with it was
//   checked by hand (macOS: pastes the HTML picture at that size; SVG alone,
//   or a PDF, it takes no better).
//
//   node scripts/test-copy-special-e2e.mjs [editor-url]
//
// editor-url defaults to slides/dist-single/BeeSlides.beeslides.html. Needs
// playwright-core ($PLAYWRIGHT_CORE, the package, or the npx cache); without
// one or without a build it SKIPS with exit 0 and says so.
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

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

const skip = (why) => { console.log(`test-copy-special-e2e: SKIP — ${why}`); process.exit(0) }
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
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

const BG = '#FFF7E6'
const deck = (base) => {
  const d = JSON.parse(JSON.stringify(base))
  d.slides = [{
    id: 'S', background: BG, transition: 'fade', notes: '', elements: [
      { id: 't1', type: 'text', x: 120, y: 80, w: 700, h: 120, rotation: 0, opacity: 1, html: 'Hello <b>PowerPoint</b>', fontSize: 56,
        fontFamily: 'Georgia, serif', fontWeight: 400, color: '#1D1119', align: 'left', valign: 'middle', lineHeight: 1.2 },
      { id: 's1', type: 'shape', shape: 'rect', x: 200, y: 300, w: 360, h: 200, rotation: 15, opacity: 1, fill: '#3B82F6',
        stroke: '#1E3A8A', strokeWidth: 6, shadow: { x: 8, y: 8, blur: 14, color: 'rgba(0,0,0,0.45)' } },
      { id: 's2', type: 'shape', shape: 'ellipse', x: 900, y: 320, w: 260, h: 260, rotation: 0, opacity: 1, fill: '#F59E0B', stroke: '#B45309', strokeWidth: 2 },
    ],
  }]
  return d
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(url)
  await p.waitForFunction(() => !!window.beeslides?.loadDoc, null, { timeout: 30_000 })
  await p.waitForTimeout(600)
  await p.evaluate(() => document.getElementById('beeslides-splash')?.remove())
  const base = await p.evaluate(() => JSON.parse(JSON.stringify(window.beeslides.doc)))
  const doc = deck(base)
  await p.evaluate((json) => window.beeslides.loadDoc(json), JSON.stringify(doc))
  await p.waitForTimeout(400)
  const { width: W, height: H } = doc.size
  const cssPerPx = (7.5 / H) * 96

  const centre = (id) => p.evaluate((id) => {
    const r = document.querySelector(`.ed-stage-scale .beeslides-el[data-el-id="${id}"]`).getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, id)
  const toastText = () => p.evaluate(() => [...document.querySelectorAll('[class*=toast]')].map((x) => x.textContent).filter(Boolean).pop() ?? '')
  const popup = () => p.evaluate(() => {
    const m = document.querySelector('.ed-copy-special')
    return m ? { caption: m.querySelector('.ed-arrange-cap')?.textContent ?? '', rows: [...m.querySelectorAll('.ed-cs-row')].map((b) => b.textContent) } : null
  })
  /** Open the popup with ⇧⌘C (Ctrl+Shift+C) and press `key`. */
  const viaKeys = async (key) => {
    await p.evaluate(() => navigator.clipboard.writeText('stale'))
    await p.keyboard.press('Control+Shift+C')
    await p.waitForTimeout(150)
    const shown = await popup()
    await p.keyboard.press(key)
    await p.waitForTimeout(1500)
    return shown
  }
  /** The clipboard as written: types, PNG size + sampled pixels, html, text. */
  const readBack = (samples = []) => p.evaluate(async (samples) => {
    const [item] = await navigator.clipboard.read()
    const r = { types: item.types, html: '', text: '', svg: '', png: null }
    if (item.types.includes('text/html')) r.html = await (await item.getType('text/html')).text()
    if (item.types.includes('text/plain')) r.text = await (await item.getType('text/plain')).text()
    if (item.types.includes('image/svg+xml')) r.svg = await (await item.getType('image/svg+xml')).text()
    if (item.types.includes('image/png')) {
      const bmp = await createImageBitmap(await item.getType('image/png'))
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const g = c.getContext('2d')
      g.drawImage(bmp, 0, 0)
      r.png = { w: bmp.width, h: bmp.height, px: samples.map(([fx, fy]) => [...g.getImageData(Math.floor(fx * bmp.width), Math.floor(fy * bmp.height), 1, 1).data]) }
    }
    return r
  }, samples)
  const near = (px, hex) => {
    const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    return px[3] > 200 && want.every((v, i) => Math.abs(v - px[i]) < 12)
  }
  const svgOk = await p.evaluate(() => !!ClipboardItem.supports?.('image/svg+xml'))

  // the text + rotated shape box: text 120..820 × 80..200; the shape's rotated
  // bbox grown by its shadow (14 + 8)
  const a = (15 * Math.PI) / 180
  const hw = (360 * Math.cos(a) + 200 * Math.sin(a)) / 2 + 22
  const hh = (360 * Math.sin(a) + 200 * Math.cos(a)) / 2 + 22
  const x0 = Math.floor(Math.min(120 - 1, 380 - hw))
  const y0 = Math.floor(80 - 1)
  const aw = Math.ceil(Math.max(820 + 1, 380 + hw)) - x0
  const ah = Math.ceil(400 + hh) - y0

  console.log('— right-click ▸ Copy special… ▸ 1 Picture')
  {
    const t = await centre('t1')
    await p.mouse.click(t.x, t.y)
    await p.waitForTimeout(200)
    const s = await centre('s1')
    await p.keyboard.down('Shift'); await p.mouse.click(s.x, s.y); await p.keyboard.up('Shift')
    await p.waitForTimeout(200)
    check(JSON.stringify((await p.evaluate(() => window.beeslides.selection)).sort()) === '["s1","t1"]', 'text + rotated shape selected')
    await p.mouse.click(s.x, s.y, { button: 'right' })
    await p.waitForTimeout(150)
    const opened = await p.evaluate(() => {
      const b = document.querySelector('.ed-ctx-menu [data-ui-item="copy-special"]')
      b?.click()
      return !!b
    })
    check(opened, 'the context menu offers Copy special…')
    await p.waitForTimeout(150)
    const shown = await popup()
    check(shown?.caption === 'Copy 2 objects as' && shown.rows.length === 6, 'the popup says what it copies and offers 5 formats + settings', shown)
    check(/^1Picture/.test(shown?.rows[0] ?? '') && /^5HTML/.test(shown?.rows[4] ?? ''), 'the formats are numbered', shown?.rows)
    await p.keyboard.press('1')
    await p.waitForTimeout(1500)
    check(/PowerPoint/.test(await toastText()), 'a toast says where to paste it')
    check(!(await popup()), 'the popup closed')
    const r = await readBack([[(380 - x0) / aw, (400 - y0) / ah], [0.995, 0.6]])
    check(r.types.includes('image/png') && r.types.includes('text/html') && (!svgOk || r.types.includes('image/svg+xml')), 'PNG, HTML (and SVG) on the clipboard', r.types)
    check(r.png && r.png.w === aw * 2 && r.png.h === ah * 2, 'the PNG is 2× the rotated, shadow-grown selection box', { got: r.png && [r.png.w, r.png.h], want: [aw * 2, ah * 2] })
    check(r.png && near(r.png.px[0], '#3B82F6'), 'the shape is drawn where it sits in the box', r.png?.px[0])
    check(r.png && r.png.px[1][3] === 0, 'no slide background behind a selection', r.png?.px[1])
    const wAttr = Number(/width="([\d.]+)"/.exec(r.html)?.[1])
    check(/^(<meta[^>]*>)?<img src="data:image\/png;base64,/.test(r.html), 'the HTML is an <img> of the PNG', r.html.slice(0, 60))
    check(Math.abs(wAttr - aw * cssPerPx) < 0.02, 'the <img> is sized as on a 7.5 in slide', { wAttr, want: aw * cssPerPx })
    check(/alt="Hello PowerPoint"/.test(r.html), 'alt text comes from the text box')
  }

  console.log('— ⇧⌘C ▸ 5 HTML')
  {
    const shown = await viaKeys('5')
    check(shown?.caption === 'Copy 2 objects as', 'Ctrl+Shift+C opens the same popup', shown)
    const r = await readBack()
    check(JSON.stringify(r.types.slice().sort()) === '["text/html","text/plain"]', 'only HTML and plain text', r.types)
    check(/font-family:[^;"]*Georgia/.test(r.html) && /font-size:42pt/.test(r.html), 'the text keeps its font and size (56 px = 42 pt) inline', r.html.slice(0, 300))
    check(/<b[ >][^]*PowerPoint/.test(r.html) && !/class=/.test(r.html), 'bold stays bold; no classes leak', r.html.slice(0, 400))
    check(r.html.indexOf('Hello') < r.html.indexOf('<img'), 'reading order: the text above, then the shape as an <img>')
    check((r.html.match(/<img /g) ?? []).length === 1, 'one picture (the shape)')
    check(r.text.trim() === 'Hello PowerPoint', 'plain text is the words', r.text)
  }

  console.log('— 2 PNG · 3 SVG · 4 SVG code, Esc')
  {
    await p.keyboard.press('Escape')
    const c = await centre('s2')
    await p.mouse.click(c.x, c.y)
    await p.waitForTimeout(200)
    const shown = await viaKeys('2')
    check(shown?.caption === 'Copy the object as', 'one object', shown?.caption)
    let r = await readBack([[0.5, 0.5]])
    check(JSON.stringify(r.types) === '["image/png"]', '2 = only the PNG (the key right after a canvas click)', { types: r.types, errors })
    // the circle 900..1160 × 320..580, grown by half its 2px stroke (1)
    check(r.png && r.png.w === 262 * 2 && near(r.png.px[0], '#F59E0B'), 'the circle, drawn', r.png && [r.png.w, r.png.px[0]])
    if (svgOk) {
      await viaKeys('3')
      r = await readBack()
      check(JSON.stringify(r.types) === '["image/svg+xml"]' && /<ellipse|<path|<circle/.test(r.svg), '3 = only the SVG', r.types)
    } else console.log('  skip  3 = SVG (this Chromium cannot write it)')
    await viaKeys('4')
    r = await readBack()
    check(JSON.stringify(r.types) === '["text/plain"]' && /<svg[^>]*viewBox="899 319 262 262"/.test(r.text), '4 = the SVG code as text', r.text.slice(0, 200))
    await viaKeys('Escape')
    r = await readBack()
    check(r.text === 'stale' && !(await popup()), 'Esc closes it and copies nothing')
  }

  console.log('— Settings ▸ Copy special')
  {
    await p.evaluate(() => localStorage.setItem('slidomingo-copy-special-v1', JSON.stringify({ scale: 1, background: true })))
    await viaKeys('2')
    const r = await readBack([[0.02, 0.02]])
    check(r.png && r.png.w === 262, '1× resolution', r.png?.w)
    check(r.png && near(r.png.px[0], BG), 'on the slide background', r.png?.px[0])
    await p.evaluate(() => localStorage.removeItem('slidomingo-copy-special-v1'))
  }

  console.log('— Edit ▸ Copy as')
  {
    const ran = await p.evaluate(async () => {
      await navigator.clipboard.writeText('stale')
      return window.beeslides.menu?.run('edit.copyAsPng') ?? 'no menu api'
    })
    await p.waitForTimeout(1500)
    const r = await readBack()
    check(JSON.stringify(r.types) === '["image/png"]' && r.png?.w === 262 * 2, 'Edit ▸ Copy as ▸ PNG copies the selection', { ran, types: r.types })
  }

  console.log('— empty canvas: the whole slide')
  {
    await p.keyboard.press('Escape')
    const pt = await p.evaluate(() => {
      const r = document.querySelector('.ed-stage-scale').getBoundingClientRect()
      return { x: r.x + r.width * 0.92, y: r.y + r.height * 0.08 }
    })
    await p.mouse.click(pt.x, pt.y, { button: 'right' })
    await p.waitForTimeout(150)
    await p.evaluate(() => document.querySelector('.ed-ctx-menu [data-ui-item="copy-special"]')?.click())
    await p.waitForTimeout(150)
    check((await popup())?.caption === 'Copy the slide as', 'nothing selected: the slide')
    await p.keyboard.press('1')
    await p.waitForTimeout(1500)
    const r = await readBack([[0.97, 0.05], [1030 / W, 450 / H]])
    check(r.png && r.png.w === W * 2 && r.png.h === H * 2, 'the PNG is the slide at 2×', r.png && [r.png.w, r.png.h])
    check(r.png && near(r.png.px[0], BG), 'with its background', r.png?.px[0])
    check(r.png && near(r.png.px[1], '#F59E0B'), 'and the unselected circle', r.png?.px[1])
    const wAttr = Number(/width="([\d.]+)"/.exec(r.html)?.[1])
    check(Math.abs(wAttr - W * cssPerPx) < 0.02, 'the <img> is a full slide wide', wAttr)
  }
} finally {
  await browser.close()
}

console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
