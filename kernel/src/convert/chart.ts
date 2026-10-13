// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// c:chartSpace (ppt/charts/chartN.xml) → OutChart — an ECharts-shaped option
// for charts-lite (kernel/src/charts.ts), the same shape every chart the
// editor creates carries, so an imported chart is as editable as a native one.
//
// WHERE THE DATA LIVES. A chart part references its numbers in the embedded
// workbook (c:f formulas) and CACHES them beside the reference (c:strCache /
// c:numCache, or c:strLit / c:numLit for literal data). The cache is what
// PowerPoint itself paints until the workbook is opened, so it is the truth
// here; the workbook is never read. A series with no cache has no numbers.
//
// WHAT MAPS. bar/column (clustered, stacked, 100%-stacked; vertical or
// horizontal — c:barDir "bar" becomes charts-lite's horizontal shape, a
// category yAxis against a value xAxis), line and area (standard, stacked,
// 100%-stacked), pie/doughnut and scatter, including bar+line combos and a
// secondary value axis. Series names, categories, values, per-series colours (spPr, else the
// theme accent PowerPoint's default chart style picks by c:idx), per-point
// pie colours (c:dPt), value-axis min/max and title, legend, pie data labels,
// and the chart title. charts-lite has no title, so the title becomes a TEXT element
// above the plot, welded to the chart by groupId (the box-with-text idiom
// shapes.ts uses) — editable, and it moves with the chart.
//
// WHAT DOES NOT, honestly reported: 100%-stacked values are frozen as
// percentages, a horizontal chart's secondary axis is merged into its one
// value axis, 3-D is drawn flat, and any other chart type (radar, bubble,
// stock, surface, bar-of-pie, …) is not converted at all — the caller keeps
// its placeholder box. Data labels outside pies, value-axis number formats,
// category-axis titles and hidden axes are not drawn either, each reported.
//
// The elements come back WITHOUT ids — the orchestrator mints them.

import { NS, kid, kids, attr, intAttr, textOf, type XElem } from './xml.ts'
import { resolveColor } from './theme.ts'
import {
  EMU_PER_PX, METRIC_SUBSTITUTES,
  type InheritCtx, type OutChart, type OutText,
} from './types.ts'

const C = NS.c
const r2 = (v: number): number => Math.round(v * 100) / 100
const px = (emu: number): number => Math.round((emu / EMU_PER_PX) * 100) / 100

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const cssFace = (name: string): string => (/[^A-Za-z0-9-]/.test(name) ? `'${name}'` : name)
const fontStack = (face: string): string => {
  const sub = METRIC_SUBSTITUTES[face]
  return sub ? `${cssFace(face)}, ${cssFace(sub)}, sans-serif` : `${cssFace(face)}, sans-serif`
}

/** c:<x> val="…" — the chart schema's ubiquitous single-attribute element. */
const valOf = (el: XElem | undefined, local: string): string | undefined => {
  const k = el ? kid(el, C, local) : undefined
  return k ? attr(k, 'val') ?? '' : undefined
}
/** CT_Boolean: present-without-val means TRUE (the schema default). */
const boolOf = (el: XElem | undefined, local: string): boolean | undefined => {
  const v = valOf(el, local)
  return v === undefined ? undefined : v === '' || v === '1' || v === 'true'
}

/** plotArea group element → the charts-lite family it maps to. */
const GROUP_KIND: Record<string, 'bar' | 'line' | 'area' | 'pie' | 'scatter'> = {
  barChart: 'bar', bar3DChart: 'bar',
  lineChart: 'line', line3DChart: 'line',
  areaChart: 'area', area3DChart: 'area',
  pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'pie',
  scatterChart: 'scatter',
}

// --- caches -------------------------------------------------------------------

/** c:pt children of a cache/literal → values by idx, ptCount long. */
function pts(cache: XElem | undefined): Array<string | undefined> {
  if (!cache) return []
  const out: Array<string | undefined> = []
  const count = kid(cache, C, 'ptCount')
  const n = count ? intAttr(count, 'val', 0) : 0
  for (let i = 0; i < n; i++) out.push(undefined)
  for (const p of kids(cache, C, 'pt')) {
    const v = kid(p, C, 'v')
    const i = intAttr(p, 'idx', out.length)
    if (i < 0 || i > 100000) continue
    while (out.length <= i) out.push(undefined)
    out[i] = v ? textOf(v) : ''
  }
  return out
}

/** The cache inside a data-source holder (c:cat, c:val, c:xVal, c:yVal, c:tx),
 *  whichever of the ref/literal forms it carries; `multi` reports a
 *  multi-level category axis (only its innermost level is kept). */
function cacheOf(holder: XElem | undefined): { cache?: XElem; numeric: boolean; multi: boolean } {
  if (!holder) return { numeric: false, multi: false }
  const strRef = kid(holder, C, 'strRef')
  if (strRef) return { cache: kid(strRef, C, 'strCache'), numeric: false, multi: false }
  const numRef = kid(holder, C, 'numRef')
  if (numRef) return { cache: kid(numRef, C, 'numCache'), numeric: true, multi: false }
  const strLit = kid(holder, C, 'strLit')
  if (strLit) return { cache: strLit, numeric: false, multi: false }
  const numLit = kid(holder, C, 'numLit')
  if (numLit) return { cache: numLit, numeric: true, multi: false }
  const multi = kid(holder, C, 'multiLvlStrRef')
  const mc = multi ? kid(multi, C, 'multiLvlStrCache') : undefined
  if (mc) {
    const lvl = kids(mc, C, 'lvl')[0]
    if (lvl) {
      // a level has c:pt children but no ptCount of its own — borrow the cache's
      const merged: XElem = { ...lvl, children: [...kids(mc, C, 'ptCount'), ...lvl.children] }
      return { cache: merged, numeric: false, multi: true }
    }
  }
  return { numeric: false, multi: false }
}

/** Excel serial date → ISO day. Used only when a numeric category cache's
 *  formatCode is a date format — the axis would otherwise read "44927". */
function serialDate(v: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000))
  return d.toISOString().slice(0, 10)
}

function labelsOf(holder: XElem | undefined): { labels: string[]; multi: boolean } {
  const { cache, numeric, multi } = cacheOf(holder)
  const raw = pts(cache)
  const fc = cache ? kid(cache, C, 'formatCode') : undefined
  const fmt = fc ? textOf(fc) : ''
  const isDate = numeric && /[dmy]/i.test(fmt.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/general/i.test(fmt)
  return {
    labels: raw.map((s) => {
      if (s === undefined) return ''
      const n = Number(s)
      return isDate && Number.isFinite(n) ? serialDate(n) : s
    }),
    multi,
  }
}

function numbersOf(holder: XElem | undefined): Array<number | null> {
  return pts(cacheOf(holder).cache).map((s) => {
    if (s === undefined || s === '') return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  })
}

/** Rich text (c:rich, an a:txBody shape) → html + its first run's look. */
function richOf(rich: XElem): { html: string; text: string; sz?: number; bold?: boolean; fill?: XElem } {
  const lines: string[] = []
  const plain: string[] = []
  let sz: number | undefined
  let bold: boolean | undefined
  let fill: XElem | undefined
  for (const p of kids(rich, NS.a, 'p')) {
    const pPr = kid(p, NS.a, 'pPr')
    const def = pPr ? kid(pPr, NS.a, 'defRPr') : undefined
    let line = ''
    for (const r of kids(p, NS.a)) {
      if (r.local !== 'r' && r.local !== 'fld') continue
      const t = kid(r, NS.a, 't')
      const s = t ? textOf(t) : ''
      if (!s) continue
      const rPr = kid(r, NS.a, 'rPr')
      for (const src of [rPr, def]) {
        if (!src) continue
        if (sz === undefined && attr(src, 'sz') !== undefined) sz = intAttr(src, 'sz', 1400) / 100
        if (bold === undefined && attr(src, 'b') !== undefined) bold = attr(src, 'b') === '1' || attr(src, 'b') === 'true'
        if (!fill) fill = kid(src, NS.a, 'solidFill')
      }
      line += esc(s)
    }
    if (sz === undefined && def && attr(def, 'sz') !== undefined) sz = intAttr(def, 'sz', 1400) / 100
    if (bold === undefined && def && attr(def, 'b') !== undefined) bold = attr(def, 'b') === '1'
    if (!fill && def) fill = kid(def, NS.a, 'solidFill')
    lines.push(line)
    plain.push(line)
  }
  while (lines.length && !lines[lines.length - 1]) { lines.pop(); plain.pop() }
  return { html: lines.join('<br>'), text: plain.join(' ').trim(), sz, bold, fill }
}

/** A c:title's text (rich or cached), '' when it has none. */
function titleTextOf(titleEl: XElem | undefined): string {
  const ttx = titleEl ? kid(titleEl, C, 'tx') : undefined
  if (!ttx) return ''
  const rich = kid(ttx, C, 'rich')
  if (rich) return richOf(rich).text
  return (pts(cacheOf(ttx).cache)[0] ?? '').trim()
}

/** A c:dLbls that would actually print something. */
const labelsShown = (lbls: XElem | undefined): boolean =>
  !!lbls && !boolOf(lbls, 'delete') &&
  ['showVal', 'showCatName', 'showSerName', 'showPercent', 'showBubbleSize'].some((k) => boolOf(lbls, k))

/** c:txPr / c:rich → its first paragraph's defRPr (size, face, colour). */
function defRPrOf(holder: XElem | undefined): XElem | undefined {
  const tx = holder ? kid(holder, C, 'txPr') ?? kid(holder, C, 'rich') : undefined
  const p = tx ? kid(tx, NS.a, 'p') : undefined
  const pPr = p ? kid(p, NS.a, 'pPr') : undefined
  return pPr ? kid(pPr, NS.a, 'defRPr') : undefined
}

// --- the converter ----------------------------------------------------------------

export interface ChartFrame { x: number; y: number; w: number; h: number; rotation: number }

export interface ChartResult {
  chart: OutChart
  /** the chart title, as a text element sitting above the plot */
  title?: OutText
}

interface Series {
  kind: 'bar' | 'line' | 'area' | 'scatter' | 'pie'
  name: string
  idx: number
  order: number
  cats: string[]
  vals: Array<number | null>
  xs?: Array<number | null>
  color?: string
  points: Map<number, string>
  noMarker: boolean
  smooth: boolean
  stack?: string
  axis: number
  labelFmt?: string | false
}

/**
 * Convert one chart part. Returns undefined — after reporting why — when the
 * chart cannot be represented; the caller then keeps its placeholder box.
 */
export function chartFrom(space: XElem, frame: ChartFrame, ctx: InheritCtx, where: string): ChartResult | undefined {
  const chartEl = kid(space, C, 'chart')
  const plot = chartEl ? kid(chartEl, C, 'plotArea') : undefined
  if (!chartEl || !plot) {
    ctx.report.add('dropped', 'chart-unreadable', where, 'the chart part has no plot area — a placeholder box marks the spot')
    return undefined
  }
  const groups = kids(plot, C).filter((k) => GROUP_KIND[k.local])
  const others = kids(plot, C).filter((k) => /Chart$/.test(k.local) && !GROUP_KIND[k.local])
  const kinds = new Set(groups.map((g) => GROUP_KIND[g.local]))
  const why = others.length ? `${others.map((o) => o.local).join(', ')} is not a chart type slidomingo draws`
    : !groups.length ? 'the plot area holds no chart'
    : kinds.has('pie') && groups.length > 1 ? 'a pie combined with other chart types'
    : kinds.has('scatter') && kinds.size > 1 ? 'a scatter combined with other chart types'
    : undefined
  if (why) {
    ctx.report.add('dropped', 'chart-type-unsupported', where, `${why} — a placeholder box marks the spot`)
    return undefined
  }

  const accents = [1, 2, 3, 4, 5, 6].map((i) => ctx.theme.scheme[`accent${i}`]).filter((c): c is string => !!c)
  const accent = (i: number): string | undefined => (accents.length ? accents[((i % accents.length) + accents.length) % accents.length] : undefined)
  const solid = (spPr: XElem | undefined, line: boolean): string | undefined => {
    if (!spPr) return undefined
    const holder = line ? kid(spPr, NS.a, 'ln') : spPr
    const f = holder ? kid(holder, NS.a, 'solidFill') : undefined
    return f ? resolveColor(f, ctx.theme)?.css : undefined
  }

  // value axes: the first group's valAx is primary; a group on any other is secondary
  const axIds = (g: XElem): string => kids(g, C, 'axId').map((a) => attr(a, 'val')).join(',')
  const primaryAx = groups.length ? axIds(groups[0]) : ''

  const series: Series[] = []
  let multiCats = false
  let horizontal = false
  let percent = false
  let threeD = false
  let dataLabels = false
  groups.forEach((g, gi) => {
    const kind = GROUP_KIND[g.local]
    if (g.local.includes('3D')) threeD = true
    const grouping = valOf(g, 'grouping') ?? 'clustered'
    const stacked = grouping === 'stacked' || grouping === 'percentStacked'
    if (kind === 'bar' && valOf(g, 'barDir') === 'bar') horizontal = true
    const vary = boolOf(g, 'varyColors') ?? kind === 'pie'
    const groupLbls = kid(g, C, 'dLbls')
    if (kind !== 'pie' && labelsShown(groupLbls)) dataLabels = true
    const groupSers: Series[] = []
    for (const ser of kids(g, C, 'ser')) {
      const idx = intAttr(kid(ser, C, 'idx') ?? ser, 'val', series.length)
      const order = intAttr(kid(ser, C, 'order') ?? ser, 'val', idx)
      const tx = kid(ser, C, 'tx')
      const txV = tx ? kid(tx, C, 'v') : undefined
      const nameRaw = tx ? pts(cacheOf(tx).cache)[0] ?? (txV ? textOf(txV) : undefined) : undefined
      const spPr = kid(ser, C, 'spPr')
      const markerEl = kid(ser, C, 'marker')
      // a line's colour is its stroke, a scatter's its marker (then stroke),
      // everything else's its fill; unset → the default style's accent by idx
      const color = (kind === 'line' ? solid(spPr, true)
        : kind === 'scatter' ? solid(markerEl ? kid(markerEl, C, 'spPr') : undefined, false) ?? solid(spPr, true)
        : solid(spPr, false)) ?? accent(idx)
      const cat = labelsOf(kind === 'scatter' ? undefined : kid(ser, C, 'cat'))
      if (cat.multi) multiCats = true
      const s: Series = {
        kind, name: nameRaw ?? `Series ${idx + 1}`, idx, order,
        cats: cat.labels,
        vals: numbersOf(kind === 'scatter' ? kid(ser, C, 'yVal') : kid(ser, C, 'val')),
        points: new Map(),
        noMarker: valOf(markerEl, 'symbol') === 'none',
        smooth: boolOf(ser, 'smooth') ?? false,
        axis: gi > 0 && axIds(g) !== primaryAx ? 1 : 0,
      }
      if (color) s.color = color
      if (kind === 'scatter') {
        const xh = kid(ser, C, 'xVal')
        const { numeric } = cacheOf(xh)
        s.xs = numeric ? numbersOf(xh) : s.vals.map((_, i) => i + 1)
      }
      if (stacked) s.stack = `stack${gi}`
      if (kind !== 'pie' && labelsShown(kid(ser, C, 'dLbls'))) dataLabels = true
      if (kind === 'pie') {
        const n = Math.max(s.vals.length, s.cats.length)
        for (let i = 0; i < n; i++) {
          const c = vary ? accent(i) : color
          if (c) s.points.set(i, c)
        }
        for (const dPt of kids(ser, C, 'dPt')) {
          const c = solid(kid(dPt, C, 'spPr'), false)
          if (c) s.points.set(intAttr(kid(dPt, C, 'idx') ?? dPt, 'val', -1), c)
        }
        const lbls = kid(ser, C, 'dLbls') ?? groupLbls
        const parts: string[] = []
        if (lbls && boolOf(lbls, 'showCatName')) parts.push('{b}')
        if (lbls && boolOf(lbls, 'showVal')) parts.push('{c}')
        if (lbls && boolOf(lbls, 'showPercent')) parts.push('{d}%')
        s.labelFmt = parts.length ? parts.join(': ') : false
      }
      groupSers.push(s)
    }
    if (grouping === 'percentStacked' && groupSers.length) {
      // freeze to shares of each category's total — charts-lite stacks
      // values, it has no 100% mode
      percent = true
      const n = Math.max(...groupSers.map((s) => s.vals.length))
      for (let i = 0; i < n; i++) {
        const total = groupSers.reduce((a, s) => a + Math.abs(s.vals[i] ?? 0), 0)
        for (const s of groupSers) {
          const v = s.vals[i]
          if (v !== null && v !== undefined) s.vals[i] = total ? r2((v / total) * 100) : 0
        }
      }
    }
    series.push(...groupSers.sort((a, b) => a.order - b.order))
  })

  if (!series.length || series.every((s) => s.vals.every((v) => v === null))) {
    ctx.report.add('dropped', 'chart-no-data', where,
      'the chart carries no cached values (only workbook references) — a placeholder box marks the spot')
    return undefined
  }

  // ---- text: base size + face from c:txPr, PowerPoint's 10pt default
  const baseDef = defRPrOf(space)
  const basePt = baseDef && attr(baseDef, 'sz') !== undefined ? intAttr(baseDef, 'sz', 1000) / 100 : 10
  const latin = baseDef ? kid(baseDef, NS.a, 'latin') : undefined
  const faceRaw = (latin ? attr(latin, 'typeface') : undefined) ?? '+mn-lt'
  const face = faceRaw === '+mj-lt' ? ctx.theme.majorFont : faceRaw === '+mn-lt' ? ctx.theme.minorFont : faceRaw
  const fontPx = r2(basePt * (4 / 3))
  const inkDef = baseDef ? resolveColor(kid(baseDef, NS.a, 'solidFill'), ctx.theme)?.css : undefined
  const ink = inkDef ?? '#595959' // tx1 at 65% — PowerPoint's default chart text

  // ---- title
  const titleEl = kid(chartEl, C, 'title')
  let titleText: { html: string; sz?: number; bold?: boolean; fill?: XElem } | undefined
  if (titleEl && !boolOf(chartEl, 'autoTitleDeleted')) {
    const ttx = kid(titleEl, C, 'tx')
    const rich = ttx ? kid(ttx, C, 'rich') : undefined
    if (rich) {
      const r = richOf(rich)
      if (r.text) titleText = r
    } else if (ttx) {
      const s = pts(cacheOf(ttx).cache)[0]
      if (s) titleText = { html: esc(s) }
    } else if (series.length === 1) {
      // an auto title: PowerPoint shows the lone series' name
      const def = defRPrOf(titleEl)
      titleText = { html: esc(series[0].name), sz: def && attr(def, 'sz') !== undefined ? intAttr(def, 'sz', 1400) / 100 : undefined }
    }
    if (titleText && !titleText.sz) {
      const def = defRPrOf(titleEl)
      if (def && attr(def, 'sz') !== undefined) titleText.sz = intAttr(def, 'sz', 1400) / 100
    }
  }

  // ---- the option
  const legendEl = kid(chartEl, C, 'legend')
  const legendPos = valOf(legendEl, 'legendPos') ?? 'r'
  const legend = legendEl
    ? { ...(legendPos === 't' ? { top: 0 } : { bottom: 0 }), textStyle: { color: ink, fontSize: fontPx } }
    : undefined
  const axisLabel = { color: ink, fontSize: fontPx }
  const option: Record<string, unknown> = { textStyle: { fontFamily: fontStack(face) } }
  if (accents.length) option.color = accents

  const isPie = kinds.has('pie')
  let preset: OutChart['preset']
  if (isPie) {
    preset = 'pie'
    const s = series[0]
    const n = Math.max(s.vals.length, s.cats.length)
    const colors: string[] = []
    const data = []
    for (let i = 0; i < n; i++) {
      data.push({ name: s.cats[i] || String(i + 1), value: Math.max(0, s.vals[i] ?? 0) })
      colors.push(s.points.get(i) ?? accent(i) ?? '#4472C4')
    }
    const hole = groups[0].local === 'doughnutChart' ? Math.min(90, Math.max(10, intAttr(kid(groups[0], C, 'holeSize') ?? groups[0], 'val', 50))) : 0
    const outer = 72
    option.color = colors
    option.tooltip = { trigger: 'item' }
    option.series = [{
      type: 'pie', name: s.name,
      radius: hole ? [`${r2((outer * hole) / 100)}%`, `${outer}%`] : `${outer}%`,
      label: s.labelFmt ? { formatter: s.labelFmt, color: ink } : false,
      data,
    }]
    if (series.length > 1) {
      ctx.report.add('approximated', 'chart-pie-extra-series', where,
        'a pie draws one series; the first is imported and the others are dropped')
    }
  } else if (kinds.has('scatter')) {
    preset = 'scatter'
    option.tooltip = { trigger: 'item' }
    option.xAxis = { type: 'value', axisLabel }
    option.series = series.map((s) => ({
      type: 'scatter', name: s.name, symbolSize: 9,
      ...(s.color ? { itemStyle: { color: s.color } } : {}),
      data: s.vals.map((v, i) => [s.xs?.[i] ?? i + 1, v ?? 0]).filter((_, i) => s.vals[i] !== null),
    }))
  } else {
    preset = kinds.has('bar') ? 'bar' : 'line'
    const n = Math.max(...series.map((s) => Math.max(s.vals.length, s.cats.length)))
    const catsFrom = series.find((s) => s.cats.some((c) => c)) ?? series[0]
    const cats = Array.from({ length: n }, (_, i) => catsFrom.cats[i] || String(i + 1))
    option.tooltip = { trigger: 'axis' }
    // horizontal bars: the categories go on yAxis (set with the value axis below)
    if (!horizontal) option.xAxis = { type: 'category', data: cats, axisLabel }
    else option.yAxis = { type: 'category', data: cats, axisLabel }
    option.series = series.map((s) => {
      const data = Array.from({ length: n }, (_, i) => s.vals[i] ?? 0)
      const base: Record<string, unknown> = { type: s.kind === 'area' ? 'line' : s.kind, name: s.name, data }
      if (s.stack) base.stack = s.stack
      // charts-lite draws ONE value axis across horizontal bars
      if (s.axis && !horizontal) base.yAxisIndex = 1
      if (s.kind === 'bar') {
        if (s.color) base.itemStyle = { color: s.color }
      } else {
        if (s.color) base.lineStyle = { color: s.color, width: 2.5 }
        if (s.smooth) base.smooth = true
        if (s.kind === 'area') {
          base.areaStyle = s.color ? { color: s.color } : {}
          base.symbol = 'none'
        } else if (s.noMarker) base.symbol = 'none'
      }
      return base
    })
  }

  // axes whose look was carried (their title among it); every other axis
  // feature is checked against this below
  const carriedAxes = new Set<XElem>()
  let numFormat = false
  let mergedAxis = false
  if (!isPie) {
    const valAxes = kids(plot, C, 'valAx')
    const axisCfg = (ax: XElem | undefined): Record<string, unknown> => {
      const cfg: Record<string, unknown> = { type: 'value', axisLabel: { ...axisLabel } }
      if (!ax) return cfg
      carriedAxes.add(ax)
      const sc = kid(ax, C, 'scaling')
      const min = valOf(sc, 'min')
      const max = valOf(sc, 'max')
      if (min !== undefined && Number.isFinite(Number(min))) cfg.min = Number(min)
      if (max !== undefined && Number.isFinite(Number(max))) cfg.max = Number(max)
      // charts-lite draws a value axis's name above its labels
      const name = titleTextOf(kid(ax, C, 'title'))
      if (name) cfg.name = name
      // a source-linked format is the data's own (General in practice); an
      // explicit one (0%, #,##0 "kg", …) has no charts-lite formatter
      const nf = kid(ax, C, 'numFmt')
      const code = nf ? attr(nf, 'formatCode') ?? '' : ''
      if (nf && attr(nf, 'sourceLinked') !== '1' && code && !/^general$/i.test(code)) numFormat = true
      return cfg
    }
    // each group names its axes by c:axId; its value axis is the valAx
    // carrying one of those ids. A scatter group names TWO valAx — x first
    // (c:axPos b), then y.
    const axisOf = (g: XElem | undefined): XElem | undefined => {
      if (!g) return undefined
      const ids = new Set(kids(g, C, 'axId').map((a) => attr(a, 'val')))
      const mine = valAxes.filter((a) => ids.has(valOf(a, 'axId')))
      if (kinds.has('scatter')) return mine.find((a) => valOf(a, 'axPos') === 'l' || valOf(a, 'axPos') === 'r') ?? mine[1]
      return mine[0]
    }
    const y0 = axisCfg(axisOf(groups[0]))
    if (percent) {
      Object.assign(y0, { min: 0, max: 100, axisLabel: { ...axisLabel, formatter: '{value}%' } })
      numFormat = false // the frozen shares carry their own % formatter
    }
    const second = groups.find((g, gi) => gi > 0 && axIds(g) !== primaryAx)
    if (horizontal) {
      // the value axis runs along the bottom; the category axis (already
      // option.yAxis) takes its title and its direction from the c:catAx
      option.xAxis = y0
      mergedAxis = !!second
      const ids = new Set(kids(groups[0], C, 'axId').map((a) => attr(a, 'val')))
      const catAx = kids(plot, C).find((a) => (a.local === 'catAx' || a.local === 'dateAx') && ids.has(valOf(a, 'axId')))
      if (catAx) {
        const cat = option.yAxis as Record<string, unknown>
        const name = titleTextOf(kid(catAx, C, 'title'))
        if (name) { cat.name = name; carriedAxes.add(catAx) }
        // PowerPoint lists a bar chart's categories bottom-up; maxMin flips
        // them top-down, which is ECharts' inverse
        if (valOf(kid(catAx, C, 'scaling'), 'orientation') === 'maxMin') cat.inverse = true
      }
    } else {
      option.yAxis = second ? [y0, axisCfg(axisOf(second))] : y0
    }
  }
  if (legend) option.legend = legend
  // no zoom on horizontal bars (charts-lite ignores it there anyway)
  if (!isPie && !kinds.has('scatter') && !horizontal) option.dataZoom = [{ type: 'inside' }]

  // ---- honest notes
  if (mergedAxis) {
    ctx.report.add('approximated', 'chart-secondary-axis-merged', where,
      'a horizontal bar chart draws one value axis — the secondary axis’s series share the primary one')
  }
  if (percent) {
    ctx.report.add('approximated', 'chart-percent-frozen', where,
      '100% stacked values are frozen to percentages at import — the raw values are not kept')
  }
  if (threeD) {
    ctx.report.add('approximated', 'chart-3d-flattened', where, 'a 3-D chart is drawn flat')
  }
  if (multiCats) {
    ctx.report.add('approximated', 'chart-category-levels', where,
      'multi-level category labels keep only their innermost level')
  }
  if (dataLabels) {
    ctx.report.add('approximated', 'chart-data-labels-dropped', where,
      'data labels on bars/lines/points have no charts-lite equivalent — the values show in the tooltip instead')
  }
  if (numFormat) {
    ctx.report.add('approximated', 'chart-number-format-dropped', where,
      'the value axis has its own number format (e.g. 0% or a unit) — its labels show the plain numbers')
  }
  const axes = kids(plot, C).filter((k) => /^(cat|val|date|ser)Ax$/.test(k.local))
  if (!isPie && axes.some((a) => !carriedAxes.has(a) && titleTextOf(kid(a, C, 'title')))) {
    ctx.report.add('approximated', 'chart-axis-title-dropped', where,
      'a category-axis title has no charts-lite equivalent on columns/lines — value-axis titles (and a horizontal bar chart’s category title) are kept')
  }
  if (!isPie && axes.some((a) => boolOf(a, 'delete'))) {
    ctx.report.add('approximated', 'chart-axis-hidden-shown', where,
      'a hidden axis is drawn anyway — charts-lite always draws its axes')
  }
  if (legendEl && legendPos !== 't' && legendPos !== 'b') {
    ctx.report.add('approximated', 'chart-legend-moved', where,
      `legend position "${legendPos}" has no charts-lite equivalent — drawn below the plot`)
  }
  ctx.report.add('carried', 'chart-imported', where,
    'the chart is a native, editable chart: series, categories and values come from the chart’s cached data')

  // ---- elements: title strip on top, the plot below it
  const x = px(frame.x), y = px(frame.y), w = px(frame.w), h = px(frame.h)
  const rotation = r2(frame.rotation)
  let title: OutText | undefined
  let plotY = y
  let plotH = h
  if (titleText) {
    const sizePx = r2((titleText.sz ?? r2(basePt * 1.4)) * (4 / 3))
    const lines = titleText.html.split('<br>').length
    const th = r2(Math.min(h / 2, sizePx * 1.2 * lines + 12))
    const overlay = boolOf(titleEl, 'overlay') ?? false
    const tInk = titleText.fill ? resolveColor(titleText.fill, ctx.theme)?.css : undefined
    title = {
      id: '', type: 'text', x, y, w, h: th, rotation, opacity: 1,
      html: titleText.html, fontSize: sizePx, fontFamily: fontStack(face),
      fontWeight: titleText.bold ? 700 : 400, color: tInk ?? ink,
      align: 'center', valign: 'middle', lineHeight: 1.2,
    }
    if (!overlay) { plotY = r2(y + th); plotH = r2(h - th) }
  }
  const chart: OutChart = {
    id: '', type: 'chart', x, y: plotY, w, h: plotH, rotation, opacity: 1,
    preset, option,
  }
  return title ? { chart, title } : { chart }
}
