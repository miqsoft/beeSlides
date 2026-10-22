#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "Convert to objects" (slides/src/svgconvert.ts) in a real browser: each case
// is a diagram on a blank slide, screenshotted, converted through the panel's
// button, screenshotted again, and the two pictures compared pixel by pixel —
// the conversion is only right if the slide LOOKS the same, whatever the model
// now says. Then the model is checked for what was supposed to become what.
//   node scripts/test-svg-convert-e2e.mjs [url] [--shots <dir>]
// url defaults to the built editor (npm run build:single first); pass
// http://127.0.0.1:<port>/ for a dev server. Needs playwright-core (same lookup
// as test-icons-e2e.mjs); SKIPS with exit 0 without it or a build. Headless.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const shotsAt = argv.indexOf('--shots')
const shots = shotsAt >= 0 ? argv.splice(shotsAt, 2)[1] : null
if (shots) mkdirSync(shots, { recursive: true })

async function loadChromium() {
  const tries = []
  if (process.env.PLAYWRIGHT_CORE) tries.push(pathToFileURL(process.env.PLAYWRIGHT_CORE).href)
  tries.push('playwright-core')
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) for (const d of readdirSync(npx)) {
    const p = join(npx, d, 'node_modules/playwright-core/index.mjs')
    if (existsSync(p)) tries.push(pathToFileURL(p).href)
  }
  for (const spec of tries) { try { return (await import(spec)).chromium } catch { /* next */ } }
  return null
}
const skip = (why) => { console.log(`test-svg-convert-e2e: SKIP — ${why}`); process.exit(0) }
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : null)
if (!url) skip('no build and no url given')
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')
let browser
try { browser = await chromium.launch({ headless: true }) } catch (e) { skip(`no browser: ${String(e.message).split('\n')[0]}`) }

let checks = 0, failures = 0
const ok = (c, m, d) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.log(`  FAIL  ${m}${d === undefined ? '' : ' — ' + JSON.stringify(d)}`) } }

const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(url)
await page.waitForFunction(() => !!window.beeslides?.loadDoc, null, { timeout: 30000 })
await page.waitForSelector('.ed-stage-scale')
await page.waitForFunction(() => !document.getElementById('beeslides-splash'), null, { timeout: 15000 }).catch(() => {})
await page.waitForTimeout(500)

const base = await page.evaluate(() => JSON.parse(JSON.stringify(window.beeslides.doc)))
const BOX = { rotation: 0, opacity: 1 }

/** load one slide holding `elements`, wait for it to paint */
async function load(elements, bg = '#FFFFFF') {
  const doc = JSON.parse(JSON.stringify(base))
  doc.slides = [{ id: 's1', name: '', background: bg, transition: 'fade', notes: '', elements }]
  doc.layouts = []
  await page.evaluate((d) => window.beeslides.loadDoc(JSON.stringify(d)), doc)
  await page.waitForTimeout(500)
}
const els = () => page.evaluate(() => window.beeslides.doc.slides[0].elements.map((e) => JSON.parse(JSON.stringify(e))))

async function snap() {
  await page.evaluate(() => { document.activeElement?.blur?.(); window.beeslides.select?.([]); document.documentElement.classList.add('ed-capturing') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const slide = page.locator('.ed-stage-scale .beeslides-slide, .ed-stage-scale [data-slide-id]').first()
  const buf = await (await page.locator('.ed-stage-scale').first()).screenshot()
  await page.evaluate(() => document.documentElement.classList.remove('ed-capturing'))
  return buf
}

/** fraction of pixels whose colour differs by more than 48 in any channel */
async function diff(a, b) {
  return page.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + s })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height)
    const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data }
    const A = px(ia), B = px(ib)
    let bad = 0
    for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) > 48 || Math.abs(A[i + 1] - B[i + 1]) > 48 || Math.abs(A[i + 2] - B[i + 2]) > 48) bad++
    return bad / (w * h)
  }, [a.toString('base64'), b.toString('base64')])
}

async function convert(id) {
  await page.locator(`.ed-stage-scale [data-el-id="${id}"]`).first().click({ delay: 80 })
  await page.waitForTimeout(300)
  const btn = page.locator('button:has-text("Convert to objects")').first()
  if (!(await btn.count())) return false
  await btn.click()
  await page.waitForTimeout(500)
  return true
}

const svg = (id, markup, frame = { x: 200, y: 100, w: 400, h: 400 }, extra = {}) => ({ id, type: 'svg', ...frame, ...BOX, markup, ...extra })

let n = 0
async function roundtrip(name, element, { tol = 0.004, check } = {}) {
  console.log(`\n${name}`)
  await load([element])
  const before = await snap()
  const converted = await convert(element.id)
  ok(converted, 'the panel offers Convert to objects for a diagram')
  const after = await snap()
  if (shots) { writeFileSync(join(shots, `${++n}-${name.replace(/\W+/g, '-')}-before.png`), before); writeFileSync(join(shots, `${n}-${name.replace(/\W+/g, '-')}-after.png`), after) }
  const d = await diff(before, after)
  ok(d <= tol, `looks the same (${(d * 100).toFixed(3)}% of pixels differ, limit ${(tol * 100).toFixed(1)}%)`, d)
  const out = await els()
  ok(!out.some((e) => e.type === 'svg'), 'the diagram element is gone')
  if (check) await check(out)
  return out
}

// 1. primitives: native rect/ellipse, polygon, polyline with round joins, dashed line
await roundtrip('primitives', svg('d1', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="5" y="5" width="40" height="30" rx="6" fill="#d33" stroke="#222" stroke-width="3"/>
  <circle cx="75" cy="25" r="16" fill="#39c" stroke="#046" stroke-width="2"/>
  <ellipse cx="25" cy="65" rx="20" ry="10" fill="#fc3"/>
  <polygon points="55,50 90,50 72,85" fill="#6a3" stroke="#252" stroke-width="2" stroke-linejoin="round"/>
  <polyline points="5,95 20,80 35,95 50,80" fill="none" stroke="#a0a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="55" y1="92" x2="95" y2="92" stroke="#444" stroke-width="3" stroke-dasharray="6 4"/>
</svg>`), { check: async (out) => {
  ok(out.some((e) => e.type === 'shape' && e.shape === 'rect' && e.radius > 0), 'the rounded rect became a rect shape with its radius')
  ok(out.some((e) => e.shape === 'ellipse') && out.filter((e) => e.shape === 'ellipse').length === 2, 'both circles became ellipse shapes')
  ok(out.filter((e) => e.shape === 'path').length === 3, 'polygon, polyline and line became path shapes', out.map((e) => e.shape))
  const poly = out.find((e) => e.shape === 'path' && e.strokeJoin === 'round' && e.strokeCap === 'round')
  ok(!!poly, 'round caps and joins are kept on the path')
  ok(out.some((e) => e.strokeStyle === 'dashed'), 'the dashed line stays dashed')
  ok(/dash patterns/.test(await page.locator('.ed-toast').first().innerText().catch(() => '')), 'and the toast owns up that the exact pattern is the standard one')
  const gid = new Set(out.map((e) => e.groupId))
  ok(gid.size === 1 && [...gid][0], 'all pieces share one group, so they still move as one')
} })

// 2. paths: arcs, quadratic curves, relative/shorthand commands, an even-odd donut
await roundtrip('paths', svg('d2', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M10 50 a20 20 0 0 1 40 0 a20 20 0 0 1 -40 0 z" fill="#c63"/>
  <path d="M60 10 q15 -10 30 0 t0 20 s-15 10 -30 0 z" fill="#36c" stroke="#013" stroke-width="2"/>
  <path fill-rule="evenodd" d="M15 70 h30 v25 h-30 z M22 77 h16 v11 h-16 z" fill="#2a6"/>
  <path d="M60 60 H90 V90 H60 Z" fill="none" stroke="#c20" stroke-width="3" stroke-linejoin="round"/>
</svg>`), { check: (out) => {
  ok(out.every((e) => e.shape === 'path'), 'every piece is a path shape', out.map((e) => e.shape))
  ok(out.some((e) => e.fillRule === 'evenodd'), 'the even-odd fill rule is kept (the donut keeps its hole)')
  ok(out.every((e) => !/[a-zQqSsTtAaHhVv]/.test(e.d.replace(/[MLCZ]/g, ''))), 'paths use only absolute M / L / C / Z, which the path editors understand', out.map((e) => e.d.slice(0, 40)))
} })

// 3. styling: <style> classes, inheritance, currentColor, group opacity, gradients
await roundtrip('styling', svg('d3', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" color="#936">
  <style>.a{fill:#e80}.b{stroke:#08e;stroke-width:4;fill:none}</style>
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f06"/><stop offset="1" stop-color="#60f"/></linearGradient></defs>
  <rect class="a" x="5" y="5" width="40" height="40"/>
  <circle class="b" cx="75" cy="25" r="18"/>
  <g fill="currentColor" opacity="0.5"><rect x="5" y="55" width="40" height="40"/></g>
  <rect x="55" y="55" width="40" height="40" fill="url(#g)"/>
</svg>`), { tol: 0.01, check: (out) => {
  ok(out.some((e) => e.fill === '#ee8800'), 'a class-styled fill is resolved', out.map((e) => e.fill))
  ok(out.some((e) => e.opacity === 0.5), 'group opacity lands on its pieces')
  const grad = out.find((e) => e.fillGradient)
  ok(grad && grad.fillGradient.stops.length === 2, 'a linear gradient becomes a gradient fill', grad?.fillGradient)
} })

// 3b. a radial gradient fading out (a glow) → a smaller, blurred shape in its inner colour, not a hard disc
await roundtrip('glow', svg('d3b', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><radialGradient id="rg"><stop offset="0" stop-color="#fb4" stop-opacity=".6"/><stop offset="1" stop-color="#fb4" stop-opacity="0"/></radialGradient></defs>
  <circle cx="50" cy="50" r="40" fill="url(#rg)"/>
</svg>`), { tol: 0.02, check: (out) => {
  const glow = out.find((e) => e.shape === 'ellipse')
  ok(glow && glow.blur > 0 && /^#ffbb44/i.test(glow.fill), 'a fading radial gradient → a blurred ellipse in its inner colour', glow && [glow.fill, glow.blur, glow.w])
} })

// 4. placement: a wide frame letterboxes the viewBox; rotation and flip of the element carry over
await roundtrip('placement', svg('d4', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="100" fill="#fd0"/><circle cx="30" cy="30" r="20" fill="#d20"/><path d="M50 90 L90 50 L90 90 Z" fill="#05a"/></svg>`,
  { x: 150, y: 120, w: 500, h: 250 }, { rotation: 20, flipH: true }), { tol: 0.006 })

// 4b. transforms: nested, non-uniform scale, skew, rotated circle and rect (these cannot stay native)
await roundtrip('transforms', svg('d4b', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g transform="translate(14 4) rotate(30 40 40) scale(.8 .5)">
    <rect x="10" y="10" width="60" height="50" rx="8" fill="#d63" stroke="#321" stroke-width="4"/>
    <circle cx="40" cy="35" r="14" fill="#fff"/>
  </g>
  <rect x="35" y="55" width="25" height="25" fill="#36d" transform="skewX(20)"/>
  <ellipse cx="25" cy="85" rx="18" ry="8" fill="#2a5" transform="rotate(-25 25 85)"/>
</svg>`, { x: 200, y: 80, w: 450, h: 450 }), { tol: 0.006, check: (out) => {
  ok(out.every((e) => e.shape === 'path'), 'transformed primitives are path shapes (a rect cannot be skewed or rotated off-axis)', out.map((e) => e.shape))
} })

// 4c. a real outline icon: one group with stroke styles inherited by round-capped paths
await roundtrip('outline icon', svg('d4c', `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#235" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><path d="M8 4v2M4 8h2"/></svg>`,
  { x: 260, y: 100, w: 360, h: 360 }), { tol: 0.006, check: (out) => {
  ok(out.length === 2 && out.every((e) => e.strokeCap === 'round' && e.strokeJoin === 'round' && e.fill === 'none'), 'inherited stroke styling lands on each path', out.map((e) => [e.strokeCap, e.strokeJoin, e.fill]))
  ok(out.every((e) => Math.abs(e.strokeWidth - 30) < 0.5), 'the stroke width is scaled with the diagram (2 units × 15)', out.map((e) => e.strokeWidth))
} })

// 4d. content past the diagram's frame was cut off by the svg; objects cannot be, so the converter says so
console.log('\noverflow')
await load([svg('d4d', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="60" y="20" width="80" height="40" fill="#c30"/></svg>')])
await convert('d4d')
const toast4d = await page.locator('.ed-toast').first().innerText().catch(() => '')
ok(/cut off before/.test(toast4d), 'a piece that stuck out past the frame is called out', toast4d)
await load([svg('d4e', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#c30" stroke="#000" stroke-width="4"/></svg>')])
await convert('d4e')
ok(!/cut off/.test(await page.locator('.ed-toast').first().innerText().catch(() => '')), 'one that fits, stroke included, is not')

// 5. text
await roundtrip('text', svg('d5', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#eef"/>
  <text x="100" y="40" font-size="22" font-family="Helvetica, Arial, sans-serif" font-weight="bold" text-anchor="middle" fill="#124">Title</text>
  <text x="10" y="75" font-size="14" font-family="Helvetica, Arial, sans-serif" fill="#a22">Left aligned</text></svg>`,
  { x: 200, y: 150, w: 600, h: 300 }), { tol: 0.01, check: (out) => {
  const texts = out.filter((e) => e.type === 'text')
  ok(texts.length === 2 && texts.some((t) => /Title/.test(t.html) && t.align === 'center' && t.fontWeight === 700) && texts.some((t) => /Left aligned/.test(t.html) && t.align === 'left'), 'text became text elements with the right words, weight and alignment', texts.map((t) => [t.html, t.align]))
} })

// 6. what cannot be carried over is said, and nothing breaks
console.log('\nunsupported parts')
await load([svg('d6', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter><radialGradient id="r"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#06c"/></radialGradient></defs>
  <circle cx="30" cy="30" r="20" fill="url(#r)"/><rect x="50" y="50" width="40" height="40" fill="#c60" filter="url(#f)"/></svg>`)])
await page.locator('.ed-stage-scale [data-el-id="d6"]').first().click({ delay: 80 })
await page.waitForTimeout(300)
await page.locator('button:has-text("Convert to objects")').first().click()
await page.waitForTimeout(500)
const toastText = await page.locator('.ed-toast').first().innerText().catch(() => '')
ok(/Converted into 2 objects/.test(toastText) && /radial/i.test(toastText) && /filter/i.test(toastText), 'the toast says what could not be carried over', toastText)
ok((await els()).length === 2, 'the convertible parts are still converted')

// 7. undo is one step, and the empty / locked cases refuse
console.log('\nundo and refusals')
await page.evaluate(() => document.activeElement?.blur())
await page.keyboard.press('Meta+z')
await page.waitForTimeout(300)
const back = await els()
ok(back.length === 1 && back[0].type === 'svg' && back[0].id === 'd6', 'one undo brings the diagram back')
await load([svg('d7', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs/></svg>')])
await page.locator('.ed-stage-scale [data-el-id="d7"]').first().click({ delay: 80 })
await page.waitForTimeout(300)
await page.locator('button:has-text("Convert to objects")').first().click()
await page.waitForTimeout(400)
ok((await els())[0]?.type === 'svg' && /Nothing in this diagram/.test(await page.locator('.ed-toast').first().innerText().catch(() => '')), 'a diagram with nothing drawable is left alone, with a reason')

// 8. provenance rides along
console.log('\nprovenance')
await load([svg('d8', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#333"/><circle cx="5" cy="5" r="3" fill="#fff"/></svg>', undefined, { provenance: { origin: 'Team icons', license: 'MIT' } })])
await convert('d8')
const o8 = await els()
ok(o8.filter((e) => e.provenance).length === 1 && o8[0].provenance?.license === 'MIT', 'the diagram’s source and license move to its converted pieces', o8.map((e) => e.provenance))

// 9. right-click offers it too
console.log('\ncontext menu')
await load([svg('d9', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#369"/></svg>')])
await page.locator('.ed-stage-scale [data-el-id="d9"]').first().click({ button: 'right', delay: 80 })
await page.waitForTimeout(300)
const menuItem = page.locator('.ed-ctx-menu [data-ui-item="convert-svg"]')
ok((await menuItem.count()) === 1, 'the right-click menu has Convert to objects for a lone diagram')
await menuItem.click()
await page.waitForTimeout(400)
ok((await els())[0]?.type === 'shape', 'and it converts')

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(failures ? `\n${failures} of ${checks} FAILED` : `\ntest-svg-convert-e2e: ${checks} passed`)
process.exit(failures ? 1 : 0)
