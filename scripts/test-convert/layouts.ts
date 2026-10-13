#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert layout-extraction rig — the master → layout tree, master
// decoration, showMasterSp, palette/headingFamily, and picture backgrounds.
//
//   node scripts/test-convert/layouts.ts       (Node ≥ 23.6 strips types natively)
//
// Uses fxLayouts (scripts/test-convert/_fixtures.ts #9) — one master (a title
// placeholder that decoration must SKIP, plus a logo) serving two layouts,
// three slides (two sharing one layout, to prove the layout cache dedups).
// Multi-master trees and template mode live in hierarchy.ts.

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import type { OutShape, OutText, OutImage } from '../../kernel/src/convert/types.ts'
import { fxLayouts } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const r = await convertPptx(await fxLayouts())
const d = r.doc

// ------------------------------------------------------------ doc.layouts
// the master becomes a root; layout 1 hangs under it, layout 2
// (showMasterSp="0") is detached into a root of its own. Slides 1 and 3
// share layout 1 — the layout cache dedups it.
ok(d.layouts !== undefined && d.layouts.length === 3,
  `master + 2 layouts extracted, layout 1 deduped via the layout cache (got ${d.layouts?.length})`)
ok(d.layouts?.map((l) => l.id).join(',') === 'pptx-master-1,pptx-layout-1,pptx-layout-2',
  `order: master, its child, then its detached root (got ${d.layouts?.map((l) => l.id).join(',')})`)
const [master, ly1, ly2] = d.layouts ?? []

ok(ly1.name === 'Custom Layout', 'layout 1 name comes from cSld/@name')
ok(ly2.name === 'Picture Background', 'layout 2 name comes from cSld/@name too')
ok(master.name === 'fixture', 'the master (no cSld/@name) is named after its theme')
ok(ly1.parentId === 'pptx-master-1', 'layout 1 is a child of its master')
ok(ly2.parentId === undefined, 'layout 2 (showMasterSp="0") is a detached root')
ok(master.parentId === undefined, 'the master is a root')
ok(d.defaultLayoutId === 'pptx-layout-1', 'defaultLayoutId: the obj layout under the first master')

// ---------------------------------------------------- the master: decoration
ok(master.elements.length === 1, `the master carries its logo only (got ${master.elements.length})`)
const logo = master.elements.find((e) => e.id === 'pm1-3') as OutImage | undefined
ok(logo !== undefined && logo.type === 'image', 'the master logo lives ONCE, on the master entry, id pm1-<cNvPr>')
ok(logo !== undefined && logo.x === 1152 && logo.y === 672 && logo.w === 48 && logo.h === 48,
  'logo frame: off 10972800,6400800 ext 457200,457200 → 1152,672,48,48')
ok(!master.elements.some((e) => e.id === 'pm1-1'),
  "the master's OWN title placeholder is decoration-skipped — the master gets no prompts")
ok(master.fontFamily === 'Calibri, Carlito, sans-serif' && master.headingFamily === "'Calibri Light', sans-serif",
  'the master slide type carries its theme faces (minor → fontFamily, major → headingFamily)')

// ---------------------------------------------------- layout 1: own shapes only
ok(ly1.elements.length === 3, `layout 1 carries title + body + rule, no master logo (got ${ly1.elements.length})`)
ok(!ly1.elements.some((e) => e.id.startsWith('pm') || e.id.startsWith('mst')),
  "layout 1 never copies the master's decoration — it inherits it through parentId")

const title1 = ly1.elements.find((e) => e.id === 'pl1-10') as OutText | undefined
ok(title1 !== undefined && title1.type === 'text' && title1.role === 'title' && title1.placeholder === 'Click to add title' && title1.html === '',
  'layout 1 title placeholder: role title, slidomingo prompt convention, empty html')
ok(title1 !== undefined && title1.x === 48 && title1.y === 28.83 && title1.w === 864 && title1.h === 120,
  'layout 1 title frame from its own xfrm (48, 28.83, 864, 120)')
ok(title1 !== undefined && title1.fontSize === 58.67,
  "layout 1 title size resolves through the master's titleStyle (sz 4400 = 44pt = 58.67px)")

const body1 = ly1.elements.find((e) => e.id === 'pl1-11') as OutText | undefined
ok(body1 !== undefined && body1.role === 'body' && body1.placeholder === 'Click to add text',
  'layout 1 body placeholder: role body, generic text prompt')
ok(body1 !== undefined && body1.fontSize === 24,
  "layout 1 body size resolves through the master's bodyStyle (sz 1800 = 18pt = 24px)")

const rule1 = ly1.elements.find((e) => e.id === 'pl1-12') as OutShape | undefined
ok(rule1 !== undefined && rule1.type === 'shape' && rule1.fill === '#F7A600' && rule1.role === undefined,
  'layout 1 decorative rule converts through the SAME shapeFrom as slides, no role')

// z-order: decoration first, then placeholders — the order a flattened
// slide paints its chrome in, with content on top
ok(ly1.elements.map((e) => e.id).join(',') === 'pl1-12,pl1-10,pl1-11',
  `z-order: layout decoration under the placeholders (got ${ly1.elements.map((e) => e.id).join(',')})`)

// -------------------------------------------------- layout 2: showMasterSp
ok(!ly2.elements.some((e) => e.id.startsWith('pm')),
  'showMasterSp="0" suppresses the master logo for layout 2 — nothing folded in')
ok(ly2.elements.length === 1, `layout 2 carries only its background image (got ${ly2.elements.length})`)
const bgImg2 = ly2.elements[0] as OutImage
ok(bgImg2.id === 'pl2-bg' && bgImg2.type === 'image' && bgImg2.x === 0 && bgImg2.y === 0
  && bgImg2.w === d.size.width && bgImg2.h === d.size.height && bgImg2.fit === 'cover',
  'layout 2 background resolves to a full-bleed image at the bottom of z-order')
ok(ly2.background === '#FFFFFF', 'layout 2 keeps a solid #FFFFFF fallback in `background` for readers that ignore images')

// ------------------------------------------------ slides: linked to the tree
ok(d.slides.map((s) => s.layoutId).join(',') === 'pptx-layout-1,pptx-layout-2,pptx-layout-1',
  `every slide links to its layout (got ${d.slides.map((s) => s.layoutId).join(',')})`)
ok(d.slides[0].elements.map((e) => e.id).join(',') === 'pm1-3,pl1-12,pl1-10,pl1-11,s1-20',
  `slide 1 carries the composite under the entries' own ids, its own text box on top (got ${d.slides[0].elements.map((e) => e.id).join(',')})`)

// slide 2 has no p:bg of its own, but its layout (2) does — the SAME picture
// resolution applies to a slide's own background, not just extracted layouts.
const slide2Bg = d.slides[1].elements[0] as OutImage
ok(slide2Bg !== undefined && slide2Bg.id === 'pl2-bg' && slide2Bg.type === 'image' && slide2Bg.fit === 'cover',
  "linked slide 2 carries layout 2's picture background as its first (bottom) element")
ok(d.slides[1].background === '#FFFFFF', 'slide 2 keeps the solid #FFFFFF fallback too')
{
  const flat = (await convertPptx(await fxLayouts(), { link: false })).doc
  const bg = flat.slides[1].elements[0] as OutImage
  ok(bg !== undefined && bg.id === 's2-bg' && bg.type === 'image' && bg.src === slide2Bg.src,
    'flattened ({link:false}) slide 2 bakes the same picture as its own s2-bg')
  ok(flat.slides.every((s) => s.layoutId === undefined), '{link:false} links nothing')
  ok(flat.layouts?.map((l) => l.id).join(',') === d.layouts?.map((l) => l.id).join(','),
    '{link:false} extracts the same tree')
}

const codes = new Set(r.report.entries.map((e) => e.code))
ok(codes.has('background-image-imported'),
  'the picture background is reported approximated (background-image-imported)')

// ---------------------------------------------------------- palette / fonts
// DEFAULT_THEME: dk1 #000000 lt1 #FFFFFF dk2 #28303A lt2 #E7E6E6 accent1
// #4472C4 accent2 #FBAE40 accent3 #808080 accent4 #FF0000 accent5 #70AD47
// accent6 #C00000 hlink #0563C1 folHlink #954F72; STANDARD_CLRMAP routes
// bg2→lt2, tx2→dk2. Major face "Calibri Light" (no metric substitute).
ok(d.theme.palette !== undefined, 'doc.theme.palette is populated')
ok(d.theme.palette?.bg2 === '#E7E6E6' && d.theme.palette?.tx2 === '#28303A',
  'palette bg2/tx2 resolve through the clrMap, mirroring theme.background/color')
ok(d.theme.palette?.accent2 === '#FBAE40' && d.theme.palette?.accent3 === '#808080'
  && d.theme.palette?.accent4 === '#FF0000' && d.theme.palette?.accent5 === '#70AD47'
  && d.theme.palette?.accent6 === '#C00000',
  'palette accent2-6 all populated from the scheme')
ok(d.theme.palette?.hlink === '#0563C1' && d.theme.palette?.folHlink === '#954F72',
  'palette hlink/folHlink populated')
ok(d.theme.headingFamily === "'Calibri Light', sans-serif",
  'headingFamily resolves the theme\'s major (heading) font — pptx.ts previously never read it')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
