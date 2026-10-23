#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Right-click ▸ Copy for PowerPoint (editor/copypicture.ts) in a real
// (headless) browser, reading the clipboard back:
//   two selected elements → a PNG at 2× the selection's rotated, shadow-grown
//   box, drawn (the shape's fill is in it, the corners outside it are
//   transparent), an HTML <img> of it sized as on a 7.5 in slide, the alt
//   text from the text box; an empty-canvas right-click copies the whole
//   slide, background included. What PowerPoint does with it was checked by
//   hand (macOS: pastes the HTML picture at that size; SVG alone it ignores).
//
//   node scripts/test-copy-picture-e2e.mjs [editor-url]
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

const skip = (why) => { console.log(`test-copy-picture-e2e: SKIP — ${why}`); process.exit(0) }
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
  /** Click the menu's copy-picture row; the toast it left. */
  const runItem = async (label) => {
    await p.waitForTimeout(150)
    const found = await p.evaluate((label) => {
      const b = [...document.querySelectorAll('[data-ui-item="copy-picture"]')].find((x) => x.textContent.includes(label))
      b?.click()
      return !!b
    }, label)
    check(found, `the menu offers "${label}"`)
    await p.waitForTimeout(1500)
    return p.evaluate(() => [...document.querySelectorAll('[class*=toast]')].map((x) => x.textContent).filter(Boolean).pop() ?? '')
  }
  /** The clipboard as written: types, PNG size + sampled pixels, html. */
  const readBack = (samples) => p.evaluate(async (samples) => {
    const [item] = await navigator.clipboard.read()
    const r = { types: item.types, html: '', png: null }
    if (item.types.includes('text/html')) r.html = await (await item.getType('text/html')).text()
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

  console.log('— a selection')
  {
    const t = await centre('t1')
    await p.mouse.click(t.x, t.y)
    await p.waitForTimeout(200)
    const s = await centre('s1')
    await p.keyboard.down('Shift'); await p.mouse.click(s.x, s.y); await p.keyboard.up('Shift')
    await p.waitForTimeout(200)
    check(JSON.stringify((await p.evaluate(() => window.beeslides.selection)).sort()) === '["s1","t1"]', 'text + rotated shape selected')
    await p.mouse.click(s.x, s.y, { button: 'right' })
    const toast = await runItem('Copy for PowerPoint')
    check(/PowerPoint/.test(toast), 'a toast says where to paste it', toast)

    // the box: text 120..820 × 80..200; the shape's rotated bbox grown by its shadow (14 + 8)
    const a = (15 * Math.PI) / 180
    const hw = (360 * Math.cos(a) + 200 * Math.sin(a)) / 2 + 22
    const hh = (360 * Math.sin(a) + 200 * Math.cos(a)) / 2 + 22
    const x0 = Math.floor(Math.min(120 - 1, 380 - hw))
    const y0 = Math.floor(80 - 1)
    const x1 = Math.ceil(Math.max(820 + 1, 380 + hw))
    const y1 = Math.ceil(400 + hh)
    const [aw, ah] = [x1 - x0, y1 - y0]
    // sample: the shape's centre (380,400) and the box's top-right corner (empty)
    const r = await readBack([[(380 - x0) / aw, (400 - y0) / ah], [0.995, 0.6]])
    check(r.types.includes('image/png') && r.types.includes('text/html'), 'PNG and HTML on the clipboard', r.types)
    check(r.png && r.png.w === aw * 2 && r.png.h === ah * 2, 'the PNG is 2× the rotated, shadow-grown selection box', { got: r.png && [r.png.w, r.png.h], want: [aw * 2, ah * 2] })
    check(r.png && near(r.png.px[0], '#3B82F6'), 'the shape is drawn where it sits in the box', r.png?.px[0])
    check(r.png && r.png.px[1][3] === 0, 'no slide background behind a selection', r.png?.px[1])
    const wAttr = Number(/width="([\d.]+)"/.exec(r.html)?.[1])
    check(/^(<meta[^>]*>)?<img src="data:image\/png;base64,/.test(r.html), 'the HTML is an <img> of the PNG', r.html.slice(0, 60))
    check(Math.abs(wAttr - aw * cssPerPx) < 0.02, 'the <img> is sized as on a 7.5 in slide', { wAttr, want: aw * cssPerPx })
    check(/alt="Hello PowerPoint"/.test(r.html), 'alt text comes from the text box')
  }

  console.log('— the keys: ⇧⌘C / Ctrl+Shift+C')
  {
    await p.keyboard.press('Escape')
    const c = await centre('s2')
    await p.mouse.click(c.x, c.y)
    await p.waitForTimeout(200)
    await p.evaluate(() => navigator.clipboard.writeText('stale'))
    await p.keyboard.press('Control+Shift+C')
    await p.waitForTimeout(1500)
    const r = await readBack([[0.5, 0.5]])
    // the circle 900..1160 × 320..580, grown by half its 2px stroke (1)
    check(r.png && r.png.w === 262 * 2 && r.png.h === 262 * 2, 'the shortcut copies the selected circle', r.png && [r.png.w, r.png.h])
    check(r.png && near(r.png.px[0], '#F59E0B'), 'and draws it', r.png?.px[0])
  }

  console.log('— Edit ▸ Copy for PowerPoint')
  {
    const ran = await p.evaluate(async () => {
      await navigator.clipboard.writeText('stale')
      return window.beeslides.menu?.run('edit.copyPicture') ?? 'no menu api'
    })
    await p.waitForTimeout(1500)
    const r = await readBack([[0.5, 0.5]])
    check(r.png && r.png.w === 262 * 2, 'the menu command copies the selection too', { ran, png: r.png && [r.png.w, r.png.h] })
  }

  console.log('— empty canvas: the whole slide')
  {
    await p.keyboard.press('Escape')
    const pt = await p.evaluate(() => {
      const r = document.querySelector('.ed-stage-scale').getBoundingClientRect()
      return { x: r.x + r.width * 0.92, y: r.y + r.height * 0.08 }
    })
    await p.mouse.click(pt.x, pt.y, { button: 'right' })
    await runItem('Copy slide for PowerPoint')
    const r = await readBack([[0.97, 0.05], [(1030) / W, (450) / H]])
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
