#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert slide-linking rig — which slides link to their layout,
// why the rest stay flattened, and the two properties that make linking safe:
//
//   node scripts/test-convert/linking.ts       (Node ≥ 23.6 strips types natively)
//
//   • NO-OP RESYNC. The editor's resync (model.ts applyLayout over the
//     layout's effectiveLayout) must reproduce every linked slide EXACTLY —
//     otherwise the first master edit would change slides nobody touched.
//     This runs the REAL model functions, imported from slides/src/model.ts.
//   • ORACLE. A linked slide must present exactly like the same slide
//     flattened ({ link: false }): same visible elements, same background.
//     Compared id-free here (a signature multiset), independently of the
//     converter's own id translation; an UNLINKED slide must equal its
//     flattened twin byte for byte.
//
// Uses fxLinking (scripts/test-convert/_fixtures.ts #12, one slide per case)
// and, for the two properties, every multi-slide fixture.

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import type { OutDoc, OutElement, OutImage, OutText } from '../../kernel/src/convert/types.ts'
import {
  applyLayout, effectiveLayout, layoutElementIds, type SlidomingoDoc, type Slide,
} from '../../slides/src/model.ts'
import { fxLinking, fxMasters, fxChrome, fxLayouts, LINKING_CASES } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const r = await convertPptx(await fxLinking())
const d = r.doc
const slideAt = (n: number) => d.slides[n - 1]
const reasonOf = (n: number): string | undefined =>
  r.report.entries.find((e) => e.code === 'slide-unlinked' && e.where === `slide ${n}`)?.detail.split(':')[0]

// ------------------------------------------------------------ per case
const EXPECT: Record<keyof typeof LINKING_CASES, { layoutId?: string; reason?: string }> = {
  clean: { layoutId: 'pptx-layout-1' },
  titleMoved: { reason: 'placeholder-moved' },
  runSize: { reason: 'placeholder-restyled' },
  clrMapOvr: { reason: 'color-map-override' },
  ownBg: { reason: 'own-background' },
  picOverTitle: { reason: 'z-order' },
  picSlotFilled: { layoutId: 'pptx-layout-2' },
  picSlotEmpty: { reason: 'empty-media-placeholder' },
  ownSldNum: { layoutId: 'pptx-layout-1' },
}
for (const [name, n] of Object.entries(LINKING_CASES) as Array<[keyof typeof LINKING_CASES, number]>) {
  const want = EXPECT[name]
  const s = slideAt(n)
  if (want.layoutId) {
    ok(s.layoutId === want.layoutId && reasonOf(n) === undefined,
      `${name} (slide ${n}): linked to ${want.layoutId} (got ${s.layoutId ?? `unlinked: ${reasonOf(n)}`})`)
  } else {
    ok(s.layoutId === undefined && reasonOf(n) === want.reason,
      `${name} (slide ${n}): stays flattened, reported ${want.reason} (got ${s.layoutId ? `linked ${s.layoutId}` : reasonOf(n)})`)
  }
}
ok(r.report.entries.filter((e) => e.code === 'slide-unlinked').length === 6,
  'exactly the six deviating slides are reported slide-unlinked')

// ------------------------------------------------------------ linked content
{
  const s = slideAt(LINKING_CASES.clean)
  ok(s.elements.map((e) => e.id).join(',') === 'pm1-3,pl1-12,pl1-10,pl1-11',
    `clean: the composite under the entries' own ids, nothing left over (got ${s.elements.map((e) => e.id).join(',')})`)
  const title = s.elements.find((e) => e.id === 'pl1-10') as OutText
  ok(title.role === 'title' && title.html === 'Clean', 'clean: the title text lands in the title slot, role kept')
  const body = s.elements.find((e) => e.id === 'pl1-11') as OutText
  ok(body.role === 'body' && body.html === '<ul><li>First point</li><li>Second <b>bold</b> point</li></ul>',
    `clean: the bullets arrive as a REAL list, inline <b> intact, in the body slot's html (got ${body.html})`)
  const num = s.elements.find((e) => e.id === 'pl1-12') as OutText
  ok(num.html === '{{page}}', "clean: the layout's slide number rides along as a slot")
}
{
  const s = slideAt(LINKING_CASES.picSlotFilled)
  const img = s.elements.find((e) => e.id === 'pl2-21') as OutImage | undefined
  ok(img !== undefined && img.type === 'image' && img.role === 'media' && img.src.startsWith('asset:'),
    'picture slot: the image is ADOPTED into the media slot — slot id and role, the image\'s own content')
  ok(img !== undefined && img.x === 672 && img.y === 168 && img.w === 480 && img.h === 480,
    "picture slot: at the slot's frame (off 6400800,1600200 ext 4572000² → 672,168,480,480)")
  ok(s.elements.map((e) => e.id).join(',') === 'pm1-3,pl2-20,pl2-21,pl2-22', 'picture slot: nothing left over')
}
{
  const s = slideAt(LINKING_CASES.ownSldNum)
  ok(s.elements.map((e) => e.id).join(',') === 'pm1-3,pl1-12,pl1-10,pl1-11',
    "own sldNum: the slide's own slide number fills the layout's sldNum slot instead of doubling it")
}
{
  const s = slideAt(LINKING_CASES.titleMoved)
  ok(s.elements.map((e) => e.id).join(',') === 'mst2-3,ly2-12,s2-2,s2-4',
    'an unlinked slide keeps the flattened ids: mst<n>/ly<n> chrome, then s<n> content')
  ok(s.elements.map((e) => e.morphId ?? '-').join(',') === 'pm1-3,pl1-12,-,-',
    `…but its chrome morphs as the linked ids (morphId pm1-3/pl1-12), its content as itself (got ${s.elements.map((e) => e.morphId ?? '-').join(',')})`)
}
{
  // own background: the slide's picture is its own, not the chain's
  const s = slideAt(LINKING_CASES.ownBg)
  ok(!s.elements.some((e) => e.id.endsWith('-bg') && e.morphId),
    'own background: a slide\'s OWN picture background gets no morphId')
}
// the linked slide's chrome and the unlinked slide's chrome pair up in Morph
{
  const key = (e: OutElement) => e.morphId ?? e.id
  const a = new Set(slideAt(LINKING_CASES.clean).elements.map(key))
  const b = slideAt(LINKING_CASES.titleMoved).elements.map(key)
  ok(a.has('pm1-3') && b.includes('pm1-3') && b.includes('pl1-12'),
    'linked → unlinked: master and layout chrome share morph keys across the pair')
  for (const s of d.slides) {
    const keys = s.elements.map(key)
    if (new Set(keys).size !== keys.length) ok(false, `${s.id}: morph keys are unique on the slide`)
  }
}

// ------------------------------------------------------------ the two properties
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v
const signature = (e: OutElement): string => {
  const rest: Record<string, unknown> = { ...e }
  delete rest.id; delete rest.groupId; delete rest.role; delete rest.placeholder; delete rest.morphId
  delete rest.from; delete rest.to; delete rest.locked // editor click-through only, not presentation
  delete rest.footerRole // a tag for doc.headerFooter, which an import never sets
  return JSON.stringify(canon(rest))
}
const visible = (els: OutElement[]): OutElement[] =>
  els.filter((e) => !(e.type === 'text' && e.placeholder !== undefined && !e.html.trim()))

const FIXTURES: Array<[string, () => Promise<Uint8Array>]> = [
  ['linking', fxLinking], ['masters', () => fxMasters()], ['chrome', fxChrome], ['layouts', fxLayouts],
]
for (const [name, build] of FIXTURES) {
  const linked: OutDoc = (await convertPptx(await build())).doc
  const flat: OutDoc = (await convertPptx(await build(), { link: false })).doc
  const sd = linked as unknown as SlidomingoDoc
  const known = layoutElementIds(sd)
  let resyncOk = 0, oracleOk = 0, flatOk = 0, nLinked = 0, nFlat = 0
  linked.slides.forEach((s, i) => {
    const f = flat.slides[i]
    if (!s.layoutId) {
      nFlat++
      if (JSON.stringify(s) === JSON.stringify(f)) flatOk++
      else console.log(`        ${name} slide ${i + 1}: unlinked output differs from { link: false }`)
      return
    }
    nLinked++
    const layout = sd.layouts!.find((l) => l.id === s.layoutId)!
    const eff = effectiveLayout(sd, layout)
    const again = applyLayout(s as unknown as Slide, eff, known)
    if (JSON.stringify(again) === JSON.stringify(s.elements) && eff.background === s.background) resyncOk++
    else console.log(`        ${name} slide ${i + 1}: resync changed it`)
    const a = visible(s.elements).map(signature).sort()
    const b = f.elements.map(signature).sort()
    if (JSON.stringify(a) === JSON.stringify(b) && s.background === f.background) oracleOk++
    else console.log(`        ${name} slide ${i + 1}: presents differently from its flattened twin`)
  })
  ok(nLinked > 0 && resyncOk === nLinked, `${name}: resync is a no-op on every linked slide (${resyncOk}/${nLinked})`)
  ok(oracleOk === nLinked, `${name}: every linked slide presents like its { link: false } twin (${oracleOk}/${nLinked})`)
  ok(flatOk === nFlat, `${name}: every unlinked slide IS its { link: false } twin (${flatOk}/${nFlat})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
