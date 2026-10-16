// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slides/src/iconstyles.ts — icon styles (DECISIONS "Icon styles"): which part
// each shape is, one icon in one look, the presets, reading untrusted looks,
// learning a look from a painted icon. Run (bundled):
//   slides/node_modules/.bin/esbuild scripts/test-iconstyles.ts --bundle --platform=node --format=esm --outfile=/tmp/t.mjs && node /tmp/t.mjs
// With ICONSTYLES_SHEET=<file.svg> it also writes every preset × icon as one sheet to look at.
import { writeFileSync } from 'node:fs'
import { newIconsetDoc, defaultShape, type IconLook, type ShapeElement, type SlidomingoDoc } from '../slides/src/model.ts'
import { iconShapes, iconsetInfo } from '../slides/src/iconset.ts'
import {
  LOOK_PRESETS, clearTweaks, iconLookSvg, iconParts, iconTweaks, learnLookFromIcon, lookFromPreset, lookRecipe, readLook, readTweak,
  safeColor, setTweak, sketchSegs, tweakedIconCount, MAX_TWEAK_SHAPES,
} from '../slides/src/iconstyles.ts'
import { parsePath } from '../slides/src/svgpath.ts'
import { sanitizeSlide } from '../slides/src/untrusted.ts'

let checks = 0, failures = 0
const ok = (c: boolean, m: string, d?: unknown) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.log(`  FAIL  ${m}${d === undefined ? '' : ' — ' + JSON.stringify(d)}`) } }

const path = (doc: SlidomingoDoc, d: string, over: Partial<ShapeElement> = {}): ShapeElement => ({
  ...(defaultShape('path') as ShapeElement),
  id: `p${Math.random().toString(36).slice(2, 8)}`,
  x: 0, y: 0, w: doc.size.width, h: doc.size.height,
  d, pathBox: [0, 0, 24, 24], fill: 'transparent', stroke: '#000000', strokeWidth: 32, strokeCap: 'round', strokeJoin: 'round',
  ...over,
})

const doc = newIconsetDoc({ names: ['search', 'document', 'evidence'] })
const [search, document, evidence] = doc.slides
// a magnifier: the lens (body), the handle (open → detail), a glint (accent)
search.elements = [
  path(doc, 'M10 3a7 7 0 1 0 0 14a7 7 0 1 0 0-14Z'),
  path(doc, 'M15 15L21 21'),
  path(doc, 'M7 10a3 3 0 0 1 3-3V10Z', { iconPart: 'accent' }),
]
// a page with lines on it: the lines sit inside the body
document.elements = [
  path(doc, 'M6 2H14L19 7V22H6Z'),
  path(doc, 'M9 12H16'),
  path(doc, 'M9 16H14'),
  path(doc, 'M14 2V7H19'),
]
// a tagged bag: body, a filled dot (detail), a closed tag as accent
evidence.elements = [
  path(doc, 'M4 7H20V21H4Z'),
  path(doc, 'M4 7L7 3H17L20 7'),
  path(doc, 'M15 11H19V15H15Z', { iconPart: 'accent' }),
  path(doc, 'M8 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0Z', { fill: '#000000', stroke: 'transparent', strokeWidth: 0 }),
]

console.log('-- parts')
{
  const { shapes } = iconShapes(doc, search)
  ok(iconParts(shapes).join() === 'body,detail,accent', 'lens = body, handle (open) = detail, tagged glint = accent', iconParts(shapes))
  const d = iconShapes(doc, document).shapes
  ok(iconParts(d).join() === 'body,detail,detail,detail', 'small shapes and lines are detail', iconParts(d))
  const e = iconShapes(doc, evidence).shapes
  ok(iconParts(e)[3] === 'detail' && e[3].filled, 'a filled dot is a filled detail')
  const ring = { ...search, elements: [path(doc, 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18'), path(doc, 'M8 12l3 3l5-6')] }
  const r = iconShapes(doc, ring).shapes
  ok(!r[0].open && r[1].open, 'a circle drawn without Z is still closed (it can be filled); a tick is open')
}

console.log('-- reading a look')
{
  ok(typeof readLook(null) === 'string' && typeof readLook({}) === 'string', 'no object / no name → a message')
  const l = readLook({ name: '  My  look ', stroke: { weight: 99, color: 'red;}<x>', cap: 'nope' }, fill: { body: '#ff0', accent: { color: 'url(x)' }, detail: 'transparent' }, shadow: { dx: 0, dy: 0 }, sketch: 5, tile: { shape: 'hex', color: '#123' } })
  ok(typeof l !== 'string', 'a sloppy look is cleaned, not refused')
  if (typeof l !== 'string') {
    ok(l.name === 'My look' && l.stroke.weight === 4 && l.stroke.color === '#000000' && !l.stroke.cap, 'name trimmed, weight clamped, bad colour and cap dropped', l)
    ok(l.fill?.body?.color === '#ff0' && !l.fill.accent && !l.fill.detail, 'url() and transparent fills dropped', l.fill)
    ok(!l.shadow && l.sketch === 1 && l.tile?.shape === 'circle' && l.tile.color === '#123', 'zero shadow dropped, sketch clamped, unknown tile shape → circle', l)
    ok(/^look/.test(l.id), 'an id is made up when missing', l.id)
  }
  ok(safeColor('rgb(1, 2, 3)') === 'rgb(1, 2, 3)' && safeColor('#abc') === '#abc' && safeColor('x" onload="y') === '#000000', 'safeColor keeps colours, refuses markup')
  const kept = readLook({ id: 'look-abc', name: 'k', stroke: { weight: 1, color: '#000' } })
  ok(typeof kept !== 'string' && kept.id === 'look-abc', 'a valid id is kept')
}

console.log('-- one icon in a look')
{
  const ink = iconsetInfo(doc)!.style.color
  const presets = Object.fromEntries(LOOK_PRESETS.map((p) => [p.id, lookFromPreset(p, ink, p.name)]))
  // no Outline or Sketch preset any more (a wobble is not a drawing style); looks can still have them
  presets.outline = { id: 'outline', name: 'Outline', stroke: { weight: 1, color: ink } }
  presets.sketch = { id: 'sketch', name: 'Sketch', stroke: { weight: 0.9, color: ink }, sketch: 0.7 }
  ok(!LOOK_PRESETS.some((p) => p.id === 'outline' || p.id === 'sketch') && LOOK_PRESETS.length === 8, 'the presets only repaint: no Outline (= as drawn), no Sketch')
  const outline = iconLookSvg(doc, search, presets.outline).svg
  ok(outline.includes('viewBox="0 0 24 24"') && !outline.includes('\u0000'), 'grid units, no colour tokens left', outline)
  ok(outline.includes('stroke="currentColor"') && !outline.includes('#000000'), 'one colour → currentColor', outline)
  ok(outline.includes('stroke-width="2"'), '1 × the set stroke = 2 units')
  ok(iconLookSvg(doc, search, presets.bold).svg.includes('stroke-width="3"'), 'bold = 1.5 ×')
  const color = iconLookSvg(doc, search, presets.color).svg
  ok(color.includes('fill="#7dd3fc"') && color.includes('fill="#fb923c"') && color.includes('stroke="#1e293b"') && !color.includes('currentColor'), 'colour: body + accent fills, colours kept', color)
  ok(color.indexOf('fill="#7dd3fc"') < color.indexOf('stroke="#1e293b"'), 'fills are drawn under the lines')
  const solid = iconLookSvg(doc, document, presets.solid).svg
  ok(/<mask id="(ko-[a-z0-9]+)"/.test(solid) && solid.includes(`mask="url(#${/<mask id="(ko-[a-z0-9]+)"/.exec(solid)![1]})"`) && (solid.match(/stroke="#000"/g) ?? []).length === 3, 'solid: the two lines and the fold of the page are cut out', solid)
  const solidSearch = iconLookSvg(doc, search, presets.solid).svg
  ok(!solidSearch.includes('stroke="#000"') || !solidSearch.includes('M15 15L21 21"' + ' stroke="#000"'), 'the handle outside the lens is not cut')
  const comic = iconLookSvg(doc, search, presets.comic).svg
  ok(comic.includes('<g transform="translate(0.9 0.9)">') && comic.includes('fill="#ffd23f"'), 'comic: a hard shadow and a bright body', comic)
  const sticker = iconLookSvg(doc, evidence, presets.sticker).svg
  ok(sticker.includes('stroke="#ffffff"') && sticker.includes('opacity="0.25"'), 'sticker: white border, soft shadow')
  const badge = iconLookSvg(doc, search, presets.badge).svg
  ok(badge.includes('<circle cx="12" cy="12" r="12" fill="#4f46e5"/>') && badge.includes('scale(0.62)'), 'badge: a circle behind, the icon scaled into it', badge)
  const sketch1 = iconLookSvg(doc, search, presets.sketch).svg
  ok(sketch1 === iconLookSvg(doc, search, presets.sketch).svg, 'sketch is the same every time (seeded by the icon)')
  ok(sketch1 !== iconLookSvg(doc, document, presets.sketch).svg, 'and differs between icons')
  const dot = iconLookSvg(doc, evidence, presets.outline).svg
  ok(/M8 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0Z" fill="currentColor"/.test(dot), 'a filled dot stays filled, in the ink', dot)
  const evil = iconLookSvg(doc, search, { id: 'x', name: 'x', stroke: { weight: 1, color: '"/><script>' } } as never).svg
  ok(!evil.includes('<script'), 'a stored look with markup in a colour cannot write markup')
  ok(iconLookSvg(doc, search, presets.outline, { title: true }).svg.includes('<title>search</title>'), 'title from the slide name')
}

console.log('-- sketch wobble')
{
  const segs = parsePath('M0 0L10 0L10 10Z')!
  const w = sketchSegs(segs, 0.7, 42)
  ok(w.length === segs.length && w[1][0] === 'C' && w[3][0] === 'Z', 'lines become gently bowed curves, Z kept', w)
  ok(JSON.stringify(sketchSegs(segs, 0.7, 42)) === JSON.stringify(w), 'same seed, same wobble')
}

console.log('-- learning a look')
{
  // someone painted the magnifier by hand: thick red lines, yellow lens, blue glint
  const painted = structuredClone(search)
  painted.elements[0] = { ...(painted.elements[0] as ShapeElement), stroke: '#CC0000', strokeWidth: 48, fill: '#ffee00' }
  painted.elements[1] = { ...(painted.elements[1] as ShapeElement), stroke: '#cc0000', strokeWidth: 48 }
  painted.elements[2] = { ...(painted.elements[2] as ShapeElement), stroke: '#cc0000', strokeWidth: 48, fill: '#0000ff', opacity: 0.5 }
  const l = learnLookFromIcon(doc, painted)
  ok(l?.stroke.color === '#cc0000' && l.stroke.weight === 1.5, 'stroke colour and weight (48 px = 3 units = 1.5 ×)', l)
  ok(l?.fill?.body?.color === '#ffee00' && l.fill.accent?.color === '#0000ff' && l.fill.accent.opacity === 0.5, 'fills per part, with opacity', l?.fill)
  ok(learnLookFromIcon(doc, { ...search, elements: [] }) === null, 'an empty icon teaches nothing')
}

console.log('-- one icon its own way in a style (tweaks)')
{
  const color = lookFromPreset(LOOK_PRESETS.find((p) => p.id === 'color')!, '#000000', 'Color')
  const [lens, handle, glint] = search.elements
  const plain = iconLookSvg(doc, search, color).svg
  const look = structuredClone(color)
  setTweak(look, search.id, lens.id, { fill: { color: '#22c55e' } })
  setTweak(look, search.id, handle.id, { stroke: '#dc2626' })
  setTweak(look, search.id, glint.id, { hide: true })
  const svg = iconLookSvg(doc, search, look).svg
  ok(svg.includes('fill="#22c55e"') && !svg.includes('fill="#7dd3fc"'), 'the lens takes its own fill instead of the body colour', svg)
  ok(svg.includes('stroke="#dc2626"') && svg.includes('stroke="#1e293b"'), 'the handle gets its own line colour, the rest keeps the style\'s')
  ok(!svg.includes('fill="#fb923c"') && plain.includes('fill="#fb923c"'), 'the hidden glint (the accent) is left out of this style only')
  ok(iconLookSvg(doc, document, look).svg === iconLookSvg(doc, document, color).svg, 'other icons are untouched')
  ok(iconLookSvg(doc, search, color).svg === plain, 'the style itself is untouched (tweaks live on the copy)')
  ok(tweakedIconCount(look) === 1 && Object.keys(iconTweaks(look, search.id)).length === 3, 'three shapes of one icon tweaked')

  const none = structuredClone(color)
  setTweak(none, search.id, lens.id, { fill: 'none' })
  ok(!iconLookSvg(doc, search, none).svg.includes('fill="#7dd3fc"'), 'fill "none" leaves the body empty')

  // hiding one shape keeps the others' parts and hand-drawn wobble
  const sk: IconLook = { id: 'sk', name: 'Sketch', stroke: { weight: 0.9, color: '#000000' }, sketch: 0.7 }
  const skHidden = structuredClone(sk)
  setTweak(skHidden, search.id, glint.id, { hide: true })
  const strokes = (look: typeof sk) => [...iconLookSvg(doc, search, look).svg.matchAll(/<path d="([^"]+)"[^>]*stroke=/g)].map((m) => m[1])
  const [lensWob, handleWob] = strokes(sk), hidden = strokes(skHidden)
  ok(!!lensWob && hidden[0] === lensWob && hidden.includes(handleWob), 'hiding a shape does not change how the others wobble')

  // clearing
  setTweak(look, search.id, lens.id, undefined)
  ok(!iconTweaks(look, search.id)[lens.id] && tweakedIconCount(look) === 1, 'clearing one shape keeps the rest')
  setTweak(look, search.id, handle.id, {})
  ok(!iconTweaks(look, search.id)[handle.id], 'an empty tweak is removed')
  clearTweaks(look, search.id)
  ok(look.tweaks === undefined, 'no tweaks left → no tweaks key')
  setTweak(look, search.id, lens.id, { hide: true })
  setTweak(look, document.id, document.elements[0].id, { hide: true })
  clearTweaks(look)
  ok(look.tweaks === undefined, 'reset all icons')

  // untrusted tweaks (a file, a paste, an agent)
  const r = readLook({ ...color, tweaks: {
    [search.id]: { [lens.id]: { fill: { color: '#123456', opacity: 0.5 }, stroke: 'red', hide: true, junk: 1 }, 'bad id!': { hide: true }, [handle.id]: { fill: 'url(#x)' } },
    '<script>': { a: { hide: true } },
    [document.id]: 'nope',
  } }) as any
  ok(typeof r !== 'string' && JSON.stringify(Object.keys(r.tweaks)) === JSON.stringify([search.id]), 'only well-formed icon ids are kept', r.tweaks)
  ok(JSON.stringify(r.tweaks[search.id]) === JSON.stringify({ [lens.id]: { fill: { color: '#123456', opacity: 0.5 }, stroke: 'red', hide: true } }), 'bad shape ids and bad colours are dropped', r.tweaks)
  ok(readTweak({ fill: 'none' })?.fill === 'none' && readTweak({ stroke: 'transparent' }) === undefined && readTweak({}) === undefined, 'readTweak: none fill kept, no-paint stroke dropped, empty → undefined')
  const many = Object.fromEntries(Array.from({ length: MAX_TWEAK_SHAPES + 50 }, (_, i) => [`e${i}`, { hide: true }]))
  const capped = readLook({ ...color, tweaks: { [search.id]: many } }) as any
  ok(Object.keys(capped.tweaks[search.id]).length === MAX_TWEAK_SHAPES, 'shapes per icon are bounded')
  const withT = structuredClone(color)
  setTweak(withT, search.id, lens.id, { hide: true })
  ok(lookRecipe(withT).tweaks === undefined && withT.tweaks !== undefined, 'the recipe (My styles, Copy style) leaves the set\'s tweaks behind')
}

console.log('-- paste safety')
{
  const s = sanitizeSlide({ ...search, elements: [{ ...search.elements[0], iconPart: 'body' }, { ...search.elements[1], iconPart: '<x>' }] } as never) as any
  ok(s.elements[0].iconPart === 'body' && s.elements[1].iconPart === undefined, 'iconPart kept when known, dropped otherwise')
}

if (process.env.ICONSTYLES_SHEET) {
  const ink = '#111827'
  const looks = LOOK_PRESETS.map((p) => lookFromPreset(p, ink, p.name))
  const cell = 64, pad = 16
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${pad + looks.length * (cell + pad)}" height="${pad + doc.slides.length * (cell + pad) + 20}" style="background:#f4f4f5">`
  looks.forEach((l, c) => {
    out += `<text x="${pad + c * (cell + pad)}" y="14" font-size="11" font-family="sans-serif">${l.name}</text>`
    doc.slides.forEach((s, r) => {
      const svg = iconLookSvg(doc, s, l).svg.replace('<svg ', `<svg x="${pad + c * (cell + pad)}" y="${20 + pad + r * (cell + pad)}" color="${ink}" `).replace(/width="24" height="24"/, `width="${cell}" height="${cell}"`)
      out += svg
    })
  })
  writeFileSync(process.env.ICONSTYLES_SHEET, out + '</svg>')
  console.log(`  sheet → ${process.env.ICONSTYLES_SHEET}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
