#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Present-mode navigation rig — extra slides + states (model.ts presentNext /
// presentPrev / presentToggleExtras / extrasOf / extraParent) and the typed
// slide number + Enter jump (presentJumpTarget, presentNumberKey), and zoom
// frames on top of the flow (zoomNext / zoomPrev / zoomStackAt). No DOM.
//
//   slides/node_modules/.bin/esbuild scripts/test-present-nav.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-present-nav.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node $TMPDIR/test-present-nav.mjs
//
// Decks are written as a string of slide ids: uppercase = normal, lowercase =
// hidden, and `P:id` is an interactive state `id` of slide P.

import {
  emptySlide, extraParent, extrasOf, newDoc, presentDigitOf, presentJumpTarget, presentNext, presentNumberKey, presentPrev,
  presentToggleExtras, type SlidomingoDoc,
} from '../slides/src/model.ts'
import { defaultZoom, zoomFrameFor, zoomNext, zoomPrev, zoomStackAt, type ZoomElement, type ZoomFrame } from '../slides/src/model.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

/** 'A b c D' → A normal, b/c hidden extras of A, D normal. 'A:s' = state s of A. */
function deck(spec: string): SlidomingoDoc {
  const doc = newDoc()
  doc.slides = spec.split(/\s+/).map((tok) => {
    const m = /^(?:(\w):)?(\w)$/.exec(tok)!
    const id = m[2]
    const s = emptySlide({ id, name: id })
    if (id === id.toLowerCase()) s.hidden = true
    if (m[1]) { s.stateOf = m[1]; delete s.hidden }
    return s
  })
  return doc
}
const idx = (d: SlidomingoDoc, id: string) => d.slides.findIndex((s) => s.id === id)
const name = (d: SlidomingoDoc, i: number) => (i < 0 ? 'none' : d.slides[i].id)
/** next/prev/x as slide ids, from slide `id` */
const next = (d: SlidomingoDoc, id: string) => name(d, presentNext(d, idx(d, id)))
const prev = (d: SlidomingoDoc, id: string) => name(d, presentPrev(d, idx(d, id)))
const x = (d: SlidomingoDoc, id: string) => name(d, presentToggleExtras(d, idx(d, id)))

console.log('— normal flow skips hidden slides')
{
  const d = deck('A b c D')
  ok(next(d, 'A') === 'D', '→ from A goes to D')
  ok(prev(d, 'D') === 'A', '← from D goes to A')
  ok(next(d, 'D') === 'none', '→ from the last slide goes nowhere')
  ok(prev(d, 'A') === 'none', '← from the first slide goes nowhere')
}

console.log('— X enters the extras and leaves them forward')
{
  const d = deck('A b c D')
  ok(x(d, 'A') === 'b', 'X on A enters the first extra')
  ok(x(d, 'b') === 'D', 'X on b moves on to D')
  ok(x(d, 'c') === 'D', 'X on c moves on to D')
  ok(x(d, 'D') === 'none', 'X on a slide with no extras does nothing')
  ok(extrasOf(d, idx(d, 'A')).map((i) => d.slides[i].id).join() === 'b,c', 'extrasOf(A) = b, c')
  ok(extrasOf(d, idx(d, 'b')).length === 0, 'an extra has no extras of its own')
  ok(extraParent(d, idx(d, 'c')) === idx(d, 'A'), 'extraParent(c) = A')
  ok(extraParent(d, idx(d, 'D')) === -1, 'a normal slide has no extra parent')
}

console.log('— → walks the run and moves on to N+1; ← walks back')
{
  const d = deck('A b c D')
  ok(next(d, 'b') === 'c', '→ on b goes to c')
  ok(next(d, 'c') === 'D', '→ on the last extra moves on to D')
  ok(next(d, 'A') === 'D', '→ from A (extras skipped) goes to D')
  ok(prev(d, 'c') === 'b', '← on c goes to b')
  ok(prev(d, 'b') === 'A', '← on the first extra returns to A')
  ok(prev(d, 'D') === 'A', '← from D goes to A, not into the extras')
}

console.log('— the old ← no-op on a hidden slide is fixed')
{
  const d = deck('A b D')
  ok(prev(d, 'b') === 'A', '← on a hidden slide used to do nothing; now goes to its parent')
}

console.log('— states')
{
  // A, hidden b with a state s, hidden c, normal D
  const d = deck('A b b:s c D')
  ok(extrasOf(d, idx(d, 'A')).map((i) => d.slides[i].id).join() === 'b,c', 'a state between extras is skipped by extrasOf')
  ok(prev(d, 's') === 'b', '← on a state of an extra goes to that extra')
  ok(next(d, 's') === 'c', '→ on a state of an extra continues the extra run')
  ok(x(d, 's') === 'D', 'X on a state of an extra moves on to the next normal slide')
  ok(next(d, 'b') === 'c', '→ on the extra itself skips its state')

  const n = deck('A B B:t D')
  ok(prev(n, 't') === 'B', '← on a state of a normal slide goes to the anchor (unchanged)')
  ok(next(n, 't') === 'D', '→ on a state of a normal slide continues past the anchor (unchanged)')
  ok(x(n, 't') === 'none', 'X on a state of a normal slide does nothing')
  ok(next(n, 'B') === 'D', '→ from B skips its state')
}

console.log('— appendix at the end of the deck')
{
  const d = deck('A B x y')
  ok(x(d, 'B') === 'x', 'X on the last slide opens the appendix')
  ok(x(d, 'A') === 'none', 'X on A (no extras) does nothing')
  ok(next(d, 'B') === 'none', '→ from B ends the show (appendix is skipped)')
  ok(next(d, 'x') === 'y', '→ walks the appendix')
  ok(next(d, 'y') === 'B', '→ past the end of the appendix falls back to B (nothing after it)')
  ok(x(d, 'x') === 'B', 'X on an appendix slide falls back to B')
  ok(x(d, 'y') === 'B', 'X on the last appendix slide falls back to B')
  ok(prev(d, 'x') === 'B', '← on the first appendix slide returns to B')

  const s = deck('A B x x:s')
  ok(x(s, 's') === 'B', 'X on a state of an appendix slide falls back to B')
  ok(next(s, 's') === 'B', '→ on a state of the last appendix slide falls back to B')
}

console.log('— hidden slides before the first normal slide have no parent')
{
  const d = deck('h A')
  ok(extraParent(d, idx(d, 'h')) === -1, 'extraParent is -1')
  ok(x(d, 'h') === 'none', 'X does nothing on it')
  ok(x(d, 'A') === 'none', 'and A has no extras')
  ok(next(d, 'h') === 'A', '→ from it enters the normal flow')
  ok(prev(d, 'h') === 'none', '← from it goes nowhere')
  ok(next(d, 'A') === 'none', 'the orphan is not reachable from A')
}

console.log('— a run is split by a normal slide')
{
  const d = deck('A b C d')
  ok(extrasOf(d, idx(d, 'A')).length === 1 && extraParent(d, idx(d, 'd')) === idx(d, 'C'), 'b belongs to A, d to C')
  ok(next(d, 'b') === 'C', '→ on b moves on to C')
  ok(x(d, 'b') === 'C', 'X on b moves on to C')
  ok(next(d, 'd') === 'C', '→ on d (appendix) falls back to C')
}

console.log('— typed slide number + Enter')
{
  const jump = (d: SlidomingoDoc, n: number) => name(d, presentJumpTarget(d, n))
  const d = deck('A b B:s C D')
  ok(jump(d, 1) === 'A' && jump(d, 2) === 'C' && jump(d, 3) === 'D', 'numbers count the slides the show numbers (hidden + states skipped)')
  ok(jump(d, 0) === 'none' && jump(d, 4) === 'none' && jump(d, -1) === 'none', 'out of range is no target')
  ok(jump(d, 1.5) === 'none' && jump(d, NaN) === 'none', 'a non-integer is no target')
  d.present = { ...(d.present ?? {}), numberHidden: true }
  ok(jump(d, 2) === 'b' && jump(d, 3) === 'C', 'numberHidden: a hidden slide has a number, so it is a target')
  const e = deck('A B C')
  e.slides[1].excludeFromNumbering = true
  ok(jump(e, 2) === 'C' && jump(e, 3) === 'none', 'a slide excluded from numbering is skipped, later numbers shift')
}

console.log('— typing the number (presentNumberKey)')
{
  type K = [key: string, code?: string]
  /** feed keys; returns the slide number Enter asked for, or what happened last */
  const type = (keys: K[]): string => {
    let buf = ''
    let last = ''
    for (const [key, code] of keys) {
      const r = presentNumberKey(buf, key, code)
      if (r.kind === 'edit') buf = r.buf
      else if (r.kind === 'go') return `go ${r.n}`
      else if (r.kind === 'drop') buf = ''
      last = r.kind === 'drop' ? `drop${r.consumed ? '+' : ''}` : r.kind
    }
    return `${last} ${buf}`
  }
  ok(type([['1', 'Digit1'], ['2', 'Digit2'], ['Enter', 'Enter']]) === 'go 12', 'US: 1 2 Enter goes to 12')
  ok(type([['Shift', 'ShiftLeft'], ['1', 'Digit1'], ['Shift', 'ShiftLeft'], ['2', 'Digit2'], ['Enter', 'Enter']]) === 'go 12',
    'AZERTY: Shift on its own between the digits keeps the number')
  ok(type([['&', 'Digit1'], ['é', 'Digit2'], ['Enter', 'Enter']]) === 'go 12', 'AZERTY unshifted top row counts as digits (read from code)')
  ok(type([['1', 'Numpad1'], ['4', 'Numpad4'], ['Enter', 'NumpadEnter']]) === 'go 14', 'numpad digits + numpad Enter')
  ok(type([['End', 'Numpad1']]) === 'pass ', 'numpad with NumLock off (End) is not a digit')
  ok(type([['7']]) === 'edit 7', 'an event without a code falls back to the key')
  ok(type([['1', 'Digit1'], ['2', 'Digit2'], ['Backspace', 'Backspace'], ['3', 'Digit3'], ['Enter', 'Enter']]) === 'go 13', 'Backspace edits the number')
  ok(type([['1', 'Digit1'], ['Escape', 'Escape']]) === 'drop+ ', 'Esc drops the number and is used up')
  ok(type([['1', 'Digit1'], ['ArrowRight', 'ArrowRight']]) === 'drop ', 'another key drops the number and stays the show\'s')
  ok(type([['Escape', 'Escape']]) === 'pass ' && type([['Shift', 'ShiftLeft']]) === 'pass ', 'with nothing typed, keys pass through')
  ok(type([['1'], ['2'], ['3'], ['4'], ['5']]) === 'edit 1234', 'at most 4 digits are kept')
  ok(presentDigitOf('a', 'KeyA') === '' && presentDigitOf('!', 'Digit1') === '1', 'presentDigitOf reads the physical key')
}

console.log('— zoom frames on top of the normal flow')
{
  // O A b c D E: b, c are A's extras; a zoom into A (range 'section', no
  // sections = to the deck's end) walks them, where → normally skips them
  const doc = deck('O A b c D E')
  const names = (d: SlidomingoDoc, list: number[]) => list.map((i) => name(d, i)).join(' ')
  const tile = (on: number, target: ZoomElement['target'], range?: ZoomElement['range']) => {
    const el = defaultZoom(target, range ? { range } : {})
    doc.slides[on].elements.push(el)
    return el
  }
  const f = zoomFrameFor(doc, 0, tile(0, { slide: 'A' }, 'section'))!
  ok(names(doc, [presentNext(doc, 1), zoomNext(doc, f, 1)]) === 'D b', 'outside a zoom → skips the extras; inside one it walks them')
  ok(names(doc, [zoomNext(doc, f, 2), zoomNext(doc, f, 3)]) === 'c D', 'and on through the rest of the range')
  ok(zoomNext(doc, f, 5) === -1 && zoomPrev(doc, f, 1) === -1, 'past either end of the range: zoom out')
  const g = zoomFrameFor(doc, 0, tile(0, { slide: 'A' }))!
  ok(zoomNext(doc, g, 1) === -1, 'a one-slide zoom zooms out on the first →')
  // the stack after landing somewhere
  const inner: ZoomFrame = zoomFrameFor(doc, 4, tile(4, { slide: 'E' }))!
  const stack = [f, inner]
  ok(zoomStackAt(doc, stack, 5).length === 2, 'landing inside the inner range keeps both frames')
  ok(zoomStackAt(doc, stack, 4).length === 1, "landing on the inner overview closes only the inner frame")
  ok(zoomStackAt(doc, stack, 0).length === 0, 'landing outside both closes both')
  const nest: ZoomFrame[] = [g, zoomFrameFor(doc, 1, tile(1, { slide: 'E' }))!]
  ok(zoomStackAt(doc, nest, 5).length === 2, 'an outer frame waits while an inner one plays outside its range')
  ok(zoomStackAt(doc, [], 3).length === 0, 'no zoom, nothing to close')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
