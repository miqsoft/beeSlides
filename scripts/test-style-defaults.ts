#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Default styles per slide type (model.ts resolveStyleDefaults): what new
// shapes, lines and text look like, resolved per field nearest-first down the
// slide-type tree, then the deck, then the built-in look. Pure JSON, no DOM —
// but BUNDLED, not run directly, like test-clipboard.ts:
//
//   slides/node_modules/.bin/esbuild scripts/test-style-defaults.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-style-defaults.mjs" \
//     && node "$TMPDIR/test-style-defaults.mjs"

import { restyleToDefaults } from '../slides/src/editor/clipboard.ts'
import {
  defaultShape, defaultText, emptySlide, lineDefaultsFor, newDoc, resolveStyleDefaults, setShapeStroke,
  setShapeStrokeWidth, shapeDefaultsFor, SHAPE_DEFAULT, strokeFallbackFor, textDefaultsFor, FONT_STACK,
  type Slide, type SlidomingoDoc,
} from '../slides/src/model.ts'
import { resolveThemeRefs, slotForLiteral } from '../slides/src/palette.ts'
import { sanitizeSlide } from '../slides/src/untrusted.ts'
import { validateDoc } from '../slides/src/validate.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ✓ ${message}`)
  else {
    failures++
    console.error(`  ✗ ${message}`)
  }
}

/** Master → Section → Dark section, plus a slide of each and one without a type. */
function fixture(): { doc: SlidomingoDoc; master: Slide; section: Slide; dark: Slide; onDark: Slide; onSection: Slide; loose: Slide } {
  const doc = newDoc()
  doc.theme.background = '#FFFFFF'
  doc.theme.color = '#111111'
  doc.theme.accent = '#E03C31'
  const master = emptySlide({ id: 'ly-master', name: 'Master' })
  const section = emptySlide({ id: 'ly-section', name: 'Section', parentId: master.id })
  const dark = emptySlide({ id: 'ly-dark', name: 'Dark section', parentId: section.id, background: '#101010' })
  doc.layouts = [master, section, dark]
  const onDark = emptySlide({ id: 's-dark', layoutId: dark.id, background: '#101010' })
  const onSection = emptySlide({ id: 's-section', layoutId: section.id })
  const loose = emptySlide({ id: 's-loose' })
  doc.slides = [onDark, onSection, loose]
  return { doc, master, section, dark, onDark, onSection, loose }
}

console.log('built-in fallback')
{
  const { doc, loose, onDark } = fixture()
  const s = shapeDefaultsFor(doc, loose, 'rect')
  ok(s.fill === SHAPE_DEFAULT.fill && s.stroke === SHAPE_DEFAULT.stroke && s.strokeWidth === SHAPE_DEFAULT.strokeWidth,
    'no defaults anywhere: a shape gets SHAPE_DEFAULT')
  ok(s.radius === 12 && shapeDefaultsFor(doc, loose, 'ellipse').radius === 0, 'a rectangle is rounded 12, other kinds 0')
  ok(!s.themeRefs && !s.shadow && !s.strokeStyle, 'and nothing else')
  const l = lineDefaultsFor(doc, onDark, 'line')
  ok(l.fill === '#FAF6F7' && l.strokeWidth === 3, 'a line on a dark slide gets light ink, width 3')
  const t = textDefaultsFor(doc, loose)
  const base = defaultText()
  ok(t.fontFamily === FONT_STACK && t.fontSize === base.fontSize && t.color === '#1D1119' && t.align === 'center',
    'text gets the defaultText() look with readable ink')
  const r = resolveStyleDefaults(doc, loose, 'shape:rect')
  ok(r.sourceOf('fill').kind === 'builtin', 'sourceOf says built-in')
}

console.log('\nnearest wins down a 3-level tree')
{
  const { doc, master, section, dark, onDark, onSection, loose } = fixture()
  doc.theme.styleDefaults = { shape: { fill: '#AAAAAA', strokeWidth: 5 }, text: { fontSize: 20 } }
  master.styleDefaults = { shape: { fill: '#E03C31', themeRefs: { fill: 'accent1' } }, text: { fontSize: 53.33 } }
  section.styleDefaults = { text: { color: '#FFFFFF' } }
  dark.styleDefaults = { shape: { stroke: '#00FF00' } }

  const s = shapeDefaultsFor(doc, onDark, 'rect')
  ok(s.stroke === '#00FF00', 'the slide’s own type sets stroke')
  ok(s.fill === '#E03C31' && s.themeRefs?.fill === 'accent1', 'fill comes from the master, with its palette ref')
  ok(s.strokeWidth === 5, 'strokeWidth falls through to the deck')
  ok(s.radius === 12, 'radius falls through to built-in')
  const r = resolveStyleDefaults(doc, onDark, 'shape:rect')
  const src = r.sourceOf('fill')
  ok(src.kind === 'type' && src.layout.id === master.id, 'sourceOf(fill) names the master')
  ok(r.sourceOf('strokeWidth').kind === 'deck', 'sourceOf(strokeWidth) is the deck')
  ok(r.sourceOf('stroke').kind === 'type', 'on a slide, even its own type is a "type" source')

  const t = textDefaultsFor(doc, onSection)
  ok(t.fontSize === 53.33 && t.color === '#FFFFFF', 'partial text styles merge per field (size from master, colour from section)')
  const t2 = textDefaultsFor(doc, loose)
  ok(t2.fontSize === 20 && t2.color === '#1D1119', 'a slide with no type uses the deck, then built-in')

  const here = resolveStyleDefaults(doc, dark, 'shape:rect')
  ok(here.sourceOf('stroke').kind === 'here', 'editing a slide type in the Layout Manager: its own fields are "here"')
  ok(here.values.fill === '#E03C31', 'and it inherits like a slide of that type')
}

console.log('\nper-kind overrides')
{
  const { doc, master, section, onSection } = fixture()
  master.styleDefaults = { shapes: { ellipse: { fill: '#0000FF' } }, shape: { fill: '#FF0000' } }
  ok(shapeDefaultsFor(doc, onSection, 'ellipse').fill === '#0000FF', 'a per-kind style beats the generic one at the same level')
  ok(shapeDefaultsFor(doc, onSection, 'rect').fill === '#FF0000', 'other kinds keep the generic style')
  section.styleDefaults = { shape: { fill: '#00FF00' } }
  ok(shapeDefaultsFor(doc, onSection, 'ellipse').fill === '#00FF00', 'a nearer generic style beats a farther per-kind one')
  const r = resolveStyleDefaults(doc, section, 'shape:ellipse')
  const g = r.sourceOf('fill')
  ok(g.kind === 'here' && g.generic === true, 'sourceOf flags a same-level generic value (the sub-card’s "From: Shapes")')
  ok(resolveStyleDefaults(doc, section, 'shape').values.fill === '#00FF00', "'shape' alone resolves the generic style only")
  master.styleDefaults.shapes!.path = { fill: '#123456' }
  section.styleDefaults = {}
  ok(shapeDefaultsFor(doc, onSection, 'path').fill === '#123456', 'polygons read shapes.path')
}

console.log('\nlines')
{
  const { doc, master, onSection } = fixture()
  master.styleDefaults = { line: { color: '#E03C31', width: 6, strokeStyle: 'dashed', lineEnd: 'arrow', strokeCap: 'square', themeRefs: { color: 'accent1' } } }
  const l = lineDefaultsFor(doc, onSection, 'line')
  ok(l.fill === '#E03C31' && l.themeRefs?.fill === 'accent1', 'a line paints with fill, and the ref moves with it')
  ok(l.strokeWidth === 6 && l.strokeStyle === 'dashed' && l.lineEnd === 'arrow' && l.strokeCap === 'square', 'width, dash, tips and caps apply')
  const c = lineDefaultsFor(doc, onSection, 'path')
  ok(c.stroke === '#E03C31' && c.fill === 'transparent' && c.themeRefs?.stroke === 'accent1', 'a curve paints with stroke')
  ok(c.lineEnd === undefined && c.strokeCap === undefined, 'tips and caps are line-only')
}

console.log('\nshadows')
{
  const { doc, master, section, onSection } = fixture()
  master.styleDefaults = { shape: { shadow: { y: 2, blur: 10, color: 'rgba(10,16,28,0.25)' } } }
  const s = shapeDefaultsFor(doc, onSection, 'rect')
  ok(!!s.shadow && s.shadow !== master.styleDefaults.shape!.shadow, 'an inherited shadow is copied, never shared')
  section.styleDefaults = { shape: { shadow: { blur: 0, color: 'transparent' } } }
  ok(!shapeDefaultsFor(doc, onSection, 'rect').shadow, 'an invisible shadow at a nearer level means "no shadow"')
}

console.log('\nstroke fallback (a first border on a borderless shape)')
{
  const { doc, master, onSection } = fixture()
  master.styleDefaults = { shape: { stroke: '#336699', strokeWidth: 4 } }
  const shape = defaultShape('rect', { stroke: 'transparent', strokeWidth: 0 })
  const fb = strokeFallbackFor(doc, onSection, shape)
  setShapeStroke(shape, '#FF0000', fb)
  ok(shape.strokeWidth === 4, 'a colour brings the type’s default width')
  const shape2 = defaultShape('rect', { stroke: 'transparent', strokeWidth: 0 })
  setShapeStrokeWidth(shape2, 3, fb)
  ok(shape2.stroke === '#336699', 'a width brings the type’s default colour')
  master.styleDefaults = { shape: { stroke: 'transparent', strokeWidth: 0 } }
  const fb2 = strokeFallbackFor(doc, onSection, shape)
  ok(fb2.stroke === SHAPE_DEFAULT.stroke && fb2.strokeWidth === SHAPE_DEFAULT.strokeWidth,
    'a borderless type default still falls back to a visible border')
}

console.log('\npalette')
{
  const { doc, master, onSection } = fixture()
  master.styleDefaults = {
    shape: { fill: '#E03C31', themeRefs: { fill: 'accent1' } },
    shapes: { ellipse: { stroke: '#E03C31', themeRefs: { stroke: 'accent1' } } },
    line: { color: '#E03C31', themeRefs: { color: 'accent1' } },
  }
  doc.theme.styleDefaults = { text: { color: '#111111', themeRefs: { color: 'tx1' } } }
  doc.theme.accent = '#2255CC'
  doc.theme.color = '#222222'
  ok(resolveThemeRefs(doc), 'resolveThemeRefs reports a change')
  ok(master.styleDefaults.shape!.fill === '#2255CC', 'a slide type’s stored shape fill follows the new accent')
  ok(master.styleDefaults.shapes!.ellipse!.stroke === '#2255CC', 'so does a per-kind style')
  ok(master.styleDefaults.line!.color === '#2255CC', 'and a line colour')
  ok(doc.theme.styleDefaults.text!.color === '#222222', 'and the deck-level text colour')
  ok(shapeDefaultsFor(doc, onSection, 'rect').fill === '#2255CC', 'new objects get the re-derived colour')
  ok(!resolveThemeRefs(doc), 'and it is idempotent')

  ok(slotForLiteral(doc, '#2255cc') === 'accent1', 'slotForLiteral matches a palette hex, case-insensitively')
  ok(slotForLiteral(doc, '#2255CD') === null, 'and nothing close')
  ok(slotForLiteral(doc, 'rgba(34, 85, 204, 0.5)') === null, 'a translucent pick is not the slot')
  ok(slotForLiteral(doc, '#FFFFFF') === 'bg1', 'the first slot wins when several share a colour')
}

console.log('\npaste without design lands in the target type’s look')
{
  const { doc, master, section, onSection, loose } = fixture()
  master.styleDefaults = {
    shape: { fill: '#E03C31', stroke: '#000000', strokeWidth: 1, themeRefs: { fill: 'accent1' } },
    line: { color: '#0000FF', width: 8 },
  }
  section.styleDefaults = { text: { color: '#FFFFFF', fontSize: 40, align: 'left' } }
  const rect = defaultShape('rect', { fill: '#00FF00', radius: 3, opacity: 0.5, themeRefs: { fill: 'accent2' } })
  restyleToDefaults(rect, onSection, doc)
  ok(rect.fill === '#E03C31' && rect.stroke === '#000000' && rect.strokeWidth === 1 && rect.themeRefs?.fill === 'accent1',
    'a shape takes the type’s shape style and its palette link')
  ok(rect.radius === 3 && rect.opacity === 1, 'corner radius (geometry) is kept, opacity reset to the style’s')
  const line = defaultShape('line', { fill: '#FF0000', strokeWidth: 1, lineEnd: 'dot' })
  restyleToDefaults(line, onSection, doc)
  ok(line.fill === '#0000FF' && line.strokeWidth === 8 && line.lineEnd === 'dot', 'a line takes the line style and keeps its tips')
  const curve = defaultShape('path', { d: 'M 0 0 Q 50 50 100 0', fill: 'transparent', stroke: '#FF0000' })
  restyleToDefaults(curve, onSection, doc)
  ok(curve.stroke === '#0000FF' && curve.fill === 'transparent', 'an open path is a line, not a shape')
  const poly = defaultShape('path', { d: 'M 0 0 L 10 0 L 5 5 Z', fill: '#FF0000' })
  restyleToDefaults(poly, onSection, doc)
  ok(poly.fill === '#E03C31', 'a closed path is a shape')
  const text = defaultText({ color: '#FF0000', fontSize: 12, align: 'right' })
  restyleToDefaults(text, onSection, doc)
  ok(text.color === '#FFFFFF' && text.fontSize === 40, 'text takes the type’s text style')
  ok(text.align === 'right', 'alignment (layout) is kept, as before')
  const other = defaultShape('rect', { fill: '#00FF00' })
  restyleToDefaults(other, loose, doc)
  ok(other.fill === SHAPE_DEFAULT.fill, 'on a slide without a type it is the built-in look')
}

console.log('\nsanitize + validate')
{
  const { doc, master } = fixture()
  master.styleDefaults = {
    shape: { fill: '#E03C31', themeRefs: { fill: 'accent1' }, bogus: 1 } as never,
    shapes: { ellipse: { fill: '#00FF00' }, hexagon: { fill: '#000' } } as never,
    line: { color: 'url(https://evil.example/x)', width: 4 },
    text: { fontFamily: "'Inter', sans-serif", fontSize: 30 },
  }
  const clean = sanitizeSlide(JSON.parse(JSON.stringify(master)))!
  const sd = clean.styleDefaults!
  ok(!!sd, 'sanitizeSlide keeps styleDefaults')
  ok(sd.shape?.fill === '#E03C31' && sd.shape.themeRefs?.fill === 'accent1', 'with its colours and refs')
  ok(!('bogus' in (sd.shape ?? {})), 'unknown fields are dropped')
  ok(sd.shapes?.ellipse?.fill === '#00FF00' && !('hexagon' in (sd.shapes ?? {})), 'unknown shape kinds are dropped')
  ok(sd.line?.width === 4 && sd.line.color === undefined, 'a colour reaching for the network is dropped, the rest kept')
  ok(sd.text?.fontSize === 30, 'text styles survive')
  const empty = sanitizeSlide({ id: 'x', elements: [], styleDefaults: { shape: { nope: 1 } } })!
  ok(empty.styleDefaults === undefined, 'a record with nothing valid left disappears entirely')

  const res = validateDoc(doc, { measure: false })
  const paths = res.findings.filter((f) => f.code === 'unknown-key').map((f) => f.path)
  ok(paths.includes('styleDefaults.shape.bogus') && paths.includes('styleDefaults.shapes.hexagon'),
    `validate reports unknown default-style keys (${paths.join(', ')})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
