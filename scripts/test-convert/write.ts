#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The DrawingML WRITER (kernel/src/convert/drawingml-write.ts, gvml.ts), read
// back by our own importer: a slide of every kind the writer makes natively
// goes out through writePptx and comes back through convertPptx, and every
// frame, colour, run and cell must survive. The clipboard package
// (writeGvml) is checked as a package: parts, rels, content types and a
// well-formed lockedCanvas drawing. parseRich and normalizePath get their own
// cases. That PowerPoint itself pastes the package as native shapes was
// checked by hand (DECISIONS 2026-10-23); this rig keeps the writer honest
// against the importer, not against PowerPoint.

import { deflateSync } from 'node:zlib'
import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import { readZip, crc32 } from '../../kernel/src/convert/zip.ts'
import { parseXml, kids, kid, attr, NS } from '../../kernel/src/convert/xml.ts'
import { writeGvml } from '../../kernel/src/convert/gvml.ts'
import { slidePart, writePptx, type PptxLayoutIn, type PptxSlideIn } from '../../kernel/src/convert/pptx-write.ts'
import { SLIDE_NUMBER, concreteFace, normalizePath, parseRich, type WElement, type WText } from '../../kernel/src/convert/drawingml-write.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string, detail?: unknown) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`) }
  else console.log(`  ok    ${msg}`)
}
const near = (a: number | undefined, b: number, tol = 1) => typeof a === 'number' && Math.abs(a - b) <= tol

/** A real 4×2 PNG: left half red, right half blue. */
function png(): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const b = new Uint8Array(12 + data.length)
    const v = new DataView(b.buffer)
    v.setUint32(0, data.length)
    b.set(new TextEncoder().encode(type), 4)
    b.set(data, 8)
    v.setUint32(8 + data.length, crc32(b.subarray(4, 8 + data.length)))
    return b
  }
  const ihdr = new Uint8Array(13)
  const iv = new DataView(ihdr.buffer)
  iv.setUint32(0, 4); iv.setUint32(4, 2); ihdr[8] = 8; ihdr[9] = 2
  const row = [0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]
  const raw = new Uint8Array([...row, ...row])
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const PNG = png()
const PNG_URI = 'data:image/png;base64,' + Buffer.from(PNG).toString('base64')

const base = { rotation: 0, opacity: 1 }
const ELEMENTS: WElement[] = [
  { ...base, id: 'title', type: 'text', x: 80, y: 40, w: 800, h: 80, html: 'Quarterly <b>results</b> <span style="color:#C2410C">2026</span>',
    fontSize: 48, fontFamily: 'Georgia, serif', fontWeight: 400, color: '#1D1119', align: 'left', valign: 'middle', lineHeight: 1.2 },
  { ...base, id: 'list', type: 'text', x: 80, y: 140, w: 500, h: 200,
    html: 'Intro line<ul><li>Revenue up <i>12%</i></li><li>Two <a href="https://example.com">markets</a><ul><li>Nested</li></ul></li></ul>',
    fontSize: 28, fontFamily: 'Helvetica, Arial, sans-serif', fontWeight: 700, color: '#333333', align: 'center', valign: 'top', lineHeight: 1.3 },
  { ...base, id: 'rect', type: 'shape', shape: 'rect', x: 640, y: 160, w: 300, h: 160, rotation: 15, fill: '#3B82F6', stroke: '#1E3A8A', strokeWidth: 6, radius: 16,
    shadow: { x: 8, y: 8, blur: 14, color: 'rgba(0,0,0,0.45)' } },
  { ...base, id: 'oval', type: 'shape', shape: 'ellipse', x: 980, y: 160, w: 200, h: 120, fill: '#F59E0B', stroke: '', strokeWidth: 0, radius: 0,
    fillGradient: { angle: 90, stops: [{ at: 0, color: '#F59E0B' }, { at: 1, color: '#EF4444' }] } },
  { ...base, id: 'tri', type: 'shape', shape: 'triangle', x: 80, y: 380, w: 120, h: 100, fill: '#10B981', stroke: '', strokeWidth: 0, radius: 0, opacity: 0.5 },
  { ...base, id: 'arrow', type: 'shape', shape: 'arrow', x: 240, y: 380, w: 200, h: 100, fill: '#8B5CF6', stroke: '', strokeWidth: 0, radius: 0 },
  { ...base, id: 'line', type: 'shape', shape: 'line', x: 480, y: 400, w: 240, h: 20, fill: '#111827', stroke: '', strokeWidth: 4, radius: 0, lineEnd: 'arrow', strokeStyle: 'dashed' },
  { ...base, id: 'path', type: 'shape', shape: 'path', x: 760, y: 380, w: 160, h: 160, fill: '#14B8A6', stroke: '#0F766E', strokeWidth: 2, radius: 0,
    d: 'M 10 50 A 40 40 0 1 1 90 50 Q 50 100 10 50 Z', pathBox: [0, 0, 100, 100] },
  { ...base, id: 'img', type: 'image', x: 960, y: 380, w: 200, h: 100, src: PNG_URI, fit: 'fill', crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, alt: 'blue half' },
  { ...base, id: 'tbl', type: 'table', x: 80, y: 500, w: 600, h: 180, header: true, columns: [{ w: 2 }, { w: 1 }, { w: 1 }],
    rows: [
      { cells: [{ html: 'Name' }, { html: 'Q1' }, { html: 'Q2' }] },
      { cells: [{ html: 'Merged <b>across</b>', colspan: 2 }, { html: '' }, { html: '7' }] },
      { cells: [{ html: 'Tall', rowspan: 2 }, { html: '3' }, { html: '4' }] },
      { cells: [{ html: '' }, { html: '5' }, { html: '6', bg: '#FDE68A' }] },
    ],
    style: { headerBg: '#1E3A8A', headerColor: '#FFFFFF', zebra: '#F3F4F6', borderColor: '#999999', borderWidth: 1, cellPadX: 8, cellPadY: 6, fontSize: 20, color: '#111111' } },
  { ...base, id: 'g1', type: 'shape', shape: 'rect', x: 760, y: 580, w: 80, h: 80, fill: '#EC4899', stroke: '', strokeWidth: 0, radius: 0, groupId: 'G' },
  { ...base, id: 'g2', type: 'shape', shape: 'ellipse', x: 860, y: 600, w: 60, h: 60, fill: '#6366F1', stroke: '', strokeWidth: 0, radius: 0, groupId: 'G' },
  { ...base, id: 'gone', type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#000000', stroke: '', strokeWidth: 0, radius: 0, hidden: true },
]

const SIZE = { width: 1280, height: 720 }
type Any = Record<string, any>

console.log('— round trip: writePptx → convertPptx')
const { bytes } = await writePptx({ size: SIZE, slides: [{ elements: ELEMENTS, background: '#FFF7E6' }], theme: { fontFamily: 'Inter, sans-serif', accent: '#2563EB' } })
const r = await convertPptx(bytes)
const els = (r.doc.slides[0]?.elements ?? []) as Any[]
const parts = await readZip(bytes)
const slideXml = new TextDecoder().decode(parts.get('ppt/slides/slide1.xml'))
const slideRels = new TextDecoder().decode(parts.get('ppt/slides/_rels/slide1.xml.rels'))
ok(r.doc.size.width === 1280 && r.doc.size.height === 720, 'slide size: 7.5 in tall, 1280 × 720 px back', r.doc.size)
ok(r.doc.slides[0]?.background?.toUpperCase() === '#FFF7E6', 'slide background', r.doc.slides[0]?.background)
ok(els.length === 12, '12 visible elements back; the hidden one is not written', els.length)
const [title, list, rect, oval, tri, arrow, line, path, img, tbl, g1, g2] = els

ok(title?.type === 'text' && title.x === 80 && title.y === 40 && title.w === 800 && title.h === 80, 'text: frame exact', title && [title.x, title.y, title.w, title.h])
ok(title?.html === 'Quarterly <b>results</b> 2026', 'text: bold run back (run colours the importer flattens)', title?.html)
ok(/<a:r><a:rPr [^>]*><a:solidFill><a:srgbClr val="C2410C"\/><\/a:solidFill>[^]*?<a:t>2026<\/a:t>/.test(slideXml), 'text: the coloured run is written with its own colour')
ok(near(title?.fontSize, 48, 0.5) && /^Georgia/.test(title?.fontFamily) && title?.valign === 'middle' && title?.lineHeight === 1.2, 'text: size 48 px, Georgia, middle, line height 1.2', title && [title.fontSize, title.fontFamily, title.valign, title.lineHeight])
ok(list?.html === 'Intro line<ul><li>Revenue up <i>12%</i></li><li>Two <u>markets</u><ul><li>Nested</li></ul></li></ul>', 'text: lines, bullets, nesting and italics back', list?.html)
ok(list?.fontWeight === 700 && list?.align === 'center' && list?.lineHeight === 1.3, 'text: bold box, centred, 1.3', list && [list.fontWeight, list.align, list.lineHeight])
ok(/Target="https:\/\/example.com" TargetMode="External"/.test(slideRels) && /<a:hlinkClick r:id="rId\d+"\/>/.test(slideXml), 'text: the link is a real hyperlink')

ok(rect?.shape === 'rect' && rect.x === 640 && rect.y === 160 && rect.w === 300 && rect.h === 160 && rect.rotation === 15, 'rect: frame and 15° rotation', rect && [rect.x, rect.y, rect.w, rect.h, rect.rotation])
ok(rect?.fill === '#3B82F6' && rect.stroke === '#1E3A8A' && rect.strokeWidth === 6 && rect.radius === 16, 'rect: fill, 6 px outline, 16 px corners', rect && [rect.fill, rect.stroke, rect.strokeWidth, rect.radius])
ok(near(rect?.shadow?.x, 8, 0.5) && near(rect?.shadow?.y, 8, 0.5) && near(rect?.shadow?.blur, 14, 0.5) && /0\.45/.test(rect?.shadow?.color ?? ''), 'rect: shadow', rect?.shadow)
ok(oval?.shape === 'ellipse' && oval.fillGradient?.angle === 90 && oval.fillGradient.stops.map((s: Any) => s.color).join() === '#F59E0B,#EF4444', 'ellipse: the gradient, angle 90', oval?.fillGradient)
ok(tri?.shape === 'triangle' && /^rgba\(16, ?185, ?129, ?0\.5\)$/.test(tri.fill), 'triangle: opacity carried in the fill', tri?.fill)
ok(arrow?.shape === 'arrow' && arrow.fill === '#8B5CF6', 'arrow: a native right arrow', arrow?.shape)
ok(line?.shape === 'line' && line.x === 480 && line.w === 240 && near(line.y + line.h / 2, 410, 0.5), 'line: through the middle of its box', line && [line.x, line.y, line.w, line.h])
ok(line?.strokeStyle === 'dashed' && line.lineEnd === 'arrow' && line.fill === '#111827' && line.strokeWidth === 4, 'line: dashed, arrow end, colour, width', line && [line.strokeStyle, line.lineEnd, line.fill, line.strokeWidth])
ok(path?.x === 760 && path.y === 380 && path.w === 160 && path.h === 160 && path.fill === '#14B8A6', 'path: frame and fill (the importer reads custom outlines as a box)', path && [path.x, path.w, path.fill])
ok(/<a:custGeom>[^]*<a:path w="100000" h="100000">[^]*<a:cubicBezTo>[^]*<a:close\/><\/a:path>/.test(slideXml), 'path: written as a custom outline with curves, in path units')
ok(img?.type === 'image' && img.alt === 'blue half' && img.crop?.x === 0.5 && img.crop?.w === 0.5 && img.fit === 'cover', 'image: crop and alt text', img && [img.crop, img.alt, img.fit])
ok([...parts.keys()].some((k) => /^ppt\/media\/image\d+\.png$/.test(k)), 'image: the PNG is in the package')
ok(tbl?.type === 'table' && tbl.columns.map((c: Any) => c.w).join() === '300,150,150', 'table: column widths 2 : 1 : 1', tbl?.columns)
const cells = tbl?.rows.map((row: Any) => row.cells.map((c: Any) => c.html))
ok(JSON.stringify(cells) === JSON.stringify([['Name', 'Q1', 'Q2'], ['Merged <b>across</b>', '', '7'], ['Tall', '3', '4'], ['', '5', '6']]), 'table: every cell back', cells)
ok(tbl?.rows[1].cells[0].colspan === 2 && tbl?.rows[2].cells[0].rowspan === 2, 'table: merged across and down')
ok(tbl?.rows[3].cells[2].bg === '#FDE68A', 'table: a cell colour override', tbl?.rows[3].cells[2])
const st = tbl?.style ?? {}
ok(st.headerBg === '#1E3A8A' && st.headerColor === '#FFFFFF' && st.zebra === '#F3F4F6' && st.borderColor === '#999999' && st.borderWidth === 1, 'table: header, zebra and border colours', st)
ok(st.cellPadX === 8 && st.cellPadY === 6 && near(st.fontSize, 20, 0.5) && st.color === '#111111', 'table: padding, text size and colour', st)
ok(g1?.groupId && g1.groupId === g2?.groupId && g1.x === 760 && g2.x === 860, 'group: both shapes back as one group, in place', [g1?.groupId, g2?.groupId])

console.log('— a deck: masters, layouts, filled slots, notes, sections, transitions')
{
  const text = (id: string, frame: [number, number, number, number], html: string, more: Partial<WText> = {}): WText => ({
    ...base, id, type: 'text', x: frame[0], y: frame[1], w: frame[2], h: frame[3], html,
    fontSize: 32, fontFamily: 'Georgia, serif', fontWeight: 400, color: '#1D1119', align: 'left', valign: 'top', ...more,
  })
  const TITLE: [number, number, number, number] = [80, 40, 1120, 100]
  const master: WElement[] = [
    { ...base, id: 'bar', type: 'shape', shape: 'rect', x: 0, y: 690, w: 1280, h: 30, fill: '#2563EB' },
    text('m-title', TITLE, 'Click to add title', { fontSize: 44, fontWeight: 700, ph: { type: 'title', template: true } }),
    text('m-body', [80, 160, 1120, 480], 'Click to add text', { ph: { type: 'body', idx: 1, template: true } }),
    text('m-ftr', [80, 650, 600, 30], 'Acme confidential', { fontSize: 14, ph: { type: 'ftr', idx: 11, template: true } }),
    text('m-num', [1100, 650, 100, 30], SLIDE_NUMBER, { fontSize: 14, align: 'right', ph: { type: 'sldNum', idx: 12, template: true } }),
  ]
  const layouts: PptxLayoutIn[] = [
    { name: 'Title', master: 0, elements: [
      text('t-title', [80, 250, 1120, 120], 'Click to add title', { fontSize: 60, align: 'center', ph: { type: 'title', template: true } }),
      text('t-sub', [80, 390, 1120, 60], 'Click to add subtitle', { align: 'center', ph: { type: 'subTitle', idx: 1, template: true } }),
    ] },
    { name: 'Content + picture', master: 0, background: { color: '#F8FAFC' }, elements: [
      { ...base, id: 'dot', type: 'shape', shape: 'ellipse', x: 1180, y: 40, w: 40, h: 40, fill: '#F59E0B' },
      text('c-title', TITLE, 'Click to add title', { fontSize: 44, ph: { type: 'title', template: true } }),
      text('c-body', [80, 160, 560, 480], 'Click to add text', { ph: { type: 'body', idx: 1, template: true } }),
      { ...base, id: 'c-pic', type: 'shape', shape: 'rect', x: 680, y: 160, w: 520, h: 480, fill: '#F5EEF1', stroke: '#DCCCD3', strokeWidth: 1.5, ph: { type: 'pic', idx: 2, template: true } },
    ] },
  ]
  const slides: PptxSlideIn[] = [
    { layout: 0, elements: [
      text('t-title', [80, 250, 1120, 120], 'Hello', { fontSize: 60, align: 'center', ph: { type: 'title', inheritFrame: true } }),
      text('t-sub', [80, 390, 1120, 60], '', { align: 'center', ph: { type: 'subTitle', idx: 1, inheritFrame: true } }),
    ] },
    { layout: 1, notes: 'Say hello\n\nThen the agenda & more', transition: { kind: 'push', dir: 'l' }, elements: [
      text('c-title', TITLE, 'Agenda', { fontSize: 44, ph: { type: 'title', inheritFrame: true } }),
      text('c-body', [80, 160, 560, 480], '<ul><li>One</li><li>Two</li></ul>', { ph: { type: 'body', idx: 1, inheritFrame: true } }),
      { ...base, id: 'c-pic', type: 'image', x: 680, y: 160, w: 520, h: 480, src: PNG_URI, fit: 'fill', ph: { type: 'pic', idx: 2, inheritFrame: true } },
      { ...base, id: 'back', type: 'shape', shape: 'rect', x: 80, y: 600, w: 120, h: 40, fill: '#111827', jump: slidePart(0), name: 'Back to start' },
      text('m-num', [1100, 650, 100, 30], `Page ${SLIDE_NUMBER}`, { fontSize: 14, align: 'right', ph: { type: 'sldNum', idx: 12, inheritFrame: true } }),
    ] },
    { layout: 1, hidden: true, transition: { kind: 'morph' }, elements: [
      text('c-title', [80, 60, 1120, 100], 'Backup', { fontSize: 44, ph: { type: 'title' } }),
    ] },
    { elements: [text('free', [100, 100, 400, 80], 'No slide type', { fontSize: 24 })], background: '#0F172A' },
  ]
  const deck = await writePptx({
    size: SIZE, slides, masters: [{ name: 'Brand', elements: master, background: { gradient: { angle: 180, stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: '#E0E7FF' }] } } }],
    layouts, theme: { fontFamily: 'Inter, sans-serif', headingFamily: 'Georgia, serif', accent: '#2563EB' },
    sections: [{ name: 'Intro', first: 0 }, { name: 'Main', first: 1 }], title: 'Rig deck',
  })
  // to open it in PowerPoint by hand: WRITE_RIG_PPTX=/path/deck.pptx
  if (process.env.WRITE_RIG_PPTX) (await import('node:fs')).writeFileSync(process.env.WRITE_RIG_PPTX, deck.bytes)
  const z = await readZip(deck.bytes)
  const txt = (n: string) => new TextDecoder().decode(z.get(n))
  const names = [...z.keys()]
  for (const n of ['ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/slideMaster2.xml', 'ppt/slideLayouts/slideLayout3.xml', 'ppt/theme/theme2.xml',
    'ppt/notesMasters/notesMaster1.xml', 'ppt/theme/theme3.xml', 'ppt/notesSlides/notesSlide2.xml', 'ppt/presProps.xml', 'docProps/core.xml']) ok(z.has(n), `part ${n}`)
  ok(!z.has('ppt/notesSlides/notesSlide1.xml'), 'no notes page for a slide without notes')
  // every XML part parses, every internal relationship lands, every part has a content type
  const xmlParts = names.filter((n) => /\.(xml|rels)$/.test(n))
  const bad = xmlParts.filter((n) => { try { parseXml(txt(n)); return false } catch { return true } })
  ok(!bad.length, 'every XML part is well-formed', bad)
  const dangling: string[] = []
  for (const n of names.filter((x) => x.endsWith('.rels'))) {
    const dir = n.replace(/_rels\/[^/]*\.rels$/, '')
    for (const m of txt(n).matchAll(/Target="([^"]+)"(?! TargetMode)/g)) {
      const parts = (dir + m[1]).split('/')
      const out: string[] = []
      for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p) }
      if (!z.has(out.join('/'))) dangling.push(`${n} → ${m[1]}`)
    }
  }
  ok(!dangling.length, 'every internal relationship points at a part that exists', dangling)
  const ct = txt('[Content_Types].xml')
  const untyped = names.filter((n) => n.endsWith('.xml') && n !== '[Content_Types].xml' && !ct.includes(`PartName="/${n}"`))
  ok(!untyped.length, 'every XML part has a content type', untyped)
  ok(names.filter((n) => n.startsWith('ppt/media/')).length === 1, 'a picture shown twice is stored once', names.filter((n) => n.startsWith('ppt/media/')))

  const m1 = txt('ppt/slideMasters/slideMaster1.xml')
  ok(/<p:ph type="title" hasCustomPrompt="1"\/>/.test(m1) && /<p:ph type="sldNum" idx="12"\/>/.test(m1), 'master: title and slide-number slots')
  ok(/<a:fld id="[^"]+" type="slidenum">[^]*?<a:t>‹#›<\/a:t><\/a:fld>/.test(m1), 'master: the slide number is PowerPoint’s field')
  ok(/<p:titleStyle><a:lvl1pPr algn="l"><a:buNone\/><a:defRPr sz="3300" b="1"/.test(m1), 'master: title style from its title slot (44 px = 33 pt, bold)')
  ok(/<p:bg><p:bgPr><a:gradFill/.test(m1), 'master: gradient background')
  const l3 = txt('ppt/slideLayouts/slideLayout2.xml')
  ok(/<p:cSld name="Content \+ picture">/.test(l3) && /<p:ph type="pic" idx="2"\/>/.test(l3), 'layout: named, with its picture slot')
  ok(!/DCCCD3/.test(l3), 'layout: the picture slot carries no border down to its pictures')
  ok(/<a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="l"><a:buNone\/><a:defRPr sz="2400" b="0">/.test(l3), 'layout: a text slot hands its look down (lstStyle)')
  const s1 = txt('ppt/slides/slide1.xml')
  ok(/<p:nvPr><p:ph type="title"\/><\/p:nvPr><\/p:nvSpPr><p:spPr><a:prstGeom/.test(s1), 'slide: a filled slot in the layout’s frame is written without one')
  ok(/<p:ph type="subTitle" idx="1"\/>/.test(s1), 'slide: an empty slot is kept (PowerPoint shows its prompt while editing)')
  const s2 = txt('ppt/slides/slide2.xml')
  ok(/<p:pic><p:nvPicPr><p:cNvPr [^>]*\/><p:cNvPicPr><a:picLocks noGrp="1" noChangeAspect="1"\/><\/p:cNvPicPr><p:nvPr><p:ph type="pic" idx="2"\/>/.test(s2), 'slide: the picture fills the picture slot')
  ok(/<p:cNvPr id="\d+" name="Back to start"><a:hlinkClick r:id="(rId\d+)" action="ppaction:\/\/hlinksldjump"\/>/.test(s2) &&
    /Type="[^"]*\/slide" Target="slide1.xml"/.test(txt('ppt/slides/_rels/slide2.xml.rels')), 'slide: a jump to another slide, by name')
  ok(/<a:t>Page <\/a:t><\/a:r><a:fld [^>]*type="slidenum">[^]*?<a:t>2<\/a:t><\/a:fld>/.test(s2), 'slide: "Page {{page}}" keeps the number as a field')
  ok(/<p:transition spd="med"><p:push dir="l"\/><\/p:transition>/.test(s2), 'slide: push transition')
  ok(/<p:ph type="sldNum" idx="12"\/><\/p:nvPr><\/p:nvSpPr><p:spPr><a:xfrm>/.test(s2), 'slide: a slot its layout lacks keeps its own frame')
  ok(/<a:t>Hello<\/a:t>/.test(s1) && /<a:rPr [^>]*b="0"[^>]*>(?:(?!<\/a:rPr>).)*<\/a:rPr><a:t>Hello/.test(s1), 'slide: a light title says so (the master’s bold title style must not leak in)')
  ok(/<p159:morph option="byObject"\/>/.test(txt('ppt/slides/slide3.xml')) && /<p:sld [^>]*show="0"/.test(txt('ppt/slides/slide3.xml')), 'slide: morph (with a fade fallback) and hidden')
  const pres = txt('ppt/presentation.xml')
  ok(/<p14:section name="Intro"[^>]*><p14:sldIdLst><p14:sldId id="256"\/><\/p14:sldIdLst>/.test(pres) && /name="Main"[^>]*><p14:sldIdLst><p14:sldId id="257"\/><p14:sldId id="258"\/><p14:sldId id="259"\/>/.test(pres), 'presentation: sections')
  ok((pres.match(/<p:sldMasterId /g) ?? []).length === 2, 'presentation: the brand master + a plain one for the slide with no type')

  // and back through our own importer: the tree, the links, the notes
  const back = await convertPptx(deck.bytes)
  const lay = (back.doc.layouts ?? []) as Any[]
  const brand = lay.find((l) => l.id === 'pptx-master-1')
  ok(!!brand && !brand.parentId, 'import: the master is a root slide type', lay.map((l) => [l.id, l.parentId, l.name]))
  const children = lay.filter((l) => l.parentId === 'pptx-master-1')
  ok(children.length === 2, 'import: both layouts come back under it', children.map((l) => l.name))
  const bs = back.doc.slides as Any[]
  ok(bs.length === 4 && bs[2].hidden === true, 'import: four slides, the third hidden', bs.map((s) => s.hidden))
  ok(bs[1].notes === 'Say hello\n\nThen the agenda & more', 'import: speaker notes', bs[1].notes)
  ok(bs[1].transition === 'push', 'import: the transition', bs[1].transition)
  const t0 = (bs[0].elements as Any[]).find((e) => e.role === 'title')
  ok(t0?.html === 'Hello' && t0.x === 80 && t0.y === 250, 'import: the filled title, in the layout’s frame', t0 && [t0.html, t0.x, t0.y])
  ok(bs.slice(0, 2).every((s) => !!s.layoutId), 'import: slides on a layout come back linked to it', bs.map((s) => s.layoutId))
  ok(deck.warnings.length === 0, 'no warnings', deck.warnings)
}

console.log('— the clipboard package (writeGvml)')
{
  const g = await writeGvml(ELEMENTS, { emuPerPx: 9525, theme: { fontFamily: 'Inter, sans-serif' } })
  const z = await readZip(g.bytes)
  const text = (n: string) => new TextDecoder().decode(z.get(n))
  const names = [...z.keys()]
  ok(names[0] === '[Content_Types].xml', '[Content_Types].xml is the first part', names[0])
  for (const n of ['_rels/.rels', 'clipboard/drawings/drawing1.xml', 'clipboard/drawings/_rels/drawing1.xml.rels', 'clipboard/theme/theme1.xml', 'clipboard/media/image1.png']) ok(z.has(n), `part ${n}`)
  const ct = text('[Content_Types].xml')
  ok(/Extension="png" ContentType="image\/png"/.test(ct) && /PartName="\/clipboard\/drawings\/drawing1.xml"/.test(ct) && /PartName="\/clipboard\/theme\/theme1.xml"/.test(ct), 'content types cover the drawing, theme and pictures')
  const rels = text('clipboard/drawings/_rels/drawing1.xml.rels')
  const targets = [...rels.matchAll(/Target="([^"]+)"(?! TargetMode)/g)].map((m) => m[1])
  ok(targets.every((t) => z.has(('clipboard/drawings/' + t).replace(/[^/]+\/\.\.\//g, ''))), 'every internal relationship points at a part that exists', targets)
  ok(/Id="rId1" Type="[^"]*\/theme"/.test(rels) && /TargetMode="External"/.test(rels), 'rId1 is the theme; the link is external')
  const doc = parseXml(text('clipboard/drawings/drawing1.xml'))
  const gd = kid(doc, NS.a, 'graphicData')
  const canvas = gd && kids(gd)[0]
  ok(doc.local === 'graphic' && attr(gd!, 'uri') === 'http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas' && canvas?.local === 'lockedCanvas', 'a:graphic › a:graphicData › lc:lockedCanvas')
  const shapes = canvas ? kids(canvas).filter((k) => !['nvGrpSpPr', 'grpSpPr'].includes(k.local)) : []
  ok(shapes.map((s) => s.local).join() === 'sp,sp,sp,sp,sp,sp,sp,sp,pic,graphicFrame,grpSp', 'canvas: 8 shapes, a picture, a table and a group, in z-order', shapes.map((s) => s.local))
  ok(shapes.every((s) => s.ns === NS.a), 'canvas: every node in the a: namespace (no p:)')
  ok(!/<p:/.test(text('clipboard/drawings/drawing1.xml')) && /<a:txSp><a:txBody>/.test(text('clipboard/drawings/drawing1.xml')), 'canvas: text sits in a:txSp')
  const grp = kid(canvas!, NS.a, 'grpSpPr')
  const chOff = grp && kid(kid(grp, NS.a, 'xfrm')!, NS.a, 'chOff')
  ok(chOff && attr(chOff, 'x') === String(80 * 9525) && attr(chOff, 'y') === String(40 * 9525), 'canvas: the group starts at the selection’s top-left', chOff && [attr(chOff, 'x'), attr(chOff, 'y')])
  const theme = parseXml(text('clipboard/theme/theme1.xml'))
  ok(theme.local === 'clipboardTheme' && !!kid(theme, NS.a, 'clrMap') && /typeface="Inter"/.test(text('clipboard/theme/theme1.xml')), 'theme: a:clipboardTheme with a colour map and the deck’s face')
  ok(g.warnings.length === 0, 'no warnings for natively written kinds', g.warnings)
}

console.log('— parseRich')
{
  const lines = (h: string) => parseRich(h).map((p) => (p.list ? `${p.list.ordered ? '#' : '*'}${p.list.level}:` : '') + p.runs.map((r) => (r.br ? '⏎' : r.text)).join(''))
  const eqs = (h: string, want: string[]) => ok(JSON.stringify(lines(h)) === JSON.stringify(want), `parseRich ${JSON.stringify(h)}`, lines(h))
  eqs('A<br>B', ['A', 'B'])
  eqs('<br>B', ['', 'B'])
  eqs('A<br>', ['A'])
  eqs('A<br><br><ul><li>x</li></ul>', ['A', '', '*0:x'])
  eqs('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>after', ['*0:a', '*1:b', '*0:c', 'after'])
  eqs('<ol><li>one<br>more</li></ol>', ['#0:one⏎more'])
  eqs('<div>A</div><div><br></div><div>B</div>', ['A', '', 'B'])
  eqs('&lt;tag&gt; &amp; x&nbsp;y &#8364;', ['<tag> & x\u00a0y €'])
  const runs = parseRich('<b>B<i>BI</i></b><span style="color:#FF0000;font-size:2em">R</span>')[0].runs
  ok(runs[0].bold && !runs[0].italic && runs[1].bold && runs[1].italic && runs[2].color === '#FF0000' && runs[2].size?.(10) === 20, 'parseRich: nested formatting and span colour/size')
}

console.log('— concreteFace')
{
  ok(concreteFace('Georgia, serif', 'X') === 'Georgia' && concreteFace('"Open Sans", sans-serif', 'X') === 'Open Sans', 'a named face is kept (quotes dropped)')
  ok(concreteFace('-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'Arial') === 'Arial' && concreteFace('system-ui', 'Arial') === 'Arial', 'a system-UI stack takes the fallback, never a browser alias')
  ok(concreteFace('serif', 'X') === 'Times New Roman' && concreteFace('monospace', 'X') === 'Courier New' && concreteFace('', 'X') === 'X', 'generic families get a concrete stand-in')
}

console.log('— normalizePath')
{
  const segs = normalizePath('M0 0 L10 0 l0 10 h-10 z')
  ok(JSON.stringify(segs) === JSON.stringify([{ c: 'M', p: [0, 0] }, { c: 'L', p: [10, 0] }, { c: 'L', p: [10, 10] }, { c: 'L', p: [0, 10] }, { c: 'Z', p: [] }]), 'relative lines and H/V become absolute lineTos', segs)
  const arc = normalizePath('M 0 0 A 10 10 0 0 1 10 10')
  ok(arc?.length === 2 && arc[1].c === 'C' && arc[1].p[4] === 10 && arc[1].p[5] === 10, 'a quarter arc is one cubic that lands on its end', arc)
  const big = normalizePath('M 10 50 A 40 40 0 1 1 90 50')
  ok(!!big && big.length >= 3 && big.slice(1).every((s) => s.c === 'C'), 'a large arc becomes several cubics', big?.length)
  const quad = normalizePath('M0 0 Q 5 10 10 0 T 20 0')
  ok(quad?.length === 3 && quad[2].p[0] === 10 + (2 / 3) * 5 && near(quad[2].p[1], -20 / 3, 1e-9), 'Q/T become cubics (T reflects the control point)', quad)
  ok(normalizePath('M 0 0 X 5') === null && normalizePath('') === null, 'an unreadable path is null')
  const implicit = normalizePath('M0 0 10 10 20 0')
  ok(implicit?.map((s) => s.c).join('') === 'MLL', 'pairs after M are lineTos', implicit)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
