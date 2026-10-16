// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Example icons (docs/DECISIONS.md, "Drawing style and styles"): icons
// someone likes, from any library, kept in the set (`iconset.examples`) so
// Claude draws new icons like them. They are the DRAWING side of a set's
// style — read before an icon is drawn — where styles (iconstyles.ts) only
// repaint what is drawn.
//
//   - `readIconExamples`   untrusted → clean examples (the one gate)
//   - `exampleSvg`         one example → a small SVG (doc_info, panel previews)
//   - `styleFromExamples`  the line width, ends, corners and fill they share
//
// An example is never put into the page or an export: the panel shows it as
// an <img>, the agent reads its text. Opened files skip untrusted.ts, so
// everything is read through `readIconExamples` again where it is used.
//
// Pure — no DOM, no i18n — so scripts/test-iconexamples.ts runs it in node.
// Reading an SVG file (DOMParser) is editor/iconsetactions.ts `readSvgExample`.

import type { IconExample, IconExampleShape, IconsetStyle } from './model.ts'
import { escXml, isNoPaint, n3 } from './iconset.ts'

/** The most examples a set keeps (the newest win). */
export const MAX_EXAMPLES = 12
/** The most shapes one example keeps. */
export const MAX_EXAMPLE_SHAPES = 60
const MAX_D = 4000

export const EXAMPLE_TAGS: readonly IconExampleShape['tag'][] = ['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i
const PATH_RE = /^[0-9eE.,\s+\-MmLlHhVvCcSsQqTtAaZz]*$/
const POINTS_RE = /^[0-9eE.,\s+-]*$/
const TRANSFORM_RE = /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([0-9eE.,\s+-]*\)\s*,?)+$/
const COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s/+-]{1,60}\)|[a-z]{3,20})$/i

type Reader = (v: string) => boolean
const num: Reader = (v) => v.length <= 24 && NUM_RE.test(v)
const word = (...opts: string[]): Reader => (v) => opts.includes(v)

/** Every attribute an example keeps, and what its value may be. */
const ATTRS: Record<string, Reader> = {
  d: (v) => v.length <= MAX_D && PATH_RE.test(v),
  points: (v) => v.length <= MAX_D && POINTS_RE.test(v),
  cx: num, cy: num, r: num, rx: num, ry: num, x: num, y: num, width: num, height: num,
  x1: num, y1: num, x2: num, y2: num,
  transform: (v) => v.length <= 200 && TRANSFORM_RE.test(v),
  fill: (v) => COLOR_RE.test(v),
  stroke: (v) => COLOR_RE.test(v),
  'stroke-width': num, opacity: num, 'fill-opacity': num, 'stroke-opacity': num,
  'stroke-linecap': word('round', 'square', 'butt'),
  'stroke-linejoin': word('round', 'bevel', 'miter', 'arcs', 'miter-clip'),
  'fill-rule': word('nonzero', 'evenodd'),
}

/** The attribute names an example keeps (what readSvgExample copies). */
export const EXAMPLE_ATTRS: readonly string[] = Object.keys(ATTRS)

function readShape(v: unknown): IconExampleShape | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const tag = EXAMPLE_TAGS.find((t) => t === r.tag)
  if (!tag || !r.a || typeof r.a !== 'object') return null
  const a: Record<string, string> = {}
  for (const [k, val] of Object.entries(r.a as Record<string, unknown>)) {
    if (typeof val !== 'string' || !Object.hasOwn(ATTRS, k)) continue
    const s = val.trim()
    if (s && ATTRS[k](s)) a[k] = s
  }
  return { tag, a }
}

/** Untrusted → one clean example, or null when nothing drawable is left. */
export function readIconExample(v: unknown): IconExample | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const vb = Array.isArray(r.viewBox) ? r.viewBox : []
  if (vb.length !== 4 || !vb.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e6)) return null
  if (vb[2] <= 0 || vb[3] <= 0) return null
  const name = typeof r.name === 'string' ? r.name.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  const shapes = (Array.isArray(r.shapes) ? r.shapes : []).slice(0, MAX_EXAMPLE_SHAPES).map(readShape).filter((s): s is IconExampleShape => !!s)
  if (!shapes.length) return null
  return { name: name || 'icon', viewBox: [vb[0], vb[1], vb[2], vb[3]], shapes }
}

/** Untrusted → the set's examples (at most MAX_EXAMPLES, the last ones). */
export function readIconExamples(v: unknown): IconExample[] {
  if (!Array.isArray(v)) return []
  return v.map(readIconExample).filter((e): e is IconExample => !!e).slice(-MAX_EXAMPLES)
}

/** One example as a standalone SVG; `ink` stands in for currentColor (a preview). */
export function exampleSvg(ex: IconExample, opts: { ink?: string; size?: number } = {}): string {
  const clean = readIconExample(ex)
  if (!clean) return ''
  const ink = opts.ink && COLOR_RE.test(opts.ink) ? opts.ink : undefined
  const body = clean.shapes.map((s) => {
    const attrs = Object.entries(s.a).map(([k, v]) => {
      const val = ink && v.toLowerCase() === 'currentcolor' ? ink : v
      return ` ${k}="${escXml(val)}"`
    }).join('')
    return `<${s.tag}${attrs}/>`
  }).join('')
  const [x, y, w, h] = clean.viewBox.map(n3)
  const size = opts.size ? ` width="${n3(opts.size)}" height="${n3(opts.size)}"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}"${size}>${body}</svg>`
}

/** One painted shape of an example, its stroke width in OUR grid units. */
export interface ExamplePaint {
  /** null = not stroked */
  stroke: string | null
  strokeWidth: number
  /** null = not filled */
  fill: string | null
  cap?: string
  join?: string
}

/** What each shape of the examples is painted with, scaled to a `grid` square. */
export function examplePaints(examples: readonly IconExample[], grid: number): ExamplePaint[] {
  const out: ExamplePaint[] = []
  for (const ex of readIconExamples(examples)) {
    const k = grid / ex.viewBox[2]
    for (const s of ex.shapes) {
      const stroke = s.a.stroke && !isNoPaint(s.a.stroke) ? s.a.stroke : null
      const lineLike = s.tag === 'line' || s.tag === 'polyline'
      const fill = lineLike || !s.a.fill || isNoPaint(s.a.fill) ? null : s.a.fill
      const sw = stroke ? parseFloat(s.a['stroke-width'] ?? '1') : 0
      out.push({ stroke, strokeWidth: Number.isFinite(sw) ? sw * k : 0, fill, cap: s.a['stroke-linecap'], join: s.a['stroke-linejoin'] })
    }
  }
  return out
}

function mode<T>(xs: readonly T[]): T | undefined {
  const n = new Map<T, number>()
  let best: T | undefined, bestN = 0
  for (const x of xs) {
    const c = (n.get(x) ?? 0) + 1
    n.set(x, c)
    if (c > bestN) { best = x; bestN = c }
  }
  return best
}

/**
 * The drawing style the examples share, as a patch for the set's style: the
 * usual line width (to a quarter unit), line ends and corners, and outline or
 * solid (no strokes at all). Empty when there is nothing to read. Ink and
 * padding stay the set's own.
 */
export function styleFromExamples(examples: readonly IconExample[], grid: number): Partial<IconsetStyle> {
  const paints = examplePaints(examples, grid)
  const patch: Partial<IconsetStyle> = {}
  const stroked = paints.filter((p) => p.stroke && p.strokeWidth > 0)
  if (stroked.length) {
    const ws = stroked.map((p) => p.strokeWidth).sort((a, b) => a - b)
    const w = Math.round(ws[Math.floor(ws.length / 2)] * 4) / 4
    patch.strokeWidth = Math.min(grid / 4, Math.max(0.25, w))
    // unset is what SVG draws by default: butt ends, miter corners
    const cap = mode(stroked.map((p) => p.cap ?? 'butt'))
    if (cap === 'round' || cap === 'square' || cap === 'butt') patch.cap = cap
    const join = mode(stroked.map((p) => p.join ?? 'miter'))
    patch.join = join === 'round' || join === 'bevel' ? join : 'miter'
    patch.fill = 'outline'
  } else if (paints.some((p) => p.fill)) {
    patch.fill = 'solid'
  }
  return patch
}
