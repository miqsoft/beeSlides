// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slides/src/iconexamples.ts — example icons, the drawing side of an icon
// set's style (DECISIONS "Drawing style and styles"): reading untrusted
// examples, writing one back as SVG, and the line style they share. Run:
//   node scripts/test-iconexamples.ts
import { readIconExample, readIconExamples, exampleSvg, styleFromExamples, MAX_EXAMPLES, MAX_EXAMPLE_SHAPES } from '../slides/src/iconexamples.ts'
import type { IconExample } from '../slides/src/model.ts'

let checks = 0, failures = 0
const ok = (c: boolean, m: string, d?: unknown) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.log(`  FAIL  ${m}${d === undefined ? '' : ' — ' + JSON.stringify(d)}`) } }

/** A Lucide-like icon: 24 box, stroke 2, round ends and corners. */
const lucide = (name: string): IconExample => ({
  name, viewBox: [0, 0, 24, 24],
  shapes: [
    { tag: 'circle', a: { cx: '11', cy: '11', r: '8', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } },
    { tag: 'path', a: { d: 'm21 21-4.3-4.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } },
  ],
})

console.log('-- reading untrusted examples')
{
  const ex = readIconExample({
    name: ' <b>search</b>\n icon ',
    viewBox: [0, 0, 24, 24],
    shapes: [
      { tag: 'path', a: { d: 'M3 3h18', stroke: '#000', onclick: 'alert(1)', style: 'fill:red', 'stroke-width': '2' } },
      { tag: 'path', a: { d: 'M0 0" onload="x', fill: 'url(#evil)', stroke: 'javascript:1' } },
      { tag: 'script', a: { d: 'M0 0' } },
      { tag: 'image', a: { href: 'https://example.com/x.png' } },
      { tag: 'rect', a: { x: '1', y: '1', width: '22', height: '22', transform: 'rotate(45 12 12) translate(1,2)', rx: '2' } },
      { tag: 'rect', a: { x: '1', transform: 'url(x)' } },
    ],
  })
  ok(!!ex && ex.name === 'bsearch/b icon', 'name: no markup, one line', ex?.name)
  ok(!!ex && ex.shapes.length === 4, 'only drawable tags are kept (path, rect …; not script or image)', ex?.shapes.map((s) => s.tag))
  ok(!!ex && JSON.stringify(ex.shapes[0].a) === JSON.stringify({ d: 'M3 3h18', stroke: '#000', 'stroke-width': '2' }), 'unknown attributes (onclick, style) are dropped', ex?.shapes[0].a)
  ok(!!ex && Object.keys(ex.shapes[1].a).length === 0, 'a d with a quote, a url() fill, a javascript: stroke are dropped', ex?.shapes[1].a)
  ok(!!ex && ex.shapes[2].a.transform === 'rotate(45 12 12) translate(1,2)' && ex.shapes[3].a.transform === undefined, 'transforms: only the plain functions')
  ok(readIconExample({ name: 'x', viewBox: [0, 0, 0, 24], shapes: [{ tag: 'path', a: { d: 'M0 0' } }] }) === null, 'a zero-size viewBox is refused')
  ok(readIconExample({ name: 'x', viewBox: [0, 0, 24, 24], shapes: [{ tag: 'text', a: {} }] }) === null, 'nothing drawable → null')
  ok(readIconExample('nope') === null && readIconExample(null) === null, 'garbage → null')
  const many = readIconExample({ name: 'x', viewBox: [0, 0, 24, 24], shapes: Array.from({ length: 200 }, () => ({ tag: 'path', a: { d: 'M0 0' } })) })
  ok(many?.shapes.length === MAX_EXAMPLE_SHAPES, `at most ${MAX_EXAMPLE_SHAPES} shapes`)
  const list = readIconExamples(Array.from({ length: 20 }, (_, i) => lucide(`i${i}`)))
  ok(list.length === MAX_EXAMPLES && list[0].name === 'i8' && list.at(-1)!.name === 'i19', `at most ${MAX_EXAMPLES}, the newest kept`)
  ok(readIconExamples({}).length === 0 && readIconExamples(undefined).length === 0, 'not a list → none')
}

console.log('-- one example as SVG')
{
  const svg = exampleSvg(lucide('search'))
  ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">') && svg.includes('<circle cx="11" cy="11" r="8"') && svg.includes('d="m21 21-4.3-4.3"'), 'the shapes, in the file’s own units', svg)
  ok(svg.includes('stroke="currentColor"') && !svg.includes('<script') && !svg.includes('</script'), 'currentColor kept; no script')
  ok(exampleSvg(lucide('search'), { ink: '#ff0000' }).includes('stroke="#ff0000"'), 'a preview shows currentColor as the ink')
  ok(!exampleSvg(lucide('search'), { ink: '"/><x' }).includes('<x'), 'a bad ink is ignored')
  const tampered = { name: 'x', viewBox: [0, 0, 24, 24], shapes: [{ tag: 'path', a: { d: 'M0 0', fill: '"><script>alert(1)</script>' } }] } as unknown as IconExample
  ok(!exampleSvg(tampered).includes('<script'), 'a stored example is read again: markup in a value cannot get out')
}

console.log('-- the line style the examples share')
{
  const st = styleFromExamples([lucide('a'), lucide('b')], 24)
  ok(st.strokeWidth === 2 && st.cap === 'round' && st.join === 'round' && st.fill === 'outline', 'Lucide-like: 2 units, round ends and corners, outline', st)
  // Phosphor-like: a 256 box, stroke 16 → 1.5 of 24
  const phosphor: IconExample = { name: 'p', viewBox: [0, 0, 256, 256], shapes: [
    { tag: 'path', a: { d: 'M40 40H216', fill: 'none', stroke: '#000', 'stroke-width': '16', 'stroke-linecap': 'square', 'stroke-linejoin': 'bevel' } },
  ] }
  const p = styleFromExamples([phosphor], 24)
  ok(p.strokeWidth === 1.5 && p.cap === 'square' && p.join === 'bevel', 'stroke width scaled from the file’s box to the grid (16 of 256 = 1.5 of 24)', p)
  const bare: IconExample = { name: 'b', viewBox: [0, 0, 24, 24], shapes: [{ tag: 'path', a: { d: 'M2 2H22', stroke: '#000', fill: 'none' } }] }
  const b = styleFromExamples([bare], 24)
  ok(b.strokeWidth === 1 && b.cap === 'butt' && b.join === 'miter', 'no stroke-width/linecap/linejoin: what SVG draws (1, butt, miter)', b)
  // a filled family (Material-like): no strokes at all
  const filled: IconExample = { name: 'f', viewBox: [0, 0, 24, 24], shapes: [{ tag: 'path', a: { d: 'M2 2H22V22H2Z', fill: '#000000' } }] }
  const f = styleFromExamples([filled], 24)
  ok(f.fill === 'solid' && f.strokeWidth === undefined, 'no strokes anywhere → drawn solid, line width left alone', f)
  ok(Object.keys(styleFromExamples([], 24)).length === 0, 'no examples → no change')
  const huge: IconExample = { name: 'h', viewBox: [0, 0, 24, 24], shapes: [{ tag: 'path', a: { d: 'M2 2H22', stroke: '#000', 'stroke-width': '30' } }] }
  ok(styleFromExamples([huge], 24).strokeWidth === 6, 'a wild stroke width is capped (a quarter of the grid)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
