// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The selected CELLS of a table on the canvas — the active cell and, with
// Shift+click / Shift+arrows / a drag across cells, a range — and the table
// commands that act on them: merge, split, insert/delete rows and columns,
// clear, copy/cut/paste. One instance per SlideCanvas (`canvas.tableRange`);
// the panel, the context menu and the menu-bar commands all call `run`.
//
// The range is editor state, never in the document. It belongs to ONE table
// that is the whole element selection; anything else (another selection, the
// table gone, an undo that shrank it) clears or clamps it in `paint`, which
// the canvas calls after every render/syncTargets. Highlights are a class on
// the canvas's own <td>s (`.beeslides-cell-sel`), so no output path can see
// them. Every command is ONE store.commit (one undo step), and is checked
// before committing so a no-op never leaves an empty undo step. The table
// logic itself is pure, in ../tablespans.ts.

import type { Store } from '../store'
import type { TableCell, TableElement } from '../model'
import {
  anchorOf, canMerge, canSplit, cellToward, cellsToTsv, clearCells, closeRect, copyCells, deleteColumns, deleteRows,
  insertColumn, insertRow, mergeCells, nextCell, pasteCells, rectOf, splitCells, TABLE_MAX, tsvToCells, type CellRect,
} from '../tablespans'
import { sanitizeCellBlock } from '../untrusted'
import { sanitizeHtml } from '../render'

/** The clipboard type a copied cell range travels as (plus TSV + an html table). */
export const CELLS_MIME = 'application/x-slidomingo-cells'

export type TableOp =
  | 'merge' | 'split'
  | 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight'
  | 'deleteRows' | 'deleteCols' | 'clear'

/** The cell commands in menu order with their English labels (i18n keys —
 *  translated where they are shown, never here). The menu bar's ids are
 *  `table.<op>` (menumodel.ts). */
export const TABLE_OPS: ReadonlyArray<readonly [TableOp, string]> = [
  ['merge', 'Merge cells'], ['split', 'Split cell'],
  ['rowAbove', 'Insert row above'], ['rowBelow', 'Insert row below'],
  ['colLeft', 'Insert column left'], ['colRight', 'Insert column right'],
  ['deleteRows', 'Delete row'], ['deleteCols', 'Delete column'],
]

export interface TableRangeHost {
  store: Store
  /** the canvas's current slide surface (`.ed-stage-scale` content) */
  surface(): HTMLElement | null
  /** start editing a cell (commits any running edit first) */
  editCell(id: string, r: number, c: number): void
  /** true while a table cell is being edited */
  editingCell(): boolean
  commitTextEdit(): void
}

interface Sel { id: string; anchor: [number, number]; focus: [number, number] }

export interface TableRangeState {
  id: string
  rect: CellRect
  canMerge: boolean
  canSplit: boolean
  rows: number
  cols: number
}

export class TableRange {
  private sel: Sel | null = null
  private listeners = new Set<() => void>()
  private lastKey = ''

  constructor(private host: TableRangeHost) {}

  /** Called after any change of the selected cells (panel / menu refresh). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    const s = this.state()
    const key = s ? JSON.stringify(s) : ''
    if (key === this.lastKey) return
    this.lastKey = key
    for (const fn of this.listeners) fn()
  }

  /** The table the cells belong to, while it is still the lone selection. */
  table(): TableElement | null {
    const sel = this.sel
    if (!sel) return null
    const { store } = this.host
    if (store.selection.length !== 1 || store.selection[0] !== sel.id) return null
    const el = store.element(sel.id)
    return el?.type === 'table' ? el : null
  }

  /** The selected cells as a closed rectangle (never part of a merged cell). */
  rect(): CellRect | null {
    const el = this.table()
    const sel = this.sel
    if (!el || !sel) return null
    return closeRect(el, rectOf(sel.anchor[0], sel.anchor[1], sel.focus[0], sel.focus[1]))
  }

  state(): TableRangeState | null {
    const el = this.table()
    const rect = this.rect()
    if (!el || !rect) return null
    return {
      id: el.id, rect,
      canMerge: canMerge(el, rect), canSplit: canSplit(el, rect),
      rows: el.rows.length, cols: el.columns.length,
    }
  }

  /** Make (r, c) the active cell — or, with `extend`, the far corner of the
   *  range that starts at the active cell. */
  setCell(id: string, r: number, c: number, extend = false) {
    const el = this.host.store.element(id)
    if (el?.type !== 'table') return
    const a = anchorOf(el, r, c) ?? [r, c]
    if (extend && this.sel?.id === id) this.sel = { ...this.sel, focus: a }
    else this.sel = { id, anchor: a, focus: a }
    this.paint()
  }

  clear() {
    if (!this.sel) return
    this.sel = null
    this.paint()
  }

  get active(): boolean { return !!this.table() }

  /** Keep the highlight in step with the canvas DOM and the model. */
  paint() {
    const surface = this.host.surface()
    surface?.querySelectorAll('.beeslides-cell-sel').forEach((td) => td.classList.remove('beeslides-cell-sel'))
    const el = this.table()
    if (!el) {
      this.sel = null
      this.emit()
      return
    }
    // an undo can shrink the table under the selection
    const clamp = ([r, c]: [number, number]): [number, number] =>
      anchorOf(el, Math.min(r, el.rows.length - 1), Math.min(c, el.columns.length - 1)) ?? [0, 0]
    this.sel = { id: el.id, anchor: clamp(this.sel!.anchor), focus: clamp(this.sel!.focus) }
    this.emit()
    if (this.host.editingCell() || !surface) return
    const rect = this.rect()!
    const node = surface.querySelector(`[data-el-id="${CSS.escape(el.id)}"]`)
    node?.querySelectorAll<HTMLElement>('td[data-r][data-c]').forEach((td) => {
      const r = Number(td.dataset.r)
      const c = Number(td.dataset.c)
      if (r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1) td.classList.add('beeslides-cell-sel')
    })
  }

  // --- commands ------------------------------------------------------------------

  /** Whether `op` would change the table right now. */
  can(op: TableOp): boolean {
    const el = this.table()
    const rect = this.rect()
    if (!el || !rect) return false
    switch (op) {
      case 'merge': return canMerge(el, rect)
      case 'split': return canSplit(el, rect)
      case 'deleteRows': return rect.r1 - rect.r0 + 1 < el.rows.length
      case 'deleteCols': return rect.c1 - rect.c0 + 1 < el.columns.length
      case 'rowAbove': case 'rowBelow': return el.rows.length < TABLE_MAX.rows
      case 'colLeft': case 'colRight': return el.columns.length < TABLE_MAX.cols
      case 'clear': {
        for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) if (el.rows[r]?.cells[c]?.html) return true
        return false
      }
      default: return true
    }
  }

  /** Run a table command on the selected cells: one commit, one undo step. */
  run(op: TableOp): boolean {
    if (this.host.editingCell()) this.host.commitTextEdit()
    const el = this.table()
    const rect = this.rect()
    if (!el || !rect || !this.can(op)) return false
    const id = el.id
    let next: Sel | null = this.sel
    const shift = (dr: number, dc: number): Sel => ({
      id, anchor: [this.sel!.anchor[0] + dr, this.sel!.anchor[1] + dc], focus: [this.sel!.focus[0] + dr, this.sel!.focus[1] + dc],
    })
    const one = (r: number, c: number): Sel => ({ id, anchor: [r, c], focus: [r, c] })
    this.host.store.commit(() => {
      const tb = this.host.store.element(id) as TableElement
      switch (op) {
        case 'merge': mergeCells(tb, rect); next = one(rect.r0, rect.c0); break
        case 'split': splitCells(tb, rect); next = { id, anchor: [rect.r0, rect.c0], focus: [rect.r1, rect.c1] }; break
        case 'rowAbove': insertRow(tb, rect.r0); next = shift(1, 0); break
        case 'rowBelow': insertRow(tb, rect.r1 + 1); break
        case 'colLeft': insertColumn(tb, rect.c0); next = shift(0, 1); break
        case 'colRight': insertColumn(tb, rect.c1 + 1); break
        case 'deleteRows': deleteRows(tb, rect.r0, rect.r1); next = one(Math.min(rect.r0, tb.rows.length - 1), rect.c0); break
        case 'deleteCols': deleteColumns(tb, rect.c0, rect.c1); next = one(rect.r0, Math.min(rect.c0, tb.columns.length - 1)); break
        case 'clear': clearCells(tb, rect); break
      }
    })
    this.sel = next
    this.paint()
    return true
  }

  // --- keyboard (the canvas has focus, no cell is being edited) ------------------

  /** Keys for the selected cells. True = handled (the caller prevents default). */
  handleKey(ev: KeyboardEvent): boolean {
    const el = this.table()
    const sel = this.sel
    if (!el || !sel || this.host.editingCell()) return false
    const mod = ev.metaKey || ev.ctrlKey
    if (mod || ev.altKey) return false
    const k = ev.key
    if (k === 'Escape') { this.clear(); return true }
    if (k === 'Delete' || k === 'Backspace') { this.run('clear'); return true }
    if (k === 'Enter' || k === 'F2') {
      this.host.editCell(el.id, sel.focus[0], sel.focus[1])
      return true
    }
    if (k === 'Tab') {
      const to = nextCell(el, sel.focus[0], sel.focus[1], ev.shiftKey ? -1 : 1)
      if (to) this.setCell(el.id, to[0], to[1])
      return true
    }
    const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[k as 'ArrowUp']
    if (dir) {
      const to = cellToward(el, sel.focus[0], sel.focus[1], dir)
      if (to) this.setCell(el.id, to[0], to[1], ev.shiftKey)
      return true
    }
    return false
  }

  // --- pointer -----------------------------------------------------------------------

  /** A press inside the cell being edited may become a drag across cells:
   *  once the pointer reaches another cell of the same table, the edit ends
   *  and the cells between become the range. */
  armDrag(id: string, r: number, c: number) {
    const onMove = (ev: PointerEvent) => {
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)
      const td = hit?.closest<HTMLElement>('td[data-r][data-c]')
      const owner = td?.closest<HTMLElement>('.beeslides-el-table')
      if (!td || owner?.dataset.elId !== id || !owner.closest('.ed-stage-scale')) return
      const tr = Number(td.dataset.r)
      const tc = Number(td.dataset.c)
      if (this.host.editingCell()) {
        if (tr === r && tc === c) return // still selecting text in the cell
        this.sel = { id, anchor: [r, c], focus: [r, c] }
        window.getSelection()?.removeAllRanges()
        this.host.commitTextEdit()
      }
      if (this.sel?.id !== id || (this.sel.focus[0] === tr && this.sel.focus[1] === tc)) return
      this.setCell(id, tr, tc, true)
      ev.preventDefault()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
  }

  // --- clipboard -----------------------------------------------------------------------

  /** The last block this editor copied, with the tab-separated text it went
   *  out as — so a copy made where only text reaches the clipboard (the
   *  context menu writes through navigator.clipboard) still pastes back with
   *  its merged cells when that same text comes back. */
  private lastCopy: { tsv: string; rows: Array<{ cells: TableCell[] }> } | null = null

  /** The selected cells as clipboard data: our own block (spans kept),
   *  tab-separated text and an html table. Null when no cells are selected. */
  copyData(): { cells: string; text: string; html: string } | null {
    const el = this.table()
    const rect = this.rect()
    if (!el || !rect || this.host.editingCell()) return null
    const block = copyCells(el, rect)
    const text = cellsToTsv(block.rows)
    this.lastCopy = { tsv: text, rows: block.rows }
    return { cells: JSON.stringify({ rows: block.rows }), text, html: cellsToHtml(block.rows) }
  }

  /** ⌘C / ⌘X on selected cells. False = not ours to handle. */
  copy(ev: ClipboardEvent, cut: boolean): boolean {
    if (!ev.clipboardData) return false
    const data = this.copyData()
    if (!data) return false
    ev.clipboardData.setData(CELLS_MIME, data.cells)
    ev.clipboardData.setData('text/plain', data.text)
    ev.clipboardData.setData('text/html', data.html)
    ev.preventDefault()
    if (cut) this.run('clear')
    return true
  }

  /** ⌘V onto selected cells. False = not ours. */
  paste(ev: ClipboardEvent, isElementClip: (text: string) => boolean): boolean {
    const dt = ev.clipboardData
    if (!dt || !this.pasteData(dt.getData(CELLS_MIME), dt.getData('text/plain'), isElementClip)) return false
    ev.preventDefault()
    return true
  }

  /** Paste onto the selected cells: a copied block (`cells`, spans kept) or
   *  tab-separated `text`, with its top-left on the range's. One commit.
   *  False = nothing selected, or the clipboard is not cells (elements, empty). */
  pasteData(cells: string | null, text: string | null, isElementClip: (text: string) => boolean): boolean {
    const el = this.table()
    const rect = this.rect()
    if (!el || !rect || this.host.editingCell()) return false
    let block: Array<{ cells: TableCell[] }> | null = null
    if (cells) {
      try { block = sanitizeCellBlock((JSON.parse(cells) as { rows?: unknown })?.rows) } catch { block = null }
    }
    if (!block) {
      if (!text || isElementClip(text)) return false
      // our own copy, back as text only: paste the block it came from
      block = this.lastCopy && this.lastCopy.tsv === text
        ? sanitizeCellBlock(this.lastCopy.rows)
        : tsvToCells(text.slice(0, 200_000))
    }
    if (!block?.length) return false
    const id = el.id
    let written: CellRect | null = null
    this.host.store.commit(() => {
      written = pasteCells(this.host.store.element(id) as TableElement, rect.r0, rect.c0, block!)
    })
    if (written) {
      const w = written as CellRect
      this.sel = { id, anchor: [w.r0, w.c0], focus: [w.r1, w.c1] }
    }
    this.paint()
    return true
  }
}

/** A copied block as an html table, for other apps (cell html is the model's
 *  own, re-sanitized; spans as attributes, covered cells left out). */
function cellsToHtml(rows: Array<{ cells: TableCell[] }>): string {
  const width = Math.max(0, ...rows.map((r) => r.cells.length))
  const tb = { rows: rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c })) })), columns: Array.from({ length: width }, () => ({ w: 1 })) }
  const covered = new Set<string>()
  const out = tb.rows.map((row, r) => '<tr>' + row.cells.map((cell, c) => {
    if (covered.has(`${r},${c}`)) return ''
    const cs = Math.max(1, Math.min(Number(cell.colspan) || 1, width - c))
    const rs = Math.max(1, Math.min(Number(cell.rowspan) || 1, rows.length - r))
    for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) if (i !== r || j !== c) covered.add(`${i},${j}`)
    return `<td${cs > 1 ? ` colspan="${cs}"` : ''}${rs > 1 ? ` rowspan="${rs}"` : ''}>${sanitizeHtml(String(cell.html ?? ''))}</td>`
  }).join('') + '</tr>').join('')
  return `<table>${out}</table>`
}
