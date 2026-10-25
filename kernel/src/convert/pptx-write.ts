// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// A .pptx from drawingml-write.ts's shapes: slide masters, their layouts,
// the slides, speaker notes, sections and transitions — the other direction
// of pptx.ts. The caller (slides/src/editor/pptxexport.ts) decides what is
// a master, a layout and a slide; this file only spells it:
//
//   ppt/presentation.xml        masters, notes master, slides, size, sections
//   ppt/slideMasters/N          its shapes + slots (WPh.template), its own
//                               theme, text styles from its title/body slots
//   ppt/slideLayouts/N          one per layout, under its master
//   ppt/slides/N                shapes, slots filled (WPh), notes, transition
//   ppt/notesMasters, notesSlides, theme/N, media/, docProps/
//
// A slide with no layout lands on a blank layout under a plain master added
// for it, which is all the rig's small decks need. Pictures are stored once
// however many parts show them. Relationship ids: rId1 is a part's parent
// (a slide's layout, a layout's master; a master's layouts come first), the
// drawing's own start after them, rIdBg / rIdNotes are fixed names.

import { crc32, writeZip, type ZipEntry } from './zip.ts'
import { esc, gradFill, solidFill, writeDrawingML, type WElement, type WGradient, type WMedia, type WText } from './drawingml-write.ts'
import { NS_A, NS_P, NS_R, REL, XML, contentTypes, emuPerPxFor, partRels, relsXml, themeXml, utf8, type RelIn, type ThemeIn } from './opc.ts'

/** A background: a CSS colour, a linear gradient, or a picture (PNG) stretched over the slide. */
export type PptxFill = { color: string } | { gradient: WGradient } | { png: Uint8Array }

export interface PptxMasterIn {
  name: string
  /** decoration (drawn on every slide) and slots (`ph.template`) */
  elements: WElement[]
  background?: PptxFill
  /** its theme's colours and faces (default: the deck's) */
  theme?: ThemeIn
}

export interface PptxLayoutIn {
  name: string
  /** index into `masters` */
  master: number
  elements: WElement[]
  /** absent: the master's */
  background?: PptxFill
  /** false: the master's decoration stays off this layout's slides */
  masterShapes?: boolean
}

export interface PptxTransition {
  kind: 'fade' | 'push' | 'wipe' | 'cover' | 'split' | 'zoom' | 'morph'
  /** push/wipe/cover: the way the new slide MOVES (ST_TransitionSideDirectionType) */
  dir?: 'l' | 'r' | 'u' | 'd'
  /** split: the seam */
  orient?: 'horz' | 'vert'
}

export interface PptxSlideIn {
  elements: WElement[]
  /** absent: the layout's; a string is a CSS colour */
  background?: string | PptxFill
  /** index into `layouts`; absent: a blank layout */
  layout?: number
  /** speaker notes, plain text */
  notes?: string
  /** skipped in the show, still reachable by a jump */
  hidden?: boolean
  transition?: PptxTransition
  /** what its slide-number fields show until PowerPoint renumbers them */
  number?: string
}

export interface PptxIn {
  size: { width: number; height: number }
  slides: PptxSlideIn[]
  masters?: PptxMasterIn[]
  layouts?: PptxLayoutIn[]
  /** the deck's theme: every master's unless it has its own */
  theme?: ThemeIn
  emuPerPx?: number
  /** named slide groups, each from slide index `first` to the next one's */
  sections?: Array<{ name: string; first: number }>
  title?: string
}

/** The part a slide's jump (WBase.jump) names, for slide index `i`. */
export const slidePart = (i: number): string => `slide${i + 1}.xml`

const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
const NS_P159 = 'http://schemas.microsoft.com/office/powerpoint/2015/09/main'
const CT = 'application/vnd.openxmlformats-officedocument.presentationml'
const CLR_MAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'
const ROOT_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

export async function writePptx(o: PptxIn): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const epp = o.emuPerPx ?? emuPerPxFor(o.size.height)
  const cx = Math.round(o.size.width * epp), cy = Math.round(o.size.height * epp)
  const warnings = new Set<string>()
  const parts: ZipEntry[] = []
  const overrides: Array<[string, string]> = []
  const part = (name: string, xml: string, type?: string, rels?: RelIn[]) => {
    parts.push({ name, data: utf8(xml) })
    if (type) overrides.push([`/${name}`, type])
    if (rels) {
      const slash = name.lastIndexOf('/')
      parts.push({ name: `${name.slice(0, slash)}/_rels/${name.slice(slash + 1)}.rels`, data: utf8(relsXml(rels)) })
    }
  }

  // pictures: one file per distinct picture, however many parts show it
  const media: WMedia[] = []
  const byContent = new Map<string, string>()
  const store = (m: WMedia): string => {
    const key = `${m.data.length}:${crc32(m.data)}`
    let name = byContent.get(key)
    if (!name) {
      name = `image${media.length + 1}.${m.name.split('.').pop()}`
      byContent.set(key, name)
      media.push({ ...m, name })
    }
    return name
  }

  /** One part's drawing: its shapes, their relationships (media renamed into the package). */
  const drawing = (els: WElement[], firstRel: number, fontFamily: string | undefined, slideNumber?: string) => {
    const w = writeDrawingML(els, { flavor: 'slide', emuPerPx: epp, fontFamily, firstRel, slideNumber })
    w.warnings.forEach((x) => warnings.add(x))
    const local = new Map(w.media.map((m) => [m.name, store(m)]))
    const rels = partRels(w.rels.map((r) => (r.type === 'image' ? { ...r, target: local.get(r.target) ?? r.target } : r)), '../media/')
    return { xml: w.xml, rels }
  }
  const bgOf = (fill: PptxFill | undefined, rels: RelIn[]): string => {
    if (!fill) return ''
    let paint: string
    if ('png' in fill) {
      rels.push({ id: 'rIdBg', type: `${REL}/image`, target: `../media/${store({ name: 'bg.png', data: fill.png, contentType: 'image/png' })}` })
      paint = '<a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rIdBg"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill>'
    } else if ('gradient' in fill) paint = gradFill(fill.gradient)
    else paint = solidFill(fill.color)
    return paint === '<a:noFill/>' ? '' : `<p:bg><p:bgPr>${paint}<a:effectLst/></p:bgPr></p:bg>`
  }

  // masters and layouts, plus a plain master + blank layout for slides with none
  const masters = [...(o.masters ?? [])]
  const layouts = [...(o.layouts ?? [])]
  const needsPlain = o.slides.some((s) => s.layout === undefined || !layouts[s.layout]) || !masters.length
  let plainLayout = -1
  if (needsPlain) {
    masters.push({ name: 'Plain', elements: [] })
    plainLayout = layouts.push({ name: 'Blank', master: masters.length - 1, elements: [] }) - 1
  }
  // every master needs a layout of its own
  masters.forEach((_, m) => { if (!layouts.some((l) => l.master === m)) layouts.push({ name: 'Blank', master: m, elements: [] }) })

  // ids: masters and layouts share one range from 2^31
  let nextId = 2147483648
  const masterIds: number[] = [], layoutIds: number[] = []
  masters.forEach((_, mi) => {
    masterIds[mi] = nextId++
    layouts.forEach((l, li) => { if (l.master === mi) layoutIds[li] = nextId++ })
  })

  masters.forEach((m, mi) => {
    const n = mi + 1
    const own = layouts.map((l, li) => ({ l, li })).filter(({ l }) => l.master === mi)
    const theme = { ...o.theme, ...m.theme }
    const rels: RelIn[] = own.map(({ li }, k) => ({ id: `rId${k + 1}`, type: `${REL}/slideLayout`, target: `../slideLayouts/slideLayout${li + 1}.xml` }))
    rels.push({ id: `rId${own.length + 1}`, type: `${REL}/theme`, target: `../theme/theme${n}.xml` })
    const d = drawing(m.elements, own.length + 2, theme.fontFamily, '‹#›')
    rels.push(...d.rels)
    const bg = bgOf(m.background, rels) || '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
    const ids = own.map(({ li }, k) => `<p:sldLayoutId id="${layoutIds[li]}" r:id="rId${k + 1}"/>`).join('')
    part(`ppt/slideMasters/slideMaster${n}.xml`, XML +
      `<p:sldMaster ${ROOT_NS}><p:cSld name="${esc(m.name)}">${bg}<p:spTree>${GRP}${d.xml}</p:spTree></p:cSld>` +
      `<p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst>${ids}</p:sldLayoutIdLst>${txStyles(m.elements, epp)}</p:sldMaster>`,
    `${CT}.slideMaster+xml`, rels)
    part(`ppt/theme/theme${n}.xml`, themeXml('a:theme', theme), 'application/vnd.openxmlformats-officedocument.theme+xml')
  })

  layouts.forEach((l, li) => {
    const rels: RelIn[] = [{ id: 'rId1', type: `${REL}/slideMaster`, target: `../slideMasters/slideMaster${l.master + 1}.xml` }]
    const theme = { ...o.theme, ...masters[l.master].theme }
    const d = drawing(l.elements, 2, theme.fontFamily, '‹#›')
    rels.push(...d.rels)
    const bg = bgOf(l.background, rels)
    part(`ppt/slideLayouts/slideLayout${li + 1}.xml`, XML +
      `<p:sldLayout ${ROOT_NS}${l.masterShapes === false ? ' showMasterSp="0"' : ''} preserve="1" userDrawn="1">` +
      `<p:cSld name="${esc(l.name)}">${bg}<p:spTree>${GRP}${d.xml}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    `${CT}.slideLayout+xml`, rels)
  })

  // the notes master exists only when some slide has notes
  const withNotes = o.slides.map((s) => !!s.notes?.trim())
  const notesTheme = masters.length + 1
  if (withNotes.some(Boolean)) {
    part('ppt/notesMasters/notesMaster1.xml', notesMasterXml(cx, cy), `${CT}.notesMaster+xml`,
      [{ id: 'rId1', type: `${REL}/theme`, target: `../theme/theme${notesTheme}.xml` }])
    part(`ppt/theme/theme${notesTheme}.xml`, themeXml('a:theme', o.theme ?? {}), 'application/vnd.openxmlformats-officedocument.theme+xml')
  }

  o.slides.forEach((s, i) => {
    const n = i + 1
    const li = s.layout !== undefined && layouts[s.layout] ? s.layout : plainLayout
    const rels: RelIn[] = [{ id: 'rId1', type: `${REL}/slideLayout`, target: `../slideLayouts/slideLayout${li + 1}.xml` }]
    const theme = { ...o.theme, ...masters[layouts[li].master].theme }
    // a slot the layout does not have gives no frame to follow
    const slots = layouts[li].elements.filter((e) => e.ph)
    const els = s.elements.map((e) => e.ph?.inheritFrame && !slots.some((t) => t.ph!.type === e.ph!.type && t.ph!.idx === e.ph!.idx)
      ? { ...e, ph: { ...e.ph, inheritFrame: false } }
      : e)
    const d = drawing(els, 2, theme.fontFamily, s.number ?? String(n))
    rels.push(...d.rels)
    const bg = bgOf(typeof s.background === 'string' ? { color: s.background } : s.background, rels)
    if (withNotes[i]) {
      rels.push({ id: 'rIdNotes', type: `${REL}/notesSlide`, target: `../notesSlides/notesSlide${n}.xml` })
      part(`ppt/notesSlides/notesSlide${n}.xml`, notesSlideXml(s.notes!), `${CT}.notesSlide+xml`, [
        { id: 'rId1', type: `${REL}/notesMaster`, target: '../notesMasters/notesMaster1.xml' },
        { id: 'rId2', type: `${REL}/slide`, target: `../slides/slide${n}.xml` },
      ])
    }
    part(`ppt/slides/slide${n}.xml`, XML +
      `<p:sld ${ROOT_NS}${s.hidden ? ' show="0"' : ''}><p:cSld>${bg}<p:spTree>${GRP}${d.xml}</p:spTree></p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(s.transition)}</p:sld>`,
    `${CT}.slide+xml`, rels)
  })

  // the presentation
  const presRels: RelIn[] = masters.map((_, mi) => ({ id: `rId${mi + 1}`, type: `${REL}/slideMaster`, target: `slideMasters/slideMaster${mi + 1}.xml` }))
  const slideRel = (i: number) => `rId${masters.length + 1 + i}`
  o.slides.forEach((_, i) => presRels.push({ id: slideRel(i), type: `${REL}/slide`, target: `slides/slide${i + 1}.xml` }))
  presRels.push(
    { id: 'rIdTheme', type: `${REL}/theme`, target: 'theme/theme1.xml' },
    { id: 'rIdPresProps', type: `${REL}/presProps`, target: 'presProps.xml' },
    { id: 'rIdViewProps', type: `${REL}/viewProps`, target: 'viewProps.xml' },
    { id: 'rIdTableStyles', type: `${REL}/tableStyles`, target: 'tableStyles.xml' },
  )
  if (withNotes.some(Boolean)) presRels.push({ id: 'rIdNotesMaster', type: `${REL}/notesMaster`, target: 'notesMasters/notesMaster1.xml' })
  const masterIdLst = masters.map((_, mi) => `<p:sldMasterId id="${masterIds[mi]}" r:id="rId${mi + 1}"/>`).join('')
  const notesIdLst = withNotes.some(Boolean) ? '<p:notesMasterIdLst><p:notesMasterId r:id="rIdNotesMaster"/></p:notesMasterIdLst>' : ''
  const sldIdLst = o.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="${slideRel(i)}"/>`).join('')
  part('ppt/presentation.xml', XML +
    `<p:presentation ${ROOT_NS} saveSubsetFonts="1">` +
    `<p:sldMasterIdLst>${masterIdLst}</p:sldMasterIdLst>${notesIdLst}<p:sldIdLst>${sldIdLst}</p:sldIdLst>` +
    `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/>${sectionsXml(o.sections, o.slides.length)}</p:presentation>`,
  `${CT}.presentation.main+xml`, presRels)
  part('ppt/presProps.xml', XML + `<p:presentationPr ${ROOT_NS}/>`, `${CT}.presProps+xml`)
  part('ppt/viewProps.xml', XML + `<p:viewPr ${ROOT_NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`, `${CT}.viewProps+xml`)
  part('ppt/tableStyles.xml', XML + `<a:tblStyleLst xmlns:a="${NS_A}" def="{2D5ABB26-0587-4C30-8999-92F81FD0307C}"/>`, `${CT}.tableStyles+xml`)
  part('docProps/core.xml', XML +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${esc(o.title ?? '')}</dc:title></cp:coreProperties>`, 'application/vnd.openxmlformats-package.core-properties+xml')
  part('docProps/app.xml', XML +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>BeeSlides</Application></Properties>',
  'application/vnd.openxmlformats-officedocument.extended-properties+xml')

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: utf8(contentTypes(media, overrides)) },
    { name: '_rels/.rels', data: utf8(relsXml([
      { id: 'rId1', type: `${REL}/officeDocument`, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
      { id: 'rId3', type: `${REL}/extended-properties`, target: 'docProps/app.xml' },
    ])) },
    ...parts,
    ...media.map((m) => ({ name: `ppt/media/${m.name}`, data: m.data })),
  ]
  return { bytes: await writeZip(entries), warnings: [...warnings] }
}

// ---- parts ---------------------------------------------------------------------------

/** The master's text styles from its title and body slots: what PowerPoint
 *  gives text in a slot no layout styles, in the theme's faces. */
function txStyles(els: WElement[], epp: number): string {
  const slot = (t: string) => els.find((e): e is WText => e.type === 'text' && e.ph?.type === t)
  const hpt = (px: number) => Math.max(100, Math.min(400000, Math.round((px * epp) / 127)))
  const rPr = (el: WText | undefined, dflt: number, face: string) =>
    `<a:defRPr sz="${el ? hpt(el.fontSize) : dflt}"${el && (el.fontWeight ?? 400) >= 600 ? ' b="1"' : ''} kern="1200">` +
    `${el ? solidFill(el.color) : '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>'}<a:latin typeface="${face}"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>`
  const title = slot('title'), body = slot('body')
  const algn = (el: WText | undefined) => (el?.align === 'center' ? 'ctr' : el?.align === 'right' ? 'r' : 'l')
  const levels = [0, 1, 2, 3, 4].map((lv) => {
    const indent = 285750
    const bullet = lv ? `<a:buFont typeface="Arial"/><a:buChar char="${['•', '◦', '▪'][(lv - 1) % 3]}"/>` : '<a:buNone/>'
    return `<a:lvl${lv + 1}pPr marL="${lv * 2 * indent}"${lv ? ` indent="${-indent}"` : ' indent="0"'} algn="${algn(body)}">${bullet}${rPr(body, 2400 - lv * 200, '+mn-lt')}</a:lvl${lv + 1}pPr>`
  }).join('')
  return '<p:txStyles>' +
    `<p:titleStyle><a:lvl1pPr algn="${algn(title)}"><a:buNone/>${rPr(title, 4400, '+mj-lt')}</a:lvl1pPr></p:titleStyle>` +
    `<p:bodyStyle>${levels}</p:bodyStyle>` +
    `<p:otherStyle><a:lvl1pPr><a:defRPr kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle>` +
    '</p:txStyles>'
}

function transitionXml(t: PptxTransition | undefined): string {
  if (!t) return ''
  if (t.kind === 'morph') {
    return `<mc:AlternateContent xmlns:mc="${NS_MC}"><mc:Choice xmlns:p159="${NS_P159}" Requires="p159">` +
      '<p:transition spd="slow"><p159:morph option="byObject"/></p:transition></mc:Choice>' +
      '<mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>'
  }
  const fx = t.kind === 'split'
    ? `<p:split orient="${t.orient ?? 'horz'}" dir="out"/>`
    : t.kind === 'push' || t.kind === 'wipe' || t.kind === 'cover'
      ? `<p:${t.kind}${t.dir ? ` dir="${t.dir}"` : ''}/>`
      : `<p:${t.kind}/>`
  return `<p:transition spd="med">${fx}</p:transition>`
}

function sectionsXml(sections: PptxIn['sections'], count: number): string {
  const list = (sections ?? []).filter((s) => s.first >= 0 && s.first < count).sort((a, b) => a.first - b.first)
  if (!list.length) return ''
  // slides before the first section sit in PowerPoint's own unnamed one
  if (list[0].first > 0) list.unshift({ name: 'Default Section', first: 0 })
  const guid = (i: number) => `{8B3A9D10-6E2C-4F5B-9A1D-${i.toString(16).toUpperCase().padStart(12, '0')}}`
  const body = list.map((s, k) => {
    const end = k + 1 < list.length ? list[k + 1].first : count
    const ids = Array.from({ length: Math.max(0, end - s.first) }, (_, j) => `<p14:sldId id="${256 + s.first + j}"/>`).join('')
    return `<p14:section name="${esc(s.name)}" id="${guid(k)}"><p14:sldIdLst>${ids}</p14:sldIdLst></p14:section>`
  }).join('')
  return `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="${NS_P14}">${body}</p14:sectionLst></p:ext></p:extLst>`
}

/** The notes page: the slide's picture on top, the notes below, on a portrait 7.5 × 10 in page. */
function notesMasterXml(cx: number, cy: number): string {
  const w = 6096000, h = Math.round((w * cy) / cx)
  const img = { x: 381000, y: 685800, w, h: Math.min(h, 3429000) }
  return XML + `<p:notesMaster ${ROOT_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr><a:xfrm><a:off x="${img.x}" y="${img.y}"/><a:ext cx="${img.w}" cy="${img.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>' +
    `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/>` +
    '<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle>' +
    '</p:notesMaster>'
}

function notesSlideXml(text: string): string {
  const paras = text.replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(line)}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>')
    .join('')
  return XML + `<p:notes ${ROOT_NS}><p:cSld><p:spTree>${GRP}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
}
