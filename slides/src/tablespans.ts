// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Merged table cells — the ONE reading of `TableCell.colspan`/`rowspan`
// (model.ts, DECISIONS 2026-10-08) and every structural edit that has to
// respect it. Pure and DOM-free: render.ts, untrusted.ts, validate.ts and the
// editor (editor/tablerange.ts) all go through here, so a span means the
// same thing on the canvas, in a thumbnail, in the no-JS preview and to the
// sanitizer, and the rig (scripts/test-table-merge.ts) runs it in node.
//
// The model: a table keeps one cell per grid position in every row. The
// top-left cell of a merged block (its ANCHOR) carries the spans; the cells
// it covers stay in the grid, ignored. Which cells are covered is derived
// here, never stored. `tableLayout` reads spans in reading order: a span is
// clamped to the grid, then shrunk until it covers no position an earlier
// anchor already took (and no position a short row lacks) — so whatever a
// file says, the layout is a partition of the grid into rectangles, and
// `normalizeTableSpans` writes exactly that layout back.

import type { TableCell, TableElement } from './model'

/** An inclusive cell rectangle, `r0 <= r1`, `c0 <= c1`. */
export interface CellRect { r0: number; c0: number; r1: number; c1: number }

export interface TableLayout {
  nRows: number
  /** the grid width: `columns.length` */
  nCols: number
  /** the anchor `[r, c]` that owns each position; null where row r has no cell c */
  owner: Array<Array<readonly [number, number] | null>>
  /** each anchor's spans (1×1 for an ordinary cell); undefined where covered */
  span: Array<Array<{ rs: number; cs: number } | undefined>>
}

/** A stored span as a count: a positive integer, anything else 1. */
function spanCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1
}

/** How the grid of `el` is actually laid out — see the file header. */
export function tableLayout(el: Pick<TableElement, 'rows' | 'columns'>): TableLayout {
  const rows = Array.isArray(el.rows) ? el.rows : []
  const nCols = Array.isArray(el.columns) ? el.columns.length : 0
  const nRows = rows.length
  const width = (r: number) => (Array.isArray(rows[r]?.cells) ? rows[r].cells.length : 0)
  const owner: TableLayout['owner'] = rows.map((_, r) => new Array(width(r)).fill(null))
  const span: TableLayout['span'] = rows.map((_, r) => new Array(width(r)).fill(undefined))
  for (let r = 0; r < nRows; r++) {
    const cells = rows[r].cells ?? []
    for (let c = 0; c < cells.length; c++) {
      if (owner[r][c]) continue // covered by an earlier anchor
      const cell = cells[c] as TableCell | undefined
      let cs = c < nCols ? Math.min(spanCount(cell?.colspan), nCols - c) : 1
      let rs = Math.min(spanCount(cell?.rowspan), nRows - r)
      // shrink across: stop at a position already taken
      let k = 1
      while (k < cs && c + k < cells.length && !owner[r][c + k]) k++
      cs = k
      // shrink down: stop at a row that cannot take the whole width
      let h = 1
      while (h < rs) {
        const rr = r + h
        let free = width(rr) >= c + cs
        for (let j = c; free && j < c + cs; j++) if (owner[rr][j]) free = false
        if (!free) break
        h++
      }
      rs = h
      const id = [r, c] as const
      for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) owner[i][j] = id
      span[r][c] = { rs, cs }
    }
  }
  return { nRows, nCols, owner, span }
}

/** Write `rs`×`cs` onto a cell in the stored form (1 = key absent). */
function setSpan(cell: TableCell, rs: number, cs: number): boolean {
  let changed = false
  if (cs > 1) { if (cell.colspan !== cs) { cell.colspan = cs; changed = true } }
  else if ('colspan' in cell) { delete cell.colspan; changed = true }
  if (rs > 1) { if (cell.rowspan !== rs) { cell.rowspan = rs; changed = true } }
  else if ('rowspan' in cell) { delete cell.rowspan; changed = true }
  return changed
}

/** Rewrite every cell's spans as `tableLayout` reads them (in place): spans
 *  clamped to the grid, overlaps resolved, covered cells span-free, `1`
 *  omitted. True when anything changed. */
export function normalizeTableSpans(el: Pick<TableElement, 'rows' | 'columns'>): boolean {
  const L = tableLayout(el)
  let changed = false
  el.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
    if (!cell || typeof cell !== 'object') return
    const sp = L.span[r][c]
    if (setSpan(cell, sp?.rs ?? 1, sp?.cs ?? 1)) changed = true
  }))
  return changed
}

/** True when some cell of `el` really spans (after the layout's clamping). */
export function hasMergedCells(el: Pick<TableElement, 'rows' | 'columns'>): boolean {
  return tableLayout(el).span.some((row) => row.some((sp) => !!sp && (sp.rs > 1 || sp.cs > 1)))
}

/** The anchor that owns position (r, c), or null off the grid. */
export function anchorOf(el: Pick<TableElement, 'rows' | 'columns'>, r: number, c: number, L = tableLayout(el)): [number, number] | null {
  const o = L.owner[r]?.[c]
  return o ? [o[0], o[1]] : null
}

/** The rectangle the anchor at (r, c) covers. */
export function anchorRect(L: TableLayout, r: number, c: number): CellRect {
  const sp = L.span[r]?.[c] ?? { rs: 1, cs: 1 }
  return { r0: r, c0: c, r1: r + sp.rs - 1, c1: c + sp.cs - 1 }
}

/** `a`..`b` as a rectangle, corners in any order. */
export function rectOf(r0: number, c0: number, r1: number, c1: number): CellRect {
  return { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) }
}

/** Grow `rect` until no merged cell sticks out of it (a selection never
 *  holds part of a merged cell). Clamped to the grid. */
export function closeRect(el: Pick<TableElement, 'rows' | 'columns'>, rect: CellRect, L = tableLayout(el)): CellRect {
  let { r0, c0, r1, c1 } = rect
  r0 = Math.max(0, r0); c0 = Math.max(0, c0)
  r1 = Math.min(L.nRows - 1, r1); c1 = Math.min(L.nCols - 1, c1)
  for (let grew = true; grew;) {
    grew = false
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const o = L.owner[r]?.[c]
        if (!o) continue
        const a = anchorRect(L, o[0], o[1])
        if (a.r0 < r0 || a.c0 < c0 || a.r1 > r1 || a.c1 > c1) {
          r0 = Math.min(r0, a.r0); c0 = Math.min(c0, a.c0)
          r1 = Math.max(r1, a.r1); c1 = Math.max(c1, a.c1)
          grew = true
        }
      }
    }
  }
  return { r0, c0, r1, c1 }
}

/** The anchors inside `rect`, in reading order. */
function anchorsIn(L: TableLayout, rect: CellRect): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) if (L.span[r]?.[c]) out.push([r, c])
  }
  return out
}

/** True when merging `rect` would change the table (it covers more than one
 *  cell after closing, and is not already exactly one merged cell). */
export function canMerge(el: Pick<TableElement, 'rows' | 'columns'>, rect: CellRect): boolean {
  const L = tableLayout(el)
  return anchorsIn(L, closeRect(el, rect, L)).length > 1
}

/** True when some merged cell meets `rect`. */
export function canSplit(el: Pick<TableElement, 'rows' | 'columns'>, rect: CellRect): boolean {
  const L = tableLayout(el)
  const closed = closeRect(el, rect, L)
  return anchorsIn(L, closed).some(([r, c]) => { const sp = L.span[r][c]!; return sp.rs > 1 || sp.cs > 1 })
}

/** A cell's html with nothing in it (what an emptied cell commits as). */
const blankHtml = (html: unknown) => typeof html !== 'string' || !html.replace(/<br\s*\/?>|&nbsp;|\s/gi, '')

/**
 * Merge `rect` (closed first) into its top-left cell. The text of every cell
 * in it is kept — joined in reading order, one line each — and the covered
 * cells are emptied (`{ html: '' }`), so splitting again gives blank cells,
 * as in PowerPoint and Word. Returns the merged rectangle, or null when
 * there was nothing to merge.
 */
export function mergeCells(el: TableElement, rect: CellRect): CellRect | null {
  const L = tableLayout(el)
  const R = closeRect(el, rect, L)
  const anchors = anchorsIn(L, R)
  if (anchors.length < 2) return null
  const parts = anchors.map(([r, c]) => el.rows[r].cells[c].html).filter((h) => !blankHtml(h))
  const top = el.rows[R.r0].cells[R.c0]
  top.html = parts.join('<br>')
  for (let r = R.r0; r <= R.r1; r++) {
    for (let c = R.c0; c <= R.c1; c++) if (r !== R.r0 || c !== R.c0) el.rows[r].cells[c] = { html: '' }
  }
  setSpan(top, R.r1 - R.r0 + 1, R.c1 - R.c0 + 1)
  normalizeTableSpans(el)
  return R
}

/** Split every merged cell that meets `rect` back into single cells (the
 *  text stays in the top-left one). True when anything was split. */
export function splitCells(el: TableElement, rect: CellRect): boolean {
  const L = tableLayout(el)
  let changed = false
  for (const [r, c] of anchorsIn(L, closeRect(el, rect, L))) {
    if (setSpan(el.rows[r].cells[c], 1, 1)) changed = true
  }
  return changed
}

/** Every anchor of the layout, with its spans. */
function eachAnchor(L: TableLayout, fn: (r: number, c: number, rs: number, cs: number) => void) {
  L.span.forEach((row, r) => row.forEach((sp, c) => { if (sp) fn(r, c, sp.rs, sp.cs) }))
}

/** The largest table the sanitizer keeps (untrusted.ts LIMITS.rows / .cols):
 *  editor edits that grow a table stop here. */
export const TABLE_MAX = { rows: 2_000, cols: 200 } as const

/** A fresh row of `n` empty cells. */
const blankRow = (n: number) => ({ cells: Array.from({ length: n }, () => ({ html: '' }) as TableCell) })

/** Insert an empty row before row `at` (`at = rows.length` appends). A merged
 *  cell the new row passes through grows by one row. */
export function insertRow(el: TableElement, at: number): void {
  const L = tableLayout(el)
  at = Math.max(0, Math.min(at, L.nRows))
  normalizeTableSpans(el)
  eachAnchor(L, (r, c, rs) => { if (r < at && at <= r + rs - 1) el.rows[r].cells[c].rowspan = rs + 1 })
  el.rows.splice(at, 0, blankRow(Math.max(L.nCols, ...el.rows.map((row) => row.cells.length))))
  normalizeTableSpans(el)
}

/** Insert an empty column before column `at` (as wide as its neighbour). A
 *  merged cell the new column passes through grows by one column. */
export function insertColumn(el: TableElement, at: number): void {
  const L = tableLayout(el)
  at = Math.max(0, Math.min(at, L.nCols))
  normalizeTableSpans(el)
  eachAnchor(L, (r, c, _rs, cs) => { if (c < at && at <= c + cs - 1) el.rows[r].cells[c].colspan = cs + 1 })
  const w = el.columns[Math.min(at, el.columns.length - 1)]?.w ?? 1
  el.columns.splice(at, 0, { w })
  for (const row of el.rows) row.cells.splice(Math.min(at, row.cells.length), 0, { html: '' })
  normalizeTableSpans(el)
}

/** Delete rows `r0..r1`. A merged cell that loses rows shrinks; one whose
 *  top row goes moves its content to the first row that stays. Refuses
 *  (false) to delete every row. */
export function deleteRows(el: TableElement, r0: number, r1: number): boolean {
  if (r0 > r1) [r0, r1] = [r1, r0]
  r0 = Math.max(0, r0); r1 = Math.min(el.rows.length - 1, r1)
  if (r0 > r1 || r1 - r0 + 1 >= el.rows.length) return false
  const L = tableLayout(el)
  normalizeTableSpans(el)
  const n = r1 - r0 + 1
  eachAnchor(L, (r, c, rs) => {
    const end = r + rs - 1
    if (end < r0 || r > r1 || rs === 1) return
    const lost = Math.min(end, r1) - Math.max(r, r0) + 1
    if (r < r0) { el.rows[r].cells[c].rowspan = rs - lost; return }
    // the anchor's own row goes: hand the block to the first row below the cut
    if (end > r1) el.rows[r1 + 1].cells[c] = { ...el.rows[r].cells[c], rowspan: rs - lost }
  })
  el.rows.splice(r0, n)
  normalizeTableSpans(el)
  return true
}

/** Delete columns `c0..c1` — `deleteRows` across. Refuses to delete them all. */
export function deleteColumns(el: TableElement, c0: number, c1: number): boolean {
  if (c0 > c1) [c0, c1] = [c1, c0]
  c0 = Math.max(0, c0); c1 = Math.min(el.columns.length - 1, c1)
  if (c0 > c1 || c1 - c0 + 1 >= el.columns.length) return false
  const L = tableLayout(el)
  normalizeTableSpans(el)
  const n = c1 - c0 + 1
  eachAnchor(L, (r, c, _rs, cs) => {
    const end = c + cs - 1
    if (end < c0 || c > c1 || cs === 1) return
    const lost = Math.min(end, c1) - Math.max(c, c0) + 1
    if (c < c0) { el.rows[r].cells[c].colspan = cs - lost; return }
    if (end > c1) el.rows[r].cells[c1 + 1] = { ...el.rows[r].cells[c], colspan: cs - lost }
  })
  el.columns.splice(c0, n)
  for (const row of el.rows) row.cells.splice(c0, n)
  normalizeTableSpans(el)
  return true
}

/** The cell after (step 1) or before (step -1) the anchor at (r, c) in
 *  reading order — covered positions skipped. Null past either end. */
export function nextCell(el: Pick<TableElement, 'rows' | 'columns'>, r: number, c: number, step: 1 | -1): [number, number] | null {
  const L = tableLayout(el)
  const order: Array<[number, number]> = []
  L.span.forEach((row, rr) => row.forEach((sp, cc) => { if (sp) order.push([rr, cc]) }))
  const a = anchorOf(el, r, c, L) ?? [r, c]
  const i = order.findIndex(([rr, cc]) => rr === a[0] && cc === a[1])
  return i < 0 ? null : order[i + step] ?? null
}

/** The cell beside the anchor at (r, c) in direction `dir` — past its whole
 *  block — or null at the table's edge. */
export function cellToward(el: Pick<TableElement, 'rows' | 'columns'>, r: number, c: number, dir: 'up' | 'down' | 'left' | 'right'): [number, number] | null {
  const L = tableLayout(el)
  const a = anchorOf(el, r, c, L)
  if (!a) return null
  const R = anchorRect(L, a[0], a[1])
  const [rr, cc] = dir === 'up' ? [R.r0 - 1, c] : dir === 'down' ? [R.r1 + 1, c] : dir === 'left' ? [r, R.c0 - 1] : [r, R.c1 + 1]
  return anchorOf(el, rr, cc, L)
}

/** Empty the text of every cell in `rect` (closed). True when any changed. */
export function clearCells(el: TableElement, rect: CellRect): boolean {
  const L = tableLayout(el)
  let changed = false
  for (const [r, c] of anchorsIn(L, closeRect(el, rect, L))) {
    if (el.rows[r].cells[c].html) { el.rows[r].cells[c].html = ''; changed = true }
  }
  return changed
}

/** A copy of the cells in `rect` (closed first, so a merged cell is never
 *  cut in half) — a small grid in the table's own shape, spans included. */
export function copyCells(el: TableElement, rect: CellRect): { rect: CellRect; rows: Array<{ cells: TableCell[] }> } {
  const R = closeRect(el, rect)
  const rows: Array<{ cells: TableCell[] }> = []
  for (let r = R.r0; r <= R.r1; r++) {
    const cells: TableCell[] = []
    for (let c = R.c0; c <= R.c1; c++) cells.push(JSON.parse(JSON.stringify(el.rows[r].cells[c] ?? { html: '' })) as TableCell)
    rows.push({ cells })
  }
  return { rect: R, rows }
}

/**
 * Paste a block of cells (`copyCells`'s shape, already sanitized) with its
 * top-left at (r, c): the table grows to fit, every merged cell the block
 * lands on is split first (its text stays in its own top-left cell), then
 * the block's cells — spans included — replace what is there. Returns the
 * rectangle written.
 */
export function pasteCells(el: TableElement, r: number, c: number, block: Array<{ cells: TableCell[] }>): CellRect | null {
  // the table never grows past what the sanitizer keeps (TABLE_MAX): the
  // part of the block beyond that is dropped, as a re-open would drop it
  const h = Math.min(block.length, TABLE_MAX.rows - r)
  const w = Math.min(block.reduce((m, row) => Math.max(m, row.cells.length), 0), TABLE_MAX.cols - c)
  if (h <= 0 || w <= 0) return null
  // grow in one go: rows/columns appended at the end never pass through a
  // merged cell, so there is nothing to stretch (one normalise, not one per row)
  normalizeTableSpans(el)
  const cols = Math.max(el.columns.length, c + w)
  const lastW = el.columns[el.columns.length - 1]?.w ?? 1
  while (el.columns.length < cols) el.columns.push({ w: lastW })
  for (const row of el.rows) while (row.cells.length < cols) row.cells.push({ html: '' })
  while (el.rows.length < r + h) el.rows.push(blankRow(cols))
  const target: CellRect = { r0: r, c0: c, r1: r + h - 1, c1: c + w - 1 }
  // split whatever the block lands on, however far it reaches outside
  const L = tableLayout(el)
  for (let i = target.r0; i <= target.r1; i++) {
    for (let j = target.c0; j <= target.c1; j++) {
      const o = L.owner[i]?.[j]
      if (o) setSpan(el.rows[o[0]].cells[o[1]], 1, 1)
    }
  }
  block.slice(0, h).forEach((row, i) => {
    for (let j = 0; j < w; j++) {
      const cell = row.cells[j]
      el.rows[r + i].cells[c + j] = cell ? (JSON.parse(JSON.stringify(cell)) as TableCell) : { html: '' }
    }
  })
  // a block's own spans never reach past the block
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      const cell = el.rows[r + i].cells[c + j]
      const rs = Math.min(spanCount(cell.rowspan), h - i)
      const cs = Math.min(spanCount(cell.colspan), w - j)
      setSpan(cell, rs, cs)
    }
  }
  normalizeTableSpans(el)
  return target
}

/** Cell html → plain text (no DOM): line breaks and blocks become spaces,
 *  tags go, the few entities the sanitizer writes are decoded. */
export function cellText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>|<\/(?:div|p|li)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A copied block as tab-separated text (what a spreadsheet or a text
 *  editor gets): one line per row, covered positions empty. */
export function cellsToTsv(rows: Array<{ cells: TableCell[] }>): string {
  const L = tableLayout({ rows, columns: new Array(Math.max(0, ...rows.map((r) => r.cells.length))).fill({ w: 1 }) })
  return rows.map((row, r) => row.cells.map((cell, c) => (L.span[r]?.[c] ? cellText(cell.html) : '')).join('\t')).join('\n')
}

/** Tab-separated text → a block of plain cells (a paste from a spreadsheet). */
export function tsvToCells(text: string): Array<{ cells: TableCell[] }> {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return lines.map((line) => ({ cells: line.split('\t').map((v) => ({ html: esc(v.trim()) })) }))
}
