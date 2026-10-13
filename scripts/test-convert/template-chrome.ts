#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert template-chrome rig — what a corporate master (the
// a real corporate 2022 one) carries that PowerPoint never draws:
// showMasterSp on the part ROOT, cNvPr hidden="1" shapes and group members,
// pictures stacked exactly under an opaque one, and furniture text around
// a slide-number field — and which master's theme a template takes.
//
//   node scripts/test-convert/template-chrome.ts   (Node ≥ 23.6 strips types natively)
//
// Uses fxTemplateChrome (scripts/test-convert/_fixtures.ts #13) — see its
// comment for which shape is hidden, covered or kept.

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import { isOpaqueRaster } from '../../kernel/src/convert/media.ts'
import type { OutDoc, OutSlide, OutText } from '../../kernel/src/convert/types.ts'
import { fxTemplateChrome, fxThemeMajority, pngOf, JPEG_BYTES } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const byId = (d: OutDoc, id: string): OutSlide | undefined => d.layouts?.find((l) => l.id === id)
const elIds = (s: OutSlide | undefined): string => (s?.elements ?? []).map((e) => e.id).join(',')

const tplRes = await convertPptx(await fxTemplateChrome(), { mode: 'template' })
const deckRes = await convertPptx(await fxTemplateChrome())
const tpl = tplRes.doc
const deck = deckRes.doc

// ------------------------------------------------------------ opacity probe
ok(isOpaqueRaster(JPEG_BYTES), 'a JPEG is opaque')
ok(isOpaqueRaster(pngOf(2, 0)) && isOpaqueRaster(pngOf(0, 0)) && isOpaqueRaster(pngOf(3, 0)),
  'a grey / RGB / palette PNG without tRNS is opaque')
ok(!isOpaqueRaster(pngOf(6, 0)) && !isOpaqueRaster(pngOf(4, 0)), 'a PNG with an alpha channel is not')
ok(!isOpaqueRaster(pngOf(2, 0, true)) && !isOpaqueRaster(pngOf(3, 0, true)), 'a tRNS chunk makes any PNG not opaque')
ok(!isOpaqueRaster(new TextEncoder().encode('<svg/>')), 'anything else (svg markup) is not')

// ------------------------------------------------------------ showMasterSp on the root
{
  const k1 = byId(tpl, 'pptx-layout-1')
  ok(k1 !== undefined && k1.parentId === undefined,
    'p:sldLayout/@showMasterSp="0" detaches the layout into a root')
  ok(elIds(k1) === 'pl1-7,pl1-10',
    `…carrying no master decoration, one logo, its title prompt (got ${elIds(k1)})`)
  const k2 = byId(tpl, 'pptx-layout-2')
  ok(k2 !== undefined && k2.parentId === undefined, 'p:cSld/@showMasterSp="0" (legacy position) still detaches')
  ok(byId(tpl, 'pptx-layout-3')?.parentId === 'pptx-master-1', 'a layout that says nothing stays a child')
  const s1 = deck.slides[0]
  ok(s1.layoutId === 'pptx-layout-1' && !s1.elements.some((e) => e.id.startsWith('pm') || e.id.startsWith('mst')),
    `a slide on the hide-master layout shows none of the master's shapes (got ${elIds(s1)})`)
  ok(s1.elements.filter((e) => e.type === 'image').length === 1, 'the title slide shows its logo exactly once')
}

// ------------------------------------------------------------ hidden shapes
{
  const m1 = elIds(byId(tpl, 'pptx-master-1'))
  ok(m1 === 'pm1-3,pm1-31',
    `master: hidden pic, hidden group and hidden group member are skipped; the rest stays (got ${m1})`)
  ok(!elIds(byId(tpl, 'pptx-layout-1')).includes('pl1-13'), 'a hidden layout picture is skipped')
  const hidden = tplRes.report.entries.filter((e) => e.code === 'hidden-shape-skipped').map((e) => e.where).sort()
  ok(JSON.stringify(hidden) === JSON.stringify([
    'layout 1 / sp "Objekt 12"', 'master 1 / sp "Objekt 7"', 'master 1 / sp "Old Group"', 'master 1 / sp "R32"',
  ]), `each skip is reported, as carried (got ${hidden.join('; ')})`)
  ok(tplRes.report.entries.filter((e) => e.code === 'hidden-shape-skipped').every((e) => e.verdict === 'carried'),
    'hidden-shape-skipped is a carried verdict — PowerPoint does not draw them either')
  ok(!tplRes.report.entries.some((e) => e.code === 'graphic-dropped'), 'no placeholder box for a hidden OLE stand-in')
}

// ------------------------------------------------------------ covered pictures
{
  ok(!elIds(byId(tpl, 'pptx-layout-1')).includes('pl1-6'), 'the old logo exactly under an opaque logo is dropped')
  const k2 = elIds(byId(tpl, 'pptx-layout-2'))
  ok(k2 === 'pl2-6,pl2-7,pl2-8,pl2-10',
    `under an ALPHA logo the logo stays; a picture inside a later JPEG goes (got ${k2})`)
  const covered = tplRes.report.entries.filter((e) => e.code === 'covered-picture-dropped').map((e) => e.where).sort()
  ok(JSON.stringify(covered) === JSON.stringify(['layout 1 / pl1-6', 'layout 2 / pl2-9']),
    `each drop is reported (got ${covered.join('; ')})`)
  // the flattened slide's baked chrome makes the same drop — so it still
  // links: slide 1 above is linked to layout 1
  ok(deckRes.report.entries.some((e) => e.code === 'covered-picture-dropped' && e.where === 'slide 1 / ly1-6'),
    'a flattened candidate drops the same picture from its baked layout chrome')
}

// ------------------------------------------------------------ furniture text
{
  const k3 = byId(tpl, 'pptx-layout-3')
  const html = (id: string): string | undefined => (k3?.elements.find((e) => e.id === id) as OutText | undefined)?.html
  ok(html('pl3-40') === 'Page {{page}}', `sldNum keeps the literal text around its field (got ${html('pl3-40')})`)
  ok(html('pl3-41') === '{{date}}', `a dt with no field is still the date field (got ${html('pl3-41')})`)
  ok(html('pl3-42') === '© Acme', `ftr carries its text (got ${html('pl3-42')})`)
  const s2 = deck.slides[1]
  ok(s2.layoutId === 'pptx-layout-3' && s2.elements.filter((e) => e.type === 'image').length === 1,
    `a content slide shows the master logo once (got ${elIds(s2)})`)
}

// ------------------------------------------------------------ default slide type
ok(tpl.defaultLayoutId === 'pptx-layout-3', 'the obj layout is the default slide type')
{
  const noObj = (await convertPptx(await fxTemplateChrome({ noObj: true }), { mode: 'template' })).doc
  ok(noObj.defaultLayoutId === 'pptx-layout-1',
    `no obj layout: the first master's first layout, detached or not — not its first child k3 (got ${noObj.defaultLayoutId})`)
}

// ------------------------------------------------------------ document theme
{
  const t = (await convertPptx(await fxThemeMajority(), { mode: 'template' })).doc
  ok(t.theme.accent === '#AA3355' && t.theme.fontFamily === 'Verdana, sans-serif',
    `template: the theme of the master with the most layouts (got ${t.theme.accent} ${t.theme.fontFamily})`)
  const d = (await convertPptx(await fxThemeMajority())).doc
  ok(d.theme.accent === '#4472C4', `deck: still its first slide's theme (got ${d.theme.accent})`)
}

console.log(failures ? `\n${failures}/${checks} checks FAILED` : `\n${checks}/${checks} checks passed`)
if (failures) process.exit(1)
