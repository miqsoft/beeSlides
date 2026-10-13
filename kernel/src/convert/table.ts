// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// a:tbl → OutTable. The two table models disagree about where the look lives,
// and the converter's whole job is the translation between them:
//
//   - PowerPoint styles a table through a TABLE STYLE (ppt/tableStyles.xml, or
//     a built-in referenced by GUID) applied in LAYERS — wholeTbl, then the
//     column/row bands, then first/last column, then first/last row — with
//     the tblPr flags (firstRow, bandRow, …) switching layers on, and each
//     cell's own tcPr on top. slidomingo holds ONE TableStyle per table
//     (header colours, a zebra stripe, one border) plus per-cell overrides.
//     So every cell's EFFECTIVE fill/ink/bold is resolved here, the
//     table-wide style is chosen as the most common value per region, and a
//     cell carries an override only where it differs from what the renderer
//     would paint without one. The result looks like the source and still
//     re-styles as a whole wherever the source was uniform.
//   - Built-in styles are usually WRITTEN INTO tableStyles.xml by PowerPoint
//     (it embeds every style the deck uses), so the part is the first source.
//     A GUID the part does not define falls back to the built-ins generated
//     below (all 74 of PowerPoint's gallery: No Style, Themed 1/2, Light
//     1–3, Medium 1–4, Dark 1/2, with their accents) or, for any other GUID,
//     a plain table — reported.
//   - A layer's fill is an a:fill OR an a:fillRef into the theme's fill
//     styles, a border edge an a:ln OR an a:lnRef (the Themed and several
//     Light styles use the refs throughout), and a style may carry an
//     a:tblBg: the table's background, showing under noFill layers and
//     composited under translucent ones. Gradients (theme fill styles 2/3
//     usually are) flatten to the mean of their stops — reported. A tblBg's
//     effect (a theme shadow or bevel, through a:effectRef) is reported as
//     dropped when the theme's effect style would draw something.
//   - Merged cells map one to one (DECISIONS 2026-10-08): the origin a:tc's
//     gridSpan/rowSpan become the anchor's colspan/rowspan, and every cell it
//     covers (hMerge/vMerge) stays in the grid as an empty `{ html: '' }`.
//     The origin's look covers the block; covered cells take no part in the
//     table-wide style choice. The orchestrator declares
//     `requires: ['table-merge']` when a span was emitted (pptx.ts).
//   - Row heights have no field either (the renderer shares the frame's height
//     between rows by content); uneven a:tr@h is reported, not faked.
//   - Text flattens like text.ts's: b/i/u/strike survive as markup, size and
//     face go table-wide (dominant by character count), ink goes per cell.
//
// The element is returned WITHOUT an id — the orchestrator mints it, as for
// pictures (imageFrom's contract).

import { NS, kid, kids, attr, intAttr, textOf, parseXml, descendants, type XElem } from './xml.ts'
import { resolveColor, resolveFillRef, resolveLnRef } from './theme.ts'
import {
  EMU_PER_PX, METRIC_SUBSTITUTES,
  type InheritCtx, type OutSlide, type OutTable, type OutTableCell,
} from './types.ts'

/** EMU → px, 1/100 px (the engine-wide convention). */
const px = (emu: number): number => Math.round((emu / EMU_PER_PX) * 100) / 100
const r2 = (v: number): number => Math.round(v * 100) / 100
const flag = (v: string | undefined): boolean => v === '1' || v === 'true' || v === 'on'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const cssFace = (name: string): string => (/[^A-Za-z0-9-]/.test(name) ? `'${name}'` : name)
const fontStack = (face: string): string => {
  const sub = METRIC_SUBSTITUTES[face]
  return sub ? `${cssFace(face)}, ${cssFace(sub)}, sans-serif` : `${cssFace(face)}, sans-serif`
}

/** PowerPoint's default table style — Medium Style 2, Accent 1 (also the
 *  python-pptx default). */
export const MEDIUM_STYLE_2_ACCENT_1 = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'

// ---- PowerPoint's built-in table styles ------------------------------------
//
// PowerPoint writes every style a deck uses into tableStyles.xml, so these
// matter for files from OTHER writers (python-pptx, generators, converters),
// which name a built-in by GUID and define nothing. Each style is generated
// here as the a:tblStyle XML PowerPoint would write, so a built-in and a
// style read from the package resolve through ONE code path.
//
// Provenance (2026-10-08): the 74 GUIDs and their gallery order are the GUID
// table in Microsoft PowerPoint for Mac 16's binary; the layer structure of
// each family is its preset list's base definition (embedded in the same
// binary as a tblStyleLst; the base uses dk1/tx1 where the accent variants
// use accentN). That list carries the ACCENT form only for Themed Style 1/2,
// Medium Style 3 and Dark Style 1 (each Accent 1), which pins where the
// accent goes in those families. Elsewhere the accent variants substitute
// accentN for the base's role colour in rules and fills, keeping the text
// colours — how PowerPoint-written tableStyles.xml files show them, from
// memory, not checked against the binary. Least certain: Dark Style 2's
// accent pairs (body accent A, header accent B; the total row's double rule
// kept dk1). The corner-cell layers (nwCell, …) are left out: only ever a
// border tweak, and styleLook does not read them.

type Edge = 'left' | 'right' | 'top' | 'bottom' | 'insideH' | 'insideV'
type Edges = Partial<Record<Edge, string>>
const EDGES: Edge[] = ['left', 'right', 'top', 'bottom', 'insideH', 'insideV']
/** A scheme colour, optionally with one modifier in percent. */
const sc = (v: string, mod?: 'tint' | 'shade' | 'alpha', pct = 100): string =>
  mod ? `<a:schemeClr val="${v}"><a:${mod} val="${pct * 1000}"/></a:schemeClr>` : `<a:schemeClr val="${v}"/>`
const ln = (w: number, clr: string, cmpd = 'sng'): string =>
  `<a:ln w="${w}" cmpd="${cmpd}"><a:solidFill>${clr}</a:solidFill></a:ln>`
const lnRef = (idx: number, clr: string): string => `<a:lnRef idx="${idx}">${clr}</a:lnRef>`
const NO_LN = '<a:ln><a:noFill/></a:ln>'
const all = (x: string): Edges => Object.fromEntries(EDGES.map((e) => [e, x]))
const fill = (clr: string): string => `<a:fill><a:solidFill>${clr}</a:solidFill></a:fill>`
const NO_FILL = '<a:fill><a:noFill/></a:fill>'
/** One style layer: optional ink/bold, borders, fill (an a:fill or a:fillRef). */
const layer = (name: string, o: { ink?: string; b?: boolean; bdr?: Edges; fill?: string } = {}): string => {
  const b = o.b ? ' b="on"' : ''
  const tx = o.ink ? `<a:tcTxStyle${b}><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef>${o.ink}</a:tcTxStyle>`
    : o.b ? '<a:tcTxStyle b="on"/>' : ''
  const bdr = EDGES.map((e) => (o.bdr?.[e] ? `<a:${e}>${o.bdr[e]}</a:${e}>` : '')).join('')
  return `<a:${name}>${tx}<a:tcStyle><a:tcBdr>${bdr}</a:tcBdr>${o.fill ?? ''}</a:tcStyle></a:${name}>`
}
const bold = (name: string, o: { ink?: string; bdr?: Edges; fill?: string } = {}): string => layer(name, { ...o, b: true })
const TX1 = sc('tx1')
const DK1 = sc('dk1')
const LT1 = sc('lt1')

/**
 * One gallery row. `ids` in gallery order: with `base`, the plain style (its
 * role colour `base`) then Accent 1–6; `accents`, Accent 1–6 only; `pairs`,
 * the plain style then Accent 1/2, 3/4, 5/6; none of these, one style.
 * `make(a, b, plain)` builds the layers for role colour `a` (and `b`, the
 * pair's second accent).
 */
interface Family {
  name: string
  ids: string
  base?: string
  accents?: true
  pairs?: true
  make: (a: string, b: string, plain: boolean) => string
}

const FAMILIES: Family[] = [
  { name: 'No Style, No Grid', ids: '2D5ABB26-0587-4C30-8999-92F81FD0307C',
    make: () => layer('wholeTbl', { ink: TX1, bdr: all(NO_LN), fill: NO_FILL }) },
  { name: 'Themed Style 1', accents: true,
    ids: '3C2FFA5D-87B4-456A-9821-1D502468CF0F 284E427A-3D55-4303-BF80-6455036E1DE7 69C7853C-536D-4A76-A0AE-DD22124D55A5 ' +
      '775DCB02-9BB8-47FD-8907-85C794F793BA 35758FB7-9AC5-4552-8A53-C91805E547FA 08FB837D-C827-4EFA-A057-4D05807E0F7C',
    make: (a) => {
      const r1 = lnRef(1, sc(a))
      const r2 = lnRef(2, sc(a))
      const band = fill(sc(a, 'alpha', 40))
      return `<a:tblBg><a:fillRef idx="2">${sc(a)}</a:fillRef><a:effectRef idx="1">${sc(a)}</a:effectRef></a:tblBg>` +
        layer('wholeTbl', { ink: DK1, bdr: all(r1), fill: NO_FILL }) +
        layer('band1H', { fill: band }) + layer('band1V', { bdr: { top: r1, bottom: r1 }, fill: band }) +
        bold('lastCol', { bdr: { left: r2, right: r1, top: r1, bottom: r1, insideH: r1, insideV: NO_LN } }) +
        bold('firstCol', { bdr: { left: r1, right: r2, top: r1, bottom: r1, insideH: r1, insideV: NO_LN } }) +
        bold('lastRow', { bdr: { left: r1, right: r1, top: r2, bottom: r2, insideH: NO_LN, insideV: NO_LN }, fill: NO_FILL }) +
        bold('firstRow', { ink: LT1, bdr: { left: r1, right: r1, top: r1, bottom: lnRef(2, LT1), insideH: NO_LN, insideV: NO_LN }, fill: fill(sc(a)) })
    } },
  { name: 'No Style, Table Grid', ids: '5940675A-B579-460E-94D1-54222C63F5DA',
    make: () => layer('wholeTbl', { ink: TX1, bdr: all(ln(12700, TX1)), fill: NO_FILL }) },
  { name: 'Themed Style 2', accents: true,
    ids: 'D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7 18603FDC-E32A-4AB5-989C-0864C3EAD2B8 306799F8-075E-4A3A-A7F6-7FBC6576F1A4 ' +
      'E269D01E-BC32-4049-B463-5C60D7B0CCD2 327F97BB-C833-4FB7-BDE5-3F7075034690 638B1855-1B75-4FBE-930C-398BA8C253C6',
    make: (a) => {
      const edge = lnRef(1, sc(a, 'tint', 50))
      const band = fill(sc('lt1', 'alpha', 20))
      return `<a:tblBg><a:fillRef idx="3">${sc(a)}</a:fillRef><a:effectRef idx="3">${sc(a)}</a:effectRef></a:tblBg>` +
        layer('wholeTbl', { ink: LT1, bdr: { left: edge, right: edge, top: edge, bottom: edge, insideH: NO_LN, insideV: NO_LN }, fill: NO_FILL }) +
        layer('band1H', { fill: band }) + layer('band1V', { fill: band }) +
        bold('lastCol', { bdr: { left: lnRef(2, LT1) } }) + bold('firstCol', { bdr: { right: lnRef(2, LT1) } }) +
        bold('lastRow', { bdr: { top: lnRef(2, LT1) }, fill: NO_FILL }) +
        bold('firstRow', { bdr: { bottom: lnRef(3, LT1) }, fill: NO_FILL })
    } },
  { name: 'Light Style 1', base: 'tx1',
    ids: '9D7B26C5-4107-4FEC-AEDC-1716B250A1EF 3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5 0E3FDE45-AF77-4B5C-9715-49D594BDF05E ' +
      'C083E6E3-FA7D-4D7B-A595-EF9225AFEA82 D27102A9-8310-4765-A935-A1911B00CA55 5FD0F851-EC5A-4D38-B0AD-8093EC10F338 ' +
      '68D230F3-CF80-4859-8CE7-A43EE81993B5',
    make: (a) => {
      const rule = ln(12700, sc(a))
      const band = fill(sc(a, 'alpha', 20))
      return layer('wholeTbl', { ink: TX1, bdr: { ...all(NO_LN), top: rule, bottom: rule }, fill: NO_FILL }) +
        layer('band1H', { fill: band }) + layer('band1V', { fill: band }) + bold('lastCol') + bold('firstCol') +
        bold('lastRow', { bdr: { top: rule }, fill: NO_FILL }) + bold('firstRow', { bdr: { bottom: rule }, fill: NO_FILL })
    } },
  { name: 'Light Style 2', base: 'tx1',
    ids: '7E9639D4-E3E2-4D34-9284-5A2195B3D0D7 69012ECD-51FC-41F1-AA8D-1B2483CD663E 72833802-FEF1-4C79-8D5D-14CF1EAF98D9 ' +
      'F2DE63D5-997A-4646-A377-4702673A728D 17292A2E-F333-43FB-9621-5CBBE7FDCDCB 5A111915-BE36-4E01-A7E5-04B1672EAD32 ' +
      '912C8C85-51F0-491E-9774-3900AFEF0FD7',
    make: (a) => {
      const r1 = lnRef(1, sc(a))
      return layer('wholeTbl', { ink: TX1, bdr: { left: r1, right: r1, top: r1, bottom: r1, insideH: NO_LN, insideV: NO_LN }, fill: NO_FILL }) +
        layer('band1H', { bdr: { top: r1, bottom: r1 } }) +
        layer('band1V', { bdr: { left: r1, right: r1 } }) + layer('band2V', { bdr: { left: r1, right: r1 } }) +
        bold('lastCol') + bold('firstCol') + bold('lastRow', { bdr: { top: ln(50800, sc(a), 'dbl') } }) +
        bold('firstRow', { ink: sc('bg1'), fill: `<a:fillRef idx="1">${sc(a)}</a:fillRef>` })
    } },
  { name: 'Light Style 3', base: 'tx1',
    ids: '616DA210-FB5B-4158-B5E0-FEB733F419BA BC89EF96-8CEA-46FF-86C4-4CE0E7609802 5DA37D80-6434-44D0-A028-1B22A696006F ' +
      '8799B23B-EC83-4686-B30A-512413B5E67A ED083AE6-46FA-4A59-8FB0-9F97EB10719F BDBED569-4797-4DF1-A0F4-6AAB3CD982D8 ' +
      'E8B1032C-EA38-4F05-BA0D-38AFFFC7BED3',
    make: (a) => {
      const band = fill(sc(a, 'alpha', 20))
      return layer('wholeTbl', { ink: TX1, bdr: all(ln(12700, sc(a))), fill: NO_FILL }) +
        layer('band1H', { fill: band }) + layer('band1V', { fill: band }) + bold('lastCol') + bold('firstCol') +
        bold('lastRow', { bdr: { top: ln(50800, sc(a), 'dbl') }, fill: NO_FILL }) +
        bold('firstRow', { bdr: { bottom: ln(25400, sc(a)) }, fill: NO_FILL })
    } },
  { name: 'Medium Style 1', base: 'dk1',
    ids: '793D81CF-94F2-401A-BA57-92F5A7B2D0C5 B301B821-A1FF-4177-AEE7-76D212191A09 9DCAF9ED-07DC-4A11-8D7F-57B35C25682E ' +
      '1FECB4D8-DB02-4DC6-A0A2-4F2EBAE1DC90 1E171933-4619-4E11-9A3F-F7608DF75F80 FABFCF23-3B69-468F-B69F-88F6DE6A72F2 ' +
      '10A1B5D5-9B99-4C35-A422-299274C87663',
    make: (a) => {
      const rule = ln(12700, sc(a))
      const band = fill(sc(a, 'tint', 20))
      return layer('wholeTbl', { ink: DK1, bdr: { ...all(rule), insideV: NO_LN }, fill: fill(LT1) }) +
        layer('band1H', { fill: band }) + layer('band1V', { fill: band }) + bold('lastCol') + bold('firstCol') +
        bold('lastRow', { bdr: { top: ln(50800, sc(a), 'dbl') }, fill: fill(LT1) }) +
        bold('firstRow', { ink: LT1, fill: fill(sc(a)) })
    } },
  { name: 'Medium Style 2', base: 'dk1',
    ids: '073A0DAA-6AF3-43AB-8588-CEC1D06C72B9 5C22544A-7EE6-4342-B048-85BDC9FD1C3A 21E4AEA4-8DFA-4A89-87EB-49C32662AFE0 ' +
      'F5AB1C69-6EDB-4FF4-983F-18BD219EF322 00A15C55-8517-42AA-B614-E9B94910E393 7DF18680-E054-41AD-8BC1-D1AEF772440D ' +
      '93296810-A885-4BE3-A3E7-6D5BEEA58F35',
    make: (a) => {
      const band = fill(sc(a, 'tint', 40))
      const solid = fill(sc(a))
      return layer('wholeTbl', { ink: DK1, bdr: all(ln(12700, LT1)), fill: fill(sc(a, 'tint', 20)) }) +
        layer('band1H', { fill: band }) + layer('band2H') + layer('band1V', { fill: band }) + layer('band2V') +
        bold('lastCol', { ink: LT1, fill: solid }) + bold('firstCol', { ink: LT1, fill: solid }) +
        bold('lastRow', { ink: LT1, bdr: { top: ln(38100, LT1) }, fill: solid }) +
        bold('firstRow', { ink: LT1, bdr: { bottom: ln(38100, LT1) }, fill: solid })
    } },
  { name: 'Medium Style 3', base: 'dk1',
    ids: '8EC20E35-A176-4012-BC5E-935CFFF8708E 6E25E649-3F16-4E02-A733-19D2CDBF48F0 85BE263C-DBD7-4A20-BB59-AAB30ACAA65A ' +
      'EB344D84-9AFB-497E-A393-DC336BA19D2E EB9631B5-78F2-41C9-869B-9F39066F8104 74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6 ' +
      '2A488322-F2BA-4B5B-9748-0D474271808F',
    // the accent colours only the header and the first/last columns
    make: (a) => {
      const rule = ln(25400, DK1)
      const band = fill(sc('dk1', 'tint', 20))
      return layer('wholeTbl', { ink: DK1, bdr: { ...all(NO_LN), top: rule, bottom: rule }, fill: fill(LT1) }) +
        layer('band1H', { fill: band }) + layer('band1V', { fill: band }) +
        bold('lastCol', { ink: LT1, fill: fill(sc(a)) }) + bold('firstCol', { ink: LT1, fill: fill(sc(a)) }) +
        bold('lastRow', { bdr: { top: ln(50800, DK1, 'dbl') }, fill: fill(LT1) }) +
        bold('firstRow', { ink: LT1, bdr: { bottom: rule }, fill: fill(sc(a)) })
    } },
  { name: 'Medium Style 4', base: 'dk1',
    ids: 'D7AC3CCA-C797-4891-BE02-D94E43425B78 69CF1AB2-1976-4502-BF36-3FF5EA218861 8A107856-5554-42FB-B03E-39F5DBC370BA ' +
      '0505E3EF-67EA-436B-97B2-0124C06EBD24 C4B1156A-380E-4F78-BDF5-A606A8083BF9 22838BEF-8BB2-4498-84A7-C5851F593DF1 ' +
      '16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4',
    make: (a) => {
      const body = fill(sc(a, 'tint', 20))
      const band = fill(sc(a, 'tint', 40))
      return layer('wholeTbl', { ink: DK1, bdr: all(ln(12700, sc(a))), fill: body }) +
        layer('band1H', { fill: band }) + layer('band1V', { fill: band }) + bold('lastCol') + bold('firstCol') +
        bold('lastRow', { bdr: { top: ln(25400, sc(a)) }, fill: body }) + bold('firstRow', { fill: body })
    } },
  { name: 'Dark Style 1', base: 'dk1',
    ids: 'E8034E78-7F5D-4C2E-B375-FC64B27BC917 125E5076-3810-47DD-B79F-674D7AD40C01 37CE84F3-28C3-443E-9E96-99CF82512B78 ' +
      'D03447BB-5D67-496B-8E87-E561075AD55C E929F9F4-4A8F-4326-A1B4-22849713DDAB 8FD4443E-F989-4FC4-A0C8-D5A2AF1F390B ' +
      'AF606853-7671-496A-8E4F-DF71F8EC918B',
    // the plain style tints dk1; an accent variant is the accent itself, shaded
    make: (a, _b, plain) => {
      const band = fill(plain ? sc('dk1', 'tint', 40) : sc(a, 'shade', 60))
      const side = fill(plain ? sc('dk1', 'tint', 60) : sc(a, 'shade', 60))
      const rule = ln(25400, LT1)
      return layer('wholeTbl', { ink: LT1, bdr: all(NO_LN), fill: fill(plain ? sc('dk1', 'tint', 20) : sc(a)) }) +
        layer('band1H', { fill: band }) + layer('band1V', { fill: band }) +
        bold('lastCol', { bdr: { left: rule }, fill: side }) + bold('firstCol', { bdr: { right: rule }, fill: side }) +
        bold('lastRow', { bdr: { top: rule }, fill: fill(plain ? sc('dk1', 'tint', 60) : sc(a, 'shade', 40)) }) +
        bold('firstRow', { bdr: { bottom: rule }, fill: fill(DK1) })
    } },
  { name: 'Dark Style 2', base: 'dk1', pairs: true,
    ids: '5202B0CA-FC54-4496-8BCA-5EF66A818D29 0660B408-B3CF-4A94-85FC-2B1E0A45F4A2 91EBBBCC-DAD2-459C-BE2E-F6DE35CF9A28 ' +
      '46F890A9-2807-4EBB-B81D-B2AA78EC7F39',
    make: (a, b) => {
      const body = fill(sc(a, 'tint', 20))
      const band = fill(sc(a, 'tint', 40))
      return layer('wholeTbl', { ink: DK1, bdr: all(NO_LN), fill: body }) +
        layer('band1H', { fill: band }) + layer('band1V', { fill: band }) + bold('lastCol') + bold('firstCol') +
        bold('lastRow', { bdr: { top: ln(50800, DK1, 'dbl') }, fill: body }) +
        bold('firstRow', { ink: LT1, fill: fill(sc(b)) })
    } },
]

/** GUID (upper case, braced) → its family and gallery index. */
let builtinIndex: Map<string, [Family, number]> | undefined
const builtinCache = new Map<string, XElem>()

/** The a:tblStyle XML of built-in style `id` (upper-case, braced), or
 *  undefined for a GUID PowerPoint does not ship. Exported for the rig. */
export function builtinStyleXml(id: string): string | undefined {
  if (!builtinIndex) {
    builtinIndex = new Map()
    for (const f of FAMILIES) f.ids.split(' ').forEach((g, i) => builtinIndex!.set(`{${g}}`, [f, i]))
  }
  const hit = builtinIndex.get(id)
  if (!hit) return undefined
  const [f, i] = hit
  let a = f.base ?? 'tx1'
  let b = a
  let name = f.name
  if (f.accents) { a = b = `accent${i + 1}`; name += ` - Accent ${i + 1}` }
  else if (f.pairs && i > 0) { a = `accent${2 * i - 1}`; b = `accent${2 * i}`; name += ` - Accent ${2 * i - 1}/Accent ${2 * i}` }
  else if (i > 0) { a = b = `accent${i}`; name += ` - Accent ${i}` }
  const plain = !f.accents && i === 0
  return `<a:tblStyle xmlns:a="${NS.a}" styleId="${id}" styleName="${name}">${f.make(a, b, plain)}</a:tblStyle>`
}

/** Every built-in style GUID, in PowerPoint's gallery order (for the rig). */
export function builtinStyleIds(): string[] {
  return FAMILIES.flatMap((f) => f.ids.split(' ').map((g) => `{${g}}`))
}

function builtinStyle(id: string): XElem | undefined {
  let el = builtinCache.get(id)
  if (el) return el
  const src = builtinStyleXml(id)
  if (!src) return undefined
  el = parseXml(src)
  builtinCache.set(id, el)
  return el
}

/** The package's table styles: ppt/tableStyles.xml's a:tblStyle by styleId,
 *  plus its `def` (the style a table with no tableStyleId gets). */
export interface TableStyles {
  byId: Map<string, XElem>
  def?: string
}

export function parseTableStyles(root: XElem | undefined): TableStyles {
  const byId = new Map<string, XElem>()
  if (!root) return { byId }
  for (const s of kids(root, NS.a, 'tblStyle')) {
    const id = attr(s, 'styleId')
    if (id) byId.set(id.toUpperCase(), s)
  }
  const def = attr(root, 'def')
  return def ? { byId, def: def.toUpperCase() } : { byId }
}

/** A line as the table model can hold it: colour + px width, or none. */
interface Line { color: string; width: number }

/** css colour → [r,g,b,a] (#RRGGBB or rgba(r,g,b,a), the two forms
 *  resolveColor emits). */
function rgbaOf(css: string): [number, number, number, number] | undefined {
  const h = /^#([0-9a-f]{6})$/i.exec(css)
  if (h) {
    const n = parseInt(h[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(css)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : undefined
}
const hex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0').toUpperCase()).join('')

/** A style reference's colour as the opaque '#RRGGBB' phClr the theme's
 *  style matrix substitutes (shapes.ts's phClrOf, minus its report: a table
 *  style's ref colours are PowerPoint's own and carry no alpha). */
function phClrOf(ref: XElem, ctx: InheritCtx): string | undefined {
  const c = resolveColor(ref, ctx.theme)
  const v = c ? rgbaOf(c.css) : undefined
  return v ? hex(v[0], v[1], v[2]) : undefined
}

/** A gradient flattened to the mean of its stops — the table model has no
 *  gradient fills; the average reads closest to the whole cell. */
function flatGradient(grad: XElem, ctx: InheritCtx, phClr?: string): string | undefined {
  const lst = kid(grad, NS.a, 'gsLst')
  const stops = (lst ? kids(lst, NS.a, 'gs') : [])
    .map((gs) => resolveColor(gs, ctx.theme, phClr)?.css)
    .map((c) => (c ? rgbaOf(c) : undefined))
    .filter((v): v is [number, number, number, number] => !!v)
  if (!stops.length) return undefined
  const mean = (i: number): number => stops.reduce((a, v) => a + v[i], 0) / stops.length
  return hex(mean(0), mean(1), mean(2))
}

/** Set when a fill had to be flattened (gradient → one colour); the table
 *  reports it once. */
interface Flags { flattened: boolean }

/** One a:ln (or a cell's a:lnL/lnR/…) → a visible Line, null for an explicit
 *  noFill/zero width, undefined when it says nothing about visibility. */
function lineOf(ln: XElem | undefined, ctx: InheritCtx): Line | null | undefined {
  if (!ln) return undefined
  if (kid(ln, NS.a, 'noFill')) return null
  const fill = kid(ln, NS.a, 'solidFill')
  const c = fill ? resolveColor(fill, ctx.theme) : undefined
  if (!c) return undefined
  const w = intAttr(ln, 'w', 12700)
  return w > 0 ? { color: c.css, width: r2(w / EMU_PER_PX) } : null
}

/** A table style's border edge (a:left, a:insideH, …): its own a:ln, or an
 *  a:lnRef into the theme's line styles (CT_ThemeableLineStyle allows
 *  either — the Themed and several Light styles use lnRef throughout). */
function edgeLine(edge: XElem, ctx: InheritCtx): Line | null | undefined {
  const ln = kid(edge, NS.a, 'ln')
  if (ln) return lineOf(ln, ctx)
  const ref = kid(edge, NS.a, 'lnRef')
  if (!ref) return undefined
  const ph = phClrOf(ref, ctx)
  if (!ph) return undefined
  const got = resolveLnRef(intAttr(ref, 'idx', 0), ph, ctx.theme)
  if (!got) return undefined
  if (got.kind === 'none' || kid(got.ln, NS.a, 'noFill')) return null
  const w = intAttr(got.ln, 'w', 9525)
  // a gradient theme line keeps the reference colour
  return w > 0 ? { color: got.color?.css ?? ph, width: r2(w / EMU_PER_PX) } : null
}

/** A fill holder (tcPr, a:fill, tblPr) → css colour, 'none' for noFill,
 *  undefined when silent. A gradient is flattened (and flagged). */
function fillOf(holder: XElem | undefined, ctx: InheritCtx, flags?: Flags): string | undefined {
  if (!holder) return undefined
  if (kid(holder, NS.a, 'noFill')) return 'none'
  const solid = kid(holder, NS.a, 'solidFill')
  if (solid) return resolveColor(solid, ctx.theme)?.css
  const grad = kid(holder, NS.a, 'gradFill')
  const flat = grad ? flatGradient(grad, ctx) : undefined
  if (flat && flags) flags.flattened = true
  return flat
}

/** a:fillRef → the theme fill style it names, painted in the ref's colour
 *  (idx 0 = none). A gradient style is flattened (and flagged); a style the
 *  theme lacks falls back to the ref's colour as a solid fill. */
function fillRefOf(ref: XElem, ctx: InheritCtx, flags: Flags): string | undefined {
  const ph = phClrOf(ref, ctx)
  if (!ph) return undefined
  const got = resolveFillRef(intAttr(ref, 'idx', 1), ph, ctx.theme)
  if (!got) return ph
  if (got.kind === 'none') return 'none'
  if (got.kind === 'solid') return got.color.css
  const flat = got.el.local === 'gradFill' ? flatGradient(got.el, ctx, got.phClr) : undefined
  flags.flattened = true
  return flat ?? ph
}

/** A style layer's / tblBg's fill: an a:fill wrapper or an a:fillRef
 *  (CT_TableStyleCellStyle and CT_TableBackgroundStyle allow either). */
function styleFill(holder: XElem, ctx: InheritCtx, flags: Flags): string | undefined {
  const fill = kid(holder, NS.a, 'fill')
  if (fill) return fillOf(fill, ctx, flags)
  const ref = kid(holder, NS.a, 'fillRef')
  return ref ? fillRefOf(ref, ctx, flags) : undefined
}

/** `top` painted over an opaque `base` → one opaque colour; anything else
 *  (no base, an opaque top, unparseable) → `top` as it is. */
function over(top: string, base: string | undefined): string {
  const t = rgbaOf(top)
  const b = base ? rgbaOf(base) : undefined
  if (!t || t[3] >= 1 || !b || b[3] < 1) return top
  const a = t[3]
  return hex(t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a))
}

/** Effective look of one cell after the style's layers. */
interface CellLook { fill: string; color?: string; bold: boolean; italic: boolean; lines: Line[]; noLine: boolean }

const LAYERS = ['wholeTbl', 'band1V', 'band2V', 'band1H', 'band2H', 'lastCol', 'firstCol', 'lastRow', 'firstRow'] as const

function layersFor(
  r: number, c: number, nR: number, nC: number,
  f: { firstRow: boolean; lastRow: boolean; firstCol: boolean; lastCol: boolean; bandRow: boolean; bandCol: boolean },
): Set<string> {
  const on = new Set<string>(['wholeTbl'])
  const isFR = f.firstRow && r === 0
  const isLR = f.lastRow && r === nR - 1
  const isFC = f.firstCol && c === 0
  const isLC = f.lastCol && c === nC - 1
  // bands count only the body: header/total rows (and first/last columns)
  // are not banded, so the first BODY row is band1
  if (f.bandRow && !isFR && !isLR) on.add(((r - (f.firstRow ? 1 : 0)) % 2 === 0) ? 'band1H' : 'band2H')
  if (f.bandCol && !isFC && !isLC) on.add(((c - (f.firstCol ? 1 : 0)) % 2 === 0) ? 'band1V' : 'band2V')
  if (isLC) on.add('lastCol')
  if (isFC) on.add('firstCol')
  if (isLR) on.add('lastRow')
  if (isFR) on.add('firstRow')
  return on
}

function styleLook(style: XElem | undefined, on: Set<string>, ctx: InheritCtx, flags: Flags): CellLook {
  const look: CellLook = { fill: 'none', bold: false, italic: false, lines: [], noLine: false }
  if (!style) return look
  for (const name of LAYERS) {
    if (!on.has(name)) continue
    const layer = kid(style, NS.a, name)
    if (!layer) continue
    const tx = kid(layer, NS.a, 'tcTxStyle')
    if (tx) {
      const b = attr(tx, 'b')
      if (b !== undefined) look.bold = b === 'on'
      const i = attr(tx, 'i')
      if (i !== undefined) look.italic = i === 'on'
      const ink = resolveColor(tx, ctx.theme)
      if (ink) look.color = ink.css
    }
    const tc = kid(layer, NS.a, 'tcStyle')
    if (!tc) continue
    const fill = styleFill(tc, ctx, flags)
    if (fill !== undefined) look.fill = fill
    const bdr = kid(tc, NS.a, 'tcBdr')
    for (const edge of bdr ? kids(bdr, NS.a) : []) {
      const l = edgeLine(edge, ctx)
      if (l) look.lines.push(l)
      else if (l === null) look.noLine = true
    }
  }
  return look
}

/** Most common value (first seen wins ties) — undefined for an empty list. */
function mode<T>(vals: T[], key: (v: T) => string = String): T | undefined {
  const counts = new Map<string, { v: T; n: number }>()
  let best: { v: T; n: number } | undefined
  for (const v of vals) {
    const k = key(v)
    const e = counts.get(k) ?? { v, n: 0 }
    e.n++
    counts.set(k, e)
    if (!best || e.n > best.n) best = e
  }
  return best?.v
}

interface RunInfo { chars: number; sizePt?: number; face?: string; color?: string; bold: boolean }

/** One cell's txBody → html (paragraphs joined by <br>, b/i/u/s as markup)
 *  plus its runs, for the table-wide dominance pass. `styleBold` is the
 *  layered tcTxStyle bold: a run inherits it unless it says otherwise. */
function cellText(
  tc: XElem, ctx: InheritCtx, styleBold: boolean, styleItalic: boolean,
): { html: string; runs: RunInfo[]; align?: 'left' | 'center' | 'right' } {
  const tb = kid(tc, NS.a, 'txBody')
  const runs: RunInfo[] = []
  const lines: string[] = []
  let align: 'left' | 'center' | 'right' | undefined
  const piece: Array<{ html: string; bold: boolean; chars: number }> = []
  for (const p of tb ? kids(tb, NS.a, 'p') : []) {
    const pPr = kid(p, NS.a, 'pPr')
    const algn = pPr ? attr(pPr, 'algn') : undefined
    if (align === undefined && algn !== undefined) {
      align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left'
    }
    let line = ''
    for (const c of kids(p, NS.a)) {
      if (c.local === 'br') { line += '<br>'; continue }
      if (c.local !== 'r' && c.local !== 'fld') continue
      const t = kid(c, NS.a, 't')
      const text = t ? textOf(t) : ''
      if (!text) continue
      const rPr = kid(c, NS.a, 'rPr')
      const bAttr = rPr ? attr(rPr, 'b') : undefined
      const bold = bAttr !== undefined ? flag(bAttr) : styleBold
      const iAttr = rPr ? attr(rPr, 'i') : undefined
      const italic = iAttr !== undefined ? flag(iAttr) : styleItalic
      const u = rPr ? attr(rPr, 'u') : undefined
      const st = rPr ? attr(rPr, 'strike') : undefined
      const sz = rPr ? attr(rPr, 'sz') : undefined
      const latin = rPr ? kid(rPr, NS.a, 'latin') : undefined
      const fill = rPr ? kid(rPr, NS.a, 'solidFill') : undefined
      runs.push({
        chars: text.length,
        sizePt: sz !== undefined && Number.isFinite(parseInt(sz, 10)) ? parseInt(sz, 10) / 100 : undefined,
        face: latin ? attr(latin, 'typeface') : undefined,
        color: fill ? resolveColor(fill, ctx.theme)?.css : undefined,
        bold,
      })
      let h = esc(text)
      if (st !== undefined && st !== 'noStrike') h = `<s>${h}</s>`
      if (u !== undefined && u !== 'none') h = `<u>${h}</u>`
      if (italic) h = `<i>${h}</i>`
      piece.push({ html: h, bold, chars: text.length })
      line += `\u0000${piece.length - 1}\u0000`
    }
    lines.push(line)
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  // a cell whose every run is bold says so with cell.bold (one flag the
  // table panel can toggle), not with <b> around everything
  const allBold = piece.length > 0 && piece.every((x) => x.bold)
  const html = lines.join('<br>').replace(/\u0000(\d+)\u0000/g, (_m, i: string) => {
    const x = piece[Number(i)]
    return x.bold && !allBold ? `<b>${x.html}</b>` : x.html
  })
  return { html, runs, align }
}

/** One row's a:tc elements by grid column. PowerPoint writes a continuation
 *  a:tc (hMerge) for every column a gridSpan covers, so a conforming row maps
 *  index for index; a writer that leaves continuations out still gets its
 *  cells in the right columns (the left-out positions stay undefined). */
function placeCells(tcs: XElem[], nC: number): Array<XElem | undefined> {
  const out: Array<XElem | undefined> = []
  let i = 0
  while (out.length < nC && i < tcs.length) {
    const tc = tcs[i++]
    out.push(tc)
    const span = flag(attr(tc, 'hMerge')) ? 1 : intAttr(tc, 'gridSpan', 1)
    for (let k = 1; k < span && out.length < nC; k++) {
      if (i < tcs.length && flag(attr(tcs[i], 'hMerge'))) out.push(tcs[i++])
      else out.push(undefined)
    }
  }
  while (out.length < nC) out.push(undefined)
  return out
}

/** Whether a covered a:tc holds text PowerPoint does not show either. */
const hasText = (tc: XElem | undefined): boolean =>
  !!tc && descendants(tc, NS.a, 't').some((t) => textOf(t).trim() !== '')

/** What a table style's background effect would draw — the effect list's
 *  entries and any 3-D — or undefined when it draws nothing (an a:effectRef
 *  idx 0, or into a theme effect style that is empty or missing). */
function bgEffect(bg: XElem | undefined, ctx: InheritCtx): string | undefined {
  if (!bg) return undefined
  let src = kid(bg, NS.a, 'effect')
  const ref = kid(bg, NS.a, 'effectRef')
  if (!src && ref) {
    const idx = intAttr(ref, 'idx', 0)
    src = idx > 0 ? ctx.theme.effectStyles?.[idx - 1] : undefined
  }
  if (!src) return undefined
  const lst = kid(src, NS.a, 'effectLst') ?? kid(src, NS.a, 'effectDag')
  const names = [...(lst ? kids(lst, NS.a) : []), ...kids(src, NS.a, 'scene3d'), ...kids(src, NS.a, 'sp3d')]
    .map((e) => e.local)
  return names.length ? [...new Set(names)].join(', ') : undefined
}

export interface TableFrame { x: number; y: number; w: number; h: number; rotation: number }

/**
 * Convert one a:tbl. Returns undefined (and reports nothing — the caller's
 * placeholder path does) for a table with no grid or no rows.
 */
export function tableFrom(
  tbl: XElem, frame: TableFrame, ctx: InheritCtx, styles: TableStyles, where: string,
): OutTable | undefined {
  const grid = kid(tbl, NS.a, 'tblGrid')
  const gridCols = grid ? kids(grid, NS.a, 'gridCol') : []
  const trs = kids(tbl, NS.a, 'tr')
  if (!gridCols.length || !trs.length) return undefined
  const nC = gridCols.length
  const nR = trs.length

  const tblPr = kid(tbl, NS.a, 'tblPr')
  const f = {
    firstRow: !!tblPr && flag(attr(tblPr, 'firstRow')),
    lastRow: !!tblPr && flag(attr(tblPr, 'lastRow')),
    firstCol: !!tblPr && flag(attr(tblPr, 'firstCol')),
    lastCol: !!tblPr && flag(attr(tblPr, 'lastCol')),
    bandRow: !!tblPr && flag(attr(tblPr, 'bandRow')),
    bandCol: !!tblPr && flag(attr(tblPr, 'bandCol')),
  }

  // ---- the table style: tableStyles.xml first, then the built-in, else plain
  const idEl = tblPr ? kid(tblPr, NS.a, 'tableStyleId') : undefined
  const wantId = (idEl ? textOf(idEl).trim() : '').toUpperCase() || styles.def
  let style: XElem | undefined
  if (tblPr && kid(tblPr, NS.a, 'tableStyle')) style = kid(tblPr, NS.a, 'tableStyle')
  else if (wantId) {
    style = styles.byId.get(wantId) ?? builtinStyle(wantId)
    if (!style) {
      ctx.report.add('approximated', 'table-style-unknown', where,
        `table style ${wantId} is neither defined in the package nor built in — imported as a plain table (cell-level fills and borders still carried)`)
    }
  }
  // the table's background — its own tblPr fill, else the style's a:tblBg —
  // shows wherever the layered cell fill is none, and under a translucent one
  const flags: Flags = { flattened: false }
  const bgEl = style ? kid(style, NS.a, 'tblBg') : undefined
  const tblFill = fillOf(tblPr, ctx, flags) ?? (bgEl ? styleFill(bgEl, ctx, flags) : undefined)
  const base = tblFill !== undefined && tblFill !== 'none' ? tblFill : undefined
  const effect = bgEffect(bgEl, ctx)
  if (effect) {
    ctx.report.add('dropped', 'table-effect-dropped', where,
      `the table style's background effect (${effect}) is not drawn — slidomingo tables have no shadow, glow or bevel`)
  }

  // ---- merged cells: the origin a:tc carries gridSpan/rowSpan, every cell it
  // covers stays in the grid (hMerge/vMerge) — slidomingo's model exactly
  // (slides/src/tablespans.ts). Spans are read in reading order, clamped to
  // the grid and shrunk off any position an earlier origin took, as
  // tableLayout reads them, so what is emitted is already normalised.
  const tcGrid = trs.map((tr) => placeCells(kids(tr, NS.a, 'tc'), nC))
  const covered: boolean[][] = tcGrid.map(() => new Array<boolean>(nC).fill(false))
  const spans: Array<Array<{ rs: number; cs: number } | undefined>> = tcGrid.map(() => new Array(nC).fill(undefined))
  let clamped = false
  let hiddenText = false
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      if (covered[r][c]) continue
      const tc = tcGrid[r][c]
      // a continuation no origin reaches is an ordinary (empty) cell
      const origin = !!tc && !flag(attr(tc, 'hMerge')) && !flag(attr(tc, 'vMerge'))
      const wantCs = origin ? Math.max(1, intAttr(tc, 'gridSpan', 1)) : 1
      const wantRs = origin ? Math.max(1, intAttr(tc, 'rowSpan', 1)) : 1
      let cs = 1
      while (cs < Math.min(wantCs, nC - c) && !covered[r][c + cs]) cs++
      let rs = 1
      while (rs < Math.min(wantRs, nR - r) && covered[r + rs].slice(c, c + cs).every((x) => !x)) rs++
      if (cs < wantCs || rs < wantRs) clamped = true
      if (cs > 1 || rs > 1) {
        spans[r][c] = { rs, cs }
        for (let i = r; i < r + rs; i++) {
          for (let j = c; j < c + cs; j++) {
            if (i === r && j === c) continue
            covered[i][j] = true
            if (hasText(tcGrid[i][j])) hiddenText = true
          }
        }
      }
    }
  }

  // ---- every cell's effective look
  interface Cell { html: string; align?: 'left' | 'center' | 'right'; fill: string; color: string; bold: boolean; runs: RunInfo[]; covered?: true }
  const cells: Cell[][] = []
  const lines: Line[] = []
  let noLine = false
  let marX: number | undefined
  let marY: number | undefined
  const tx1 = ctx.theme.scheme['tx1'] ?? '#000000'

  for (let r = 0; r < nR; r++) {
    const row: Cell[] = []
    for (let c = 0; c < nC; c++) {
      // a covered cell is not drawn: it adds nothing to the table-wide
      // choices (its fill and borders are the origin's, PowerPoint's way)
      if (covered[r][c]) { row.push({ html: '', fill: 'none', color: tx1, bold: false, runs: [], covered: true }); continue }
      const tc = tcGrid[r][c]
      const look = styleLook(style, layersFor(r, c, nR, nC, f), ctx, flags)
      look.fill = look.fill === 'none' ? base ?? 'none' : over(look.fill, base)
      if (!tc) { row.push({ html: '', fill: look.fill, color: look.color ?? tx1, bold: look.bold, runs: [] }); continue }
      const tcPr = kid(tc, NS.a, 'tcPr')
      const continuation = flag(attr(tc, 'hMerge')) || flag(attr(tc, 'vMerge'))

      let fill = look.fill
      const own = fillOf(tcPr, ctx, flags)
      if (own !== undefined) fill = own === 'none' ? base ?? 'none' : over(own, base)

      if (tcPr) {
        for (const e of ['lnL', 'lnR', 'lnT', 'lnB'] as const) {
          const l = lineOf(kid(tcPr, NS.a, e), ctx)
          if (l) lines.push(l)
          else if (l === null) noLine = true
        }
        if (marX === undefined && attr(tcPr, 'marL') !== undefined) marX = intAttr(tcPr, 'marL', 91440)
        if (marY === undefined && attr(tcPr, 'marT') !== undefined) marY = intAttr(tcPr, 'marT', 45720)
      }
      lines.push(...look.lines)
      if (look.noLine) noLine = true

      const t = continuation ? { html: '', runs: [] as RunInfo[], align: undefined } : cellText(tc, ctx, look.bold, look.italic)
      const runColor = mode(t.runs.filter((x) => x.color).map((x) => x.color as string))
      row.push({
        html: t.html, align: t.align, fill,
        color: runColor ?? look.color ?? tx1,
        bold: t.runs.length > 0 ? t.runs.every((x) => x.bold) : look.bold,
        runs: t.runs,
      })
    }
    cells.push(row)
  }

  // ---- table-wide choices: the most common value per region
  const header = f.firstRow
  const shown = (row: Cell[]): Cell[] => row.filter((x) => !x.covered)
  const body = (header ? cells.slice(1) : cells).map(shown)
  const headerRow = header ? shown(cells[0]) : []
  const css = (fill: string): string => (fill === 'none' ? 'transparent' : fill)
  const headerBg = css(mode(headerRow.map((x) => x.fill)) ?? 'none')
  const headerColor = mode(headerRow.map((x) => x.color)) ?? tx1
  const odd = body.filter((_, i) => i % 2 === 1).flat().map((x) => x.fill)
  const zebraFill = mode(odd)
  const zebra = zebraFill && zebraFill !== 'none' ? zebraFill : undefined
  const color = mode(body.flat().map((x) => x.color)) ?? tx1

  const allRuns = cells.flat().flatMap((x) => x.runs)
  const dom = (pick: (x: RunInfo) => string | undefined): string | undefined => {
    const tally = new Map<string, number>()
    for (const x of allRuns) { const v = pick(x); if (v !== undefined) tally.set(v, (tally.get(v) ?? 0) + x.chars) }
    let best: string | undefined
    let n = -1
    for (const [k, v] of tally) if (v > n) { best = k; n = v }
    return best
  }
  const sizePt = Number(dom((x) => (x.sizePt !== undefined ? String(x.sizePt) : undefined)) ?? 18)
  const faceRaw = dom((x) => x.face) ?? '+mn-lt'
  const face = faceRaw === '+mj-lt' ? ctx.theme.majorFont : faceRaw === '+mn-lt' ? ctx.theme.minorFont : faceRaw
  if (allRuns.some((x) => (x.sizePt !== undefined && x.sizePt !== sizePt) || (x.face !== undefined && x.face !== faceRaw))) {
    ctx.report.add('approximated', 'table-text-flattened', where,
      'cells disagree on text size/face; the table carries the dominant run’s (by character count) for every cell')
  }

  const border = mode(lines, (l) => `${l.color}|${l.width}`)
  if (border && (noLine || lines.some((l) => l.color !== border.color || l.width !== border.width))) {
    ctx.report.add('approximated', 'table-borders-unified', where,
      'per-edge cell borders differ; the table carries its most common border on every cell edge')
  }
  if (flags.flattened) {
    ctx.report.add('approximated', 'table-fill-flattened', where,
      'a gradient fill (often the theme’s, through a themed table style) is drawn as one solid colour — the mean of its stops')
  }
  if (clamped) {
    ctx.report.add('approximated', 'table-span-clamped', where,
      'a merged cell reaches past the grid or into another merged cell; it is cut back to the free cells it can cover')
  }
  if (hiddenText) {
    ctx.report.add('dropped', 'table-merge-hidden-text', where,
      'cells covered by a merged cell hold text PowerPoint does not show either; it is left out')
  }
  const heights = trs.map((tr) => intAttr(tr, 'h', 0))
  if (Math.max(...heights) - Math.min(...heights) > EMU_PER_PX) {
    ctx.report.add('approximated', 'table-row-heights-approximated', where,
      'rows have different fixed heights; slidomingo shares the table’s height between rows by content')
  }

  // ---- cells: overrides only where the renderer's default would differ
  const rows: OutTable['rows'] = cells.map((row, r) => ({
    cells: row.map((x, c) => {
      if (x.covered) return { html: '' }
      const isHeader = header && r === 0
      const bodyIndex = header ? r - 1 : r
      const expectBg = isHeader ? headerBg : zebra && bodyIndex % 2 === 1 ? zebra : 'transparent'
      const expectInk = isHeader ? headerColor : color
      const out: OutTableCell = { html: x.html }
      const sp = spans[r][c]
      if (sp && sp.cs > 1) out.colspan = sp.cs
      if (sp && sp.rs > 1) out.rowspan = sp.rs
      if (x.align && x.align !== 'left') out.align = x.align
      if (css(x.fill) !== expectBg) out.bg = css(x.fill)
      if (x.color !== expectInk) out.color = x.color
      // the renderer bolds the header row itself; body cells say so
      if (!isHeader && x.bold) out.bold = true
      return out
    }),
  }))

  ctx.report.add('carried', 'table-imported', where,
    'the table is a native, editable table: cell text, column widths, style fills and per-cell overrides carried')

  return {
    id: '', type: 'table',
    x: px(frame.x), y: px(frame.y), w: px(frame.w), h: px(frame.h),
    rotation: r2(frame.rotation), opacity: 1,
    columns: gridCols.map((g) => ({ w: px(intAttr(g, 'w', 0)) || 1 })),
    rows,
    header,
    style: {
      headerBg, headerColor,
      ...(zebra ? { zebra } : {}),
      borderColor: border ? border.color : 'transparent',
      borderWidth: border ? border.width : 0,
      cellPadX: px(marX ?? 91440),
      cellPadY: px(marY ?? 45720),
      fontSize: r2(sizePt * (4 / 3)),
      fontFamily: fontStack(face),
      color,
      radius: 0,
    },
  }
}

/** The `requires` name a document with merged table cells declares — the
 *  same string as slides/src/model.ts TABLE_MERGE_FEATURE. */
export const TABLE_MERGE_FEATURE = 'table-merge'

/** True when a table on any of these slides carries a span (what slides'
 *  model.usesTableMerge tests: a stored colspan/rowspan above 1). */
export function usesTableSpans(lists: Array<OutSlide[] | undefined>): boolean {
  return lists.some((list) => (list ?? []).some((s) => s.elements.some((el) =>
    el.type === 'table' && el.rows.some((row) => row.cells.some((c) => (c.colspan ?? 1) > 1 || (c.rowspan ?? 1) > 1)))))
}
