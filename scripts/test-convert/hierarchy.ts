#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert master → layout tree rig — doc.layouts as a tree of
// slide types, deck-mode pruning vs template-mode completeness, detached
// layouts, and the default slide type.
//
//   node scripts/test-convert/hierarchy.ts       (Node ≥ 23.6 strips types natively)
//
// Uses fxMasters (scripts/test-convert/_fixtures.ts #11): two masters, seven
// layouts numbered by the package's own lists — see the fixture's comment for
// which layout is a child, which is detached and why, and which is unused.

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import type { OutDoc, OutImage, OutSlide } from '../../kernel/src/convert/types.ts'
import { effectiveLayout, type SlidomingoDoc, type Slide } from '../../slides/src/model.ts'
import { fxMasters } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const ids = (d: OutDoc): string => (d.layouts ?? []).map((l) => l.id).join(',')
const byId = (d: OutDoc, id: string): OutSlide | undefined => d.layouts?.find((l) => l.id === id)
const elIds = (s: OutSlide | undefined): string => (s?.elements ?? []).map((e) => e.id).join(',')

const deck = (await convertPptx(await fxMasters())).doc
const tpl = (await convertPptx(await fxMasters(), { mode: 'template' })).doc

// ------------------------------------------------------------ deck: pruned
ok(ids(deck) === 'pptx-master-1,pptx-layout-1,pptx-layout-2,pptx-layout-3,pptx-layout-4,pptx-master-2,pptx-layout-6',
  `deck: per master — the master, its used children in list order, then its detached roots; unused k5/k7 pruned (got ${ids(deck)})`)
ok(byId(deck, 'pptx-master-1')?.name === 'Brand Master' && byId(deck, 'pptx-master-2')?.name === 'Second Master',
  'master entries are named by their cSld/@name')

// ------------------------------------------------------------ children
for (const [id, parent] of [['pptx-layout-1', 'pptx-master-1'], ['pptx-layout-2', 'pptx-master-1'], ['pptx-layout-6', 'pptx-master-2']]) {
  const ly = byId(deck, id)
  ok(ly?.parentId === parent, `${id} is a child of ${parent}`)
  ok(ly !== undefined && !ly.elements.some((e) => e.id.startsWith('pm')),
    `${id} carries none of its master's elements — no merged logo (got ${elIds(ly)})`)
}
ok(elIds(byId(deck, 'pptx-master-1')) === 'pm1-3', 'master 1 paints its logo once')
ok(elIds(byId(deck, 'pptx-master-2')) === 'pm2-bg,pm2-5',
  'master 2 paints its picture background, then its decoration')
{
  // the model's own composite shows what a child really looks like
  const sd = deck as unknown as SlidomingoDoc
  const eff = effectiveLayout(sd, byId(deck, 'pptx-layout-6') as unknown as Slide)
  ok(eff.elements.map((e) => e.id).join(',') === 'pm2-bg,pm2-5,pl6-10,pl6-11',
    `effectiveLayout(k6) = the master's picture + band under k6's own prompts (got ${eff.elements.map((e) => e.id).join(',')})`)
  const m2 = byId(deck, 'pptx-master-2')!
  ok(m2.fontFamily === "Verdana, sans-serif" && m2.headingFamily === 'Georgia, sans-serif',
    "master 2 carries ITS theme's faces, not the first master's")
  const band = m2.elements.find((e) => e.id === 'pm2-5')
  ok(band !== undefined && band.type === 'shape' && band.fill === '#AA3355',
    "master 2's decoration resolves against master 2's theme (accent1 #AA3355)")
}

// ------------------------------------------------------------ detached roots
{
  const k3 = byId(deck, 'pptx-layout-3')
  ok(k3 !== undefined && k3.parentId === undefined && elIds(k3) === 'pl3-12',
    `showMasterSp="0" → a root with no master decoration (got ${elIds(k3)})`)
  const k4 = byId(deck, 'pptx-layout-4')
  ok(k4 !== undefined && k4.parentId === undefined && elIds(k4) === 'pl4-bg,pm1-3',
    `own picture bg → a root: the picture, the master's logo folded in ABOVE it (got ${elIds(k4)})`)
  const k7 = byId(tpl, 'pptx-layout-7')
  ok(k7 !== undefined && k7.parentId === undefined && k7.background === '#334455' && elIds(k7) === 'pm2-5,pl7-10',
    `own p:bg under a picture master → a root: own colour, master band folded in, no master picture (got ${k7?.background} ${elIds(k7)})`)
}

// ------------------------------------------------------------ template mode
ok(ids(tpl) === 'pptx-master-1,pptx-layout-1,pptx-layout-2,pptx-layout-5,pptx-layout-3,pptx-layout-4,pptx-master-2,pptx-layout-6,pptx-layout-7',
  `template: EVERY layout under every master, same order rules (got ${ids(tpl)})`)
ok(byId(tpl, 'pptx-layout-5')?.parentId === 'pptx-master-1', 'template: the unused k5 is kept, a child of master 1')
{
  // numbering is by the lists, not by use — every entry both modes emit is
  // the SAME entry, down to its element ids
  const same = (deck.layouts ?? []).every((l) => JSON.stringify(l) === JSON.stringify(byId(tpl, l.id)))
  ok(same, 'numbering is stable across modes: each deck entry equals its template twin exactly')
}
ok(tpl.slides.length === 1, `template: one starter slide (got ${tpl.slides.length})`)
{
  const s = tpl.slides[0]
  ok(s.layoutId === tpl.defaultLayoutId && s.layoutId === 'pptx-layout-1',
    'template: the starter slide is linked to the default layout')
  const td = tpl as unknown as SlidomingoDoc
  const eff = effectiveLayout(td, byId(tpl, 'pptx-layout-1') as unknown as Slide)
  ok(JSON.stringify(s.elements) === JSON.stringify(eff.elements),
    "template: the starter slide is a copy of its layout's composite, under the same ids")
}
{
  const used = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && v.startsWith('asset:')) used.add(v.slice(6))
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  }
  walk(tpl.layouts)
  walk(tpl.slides)
  ok(Object.keys(tpl.assets).every((k) => used.has(k)) && used.size === Object.keys(tpl.assets).length,
    'template: doc.assets holds exactly the media the layouts reference')
  const bgImg = byId(tpl, 'pptx-master-2')?.elements[0] as OutImage | undefined
  ok(bgImg !== undefined && bgImg.src.startsWith('asset:') && used.has(bgImg.src.slice(6)),
    "template: master 2's picture background is registered")
}

// ------------------------------------------------------------ default slide type
ok(deck.defaultLayoutId === 'pptx-layout-1', 'deck: defaultLayoutId is the obj layout under the first master')
{
  const noObj = (await convertPptx(await fxMasters({ noObj: true }))).doc
  ok(noObj.defaultLayoutId === 'pptx-layout-2',
    `deck, no obj layout: defaultLayoutId is the most-used layout, k2 (got ${noObj.defaultLayoutId})`)
  const noObjTpl = (await convertPptx(await fxMasters({ noObj: true }), { mode: 'template' })).doc
  ok(noObjTpl.defaultLayoutId === 'pptx-layout-1',
    `template, no obj layout: defaultLayoutId is the first master's first layout (got ${noObjTpl.defaultLayoutId})`)
}

// ------------------------------------------------------------ deck: linking
ok(deck.slides.map((s) => s.layoutId).join(',') === 'pptx-layout-1,pptx-layout-2,pptx-layout-3,pptx-layout-4,pptx-layout-6,pptx-layout-1',
  `deck: every plain slide links to its layout, detached roots included (got ${deck.slides.map((s) => s.layoutId).join(',')})`)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
