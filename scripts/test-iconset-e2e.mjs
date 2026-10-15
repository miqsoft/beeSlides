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
// Checks: the Icon set tile opens an empty set; name and brief are set in
// the panel; its Plan with AI box sends a free-text request to Claude; Claude's plan (icons op "plan") arrives
// as empty, named icons;
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

// --- the start page: Icon set → straight into the editor, an empty set ----------------
await page.locator('button.ed-sp-tile:has-text("Icon set")').first().click({ timeout: 15000 })
await page.waitForFunction(() => !!window.__agent && window.slidomingo?.doc?.kind === 'iconset', null, { timeout: 15000 })
await page.waitForTimeout(400)

const doc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.slidomingo.doc)))
let d = await doc()
ok(d.slides.length === 1 && !d.slides[0].elements.length && d.size.width === 384, 'the tile opens the editor on a new, empty icon set (24 units at 384 px)')

// name and brief are set in the panel, later — no intro step
const rowInput = (label) => page.locator('.ed-row', { has: page.locator(`span:text-is("${label}")`) }).locator('input, textarea').first()
await rowInput('Set name').fill('Forensics')
await rowInput('Set name').press('Tab')
await rowInput('Brief').fill('Digital forensics for a course: clean outline icons')
await rowInput('Brief').press('Tab')
await page.waitForTimeout(200)
d = await doc()
ok(d.title === 'Forensics' && d.iconset?.brief?.startsWith('Digital forensics'), `name and brief set from the panel (${d.title})`)

// Plan with AI: free text in the panel → Claude
await page.locator('textarea.ed-iconset-ask').fill('think about 3 icons for evidence handling')
await page.locator('.ed-btn-block:has-text("Plan with AI")').click()
await page.waitForTimeout(200)
const planAsk = await page.evaluate(() => window.__prompts.find((p) => p.kind === 'plan-icons'))
ok(planAsk?.payload?.request === 'think about 3 icons for evidence handling' && planAsk.payload.brief.startsWith('Digital'), 'Plan with AI sends the request in the user\'s words, with the brief')

// Claude answers with a plan (the agent `icons` op "plan"): empty, named icons
let n = 0
async function act(verb, args) {
  const id = `a${++n}`
  await page.evaluate(([id, verb, args]) => window.__agent({ requestId: id, verb, args }), [id, verb, args])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 15000 })
  return page.evaluate((id) => window.__results[id], id)
}
const planned = await act('icons', { op: 'plan', icons: [
  { name: 'fingerprint', prompt: 'a fingerprint inside a magnifier', keywords: ['print'] },
  { name: 'evidence bag', prompt: 'a sealed bag with a tag' },
  { name: 'hash', prompt: 'a # on a document' },
] })
d = await doc()
ok(planned.ok && d.slides.map((s) => s.name).join() === 'fingerprint,evidence bag,hash' && d.slides.every((s) => !s.elements.length), `the plan arrives as three empty, named icons (${d.slides.map((s) => s.name)})`)
await page.waitForTimeout(300)
const drawLabel = await page.evaluate(() => [...document.querySelectorAll('.ed-btn-block')].map((b) => b.textContent).find((x) => /^Draw/.test(x ?? '')))
ok(drawLabel === 'Draw 3 empty icons', `the panel offers to draw what was planned (${drawLabel})`)

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
ok(ui.panel.includes('Plan with AI') && ui.panel.includes('Icon') && ui.panel.includes('Icon set'), `the Format panel: plan, this icon, the set (${ui.panel.join(', ')})`)
if (shots) await page.screenshot({ path: join(shots, 'iconset-editor.png') })

// --- agent: doc_info → pathElement → write_slide ---------------------------------------
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
ok(drawn?.payload?.icons?.map((i) => i.name).join() === 'evidence bag,hash' && drawn.payload.icons[0].prompt === 'a sealed bag with a tag' && drawn.payload.brief.startsWith('Digital'), `Draw with AI sends the two empty icons with their plan and the brief (${JSON.stringify(drawn?.payload?.icons?.map((i) => i.name))})`)

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

// --- icon styles (DECISIONS "Icon styles") ---------------------------------------------------
// draw the other two icons with parts, so every style has something to paint
const pe = info.iconset.pathElement
const part = (id, d, iconPart, over = {}) => ({ ...pe, id, d, iconPart, ...over })
d = await doc()
await writeSlide(d.slides[1].id, { ...d.slides[1], elements: [
  part('bag', 'M5 8H19V20H5Z', 'body'), part('flap', 'M5 8L8 4H16L19 8', 'detail'), part('tag', 'M14 12H17V15H14Z', 'accent'),
] })
await writeSlide(d.slides[2].id, { ...d.slides[2], elements: [
  part('page', 'M6 3H14L18 7V21H6Z', 'body'), part('h1', 'M10 10V17', 'detail'), part('h2', 'M14 10V17', 'detail'), part('h3', 'M8.5 12H15.5', 'detail'), part('h4', 'M8.5 15H15.5', 'detail'),
] })
await thumbs.nth(0).click()
await page.waitForTimeout(300)
const sections = await page.evaluate(() => [...document.querySelectorAll('.ed-section')].map((h) => h.textContent))
ok(sections.includes('Styles'), `the panel has a Styles section (${sections.join(', ')})`)
await page.locator('.ed-section[data-key="Styles"]').evaluate((h) => h.scrollIntoView())
const cards = () => page.evaluate(() => [...document.querySelectorAll('.ed-looks:not(.ed-looks-small) .ed-look-card:not(.ed-look-add) span')].map((s) => s.textContent))
ok((await cards()).join() === 'Set style', 'one card at first: the set style')
await page.locator('.ed-look-add').click()
await page.waitForTimeout(150)
const presetNames = await page.evaluate(() => [...document.querySelectorAll('.ed-look-drawer .ed-looks-small .ed-look-card span')].map((s) => s.textContent))
ok(presetNames.length >= 10 && presetNames.includes('Comic') && presetNames.includes('Badge'), `the drawer offers the presets, each previewing this icon (${presetNames.slice(0, 10).join(', ')})`)
if (shots) await page.screenshot({ path: join(shots, 'iconstyles-drawer.png') })
await page.locator('.ed-look-drawer .ed-look-card:has(span:text-is("Comic"))').click()
await page.waitForTimeout(200)
d = await doc()
ok(d.iconset.variants?.length === 1 && d.iconset.variants[0].name === 'Comic' && d.iconset.variants[0].shadow, 'a preset click adds the Comic style to the set')
ok((await cards()).join() === 'Set style,Comic', 'the gallery shows it, picked')
await rowInput('Line weight (×)').fill('2')
await rowInput('Line weight (×)').press('Tab')
await page.waitForTimeout(150)
d = await doc()
ok(d.iconset.variants[0].stroke.weight === 2, 'its settings edit the style')
if (shots) await page.screenshot({ path: join(shots, 'iconstyles-editor.png') })

// My styles: saved app-wide, offered in the drawer
await page.locator('.ed-look-actions button:has-text("Save to My styles")').click()
const mine = await page.evaluate(() => JSON.parse(localStorage.getItem('slidomingo-icon-styles-v1') ?? '[]'))
ok(mine.length === 1 && mine[0].name === 'Comic' && mine[0].stroke.weight === 2, 'Save to My styles keeps it in the app')
await page.locator('.ed-look-add').click()
await page.waitForTimeout(150)
const mineCards = await page.evaluate(() => [...document.querySelectorAll('.ed-look-drawer .ed-looks-small')].at(-1)?.textContent ?? '')
ok(mineCards.includes('Comic'), 'and the drawer offers it under My styles')

// learn from a hand-painted icon
await page.evaluate(() => {
  const s = window.slidomingo.doc.slides[0]
  s.elements[0].fill = '#22c55e'
  s.elements.forEach((e) => { e.stroke = '#14532d'; e.strokeWidth = 40 })
})
await page.locator('.ed-look-drawer button:has-text("From this icon")').click()
await page.waitForTimeout(200)
d = await doc()
const learned = d.iconset.variants.at(-1)
ok(learned?.name.startsWith('Learned from') && learned.stroke.color === '#14532d' && learned.stroke.weight === 1.25 && learned.fill?.body?.color === '#22c55e', `From this icon learns colour, weight and fill (${JSON.stringify(learned?.stroke)})`)
ok(d.slides[0].elements.every((e) => e.stroke === '#000000' && e.strokeWidth === 32 && e.fill === 'transparent'), 'and the painted icon is back in the set style')
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
await page.waitForTimeout(150)
d = await doc()
ok(d.slides[0].elements[0].fill === '#22c55e' && d.iconset.variants.length === 2, 'one undo brings the paint back, the learned style stays')
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
await page.waitForTimeout(150)

// paste a shared style
await page.locator('.ed-look-add').click()
await page.waitForTimeout(150)
await page.locator('.ed-look-drawer button:has-text("Paste style")').click()
await page.locator('dialog.ed-askdialog textarea').fill(JSON.stringify({ format: 'slidomingo-icon-style', version: 1, style: { name: 'Shared badge', stroke: { weight: 1.2, color: '#ffffff' }, tile: { shape: 'rounded', color: '#0f766e' } } }))
await page.locator('dialog.ed-askdialog button.ed-primary').click()
await page.waitForTimeout(200)
d = await doc()
ok(d.iconset.variants.at(-1)?.name === 'Shared badge' && d.iconset.variants.at(-1).tile?.shape === 'rounded', 'Paste style adds a shared style')

// Describe with AI → Claude; its icons op "style" adds the look
await page.locator('.ed-look-add').click()
await page.waitForTimeout(150)
await page.locator('.ed-look-drawer button:has-text("Describe with AI")').click()
await page.locator('dialog.ed-askdialog textarea').fill('soft pastel, rounded, no outlines feel')
await page.locator('dialog.ed-askdialog button.ed-primary').click()
await page.waitForTimeout(150)
const styleAsk = await page.evaluate(() => window.__prompts.find((p) => p.kind === 'style-icons'))
ok(styleAsk?.payload?.request === 'soft pastel, rounded, no outlines feel', 'Describe with AI sends the look in the user\'s words')
const viaAi = await act('icons', { op: 'style', name: 'Pastel', weight: 0.8, color: '#64748b', body: '#fbcfe8', accent: '#a5f3fc', cap: 'round' })
d = await doc()
ok(viaAi.ok && d.iconset.variants.at(-1)?.name === 'Pastel', 'Claude\'s style op adds it')
await page.waitForTimeout(200)
if (shots) await page.screenshot({ path: join(shots, 'iconstyles-gallery.png') })

// compare every icon in every style
await page.locator('button:has-text("Compare all styles…")').click()
await page.waitForTimeout(250)
const sheet = await page.evaluate(() => ({ rows: document.querySelectorAll('dialog.ed-look-sheet tbody tr').length, imgs: document.querySelectorAll('dialog.ed-look-sheet tbody img').length }))
ok(sheet.rows === 5 && sheet.imgs === 15, `Compare shows 3 icons × 5 styles (${JSON.stringify(sheet)})`)
if (shots) await page.locator('dialog.ed-look-sheet').screenshot({ path: join(shots, 'iconstyles-sheet.png') })
await page.locator('dialog.ed-look-sheet .ed-seg button').nth(1).click()
await page.waitForTimeout(150)
if (shots) await page.locator('dialog.ed-look-sheet').screenshot({ path: join(shots, 'iconstyles-sheet-dark.png') })
await page.locator('dialog.ed-look-sheet button:has-text("Close")').click()

// the export: a folder per style, listed in icons.json
await page.locator('[data-ui-tool="pdf"]:visible > button').first().click()
await page.locator('.ed-menu:visible button:has-text("Export icon set…")').first().click()
await page.waitForFunction(() => window.__exports.length > 1, null, { timeout: 10000 })
const exp2 = await page.evaluate(() => window.__exports[1])
const names2 = exp2.files.map((f) => f.name)
ok(names2.includes('comic/fingerprint.svg') && names2.includes('pastel/hash.svg') && names2.includes('shared-badge/evidence-bag.svg') && names2.length === 3 + 4 * 3 + 1, `one folder per style (${names2.length} files)`)
const man2 = JSON.parse(exp2.files.at(-1).text)
ok(man2.styles?.map((x) => x.folder).join() === 'comic,learned-from-fingerprint,shared-badge,pastel' && man2.icons.some((i) => i.file === 'comic/hash.svg' && i.keywords?.includes('Comic')), 'icons.json lists the styles; each copy is searchable by its style')
const comicSvg = exp2.files.find((f) => f.name === 'comic/fingerprint.svg').text
ok(comicSvg.includes('<g transform="translate(0.9 0.9)">') && comicSvg.includes('#ffd23f'), 'the comic file carries its shadow and colours')

// --- no presenting --------------------------------------------------------------------------
const hidden = await page.evaluate(() => [...document.querySelectorAll('[data-ui-tool="present"], [data-ui-tool="notes"]')].every((b) => getComputedStyle(b).display === 'none'))
ok(hidden, 'present and notes buttons are hidden')

await browser.close()
console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`)
process.exit(failures ? 1 : 0)
