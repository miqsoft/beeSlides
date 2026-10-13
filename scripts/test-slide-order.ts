#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Slide/section move rig (slides/src/editor/slideorder.ts) — runs without a DOM.
//
//   slides/node_modules/.bin/esbuild scripts/test-slide-order.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-slide-order.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node $TMPDIR/test-slide-order.mjs
//
// (bundled because model.ts uses extensionless imports)
//
// Every case runs on the deck  [a, b | S1: c, d(state of c), e | S2: f]
// and reads the result back through model.ts's own section helpers, so it
// checks what the panel will actually show, not the token list.

import { emptySlide, extraParent, newDoc, sectionOf, sectionsInOrder, type SlidomingoDoc } from '../slides/src/model.ts'
import {
  applyTokens, dropSlots, extraDropAt, moveSectionTo, moveSlidesAsExtras, moveSlidesOutOfExtras, moveSlidesTo, stepSlides, tokensOf, type Token,
} from '../slides/src/editor/slideorder.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

function deck(): SlidomingoDoc {
  const doc = newDoc()
  doc.slides = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => emptySlide({ id, name: id }))
  doc.slides[3].stateOf = 'c'
  doc.sections = [
    { id: 'S1', name: 'One', startSlideId: 'c' },
    { id: 'S2', name: 'Two', startSlideId: 'f' },
  ]
  return doc
}

/** The panel as a string: `a b | S1: c d e | S2: f`. */
function view(doc: SlidomingoDoc): string {
  return tokensOf(doc).map((t) => (t.kind === 'header' ? `| ${t.section.id}:` : t.slides.map((s) => s.id).join(' '))).join(' ')
}

/** Token index of a header / of the block starting with a slide. */
const header = (doc: SlidomingoDoc, id: string) => tokensOf(doc).findIndex((t) => t.kind === 'header' && t.section.id === id)
const block = (doc: SlidomingoDoc, id: string) => tokensOf(doc).findIndex((t) => t.kind === 'block' && t.slides[0].id === id)
const end = (doc: SlidomingoDoc) => tokensOf(doc).length

function apply(doc: SlidomingoDoc, next: Token[] | null): boolean {
  return next ? applyTokens(doc, next) : false
}

console.log('\ntokens')
{
  const doc = deck()
  ok(view(doc) === 'a b | S1: c d e | S2: f', `the base deck reads as tokens (${view(doc)})`)
}

console.log('\nmoveSlidesAsExtras')
{
  const doc = deck()
  const r = moveSlidesAsExtras(doc, ['f'], header(doc, 'S1'))
  ok(!!r, 'f can be dropped as an extra at the end of the unsectioned run above S1')
  if (r) {
    applyTokens(doc, r.tokens)
    for (const h of r.heads) h.hidden = true
    ok(view(doc) === 'a b f | S1: c d e', `f lands after b (${view(doc)})`)
    ok(doc.slides.find((x) => x.id === 'f')?.hidden === true, 'f is hidden')
    ok(extraParent(doc, doc.slides.findIndex((x) => x.id === 'f')) === 1, 'f is an extra of b')
  }
}
{
  const doc = deck()
  const r = moveSlidesAsExtras(doc, ['b'], block(doc, 'b'))
  ok(!!r && r.heads.map((h) => h.id).join() === 'b', 'dropping b where it already is still nests it (hides it)')
  doc.slides[1].hidden = true
  ok(moveSlidesAsExtras(doc, ['b'], block(doc, 'b')) === null, 'a hidden slide dropped in place is a no-op')
}
{
  const doc = deck()
  ok(moveSlidesAsExtras(doc, ['e'], 0) === null, 'nothing normal above the first slot — no extras there')
  ok(moveSlidesAsExtras(doc, ['e'], header(doc, 'S1') + 1) === null, 'directly under a section header would hide the section start — refused')
  ok(moveSlidesAsExtras(doc, ['a'], block(doc, 'b')) === null, 'a moved slide cannot be its own parent: nothing normal is left above it')
}
{
  const doc = deck()
  const r = moveSlidesAsExtras(doc, ['c'], end(doc))
  ok(!!r && r.heads.length === 1 && r.heads[0].id === 'c', 'a parent with a state moves as one block; only its head is hidden')
  if (r) {
    applyTokens(doc, r.tokens)
    for (const h of r.heads) h.hidden = true
    ok(view(doc) === 'a b | S1: e | S2: f c d', `c and its state travel together (${view(doc)})`)
    ok(!doc.slides.find((x) => x.id === 'd')?.hidden, "the state d itself isn't flagged")
  }
}

console.log('\nmoveSlidesOutOfExtras (plain sidebar drop takes an extra out)')
{
  // [a, b(extra of a), c(extra of a) | S1: c… ] — b and c hidden after a
  const doc = deck()
  doc.slides[1].hidden = true
  doc.slides[2].hidden = true
  doc.sections = [{ id: 'S2', name: 'Two', startSlideId: 'f' }]
  const r = moveSlidesOutOfExtras(doc, ['c'], end(doc))
  ok(!!r && r.heads.map((h) => h.id).join() === 'c', 'the dragged extra is the one shown again')
  if (r) {
    applyTokens(doc, r.tokens)
    for (const h of r.heads) delete h.hidden
    ok(view(doc) === 'a b e | S2: f c d', `c (with its state) lands at the end (${view(doc)})`)
    ok(!doc.slides.find((x) => x.id === 'c')?.hidden, 'c is a normal slide again')
    ok(doc.slides.find((x) => x.id === 'b')?.hidden === true, 'b, not dragged, stays an extra of a')
  }
}
{
  const doc = deck()
  doc.slides[1].hidden = true
  const r = moveSlidesOutOfExtras(doc, ['b'], block(doc, 'b'))
  ok(!!r && r.heads.map((h) => h.id).join() === 'b', 'an extra dropped in place (left side) still un-nests')
  delete doc.slides[1].hidden
  ok(moveSlidesOutOfExtras(doc, ['b'], block(doc, 'b')) === null, 'a normal slide dropped in place is a no-op')
}
{
  const doc = deck()
  doc.slides[1].hidden = true // b = extra of a
  const r = moveSlidesOutOfExtras(doc, ['a'], end(doc))
  ok(!!r && r.heads.length === 0, 'moving a parent carries its extras without un-hiding them')
  if (r) {
    applyTokens(doc, r.tokens)
    ok(doc.slides.find((x) => x.id === 'b')?.hidden === true && extraParent(doc, doc.slides.findIndex((x) => x.id === 'b')) >= 0, 'b is still an extra, of a, after the move')
  }
}
{
  const doc = deck()
  doc.slides[0].hidden = true // a leading hidden slide is not an extra
  const r = moveSlidesOutOfExtras(doc, ['a'], block(doc, 'b') + 1)
  ok(!!r && r.heads.length === 0, 'a hidden orphan is not an extra — a plain drop keeps it hidden')
}

console.log('\nextraDropAt (drop beside a slide)')
/** Drop `ids` beside slide `target` as extras, the way the sidebar does. */
function dropBeside(doc: SlidomingoDoc, ids: string[], target: string): boolean {
  const at = extraDropAt(doc, target)
  const r = at === null ? null : moveSlidesAsExtras(doc, ids, at)
  if (!r) return false
  applyTokens(doc, r.tokens)
  for (const h of r.heads) h.hidden = true
  return true
}
const parentOf = (doc: SlidomingoDoc, id: string) => {
  const p = extraParent(doc, doc.slides.findIndex((x) => x.id === id))
  return p < 0 ? 'none' : doc.slides[p].id
}
{
  const doc = deck()
  ok(extraDropAt(doc, 'a') === block(doc, 'a') + 1, 'a normal slide without extras: right after it')
  ok(dropBeside(doc, ['f'], 'a') && view(doc) === 'a f b | S1: c d e', `f dropped beside a lands under a (${view(doc)})`)
  ok(parentOf(doc, 'f') === 'a', 'f is an extra of a (not of the slide above the gap)')
}
{
  const doc = deck()
  doc.slides[1].hidden = true // b is now an extra of a
  ok(extraDropAt(doc, 'a') === header(doc, 'S1'), 'a normal slide with extras: after the run, stopping at the header')
  ok(dropBeside(doc, ['e'], 'a') && view(doc) === 'a b e | S1: c d | S2: f', `e is appended to a's run (${view(doc)})`)
  ok(parentOf(doc, 'e') === 'a', 'e is an extra of a')
  ok(extraDropAt(doc, 'b') === block(doc, 'b') + 1, 'an extra: right after itself')
  ok(dropBeside(doc, ['f'], 'b') && view(doc) === 'a b f e | S1: c d', `f dropped beside b lands between b and e (${view(doc)})`)
  ok(parentOf(doc, 'f') === 'a', 'f joins the same run (extra of a)')
}
{
  const doc = deck()
  ok(extraDropAt(doc, 'd') === extraDropAt(doc, 'c'), 'a state counts as its parent block')
  ok(extraDropAt(doc, 'c') === block(doc, 'e'), 'c: right after its block (e is normal)')
  ok(dropBeside(doc, ['a'], 'c') && view(doc) === 'b | S1: c d a e | S2: f', `a dropped beside c (${view(doc)})`)
  ok(parentOf(doc, 'a') === 'c', 'a is an extra of c')
}
{
  const doc = deck()
  doc.slides[5].hidden = true // f: hidden start of S2, extra of e in doc order
  ok(extraDropAt(doc, 'e') === header(doc, 'S2'), 'the run stops at a section header')
  ok(extraDropAt(doc, 'f') === block(doc, 'f') + 1, 'an extra right under a header still takes drops after itself')
}
{
  const doc = deck()
  doc.slides[0].hidden = true // a: hidden with no normal slide above
  ok(extraDropAt(doc, 'a') === null, 'a hidden orphan can host no extras')
  ok(extraDropAt(doc, 'zz') === null, 'an unknown slide gives null')
}

console.log('\nmoveSlidesTo')
{
  const doc = deck()
  ok(apply(doc, moveSlidesTo(doc, ['e'], header(doc, 'S1') + 1)), 'drop e after the S1 header changes the deck')
  ok(view(doc) === 'a b | S1: e c d | S2: f', `e becomes S1's first slide, c+d follow (${view(doc)})`)
  ok(sectionsInOrder(doc).find((s) => s.id === 'S1')?.startSlideId === 'e', 'S1.startSlideId = e')
}
{
  const doc = deck()
  apply(doc, moveSlidesTo(doc, ['f'], header(doc, 'S2')))
  ok(view(doc) === 'a b | S1: c d e f', `f joins the end of S1 (${view(doc)})`)
  ok(!doc.sections?.some((s) => s.id === 'S2'), 'S2 emptied, so it is dropped')
}
{
  const doc = deck()
  apply(doc, moveSlidesTo(doc, ['c'], end(doc)))
  ok(view(doc) === 'a b | S1: e | S2: f c d', `dragging a section start to the end: d travels with c (${view(doc)})`)
  ok(doc.sections?.find((s) => s.id === 'S1')?.startSlideId === 'e', 'S1 now starts at e')
  ok(sectionOf(doc, 'c')?.id === 'S2', 'c lands in S2')
}
{
  const doc = deck()
  apply(doc, moveSlidesTo(doc, ['a', 'e'], end(doc)))
  ok(view(doc) === 'b | S1: c d | S2: f a e', `multi-move [a, e] keeps their relative order (${view(doc)})`)
}
{
  const doc = deck()
  apply(doc, moveSlidesTo(doc, ['d'], 0))
  ok(view(doc) === 'c d a b | S1: e | S2: f', `a selected state brings its parent block (${view(doc)})`)
}
{
  const doc = deck()
  ok(moveSlidesTo(doc, ['e'], block(doc, 'e')) === null, 'dropping in front of itself is a no-op')
  ok(moveSlidesTo(doc, ['e'], block(doc, 'e') + 1) === null, 'dropping right after itself is a no-op')
  ok(moveSlidesTo(doc, ['a', 'b'], block(doc, 'b')) === null, 'dropping inside the moved run is a no-op')
}
{
  const doc = deck()
  apply(doc, moveSlidesTo(doc, ['b'], block(doc, 'e')))
  ok(view(doc) === 'a | S1: c d b e | S2: f', `dragging down lands exactly in front of the target (${view(doc)})`)
  apply(doc, moveSlidesTo(doc, ['b'], block(doc, 'a')))
  ok(view(doc) === 'b a | S1: c d e | S2: f', `dragging up lands exactly in front of the target (${view(doc)})`)
}

console.log('\nmoveSectionTo')
{
  const doc = deck()
  apply(doc, moveSectionTo(doc, 'S2', header(doc, 'S1')))
  ok(view(doc) === 'a b | S2: f | S1: c d e', `S2 before S1 (${view(doc)})`)
}
{
  const doc = deck()
  apply(doc, moveSectionTo(doc, 'S1', end(doc)))
  ok(view(doc) === 'a b | S2: f | S1: c d e', `S1 to the end (${view(doc)})`)
  ok(doc.sections?.length === 2, 'both sections survive a section move')
}
{
  const doc = deck()
  ok(moveSectionTo(doc, 'S1', header(doc, 'S1')) === null, 'a section dropped on its own header is a no-op')
  ok(moveSectionTo(doc, 'S1', header(doc, 'S2')) === null, 'a section dropped before the next header is a no-op')
  const slots = dropSlots(doc, 'section', new Set(), 'S1').map((s) => s.at)
  ok(!slots.includes(header(doc, 'S1')) && !slots.includes(header(doc, 'S2')), 'section mode never offers those no-op slots')
  ok(slots.includes(end(doc)), 'S1 may go to the end')
  ok(!dropSlots(doc, 'section', new Set(), 'S2').some((s) => s.anchor === 'end'), 'the last section is not offered the end')
}

console.log('\nstepSlides')
{
  const doc = deck()
  apply(doc, stepSlides(doc, ['c'], -1))
  ok(view(doc) === 'a b c d | S1: e | S2: f', `⌘↑ on c puts it at the end of the unsectioned prefix (${view(doc)})`)
}
{
  const doc = deck()
  apply(doc, stepSlides(doc, ['e'], 1))
  ok(view(doc) === 'a b | S1: c d | S2: e f', `⌘↓ on e makes it the start of S2 (${view(doc)})`)
  ok(doc.sections?.find((s) => s.id === 'S2')?.startSlideId === 'e', 'S2.startSlideId = e')
}
{
  const doc = deck()
  apply(doc, stepSlides(doc, ['f'], 1))
  ok(stepSlides(doc, ['f'], 1) === null, '⌘↓ on the last slide is a no-op')
  apply(doc, stepSlides(doc, ['f'], -1))
  ok(view(doc) === 'a b | S1: c d e f', `⌘↑ on S2's only slide empties and drops S2 (${view(doc)})`)
}
{
  const doc = deck()
  apply(doc, stepSlides(doc, ['b', 'e'], 'end'))
  ok(view(doc) === 'a | S1: c d | S2: f b e', `⌘⇧↓ moves the selection to the end (${view(doc)})`)
  apply(doc, stepSlides(doc, ['f'], 'start'))
  ok(view(doc) === 'f a | S1: c d | S2: b e', `⌘⇧↑ moves the selection to the start (${view(doc)})`)
}

console.log('\nextras travel with their parent')
// [a, b, (bx1), (bx1s state of bx1), (bx2), c, d] — bx1/bx2 are b's extras
function extrasDeck(): SlidomingoDoc {
  const doc = newDoc()
  doc.slides = ['a', 'b', 'bx1', 'bx1s', 'bx2', 'c', 'd'].map((id) => emptySlide({ id, name: id }))
  for (const s of doc.slides) if (s.id.startsWith('bx')) s.hidden = true
  doc.slides[3].stateOf = 'bx1'
  return doc
}
/** The deck order, each extra tagged with its parent: `a b bx1<b bx1s bx2<b c d`. */
const nest = (doc: SlidomingoDoc) => doc.slides.map((s, i) => {
  const p = extraParent(doc, i)
  return p >= 0 ? `${s.id}<${doc.slides[p].id}` : s.id
}).join(' ')
{
  const doc = extrasDeck()
  ok(nest(doc) === 'a b bx1<b bx1s bx2<b c d', `the extras deck nests under b (${nest(doc)})`)
  apply(doc, stepSlides(doc, ['b'], 1))
  ok(nest(doc) === 'a c b bx1<b bx1s bx2<b d', `⌘↓ on b steps past c with its extras (${nest(doc)})`)
}
{
  const doc = extrasDeck()
  apply(doc, stepSlides(doc, ['b'], -1))
  ok(nest(doc) === 'b bx1<b bx1s bx2<b a c d', `⌘↑ on b takes its extras along (${nest(doc)})`)
}
{
  const doc = extrasDeck()
  apply(doc, stepSlides(doc, ['c'], -1))
  ok(nest(doc) === 'a c b bx1<b bx1s bx2<b d', `⌘↑ on c steps over b's whole run, not into it (${nest(doc)})`)
}
{
  const doc = extrasDeck()
  apply(doc, stepSlides(doc, ['a'], 1))
  ok(nest(doc) === 'b bx1<b bx1s bx2<b a c d', `⌘↓ on a steps over b's whole run (${nest(doc)})`)
}
{
  const doc = extrasDeck()
  apply(doc, stepSlides(doc, ['b'], 'end'))
  ok(nest(doc) === 'a c d b bx1<b bx1s bx2<b', `⌘⇧↓ on b moves its extras to the end too (${nest(doc)})`)
}
{
  const doc = extrasDeck()
  apply(doc, moveSlidesTo(doc, ['b'], end(doc)))
  ok(nest(doc) === 'a c d b bx1<b bx1s bx2<b', `dragging b to the end carries its extras (${nest(doc)})`)
  apply(doc, moveSlidesTo(doc, ['b'], 0))
  ok(nest(doc) === 'b bx1<b bx1s bx2<b a c d', `and back to the start (${nest(doc)})`)
}
{
  const doc = extrasDeck()
  ok(moveSlidesTo(doc, ['b'], block(doc, 'bx2')) === null, 'dropping b inside its own extras run is a no-op')
}
{
  const doc = extrasDeck()
  apply(doc, stepSlides(doc, ['bx1'], 1))
  ok(nest(doc) === 'a b bx2<b bx1<b bx1s c d', `⌘↓ on an extra steps within its run, with its state (${nest(doc)})`)
  apply(doc, stepSlides(doc, ['bx1'], -1))
  ok(nest(doc) === 'a b bx1<b bx1s bx2<b c d', `and ⌘↑ steps it back (${nest(doc)})`)
}
{
  const doc = extrasDeck()
  apply(doc, moveSlidesTo(doc, ['bx2'], end(doc)))
  ok(nest(doc) === 'a b bx1<b bx1s c d bx2<d', `a dragged extra still moves alone (${nest(doc)})`)
}
{
  const doc = extrasDeck()
  const at = extraDropAt(doc, 'd')!
  const r = moveSlidesAsExtras(doc, ['b'], at)
  ok(!!r, 'a normal slide with extras can be dropped as extras')
  if (r) applyTokens(doc, r.tokens)
  for (const h of r?.heads ?? []) h.hidden = true
  ok(nest(doc) === 'a c d b<d bx1<d bx1s bx2<d', `…and its run comes along under the new parent (${nest(doc)})`)
}

console.log('\ndangling and state-start sections')
{
  const doc = deck()
  doc.sections!.push({ id: 'gone', name: 'Gone', startSlideId: 'nope' })
  apply(doc, moveSlidesTo(doc, ['f'], header(doc, 'S2')))
  ok(doc.sections?.some((s) => s.id === 'gone' && s.startSlideId === 'nope') === true, 'a dangling section survives untouched')
}
{
  const doc = deck()
  doc.sections!.find((s) => s.id === 'S1')!.startSlideId = 'd' // starts on a state
  ok(view(doc) === 'a b | S1: c d e | S2: f', 'a section starting on a state is placed before its parent block')
  apply(doc, moveSlidesTo(doc, ['a'], end(doc)))
  ok(doc.sections?.find((s) => s.id === 'S1')?.startSlideId === 'c', 'and is normalized onto the parent on the next move')
}

console.log('\ndropSlots')
{
  const doc = deck()
  const slots = dropSlots(doc, 'slides', new Set())
  const at = slots.map((s) => `${s.anchor}:${s.at}`)
  ok(slots.some((s) => s.anchor === 'beforeHeader' && s.id === 'S1'), 'slides mode: before S1 = end of the unsectioned prefix')
  ok(slots.some((s) => s.anchor === 'afterHeader' && s.id === 'S1'), 'slides mode: after the S1 header')
  ok(slots.some((s) => s.anchor === 'beforeHeader' && s.id === 'S2'), 'slides mode: before the S2 header')
  ok(slots[slots.length - 1].anchor === 'end', 'slides mode: the end of the deck comes last')
  ok(new Set(slots.map((s) => s.at)).size === slots.length, `no two slots share a position (${at.join(' ')})`)
  ok(!slots.some((s) => s.anchor === 'beforeThumb' && s.id === 'c'), 'the first slide under a header is the afterHeader slot, not a second one')
}
{
  const doc = deck()
  doc.slides = doc.slides.filter((s) => s.id !== 'a' && s.id !== 'b') // S1 starts the deck
  const slots = dropSlots(doc, 'slides', new Set())
  ok(!slots.some((s) => s.anchor === 'beforeHeader' && s.id === 'S1'), 'no slot above a first header with nothing above it')
}
{
  const doc = deck()
  const hidden = new Set([2, 3, 4]) // S1 collapsed
  const slots = dropSlots(doc, 'slides', hidden)
  ok(slots.some((s) => s.anchor === 'afterHeader' && s.id === 'S1'), 'a collapsed section still takes a drop after its header')
  ok(!slots.some((s) => s.anchor === 'beforeThumb' && s.id === 'e'), 'collapsed thumbs offer no slots')
  ok(!slots.some((s) => s.anchor === 'beforeHeader' && s.id === 'S2'), 'no before-header slot right under a collapsed section')
}
{
  const doc = deck()
  for (const sid of ['S1', 'S2']) {
    const slots = dropSlots(doc, 'section', new Set(), sid)
    ok(!slots.some((s) => s.at <= block(doc, 'b')), `section mode never offers a slot above the unsectioned run (${sid})`)
  }
}
{
  const doc = deck()
  delete doc.sections
  const slots = dropSlots(doc, 'slides', new Set())
  ok(slots.map((s) => s.at).join() === '0,1,2,3,4,5', 'no sections: a slot before every block plus the end')
  apply(doc, moveSlidesTo(doc, ['a'], end(doc)))
  ok(view(doc) === 'b c d e f a' && doc.sections === undefined, `no sections: drop at the end (${view(doc)})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
