#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Slide relink — the model half of "Change layout…" and the Layout
// Manager's slide leaves (docs/DECISIONS.md 2026-09-28).
//
//   node scripts/test-slide-relink.mjs
//
// WHAT THIS PROVES. `relinkPreview` grades a move honestly: title+body onto
// title+body fits; content that was sitting in a slot and finds none in the
// target (a second column, a picture onto a type with no media slot) floats
// and makes it 'partial'; the user's own free extras never count against a
// fit. `relinkSlide` really switches what the slide follows — the next
// resync of the NEW type is a no-op, and editing the OLD type no longer
// reaches it (the "Apply layout…" bug this replaces: the slide snapped back
// to its old type on that type's next edit). The leaf lists skip `stateOf`
// variants, and "Not linked" catches dangling ids too.

import {
  relinkPreview, relinkSlide, directlyLinked, unlinkedSlides, linkedSlides,
  resyncLinkedSlides, layoutElementIds, applyLayout, effectiveLayout, instantiateLayout,
} from '../slides/src/model.ts'

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const text = (id, role, html = '', x = 0) => ({
  id, type: 'text', x, y: 0, w: 100, h: 40, rotation: 0, opacity: 1, html,
  fontSize: 20, fontFamily: 'Arial', fontWeight: 400, color: '#000', align: 'left', valign: 'top', lineHeight: 1.2,
  ...(role ? { role } : {}),
})
const rect = (id, extra = {}) => ({
  id, type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1,
  fill: '#000', stroke: 'none', strokeWidth: 0, radius: 0, ...extra,
})
const image = (id, extra = {}) => ({
  id, type: 'image', src: 'data:,', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, fit: 'cover', ...extra,
})
const ly = (id, elements, extra = {}) => ({ id, name: id, background: `#${id.length}${id.length}${id.length}`, transition: 'fade', notes: '', elements, ...extra })
function makeDoc(layouts, slides = []) {
  return {
    format: 'beeslides/slides', version: 1, docId: 'd', title: 't',
    size: { width: 1280, height: 720 },
    theme: { background: '#fff', color: '#000', accent: '#f00', fontFamily: 'Arial' },
    slides, layouts,
  }
}
/** A slide instantiated from `layout` (element ids kept), linked to it, with its text filled in. */
function slideFrom(doc, layoutId, fill = {}) {
  const layout = doc.layouts.find((l) => l.id === layoutId)
  const s = instantiateLayout(effectiveLayout(doc, layout))
  s.layoutId = layoutId
  for (const e of s.elements) if (e.type === 'text' && fill[e.role ?? e.id]) e.html = fill[e.role ?? e.id]
  doc.slides.push(s)
  return s
}

const tb = (p) => ly(p, [rect(`${p}-bar`), text(`${p}-title`, 'title', '', 0), text(`${p}-body`, 'body', '', 0)])
const twoCol = ly('TWO', [text('two-title', 'title'), text('two-left', 'body', '', 0), text('two-right', 'body', '', 600)])
const titleOnly = ly('TITLE', [text('to-title', 'title')])
const picture = ly('PIC', [text('pic-title', 'title'), rect('pic-media', { role: 'media' })])

// ---- verdicts ----------------------------------------------------------------
console.log('\nrelinkPreview — verdicts')
{
  const doc = makeDoc([tb('A'), tb('B'), twoCol, titleOnly, picture])
  const s = slideFrom(doc, 'A', { title: 'Hello', body: 'World' })
  const p = relinkPreview(doc, s, doc.layouts.find((l) => l.id === 'B'))
  ok(p.verdict === 'fit', `title+body → title+body fits — got ${p.verdict}`)
  ok(p.filled.join(',') === 'B-title,B-body', `both slots filled — got ${p.filled}`)
  ok(!p.floating.length && !p.emptySlots.length, 'nothing floats, no empty slots')
  ok(JSON.stringify(s.elements.map((e) => e.id)) === '["A-bar","A-title","A-body"]', 'preview mutates nothing')

  const s2 = slideFrom(doc, 'TWO', { 'two-title': 'T', 'two-left': 'L', 'two-right': 'R' })
  // the fill helper keys by role first: both columns are role body — fill by id instead
  s2.elements.find((e) => e.id === 'two-left').html = 'L'
  s2.elements.find((e) => e.id === 'two-right').html = 'R'
  s2.elements.find((e) => e.id === 'two-title').html = 'T'
  const p2 = relinkPreview(doc, s2, titleOnly)
  ok(p2.verdict === 'partial', `two-column → title-only is partial — got ${p2.verdict}`)
  ok(p2.floating.map((e) => e.id).sort().join(',') === 'two-left,two-right', `both columns float — got ${p2.floating.map((e) => e.id)}`)
  ok(p2.elements.filter((e) => e.type === 'text').length === 3, 'no written text is lost (title slot + 2 floating columns)')

  const s3 = slideFrom(doc, 'PIC', { title: 'Look' })
  const pic = s3.elements.findIndex((e) => e.id === 'pic-media')
  // What applyLayout leaves after a picture filled the media slot: the donor's type, the slot's id + role.
  s3.elements[pic] = image('pic-media', { role: 'media' })
  const p3 = relinkPreview(doc, s3, doc.layouts.find((l) => l.id === 'A'))
  ok(p3.verdict === 'partial' && p3.floating.map((e) => e.id).join(',') === 'pic-media',
    `media → a type with no media slot: the picture floats — got ${p3.verdict} / ${p3.floating.map((e) => e.id)}`)
  ok(p3.emptySlots.join(',') === 'A-body', `unfilled body placeholder reported as an empty slot — got ${p3.emptySlots}`)
  const p3b = relinkPreview(doc, s3, picture)
  ok(p3b.verdict === 'fit', 'the same slide onto its own type fits')

  // A free extra (no role, not layout-owned) rides along anywhere — never counts.
  const s4 = slideFrom(doc, 'A', { title: 'x' })
  s4.elements.push(rect('user-arrow'))
  const p4 = relinkPreview(doc, s4, titleOnly)
  ok(p4.verdict === 'fit' && p4.extras.map((e) => e.id).join(',') === 'user-arrow', 'a user extra is an extra, not a collision')
  // …but a roleless picture the user dropped DOES fill a media slot.
  s4.elements.push(image('user-pic'))
  const p5 = relinkPreview(doc, s4, picture)
  ok(p5.filled.includes('pic-media') && !p5.extras.some((e) => e.id === 'user-pic'), 'a roleless picture fills the target’s media slot')
  // Container children never count separately.
  s4.elements.push(rect('kid', { parentId: 'user-arrow' }))
  ok(relinkPreview(doc, s4, titleOnly).extras.every((e) => e.id !== 'kid'), 'container children ride with their container')
}

// ---- relinkSlide ---------------------------------------------------------------
console.log('\nrelinkSlide')
{
  const doc = makeDoc([tb('A'), tb('B', undefined)])
  doc.layouts[1].excludeFromNumbering = true
  const s = slideFrom(doc, 'A', { title: 'Hello', body: 'World' })
  const p = relinkSlide(doc, s.id, 'B')
  ok(p && p.verdict === 'fit', 'returns the applied preview')
  ok(s.layoutId === 'B', 'layoutId switched to the target')
  ok(s.elements.map((e) => e.id).join(',') === 'B-bar,B-title,B-body', `elements take the target’s slots — got ${s.elements.map((e) => e.id)}`)
  ok(s.elements.find((e) => e.id === 'B-title').html === 'Hello' && s.elements.find((e) => e.id === 'B-body').html === 'World', 'content carried across')
  ok(s.background === doc.layouts[1].background && s.excludeFromNumbering === true, 'background + numbering opt-out copied like a resync')

  const before = JSON.stringify(s)
  resyncLinkedSlides(doc, 'B', layoutElementIds(doc))
  ok(JSON.stringify(s) === before, 'the first resync of the new type after a relink is a no-op')

  doc.layouts[0].elements[0].fill = '#abcdef'
  doc.layouts[0].background = '#123456'
  resyncLinkedSlides(doc, 'A', layoutElementIds(doc))
  ok(JSON.stringify(s) === before, 'editing the OLD type no longer reaches the slide')
  ok(!linkedSlides(doc, 'A').includes(s) && linkedSlides(doc, 'B').includes(s), 'linkedSlides agrees')

  doc.layouts[1].elements[1].fontSize = 44
  resyncLinkedSlides(doc, 'B', layoutElementIds(doc))
  ok(s.elements.find((e) => e.id === 'B-title').fontSize === 44 && s.elements.find((e) => e.id === 'B-title').html === 'Hello',
    'editing the NEW type does reach it, content kept')

  ok(relinkSlide(doc, s.id, 'nope') === null && s.layoutId === 'B', 'unknown target: null, slide untouched')
  ok(relinkSlide(doc, 'nope', 'A') === null, 'unknown slide: null')

  // Relinking a partial fit twice in a row settles (idempotent second pass).
  const two = makeDoc([twoCol, titleOnly])
  const t2 = slideFrom(two, 'TWO')
  for (const e of t2.elements) e.html = e.id
  relinkSlide(two, t2.id, 'TITLE')
  const once = JSON.stringify(t2.elements)
  resyncLinkedSlides(two, 'TITLE', layoutElementIds(two))
  ok(JSON.stringify(t2.elements) === once, 'partial fit: the floating columns stay put on the next resync')
}
{
  // Relinking to a child type composes the whole chain.
  const doc = makeDoc([ly('R', [rect('r-logo')]), ly('C', [text('c-title', 'title')], { parentId: 'R' }), tb('A')])
  const s = slideFrom(doc, 'A', { title: 'Hi' })
  relinkSlide(doc, s.id, 'C')
  ok(s.elements.map((e) => e.id).join(',') === 'r-logo,c-title' && s.elements[1].html === 'Hi', 'child target: inherited chrome + own slot, content kept')
  ok(s.background === doc.layouts[1].background, 'background from the target (effective layout keeps the child’s own)')
}

// ---- built-in "Change layout…" = apply + unlink ---------------------------
console.log('\nChange layout onto a built-in')
{
  // editor.ts: applyLayout(builtin) then `delete slide.layoutId` — a built-in
  // has no identity to follow, so the slide must not keep the stale link.
  const doc = makeDoc([tb('A')])
  const s = slideFrom(doc, 'A', { title: 'Hello' })
  const builtin = ly('layout-title-only', [text('bt-title', 'title')])
  s.elements = applyLayout(s, builtin, layoutElementIds(doc))
  delete s.layoutId
  ok(!('layoutId' in s), 'layoutId cleared')
  ok(s.elements[0].html === 'Hello', 'content moved into the built-in’s title')
  const snap = JSON.stringify(s)
  doc.layouts[0].elements[1].fontSize = 99
  resyncLinkedSlides(doc, 'A', layoutElementIds(doc))
  ok(JSON.stringify(s) === snap, '…and the old type no longer pulls it back')
}

// ---- leaves --------------------------------------------------------------------
console.log('\ndirectlyLinked / unlinkedSlides')
{
  const doc = makeDoc([tb('A'), ly('A1', [], { parentId: 'A' })])
  const a = slideFrom(doc, 'A')
  const a1 = slideFrom(doc, 'A1')
  const state = { ...JSON.parse(JSON.stringify(a)), id: 'state', stateOf: a.id }
  doc.slides.push(state)
  const free = { ...JSON.parse(JSON.stringify(a)), id: 'free' }
  delete free.layoutId
  const dangling = { ...JSON.parse(JSON.stringify(a)), id: 'dangling', layoutId: 'gone' }
  doc.slides.push(free, dangling)
  ok(directlyLinked(doc, 'A').map((s) => s.id).join(',') === a.id, 'directlyLinked: own slides only, no descendant slides, no states')
  ok(directlyLinked(doc, 'A1').map((s) => s.id).join(',') === a1.id, 'child type has its own leaf')
  ok(linkedSlides(doc, 'A').length === 3, 'linkedSlides still counts the subtree (+ the state) — the resync set is unchanged')
  ok(unlinkedSlides(doc).map((s) => s.id).join(',') === 'free,dangling', 'unlinkedSlides: never-linked + dangling, no states')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
