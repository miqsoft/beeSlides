#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Slide-type tree moves — the model half of the Layout Manager's
// Slide Master–style sidebar (docs/DECISIONS.md 2026-09-23).
//
//   node scripts/test-slide-type-tree.mjs
//
// WHAT THIS PROVES. The sidebar's drag-and-drop reorders AND reparents
// (`moveSlideTypeInTree`), refuses cycles, carries a moved type's subtree
// with it, and resyncs linked slides explicitly (`resyncLinkedSlides` —
// editor.ts's own resync only watches the open surface). "Detach from
// parent" (`detachSlideType`) must leave the effective look untouched. And
// the sidebar's rows must come out in TRUE depth-first order
// (`slideTypeRows`) — the old tree rendered all siblings of a level before
// any of their children, so with roots A, B and A's child A1 it showed
// A, B, A1 and A1 read as B's child.

import {
  slideTypeRows, moveSlideTypeInTree, isDescendantOf, detachSlideType,
  resyncLinkedSlides, effectiveLayout, layoutElementIds, removeLayout,
} from '../slides/src/model.ts'

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const rect = (id, fill = '#000') => ({
  id, type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1,
  fill, stroke: 'none', strokeWidth: 0, radius: 0,
})
const ly = (id, parentId, elements = [], background = '#fff') => ({
  id, name: id, background, transition: 'fade', notes: '', elements, ...(parentId ? { parentId } : {}),
})
function makeDoc(layouts, slides = []) {
  return {
    format: 'beeslides/slides', version: 1, docId: 'd', title: 't',
    size: { width: 1280, height: 720 },
    theme: { background: '#fff', color: '#000', accent: '#f00', fontFamily: 'Arial' },
    slides, layouts,
  }
}
const order = (doc) => slideTypeRows(doc).map((r) => `${'  '.repeat(r.depth)}${r.layout.id}`).join(' / ')
const ids = (doc) => doc.layouts.map((l) => l.id).join(',')

// ---- depth-first rows --------------------------------------------------------
console.log('\nslideTypeRows — true depth-first order')
{
  const doc = makeDoc([ly('A'), ly('B'), ly('A1', 'A')])
  ok(order(doc) === 'A /   A1 / B', `A/B/A1 renders as A, A1 (indented), B — got "${order(doc)}"`)
  const deep = makeDoc([ly('R'), ly('C2', 'R'), ly('C1', 'R'), ly('G', 'C2'), ly('S')])
  ok(order(deep) === 'R /   C2 /     G /   C1 / S', `3 levels, siblings in array order — got "${order(deep)}"`)
  const cyc = makeDoc([ly('A'), ly('X', 'Y'), ly('Y', 'X'), ly('D', 'gone'), ly('D1', 'D')])
  const rows = slideTypeRows(cyc)
  ok(rows.length === 5, 'cycle + dangling-parent entries are still listed (no row lost)')
  ok(order(cyc) === 'A / D /   D1 / X / Y', `dangling parent shows as a root with its subtree; cycle members last — got "${order(cyc)}"`)
}

// ---- moveSlideTypeInTree ---------------------------------------------------
console.log('\nmoveSlideTypeInTree')
{
  const doc = makeDoc([ly('A'), ly('B'), ly('C')])
  ok(moveSlideTypeInTree(doc, 'C', undefined, 'A') && ids(doc) === 'C,A,B', 'reorder among roots: C before A')
  ok(moveSlideTypeInTree(doc, 'C', undefined) && ids(doc) === 'A,B,C', 'no beforeId → last root')
}
{
  const doc = makeDoc([ly('A'), ly('A1', 'A'), ly('A2', 'A'), ly('B')])
  ok(moveSlideTypeInTree(doc, 'B', 'A') && doc.layouts.find((l) => l.id === 'B').parentId === 'A', 'reparent root B under A')
  ok(order(doc) === 'A /   A1 /   A2 /   B', `…placed after A's last existing child — got "${order(doc)}"`)
  ok(moveSlideTypeInTree(doc, 'B', 'A', 'A1') && order(doc) === 'A /   B /   A1 /   A2', 'beforeId A1 → first child')
  ok(moveSlideTypeInTree(doc, 'A2', undefined) && !('parentId' in doc.layouts.find((l) => l.id === 'A2')), 'move to root deletes parentId')
  ok(order(doc) === 'A /   B /   A1 / A2', `…and lands after the last root — got "${order(doc)}"`)
}
{
  const doc = makeDoc([ly('P'), ly('Q'), ly('Q1', 'Q')])
  ok(moveSlideTypeInTree(doc, 'P', 'Q1') && order(doc) === 'Q /   Q1 /     P', 'under a childless parent: placed right after it')
}
{
  const doc = makeDoc([ly('A'), ly('A1', 'A'), ly('A11', 'A1'), ly('B')])
  const before = JSON.stringify(doc)
  ok(!moveSlideTypeInTree(doc, 'A', 'A11'), 'refuses moving A under its own grandchild (cycle)')
  ok(!moveSlideTypeInTree(doc, 'A', 'A'), 'refuses moving A under itself')
  ok(!moveSlideTypeInTree(doc, 'A', 'nope'), 'refuses an unknown parent')
  ok(JSON.stringify(doc) === before, 'refused moves leave the doc untouched')
  ok(isDescendantOf(doc, 'A11', 'A') && !isDescendantOf(doc, 'A', 'A11') && !isDescendantOf(doc, 'B', 'A'), 'isDescendantOf')
  ok(moveSlideTypeInTree(doc, 'A1', 'B') && order(doc) === 'A / B /   A1 /     A11', `subtree follows: A1 (with A11) under B — got "${order(doc)}"`)
}

// ---- resyncLinkedSlides ----------------------------------------------------
console.log('\nresyncLinkedSlides — a reparent reaches linked slides')
{
  const doc = makeDoc(
    [ly('Corp', undefined, [rect('corp-bar', '#f00')], '#fff'), ly('Alt', undefined, [rect('alt-bar', '#00f')], '#eee'),
      ly('Content', 'Corp', [rect('content-box')])],
    [],
  )
  // A slide born from Content (instantiate keeps element ids).
  const slide = { id: 's1', layoutId: 'Content', background: '#fff', transition: 'fade', notes: '',
    elements: JSON.parse(JSON.stringify(effectiveLayout(doc, doc.layouts[2]).elements)) }
  doc.slides.push(slide)
  ok(slide.elements.some((e) => e.id === 'corp-bar'), 'fixture: slide starts with Corp chrome')
  moveSlideTypeInTree(doc, 'Content', 'Alt')
  ok(resyncLinkedSlides(doc, 'Content', layoutElementIds(doc)), 'resync reports a change')
  const got = slide.elements.map((e) => e.id).join(',')
  ok(got === 'alt-bar,content-box', `linked slide now shows Alt chrome, Corp chrome dropped — got "${got}"`)
  // effectiveLayout composites ancestor ELEMENTS only; background stays the
  // slide type's own (Content's '#fff'), exactly as before the move.
  ok(slide.background === '#fff', 'background still comes from the slide’s own type')
}

// ---- detachSlideType -------------------------------------------------------
console.log('\ndetachSlideType — keeps the look')
{
  const doc = makeDoc([ly('R', undefined, [rect('r1')]), ly('M', 'R', [rect('m1')]), ly('L', 'M', [rect('l1')])])
  const leaf = () => doc.layouts.find((l) => l.id === 'L')
  const before = JSON.stringify(effectiveLayout(doc, leaf()).elements)
  detachSlideType(doc, 'L')
  ok(!('parentId' in leaf()), 'parentId removed')
  ok(JSON.stringify(effectiveLayout(doc, leaf()).elements) === before, 'effective elements unchanged (whole chain baked in, in order)')
  ok(slideTypeRows(doc).map((r) => r.layout.id).join(',') === 'R,M,L', 'detached type stays right after its former family')
  const doc2 = makeDoc([ly('R'), ly('M', 'R'), ly('M1', 'M'), ly('S')])
  detachSlideType(doc2, 'M')
  ok(order(doc2) === 'R / M /   M1 / S', `detached type keeps its own children and lands before the next root — got "${order(doc2)}"`)
  const rootBefore = JSON.stringify(doc.layouts[0])
  detachSlideType(doc, 'R')
  ok(JSON.stringify(doc.layouts[0]) === rootBefore, 'detaching a root is a no-op')
}
{
  // removeLayout still bakes through the shared helper.
  const doc = makeDoc([ly('R', undefined, [rect('r1')]), ly('C', 'R', [rect('c1')])])
  removeLayout(doc, 'R')
  ok(doc.layouts[0].elements.map((e) => e.id).join(',') === 'r1,c1' && !doc.layouts[0].parentId, 'removeLayout bakes the parent into its child')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
