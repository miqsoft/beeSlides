#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// The shared element-edit layer (slides/src/editor/elementactions.ts): what
// one edit IS for both the properties panel and the mini toolbar. Runs
// without a DOM.
//
//   npx tsx scripts/test-element-edits.ts

import { defaultShape, defaultText, emptySlide, newDoc, type ShapeElement, type TextElement } from '../slides/src/model.ts'
import { Store } from '../slides/src/store.ts'
import { ElementEdits } from '../slides/src/editor/elementactions.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

function setup() {
  const doc = newDoc()
  doc.slides = [emptySlide({ id: 's1' })]
  const store = new Store(doc)
  store.slide.elements.push(
    defaultShape('rect', { id: 'r', fill: '#111111' }),
    defaultShape('line', { id: 'l', fill: '#222222', stroke: 'transparent' }),
    defaultText({ id: 't', fontWeight: 400 }),
  )
  return { store, edits: new ElementEdits(store) }
}
const el = <T>(store: Store, id: string) => store.element(id) as unknown as T
const flush = () => new Promise<void>((r) => queueMicrotask(r))

// wrapped: tsx compiles rigs to CJS, where top-level await is unavailable
void (async () => {
  console.log('\nbursts')
  {
    const { store, edits } = setup()
    edits.setFill('r', '#aa0000', false)
    edits.setFill('r', '#bb0000', false)
    edits.setFill('r', '#cc0000', true)
    ok(el<ShapeElement>(store, 'r').fill === '#cc0000', 'a burst lands its final value')
    store.undo()
    ok(el<ShapeElement>(store, 'r').fill === '#111111', 'one undo reverts the whole burst')
  }
  {
    const { store, edits } = setup()
    edits.setFill('r', '#aa0000', false)
    store.select(['t']) // selection change abandons the open burst
    edits.setFill('r', '#bb0000', true)
    store.undo()
    ok(el<ShapeElement>(store, 'r').fill === '#aa0000', 'a selection change starts a fresh undo step')
  }
  {
    // two surfaces, one instance: a burst opened from one continues on the other
    const { store, edits } = setup()
    let docEvents = 0
    store.on('doc', () => { docEvents++ })
    const w0 = el<ShapeElement>(store, 'r').strokeWidth // a new shape's default border
    edits.setStrokeWidth('r', w0 + 2, false)
    edits.mutate('r', (e) => { (e as ShapeElement).strokeWidth = w0 + 5 }, true)
    store.undo()
    ok(el<ShapeElement>(store, 'r').strokeWidth === w0 && docEvents >= 2, 'mutate() and named setters share one burst')
  }

  console.log('\npalette references')
  {
    const { store, edits } = setup()
    edits.setRef({ id: 'r', path: 'fill' }, '#F7A600', 'accent1')
    await flush()
    const r = el<ShapeElement>(store, 'r')
    ok(r.fill === '#F7A600' && r.themeRefs?.fill === 'accent1', 'a swatch writes the literal AND its reference')
    // what a hand-pick does: onChange(v, true) then onManualCommit(v)
    edits.setFill('r', '#00ff00', true)
    edits.setRef({ id: 'r', path: 'fill' }, '#00ff00', null)
    ok(el<ShapeElement>(store, 'r').themeRefs === undefined, 'a hand-picked colour clears the reference')
    store.undo()
    const back = el<ShapeElement>(store, 'r')
    ok(back.fill === '#F7A600' && back.themeRefs?.fill === 'accent1', 'ONE undo restores both the colour and its reference')
  }
  {
    const { store, edits } = setup()
    edits.setFill('r', '#00ff00', true)
    edits.setRef({ id: 'r', path: 'fill' }, '#00ff00', null) // nothing to clear
    store.undo()
    ok(el<ShapeElement>(store, 'r').fill === '#111111', 'a manual pick without a reference is still one undo step')
  }
  {
    const { store, edits } = setup()
    edits.setFill('r', '#00ff00', true)
    await flush() // a later, separate clear is its own step
    edits.setRef({ id: 'r', path: 'fill' }, '#123456', 'accent2')
    store.undo()
    ok(el<ShapeElement>(store, 'r').fill === '#00ff00', 'a later swatch pick is its own undo step')
  }

  console.log('\nnamed setters')
  {
    const { store, edits } = setup()
    edits.setStroke('l', '#ff00ff')
    const l = el<ShapeElement>(store, 'l')
    ok(l.fill === '#ff00ff' && l.stroke === 'transparent', 'a line\'s stroke colour is written to fill (what render paints)')
    ok(edits.strokeOf(l) === '#ff00ff' && ElementEdits.strokePath(l) === 'fill', 'strokeOf/strokePath agree for lines')
    edits.setStroke('r', '#00ffff')
    ok(el<ShapeElement>(store, 'r').stroke === '#00ffff', 'other shapes write stroke')
    ok(el<ShapeElement>(store, 'r').strokeWidth > 0, 'a visible border colour brings a visible width (model.setShapeStroke)')
    edits.setStrokeWidth('r', -3)
    ok(el<ShapeElement>(store, 'r').strokeWidth === 0, 'stroke width clamps at 0')

    edits.setFontSizePt('t', 24)
    ok(el<TextElement>(store, 't').fontSize === 32, '24pt = 32 slide px')
    ok(ElementEdits.fontSizePt(el<TextElement>(store, 't')) === 24, 'fontSizePt round-trips')
    edits.setFontSizePt('t', 1)
    ok(el<TextElement>(store, 't').fontSize === 4, 'size clamps at 3pt')

    edits.toggleBold('t')
    ok(el<TextElement>(store, 't').fontWeight === 700, 'toggleBold: regular → bold')
    el<TextElement>(store, 't').fontWeight = 600
    edits.toggleBold('t')
    ok(el<TextElement>(store, 't').fontWeight === 400, 'toggleBold: anything heavier than regular → regular')

    edits.setTextAlign('t', 'right')
    ok(el<TextElement>(store, 't').align === 'right', 'setTextAlign')
    edits.setFill('t', '#abcdef')
    ok(el<TextElement>(store, 't').color === '#abcdef' && ElementEdits.fillPath(el(store, 't')) === 'color', 'setFill on text writes color')

    // `modified` is excluded: a setter on the wrong element type still goes
    // through store.touch(), which stamps the clock — equal only when both
    // reads land in the same millisecond, so the check flaked under load.
    const content = () => JSON.stringify({ ...store.doc, modified: undefined })
    const before = content()
    edits.setImageFit('r', 'cover')
    edits.mutate('missing', () => { throw new Error('ran') }, true)
    ok(content() === before, 'setters ignore the wrong element type and missing ids')
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 1 : 0)
})()
