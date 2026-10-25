#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Layout guard rig (slides/src/layoutguard.ts) — runs without a DOM; text
// measurement is a stub keyed by html, so every height is exact.
//
//   slides/node_modules/.bin/esbuild scripts/test-layoutguard.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-layoutguard.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node $TMPDIR/test-layoutguard.mjs
//
// (bundled because model.ts uses extensionless imports)
//
// WHAT THIS PROVES. The guard edits slides nobody asked it to touch, so the
// cases that matter are both directions: it fixes what is predictable (a
// stack keeps its gaps, a row keeps its span, an arrow keeps its box) and it
// keeps its hands off what is deliberate (a move, a card behind its text,
// reflow:false) — reporting instead.

import { defaultShape, defaultText, emptySlide, newDoc, type ShapeElement, type Slide, type SlideElement, type TextElement } from '../slides/src/model.ts'
import { checkLayout, guardLayout, snapshotSlide, staticBaseline } from '../slides/src/layoutguard.ts'
import { lineEndpoints } from '../slides/src/editor/lineedit.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}
const near = (a: number, b: number, eps = 0.6) => Math.abs(a - b) <= eps

/** Stub measure: html "need:<px>|..." needs that many px; anything else fits. */
const measure = (el: TextElement) => {
  const m = /need:(\d+)/.exec(el.html)
  return m ? Number(m[1]) : el.h
}

const text = (id: string, x: number, y: number, w: number, h: number, extra: Partial<TextElement> = {}) =>
  defaultText({ id, x, y, w, h, html: id, valign: 'top', ...extra })
const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<ShapeElement> = {}) =>
  defaultShape('rect', { id, x, y, w, h, ...extra })

function setup(els: SlideElement[]): { doc: ReturnType<typeof newDoc>; slide: Slide } {
  const doc = newDoc()
  const slide = emptySlide({ id: 's1' })
  slide.elements = els
  doc.slides = [slide]
  return { doc, slide }
}
const get = <T extends SlideElement = SlideElement>(slide: Slide, id: string) => slide.elements.find((e) => e.id === id) as T

console.log('\ngrow text, column keeps its gaps')
{
  const { doc, slide } = setup([text('a', 100, 100, 600, 60), text('b', 100, 200, 600, 60), text('c', 100, 300, 600, 60)])
  const before = snapshotSlide(slide)
  get<TextElement>(slide, 'a').html = 'need:120|a much longer text'
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  ok(get(slide, 'a').h === 120, 'the edited box grew to its measured height')
  ok(near(get(slide, 'b').y, 260) && near(get(slide, 'c').y, 360), 'the two below moved down 60 (gaps kept)')
  ok(r.adjusted.some((a) => a.kind === 'grow' && a.element === 'a'), 'growth reported')
  ok(r.adjusted.filter((a) => a.kind === 'shift').length === 2, 'two shifts reported')
  ok(r.issues.filter((i) => i.severity !== 'info').length === 0, 'no remaining issues')
}

console.log('\nshrink closes the gap, unless another column still holds it')
{
  const { doc, slide } = setup([text('a', 100, 100, 300, 200), text('side', 500, 100, 300, 100), text('foot', 100, 340, 700, 60)])
  const before = snapshotSlide(slide)
  get(slide, 'a').h = 100
  guardLayout(doc, slide, before, { apply: true, measure })
  ok(near(get(slide, 'foot').y, 240), 'footer under a shrunk column moved up 100')
}
{
  const { doc, slide } = setup([text('a', 100, 100, 300, 200), text('side', 500, 100, 300, 200), text('foot', 100, 340, 700, 60)])
  const before = snapshotSlide(slide)
  get(slide, 'a').h = 100
  guardLayout(doc, slide, before, { apply: true, measure })
  ok(near(get(slide, 'foot').y, 340), 'a full-height neighbour column keeps the footer in place')
}

console.log('\nmiddle of an evenly spaced row is redistributed within its span')
{
  const { doc, slide } = setup([rect('c1', 100, 200, 280, 200), rect('c2', 500, 200, 280, 200), rect('c3', 900, 200, 280, 200)])
  const before = snapshotSlide(slide)
  get(slide, 'c2').w = 380
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  ok(near(get(slide, 'c1').x, 100) && near(get(slide, 'c3').x, 900), 'outer cards keep the span')
  ok(near(get(slide, 'c2').x, 450), 'middle card recentred (equal 70px gaps)')
  ok(r.adjusted.some((a) => a.kind === 'redistribute'), 'reported as redistribution')
  ok(!r.issues.some((i) => i.code === 'layout-uneven-gap'), 'no uneven-gap finding afterwards')
}

console.log('\nfree arrow touching a resized box follows and gets bound')
{
  const line = defaultShape('line', { id: 'ln', x: 300, y: 448, w: 300, h: 4, rotation: 0 })
  const { doc, slide } = setup([rect('p', 100, 400, 200, 100), line])
  const before = snapshotSlide(slide)
  get(slide, 'p').w = 300
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  const [a, b] = lineEndpoints(get<ShapeElement>(slide, 'ln'))
  ok(near(a.x, 400) && near(a.y, 450), `start followed the box edge (${Math.round(a.x)},${Math.round(a.y)})`)
  ok(near(b.x, 600) && near(b.y, 450), 'far end stayed put')
  ok(get<ShapeElement>(slide, 'ln').from?.el === 'p' && get<ShapeElement>(slide, 'ln').from?.side === 'right', 'bound to p (right)')
  ok(r.adjusted.some((x) => x.kind === 'bind'), 'binding reported')
}

{
  // the far end sits on another box's side midpoint: bound too
  const line = defaultShape('line', { id: 'ln', x: 300, y: 448, w: 300, h: 4, rotation: 0 })
  const { doc, slide } = setup([rect('p', 100, 400, 200, 100), rect('q', 600, 400, 200, 100), line])
  const before = snapshotSlide(slide)
  get(slide, 'p').h = 160
  guardLayout(doc, slide, before, { apply: true, measure })
  const l = get<ShapeElement>(slide, 'ln')
  ok(l.from?.el === 'p' && l.to?.el === 'q' && l.to?.side === 'left', 'the untouched far end is attached to the box it sat on')
}

console.log('\nbound connector re-routes on any slide')
{
  const conn = defaultShape('line', { id: 'cn', x: 300, y: 148, w: 200, h: 4, from: { el: 'q', side: 'right' }, to: { el: 'r', side: 'left' } })
  const { doc, slide } = setup([rect('q', 100, 100, 200, 100), rect('r', 500, 100, 200, 100), conn])
  doc.slides.unshift(emptySlide({ id: 's0' })) // s1 is not the "open" slide
  const before = snapshotSlide(slide)
  get(slide, 'q').y = 300
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  const [a, b] = lineEndpoints(get<ShapeElement>(slide, 'cn'))
  ok(near(a.x, 300) && near(a.y, 350) && near(b.x, 500) && near(b.y, 150), 'endpoints follow q and r')
  ok(r.adjusted.some((x) => x.kind === 'reroute' && x.element === 'cn'), 'reroute reported')
}

console.log('\na move onto another text box is reported, not undone')
{
  const { doc, slide } = setup([text('t1', 100, 100, 300, 60), text('t2', 100, 300, 300, 60)])
  const before = snapshotSlide(slide)
  get(slide, 't1').y = 280
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  ok(get(slide, 't1').y === 280 && get(slide, 't2').y === 300, 'nothing moved')
  const ov = r.issues.find((i) => i.code === 'layout-overlap')
  ok(!!ov && ov.element === 't1' && !!ov.suggest, 'layout-overlap on t1 with a suggested frame')
}
{
  // the suggestion must not land on a third box
  const { doc, slide } = setup([text('t1', 100, 100, 300, 50), text('t2', 100, 300, 300, 50), text('t3', 100, 366, 300, 50)])
  const before = snapshotSlide(slide)
  get(slide, 't1').y = 320
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  const sug = r.issues.find((i) => i.code === 'layout-overlap' && i.elements?.includes('t2'))?.suggest
  const hits = (f: { x: number; y: number; w: number; h: number }, id: string) => {
    const o = get(slide, id)
    return Math.min(f.x + f.w, o.x + o.w) - Math.max(f.x, o.x) > 1 && Math.min(f.y + f.h, o.y + o.h) - Math.max(f.y, o.y) > 1
  }
  ok(!!sug && !hits(sug, 't2') && !hits(sug, 't3'), `suggested frame clears every box (${sug && `${sug.x},${sug.y}`})`)
}

console.log('\nno room: a push past the canvas is reverted')
{
  const { doc, slide } = setup([text('a', 100, 500, 600, 60), text('b', 100, 620, 600, 80)])
  const before = snapshotSlide(slide)
  get<TextElement>(slide, 'a').html = 'need:150|longer'
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  ok(get(slide, 'b').y === 620, 'b stayed on the canvas')
  ok(r.issues.some((i) => i.code === 'layout-no-room' && i.elements?.includes('b')), 'layout-no-room names b')
  ok(r.issues.some((i) => i.code === 'layout-overlap'), 'the resulting overlap is reported')
}

console.log('\na card behind its text')
{
  const { doc, slide } = setup([rect('card', 80, 80, 400, 300), text('in', 100, 100, 360, 60), text('below', 80, 420, 400, 60)])
  const before = snapshotSlide(slide)
  get<TextElement>(slide, 'in').html = 'need:100|grown'
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  ok(!r.issues.some((i) => i.code === 'layout-overlap'), 'card+text is not an overlap')
  ok(get(slide, 'card').y === 80 && get(slide, 'card').h === 300, 'a roomy card neither moved nor grew')
  ok(get(slide, 'below').y === 420, 'nothing below the card moved')
}
{
  const { doc, slide } = setup([rect('card', 80, 80, 400, 120), text('in', 100, 100, 360, 80), text('below', 80, 240, 400, 60)])
  const before = snapshotSlide(slide)
  get<TextElement>(slide, 'in').html = 'need:140|grown'
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  ok(get(slide, 'card').h === 180, `a full card grew with its text (h ${get(slide, 'card').h})`)
  ok(near(get(slide, 'below').y, 300), 'and what sits under the card moved with it')
  ok(!r.issues.some((i) => i.code === 'layout-overlap'), 'no overlap left')
}

console.log('\nreflow:false reports but changes nothing')
{
  const { doc, slide } = setup([text('a', 100, 100, 600, 60), text('b', 100, 200, 600, 60)])
  const before = snapshotSlide(slide)
  get<TextElement>(slide, 'a').html = 'need:150|longer'
  const snap = JSON.stringify(slide)
  const r = guardLayout(doc, slide, before, { apply: false, measure })
  ok(JSON.stringify(slide) === snap, 'slide untouched')
  ok(r.adjusted.length === 0, 'no adjustments claimed')
  ok(r.issues.some((i) => i.code === 'layout-overlap'), 'the overlap the growth implies is reported')
}

console.log('\na stack with no room below is respaced within its span instead')
{
  // three boxes, 140px gaps, down to 640: pushing c 100px leaves the canvas
  const { doc, slide } = setup([text('a', 100, 60, 600, 100), text('b', 100, 300, 600, 100), text('c', 100, 540, 600, 100)])
  const before = snapshotSlide(slide)
  get<TextElement>(slide, 'b').html = 'need:200|longer'
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  ok(near(get(slide, 'a').y, 60) && near(get(slide, 'c').y, 540), 'outer edges of the stack kept')
  ok(near(get(slide, 'b').y, 250), `b recentred with equal 90px gaps (y ${get(slide, 'b').y})`)
  ok(!r.issues.some((i) => i.code === 'layout-no-room'), 'no no-room issue')
}

console.log('\ngroups and containers')
{
  const { doc, slide } = setup([text('a', 100, 100, 300, 60), text('g1', 100, 200, 300, 60, { groupId: 'G' }), text('g2', 500, 200, 300, 60, { groupId: 'G' })])
  const before = snapshotSlide(slide)
  get<TextElement>(slide, 'a').html = 'need:100|x'
  guardLayout(doc, slide, before, { apply: true, measure })
  ok(near(get(slide, 'g1').y, 240) && near(get(slide, 'g2').y, 240), 'a group moves as one even where only one member was below')
}
{
  const box = rect('box', 100, 100, 400, 300, { container: true })
  const child = text('ch', 120, 120, 360, 60, { parentId: 'box', parentOffset: { relX: 20 / 400, relY: 20 / 300, relW: 360 / 400, relH: 60 / 300 } })
  const { doc, slide } = setup([box, child])
  const before = snapshotSlide(slide)
  get(slide, 'box').x = 300 // an agent moves the container on a slide nobody has open
  guardLayout(doc, slide, before, { apply: true, measure })
  ok(near(get(slide, 'ch').x, 320), 'its child follows')
}
{
  // ...and an arrow touching the child follows it; a child landing on text is reported
  const box = rect('box', 100, 100, 400, 300, { container: true })
  const child = text('ch', 120, 120, 360, 60, { parentId: 'box', parentOffset: { relX: 20 / 400, relY: 20 / 300, relW: 360 / 400, relH: 60 / 300 } })
  const line = defaultShape('line', { id: 'ln', x: 480, y: 148, w: 200, h: 4, rotation: 0 })
  const { doc, slide } = setup([box, child, line, text('other', 700, 420, 300, 60)])
  const before = snapshotSlide(slide)
  get(slide, 'box').x = 560
  get(slide, 'box').y = 380
  const r = guardLayout(doc, slide, before, { apply: true, measure })
  const [a] = lineEndpoints(get<ShapeElement>(slide, 'ln'))
  ok(near(a.x, 940) && near(a.y, 430), `the arrow end on the child followed it (${Math.round(a.x)},${Math.round(a.y)})`)
  ok(r.issues.some((i) => i.code === 'layout-overlap' && i.elements?.includes('ch') && i.elements?.includes('other')), 'the carried child now on "other" is reported')
}
{
  const box = rect('box', 100, 100, 400, 300, { container: true })
  const child = text('ch', 120, 120, 360, 60, { parentId: 'box', parentOffset: { relX: 20 / 400, relY: 20 / 300, relW: 360 / 400, relH: 60 / 300 } })
  const { doc, slide } = setup([box, child])
  const before = snapshotSlide(slide)
  get(slide, 'ch').y = 200 // the child itself is moved
  guardLayout(doc, slide, before, { apply: true, measure })
  const off = get(slide, 'ch').parentOffset!
  ok(near(off.relY * 300 + 100, 200), 'a moved child is re-anchored, so syncContainers will not snap it back')
}

console.log('\nmiddle-aligned text grows both ways')
{
  const { doc, slide } = setup([text('top', 100, 40, 600, 40), text('m', 100, 200, 600, 80, { valign: 'middle' }), text('bot', 100, 320, 600, 40)])
  const before = snapshotSlide(slide)
  get<TextElement>(slide, 'm').html = 'need:120|x'
  guardLayout(doc, slide, before, { apply: true, measure })
  ok(near(get(slide, 'm').y, 180) && get(slide, 'm').h === 120, 'centre kept')
  ok(near(get(slide, 'bot').y, 340) && near(get(slide, 'top').y, 20), 'neighbours above and below keep their gaps')
}

console.log('\ncheck_layout and Tidy static mode')
{
  const { doc, slide } = setup([rect('bg', 0, 0, 1280, 720), text('a', 100, 100, 600, 160), text('b', 100, 230, 600, 60)])
  const issues = checkLayout(doc, slide, { measure })
  ok(issues.some((i) => i.code === 'layout-overlap'), 'a static overlap is found')
  ok(!issues.some((i) => i.elements?.includes('bg')), 'the full-bleed backdrop is never part of one')
  const ids = new Set(['a'])
  const before = staticBaseline(doc, slide, ids, measure)
  guardLayout(doc, slide, before, { apply: true, measure, changed: ids, growAll: true })
  ok(near(get(slide, 'b').y, 276), `Tidy pushed the overlapped neighbour below a (y ${get(slide, 'b').y})`)
  ok(checkLayout(doc, slide, { measure }).length === 0, 'check_layout is clean afterwards')
}

console.log('\nnested boxes: tight inset')
{
  const tightOf = (els: SlideElement[]) => checkLayout(setup(els).doc, setup(els).slide, { measure }).filter((i) => i.code === 'layout-tight-inset')
  const outer = () => rect('outer', 100, 100, 600, 300)
  const t3 = tightOf([outer(), rect('inner', 103, 160, 200, 100)])
  ok(t3.length === 1 && t3[0].element === 'inner' && t3[0].severity === 'info', 'a nested box 3px inside is flagged')
  ok(!!t3[0]?.suggest && t3[0].suggest.x >= 112 - 0.5, 'its suggestion is inset to the minimum')
  ok(tightOf([outer(), rect('inner', 120, 160, 200, 100)]).length === 0, 'a nested box 20px inside is clean')
  ok(tightOf([outer(), rect('inner', 100, 160, 200, 100)]).length === 0, 'a box flush with the edge is deliberate, not flagged')
  const arrow = defaultShape('line', { id: 'ar', x: 20, y: 208, w: 83, h: 4, rotation: 0 })
  const ta = tightOf([outer(), rect('inner', 103, 160, 200, 100), arrow])
  ok(ta.length === 1 && ta[0].severity === 'warning' && !!ta[0].elements?.includes('ar'), 'an arrow ending on a tight inner box is flagged, stronger')
  ok(tightOf([outer(), rect('inner', 120, 160, 200, 100), arrow]).length === 0, 'the same arrow into a roomy inner box is clean')
}

console.log('\nempty band under the title')
{
  const bandOf = (els: SlideElement[]) => { const { doc, slide } = setup(els); return checkLayout(doc, slide, { measure }).filter((i) => i.code === 'layout-empty-band') }
  const title = () => text('t', 96, 100, 1000, 70, { role: 'title' })
  ok(bandOf([title(), rect('fig', 96, 230, 1088, 400)]).length === 0, 'content 60px under the title and down to the footer: no finding')
  const low = bandOf([title(), rect('fig', 96, 300, 1088, 330)])
  ok(low.length === 1 && /starts 130px below the title/.test(low[0].message), 'content starting 130px under the title: an empty band', )
  const short = bandOf([title(), rect('fig', 96, 220, 1088, 200)])
  ok(short.length === 1 && /lower 228px of the slide are empty/.test(short[0].message), 'content ending halfway down: the empty lower part')
  ok(bandOf([text('t', 96, 300, 1000, 120, { role: 'title' }), rect('fig', 96, 560, 600, 40)]).length === 0, 'a title low on the slide (title or statement slide): not checked')
}

console.log(`\n${checks - failures}/${checks} passed`)
if (failures) process.exit(1)
