// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "Convert to objects": turn one opaque `svg` element into ordinary shapes,
// paths and text the editor can select, recolour and morph one by one.
//
// HOW IT STAYS FAITHFUL. The diagram is rendered the way the canvas renders it
// (render.ts renderElement — same sanitizer, same scoped CSS, same flips) into an
// off-screen host at 1:1 scale, and every geometry node is then READ OFF THE LIVE
// DOM: getScreenCTM() is the node's exact path from its own coordinates to
// pixels in the element's box (nested transforms, viewBox letterboxing and the
// element's flip included), and getComputedStyle() resolves fill, stroke and
// opacity through classes, <style> rules, inheritance and currentColor. So there
// is no second SVG interpreter here to disagree with the browser.
//
// WHAT BECOMES WHAT
//   rect / circle / ellipse, axis-aligned  → a rect / ellipse shape
//   anything else geometric (path, line, polyline, polygon, rotated or skewed
//   primitives, rounded rects with unequal radii) → a `path` shape (M/L/C/Z,
//   one element per SVG element so holes stay holes — editing a compound
//   path's nodes is the editors' known limit, see editor/CLAUDE.md)
//   text → a text element (one box, centred on the original text's box)
// all in document order, sharing one groupId so they still move as one.
//
// WHAT IS NOT CARRIED OVER, and said so in `notes` rather than dropped quietly:
// filters, masks, clip paths, patterns, <image>, <use>, markers, radial
// gradients (flattened to one colour), CSS animations and hover rules, and the
// element's own shadow/blur/reflection/fx. Nothing here fetches or runs
// anything: the markup was already sanitized to be drawn.

import { defaultShape, defaultText, uid, type ShapeElement, type SlideElement, type SlidomingoDoc, type SvgElement, type TextElement } from './model'
import { renderElement } from './render'
import {
  apply, ellipseSegs, isAxisAligned, mul, parsePath, pointsSegs, rectSegs, rotateAbout, scaleOf, segsBBox, segsToD,
  transformSegs, translate, type Mat, type Seg,
} from './svgpath'

export interface ConvertResult {
  elements: SlideElement[]
  /** what could not be carried over, one short line each (deduplicated) */
  notes: string[]
}

/** More than this and the result would be a slide nobody can work with. */
export const MAX_PIECES = 300

/** Subtrees that define things rather than draw them. */
const DEFS = new Set(['defs', 'clippath', 'mask', 'marker', 'pattern', 'symbol', 'lineargradient', 'radialgradient', 'filter', 'style', 'title', 'desc', 'metadata'])

// --- colour -----------------------------------------------------------------------

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')

/** A computed colour (`rgb()/rgba()`, possibly with a slash alpha) with an
 *  extra opacity folded in → `#rrggbb` / `#rrggbbaa`, or null when it is not one. */
export function cssToHex(value: string, extraAlpha = 1): string | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(value.trim())
  if (!m) return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null
  let a = 1
  if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  a = Math.max(0, Math.min(1, a * extraAlpha))
  const base = `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}`
  return a >= 0.999 ? base : base + hex2(a * 255)
}

// --- the walk -----------------------------------------------------------------------

interface Ctx {
  /** the svg element's own box → slide space (position and rotation) */
  outer: Mat
  /** the svg element's size: what the diagram clips to */
  w: number
  h: number
  hostLeft: number
  hostTop: number
  root: SVGSVGElement
  notes: Set<string>
  out: SlideElement[]
}

const lengthOf = (v: SVGAnimatedLength) => v.baseVal.value

/** [node → the element's own box, node → slide space] */
function matrixOf(node: SVGGraphicsElement, ctx: Ctx): [Mat, Mat] | null {
  const ctm = node.getScreenCTM()
  if (!ctm) return null
  const local: Mat = [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e - ctx.hostLeft, ctm.f - ctx.hostTop]
  return [local, mul(ctx.outer, local)]
}

/** An <svg> clips its drawing to its own box; objects cannot. Say so when a
 *  piece sticks out, because it will now show in full. */
function noteOverflow(segs: Seg[], local: Mat, strokeWidth: number, ctx: Ctx) {
  const bb = segsBBox(transformSegs(segs, local))
  if (!bb) return
  const pad = strokeWidth / 2 + 1
  if (bb.x < -pad || bb.y < -pad || bb.x + bb.w > ctx.w + pad || bb.y + bb.h > ctx.h + pad) {
    ctx.notes.add('parts that stuck out past the diagram’s frame, which were cut off before, now show in full')
  }
}

function paintOf(cs: CSSStyleDeclaration, which: 'fill' | 'stroke', alpha: number, ctx: Ctx):
  { kind: 'none' } | { kind: 'color'; color: string } | { kind: 'url'; id: string } {
  const v = cs.getPropertyValue(which).trim()
  const op = parseFloat(cs.getPropertyValue(`${which}-opacity`))
  const a = alpha * (Number.isFinite(op) ? op : 1)
  if (!v || v === 'none') return { kind: 'none' }
  const url = /^url\(\s*["']?#([^"')]+)["']?\s*\)/.exec(v)
  if (url) return { kind: 'url', id: url[1] }
  const hex = cssToHex(v, a)
  if (hex) return { kind: 'color', color: hex }
  ctx.notes.add(`a ${which} the converter could not read ("${v.slice(0, 24)}") became black`)
  return { kind: 'color', color: '#000000' }
}

/** The element a `url(#id)` names, looked up inside THIS diagram only — the same
 *  id can exist on the canvas and in thumbnails. */
const byId = (root: SVGSVGElement, id: string): Element | null => {
  for (const e of Array.from(root.querySelectorAll('[id]'))) if (e.getAttribute('id') === id) return e
  return null
}

/** Gradient stops, following `href` to a gradient that holds them. */
function stopsOf(g: Element, root: SVGSVGElement, depth = 0): Array<{ at: number; color: string }> {
  const own = Array.from(g.children).filter((c) => c.localName.toLowerCase() === 'stop')
  if (!own.length) {
    const ref = (g.getAttribute('href') ?? g.getAttribute('xlink:href') ?? '').replace(/^#/, '')
    const next = ref && depth < 6 ? byId(root, ref) : null
    return next ? stopsOf(next, root, depth + 1) : []
  }
  const out: Array<{ at: number; color: string }> = []
  for (const s of own) {
    const cs = getComputedStyle(s)
    const so = parseFloat(cs.getPropertyValue('stop-opacity'))
    const color = cssToHex(cs.getPropertyValue('stop-color'), Number.isFinite(so) ? so : 1) ?? '#000000'
    const off = (s as SVGStopElement).offset?.baseVal ?? 0
    out.push({ at: Math.max(out.at(-1)?.at ?? 0, Math.min(1, Math.max(0, off))), color })
  }
  return out
}

/** A linear SVG gradient → the model's angle + stops, laid on the shape's final
 *  box (`bx,by,bw,bh` in slide space). Returns null for anything else. */
function linearFill(g: Element, node: SVGGraphicsElement, m: Mat, box: { x: number; y: number; w: number; h: number }, ctx: Ctx):
  NonNullable<ShapeElement['fillGradient']> | null {
  const kind = g.localName.toLowerCase()
  const stops = stopsOf(g, ctx.root)
  if (!stops.length) return null
  if (kind === 'radialgradient') {
    ctx.notes.add('radial gradients became one flat colour')
    return null
  }
  if (kind !== 'lineargradient') return null
  if (g.getAttribute('gradientTransform')) ctx.notes.add('a gradient transform was ignored')
  const lg = g as SVGLinearGradientElement
  const user = (g.getAttribute('gradientUnits') ?? 'objectBoundingBox') === 'userSpaceOnUse'
  const bb = node.getBBox()
  const pos = (v: SVGAnimatedLength, axis: 'x' | 'y') => {
    const raw = v.baseVal
    if (user) return raw.value
    const frac = raw.unitType === SVGLength.SVG_LENGTHTYPE_PERCENTAGE ? raw.valueInSpecifiedUnits / 100 : raw.value
    return axis === 'x' ? bb.x + frac * bb.width : bb.y + frac * bb.height
  }
  // x2 defaults to 100%, the rest to 0%: baseVal reports that as 0 when unset, so read the attributes
  const has = (n: string) => g.hasAttribute(n)
  let [x1, y1, x2, y2] = [pos(lg.x1, 'x'), pos(lg.y1, 'y'), pos(lg.x2, 'x'), pos(lg.y2, 'y')]
  if (!has('x2') && !user) x2 = bb.x + bb.width
  const [sx, sy] = apply(m, x1, y1), [ex, ey] = apply(m, x2, y2)
  // into fractions of the final box; the model's line runs through the centre, one box long
  const fx = (x: number) => (box.w ? (x - box.x) / box.w : 0.5), fy = (y: number) => (box.h ? (y - box.y) / box.h : 0.5)
  const dx = fx(ex) - fx(sx), dy = fy(ey) - fy(sy)
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return { angle: 90, stops: [{ at: 0, color: stops.at(-1)!.color }, { at: 1, color: stops.at(-1)!.color }] }
  const ux = dx / len, uy = dy / len
  const angle = ((Math.atan2(ux, -uy) * 180) / Math.PI + 360) % 360
  const proj = (px: number, py: number) => (px - 0.5) * ux + (py - 0.5) * uy + 0.5
  const t0 = proj(fx(sx), fy(sy)), t1 = proj(fx(ex), fy(ey))
  const mapped = stops.map((s) => ({ at: Math.min(1, Math.max(0, t0 + s.at * (t1 - t0))), color: s.color }))
  if (t0 > 0.001) mapped.unshift({ at: 0, color: stops[0].color })
  if (t1 < 0.999) mapped.push({ at: 1, color: stops.at(-1)!.color })
  for (let i = 1; i < mapped.length; i++) if (mapped[i].at < mapped[i - 1].at) mapped[i].at = mapped[i - 1].at
  return { angle: Math.round(angle * 10) / 10, stops: mapped.map((s) => ({ at: Math.round(s.at * 1000) / 1000, color: s.color })) }
}

/** A flat colour standing in for a paint server that cannot be carried over. */
function flatOf(g: Element | null, root: SVGSVGElement): string {
  const stops = g ? stopsOf(g, root) : []
  return stops.length ? stops[Math.floor((stops.length - 1) / 2)].color : '#000000'
}

interface Style {
  fill: string
  fillGradient?: ShapeElement['fillGradient']
  stroke: string
  strokeWidth: number
  strokeStyle?: ShapeElement['strokeStyle']
  strokeCap?: ShapeElement['strokeCap']
  strokeJoin?: ShapeElement['strokeJoin']
  evenodd: boolean
  opacity: number
}

function styleOf(node: SVGGraphicsElement, m: Mat, box: { x: number; y: number; w: number; h: number }, alpha: number, ctx: Ctx): Style {
  const cs = getComputedStyle(node)
  const fp = paintOf(cs, 'fill', 1, ctx)
  const sp = paintOf(cs, 'stroke', 1, ctx)
  const st: Style = { fill: 'none', stroke: 'none', strokeWidth: 0, evenodd: cs.getPropertyValue('fill-rule').trim() === 'evenodd', opacity: alpha }
  if (fp.kind === 'color') st.fill = fp.color
  else if (fp.kind === 'url') {
    const g = byId(ctx.root, fp.id)
    const grad = g ? linearFill(g, node, m, box, ctx) : null
    if (grad) { st.fillGradient = grad; st.fill = grad.stops[0].color }
    else {
      st.fill = flatOf(g, ctx.root)
      if (g && g.localName.toLowerCase() === 'pattern') ctx.notes.add('a pattern fill became one flat colour')
    }
  }
  if (sp.kind !== 'none') {
    const sw = parseFloat(cs.getPropertyValue('stroke-width')) * scaleOf(m)
    if (sw > 0) {
      st.strokeWidth = Math.round(sw * 100) / 100
      st.stroke = sp.kind === 'color' ? sp.color : flatOf(byId(ctx.root, sp.id), ctx.root)
      if (sp.kind === 'url') ctx.notes.add('a gradient stroke became one flat colour')
      const dash = cs.getPropertyValue('stroke-dasharray').trim()
      const first = dash && dash !== 'none' ? parseFloat(dash) : 0
      if (first > 0) ctx.notes.add('dash patterns became the standard dashed or dotted style')
      if (first > 0) st.strokeStyle = cs.getPropertyValue('stroke-linecap').trim() === 'round' && first <= parseFloat(cs.getPropertyValue('stroke-width')) * 1.2 ? 'dotted' : 'dashed'
      const cap = cs.getPropertyValue('stroke-linecap').trim()
      if (cap === 'round' || cap === 'square') st.strokeCap = cap
      const join = cs.getPropertyValue('stroke-linejoin').trim()
      if (join === 'round' || join === 'bevel') st.strokeJoin = join
    }
  }
  return st
}

function unsupportedFor(cs: CSSStyleDeclaration, ctx: Ctx) {
  if (cs.getPropertyValue('filter').trim() && cs.getPropertyValue('filter').trim() !== 'none') ctx.notes.add('filters (blur, shadows…) were dropped')
  if (cs.getPropertyValue('clip-path').trim() && cs.getPropertyValue('clip-path').trim() !== 'none') ctx.notes.add('clip paths were dropped, so some parts may show that were hidden')
  if (cs.getPropertyValue('mask').trim() && cs.getPropertyValue('mask').trim() !== 'none') ctx.notes.add('masks were dropped, so some parts may show that were hidden')
  if (cs.getPropertyValue('marker-start').trim() !== 'none' || cs.getPropertyValue('marker-mid').trim() !== 'none' || cs.getPropertyValue('marker-end').trim() !== 'none') ctx.notes.add('line markers (arrowheads) were dropped')
}

/** A path shape for `segs` already in slide space. */
function pathShape(segs: Seg[], st: Style): ShapeElement | null {
  const bb = segsBBox(segs)
  if (!bb) return null
  const w = Math.max(bb.w, 1), h = Math.max(bb.h, 1)
  return defaultShape('path', {
    x: Math.round(bb.x * 100) / 100, y: Math.round(bb.y * 100) / 100, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100,
    d: segsToD(segs, bb.x, bb.y), pathBox: [0, 0, Math.round(w * 100) / 100, Math.round(h * 100) / 100],
    fill: st.fill, ...(st.fillGradient ? { fillGradient: st.fillGradient } : {}),
    stroke: st.stroke, strokeWidth: st.strokeWidth, radius: 0, opacity: st.opacity,
    ...(st.strokeStyle ? { strokeStyle: st.strokeStyle } : {}),
    ...(st.strokeCap ? { strokeCap: st.strokeCap } : {}),
    ...(st.strokeJoin ? { strokeJoin: st.strokeJoin } : {}),
    ...(st.evenodd ? { fillRule: 'evenodd' as const } : {}),
  })
}

function convertGeometry(node: SVGGraphicsElement, tag: string, m: Mat, ml: Mat, st0: (box: { x: number; y: number; w: number; h: number }) => Style, ctx: Ctx) {
  let segs: Seg[] | null = null
  let native: 'rect' | 'ellipse' | null = null
  let rx = 0
  const aligned = isAxisAligned(m)
  const sx = Math.abs(m[0]), sy = Math.abs(m[3])
  if (tag === 'rect') {
    const r = node as SVGRectElement
    const x = lengthOf(r.x), y = lengthOf(r.y), w = lengthOf(r.width), h = lengthOf(r.height)
    if (!(w > 0 && h > 0)) return
    let rrx = lengthOf(r.rx), rry = lengthOf(r.ry)
    if (!node.hasAttribute('rx') && node.hasAttribute('ry')) rrx = rry
    if (!node.hasAttribute('ry') && node.hasAttribute('rx')) rry = rrx
    segs = rectSegs(x, y, w, h, rrx, rry)
    if (aligned && Math.abs(rrx - rry) < 1e-6 && Math.abs(sx - sy) < 1e-4) { native = 'rect'; rx = rrx }
  } else if (tag === 'circle' || tag === 'ellipse') {
    const e = node as SVGCircleElement & SVGEllipseElement
    const cx = lengthOf(e.cx), cy = lengthOf(e.cy)
    const erx = tag === 'circle' ? lengthOf((node as SVGCircleElement).r) : lengthOf(e.rx)
    const ery = tag === 'circle' ? erx : lengthOf(e.ry)
    if (!(erx > 0 && ery > 0)) return
    segs = ellipseSegs(cx, cy, erx, ery)
    if (aligned) native = 'ellipse'
  } else if (tag === 'line') {
    const l = node as SVGLineElement
    segs = [['M', lengthOf(l.x1), lengthOf(l.y1)], ['L', lengthOf(l.x2), lengthOf(l.y2)]]
  } else if (tag === 'polyline' || tag === 'polygon') {
    segs = pointsSegs(node.getAttribute('points') ?? '', tag === 'polygon')
  } else if (tag === 'path') {
    segs = parsePath(node.getAttribute('d') ?? '')
    if (!segs) { ctx.notes.add('a path whose data could not be read was skipped'); return }
  }
  if (!segs) return
  const placed = transformSegs(segs, m)
  const bb = segsBBox(placed)
  if (!bb) return
  const st = st0(bb)
  noteOverflow(segs, ml, st.strokeWidth, ctx)
  if (tag === 'line' && st.stroke === 'none') return // a line with no stroke draws nothing
  if (st.fill === 'none' && st.stroke === 'none') return // invisible
  if (native === 'rect' || native === 'ellipse') {
    const half = st.strokeWidth / 2
    const el = defaultShape(native, {
      x: round2(bb.x - half), y: round2(bb.y - half), w: round2(bb.w + st.strokeWidth), h: round2(bb.h + st.strokeWidth),
      fill: st.fill, ...(st.fillGradient ? { fillGradient: st.fillGradient } : {}),
      stroke: st.stroke, strokeWidth: st.strokeWidth, radius: native === 'rect' ? round2(rx * sx + (rx ? half : 0)) : 0,
      opacity: st.opacity,
      ...(st.strokeStyle ? { strokeStyle: st.strokeStyle } : {}),
    })
    ctx.out.push(el)
    return
  }
  const shape = pathShape(placed, st)
  if (shape) ctx.out.push(shape)
}

const round2 = (v: number) => Math.round(v * 100) / 100
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function convertText(node: SVGTextElement, m: Mat, alpha: number, ctx: Ctx) {
  // lines: a tspan that restarts at its own x / y / dy begins a new one
  const lines: string[] = []
  let cur = ''
  const colours = new Set<string>()
  const push = () => { if (cur.trim()) lines.push(cur.replace(/\s+/g, ' ').trim()); cur = '' }
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) cur += c.textContent ?? ''
      else if (c.nodeType === Node.ELEMENT_NODE && (c as Element).localName.toLowerCase() === 'tspan') {
        const t = c as SVGTSpanElement
        if (t.hasAttribute('x') || t.hasAttribute('y') || t.hasAttribute('dy')) push()
        colours.add(getComputedStyle(t).fill)
        walk(t)
      }
    }
  }
  walk(node)
  push()
  if (!lines.length) return
  const cs = getComputedStyle(node)
  const fill = paintOf(cs, 'fill', alpha, ctx)
  const color = fill.kind === 'color' ? fill.color : fill.kind === 'url' ? flatOf(byId(ctx.root, fill.id), ctx.root) : null
  if (!color) return // text with no fill draws nothing
  if (colours.size > 1) ctx.notes.add('text with several colours or styles became one style')
  if (cs.getPropertyValue('text-decoration-line').trim() !== 'none') ctx.notes.add('text underline/strike-through was dropped')
  if (m[1] && Math.abs(m[1]) > 1e-6 && !isAxisAligned([m[0], m[1], -m[1], m[0], 0, 0], 1e-3)) ctx.notes.add('skewed text was straightened')
  const bb = node.getBBox()
  if (!(bb.width > 0 && bb.height > 0)) return
  const k = scaleOf(m)
  const rot = Math.abs(m[1]) > 1e-6 ? (Math.atan2(m[1], m[0]) * 180) / Math.PI : m[0] < 0 ? 180 : 0
  const [ccx, ccy] = apply(m, bb.x + bb.width / 2, bb.y + bb.height / 2)
  const fontSize = round2(parseFloat(cs.fontSize) * k)
  const weightRaw = cs.fontWeight
  const weight = weightRaw === 'bold' ? 700 : weightRaw === 'normal' ? 400 : Number(weightRaw) || 400
  const lineHeight = lines.length > 1 ? Math.min(2, Math.max(1, round2((bb.height * k) / (lines.length * fontSize)))) : 1.2
  const w = round2(bb.width * k * 1.25 + 8)
  const h = round2(Math.max(bb.height * k, lines.length * fontSize * lineHeight) + 4)
  const anchor = cs.getPropertyValue('text-anchor').trim()
  const el: TextElement = defaultText({
    x: round2(ccx - w / 2), y: round2(ccy - h / 2), w, h, rotation: round2(rot), opacity: 1,
    html: lines.map(escapeHtml).join('<br>'),
    fontSize, fontFamily: cs.fontFamily, fontWeight: weight, color,
    align: anchor === 'end' ? 'right' : anchor === 'middle' ? 'center' : 'left',
    valign: 'middle', lineHeight,
  })
  // the box is centred on the text's own box; a left/right anchor keeps the
  // text where it was by pinning the matching edge instead of the centre
  if (el.align !== 'center') {
    const edge = apply(m, el.align === 'right' ? bb.x + bb.width : bb.x, bb.y + bb.height / 2)
    el.x = round2(el.align === 'right' ? edge[0] - w : edge[0])
    el.y = round2(edge[1] - h / 2)
  }
  if (alpha < 1) el.opacity = alpha
  ctx.out.push(el)
}

function visit(node: Element, alpha: number, ctx: Ctx) {
  const tag = node.localName.toLowerCase()
  if (DEFS.has(tag)) return
  const cs = getComputedStyle(node)
  if (cs.display === 'none') return
  const a = alpha * (parseFloat(cs.opacity) || (cs.opacity === '0' ? 0 : 1))
  unsupportedFor(cs, ctx)
  if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') {
    for (const c of Array.from(node.children)) visit(c, a, ctx)
    return
  }
  if (cs.visibility === 'hidden' || a === 0) return
  const g = node as unknown as SVGGraphicsElement
  if (tag === 'image') { ctx.notes.add('embedded images inside the diagram were dropped'); return }
  if (tag === 'use') { ctx.notes.add('<use> copies were dropped'); return }
  if (tag === 'foreignobject') { ctx.notes.add('embedded HTML was dropped'); return }
  if (tag === 'text') {
    const ms = matrixOf(g, ctx)
    if (ms) convertText(node as SVGTextElement, ms[1], a, ctx)
    return
  }
  if (!['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(tag)) return
  const ms = matrixOf(g, ctx)
  if (!ms) return
  const m = ms[1]
  convertGeometry(g, tag, m, ms[0], (box) => styleOf(g, m, box, a, ctx), ctx)
}

export function convertSvgToObjects(el: SvgElement, doc: SlidomingoDoc): ConvertResult | { error: string } {
  const markup = el.asset ? doc.assets?.[el.asset] : el.markup
  if (!markup) return { error: 'This diagram has no content.' }
  // the diagram exactly as the canvas draws it, but upright and unshadowed at the origin:
  // the element's own rotation is composed in afterwards, over every piece alike
  const token = uid('conv')
  const clean = { ...el, id: token, x: 0, y: 0, rotation: 0, opacity: 1, shadow: undefined, blur: undefined, blend: undefined, reflection: undefined, backdropFilter: undefined } as SvgElement
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:0;top:0;width:${el.w}px;height:${el.h}px;opacity:0;pointer-events:none;z-index:-1;overflow:visible`
  host.setAttribute('aria-hidden', 'true')
  const node = renderElement(clean, doc, {})
  node.style.position = 'absolute'
  host.appendChild(node)
  document.body.appendChild(host)
  try {
    const root = node.querySelector('svg') as SVGSVGElement | null
    if (!root) return { error: 'This diagram could not be read.' }
    const rect = host.getBoundingClientRect()
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2
    const ctx: Ctx = {
      outer: mul(rotateAbout(el.rotation || 0, cx, cy), translate(el.x, el.y)), w: el.w, h: el.h,
      hostLeft: rect.left, hostTop: rect.top, root, notes: new Set(), out: [],
    }
    if (el.css?.trim()) ctx.notes.add('its animations and hover styling were dropped')
    if (el.shadow || el.blur || el.reflection || el.blend || el.backdropFilter) ctx.notes.add('the diagram’s own shadow, blur or blend effect was dropped')
    if (el.fx && Object.keys(el.fx).length) ctx.notes.add('its entrance and loop animations were dropped')
    for (const c of Array.from(root.children)) visit(c, 1, ctx)
    if (!ctx.out.length) return { error: 'Nothing in this diagram could be turned into objects.' }
    if (ctx.out.length > MAX_PIECES) return { error: `This diagram is too detailed to turn into objects (${ctx.out.length} pieces; the limit is ${MAX_PIECES}).` }
    const group = ctx.out.length > 1 ? uid('g') : undefined
    ctx.out.forEach((piece, i) => {
      piece.opacity = round2(piece.opacity * (el.opacity ?? 1))
      if (group) piece.groupId = group
      if (el.link) piece.link = el.link
      if (el.group) piece.group = el.group
      if (el.showOnHover) piece.showOnHover = el.showOnHover
      if (el.locked) piece.locked = true
      if (el.hidden) piece.hidden = true
      if (i === 0 && piece.type === 'shape' && el.provenance) piece.provenance = { ...el.provenance }
    })
    return { elements: ctx.out, notes: [...ctx.notes] }
  } finally {
    host.remove()
  }
}

