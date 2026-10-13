#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Chart panel edits — slides/src/chartaxes.ts: bar direction (axis swap) and
// stacking, plus the category-axis lookup the panel's data grid and the
// table→chart binding (model.syncLinkedChart) write through.
//
//   node scripts/test-chart-edit.ts
//
// Negative controls, each seen to fail against a deliberately broken
// implementation while this rig was written:
//
//   • a swap that keeps a dual-axis yAxis ARRAY as xAxis leaves charts-lite
//     reading `xAxis[0]` but the panel's min/max writing `xAxis` — the
//     "one value axis object" check fails.
//   • catAxisKey hard-wired to 'xAxis' (the pre-charts-2 panel) writes a
//     horizontal chart's categories onto its value axis — the ensureCatAxis
//     check fails.

import {
  catAxisKey, chartCategories, chartIsHorizontal, chartIsStacked, ensureCatAxis,
  setChartHorizontal, setChartStacked, valueAxisKey, PANEL_STACK,
} from '../slides/src/chartaxes.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
type Opt = Record<string, any>
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const vertical = (): Opt => ({
  xAxis: { type: 'category', data: ['Q1', 'Q2'], axisLabel: { fontSize: 14 } },
  yAxis: { type: 'value', min: 0, max: 40, name: 'Revenue' },
  dataZoom: [{ type: 'inside' }],
  series: [{ type: 'bar', name: 'A', data: [1, 2] }, { type: 'bar', name: 'B', data: [3, 4] }],
})

console.log('\norientation')
{
  const o = vertical()
  ok(!chartIsHorizontal(o) && catAxisKey(o) === 'xAxis' && valueAxisKey(o) === 'yAxis', 'a column chart: categories on xAxis')
  ok(setChartHorizontal(o, true), 'going horizontal changes the option')
  ok(chartIsHorizontal(o) && catAxisKey(o) === 'yAxis' && valueAxisKey(o) === 'xAxis', '…to the horizontal shape')
  ok(eq(o.yAxis, { type: 'category', data: ['Q1', 'Q2'], axisLabel: { fontSize: 14 } }), 'the category axis moves to yAxis with its look')
  ok(eq(o.xAxis, { type: 'value', min: 0, max: 40, name: 'Revenue' }), 'the value axis moves to xAxis with its range and name')
  ok(eq(o.series, vertical().series) && eq(o.dataZoom, vertical().dataZoom), 'series and the rest of the option are untouched')
  ok(!setChartHorizontal(o, true), 'horizontal again is a no-op')
  o.yAxis.inverse = true
  ok(setChartHorizontal(o, false) && eq(o, vertical()), 'and back: the very same option (inverse dropped — columns ignore it)')
}
{
  // a dual-axis chart keeps only its first value axis sideways
  const o: Opt = {
    xAxis: { type: 'category', data: ['a'] },
    yAxis: [{ type: 'value', name: 'L' }, { type: 'value', name: 'R' }],
    series: [{ type: 'bar', data: [1], yAxisIndex: 0 }, { type: 'line', data: [2], yAxisIndex: 1 }],
  }
  setChartHorizontal(o, true)
  ok(!Array.isArray(o.xAxis) && eq(o.xAxis, { type: 'value', name: 'L' }), 'a dual-axis chart goes sideways on ONE value axis object (the first)')
  ok(o.series.every((s: Opt) => s.yAxisIndex === undefined), '…and its series drop yAxisIndex')
}
{
  // ECharts' own horizontal option (yAxis category, xAxis value) is recognised as-is
  const o: Opt = { yAxis: { type: 'category', data: ['x', 'y'] }, xAxis: { type: 'value' }, series: [] }
  ok(chartIsHorizontal(o) && eq(chartCategories(o), ['x', 'y']), 'a hand-written ECharts horizontal option reads as horizontal')
  ok(!chartIsHorizontal({ xAxis: { type: 'category' }, yAxis: { type: 'category' } }), 'two category axes are not horizontal')
  ok(!chartIsHorizontal({ series: [] }) && eq(chartCategories({}), []), 'no axes: vertical, no categories')
}

console.log('\ncategory axis writes')
{
  const o: Opt = { yAxis: { type: 'category' }, xAxis: { type: 'value', min: 0 }, series: [] }
  ensureCatAxis(o).data.push('new')
  ok(eq(o.yAxis.data, ['new']) && o.xAxis.data === undefined, "a horizontal chart's categories are written to yAxis, never the value axis")
  const v: Opt = { series: [] }
  ensureCatAxis(v).data.push('c')
  ok(eq(v.xAxis, { type: 'category', data: ['c'] }), 'a chart with no axes gets a category xAxis')
}

console.log('\nstacking')
{
  const o = vertical()
  o.series.push({ type: 'line', name: 'L', data: [5, 5] }, { type: 'pie', data: [] })
  ok(!chartIsStacked(o), 'nothing stacked yet')
  setChartStacked(o, true)
  ok(o.series.slice(0, 3).every((s: Opt) => s.stack === PANEL_STACK) && o.series[3].stack === undefined,
    'on: every bar AND line series gets the stack key (a pie never does)')
  ok(chartIsStacked(o), '…and reads as stacked')
  setChartStacked(o, false)
  ok(o.series.every((s: Opt) => !('stack' in s)), 'off: the key is removed, not blanked')
  const imported = clone(vertical())
  imported.series[0].stack = 'stack0'
  ok(chartIsStacked(imported), 'one stacked series (an imported stacked column + line combo) reads as stacked')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
