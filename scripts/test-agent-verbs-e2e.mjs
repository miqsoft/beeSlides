#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The single agent-action verbs (editor/agentverbs/ — slide types, reusable
// objects, element structure, apply_change_pattern) in a real browser:
//   node scripts/test-agent-verbs-e2e.mjs [url]
// url defaults to the built editor, slides/dist-single/BeeSlides.beeslides.html
// (npm run build:single first); pass http://localhost:<port>/ for a dev server.
// A fake window.slidomingoDesktop plays main: every call goes in through
// onAgentAction exactly as the desktop app delivers it, and the answer is read
// from sendAgentActionResult. Needs playwright-core (same lookup as
// test-agent-icons-e2e.mjs); SKIPS with exit 0 without it or a build.
//
// Checks, per verb: a success case asserting the document change and (for
// every verb that commits) that ONE undo puts the document back exactly and
// redo brings the change back; and the main refusals, asserting the exact
// error string the handler answers and that a refusal changes nothing.
// Verbs: create_slide_type, rename_slide_type, reorder_slide_type,
// move_slide_type, detach_slide_type, relink_slide_type,
// promote_to_reusable_object, create_reusable_object, set_frame,
// duplicate_element, delete_element, reorder_element, apply_change_pattern.
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'

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

const skip = (why) => { console.log(`test-agent-verbs-e2e: SKIP — ${why}`); process.exit(0) }
const chromium = await loadChromium()
if (!chromium) skip('no playwright-core (set PLAYWRIGHT_CORE)')
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : skip('no build (npm run build:single in slides/) and no url given'))

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.error(`  FAIL  ${m}`) } }

// ---- the deck ---------------------------------------------------------------
// Slide types: BASE (root) ← CHILD; OTHER (root); MASTER (root, parentOnly).
// Deck slides: s-child follows CHILD, s-other follows OTHER, s-free follows
// nothing and holds the elements the element verbs work on.
const text = (id, html, extra = {}) => ({
  id, type: 'text', x: 80, y: 60, w: 600, h: 80, rotation: 0, opacity: 1, html,
  fontSize: 32, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.2, ...extra,
})
const rect = (id, x, fill, extra = {}) => ({
  id, type: 'shape', shape: 'rect', x, y: 300, w: 120, h: 120, rotation: 0, opacity: 1,
  fill, stroke: 'none', strokeWidth: 0, radius: 0, ...extra,
})
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const slide = (id, elements, extra = {}) => ({ id, background: '#ffffff', transition: 'fade', notes: '', elements, ...extra })
const baseEls = () => [rect('base-bar', 0, '#204080', { y: 0, w: 1280, h: 40 }), text('base-title', '', { role: 'title' })]
const childEls = () => [text('child-body', '', { role: 'body', y: 200, h: 300, fontSize: 20 })]
const otherEls = () => [text('other-title', '', { role: 'title', x: 200 }), text('other-body', '', { role: 'body', y: 220, h: 300, fontSize: 20 })]
function deck(base) {
  const d = JSON.parse(JSON.stringify(base))
  d.docId = `agent-verbs-${Date.now()}`
  d.layouts = [
    { ...slide('BASE', baseEls()), name: 'Base' },
    { ...slide('CHILD', childEls()), name: 'Child', parentId: 'BASE' },
    { ...slide('OTHER', otherEls()), name: 'Other' },
    { ...slide('MASTER', []), name: 'Master', parentOnly: true },
  ]
  const filled = (els, fill) => els.map((e) => (fill[e.id] ? { ...e, html: fill[e.id] } : e))
  d.slides = [
    slide('s-child', filled([...baseEls(), ...childEls()], { 'base-title': 'Hello', 'child-body': 'World' }), { layoutId: 'CHILD' }),
    slide('s-other', filled(otherEls(), { 'other-title': 'Other title', 'other-body': 'Other body' }), { layoutId: 'OTHER' }),
    slide('s-free', [
      rect('r1', 100, '#ff0000'), rect('r2', 300, '#00ff00'), rect('r3', 500, '#0000ff'),
      text('t1', 'Caption'),
      { id: 'pic', type: 'image', src: PNG, x: 700, y: 300, w: 160, h: 120, rotation: 0, opacity: 1, fit: 'contain', radius: 0, alt: 'dot' },
    ]),
  ]
  delete d.reusableObjects
  return d
}

// ---- the page ---------------------------------------------------------------
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const pageErrors = []
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('pageerror', e.stack ?? e.message) })
await page.addInitScript(() => {
  window.__results = {}
  const thenable = () => Promise.resolve(undefined)
  const impl = {
    onAgentAction: (cb) => { window.__agent = cb },
    sendAgentActionResult: (r) => { window.__results[r.requestId] = r },
    // the start picker's lists (recent files, drafts, templates)
    listRecent: () => Promise.resolve([]),
    listDrafts: () => Promise.resolve([]),
    listTemplateMeta: () => Promise.resolve([]),
  }
  window.slidomingoDesktop = new Proxy(impl, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => thenable() : undefined)),
  })
})
await page.goto(url)
// the desktop start picker: pick a blank deck
await page.waitForTimeout(1500)
const blank = page.locator('button:visible:has-text("Blank")').first()
if (await blank.count()) await blank.click()
await page.waitForFunction(() => !!window.__agent && !!window.beeslides?.doc, null, { timeout: 15000 })
const base = await page.evaluate(() => JSON.parse(JSON.stringify(window.beeslides.doc)))
const fixture = JSON.stringify(deck(base))
/** Every section starts from the same deck (same docId: the action log
 *  carries on, which apply_change_pattern relies on within its section). */
async function reset() {
  ok(await page.evaluate((json) => window.beeslides.loadDoc(json), fixture), 'the test deck loads')
  await page.waitForTimeout(100)
}

let n = 0
async function act(verb, args) {
  const id = `r${++n}`
  await page.evaluate(([id, verb, args]) => window.__agent({ requestId: id, verb, args }), [id, verb, args])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 15000 })
  return page.evaluate((id) => window.__results[id], id)
}
const docNow = () => page.evaluate(() => JSON.parse(JSON.stringify(window.beeslides.doc)))
const layout = (d, id) => d.layouts?.find((l) => l.id === id)
const slideOf = (d, id) => d.slides.find((s) => s.id === id)
const elOf = (d, sid, eid) => slideOf(d, sid)?.elements.find((e) => e.id === eid)
const ids = (arr) => (arr ?? []).map((x) => x.id).join(',')
const roots = (d) => d.layouts.filter((l) => !l.parentId).map((l) => l.id).join(',')

/** Run a verb that must succeed; returns { r, before, after }. */
async function succeed(verb, args, label) {
  const before = await docNow()
  const r = await act(verb, args)
  ok(r.ok === true, `${verb}: ${label} (${r.ok ? 'ok' : r.error})`)
  return { r, before, after: await docNow() }
}
/** ONE undo restores `before` exactly; redo brings `after` back. */
async function oneUndo(verb, { before, after }) {
  await page.evaluate(() => window.beeslides.undo())
  ok(isDeepStrictEqual(await docNow(), before), `${verb}: one undo restores the document`)
  await page.evaluate(() => window.beeslides.redo())
  ok(isDeepStrictEqual(await docNow(), after), `${verb}: redo brings the change back`)
}
function diffPaths(a, b, path = '', out = []) {
  if (isDeepStrictEqual(a, b)) return out
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out)
  } else out.push([path, a, b])
  return out
}
/** A refusal with exactly `error`, and nothing in the document changed
 *  (`ignore`: top-level keys a refusal is known to touch). */
async function refuse(verb, args, error, label, { ignore = [] } = {}) {
  const strip = (d) => { for (const k of ignore) delete d[k]; return d }
  const before = strip(await docNow())
  const r = await act(verb, args)
  const now = strip(await docNow())
  if (!isDeepStrictEqual(now, before)) console.log(`    changed: ${JSON.stringify(diffPaths(before, now)).slice(0, 300)}`)
  ok(r.ok === false && r.error === error, `${verb} refuses ${label}: ${JSON.stringify(r.error)}${r.error === error ? '' : ` (wanted ${JSON.stringify(error)})`}`)
  ok(isDeepStrictEqual(now, before), `${verb}: refusing ${label} changes nothing`)
}

// ---- slide types --------------------------------------------------------------
await reset()
console.log('\ncreate_slide_type')
{
  const blankT = await succeed('create_slide_type', { name: '  Fresh  ', mode: 'blank' }, 'a blank type')
  const fresh = layout(blankT.after, blankT.r.layoutId)
  ok(fresh?.name === 'Fresh' && !fresh.parentId && fresh.elements.length === 0 && blankT.after.layouts.at(-1)?.id === fresh.id,
    `a new empty root type named "Fresh" at the end (${JSON.stringify(fresh && { name: fresh.name, parentId: fresh.parentId, n: fresh.elements.length })})`)
  await oneUndo('create_slide_type', blankT)
  const parentT = await succeed('create_slide_type', { name: 'Kid', mode: 'parent', sourceId: 'BASE' }, 'a child of BASE')
  const kid = layout(parentT.after, parentT.r.layoutId)
  ok(kid?.parentId === 'BASE' && kid.elements.length === 0, `parent mode: follows BASE and starts empty (${kid?.parentId}, ${kid?.elements.length})`)
  const basisT = await succeed('create_slide_type', { name: 'Copy', mode: 'basis', sourceId: 'CHILD' }, 'based on CHILD')
  const copy = layout(basisT.after, basisT.r.layoutId)
  const effective = ['base-bar', 'base-title', 'child-body']
  ok(copy && !copy.parentId && copy.elements.length === 3 && copy.elements.every((e) => !effective.includes(e.id)),
    `basis mode: an independent copy of CHILD's effective content with fresh ids (${ids(copy?.elements)})`)
  ok(copy?.elements.map((e) => e.type).join() === 'shape,text,text', 'basis mode keeps the inherited chain in order')
  await oneUndo('create_slide_type', basisT)
  await refuse('create_slide_type', { mode: 'blank' }, 'Missing or empty name — slide types require a real name.', 'no name')
  await refuse('create_slide_type', { name: '   ', mode: 'blank' }, 'Missing or empty name — slide types require a real name.', 'a blank name')
  await refuse('create_slide_type', { name: 'X', mode: 'clone' }, 'mode must be one of "blank", "parent", "basis".', 'an unknown mode')
  await refuse('create_slide_type', { name: 'X', mode: 'parent', sourceId: 'nope' }, 'No slide type with id "nope" to base this on.', 'an unknown source')
  await refuse('create_slide_type', { name: 'X', mode: 'basis', sourceId: 's-free' }, 'No slide type with id "s-free" to base this on.', 'a deck slide as source')
}

await reset()
console.log('\nrename_slide_type')
{
  const s = await succeed('rename_slide_type', { layoutId: 'OTHER', name: ' Two columns ' }, 'OTHER')
  ok(layout(s.after, 'OTHER').name === 'Two columns', `renamed, trimmed (${JSON.stringify(layout(s.after, 'OTHER').name)})`)
  await oneUndo('rename_slide_type', s)
  await refuse('rename_slide_type', { name: 'X' }, 'Missing layoutId.', 'no layoutId')
  await refuse('rename_slide_type', { layoutId: 'OTHER', name: '' }, 'Missing or empty name — slide types require a real name.', 'an empty name')
  await refuse('rename_slide_type', { layoutId: 'nope', name: 'X' }, 'no-such-slide-type', 'an unknown type')
  await refuse('rename_slide_type', { layoutId: 's-free', name: 'X' }, 'no-such-slide-type', 'a deck slide id')
}

await reset()
console.log('\nreorder_slide_type')
{
  ok(roots(await docNow()) === 'BASE,OTHER,MASTER', 'roots start as BASE, OTHER, MASTER')
  const s = await succeed('reorder_slide_type', { layoutId: 'MASTER', to: 0 }, 'MASTER to the front')
  ok(roots(s.after) === 'MASTER,BASE,OTHER', `MASTER is the first root (${roots(s.after)})`)
  ok(layout(s.after, 'CHILD').parentId === 'BASE', 'children keep their parent')
  await oneUndo('reorder_slide_type', s)
  await reset()
  const far = await succeed('reorder_slide_type', { layoutId: 'BASE', to: 99 }, 'an out-of-range index clamps')
  ok(roots(far.after) === 'OTHER,MASTER,BASE', `BASE is the last root (${roots(far.after)})`)
  await page.evaluate(() => window.beeslides.undo())
  await refuse('reorder_slide_type', { layoutId: 'BASE' }, 'Missing layoutId or to.', 'no to')
  await refuse('reorder_slide_type', { to: 1 }, 'Missing layoutId or to.', 'no layoutId')
  await refuse('reorder_slide_type', { layoutId: 'BASE', to: '1' }, 'Missing layoutId or to.', 'a string index')
  await refuse('reorder_slide_type', { layoutId: 'nope', to: 0 }, 'no-such-slide-type', 'an unknown type')
}

await reset()
console.log('\nmove_slide_type')
{
  const s = await succeed('move_slide_type', { layoutId: 'OTHER', parentId: 'BASE' }, 'OTHER under BASE')
  ok(layout(s.after, 'OTHER').parentId === 'BASE', 'OTHER now follows BASE')
  const linked = slideOf(s.after, 's-other')
  ok(linked.elements.some((e) => e.id === 'base-bar') && linked.elements.find((e) => e.id === 'other-body')?.html === 'Other body',
    `its linked slide resynced in the same step: inherits base-bar, keeps its text (${ids(linked.elements)})`)
  await oneUndo('move_slide_type', s)
  await reset()
  const before = await succeed('move_slide_type', { layoutId: 'MASTER', parentId: null, beforeId: 'BASE' }, 'MASTER to a root before BASE')
  ok(roots(before.after) === 'MASTER,BASE,OTHER', `placed before BASE (${roots(before.after)})`)
  await oneUndo('move_slide_type', before)
  await reset()
  await refuse('move_slide_type', { parentId: null }, 'Missing layoutId.', 'no layoutId')
  await refuse('move_slide_type', { layoutId: 'OTHER' }, 'parentId must be a slide type id, or null for a top-level slide type.', 'no parentId')
  await refuse('move_slide_type', { layoutId: 'OTHER', parentId: 5 }, 'parentId must be a slide type id, or null for a top-level slide type.', 'a numeric parentId')
  await refuse('move_slide_type', { layoutId: 'nope', parentId: null }, 'no-such-slide-type', 'an unknown type')
  await refuse('move_slide_type', { layoutId: 'OTHER', parentId: 'nope' }, 'No slide type with id "nope" to move under.', 'an unknown parent')
  await refuse('move_slide_type', { layoutId: 'BASE', parentId: 'CHILD' }, 'Refused: a slide type cannot be moved under itself or one of its own descendants.', 'a move under its own child')
  await refuse('move_slide_type', { layoutId: 'BASE', parentId: 'BASE' }, 'Refused: a slide type cannot be moved under itself or one of its own descendants.', 'a move under itself')
}

await reset()
console.log('\ndetach_slide_type')
{
  const s = await succeed('detach_slide_type', { layoutId: 'CHILD' }, 'CHILD from BASE')
  const child = layout(s.after, 'CHILD')
  ok(!child.parentId, 'CHILD has no parent any more')
  ok(ids(child.elements) === 'base-bar,base-title,child-body', `the inherited content is baked in (${ids(child.elements)})`)
  ok(roots(s.after) === 'BASE,CHILD,OTHER,MASTER', `it becomes a root right after its family (${roots(s.after)})`)
  ok(isDeepStrictEqual(slideOf(s.after, 's-child'), slideOf(s.before, 's-child')), 'its linked slide looks exactly as before')
  await oneUndo('detach_slide_type', s)
  await refuse('detach_slide_type', {}, 'Missing layoutId.', 'no layoutId')
  await refuse('detach_slide_type', { layoutId: 'nope' }, 'no-such-slide-type', 'an unknown type')
  await refuse('detach_slide_type', { layoutId: 'BASE' }, 'That slide type has no parent to detach from.', 'a root')
}

await reset()
console.log('\nrelink_slide_type')
{
  const s = await succeed('relink_slide_type', { slideId: 's-other', layoutId: 'CHILD' }, 's-other to CHILD')
  const sl = slideOf(s.after, 's-other')
  ok(sl.layoutId === 'CHILD', 'the slide follows CHILD')
  ok(s.r.layoutId === 'CHILD' && typeof s.r.verdict === 'string' && Array.isArray(s.r.filled) && Array.isArray(s.r.floating) && Array.isArray(s.r.emptySlots) && Array.isArray(s.r.warnings),
    `the answer carries the verdict (${s.r.verdict}; filled ${s.r.filled}; floating ${s.r.floating}; empty ${s.r.emptySlots})`)
  ok(sl.elements.some((e) => e.id === 'base-bar') && sl.elements.find((e) => e.id === 'base-title')?.html === 'Other title' && sl.elements.find((e) => e.id === 'child-body')?.html === 'Other body',
    `the text moves into CHILD's placeholders (${sl.elements.map((e) => `${e.id}=${e.html ?? ''}`).join(' ')})`)
  ok(s.r.verdict === 'fit' && s.r.filled.join() === 'base-title,child-body', 'title+body onto title+body fits')
  await oneUndo('relink_slide_type', s)
  const un = await succeed('relink_slide_type', { slideId: 's-child', layoutId: null }, 'unlink s-child')
  ok(un.r.layoutId === null && slideOf(un.after, 's-child').layoutId === undefined, 'the slide follows nothing')
  ok(isDeepStrictEqual(slideOf(un.after, 's-child').elements, slideOf(un.before, 's-child').elements), 'and keeps its look')
  await oneUndo('relink_slide_type', un)
  await refuse('relink_slide_type', { layoutId: 'CHILD' }, 'Missing slideId.', 'no slideId')
  await refuse('relink_slide_type', { slideId: 'nope', layoutId: 'CHILD' }, 'no-such-slide (relink takes a deck slide id)', 'an unknown slide')
  await refuse('relink_slide_type', { slideId: 'CHILD', layoutId: 'OTHER' }, 'no-such-slide (relink takes a deck slide id)', 'a slide type as the slide')
  await refuse('relink_slide_type', { slideId: 's-free' }, 'layoutId must be a slide type id, or null to unlink.', 'no layoutId')
  await refuse('relink_slide_type', { slideId: 's-free', layoutId: 7 }, 'layoutId must be a slide type id, or null to unlink.', 'a numeric layoutId')
  await refuse('relink_slide_type', { slideId: 's-free', layoutId: 'nope' }, 'no-such-slide-type', 'an unknown type')
  await refuse('relink_slide_type', { slideId: 's-free', layoutId: 'MASTER' }, 'parent-only (that slide type is a master: pick one of its children)', 'a parent-only type')
}

// ---- reusable objects ---------------------------------------------------------
await reset()
console.log('\ncreate_reusable_object')
{
  const s = await succeed('create_reusable_object', { name: ' Logo ' }, 'named')
  const obj = s.after.reusableObjects?.find((o) => o.id === s.r.objectId)
  ok(obj?.name === 'Logo' && obj.elements.length === 0 && s.after.reusableObjects.length === 1, `a new empty object named "Logo" (${JSON.stringify(obj && { name: obj.name, n: obj.elements.length })})`)
  await oneUndo('create_reusable_object', s)
  const anon = await succeed('create_reusable_object', {}, 'without a name')
  const o2 = anon.after.reusableObjects?.find((o) => o.id === anon.r.objectId)
  ok(!!o2 && o2.name === undefined && anon.after.reusableObjects.length === 2, 'an unnamed object is appended')
  await page.evaluate(() => { window.beeslides.undo(); window.beeslides.undo() })
  ok(!(await docNow()).reusableObjects?.length, 'cleanup: both objects undone')
}

await reset()
console.log('\npromote_to_reusable_object')
{
  const s = await succeed('promote_to_reusable_object', { slideId: 's-free', elementIds: ['r1', 'pic'], name: 'Pair' }, 'r1 + pic')
  const obj = s.after.reusableObjects?.find((o) => o.id === s.r.objectId)
  ok(obj?.name === 'Pair' && obj.elements.length === 2, `an object "Pair" with two elements (${JSON.stringify(obj && { name: obj.name, n: obj.elements.length })})`)
  ok(obj?.elements.map((e) => e.type).join() === 'shape,image' && obj.elements[1].src === PNG && obj.elements[0].fill === '#ff0000', 'it holds copies of the shape and the picture')
  ok(isDeepStrictEqual(slideOf(s.after, 's-free'), slideOf(s.before, 's-free')), 'the slide itself is untouched')
  await oneUndo('promote_to_reusable_object', s)
  const fromType = await succeed('promote_to_reusable_object', { slideId: 'OTHER', elementIds: ['other-title'] }, 'from a slide type')
  ok(fromType.after.reusableObjects?.find((o) => o.id === fromType.r.objectId)?.elements.length === 1, 'a slide type id resolves too')
  await page.evaluate(() => window.beeslides.undo())
  await refuse('promote_to_reusable_object', { slideId: 's-free' }, 'Missing slideId or elementIds.', 'no elementIds')
  await refuse('promote_to_reusable_object', { slideId: 's-free', elementIds: [] }, 'Missing slideId or elementIds.', 'empty elementIds')
  await refuse('promote_to_reusable_object', { elementIds: ['r1'] }, 'Missing slideId or elementIds.', 'no slideId')
  await refuse('promote_to_reusable_object', { slideId: 'nope', elementIds: ['r1'] }, 'no-such-slide', 'an unknown slide')
  await refuse('promote_to_reusable_object', { slideId: 's-free', elementIds: ['r1', 'nope'] }, 'One or more elementIds do not exist on that slide.', 'an unknown element')
}

// ---- element verbs -------------------------------------------------------------
await reset()
console.log('\nset_frame')
{
  const s = await succeed('set_frame', { slideId: 's-free', elementId: 'r1', x: 140, y: 320, w: 200, h: 90, rotation: 15 }, 'r1')
  const r1 = elOf(s.after, 's-free', 'r1')
  ok(r1.x === 140 && r1.y === 320 && r1.w === 200 && r1.h === 90 && r1.rotation === 15, `the frame is written (${JSON.stringify({ x: r1.x, y: r1.y, w: r1.w, h: r1.h, rotation: r1.rotation })})`)
  ok(isDeepStrictEqual(s.r.frame, { x: 140, y: 320, w: 200, h: 90, rotation: 15 }) && Array.isArray(s.r.warnings), 'the answer reports the frame and warnings')
  ok(isDeepStrictEqual({ ...r1, x: 100, y: 300, w: 120, h: 120, rotation: 0 }, elOf(s.before, 's-free', 'r1')), 'nothing but the frame changed')
  await oneUndo('set_frame', s)
  const part = await succeed('set_frame', { slideId: 's-free', elementId: 'r2', y: 100 }, 'only y')
  ok(elOf(part.after, 's-free', 'r2').y === 100 && elOf(part.after, 's-free', 'r2').x === 300, 'an omitted key keeps its value')
  await oneUndo('set_frame', part)
  await page.evaluate(() => window.beeslides.undo())
  await page.evaluate(() => window.beeslides.undo())
  await refuse('set_frame', { slideId: 's-free', x: 1 }, 'Missing slideId or elementId.', 'no elementId')
  await refuse('set_frame', { elementId: 'r1', x: 1 }, 'Missing slideId or elementId.', 'no slideId')
  await refuse('set_frame', { slideId: 'nope', elementId: 'r1', x: 1 }, 'no-such-element', 'an unknown slide')
  await refuse('set_frame', { slideId: 's-free', elementId: 'nope', x: 1 }, 'no-such-element', 'an unknown element')
  await refuse('set_frame', { slideId: 's-other', elementId: 'r1', x: 1 }, 'no-such-element', 'an element of another slide')
  await refuse('set_frame', { slideId: 's-free', elementId: 'r1', x: 'left' }, 'Invalid x.', 'a string x')
  await refuse('set_frame', { slideId: 's-free', elementId: 'r1', w: 50, rotation: 'a lot' }, 'Invalid rotation.', 'a bad rotation (and writes nothing of the rest)')
}

await reset()
console.log('\nduplicate_element')
{
  const s = await succeed('duplicate_element', { slideId: 's-free', elementId: 'r2', x: 900, y: 500 }, 'r2 at (900, 500)')
  const els = slideOf(s.after, 's-free').elements
  const copy = els.find((e) => e.id === s.r.elementId)
  ok(typeof s.r.elementId === 'string' && s.r.elementId !== 'r2' && els.length === 6 && els.at(-1) === copy, `a copy with a new id on top (${s.r.elementId})`)
  ok(copy && copy.x === 900 && copy.y === 500 && copy.fill === '#00ff00' && copy.w === 120, 'at the asked spot, same look')
  await oneUndo('duplicate_element', s)
  const inPlace = await succeed('duplicate_element', { slideId: 's-free', elementId: 'pic' }, 'the picture, no position')
  const pc = elOf(inPlace.after, 's-free', inPlace.r.elementId)
  ok(pc?.type === 'image' && pc.src === PNG && pc.x === 724 && pc.y === 324, `without x/y the copy is offset like ⌘D (${pc?.x}, ${pc?.y})`)
  await page.evaluate(() => window.beeslides.undo())
  await refuse('duplicate_element', { slideId: 's-free' }, 'Missing slideId or elementId.', 'no elementId')
  await refuse('duplicate_element', { slideId: 'nope', elementId: 'r2' }, 'no-such-element', 'an unknown slide')
  await refuse('duplicate_element', { slideId: 's-free', elementId: 'nope' }, 'no-such-element', 'an unknown element')
  await refuse('duplicate_element', { slideId: 's-free', elementId: 'r2', x: 'far' }, 'Invalid x.', 'a string x')
}

await reset()
console.log('\ndelete_element')
{
  const s = await succeed('delete_element', { slideId: 's-free', elementId: 'r2' }, 'r2')
  ok(ids(slideOf(s.after, 's-free').elements) === 'r1,r3,t1,pic', `r2 is gone (${ids(slideOf(s.after, 's-free').elements)})`)
  ok(isDeepStrictEqual(slideOf(s.after, 's-other'), slideOf(s.before, 's-other')), 'other slides untouched')
  await oneUndo('delete_element', s)
  await page.evaluate(() => window.beeslides.undo())
  ok(ids(slideOf(await docNow(), 's-free').elements) === 'r1,r2,r3,t1,pic', 'cleanup: r2 is back in place')
  await refuse('delete_element', { elementId: 'r2' }, 'Missing slideId or elementId.', 'no slideId')
  await refuse('delete_element', { slideId: 'nope', elementId: 'r2' }, 'no-such-element', 'an unknown slide')
  await refuse('delete_element', { slideId: 's-free', elementId: 'nope' }, 'no-such-element', 'an unknown element')
}

await reset()
console.log('\nreorder_element')
{
  const order = async () => ids(slideOf(await docNow(), 's-free').elements)
  const front = await succeed('reorder_element', { slideId: 's-free', elementId: 'r1', to: 'front' }, 'r1 to front')
  ok(ids(slideOf(front.after, 's-free').elements) === 'r2,r3,t1,pic,r1', `front = last painted (${ids(slideOf(front.after, 's-free').elements)})`)
  await oneUndo('reorder_element', front)
  await page.evaluate(() => window.beeslides.undo())
  const back = await succeed('reorder_element', { slideId: 's-free', elementId: 'pic', to: 'back' }, 'pic to back')
  ok(ids(slideOf(back.after, 's-free').elements) === 'pic,r1,r2,r3,t1', 'back = first painted')
  await page.evaluate(() => window.beeslides.undo())
  const fwd = await succeed('reorder_element', { slideId: 's-free', elementId: 'r2', to: 'forward' }, 'r2 forward')
  ok(ids(slideOf(fwd.after, 's-free').elements) === 'r1,r3,r2,t1,pic', 'forward swaps with the next one')
  await page.evaluate(() => window.beeslides.undo())
  const bwd = await succeed('reorder_element', { slideId: 's-free', elementId: 'r2', to: 'backward' }, 'r2 backward')
  ok(ids(slideOf(bwd.after, 's-free').elements) === 'r2,r1,r3,t1,pic', 'backward swaps with the previous one')
  await oneUndo('reorder_element', bwd)
  await page.evaluate(() => window.beeslides.undo())
  const edge = await succeed('reorder_element', { slideId: 's-free', elementId: 'pic', to: 'forward' }, 'the top one forward')
  ok(ids(slideOf(edge.after, 's-free').elements) === 'r1,r2,r3,t1,pic', 'already on top: the order stays')
  await page.evaluate(() => window.beeslides.undo())
  ok(await order() === 'r1,r2,r3,t1,pic', 'cleanup: original order')
  await refuse('reorder_element', { slideId: 's-free', elementId: 'r1' }, 'Missing slideId, elementId or to.', 'no to')
  await refuse('reorder_element', { slideId: 's-free', to: 'front' }, 'Missing slideId, elementId or to.', 'no elementId')
  await refuse('reorder_element', { slideId: 'nope', elementId: 'r1', to: 'front' }, 'no-such-element', 'an unknown slide')
  await refuse('reorder_element', { slideId: 's-free', elementId: 'nope', to: 'front' }, 'no-such-element', 'an unknown element')
}

await reset()
console.log('\napply_change_pattern')
{
  // a recorded change to r1: a new fill and size (copyable), via the agent's own verb
  const recolor = await act('update_element', { slideId: 's-free', elementId: 'r1', props: { fill: '#ff8800', w: 150, x: 120 } })
  ok(recolor.ok, `setup: r1 recoloured and resized (${recolor.error ?? 'ok'})`)
  const s = await succeed('apply_change_pattern', { slideId: 's-free', sourceElementId: 'r1', targetElementIds: ['r2', 'r3', 't1', 'nope', 7] }, 'r1 → r2, r3')
  ok(isDeepStrictEqual(s.r.applied, ['r2', 'r3']) && isDeepStrictEqual(s.r.skipped, ['t1', 'nope']), `applied to the same kind, skipped the rest (applied ${s.r.applied}; skipped ${s.r.skipped})`)
  const r2 = elOf(s.after, 's-free', 'r2'), r3 = elOf(s.after, 's-free', 'r3')
  ok(r2.fill === '#ff8800' && r2.w === 150 && r3.fill === '#ff8800' && r3.w === 150, 'the fill and width are copied')
  // (the layout guard may still push r3 along the row: r2 grew by 30)
  ok(r2.x === 300 && r2.y === 300 && r3.x !== 120 && r3.y === 300, `the position is never copied (r2 at ${r2.x}, r3 at ${r3.x})`)
  ok(isDeepStrictEqual(elOf(s.after, 's-free', 't1'), elOf(s.before, 's-free', 't1')), 'the skipped text is untouched')
  await oneUndo('apply_change_pattern', s)
  const none = await succeed('apply_change_pattern', { slideId: 's-free', sourceElementId: 'r1', targetElementIds: ['t1'] }, 'nothing of the same kind')
  ok(none.r.applied.length === 0 && isDeepStrictEqual(none.r.skipped, ['t1']) && isDeepStrictEqual(none.after, none.before), 'nothing applied, nothing changed')
  await refuse('apply_change_pattern', { slideId: 's-free', sourceElementId: 'r1' }, 'Missing slideId, sourceElementId or targetElementIds.', 'no targets')
  await refuse('apply_change_pattern', { slideId: 's-free', sourceElementId: 'r1', targetElementIds: [] }, 'Missing slideId, sourceElementId or targetElementIds.', 'empty targets')
  await refuse('apply_change_pattern', { slideId: 's-free', targetElementIds: ['r2'] }, 'Missing slideId, sourceElementId or targetElementIds.', 'no source')
  await refuse('apply_change_pattern', { slideId: 'nope', sourceElementId: 'r1', targetElementIds: ['r2'] }, 'no-such-source-element', 'an unknown slide')
  await refuse('apply_change_pattern', { slideId: 's-free', sourceElementId: 'nope', targetElementIds: ['r2'] }, 'no-such-source-element', 'an unknown source')
  await refuse('apply_change_pattern', { slideId: 's-free', sourceElementId: 't1', targetElementIds: ['r2'] }, 'no-reapplicable-change', 'a source never changed')
  // a pure move leaves nothing to copy (x/y are never reapplied)
  const moved = await act('set_frame', { slideId: 's-free', elementId: 'r3', x: 520, y: 310 })
  ok(moved.ok, 'setup: r3 moved')
  await refuse('apply_change_pattern', { slideId: 's-free', sourceElementId: 'r3', targetElementIds: ['r2'] }, 'no-reapplicable-change', 'a source whose last change was a move')
}

ok(!pageErrors.length, `no page errors (${pageErrors.length})`)
await browser.close()
console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nall ${checks} checks passed`)
process.exit(failures ? 1 : 0)
