// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The chart and table element panels: chart type, series, data grid and pie
// slices; table size, look, cells and the table → chart bridge.

import { applyChartPalette, defaultChart, tableStyleFor, type ChartElement, type TableElement } from '../../model'
import { CHART_PRESETS } from '../../charts'
import { catAxisKey, chartCategories, chartIsHorizontal, chartIsStacked, ensureCatAxis, setChartHorizontal, setChartStacked, valueAxisKey } from '../../chartaxes'
import { t } from '../../i18n'
import { TABLE_OPS } from '../tablerange'
import { deleteColumns, deleteRows, insertColumn, insertRow } from '../../tablespans'
import { type PanelContext, toast } from './context'

export function buildChartProps(ctx: PanelContext, el: ChartElement) {
  const opt = el.option as Record<string, any>
  const series: any[] = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []
  const isPie = series.some((s) => s?.type === 'pie')
  const isScatter = series.some((s) => s?.type === 'scatter')
  // live table binding banner (if this chart tracks a table)
  if (el.source?.tableId) {
    const linkRow = document.createElement('div')
    linkRow.className = 'ed-chart-link'
    const label = document.createElement('span')
    const stillThere = ctx.store.slide.elements.some((e) => e.id === el.source!.tableId && e.type === 'table')
    label.textContent = stillThere ? t('🔗 Live-linked to a table') : t('🔗 Linked table not on this slide')
    const unlink = document.createElement('button')
    unlink.className = 'ed-btn'
    unlink.textContent = t('Unlink')
    unlink.title = t('Stop tracking the table; the chart keeps its current data')
    unlink.addEventListener('click', () => ctx.mutate(el.id, (e) => { delete (e as ChartElement).source }, true))
    linkRow.append(label, unlink)
    ctx.host.appendChild(linkRow)
  }
  ctx.row('Type', ctx.select(Object.keys(CHART_PRESETS), el.preset ?? 'bar', (v) =>
    ctx.mutate(el.id, (e) => {
      const c = e as ChartElement
      c.preset = v
      c.option = applyChartPalette(CHART_PRESETS[v](), ctx.store.doc.theme)
    }, true)))

  if (!isPie && !isScatter) buildChartCartesian(ctx, el, opt, series)
  else if (isPie) buildChartPie(ctx, el, series)
}

/** The escape hatch: the full option as JSON, for anything the UI omits.
 *  Rendered inside the Advanced section (buildAdvancedProps). */
export function buildChartJson(ctx: PanelContext, el: ChartElement) {
  ctx.subhead(t('Chart option (JSON)'))
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.innerHTML = t('The full <b>chart option</b> as JSON (pure data — use template-string formatters like <code>{b}: {c}</code>, never functions). Tooltips and zoom run while presenting.')
  ctx.host.appendChild(hint)
  const ta = document.createElement('textarea')
  ta.className = 'ed-chart-json'
  ta.rows = 12
  ta.spellcheck = false
  ta.value = JSON.stringify(el.option, null, 2)
  ta.addEventListener('change', () => {
    try {
      const parsed = JSON.parse(ta.value)
      ta.classList.remove('ed-invalid')
      ctx.mutate(el.id, (e) => { (e as ChartElement).option = parsed }, true)
    } catch { ta.classList.add('ed-invalid') }
  })
  ctx.host.appendChild(ta)
}

function seriesColor(s: any, palette: string[] | undefined, i: number): string {
  const c = s?.type === 'line' ? s?.lineStyle?.color : s?.itemStyle?.color
  if (typeof c === 'string') return c
  const p = palette && palette.length ? palette : ['#5470c6', '#91cc75', '#fac858', '#ee6666']
  return p[i % p.length]
}

function setSeriesColor(s: any, v: string) {
  if (s?.type === 'line') s.lineStyle = { ...(s.lineStyle ?? {}), color: v }
  else s.itemStyle = { ...(s.itemStyle ?? {}), color: v }
}

function buildChartCartesian(ctx: PanelContext, el: ChartElement, opt: Record<string, any>, series: any[]) {
  // horizontal bars keep their ONE value axis on xAxis (chartaxes.ts)
  const horizontal = chartIsHorizontal(opt)
  const valKey = valueAxisKey(opt)
  const yAxis: any[] = Array.isArray(opt[valKey]) ? opt[valKey] : opt[valKey] ? [opt[valKey]] : [{ type: 'value' }]
  const twoAxes = !horizontal && yAxis.length > 1

  ctx.row('Legend', ctx.toggle(!!opt.legend, (on) =>
    ctx.editOption(el.id, (o) => { if (on) o.legend = { bottom: 0 }; else delete o.legend })))
  // orientation is a bar chart's choice; a line-only chart offers it only
  // when it is already sideways, so it can be turned back
  if (horizontal || series.some((s) => s?.type === 'bar')) {
    ctx.row('Bar direction', ctx.labeledSelect([['vertical', t('Vertical')], ['horizontal', t('Horizontal')]],
      horizontal ? 'horizontal' : 'vertical',
      (v) => ctx.editOption(el.id, (o) => { setChartHorizontal(o, v === 'horizontal') })))
  }
  ctx.row('Stacked', ctx.toggle(chartIsStacked(opt), (on) =>
    ctx.editOption(el.id, (o) => setChartStacked(o, on))))

  // The data is what a chart is FOR — its grid stays an open section right
  // under the basics; series styling and axes are the "more".
  buildChartGrid(ctx, el, opt, series)

  ctx.section('Series')
  // one value axis across horizontal bars — no second axis to offer
  if (!horizontal) ctx.row('Second axis', ctx.toggle(twoAxes, (on) => ctx.editOption(el.id, (o) => {
    const ss: any[] = Array.isArray(o.series) ? o.series : o.series ? [o.series] : []
    if (on) {
      const first = Array.isArray(o.yAxis) ? (o.yAxis[0] ?? {}) : (o.yAxis ?? {})
      o.yAxis = [{ type: 'value', ...first }, { type: 'value', name: t('Axis {n}', { n: 2 }) }]
      ss.forEach((s, i) => { if (s) s.yAxisIndex = i === 0 ? 0 : 1 })
    } else {
      o.yAxis = { type: 'value', ...(Array.isArray(o.yAxis) ? o.yAxis[0] : o.yAxis) }
      ss.forEach((s) => { if (s) delete s.yAxisIndex })
    }
  })))

  // --- series list --------------------------------------------------------
  const palette: string[] | undefined = Array.isArray(opt.color) ? opt.color : undefined
  series.forEach((s, i) => {
    const row = document.createElement('div')
    row.className = 'ed-series-row'
    const name = document.createElement('input')
    name.type = 'text'; name.className = 'ed-series-name'; name.value = s?.name ?? ''
    name.placeholder = t('Series {n}', { n: i + 1 })
    name.addEventListener('input', () => ctx.editOption(el.id, (o) => { o.series[i].name = name.value }, false))
    name.addEventListener('change', () => ctx.editOption(el.id, (o) => { o.series[i].name = name.value }, true))
    const type = ctx.labeledSelect([['bar', t('Bar')], ['line', t('Line')]], s?.type === 'line' ? 'line' : 'bar',
      (v) => ctx.editOption(el.id, (o) => { o.series[i].type = v }))
    row.append(name, type)
    if (twoAxes) {
      row.append(ctx.labeledSelect([['0', t('Left')], ['1', t('Right')]], String(Math.round(s?.yAxisIndex ?? 0)),
        (v) => ctx.editOption(el.id, (o) => { o.series[i].yAxisIndex = parseInt(v) })))
    }
    row.append(ctx.color(seriesColor(s, palette, i), (v, final) =>
      ctx.editOption(el.id, (o) => setSeriesColor(o.series[i], v), final)))
    const rm = ctx.opBtn('✕', t('Remove'), () => ctx.editOption(el.id, (o) => {
      o.series.splice(i, 1)
      if (o.series.length <= 1) { o.series.forEach((x: any) => x && delete x.yAxisIndex); if (Array.isArray(o.yAxis)) o.yAxis = o.yAxis[0] ?? { type: 'value' } }
    }))
    rm.classList.add('ed-series-rm')
    row.append(rm)
    ctx.host.appendChild(row)
  })
  const addRow = document.createElement('div')
  addRow.className = 'ed-chart-add'
  const addBtn = document.createElement('button')
  addBtn.className = 'ed-btn'
  addBtn.textContent = t('＋ Add series')
  addBtn.title = t('Add chart series')
  addBtn.addEventListener('click', () => ctx.editOption(el.id, (o) => {
    const ss: any[] = Array.isArray(o.series) ? o.series : o.series ? [o.series] : []
    const n = chartCategories(o).length || 4
    ss.push({ type: 'bar', name: t('Series {n}', { n: ss.length + 1 }), data: Array(n).fill(0) })
    o.series = ss
  }))
  addRow.appendChild(addBtn)
  ctx.host.appendChild(addRow)

  // --- per-axis min/max ---------------------------------------------------
  yAxis.forEach((ax, ai) => {
    const label = twoAxes ? (ai === 0 ? t('Left axis') : t('Right axis')) : horizontal ? t('Value axis') : t('Y axis')
    const wrap = document.createElement('div')
    wrap.className = 'ed-axis-range'
    const mk = (key: 'min' | 'max', ph: string) => {
      const inp = document.createElement('input')
      inp.type = 'number'; inp.placeholder = ph
      inp.value = typeof ax?.[key] === 'number' ? String(ax[key]) : ''
      const commit = (final: boolean) => ctx.editOption(el.id, (o) => {
        const k = valueAxisKey(o)
        const a = Array.isArray(o[k]) ? o[k][ai] : o[k]
        const raw = inp.value.trim()
        if (raw === '' || Number.isNaN(parseFloat(raw))) delete a[key]
        else a[key] = parseFloat(raw)
      }, final)
      inp.addEventListener('input', () => commit(false))
      inp.addEventListener('change', () => commit(true))
      return inp
    }
    wrap.append(mk('min', t('min')), mk('max', t('max')))
    ctx.row(label, wrap)
  })
}

/** Editable categories × series grid. Adding/removing rows keeps every
 *  series data array and the x-axis categories in lockstep. */
function buildChartGrid(ctx: PanelContext, el: ChartElement, opt: Record<string, any>, series: any[]) {
  // the categories sit on yAxis when the bars are horizontal
  const cats: any[] = chartCategories(opt)
  ctx.section('Data')
  const scroll = document.createElement('div')
  scroll.className = 'ed-chart-grid-wrap'
  const table = document.createElement('table')
  table.className = 'ed-chart-grid'
  const thead = document.createElement('tr')
  const corner = document.createElement('th'); corner.textContent = ''
  thead.appendChild(corner)
  series.forEach((s, i) => {
    const th = document.createElement('th')
    th.textContent = s?.name || t('Series {n}', { n: i + 1 })
    thead.appendChild(th)
  })
  thead.appendChild(document.createElement('th'))
  table.appendChild(thead)

  const cellInput = (value: string, onCommit: (v: string, final: boolean) => void, numeric: boolean) => {
    const inp = document.createElement('input')
    inp.type = numeric ? 'number' : 'text'
    inp.value = value
    inp.addEventListener('input', () => onCommit(inp.value, false))
    inp.addEventListener('change', () => onCommit(inp.value, true))
    return inp
  }

  const rowCount = Math.max(cats.length, ...series.map((s) => (s?.data?.length ?? 0)))
  for (let r = 0; r < rowCount; r++) {
    const tr = document.createElement('tr')
    const cat = document.createElement('td')
    cat.appendChild(cellInput(String(cats[r] ?? ''), (v, final) => ctx.editOption(el.id, (o) => {
      ensureCatAxis(o).data[r] = v
    }, final), false))
    tr.appendChild(cat)
    series.forEach((s, i) => {
      const td = document.createElement('td')
      td.appendChild(cellInput(String(s?.data?.[r] ?? ''), (v, final) => ctx.editOption(el.id, (o) => {
        const arr = o.series[i].data ?? (o.series[i].data = [])
        const n = parseFloat(v)
        arr[r] = Number.isNaN(n) ? 0 : n
      }, final), true))
      tr.appendChild(td)
    })
    const rmTd = document.createElement('td')
    rmTd.appendChild(ctx.opBtn('✕', t('Remove row'), () => ctx.editOption(el.id, (o) => {
      const ca = o[catAxisKey(o)]
      if (Array.isArray(ca?.data)) ca.data.splice(r, 1)
      o.series.forEach((s: any) => { if (Array.isArray(s?.data)) s.data.splice(r, 1) })
    })))
    tr.appendChild(rmTd)
    table.appendChild(tr)
  }
  scroll.appendChild(table)
  ctx.host.appendChild(scroll)

  const addRow = document.createElement('div')
  addRow.className = 'ed-chart-add'
  const addBtn = document.createElement('button')
  addBtn.className = 'ed-btn'
  addBtn.textContent = t('＋ Add row')
  addBtn.title = t('Add row')
  addBtn.addEventListener('click', () => ctx.editOption(el.id, (o) => {
    const ca = ensureCatAxis(o)
    ca.data.push(t('Item {n}', { n: ca.data.length + 1 }))
    const ss: any[] = Array.isArray(o.series) ? o.series : [o.series]
    ss.forEach((s) => { if (s) (s.data ?? (s.data = [])).push(0) })
  }))
  addRow.appendChild(addBtn)
  ctx.host.appendChild(addRow)
}

/** Pie: one row per slice (name · value · colour · remove) + add. */
function buildChartPie(ctx: PanelContext, el: ChartElement, series: any[]) {
  const s = series.find((x) => x?.type === 'pie') ?? series[0]
  const data: any[] = s?.data ?? []
  const palette: string[] | undefined = Array.isArray((el.option as any).color) ? (el.option as any).color : undefined
  ctx.section('Slices')
  data.forEach((d, i) => {
    const row = document.createElement('div')
    row.className = 'ed-series-row'
    const name = document.createElement('input')
    name.type = 'text'; name.className = 'ed-series-name'; name.value = d?.name ?? ''
    name.addEventListener('input', () => editPieDatum(ctx, el.id, i, (x) => { x.name = name.value }, false))
    name.addEventListener('change', () => editPieDatum(ctx, el.id, i, (x) => { x.name = name.value }, true))
    const val = document.createElement('input')
    val.type = 'number'; val.className = 'ed-pie-val'; val.value = String(d?.value ?? 0)
    const commitVal = (final: boolean) => editPieDatum(ctx, el.id, i, (x) => { const n = parseFloat(val.value); x.value = Number.isNaN(n) ? 0 : n }, final)
    val.addEventListener('input', () => commitVal(false))
    val.addEventListener('change', () => commitVal(true))
    const swatch = ctx.color((palette && palette[i]) || seriesColor({ type: 'pie' }, palette, i), (v, final) =>
      ctx.editOption(el.id, (o) => { if (!Array.isArray(o.color)) o.color = []; o.color[i] = v }, final))
    const rm = ctx.opBtn('✕', t('Remove'), () => editPieDatum(ctx, el.id, i, null, true))
    rm.classList.add('ed-series-rm')
    row.append(name, val, swatch, rm)
    ctx.host.appendChild(row)
  })
  const addRow = document.createElement('div')
  addRow.className = 'ed-chart-add'
  const addBtn = document.createElement('button')
  addBtn.className = 'ed-btn'
  addBtn.textContent = t('＋ Add slice')
  addBtn.title = t('Add slice')
  addBtn.addEventListener('click', () => ctx.editOption(el.id, (o) => {
    const ps = (Array.isArray(o.series) ? o.series : [o.series]).find((x: any) => x?.type === 'pie') ?? o.series[0]
    ps.data = ps.data ?? []
    ps.data.push({ name: t('Item {n}', { n: ps.data.length + 1 }), value: 0 })
  }))
  addRow.appendChild(addBtn)
  ctx.host.appendChild(addRow)
}

function editPieDatum(ctx: PanelContext, id: string, i: number, fn: ((d: any) => void) | null, final: boolean) {
  ctx.editOption(id, (o) => {
    const ps = (Array.isArray(o.series) ? o.series : [o.series]).find((x: any) => x?.type === 'pie') ?? o.series[0]
    if (!ps?.data) return
    if (fn === null) ps.data.splice(i, 1)
    else fn(ps.data[i])
  }, final)
}

export function buildTableProps(ctx: PanelContext, el: TableElement) {
  const stepper = (label: string, count: number, onDelta: (d: number) => void) => {
    const wrap = document.createElement('div')
    wrap.className = 'ed-stepper'
    const minus = ctx.opBtn('−', t('Remove'), () => onDelta(-1))
    const val = document.createElement('span')
    val.className = 'ed-stepper-val'
    val.textContent = String(count)
    const plus = ctx.opBtn('+', t('Add'), () => onDelta(1))
    wrap.append(minus, val, plus)
    ctx.row(label, wrap)
  }
  const cols = el.columns.length
  const rows = el.rows.length
  // at the end of the table; tablespans.ts keeps merged cells in step
  // (one that reaches the removed row/column shrinks)
  stepper(t('Columns'), cols, (d) => ctx.mutate(el.id, (e) => {
    const tb = e as TableElement
    if (d > 0) insertColumn(tb, tb.columns.length)
    else deleteColumns(tb, tb.columns.length - 1, tb.columns.length - 1)
  }, true))
  stepper(t('Rows'), rows, (d) => ctx.mutate(el.id, (e) => {
    const tb = e as TableElement
    const minRows = tb.header ? 2 : 1
    if (d > 0) insertRow(tb, tb.rows.length)
    else if (tb.rows.length > minRows) deleteRows(tb, tb.rows.length - 1, tb.rows.length - 1)
  }, true))

  ctx.row('Header row', ctx.toggle(el.header, (v) => ctx.mutate(el.id, (e) => {
    (e as TableElement).header = v
  }, true)))

  // one-tap looks that all work within the fixed-grid renderer
  const st = el.style
  const preset = st.borderWidth && st.zebra ? 'Boxed'
    : st.borderWidth ? 'Lined'
    : st.zebra ? 'Zebra'
    : 'Minimal'
  const themed = tableStyleFor(ctx.store.doc.theme)
  ctx.row('Preset', ctx.select(['Lined', 'Zebra', 'Boxed', 'Minimal'], preset, (v) =>
    ctx.mutate(el.id, (e) => {
      const s = (e as TableElement).style
      s.borderWidth = v === 'Lined' || v === 'Boxed' ? Math.max(themed.borderWidth, 1) : 0
      s.zebra = v === 'Zebra' || v === 'Boxed' ? themed.zebra ?? 'rgba(29,17,25,0.05)' : undefined
      if (v === 'Minimal') { s.headerBg = 'transparent'; s.headerColor = s.color }
      else if (s.headerBg === 'transparent') {
        s.headerBg = themed.headerBg
        s.headerColor = themed.headerColor
      }
    }, true)))

  buildTableCells(ctx, el)

  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = t('Double-click a cell to edit. Tab moves across, Enter down.')
  ctx.host.appendChild(hint)

  const toChart = document.createElement('button')
  toChart.className = 'ed-btn ed-btn-block'
  toChart.textContent = t('Make a chart from this table →')
  toChart.title = t('Create a bar chart from the numbers in this table (first column = labels)')
  toChart.addEventListener('click', () => tableToChart(ctx, el))
  ctx.host.appendChild(toChart)

  // --- more: the fine-grained look ------------------------------------------
  ctx.section('Style')
  ctx.row('Header fill', ctx.colorAlpha(st.headerBg, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as TableElement).style.headerBg = v }, fin)))
  ctx.row('Header text', ctx.colorAlpha(st.headerColor, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as TableElement).style.headerColor = v }, fin)))
  ctx.row('Text', ctx.colorAlpha(st.color, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as TableElement).style.color = v }, fin)))
  ctx.row('Grid lines', ctx.colorAlpha(st.borderColor, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as TableElement).style.borderColor = v }, fin)))

  const grid = document.createElement('div')
  grid.className = 'ed-grid2'
  grid.append(
    ctx.mini(t('Font'), st.fontSize, (v) => ctx.mutate(el.id, (e) =>
      { (e as TableElement).style.fontSize = Math.max(v, 6) }, true)),
    ctx.mini(t('Radius'), st.radius, (v) => ctx.mutate(el.id, (e) =>
      { (e as TableElement).style.radius = Math.max(v, 0) }, true)),
    ctx.mini(t('Pad X'), st.cellPadX, (v) => ctx.mutate(el.id, (e) =>
      { (e as TableElement).style.cellPadX = Math.max(v, 0) }, true)),
    ctx.mini(t('Pad Y'), st.cellPadY, (v) => ctx.mutate(el.id, (e) =>
      { (e as TableElement).style.cellPadY = Math.max(v, 0) }, true)),
  )
  ctx.host.appendChild(grid)
}

/** The Cells block: merge/split and rows/columns at the selected cells. */
function buildTableCells(ctx: PanelContext, el: TableElement) {
  const cells = ctx.panel.tableCells
  const live = cells?.state()?.id === el.id
  const cap = document.createElement('div')
  cap.className = 'ed-arrange-cap'
  cap.textContent = t('Cells')
  ctx.host.appendChild(cap)
  const grid = document.createElement('div')
  grid.className = 'ed-grid2 ed-table-cells'
  for (const [op, label] of TABLE_OPS) {
    const b = document.createElement('button')
    b.className = 'ed-btn'
    b.textContent = t(label)
    b.dataset.tableOp = op
    b.disabled = !live || !cells!.can(op)
    // mousedown would blur a cell being edited before the click lands;
    // run() commits that edit itself, so keep focus where it is
    b.addEventListener('mousedown', (ev) => ev.preventDefault())
    b.addEventListener('click', () => { cells?.run(op) })
    grid.appendChild(b)
  }
  ctx.host.appendChild(grid)
  if (!live) {
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('Click a cell of the table to work on it. Shift+click, Shift+arrows or a drag across cells select several.')
    ctx.host.appendChild(hint)
  }
}

/** Bridge: build a bar chart from a table's numeric columns and insert it. */
function tableToChart(ctx: PanelContext, el: TableElement) {
  const bodyRows = el.header ? el.rows.slice(1) : el.rows
  // strip markup + entities + thousands separators so "1,204" / "+222%" parse
  const strip = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').replace(/,/g, '').trim()
  const num = (html: string) => parseFloat(strip(html))
  const labels = bodyRows.map((r) => strip(r.cells[0]?.html ?? ''))
  const headerRow = el.header ? el.rows[0] : null
  // every column after the labels that is mostly numeric becomes its own series
  const cols: Array<{ name: string; data: number[]; isPct: boolean; maxAbs: number }> = []
  for (let c = 1; c < el.columns.length; c++) {
    const raw = bodyRows.map((r) => r.cells[c]?.html ?? '')
    const parsed = raw.map(num)
    const good = parsed.filter((n) => !Number.isNaN(n))
    if (good.length < Math.ceil(bodyRows.length / 2)) continue
    const isPct = /%/.test(headerRow ? strip(headerRow.cells[c]?.html ?? '') : '') ||
      raw.filter((h) => /%/.test(h)).length >= Math.ceil(bodyRows.length / 2)
    cols.push({
      name: headerRow ? strip(headerRow.cells[c]?.html ?? '') : '',
      data: parsed.map((n) => (Number.isNaN(n) ? 0 : n)),
      isPct,
      maxAbs: Math.max(1, ...good.map((n) => Math.abs(n))),
    })
  }
  if (!cols.length) { toast(t('No numeric column found to chart')); return }

  // two columns on very different scales (or one is a %) → dual axis: bars
  // on the left, the odd one as a line on a right-hand axis
  let secondary = -1
  if (cols.length === 2) {
    const pct = cols.filter((c) => c.isPct)
    if (pct.length === 1) secondary = cols.indexOf(pct[0])
    else {
      const big = cols[0].maxAbs >= cols[1].maxAbs ? 0 : 1
      if (cols[big].maxAbs / cols[1 - big].maxAbs >= 12) secondary = 1 - big
    }
  }

  const option: Record<string, unknown> = {
    xAxis: { type: 'category', data: labels },
    tooltip: { trigger: 'axis' },
  }
  if (secondary >= 0) {
    const prim = cols[1 - secondary], sec = cols[secondary]
    option.yAxis = [
      { type: 'value', name: prim.name || undefined },
      { type: 'value', name: sec.name || undefined, axisLabel: sec.isPct ? { formatter: '{value}%' } : undefined },
    ]
    option.series = [
      { type: 'bar', name: prim.name, data: prim.data, yAxisIndex: 0 },
      { type: 'line', name: sec.name, data: sec.data, yAxisIndex: 1, smooth: true },
    ]
    option.legend = { bottom: 0 }
  } else {
    option.yAxis = { type: 'value' }
    option.series = cols.map((c) => ({ type: 'bar', name: c.name, data: c.data }))
    if (cols.length > 1) option.legend = { bottom: 0 }
  }
  applyChartPalette(option, ctx.store.doc.theme)
  const chart = defaultChart(option, {
    x: el.x, y: Math.min(el.y + el.h + 24, 480), w: Math.max(el.w, 640), h: 300, preset: 'bar',
    // live binding: edits to the table flow into this chart
    source: { tableId: el.id },
  })
  ctx.store.commit(() => ctx.store.slide.elements.push(chart))
  ctx.store.select([chart.id])
  toast(t('Chart created — it updates live with the table'))
}
