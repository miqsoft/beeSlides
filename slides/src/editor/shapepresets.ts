// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Preset shape gallery — stars, block arrows, callouts, flowchart symbols and
// friends, as GENERATORS for the existing `path` shape. Nothing here is a new
// shape kind: `presetPath(id, w, h)` returns ordinary path data in the
// ShapeElement `d` / `pathBox = [0, 0, w, h]` model, so a saved deck holds a
// plain path that every reader (old ones included) already renders and that
// the editor edits like any other path. There is no format change at all —
// a preset is forgotten the moment it is inserted (docs/DECISIONS.md).
//
// Pure (no DOM), so scripts/test-shape-presets.ts snapshots every generator.
//
// The output comes in exactly the two forms the editor itself writes, so an
// inserted preset is byte-stable under its editor:
//   - straight outlines: "M x y L x y … Z" — the Polygon tool's form
//     (lineedit.ts setPathAnchors), edited by LineEditor's corner handles;
//   - anything with a curve: serializeBezier's form — every segment an
//     explicit cubic, the closing one included, then Z — edited by
//     BezierEditor's pen handles (bezier.ts foldClosingNode).
//
// Single subpath only: both editors read a path as ONE chain of points, so a
// second `M` would be welded onto the first on the next edit. Interior lines
// (the cube's front edges, the can's rim, a predefined-process bar) are drawn
// by RETRACING — out along the line and straight back, which adds stroke but
// encloses no area — and the frame's hole is a keyhole: the inner rim runs
// the other way round and joins the outer one along the corner mitre.
//
// Generators take the real (w, h), not a unit square: corner cuts, arrow
// heads and bevels scale with min(w, h) the way PowerPoint's do, so a wide
// arrow keeps its head instead of stretching it.

import { type BezNode, type Pt, serializeBezier } from './bezier'

export type PresetCategory = 'basic' | 'stars' | 'arrows' | 'callouts' | 'flowchart'

/** Gallery sections, in display order. Labels are English source strings —
 *  the caller translates them with t() at render time. */
export const PRESET_CATEGORIES: ReadonlyArray<{ id: PresetCategory; label: string }> = [
  { id: 'basic', label: 'Basic shapes' },
  { id: 'arrows', label: 'Block arrows' },
  { id: 'stars', label: 'Stars' },
  { id: 'callouts', label: 'Callouts' },
  { id: 'flowchart', label: 'Flowchart' },
]

export interface ShapePreset {
  id: string
  /** English source string; translated by the caller (name + tooltip). */
  label: string
  category: PresetCategory
  /** default size on insert, in slide px */
  size: [number, number]
  /** path data for a w×h box, in pathBox [0, 0, w, h] */
  path: (w: number, h: number) => string
}

// ---- output helpers ---------------------------------------------------------

const r2 = (v: number) => Math.round(v * 100) / 100
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/** A closed straight outline, in the Polygon tool's own form. */
function poly(pts: Array<[number, number]>): string {
  return 'M ' + pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join(' L ') + ' Z'
}

/** Scale a point list (in any units) to exactly fill w×h. */
function fitPts(pts: Array<[number, number]>, w: number, h: number): Array<[number, number]> {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const y0 = Math.min(...ys), y1 = Math.max(...ys)
  return pts.map(([x, y]) => [((x - x0) / (x1 - x0 || 1)) * w, ((y - y0) / (y1 - y0 || 1)) * h])
}

/** Builds one closed chain of cubic nodes (BezNode, as bezier.ts edits them).
 *  Straight segments get chord-third handles — the same thing parseBezier
 *  turns an `L` into — so everything serializes as one uniform cubic chain. */
class Chain {
  nodes: BezNode[] = []
  constructor(x: number, y: number) {
    this.nodes.push({ p: { x, y } })
  }
  private get last(): BezNode {
    return this.nodes[this.nodes.length - 1]
  }
  line(x: number, y: number): this {
    const a = this.last
    const p = { x, y }
    a.out = lerp(a.p, p, 1 / 3)
    this.nodes.push({ p, in: lerp(a.p, p, 2 / 3) })
    return this
  }
  curve(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    this.last.out = { x: c1x, y: c1y }
    this.nodes.push({ p: { x, y }, in: { x: c2x, y: c2y } })
    return this
  }
  /** Elliptical arc (centre, radii) from angle a0 to a1 in degrees — y points
   *  down, so increasing angles run clockwise on screen. The chain must
   *  already stand at the a0 point. ≤90° per cubic (error < 0.03% of r). */
  arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): this {
    const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90 - 1e-9))
    const step = ((a1 - a0) / n) * (Math.PI / 180)
    const k = (4 / 3) * Math.tan(step / 4)
    let t = a0 * (Math.PI / 180)
    for (let i = 0; i < n; i++) {
      const t1 = t + step
      const p0 = { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) }
      const p1 = { x: cx + rx * Math.cos(t1), y: cy + ry * Math.sin(t1) }
      this.curve(
        p0.x - k * rx * Math.sin(t), p0.y + k * ry * Math.cos(t),
        p1.x + k * rx * Math.sin(t1), p1.y - k * ry * Math.cos(t1),
        p1.x, p1.y,
      )
      t = t1
    }
    return this
  }
  /** Close back to the start. A last node sitting on the start point becomes
   *  the closing segment itself (serializeBezier always writes one). */
  close(): BezNode[] {
    const first = this.nodes[0]
    const last = this.last
    if (this.nodes.length > 2 && Math.hypot(last.p.x - first.p.x, last.p.y - first.p.y) < 1e-6) {
      first.in = last.in
      this.nodes.pop()
    } else {
      this.line(first.p.x, first.p.y)
      first.in = this.last.in
      this.nodes.pop()
    }
    return this.nodes
  }
}

/** Exact axis-aligned bounds of a closed cubic chain (extrema of each
 *  segment, not of its control points). */
export function chainBounds(nodes: BezNode[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const take = (p: Pt) => {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x)
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y)
  }
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % nodes.length]
    const p0 = a.p, c1 = a.out ?? a.p, c2 = b.in ?? b.p, p3 = b.p
    take(p0)
    for (const ax of ['x', 'y'] as const) {
      // derivative of the cubic along this axis: qa t² + qb t + qc
      const qa = -p0[ax] + 3 * c1[ax] - 3 * c2[ax] + p3[ax]
      const qb = 2 * (p0[ax] - 2 * c1[ax] + c2[ax])
      const qc = c1[ax] - p0[ax]
      const roots: number[] = []
      if (Math.abs(qa) < 1e-12) {
        if (Math.abs(qb) > 1e-12) roots.push(-qc / qb)
      } else {
        const disc = qb * qb - 4 * qa * qc
        if (disc >= 0) {
          const s = Math.sqrt(disc)
          roots.push((-qb + s) / (2 * qa), (-qb - s) / (2 * qa))
        }
      }
      for (const t of roots) {
        if (t <= 0 || t >= 1) continue
        const u = 1 - t
        take({
          x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
        })
      }
    }
  }
  return { x0, y0, x1, y1 }
}

/** Serialize a closed chain, first scaled so its true bounds fill w×h. */
function fitChain(nodes: BezNode[], w: number, h: number): string {
  const b = chainBounds(nodes)
  const sx = w / (b.x1 - b.x0 || 1)
  const sy = h / (b.y1 - b.y0 || 1)
  const m = (p: Pt): Pt => ({ x: (p.x - b.x0) * sx, y: (p.y - b.y0) * sy })
  return serializeBezier(nodes.map((n) => ({ p: m(n.p), in: n.in && m(n.in), out: n.out && m(n.out) })), true)
}

/** Serialize a closed chain that was built in w×h coordinates already. */
const chain = (nodes: BezNode[]) => serializeBezier(nodes, true)

// ---- generators ---------------------------------------------------------------

function star(points: number, inner: number) {
  return (w: number, h: number) => {
    const pts: Array<[number, number]> = []
    for (let i = 0; i < points * 2; i++) {
      const a = (-90 + (i * 180) / points) * (Math.PI / 180)
      const rad = i % 2 ? inner : 1
      pts.push([rad * Math.cos(a), rad * Math.sin(a)])
    }
    return poly(fitPts(pts, w, h))
  }
}

/** An irregular burst — fixed jitter tables, so it is deterministic. */
function explosion(w: number, h: number) {
  const outer = [1, 0.8, 0.96, 0.76, 1, 0.86, 0.93, 0.78, 0.99, 0.84, 0.9, 0.8]
  const inner = [0.52, 0.6, 0.5, 0.62, 0.55, 0.5, 0.6, 0.53, 0.58, 0.5, 0.62, 0.55]
  const skew = [4, -6, 3, 7, -4, 5, -7, 2, 6, -3, 4, -5]
  const pts: Array<[number, number]> = []
  const n = outer.length
  for (let i = 0; i < n; i++) {
    const a = (-90 + (i * 360) / n + skew[i]) * (Math.PI / 180)
    const b = (-90 + ((i + 0.5) * 360) / n) * (Math.PI / 180)
    pts.push([outer[i] * Math.cos(a), outer[i] * Math.sin(a)])
    pts.push([inner[i] * Math.cos(b), inner[i] * Math.sin(b)])
  }
  return poly(fitPts(pts, w, h))
}

type Dir = 'right' | 'left' | 'up' | 'down'

/** Map an arrow drawn pointing RIGHT in (along, across) coordinates — `len`
 *  along the shaft, `th` across it — into a w×h box facing `dir`. */
function orient(dir: Dir, w: number, h: number, draw: (len: number, th: number) => Array<[number, number]>) {
  const horiz = dir === 'right' || dir === 'left'
  const len = horiz ? w : h
  const pts = draw(len, horiz ? h : w)
  return pts.map(([u, v]): [number, number] =>
    dir === 'right' ? [u, v] : dir === 'left' ? [w - u, v] : dir === 'down' ? [v, u] : [v, h - u])
}

function blockArrow(dir: Dir) {
  return (w: number, h: number) => poly(orient(dir, w, h, (len, th) => {
    const head = Math.min(len, th * 0.5 + Math.min(len, th) * 0.1)
    return [[0, th * 0.25], [len - head, th * 0.25], [len - head, 0], [len, th / 2], [len - head, th], [len - head, th * 0.75], [0, th * 0.75]]
  }))
}

function doubleArrow(dir: 'right' | 'down') {
  return (w: number, h: number) => poly(orient(dir, w, h, (len, th) => {
    const head = Math.min(len / 2, th * 0.5 + Math.min(len, th) * 0.1)
    return [
      [0, th / 2], [head, 0], [head, th * 0.25], [len - head, th * 0.25], [len - head, 0], [len, th / 2],
      [len - head, th], [len - head, th * 0.75], [head, th * 0.75], [head, th],
    ]
  }))
}

function notchedArrow(w: number, h: number) {
  const head = Math.min(w, h * 0.5 + Math.min(w, h) * 0.1)
  const notch = Math.min(w - head, h * 0.25)
  return poly([[0, h * 0.25], [w - head, h * 0.25], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h * 0.75], [0, h * 0.75], [notch, h / 2]])
}

function chevron(w: number, h: number) {
  const d = Math.min(w, h) * 0.5
  return poly([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h], [d, h / 2]])
}

function pentagonArrow(w: number, h: number) {
  const d = Math.min(w, h * 0.5)
  return poly([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h]])
}

function roundedRect(w: number, h: number) {
  const r = Math.min(w, h) * 0.17
  return chain(new Chain(r, 0)
    .line(w - r, 0).arc(w - r, r, r, r, -90, 0)
    .line(w, h - r).arc(w - r, h - r, r, r, 0, 90)
    .line(r, h).arc(r, h - r, r, r, 90, 180)
    .line(0, r).arc(r, r, r, r, 180, 270)
    .close())
}

function snippedRect(w: number, h: number) {
  const c = Math.min(w, h) * 0.2
  return poly([[0, 0], [w - c, 0], [w, c], [w, h], [0, h]])
}

/** A rectangle with concave (scooped) corners. */
function plaque(w: number, h: number) {
  const r = Math.min(w, h) * 0.16
  return chain(new Chain(r, 0)
    .line(w - r, 0).arc(w, 0, r, r, 180, 90)
    .line(w, h - r).arc(w, h, r, r, 270, 180)
    .line(r, h).arc(0, h, r, r, 0, -90)
    .line(0, r).arc(0, 0, r, r, 90, 0)
    .close())
}

function parallelogram(w: number, h: number) {
  const s = Math.min(w, h) * 0.25
  return poly([[s, 0], [w, 0], [w - s, h], [0, h]])
}

function trapezoid(w: number, h: number) {
  const s = Math.min(w * 0.5, Math.min(w, h) * 0.25)
  return poly([[s, 0], [w - s, 0], [w, h], [0, h]])
}

function hexagon(w: number, h: number) {
  const i = Math.min(w / 2, Math.min(w, h) * 0.2887)
  return poly([[i, 0], [w - i, 0], [w, h / 2], [w - i, h], [i, h], [0, h / 2]])
}

function octagon(w: number, h: number) {
  const c = Math.min(w, h) * 0.2929
  return poly([[c, 0], [w - c, 0], [w, c], [w, h - c], [w - c, h], [c, h], [0, h - c], [0, c]])
}

function plus(w: number, h: number) {
  const t = Math.min(w, h) * 0.34
  const xa = (w - t) / 2, xb = (w + t) / 2
  const ya = (h - t) / 2, yb = (h + t) / 2
  return poly([[xa, 0], [xb, 0], [xb, ya], [w, ya], [w, yb], [xb, yb], [xb, h], [xa, h], [xa, yb], [0, yb], [0, ya], [xa, ya]])
}

/** Picture frame: outer rim clockwise, inner rim counter-clockwise, joined
 *  along the top-left mitre (nonzero fill leaves the middle empty). */
function frame(w: number, h: number) {
  const t = Math.min(w, h) * 0.14
  return poly([[0, 0], [w, 0], [w, h], [0, h], [0, 0], [t, t], [t, h - t], [w - t, h - t], [w - t, t], [t, t]])
}

/** Cylinder: the whole top ellipse, the body, then the top's front rim
 *  retraced so it shows as a line (both loops wind the same way). */
function can(w: number, h: number) {
  const ry = Math.min(h * 0.18, w * 0.25)
  const cx = w / 2
  return chain(new Chain(0, ry)
    .arc(cx, ry, cx, ry, 180, 0).arc(cx, ry, cx, ry, 0, -180)
    .line(0, h - ry).arc(cx, h - ry, cx, ry, 180, 0)
    .line(w, ry).arc(cx, ry, cx, ry, 0, 180)
    .close())
}

/** Cube: the silhouette, then the three front edges retraced. */
function cube(w: number, h: number) {
  const d = Math.min(w, h) * 0.25
  return poly([[0, d], [d, 0], [w, 0], [w, h - d], [w - d, h], [0, h], [0, d], [w - d, d], [w, 0], [w - d, d], [w - d, h], [w - d, d]])
}

function heart(w: number, h: number) {
  return fitChain(new Chain(0.5, 0.25)
    .curve(0.5, 0.1, 0.36, 0, 0.23, 0)
    .curve(0.08, 0, 0, 0.14, 0, 0.3)
    .curve(0, 0.56, 0.3, 0.74, 0.5, 1)
    .curve(0.7, 0.74, 1, 0.56, 1, 0.3)
    .curve(1, 0.14, 0.92, 0, 0.77, 0)
    .curve(0.64, 0, 0.5, 0.1, 0.5, 0.25)
    .close(), w, h)
}

function lightning(w: number, h: number) {
  return poly(fitPts([[0.32, 0], [0.78, 0], [0.56, 0.36], [0.86, 0.36], [0.2, 1], [0.42, 0.52], [0.14, 0.52]], w, h))
}

/** Crescent: a wide arc round the left of one circle, back along a
 *  shallower arc of a second circle offset to the right. */
function moon(w: number, h: number) {
  // inner circle centre (0.9, 0) through (0.5, ±0.866): radius √0.91
  const ri = Math.sqrt(0.91)
  const ai = (Math.atan2(0.866, -0.4) * 180) / Math.PI // ≈ 114.8°
  return fitChain(new Chain(0.5, -0.866)
    .arc(0, 0, 1, 1, -60, -300)
    .arc(0.9, 0, ri, ri, ai, 360 - ai)
    .close(), w, h)
}

/** Points round an ellipse joined by outward bumps; `tail` replaces the bump
 *  after point `tail` with a pointed tail (the cloud callout). */
function cloudChain(tail?: number): BezNode[] {
  const n = 10
  const rad = [1, 0.94, 1, 0.92, 0.98, 1, 0.93, 1, 0.95, 0.97]
  const jit = [0, 5, -4, 3, -2, 4, -5, 2, -3, 4]
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (-90 + (i * 360) / n + jit[i]) * (Math.PI / 180)
    pts.push({ x: 0.5 + 0.5 * rad[i] * Math.cos(a), y: 0.5 + 0.38 * rad[i] * Math.sin(a) })
  }
  const c = new Chain(pts[0].x, pts[0].y)
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    if (i === tail) {
      const mx = (a.x + b.x) / 2 - 0.5
      const my = (a.y + b.y) / 2 - 0.5
      c.line(0.5 + mx * 1.6, 0.5 + my * 2).line(b.x, b.y)
      continue
    }
    const vx = b.x - a.x, vy = b.y - a.y
    let nx = vy, ny = -vx
    if (nx * ((a.x + b.x) / 2 - 0.5) + ny * ((a.y + b.y) / 2 - 0.5) < 0) { nx = -nx; ny = -ny }
    // control points pushed out along the normal (≈ a round bump), and
    // splayed slightly along the chord for a puffier lobe
    c.curve(a.x + nx * 0.62 - vx * 0.15, a.y + ny * 0.62 - vy * 0.15, b.x + nx * 0.62 + vx * 0.15, b.y + ny * 0.62 + vy * 0.15, b.x, b.y)
  }
  return c.close()
}

const cloud = (w: number, h: number) => fitChain(cloudChain(), w, h)
const cloudCallout = (w: number, h: number) => fitChain(cloudChain(6), w, h)

/** Speech-bubble tail along the bottom edge: base [bx0, bx1], tip (tx, h). */
function rectCallout(w: number, h: number) {
  const bh = h * 0.78
  return poly([[0, 0], [w, 0], [w, bh], [w * 0.42, bh], [w * 0.2, h], [w * 0.25, bh], [0, bh]])
}

function roundedCallout(w: number, h: number) {
  const bh = h * 0.78
  const r = Math.min(w, bh) * 0.17
  return chain(new Chain(r, 0)
    .line(w - r, 0).arc(w - r, r, r, r, -90, 0)
    .line(w, bh - r).arc(w - r, bh - r, r, r, 0, 90)
    .line(w * 0.42, bh).line(w * 0.2, h).line(w * 0.25, bh)
    .line(r, bh).arc(r, bh - r, r, r, 90, 180)
    .line(0, r).arc(r, r, r, r, 180, 270)
    .close())
}

function ovalCallout(w: number, h: number) {
  const at = (deg: number) => ({ x: 0.5 + 0.5 * Math.cos((deg * Math.PI) / 180), y: 0.4 + 0.4 * Math.sin((deg * Math.PI) / 180) })
  const a = at(140)
  return fitChain(new Chain(a.x, a.y)
    .arc(0.5, 0.4, 0.5, 0.4, 140, 475)
    .line(0.08, 1)
    .close(), w, h)
}

// flowchart symbols

const process = (w: number, h: number) => poly([[0, 0], [w, 0], [w, h], [0, h]])
const decision = (w: number, h: number) => poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])
const data = (w: number, h: number) => { const s = w * 0.2; return poly([[s, 0], [w, 0], [w - s, h], [0, h]]) }
const manualInput = (w: number, h: number) => poly([[0, h * 0.2], [w, 0], [w, h], [0, h]])

function terminator(w: number, h: number) {
  const r = Math.min(h / 2, w / 2)
  return chain(new Chain(r, 0)
    .line(w - r, 0).arc(w - r, h / 2, r, h / 2, -90, 90)
    .line(r, h).arc(r, h / 2, r, h / 2, 90, 270)
    .close())
}

function documentShape(w: number, h: number) {
  return fitChain(new Chain(0, 0)
    .line(1, 0).line(1, 0.8)
    .curve(0.6, 0.6, 0.4, 1.15, 0, 0.9)
    .close(), w, h)
}

/** Process box with a bar inside each end (retraced, so they are lines). */
function predefinedProcess(w: number, h: number) {
  const a = Math.min(w * 0.12, h * 0.4)
  return poly([[0, 0], [a, 0], [a, h], [a, 0], [w - a, 0], [w - a, h], [w - a, 0], [w, 0], [w, h], [0, h]])
}

function circle(w: number, h: number) {
  return chain(new Chain(w, h / 2).arc(w / 2, h / 2, w / 2, h / 2, 0, 360).close())
}

// ---- the catalog ---------------------------------------------------------------

export const SHAPE_PRESETS: readonly ShapePreset[] = [
  { id: 'roundRect', label: 'Rounded rectangle', category: 'basic', size: [300, 200], path: roundedRect },
  { id: 'snipRect', label: 'Snipped rectangle', category: 'basic', size: [300, 200], path: snippedRect },
  { id: 'plaque', label: 'Plaque', category: 'basic', size: [300, 200], path: plaque },
  { id: 'parallelogram', label: 'Parallelogram', category: 'basic', size: [300, 180], path: parallelogram },
  { id: 'trapezoid', label: 'Trapezoid', category: 'basic', size: [280, 180], path: trapezoid },
  { id: 'hexagon', label: 'Hexagon', category: 'basic', size: [230, 200], path: hexagon },
  { id: 'octagon', label: 'Octagon', category: 'basic', size: [200, 200], path: octagon },
  { id: 'plus', label: 'Plus', category: 'basic', size: [200, 200], path: plus },
  { id: 'frame', label: 'Frame', category: 'basic', size: [280, 200], path: frame },
  { id: 'can', label: 'Can', category: 'basic', size: [160, 220], path: can },
  { id: 'cube', label: 'Cube', category: 'basic', size: [200, 200], path: cube },
  { id: 'heart', label: 'Heart', category: 'basic', size: [200, 180], path: heart },
  { id: 'lightning', label: 'Lightning bolt', category: 'basic', size: [160, 220], path: lightning },
  { id: 'cloud', label: 'Cloud', category: 'basic', size: [280, 190], path: cloud },
  { id: 'moon', label: 'Moon', category: 'basic', size: [140, 200], path: moon },

  { id: 'rightArrow', label: 'Right arrow', category: 'arrows', size: [260, 140], path: blockArrow('right') },
  { id: 'leftArrow', label: 'Left arrow', category: 'arrows', size: [260, 140], path: blockArrow('left') },
  { id: 'upArrow', label: 'Up arrow', category: 'arrows', size: [140, 260], path: blockArrow('up') },
  { id: 'downArrow', label: 'Down arrow', category: 'arrows', size: [140, 260], path: blockArrow('down') },
  { id: 'leftRightArrow', label: 'Left-right arrow', category: 'arrows', size: [300, 140], path: doubleArrow('right') },
  { id: 'upDownArrow', label: 'Up-down arrow', category: 'arrows', size: [140, 300], path: doubleArrow('down') },
  { id: 'notchedArrow', label: 'Notched right arrow', category: 'arrows', size: [260, 140], path: notchedArrow },
  { id: 'chevron', label: 'Chevron', category: 'arrows', size: [220, 160], path: chevron },
  { id: 'pentagonArrow', label: 'Pentagon arrow', category: 'arrows', size: [260, 140], path: pentagonArrow },

  { id: 'star5', label: '5-point star', category: 'stars', size: [210, 200], path: star(5, 0.382) },
  { id: 'star6', label: '6-point star', category: 'stars', size: [210, 200], path: star(6, 0.55) },
  { id: 'star8', label: '8-point star', category: 'stars', size: [200, 200], path: star(8, 0.6) },
  { id: 'explosion', label: 'Explosion', category: 'stars', size: [240, 220], path: explosion },

  { id: 'rectCallout', label: 'Rectangular callout', category: 'callouts', size: [300, 200], path: rectCallout },
  { id: 'roundCallout', label: 'Rounded callout', category: 'callouts', size: [300, 200], path: roundedCallout },
  { id: 'ovalCallout', label: 'Oval callout', category: 'callouts', size: [300, 200], path: ovalCallout },
  { id: 'cloudCallout', label: 'Cloud callout', category: 'callouts', size: [300, 210], path: cloudCallout },

  { id: 'process', label: 'Process', category: 'flowchart', size: [240, 140], path: process },
  { id: 'decision', label: 'Decision', category: 'flowchart', size: [220, 160], path: decision },
  { id: 'terminator', label: 'Terminator', category: 'flowchart', size: [240, 110], path: terminator },
  { id: 'data', label: 'Data', category: 'flowchart', size: [240, 140], path: data },
  { id: 'document', label: 'Document', category: 'flowchart', size: [240, 150], path: documentShape },
  { id: 'predefinedProcess', label: 'Predefined process', category: 'flowchart', size: [240, 140], path: predefinedProcess },
  { id: 'manualInput', label: 'Manual input', category: 'flowchart', size: [240, 140], path: manualInput },
  { id: 'flowConnector', label: 'Flowchart connector', category: 'flowchart', size: [120, 120], path: circle },
]

/** Path data for preset `id` in a w×h box (pathBox [0, 0, w, h]), or null. */
export function presetPath(id: string, w: number, h: number): string | null {
  const p = SHAPE_PRESETS.find((x) => x.id === id)
  return p ? p.path(w, h) : null
}
