#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// charts-lite stacks, horizontal bars, axis names and live-mount cleanup —
// kernel/src/charts.ts.
//
//   node scripts/test-chart-stack.ts
//
// Three layers:
//
//   1. The pure helpers (stackBars: slots + [from, to] spans; stackLines: the
//      same piles for line/area series; barExtent: one bar's pixel extent),
//      pinned value by value.
//   2. The real renderer, chartSnapshotSvg, under a ~30-line DOM shim (the
//      engine only ever calls createElementNS / setAttribute / appendChild /
//      style / textContent). Every chart sets an explicit grid and value
//      range, so each bar's rectangle is computable on paper:
//        w 400 × h 300, grid 50/50/50/50 → plot x 50..350, y 50..250;
//        yAxis 0..10 → yOf(v) = 250 − 20·v; a horizontal chart's xAxis
//        0..10 → xOf(v) = 50 + 30·v.
//   3. mountChart (present mode) under the same shim plus a window/host
//      listener registry that honours AbortSignal like a browser: every
//      listener a mount adds — window's pan mousemove/mouseup included — is
//      gone after dispose.
//
// More negative controls (horizontal / stacked lines / names / dispose):
//
//   • dispose without the AbortController (the pre-fix code): the window
//     keeps its mousemove + mouseup — the "window listeners after dispose"
//     check fails with 2.
//   • a y-axis name end-anchored at grid.x − 8 above the plot (the pre-fix
//     layout, which clipped 'Revenue' to '…evenue') fails the rotated /
//     centred / left-of-the-tick-labels checks.
//   • stacked lines drawn from their own values: B's points land at 190/170
//     instead of 170/130.
//
// Negative controls, each seen to fail against a deliberately broken
// implementation while this rig was written:
//
//   • unclamped stack: with yAxis.min 50 the first stacked segment's base
//     (yOf(0)) lies ~333px below the plot — the "every rect inside the plot"
//     check fails without barExtent's clamp.
//   • stacked axis range: with the range computed from single values (max 4)
//     instead of the stacked totals (max 6), the auto axis tops out at 4 and
//     the clamped pile comes out 100px tall instead of 133.33.
//   • unstacked geometry: a slot counter that also advanced for stacked bars
//     shifts the unstacked bar's x — pinned exactly.

import { stackBars, stackLines, barExtent, chartSnapshotSvg, mountChart, CHART_PRESETS } from '../kernel/src/charts.ts'

const CHART_BAR = CHART_PRESETS.bar

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

// ------------------------------------------------------------ 1 · pure helpers
console.log('\nstackBars')
{
  const a = { type: 'bar', stack: 'x', data: [1, 2, -1] }
  const b = { type: 'bar', data: [5, 5, 5] }
  const c = { type: 'bar', stack: 'x', data: [3, 4, -2] }
  const r = stackBars([a, b, c], () => 0, 0, 3)
  ok(r.slots === 2, 'a stack and one plain bar take two slots')
  ok(r.slotOf.get(a) === 0 && r.slotOf.get(c) === 0, 'both members of the stack share slot 0')
  ok(r.slotOf.get(b) === 1, 'the plain bar keeps its own slot (1)')
  ok(r.stacked.has(a) && r.stacked.has(c) && !r.stacked.has(b), 'only the stack members are marked stacked')
  ok(eq(r.spans.get(a), [[0, 1], [0, 2], [0, -1]]), 'the first member grows from zero')
  ok(eq(r.spans.get(c), [[1, 4], [2, 6], [-1, -3]]), 'the second piles on top — positives up, negatives down')
  ok(eq(r.spans.get(b), [[0, 5], [0, 5], [0, 5]]), 'the plain bar is [0, v]')

  // the same stack name on two value axes is two piles
  const p = { type: 'bar', stack: 's', data: [1] }
  const q = { type: 'bar', stack: 's', yAxisIndex: 1, data: [2] }
  const r2 = stackBars([p, q], (s) => (s.yAxisIndex === 1 ? 1 : 0), 0, 1)
  ok(r2.slots === 2 && r2.slotOf.get(p) !== r2.slotOf.get(q), 'a stack key is per value axis')
  ok(eq(r2.spans.get(q), [[0, 2]]), 'the second axis pile starts at zero')

  // the category window (zoom) slices the data before piling
  const w = stackBars([{ type: 'bar', stack: 's', data: [1, 2, 3, 4] }], () => 0, 1, 2)
  ok(eq([...w.spans.values()][0], [[0, 2], [0, 3]]), 'the zoom window [i0, i0+nCat) is what piles')

  // no stack anywhere: one slot per bar, in order — the pre-stack layout
  const plain = [{ type: 'bar', data: [1] }, { type: 'bar', data: [2] }, { type: 'bar', data: [3] }]
  const r3 = stackBars(plain, () => 0, 0, 1)
  ok(r3.slots === 3 && plain.every((s, i) => r3.slotOf.get(s) === i) && r3.stacked.size === 0,
    'unstacked bars take slots 0, 1, 2 in series order')
}

console.log('\nstackLines')
{
  const a = { type: 'line', stack: 's', data: [1, 2, -1] }
  const b = { type: 'line', data: [5, 5, 5] }
  const c = { type: 'line', stack: 's', data: [3, 4, -2] }
  const r = stackLines([a, b, c], () => 0, 0, 3)
  ok(r.stacked.has(a) && r.stacked.has(c) && !r.stacked.has(b), 'only the stack members are marked stacked')
  ok(eq(r.spans.get(a), [[0, 1], [0, 2], [0, -1]]), 'the first line sits on zero')
  ok(eq(r.spans.get(c), [[1, 4], [2, 6], [-1, -3]]), 'the second piles on it — positives up, negatives down')
  ok(eq(r.spans.get(b), [[0, 5], [0, 5], [0, 5]]), 'an unstacked line is [0, v] — its own values')
  const p = { type: 'line', stack: 's', data: [1] }
  const q = { type: 'line', stack: 's', yAxisIndex: 1, data: [2] }
  ok(eq(stackLines([p, q], (s) => (s.yAxisIndex === 1 ? 1 : 0), 0, 1).spans.get(q), [[0, 2]]), 'a line stack key is per value axis')
  ok(eq([...stackLines([{ type: 'line', stack: 's', data: [1, 2, 3, 4] }], () => 0, 1, 2).spans.values()][0], [[0, 2], [0, 3]]),
    'the zoom window [i0, i0+nCat) is what piles')
}

console.log('\nbarExtent')
{
  const yOf = (v: number): number => 250 - 20 * v
  // unstacked: [base, base + (yOf(v) − base)·sweep] — the pre-stack formula
  ok(eq(barExtent(0, 5, false, yOf, 250, 1, 50, 250), [250, 150]), 'unstacked bar at full sweep: base → yOf(v)')
  ok(eq(barExtent(0, 5, false, yOf, 250, 0.5, 50, 250), [250, 200]), 'unstacked bar at half sweep grows halfway')
  ok(eq(barExtent(0, -2, false, yOf, 200, 1, 50, 250), [200, 290]),
    'unstacked bars stay unclamped, exactly as before stacking existed')
  ok(eq(barExtent(2, 6, true, yOf, 250, 1, 50, 250), [210, 130]), 'a stacked segment spans yOf(from) → yOf(to)')
  ok(eq(barExtent(2, 6, true, yOf, 250, 0.5, 50, 250), [230, 190]), 'a stack sweeps in as a whole (both ends scaled about zero)')
  // axis min 50 → yOf(0) is far below the plot
  const yMin = (v: number): number => 250 - ((v - 50) / 30) * 200
  ok(eq(barExtent(0, 60, true, yMin, 250, 1, 50, 250).map((y) => Math.round(y * 1000) / 1000), [250, 183.333]),
    'with an axis minimum above zero the bottom segment is clamped to the plot bottom')
  // yMin's max is 80: a segment 90 → 100 lies wholly above it
  ok(eq(barExtent(90, 100, true, yMin, 250, 1, 50, 250), [50, 50]), 'a segment entirely above the axis max collapses at the top')
}

// --------------------------------------------------- 2 · the real renderer
// A minimal DOM: enough for renderChart and XMLSerializer.
interface Node { tag: string; attrs: Record<string, string>; children: Node[]; style: { cssText: string }; textContent: string }
;(globalThis as any).document = {
  createElementNS: (_ns: string, tag: string): Node & { setAttribute(k: string, v: string): void; appendChild(c: Node): Node } => {
    const n: any = { tag, attrs: {}, children: [], style: { cssText: '' }, textContent: '' }
    n.setAttribute = (k: string, v: string) => { n.attrs[k] = String(v) }
    n.appendChild = (c: Node) => { n.children.push(c); return c }
    return n
  },
}
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const ser = (n: Node): string =>
  `<${n.tag}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>` +
  `${esc(n.textContent ?? '')}${n.children.map(ser).join('')}</${n.tag}>`
;(globalThis as any).XMLSerializer = class { serializeToString(n: Node): string { return ser(n) } }

interface Rect { x: number; y: number; width: number; height: number; fill: string }
const rectsOf = (svg: string): Rect[] =>
  [...svg.matchAll(/<rect ([^>]*)>/g)].map((m) => {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
    return { x: Number(a.x), y: Number(a.y), width: Number(a.width), height: Number(a.height), fill: a.fill }
  })
const GRID = { left: 50, right: 50, top: 50, bottom: 50 }
const render = (option: Record<string, unknown>): Rect[] => rectsOf(chartSnapshotSvg({ w: 400, h: 300, option }))
const bar = (color: string, data: number[], extra: Record<string, unknown> = {}) =>
  ({ type: 'bar', data, itemStyle: { color }, ...extra })
const inPlot = (r: Rect): boolean => r.y >= 50 - 1e-6 && r.y + r.height <= 250 + 1e-6

console.log('\nchartSnapshotSvg')
{
  // band = 300 / 2 = 150; groupW = 93; i = 0 → slot x0 = 50 + 28.5 = 78.5
  const rs = render({
    grid: GRID, xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value', min: 0, max: 10 },
    series: [bar('#A00001', [1, 2], { stack: 's' }), bar('#B00002', [3, 4], { stack: 's' }), bar('#C00003', [5, 5])],
  })
  const A = rs.filter((r) => r.fill === '#A00001')
  const B = rs.filter((r) => r.fill === '#B00002')
  const P = rs.filter((r) => r.fill === '#C00003')
  ok(A.length === 2 && B.length === 2 && P.length === 2, 'one rect per bar per category')
  // two slots → barW 46.5; stack in slot 0 at x0 + 1, plain bar in slot 1
  ok(near(A[0].x, 79.5) && near(B[0].x, 79.5), 'the stack members share slot 0')
  ok(near(P[0].x, 79.5 + 46.5), 'the plain bar sits in slot 1')
  ok(near(A[0].y, 230) && near(A[0].height, 20), 'segment A(1) spans 0 → 1: y 250 → 230')
  ok(near(B[0].y, 170) && near(B[0].height, 60), 'segment B(3) piles on it: 1 → 4, y 230 → 170')
  ok(near(B[1].y, 130) && near(B[1].height, 80), 'second category: B(4) on A(2) spans 2 → 6, y 210 → 130')
  ok(near(P[0].y, 150) && near(P[0].height, 100), 'the plain bar is unchanged: 0 → 5, y 250 → 150')
}
{
  // auto range: the totals (4 and 6), not the single values (max 4), set it —
  // niceTicks(0, 6) → 0..6, so yOf(v) = 250 − v·200/6 and B(4) on A(2) is
  // 133.33px tall (a range from single values, 0..4, would clip it to 100)
  const svg = chartSnapshotSvg({ w: 400, h: 300, option: {
    grid: GRID, xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' },
    series: [bar('#A00001', [1, 2], { stack: 's' }), bar('#B00002', [3, 4], { stack: 's' })],
  } })
  const labels = [...svg.matchAll(/text-anchor="end"[^>]*>([^<]*)</g)].map((m) => Number(m[1]))
  ok(Math.max(...labels) === 6, `the auto axis tops out at the stacked total (labels ${labels.join(',')})`)
  const b1 = rectsOf(svg).filter((r) => r.fill === '#B00002')[1]
  ok(near(b1.y, 50) && Math.abs(b1.height - 400 / 3) < 0.01, 'the second pile reaches exactly the plot top: 2 → 6')
}
{
  // negatives pile downward from zero
  const rs = render({
    grid: GRID, xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value', min: -10, max: 10 },
    series: [bar('#A00001', [-2], { stack: 's' }), bar('#B00002', [-3], { stack: 's' })],
  })
  // yOf(v) = 250 − 10·(v + 10): 0 → 150, −2 → 170, −5 → 200
  const [a] = rs.filter((r) => r.fill === '#A00001')
  const [b] = rs.filter((r) => r.fill === '#B00002')
  ok(near(a.y, 150) && near(a.height, 20) && near(b.y, 170) && near(b.height, 30), 'negatives stack downward from zero')
}
{
  // PowerPoint stacked column with c:min 50 → yAxis.min 50
  const rs = render({
    grid: GRID, xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value', min: 50 },
    series: [bar('#A00001', [60, 70], { stack: 's' }), bar('#B00002', [10, 10], { stack: 's' })],
  })
  ok(rs.filter((r) => r.fill === '#A00001' || r.fill === '#B00002').every(inPlot),
    'with an axis minimum above zero every stacked rect stays inside the plot')
}
{
  // no stack at all: the pre-stack slot geometry, pinned
  const rs = render({
    grid: GRID, xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value', min: 0, max: 10 },
    series: [bar('#A00001', [2]), bar('#B00002', [4]), bar('#C00003', [-1])],
  })
  // band 300, groupW 186, barW 62, x0 = 50 + 57 = 107
  const [a] = rs.filter((r) => r.fill === '#A00001')
  const [b] = rs.filter((r) => r.fill === '#B00002')
  const [c] = rs.filter((r) => r.fill === '#C00003')
  ok(near(a.x, 108) && near(b.x, 170) && near(c.x, 232), 'unstacked bars keep one slot each, in order')
  ok(near(a.y, 210) && near(a.height, 40) && near(b.y, 170) && near(b.height, 80), 'unstacked heights grow from the zero line')
  // the pre-stack renderer did not clip unstacked bars either: −1 on a 0..10
  // axis hangs 20px under the baseline, exactly as it always did
  ok(near(c.y, 250) && near(c.height, 20), 'a negative bar on a 0..10 axis draws exactly as before (unclipped)')
}

// ---------------------------------------------------------- stacked lines
interface Svg { circles: Array<{ cx: number; cy: number; fill: string }>; paths: Array<{ d: string; fill: string; stroke?: string }>; texts: Array<{ x: number; y: number; anchor: string; transform?: string; size: number; s: string }> }
const attrsOf = (m: string): Record<string, string> => Object.fromEntries([...m.matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
const parse = (svg: string): Svg => ({
  circles: [...svg.matchAll(/<circle ([^>]*)>/g)].map((m) => { const a = attrsOf(m[1]); return { cx: Number(a.cx), cy: Number(a.cy), fill: a.fill } }),
  paths: [...svg.matchAll(/<path ([^>]*)>/g)].map((m) => { const a = attrsOf(m[1]); return { d: a.d, fill: a.fill, stroke: a.stroke } }),
  texts: [...svg.matchAll(/<text ([^>]*)>([^<]*)</g)].map((m) => {
    const a = attrsOf(m[1])
    return { x: Number(a.x), y: Number(a.y), anchor: a['text-anchor'], transform: a.transform, size: Number(a['font-size']), s: m[2] }
  }),
})
const line = (color: string, data: number[], extra: Record<string, unknown> = {}) =>
  ({ type: 'line', data, lineStyle: { color }, ...extra })

console.log('\nstacked lines / areas')
{
  // band 150 → points at x 125 and 275
  const svg = parse(chartSnapshotSvg({ w: 400, h: 300, option: {
    grid: GRID, xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value', min: 0, max: 10 },
    series: [line('#A00001', [1, 2], { stack: 's', areaStyle: {} }), line('#B00002', [3, 4], { stack: 's', areaStyle: {} })],
  } }))
  const A = svg.circles.filter((c) => c.fill === '#A00001')
  const B = svg.circles.filter((c) => c.fill === '#B00002')
  ok(near(A[0].cy, 230) && near(A[1].cy, 210), 'the first stacked line sits on its own values (1, 2)')
  ok(near(B[0].cy, 170) && near(B[1].cy, 130), 'the second sits on the running totals (4, 6), not on 3, 4')
  const areaB = svg.paths.find((p) => p.fill === '#B00002' && p.d.endsWith('Z'))
  ok(areaB?.d === 'M 125 170 L 275 130 L 275 210 L 125 230 Z',
    `B's area fills down to A's curve, not to zero (${areaB?.d})`)
  const areaA = svg.paths.find((p) => p.fill === '#A00001' && p.d.endsWith('Z'))
  ok(areaA?.d === 'M 125 230 L 275 210 L 275 250 L 125 250 Z', `the bottom area fills to zero (${areaA?.d})`)
}
{
  // auto range covers the totals: 1+3=4, 2+4=6 → niceTicks(0, 6) tops out at 6
  const svg = chartSnapshotSvg({ w: 400, h: 300, option: {
    grid: GRID, xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' },
    series: [line('#A00001', [1, 2], { stack: 's' }), line('#B00002', [3, 4], { stack: 's' })],
  } })
  const labels = [...svg.matchAll(/text-anchor="end"[^>]*>([^<]*)</g)].map((m) => Number(m[1]))
  ok(Math.max(...labels) === 6, `a stacked line's auto axis tops out at the stacked total (labels ${labels.join(',')})`)
}
{
  // unstacked: the pre-stack area to the zero baseline, byte for byte
  const svg = parse(chartSnapshotSvg({ w: 400, h: 300, option: {
    grid: GRID, xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value', min: 0, max: 10 },
    series: [line('#A00001', [1, 2], { areaStyle: {} }), line('#B00002', [3, 4], { areaStyle: {} })],
  } }))
  ok(svg.paths.find((p) => p.fill === '#B00002' && p.d.endsWith('Z'))?.d === 'M 125 190 L 275 170 L 275 250 L 125 250 Z',
    'an unstacked area still fills to the zero line')
}

// --------------------------------------------------------- horizontal bars
console.log('\nhorizontal bars')
const hopt = (series: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  grid: GRID, yAxis: { type: 'category', data: ['a', 'b'] }, xAxis: { type: 'value', min: 0, max: 10 }, series, ...extra,
})
{
  // band 100 (cat 0 = y 150..250, cat 1 = 50..150), groupH 62, two slots → barH 31
  const svg = chartSnapshotSvg({ w: 400, h: 300, option: hopt(
    [bar('#A00001', [1, 2], { stack: 's' }), bar('#B00002', [3, 4], { stack: 's' }), bar('#C00003', [5, 5])],
    { tooltip: { trigger: 'axis' } }) })
  const rs = rectsOf(svg)
  const A = rs.filter((r) => r.fill === '#A00001')
  const B = rs.filter((r) => r.fill === '#B00002')
  const P = rs.filter((r) => r.fill === '#C00003')
  ok(A.length === 2 && B.length === 2 && P.length === 2, 'one rect per bar per category')
  ok(near(A[0].x, 50) && near(A[0].width, 30), 'A(1) grows right from zero: x 50 → 80')
  ok(near(B[0].x, 80) && near(B[0].width, 90), 'B(3) piles on it: 1 → 4, x 80 → 170')
  ok(near(B[1].x, 110) && near(B[1].width, 120), 'second category: B(4) on A(2) spans 2 → 6, x 110 → 230')
  ok(near(P[0].x, 50) && near(P[0].width, 150), 'the plain bar is 0 → 5: x 50 → 200')
  // slot 0 at the bottom of each band: 250 − 19 − 31 = 200 (+1 inset)
  ok(near(A[0].y, 201) && near(A[0].height, 29) && near(B[0].y, 201), 'the stack shares slot 0, nearest the bottom of the band')
  ok(near(P[0].y, 170), 'the plain bar sits in slot 1, above it')
  ok(near(A[1].y, 101), 'the first category is the BOTTOM band (ECharts / PowerPoint order)')
  const t = parse(svg).texts
  const cat = t.filter((x) => x.anchor === 'end')
  ok(cat.length === 2 && cat.every((x) => near(x.x, 42)) && near(cat[0].y, 200 + 12 * 0.35) && near(cat[1].y, 100 + 12 * 0.35),
    'category labels end-anchored left of the plot, centred on their bands')
  const val = t.filter((x) => x.anchor === 'middle' && near(x.y, 250 + 12 + 6))
  ok(eq(val.map((x) => x.s), ['0', '2', '4', '6', '8', '10']) && near(val[0].x, 50) && near(val[5].x, 350),
    'value labels along the bottom, 0..10 across the plot')
  const stripes = rs.filter((r) => r.fill === 'transparent')
  ok(stripes.length === 2 && stripes.every((r) => near(r.x, 50) && near(r.width, 300) && near(r.height, 100)),
    'axis-tooltip hit stripes span the plot, one per category')
}
{
  const rs = rectsOf(chartSnapshotSvg({ w: 400, h: 300, option: hopt([bar('#A00001', [1, 2])], { yAxis: { type: 'category', data: ['a', 'b'], inverse: true } }) }))
  // one slot → barH 62: cat 0 band 50..150 → y 50 + 19 + 1
  ok(near(rs.filter((r) => r.fill === '#A00001')[0].y, 70), 'inverse puts the first category at the TOP')
}
{
  // auto range from the stacked totals, negatives pile left of zero
  const svg = chartSnapshotSvg({ w: 400, h: 300, option: {
    ...hopt([bar('#A00001', [-2, 1], { stack: 's' }), bar('#B00002', [-3, 2], { stack: 's' })]),
    xAxis: { type: 'value', min: -10, max: 10 },
  } })
  // xOf(v) = 50 + 15·(v + 10): 0 → 200, −2 → 170, −5 → 125
  const [a] = rectsOf(svg).filter((r) => r.fill === '#A00001')
  const [b] = rectsOf(svg).filter((r) => r.fill === '#B00002')
  ok(near(a.x, 170) && near(a.width, 30) && near(b.x, 125) && near(b.width, 45), 'negatives stack leftward from zero')
}
{
  // long category labels: the left inset grows so they fit
  const long = 'A rather long category'
  const svg = chartSnapshotSvg({ w: 400, h: 300, option: {
    ...hopt([bar('#A00001', [1, 2])]), yAxis: { type: 'category', data: [long, 'b'] },
  } })
  const [first] = rectsOf(svg).filter((r) => r.fill === '#A00001')
  const label = parse(svg).texts.find((x) => x.s === long)!
  const estW = [...long].reduce((n, ch) => n + (/\s/.test(ch) ? 0.35 : 0.58), 0) * 12
  ok(first.x > 50 && label.x - estW >= 0, `a long category label fits inside the chart (plot starts at ${first.x.toFixed(1)})`)
}
{
  // a horizontal chart with dataZoom still mounts no zoom (wheel) handler — see mount checks below
  const svg = parse(chartSnapshotSvg({ w: 400, h: 300, option: {
    ...hopt([line('#A00001', [2, 4], { stack: 's' }), line('#B00002', [1, 1], { stack: 's' })]),
  } }))
  const B = svg.circles.filter((c) => c.fill === '#B00002')
  // centres: cat 0 → y 200, cat 1 → y 100; B on A: 3 → x 140, 5 → x 200
  ok(B.length === 2 && near(B[0].cx, 140) && near(B[0].cy, 200) && near(B[1].cx, 200) && near(B[1].cy, 100),
    'a stacked line in a horizontal chart runs through the band centres at the running totals')
}

// ------------------------------------------------------------- axis names
console.log('\naxis names')
{
  // the preset's left inset (56) with labels up to "30": the name must not run off the chart
  const svg = parse(chartSnapshotSvg({ w: 800, h: 520, option: {
    grid: { left: 56, right: 20, top: 24, bottom: 56 },
    xAxis: { type: 'category', data: ['Q1', 'Q2'] }, yAxis: { type: 'value', name: 'Revenue' },
    series: [{ type: 'bar', data: [12, 28] }],
  } }))
  const name = svg.texts.find((x) => x.s === 'Revenue')!
  ok(!!name.transform && name.transform.startsWith('rotate(-90 '), 'the y-axis name is rotated along the axis')
  // rotated −90°, the glyphs extend ≈0.8em LEFT of the baseline x
  ok(name.x - 0.8 * name.size >= 0, `the rotated name lies inside the chart (baseline x ${name.x.toFixed(1)})`)
  ok(near(name.y, 24 + (520 - 24 - 56) / 2), 'the name is centred on the plot height')
  const ticks = svg.texts.filter((x) => x.anchor === 'end')
  const tickLeft = Math.min(...ticks.map((x) => x.x - x.s.length * 0.58 * x.size))
  ok(name.x + 0.2 * name.size <= tickLeft, 'the name sits left of the tick labels, not over them')
}
{
  // wide tick labels in a narrow inset: the plot moves right to make room
  const svg = chartSnapshotSvg({ w: 400, h: 300, option: {
    grid: GRID, xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value', name: 'Units', min: 0, max: 100000 },
    series: [bar('#A00001', [50000])],
  } })
  const name = parse(svg).texts.find((x) => x.s === 'Units')!
  const [r] = rectsOf(svg).filter((x) => x.fill === '#A00001')
  ok(name.x - 0.8 * name.size >= 0, 'with wide tick labels the name still fits')
  ok(r.x > 50 + 300 * 0.19, `…because the plot gave up the space (bar at x ${r.x.toFixed(1)})`)
}
{
  // right-hand axis name on a dual-axis chart stays inside the right edge
  const svg = parse(chartSnapshotSvg({ w: 400, h: 300, option: {
    grid: GRID, xAxis: { type: 'category', data: ['a'] },
    yAxis: [{ type: 'value' }, { type: 'value', name: 'Rate', min: 0, max: 1000 }],
    series: [bar('#A00001', [5]), { type: 'line', yAxisIndex: 1, data: [500, 600] }],
  } }))
  const name = svg.texts.find((x) => x.s === 'Rate')!
  ok(name.transform?.startsWith('rotate(-90 ') && name.x + 0.2 * name.size <= 400, 'the right-axis name is rotated and inside the chart')
}

// ------------------------------------------------------- mountChart dispose
console.log('\nmountChart dispose')
{
  type Rec = { type: string; fn: unknown }
  const target = <T extends object>(o: T): T & { listeners: Rec[]; addEventListener: (...a: any[]) => void; removeEventListener: (...a: any[]) => void } => {
    const t = o as any
    t.listeners = [] as Rec[]
    t.addEventListener = (type: string, fn: unknown, opts?: { signal?: AbortSignal }) => {
      const sig = opts?.signal
      if (sig?.aborted) return
      const rec = { type, fn }
      t.listeners.push(rec)
      sig?.addEventListener('abort', () => { const i = t.listeners.indexOf(rec); if (i >= 0) t.listeners.splice(i, 1) })
    }
    t.removeEventListener = (type: string, fn: unknown) => {
      const i = t.listeners.findIndex((r: Rec) => r.type === type && r.fn === fn)
      if (i >= 0) t.listeners.splice(i, 1)
    }
    return t
  }
  const doc = (globalThis as any).document
  const makeNode = doc.createElementNS
  doc.createElementNS = (ns: string, tag: string) => target(makeNode(ns, tag))
  doc.createElement = () => ({ style: {} as Record<string, string>, remove() {}, querySelectorAll: () => [] })
  doc.body = { appendChild: (c: unknown) => c }
  doc.fullscreenElement = null
  ;(globalThis as any).getComputedStyle = () => ({ position: 'relative' })
  ;(globalThis as any).NodeList ??= class {} // anim.killTweensOf type-tests its target
  const win = target({})
  ;(globalThis as any).window = win
  const host = (): any => target({ style: {}, innerHTML: '', children: [] as unknown[], querySelector: () => null, prepend(c: unknown) { this.children.unshift(c) }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) })

  const zoomable = { ...CHART_BAR(), dataZoom: [{ type: 'inside' }], tooltip: { trigger: 'axis' } }
  const h1 = host()
  const dispose = mountChart({ w: 400, h: 300, option: zoomable }, h1)
  const svg = h1.children[0]
  ok(win.listeners.map((r) => r.type).sort().join() === 'mousemove,mouseup', 'a zoomable chart adds a window mousemove + mouseup (the pan drag)')
  ok(h1.listeners.map((r: Rec) => r.type).sort().join() === 'mousedown,wheel', '…and a wheel + mousedown on its host')
  ok(svg.listeners.length === 2, '…and the tooltip mousemove + mouseleave on its svg')
  dispose()
  ok(win.listeners.length === 0, `after dispose no window listener is left (${win.listeners.length})`)
  ok(h1.listeners.length === 0 && svg.listeners.length === 0, 'after dispose the host and svg listeners are gone too')

  // horizontal bars mount no zoom, even with dataZoom set
  const h2 = host()
  const d2 = mountChart({ w: 400, h: 300, option: { ...hopt([bar('#A00001', [1, 2])]), dataZoom: [{ type: 'inside' }] } }, h2)
  ok(win.listeners.length === 0 && h2.listeners.length === 0, 'a horizontal chart has no zoom / pan (dataZoom off)')
  d2()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
