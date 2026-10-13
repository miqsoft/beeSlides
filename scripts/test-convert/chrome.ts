#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert master/layout chrome rig — master decoration, layout
// decoration and furniture placeholders reaching a slide: through its layout
// link (slides 1 and 2) or baked directly onto a flattened slide's own
// `elements` (slide 3, and every slide under { link: false }).
//
//   node scripts/test-convert/chrome.ts       (Node ≥ 23.6 strips types natively)
//
// Uses fxChrome (scripts/test-convert/_fixtures.ts #10): a master footer bar
// (decoration) plus a layout carrying a title PROMPT (must never leak onto a
// real slide) and ftr/dt/sldNum furniture, with `<p:hf sldNum="0"/>` hiding
// the slide number everywhere. Three slides probe the three ways a slide can
// deviate from painting the full template onto itself — see the fixture's
// own comment for the exact scenarios.

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import type { ConvertResult, OutShape, OutText } from '../../kernel/src/convert/types.ts'
import { fxChrome } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const r: ConvertResult = await convertPptx(await fxChrome())
const d = r.doc
// the same package flattened — the chrome-baking path every UNLINKED slide takes
const flat = (await convertPptx(await fxChrome(), { link: false })).doc

// ------------------------------------------------------------- the tree
// the master's footer bar lives once, on the master entry; the layout holds
// only its own shapes — decoration, then furniture, then content prompts —
// and follows p:hf like a slide does, so the hidden sldNum is not there.
ok(d.layouts?.map((l) => l.id).join(',') === 'pptx-master-1,pptx-layout-1', 'chrome: one master + its one layout')
const [mst, ly] = d.layouts ?? []
ok(mst !== undefined && mst.elements.map((e) => e.id).join(',') === 'pm1-40',
  `the master entry carries its footer bar (got ${mst?.elements.map((e) => e.id).join(',')})`)
ok(ly !== undefined && ly.parentId === 'pptx-master-1', 'the layout is a child of the master')
ok(ly !== undefined && ly.elements.map((e) => e.id).join(',') === 'pl1-50,pl1-61,pl1-62,pl1-60',
  `layout: watermark, ftr, dt, then the title prompt; sldNum hidden by p:hf (got ${ly?.elements.map((e) => e.id).join(',')})`)

// ------------------------------------------------------------- slide 1: Plain
const s1 = d.slides[0]
ok(s1.layoutId === 'pptx-layout-1', 'slide 1 does not deviate — linked')
ok(s1.elements.map((e) => e.id).join(',') === 'pm1-40,pl1-50,pl1-61,pl1-62,pl1-60,s1-70',
  `slide 1: the composite under the entries' ids, then its own content (got ${s1.elements.map((e) => e.id).join(',')})`)
const prompt1 = s1.elements.find((e) => e.id === 'pl1-60') as OutText | undefined
ok(prompt1 !== undefined && prompt1.html === '' && prompt1.placeholder === 'Click to add title',
  'slide 1: the unused title slot rides along EMPTY (a prompt the editor dims and presenting hides)')
const f1 = flat.slides[0]
ok(f1.elements.map((e) => e.id).join(',') === 'mst1-40,ly1-50,ly1-61,ly1-62,s1-70',
  `flattened slide 1: master decoration + layout decoration + ftr + dt (sldNum hidden), THEN the slide's own content (got ${f1.elements.map((e) => e.id).join(',')})`)
ok(!f1.elements.some((e) => e.id === 'ly1-60'),
  "flattened slide 1: NEGATIVE — the layout's title PROMPT never bakes onto a flattened slide")
ok(!f1.elements.some((e) => e.id === 'ly1-63'),
  'flattened slide 1: NEGATIVE — sldNum stays absent, p:hf sldNum="0" respected')
const ftr1 = f1.elements.find((e) => e.id === 'ly1-61') as OutText | undefined
ok(ftr1 !== undefined && ftr1.type === 'text' && ftr1.html === 'Acme Corp',
  "flattened slide 1: the baked footer carries the layout's own authored text")
const dt1 = f1.elements.find((e) => e.id === 'ly1-62') as OutText | undefined
ok(dt1 !== undefined && dt1.html === '{{date}}', 'flattened slide 1: the baked date field is the dynamic {{date}} token')
const mstRule1 = f1.elements.find((e) => e.id === 'mst1-40') as OutShape | undefined
ok(mstRule1 !== undefined && mstRule1.fill === '#203040' && mstRule1.x === 0 && mstRule1.y === 672
  && mstRule1.w === 1280 && mstRule1.h === 24,
  'flattened slide 1: the master footer bar bakes at its own frame and fill')

// -------------------------------------------------------- slide 2: OwnFooter
const s2 = d.slides[1]
ok(s2.layoutId === 'pptx-layout-1', 'slide 2: its own footer fills the ftr slot — linked')
ok(s2.elements.map((e) => e.id).join(',') === 'pm1-40,pl1-50,pl1-61,pl1-62,pl1-60',
  `slide 2: the footer lands IN the layout's ftr slot, nothing left over (got ${s2.elements.map((e) => e.id).join(',')})`)
const slotFtr = s2.elements.find((e) => e.id === 'pl1-61') as OutText | undefined
ok(slotFtr !== undefined && slotFtr.html === 'Custom Footer', "slide 2: the slot carries the slide's own footer text")
const f2 = flat.slides[1]
ok(f2.elements.map((e) => e.id).join(',') === 'mst2-40,ly2-50,ly2-62,s2-71',
  `flattened slide 2: the layout's ftr (idx 10) is NOT underlaid — the slide already has an idx=10 placeholder itself (got ${f2.elements.map((e) => e.id).join(',')})`)
const ownFtr = f2.elements.find((e) => e.id === 's2-71') as OutText | undefined
ok(ownFtr !== undefined && ownFtr.html === 'Custom Footer',
  "flattened slide 2: the slide's OWN footer placeholder survives as its own real content, not as underlay")

// ------------------------------------------------------ slide 3: NoMasterSp
const s3 = d.slides[2]
ok(s3.layoutId === undefined, 'slide 3 hides the master its layout shows — stays unlinked')
ok(s3.elements.map((e) => e.id).join(',') === 'ly3-50,ly3-61,ly3-62,s3-72',
  `slide 3: p:sld/@showMasterSp="0" on the SLIDE ITSELF suppresses the master footer bar, but layout decoration and furniture are unaffected (got ${s3.elements.map((e) => e.id).join(',')})`)
ok(!s3.elements.some((e) => e.id.startsWith('mst3-')),
  "slide 3: NEGATIVE — the master's footer bar is absent when the slide's own cSld suppresses it")
{
  const un = r.report.entries.filter((e) => e.code === 'slide-unlinked')
  ok(un.length === 1 && un[0].where === 'slide 3' && un[0].detail.startsWith('hides-master:'),
    `slide 3 alone is reported unlinked, reason hides-master (got ${un.map((e) => `${e.where} ${e.detail.split(':')[0]}`).join('; ')})`)
}

// font-substituted (Calibri) + text-needs-refit — the same two codes
// fxPlaceholder's bare, autofit-less placeholder text draws — plus slide 3's
// slide-unlinked; nothing is dropped.
{
  const got = [...new Set(r.report.entries.map((e) => e.code))].sort()
  const want = ['font-substituted', 'slide-unlinked', 'text-needs-refit']
  ok(got.length === want.length && got.every((c, i) => c === want[i]),
    `chrome: report codes are exactly [${want.join(', ')}] (got [${got.join(', ')}])`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
