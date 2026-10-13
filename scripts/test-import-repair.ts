#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Import repair rig (slides/src/importrepair.ts) — runs without a DOM; text
// measurement is a stub that reads the needed height out of the html and
// scales it with the font size, so every outcome is exact.
//
//   slides/node_modules/.bin/esbuild scripts/test-import-repair.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-import-repair.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node $TMPDIR/test-import-repair.mjs
//
// (bundled because model.ts uses extensionless imports)
//
// WHAT THIS PROVES. The static pass edits imported slides nobody touched yet,
// so both directions matter: it fixes overflow the way PowerPoint would
// (grow the box, else shrink the type a little) and it keeps its hands off
// what it cannot fix faithfully — covering a neighbour, leaving the slide,
// a slot the slide type owns — and reports those instead.

import { defaultShape, defaultText, emptySlide, newDoc, type SlidomingoDoc, type TextElement } from '../slides/src/model.ts'
import { MIN_SHRINK, repairItems, settleImportedText } from '../slides/src/importrepair.ts'
import type { FidelityReport } from '../kernel/src/convert/report.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

/** Stub measure: html "need:<px>@<fs>" needs <px> at font size <fs>, and
 *  proportionally more or less at another size; anything else fits. */
const measure = (el: TextElement) => {
  const m = /need:(\d+)@(\d+)/.exec(el.html)
  return m ? Number(m[1]) * el.fontSize / Number(m[2]) : el.h
}

const text = (id: string, x: number, y: number, w: number, h: number, extra: Partial<TextElement> = {}) =>
  defaultText({ id, x, y, w, h, html: id, valign: 'top', fontSize: 40, ...extra })

function deck(...slides: Array<ReturnType<typeof emptySlide>>): SlidomingoDoc {
  const doc = newDoc()
  doc.slides = slides
  return doc
}

function slideWith(id: string, elements: ReturnType<typeof emptySlide>['elements']) {
  const s = emptySlide()
  s.id = id
  s.elements = elements
  return s
}

console.log('grow')
{
  const t = text('t', 100, 100, 400, 100, { html: 'need:160@40' })
  const doc = deck(slideWith('s1', [t]))
  const r = settleImportedText(doc, measure)
  ok(r.grown === 1 && r.shrunk === 0 && !r.leftovers.length, 'a top-anchored box with room below grows')
  ok(t.y === 100 && t.h === 160 && t.fontSize === 40, '…downward, type size kept')
}
{
  const t = text('t', 100, 300, 400, 100, { html: 'need:160@40', valign: 'bottom' })
  settleImportedText(deck(slideWith('s1', [t])), measure)
  ok(t.y === 240 && t.h === 160, 'a bottom-anchored box grows upward (bottom edge kept)')
}
{
  const t = text('t', 100, 300, 400, 100, { html: 'need:160@40', valign: 'middle' })
  settleImportedText(deck(slideWith('s1', [t])), measure)
  ok(t.y === 270 && t.h === 160, 'a middle-anchored box grows both ways (centre kept)')
}
{
  const t = text('t', 100, 100, 400, 100, { html: 'need:100@40' })
  const r = settleImportedText(deck(slideWith('s1', [t])), measure)
  ok(r.grown === 0 && r.shrunk === 0 && t.h === 100, 'a box that fits is left alone')
}
{
  const t = text('t', 100, 100, 400, 100, { html: 'need:160@40', groupId: 'g1' })
  const shape = defaultShape('rect', { id: 'b', x: 100, y: 100, w: 400, h: 100, groupId: 'g1' })
  const r = settleImportedText(deck(slideWith('s1', [shape, t])), measure)
  ok(r.grown === 1 && shape.h === 160 && shape.y === 100, 'the welded box-with-text shape grows with its text')
}
{
  const card = defaultShape('rect', { id: 'card', x: 50, y: 50, w: 600, h: 400 })
  const t = text('t', 100, 100, 400, 100, { html: 'need:160@40' })
  const r = settleImportedText(deck(slideWith('s1', [card, t])), measure)
  ok(r.grown === 1 && t.h === 160, 'a card the text already sits on does not block growth')
}
{
  const bg = defaultShape('rect', { id: 'bg', x: 0, y: 0, w: 1280, h: 720 })
  const t = text('t', 100, 100, 400, 100, { html: 'need:160@40' })
  const r = settleImportedText(deck(slideWith('s1', [bg, t])), measure)
  ok(r.grown === 1, 'a full-bleed backdrop does not block growth')
}

console.log('shrink')
{
  const t = text('t', 100, 100, 400, 100, { html: 'need:110@40' })
  const below = defaultShape('rect', { id: 'below', x: 100, y: 205, w: 400, h: 80 })
  const r = settleImportedText(deck(slideWith('s1', [t, below])), measure)
  ok(r.grown === 0 && r.shrunk === 1, 'growing would cover a neighbour, so the type shrinks instead')
  ok(t.h === 100 && t.y === 100, '…the box keeps its frame')
  ok(measure(t) <= 101 && t.fontSize >= 40 * MIN_SHRINK && t.fontSize < 40, `…to the largest size that fits (${t.fontSize}px)`)
}
{
  const t = text('t', 100, 655, 400, 60, { html: 'need:70@40' })
  const r = settleImportedText(deck(slideWith('s1', [t])), measure)
  ok(r.grown === 0 && r.shrunk === 1 && t.y + t.h <= 720, 'growing would leave the slide, so the type shrinks instead')
}
{
  const t = text('t', 100, 100, 400, 100, { html: 'need:110@40 <span style="font-size:20px">x</span>' })
  const below = defaultShape('rect', { id: 'below', x: 100, y: 205, w: 400, h: 80 })
  settleImportedText(deck(slideWith('s1', [t, below])), measure)
  const run = Number(/font-size:([\d.]+)px/.exec(t.html)?.[1])
  ok(run < 20 && Math.abs(run / 20 - t.fontSize / 40) < 0.01, `run sizes in the html scale with the box (${run}px)`)
}

console.log('leftovers')
{
  const t = text('t', 100, 100, 400, 100, { html: 'need:200@40' })
  const below = defaultShape('rect', { id: 'below', x: 100, y: 205, w: 400, h: 80 })
  const doc = deck(slideWith('s1', [t, below]))
  const r = settleImportedText(doc, measure)
  ok(r.grown === 0 && r.shrunk === 0 && r.leftovers.length === 1, 'too much text for a faithful fix is left as is')
  ok(t.h === 100 && t.fontSize === 40 && t.html === 'need:200@40', '…untouched')
  ok(r.leftovers[0]?.elementId === 't' && r.leftovers[0]?.slideId === 's1' && r.leftovers[0]?.overflow === 100, '…and reported with its id and overflow')
}
{
  const doc = newDoc()
  const layout = emptySlide()
  layout.id = 'pl1'
  layout.elements = [text('pl1-title', 100, 100, 400, 100, { role: 'title' })]
  doc.layouts = [layout]
  const s = slideWith('s1', [text('pl1-title', 100, 100, 400, 100, { role: 'title', html: 'need:160@40' })])
  s.layoutId = 'pl1'
  doc.slides = [s]
  const r = settleImportedText(doc, measure)
  ok(r.grown === 0 && r.leftovers.length === 1 && s.elements[0].h === 100, 'a slot the slide type owns is reported, not resized')
}
{
  const t = text('t', 100, 100, 400, 100, { html: 'need:110@40', rotation: 30 })
  const r = settleImportedText(deck(slideWith('s1', [t])), measure)
  ok(r.grown === 0 && r.shrunk === 1, 'a rotated box is never grown (shrink only)')
}

console.log('repair items')
{
  const doc = deck(slideWith('s1', []), slideWith('s3', []))
  const report: FidelityReport = {
    counts: { carried: 1, approximated: 3, dropped: 3 },
    provenance: {},
    entries: [
      { code: 'chart-imported', verdict: 'carried', where: 'slide 1 / sp "Chart 2"', detail: 'ok', count: 1 },
      { code: 'graphic-dropped', verdict: 'dropped', where: 'slide 3 / sp "Diagram 4"', detail: 'SmartArt', count: 1 },
      { code: 'image-missing-part', verdict: 'dropped', where: 'slide 1 / sp 5', detail: 'gone', count: 1 },
      { code: 'table-text-flattened', verdict: 'approximated', where: 'slide 1 / sp "Table 1"', detail: 'flat', count: 2 },
      { code: 'shape-approximated', verdict: 'approximated', where: 'layout 2 / sp "Arrow"', detail: 'arrow', count: 1 },
      { code: 'background-unresolved', verdict: 'dropped', where: 'slide 2', detail: 'white', count: 1 },
    ],
  }
  const items = repairItems(doc, report, [{ slideId: 's1', slide: 1, elementId: 't9', overflow: 42, why: 'covers' }])
  const codes = items.map((i) => i.code)
  ok(!codes.includes('chart-imported') && !codes.includes('image-missing-part'), 'carried entries and unrepairable codes are not sent')
  ok(!items.some((i) => i.code === 'shape-approximated'), 'layout/master entries are not sent')
  ok(!items.some((i) => i.code === 'background-unresolved'), 'an entry for a slide no longer in the deck drops out')
  const g = items.find((i) => i.code === 'graphic-dropped')
  ok(g?.slide === 2 && g.slideId === 's3' && g.shape === 'sp "Diagram 4"', 'source slide 3 is found as deck slide 2 (id s3), with its shape')
  ok(items.find((i) => i.code === 'table-text-flattened')?.count === 2, 'counts carry over')
  const o = items.find((i) => i.code === 'text-overflow')
  ok(o?.elementId === 't9' && /42px/.test(o.detail), 'static leftovers become text-overflow items')
  ok(items.map((i) => i.slide).join() === [...items.map((i) => i.slide)].sort((a, b) => a - b).join(), 'sorted by slide')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
