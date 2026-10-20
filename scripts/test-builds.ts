#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Click-builds rig: what builds.ts says is on screen after click N.
//
//   slides/node_modules/.bin/esbuild scripts/test-builds.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-builds.mjs" \
//     && node "$TMPDIR/test-builds.mjs"
//
// builds.ts is the single source of truth for present mode, the speaker view,
// the editor's badges and validate, so this pins its rules: clicks compress,
// `order` never makes a click, byParagraph splits by block / <br> and skips
// blank lines, exits are honoured only after the entrance, and hover-set
// members take no part.

import { buildPlan, clickHasParagraphs, mergeClickIntoPrevious, normalizeSteps, paragraphCount, setEnterClick, setExitClick, swapClicks, slideAtStep, splitParagraphs, stepCount, stepsOf, visibleAt } from '../slides/src/builds'
import { validateDoc } from '../slides/src/validate'
import { newDoc, parseDoc } from '../slides/src/model'
import type { Slide, SlideElement } from '../slides/src/model'

let failures = 0
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const same = (a: Iterable<string>, b: string[]) => {
  const x = [...a].sort().join(',')
  const y = [...b].sort().join(',')
  return x === y
}

const text = (id: string, html = id, fx?: SlideElement['fx'], extra: Record<string, unknown> = {}): SlideElement => ({
  id, type: 'text', x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1, html, fontSize: 20,
  fontFamily: 'system-ui', fontWeight: 400, color: '#000', align: 'left', valign: 'top', lineHeight: 1.2,
  ...(fx ? { fx } : {}), ...extra,
}) as SlideElement
const slideOf = (elements: SlideElement[]): Slide => ({ id: 's', background: '#fff', transition: 'none', notes: '', elements }) as Slide

// ---------------------------------------------------------------- paragraphs
ok(paragraphCount('just a line') === 1, 'inline-only html is one paragraph')
ok(paragraphCount('<div>one</div><div>two</div><div>three</div>') === 3, 'each top-level <div> is a paragraph')
ok(paragraphCount('<p>a</p><p>b</p>') === 2, 'each top-level <p> is a paragraph')
ok(paragraphCount('first line<div>second</div><div>third</div>') === 3, 'the bare first line + <div>s (what contenteditable writes) is three')
ok(paragraphCount('a<br>b<br>c') === 3, '<br> separates paragraphs in inline html')
ok(paragraphCount('<div>a</div><div><br></div><div>b</div>') === 2, 'a blank <div><br></div> line is not a paragraph (it would cost a click and show nothing)')
ok(paragraphCount('<div>a</div><div>&nbsp;</div><div> </div>') === 1, 'whitespace / &nbsp; lines are not paragraphs')
ok(paragraphCount('<div><div>a</div><div>b</div></div>') === 1, 'nested blocks stay inside their top-level block')
ok(paragraphCount('<div><b>bold</b> and <i>it</i></div><div><span>x</span></div>') === 2, 'inline markup does not split a paragraph')
ok(paragraphCount('') === 0, 'empty html has no paragraphs')
ok(splitParagraphs('<div>a</div>b<br>c').join('|') === '<div>a</div>|b<br>|c', 'splitParagraphs returns each paragraph\'s own markup')

// ---------------------------------------------------------------- compression
{
  const s = slideOf([text('bg'), text('a', 'a', { step: 1 }), text('b', 'b', { step: 3 }), text('c', 'c', { step: 3 })])
  const plan = buildPlan(s)
  ok(plan.steps.length === 2, 'steps 1 and 3 are two clicks — the gap costs the presenter nothing')
  ok(plan.steps[0].at === 1 && plan.steps[1].at === 3, 'a click remembers the authored number it came from')
  ok(plan.steps[1].enter.map((t) => t.elId).join() === 'b,c', 'equal steps enter on the same click')
  ok(stepCount(s) === 2, 'stepCount')
  ok(same(visibleAt(s, 0), ['bg']), 'click 0: only what is with the slide')
  ok(same(visibleAt(s, 1), ['bg', 'a']), 'click 1 brings a in')
  ok(same(visibleAt(s, 2), ['bg', 'a', 'b', 'c']), 'click 2 brings b and c in together')
  ok(same(visibleAt(s, 99), ['bg', 'a', 'b', 'c']), 'visibleAt clamps past the last click')
  ok(same(visibleAt(s, -3), ['bg']), 'visibleAt clamps below zero')
  const v = slideAtStep(s, 1)
  ok(v.elements.map((e) => e.id).join() === 'bg,a', 'slideAtStep keeps only what is visible')
  ok(s.elements.length === 4 && v !== s, 'slideAtStep copies — the model is untouched')
  const none = slideOf([text('x'), text('y')])
  ok(slideAtStep(none, 5) === none && stepCount(none) === 0, 'a slide with no builds is returned as-is')
  ok(JSON.stringify(stepsOf(plan, 'b')) === '{"enter":2,"exit":0}', 'stepsOf reports the compressed click')
}

// -------------------------------------------------------------------- order
{
  const s = slideOf([text('a', 'a', { order: 3 }), text('b', 'b', { order: 1, step: 1 })])
  ok(stepCount(s) === 1, '`order` alone never makes a click — it only staggers within one')
}

// ---------------------------------------------------------------------- exits
{
  const s = slideOf([text('a', 'a', { exitStep: 2 }), text('b', 'b', { step: 1, exitStep: 3 })])
  const plan = buildPlan(s)
  ok(plan.steps.length === 3, 'exits make clicks too (1 brings b, 2 takes a out, 3 takes b out)')
  ok(plan.steps[1].exit[0].elId === 'a', 'click 2 exits a')
  ok(same(visibleAt(s, 0), ['a']), 'a is with the slide, b waits')
  ok(same(visibleAt(s, 1), ['a', 'b']), 'click 1: a and b')
  ok(same(visibleAt(s, 2), ['b']), 'click 2: a has left')
  ok(same(visibleAt(s, 3), []), 'click 3: everything has left')
  ok(slideAtStep(s, 2).elements.map((e) => e.id).join() === 'b', 'an exited element is not in the slide at that step (it must not morph out)')
  const bad = slideOf([text('x', 'x', { step: 2, exitStep: 2 }), text('y', 'y', { step: 3, exitStep: 1 })])
  ok(!buildPlan(bad).steps.some((s) => s.exit.length), 'an exit at or before the entrance is ignored')
  ok(same(visibleAt(bad, 99), ['x', 'y']), '…so those elements simply stay')
}

// ------------------------------------------------------------- paragraph builds
{
  const html = '<div>one</div><div>two</div><div><br></div><div>three</div>'
  const s = slideOf([text('t', html, { byParagraph: true })])
  const plan = buildPlan(s)
  ok(plan.paragraphs.get('t') === 3, 'three real paragraphs')
  ok(plan.steps.length === 3, 'by default paragraph k arrives on click 1 + k')
  ok(plan.steps[0].enter[0].para === 0 && plan.steps[2].enter[0].para === 2, 'targets carry the paragraph index')
  ok(same(visibleAt(s, 0), ['t']), 'at click 0 the box is there with no paragraph shown')
  ok(same(visibleAt(s, 2), ['t', 't#0', 't#1']), 'click 2: two paragraphs')
  ok(same(visibleAt(s, 3), ['t', 't#0', 't#1', 't#2']), 'click 3: all three')

  const start2 = slideOf([text('t', html, { byParagraph: true, step: 2 })])
  ok(buildPlan(start2).steps.map((x) => x.at).join() === '2,3,4', 'step 2 + byParagraph: paragraphs on clicks 2, 3, 4')

  const first0 = slideOf([text('t', html, { byParagraph: true, step: 0 })])
  ok(same(visibleAt(first0, 0), ['t', 't#0']), 'step 0 + byParagraph: the first paragraph is with the slide')
  ok(stepCount(first0) === 2, '…and the rest take a click each')

  const gone = slideOf([text('t', html, { byParagraph: true, exitStep: 3 })])
  const gp = buildPlan(gone)
  ok(gp.steps.length === 3 && gp.steps[2].exit[0].elId === 't', 'the box can exit once its paragraphs have arrived')
  ok(!gp.steps.some((x) => x.enter.some((e) => e.para === 2)), 'a paragraph that would arrive after the box has left costs no click')
  ok(same(visibleAt(gone, 3), []), 'after the exit nothing of it remains, paragraphs included')

  const wrongType = slideOf([{ ...text('i'), type: 'shape', fx: { byParagraph: true } } as unknown as SlideElement])
  ok(stepCount(wrongType) === 0, 'byParagraph on a non-text element does nothing')
}

// --------------------------------------------------------------- exclusions
{
  const s = slideOf([
    text('hov', 'h', { step: 1 }, { showOnHover: 'g' }),
    text('hid', 'x', { step: 2 }, { hidden: true }),
    text('real', 'r', { step: 1 }),
  ])
  const plan = buildPlan(s)
  ok(plan.steps.length === 1 && plan.steps[0].enter.map((t) => t.elId).join() === 'real', 'hover-set members and hidden elements take no part in builds')
  ok(slideAtStep(s, 0).elements.map((e) => e.id).sort().join() === 'hid,hov', 'they are neither hidden by the plan nor revealed by it (hover/hidden own them)')
}

// ---------------------------------------------------------------- validate
{
  const base = (els: SlideElement[], prev?: SlideElement[]) => ({
    format: 'beeslides/slides', version: '1.0.0', docId: 't', title: 't',
    size: { width: 1280, height: 720 }, theme: { accent: '#F7A600', fontFamily: 'system-ui' }, assets: {}, fonts: null,
    slides: [
      ...(prev ? [{ id: 's0', background: '#fff', transition: 'none', notes: '', elements: prev }] : []),
      { id: 's1', background: '#fff', transition: prev ? 'morph' : 'none', notes: '', elements: els },
    ],
  }) as any
  const codes = (d: any) => validateDoc(d, { measure: false }).findings.map((f) => f.code)
  ok(!codes(base([text('a', 'a', { step: 1 })])).some((c) => /step|paragraph/.test(c)), 'a plain step is clean')
  ok(codes(base([text('a', 'a', { step: 2, exitStep: 2 })])).includes('exit-before-enter'), 'exitStep <= step warns')
  ok(codes(base([{ ...text('a'), type: 'shape', fx: { byParagraph: true } } as any])).includes('by-paragraph-not-text'), 'byParagraph on a non-text element warns')
  ok(codes(base([text('a', 'a', { step: 1 })], [text('a')])).includes('step-on-morph'), 'a step on an element that morphs in warns')
  ok(codes(base([text('a', 'a', { step: 1.5 })])).includes('bad-step'), 'a fractional step warns')
  ok(codes(base([text('a', 'a', { loop: { type: 'pulse' }, ambient: 'kenburns' })])).includes('loop-scale-clash'), 'pulse + Ken Burns warns (both drive scale)')
  ok(!codes(base([text('a', 'a', { loop: { type: 'spin', duration: 4, amount: -360, delay: 1 } })])).some((c) => c === 'unknown-key'), 'the generic loop keys are known to validate')
  const gifDoc = base([text('a', 'a', { step: 1 })]); gifDoc.slides[0].autoBuild = { every: 0 }
  ok(codes(gifDoc).includes('bad-auto-build'), 'autoBuild.every <= 0 warns')
  const gifOk = base([text('a', 'a', { step: 1 })]); gifOk.slides[0].autoBuild = { every: 2, hold: 1, loop: true }; gifOk.slides[0].advanceAfter = 5; gifOk.present = { autoAdvance: 8, loop: true }
  ok(!codes(gifOk).some((c) => c === 'unknown-key' || c === 'bad-auto-build'), 'autoBuild / advanceAfter / present.autoAdvance+loop are known keys')
  ok(!codes(base([text('a', 'a', { step: 1, exit: 'fade', exitStep: 2, exitDur: 0.3, byParagraph: false })])).includes('unknown-key'), 'the new fx keys are known to validate')
}

// ------------------------------------------------- survives load (untrusted.ts)
{
  const doc = newDoc()
  const fx = { step: 2, exitStep: 4, exit: 'slide-left', exitDur: 0.4, byParagraph: true } as const
  doc.slides = [slideOf([text('a', '<div>x</div><div>y</div>', { ...fx, loop: { type: 'wiggle', duration: 1, amount: 5, delay: 0.5 } })])]
  doc.slides[0].autoBuild = { every: 2, hold: 1, loop: true }
  doc.slides[0].advanceAfter = 7
  const back = parseDoc(JSON.stringify(doc))
  ok(JSON.stringify(back?.slides[0].elements[0].fx) === JSON.stringify({ ...fx, loop: { type: 'wiggle', duration: 1, amount: 5, delay: 0.5 } }), 'the build + loop fx keys survive parseDoc\'s untrusted-input filter')
  ok(JSON.stringify(back?.slides[0].autoBuild) === '{"every":2,"hold":1,"loop":true}' && back?.slides[0].advanceAfter === 7, 'autoBuild / advanceAfter survive it too')
}

// ------------------------------------------------------------------ editing ops
{
  const steps = (s: Slide) => s.elements.map((e) => `${e.id}:${e.fx?.step ?? '-'}/${e.fx?.exitStep ?? '-'}`).join(' ')
  const gappy = slideOf([text('a', 'a', { step: 2 }), text('b', 'b', { step: 5, exitStep: 9 }), text('c', 'c')])
  normalizeSteps(gappy)
  ok(steps(gappy) === 'a:1/- b:2/3 c:-/-', `normalizeSteps closes gaps (${steps(gappy)})`)

  const s = slideOf([text('a', 'a', { step: 1 }), text('b', 'b', { step: 2 }), text('c', 'c', { step: 3 })])
  setEnterClick(s, 'c', 1)
  ok(steps(s) === 'a:1/- b:2/- c:1/-', `moving c to click 1 joins a (${steps(s)})`)
  setEnterClick(s, 'a', 0)
  ok(steps(s) === 'a:-/- b:2/- c:1/-' && !s.elements[0].fx, `moving a to "with slide" clears its step and its empty fx (${steps(s)})`)
  setEnterClick(s, 'b', 99)
  ok(steps(s) === 'a:-/- b:2/- c:1/-', `b to a click past the end is the NEW last click — here it already was (${steps(s)})`)

  const e = slideOf([text('a', 'a', { step: 1, exitStep: 2, exit: 'fade-up' })])
  setEnterClick(e, 'a', 2)
  ok(e.elements[0].fx?.step === 1 && e.elements[0].fx?.exitStep === 2, 'a lone element: clicks compress, so "click 2" is the new last click, i.e. 1/2 stays')
  const e2 = slideOf([text('a', 'a', { step: 1, exitStep: 2 }), text('b', 'b', { step: 3 })])
  setEnterClick(e2, 'a', 3)
  ok(steps(e2) === 'a:1/2 b:1/-', `moving a past its exit pushes the exit after it, then clicks compress (${steps(e2)})`)
  const keepExit = slideOf([text('a', 'a', { step: 1, exitStep: 3, exit: 'slide-left', exitDur: 0.4 }), text('b', 'b', { step: 2 })])
  setExitClick(keepExit, 'a', 0)
  ok(!keepExit.elements[0].fx?.exitStep && !keepExit.elements[0].fx?.exit && !keepExit.elements[0].fx?.exitDur, 'Never clears exitStep, exit and exitDur together')
  setExitClick(keepExit, 'a', 1)
  ok(keepExit.elements[0].fx?.exitStep === 2, 'an exit is always kept after the entrance')

  const sw = slideOf([text('a', 'a', { step: 1 }), text('b', 'b', { step: 2, exitStep: 3 }), text('c', 'c', { step: 3 })])
  swapClicks(sw, 1, 2)
  ok(steps(sw) === 'a:2/- b:1/3 c:3/-', `swapClicks swaps whole clicks (${steps(sw)})`)

  const mg = slideOf([text('a', 'a', { step: 1 }), text('b', 'b', { step: 2 }), text('c', 'c', { step: 3 })])
  mergeClickIntoPrevious(mg, 2)
  ok(steps(mg) === 'a:1/- b:1/- c:2/-', `merging click 2 into click 1 renumbers the rest (${steps(mg)})`)
  mergeClickIntoPrevious(mg, 1)
  ok(steps(mg) === 'a:-/- b:-/- c:1/-', `merging click 1 folds into "with the slide" (${steps(mg)})`)

  const para = slideOf([text('t', '<div>a</div><div>b</div>', { byParagraph: true }), text('x', 'x', { step: 2 })])
  const pp = buildPlan(para)
  ok(clickHasParagraphs(pp, 1) && clickHasParagraphs(pp, 2), 'paragraph clicks are recognised')
  setEnterClick(para, 't', 2)
  ok(para.elements[0].fx?.step === 1 && buildPlan(para).steps.length === 2 && buildPlan(para).steps[0].enter.length === 2, 'moving a paragraph box onto x\'s click moves its whole run there (and click 1, now empty, compresses away)')
  setEnterClick(para, 't', 0)
  ok(para.elements[0].fx?.step === 0 && visibleAt(para, 0).has('t#0'), 'to "with slide" a paragraph box keeps an explicit step 0 (first paragraph with the slide)')
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall builds checks passed')
