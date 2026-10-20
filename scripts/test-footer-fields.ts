#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Masters, inherited chrome, Header & footer and live fields (docs/DECISIONS.md
// 2026-09-30, "Templates behave like PowerPoint"). Bundled, not run directly —
// render.ts imports './model' extensionless (same as scripts/test-doc-cleanup.ts):
//
//   slides/node_modules/.bin/esbuild scripts/test-footer-fields.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-footer-fields.mjs" \
//     && node "$TMPDIR/test-footer-fields.mjs"
//
// WHAT THIS PROVES.
// - Inherited chrome follows its master: a master's text edit reaches slides
//   that already exist, and a master text that is deleted leaves them — even
//   though both are text, which `applyLayout` otherwise never drops. A type's
//   OWN text (the Comparison's "Option A") keeps what the slide wrote, and so
//   do content slots a master carries (a title placeholder).
// - `doc.headerFooter` and `slide.footer` decide which footer pieces show, a
//   resync never touches `slide.footer`, and `hideOnTitle` only hits title
//   slides.
// - {{footer}}, {{prop:Name}} and a fixed {{date}} resolve; marker mode wraps
//   values (a slide) or shows names (a slide type), and escapes both.
// - A `parentOnly` master is never the default type nor a pickable one.
// - The validator knows every key this adds (and those it used to flag wrongly).

import {
  applyLayout, ancestorElementIds, builtinLayouts, defaultSlideType, effectiveLayout, footerHidden, instantiateLayout,
  isTitleSlideType, layoutElementIds, pickableSlideTypes, relinkPreview, relinkSlide, resyncLinkedSlides, starterSlide,
  type SlidomingoDoc, type Slide, type SlideElement, type TextElement,
} from '../slides/src/model.ts'
import { fieldContext, resolveFields } from '../slides/src/render.ts'
import { validateDoc } from '../slides/src/validate.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const base = { rotation: 0, opacity: 1 }
const text = (id: string, html: string, extra: Partial<TextElement> = {}): TextElement => ({
  ...base, id, type: 'text', x: 0, y: 0, w: 400, h: 40, html, fontSize: 14, fontFamily: '', fontWeight: 400,
  color: '#000', align: 'left', valign: 'top', lineHeight: 1.2, ...extra,
})
const rect = (id: string): SlideElement => ({ ...base, id, type: 'shape', shape: 'rect', x: 0, y: 700, w: 1280, h: 2, fill: '#999', stroke: 'transparent', strokeWidth: 0, radius: 0 } as SlideElement)
const layout = (id: string, elements: SlideElement[], extra: Partial<Slide> = {}): Slide =>
  ({ id, name: id, background: '#fff', transition: 'none', notes: '', elements, ...extra })
const htmlOf = (s: Slide, id: string) => (s.elements.find((e) => e.id === id) as TextElement | undefined)?.html

function fixture(): SlidomingoDoc {
  const master = layout('M', [
    rect('m-rule'),
    text('m-copy', '© Old Corp', { footerRole: 'footer' }),
    text('m-class', '- Internal -'),
    text('m-page', 'Page {{page}}', { footerRole: 'slideNumber' }),
    text('m-date', '{{date}}', { footerRole: 'date' }),
    // a content slot on the master itself: its text is the slide's
    text('m-title', '', { role: 'title', placeholder: 'Click to add title' }),
  ], { parentOnly: true })
  const content = layout('C', [text('c-body', '', { role: 'body', placeholder: 'Text' })], { parentId: 'M' })
  const cmp = builtinLayouts().find((l) => l.id === 'layout-comparison')!
  const comparison = { ...clone(cmp), id: 'CMP', parentId: 'M' }
  const title = layout('T', [
    text('t-title', '', { role: 'title', placeholder: 'Title' }),
    text('t-sub', '', { role: 'subtitle', placeholder: 'Subtitle' }),
  ], { parentId: 'M' })
  const doc: SlidomingoDoc = {
    format: 'beeslides/slides', version: 1, docId: 'd', title: 'Deck', modified: '',
    size: { width: 1280, height: 720 }, theme: { background: '#fff', color: '#000', accent: '#f60', fontFamily: 'system-ui' },
    layouts: [master, content, comparison, title], slides: [],
  }
  // three linked slides, the way the editor makes them (starterSlide), then edited
  const s1 = starterSlide(doc, 'C'); (s1.elements.find((e) => e.id === 'm-title') as TextElement).html = 'Results'
  ;(s1.elements.find((e) => e.id === 'c-body') as TextElement).html = 'Numbers went up'
  const s2 = starterSlide(doc, 'CMP'); (s2.elements.find((e) => e.id === 'lcmp-label-a') as TextElement).html = 'Plan A (mine)'
  const s3 = starterSlide(doc, 'T')
  doc.slides = [s1, s2, s3]
  return doc
}

// ---- 1 · inherited chrome follows its master ---------------------------------
console.log('\ninherited chrome follows its master')
{
  const doc = fixture()
  const [s1, s2] = doc.slides
  ok(htmlOf(s1, 'm-copy') === '© Old Corp', 'a new slide carries the master footer text')
  ok(ancestorElementIds(doc, doc.layouts![1]).has('m-copy'), 'the master footer is locked on the child type')

  // edit the master's text, as the Layout Manager does, then the editor's resync
  const known = layoutElementIds(doc)
  ;(doc.layouts![0].elements.find((e) => e.id === 'm-class') as TextElement).html = '- Confidential -'
  resyncLinkedSlides(doc, 'M', known)
  ok(htmlOf(s1, 'm-class') === '- Confidential -', 'a master text edit reaches a slide that already existed')
  ok(htmlOf(s2, 'm-class') === '- Confidential -', '… on every child type (Comparison too)')
  ok(htmlOf(s1, 'm-title') === 'Results', 'a master CONTENT slot (role/placeholder) keeps the slide’s own text')
  ok(htmlOf(s1, 'c-body') === 'Numbers went up', 'the child type’s body keeps the slide’s text')
  ok(htmlOf(s2, 'lcmp-label-a') === 'Plan A (mine)', 'the Comparison’s own "Option A" keeps the slide’s edit (not inherited)')

  // a stale copy on a slide (from before this fix) is healed by any resync
  ;(s1.elements.find((e) => e.id === 'm-copy') as TextElement).html = '© Frozen copy'
  resyncLinkedSlides(doc, 'C', layoutElementIds(doc))
  ok(htmlOf(s1, 'm-copy') === '© Old Corp', 'a frozen footer copy on a slide takes the master’s text on the next resync')

  // delete the classification text from the master: the editor passes the
  // surface's pre-edit ids as known AND the deleted ones as retired
  const before = new Set(doc.layouts![0].elements.map((e) => e.id))
  doc.layouts![0].elements = doc.layouts![0].elements.filter((e) => e.id !== 'm-class')
  const known2 = layoutElementIds(doc); for (const id of before) known2.add(id)
  const without = clone(doc)
  resyncLinkedSlides(without, 'M', known2)
  ok(!!htmlOf(without.slides[0], 'm-class'), 'without retired ids a deleted master TEXT would survive (the old zombie)')
  resyncLinkedSlides(doc, 'M', known2, new Set(['m-class']))
  ok(!htmlOf(s1, 'm-class') && !htmlOf(s2, 'm-class'), 'a deleted master text disappears from every slide')

  // retired ids of the type ITSELF are not chrome: written text survives
  const cmp = doc.layouts!.find((l) => l.id === 'CMP')!
  const cmpBefore = new Set(cmp.elements.map((e) => e.id))
  cmp.elements = cmp.elements.filter((e) => e.id !== 'lcmp-label-a')
  const known3 = layoutElementIds(doc); for (const id of cmpBefore) known3.add(id)
  resyncLinkedSlides(doc, 'CMP', known3, new Set(['lcmp-label-a']))
  ok(htmlOf(s2, 'lcmp-label-a') === 'Plan A (mine)', 'deleting a type’s own label keeps what a slide wrote in it')

  // relink + preview agree, and apply the locked rule too
  const s = instantiateLayout(effectiveLayout(doc, doc.layouts![1]))
  ;(s.elements.find((e) => e.id === 'm-copy') as TextElement).html = '© Stale'
  doc.slides.push(s)
  const p = relinkPreview(doc, s, doc.layouts!.find((l) => l.id === 'T')!)
  ok((p.elements.find((e) => e.id === 'm-copy') as TextElement).html === '© Old Corp', 'relinkPreview shows the master’s footer, not the stale copy')
  relinkSlide(doc, s.id, 'T')
  ok(htmlOf(s, 'm-copy') === '© Old Corp' && s.layoutId === 'T', 'relinkSlide writes the same')

  // a one-shot applyLayout (no locked set) keeps the historical behaviour
  const once = applyLayout({ ...s, elements: s.elements.map((e) => e.id === 'm-copy' ? { ...e, html: 'x' } as SlideElement : e) }, effectiveLayout(doc, doc.layouts![1]), layoutElementIds(doc))
  ok((once.find((e) => e.id === 'm-copy') as TextElement).html === 'x', 'applyLayout without `locked` still carries donor text (built-in apply)')
}

// ---- 2 · header & footer ------------------------------------------------------
console.log('\nheader & footer switches')
{
  const doc = fixture()
  const [s1, s2, s3] = doc.slides
  ok(footerHidden(doc, s1).size === 0, 'no headerFooter, no slide.footer: everything shows (old files unchanged)')
  doc.headerFooter = { slideNumber: { show: false } }
  ok([...footerHidden(doc, s1)].join() === 'slideNumber', 'slide number off deck-wide')
  s2.footer = { date: false }
  ok([...footerHidden(doc, s2)].sort().join() === 'date,slideNumber', 'a per-slide date opt-out adds to the deck’s')
  ok(!footerHidden(doc, s1).has('date'), '… and only on that slide')
  resyncLinkedSlides(doc, 'M', layoutElementIds(doc))
  ok(s2.footer?.date === false, 'slide.footer survives a resync of its master')
  ok(isTitleSlideType(doc, s3) && !isTitleSlideType(doc, s1), 'a title + subtitle type is a title slide; a content type is not')
  doc.headerFooter.hideOnTitle = true
  ok(footerHidden(doc, s3).size === 3 && !footerHidden(doc, s1).has('footer'), 'hideOnTitle drops every footer piece on title slides only')
  ok(footerHidden(doc, doc.layouts![3]).size === 3, 'a slide-type surface reports the same (renderSlide dims instead of hiding)')
}

// ---- 3 · field tokens ------------------------------------------------------------
console.log('\nfield tokens')
{
  const doc = fixture()
  doc.headerFooter = { footer: { text: '© Acme <Labs>' }, date: { fixed: '30.09.2026' } }
  doc.meta = { custom: { Classification: 'Internal & restricted' } }
  const ctx = fieldContext(doc, doc.slides[1])
  ok(resolveFields('{{footer}}', ctx) === '© Acme &lt;Labs&gt;', '{{footer}} = headerFooter.footer.text, escaped')
  ok(resolveFields('- {{prop:Classification}} -', ctx) === '- Internal &amp; restricted -', '{{prop:Name}} = meta.custom[Name], escaped')
  ok(resolveFields('{{prop:Missing}}|', ctx) === '|', 'an unknown property resolves empty')
  ok(resolveFields('{{date}}', ctx) === '30.09.2026', 'a fixed date wins over today')
  ok(resolveFields('Page {{page}}', ctx) === 'Page 2', '{{page}} is unchanged')
  const marked = resolveFields('Page {{page}}', ctx, 'value')
  ok(marked === 'Page <span class="sl-field" data-field="page">2</span>', `value markers wrap the value (${marked})`)
  const named = resolveFields('{{page}} · {{date}} · {{prop:Classification}}', ctx, 'name')
  ok(named.includes('>‹Page›<') && named.includes('>‹Date›<') && named.includes('>‹Classification›<'), `name markers show the field names (${named})`)
  ok(resolveFields('{{prop:a"b}}', { ...ctx, props: { 'a"b': 'x' } }, 'value').includes('data-field="prop:a&quot;b"'), 'a property name cannot break out of the attribute')
  delete doc.headerFooter.date!.fixed
  ok(resolveFields('{{date}}', fieldContext(doc, doc.slides[0])) === new Date().toLocaleDateString(), 'without a fixed date {{date}} is today')
}

// ---- 4 · parentOnly ------------------------------------------------------------------
console.log('\nmasters are not slide types')
{
  const doc = fixture()
  ok(pickableSlideTypes(doc).map((l) => l.id).join() === 'C,CMP,T', 'pickableSlideTypes skips the master')
  ok(defaultSlideType(doc).id === 'C', 'no defaultLayoutId: the first PICKABLE type, not the master in front')
  doc.defaultLayoutId = 'M'
  ok(defaultSlideType(doc).id === 'C', 'a defaultLayoutId naming a master falls back too')
  doc.defaultLayoutId = 'T'
  ok(defaultSlideType(doc).id === 'T', 'a real default is honoured')
  ok(starterSlide(doc).layoutId === 'T', 'the starter slide follows it')
  const all = clone(doc); for (const l of all.layouts!) l.parentOnly = true; delete all.defaultLayoutId
  ok(defaultSlideType(all).id === 'M', 'every type a master: still a doc type rather than the built-in blank')
}

// ---- 5 · validator ------------------------------------------------------------------
console.log('\nvalidator')
{
  const doc = fixture()
  doc.headerFooter = { footer: { text: 'x' }, hideOnTitle: true }
  doc.meta = { custom: { Classification: 'x' } }
  doc.basedOn = { templateId: 'abc' }
  doc.slides[0].footer = { date: false }
  const v = validateDoc(doc, { measure: false })
  const unknown = v.findings.filter((f) => f.code === 'unknown-key').map((f) => f.path)
  ok(!unknown.length, `no unknown keys for headerFooter, footer, footerRole, parentOnly, parentId, basedOn (${unknown.join(', ')})`)
  const bad = clone(doc)
  ;(bad.slides[0].elements.find((e) => e.id === 'm-page') as TextElement & { footerRole: string }).footerRole = 'page'
  ok(validateDoc(bad, { measure: false }).findings.some((f) => f.code === 'unknown-footer-role'), 'a misspelt footerRole is reported')
  const onMaster = clone(doc); onMaster.slides[0].layoutId = 'M'
  ok(validateDoc(onMaster, { measure: false }).findings.some((f) => f.code === 'parent-only-type'), 'a slide following a master is noted')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
