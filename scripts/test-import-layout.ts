#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Import-onto-layout rig (slides/src/importlayout.ts) — runs without a DOM.
//
//   slides/node_modules/.bin/esbuild scripts/test-import-layout.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-import-layout.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node $TMPDIR/test-import-layout.mjs
//
// WHAT THIS PROVES. Reusing a layout must never change how an imported slide
// looks, so every case checks both directions: the same design is found
// across different ids and asset keys (the converter numbers per file), a
// different one is not; a slide that would render differently stays exactly
// as in the file; footer text written into a field keeps reading the same.
// Restyling ("Use a different layout…") is a deliberate change: it must keep
// every piece of content and drop only the file's chrome.

import {
  defaultShape, defaultText, emptySlide, newDoc, relinkSlide,
  type ImageElement, type Slide, type SlidomingoDoc, type TextElement,
} from '../slides/src/model.ts'
import { matchDesign, rebaseOnLayout, restyleOnLayout } from '../slides/src/importlayout.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const type = (id: string, name: string, parentId: string | undefined, elements: Slide['elements']): Slide => {
  const s = emptySlide()
  s.id = id
  s.name = name
  s.background = '#FFFFFF'
  if (parentId) s.parentId = parentId
  s.elements = elements
  return s
}
const logo = (id: string, key: string): ImageElement =>
  ({ id, type: 'image', x: 1100, y: 20, w: 120, h: 60, rotation: 0, opacity: 1, src: `asset:${key}`, fit: 'contain', radius: 0 } as ImageElement)
const bar = (id: string) => defaultShape('rect', { id, x: 0, y: 690, w: 1280, h: 30, fill: '#179C7D', stroke: 'none', strokeWidth: 0, radius: 0 })
const slot = (id: string, extra: Partial<TextElement> = {}) =>
  defaultText({ id, x: 50, y: 40, w: 1000, h: 80, html: '', role: 'title', placeholder: 'Click to add title', fontFamily: 'Georgia', fontSize: 40, ...extra })
const footer = (id: string, html: string, extra: Partial<TextElement> = {}) =>
  defaultText({ id, x: 240, y: 690, w: 300, h: 20, html, fontSize: 10, fontFamily: 'Georgia', ...extra })

/** A deck as the converter makes it: master + layout, slides linked. */
function fileDeck(titleFont = 'Georgia'): SlidomingoDoc {
  const doc = newDoc()
  doc.assets = { 'pptx-a1': PNG }
  doc.layouts = [
    type('pptx-master-1', 'Corporate', undefined, [bar('pm1-5'), logo('pm1-6', 'pptx-a1')]),
    type('pptx-layout-2', 'Title only', 'pptx-master-1', [slot('pl2-8', { fontFamily: titleFont }), footer('pl2-9', '© ACME Corp', { footerRole: 'footer' })]),
    type('pptx-layout-3', 'Section', 'pptx-master-1', [slot('pl3-4', { y: 300, fontFamily: titleFont })]),
  ]
  const s1 = emptySlide(); s1.id = 's1'
  s1.elements = [defaultText({ id: 's1-2', html: 'Hello', role: 'title' }), defaultShape('ellipse', { id: 's1-7', x: 600, y: 300 })]
  const s2 = emptySlide(); s2.id = 's2'
  s2.elements = [defaultText({ id: 's2-2', html: 'Part one', role: 'title' })]
  doc.slides = [s1, s2]
  relinkSlide(doc, 's1', 'pptx-layout-2')
  relinkSlide(doc, 's2', 'pptx-layout-3')
  return doc
}

/** The user's layout made from the same template: other ids, other asset
 *  key, the footer turned into a field — and maybe trimmed. */
function userLayout(opts: { trimmed?: boolean; logoData?: string } = {}): SlidomingoDoc {
  const doc = newDoc()
  doc.template = true
  doc.templateId = 'tmpl-acme'
  doc.assets = { 'logo-x': opts.logoData ?? PNG }
  doc.layouts = [
    type('pptx-master-2', 'Corporate', undefined, [bar('pm2-5'), logo('pm2-6', 'logo-x')]),
    type('pptx-layout-9', 'Title only', 'pptx-master-2', [slot('pl9-8'), footer('pl9-9', '{{footer}}', { footerRole: 'footer' })]),
    ...(opts.trimmed ? [] : [type('pptx-layout-11', 'Section', 'pptx-master-2', [slot('pl11-4', { y: 300 })])]),
    type('pptx-layout-12', 'Two content', 'pptx-master-2', [slot('pl12-1'), slot('pl12-2', { role: 'body', y: 200, h: 400 })]),
  ]
  doc.defaultLayoutId = 'pptx-layout-9'
  doc.slides = [emptySlide()]
  return doc
}

const sigs = (d: SlidomingoDoc, s: Slide) => s.elements.map((e) => {
  const { id: _i, role: _r, placeholder: _p, footerRole: _f, ...rest } = e as TextElement
  const src = (rest as { src?: string }).src
  return JSON.stringify({ ...rest, ...(src ? { src: d.assets?.[src.slice(6)] ?? src } : {}) })
})

console.log('match')
{
  const deck = fileDeck()
  const m = matchDesign(deck, userLayout())
  ok(!!m && m.roots === 1, 'the same master is found across different ids and asset keys')
  ok(m?.types.get('pptx-master-1') === 'pptx-master-2' && m?.types.get('pptx-layout-2') === 'pptx-layout-9' && m?.types.get('pptx-layout-3') === 'pptx-layout-11',
    '…and its layouts, by content')
  ok(m?.elements.get('pm1-6') === 'pm2-6' && m?.elements.get('pl2-8') === 'pl9-8', 'elements pair up one by one')
  ok(m?.bindings.footer === '© ACME Corp', 'the file’s literal footer is read into the layout’s {{footer}} field')
  ok(matchDesign(deck, userLayout({ logoData: PNG.replace('ggg', 'gga') })) === null, 'a different logo picture is a different design')
  const big = userLayout(); big.size = { width: 1024, height: 768 }
  ok(matchDesign(deck, big) === null, 'a different slide size never matches')
}

console.log('rebase')
{
  const deck = fileDeck()
  const before = structuredClone(deck)
  const layout = userLayout()
  const r = rebaseOnLayout(deck, layout, matchDesign(deck, layout)!, 'ACME')
  ok(r.linked === 2 && r.keptFromFile === 0 && !r.extraTypes.length, 'both slides follow the layout’s slide types')
  ok(deck.slides[0].layoutId === 'pptx-layout-9' && deck.slides[1].layoutId === 'pptx-layout-11', '…the matching ones')
  ok(deck.slides[0].elements.find((e) => e.id === 'pl9-8')?.type === 'text' && (deck.slides[0].elements.find((e) => e.id === 'pl9-8') as TextElement).html === 'Hello',
    'the title sits in the layout’s own slot')
  ok(deck.slides[0].elements.some((e) => e.id === 's1-7'), 'the slide’s own shape stays')
  ok(deck.headerFooter?.footer?.text === '© ACME Corp', 'the footer field says what the file said')
  ok(deck.basedOn?.templateId === 'tmpl-acme' && deck.basedOn.name === 'ACME', 'the deck is based on the layout now')
  ok(deck.layouts?.some((l) => l.id === 'pptx-layout-12') === true && !deck.layouts.some((l) => l.id === 'pptx-layout-2'),
    'the layout’s full set of slide types replaces the file’s copies')
  ok(deck.defaultLayoutId === 'pptx-layout-9', 'the layout’s default slide type')
  const fieldFree = (d: SlidomingoDoc, s: Slide) => sigs(d, s).map((x) => x.replace('{{footer}}', d.headerFooter?.footer?.text ?? ''))
  ok(JSON.stringify(fieldFree(deck, deck.slides[0])) === JSON.stringify(fieldFree(before, before.slides[0])), 'slide 1 looks exactly as before (footer through the field)')
}
{
  const deck = fileDeck('Calibri')
  const before = structuredClone(deck)
  const layout = userLayout()
  const m = matchDesign(deck, layout)!
  ok(!!m, 'an empty slot’s prompt styling does not decide the design')
  const r = rebaseOnLayout(deck, layout, m, 'ACME')
  ok(r.linked === 0 && r.keptFromFile === 2, 'but a slide whose title would change font is kept as in the file')
  ok(/fontFamily/.test(r.why.s1 ?? ''), '…with the reason')
  ok(!deck.slides[0].layoutId && JSON.stringify(sigs(deck, deck.slides[0])) === JSON.stringify(sigs(before, before.slides[0])), '…unlinked, looking exactly as before')
  ok(deck.slides[0].elements.every((e) => !layout.layouts!.some((l) => l.elements.some((x) => x.id === e.id))),
    '…its ids out of the layout’s id space')
}
{
  const deck = fileDeck()
  const layout = userLayout({ trimmed: true })
  const r = rebaseOnLayout(deck, layout, matchDesign(deck, layout)!, 'ACME')
  ok(r.linked === 2 && r.extraTypes.join() === 'Section', 'a type the trimmed layout lacks is kept from the file')
  const extra = deck.layouts!.find((l) => l.name === 'Section' && l.id.endsWith('-file'))
  ok(extra?.parentId === 'pptx-master-2', '…under the layout’s matching master')
  ok(deck.slides[1].layoutId === extra?.id && deck.slides[1].elements.some((e) => e.id === 'pm2-6'), '…and its slide follows it with the layout’s master')
}

console.log('restyle')
{
  const deck = fileDeck()
  // an unlinked slide as the converter flattens it: baked chrome + own title
  const s3 = emptySlide(); s3.id = 's3'
  s3.elements = [bar('mst3-5'), footer('s3-6', 'Page {{page}}', { footerRole: 'slideNumber' }), defaultText({ id: 's3-2', html: 'Loose', role: 'title' }), defaultShape('rect', { id: 's3-9', x: 300, y: 300 }), defaultText({ id: 's3-10', html: '- Intern -' })]
  deck.slides.push(s3)
  const other = userLayout()
  other.layouts![0].elements = [defaultShape('rect', { id: 'pm2-5', x: 0, y: 0, w: 1280, h: 20, fill: '#A00' })] // another look
  const r = restyleOnLayout(deck, other, 'Other')
  ok(r.fit === 3 && r.partial === 0, 'every slide finds a slide type its content fits')
  ok(deck.slides.every((s) => s.layoutId && other.layouts!.some((l) => l.id === s.layoutId)), 'every slide follows one of the new layout’s types')
  ok(!deck.slides[2].elements.some((e) => e.id === 'mst3-5' || e.id === 's3-6'), 'the file’s baked chrome and footer are gone')
  ok(deck.slides[2].elements.some((e) => e.id === 's3-9') && deck.slides[2].elements.some((e) => e.type === 'text' && e.html === 'Loose'), 'the slide’s own content stays')
  ok(deck.slides[0].elements.some((e) => e.type === 'text' && e.html === 'Hello'), 'a linked slide’s title comes along too')
  ok(deck.basedOn?.name === 'Other', 'the deck is based on the chosen layout')
  ok(deck.headerFooter?.footer?.text === '© ACME Corp', 'what the file’s footer said is carried into the new layout’s {{footer}} field (not just any text)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
