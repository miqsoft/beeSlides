// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Packages for drawingml-write.ts's shapes:
//
//   writeGvml  PowerPoint's clipboard format ("Art::GVML ClipFormat" on
//              Windows, com.microsoft.Art--GVML-ClipFormat on macOS): a small
//              OPC zip — [Content_Types].xml, _rels/.rels → clipboard/drawings/
//              drawing1.xml (one lc:lockedCanvas group), its rels (theme,
//              pictures, links), clipboard/theme/theme1.xml (a:clipboardTheme)
//              and clipboard/media/*. Laid out after what PowerPoint for Mac
//              writes itself; a package built this way pastes as native,
//              editable shapes (checked by hand 2026-10-23, DECISIONS).
//   writePptx  The smallest .pptx those shapes fit in: one master, one blank
//              layout, a theme and the slides. The rig reads it back through
//              convertPptx (the round trip); it is also where a .pptx export
//              starts.

import { writeZip, type ZipEntry } from './zip.ts'
import { REL_HYPERLINK, REL_IMAGE, concreteFace, esc, parseColor, writeDrawingML, type WElement, type WRel, type WMedia } from './drawingml-write.ts'

export interface ThemeIn {
  fontFamily?: string
  headingFamily?: string
  background?: string
  color?: string
  accent?: string
  palette?: Partial<Record<'bg2' | 'tx2' | 'accent2' | 'accent3' | 'accent4' | 'accent5' | 'accent6' | 'hlink' | 'folHlink', string>>
}

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** EMU per slide px for a slide `height` px tall, shown 7.5 in tall as PowerPoint's own 16:9 and 4:3 slides are. */
export const emuPerPxFor = (height: number): number => 6858000 / Math.max(1, height)

// ---- clipboard ---------------------------------------------------------------------

export interface GvmlResult { bytes: Uint8Array; warnings: string[] }

export async function writeGvml(elements: WElement[], o: { emuPerPx: number; theme?: ThemeIn }): Promise<GvmlResult> {
  const w = writeDrawingML(elements, { flavor: 'canvas', emuPerPx: o.emuPerPx, fontFamily: o.theme?.fontFamily })
  const b = w.box
  const drawing = XML +
    `<a:graphic xmlns:a="${NS_A}" xmlns:r="${NS_R}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas">` +
    `<lc:lockedCanvas xmlns:lc="http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas">` +
    `<a:nvGrpSpPr><a:cNvPr id="0" name=""/><a:cNvGrpSpPr/></a:nvGrpSpPr>` +
    `<a:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${b.w}" cy="${b.h}"/><a:chOff x="${b.x}" y="${b.y}"/><a:chExt cx="${b.w}" cy="${b.h}"/></a:xfrm></a:grpSpPr>` +
    w.xml + '</lc:lockedCanvas></a:graphicData></a:graphic>'
  const rels = relsXml([{ id: 'rId1', type: `${REL}/theme`, target: '../theme/theme1.xml' }, ...partRels(w.rels, '../media/')])
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: utf8(contentTypes(w.media, [
      ['/clipboard/drawings/drawing1.xml', 'application/vnd.openxmlformats-officedocument.drawing+xml'],
      ['/clipboard/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ])) },
    { name: '_rels/.rels', data: utf8(relsXml([{ id: 'rId1', type: `${REL}/drawing`, target: 'clipboard/drawings/drawing1.xml' }])) },
    { name: 'clipboard/drawings/drawing1.xml', data: utf8(drawing) },
    { name: 'clipboard/drawings/_rels/drawing1.xml.rels', data: utf8(rels) },
    { name: 'clipboard/theme/theme1.xml', data: utf8(themeXml('a:clipboardTheme', o.theme ?? {})) },
    ...w.media.map((m) => ({ name: `clipboard/media/${m.name}`, data: m.data })),
  ]
  return { bytes: await writeZip(entries), warnings: w.warnings }
}

// ---- .pptx -------------------------------------------------------------------------

export interface PptxSlideIn { elements: WElement[]; background?: string }

export async function writePptx(o: { size: { width: number; height: number }; slides: PptxSlideIn[]; theme?: ThemeIn; emuPerPx?: number }): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const epp = o.emuPerPx ?? emuPerPxFor(o.size.height)
  const cx = Math.round(o.size.width * epp), cy = Math.round(o.size.height * epp)
  const warnings = new Set<string>()
  const media: WMedia[] = []
  const slideParts: ZipEntry[] = []
  o.slides.forEach((sl, i) => {
    const n = i + 1
    const w = writeDrawingML(sl.elements, { flavor: 'slide', emuPerPx: epp, fontFamily: o.theme?.fontFamily })
    w.warnings.forEach((x) => warnings.add(x))
    // media names are per call; make them unique in the package
    const renamed = new Map<string, string>()
    for (const m of w.media) {
      const name = `s${n}-${m.name}`
      renamed.set(m.name, name)
      media.push({ ...m, name })
    }
    const bgc = parseColor(sl.background)
    const bg = bgc ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bgc.hex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : ''
    const xml = XML + `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld>${bg}<p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      w.xml + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    const rels = relsXml([
      { id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
      ...partRels(w.rels.map((r) => (r.type === 'image' ? { ...r, target: renamed.get(r.target) ?? r.target } : r)), '../media/'),
    ])
    slideParts.push({ name: `ppt/slides/slide${n}.xml`, data: utf8(xml) }, { name: `ppt/slides/_rels/slide${n}.xml.rels`, data: utf8(rels) })
  })
  const slideIds = o.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${3 + i}"/>`).join('')
  const presentation = XML + `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst>` +
    `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  const presRels = relsXml([
    { id: 'rId1', type: `${REL}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: `${REL}/theme`, target: 'theme/theme1.xml' },
    ...o.slides.map((_, i) => ({ id: `rId${3 + i}`, type: `${REL}/slide`, target: `slides/slide${i + 1}.xml` })),
  ])
  const emptyTree = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>'
  const master = XML + `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${emptyTree}</p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`
  const layout = XML + `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank">${emptyTree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: utf8(contentTypes(media, [
      ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
      ['/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
      ['/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
      ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
      ...o.slides.map((_, i): [string, string] => [`/ppt/slides/slide${i + 1}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml']),
    ])) },
    { name: '_rels/.rels', data: utf8(relsXml([{ id: 'rId1', type: `${REL}/officeDocument`, target: 'ppt/presentation.xml' }])) },
    { name: 'ppt/presentation.xml', data: utf8(presentation) },
    { name: 'ppt/_rels/presentation.xml.rels', data: utf8(presRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: utf8(master) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: utf8(relsXml([
      { id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: `${REL}/theme`, target: '../theme/theme1.xml' },
    ])) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: utf8(layout) },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: utf8(relsXml([{ id: 'rId1', type: `${REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml' }])) },
    { name: 'ppt/theme/theme1.xml', data: utf8(themeXml('a:theme', o.theme ?? {})) },
    ...slideParts,
    ...media.map((m) => ({ name: `ppt/media/${m.name}`, data: m.data })),
  ]
  return { bytes: await writeZip(entries), warnings: [...warnings] }
}

// ---- parts ---------------------------------------------------------------------------

interface RelIn { id: string; type: string; target: string; external?: boolean }

function partRels(rels: WRel[], mediaDir: string): RelIn[] {
  return rels.map((r) => r.type === 'image'
    ? { id: r.id, type: REL_IMAGE, target: mediaDir + r.target }
    : { id: r.id, type: REL_HYPERLINK, target: r.target, external: true })
}

function relsXml(rels: RelIn[]): string {
  return XML + `<Relationships xmlns="${NS_REL}">` +
    rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
    '</Relationships>'
}

function contentTypes(media: WMedia[], overrides: Array<[string, string]>): string {
  const exts = new Map<string, string>([['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml']])
  for (const m of media) exts.set(m.name.split('.').pop()!, m.contentType)
  return XML + `<Types xmlns="${NS_CT}">` +
    [...exts].map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join('') +
    overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('') +
    '</Types>'
}

/** A theme from the deck's colours and faces — `a:theme` for a .pptx, `a:clipboardTheme` for the clipboard. */
export function themeXml(root: 'a:theme' | 'a:clipboardTheme', t: ThemeIn): string {
  const hex = (css: string | undefined, d: string) => parseColor(css)?.hex ?? d
  const pal = t.palette ?? {}
  const slot = (name: string, v: string) => `<a:${name}><a:srgbClr val="${v}"/></a:${name}>`
  const clrScheme = '<a:clrScheme name="BeeSlides">' +
    slot('dk1', hex(t.color, '000000')) + slot('lt1', hex(t.background, 'FFFFFF')) +
    slot('dk2', hex(pal.tx2, hex(t.color, '1F2937'))) + slot('lt2', hex(pal.bg2, 'E5E7EB')) +
    slot('accent1', hex(t.accent, '2563EB')) + slot('accent2', hex(pal.accent2, 'F59E0B')) + slot('accent3', hex(pal.accent3, '10B981')) +
    slot('accent4', hex(pal.accent4, 'EF4444')) + slot('accent5', hex(pal.accent5, '8B5CF6')) + slot('accent6', hex(pal.accent6, '14B8A6')) +
    slot('hlink', hex(pal.hlink, '2563EB')) + slot('folHlink', hex(pal.folHlink, '7C3AED')) +
    '</a:clrScheme>'
  const body = concreteFace(t.fontFamily, 'Arial')
  const heading = concreteFace(t.headingFamily, body)
  const font = (tag: string, face: string) => `<a:${tag}><a:latin typeface="${esc(face)}"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`
  const fontScheme = `<a:fontScheme name="BeeSlides">${font('majorFont', heading)}${font('minorFont', body)}</a:fontScheme>`
  const ph = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const fmtScheme = '<a:fmtScheme name="BeeSlides">' +
    `<a:fillStyleLst>${ph}${ph}${ph}</a:fillStyleLst>` +
    `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}">${ph}</a:ln>`).join('')}</a:lnStyleLst>` +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${ph}${ph}${ph}</a:bgFillStyleLst>` +
    '</a:fmtScheme>'
  const elements = `<a:themeElements>${clrScheme}${fontScheme}${fmtScheme}</a:themeElements>`
  return root === 'a:theme'
    ? XML + `<a:theme xmlns:a="${NS_A}" name="BeeSlides">${elements}</a:theme>`
    : XML + `<a:clipboardTheme xmlns:a="${NS_A}">${elements}<a:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></a:clipboardTheme>`
}
