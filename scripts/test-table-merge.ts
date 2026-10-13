#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Merged table cells rig (slides/src/tablespans.ts, DECISIONS 2026-10-08).
//
//   slides/node_modules/.bin/esbuild scripts/test-table-merge.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-table-merge.mjs" \
//     && node "$TMPDIR/test-table-merge.mjs"
//
// Pins:
//   * the layout: spans are clamped to the grid and never overlap, whatever a
//     file says, and normalizeTableSpans writes exactly that layout back;
//   * every structural edit (merge, split, insert/delete row/column, paste)
//     keeps the grid rectangular and the spans honest;
//   * the reader gate: `requires: ['table-merge']` exactly while a table has
//     a span — through the Store's sync, save.ts's write wrapper and a
//     parseDoc round trip; an older build does not know the name;
//   * untrusted.ts: hostile spans are dropped or normalised;
//   * render.ts draws real colspan/rowspan and skips covered cells;
//   * validate.ts reports clamped spans and hidden text, and stays quiet on
//     a clean merged table.

import fs from 'node:fs'
import path from 'node:path'
import {
  KNOWN_FEATURES, TABLE_MERGE_FEATURE, defaultTable, newDoc, parseDoc, syncContentRequires,
  syncTableMergeRequires, unsupportedFeatures, usesTableMerge, type TableElement,
} from '../slides/src/model'
import { withContentRequires } from '../slides/src/save'
import { missingFeatures } from '../kernel/src/doc'
import { sanitizeCellBlock, sanitizeElement } from '../slides/src/untrusted'
import { renderTableHtml } from '../slides/src/render'
import { validateDoc } from '../slides/src/validate'
import {
  canMerge, canSplit, cellToward, cellsToTsv, clearCells, closeRect, copyCells, deleteColumns, deleteRows,
  insertColumn, insertRow, mergeCells, nextCell, normalizeTableSpans, pasteCells, splitCells, TABLE_MAX, tableLayout, tsvToCells,
} from '../slides/src/tablespans'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) } else console.log(`  ✓ ${msg}`)
}

/** An r×c table whose cells say where they are ("r,c"). */
function grid(nr: number, nc: number): TableElement {
  return defaultTable({
    id: 'tb', header: false,
    columns: Array.from({ length: nc }, () => ({ w: 1 })),
    rows: Array.from({ length: nr }, (_, r) => ({ cells: Array.from({ length: nc }, (_, c) => ({ html: `${r},${c}` })) })),
  })
}
/** The layout as a picture: anchor cells by their text, covered as '·'. */
function picture(el: TableElement): string {
  const L = tableLayout(el)
  return el.rows.map((row, r) => row.cells.map((cell, c) => {
    const sp = L.span[r][c]
    if (!sp) return '·'
    return (cell.html || '_') + (sp.rs > 1 || sp.cs > 1 ? `[${sp.rs}x${sp.cs}]` : '')
  }).join(' ')).join(' / ')
}
const rectangular = (el: TableElement) => el.rows.every((r) => r.cells.length === el.columns.length)

// --- the layout -------------------------------------------------------------------

console.log('\nlayout')
{
  const t = grid(3, 3)
  ok(picture(t) === '0,0 0,1 0,2 / 1,0 1,1 1,2 / 2,0 2,1 2,2', 'a table without spans is all anchors')
  t.rows[0].cells[0].colspan = 2
  t.rows[0].cells[0].rowspan = 2
  ok(picture(t) === '0,0[2x2] · 0,2 / · · 1,2 / 2,0 2,1 2,2', 'a 2×2 span covers its block')
  t.rows[0].cells[2].rowspan = 9
  ok(picture(t).includes('0,2[3x1]'), 'a span past the bottom is clamped to the grid')
  t.rows[0].cells[2].colspan = 4
  ok(picture(t).includes('0,2[3x1]'), 'and past the right edge')
  const u = grid(2, 3)
  u.rows[0].cells[1].rowspan = 2
  u.rows[1].cells[0].colspan = 3
  ok(picture(u) === '0,0 0,1[2x1] 0,2 / 1,0 · 1,2', 'an overlapping span shrinks — the first anchor in reading order wins')
  const v = grid(2, 2)
  v.rows[0].cells[0].colspan = 2
  v.rows[0].cells[1].rowspan = 2 // a covered cell's own span
  ok(picture(v) === '0,0[1x2] · / 1,0 1,1', "a covered cell's own span is ignored")
  ok(normalizeTableSpans(v) && !('rowspan' in v.rows[0].cells[1]), 'and normalising removes it')
  ok(!normalizeTableSpans(v), 'normalising twice changes nothing')
  const w = grid(2, 2)
  w.rows[0].cells[0].colspan = 1.9 as never
  w.rows[1].cells[0].rowspan = -3 as never
  ok(picture(w) === '0,0 0,1 / 1,0 1,1', 'fractions floor, junk reads as 1')
  normalizeTableSpans(w)
  ok(!('colspan' in w.rows[0].cells[0]) && !('rowspan' in w.rows[1].cells[0]), 'and a span of 1 is not stored')
  const ragged = grid(2, 3)
  ragged.rows[1].cells.pop()
  ragged.rows[0].cells[1].rowspan = 2
  ragged.rows[0].cells[1].colspan = 2
  ok(picture(ragged) === '0,0 0,1[1x2] · / 1,0 1,1', 'a short row cannot be covered past its end')
}

// --- merge / split ------------------------------------------------------------------

console.log('\nmerge and split')
{
  const t = grid(3, 3)
  ok(canMerge(t, { r0: 0, c0: 0, r1: 1, c1: 1 }) && !canMerge(t, { r0: 1, c0: 1, r1: 1, c1: 1 }), 'one cell cannot merge, a block can')
  const R = mergeCells(t, { r0: 0, c0: 0, r1: 1, c1: 1 })
  ok(!!R && picture(t) === '0,0<br>0,1<br>1,0<br>1,1[2x2] · 0,2 / · · 1,2 / 2,0 2,1 2,2', 'merge keeps every text, one line each, in the top-left cell')
  ok(t.rows[0].cells[1].html === '' && t.rows[1].cells[1].html === '', 'and empties the covered cells')
  ok(rectangular(t), 'the grid stays rectangular')
  ok(!canMerge(t, { r0: 0, c0: 0, r1: 0, c1: 0 }), 'a merged cell on its own is not mergeable again')
  ok(JSON.stringify(closeRect(t, { r0: 1, c0: 1, r1: 2, c1: 2 })) === JSON.stringify({ r0: 0, c0: 0, r1: 2, c1: 2 }),
    'a selection that cuts a merged cell grows to hold all of it')
  mergeCells(t, { r0: 1, c0: 1, r1: 1, c1: 2 })
  ok(picture(t).startsWith('0,0<br>0,1<br>1,0<br>1,1<br>0,2<br>1,2[2x3]'), 'merging across a merged cell takes it in whole')
  ok(canSplit(t, { r0: 2, c0: 0, r1: 2, c1: 2 }) === false && canSplit(t, { r0: 1, c0: 2, r1: 1, c1: 2 }), 'split is offered only where a merged cell is')
  ok(splitCells(t, { r0: 1, c0: 1, r1: 1, c1: 1 }) && picture(t).startsWith('0,0<br>0,1<br>1,0<br>1,1<br>0,2<br>1,2 _ _ / _ _ _'),
    'split gives back single, empty cells; the text stays top-left')
  ok(!splitCells(t, { r0: 0, c0: 0, r1: 2, c1: 2 }), 'nothing left to split')
  const e = grid(1, 3)
  e.rows[0].cells[1].html = '<br>'
  e.rows[0].cells[2].html = ''
  mergeCells(e, { r0: 0, c0: 0, r1: 0, c1: 2 })
  ok(e.rows[0].cells[0].html === '0,0', 'empty cells add no blank lines to the merged text')
}

// --- rows and columns ------------------------------------------------------------------

console.log('\ninsert and delete with spans present')
{
  const t = grid(3, 3)
  mergeCells(t, { r0: 0, c0: 0, r1: 1, c1: 1 }) // 2×2 at the top-left
  t.rows[0].cells[0].html = 'M'
  insertRow(t, 1)
  ok(picture(t) === 'M[3x2] · 0,2 / · · _ / · · 1,2 / 2,0 2,1 2,2' && rectangular(t), 'a row inserted through a merged cell grows it')
  insertRow(t, 0)
  ok(picture(t).startsWith('_ _ _ / M[3x2]'), 'a row inserted above it moves it down')
  insertRow(t, t.rows.length)
  ok(t.rows.length === 6 && picture(t).endsWith('/ _ _ _'), 'appending a row (the panel stepper) touches no span')
  deleteRows(t, 0, 0)
  deleteRows(t, t.rows.length - 1, t.rows.length - 1)
  insertColumn(t, 1)
  ok(picture(t) === 'M[3x3] · · 0,2 / · · · _ / · · · 1,2 / 2,0 _ 2,1 2,2' && rectangular(t) && t.columns.length === 4,
    'a column inserted through a merged cell widens it')
  insertColumn(t, 0)
  ok(picture(t).startsWith('_ M[3x3]') && t.columns.length === 5, 'a column inserted left of it moves it right')
  deleteColumns(t, 0, 0)
  deleteColumns(t, 1, 1)
  ok(picture(t) === 'M[3x2] · 0,2 / · · _ / · · 1,2 / 2,0 2,1 2,2', 'deleting a column it spans shrinks it')
  deleteRows(t, 1, 1)
  ok(picture(t) === 'M[2x2] · 0,2 / · · 1,2 / 2,0 2,1 2,2', 'deleting a row it spans shrinks it')
  deleteRows(t, 0, 0)
  ok(picture(t) === 'M[1x2] · 1,2 / 2,0 2,1 2,2', 'deleting its TOP row moves it (text and all) to the next row')
  deleteColumns(t, 0, 0)
  ok(picture(t) === 'M 1,2 / 2,1 2,2' && rectangular(t), 'deleting its LEFT column moves it to the next column')
  ok(!deleteRows(t, 0, t.rows.length - 1) && !deleteColumns(t, 0, t.columns.length - 1), 'the last row / column is never deleted')
  ok(!('colspan' in t.rows[0].cells[0]) && !('rowspan' in t.rows[0].cells[0]), 'a span shrunk to 1 is not stored')
}

// --- keyboard navigation -----------------------------------------------------------------

console.log('\nnavigation skips covered cells')
{
  const t = grid(3, 3)
  mergeCells(t, { r0: 0, c0: 1, r1: 1, c1: 2 }) // 2×2 at (0,1)
  const walk: string[] = []
  for (let at: [number, number] | null = [0, 0]; at; at = nextCell(t, at[0], at[1], 1)) walk.push(at.join(','))
  ok(walk.join(' ') === '0,0 0,1 1,0 2,0 2,1 2,2', 'Tab visits each cell once, merged ones once')
  ok(nextCell(t, 1, 2, -1)?.join() === '0,0', 'Shift+Tab from inside a merged cell goes before its top-left')
  ok(cellToward(t, 0, 0, 'right')?.join() === '0,1' && cellToward(t, 0, 1, 'right') === null, '→ steps over the whole merged cell')
  ok(cellToward(t, 0, 1, 'down')?.join() === '2,1' && cellToward(t, 2, 2, 'up')?.join() === '0,1', '↓/↑ leave it below/above its block')
  ok(cellToward(t, 1, 0, 'right')?.join() === '0,1', '→ into a merged cell lands on its top-left')
}

// --- copy / paste ------------------------------------------------------------------------

console.log('\ncopy and paste a range')
{
  const t = grid(3, 3)
  mergeCells(t, { r0: 0, c0: 0, r1: 0, c1: 1 })
  const clip = copyCells(t, { r0: 0, c0: 1, r1: 1, c1: 1 })
  ok(JSON.stringify(clip.rect) === JSON.stringify({ r0: 0, c0: 0, r1: 1, c1: 1 }) && clip.rows[0].cells[0].colspan === 2,
    'copying part of a merged cell copies all of it, span included')
  ok(cellsToTsv(clip.rows) === '0,0 0,1\t\n1,0\t1,1', 'as text: tab-separated, covered cells empty')
  const block = sanitizeCellBlock(JSON.parse(JSON.stringify(clip.rows)))
  ok(!!block && block[0].cells[0].colspan === 2, 'the clipboard block survives untrusted.ts')
  const dst = grid(2, 2)
  const R = pasteCells(dst, 1, 1, block!)
  ok(!!R && dst.rows.length === 3 && dst.columns.length === 3 && rectangular(dst), 'pasting past the edge grows the table')
  ok(picture(dst) === '0,0 0,1 _ / 1,0 0,0<br>0,1[1x2] · / _ 1,0 1,1', 'and lands the merged cell as a merged cell')
  const over = grid(3, 3)
  mergeCells(over, { r0: 0, c0: 0, r1: 2, c1: 0 }) // a 3×1 column
  pasteCells(over, 1, 0, [{ cells: [{ html: 'P' }] }])
  ok(picture(over).startsWith('0,0<br>1,0<br>2,0 0,1 0,2 / P '), 'a paste onto a merged cell splits it first')
  ok(rectangular(over), 'still rectangular')
  // a huge paste stops where the sanitizer would cut the table anyway — fast
  const big = grid(3, 3)
  const t0 = Date.now()
  const BR = pasteCells(big, 1, 1, tsvToCells(['x\t'.repeat(300), ...Array.from({ length: 5000 }, (_, i) => `r${i}`)].join('\n')))
  const ms = Date.now() - t0
  ok(big.rows.length === TABLE_MAX.rows && big.columns.length === TABLE_MAX.cols && rectangular(big), 'a huge paste stops at TABLE_MAX rows × columns')
  ok(!!BR && BR.r1 === TABLE_MAX.rows - 1 && BR.c1 === TABLE_MAX.cols - 1 && big.rows[1].cells[1].html === 'x', 'and reports the part it wrote')
  ok(ms < 1500, `and grows the table in one go (${ms} ms)`)
  ok(pasteCells(grid(1, 1), TABLE_MAX.rows, 0, [{ cells: [{ html: 'n' }] }]) === null, 'a paste wholly past the ceiling writes nothing')
  ok(tsvToCells('a\tb\nc\td\n').map((r) => r.cells.map((c) => c.html).join('|')).join('/') === 'a|b/c|d', 'tab-separated text pastes as cells')
  ok(tsvToCells('<x>&').length === 1 && tsvToCells('<x>&')[0].cells[0].html === '&lt;x&gt;&amp;', 'and is escaped, never markup')
  const c2 = grid(2, 2)
  mergeCells(c2, { r0: 0, c0: 0, r1: 1, c1: 0 })
  ok(clearCells(c2, { r0: 1, c0: 0, r1: 1, c1: 1 }) && c2.rows[0].cells[0].html === '' && c2.rows[1].cells[1].html === '', 'Delete clears a range, merged cells whole')
}

// --- untrusted.ts ------------------------------------------------------------------------

console.log('\nuntrusted: hostile spans')
{
  const t = grid(2, 2) as unknown as Record<string, unknown>
  const rows = (t.rows as Array<{ cells: Array<Record<string, unknown>> }>)
  rows[0].cells[0].colspan = 99
  rows[0].cells[1].rowspan = 2 // covered by the colspan above
  const out = sanitizeElement(t) as unknown as TableElement
  ok(!!out && out.rows[0].cells[0].colspan === 2 && !('rowspan' in out.rows[0].cells[1]), 'a pasted span is clamped to its grid and overlaps resolved')
  for (const bad of [0, -1, 1.5, 'x', 1e9, '2" onclick="x']) {
    const u = grid(2, 2) as unknown as { rows: Array<{ cells: Array<Record<string, unknown>> }> }
    u.rows[0].cells[0].colspan = bad
    const s = sanitizeElement(u) as unknown as TableElement
    ok(!!s && !('colspan' in s.rows[0].cells[0]), `colspan ${JSON.stringify(bad)} is dropped`)
  }
  const v = grid(2, 2) as unknown as { rows: Array<{ cells: Array<Record<string, unknown>> }> }
  v.rows[0].cells[0].rowspan = '2'
  ok((sanitizeElement(v) as unknown as TableElement).rows[0].cells[0].rowspan === 2, 'a numeric string is coerced, like every number')
  ok(sanitizeCellBlock({}) === null && sanitizeCellBlock([]) === null && sanitizeCellBlock([{ cells: [{ html: 1 }] }]) === null,
    'a clipboard block that is not rows of cells is refused')
}

// --- render.ts ----------------------------------------------------------------------------

console.log('\nrender')
{
  const doc = newDoc()
  const t = grid(2, 3)
  mergeCells(t, { r0: 0, c0: 0, r1: 1, c1: 1 })
  const html = renderTableHtml(t, doc)
  ok(/<td data-r="0" data-c="0" colspan="2" rowspan="2"/.test(html), 'the anchor is a real colspan/rowspan cell')
  ok((html.match(/<td /g) ?? []).length === 3, 'covered cells are not drawn')
  ok(!/data-r="1" data-c="1"/.test(html) && /data-r="1" data-c="2"/.test(html), 'and the cell beside the block keeps its own coordinates')
  const plain = renderTableHtml(grid(2, 2), doc)
  ok(!/colspan|rowspan/.test(plain), 'a table without spans renders as before')
  const hostile = grid(1, 2) as unknown as { rows: Array<{ cells: Array<Record<string, unknown>> }> }
  hostile.rows[0].cells[0].colspan = '2"><img src=x onerror=alert(1)>'
  ok(!/onerror|<img/.test(renderTableHtml(hostile as unknown as TableElement, doc)), 'a span is a number in the markup, never the stored string')
}

// --- validate.ts --------------------------------------------------------------------------

console.log('\nvalidate')
{
  const doc = newDoc()
  const t = grid(3, 3)
  mergeCells(t, { r0: 0, c0: 0, r1: 1, c1: 1 })
  doc.slides[0].elements = [t]
  const codes = () => validateDoc(doc, { measure: false }).findings.map((f) => f.code).filter((c) => c.startsWith('table-'))
  ok(codes().length === 0, 'a clean merged table is quiet')
  t.rows[1].cells[1].html = 'lost'
  t.rows[2].cells[2].colspan = 7 // the last column: nothing to span
  t.rows[0].cells[1].rowspan = 2
  const got = codes().sort().join(' ')
  ok(got === 'table-hidden-text table-span-clamped table-span-clamped', `hidden text and clamped spans are reported (${got})`)
}

// --- the reader gate ----------------------------------------------------------------------

console.log('\nrequires: table-merge')
{
  ok(KNOWN_FEATURES.has(TABLE_MERGE_FEATURE) && TABLE_MERGE_FEATURE === 'table-merge', 'this build knows "table-merge"')
  const OLDER = new Set(['asset-store', 'rich-text']) // what the build before this one knew
  ok(missingFeatures({ requires: ['table-merge'] }, OLDER).join() === 'table-merge',
    'an older build does not — it opens such a file read-only instead of saving the grid unmerged')
  ok(unsupportedFeatures({ requires: ['table-merge', 'rich-text', 'asset-store'] }).length === 0, 'and this build may write it')

  const d = newDoc() as ReturnType<typeof newDoc> & { requires?: unknown }
  const t = grid(2, 2)
  d.slides[0].elements = [t]
  ok(!usesTableMerge(d) && !syncContentRequires(d) && !('requires' in d), 'a plain table declares nothing')
  mergeCells(t, { r0: 0, c0: 0, r1: 0, c1: 1 })
  ok(usesTableMerge(d) && syncContentRequires(d) && JSON.stringify(d.requires) === '["table-merge"]', 'a merge declares the name')
  ok(!syncTableMergeRequires(d), 'and is a no-op the second time')
  d.requires = ['asset-store', 'table-merge']
  splitCells(t, { r0: 0, c0: 0, r1: 0, c1: 1 })
  ok(syncContentRequires(d) && JSON.stringify(d.requires) === '["asset-store"]', 'splitting the last merged cell drops it and keeps every other name')
  d.requires = 'table-merge'
  mergeCells(t, { r0: 0, c0: 0, r1: 1, c1: 0 })
  ok(!syncTableMergeRequires(d) && d.requires === 'table-merge', "a malformed requires is never \"fixed\" — the reader gate's call")
  delete d.requires

  for (const where of ['layouts', 'reusableObjects'] as const) {
    const x = newDoc() as ReturnType<typeof newDoc> & Record<string, unknown>
    const tb = grid(2, 2)
    tb.rows[0].cells[0].rowspan = 2
    x[where] = [{ ...x.slides[0], id: 'L1', elements: [tb] }]
    ok(usesTableMerge(x), `a merged cell on a ${where === 'layouts' ? 'slide type' : 'deck object'} counts`)
  }

  // write time: a doc the Store never saw (library item, template stamp)
  const lib = newDoc()
  lib.slides[0].elements = [t]
  const written = withContentRequires(lib) as typeof lib & { requires?: string[] }
  ok(JSON.stringify(written.requires) === '["table-merge"]' && written !== lib && !('requires' in lib),
    'save.ts declares it on a shallow copy, never touching the caller\'s doc')

  // the format's own load path keeps both the spans and the name
  const file = JSON.parse(JSON.stringify(written))
  const back = parseDoc(JSON.stringify(file)) as (typeof written) | null
  const bt = back?.slides[0].elements[0] as TableElement | undefined
  ok(!!back && JSON.stringify(back.requires) === '["table-merge"]' && bt?.rows[0].cells[0].rowspan === 2, 'parseDoc keeps requires and the spans')
  ok(bt?.rows.every((r) => r.cells.length === 2) === true, 'and the full grid — covered cells included — for an older reader')

  // the wiring (source pins: the Store needs IndexedDB, a node rig has none)
  const store = fs.readFileSync(path.resolve('slides/src/store.ts'), 'utf8')
  ok((store.match(/syncContentRequires\((?:doc|next|this\.doc)\)/g) ?? []).length === 3, 'the Store syncs on load, on replaceDoc and on every touch')
  const lib2 = fs.readFileSync(path.resolve('slides/src/editor/library.ts'), 'utf8')
  ok(lib2.includes('JSON.stringify(withContentRequires(doc))'), 'and the library splice declares it too')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
