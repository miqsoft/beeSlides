#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert graphics rig — graphicFrame tables (convert/table.ts) and
// charts (convert/chart.ts) through the whole convertPptx pipeline.
//
//   node scripts/test-convert/graphics.ts
//
// The fixture is _fixtures.ts's fxGraphics; every expected value is computed
// by hand from its constants (EMU / 9525, sz / 100 × 4/3) or pinned from the
// spec, never by running the converter against itself. The two accent1 tints
// are the theme engine's linear-light tint (gamma 2.2) of #4472C4, worked on
// paper: 20% → #E8EBF5, 40% → #CDD4EA.
//
// Negative controls, each seen to fail against a deliberately broken
// implementation while this rig was written:
//
//   • banding: band1 is the FIRST body row — an off-by-one that counted the
//     header row as band1 would stripe rows 2/4 with 40% instead (asserted
//     absent on s1-2 row 2).
//   • style source: the custom style lives only in tableStyles.xml, DEFINED
//     in lower case and referenced in upper — a case-sensitive lookup falls
//     through to 'table-style-unknown' (asserted absent for s1-3).
//   • series colour: an unstyled series takes accent<c:idx+1>, so 'South'
//     (idx 1) is accent2 #FBAE40, never accent1.
//   • stacking: 100%-stacked values become shares (1,3 → 25,75), not the raw
//     values.
//   • style forms (fxGraphicsMore): reading only a:fill / a:ln — the old
//     table.ts — leaves Light Style 8's header transparent under white ink
//     and Themed Style 7 white-on-transparent, failing the headerBg checks.
//   • broken parts (fxGraphicsBroken): without the guards in pptx.ts the
//     malformed chart part / tableStyles.xml throw out of convertPptx.
//   • horizontal bars (fxChartsMore): the pre-charts-2 import put the
//     categories on xAxis and reported chart-bars-vertical — the yAxis
//     category / xAxis value checks and the report check fail.
//   • stacked lines: dropping s.stack for non-bar groups (charts-lite used
//     to ignore it) fails the shared-stack-key checks.

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import type { ConvertResult, OutTable, OutChart, OutText, OutShape } from '../../kernel/src/convert/types.ts'
import { fxGraphics, fxGraphicsMore, fxGraphicsBroken, fxChartsMore } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function reportIs(r: ConvertResult, expected: string[], label: string) {
  const got = [...new Set(r.report.entries.map((e) => e.code))].sort()
  const want = [...new Set(expected)].sort()
  ok(got.length === want.length && got.every((c, i) => c === want[i]),
    `${label}: report codes are exactly [${want.join(', ')}] (got [${got.join(', ')}])`)
}

const r = await convertPptx(await fxGraphics(), { link: false })
const byId = (slide: number, id: string) => r.doc.slides[slide].elements.find((e) => e.id === id)
const where = (code: string) => r.report.entries.filter((e) => e.code === code).map((e) => e.where)

// ------------------------------------------------------------------ tables
{
  const t = byId(0, 's1-2') as OutTable
  ok(t?.type === 'table', 'table A: a:tbl becomes a native table element')
  ok(t.x === 96 && t.y === 96 && t.w === 384 && t.h === 160,
    'table A: frame from p:xfrm (914400 → 96, 3657600 → 384, 4 × 381000 → 160)')
  ok(eq(t.columns, [{ w: 192 }, { w: 96 }, { w: 96 }]), 'table A: gridCol widths carried as px weights')
  ok(t.header === true, 'table A: firstRow="1" → header')
  ok(t.rows.length === 4 && t.rows.every((row) => row.cells.length === 3), 'table A: 4 rows × 3 cells')
  const s = t.style as Record<string, unknown>
  ok(s.headerBg === '#4472C4' && s.headerColor === '#FFFFFF',
    'table A: built-in Medium Style 2 header — accent1 fill, lt1 ink')
  ok(s.zebra === '#E8EBF5', 'table A: zebra = band2 rows = wholeTbl accent1 tint 20%')
  ok(s.color === '#000000', 'table A: body ink = dk1')
  ok(s.borderColor === '#FFFFFF' && s.borderWidth === 1.33, 'table A: 1pt lt1 cell rules (12700 / 9525 = 1.33px)')
  ok(s.fontSize === 18.67 && s.fontFamily === 'Calibri, Carlito, sans-serif',
    'table A: 14pt runs → 18.67px, theme minor face with its metric substitute')
  ok(s.cellPadX === 9.6 && s.cellPadY === 4.8, 'table A: default cell margins 91440/45720 EMU → 9.6/4.8 px')
  ok(s.radius === 0, 'table A: square corners, like PowerPoint')
  const [h, b1, b2, b3] = t.rows
  ok(eq(h.cells.map((c) => c.html), ['Name', 'Q1', 'Q2']) && h.cells.every((c) => c.bg === undefined),
    'table A: header cells carry text and no overrides')
  ok(b1.cells.every((c) => c.bg === '#CDD4EA'), 'table A: first body row is band1 — accent1 tint 40% per cell')
  ok(b2.cells[0].bg === undefined && b2.cells[2].bg === undefined,
    'table A: second body row needs no override (the zebra paints it)')
  ok(!b2.cells.some((c) => c.bg === '#CDD4EA'), 'table A: NEGATIVE — banding never starts at the header row')
  ok(b2.cells[1].bg === '#FF0000', 'table A: an explicit tcPr solidFill wins over the style')
  ok(b1.cells[1].html === '12' && b1.cells[1].bold === true, 'table A: an all-bold cell says cell.bold, no <b> markup')
  ok(b1.cells[2].align === 'center', 'table A: paragraph algn="ctr" → cell align center')
  ok(b2.cells[2].html === 'Mixed <b>bold</b>' && b2.cells[2].bold === undefined,
    'table A: a partly bold cell keeps <b> on the bold run only')
  ok(b3.cells[0].html === 'Total' && b3.cells[0].colspan === 2 && eq(b3.cells[1], { html: '' }),
    'table A: gridSpan=2 → colspan 2 on the origin, the hMerge cell stays in the grid, empty')
  ok(eq(r.doc.requires, ['table-merge']), 'table A: a merged cell makes the document declare requires: [table-merge]')
}
{
  const t = byId(0, 's1-3') as OutTable
  const s = t.style as Record<string, unknown>
  ok(s.headerBg === '#222222' && s.headerColor === '#FFFFFF' && s.color === '#333333',
    'table B: a custom style read from tableStyles.xml (header + wholeTbl ink)')
  ok(s.zebra === undefined, 'table B: no bandRow → no zebra')
  ok(s.borderColor === '#999999' && s.borderWidth === 2, 'table B: the style insideH rule (19050 EMU → 2px)')
  ok(s.cellPadX === 19.2 && s.cellPadY === 9.6, 'table B: tcPr marL/marT 182880/91440 → 19.2/9.6 px')
  ok(t.rows[1].cells.every((c) => c.bg === '#EEEEEE'), 'table B: the wholeTbl fill lands on body cells')
  ok(!where('table-style-unknown').some((w) => w.includes('Table B')),
    'table B: NEGATIVE — GUID case does not matter (no table-style-unknown)')
}
{
  const t = byId(0, 's1-4') as OutTable
  ok(t?.type === 'table' && t.header === false && t.rows[0].cells[0].html === 'x',
    'table C: an unknown style still imports the table')
  ok((t.style as Record<string, unknown>).borderWidth === 0, 'table C: plain fallback has no rules')
  ok(where('table-style-unknown').length === 1 && where('table-style-unknown')[0].includes('Table C'),
    'table C: reported as table-style-unknown')
}

// ------------------------------------------------------------------ charts
type Opt = Record<string, any>
{
  const c = byId(1, 's2-2') as OutChart
  const title = byId(1, 's2-2-t') as OutText
  ok(c?.type === 'chart' && c.preset === 'bar', 'chart 1: clustered column → native bar chart')
  const o = c.option as Opt
  ok(eq(o.xAxis.data, ['Q1', 'Q2', 'Q3']), 'chart 1: categories from c:cat strCache')
  ok(eq(o.series.map((s: Opt) => [s.type, s.name, s.data]), [['bar', 'North', [10, 20, 30]], ['bar', 'South', [5, 15, 25]]]),
    'chart 1: series names (c:tx strCache) and values (c:val numCache)')
  ok(o.series[0].itemStyle?.color === '#FF0000', 'chart 1: explicit series spPr colour')
  ok(o.series[1].itemStyle?.color === '#FBAE40', 'chart 1: unstyled series idx 1 → accent2 (NOT accent1)')
  ok(eq(o.legend?.bottom, 0), 'chart 1: legendPos b → bottom legend')
  ok(o.series.every((s: Opt) => s.stack === undefined), 'chart 1: clustered bars carry no stack key')
  ok(title?.type === 'text' && title.html === 'Revenue' && title.fontSize === 24,
    'chart 1: c:title rich text → a text element at 18pt (24px)')
  ok(title.y === 96 && title.h === 40.8 && c.y === 136.8 && c.h === 247.2,
    'chart 1: title strip on top (24 × 1.2 + 12 = 40.8px), the plot below it')
  ok(title.groupId === 's2-2-g' && c.groupId === 's2-2-g', 'chart 1: title and chart welded by groupId')
  const els = r.doc.slides[1].elements
  ok(els.indexOf(title) === els.indexOf(c) + 1, 'chart 1: the title paints right after its chart')
}
{
  const o = (byId(1, 's2-3') as OutChart).option as Opt
  ok(o.series[0].stack !== undefined && o.series[0].stack === o.series[1].stack,
    'chart 2: grouping="stacked" bars share one stack key')
  ok(o.series[2].type === 'line' && o.series[2].yAxisIndex === 1, 'chart 2: the line on its own axId pair rides the secondary axis')
  ok(o.series[2].smooth === true && o.series[2].symbol === 'none', 'chart 2: c:smooth and c:symbol none carried')
  ok(o.series[2].lineStyle?.color === '#808080', 'chart 2: line colour = accent3 by c:idx 2')
  ok(Array.isArray(o.yAxis) && o.yAxis.length === 2 && o.yAxis[0].max === 10 && o.yAxis[1].max === undefined,
    'chart 2: two value axes; the primary keeps its c:scaling max')
}
{
  const c = byId(1, 's2-4') as OutChart
  const o = c.option as Opt
  ok(c.preset === 'pie' && o.series[0].type === 'pie', 'chart 3: doughnut → pie series')
  ok(eq(o.series[0].radius, ['36%', '72%']), 'chart 3: holeSize 50 → inner radius half the outer')
  ok(eq(o.series[0].data, [{ name: 'Yes', value: 60 }, { name: 'No', value: 30 }, { name: 'Maybe', value: 10 }]),
    'chart 3: slices named by category')
  ok(eq(o.color, ['#4472C4', '#00FF00', '#808080']), 'chart 3: varyColors accents per slice, c:dPt override on slice 1')
  ok(o.series[0].label?.formatter === '{d}%', 'chart 3: showPercent → percentage labels')
}
{
  const c = byId(2, 's3-2') as OutChart
  const o = c.option as Opt
  ok(c.preset === 'scatter' && o.xAxis.type === 'value' && o.xAxis.data === undefined,
    'chart 4: scatter → value x axis (no categories, which would switch charts-lite to category mode)')
  ok(eq(o.series[0].data, [[1, 2], [2, 4], [3, 8]]), 'chart 4: points from xVal/yVal caches')
  ok(o.series[0].itemStyle?.color === '#123456', 'chart 4: marker fill colour (the line is noFill)')
  ok(o.yAxis.min === 0 && o.yAxis.max === 10, 'chart 4: y = the second (axPos l) valAx scaling')
}
{
  const box = byId(2, 's3-3') as OutShape
  ok(box?.type === 'shape' && box.strokeStyle === 'dashed', 'chart 5: radar keeps the dashed placeholder')
  ok(where('chart-type-unsupported').length === 1 && where('chart-type-unsupported')[0].includes('Chart 5'),
    'chart 5: reported as chart-type-unsupported')
}
{
  const o = (byId(2, 's3-4') as OutChart).option as Opt
  ok(eq(o.series.map((s: Opt) => s.data), [[25, 75], [75, 25]]), 'chart 6: 100%-stacked values frozen to shares')
  ok(o.xAxis.type === 'value' && o.xAxis.min === 0 && o.xAxis.max === 100 && o.xAxis.axisLabel.formatter === '{value}%',
    'chart 6: horizontal — the value axis (xAxis) spans 0–100 %')
  ok(o.yAxis.type === 'category' && eq(o.yAxis.data, ['2023-01-01', '2023-01-02']),
    'chart 6: horizontal — date-formatted numeric categories become dates, on yAxis')
}
{
  const box = byId(2, 's3-5') as OutShape
  ok(box?.type === 'shape' && box.strokeStyle === 'dashed', 'chart 7: a cache-less chart keeps the placeholder')
}

reportIs(r, [
  'table-imported', 'table-borders-unified', 'table-style-unknown',
  'chart-imported', 'chart-type-unsupported', 'chart-percent-frozen', 'chart-no-data',
], 'graphics')

// ------------------------------------------- second pass: style forms, chart notes
{
  const m = await convertPptx(await fxGraphicsMore(), { link: false })
  const get = (slide: number, id: string) => m.doc.slides[slide].elements.find((e) => e.id === id)
  const at = (code: string) => m.report.entries.filter((e) => e.code === code).map((e) => e.where)

  const l8 = get(0, 's1-2') as OutTable
  const l8s = l8.style as Record<string, unknown>
  ok(l8s.headerBg === '#000000' && l8s.headerColor === '#FFFFFF',
    'Light Style 8: a:fillRef straight under a:tcStyle fills the header (tx1), under its bg1 ink')
  ok(l8s.borderColor === '#000000' && l8s.borderWidth === 0.67,
    'Light Style 8: a:lnRef idx 1 edges → theme line 1 (6350 EMU → 0.67px) in tx1')
  ok(l8s.zebra === undefined && l8.rows.slice(1).every((r) => r.cells.every((c) => c.bg === undefined)),
    'Light Style 8: no fills in the body (the style has none)')

  const t7 = get(0, 's1-3') as OutTable
  const t7s = t7.style as Record<string, unknown>
  ok(t7s.color === '#FFFFFF' && t7s.headerColor === '#FFFFFF', 'Themed Style 7: lt1 ink, header and body')
  ok(t7s.headerBg === '#A2B9E2', 'Themed Style 7: a:tblBg (fillRef idx 3 → the gradient, flattened) shows under the noFill header')
  ok(t7s.zebra === '#A2B9E2', 'Themed Style 7: the band2 rows (no fill of their own) show the table background too')
  ok(t7.rows[1].cells.every((c) => c.bg === '#B5C7E8'),
    'Themed Style 7: band1 lt1 @ 20% is composited over the background (#B5C7E8), not left translucent')
  ok(t7s.borderColor === '#BFC8E4' && t7s.borderWidth === 0.67,
    'Themed Style 7: lnRef edges in accent1 tint 50% (worked on paper: #BFC8E4)')
  ok(m.doc.requires === undefined, 'graphics-more: no merged cell → no requires')
  ok(at('table-effect-dropped').length === 0,
    'Themed Style 7: NEGATIVE — its effectRef idx 3 points at no theme effect style (the fixture theme has none), so nothing is reported')
  ok(at('table-fill-flattened').length === 1 && at('table-fill-flattened')[0].includes('Themed 7'),
    'Themed Style 7: the gradient flattening is reported, for that table only')

  const c1 = (get(1, 's2-2') as OutChart).option as Opt
  ok(c1.yAxis.name === 'Revenue', 'chart notes: the value-axis c:title becomes yAxis.name')
  ok(c1.yAxis.min === 50, 'chart notes: the value-axis c:min is kept')
  for (const code of ['chart-axis-title-dropped', 'chart-data-labels-dropped', 'chart-number-format-dropped', 'chart-axis-hidden-shown']) {
    ok(eq(at(code), ['slide 2 / sp "Chart 1"']), `chart notes: ${code} reported for the chart that has it, and only that one`)
  }
  const c2 = (get(1, 's2-3') as OutChart).option as Opt
  ok(c2.yAxis.name === undefined, 'chart notes: no title → no axis name')
  reportIs(m, [
    'table-imported', 'table-borders-unified', 'table-fill-flattened',
    'chart-imported', 'chart-axis-title-dropped', 'chart-data-labels-dropped',
    'chart-number-format-dropped', 'chart-axis-hidden-shown',
  ], 'graphics-more')
}
{
  // broken parts cost only themselves — before this guard either one threw
  // out of convertPptx and the user got no deck at all
  let b: ConvertResult | undefined
  let err = ''
  try { b = await convertPptx(await fxGraphicsBroken(), { link: false }) } catch (e) { err = String(e) }
  ok(!!b, `broken parts: the deck still converts${err ? ` (threw ${err})` : ''}`)
  if (b) {
    const els = b.doc.slides[0].elements
    const t = els.find((e) => e.id === 's1-2') as OutTable
    ok(t?.type === 'table' && (t.style as Record<string, unknown>).headerBg === '#4472C4',
      'broken parts: the table still imports on the built-in style')
    const bad = els.find((e) => e.id === 's1-3') as OutShape
    ok(bad?.type === 'shape' && bad.strokeStyle === 'dashed', 'broken parts: the malformed chart keeps its placeholder box')
    ok(els.find((e) => e.id === 's1-4')?.type === 'chart', 'broken parts: the good chart beside it still imports')
    reportIs(b, ['table-styles-unreadable', 'table-imported', 'table-borders-unified', 'chart-unreadable', 'chart-imported'],
      'graphics-broken')
  }
}

// ------------------------------------- charts, second pass: horizontal + stacked lines
{
  const c = await convertPptx(await fxChartsMore(), { link: false })
  const get = (id: string) => (c.doc.slides[0].elements.find((e) => e.id === id) as OutChart | undefined)?.option as Opt
  const h = get('s1-2')
  ok(h?.yAxis?.type === 'category' && eq(h.yAxis.data, ['a', 'b']), 'horizontal: c:barDir bar → categories on yAxis')
  ok(h.xAxis?.type === 'value' && !Array.isArray(h.xAxis), 'horizontal: one value axis on xAxis')
  ok(h.yAxis.name === 'Region' && h.xAxis.name === 'Sales', 'horizontal: category title → yAxis.name, value title → xAxis.name')
  ok(h.yAxis.inverse === true, 'horizontal: c:orientation maxMin on the catAx → yAxis.inverse')
  ok(h.dataZoom === undefined, 'horizontal: no dataZoom')
  ok(eq(h.series.map((s: Opt) => [s.type, s.name, s.data, s.stack, s.yAxisIndex]),
    [['bar', 'A', [3, 5], undefined, undefined], ['bar', 'B', [4, 2], undefined, undefined]]),
  'horizontal: clustered bars, no stack, no axis index')

  const l = get('s1-3')
  ok(l.xAxis?.type === 'category' && eq(l.xAxis.data, ['a', 'b']), 'stacked line: still a vertical (category x) chart')
  ok(l.series.every((s: Opt) => s.type === 'line' && s.symbol === 'none') && typeof l.series[0].stack === 'string' &&
    l.series[0].stack === l.series[1].stack, 'stacked line: both line series share one stack key')
  ok(eq(l.series.map((s: Opt) => s.data), [[1, 2], [3, 4]]), 'stacked line: raw values kept (charts-lite piles them)')

  const a = get('s1-4')
  ok(a.series.every((s: Opt) => s.type === 'line' && s.areaStyle && s.stack === a.series[0].stack && s.stack),
    '100% area: stacked line+areaStyle series on one key')
  ok(eq(a.series.map((s: Opt) => s.data), [[25, 75], [75, 25]]), '100% area: frozen to shares that pile to 100')
  ok(a.yAxis.min === 0 && a.yAxis.max === 100, '100% area: a 0..100 value axis')

  const m = get('s1-5')
  ok(m.yAxis?.type === 'category' && !Array.isArray(m.xAxis) && m.xAxis.type === 'value', 'horizontal, two axis pairs: one value axis')
  ok(m.series.every((s: Opt) => s.yAxisIndex === undefined) && m.series[0].stack && m.series[1].stack === undefined,
    'horizontal, two axis pairs: no yAxisIndex; only the stacked group stacks')
  const at = (code: string) => c.report.entries.filter((e) => e.code === code).map((e) => e.where)
  ok(eq(at('chart-secondary-axis-merged'), ['slide 1 / sp "HBar two axes"']), 'the merged axis is reported for that chart only')
  ok(eq(at('chart-percent-frozen'), ['slide 1 / sp "Percent area"']), 'the 100% freeze is reported for that chart only')
  reportIs(c, ['chart-imported', 'chart-percent-frozen', 'chart-secondary-axis-merged'], 'charts-more')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
