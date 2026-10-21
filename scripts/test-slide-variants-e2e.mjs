#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// propose_variants with HTML designs (editor.ts proposeVariants,
// variantpicker.ts) in a real browser:
//   1. HTML designs are laid out like slide_html writes; a broken one is
//      dropped with its reason, not the whole call; nothing touches the doc;
//   2. the compare view opens with every design, the slide's thumbnail gets
//      the ✨ pill; one design large, ← → flips (the current slide included),
//      Esc goes back, then closes WITHOUT discarding;
//   3. Use replaces the slide as ONE undo step, merged by id (an animation on
//      a kept id survives), and remembers the HTML (slide_html read gives it);
//   4. Keep current slide discards; a slide edited after the proposal warns.
//   node scripts/test-slide-variants-e2e.mjs [url] [--shots <dir>]
// url defaults to the built editor (npm run build:single first). --shots
// writes screenshots of the compare view. SKIPS with exit 0 without
// playwright-core or a build. Headless.
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
const skip = (why) => { console.log(`test-slide-variants-e2e: SKIP — ${why}`); process.exit(0) }
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : null)
if (!url) skip('no build and no url given')
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')
let browser
try { browser = await chromium.launch({ headless: true }) } catch (e) { skip(`no browser: ${String(e.message).split('\n')[0]}`) }

let checks = 0, failures = 0
const ok = (c, m, d) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.log(`  FAIL  ${m}${d === undefined ? '' : ' — ' + JSON.stringify(d).slice(0, 400)}`) } }

// ---- the editor, with the desktop bridge faked (as test-slide-html-e2e.mjs)
const page = await (await browser.newContext({ viewport: { width: 1500, height: 940 } })).newPage()
const errors = []
page.on('pageerror', (e) => { errors.push(e.message); if (process.env.DEBUG_STACK) console.log('PAGEERROR', e.stack) })
await page.addInitScript(() => {
  window.__results = {}
  const impl = {
    onAgentAction: (cb) => { window.__agent = cb },
    sendAgentActionResult: (r) => { window.__results[r.requestId] = r },
  }
  window.slidomingoDesktop = new Proxy(impl, { get: (t, k) => (k in t ? t[k] : () => Promise.resolve(undefined)) })
})
await page.goto(url)
await page.waitForTimeout(1500)
const blank = page.locator('button:visible:has-text("Blank")').first()
if (await blank.count()) await blank.click()
await page.waitForFunction(() => !!window.__agent && !!window.beeslides?.doc, null, { timeout: 20000 })
await page.waitForTimeout(400)
// the faked bridge answers every desktop call with undefined; what that
// trips while booting is not this rig's business (as test-slide-html-e2e.mjs)
errors.splice(0)

let rq = 0
async function act(verb, args) {
  const id = `r${++rq}`
  await page.evaluate(([id, verb, args]) => window.__agent({ requestId: id, verb, args }), [id, verb, args])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 60000 })
  return page.evaluate((id) => window.__results[id], id)
}
const doc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.beeslides.doc)))
const slideOf = async (id) => (await doc()).slides.find((s) => s.id === id)
const shot = async (name) => { if (shots) writeFileSync(join(shots, `${name}.png`), await page.screenshot()) }
const dialogOpen = () => page.evaluate(() => !!document.querySelector('dialog.ed-variants[open]'))

// ---- a slide to redesign: a title (with an animation) and three points
const add = await act('deck', { op: 'add', slideType: 'layout-blank' })
const sid = /\b(slide-[\w-]+)/.exec(add.summary ?? '')?.[1] ?? (await doc()).slides.at(-1).id
const POINTS = ['Faster reviews', 'Fewer meetings', 'One source of truth']
const w = await act('slide_html', {
  op: 'write', slideId: sid,
  css: '.s{padding:72px var(--bs-margin);display:flex;flex-direction:column;gap:24px} h1{margin:0;font-size:56px} ul{font-size:30px}',
  html: `<main class="s"><h1 id="title">Why it matters</h1><ul id="pts">${POINTS.map((p) => `<li>${p}</li>`).join('')}</ul></main>`,
})
ok(w.ok, 'the starting slide is written from HTML', w.error)
await act('elements', { op: 'edit', slideId: sid, changes: [{ id: 'title', fx: { enter: 'fade-up' } }] })
const before = await slideOf(sid)

const cards = {
  label: 'Three cards', note: 'Each point gets its own card',
  css: '.s{padding:72px var(--bs-margin);display:flex;flex-direction:column;gap:40px;height:100%} h1{margin:0;font-size:52px} .row{display:flex;gap:28px} .c{flex:1;background:#fff;border-radius:18px;padding:32px;box-shadow:0 8px 24px rgba(0,0,0,.12);font-size:28px;font-weight:600}',
  html: `<main class="s"><h1 id="title">Why it matters</h1><div class="row">${POINTS.map((p, i) => `<div class="c" id="card${i}">${p}</div>`).join('')}</div></main>`,
}
const big = {
  label: 'One big statement', note: 'Leads with the strongest point',
  css: 'body{background:var(--bs-accent)} .s{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 var(--bs-margin);gap:20px} h1{margin:0;font-size:96px;line-height:1.05} p{margin:0;font-size:28px;opacity:.8}',
  html: `<main class="s"><h1 id="title">One source of truth</h1><p id="sub">${POINTS.slice(0, 2).join(' · ')}</p></main>`,
}
const split = {
  label: 'Split',
  css: '.s{height:100%;display:grid;grid-template-columns:1fr 1fr} .l{background:#17120A;color:#fff;padding:72px;display:flex;align-items:flex-end} .r{padding:72px;display:flex;flex-direction:column;justify-content:center;gap:28px;font-size:30px} h1{margin:0;font-size:60px}',
  html: `<main class="s"><div class="l" id="left"><h1 id="title">Why it matters</h1></div><div class="r">${POINTS.map((p, i) => `<div id="p${i}">${p}</div>`).join('')}</div></main>`,
}

console.log('-- propose: HTML designs, a broken one dropped, the doc untouched --')
const r = await act('propose_variants', { slideId: sid, variants: [cards, big, { label: 'Empty', html: '   ' }, split] })
ok(r.ok && r.count === 3, 'three of four designs made', r)
ok(Array.isArray(r.dropped) && r.dropped.length === 1 && /variant 3/.test(r.dropped[0]), 'the empty one is dropped with its number and reason', r.dropped)
ok(JSON.stringify(await slideOf(sid)) === JSON.stringify(before), 'nothing on the slide changed')
await page.waitForTimeout(300)
ok(await dialogOpen(), 'the compare view opens')
const grid = await page.evaluate(() => ({
  cards: document.querySelectorAll('.ed-variants-card').length,
  labels: [...document.querySelectorAll('.ed-variants-card .ed-variants-label')].map((e) => e.textContent),
  notes: [...document.querySelectorAll('.ed-variants-card .ed-variants-note')].map((e) => e.textContent),
  title: document.querySelector('.ed-variants-title')?.textContent,
  warn: document.querySelector('.ed-variants-warn')?.hidden,
  pill: document.querySelector('.ed-sidebar .ed-thumb-variants')?.textContent,
  fits: (() => { const d = document.querySelector('dialog.ed-variants').getBoundingClientRect(); return d.bottom <= innerHeight && d.right <= innerWidth })(),
}))
ok(grid.cards === 3, 'three cards', grid.cards)
ok(JSON.stringify(grid.labels) === JSON.stringify(['Three cards', 'One big statement', 'Split']), 'labels as given', grid.labels)
ok(grid.notes.length === 2 && grid.notes[1] === 'Leads with the strongest point', 'notes shown where given', grid.notes)
ok(/3/.test(grid.title ?? ''), 'title says how many', grid.title)
ok(grid.warn === true, 'no "changed since" warning on an untouched slide')
ok(grid.pill === '3', 'the slide thumbnail carries the ✨ 3 pill', grid.pill)
ok(grid.fits, 'the view fits the window')
await shot('1-grid')

console.log('-- one design large; flip; Esc back, Esc closes without discarding --')
await page.keyboard.press('2')
await page.waitForTimeout(150)
let stage = await page.evaluate(() => ({
  one: document.querySelector('dialog.ed-variants')?.classList.contains('ed-variants-one'),
  label: document.querySelector('.ed-variants-caption .ed-variants-label')?.textContent,
  tabs: document.querySelectorAll('.ed-variants-tab').length,
  sel: [...document.querySelectorAll('.ed-variants-tab')].findIndex((t) => t.getAttribute('aria-selected') === 'true'),
}))
ok(stage.one && stage.label === 'One big statement' && stage.tabs === 4 && stage.sel === 2, 'key 2 shows design 2 large, with the current slide + 3 in the strip', stage)
await shot('2-one')
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(100)
stage = await page.evaluate(() => ({
  label: document.querySelector('.ed-variants-caption .ed-variants-label')?.textContent,
  useDisabled: [...document.querySelectorAll('.ed-variants-foot .ed-primary')].find((b) => !b.hidden)?.disabled,
}))
ok(stage.label === 'Current slide' && stage.useDisabled === true, '→ past the last design wraps to the current slide (nothing to use)', stage)
await shot('3-current')
await page.keyboard.press('Escape')
await page.waitForTimeout(100)
ok(await dialogOpen() && await page.evaluate(() => document.querySelectorAll('.ed-variants-card').length === 3), 'Esc goes back to all designs')
await page.keyboard.press('Escape')
await page.waitForTimeout(150)
ok(!(await dialogOpen()), 'Esc again closes the view')
ok(await page.evaluate(() => document.querySelector('.ed-sidebar .ed-thumb-variants')?.textContent) === '3', 'the designs are still waiting (pill kept)')
await page.click('.ed-sidebar .ed-thumb-variants')
await page.waitForTimeout(150)
ok(await dialogOpen(), 'the pill reopens the view')

console.log('-- Use: one undo step, merged by id, HTML remembered --')
await page.locator('.ed-variants-card').nth(0).locator('.ed-variants-use').click()
await page.waitForTimeout(250)
ok(!(await dialogOpen()), 'the view closes on Use')
const used = await slideOf(sid)
const byId = new Map(used.elements.map((e) => [e.id, e]))
ok(['card0', 'card1', 'card2'].every((id) => byId.has(id)), 'the cards are on the slide', [...byId.keys()])
ok(byId.get('title')?.fx?.enter === 'fade-up', 'the title kept its animation (same id)')
ok(!byId.has('pts'), 'the old list is gone')
ok(!!used.htmlSource, 'the HTML is remembered on the slide')
const read = await act('slide_html', { op: 'read', slideId: sid })
ok(/the source it was written from/.test(read.summary ?? '') && /card1/.test(read.summary ?? ''), 'slide_html read hands the design\'s own HTML back')
ok(await page.evaluate(() => !document.querySelector('.ed-sidebar .ed-thumb-variants')), 'the pill is gone')
await page.evaluate(() => window.beeslides.undo())
await page.waitForTimeout(150)
const undone = await slideOf(sid)
ok(JSON.stringify(undone.elements.map((e) => e.id)) === JSON.stringify(before.elements.map((e) => e.id)), 'one undo brings the old slide back')

console.log('-- Keep current slide; a slide changed since warns --')
const r2 = await act('propose_variants', { slideId: sid, variants: [cards, big] })
ok(r2.ok && r2.count === 2, 'a second set is proposed', r2)
await page.waitForTimeout(200)
await page.locator('.ed-variants-foot button', { hasText: 'Keep current slide' }).click()
await page.waitForTimeout(150)
ok(!(await dialogOpen()) && JSON.stringify((await slideOf(sid)).elements.map((e) => e.id)) === JSON.stringify(before.elements.map((e) => e.id)), 'Keep current slide closes and changes nothing')
ok(await page.evaluate(() => !document.querySelector('.ed-sidebar .ed-thumb-variants')), 'and the designs are discarded')
await act('propose_variants', { slideId: sid, variants: [split] })
await page.waitForTimeout(200)
await page.keyboard.press('Escape')
await act('update_element', { slideId: sid, elementId: 'title', props: { color: '#C0392B' } })
await page.click('.ed-sidebar .ed-thumb-variants')
await page.waitForTimeout(150)
ok(await page.evaluate(() => document.querySelector('.ed-variants-warn')?.hidden === false), 'edited after the proposal: the view warns before Use replaces it')
await shot('4-warn')
await page.keyboard.press('Escape')

console.log('-- a whole-slide design is still accepted; a wrong id is dropped --')
const asSlide = { ...(await slideOf(sid)), elements: (await slideOf(sid)).elements.slice(0, 1) }
const r3 = await act('propose_variants', { slideId: sid, variants: [{ slide: asSlide, label: 'Title only' }, { slide: { ...asSlide, id: 'nope' } }] })
ok(r3.ok && r3.count === 1 && /slide\.id must be/.test(r3.dropped?.[0] ?? ''), 'slide-shaped design kept, the mismatched one dropped', r3)
const r4 = await act('propose_variants', { slideId: sid, variants: [{ html: '' }] })
ok(!r4.ok && /no-valid-variants/.test(r4.error ?? ''), 'nothing valid: an error naming why', r4)

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
