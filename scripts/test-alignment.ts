#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Align / distribute rig (slides/src/alignment.ts) — the editor's Arrange
// kit: groups as one object, align to the selection or to the slide (as a
// block), distribute between themselves or across the slide.
//
//   slides/node_modules/.bin/esbuild scripts/test-alignment.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-alignment.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node $TMPDIR/test-alignment.mjs
//
// (bundled because model.ts uses extensionless imports)

import type { SlideElement } from '../slides/src/model.ts'
import {
  alignUnits, applyMoves, effectiveRef, planAlign, planCenterOnSlide, planDistribute,
  type AlignEdge, type AlignRef, type DistributeOpts,
} from '../slides/src/alignment.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

const SLIDE = { width: 1280, height: 720 }
type Spec = { id: string; x: number; y: number; w: number; h: number; groupId?: string; parentId?: string }
const el = (s: Spec) => ({ type: 'shape', ...s }) as unknown as SlideElement
const frames = (els: SlideElement[]) => Object.fromEntries(els.map((e) => [e.id, [e.x, e.y]]))
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

function align(els: SlideElement[], edge: AlignEdge, ref: AlignRef) {
  const units = alignUnits(els)
  applyMoves(units, planAlign(units, edge, ref, SLIDE))
}
function distribute(els: SlideElement[], axis: 'x' | 'y', ref: AlignRef, opts?: DistributeOpts): boolean {
  const units = alignUnits(els)
  const moves = planDistribute(units, axis, effectiveRef(units, ref), SLIDE, opts)
  if (!moves) return false
  applyMoves(units, moves)
  return true
}

console.log('units')
{
  const els = [
    el({ id: 'a', x: 0, y: 0, w: 10, h: 10, groupId: 'g' }),
    el({ id: 'b', x: 50, y: 0, w: 10, h: 10, groupId: 'g' }),
    el({ id: 'c', x: 200, y: 0, w: 10, h: 10 }),
    el({ id: 'box', x: 400, y: 0, w: 100, h: 100 }),
    el({ id: 'kid', x: 410, y: 10, w: 10, h: 10, parentId: 'box' }),
  ]
  const units = alignUnits(els)
  ok(units.length === 3, 'a group is one unit, a container\'s child rides with it (3 units)')
  ok(units[0].box.x === 0 && units[0].box.w === 60, 'a group\'s box is the union of its members')
  ok(effectiveRef(alignUnits([els[0], els[1]]), 'selection') === 'slide', 'one group alone aligns to the slide')
}

console.log('align to the selection')
{
  const els = [
    el({ id: 'a', x: 100, y: 0, w: 50, h: 10 }),
    el({ id: 'b', x: 300, y: 0, w: 100, h: 10 }),
  ]
  align(els, 'left', 'selection')
  ok(els.every((e) => e.x === 100), 'left: both at the leftmost edge')
  align(els, 'right', 'selection')
  ok(els[0].x === 150 && els[1].x === 100, 'right: right edges meet at the rightmost (200)')
  const g = [
    el({ id: 'g1', x: 500, y: 100, w: 20, h: 20, groupId: 'g' }),
    el({ id: 'g2', x: 600, y: 200, w: 20, h: 20, groupId: 'g' }),
    el({ id: 'z', x: 0, y: 0, w: 20, h: 20 }),
  ]
  align(g, 'left', 'selection')
  ok(g[0].x === 0 && g[1].x === 100, 'a group keeps its shape (moves as one: 500/600 → 0/100)')
  align(g, 'top', 'selection')
  ok(g[0].y === 0 && g[1].y === 100 && g[2].y === 0, 'top: group top meets the topmost element')
}

console.log('align to the slide')
{
  const one = [el({ id: 'a', x: 100, y: 100, w: 200, h: 100 })]
  align(one, 'centerX', 'selection')
  ok(one[0].x === 540, 'one element aligns to the slide even with ref = selection')
  const two = [
    el({ id: 'a', x: 100, y: 100, w: 100, h: 50 }),
    el({ id: 'b', x: 300, y: 200, w: 100, h: 50 }),
  ]
  align(two, 'right', 'slide')
  ok(two[0].x === 980 && two[1].x === 1180, 'right to slide: the block moves, spacing kept (rightmost at 1280)')
  align(two, 'bottom', 'slide')
  ok(two[1].y === 670 && two[0].y === 570, 'bottom to slide: the block\'s bottom lands on 720')
  const before = frames(two)
  align(two, 'right', 'slide')
  ok(JSON.stringify(frames(two)) === JSON.stringify(before), 'aligning again is a no-op')
}

console.log('center on slide')
{
  const els = [
    el({ id: 'a', x: 0, y: 0, w: 100, h: 100 }),
    el({ id: 'b', x: 200, y: 50, w: 100, h: 100 }),
  ]
  const units = alignUnits(els)
  applyMoves(units, planCenterOnSlide(units, SLIDE))
  ok(els[0].x === 490 && els[1].x === 690, 'block centred horizontally (union 300 wide → 490)')
  ok(els[0].y === 285 && els[1].y === 335, 'block centred vertically (union 150 high → 285)')
}

console.log('distribute between themselves')
{
  const els = [
    el({ id: 'a', x: 0, y: 0, w: 100, h: 10 }),
    el({ id: 'b', x: 120, y: 0, w: 100, h: 10 }),
    el({ id: 'c', x: 500, y: 0, w: 100, h: 10 }),
  ]
  ok(!distribute(els.slice(0, 2), 'x', 'selection'), 'two objects: nothing to distribute between themselves')
  distribute(els, 'x', 'selection')
  ok(els[0].x === 0 && els[1].x === 250 && els[2].x === 500, 'edges: first/last stay, middle centred in the gap')
  distribute(els, 'x', 'selection', { gap: 10 })
  ok(els[1].x === 110 && els[2].x === 220, 'fixed gap cascades from the first')
  const g = [
    el({ id: 'g1', x: 0, y: 0, w: 50, h: 10, groupId: 'g' }),
    el({ id: 'g2', x: 60, y: 0, w: 40, h: 10, groupId: 'g' }),
    el({ id: 'm', x: 110, y: 0, w: 100, h: 10 }),
    el({ id: 'r', x: 700, y: 0, w: 100, h: 10 }),
  ]
  distribute(g, 'x', 'selection')
  ok(g[0].x === 0 && g[1].x === 60, 'a group at the start stays whole')
  ok(g[2].x === 350 && g[3].x === 700, 'the group counts as one box (gaps 250/250)')
}

console.log('distribute across the slide')
{
  const two = [
    el({ id: 'a', x: 0, y: 0, w: 100, h: 10 }),
    el({ id: 'b', x: 150, y: 0, w: 100, h: 10 }),
  ]
  ok(distribute(two, 'x', 'slide'), 'two objects can be spread across the slide')
  const gap = (1280 - 200) / 3
  ok(near(two[0].x, gap) && near(two[1].x, gap * 2 + 100), 'equal space before, between and after')
  const one = [el({ id: 'a', x: 0, y: 0, w: 100, h: 100 })]
  distribute(one, 'y', 'selection')
  ok(one[0].y === 310, 'one object across the slide = centred on that axis')
  const three = [
    el({ id: 'a', x: 0, y: 0, w: 100, h: 10 }),
    el({ id: 'b', x: 10, y: 0, w: 100, h: 10 }),
    el({ id: 'c', x: 20, y: 0, w: 100, h: 10 }),
  ]
  distribute(three, 'x', 'slide', { mode: 'center' })
  ok(three.every((e, i) => near(e.x + 50, 1280 * (i + 1) / 4)), 'centers: centres at quarters of the slide')
  distribute(three, 'x', 'slide', { gap: 20 })
  ok(near(three[0].x, (1280 - 340) / 2) && near(three[2].x + 100, 1280 - (1280 - 340) / 2), 'fixed gap: the run is centred on the slide')
  ok(three[0].y === 0, 'distribute never moves the other axis')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
