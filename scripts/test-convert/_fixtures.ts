// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert e2e fixtures — .pptx packages built IN CODE with writeZip, so
// there is not one binary file in the repo and every fixture is readable as
// source. Shared by the pptx rig (scripts/test-convert/pptx.ts, which asserts
// content + exact report sets) and the loadability gate
// (scripts/test-convert/load.ts, which asserts the emitted JSON survives the
// real slides parseDoc/validateDoc). The underscore prefix keeps the suite
// runner from executing this as a rig of its own.
//
// Every EMU number here is chosen so the expected px value is HAND-COMPUTABLE
// (multiples of 9525·N): 914400 EMU = 96px, 457200 = 48px, and so on. The
// expected values in the rigs are computed from these constants by hand, never
// by running the converter against itself.

import { writeZip, type ZipEntry } from '../../kernel/src/convert/zip.ts'

const enc = new TextEncoder()

const NSP = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NSA = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NSR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'

export const XMLNS = `xmlns:p="${NSP}" xmlns:a="${NSA}" xmlns:r="${NSR}"`

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Default Extension="svg" ContentType="image/svg+xml"/>' +
  '</Types>'

const relsXml = (entries: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${entries}</Relationships>`

const ROOT_RELS = relsXml(
  `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
  `<Relationship Id="rId2" Type="${PKG}/metadata/core-properties" Target="docProps/core.xml"/>`,
)

// --- default chain parts -----------------------------------------------------

/** dk1 #000000 · lt1 #FFFFFF · dk2 #28303A · lt2 #E7E6E6 · accent1 #4472C4;
 *  minor face Calibri (METRIC_SUBSTITUTES maps it to Carlito). */
export const DEFAULT_THEME = `<a:theme ${XMLNS} name="fixture"><a:themeElements>` +
  '<a:clrScheme name="fixture">' +
  '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="28303A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="FBAE40"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="808080"/></a:accent3><a:accent4><a:srgbClr val="FF0000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="70AD47"/></a:accent5><a:accent6><a:srgbClr val="C00000"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="fixture">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="fixture">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '</a:lnStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme>' +
  '</a:themeElements></a:theme>'

export const STANDARD_CLRMAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"' +
  ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

/** Title style 44pt — the value fixture 3 asserts through the master hop. */
export const DEFAULT_MASTER = (clrMap: string = STANDARD_CLRMAP): string =>
  `<p:sldMaster ${XMLNS}><p:cSld><p:spTree/></p:cSld>${clrMap}` +
  '<p:txStyles>' +
  '<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle/>' +
  '</p:txStyles></p:sldMaster>'

/** Title placeholder frame: off (914400, 457200) ext (1828800, 914400)
 *  → 96, 48, 192, 96 px. The slide-side ph is written BARE (`<p:ph/>`, the
 *  census reality) and pairs by idx-absent-means-0. */
export const DEFAULT_LAYOUT = `<p:sldLayout ${XMLNS}><p:cSld><p:spTree>` +
  '<p:sp><p:nvSpPr><p:cNvPr id="100" name="Title Placeholder"/><p:cNvSpPr/>' +
  '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="101" name="Body Placeholder"/><p:cNvSpPr/>' +
  '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="5486400" cy="2743200"/></a:xfrm></p:spPr></p:sp>' +
  '</p:spTree></p:cSld></p:sldLayout>'

// --- the package builder -----------------------------------------------------

export interface FixtureSlide {
  xml: string
  /** extra Relationship entries appended verbatim to the slide's .rels */
  rels?: string
  /** a notesSlide part, auto-wired via rIdNotes */
  notes?: string
}

export interface FixtureSpec {
  slides: FixtureSlide[]
  /** wire the full slide→layout→master→theme chain (default true) */
  chain?: boolean
  theme?: string
  master?: string
  layout?: string
  /** docProps/core.xml content */
  core?: string
  /** part name → bytes (strings are UTF-8 encoded) */
  media?: Record<string, string | Uint8Array>
  sldSz?: { cx: number; cy: number }
}

export async function buildPptx(spec: FixtureSpec): Promise<Uint8Array> {
  const chain = spec.chain !== false
  const entries: ZipEntry[] = []
  const put = (name: string, content: string | Uint8Array): void => {
    entries.push({ name, data: typeof content === 'string' ? enc.encode(content) : content })
  }

  // [Content_Types].xml first — OPC consumers may stream
  put('[Content_Types].xml', CONTENT_TYPES)
  put('_rels/.rels', ROOT_RELS)

  const { cx, cy } = spec.sldSz ?? { cx: 12192000, cy: 6858000 }
  const sldIds = spec.slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join('')
  put('ppt/presentation.xml',
    `<p:presentation ${XMLNS}><p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="${cx}" cy="${cy}"/></p:presentation>`)
  put('ppt/_rels/presentation.xml.rels', relsXml(
    spec.slides
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`)
      .join(''),
  ))

  spec.slides.forEach((s, i) => {
    const name = `slide${i + 1}`
    put(`ppt/slides/${name}.xml`, s.xml)
    let rels = s.rels ?? ''
    if (chain) rels += `<Relationship Id="rIdL" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
    if (s.notes) {
      rels += `<Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`
      put(`ppt/notesSlides/notesSlide${i + 1}.xml`, s.notes)
    }
    if (rels) put(`ppt/slides/_rels/${name}.xml.rels`, relsXml(rels))
  })

  if (chain) {
    put('ppt/slideLayouts/slideLayout1.xml', spec.layout ?? DEFAULT_LAYOUT)
    put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml(
      `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`,
    ))
    put('ppt/slideMasters/slideMaster1.xml', spec.master ?? DEFAULT_MASTER())
    put('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml(
      `<Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme1.xml"/>`,
    ))
    put('ppt/theme/theme1.xml', spec.theme ?? DEFAULT_THEME)
  }

  if (spec.core) put('docProps/core.xml', spec.core)
  for (const [name, content] of Object.entries(spec.media ?? {})) put(name, content)

  return writeZip(entries)
}

// --- shared building blocks --------------------------------------------------

export const sp = (id: number, name: string, body: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>${body}</p:sp>`

export const xfrm = (x: number, y: number, w: number, h: number): string =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`

export const slide = (body: string, attrs = ''): string =>
  `<p:sld ${XMLNS}${attrs ? ` ${attrs}` : ''}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`

// --- the fixtures ------------------------------------------------------------

/** 1 · minimal: one bare text box, no chain at all, title from core.xml.
 *  Expected report: NO entries. */
export function fxMinimal(): Promise<Uint8Array> {
  return buildPptx({
    chain: false,
    core: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Rig Deck</dc:title></cp:coreProperties>',
    slides: [{
      xml: slide(sp(2, 'Box',
        `<p:spPr>${xfrm(914400, 914400, 2743200, 457200)}` +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>' +
        '<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/>' +
        '<a:p><a:r><a:rPr lang="en-US" sz="1800"><a:solidFill><a:srgbClr val="28303A"/></a:solidFill>' +
        '<a:latin typeface="Georgia"/></a:rPr><a:t>Hello, BeeSlides</a:t></a:r></a:p></p:txBody>')),
    }],
  })
}

/** 2 · themed: a SWAPPED clrMap (bg1→dk2, tx1→lt1) so a naive default-map
 *  read fails loudly; a linear-light shade; the box-with-text split.
 *  Expected report: NO entries. */
export function fxThemed(): Promise<Uint8Array> {
  const swapped =
    '<p:clrMap bg1="dk2" tx1="lt1" bg2="dk1" tx2="lt2" accent1="accent1" accent2="accent2"' +
    ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  const body =
    sp(2, 'BgRect',
      `<p:spPr>${xfrm(0, 0, 914400, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:spPr>') +
    sp(3, 'ShadeRect',
      `<p:spPr>${xfrm(914400, 0, 914400, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:srgbClr val="808080"><a:shade val="50000"/></a:srgbClr></a:solidFill></p:spPr>') +
    sp(4, 'LabelBox',
      `<p:spPr>${xfrm(0, 1828800, 1828800, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr>' +
      '<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/>' +
      '<a:p><a:r><a:rPr sz="1400"><a:latin typeface="Georgia"/></a:rPr><a:t>Label</a:t></a:r></a:p></p:txBody>')
  const xml =
    `<p:sld ${XMLNS}><p:cSld>` +
    '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
    `<p:spTree>${body}</p:spTree></p:cSld></p:sld>`
  return buildPptx({ master: DEFAULT_MASTER(swapped), slides: [{ xml }] })
}

/** 3 · placeholder: a slide title written `<p:ph/>` (no type, no xfrm) whose
 *  frame comes from the layout and whose size comes from the master's
 *  titleStyle. No core.xml — the deck is titled by this text.
 *  Expected report: text-needs-refit + font-substituted (Calibri). */
export function fxPlaceholder(): Promise<Uint8Array> {
  const xml = slide(
    '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Title 1"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody></p:sp>')
  return buildPptx({ slides: [{ xml }] })
}

/** 4 · nested group, 4:3 deck. Outer scales ×2 (ext 3657600×1828800 over
 *  chExt 1828800×914400, off x 914400); inner group sits at (457200, 228600)
 *  size 457200×228600 in outer child space → absolute (1828800, 457200,
 *  914400, 457200), which makes the inner map ANOTHER ×2. Leaf at (114300,
 *  57150) size 114300×57150 → absolute EMU (2057400, 571500, 228600, 114300)
 *  = 216, 60, 24, 12 px. The single-scale wrong answer (outer map applied to
 *  the leaf directly) is 914400+114300·2 = 1143000 → 120 px.
 *  Expected report: nested-group-flattened. */
export function fxGroup(): Promise<Uint8Array> {
  const xml = slide(
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Outer"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="914400" y="0"/><a:ext cx="3657600" cy="1828800"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="1828800" cy="914400"/></a:xfrm></p:grpSpPr>' +
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="11" name="Inner"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="457200" cy="228600"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="457200" cy="228600"/></a:xfrm></p:grpSpPr>' +
    sp(12, 'Leaf',
      `<p:spPr>${xfrm(114300, 57150, 114300, 57150)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>') +
    '</p:grpSp></p:grpSp>')
  return buildPptx({ chain: false, sldSz: { cx: 9144000, cy: 6858000 }, slides: [{ xml }] })
}

/** 5 · bullets: an lstStyle buChar silenced by one paragraph's buNone, and a
 *  frozen buAutoNum that starts at 3.
 *  Expected report: bullet-flattened + auto-number-frozen. */
export function fxBullets(): Promise<Uint8Array> {
  const xml = slide(
    sp(2, 'Bullets',
      `<p:spPr>${xfrm(914400, 914400, 4572000, 1828800)}</p:spPr>` +
      '<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr>' +
      '<a:lstStyle><a:lvl1pPr><a:buFont typeface="Arial"/><a:buChar char="•"/>' +
      '<a:defRPr sz="1800"><a:latin typeface="Georgia"/></a:defRPr></a:lvl1pPr></a:lstStyle>' +
      '<a:p><a:r><a:t>One</a:t></a:r></a:p>' +
      '<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>Two</a:t></a:r></a:p>' +
      '<a:p><a:r><a:t>Three</a:t></a:r></a:p></p:txBody>') +
    sp(3, 'Numbers',
      `<p:spPr>${xfrm(914400, 3657600, 4572000, 914400)}</p:spPr>` +
      '<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr>' +
      '<a:lstStyle><a:lvl1pPr><a:defRPr sz="1800"><a:latin typeface="Georgia"/></a:defRPr></a:lvl1pPr></a:lstStyle>' +
      '<a:p><a:pPr><a:buAutoNum type="arabicPeriod" startAt="3"/></a:pPr><a:r><a:t>Alpha</a:t></a:r></a:p>' +
      '<a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>Beta</a:t></a:r></a:p></p:txBody>'))
  return buildPptx({ chain: false, slides: [{ xml }] })
}

// --- click builds (p:timing) ---------------------------------------------------

let tnId = 3
/** One effect node: Set(visibility) + an animEffect carrying the duration. */
const timingEffect = (
  presetID: number, cls: 'entr' | 'exit' | 'emph' | 'path', subtype: number,
  nodeType: 'clickEffect' | 'withEffect' | 'afterEffect', spid: number,
  opts: { dur?: number; para?: number } = {},
): string => {
  const tgt = `<p:tgtEl><p:spTgt spid="${spid}">${opts.para !== undefined
    ? `<p:txEl><p:pRg st="${opts.para}" end="${opts.para}"/></p:txEl>` : ''}</p:spTgt></p:tgtEl>`
  return `<p:par><p:cTn id="${tnId++}" presetID="${presetID}" presetClass="${cls}" presetSubtype="${subtype}"` +
    ` fill="hold" nodeType="${nodeType}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
    `<p:set><p:cBhvr><p:cTn id="${tnId++}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>` +
    `${tgt}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>` +
    `<p:to><p:strVal val="${cls === 'exit' ? 'hidden' : 'visible'}"/></p:to></p:set>` +
    `<p:animEffect transition="${cls === 'exit' ? 'out' : 'in'}" filter="fade"><p:cBhvr>` +
    `<p:cTn id="${tnId++}" dur="${opts.dur ?? 500}"/>${tgt}</p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par>`
}
/** A time group (a stagger slot) inside a click. */
const timingGroup = (delay: number, ...effects: string[]): string =>
  `<p:par><p:cTn id="${tnId++}" fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>` +
  `<p:childTnLst>${effects.join('')}</p:childTnLst></p:cTn></p:par>`
/** One CLICK of the main sequence (`auto`: a first effect that starts by itself). */
const timingClick = (auto: boolean, ...groups: string[]): string =>
  `<p:par><p:cTn id="${tnId++}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>` +
  `${auto ? '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : ''}</p:stCondLst>` +
  `<p:childTnLst>${groups.join('')}</p:childTnLst></p:cTn></p:par>`
/** The whole p:timing element around a main sequence (+ optional extra sequences). */
const bldTiming = (clicks: string[], extraSeqs = '', bld = ''): string =>
  '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
  '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
  `${clicks.join('')}</p:childTnLst></p:cTn><p:prevCondLst/><p:nextCondLst/></p:seq>${extraSeqs}` +
  `</p:childTnLst></p:cTn></p:par></p:tnLst>${bld ? `<p:bldLst>${bld}</p:bldLst>` : ''}</p:timing>`

const bldBox = (id: number, name: string, x: number, y: number): string =>
  sp(id, name,
    `<p:spPr>${xfrm(x * 914400, y * 914400, 914400, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></p:spPr>')

/**
 * 6 · builds: every build shape the importer maps, and every one it must drop.
 *
 *   click 1  Fly (2) flies in FROM THE LEFT (presetID 2, subtype 8), 750 ms;
 *            With (3) fades in with it; After (4) fades in after them
 *   clicks 2-4  Bullets (5): three paragraphs, one per click (txEl pRg 0..2),
 *            animBg="1" → its box comes in with paragraph 1
 *   click 5  Out (6) exits (Disappear, presetID 1)
 *   click 6  Pulse (7): EMPHASIS — dropped, and the click it sat alone in is
 *            renumbered away
 *   click 7  Path (8): MOTION PATH — dropped likewise
 *   click 8  Rise (9): Ascend (42) → fade-up;  Wipe (10): preset 22, no
 *            equivalent → fade, approximated
 *   Auto (12): a first effect that starts with the slide — no step at all
 *   Trig (11): an interactive trigger sequence — dropped
 *   Group (13): a group of two leaves (14, 15) that flies out TO THE RIGHT (Fly Out)
 */
export function fxBuilds(): Promise<Uint8Array> {
  tnId = 3
  const body =
    bldBox(2, 'Fly', 0.5, 0.5) + bldBox(3, 'With', 2, 0.5) + bldBox(4, 'After', 3.5, 0.5) +
    sp(5, 'Bullets',
      `<p:spPr>${xfrm(914400, 1828800, 4572000, 1828800)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:srgbClr val="DDDDDD"/></a:solidFill></p:spPr>' +
      '<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/>' +
      '<a:p><a:r><a:t>One</a:t></a:r></a:p><a:p><a:r><a:t>Two</a:t></a:r></a:p><a:p><a:r><a:t>Three</a:t></a:r></a:p></p:txBody>') +
    bldBox(6, 'Out', 5, 0.5) + bldBox(7, 'Pulse', 6.5, 0.5) + bldBox(8, 'Path', 8, 0.5) +
    bldBox(9, 'Rise', 0.5, 4) + bldBox(10, 'Wipe', 2, 4) + bldBox(11, 'Trig', 3.5, 4) + bldBox(12, 'Auto', 5, 4) +
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="13" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `<p:grpSpPr><a:xfrm><a:off x="6858000" y="3657600"/><a:ext cx="1828800" cy="457200"/>` +
    '<a:chOff x="6858000" y="3657600"/><a:chExt cx="1828800" cy="457200"/></a:xfrm></p:grpSpPr>' +
    bldBox(14, 'LeafA', 7.5, 4) + bldBox(15, 'LeafB', 8.5, 4) + '</p:grpSp>'
  const clicks = [
    timingClick(true, timingGroup(0, timingEffect(10, 'entr', 0, 'withEffect', 12))), // Auto: with the slide
    timingClick(false,
      timingGroup(0, timingEffect(2, 'entr', 8, 'clickEffect', 2, { dur: 750 }), timingEffect(10, 'entr', 0, 'withEffect', 3)),
      timingGroup(500, timingEffect(10, 'entr', 0, 'afterEffect', 4))),
    timingClick(false, timingGroup(0, timingEffect(10, 'entr', 0, 'clickEffect', 5, { para: 0 }))),
    timingClick(false, timingGroup(0, timingEffect(10, 'entr', 0, 'clickEffect', 5, { para: 1 }))),
    timingClick(false, timingGroup(0, timingEffect(10, 'entr', 0, 'clickEffect', 5, { para: 2 }))),
    timingClick(false, timingGroup(0, timingEffect(1, 'exit', 0, 'clickEffect', 6))),
    timingClick(false, timingGroup(0, timingEffect(26, 'emph', 0, 'clickEffect', 7))),
    timingClick(false, timingGroup(0, timingEffect(0, 'path', 0, 'clickEffect', 8))),
    timingClick(false, timingGroup(0, timingEffect(42, 'entr', 0, 'clickEffect', 9), timingEffect(22, 'entr', 8, 'withEffect', 10))),
    timingClick(false, timingGroup(0, timingEffect(2, 'exit', 2, 'clickEffect', 13))),
  ]
  const trigger =
    '<p:seq concurrent="1" nextAc="seek"><p:cTn id="900" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq">' +
    '<p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="11"/></p:tgtEl></p:cond></p:stCondLst>' +
    '<p:endSync evt="end" delay="0"><p:rtn val="all"/></p:endSync><p:childTnLst/></p:cTn><p:nextCondLst/></p:seq>'
  const xml = `<p:sld ${XMLNS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld>` +
    bldTiming(clicks, trigger, '<p:bldP spid="5" grpId="0" build="p" animBg="1"/>') + '</p:sld>'
  return buildPptx({ chain: false, slides: [{ xml }] })
}

/** 7 · a title placeholder on the default layout/master — optionally animated. Linkable unless builds pin it. */
export function fxAnimatedTitle(animated: boolean): Promise<Uint8Array> {
  tnId = 3
  const title =
    '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody></p:sp>'
  const xml = `<p:sld ${XMLNS}><p:cSld><p:spTree>${title}${bldBox(6, 'Free', 1, 3)}</p:spTree></p:cSld>` +
    (animated
      ? bldTiming([timingClick(false, timingGroup(0, timingEffect(10, 'entr', 0, 'clickEffect', 5), timingEffect(10, 'entr', 0, 'withEffect', 6)))])
      : '') + '</p:sld>'
  return buildPptx({ slides: [{ xml }] })
}

export const SVG_BYTES = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>'
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** 6 · svg+raster pair (svg must win) plus an unreferenced media part that
 *  must be PRUNED from doc.assets.
 *  Expected report: NO entries. */
export function fxSvg(): Promise<Uint8Array> {
  const xml = slide(
    '<p:pic><p:nvPicPr><p:cNvPr id="7" name="Icon"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId2"><a:extLst>' +
    '<a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">' +
    '<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId3"/>' +
    '</a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    `<p:spPr>${xfrm(914400, 914400, 914400, 914400)}</p:spPr></p:pic>`)
  return buildPptx({
    chain: false,
    slides: [{
      xml,
      rels:
        `<Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/>` +
        `<Relationship Id="rId3" Type="${REL}/image" Target="../media/icon.svg"/>`,
    }],
    media: {
      'ppt/media/image1.png': PNG_BYTES,
      'ppt/media/icon.svg': SVG_BYTES,
      'ppt/media/unused.png': new Uint8Array([9, 9, 9, 9]),
    },
  })
}

/** 7 · connectors: one fully anchored (stCxn 2 → endCxn 3), one with a
 *  DANGLING end (endCxn 99 — nothing on the slide has that id).
 *  Expected report: connector-ref-dangling. */
export function fxConnectors(): Promise<Uint8Array> {
  const cxn = (id: number, st: number, end: number, y: number): string =>
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Conn ${id}"/>` +
    `<p:cNvCxnSpPr><a:stCxn id="${st}" idx="3"/><a:endCxn id="${end}" idx="1"/></p:cNvCxnSpPr>` +
    `<p:nvPr/></p:nvCxnSpPr>` +
    `<p:spPr><a:xfrm><a:off x="1828800" y="${y}"/><a:ext cx="914400" cy="0"/></a:xfrm>` +
    '<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>' +
    '<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>' +
    '</p:spPr></p:cxnSp>'
  const xml = slide(
    sp(2, 'A',
      `<p:spPr>${xfrm(457200, 228600, 1371600, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></p:spPr>') +
    sp(3, 'B',
      `<p:spPr>${xfrm(2743200, 228600, 1371600, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:srgbClr val="FBAE40"/></a:solidFill></p:spPr>') +
    cxn(4, 2, 3, 457200) +
    cxn(5, 2, 99, 914400))
  return buildPptx({ chain: false, slides: [{ xml }] })
}

/** 8 · structure: an UNREADABLE table (no grid, no rows) and a chart whose
 *  r:id resolves to no part — both keep the placeholder box, honestly
 *  reported (real tables/charts are fixture 15, fxGraphics) — speaker notes
 *  (sldImg/sldNum placeholders skipped), a hidden second slide carrying an
 *  mc:AlternateContent whose Fallback must be taken exactly once, and NO
 *  transition anywhere (emitted 'none', never 'fade').
 *  Expected report: table-unreadable + chart-unreadable. */
export function fxStructure(): Promise<Uint8Array> {
  const gframe = (id: number, name: string, y: number, data: string): string =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/>` +
    '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    `<p:xfrm><a:off x="914400" y="${y}"/><a:ext cx="4572000" cy="1828800"/></p:xfrm>` +
    `<a:graphic><a:graphicData ${data}</a:graphicData></a:graphic></p:graphicFrame>`
  const slide1 = slide(
    gframe(6, 'Table 1', 914400,
      'uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl/>') +
    gframe(7, 'Chart 1', 3657600,
      'uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
      '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/>'))
  const notes =
    `<p:notes ${XMLNS}><p:cSld><p:spTree>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Remember the demo</a:t></a:r></a:p></p:txBody></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Num"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>' +
    '</p:spTree></p:cSld></p:notes>'
  const rect = (id: number, color: string): string =>
    sp(id, `R${id}`,
      `<p:spPr>${xfrm(0, 0, 914400, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill></p:spPr>`)
  const slide2 = slide(
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    `<mc:Choice Requires="p14">${rect(20, '00FF00')}</mc:Choice>` +
    `<mc:Fallback>${rect(21, '0000FF')}</mc:Fallback>` +
    '</mc:AlternateContent>',
    'show="0"')
  return buildPptx({ chain: false, slides: [{ xml: slide1, notes }, { xml: slide2 }] })
}

/**
 * 9 · layout extraction: one master (a title placeholder — decoration must
 * SKIP it — plus a logo picture) serving two layouts. Layout 1 has its own
 * title/body placeholders and a decorative rule; layout 2 sets
 * showMasterSp="0" (the logo must NOT appear there — a detached root) and
 * a blipFill background. Three slides: 1 and 3 both use layout 1, proving the layout
 * cache dedups (doc.layouts stays at master + 2 layouts, the logo is never
 * doubled) rather
 * than re-extracting per slide; slide 2 uses layout 2, so its OWN background
 * resolution also hits the inherited picture background.
 * Expected report: background-image-imported (from slide 2 AND layout 2 —
 * two surfaces, two entries, same underlying picture).
 */
export async function fxLayouts(): Promise<Uint8Array> {
  const entries: ZipEntry[] = []
  const put = (name: string, content: string | Uint8Array): void => {
    entries.push({ name, data: typeof content === 'string' ? enc.encode(content) : content })
  }
  put('[Content_Types].xml', CONTENT_TYPES)
  put('_rels/.rels', ROOT_RELS)

  const sldIds = [1, 2, 3].map((i) => `<p:sldId id="${255 + i}" r:id="rId${i}"/>`).join('')
  put('ppt/presentation.xml',
    `<p:presentation ${XMLNS}><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
  put('ppt/_rels/presentation.xml.rels', relsXml(
    `<Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide2.xml"/>` +
    `<Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide3.xml"/>`,
  ))

  put('ppt/slides/slide1.xml', slide(
    sp(20, 'Title', `<p:spPr>${xfrm(457200, 274638, 8229600, 1143000)}</p:spPr>` +
      '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Slide One</a:t></a:r></a:p></p:txBody>')))
  put('ppt/slides/_rels/slide1.xml.rels', relsXml(
    `<Relationship Id="rIdL" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`))

  put('ppt/slides/slide2.xml', slide(''))
  put('ppt/slides/_rels/slide2.xml.rels', relsXml(
    `<Relationship Id="rIdL" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout2.xml"/>`))

  put('ppt/slides/slide3.xml', slide(''))
  put('ppt/slides/_rels/slide3.xml.rels', relsXml(
    `<Relationship Id="rIdL" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`))

  // Layout 1: title (off 457200,274638 ext 8229600,1143000 → 48,28.83,864,120)
  // + body (off 457200,1600200 ext 8229600,4525963 → 48,168,864,475.19) +
  // decorative rule. showMasterSp absent — the master's logo shows through.
  put('ppt/slideLayouts/slideLayout1.xml',
    `<p:sldLayout ${XMLNS} type="obj"><p:cSld name="Custom Layout"><p:spTree>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="10" name="Title"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr>${xfrm(457200, 274638, 8229600, 1143000)}</p:spPr></p:sp>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="11" name="Body"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr>${xfrm(457200, 1600200, 8229600, 4525963)}</p:spPr></p:sp>` +
    sp(12, 'Rule', `<p:spPr>${xfrm(457200, 1500000, 8229600, 12700)}` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="F7A600"/></a:solidFill></p:spPr>') +
    '</p:spTree></p:cSld></p:sldLayout>')
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml(
    `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`))

  // Layout 2: showMasterSp="0" (the logo must NOT show through) + a picture
  // background (blipFill) — no other content.
  put('ppt/slideLayouts/slideLayout2.xml',
    `<p:sldLayout ${XMLNS} type="blank" showMasterSp="0"><p:cSld name="Picture Background">` +
    '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rIdBg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>' +
    '<a:effectLst/></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldLayout>')
  put('ppt/slideLayouts/_rels/slideLayout2.xml.rels', relsXml(
    `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
    `<Relationship Id="rIdBg" Type="${REL}/image" Target="../media/bg.png"/>`))

  // Master: its OWN title placeholder (decoration must skip it — it is not
  // template chrome) plus a logo picture at off 10972800,6400800 ext
  // 457200,457200 → 1152,672,48,48 (decoration-only, no p:ph).
  put('ppt/slideMasters/slideMaster1.xml',
    `<p:sldMaster ${XMLNS}><p:cSld><p:spTree>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="1" name="Master Title"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    `<p:spPr>${xfrm(10972800, 6400800, 457200, 457200)}</p:spPr></p:pic>` +
    `</p:spTree></p:cSld>${STANDARD_CLRMAP}` +
    '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle/></p:txStyles>' +
    '</p:sldMaster>')
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml(
    `<Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme1.xml"/>` +
    `<Relationship Id="rIdLogo" Type="${REL}/image" Target="../media/logo.png"/>`))
  put('ppt/theme/theme1.xml', DEFAULT_THEME)

  put('ppt/media/logo.png', PNG_BYTES)
  put('ppt/media/bg.png', PNG_BYTES)

  return writeZip(entries)
}

/**
 * 10 · chrome: a master footer bar (decoration, not a placeholder) and a
 * layout carrying a title PROMPT (must never bake onto a real slide) plus
 * ftr/dt/sldNum furniture placeholders — the layout's own `<p:hf sldNum="0"/>`
 * hides the slide-number one everywhere. Three slides exercise the three
 * ways a slide can differ from painting the full template onto itself:
 *
 *   1 · Plain    — no chrome of its own: gets master decoration + layout
 *                  decoration + ftr + dt (sldNum stays hidden).
 *   2 · OwnFooter — already carries its own idx=10 footer placeholder: the
 *                  layout's ftr is NOT duplicated underneath it (dt still is).
 *   3 · NoMasterSp — its own p:sld/@showMasterSp="0" suppresses the master's
 *                  footer bar for THIS slide only; layout decoration and
 *                  furniture (ftr + dt) are unaffected.
 *
 * Expected report: font-substituted + text-needs-refit only (the same two
 * codes fxPlaceholder's bare, autofit-less placeholder text draws) — nothing
 * is dropped or approximated.
 */
export async function fxChrome(): Promise<Uint8Array> {
  const master =
    `<p:sldMaster ${XMLNS}><p:cSld><p:spTree>` +
    sp(40, 'FooterBar', `<p:spPr>${xfrm(0, 6400800, 12192000, 228600)}` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="203040"/></a:solidFill></p:spPr>') +
    `</p:spTree></p:cSld>${STANDARD_CLRMAP}` +
    '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'

  const ph = (id: number, name: string, type: string, idx: string | undefined, frame: string, body = ''): string =>
    '<p:sp><p:nvSpPr>' +
    `<p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/>` +
    `<p:nvPr><p:ph type="${type}"${idx !== undefined ? ` idx="${idx}"` : ''}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr>${frame}</p:spPr>${body}</p:sp>`

  const layout =
    `<p:sldLayout ${XMLNS} type="obj"><p:cSld name="Chrome Layout"><p:spTree>` +
    sp(50, 'Watermark', `<p:spPr>${xfrm(457200, 0, 914400, 457200)}` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="AAAAAA"/></a:solidFill></p:spPr>') +
    ph(60, 'Title', 'title', undefined, xfrm(457200, 274638, 8229600, 1143000)) +
    ph(61, 'Footer Placeholder', 'ftr', '10', xfrm(457200, 6400800, 4572000, 228600),
      '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Acme Corp</a:t></a:r></a:p></p:txBody>') +
    ph(62, 'Date Placeholder', 'dt', '11', xfrm(5029200, 6400800, 2286000, 228600)) +
    ph(63, 'Slide Number Placeholder', 'sldNum', '12', xfrm(10972800, 6400800, 914400, 228600)) +
    '</p:spTree></p:cSld><p:hf sldNum="0"/></p:sldLayout>'

  const rect = (id: number, color: string): string =>
    sp(id, `R${id}`, `<p:spPr>${xfrm(914400, 914400, 914400, 914400)}` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></p:spPr>`)

  const slide1 = slide(rect(70, '4472C4'))
  const slide2 = slide(
    '<p:sp><p:nvSpPr><p:cNvPr id="71" name="My Footer"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="ftr" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Custom Footer</a:t></a:r></a:p></p:txBody></p:sp>')
  const slide3 = slide(rect(72, 'AA00AA'), 'showMasterSp="0"')

  return buildPptx({ master, layout, slides: [{ xml: slide1 }, { xml: slide2 }, { xml: slide3 }] })
}

// --- multi-master packages ----------------------------------------------------

export interface MultiLayout {
  xml: string
  /** extra Relationship entries for the layout's .rels (its master rel is
   *  wired automatically) */
  rels?: string
}

export interface MultiMaster {
  /** a complete p:sldMaster — the builder injects p:sldLayoutIdLst */
  xml: string
  theme?: string
  /** extra Relationship entries for the master's .rels (theme + layout rels
   *  are wired automatically) */
  rels?: string
  layouts: MultiLayout[]
}

export interface MultiSpec {
  masters: MultiMaster[]
  /** `layout` is the GLOBAL 1-based layout number, counted across masters
   *  in list order — the same k the converter numbers layouts by */
  slides: Array<{ xml: string; layout: number; rels?: string }>
  media?: Record<string, string | Uint8Array>
}

/**
 * A package the way PowerPoint writes one: p:sldMasterIdLst in the
 * presentation, p:sldLayoutIdLst in every master, parts named
 * slideMaster<m>/slideLayout<k>/theme<m> — so the converter's rels-only
 * enumeration has real lists to walk (buildPptx has neither list).
 */
export function buildMultiPptx(spec: MultiSpec): Promise<Uint8Array> {
  const entries: ZipEntry[] = []
  const put = (name: string, content: string | Uint8Array): void => {
    entries.push({ name, data: typeof content === 'string' ? enc.encode(content) : content })
  }
  put('[Content_Types].xml', CONTENT_TYPES)
  put('_rels/.rels', ROOT_RELS)

  const masterIds = spec.masters.map((_, i) => `<p:sldMasterId id="${2147483648 + i * 100}" r:id="rIdM${i + 1}"/>`).join('')
  const sldIds = spec.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join('')
  put('ppt/presentation.xml',
    `<p:presentation ${XMLNS}><p:sldMasterIdLst>${masterIds}</p:sldMasterIdLst>` +
    `<p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
  put('ppt/_rels/presentation.xml.rels', relsXml(
    spec.masters.map((_, i) =>
      `<Relationship Id="rIdM${i + 1}" Type="${REL}/slideMaster" Target="slideMasters/slideMaster${i + 1}.xml"/>`).join('') +
    spec.slides.map((_, i) =>
      `<Relationship Id="rIdS${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')))

  let k = 0
  spec.masters.forEach((mst, mi) => {
    const m = mi + 1
    const refs: string[] = []
    const rels: string[] = [`<Relationship Id="rIdT" Type="${REL}/theme" Target="../theme/theme${m}.xml"/>`]
    for (const ly of mst.layouts) {
      k++
      refs.push(`<p:sldLayoutId id="${2147483648 + mi * 100 + k}" r:id="rIdL${k}"/>`)
      rels.push(`<Relationship Id="rIdL${k}" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout${k}.xml"/>`)
      put(`ppt/slideLayouts/slideLayout${k}.xml`, ly.xml)
      put(`ppt/slideLayouts/_rels/slideLayout${k}.xml.rels`, relsXml(
        `<Relationship Id="rIdMst" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster${m}.xml"/>` + (ly.rels ?? '')))
    }
    put(`ppt/slideMasters/slideMaster${m}.xml`,
      mst.xml.replace('</p:sldMaster>', `<p:sldLayoutIdLst>${refs.join('')}</p:sldLayoutIdLst></p:sldMaster>`))
    put(`ppt/slideMasters/_rels/slideMaster${m}.xml.rels`, relsXml(rels.join('') + (mst.rels ?? '')))
    put(`ppt/theme/theme${m}.xml`, mst.theme ?? DEFAULT_THEME)
  })

  spec.slides.forEach((sl, i) => {
    put(`ppt/slides/slide${i + 1}.xml`, sl.xml)
    put(`ppt/slides/_rels/slide${i + 1}.xml.rels`, relsXml(
      `<Relationship Id="rIdLy" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout${sl.layout}.xml"/>` + (sl.rels ?? '')))
  })
  for (const [name, content] of Object.entries(spec.media ?? {})) put(name, content)
  return writeZip(entries)
}

/** A placeholder shape. `frame` '' leaves the frame to the chain. */
export const phSp = (id: number, name: string, ph: string, frame: string, body = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
  `<p:spPr>${frame}</p:spPr>${body}</p:sp>`

/** a txBody of plain paragraphs (already-built a:p children allowed) */
export const txBody = (...paras: string[]): string =>
  `<p:txBody><a:bodyPr/><a:lstStyle/>${paras.map((p) => (p.startsWith('<a:') ? `<a:p>${p}</a:p>` : `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`)).join('')}</p:txBody>`

/** `rootAttrs` go on p:sldLayout itself — where ECMA-376 puts showMasterSp;
 *  `cSldAttrs` on p:cSld, the position some producers use instead. */
const layoutXml = (type: string, name: string, tree: string, cSldAttrs = '', bg = '', rootAttrs = ''): string =>
  `<p:sldLayout ${XMLNS} type="${type}"${rootAttrs}><p:cSld name="${name}"${cSldAttrs}>${bg}<p:spTree>${tree}</p:spTree></p:cSld></p:sldLayout>`

const TX_STYLES = '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:buChar char="•"/><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle/></p:txStyles>'

const masterXml = (name: string, tree: string, bg = ''): string =>
  `<p:sldMaster ${XMLNS}><p:cSld name="${name}">${bg}<p:spTree>` +
  phSp(1, 'Master Title', '<p:ph type="title"/>', xfrm(457200, 274638, 8229600, 1143000)) +
  `${tree}</p:spTree></p:cSld>${STANDARD_CLRMAP}${TX_STYLES}</p:sldMaster>`

const picBg = (rId: string): string =>
  `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`

const TITLE_FRAME = xfrm(457200, 274638, 8229600, 1143000) // → 48, 28.83, 864, 120
const BODY_FRAME = xfrm(457200, 1600200, 8229600, 4525963) // → 48, 168, 864, 475.19

/** A second theme: every accent moved, different faces — a master that
 *  resolves against the WRONG theme shows it at once. */
export const SECOND_THEME = DEFAULT_THEME
  .replace('name="fixture"', 'name="second"')
  .replace('<a:accent1><a:srgbClr val="4472C4"/>', '<a:accent1><a:srgbClr val="AA3355"/>')
  .replace('<a:latin typeface="Calibri Light"/>', '<a:latin typeface="Georgia"/>')
  .replace('<a:latin typeface="Calibri"/>', '<a:latin typeface="Verdana"/>')

/**
 * 11 · masters: two masters, numbered by the lists (never by use).
 *
 *   master 1 "Brand Master" (DEFAULT_THEME) — a logo (pic id 3), no bg:
 *     k1 obj "Title and Content"   (child)
 *     k2 title "Title Slide"       (child)
 *     k3 blank "No Master", showMasterSp="0"            (DETACHED, no logo)
 *     k4 blank "Picture Bg", its own picture background (DETACHED: the
 *        picture would cover the logo, so the logo is folded in above it)
 *     k5 titleOnly "Unused One"    (no slide uses it)
 *   master 2 "Second Master" (SECOND_THEME) — a picture background + a
 *   decoration rect (id 5):
 *     k6 obj "Second Content"      (child — the master paints the picture)
 *     k7 secHead "Second Unused", its own solid p:bg under the picture
 *        master (DETACHED — the inherited picture would cover it); unused
 *
 * Slides use k1, k2, k3, k4, k6, k1 (default) — `noObj` turns every obj
 * layout into `tx` and the slides onto k1, k2, k3, k4, k6, k2, k2, so the
 * most-used layout (k2) has to decide the default.
 */
export function fxMasters(opts: { noObj?: boolean } = {}): Promise<Uint8Array> {
  const obj = opts.noObj ? 'tx' : 'obj'
  const titled = (text: string): string => slide(phSp(2, 'Title', '<p:ph type="title"/>', '', txBody(text)))
  const contentTree = phSp(10, 'Title', '<p:ph type="title"/>', TITLE_FRAME) +
    phSp(11, 'Body', '<p:ph idx="1"/>', BODY_FRAME)
  const logo = '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    `<p:spPr>${xfrm(10972800, 6400800, 457200, 457200)}</p:spPr></p:pic>`
  const deco = sp(5, 'Band', `<p:spPr>${xfrm(0, 0, 12192000, 228600)}` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr>')
  const layouts = opts.noObj ? [1, 2, 3, 4, 6, 2, 2] : [1, 2, 3, 4, 6, 1]
  return buildMultiPptx({
    masters: [
      {
        xml: masterXml('Brand Master', logo),
        rels: `<Relationship Id="rIdLogo" Type="${REL}/image" Target="../media/logo.png"/>`,
        layouts: [
          { xml: layoutXml(obj, 'Title and Content', contentTree) },
          { xml: layoutXml('title', 'Title Slide',
            phSp(10, 'Title', '<p:ph type="ctrTitle"/>', TITLE_FRAME) +
            phSp(11, 'Subtitle', '<p:ph type="subTitle" idx="1"/>', BODY_FRAME)) },
          { xml: layoutXml('blank', 'No Master', sp(12, 'Frame', `<p:spPr>${xfrm(0, 0, 914400, 914400)}` +
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="00AA00"/></a:solidFill></p:spPr>'),
          '', '', ' showMasterSp="0"') },
          { xml: layoutXml('blank', 'Picture Bg', '', '', picBg('rIdBg')),
            rels: `<Relationship Id="rIdBg" Type="${REL}/image" Target="../media/bg.png"/>` },
          { xml: layoutXml('titleOnly', 'Unused One', phSp(10, 'Title', '<p:ph type="title"/>', TITLE_FRAME)) },
        ],
      },
      {
        xml: masterXml('Second Master', deco, picBg('rIdBg2')),
        theme: SECOND_THEME,
        rels: `<Relationship Id="rIdBg2" Type="${REL}/image" Target="../media/bg2.png"/>`,
        layouts: [
          { xml: layoutXml(obj, 'Second Content', contentTree) },
          { xml: layoutXml('secHead', 'Second Unused', phSp(10, 'Title', '<p:ph type="title"/>', TITLE_FRAME), '',
            '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="334455"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>') },
        ],
      },
    ],
    slides: layouts.map((layout, i) => ({ xml: layout === 3 || layout === 4 ? slide('') : titled(`Slide ${i + 1}`), layout })),
    media: {
      'ppt/media/logo.png': PNG_BYTES,
      'ppt/media/bg.png': new Uint8Array([...PNG_BYTES, 7]),
      'ppt/media/bg2.png': new Uint8Array([...PNG_BYTES, 8]),
    },
  })
}

/** Slide numbers of fxLinking, by the case each one probes. */
export const LINKING_CASES = {
  clean: 1, titleMoved: 2, runSize: 3, clrMapOvr: 4, ownBg: 5,
  picOverTitle: 6, picSlotFilled: 7, picSlotEmpty: 8, ownSldNum: 9,
} as const

/**
 * 12 · linking: one master (a decoration rect, id 3; bodyStyle bullets) and
 * two layouts —
 *   k1 obj "Title and Content": title (10), body idx 1 (11), sldNum idx 12 (12)
 *   k2 picTx "Picture with Caption": title (20), pic idx 1 (21), body idx 2 (22)
 * — and one slide per linking case (LINKING_CASES): which link, and which
 * stay flattened for which reason.
 */
export function fxLinking(): Promise<Uint8Array> {
  const title = (text: string, frame = '', rPr = ''): string =>
    phSp(2, 'Title', '<p:ph type="title"/>', frame,
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${rPr}<a:t>${text}</a:t></a:r></a:p></p:txBody>`)
  const body = (id: number, idx: number, ...paras: string[]): string =>
    phSp(id, 'Content', `<p:ph idx="${idx}"/>`, '', txBody(...paras))
  const photo = (id: number, frame: string, ph = ''): string =>
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Photo"/><p:cNvPicPr/><p:nvPr>${ph}</p:nvPr></p:nvPicPr>` +
    '<p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    `<p:spPr>${frame}</p:spPr></p:pic>`
  const imgRel = `<Relationship Id="rIdImg" Type="${REL}/image" Target="../media/photo.png"/>`
  const deco = sp(3, 'Rule', `<p:spPr>${xfrm(0, 6629400, 12192000, 228600)}` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="203040"/></a:solidFill></p:spPr>')
  const bold = '<a:r><a:t>Second </a:t></a:r><a:r><a:rPr b="1"/><a:t>bold</a:t></a:r><a:r><a:t> point</a:t></a:r>'

  return buildMultiPptx({
    masters: [{
      xml: masterXml('Linking Master', deco),
      layouts: [
        { xml: layoutXml('obj', 'Title and Content',
          phSp(10, 'Title', '<p:ph type="title"/>', TITLE_FRAME) +
          phSp(11, 'Body', '<p:ph idx="1"/>', BODY_FRAME) +
          phSp(12, 'Slide Number', '<p:ph type="sldNum" idx="12"/>', xfrm(10972800, 6400800, 914400, 228600))) },
        { xml: layoutXml('picTx', 'Picture with Caption',
          phSp(20, 'Title', '<p:ph type="title"/>', TITLE_FRAME) +
          phSp(21, 'Picture', '<p:ph type="pic" idx="1"/>', xfrm(6400800, 1600200, 4572000, 4572000)) +
          phSp(22, 'Caption', '<p:ph type="body" idx="2"/>', xfrm(457200, 1600200, 5486400, 4572000))) },
      ],
    }],
    slides: [
      // 1 · clean — bullets from the master's bodyStyle, an inline <b>
      { layout: 1, xml: slide(title('Clean') + body(4, 1, 'First point', bold)) },
      // 2 · the title moved off its slot
      { layout: 1, xml: slide(title('Moved', xfrm(914400, 914400, 4572000, 914400)) + body(4, 1, 'Text')) },
      // 3 · a run-level size override
      { layout: 1, xml: slide(title('Small', '', '<a:rPr sz="2000"/>')) },
      // 4 · the slide re-maps the scheme
      { layout: 1, xml: `<p:sld ${XMLNS}><p:cSld><p:spTree>${title('Remapped')}</p:spTree></p:cSld>` +
        '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2"' +
        ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
        '</p:clrMapOvr></p:sld>' },
      // 5 · its own background
      { layout: 1, xml: `<p:sld ${XMLNS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="EEEEEE"/></a:solidFill>` +
        `<a:effectLst/></p:bgPr></p:bg><p:spTree>${title('Grey')}</p:spTree></p:cSld></p:sld>` },
      // 6 · a picture UNDER the title it overlaps (linked, it would paint on top)
      { layout: 1, rels: imgRel, xml: slide(photo(5, TITLE_FRAME) + title('Covered')) },
      // 7 · the picture slot filled (its frame comes from the slot)
      { layout: 2, rels: imgRel, xml: slide(title('Framed') + photo(5, '', '<p:ph type="pic" idx="1"/>') + body(6, 2, 'Caption')) },
      // 8 · the picture slot left empty — linked, its dashed box would show
      { layout: 2, xml: slide(title('No picture') + body(6, 2, 'Caption')) },
      // 9 · the slide carries its own slide-number placeholder
      { layout: 1, xml: slide(title('Numbered') + phSp(7, 'Slide Number', '<p:ph type="sldNum" idx="12"/>', '',
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{1}" type="slidenum"><a:t>9</a:t></a:fld></a:p></p:txBody>')) },
    ],
    media: { 'ppt/media/photo.png': PNG_BYTES },
  })
}

/** A 1×1 PNG the converter can classify (media.ts isOpaqueRaster): IHDR of
 *  `colorType` (2 RGB = opaque, 6 RGBA = has alpha), an optional tRNS chunk,
 *  then IDAT. CRCs are zero — nothing here decodes pixels. `tag` makes
 *  otherwise-equal images distinct assets. */
export function pngOf(colorType: number, tag: number, trns = false): Uint8Array {
  const chunk = (type: string, data: number[] = []): number[] =>
    [0, 0, 0, data.length, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, colorType, 0, 0, 0]),
    ...(trns ? chunk('tRNS', [0]) : []),
    ...chunk('IDAT', [tag]), ...chunk('IEND'),
  ])
}

/** A JPEG's SOI + APP0 head — always opaque to isOpaqueRaster. */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0])

/** A picture shape; `hidden` sets cNvPr hidden="1". */
const pic = (id: number, name: string, rId: string, frame: string, hidden = false): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"${hidden ? ' hidden="1"' : ''}/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
  `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
  `<p:spPr>${frame}</p:spPr></p:pic>`

const box = (id: number, name: string, frame: string, hidden = false): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"${hidden ? ' hidden="1"' : ''}/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr>${frame}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
  '<a:solidFill><a:srgbClr val="179C7D"/></a:solidFill></p:spPr></p:sp>'

const group = (id: number, name: string, members: string, hidden = false): string =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"${hidden ? ' hidden="1"' : ''}/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/>` +
  `<a:chOff x="0" y="0"/><a:chExt cx="914400" cy="914400"/></a:xfrm></p:grpSpPr>${members}</p:grpSp>`

/** The top-right logo box of fxTemplateChrome: 960,48 240×96 px. */
const LOGO_FRAME = xfrm(9144000, 457200, 2286000, 914400)

/**
 * 13 · template chrome — the shapes a real corporate 2022 master trips on:
 *
 *   master 1 "Brand": a footer logo (pic 3); a HIDDEN OLE stand-in (pic 8);
 *     a HIDDEN group (20 ⊃ rect 21); a visible group (30) whose member 32 is
 *     hidden and 31 is not.
 *     k1 title "Title Lines" — p:sldLayout/@showMasterSp="0" (the spec's
 *        position): a hidden pic (13), then an old logo (6) exactly UNDER an
 *        opaque new logo (7), and a ctrTitle.
 *     k2 title "Legacy cSld" — showMasterSp="0" on p:cSld (the fallback):
 *        an opaque logo (6) under an ALPHA logo (7) — kept; a small picture
 *        (9) inside a later JPEG (8) — dropped.
 *     k3 obj "Content" (child): title, body, and furniture — sldNum "Page
 *        ‹#›", dt with typed-over text and no field, ftr "© Acme".
 *
 * Slides: one empty on k1, one titled on k3. `noObj` makes k3 a `tx`
 * layout, so no layout is "Title and Content" and the default slide type
 * has to come from list order — k1, although it is detached.
 */
export function fxTemplateChrome(opts: { noObj?: boolean } = {}): Promise<Uint8Array> {
  const master =
    `<p:sldMaster ${XMLNS}><p:cSld name="Brand"><p:spTree>` +
    phSp(1, 'Master Title', '<p:ph type="title"/>', xfrm(457200, 274638, 8229600, 1143000)) +
    pic(3, 'LogoFooter', 'rIdLogo', xfrm(10972800, 6400800, 457200, 457200)) +
    pic(8, 'Objekt 7', 'rIdOle', xfrm(0, 0, 0, 0), true) +
    group(20, 'Old Group', box(21, 'R21', xfrm(0, 0, 457200, 457200)), true) +
    group(30, 'Group', box(31, 'R31', xfrm(0, 0, 457200, 457200)) + box(32, 'R32', xfrm(457200, 0, 457200, 457200), true)) +
    `</p:spTree></p:cSld>${STANDARD_CLRMAP}${TX_STYLES}</p:sldMaster>`
  const furniture = (type: string, idx: number, id: number, body: string): string =>
    phSp(id, type, `<p:ph type="${type}" idx="${idx}"/>`, xfrm(457200 + (id - 40) * 1828800, 6400800, 1828800, 228600),
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p>${body}</a:p></p:txBody>`)
  const logoRels = (...ids: Array<[string, string]>): string =>
    ids.map(([rId, file]) => `<Relationship Id="${rId}" Type="${REL}/image" Target="../media/${file}"/>`).join('')
  return buildMultiPptx({
    masters: [{
      xml: master,
      rels: logoRels(['rIdLogo', 'footer.png'], ['rIdOle', 'ole.png']),
      layouts: [
        {
          xml: layoutXml('title', 'Title Lines',
            pic(13, 'Objekt 12', 'rIdOle', xfrm(0, 0, 0, 0), true) +
            pic(6, 'Old Logo', 'rIdOld', LOGO_FRAME) +
            pic(7, 'New Logo', 'rIdNew', LOGO_FRAME) +
            phSp(10, 'Title', '<p:ph type="ctrTitle"/>', TITLE_FRAME), '', '', ' showMasterSp="0"'),
          rels: logoRels(['rIdOle', 'ole.png'], ['rIdOld', 'old.png'], ['rIdNew', 'new.png']),
        },
        {
          xml: layoutXml('title', 'Legacy cSld',
            pic(6, 'Opaque Logo', 'rIdOld', LOGO_FRAME) +
            pic(7, 'Alpha Logo', 'rIdAlpha', LOGO_FRAME) +
            pic(9, 'Small', 'rIdNew', xfrm(914400, 914400, 457200, 457200)) +
            pic(8, 'Photo', 'rIdJpg', xfrm(457200, 457200, 1828800, 1828800)) +
            phSp(10, 'Title', '<p:ph type="ctrTitle"/>', TITLE_FRAME), ' showMasterSp="0"'),
          rels: logoRels(['rIdOld', 'old.png'], ['rIdAlpha', 'alpha.png'], ['rIdNew', 'new.png'], ['rIdJpg', 'photo.jpg']),
        },
        {
          xml: layoutXml(opts.noObj ? 'tx' : 'obj', 'Content',
            phSp(10, 'Title', '<p:ph type="title"/>', TITLE_FRAME) +
            phSp(11, 'Body', '<p:ph idx="1"/>', BODY_FRAME) +
            furniture('sldNum', 12, 40, '<a:r><a:t>Page</a:t></a:r><a:r><a:t> </a:t></a:r><a:fld id="{1}" type="slidenum"><a:t>‹#›</a:t></a:fld>') +
            furniture('dt', 11, 41, '<a:r><a:t>28.06.23</a:t></a:r>') +
            furniture('ftr', 10, 42, '<a:r><a:t>© Acme</a:t></a:r>')),
        },
      ],
    }],
    slides: [
      { xml: slide(''), layout: 1 },
      { xml: slide(phSp(2, 'Title', '<p:ph type="title"/>', '', txBody('Agenda'))), layout: 3 },
    ],
    media: {
      'ppt/media/footer.png': pngOf(2, 1),
      'ppt/media/ole.png': pngOf(2, 2),
      'ppt/media/old.png': pngOf(2, 3),
      'ppt/media/new.png': pngOf(2, 4),
      'ppt/media/alpha.png': pngOf(6, 5),
      'ppt/media/photo.jpg': JPEG_BYTES,
    },
  })
}

/**
 * 14 · theme majority: master 1 (DEFAULT_THEME) holds one layout, master 2
 * (SECOND_THEME, accent1 AA3355) holds two — a template's theme must come
 * from master 2. The one slide uses master 1's layout, so a DECK still
 * takes master 1's (its first slide's) theme.
 */
export function fxThemeMajority(): Promise<Uint8Array> {
  const one = (name: string): MultiLayout => ({ xml: layoutXml('obj', name, phSp(10, 'Title', '<p:ph type="title"/>', TITLE_FRAME)) })
  return buildMultiPptx({
    masters: [
      { xml: masterXml('Stock', ''), layouts: [one('Stock Content')] },
      { xml: masterXml('Brand', ''), theme: SECOND_THEME, layouts: [one('Brand Content'), one('Brand Two')] },
    ],
    slides: [{ xml: slide(''), layout: 1 }],
  })
}

/** DEFAULT_THEME plus an effect style list: styles 1 and 2 empty (the
 *  Office 2013+ shape), style 3 an outer shadow — what a:effectRef idx 3
 *  (Themed Style 2's table background) points at. */
export const EFFECTS_THEME = DEFAULT_THEME.replace('</a:lnStyleLst>',
  '</a:lnStyleLst><a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000">' +
  '<a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>' +
  '</a:effectStyleLst>')

/** Every built-in table style GUID PowerPoint ships, in gallery order — the
 *  rig's own copy (read off PowerPoint for Mac 16's GUID table), so a typo in
 *  table.ts's list fails here rather than agreeing with itself. */
export const BUILTIN_TABLE_STYLE_IDS = (
  '2D5ABB26-0587-4C30-8999-92F81FD0307C 3C2FFA5D-87B4-456A-9821-1D502468CF0F 284E427A-3D55-4303-BF80-6455036E1DE7 ' +
  '69C7853C-536D-4A76-A0AE-DD22124D55A5 775DCB02-9BB8-47FD-8907-85C794F793BA 35758FB7-9AC5-4552-8A53-C91805E547FA ' +
  '08FB837D-C827-4EFA-A057-4D05807E0F7C 5940675A-B579-460E-94D1-54222C63F5DA D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7 ' +
  '18603FDC-E32A-4AB5-989C-0864C3EAD2B8 306799F8-075E-4A3A-A7F6-7FBC6576F1A4 E269D01E-BC32-4049-B463-5C60D7B0CCD2 ' +
  '327F97BB-C833-4FB7-BDE5-3F7075034690 638B1855-1B75-4FBE-930C-398BA8C253C6 9D7B26C5-4107-4FEC-AEDC-1716B250A1EF ' +
  '3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5 0E3FDE45-AF77-4B5C-9715-49D594BDF05E C083E6E3-FA7D-4D7B-A595-EF9225AFEA82 ' +
  'D27102A9-8310-4765-A935-A1911B00CA55 5FD0F851-EC5A-4D38-B0AD-8093EC10F338 68D230F3-CF80-4859-8CE7-A43EE81993B5 ' +
  '7E9639D4-E3E2-4D34-9284-5A2195B3D0D7 69012ECD-51FC-41F1-AA8D-1B2483CD663E 72833802-FEF1-4C79-8D5D-14CF1EAF98D9 ' +
  'F2DE63D5-997A-4646-A377-4702673A728D 17292A2E-F333-43FB-9621-5CBBE7FDCDCB 5A111915-BE36-4E01-A7E5-04B1672EAD32 ' +
  '912C8C85-51F0-491E-9774-3900AFEF0FD7 616DA210-FB5B-4158-B5E0-FEB733F419BA BC89EF96-8CEA-46FF-86C4-4CE0E7609802 ' +
  '5DA37D80-6434-44D0-A028-1B22A696006F 8799B23B-EC83-4686-B30A-512413B5E67A ED083AE6-46FA-4A59-8FB0-9F97EB10719F ' +
  'BDBED569-4797-4DF1-A0F4-6AAB3CD982D8 E8B1032C-EA38-4F05-BA0D-38AFFFC7BED3 793D81CF-94F2-401A-BA57-92F5A7B2D0C5 ' +
  'B301B821-A1FF-4177-AEE7-76D212191A09 9DCAF9ED-07DC-4A11-8D7F-57B35C25682E 1FECB4D8-DB02-4DC6-A0A2-4F2EBAE1DC90 ' +
  '1E171933-4619-4E11-9A3F-F7608DF75F80 FABFCF23-3B69-468F-B69F-88F6DE6A72F2 10A1B5D5-9B99-4C35-A422-299274C87663 ' +
  '073A0DAA-6AF3-43AB-8588-CEC1D06C72B9 5C22544A-7EE6-4342-B048-85BDC9FD1C3A 21E4AEA4-8DFA-4A89-87EB-49C32662AFE0 ' +
  'F5AB1C69-6EDB-4FF4-983F-18BD219EF322 00A15C55-8517-42AA-B614-E9B94910E393 7DF18680-E054-41AD-8BC1-D1AEF772440D ' +
  '93296810-A885-4BE3-A3E7-6D5BEEA58F35 8EC20E35-A176-4012-BC5E-935CFFF8708E 6E25E649-3F16-4E02-A733-19D2CDBF48F0 ' +
  '85BE263C-DBD7-4A20-BB59-AAB30ACAA65A EB344D84-9AFB-497E-A393-DC336BA19D2E EB9631B5-78F2-41C9-869B-9F39066F8104 ' +
  '74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6 2A488322-F2BA-4B5B-9748-0D474271808F D7AC3CCA-C797-4891-BE02-D94E43425B78 ' +
  '69CF1AB2-1976-4502-BF36-3FF5EA218861 8A107856-5554-42FB-B03E-39F5DBC370BA 0505E3EF-67EA-436B-97B2-0124C06EBD24 ' +
  'C4B1156A-380E-4F78-BDF5-A606A8083BF9 22838BEF-8BB2-4498-84A7-C5851F593DF1 16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4 ' +
  'E8034E78-7F5D-4C2E-B375-FC64B27BC917 125E5076-3810-47DD-B79F-674D7AD40C01 37CE84F3-28C3-443E-9E96-99CF82512B78 ' +
  'D03447BB-5D67-496B-8E87-E561075AD55C E929F9F4-4A8F-4326-A1B4-22849713DDAB 8FD4443E-F989-4FC4-A0C8-D5A2AF1F390B ' +
  'AF606853-7671-496A-8E4F-DF71F8EC918B 5202B0CA-FC54-4496-8BCA-5EF66A818D29 0660B408-B3CF-4A94-85FC-2B1E0A45F4A2 ' +
  '91EBBBCC-DAD2-459C-BE2E-F6DE35CF9A28 46F890A9-2807-4EBB-B81D-B2AA78EC7F39'
).split(' ').map((g) => `{${g}}`)

const MEDIUM_2_ACCENT_1 = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'

/**
 * 20 · tables: merged cells and the built-in style list. Theme:
 * EFFECTS_THEME. No ppt/tableStyles.xml — every style is a built-in.
 *
 * Slide 1, s1-2 "Merged": Medium Style 2 – Accent 1, firstRow + bandRow,
 * 4 columns × 5 rows, as PowerPoint writes merges (every covered position
 * keeps its a:tc):
 *   r0  Region (rowSpan 2) | 2025 (gridSpan 2) | hMerge | Note
 *   r1  vMerge             | H1                | H2     | n1
 *   r2  North              | Block (2×2, own red fill) | hMerge (green) | n2
 *   r3  South              | vMerge+gridSpan 2 (green) | hMerge+vMerge "ghost" | n3
 *   r4  Total              | 1                 | 2      | 3 (gridSpan 3: past the grid)
 * s1-3 "Short": a writer that leaves hMerge cells OUT — r0 "Wide"
 * (gridSpan 2) then "end", r1 a | b | c; "end" belongs in column 2, not in
 * the position "Wide" covers.
 *
 * Slide 2, built-ins by GUID (2 columns × 3 rows, firstRow + bandRow):
 *   s2-2  Medium Style 1 – Accent 2   s2-3  Light Style 2 – Accent 1
 *   s2-4  Medium Style 3 – Accent 5   s2-5  Dark Style 2 – Accent 3/Accent 4
 *   s2-6  No Style, Table Grid        s2-7  Themed Style 2 – Accent 6
 *         (tblBg effectRef idx 3 → the theme's outer shadow: reported)
 *   s2-8  Themed Style 1 – Accent 1 (effectRef idx 1 → an EMPTY effect
 *         style: not reported)
 * Slide 3: one 1×2 table per BUILTIN_TABLE_STYLE_IDS entry (s3-2 …).
 * Expected report: table-imported, table-borders-unified, table-span-clamped,
 * table-merge-hidden-text, table-effect-dropped (s2-7 only).
 */
export function fxTables(): Promise<Uint8Array> {
  const run = (t: string): string => `<a:r><a:rPr lang="en-US" sz="1400"/><a:t>${t}</a:t></a:r>`
  const tc = (text: string, attrs = '', tcPr = '<a:tcPr/>'): string =>
    `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${text ? run(text) : ''}</a:p></a:txBody>${tcPr}</a:tc>`
  const tr = (cells: string): string => `<a:tr h="381000">${cells}</a:tr>`
  const solid = (hex: string): string => `<a:tcPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill></a:tcPr>`
  const tbl = (styleId: string, cols: number, rows: string, flags = 'firstRow="1" bandRow="1"'): string =>
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
    `<a:tblPr ${flags}><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr>` +
    `<a:tblGrid>${'<a:gridCol w="914400"/>'.repeat(cols)}</a:tblGrid>${rows}</a:tbl></a:graphicData>`
  const merged = tbl(MEDIUM_2_ACCENT_1, 4,
    tr(tc('Region', ' rowSpan="2"') + tc('2025', ' gridSpan="2"') + tc('', ' hMerge="1"') + tc('Note')) +
    tr(tc('', ' vMerge="1"') + tc('H1') + tc('H2') + tc('n1')) +
    tr(tc('North') + tc('Block', ' gridSpan="2" rowSpan="2"', solid('FF0000')) + tc('', ' hMerge="1"', solid('00FF00')) + tc('n2')) +
    tr(tc('South') + tc('', ' gridSpan="2" vMerge="1"', solid('00FF00')) + tc('ghost', ' hMerge="1" vMerge="1"') + tc('n3')) +
    tr(tc('Total') + tc('1') + tc('2') + tc('3', ' gridSpan="3"')))
  const short = tbl(MEDIUM_2_ACCENT_1, 3,
    tr(tc('Wide', ' gridSpan="2"') + tc('end')) + tr(tc('a') + tc('b') + tc('c')))
  const small = (id: string): string => tbl(id, 2,
    tr(tc('H1') + tc('H2')) + tr(tc('a') + tc('b')) + tr(tc('c') + tc('d')))
  const slide1 = slide(
    gxFrame(2, 'Merged', 914400, 914400, 3657600, 1905000, merged) +
    gxFrame(3, 'Short', 914400, 3200400, 2743200, 762000, short))
  const styled: Array<[string, string]> = [
    ['Medium 1 A2', '{9DCAF9ED-07DC-4A11-8D7F-57B35C25682E}'],
    ['Light 2 A1', '{69012ECD-51FC-41F1-AA8D-1B2483CD663E}'],
    ['Medium 3 A5', '{74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6}'],
    ['Dark 2 A3/A4', '{91EBBBCC-DAD2-459C-BE2E-F6DE35CF9A28}'],
    ['Table Grid', '{5940675A-B579-460E-94D1-54222C63F5DA}'],
    ['Themed 2 A6', '{638B1855-1B75-4FBE-930C-398BA8C253C6}'],
    ['Themed 1 A1', '{3C2FFA5D-87B4-456A-9821-1D502468CF0F}'],
  ]
  const slide2 = slide(styled.map(([name, id], i) =>
    gxFrame(i + 2, name, 914400 + (i % 4) * 2743200, 914400 + Math.floor(i / 4) * 1828800, 1828800, 1143000, small(id))).join(''))
  const slide3 = slide(BUILTIN_TABLE_STYLE_IDS.map((id, i) =>
    gxFrame(i + 2, `Builtin ${i}`, (i % 8) * 1371600, Math.floor(i / 8) * 685800, 1371600, 381000,
      tbl(id, 2, tr(tc('x') + tc('y')), 'firstRow="1"'))).join(''))
  return buildPptx({ theme: EFFECTS_THEME, slides: [{ xml: slide1 }, { xml: slide2 }, { xml: slide3 }] })
}
/** Every fixture, for the loadability gate. */
/**
 * 15 · graphics: native tables and charts from graphicFrames.
 *
 * Slide 1, tables (every frame 96px in, rows 381000 EMU = 40px):
 *   s1-2  built-in Medium Style 2 – Accent 1 (referenced by GUID, NOT defined
 *         in tableStyles.xml), firstRow + bandRow, 4×3, cols 192/96/96 px.
 *         Body rows alternate band1 (accent1 tint 40%) / band2 (= wholeTbl,
 *         tint 20%); one explicit red cell, one all-bold cell, one centred
 *         cell, one mixed-bold cell, and a gridSpan=2 + hMerge "Total" row
 *         (merged: colspan 2 on "Total", the covered cell empty).
 *   s1-3  a CUSTOM style defined in tableStyles.xml in lower case and
 *         referenced in upper case (style ids are GUIDs — case-insensitive):
 *         grey body, dark header,
 *         a 1.5pt #999999 insideH rule, tcPr margins 19.2/9.6 px.
 *   s1-4  a GUID nobody defines → a plain table + 'table-style-unknown'.
 * Slide 2, charts:
 *   s2-2  clustered column, 2 series (one explicit red, one theme accent2 by
 *         c:idx), rich title "Revenue" at 18pt, bottom legend.
 *   s2-3  stacked column + a smooth marker-less line on a SECONDARY axis
 *         (different c:axId pair), primary valAx max 10.
 *   s2-4  doughnut, holeSize 50, one c:dPt override, showPercent labels.
 * Slide 3:
 *   s3-2  scatter (numeric xVal), marker colour #123456, y valAx 0..10.
 *   s3-3  radar — unsupported, keeps its placeholder box.
 *   s3-4  100%-stacked HORIZONTAL bars over DATE categories (m/d/yyyy
 *         serials 44927/44928 = 2023-01-01/02): frozen to percentages,
 *         categories on yAxis (charts-lite's horizontal shape).
 *   s3-5  a line series with only a workbook reference (no cache) → no data,
 *         placeholder.
 * Expected report (link:false): table-imported, table-borders-unified (the
 * style's 3pt header rule), table-style-unknown,
 * chart-imported, chart-type-unsupported, chart-percent-frozen,
 * chart-no-data.
 */
export const NSC = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
export const CUSTOM_TABLE_STYLE = '{ABCDEF12-3456-7890-ABCD-EF1234567890}'

export function fxGraphics(): Promise<Uint8Array> {
  const frameXfrm = (x: number, y: number, w: number, h: number): string =>
    `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm>`
  const gframe = (id: number, name: string, xf: string, data: string): string =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/>` +
    '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' + xf +
    `<a:graphic>${data}</a:graphic></p:graphicFrame>`
  const tableData = (tbl: string): string =>
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tbl}</a:graphicData>`
  const chartData = (rId: string): string =>
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    `<c:chart xmlns:c="${NSC}" r:id="${rId}"/></a:graphicData>`

  // --- tables
  const run = (t: string, rPr = ''): string => `<a:r><a:rPr lang="en-US" sz="1400"${rPr}/><a:t>${t}</a:t></a:r>`
  const tc = (body: string, attrs = '', tcPr = '<a:tcPr/>', pPr = ''): string =>
    `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${pPr}${body}</a:p></a:txBody>${tcPr}</a:tc>`
  const tr = (cells: string): string => `<a:tr h="381000">${cells}</a:tr>`
  const grid = (...w: number[]): string => `<a:tblGrid>${w.map((x) => `<a:gridCol w="${x}"/>`).join('')}</a:tblGrid>`
  const tblA = '<a:tbl><a:tblPr firstRow="1" bandRow="1">' +
    '<a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>' +
    grid(1828800, 914400, 914400) +
    tr(tc(run('Name')) + tc(run('Q1')) + tc(run('Q2'))) +
    tr(tc(run('Alpha')) + tc(run('12', ' b="1"')) + tc(run('7'), '', '<a:tcPr/>', '<a:pPr algn="ctr"/>')) +
    tr(tc(run('Beta')) + tc(run('9'), '', '<a:tcPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:tcPr>') +
      tc(run('Mixed ') + run('bold', ' b="1"'))) +
    tr(tc(run('Total'), ' gridSpan="2"') + tc('', ' hMerge="1"') + tc(run('28'))) +
    '</a:tbl>'
  const tblB = '<a:tbl><a:tblPr firstRow="1">' +
    `<a:tableStyleId>${CUSTOM_TABLE_STYLE}</a:tableStyleId></a:tblPr>` +
    grid(914400, 914400) +
    tr(tc(run('H1'), '', '<a:tcPr marL="182880" marT="91440"/>') + tc(run('H2'))) +
    tr(tc(run('a')) + tc(run('b'))) +
    '</a:tbl>'
  const tblC = '<a:tbl><a:tblPr><a:tableStyleId>{DEADBEEF-0000-0000-0000-000000000000}</a:tableStyleId></a:tblPr>' +
    grid(914400) + tr(tc(run('x'))) + '</a:tbl>'
  const tableStyles = `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}">` +
    `<a:tblStyle styleId="${CUSTOM_TABLE_STYLE.toLowerCase()}" styleName="Fixture Plain">` +
    '<a:wholeTbl><a:tcTxStyle><a:srgbClr val="333333"/></a:tcTxStyle><a:tcStyle><a:tcBdr>' +
    '<a:insideH><a:ln w="19050"><a:solidFill><a:srgbClr val="999999"/></a:solidFill></a:ln></a:insideH>' +
    '</a:tcBdr><a:fill><a:solidFill><a:srgbClr val="EEEEEE"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>' +
    '<a:firstRow><a:tcTxStyle b="on"><a:srgbClr val="FFFFFF"/></a:tcTxStyle><a:tcStyle>' +
    '<a:fill><a:solidFill><a:srgbClr val="222222"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>' +
    '</a:tblStyle></a:tblStyleLst>'
  const slide1 = slide(
    gframe(2, 'Table A', frameXfrm(914400, 914400, 3657600, 1524000), tableData(tblA)) +
    gframe(3, 'Table B', frameXfrm(914400, 3048000, 1828800, 762000), tableData(tblB)) +
    gframe(4, 'Table C', frameXfrm(6096000, 914400, 914400, 381000), tableData(tblC)))

  // --- charts
  const strCache = (v: string[]): string =>
    `<c:strCache><c:ptCount val="${v.length}"/>${v.map((x, i) => `<c:pt idx="${i}"><c:v>${x}</c:v></c:pt>`).join('')}</c:strCache>`
  const numCache = (v: number[], fmt = 'General'): string =>
    `<c:numCache><c:formatCode>${fmt}</c:formatCode><c:ptCount val="${v.length}"/>` +
    `${v.map((x, i) => `<c:pt idx="${i}"><c:v>${x}</c:v></c:pt>`).join('')}</c:numCache>`
  const tx = (name: string): string => `<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f>${strCache([name])}</c:strRef></c:tx>`
  const cat = (v: string[]): string => `<c:cat><c:strRef><c:f>Sheet1!$A$2</c:f>${strCache(v)}</c:strRef></c:cat>`
  const val = (v: number[]): string => `<c:val><c:numRef><c:f>Sheet1!$B$2</c:f>${numCache(v)}</c:numRef></c:val>`
  const fill = (hex: string): string => `<c:spPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill></c:spPr>`
  const ser = (idx: number, body: string): string => `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>${body}</c:ser>`
  const axes = (cat: number, v: number, scaling = ''): string =>
    `<c:catAx><c:axId val="${cat}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="${v}"/></c:catAx>` +
    `<c:valAx><c:axId val="${v}"/><c:scaling><c:orientation val="minMax"/>${scaling}</c:scaling><c:axPos val="l"/><c:crossAx val="${cat}"/></c:valAx>`
  const space = (chart: string): string =>
    `<c:chartSpace xmlns:c="${NSC}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart>${chart}</c:chart></c:chartSpace>`
  const ids = (a: number, b: number): string => `<c:axId val="${a}"/><c:axId val="${b}"/>`

  const chart1 = space(
    '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1800"/></a:pPr><a:r><a:rPr lang="en-US" sz="1800"/><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>' +
    '<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>' +
    ser(0, tx('North') + fill('FF0000') + cat(['Q1', 'Q2', 'Q3']) + val([10, 20, 30])) +
    ser(1, tx('South') + cat(['Q1', 'Q2', 'Q3']) + val([5, 15, 25])) +
    ids(10, 20) + '</c:barChart>' + axes(10, 20) +
    '</c:plotArea><c:legend><c:legendPos val="b"/></c:legend><c:plotVisOnly val="1"/>')
  const chart2 = space(
    '<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/><c:overlap val="100"/>' +
    ser(0, tx('A') + cat(['x', 'y']) + val([1, 2])) +
    ser(1, tx('B') + cat(['x', 'y']) + val([3, 4])) +
    ids(10, 20) + '</c:barChart>' +
    '<c:lineChart><c:grouping val="standard"/>' +
    ser(2, tx('Rate') + '<c:marker><c:symbol val="none"/></c:marker>' + cat(['x', 'y']) + val([50, 60]) + '<c:smooth val="1"/>') +
    ids(30, 40) + '</c:lineChart>' +
    axes(10, 20, '<c:max val="10"/>') + axes(30, 40) +
    '</c:plotArea>')
  const chart3 = space(
    '<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:doughnutChart><c:varyColors val="1"/>' +
    ser(0, tx('Vote') +
      '<c:dPt><c:idx val="1"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></c:spPr></c:dPt>' +
      '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/></c:dLbls>' +
      cat(['Yes', 'No', 'Maybe']) + val([60, 30, 10])) +
    '<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart></c:plotArea>')
  const chart4 = space(
    '<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:scatterChart><c:scatterStyle val="lineMarker"/>' +
    ser(0, tx('Pts') +
      '<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>' +
      '<c:marker><c:symbol val="circle"/><c:spPr><a:solidFill><a:srgbClr val="123456"/></a:solidFill></c:spPr></c:marker>' +
      `<c:xVal><c:numRef><c:f>Sheet1!$A$2</c:f>${numCache([1, 2, 3])}</c:numRef></c:xVal>` +
      `<c:yVal><c:numRef><c:f>Sheet1!$B$2</c:f>${numCache([2, 4, 8])}</c:numRef></c:yVal>`) +
    ids(50, 60) + '</c:scatterChart>' +
    '<c:valAx><c:axId val="50"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="60"/></c:valAx>' +
    '<c:valAx><c:axId val="60"/><c:scaling><c:orientation val="minMax"/><c:max val="10"/><c:min val="0"/></c:scaling><c:axPos val="l"/><c:crossAx val="50"/></c:valAx>' +
    '</c:plotArea>')
  const chart5 = space(
    '<c:plotArea><c:layout/><c:radarChart><c:radarStyle val="marker"/>' +
    ser(0, tx('R') + cat(['a', 'b', 'c']) + val([1, 2, 3])) + ids(70, 80) +
    '</c:radarChart>' + axes(70, 80) + '</c:plotArea>')
  const dateCat = `<c:cat><c:numRef><c:f>Sheet1!$A$2</c:f>${numCache([44927, 44928], 'm/d/yyyy')}</c:numRef></c:cat>`
  const chart6 = space(
    '<c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="bar"/><c:grouping val="percentStacked"/><c:overlap val="100"/>' +
    ser(0, tx('A') + dateCat + val([1, 3])) +
    ser(1, tx('B') + dateCat + val([3, 1])) +
    ids(10, 20) + '</c:barChart>' + axes(10, 20) + '</c:plotArea>')
  const chart7 = space(
    '<c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/>' +
    ser(0, '<c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f></c:numRef></c:val>') +
    ids(10, 20) + '</c:lineChart>' + axes(10, 20) + '</c:plotArea>')

  const chartRel = (i: number): string =>
    `<Relationship Id="rIdC${i}" Type="${REL}/chart" Target="../charts/chart${i}.xml"/>`
  const fr = (i: number): string => frameXfrm(914400 + ((i - 1) % 3) * 3657600, 914400, 3657600, 2743200)
  const slide2 = slide(
    gframe(2, 'Chart 1', fr(1), chartData('rIdC1')) +
    gframe(3, 'Chart 2', fr(2), chartData('rIdC2')) +
    gframe(4, 'Chart 3', fr(3), chartData('rIdC3')))
  const slide3 = slide(
    gframe(2, 'Chart 4', fr(1), chartData('rIdC4')) +
    gframe(3, 'Chart 5', fr(2), chartData('rIdC5')) +
    gframe(4, 'Chart 6', fr(3), chartData('rIdC6')) +
    gframe(5, 'Chart 7', frameXfrm(914400, 4114800, 3657600, 1828800), chartData('rIdC7')))

  return buildPptx({
    slides: [
      { xml: slide1 },
      { xml: slide2, rels: chartRel(1) + chartRel(2) + chartRel(3) },
      { xml: slide3, rels: chartRel(4) + chartRel(5) + chartRel(6) + chartRel(7) },
    ],
    media: {
      'ppt/tableStyles.xml': tableStyles,
      'ppt/charts/chart1.xml': chart1, 'ppt/charts/chart2.xml': chart2, 'ppt/charts/chart3.xml': chart3,
      'ppt/charts/chart4.xml': chart4, 'ppt/charts/chart5.xml': chart5, 'ppt/charts/chart6.xml': chart6,
      'ppt/charts/chart7.xml': chart7,
    },
  })
}

/**
 * Two of PowerPoint's OWN table-style definitions, transcribed verbatim (bar
 * the a: prefix) from the preset list Microsoft PowerPoint for Mac 16 embeds
 * in its binary: they use the CT_TableStyleCellStyle / CT_ThemeableLineStyle
 * forms fxGraphics's styles do not — a:fillRef straight under a:tcStyle
 * (Light Style 8's header), a:lnRef border edges (both), and an a:tblBg
 * background through the theme's fill styles (Themed Style 7, whose ink is
 * lt1 — white text that is only readable on that background).
 */
export const LIGHT_STYLE_8_XML =
  '<a:tblStyle styleId="{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}" styleName="Light Style 8">' +
  '<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef>' +
  '<a:schemeClr val="tx1"/></a:tcTxStyle>' +
  '<a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef></a:left><a:right>' +
  '<a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef></a:right><a:top><a:lnRef idx="1">' +
  '<a:schemeClr val="tx1"/></a:lnRef></a:top><a:bottom><a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef>' +
  '</a:bottom><a:insideH><a:ln><a:noFill/></a:ln></a:insideH><a:insideV><a:ln><a:noFill/></a:ln>' +
  '</a:insideV></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl>' +
  '<a:band1H>' +
  '<a:tcStyle><a:tcBdr><a:top><a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef></a:top><a:bottom>' +
  '<a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef></a:bottom></a:tcBdr></a:tcStyle></a:band1H>' +
  '<a:band1V>' +
  '<a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef></a:left><a:right>' +
  '<a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef></a:right></a:tcBdr></a:tcStyle></a:band1V>' +
  '<a:band2V>' +
  '<a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef></a:left><a:right>' +
  '<a:lnRef idx="1"><a:schemeClr val="tx1"/></a:lnRef></a:right></a:tcBdr></a:tcStyle></a:band2V>' +
  '<a:lastCol><a:tcTxStyle b="on"/>' +
  '<a:tcStyle><a:tcBdr/></a:tcStyle></a:lastCol>' +
  '<a:firstCol><a:tcTxStyle b="on"/>' +
  '<a:tcStyle><a:tcBdr/></a:tcStyle></a:firstCol>' +
  '<a:lastRow><a:tcTxStyle b="on"/>' +
  '<a:tcStyle><a:tcBdr><a:top><a:ln w="50800" cmpd="dbl"><a:solidFill><a:schemeClr val="tx1"/>' +
  '</a:solidFill></a:ln></a:top></a:tcBdr></a:tcStyle></a:lastRow>' +
  '<a:firstRow><a:tcTxStyle b="on"><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef>' +
  '<a:schemeClr val="bg1"/></a:tcTxStyle>' +
  '<a:tcStyle><a:tcBdr/><a:fillRef idx="1"><a:schemeClr val="tx1"/></a:fillRef></a:tcStyle></a:firstRow>' +
  '</a:tblStyle>'

export const THEMED_STYLE_7_XML =
  '<a:tblStyle styleId="{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}" styleName="Themed Style 7">' +
  '<a:tblBg><a:fillRef idx="3"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="3">' +
  '<a:schemeClr val="accent1"/></a:effectRef></a:tblBg>' +
  '<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef>' +
  '<a:schemeClr val="lt1"/></a:tcTxStyle>' +
  '<a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="accent1"><a:tint val="50000"/>' +
  '</a:schemeClr></a:lnRef></a:left><a:right><a:lnRef idx="1"><a:schemeClr val="accent1">' +
  '<a:tint val="50000"/></a:schemeClr></a:lnRef></a:right><a:top><a:lnRef idx="1">' +
  '<a:schemeClr val="accent1"><a:tint val="50000"/></a:schemeClr></a:lnRef></a:top><a:bottom>' +
  '<a:lnRef idx="1"><a:schemeClr val="accent1"><a:tint val="50000"/></a:schemeClr></a:lnRef></a:bottom>' +
  '<a:insideH><a:ln><a:noFill/></a:ln></a:insideH><a:insideV><a:ln><a:noFill/></a:ln></a:insideV></a:tcBdr>' +
  '<a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl>' +
  '<a:band1H>' +
  '<a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="lt1"><a:alpha val="20000"/></a:schemeClr>' +
  '</a:solidFill></a:fill></a:tcStyle></a:band1H>' +
  '<a:band1V>' +
  '<a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="lt1"><a:alpha val="20000"/></a:schemeClr>' +
  '</a:solidFill></a:fill></a:tcStyle></a:band1V>' +
  '<a:lastCol><a:tcTxStyle b="on"/>' +
  '<a:tcStyle><a:tcBdr><a:left><a:lnRef idx="2"><a:schemeClr val="lt1"/></a:lnRef></a:left></a:tcBdr>' +
  '</a:tcStyle></a:lastCol>' +
  '<a:firstCol><a:tcTxStyle b="on"/>' +
  '<a:tcStyle><a:tcBdr><a:right><a:lnRef idx="2"><a:schemeClr val="lt1"/></a:lnRef></a:right></a:tcBdr>' +
  '</a:tcStyle></a:firstCol>' +
  '<a:lastRow><a:tcTxStyle b="on"/>' +
  '<a:tcStyle><a:tcBdr><a:top><a:lnRef idx="2"><a:schemeClr val="lt1"/></a:lnRef></a:top></a:tcBdr><a:fill>' +
  '<a:noFill/></a:fill></a:tcStyle></a:lastRow>' +
  '<a:seCell>' +
  '<a:tcStyle><a:tcBdr><a:left><a:ln><a:noFill/></a:ln></a:left><a:top><a:ln><a:noFill/></a:ln></a:top>' +
  '</a:tcBdr></a:tcStyle></a:seCell>' +
  '<a:swCell>' +
  '<a:tcStyle><a:tcBdr><a:right><a:ln><a:noFill/></a:ln></a:right><a:top><a:ln><a:noFill/></a:ln></a:top>' +
  '</a:tcBdr></a:tcStyle></a:swCell>' +
  '<a:firstRow><a:tcTxStyle b="on"/>' +
  '<a:tcStyle><a:tcBdr><a:bottom><a:lnRef idx="3"><a:schemeClr val="lt1"/></a:lnRef></a:bottom></a:tcBdr>' +
  '<a:fill><a:noFill/></a:fill></a:tcStyle></a:firstRow>' +
  '<a:neCell>' +
  '<a:tcStyle><a:tcBdr><a:bottom><a:ln><a:noFill/></a:ln></a:bottom></a:tcBdr></a:tcStyle></a:neCell>' +
  '</a:tblStyle>'

/** DEFAULT_THEME with fill style 3 a GRADIENT (phClr → white), so a fillRef
 *  idx 3 must flatten: the mean of #4472C4 and #FFFFFF is #A2B9E2
 *  ((68+255)/2 = 161.5 → 162 = A2, 184.5 → 185 = B9, 225.5 → 226 = E2). */
export const GRADIENT_FILL3_THEME = DEFAULT_THEME.replace(
  /<a:fillStyleLst>.*<\/a:fillStyleLst>/,
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs>' +
  '<a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>' +
  '</a:fillStyleLst>',
)

const gxFrame = (id: number, name: string, x: number, y: number, w: number, h: number, data: string): string =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/>` +
  '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm>` +
  `<a:graphic>${data}</a:graphic></p:graphicFrame>`
const gxTable = (styleId: string, rows: string[][]): string =>
  '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
  `<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr>` +
  `<a:tblGrid>${rows[0].map(() => '<a:gridCol w="914400"/>').join('')}</a:tblGrid>` +
  rows.map((r) => '<a:tr h="381000">' + r.map((t) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1400"/><a:t>${t}</a:t></a:r></a:p>` +
    '</a:txBody><a:tcPr/></a:tc>').join('') + '</a:tr>').join('') +
  '</a:tbl></a:graphicData>'
const gxChartRef = (rId: string): string =>
  '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
  `<c:chart xmlns:c="${NSC}" r:id="${rId}"/></a:graphicData>`
const gxChartRel = (i: number): string =>
  `<Relationship Id="rIdC${i}" Type="${REL}/chart" Target="../charts/chart${i}.xml"/>`
const gxSpace = (chart: string): string =>
  `<c:chartSpace xmlns:c="${NSC}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart>${chart}</c:chart></c:chartSpace>`
const gxSer = (i: number, name: string, vals: number[], extra = ''): string =>
  `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>` +
  `<c:tx><c:v>${name}</c:v></c:tx>${extra}` +
  '<c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>a</c:v></c:pt><c:pt idx="1"><c:v>b</c:v></c:pt></c:strLit></c:cat>' +
  `<c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>` +
  vals.map((v, j) => `<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>`).join('') + '</c:numLit></c:val></c:ser>'
const gxRich = (t: string): string =>
  `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`

/**
 * 16 · graphics, the second pass — table-style forms and chart features
 * fxGraphics does not exercise. Theme: GRADIENT_FILL3_THEME.
 *
 * Slide 1, tables (2 columns × 3 rows: header, band1, band2):
 *   s1-2  Light Style 8 — header fill is a:fillRef idx 1 tx1 (→ solid
 *         #000000) under bg1 (#FFFFFF) bold ink; lnRef idx 1 tx1 outer
 *         rules (theme line 1: 6350 EMU → 0.67px), insideH/V noFill.
 *   s1-3  Themed Style 7 (Accent 1) — tblBg fillRef idx 3 accent1 → the
 *         theme's GRADIENT, flattened to #A2B9E2 and showing through the
 *         noFill layers; body ink lt1; band1H is lt1 at 20% alpha, painted
 *         over that background: 0.2·255 + 0.8·(162,185,226) = (180.6, 199,
 *         231.8) → #B5C7E8.
 * Slide 2, charts:
 *   s2-2  stacked column, valAx c:min 50 + title "Revenue" + numFmt "0%"
 *         (not source-linked), catAx title "Quarter" + c:delete 1, series
 *         dLbls showVal.
 *   s2-3  the control: clustered column, valAx numFmt General source-linked,
 *         dLbls present but all show* 0 — none of s2-2's notes.
 * Expected report: table-imported, table-borders-unified, table-fill-flattened,
 * chart-imported, chart-axis-title-dropped, chart-data-labels-dropped,
 * chart-number-format-dropped, chart-axis-hidden-shown.
 */
export function fxGraphicsMore(): Promise<Uint8Array> {
  const rows = [['H1', 'H2'], ['a', 'b'], ['c', 'd']]
  const slide1 = slide(
    gxFrame(2, 'Light 8', 914400, 914400, 1828800, 1143000, gxTable('{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}', rows)) +
    gxFrame(3, 'Themed 7', 914400, 3048000, 1828800, 1143000, gxTable('{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}', rows)))
  const tableStyles = '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}">' + LIGHT_STYLE_8_XML + THEMED_STYLE_7_XML + '</a:tblStyleLst>'
  const showVal = '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/>' +
    '<c:showSerName val="0"/><c:showPercent val="0"/></c:dLbls>'
  const allOff = '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/>' +
    '<c:showSerName val="0"/><c:showPercent val="0"/></c:dLbls>'
  const chart1 = gxSpace(
    '<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/><c:overlap val="100"/>' +
    gxSer(0, 'A', [60, 70], showVal) + gxSer(1, 'B', [10, 10]) +
    '<c:axId val="10"/><c:axId val="20"/></c:barChart>' +
    '<c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/>' +
    `<c:axPos val="b"/>${gxRich('Quarter')}<c:crossAx val="20"/></c:catAx>` +
    '<c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/><c:min val="50"/></c:scaling>' +
    `<c:delete val="0"/><c:axPos val="l"/>${gxRich('Revenue')}` +
    '<c:numFmt formatCode="0%" sourceLinked="0"/><c:crossAx val="10"/></c:valAx>' +
    '</c:plotArea>')
  const chart2 = gxSpace(
    '<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${allOff}` +
    gxSer(0, 'A', [1, 2], allOff) +
    '<c:axId val="10"/><c:axId val="20"/></c:barChart>' +
    '<c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>' +
    '<c:axPos val="b"/><c:crossAx val="20"/></c:catAx>' +
    '<c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>' +
    '<c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="10"/></c:valAx>' +
    '</c:plotArea>')
  const slide2 = slide(
    gxFrame(2, 'Chart 1', 914400, 914400, 3657600, 2743200, gxChartRef('rIdC1')) +
    gxFrame(3, 'Chart 2', 5486400, 914400, 3657600, 2743200, gxChartRef('rIdC2')))
  return buildPptx({
    theme: GRADIENT_FILL3_THEME,
    slides: [{ xml: slide1 }, { xml: slide2, rels: gxChartRel(1) + gxChartRel(2) }],
    media: { 'ppt/tableStyles.xml': tableStyles, 'ppt/charts/chart1.xml': chart1, 'ppt/charts/chart2.xml': chart2 },
  })
}

/**
 * 17 · graphics, broken parts — a malformed ppt/tableStyles.xml and a
 * malformed chart part must cost only what they hold, never the deck.
 *   s1-2  a table on Medium Style 2 (the built-in) — still imported.
 *   s1-3  a chart whose part is truncated XML — placeholder box.
 *   s1-4  a good chart — still imported.
 * Expected report: table-styles-unreadable, table-imported, chart-unreadable,
 * chart-imported.
 */
export function fxGraphicsBroken(): Promise<Uint8Array> {
  const good = gxSpace('<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>' + gxSer(0, 'A', [1, 2]) +
    '<c:axId val="10"/><c:axId val="20"/></c:barChart>' +
    '<c:catAx><c:axId val="10"/><c:axPos val="b"/><c:crossAx val="20"/></c:catAx>' +
    '<c:valAx><c:axId val="20"/><c:axPos val="l"/><c:crossAx val="10"/></c:valAx></c:plotArea>')
  const xml = slide(
    gxFrame(2, 'Table', 914400, 914400, 1828800, 762000,
      gxTable('{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}', [['H1', 'H2'], ['a', 'b']])) +
    gxFrame(3, 'Bad chart', 914400, 2743200, 3657600, 2743200, gxChartRef('rIdC1')) +
    gxFrame(4, 'Good chart', 5486400, 2743200, 3657600, 2743200, gxChartRef('rIdC2')))
  return buildPptx({
    slides: [{ xml, rels: gxChartRel(1) + gxChartRel(2) }],
    media: {
      'ppt/tableStyles.xml': '<a:tblStyleLst',
      'ppt/charts/chart1.xml': `<c:chartSpace xmlns:c="${NSC}"><c:chart>`,
      'ppt/charts/chart2.xml': good,
    },
  })
}

// --- importer follow-ups: alt text, crop, transitions, real lists -------------

const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
const NS_P159 = 'http://schemas.microsoft.com/office/powerpoint/2015/09/main'
const NS_ADEC = 'http://schemas.microsoft.com/office/drawing/2017/decorative'

/** A slide whose p:transition (or mc:AlternateContent around one) sits after
 *  cSld, where PowerPoint writes it. */
const trSlide = (body: string, transition: string): string =>
  `<p:sld ${XMLNS} xmlns:mc="${NS_MC}" xmlns:p14="${NS_P14}" xmlns:p159="${NS_P159}">` +
  `<p:cSld><p:spTree>${body}</p:spTree></p:cSld>${transition}</p:sld>`

/** p:pic with an optional cNvPr payload (attrs + extLst) and srcRect. */
const fuPic = (id: number, name: string, cnv: { attrs?: string; ext?: string }, x: number, y: number, w: number, h: number, srcRect = ''): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"${cnv.attrs ? ` ${cnv.attrs}` : ''}>${cnv.ext ?? ''}</p:cNvPr>` +
  '<p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
  `<p:blipFill><a:blip r:embed="rIdP"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
  `<p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

/** A text box around raw a:p paragraphs (lstStyle empty — bullets are the
 *  paragraphs' own). */
const fuText = (id: number, name: string, paras: string): string =>
  sp(id, name, `<p:spPr>${xfrm(914400, 914400, 5486400, 2743200)}</p:spPr>` +
    `<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody>`)
const fuP = (text: string, pPr = ''): string =>
  `<a:p>${pPr ? `<a:pPr${pPr}` : ''}<a:r><a:rPr lang="en-US" sz="1800"><a:latin typeface="Georgia"/></a:rPr><a:t>${text}</a:t></a:r></a:p>`

/**
 * 18 · importer follow-ups (scripts/test-convert/alt-crop.ts, transitions.ts,
 * lists.ts). Every EMU is a multiple of 9525 so the px are hand-computable.
 *
 *   slide 1 — pictures (no transition)
 *     s1-2 Photo     descr "A red bicycle" (+ a title, ignored); srcRect
 *                    l=10% t=20% r=30% → crop {0.1, 0.2, 0.6, 0.8}, fit cover
 *     s1-3 Deco      a16/adec decorative val=1 (and a descr) → alt ""
 *     s1-4 Logo      title "Company logo" only → alt from the title
 *     s1-5 Padded    srcRect l=r=-25% → no crop; the 288px box spans the
 *                    picture at -0.25..1.25, so it trims by 1/6 per side:
 *                    (0,192,288,96) → (48,192,192,96), fit fill
 *     s1-6 Bare      no description → alt absent
 *     s1-7 Chart     graphicFrame descr "Sales by region" → chart alt
 *   slide 2 — p:push dir="u" → push from the bottom
 *   slide 3 — mc: p14:prism Choice (unknown) + Fallback p:fade → fade
 *   slide 4 — mc: p159:morph Choice + Fallback fade → none, morph dropped
 *   slide 5 — p:split orient=vert → split, the default dir (absent)
 *   slide 6 — p:wipe dir="d" → wipe from the top
 *   slide 7 — p:cover dir="rd" → cover from the left, approximated
 *   slide 8 — mc: p14:vortex Choice, no Fallback → fade, approximated
 *   slide 9 — lists: nested bullets + numbers (requires rich-text); a
 *              second box numbers 1. / empty paragraph / 2.
 */
export function fxImportFollowups(): Promise<Uint8Array> {
  const decoExt = '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}">' +
    `<adec:decorative xmlns:adec="${NS_ADEC}" val="1"/></a:ext></a:extLst>`
  const chart = gxSpace('<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>' + gxSer(0, 'A', [1, 2]) +
    '<c:axId val="10"/><c:axId val="20"/></c:barChart>' +
    '<c:catAx><c:axId val="10"/><c:axPos val="b"/><c:crossAx val="20"/></c:catAx>' +
    '<c:valAx><c:axId val="20"/><c:axPos val="l"/><c:crossAx val="10"/></c:valAx></c:plotArea>')
  const chartFrame = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Chart" descr="Sales by region"/>' +
    '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="6096000" y="2743200"/><a:ext cx="3657600" cy="2743200"/></p:xfrm>' +
    `<a:graphic>${gxChartRef('rIdC1')}</a:graphic></p:graphicFrame>`
  const pics =
    fuPic(2, 'Photo', { attrs: 'descr="A red bicycle" title="Bike"' }, 914400, 914400, 1828800, 914400,
      '<a:srcRect l="10000" t="20000" r="30000"/>') +
    fuPic(3, 'Deco', { attrs: 'descr="leftover text"', ext: decoExt }, 3657600, 914400, 914400, 914400) +
    fuPic(4, 'Logo', { attrs: 'title="Company logo"' }, 5486400, 914400, 914400, 914400) +
    fuPic(5, 'Padded', {}, 0, 1828800, 2743200, 914400, '<a:srcRect l="-25000" r="-25000"/>') +
    fuPic(6, 'Bare', {}, 7315200, 914400, 914400, 914400) +
    chartFrame
  const box = sp(2, 'Box', `<p:spPr>${xfrm(914400, 914400, 914400, 457200)}</p:spPr>` +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody>')
  const alt = (choice: string, fallback?: string): string =>
    `<mc:AlternateContent><mc:Choice Requires="${choice.includes('p159:') ? 'p159' : 'p14'}">${choice}</mc:Choice>` +
    `${fallback ? `<mc:Fallback>${fallback}</mc:Fallback>` : ''}</mc:AlternateContent>`
  const lists = fuText(3, 'Body',
    fuP('Agenda') +
    fuP('First', '><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>') +
    fuP('Detail', ' lvl="1"><a:buFont typeface="Courier New"/><a:buChar char="o"/></a:pPr>') +
    fuP('Second', '><a:buFont typeface="Wingdings"/><a:buChar char="l"/></a:pPr>') +
    fuP('Step one', '><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
    fuP('Step two', '><a:buAutoNum type="arabicPeriod"/></a:pPr>'))
  // 1. / blank / 2.: an empty numbered paragraph neither shows a number nor
  // restarts the count
  const autoNum = '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'
  const gapped = fuText(4, 'Gapped',
    fuP('one', '><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
    `<a:p>${autoNum}<a:endParaRPr lang="en-US"/></a:p>` +
    fuP('two', '><a:buAutoNum type="arabicPeriod"/></a:pPr>'))
  return buildPptx({
    slides: [
      { xml: slide(pics), rels: `<Relationship Id="rIdP" Type="${REL}/image" Target="../media/photo.png"/>` + gxChartRel(1) },
      { xml: trSlide(box, '<p:transition spd="med"><p:push dir="u"/></p:transition>') },
      { xml: trSlide(box, alt('<p:transition spd="slow" p14:dur="1250"><p14:prism/></p:transition>',
        '<p:transition spd="slow"><p:fade/></p:transition>')) },
      { xml: trSlide(box, alt('<p:transition spd="slow" p14:dur="2000"><p159:morph option="byObject"/></p:transition>',
        '<p:transition spd="slow"><p:fade/></p:transition>')) },
      { xml: trSlide(box, '<p:transition><p:split orient="vert" dir="out"/></p:transition>') },
      { xml: trSlide(box, '<p:transition><p:wipe dir="d"/></p:transition>') },
      { xml: trSlide(box, '<p:transition><p:cover dir="rd"/></p:transition>') },
      { xml: trSlide(box, alt('<p:transition p14:dur="1000"><p14:vortex dir="r"/></p:transition>')) },
      { xml: slide(lists + gapped) },
    ],
    media: { 'ppt/media/photo.png': PNG_BYTES, 'ppt/charts/chart1.xml': chart },
  })
}

/**
 * 19 · charts, the second pass — horizontal bars and stacked lines/areas,
 * which charts-lite now draws (no more chart-bars-vertical /
 * chart-stack-dropped).
 *   s1-2  clustered HORIZONTAL bars (c:barDir bar), catAx on the left with
 *         title "Region" and c:orientation maxMin, valAx at the bottom with
 *         title "Sales" → yAxis category {name, inverse}, xAxis value {name},
 *         no dataZoom, nothing dropped.
 *   s1-3  STACKED line chart, markers off → two line series on one stack key.
 *   s1-4  100%-STACKED area chart → stacked line+areaStyle series, frozen to
 *         shares on a 0..100 % axis (chart-percent-frozen).
 *   s1-5  horizontal bars on TWO axis pairs (a stacked group + a clustered
 *         group on a secondary valAx) → one value axis, no yAxisIndex
 *         (chart-secondary-axis-merged).
 * Expected report: chart-imported, chart-percent-frozen,
 * chart-secondary-axis-merged.
 */
export function fxChartsMore(): Promise<Uint8Array> {
  const ax = (cat: number, val: number, catPos: string, valPos: string, catExtra = '', valExtra = '', orient = 'minMax'): string =>
    `<c:catAx><c:axId val="${cat}"/><c:scaling><c:orientation val="${orient}"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${catPos}"/>${catExtra}<c:crossAx val="${val}"/></c:catAx>` +
    `<c:valAx><c:axId val="${val}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${valPos}"/>${valExtra}<c:crossAx val="${cat}"/></c:valAx>`
  const ids = (a: number, b: number): string => `<c:axId val="${a}"/><c:axId val="${b}"/>`
  const noMarker = '<c:marker><c:symbol val="none"/></c:marker>'
  const chart1 = gxSpace('<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/>' +
    gxSer(0, 'A', [3, 5]) + gxSer(1, 'B', [4, 2]) + ids(10, 20) + '</c:barChart>' +
    ax(10, 20, 'l', 'b', gxRich('Region'), gxRich('Sales'), 'maxMin') + '</c:plotArea>' +
    '<c:legend><c:legendPos val="b"/></c:legend>')
  const chart2 = gxSpace('<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:lineChart><c:grouping val="stacked"/>' +
    gxSer(0, 'A', [1, 2], noMarker) + gxSer(1, 'B', [3, 4], noMarker) + ids(10, 20) + '</c:lineChart>' +
    ax(10, 20, 'b', 'l') + '</c:plotArea>')
  const chart3 = gxSpace('<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:areaChart><c:grouping val="percentStacked"/>' +
    gxSer(0, 'A', [1, 3]) + gxSer(1, 'B', [3, 1]) + ids(10, 20) + '</c:areaChart>' +
    ax(10, 20, 'b', 'l') + '</c:plotArea>')
  const chart4 = gxSpace('<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:overlap val="100"/>' +
    gxSer(0, 'A', [1, 2]) + ids(10, 20) + '</c:barChart>' +
    '<c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/>' +
    gxSer(1, 'B', [5, 6]) + ids(30, 40) + '</c:barChart>' +
    ax(10, 20, 'l', 'b') + ax(30, 40, 'r', 't') + '</c:plotArea>')
  const xml = slide(
    gxFrame(2, 'HBar', 914400, 914400, 3657600, 2743200, gxChartRef('rIdC1')) +
    gxFrame(3, 'Stacked line', 5486400, 914400, 3657600, 2743200, gxChartRef('rIdC2')) +
    gxFrame(4, 'Percent area', 914400, 3886200, 3657600, 2743200, gxChartRef('rIdC3')) +
    gxFrame(5, 'HBar two axes', 5486400, 3886200, 3657600, 2743200, gxChartRef('rIdC4')))
  return buildPptx({
    slides: [{ xml, rels: gxChartRel(1) + gxChartRel(2) + gxChartRel(3) + gxChartRel(4) }],
    media: {
      'ppt/charts/chart1.xml': chart1, 'ppt/charts/chart2.xml': chart2,
      'ppt/charts/chart3.xml': chart3, 'ppt/charts/chart4.xml': chart4,
    },
  })
}

export function allFixtures(): Array<{ name: string; build: () => Promise<Uint8Array> }> {
  return [
    { name: 'minimal', build: fxMinimal },
    { name: 'themed', build: fxThemed },
    { name: 'placeholder', build: fxPlaceholder },
    { name: 'group', build: fxGroup },
    { name: 'bullets', build: fxBullets },
    { name: 'svg', build: fxSvg },
    { name: 'connectors', build: fxConnectors },
    { name: 'structure', build: fxStructure },
    { name: 'layouts', build: fxLayouts },
    { name: 'chrome', build: fxChrome },
    { name: 'masters', build: () => fxMasters() },
    { name: 'masters-noobj', build: () => fxMasters({ noObj: true }) },
    { name: 'linking', build: fxLinking },
    { name: 'template-chrome', build: () => fxTemplateChrome() },
    { name: 'theme-majority', build: fxThemeMajority },
    { name: 'builds', build: fxBuilds },
    { name: 'animated-title', build: () => fxAnimatedTitle(true) },
    { name: 'graphics', build: fxGraphics },
    { name: 'graphics-more', build: fxGraphicsMore },
    { name: 'graphics-broken', build: fxGraphicsBroken },
    { name: 'import-followups', build: fxImportFollowups },
    { name: 'charts-more', build: fxChartsMore },
    { name: 'tables', build: fxTables },
  ]
}
