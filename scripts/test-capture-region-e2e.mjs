#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Agent screenshots (render_preview / review_slide) on the editor side, in a
// real (headless) browser with the desktop bridge stubbed: the reported rect
// is the whole slide even on a zoomed-in canvas, elementIds / area frame just
// that part zoomed to fill the view, bad regions are refused, and the user's
// zoom comes back. Main's crop is stood in for by page.screenshot({clip}).
//
//   node scripts/test-capture-region-e2e.mjs [editor-url] [--shots dir]
//
// editor-url defaults to slides/dist-single/BeeSlides.beeslides.html. Needs
// playwright-core ($PLAYWRIGHT_CORE, the package, or the npx cache); without
// one or without a build it SKIPS with exit 0 and says so.
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
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

const skip = (why) => { console.log(`test-capture-region-e2e: SKIP — ${why}`); process.exit(0) }
const chromium = await loadChromium()
if (!chromium) skip('no playwright-core (set PLAYWRIGHT_CORE)')
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : skip('no build (npm run build:single in slides/) and no url given'))

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.error(`  FAIL  ${m}`) } }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (e) => console.error('pageerror', e.message))
await page.addInitScript(() => {
  window.__results = {}
  const thenable = () => Promise.resolve(undefined)
  const impl = {
    onAgentAction: (cb) => { window.__agent = cb },
    sendAgentActionResult: (r) => { window.__results[r.requestId] = r },
    onAgentQuery: (cb) => { window.__query = cb },
    sendAgentQueryResponse: (r) => { window.__results[r.requestId] = r },
  }
  window.slidomingoDesktop = new Proxy(impl, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => thenable() : undefined)) })
})
await page.goto(url)
await page.waitForTimeout(1500)
const blank = page.locator('button:visible:has-text("Blank")').first()
if (await blank.count()) await blank.click()
await page.waitForFunction(() => !!window.__agent && !!window.__query && !!window.beeslides?.doc, null, { timeout: 15000 })

let n = 0
async function call(kind, verb, args) {
  const id = `r${++n}`
  await page.evaluate(([kind, id, verb, args]) => window[kind]({ requestId: id, verb, args }), [kind, id, verb, args])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 15000 })
  return page.evaluate((id) => window.__results[id], id)
}
const query = (verb, args) => call('__query', verb, args)
const zoomLabel = () => page.evaluate(() => document.querySelector('.ed-zoombar')?.textContent ?? '')
/** What main would capture: the reported rect, cropped out of the page. */
async function shoot(rect, name) {
  const buf = await page.screenshot({ clip: rect })
  if (shots) (await import('node:fs')).writeFileSync(join(shots, `${name}.png`), buf)
  // share of pure-red pixels, read back in the page (no image library here)
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height })
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let red = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++
    return red / (d.length / 4)
  }, buf.toString('base64'))
}

const { slideId, size } = await page.evaluate(() => ({ slideId: window.beeslides.doc.slides[0].id, size: window.beeslides.doc.size }))
const RED = { type: 'shape', shape: 'rect', x: 1000, y: 560, w: 60, h: 40, rotation: 0, opacity: 1, fill: '#ff0000', stroke: 'none', strokeWidth: 0 }
const ins = await call('__agent', 'insert_elements', { slideId, elements: [RED], nudge: false })
ok(ins.ok && ins.elementIds?.length === 1, `a small red box at ${RED.x},${RED.y} ${RED.w}x${RED.h} (${ins.error ?? 'ok'})`)
const redId = ins.elementIds?.[0]
await page.waitForTimeout(300)

// 1) whole slide at fit
const whole = await query('render_preview', {})
const aspect = size.width / size.height
ok(whole.ok && whole.result.rect && Math.abs(whole.result.rect.width / whole.result.rect.height - aspect) < 0.02, `render_preview: the whole slide (${JSON.stringify(whole.result?.rect)})`)
ok(await page.evaluate(() => document.documentElement.classList.contains('ed-capturing')), 'editor chrome hidden for the capture')
const fitWidth = whole.result.rect.width
await page.waitForTimeout(1700)

// 2) a zoomed-in canvas still yields the whole slide, and the zoom comes back
for (let i = 0; i < 4; i++) await page.locator('.ed-zoombar button').last().click({ force: true })
await page.waitForTimeout(200)
const zoomedLabel = await zoomLabel()
const review = await query('review_slide', { slideId })
const r = review.result?.rect
ok(review.ok && r && Math.abs(r.width / r.height - aspect) < 0.02 && Math.abs(r.width - fitWidth) <= 2, `review_slide on a zoomed-in canvas (${zoomedLabel}): the whole slide at fit (${JSON.stringify(r)})`)
ok((await shoot(r, 'whole')) > 0, 'the red box is in the whole-slide shot')
await page.waitForTimeout(1700)
ok(await zoomLabel() === zoomedLabel && !(await page.evaluate(() => document.documentElement.classList.contains('ed-capturing'))), `the user's zoom (${zoomedLabel}) and the chrome are back`)
await page.locator('.ed-zoombar button').filter({ hasText: '%' }).click({ force: true }) // back to fit
await page.waitForTimeout(200)

// 3) elementIds: just that element, zoomed in
const part = await query('review_slide', { slideId, elementIds: [redId] })
const pr = part.result?.rect
const area = part.result?.area
ok(part.ok && area && area.x < RED.x && area.y < RED.y && area.x + area.w > RED.x + RED.w && area.y + area.h > RED.y + RED.h, `elementIds: the area holds the element plus a margin (${JSON.stringify(area)})`)
ok(pr && Math.abs(pr.width / pr.height - area.w / area.h) < 0.05, `the rect has the area's shape (${JSON.stringify(pr)})`)
const onScreenAtFit = RED.w * fitWidth / size.width
ok(pr && (RED.w / area.w) * pr.width > 6 * onScreenAtFit, `the element is drawn far larger than at fit (${Math.round((RED.w / area.w) * pr.width)} vs ${Math.round(onScreenAtFit)} css px)`)
const share = await shoot(pr, 'element')
ok(share > 0.2, `the shot is mostly the element (${(share * 100).toFixed(0)} % red)`)
await page.waitForTimeout(1700)

// 4) area, clamped to the slide
const corner = await query('render_preview', { area: { x: size.width - 200, y: size.height - 100, w: 400, h: 400 } })
ok(corner.ok && corner.result.area?.w === 200 && corner.result.area?.h === 100, `area past the edge is clamped to the slide (${JSON.stringify(corner.result?.area)})`)
await page.waitForTimeout(1700)

// 5) refusals
const unknown = await query('review_slide', { slideId, elementIds: ['nope'] })
ok(!unknown.ok && /nope/.test(unknown.error ?? ''), `an unknown element is refused (${unknown.error})`)
const off = await query('render_preview', { area: { x: size.width + 10, y: 0, w: 100, h: 100 } })
ok(!off.ok && /not on the/.test(off.error ?? ''), `an area off the slide is refused (${off.error})`)
const junk = await query('render_preview', { area: { x: 'a', y: 0, w: 1, h: 1 } })
ok(!junk.ok && /numbers/.test(junk.error ?? ''), `a malformed area is refused (${junk.error})`)

// 6) two captures back to back: the user's view, not the first framing, is restored
for (let i = 0; i < 2; i++) await page.locator('.ed-zoombar button').last().click({ force: true })
await page.waitForTimeout(200)
const userLabel = await zoomLabel()
await query('review_slide', { slideId, elementIds: [redId] })
await query('render_preview', {})
await page.waitForTimeout(1700)
ok(await zoomLabel() === userLabel, `back-to-back captures restore the user's zoom (${userLabel}, now ${await zoomLabel()})`)

// 7) a slide that is NOT on the canvas: shot off screen (a standalone page main
// renders in a hidden window), and the user's view stays where it is
await page.waitForTimeout(1700)
const added = await call('__agent', 'deck', { op: 'add' })
const otherId = added.slideIds?.[0]
ok(added.ok && otherId, `deck add: a second slide (${added.error ?? otherId})`)
const BIG = { ...RED, x: 100, y: 100, w: 400, h: 300 }
const big = await call('__agent', 'insert_elements', { slideId: otherId, elements: [BIG], nudge: false })
ok(big.ok, `a big red box on the other slide (${big.error ?? 'ok'})`)
const before = (await query('render_preview', {})).result?.slideId
await page.waitForTimeout(1700)
ok(before === slideId, `the user is on the first slide (${before})`)
const away = await query('review_slide', { slideId: otherId })
ok(away.ok && away.result.rect === null && typeof away.result.offscreen?.html === 'string', `review_slide of the other slide: an off-screen page, no on-screen rect (${away.error ?? 'ok'})`)
ok(away.result?.offscreen?.width === size.width && away.result?.offscreen?.height === size.height && away.result?.elements?.length >= 1, `the page is the whole slide, ${size.width}x${size.height}, with its element list`)
ok(!(await page.evaluate(() => document.documentElement.classList.contains('ed-capturing'))), 'no capture chrome toggled on the canvas')
const after = (await query('render_preview', {})).result?.slideId
await page.waitForTimeout(1700)
ok(after === slideId, `the user's view did not move (${after})`)
/** What main's hidden window would capture: the page at its own size. */
async function shootPage(offscreen, name) {
  const p = await browser.newPage({ viewport: { width: Math.round(offscreen.width), height: Math.round(offscreen.height) } })
  await p.setContent(offscreen.html)
  await p.waitForTimeout(200)
  const buf = await p.screenshot()
  await p.close()
  if (shots) (await import('node:fs')).writeFileSync(join(shots, `${name}.png`), buf)
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height })
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let red = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++
    return red / (d.length / 4)
  }, buf.toString('base64'))
}
const want = (BIG.w * BIG.h) / (size.width * size.height)
const awayShare = await shootPage(away.result.offscreen, 'offscreen-whole')
ok(Math.abs(awayShare - want) < want * 0.15, `the off-screen page draws the slide: the box covers ${(awayShare * 100).toFixed(1)} % (expected ${(want * 100).toFixed(1)} %)`)
const awayPart = await query('render_preview', { slideId: otherId, elementIds: [big.elementIds[0]] })
ok(awayPart.ok && awayPart.result.offscreen?.width === awayPart.result.area?.w, `render_preview of another slide with elementIds: a page of just that area (${JSON.stringify(awayPart.result?.area)})`)
ok((await shootPage(awayPart.result.offscreen, 'offscreen-element')) > 0.5, 'the area page is mostly the element')
const layoutId = await page.evaluate(() => window.beeslides.doc.layouts?.[0]?.id)
if (layoutId) {
  const lay = await query('review_slide', { slideId: layoutId })
  ok(!lay.ok && /open in the editor/.test(lay.error ?? ''), `a slide type that is not open is refused (${lay.error})`)
}

await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
