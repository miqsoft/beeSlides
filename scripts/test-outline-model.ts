#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Outline View, the pure half (slides/src/editor/outlinemodel.ts): every text
// element is reachable, whatever the slide's roles, and what the outline
// cannot edit is only counted. Runs without a DOM.
//
//   npx tsx scripts/test-outline-model.ts

import { defaultText, emptySlide, type Slide, type SlideElement, type TextElement } from '../slides/src/model.ts'
import { outlineParts } from '../slides/src/editor/outlinemodel.ts'

let failures = 0
const eq = (a: unknown, b: unknown, message: string) => {
  const same = JSON.stringify(a) === JSON.stringify(b)
  if (same) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`) }
}

const text = (id: string, html: string, x: number, y: number, extra: Partial<TextElement> = {}): TextElement =>
  ({ ...defaultText(), id, html, x, y, ...extra })
const slide = (...els: SlideElement[]): Slide => ({ ...emptySlide(), elements: els })
const ids = (els: TextElement[]) => els.map((e) => e.id)

{
  const p = outlineParts(slide(text('b', 'body', 80, 200, { role: 'body' }), text('t', 'Title', 80, 40, { role: 'title' })))
  eq([p.title?.id, ids(p.rest)], ['t', ['b']], 'role:title wins, body follows')
}
{
  const p = outlineParts(slide(text('lower', 'x', 80, 300), text('top', 'y', 80, 40)))
  eq([p.title?.id, ids(p.rest)], ['top', ['lower']], 'untagged slide: the topmost text is the heading')
}
{
  const p = outlineParts(slide(text('r', 'R', 700, 200, { role: 'body' }), text('l', 'L', 80, 200, { role: 'body' }), text('t', 'T', 80, 40, { role: 'title' })))
  eq(ids(p.rest), ['l', 'r'], 'two body boxes both show, left before right')
}
{
  const p = outlineParts(slide(
    text('t', 'T', 80, 40, { role: 'title' }),
    text('pg', '{{page}}', 1200, 680, { footerRole: 'slideNumber' }),
    text('chrome', 'logo', 10, 10),
    text('hid', 'secret', 80, 300, { hidden: true }),
  ), new Set(['chrome']))
  eq([p.title?.id, ids(p.rest)], ['t', []], 'footers, inherited chrome and hidden text stay out')
}
{
  const img = { id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10 } as unknown as SlideElement
  const svg = { id: 's', type: 'svg', x: 0, y: 0, w: 10, h: 10 } as unknown as SlideElement
  const tbl = { id: 'tb', type: 'table', x: 0, y: 0, w: 10, h: 10 } as unknown as SlideElement
  const p = outlineParts(slide(text('t', 'T', 0, 0, { role: 'title' }), img, svg, tbl))
  eq(p.other, { image: 2, table: 1 }, 'non-text content is counted (svg counts as a picture)')
}
eq(outlineParts(slide()).title, undefined, 'an empty slide has no title field')

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('outline model: all good')
