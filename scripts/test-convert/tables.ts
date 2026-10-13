#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert tables rig — merged cells and PowerPoint's built-in
// table styles (convert/table.ts) through the whole convertPptx pipeline.
//
//   node scripts/test-convert/tables.ts
//
// The fixture is _fixtures.ts's fxTables. Expected colours are the fixture
// theme's own slots (accent2 #FBAE40, accent4 #FF0000, accent5 #70AD47,
// accent6 #C00000, dk1 #000000, lt1 #FFFFFF) or, for the two tints, the
// values graphics.ts worked on paper (accent1 20% #E8EBF5, 40% #CDD4EA).
//
// Negative controls, each seen to fail against a deliberately broken
// implementation while this rig was written:
//
//   • covered cells: the two green-filled continuation cells of the 2×2
//     block — counting them (the old flattening did) puts #00FF00 overrides
//     into the output, and the "ghost" text a writer left in a covered cell
//     must never appear.
//   • grid placement: "Short" leaves its hMerge cells out; reading a:tc by
//     index puts "end" in column 1, under the span, where it is hidden.
//   • effects: Themed Style 1's effectRef idx 1 points at an EMPTY theme
//     effect style — reporting every effectRef would flag it too.
//   • GUIDs: the rig carries its own copy of the 74 GUIDs, so a typo in
//     table.ts's list fails here instead of agreeing with itself.

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import { builtinStyleIds, builtinStyleXml } from '../../kernel/src/convert/table.ts'
import { parseXml, kid, attr, NS } from '../../kernel/src/convert/xml.ts'
import type { OutTable, OutTableCell } from '../../kernel/src/convert/types.ts'
import { tableLayout, normalizeTableSpans } from '../../slides/src/tablespans.ts'
import { fxTables, BUILTIN_TABLE_STYLE_IDS } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const r = await convertPptx(await fxTables(), { link: false })
const byId = (slide: number, id: string) => r.doc.slides[slide].elements.find((e) => e.id === id) as OutTable
const where = (code: string) => r.report.entries.filter((e) => e.code === code).map((e) => e.where)
const st = (t: OutTable) => t.style as Record<string, unknown>
const cell = (t: OutTable, row: number, col: number): OutTableCell => t.rows[row].cells[col]

// ------------------------------------------------------------- merged cells
{
  const t = byId(0, 's1-2')
  ok(t?.type === 'table' && t.rows.length === 5 && t.rows.every((row) => row.cells.length === 4),
    'merged: the grid stays rectangular — 5 rows × 4 cells, covered positions kept')
  ok(cell(t, 0, 0).html === 'Region' && cell(t, 0, 0).rowspan === 2 && cell(t, 0, 0).colspan === undefined,
    'merged: rowSpan="2" → rowspan 2 on the origin (no colspan 1 written)')
  ok(cell(t, 0, 1).html === '2025' && cell(t, 0, 1).colspan === 2 && cell(t, 0, 1).rowspan === undefined,
    'merged: gridSpan="2" → colspan 2 on the origin')
  ok(eq(cell(t, 0, 2), { html: '' }) && eq(cell(t, 1, 0), { html: '' }),
    'merged: hMerge / vMerge continuations are plain empty cells in their grid positions')
  const block = cell(t, 2, 1)
  ok(block.html === 'Block' && block.colspan === 2 && block.rowspan === 2,
    'merged: gridSpan + rowSpan on one origin → a 2×2 block')
  ok(block.bg === '#FF0000', 'merged: the origin keeps its own fill (it paints the whole block)')
  ok(eq(cell(t, 2, 2), { html: '' }) && eq(cell(t, 3, 1), { html: '' }) && eq(cell(t, 3, 2), { html: '' }),
    'merged: the three cells the block covers are empty and carry no overrides')
  ok(!t.rows.some((row) => row.cells.some((c) => c.bg === '#00FF00')),
    'merged: NEGATIVE — a covered cell\'s own fill never reaches the output')
  ok(!JSON.stringify(t.rows).includes('ghost'), 'merged: NEGATIVE — text hidden in a covered cell is not emitted')
  ok(cell(t, 4, 3).html === '3' && cell(t, 4, 3).colspan === undefined,
    'merged: a gridSpan past the grid edge is cut back (here to no span at all)')
  ok(st(t).headerBg === '#4472C4' && st(t).zebra === '#E8EBF5',
    'merged: the table-wide header / zebra choice is unchanged by the merges')
  ok(cell(t, 1, 1).bg === '#CDD4EA' && cell(t, 3, 0).bg === '#CDD4EA',
    'merged: band1 rows still carry their 40% tint on the cells that are drawn')
  // the slides model reads exactly what was emitted: already normalised
  const copy = JSON.parse(JSON.stringify(t)) as Parameters<typeof normalizeTableSpans>[0]
  ok(!normalizeTableSpans(copy), 'merged: slides\' normalizeTableSpans changes nothing — the importer emits the normal form')
  const L = tableLayout(t as unknown as Parameters<typeof tableLayout>[0])
  ok(eq(L.owner[3][2], [2, 1]) && eq(L.owner[1][0], [0, 0]) && eq(L.owner[0][2], [0, 1]),
    'merged: slides\' tableLayout gives every covered position to its origin')
}
{
  const t = byId(0, 's1-3')
  ok(t.rows[0].cells.length === 3, 'short row: a writer that omits hMerge cells still yields three grid cells')
  ok(cell(t, 0, 0).html === 'Wide' && cell(t, 0, 0).colspan === 2 && eq(cell(t, 0, 1), { html: '' }),
    'short row: the origin spans 2 and the left-out position is an empty covered cell')
  ok(cell(t, 0, 2).html === 'end', 'short row: the cell after the span lands in ITS column (2), not under the span')
  ok(eq(t.rows[1].cells.map((c) => c.html), ['a', 'b', 'c']), 'short row: the next row is untouched')
}
ok(eq(r.doc.requires, ['table-merge']), 'document: a span makes it declare requires: [table-merge]')
ok(where('table-span-clamped').length === 1 && where('table-span-clamped')[0].includes('Merged'),
  'report: the over-long gridSpan is table-span-clamped, on the merged table only')
ok(where('table-merge-hidden-text').length === 1 && where('table-merge-hidden-text')[0].includes('Merged'),
  'report: the covered "ghost" text is table-merge-hidden-text')
ok(where('table-merge-flattened').length === 0, 'report: merges are no longer flattened')

// --------------------------------------------------- built-ins by GUID
{
  const m1 = st(byId(1, 's2-2'))
  ok(m1.headerBg === '#FBAE40' && m1.headerColor === '#FFFFFF', 'Medium Style 1 – Accent 2: accent2 header under lt1 ink')
  ok(m1.borderColor === '#FBAE40' && m1.borderWidth === 1.33, 'Medium Style 1 – Accent 2: 1pt accent2 rules')
  ok(m1.zebra === '#FFFFFF' && m1.color === '#000000', 'Medium Style 1 – Accent 2: lt1 body (band2 rows), dk1 ink')

  const l2 = st(byId(1, 's2-3'))
  ok(l2.headerBg === '#4472C4' && l2.headerColor === '#FFFFFF',
    'Light Style 2 – Accent 1: header through a:fillRef idx 1 in accent1, under bg1 ink')
  ok(l2.borderColor === '#4472C4' && l2.borderWidth === 0.67, 'Light Style 2 – Accent 1: lnRef idx 1 rules in accent1')
  ok(l2.zebra === undefined, 'Light Style 2 – Accent 1: no body fill')

  const m3 = st(byId(1, 's2-4'))
  ok(m3.headerBg === '#70AD47' && m3.headerColor === '#FFFFFF', 'Medium Style 3 – Accent 5: the accent colours the header')
  ok(m3.borderColor === '#000000' && m3.borderWidth === 2.67, 'Medium Style 3 – Accent 5: the 2pt rules stay dk1')

  const d2 = st(byId(1, 's2-5'))
  ok(d2.headerBg === '#FF0000' && d2.headerColor === '#FFFFFF' && d2.color === '#000000',
    'Dark Style 2 – Accent 3/Accent 4: the pair\'s second accent heads the table')

  const grid = st(byId(1, 's2-6'))
  ok(grid.headerBg === 'transparent' && grid.borderColor === '#000000' && grid.borderWidth === 1.33,
    'No Style, Table Grid: no fills, 1pt tx1 grid')

  const t2 = st(byId(1, 's2-7'))
  ok(t2.headerBg === '#C00000' && t2.color === '#FFFFFF', 'Themed Style 2 – Accent 6: the table background (accent6) under lt1 ink')
  const t1 = st(byId(1, 's2-8'))
  ok(t1.headerBg === '#4472C4', 'Themed Style 1 – Accent 1: accent1 header')
}
ok(eq(where('table-effect-dropped').filter((w) => w.startsWith('slide 2 ')), ['slide 2 / sp "Themed 2 A6"']),
  'effects: only the table whose background effect draws something is reported (not Themed Style 1\'s empty one)')
ok(where('table-effect-dropped').filter((w) => w.startsWith('slide 3 ')).length === 6,
  'effects: on the all-built-ins slide exactly the six Themed Style 2 tables (effectRef idx 3) are reported')
ok((r.report.entries.find((e) => e.code === 'table-effect-dropped')?.detail ?? '').includes('outerShdw'),
  'effects: the report names what was dropped')

// ------------------------------------------------- every built-in GUID
ok(eq(builtinStyleIds(), BUILTIN_TABLE_STYLE_IDS), 'built-ins: all 74 GUIDs, in PowerPoint\'s gallery order')
{
  const names = new Set<string>()
  let parsed = 0
  for (const id of BUILTIN_TABLE_STYLE_IDS) {
    const xml = builtinStyleXml(id)
    if (!xml) continue
    const el = parseXml(xml)
    if (attr(el, 'styleId') === id && kid(el, NS.a, 'wholeTbl')) parsed++
    names.add(attr(el, 'styleName') ?? '')
  }
  ok(parsed === 74, `built-ins: every style generates parseable XML with a wholeTbl (${parsed}/74)`)
  ok(names.size === 74, 'built-ins: 74 distinct style names')
  ok(names.has('Medium Style 2 - Accent 1') && names.has('Light Style 3') && names.has('Dark Style 2 - Accent 5/Accent 6') &&
    names.has('Themed Style 2 - Accent 6') && names.has('No Style, Table Grid'),
  'built-ins: names follow PowerPoint\'s gallery ("<family> - Accent N")')
  ok(builtinStyleXml('{DEADBEEF-0000-0000-0000-000000000000}') === undefined, 'built-ins: an unknown GUID is not invented')
}
ok(r.doc.slides[2].elements.filter((e) => e.type === 'table').length === 74, 'built-ins: all 74 fixture tables import')
ok(where('table-style-unknown').length === 0, 'built-ins: no table-style-unknown for any shipped GUID')

const codes = [...new Set(r.report.entries.map((e) => e.code))].sort()
const want = ['table-borders-unified', 'table-effect-dropped', 'table-imported', 'table-merge-hidden-text', 'table-span-clamped']
ok(eq(codes, want), `tables: report codes are exactly [${want.join(', ')}] (got [${codes.join(', ')}])`)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
