// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Orientation + stacking edits on a chart option (the ECharts shape charts-lite
// reads). Pure — no DOM — so scripts/test-chart-edit.ts pins it, and shared by
// the chart panel (editor/panels.ts) and the table→chart binding
// (model.syncLinkedChart), which must write the categories to whichever axis
// holds them.
//
// A chart is HORIZONTAL when its first yAxis is the category axis and xAxis is
// not (charts-lite's digest uses the same test). Then `yAxis` holds the
// categories and `xAxis` the ONE value axis; otherwise `xAxis` holds the
// categories and `yAxis` one or two value axes.

type Opt = Record<string, any>

/** ECharts allows one axis object or an array of them; the first one. */
const first = (v: unknown): Opt | undefined => {
  const x = Array.isArray(v) ? v[0] : v
  return x && typeof x === 'object' ? (x as Opt) : undefined
}

/** True for the horizontal-bar shape: category yAxis, value xAxis. */
export function chartIsHorizontal(o: Opt): boolean {
  return first(o?.yAxis)?.type === 'category' && first(o?.xAxis)?.type !== 'category'
}

/** The option key that holds the categories. */
export const catAxisKey = (o: Opt): 'xAxis' | 'yAxis' => (chartIsHorizontal(o) ? 'yAxis' : 'xAxis')

/** The option key that holds the value axis (or axes). */
export const valueAxisKey = (o: Opt): 'xAxis' | 'yAxis' => (chartIsHorizontal(o) ? 'xAxis' : 'yAxis')

/** The category axis object, created (as `{type:'category', data:[]}`) when
 *  missing, with a `data` array guaranteed — for writers. */
export function ensureCatAxis(o: Opt): Opt {
  const key = catAxisKey(o)
  let ax = first(o[key])
  if (!ax) { ax = { type: 'category' }; o[key] = ax }
  if (!Array.isArray(ax.data)) ax.data = []
  return ax
}

/** The categories (read-only view; [] when there are none). */
export function chartCategories(o: Opt): unknown[] {
  const ax = first(o?.[catAxisKey(o)])
  return Array.isArray(ax?.data) ? ax.data : []
}

/**
 * Turn the bars sideways (or upright again) by swapping the axes. Going
 * horizontal keeps only the FIRST value axis — charts-lite draws one value
 * axis across horizontal bars — so the series' yAxisIndex goes too. Going
 * back drops the category axis' `inverse` (columns ignore it). No-op when the
 * chart is already that way round. Returns whether it changed anything.
 */
export function setChartHorizontal(o: Opt, on: boolean): boolean {
  if (chartIsHorizontal(o) === on) return false
  const series: Opt[] = Array.isArray(o.series) ? o.series : o.series ? [o.series] : []
  if (on) {
    const cat = first(o.xAxis) ?? {}
    const val = first(o.yAxis) ?? {}
    o.yAxis = { ...cat, type: 'category' }
    o.xAxis = { ...val, type: 'value' }
    for (const s of series) if (s && typeof s === 'object') delete s.yAxisIndex
  } else {
    const cat: Opt = { ...(first(o.yAxis) ?? {}), type: 'category' }
    delete cat.inverse
    const val = first(o.xAxis) ?? {}
    o.xAxis = cat
    o.yAxis = { ...val, type: 'value' }
  }
  return true
}

const stackable = (o: Opt): Opt[] =>
  (Array.isArray(o?.series) ? o.series : o?.series ? [o.series] : [])
    .filter((s: Opt) => s && (s.type === 'bar' || s.type === 'line'))

/** True when any bar/line series carries a stack key — an imported stacked
 *  column chart with an unstacked line on top still reads as stacked. */
export function chartIsStacked(o: Opt): boolean {
  return stackable(o).some((s) => typeof s.stack === 'string' && s.stack !== '')
}

/** The stack key the panel writes. charts-lite keys stacks per value axis and
 *  piles bars and lines separately, so one name is enough. */
export const PANEL_STACK = 'total'

/** Stack every bar/line series (on) or none (off). */
export function setChartStacked(o: Opt, on: boolean): void {
  for (const s of stackable(o)) {
    if (on) s.stack = PANEL_STACK
    else delete s.stack
  }
}
