#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The `icons` AGENT tool (agentops/spec.ts → editor/agentops.ts → the
// editor's agentIcons) in a real browser, against a MOCK icon server:
//   node scripts/test-agent-icons-e2e.mjs [url] [--shots <dir>]
// url defaults to the built editor, slides/dist-single/BeeSlides.beeslides.html
// (npm run build:single first); pass http://localhost:<port>/ for a dev server.
// A fake window.slidomingoDesktop plays main: agent actions go in through
// onAgentAction exactly as the desktop app delivers them. Needs playwright-core
// (same lookup as test-icons-e2e.mjs); SKIPS with exit 0 without it or a build.
//
// Checks: search lists refs from the server configured in Settings; insert
// puts an svg at the exact frame, interns the markup, renders it sanitized;
// a png becomes an image; one undo step per insert; unknown slide refused;
// insert_elements (refactored to share the path) still works; an unreachable
// server comes back as an error that names the reason and Settings.
import { createServer } from 'node:http'
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

const skip = (why) => { console.log(`test-agent-icons-e2e: SKIP — ${why}`); process.exit(0) }
const chromium = await loadChromium()
if (!chromium) skip('no playwright-core (set PLAYWRIGHT_CORE)')
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : skip('no build (npm run build:single in slides/) and no url given'))
const SVG = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${c}"/><script>window.__pwned=1</script></svg>`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const ICONS = [
  { relative_path: 'cloud/cloud-upload.svg', display_name: 'Cloud upload', category: 'cloud', description: 'Upload to the cloud', license: 'MIT', author: 'Cloud Co' },
  { relative_path: 'cloud/cloud.svg', display_name: 'Cloud' },
  { relative_path: 'people/user.png', display_name: 'User' },
]
let hits = 0
const server = createServer((req, res) => {
  hits++
  res.setHeader('Access-Control-Allow-Origin', '*')
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/api/search') {
    const q = (u.searchParams.get('q') ?? '').toLowerCase()
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ results: ICONS.filter((i) => i.display_name.toLowerCase().includes(q)) }))
  } else if (u.pathname.startsWith('/files/')) {
    const p = decodeURIComponent(u.pathname.slice(7))
    if (p.endsWith('.png')) { res.setHeader('Content-Type', 'image/png'); res.end(PNG) }
    else { res.setHeader('Content-Type', 'image/svg+xml'); res.end(SVG(p.includes('upload') ? '#ff0000' : '#00aa00')) }
  } else { res.statusCode = 404; res.end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const iconBase = `http://127.0.0.1:${server.address().port}`

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.error(`  FAIL  ${m}`) } }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (e) => console.error('pageerror', e.message))
await page.addInitScript((base) => {
  localStorage.setItem('slidomingo-icon-sources', JSON.stringify([
    { id: 'mock', kind: 'server', name: 'Mock', enabled: true, url: base, token: '' },
    { id: 'off', kind: 'server', name: 'Switched off', enabled: false, url: 'http://127.0.0.1:9', token: '' },
  ]))
  window.__results = {}
  // every other bridge call: a resolved promise (boot awaits/catches them)
  const thenable = () => Promise.resolve(undefined)
  const impl = {
    onAgentAction: (cb) => { window.__agent = cb },
    sendAgentActionResult: (r) => { window.__results[r.requestId] = r },
    onSlideWrite: (cb) => { window.__slideWrite = cb },
    sendSlideWriteResult: (r) => { window.__results[r.requestId] = r },
  }
  // the icon-server proxy is left out (no main process here): the library
  // then fetches the mock server itself, as in a browser
  const absent = new Set(['iconFetch', 'setIconToken', 'iconTokenStatus', 'adoptIconTokens'])
  window.slidomingoDesktop = new Proxy(impl, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !absent.has(k) ? () => thenable() : undefined)),
  })
}, iconBase)
await page.goto(url)
// the desktop start picker: pick a blank deck
await page.waitForTimeout(1500)
const blank = page.locator('button:visible:has-text("Blank")').first()
if (await blank.count()) await blank.click()
await page.waitForFunction(() => !!window.__agent && !!window.slidomingo?.doc, null, { timeout: 15000 })

let n = 0
async function act(verb, args) {
  const id = `r${++n}`
  await page.evaluate(([id, verb, args]) => window.__agent({ requestId: id, verb, args }), [id, verb, args])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 15000 })
  return page.evaluate((id) => window.__results[id], id)
}

const slideId = await page.evaluate(() => window.slidomingo.doc.slides[0].id)
const before = await page.evaluate(() => window.slidomingo.doc.slides[0].elements.length)

const found = await act('icons', { op: 'search', query: 'cloud' })
ok(found.ok && found.refs.join() === 'i1,i2', `search against the configured server: ${JSON.stringify(found.summary)}`)
ok(found.summary.includes('license: MIT') && found.summary.includes('license unknown'), 'search lines carry the license (or say it is unknown)')
const put = await act('icons', { op: 'insert', slideId, ref: 'i1', x: 100, y: 120, size: 80, alt: 'Upload' })
ok(put.ok && typeof put.elementId === 'string', `insert: ${put.summary ?? put.error}`)
const el = await page.evaluate((id) => window.slidomingo.doc.slides[0].elements.find((e) => e.id === id), put.elementId)
const markup = await page.evaluate((k) => window.slidomingo.doc.assets?.[k], el?.asset)
ok(el?.provenance?.license === 'MIT' && el.provenance.author === 'Cloud Co' && /\/files\/cloud\/cloud-upload\.svg$/.test(el.provenance.url ?? '') && !!el.provenance.origin, `the agent's insert records the icon's provenance (${JSON.stringify(el?.provenance)})`)
ok(el?.type === 'svg' && el.x === 100 && el.y === 120 && el.w === 80 && el.h === 80 && el.alt === 'Upload', `svg element at the exact frame (${JSON.stringify(el && { type: el.type, x: el.x, y: el.y, w: el.w, h: el.h, alt: el.alt })})`)
ok(typeof markup === 'string' && markup.includes('#ff0000'), 'its markup is interned in doc.assets')
await page.waitForTimeout(300)
const dom = await page.evaluate((id) => {
  const node = document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`)
  return node ? { svg: !!node.querySelector('svg circle'), script: !!node.querySelector('script'), pwned: !!window.__pwned } : null
}, put.elementId)
ok(dom?.svg && !dom.script && !dom.pwned, `drawn on the canvas, sanitized (${JSON.stringify(dom)})`)
const users = await act('icons', { op: 'search', query: 'user' })
const png = await act('icons', { op: 'insert', slideId, ref: users.refs[0] })
const img = await page.evaluate((id) => window.slidomingo.doc.slides[0].elements.find((e) => e.id === id), png.elementId)
ok(png.ok && img?.type === 'image' && img.w === 96 && img.alt === '', `a png becomes an image element, 96px default (${img?.type} ${img?.w})`)
ok(await page.evaluate(() => window.slidomingo.doc.slides[0].elements.length) === before + 2, 'two elements added')
// one undo step per insert
await page.evaluate(() => document.activeElement?.blur())
await page.keyboard.press('Meta+z')
await page.waitForTimeout(200)
ok(await page.evaluate(() => window.slidomingo.doc.slides[0].elements.length) === before + 1, 'undo removes exactly the last icon')
const bad = await act('icons', { op: 'insert', slideId: 'nope', ref: 'i1' })
ok(!bad.ok && /no-such-slide/.test(bad.error), `unknown slide refused (${bad.error})`)
// existing insert_elements path still works after the refactor
const ins = await act('insert_elements', { slideId, elements: [{ type: 'shape', shape: 'rect', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1, fill: '#123456', stroke: 'none', strokeWidth: 0 }], nudge: false })
ok(ins.ok && ins.elementIds?.length === 1, `insert_elements unchanged (${JSON.stringify(ins.elementIds)})`)

// AI-written SVG is refused on every write path; the icon already in the deck is untouched
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0f0"/></svg>'
const box = { x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1 }
const count = () => page.evaluate(() => window.slidomingo.doc.slides[0].elements.length)
const n0 = await count()
const refusedSvg = (r, what) => ok(r && r.ok === false && /AI-written SVG is refused/.test(r.error ?? '') && /icons tool/.test(r.error), `${what} is refused with the way out (${String(r?.error).slice(0, 60)}…)`)
refusedSvg(await act('insert_elements', { slideId, elements: [{ type: 'svg', ...box, markup: MARK }] }), 'insert_elements with svg markup')
refusedSvg(await act('insert_elements', { slideId, elements: [{ type: 'svg', ...box, asset: 'fresh' }], assets: { fresh: MARK } }), 'insert_elements with a new svg asset')
refusedSvg(await act('insert_elements', { slideId, elements: [{ type: 'image', ...box, src: 'data:image/svg+xml;base64,' + Buffer.from(MARK).toString('base64'), fit: 'contain', radius: 0 }] }), 'a picture that holds svg')
ok(await count() === n0, 'nothing was added by the refused inserts')
const icon = await page.evaluate((id) => window.slidomingo.doc.slides[0].elements.find((e) => e.id === id), put.elementId)
const reuse = await act('insert_elements', { slideId, elements: [{ type: 'svg', ...box, asset: icon.asset }], nudge: false })
ok(reuse.ok && reuse.elementIds?.length === 1, 'an svg that points at artwork already in the deck is fine (a copy of the icon)')
refusedSvg(await act('update_element', { slideId, elementId: put.elementId, props: { markup: MARK } }), 'update_element swapping the markup')
refusedSvg(await act('update_element', { slideId, elementId: put.elementId, props: { asset: 'nope' } }), 'update_element pointing at an unknown asset')
const tint = await act('update_element', { slideId, elementId: put.elementId, props: { alt: 'Cloud', opacity: 0.5 } })
ok(tint.ok, 'update_element on the icon still works for everything else')
// write_slide: the get_slide round trip passes, new artwork does not
const slideNow = () => page.evaluate(() => JSON.parse(JSON.stringify(window.slidomingo.doc.slides[0])))
async function writeSlide(slide) {
  const id = `w${++n}`
  await page.evaluate(([id, slide, slideId]) => window.__slideWrite({ requestId: id, slideId, slide }), [id, slide, slideId])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 15000 })
  return page.evaluate((id) => window.__results[id], id)
}
const roundTrip = await writeSlide(await slideNow())
ok(roundTrip.ok, `write_slide with the deck's own svg unchanged is accepted (${roundTrip.error ?? 'ok'})`)
const withNew = await slideNow()
withNew.elements.push({ id: 'ai-svg', type: 'svg', ...box, markup: MARK })
refusedSvg(await writeSlide(withNew), 'write_slide adding an svg with markup')
const edited = await slideNow()
edited.elements.find((e) => e.id === put.elementId).markup = MARK
refusedSvg(await writeSlide(edited), 'write_slide rewriting an existing svg')
const native = await slideNow()
native.elements.push({ id: 'ai-path', type: 'shape', shape: 'path', ...box, fill: '#123456', stroke: 'none', strokeWidth: 0, radius: 0, d: 'M 0 0 L 10 0 L 5 10 Z', pathBox: [0, 0, 10, 10] })
ok((await writeSlide(native)).ok, 'write_slide adding a native path shape is fine — that is what the refusal points to')
// unreachable server
// a second, unreachable source: results still come, the dead one is named
await page.evaluate(() => {
  const list = JSON.parse(localStorage.getItem('slidomingo-icon-sources'))
  list[1].enabled = true
  localStorage.setItem('slidomingo-icon-sources', JSON.stringify(list))
})
const partial = await act('icons', { op: 'search', query: 'cloud' })
ok(partial.ok && partial.refs.length === 2 && partial.summary.includes('Not searched: Switched off: ') && partial.summary.includes("can't reach"), `one dead source of two: ${JSON.stringify(partial.summary.split('\n').pop().slice(0, 120))}…`)
// only the dead one left
await page.evaluate(() => {
  const list = JSON.parse(localStorage.getItem('slidomingo-icon-sources'))
  list[0].enabled = false
  localStorage.setItem('slidomingo-icon-sources', JSON.stringify(list))
})
const down = await act('icons', { op: 'search', query: 'cloud' })
ok(!down.ok && down.error.includes("can't reach") && down.error.includes('Settings'), `unreachable: ${down.error.slice(0, 140)}…`)
await page.evaluate(() => localStorage.setItem('slidomingo-icon-sources', '[]'))
const nothing = await act('icons', { op: 'search', query: 'cloud' })
ok(!nothing.ok && nothing.error.includes('No icon source is set up'), `no source at all: ${nothing.error.slice(0, 100)}…`)

if (shots) await page.screenshot({ path: join(shots, 'agent-icons.png') })
await browser.close()
server.close()
console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nall ${checks} checks passed (${hits} icon-server requests)`)
process.exit(failures ? 1 : 0)
