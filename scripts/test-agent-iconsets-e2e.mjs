#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icons from an icon-set FILE into a deck (DECISIONS 2026-10-25), in a real
// browser:
//   node scripts/test-agent-iconsets-e2e.mjs [url] [--shots <dir>]
// url defaults to slides/dist-single/BeeSlides.beeslides.html (npm run
// build:single first). Main's half runs here in node: the set file is made
// with desktop newdocs.ts (what open_deck create:true kind:"iconset" writes)
// plus three drawn icons and a style, written to disk, and read back with
// docfile.ts iconSetDocText as agenticonsets.ts does; a fake
// window.slidomingoDesktop then delivers the `icons` actions with that
// `iconSet`, exactly as agentbridge.ts sends them. Needs playwright-core
// (same lookup as test-agent-icons-e2e.mjs); SKIPS with exit 0 without it.
//
// Checks: search lists the drawn icons and styles; insert puts an svg built
// from the drawing on the slide in the deck accent, rendered sanitized and
// recorded with the set's provenance; a style by name; one undo step per
// insert; the thumbnail (an <img>) shows the ink too; without iconSet (the
// browser) a clear error. The Electron half (agentbridge → main reading the
// file, flushing an open set window) is desktop/scripts/e2e-background.mjs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { newIconsetFileDoc } from '../desktop/src/main/newdocs.ts'
import { iconSetDocText } from '../desktop/src/main/docfile.ts'

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

const skip = (why) => { console.log(`test-agent-iconsets-e2e: SKIP — ${why}`); process.exit(0) }
const chromium = await loadChromium()
if (!chromium) skip('no playwright-core (set PLAYWRIGHT_CORE)')
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : skip('no build (npm run build:single in slides/) and no url given'))

// ---- main's half: a set file on disk, read back as agenticonsets.ts does ----
const set = newIconsetFileDoc('talk.icons')
const path = (id, d, part, extra = {}) => ({
  id, type: 'shape', shape: 'path', x: 0, y: 0, w: 384, h: 384, rotation: 0, opacity: 1, radius: 0, pathBox: [0, 0, 24, 24], d,
  fill: 'transparent', stroke: '#000000', strokeWidth: 32, strokeCap: 'round', strokeJoin: 'round', iconPart: part, ...extra,
})
set.title = 'Talk icons'
set.iconset.license = 'CC-BY-4.0'
set.iconset.author = 'The talk'
set.iconset.variants = [{ id: 'look-deck', name: 'Deck bold', stroke: { weight: 1.5, color: '#000000' } }]
set.slides = [
  { id: 'ic-cloud', name: 'cloud', icon: { prompt: 'a cloud', keywords: ['weather', 'server'] }, background: '#FFFFFF', transition: 'none', notes: '',
    elements: [path('c1', 'M7 18 H17 A4 4 0 0 0 17 10 A5 5 0 0 0 7.5 9 A4.5 4.5 0 0 0 7 18 Z', 'body')] },
  { id: 'ic-lock', name: 'lock', icon: { prompt: 'a padlock' }, background: '#FFFFFF', transition: 'none', notes: '',
    elements: [path('l1', 'M6 11 H18 V20 H6 Z', 'body'), path('l2', 'M8.5 11 V8 A3.5 3.5 0 0 1 15.5 8 V11', 'detail'), path('l3', 'M12 14.5 V16.5', 'detail')] },
  { id: 'ic-chart', name: 'chart', icon: { prompt: 'rising bars' }, background: '#FFFFFF', transition: 'none', notes: '',
    elements: [path('b1', 'M5 19 V13 M10 19 V9 M15 19 V11 M20 19 V5', 'detail')] },
  { id: 'ic-todo', name: 'todo', background: '#FFFFFF', transition: 'none', notes: '', elements: [] },
]
const dir = mkdtempSync(join(tmpdir(), 'bs-iconsets-'))
const setFile = join(dir, 'talk.icons.beeslides.html')
writeFileSync(setFile, `<!DOCTYPE html><html><head><title>Talk icons — BeeSlides</title><script type="application/beeslides+json" id="beeslides-doc">\n${JSON.stringify(set).replace(/</g, '\\u003c')}\n</script></head><body></body></html>`)
const read = iconSetDocText(readFileSync(setFile, 'utf8'))
if ('error' in read) { console.error(`FAIL  main could not read the set: ${read.error}`); process.exit(1) }
const iconSet = { file: 'talk.icons.beeslides.html', text: read.text }

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.error(`  FAIL  ${m}`) } }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (e) => console.error('pageerror', e.message))
await page.addInitScript(() => {
  localStorage.setItem('slidomingo-icon-sources', '[]')
  window.__results = {}
  const thenable = () => Promise.resolve(undefined)
  const impl = {
    onAgentAction: (cb) => { window.__agent = cb },
    sendAgentActionResult: (r) => { window.__results[r.requestId] = r },
  }
  const absent = new Set(['iconFetch', 'setIconToken', 'iconTokenStatus', 'adoptIconTokens'])
  window.slidomingoDesktop = new Proxy(impl, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !absent.has(k) ? () => thenable() : undefined)),
  })
})
await page.goto(url)
await page.waitForTimeout(1500)
const blank = page.locator('button:visible:has-text("Blank")').first()
if (await blank.count()) await blank.click()
await page.waitForFunction(() => !!window.__agent && !!window.beeslides?.doc, null, { timeout: 15000 })

let n = 0
async function act(verb, args, extra = {}) {
  const id = `r${++n}`
  await page.evaluate(([id, verb, args, extra]) => window.__agent({ requestId: id, verb, args, ...extra }), [id, verb, args, extra])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 15000 })
  return page.evaluate((id) => window.__results[id], id)
}

const accent = await page.evaluate(() => window.beeslides.doc.theme.accent)
const slideId = await page.evaluate(() => window.beeslides.doc.slides[0].id)
const count = () => page.evaluate(() => window.beeslides.doc.slides[0].elements.length)
const n0 = await count()

const found = await act('icons', { op: 'search', query: '', set: setFile }, { iconSet })
ok(found.ok && found.refs.length === 3 && found.summary.includes('“Talk icons”') && found.summary.includes('"Deck bold"') && found.summary.includes('1 icon(s) of the set are not drawn yet'), `search lists the 3 drawn icons, the style, the undrawn one (${found.summary?.split('\n')[0]})`)
const lockRef = found.refs[1]
const xs = [200, 420, 640]
const ids = []
for (const [k, ref] of found.refs.entries()) {
  const r = await act('icons', { op: 'insert', slideId, ref, x: xs[k], y: 300, size: 160, alt: '' })
  ok(r.ok, `insert ${ref}: ${r.summary ?? r.error}`)
  ids.push(r.elementId)
}
const els = await page.evaluate((ids) => ids.map((id) => window.beeslides.doc.slides[0].elements.find((e) => e.id === id)), ids)
const markup = await page.evaluate((k) => window.beeslides.doc.assets?.[k], els[1]?.asset)
ok(els.every((e) => e?.type === 'svg' && e.w === 160) && typeof markup === 'string' && markup.includes(`stroke="${accent}"`) && !markup.includes('currentColor'), `svg elements in the deck accent ${accent}`)
ok(els[1].provenance?.origin === 'Icon set Talk icons (talk.icons.beeslides.html)' && els[1].provenance.license === 'CC-BY-4.0' && els[1].provenance.author === 'The talk', `provenance names the set (${JSON.stringify(els[1].provenance)})`)
await page.waitForTimeout(300)
const dom = await page.evaluate((id) => {
  const node = document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`)
  const p = node?.querySelector('svg path')
  return p ? { paths: node.querySelectorAll('svg path').length, stroke: getComputedStyle(p).stroke, w: node.getBoundingClientRect().width } : null
}, ids[1])
ok(dom?.paths === 3 && /rgb/.test(dom.stroke) && dom.w > 0, `the lock is drawn on the canvas, 3 paths (${JSON.stringify(dom)})`)
const thumbInk = await page.evaluate((id) => {
  const img = document.querySelector(`.ed-sidebar [data-el-id="${id}"] img`)
  return img ? decodeURIComponent(img.getAttribute('src') ?? '').includes('stroke=') : null
}, ids[1])
ok(thumbInk !== false, `the thumbnail (an <img>, no inherited colour) carries the ink itself (${thumbInk})`)
const bold = await act('icons', { op: 'insert', slideId, ref: lockRef, style: 'deck bold', x: 860, y: 300, size: 160 })
const boldEl = await page.evaluate((id) => window.beeslides.doc.slides[0].elements.find((e) => e.id === id), bold.elementId)
const boldMarkup = await page.evaluate((k) => window.beeslides.doc.assets?.[k], boldEl?.asset)
ok(bold.ok && bold.summary.includes('"Deck bold"') && boldMarkup?.includes('stroke-width="3"'), `a style by name: 1.5 × the set stroke (${bold.summary})`)
ok(await count() === n0 + 4, 'four icons on the slide')
await page.evaluate(() => document.activeElement?.blur())
await page.keyboard.press('Meta+z')
await page.waitForTimeout(200)
ok(await count() === n0 + 3, 'undo removes exactly the last icon')
const browserOnly = await act('icons', { op: 'search', query: '', set: setFile })
ok(!browserOnly.ok && /desktop app/.test(browserOnly.error), `without main's iconSet (the browser): ${browserOnly.error?.slice(0, 80)}…`)
const forged = await act('icons', { op: 'search', query: '', set: setFile }, { iconSet: { file: 'x', text: '{"format":"beeslides/slides","slides":[{"id":"a","elements":[]}]}' } })
ok(!forged.ok && /not an icon set/.test(forged.error), 'a document that is not a set is refused by the editor too')

if (shots) {
  await page.evaluate(() => document.querySelector('.ed-stage-scale')?.scrollIntoView())
  await page.screenshot({ path: join(shots, 'agent-iconsets.png') })
}
await browser.close()
console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nall ${checks} checks passed`)
process.exit(failures ? 1 : 0)
