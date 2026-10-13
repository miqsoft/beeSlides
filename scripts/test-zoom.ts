#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Slide / Section / Summary Zoom rig — the pure half: model.ts zoomRange /
// zoomCover / zoomFrameFor / inZoomFrame / zoomNext / zoomPrev, the integrity
// helpers (remapZoomTarget, pruneDanglingZoomTiles, retargetSectionZooms,
// zoomTilesInto), summaryZoomGrid / insertSummaryZoom, the untrusted.ts paste
// check, and zoom.ts's camera (endpoints, monotone log-space scale, the
// crossfade fallback). No DOM — present-mode behaviour is test-zoom-e2e.mjs.
//
//   slides/node_modules/.bin/esbuild scripts/test-zoom.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-zoom.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node $TMPDIR/test-zoom.mjs

import {
  defaultZoom, emptySlide, inZoomFrame, insertSummaryZoom, newDoc, pruneDanglingZoomTiles, remapZoomTarget,
  retargetSectionZooms, summaryZoomGrid, zoomCover, zoomFirst, zoomFrameFor, zoomNext, zoomPrev, zoomRange,
  zoomTargetLive, zoomTilesInto, type SlidomingoDoc, type ZoomElement, type ZoomFrame,
} from '../slides/src/model.ts'
import { zoomFrame, zoomScale, zoomSlideFrame, zoomSlideOpacity, zoomTileRect } from '../slides/src/zoom.ts'
import { sanitizeElement } from '../slides/src/untrusted.ts'
import { validateDoc } from '../slides/src/validate.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

/**
 * 'O A b C | D E' → slides O, A, b (hidden), C, then a section starting at D.
 * `|` starts a section at the next slide (named after it); `P:s` = state s of P.
 */
function deck(spec: string): SlidomingoDoc {
  const doc = newDoc()
  doc.slides = []
  doc.sections = []
  let newSection = false
  for (const tok of spec.split(/\s+/)) {
    if (tok === '|') { newSection = true; continue }
    const m = /^(?:(\w):)?(\w)$/.exec(tok)!
    const id = m[2]
    const s = emptySlide({ id, name: id })
    if (id === id.toLowerCase()) s.hidden = true
    if (m[1]) { s.stateOf = m[1]; delete s.hidden }
    doc.slides.push(s)
    if (newSection) { doc.sections.push({ id: `sec-${id}`, name: id, startSlideId: id }); newSection = false }
  }
  if (!doc.sections.length) delete doc.sections
  return doc
}
const at = (doc: SlidomingoDoc, id: string) => doc.slides.findIndex((s) => s.id === id)
const ids = (doc: SlidomingoDoc, list: number[]) => list.map((i) => (i < 0 ? '-' : doc.slides[i].id)).join(' ')
/** put a tile on slide `on` and return it */
function tile(doc: SlidomingoDoc, on: string, partial: Partial<ZoomElement>): ZoomElement {
  const el = defaultZoom({ slide: 'X' }, partial)
  doc.slides[at(doc, on)].elements.push(el)
  return el
}
/** walk → from the frame's first slide until it zooms out */
function walk(doc: SlidomingoDoc, f: ZoomFrame): string {
  const out: number[] = []
  for (let i = zoomFirst(doc, f), n = 0; i >= 0 && n < 50; i = zoomNext(doc, f, i), n++) out.push(i)
  return ids(doc, out)
}

console.log('— ranges')
{
  const doc = deck('O | A B c D | E F')
  const slideZ = tile(doc, 'O', { target: { slide: 'B' } })
  ok(JSON.stringify(zoomRange(doc, slideZ)) === JSON.stringify({ start: 2, end: 3 }), 'slide zoom = just that slide')
  const toEnd = tile(doc, 'O', { target: { slide: 'B' }, range: 'section' })
  ok(JSON.stringify(zoomRange(doc, toEnd)) === JSON.stringify({ start: 2, end: 5 }), "range 'section' = to the end of its section")
  const secZ = tile(doc, 'O', { target: { section: 'sec-A' } })
  ok(JSON.stringify(zoomRange(doc, secZ)) === JSON.stringify({ start: 1, end: 5 }), 'section zoom = the whole section')
  const lastSec = tile(doc, 'O', { target: { section: 'sec-E' } })
  ok(JSON.stringify(zoomRange(doc, lastSec)) === JSON.stringify({ start: 5, end: 7 }), 'the last section runs to the end of the deck')
  const gone = tile(doc, 'O', { target: { slide: 'nope' } })
  ok(zoomRange(doc, gone) === null && !zoomTargetLive(doc, gone), 'a missing target has no range')
  const noSec = tile(doc, 'O', { target: { section: 'nope' } })
  ok(zoomRange(doc, noSec) === null, 'a missing section has no range')
  ok(zoomCover(doc, secZ)?.id === 'A', 'a section tile shows its first slide')
  ok(zoomCover(doc, slideZ)?.id === 'B', 'a slide tile shows that slide')
  const noTarget = { ...defaultZoom({ slide: 'A' }) } as ZoomElement
  delete (noTarget as Partial<ZoomElement>).target
  ok(zoomRange(doc, noTarget) === null && zoomCover(doc, noTarget) === undefined, 'a tile with no target at all is just empty')
  // range with no sections at all
  const flat = deck('O A B')
  const z = tile(flat, 'O', { target: { slide: 'A' }, range: 'section' })
  ok(JSON.stringify(zoomRange(flat, z)) === JSON.stringify({ start: 1, end: 3 }), "range 'section' without sections runs to the deck's end")
}

console.log('— walking a frame (→ / ←)')
{
  const doc = deck('O | A b C | D')
  const secZ = tile(doc, 'O', { target: { section: 'sec-A' } })
  const f = zoomFrameFor(doc, 0, secZ, 2)!
  ok(!!f && f.step === 2 && f.overview === 0 && f.tile === secZ.id, 'a frame records the overview, the tile and its click')
  ok(walk(doc, f) === 'A b C', 'a section zoom walks its hidden slides too')
  ok(zoomNext(doc, f, at(doc, 'C')) === -1, '→ on the last slide of the range zooms out')
  ok(zoomPrev(doc, f, at(doc, 'A')) === -1, '← on the first slide of the range zooms out')
  ok(zoomPrev(doc, f, at(doc, 'C')) === at(doc, 'b'), '← walks back through hidden slides')
  ok(inZoomFrame(doc, f, at(doc, 'b')) && !inZoomFrame(doc, f, at(doc, 'D')) && !inZoomFrame(doc, f, 0), 'inZoomFrame: in range yes, outside and overview no')
}
{
  // the overview inside its own range is skipped (a tile on A that zooms into A's section)
  const doc = deck('| A B C')
  const z = tile(doc, 'A', { target: { section: 'sec-A' } })
  const f = zoomFrameFor(doc, 0, z)!
  ok(walk(doc, f) === 'B C', 'the overview is never part of its own range')
  ok(!inZoomFrame(doc, f, 0), 'nor in the frame')
  ok(zoomPrev(doc, f, at(doc, 'B')) === -1, '← from the first walkable slide zooms out (not onto the overview)')
}
{
  // states: skipped by the walk, but inside the frame through their parent
  const doc = deck('O | A A:s B')
  const z = tile(doc, 'O', { target: { section: 'sec-A' } })
  const f = zoomFrameFor(doc, 0, z)!
  ok(walk(doc, f) === 'A B', 'states are skipped by → inside a frame')
  ok(inZoomFrame(doc, f, at(doc, 's')), 'a state reached by a link stays inside the frame')
  ok(zoomNext(doc, f, at(doc, 's')) === at(doc, 'B'), '→ on a state continues after its parent')
  ok(zoomPrev(doc, f, at(doc, 's')) === at(doc, 'A'), '← on a state returns to its parent')
}
{
  const doc = deck('O A A:s')
  const self = tile(doc, 'O', { target: { slide: 'O' } })
  ok(zoomFrameFor(doc, 0, self) === null, 'a tile zooming into its own slide opens no frame')
  const st = tile(doc, 'O', { target: { slide: 's' } })
  ok(zoomFrameFor(doc, 0, st) === null, 'a tile targeting a state opens no frame')
  const gone = tile(doc, 'O', { target: { slide: 'zz' } })
  ok(zoomFrameFor(doc, 0, gone) === null, 'a tile with a missing target opens no frame')
}

console.log('— integrity helpers')
{
  const doc = deck('O | A B | C')
  const a = tile(doc, 'O', { target: { slide: 'A' } })
  const s = tile(doc, 'O', { target: { section: 'sec-C' } })
  ok(remapZoomTarget(a, new Map([['A', 'A2']])) && (a.target as { slide: string }).slide === 'A2', 'remap re-points a slide target')
  ok(!remapZoomTarget(s, new Map([['A', 'A2']])), 'remap leaves other targets alone')
  ok(remapZoomTarget(s, new Map(), new Map([['sec-C', 'sec-C2']])) && (s.target as { section: string }).section === 'sec-C2', 'remap re-points a section target')
}
{
  const doc = deck('O | A B | C')
  tile(doc, 'O', { target: { slide: 'A' } })
  tile(doc, 'O', { target: { section: 'sec-A' } })
  tile(doc, 'O', { target: { slide: 'B' } })
  ok(zoomTilesInto(doc, new Set(['A'])) === 2, 'delete impact counts slide tiles and tiles of a section starting there')
  ok(zoomTilesInto(doc, new Set(['O'])) === 0, "tiles ON a doomed slide don't count")
  doc.slides = doc.slides.filter((x) => x.id !== 'B')
  ok(pruneDanglingZoomTiles(doc) === 1 && doc.slides[0].elements.length === 2, 'prune removes exactly the tiles whose target is gone')
  ok(pruneDanglingZoomTiles(doc) === 0, 'prune is idempotent')
}
{
  const doc = deck('O | A B | C')
  const z = tile(doc, 'O', { target: { section: 'sec-A' } })
  ok(retargetSectionZooms(doc, 'sec-A') === 1 && JSON.stringify(z.target) === JSON.stringify({ slide: 'A' }) && z.range === undefined,
    'ungrouping a section turns its zooms into slide zooms of its first slide')
}

console.log('— untrusted.ts (paste)')
{
  const el = sanitizeElement({ ...defaultZoom({ section: 'sec-1' }), range: 'section', returnToZoom: false, duration: 2 }) as ZoomElement
  ok(!!el && JSON.stringify(el.target) === JSON.stringify({ section: 'sec-1' }) && el.range === 'section' && el.returnToZoom === false && el.duration === 2,
    'a well-formed tile round-trips')
  const both = sanitizeElement({ ...defaultZoom({ slide: 'a' }), target: { slide: 'a', section: 'b', evil: 1 } }) as ZoomElement
  ok(JSON.stringify(both.target) === JSON.stringify({ slide: 'a' }), 'a target keeps one id and nothing else')
  const bad = sanitizeElement({ ...defaultZoom({ slide: 'a' }), target: { slide: 'a"}<x>' }, range: 'everything', duration: -1 }) as ZoomElement
  ok(!!bad && bad.target === undefined && bad.range === undefined && bad.duration === undefined,
    'a hostile target / range / duration is dropped but the tile stays (renders as "target missing")')
}

console.log('— validate')
{
  const doc = deck('O A A:s | B c')
  tile(doc, 'O', { target: { slide: 'gone' } })
  tile(doc, 'O', { target: { slide: 's' } })
  tile(doc, 'O', { target: { slide: 'O' } })
  tile(doc, 'O', { target: { section: 'sec-B' } })
  const codes = validateDoc(doc, { measure: false }).findings.map((f) => f.code)
  ok(codes.includes('zoom-missing-target'), 'zoom-missing-target')
  ok(codes.includes('zoom-target-state'), 'zoom-target-state')
  ok(codes.includes('zoom-self-target'), 'zoom-self-target')
  ok(!codes.includes('unknown-key'), 'zoom keys are known (modelkeys)')
  const doc2 = deck('O | A | b')
  ok(validateDoc(doc2, { measure: false }).findings.some((f) => f.code === 'unreachable-hidden-slide') === false, '(control) b is an extra of A')
  const doc3 = deck('| b C')
  ok(validateDoc(doc3, { measure: false }).findings.some((f) => f.code === 'unreachable-hidden-slide'), '(control) a leading hidden slide is unreachable')
  tile(doc3, 'C', { target: { section: 'sec-b' } })
  ok(!validateDoc(doc3, { measure: false }).findings.some((f) => f.code === 'unreachable-hidden-slide'), 'a zoom into it makes it reachable')
}

console.log('— summary zoom')
for (const size of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 1080, height: 1350 }]) {
  let allOk = true
  for (let n = 1; n <= 12; n++) {
    const g = summaryZoomGrid(n, size)
    if (g.length !== n) allOk = false
    for (const r of g) {
      if (r.x < 0 || r.y < size.height * 0.2 || r.x + r.w > size.width || r.y + r.h > size.height) allOk = false
      if (Math.abs(r.w / r.h - size.width / size.height) > 0.02) allOk = false
    }
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) allOk = false
    }
    if (g[0].w < 60) allOk = false
  }
  ok(allOk, `grid ${size.width}x${size.height}: n = 1…12 tiles fit under the title, keep the aspect, never overlap`)
}
ok(summaryZoomGrid(0, { width: 1280, height: 720 }).length === 0, 'no tiles for n = 0')
{
  const doc = deck('T | A B | C D | E')
  const before = doc.sections!.length
  const ov = insertSummaryZoom(doc, [{ section: 'sec-C' }, { section: 'sec-A' }], 'Summary', 'Summary', (s) => s.id)!
  ok(!!ov && at(doc, ov.id) === 1, 'the overview goes right before the first picked section')
  const tiles = ov.elements.filter((e) => e.type === 'zoom') as ZoomElement[]
  ok(tiles.map((t) => (t.target as { section: string }).section).join(',') === 'sec-A,sec-C', 'one tile per section, in deck order')
  ok(doc.sections!.length === before + 1 && doc.sections!.some((s) => s.startSlideId === ov.id && s.name === 'Summary'), 'the overview gets its own Summary section')
  ok(ov.elements.some((e) => e.type === 'text' && e.role === 'title'), 'the overview has a title')
}
{
  const doc = deck('T A B C D')
  const ov = insertSummaryZoom(doc, [{ slide: 'B' }, { slide: 'D' }], 'Summary', 'Summary', (s) => `Sec ${s.id}`)!
  const names = doc.sections!.map((s) => s.name).sort().join(',')
  ok(names === 'Sec B,Sec D,Summary', 'picked slides start new sections (PowerPoint), named by the caller')
  ok(at(doc, ov.id) === at(doc, 'B') - 1, 'the overview sits before the first picked slide')
  const f = zoomFrameFor(doc, at(doc, ov.id), ov.elements.find((e) => e.type === 'zoom') as ZoomElement)!
  ok(walk(doc, f) === 'B C', 'a summary tile plays its section')
  ok(insertSummaryZoom(doc, [], 'S', 'S', () => 'x') === null, 'no picks, no overview')
}

console.log('— camera (zoom.ts)')
{
  const size = { width: 1280, height: 720 }
  const r = zoomTileRect({ x: 100, y: 200, w: 320, h: 180 }, size)
  ok(r.x === 100 && r.y === 200 && r.w === 320 && r.h === 180, 'a tile in the slide aspect is its own cover rect')
  const tall = zoomTileRect({ x: 0, y: 0, w: 320, h: 400 }, size)
  ok(near(tall.w, 320) && near(tall.h, 180) && near(tall.y, 110), 'a taller tile letterboxes the cover, centred')
  const c0 = zoomFrame(r, size, 0)!
  ok(near(c0.s, 1) && near(c0.tx, 0) && near(c0.ty, 0), 'p = 0: the overview as it is')
  const c1 = zoomFrame(r, size, 1)!
  ok(near(c1.s * r.x + c1.tx, 0) && near(c1.s * r.y + c1.ty, 0) && near(c1.s * (r.x + r.w) + c1.tx, size.width) && near(c1.s * (r.y + r.h) + c1.ty, size.height, 1e-4),
    'p = 1: the tile fills the slide exactly')
  const t1 = zoomSlideFrame(r, size, 1)!
  ok(near(t1.s, 1) && near(t1.tx, 0) && near(t1.ty, 0), 'p = 1: the target slide is at rest (identity)')
  const t0 = zoomSlideFrame(r, size, 0)!
  ok(near(t0.s, r.w / size.width) && near(t0.tx, r.x) && near(t0.ty, r.y), 'p = 0: the target slide sits exactly in the tile')
  let mono = true
  let prev = 0
  const ratios: number[] = []
  for (let i = 0; i <= 20; i++) {
    const c = zoomFrame(r, size, i / 20)!
    if (c.s <= prev) mono = false
    if (i) ratios.push(c.s / prev)
    prev = c.s
  }
  ok(mono, 'scale grows monotonically')
  ok(ratios.every((q) => near(q, ratios[0], 1e-9)), 'equal steps of p = equal zoom ratios (log space)')
  // the fixed point does not move
  const S = size.width / r.w
  const fx = (S * r.x) / (S - 1), fy = (S * r.y) / (S - 1)
  const cm = zoomFrame(r, size, 0.37)!
  ok(near(cm.s * fx + cm.tx, fx) && near(cm.s * fy + cm.ty, fy), 'one point of the overview stays put the whole way')
  ok(fx >= 0 && fx <= size.width && fy >= 0 && fy <= size.height, 'and it lies on the slide')
  ok(zoomScale({ x: 0, y: 0, w: 1280, h: 720 }, size) === 0 && zoomFrame({ x: 0, y: 0, w: 1280, h: 720 }, size, 0.5) === null,
    'a full-size tile has nothing to dive into: crossfade')
  ok(zoomFrame({ x: 1100, y: 600, w: 320, h: 180 }, size, 0.5) === null, 'a tile hanging off the slide crossfades')
  ok(zoomSlideOpacity(0) === 0 && zoomSlideOpacity(0.3) === 1 && zoomSlideOpacity(1) === 1, 'the target fades in over the first 30%')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
