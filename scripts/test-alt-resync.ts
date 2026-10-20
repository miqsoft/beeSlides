#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Alt text on a slide's copy of a slide-type element.
//
//   node scripts/test-alt-resync.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. The properties panel warns, under Alt text, that alt typed
// on a linked slide's copy of a slide-type element is reset at the next resync
// and has to be set on the slide type (`model.resyncOwner`). A hint that fires
// on the wrong elements is worse than none: it tells someone their description
// will vanish when it will not, or stays silent while it does. So the hint's
// predicate is checked against the REAL resync (`resyncLinkedSlides`): type an
// alt on every picture of a linked slide, resync, and the alts that came back
// different must be exactly the ones `resyncOwner` flags — and it must name
// the type in the chain that owns the element (a master for inherited chrome).

import {
  layoutElementIds, resyncLinkedSlides, resyncOwner,
  type SlidomingoDoc, type Slide, type SlideElement,
} from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1 }
const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
const img = (id: string, extra: Record<string, unknown> = {}): SlideElement =>
  ({ id, type: 'image', ...box, src: GIF, fit: 'cover', radius: 0, ...extra }) as SlideElement
const slideOf = (id: string, elements: SlideElement[], extra: Partial<Slide> = {}): Slide =>
  ({ id, background: '#ffffff', transition: 'none', elements, notes: '', ...extra }) as Slide

function build(): SlidomingoDoc {
  // master (logo) → child type (hero picture + an empty media placeholder)
  const master = slideOf('ly-master', [img('logo', { alt: 'Company logo' })], { name: 'Master' })
  const child = slideOf('ly-child', [
    img('hero', { alt: 'Type hero' }),
    { id: 'ph', type: 'shape', shape: 'rect', ...box, fill: 'transparent', stroke: '#888888', strokeWidth: 1, role: 'media' } as unknown as SlideElement,
  ], { name: 'Picture type', parentId: 'ly-master' })
  const linked = slideOf('s-linked', [
    img('logo', { alt: 'Company logo' }),
    img('hero', { alt: 'Type hero' }),
    img('ph', { role: 'media' }), // a picture that filled the media slot
    img('free'),                  // the author's own picture
  ], { layoutId: 'ly-child' })
  const loose = slideOf('s-loose', [img('hero')])           // same id, but not linked
  const dangling = slideOf('s-dangling', [img('hero')], { layoutId: 'ly-gone' })
  return {
    format: 'beeslides/slides', version: 1, title: 't', size: { width: 1280, height: 720 },
    theme: { background: '#ffffff', fontFamily: 'sans-serif', accent: '#0055ff' },
    slides: [linked, loose, dangling], layouts: [master, child], assets: {},
  } as unknown as SlidomingoDoc
}

const doc = build()
const linked = doc.slides[0]
const el = (s: Slide, id: string) => s.elements.find((e) => e.id === id)!

// 1. the predicate, case by case
ok(resyncOwner(doc, linked, el(linked, 'logo'))?.id === 'ly-master', 'inherited chrome → the hint names the MASTER that owns it')
ok(resyncOwner(doc, linked, el(linked, 'hero'))?.id === 'ly-child', 'the type’s own picture → the hint names the linked type')
ok(resyncOwner(doc, linked, el(linked, 'ph')) === undefined, 'a picture filling a media slot keeps its own alt → no hint')
ok(resyncOwner(doc, linked, el(linked, 'free')) === undefined, 'the author’s own picture → no hint')
ok(resyncOwner(doc, doc.slides[1], el(doc.slides[1], 'hero')) === undefined, 'an unlinked slide → no hint, even with a matching id')
ok(resyncOwner(doc, doc.slides[2], el(doc.slides[2], 'hero')) === undefined, 'a dangling layoutId → no hint')

// 2. the predicate agrees with what the real resync does to an alt
const before = new Map<string, boolean>()
for (const e of linked.elements) {
  before.set(e.id, !!resyncOwner(doc, linked, e))
  ;(e as { alt?: string }).alt = `typed on the slide (${e.id})`
}
resyncLinkedSlides(doc, 'ly-child', layoutElementIds(doc))
const after = doc.slides[0]
for (const [id, flagged] of before) {
  const now = (after.elements.find((e) => e.id === id) as { alt?: string } | undefined)?.alt
  const reset = now !== `typed on the slide (${id})`
  ok(reset === flagged, `${id}: resync ${reset ? 'resets' : 'keeps'} the slide’s alt, and the hint ${flagged ? 'says so' : 'stays quiet'}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
