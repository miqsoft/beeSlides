#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Grid & Snap (DECISIONS 2026-10-13): the pure parts — the deck's layout grid
// and guides (slides/src/layoutgrid.ts), the snap math (editor/snapping.ts)
// and the viewer preference (editor/gridpref.ts).
//
//   slides/node_modules/.bin/esbuild scripts/test-grid-snap.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-grid-snap.mjs
//   node $TMPDIR/test-grid-snap.mjs
//
// The canvas side (Moveable drags, guide dragging, the panel) is browser-only;
// it was verified with real mouse input against a dev server — see the
// DECISIONS entry for what that covered.

import { defaultLayoutGrid, layoutLines, layoutTracks, normalizeGuides, normalizeLayoutGrid, parseSpan, setGuide, spanRect } from '../slides/src/layoutgrid.ts'
import { axisCaught, gridSnapSpan, snapPoint, staticSnapLines } from '../slides/src/editor/snapping.ts'
import { fittingSteps, formatLength, fromUnit, loadGridPref, toUnit, type GridPref } from '../slides/src/editor/gridpref.ts'
import { newDoc } from '../slides/src/model.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.log(`  FAIL  ${message}`) }
}
const near = (a: number, b: number, eps = 0.051) => Math.abs(a - b) <= eps
const size = { width: 1280, height: 720 }

console.log('-- layout grid --')
{
  const g = defaultLayoutGrid(size)
  ok(JSON.stringify(g) === '{"columns":12,"rows":0,"gutter":24,"marginX":96,"marginY":64}', 'default: 12 columns, 24 gutter, the safe-zone side margin')
  ok(defaultLayoutGrid({ width: 1920, height: 1080 }).marginX === 144, 'default scales with the page')
  const { columns, rows } = layoutTracks(g, size)
  ok(columns.length === 12 && rows.length === 0, 'tracks: 12 columns, no rows')
  ok(columns[0].start === 96 && near(columns[11].start + columns[11].size, 1184), 'tracks: from margin to margin')
  ok(columns.every((c) => near(c.size, 68.7)), 'tracks: equal widths')
  ok(near(columns[1].start - (columns[0].start + columns[0].size), 24), 'tracks: the gutter between')
  const lines = layoutLines({ ...g, rows: 2 }, size)
  ok(lines.x.length === 24 && lines.x[0] === 96 && lines.x[lines.x.length - 1] === 1184, 'lines: every column edge, sorted, margins included')
  ok(lines.y.includes(64) && lines.y.includes(656) && lines.y.length === 4, 'lines: rows add their edges (margins shared)')
  ok(layoutLines(g, size).y.join() === '64,656', 'lines: without rows, the top and bottom margins still snap')
}
{
  ok(normalizeLayoutGrid(undefined, size) === null && normalizeLayoutGrid({ columns: 0 }, size) === null, 'normalize: absent / no columns = none')
  const n = normalizeLayoutGrid({ columns: 99, rows: -3, gutter: -5, marginX: 5000, marginY: 'x' }, size)!
  ok(n.columns === 24 && n.rows === 0 && n.gutter === 0 && n.marginX === 639 && n.marginY === 0, `normalize: clamped (${JSON.stringify(n)})`)
  const tight = layoutTracks({ columns: 24, gutter: 400, marginX: 600, marginY: 0 }, size).columns
  ok(tight.every((c) => c.size >= 1 - 1e-9), 'a huge gutter never makes a track narrower than 1 px')
}
{
  const g = defaultLayoutGrid(size)
  const r = spanRect(g, size, [7, 12])
  ok(near(r.x, 652) && near(r.x + r.w, 1184) && r.y === 64 && r.h === 592, `span 7-12: the right half of the content area (${JSON.stringify(r)})`)
  ok(JSON.stringify(spanRect(g, size, [12, 7])) === JSON.stringify(r), 'span: reversed order is the same span')
  const c = spanRect(g, size, [0, 99])
  ok(c.x === 96 && near(c.x + c.w, 1184), 'span: out-of-range picks are clamped')
  const rr = spanRect({ ...g, rows: 3 }, size, [1, 6], [2, 3])
  ok(rr.y > 64 && near(rr.y + rr.h, 656), `span with rows 2-3: bottom two thirds (${JSON.stringify(rr)})`)
  ok(JSON.stringify(parseSpan('columns 7-12')) === '{"cols":[7,12]}', 'parseSpan: "columns 7-12"')
  ok(JSON.stringify(parseSpan('Cols 3')) === '{"cols":[3,3]}', 'parseSpan: "Cols 3"')
  ok(JSON.stringify(parseSpan('columns 1 to 6, rows 2–3')) === '{"cols":[1,6],"rows":[2,3]}', 'parseSpan: with rows, "to" and an en dash')
  ok(parseSpan('space') === null && parseSpan('bounds') === null && parseSpan('col-1') === null, 'parseSpan: other within values are not spans')
}

console.log('-- guides --')
{
  ok(JSON.stringify(normalizeGuides({ x: [300, 100, 100.04, -5, 2000, 'x'], y: [50] }, size)) === '{"x":[100,300],"y":[50]}', 'normalize: on the page, sorted, de-duplicated')
  const doc = newDoc()
  setGuide(doc, 'x', null, 640)
  setGuide(doc, 'x', null, 320.04)
  ok(JSON.stringify(doc.guides) === '{"x":[320,640]}', `add: rounded to 0.1 px (${JSON.stringify(doc.guides)})`)
  setGuide(doc, 'x', 320, 330)
  ok(JSON.stringify(doc.guides) === '{"x":[330,640]}', 'move')
  setGuide(doc, 'y', null, 9999)
  ok(doc.guides?.y === undefined, 'a guide off the page is not added')
  setGuide(doc, 'x', 330, null)
  setGuide(doc, 'x', 640, null)
  ok(doc.guides === undefined, 'removing the last guide drops the field')
}

console.log('-- snapping --')
{
  ok(gridSnapSpan(103, 130, 20) === 100, 'grid: the start lands on the nearest line (103 → 100)')
  ok(gridSnapSpan(137, 130, 20) === 135, 'grid: the CENTER lands when it is nearest (137+65=202 → 200)')
  ok(gridSnapSpan(108, 130, 20) === 110, 'grid: the END lands when it is nearest (108+130=238 → 240)')
  ok(gridSnapSpan(100, 200, 20) === 100, 'grid: a box that fits the grid keeps every edge on it')
  ok(gridSnapSpan(37.3, 50, 0) === 37.3, 'grid: step 0 = unchanged')
  ok(gridSnapSpan(3, 10, 10, 5) === 5, 'grid: origin shifts the lines')
  const lines = { x: [645], y: [] as number[] }
  ok(JSON.stringify(snapPoint({ x: 641, y: 33 }, lines, 6, 20)) === '{"x":645,"y":40}', 'point: a magnetic line within reach beats the grid; the other axis takes the grid')
  ok(JSON.stringify(snapPoint({ x: 630, y: 33 }, lines, 6, 0)) === '{"x":630,"y":33}', 'point: out of reach and no grid = unchanged')
  ok(snapPoint({ x: 641, y: 0 }, { x: [640, 643], y: [] }, 6, 0).x === 640, 'point: the nearest line wins')
  ok(axisCaught(645, 643) && !axisCaught(100.1, 100), 'axisCaught: a real pull vs float noise')
}
{
  const doc = newDoc()
  doc.guides = { x: [500], y: [200] }
  doc.layoutGrid = { columns: 2, rows: 0, gutter: 20, marginX: 100, marginY: 50 }
  const base: GridPref = { ...loadGridPref() }
  const all = staticSnapLines(doc, base, { pageless: false })
  ok(all.x.includes(500) && all.x.includes(100) && all.x.includes(96) && all.x.includes(1184), `lines: guides + columns + safe-zone margins (${all.x.join(',')})`)
  ok(all.y.includes(200) && all.y.includes(50) && all.y.includes(670), 'lines: horizontal guide + top/bottom margins')
  const hidden = staticSnapLines(doc, { ...base, showGuides: false, showLayout: false }, { pageless: false })
  ok(hidden.x.join() === '96,100,1180,1184' && hidden.y.join() === '50,670', `lines: hidden guides and column lines do not snap, the template borders still do (${hidden.x.join()} / ${hidden.y.join()})`)
  const unticked = staticSnapLines(doc, { ...base, snap: { ...base.snap, guides: false, layout: false, margins: false } }, { pageless: false })
  ok(unticked.x.length === 0, 'lines: shown but Snap unticked = no lines')
  ok(staticSnapLines(doc, base, { pageless: true }).x.length === 0, 'lines: a reusable object has no page lines')
}

console.log('-- preference & units --')
{
  const p = loadGridPref() // no localStorage in node → the defaults
  ok(p.on === false && p.slideStepPx === 20 && p.unit === 'px' && p.showLayout && p.showGuides, 'defaults')
  ok(Object.values(p.snap).every(Boolean), 'defaults: every snap target on')
  ok(fittingSteps(size).join() === '5,8,10,16,20,40,80', `fitting steps for 1280×720 divide it exactly (${fittingSteps(size).join()})`)
  ok(fittingSteps({ width: 1920, height: 1080 }).includes(120) && fittingSteps({ width: 1920, height: 1080 }).every((s) => 1920 % s === 0 && 1080 % s === 0), 'fitting steps for 1920×1080')
  ok(fittingSteps({ width: 1279, height: 719 }).join() === '10,20,40,80', 'an odd page falls back to the plain presets')
  ok(near(fromUnit(1, 'cm'), 37.795, 0.001) && near(toUnit(96, 'in'), 1) && near(toUnit(96, 'pt'), 72), 'units: cm, in, pt at 96 dpi')
  ok(formatLength(20, 'px') === '20 px' && formatLength(fromUnit(0.5, 'cm'), 'cm') === '0.5 cm' && formatLength(37.795, 'mm') === '10 mm', 'formatLength: trims trailing zeros')
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`)
if (failures) process.exit(1)
