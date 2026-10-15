#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon sets (docs/DECISIONS.md, "Icon sets") in a real browser:
//   node scripts/test-iconset-e2e.mjs [url] [--shots <dir>]
// url defaults to the built editor, slides/dist-single/BeeSlides.beeslides.html
// (npm run build:single first). A fake window.slidomingoDesktop plays main:
// it records what "Draw with AI", "Send to Claude" and "Export set" hand it,
// and answers agent queries/writes the way the desktop app delivers them.
// Needs playwright-core (same lookup as test-icons-e2e.mjs); SKIPS with exit
// 0 without it or a build.
//
// Checks: the start page makes an icon set from a name, brief and icon list;
// the editor keeps the slide list but drops notes, Design and Transitions; the
// keyline overlay is drawn; doc_info hands an agent the set style and a ready
// path element; that path is accepted by write_slide, svg is refused; Apply
// set style corrects drift in one undo step; Draw with AI sends the empty
// icons; a comment on two selected icons goes to Claude for both; Export set
// writes one 24 × 24 currentColor SVG per icon plus icons.json.
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

const skip = (why) => { console.log(`test-iconset-e2e: SKIP — ${why}`); process.exit(0) }
const chromium = await loadChromium()
if (!chromium) skip('no playwright-core (set PLAYWRIGHT_CORE)')
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : skip('no build (npm run build:single in slides/) and no url given'))

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.error(`  FAIL  ${m}`) } }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('pageerror', (e) => console.error('pageerror', e.message))
await page.addInitScript(() => {
  window.__results = {}
  window.__prompts = []
  window.__exports = []
  const thenable = () => Promise.resolve(undefined)
  const impl = {
    userName: 'Tester',
    onAgentAction: (cb) => { window.__agent = cb },
    sendAgentActionResult: (r) => { window.__results[r.requestId] = r },
    onAgentQuery: (cb) => { window.__query = cb },
    sendAgentQueryResponse: (r) => { window.__results[r.requestId] = r },
    onSlideWrite: (cb) => { window.__slideWrite = cb },
    sendSlideWriteResult: (r) => { window.__results[r.requestId] = r },
    sendAgentPrompt: (kind, payload) => { window.__prompts.push({ kind, payload: JSON.parse(JSON.stringify(payload ?? null)) }) },
    exportIconset: (req) => { window.__exports.push(req); return Promise.resolve({ ok: true, path: '/tmp/x/' + req.folderName }) },
  }
  const absent = new Set(['iconFetch', 'setIconToken', 'iconTokenStatus', 'adoptIconTokens'])
  window.slidomingoDesktop = new Proxy(impl, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !absent.has(k) ? () => thenable() : undefined)),
  })
})
await page.goto(url)

// --- the start page: Icon set… → name, brief, icons → Create ------------------------
await page.locator('button.ed-sp-tile:has-text("Icon set…")').first().click({ timeout: 15000 })
await page.locator('.ed-startpick-flowcard input').first().fill('Forensics')
const areas = page.locator('.ed-startpick-flowcard textarea')
await areas.nth(0).fill('Digital forensics for a course: clean outline icons')
await areas.nth(1).fill('fingerprint\nevidence bag\nhash')
await page.locator('.ed-startpick-flowcard button:has-text("Create icon set")').click()
await page.waitForFunction(() => !!window.__agent && window.slidomingo?.doc?.kind === 'iconset', null, { timeout: 15000 })
await page.waitForTimeout(400)

const doc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.slidomingo.doc)))
let d = await doc()
ok(d.title === 'Forensics' && d.slides.map((s) => s.name).join() === 'fingerprint,evidence bag,hash', `an icon set with three named icons (${d.slides.map((s) => s.name)})`)
ok(d.iconset?.brief?.startsWith('Digital forensics') && d.size.width === 384, 'brief kept, 24-unit canvas at 384 px')

// --- the editor: a slide list, no deck-only chrome ------------------------------------
const ui = await page.evaluate(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
  return {
    root: document.querySelector('.ed-root')?.classList.contains('ed-iconset'),
    sidebar: vis(document.querySelector('.ed-sidebar')),
    notes: vis(document.querySelector('.ed-notes-pane')),
    tabs: [...document.querySelectorAll('.ed-ribbon-tab, [role="tab"]')].map((b) => b.textContent?.trim()),
    keyline: !!document.querySelector('.ed-stage-scale .ed-keyline svg rect'),
    panel: [...document.querySelectorAll('.ed-section')].map((h) => h.textContent),
  }
})
ok(ui.root && ui.sidebar && !ui.notes, `slide list shown, notes hidden (${JSON.stringify({ sidebar: ui.sidebar, notes: ui.notes })})`)
ok(!ui.tabs.some((x) => /Design|Transitions/.test(x ?? '')), `no Design or Transitions tab (${ui.tabs.join(', ')})`)
ok(ui.keyline, 'the keyline square/circle is drawn over the canvas')
ok(ui.panel.includes('Icon') && ui.panel.includes('Icon set'), `the Format panel shows the icon and the set (${ui.panel.join(', ')})`)
if (shots) await page.screenshot({ path: join(shots, 'iconset-editor.png') })

// --- agent: doc_info → pathElement → write_slide ---------------------------------------
let n = 0
async function query(verb, args = {}) {
  const id = `q${++n}`
  await page.evaluate(([id, verb, args]) => window.__query({ requestId: id, verb, args }), [id, verb, args])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 15000 })
  return page.evaluate((id) => window.__results[id], id)
}
async function writeSlide(slideId, slide) {
  const id = `w${++n}`
  await page.evaluate(([id, slide, slideId]) => window.__slideWrite({ requestId: id, slideId, slide }), [id, slide, slideId])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 15000 })
  return page.evaluate((id) => window.__results[id], id)
}
const info = (await query('doc_info')).result
ok(info.kind === 'iconset' && info.iconset?.grid === 24 && info.iconset.pathElement?.pathBox?.join() === '0,0,24,24', 'doc_info: kind, grid and a path element on the grid')
const outline = (await query('outline')).result
ok(outline.length === 3 && outline[0].name === 'fingerprint', 'outline lists the icons by name')
const first = d.slides[0]
const ring = { ...info.iconset.pathElement, id: 'ring', d: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18' }
const tick = { ...info.iconset.pathElement, id: 'tick', d: 'M8 12l3 3l5-6' }
const w1 = await writeSlide(first.id, { ...first, elements: [ring, tick] })
ok(w1.ok, `write_slide with path elements like pathElement is accepted (${w1.error ?? 'ok'})`)
const w2 = await writeSlide(first.id, { ...first, elements: [{ id: 'x', type: 'svg', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, markup: '<svg xmlns="http://www.w3.org/2000/svg"/>' }] })
ok(!w2.ok && /refused/.test(w2.error ?? ''), 'an svg element is refused')
await page.waitForTimeout(300)
const preview = await page.evaluate(() => [...document.querySelectorAll('.ed-iconset-preview img')].map((i) => i.getAttribute('width')).join())
ok(preview === '16,24,32,48', `the panel previews the icon at 16, 24, 32 and 48 px (${preview})`)

// --- Apply set style: drift corrected, one undo step -----------------------------------
await page.evaluate(() => {
  const el = window.slidomingo.doc.slides[0].elements[0]
  el.strokeWidth = 20
  el.stroke = '#555555'
})
await page.locator('[data-ui-tool="icon-style"]').first().click()
await page.waitForTimeout(200)
d = await doc()
ok(d.slides[0].elements.every((e) => e.strokeWidth === 32 && e.stroke === '#000000'), 'Apply set style puts every shape back on the set style')

// --- Draw with AI: the empty icons go to Claude --------------------------------------
await page.locator('[data-ui-tool="icon-draw"]').first().click()
await page.waitForTimeout(200)
const drawn = await page.evaluate(() => window.__prompts.find((p) => p.kind === 'draw-icons'))
ok(drawn?.payload?.icons?.map((i) => i.name).join() === 'evidence bag,hash' && drawn.payload.brief.startsWith('Digital'), `Draw with AI sends the two empty icons and the brief (${JSON.stringify(drawn?.payload?.icons?.map((i) => i.name))})`)

// --- one comment on two selected icons → Claude -------------------------------------------
const thumbs = page.locator('.ed-sidebar .ed-thumb')
await thumbs.nth(1).click()
await thumbs.nth(2).click({ modifiers: ['Shift'] })
await page.waitForTimeout(200)
await page.locator('[data-ui-tool="icon-comment"]').first().click()
await page.locator('dialog.ed-askdialog textarea').fill('thinner, more like the fingerprint')
await page.locator('dialog.ed-askdialog button.ed-primary').click()
await page.waitForTimeout(300)
const sent = await page.evaluate(() => window.__prompts.find((p) => p.kind === 'fix-comments'))
d = await doc()
ok(sent?.payload?.length === 2 && sent.payload.every((c) => c.text === 'thinner, more like the fingerprint'), `the comment went to Claude for both icons (${sent?.payload?.length})`)
ok(d.slides[1].comments?.length === 1 && d.slides[2].comments?.length === 1 && !d.slides[0].comments, 'one comment on each selected icon, none elsewhere')

// --- Export set ----------------------------------------------------------------------------
await page.locator('.ed-ribbon-tab:has-text("View"), [role="tab"]:has-text("View")').first().click()
await page.locator('[data-ui-tool="pdf"]:visible > button').first().click()
await page.locator('.ed-menu:visible button:has-text("Export icon set…")').first().click()
await page.waitForFunction(() => window.__exports.length > 0, null, { timeout: 10000 })
const exp = await page.evaluate(() => window.__exports[0])
const names = exp.files.map((f) => f.name)
ok(names.join() === 'fingerprint.svg,evidence-bag.svg,hash.svg,icons.json', `one SVG per icon plus icons.json (${names.join(', ')})`)
const svg = exp.files[0].text
ok(svg.includes('viewBox="0 0 24 24"') && svg.includes('stroke="currentColor"') && svg.includes('stroke-width="2"') && svg.includes('d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18"'), 'the SVG is on the 24 grid, ink as currentColor, the agent’s d kept')
const man = JSON.parse(exp.files.at(-1).text)
ok(man.format === 'slidomingo-icons' && man.icons.length === 3 && man.name === 'Forensics', 'icons.json names the set and its icons')
// the exported file renders: no stray stroke widths (it is a 24 px icon)
const rendered = await page.evaluate(async (svg) => {
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/currentColor/g, '#000'))
  await img.decode()
  const c = document.createElement('canvas')
  c.width = c.height = 24
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0, 24, 24)
  const px = g.getImageData(0, 0, 24, 24).data
  let ink = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] > 128) ink++
  return ink
}, svg)
ok(rendered > 40 && rendered < 300, `the exported icon draws a thin ring at 24 px (${rendered} inked px of 576)`)
if (shots) await page.screenshot({ path: join(shots, 'iconset-after.png') })

// --- no presenting --------------------------------------------------------------------------
const hidden = await page.evaluate(() => [...document.querySelectorAll('[data-ui-tool="present"], [data-ui-tool="notes"]')].every((b) => getComputedStyle(b).display === 'none'))
ok(hidden, 'present and notes buttons are hidden')

await browser.close()
console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`)
process.exit(failures ? 1 : 0)
