// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slides/src/iconset.ts — icon sets (DECISIONS "Icon sets"): the new doc, the
// "Apply set style" patch, one icon → SVG in grid units, file names, the
// icons.json manifest and how a folder source matches it. Run (bundled):
//   slides/node_modules/.bin/esbuild scripts/test-iconset.ts --bundle --platform=node --format=esm --outfile=/tmp/t.mjs && node /tmp/t.mjs
import { newIconsetDoc, defaultShape, type ShapeElement, type SlidomingoDoc } from '../slides/src/model.ts'
import {
  addIconNames,
  iconFileNames, iconManifest, iconSlideSvg, iconStylePatch, iconsetInfo, iconsToDraw, iconSlug, isNoPaint,
  manifestMatches, parseIconManifest, ICON_CANVASES, iconCanvasId, iconCanvasUnits, resizeIconCanvas, translatePathD,
} from '../slides/src/iconset.ts'
import { sanitizeSlide } from '../slides/src/untrusted.ts'

let checks = 0, failures = 0
const ok = (c: boolean, m: string, d?: unknown) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.log(`  FAIL  ${m}${d === undefined ? '' : ' — ' + JSON.stringify(d)}`) } }

const path = (doc: SlidomingoDoc, d: string, over: Partial<ShapeElement> = {}): ShapeElement => ({
  ...(defaultShape('path') as ShapeElement),
  x: 0, y: 0, w: doc.size.width, h: doc.size.height,
  d, pathBox: [0, 0, 24, 24], fill: 'transparent', stroke: '#000000', strokeWidth: 32, strokeCap: 'round', strokeJoin: 'round',
  ...over,
})

console.log('-- a new icon set')
const doc = newIconsetDoc({ names: ['Fingerprint', ' evidence bag ', ''], brief: 'forensics, outline' })
ok(doc.kind === 'iconset' && doc.slides.length === 2, 'one slide per non-empty name', doc.slides.map((s) => s.name))
ok(doc.slides[1].name === 'evidence bag', 'names are trimmed')
ok(doc.size.width === 384 && doc.size.height === 384 && doc.iconset?.scale === 16, '24 grid at 16 px per unit = 384 px square', doc.size)
ok(doc.iconset?.brief === 'forensics, outline', 'brief kept')
ok(doc.theme.styleDefaults?.shape?.strokeWidth === 32 && doc.theme.styleDefaults?.shape?.fill === 'transparent', 'new shapes start as 2-unit outlines')
ok(newIconsetDoc().slides.length === 1, 'no names → one icon')
const info = iconsetInfo(doc)!
ok(info.style.cap === 'round' && info.style.padding === 2, 'defaults filled in')
ok(iconsetInfo({ ...doc, kind: undefined }) === null, 'a deck is not an icon set')

console.log('-- apply set style')
const drift = path(doc, 'M2 2 L22 22', { stroke: '#333333', strokeWidth: 20, strokeCap: 'butt', strokeJoin: undefined })
const p = iconStylePatch(drift, info)
ok(p?.stroke === '#000000' && p?.strokeWidth === 32 && p?.strokeCap === 'round' && p?.strokeJoin === 'round', 'stroke, width, cap and join follow the set', p)
ok(p?.fill === undefined, 'an unfilled path stays unfilled')
ok(iconStylePatch(path(doc, 'M0 0'), info) === null, 'nothing to change → null')
const dot = { ...(defaultShape('ellipse') as ShapeElement), fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 }
const dp = iconStylePatch(dot, info)
ok(dp?.fill === '#000000' && dp?.stroke === undefined, 'a filled dot keeps its fill, in ink; no stroke added', dp)
const line = { ...(defaultShape('line') as ShapeElement), fill: '#123456', strokeWidth: 4 }
const lp = iconStylePatch(line, info)
ok(lp?.fill === '#000000' && lp?.strokeWidth === 32 && lp?.strokeCap === 'round', 'a line is painted with its fill', lp)

console.log('-- one icon → svg')
doc.slides[0].elements = [path(doc, 'M12 2a10 10 0 1 0 0 20'), { ...path(doc, 'M4 4 L8 8'), id: 'p2', hidden: true }]
const a = iconSlideSvg(doc, doc.slides[0], { title: true })
ok(a.svg.includes('viewBox="0 0 24 24"') && a.svg.includes('width="24" height="24"'), '24 × 24 in grid units')
ok(a.svg.includes('d="M12 2a10 10 0 1 0 0 20"'), 'a path drawn on the grid keeps its own d (arcs and all)', a.svg)
ok(a.svg.includes('stroke="currentColor"') && a.svg.includes('stroke-width="2"'), 'ink → currentColor, 32 px → 2 units', a.svg)
ok(a.svg.includes('stroke-linecap="round"') && a.svg.includes('stroke-linejoin="round"'), 'caps and joins written')
ok(!a.svg.includes('M4 4'), 'a hidden element is left out')
ok(a.svg.includes('<title>Fingerprint</title>'), 'title from the slide name')

// a path moved and scaled on the canvas: d is rewritten in grid units
doc.slides[1].elements = [path(doc, 'M0 0 L24 24', { x: 64, y: 64, w: 192, h: 192 })]
const b = iconSlideSvg(doc, doc.slides[1])
ok(/d="M 4 4 L 16 16"/.test(b.svg), 'a placed path is transformed into the grid', b.svg)
// a rect drawn by hand: stroke inset like the canvas
const rect = { ...(defaultShape('rect') as ShapeElement), x: 32, y: 32, w: 320, h: 320, radius: 0, fill: 'transparent', stroke: '#000', strokeWidth: 32 }
doc.slides[1].elements = [rect, { ...(defaultShape('rect') as ShapeElement), id: 'fill', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, x: 0, y: 0, w: 16, h: 16 }]
const c = iconSlideSvg(doc, doc.slides[1])
ok(c.svg.includes('d="M 3 3 L 21 3 L 21 21 L 3 21 Z"'), 'rect → path, stroke inset by half its width', c.svg)
ok(c.svg.includes('fill="#ff0000"'), 'a colour that is not the ink stays literal')
// rotated 90°: the box's corners swap
doc.slides[1].elements = [path(doc, 'M0 12 L24 12', { rotation: 90 })]
ok(/d="M 12 0 L 12 24"/.test(iconSlideSvg(doc, doc.slides[1]).svg), 'rotation is baked into the points')
doc.slides[1].elements = [path(doc, 'M0 0 L12 0', { flipH: true })]
ok(/d="M 24 0 L 12 0"/.test(iconSlideSvg(doc, doc.slides[1]).svg), 'a flip mirrors inside the box')
// non-shapes are reported, not drawn
doc.slides[1].elements = [{ id: 't', type: 'text', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, html: 'x' } as never]
const d = iconSlideSvg(doc, doc.slides[1])
ok(d.skipped.includes('text') && !d.svg.includes('<path'), 'text is skipped and reported', d)
// hostile strings from an opened file never break out of an attribute
doc.slides[1].elements = [path(doc, 'M0 0"/><script>alert(1)</script>', { stroke: 'red" onload="x' })]
const e = iconSlideSvg(doc, doc.slides[1])
ok(!e.svg.includes('<script') && !e.svg.includes('" onload'), 'attribute values are escaped', e.svg)

console.log('-- paints')
ok(isNoPaint('transparent') && isNoPaint('#00000000') && isNoPaint('rgba(0,0,0,0)') && isNoPaint(undefined), 'no-paint forms')
ok(!isNoPaint('#000') && !isNoPaint('rgba(0,0,0,0.5)'), 'real paints')

console.log('-- names and manifest')
ok(iconSlug('Chain of Custody!') === 'chain-of-custody' && iconSlug('Ünïcode') === 'unicode' && iconSlug('***') === 'icon', 'slugs')
const files = iconFileNames([{ name: 'Hash' }, { name: 'hash' }, {}, { name: 'Hash' }] as never)
ok(JSON.stringify(files) === JSON.stringify(['hash.svg', 'hash-2.svg', 'icon-3.svg', 'hash-3.svg']), 'unique file names in slide order', files)
doc.slides[0].icon = { keywords: ['print', ' finger ', ''] }
doc.iconset!.license = 'CC-BY-4.0'
doc.title = 'Forensics'
const man = iconManifest(doc, iconFileNames(doc.slides))
ok(man.format === 'slidomingo-icons' && man.license === 'CC-BY-4.0' && man.name === 'Forensics', 'manifest header', man)
ok(JSON.stringify(man.icons[0]) === JSON.stringify({ file: 'fingerprint.svg', name: 'Fingerprint', keywords: ['print', 'finger'] }), 'entry with trimmed keywords', man.icons[0])
ok(!('keywords' in man.icons[1]), 'no keywords → none written')
const parsed = parseIconManifest(JSON.stringify(man))
ok(parsed.get('fingerprint.svg')?.license === 'CC-BY-4.0', 'set licence carried to each entry')
ok(manifestMatches('finger', 'fingerprint.svg', parsed.get('fingerprint.svg')), 'match by file name')
ok(manifestMatches('print', 'x.svg', parsed.get('fingerprint.svg')), 'match by keyword')
ok(!manifestMatches('bag', 'fingerprint.svg', parsed.get('fingerprint.svg')), 'no false hit')
ok(parseIconManifest('not json').size === 0 && parseIconManifest('{"icons":[{"file":3},null,{"file":"a.svg","keywords":"x"}]}').size === 1, 'malformed manifests degrade, never throw')

console.log('-- what to draw')
const set = newIconsetDoc({ names: ['a', 'b', 'c'] })
set.slides[0].elements = [path(set, 'M0 0')]
ok(iconsToDraw(set, [set.slides[0].id]).map((s) => s.name).join() === 'b,c', 'one selected → every empty icon')
ok(iconsToDraw(set, [set.slides[0].id, set.slides[1].id]).map((s) => s.name).join() === 'a,b', 'several selected → exactly those')

console.log('-- paste keeps the per-icon fields')
const pasted = sanitizeSlide({ id: 's1', elements: [], icon: { keywords: ['x', 'y'], prompt: 'a magnifier over a disk' } })
ok(JSON.stringify(pasted?.icon) === JSON.stringify({ keywords: ['x', 'y'], prompt: 'a magnifier over a disk' }), 'icon survives untrusted.ts', pasted?.icon)

// Add icons: a blank starter takes the first name, names are not added twice, the rest go in at `at`
{
  const d = newIconsetDoc()
  const starter = d.slides[0].id
  const r1 = addIconNames(d, ['fingerprint', ' hash ', '', 'Fingerprint'], 1)
  ok(d.slides.map((s) => s.name).join() === 'fingerprint,hash' && d.slides[0].id === starter && r1.added === 2,
    'the blank starter is named first; empty and same-name (any case) entries add nothing', d.slides.map((s) => s.name))
  ok(r1.slideIds.length === 3 && r1.slideIds[2] === starter, 'every given name reports its icon, the existing one too', r1.slideIds)
  const r2 = addIconNames(d, ['lock', 'key'], 1)
  ok(d.slides.map((s) => s.name).join() === 'fingerprint,lock,key,hash' && r2.added === 2, 'new icons go in at `at`, in order', d.slides.map((s) => s.name))
}

console.log('-- the canvas aspect ratio')
{
  ok(translatePathD('M12 2a10 10 0 1 0 0 20', 4, 1) === 'M16 3a10 10 0 1 0 0 20', 'relative commands stay; the absolute start moves', translatePathD('M12 2a10 10 0 1 0 0 20', 4, 1))
  ok(translatePathD('M2 2 H22 V10 L4 4 4 8 Z', 4, 0) === 'M6 2H26V10L8 4 8 8Z', 'H moves x, V keeps y, implicit L pairs move too', translatePathD('M2 2 H22 V10 L4 4 4 8 Z', 4, 0))
  ok(translatePathD('M1 1A5 5 30 0 1 9 9', 2, 3) === 'M3 4A5 5 30 0 1 11 12', 'an arc keeps radii, rotation and flags; its end moves', translatePathD('M1 1A5 5 30 0 1 9 9', 2, 3))
  ok(translatePathD('m2 2 l1 1 3 3', 1, 1) === 'm3 3l1 1 3 3', 'a leading m is absolute, its pairs after are not', translatePathD('m2 2 l1 1 3 3', 1, 1))
  ok(translatePathD('M2 2 4 4', 1, 1) === 'M3 3 5 5', 'pairs after M are absolute linetos', translatePathD('M2 2 4 4', 1, 1))
  ok(translatePathD('M0.5.5L1e1 2', 1, 0) === 'M1.5 0.5L11 2', 'packed numbers and exponents parse', translatePathD('M0.5.5L1e1 2', 1, 0))

  const d = newIconsetDoc({ names: ['a'] })
  const sq = iconsetInfo(d)!
  ok(sq.gridH === 24 && d.iconset?.gridH === undefined && iconCanvasId(sq) === '1:1', 'a new set is square and stores no gridH')
  const onGrid = path(d, 'M12 2a10 10 0 1 0 0 20', { id: 'g' })
  const box = { ...(defaultShape('rect') as ShapeElement), id: 'r', x: 32, y: 48, w: 64, h: 64 }
  d.slides[0].elements = [onGrid, box]
  d.slides[0].comments = [{ id: 'c', author: '', text: 'x', at: '', x: 100, y: 100 } as never]
  ok(resizeIconCanvas(d, 32, 24) && d.size.width === 512 && d.size.height === 384 && d.iconset?.grid === 32 && d.iconset?.gridH === 24,
    '4:3 → 32 × 24 units, 512 × 384 px', { size: d.size, iconset: d.iconset })
  const g = d.slides[0].elements[0] as ShapeElement
  ok(g.x === 0 && g.w === 512 && g.h === 384 && g.pathBox?.join() === '0,0,32,24' && g.d === 'M16 2a10 10 0 1 0 0 20',
    'a path on the whole canvas stays on it, its d moved 4 units (arcs kept)', g)
  const r = d.slides[0].elements[1]
  ok(r.x === 96 && r.y === 48 && r.w === 64, 'any other shape moves by the centre shift, same size', r)
  ok(d.slides[0].comments![0].x === 164, 'a pinned comment moves with it')
  const wide = iconSlideSvg(d, d.slides[0])
  ok(wide.svg.includes('width="32" height="24" viewBox="0 0 32 24"') && wide.svg.includes('d="M16 2a10 10 0 1 0 0 20"'), 'the export is 32 × 24 and keeps the path', wide.svg)
  const man = iconManifest(d, ['a.svg'])
  ok(man.grid === 32 && man.gridH === 24, 'icons.json says the size', man)
  ok(iconCanvasId(iconsetInfo(d)!) === '4:3', 'the preset is recognised')
  ok(!resizeIconCanvas(d, 32, 24), 'the same size changes nothing')
  ok(resizeIconCanvas(d, 24, 24) && d.iconset?.gridH === undefined && (d.slides[0].elements[0] as ShapeElement).d === 'M12 2a10 10 0 1 0 0 20' && d.slides[0].elements[1].x === 32,
    'back to square: gridH dropped, everything back where it was', d.slides[0].elements)
  ok(ICON_CANVASES.every((c) => { const u = iconCanvasUnits(sq, c.id); return u.w === c.w && u.h === c.h }), 'presets are for a 24-unit set')
  const small = { ...sq, grid: 16, gridH: 16 }
  ok(iconCanvasUnits(small, '4:3').w === 21 && iconCanvasUnits(small, '4:3').h === 16 && iconCanvasId(small) === '1:1', 'a 16-unit set scales the presets')
  const tall = newIconsetDoc({ gridH: 32 })
  ok(tall.size.width === 288 && tall.size.height === 384 && tall.iconset?.gridH === 32, 'a portrait set fits 384 px on its long side', tall.size)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
