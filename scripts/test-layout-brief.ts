#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// doc_info's slide-type brief (slides/src/layoutbrief.ts).
//
//   node scripts/test-layout-brief.ts
//
// An agent fills a slide of an imported template from this brief instead of
// writing a probe slide first, so it must name the placeholders it can fill
// (the type's own and its parent's, never a hidden one) and a content area
// that clears the header and the footer, ignores the full-slide background,
// and lines up with the title.

import { layoutBrief } from '../slides/src/layoutbrief.ts'
import type { Slide, SlideElement, SlidomingoDoc } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string, got?: unknown) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`) }
  else console.log(`  ok    ${msg}`)
}

const text = (id: string, x: number, y: number, w: number, h: number, more: Record<string, unknown> = {}): SlideElement =>
  ({ id, type: 'text', x, y, w, h, html: '', ...more }) as unknown as SlideElement
const shape = (id: string, x: number, y: number, w: number, h: number, more: Record<string, unknown> = {}): SlideElement =>
  ({ id, type: 'shape', shape: 'rect', x, y, w, h, ...more }) as unknown as SlideElement

// A master like the imported Fraunhofer one: a full-slide picture, a logo top
// right, a footer band; the content type adds title, subtitle, a body slot and
// an accent bar under the subtitle.
const master: Slide = { id: 'm', elements: [
  shape('bg', 0, 0, 1280, 720),
  shape('logo', 965, 51, 265, 96),
  shape('band', 0, 644, 1280, 76),
  text('date', 145, 678, 76, 13),
] } as unknown as Slide
const content: Slide = { id: 'c', parentId: 'm', elements: [
  text('t', 50, 42, 1179, 40, { role: 'title', placeholder: 'Click to add title' }),
  text('sub', 50, 82, 1179, 34, { role: 'body', placeholder: 'Click to add text' }),
  text('body', 52, 179, 1179, 311, { role: 'body', placeholder: 'Click to add text' }),
  shape('bar', 50, 128, 38, 5),
  text('gone', 50, 600, 100, 20, { role: 'body', placeholder: 'x', hidden: true }),
] } as unknown as Slide
const bare: Slide = { id: 'b', elements: [] } as unknown as Slide
const doc = { size: { width: 1280, height: 720 }, layouts: [master, content, bare], slides: [] } as unknown as SlidomingoDoc

const c = layoutBrief(doc, content, 96)
ok(c.placeholders.map((p) => p.id).join() === 't,sub,body', 'placeholders: the type\'s own, in order, hidden left out', c.placeholders.map((p) => p.id))
ok(c.placeholders[0].role === 'title' && c.placeholders[0].frame.join() === '50,42,1179,40', 'a placeholder carries its role and frame', c.placeholders[0])
ok(c.contentArea[1] === 163, 'content starts 16px below the lowest header element (the parent\'s logo, 147), not the full-slide background', c.contentArea)
ok(c.contentArea[1] + c.contentArea[3] === 628, 'content ends 16px above the footer band (644)', c.contentArea)
ok(c.contentArea[0] === 50 && c.contentArea[2] === 1180, 'content lines up with the title (x 50, symmetric)', c.contentArea)

const b = layoutBrief(doc, bare, 96)
ok(b.placeholders.length === 0, 'a type with nothing: no placeholders')
ok(b.contentArea.join() === '96,72,1088,576', 'a type with nothing: the deck margins', b.contentArea)

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
