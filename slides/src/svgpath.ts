// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// SVG path geometry for "Convert to objects" (svgconvert.ts): read a path's
// `d`, turn every command into absolute M / L / C / Z, push the points through
// an affine matrix, measure the result and write it back as a short `d`.
//
// Pure — no DOM — so scripts/test-svg-path.ts runs it in node. What the editor's
// own path tools understand is M / L / C / Z (editor/bezier.ts parseBezier); the
// SVG commands it does not (Q, T, S, A, H, V and every relative form) are
// resolved HERE, so a converted shape edits like a hand-drawn one.

/** [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f (the SVG matrix order). */
export type Mat = readonly [number, number, number, number, number, number]

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** `m1 · m2`: apply m2 first, then m1. */
export function mul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y]

/** Rotation by `deg` clockwise (y points down) about (cx, cy). */
export function rotateAbout(deg: number, cx: number, cy: number): Mat {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r), sin = Math.sin(r)
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]
}

export const apply = (m: Mat, x: number, y: number): [number, number] =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** Uniform-equivalent scale of a matrix (√|det|): what a stroke width becomes. */
export const scaleOf = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))

/** Axis-aligned: no rotation or skew — only scale, flip and translate. */
export const isAxisAligned = (m: Mat, eps = 1e-6): boolean => Math.abs(m[1]) < eps && Math.abs(m[2]) < eps

export type Seg =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z']

// --- reading `d` ----------------------------------------------------------------

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y

/** Straight from the spec's endpoint-to-centre arc conversion (F.6.5), cut into
 *  ≤ 90° pieces so each is one cubic. */
function arcToCubics(x0: number, y0: number, rxIn: number, ryIn: number, rotDeg: number, large: boolean, sweep: boolean, x: number, y: number): Seg[] {
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn)
  if (!rx || !ry || (x0 === x && y0 === y)) return x0 === x && y0 === y ? [] : [['L', x, y]]
  const phi = (rotDeg * Math.PI) / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2
  const x1 = cosP * dx + sinP * dy, y1 = -sinP * dx + cosP * dy
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  let co = den ? Math.sqrt(Math.max(0, num / den)) : 0
  if (large === sweep) co = -co
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const ux = (x1 - cxp) / rx, uy = (y1 - cyp) / ry
  const vx = (-x1 - cxp) / rx, vy = (-y1 - cyp) / ry
  const th1 = ang(1, 0, ux, uy)
  let dth = ang(ux, uy, vx, vy)
  if (!sweep && dth > 0) dth -= 2 * Math.PI
  else if (sweep && dth < 0) dth += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9))
  const step = dth / n
  const t = (4 / 3) * Math.tan(step / 4)
  const out: Seg[] = []
  const pt = (a: number): [number, number] => {
    const ex = rx * Math.cos(a), ey = ry * Math.sin(a)
    return [cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy]
  }
  const dpt = (a: number): [number, number] => {
    const ex = -rx * Math.sin(a), ey = ry * Math.cos(a)
    return [cosP * ex - sinP * ey, sinP * ex + cosP * ey]
  }
  let a = th1
  for (let i = 0; i < n; i++) {
    const b = a + step
    const [px, py] = pt(a), [qx, qy] = i === n - 1 ? [x, y] : pt(b)
    const [dax, day] = dpt(a), [dbx, dby] = dpt(b)
    out.push(['C', px + t * dax, py + t * day, qx - t * dbx, qy - t * dby, qx, qy])
    a = b
  }
  return out
}

/**
 * Path data → absolute segments, or null when it does not parse (a stray token,
 * a command with too few numbers). Relative, shorthand (H V S T), quadratic and
 * arc commands are all resolved; the result holds only M, L, C and Z.
 */
export function parsePath(d: string): Seg[] | null {
  const out: Seg[] = []
  let i = 0
  const n = d.length
  const skip = () => { while (i < n && /[\s,]/.test(d[i])) i++ }
  const num = (): number | null => {
    skip()
    NUM.lastIndex = i
    const m = NUM.exec(d)
    if (!m) return null
    i = NUM.lastIndex
    return Number(m[0])
  }
  const flag = (): boolean | null => {
    skip()
    const ch = d[i]
    if (ch !== '0' && ch !== '1') return null
    i++
    return ch === '1'
  }
  let cx = 0, cy = 0, sx = 0, sy = 0 // current point, subpath start
  let lastC: [number, number] | null = null // previous cubic's 2nd control (for S)
  let lastQ: [number, number] | null = null // previous quad's control (for T)
  let cmd = ''
  let started = false
  skip()
  while (i < n) {
    skip()
    if (i >= n) break
    const ch = d[i]
    if (/[A-Za-z]/.test(ch)) {
      if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) return null
      cmd = ch
      i++
      if (cmd === 'Z' || cmd === 'z') {
        if (started) out.push(['Z'])
        cx = sx; cy = sy; lastC = lastQ = null
        continue
      }
    } else if (!cmd || cmd === 'Z' || cmd === 'z') {
      return null // numbers with no command to take them
    }
    if (!started && cmd !== 'M' && cmd !== 'm') return null
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const nx = (v: number) => (rel ? cx + v : v)
    const ny = (v: number) => (rel ? cy + v : v)
    if (C === 'M') {
      const x = num(), y = num()
      if (x === null || y === null) return null
      cx = nx(x); cy = ny(y); sx = cx; sy = cy
      out.push(['M', cx, cy]); started = true
      cmd = rel ? 'l' : 'L' // further pairs are lineto
      lastC = lastQ = null
    } else if (C === 'L') {
      const x = num(), y = num()
      if (x === null || y === null) return null
      cx = nx(x); cy = ny(y); out.push(['L', cx, cy]); lastC = lastQ = null
    } else if (C === 'H') {
      const x = num(); if (x === null) return null
      cx = rel ? cx + x : x; out.push(['L', cx, cy]); lastC = lastQ = null
    } else if (C === 'V') {
      const y = num(); if (y === null) return null
      cy = rel ? cy + y : y; out.push(['L', cx, cy]); lastC = lastQ = null
    } else if (C === 'C' || C === 'S') {
      let x1: number, y1: number
      if (C === 'C') {
        const a = num(), b = num()
        if (a === null || b === null) return null
        x1 = nx(a); y1 = ny(b)
      } else {
        x1 = lastC ? 2 * cx - lastC[0] : cx
        y1 = lastC ? 2 * cy - lastC[1] : cy
      }
      const a2 = num(), b2 = num(), a3 = num(), b3 = num()
      if (a2 === null || b2 === null || a3 === null || b3 === null) return null
      const x2 = nx(a2), y2 = ny(b2), x = nx(a3), y = ny(b3)
      out.push(['C', x1, y1, x2, y2, x, y])
      lastC = [x2, y2]; lastQ = null; cx = x; cy = y
    } else if (C === 'Q' || C === 'T') {
      let qx: number, qy: number
      if (C === 'Q') {
        const a = num(), b = num()
        if (a === null || b === null) return null
        qx = nx(a); qy = ny(b)
      } else {
        qx = lastQ ? 2 * cx - lastQ[0] : cx
        qy = lastQ ? 2 * cy - lastQ[1] : cy
      }
      const a2 = num(), b2 = num()
      if (a2 === null || b2 === null) return null
      const x = nx(a2), y = ny(b2)
      out.push(['C', cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y])
      lastQ = [qx, qy]; lastC = null; cx = x; cy = y
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num()
      const large = flag(), sweep = flag()
      const a = num(), b = num()
      if (rx === null || ry === null || rot === null || large === null || sweep === null || a === null || b === null) return null
      const x = nx(a), y = ny(b)
      out.push(...arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y))
      cx = x; cy = y; lastC = lastQ = null
    }
  }
  return started ? out : null
}

// --- primitives as segments -------------------------------------------------------

const KAPPA = 0.5522847498307936

export function ellipseSegs(cx: number, cy: number, rx: number, ry: number): Seg[] {
  const kx = rx * KAPPA, ky = ry * KAPPA
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['Z'],
  ]
}

export function rectSegs(x: number, y: number, w: number, h: number, rxIn = 0, ryIn = 0): Seg[] {
  const rx = Math.min(Math.max(rxIn, 0), w / 2), ry = Math.min(Math.max(ryIn, 0), h / 2)
  if (!rx || !ry) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']]
  const kx = rx * KAPPA, ky = ry * KAPPA
  return [
    ['M', x + rx, y], ['L', x + w - rx, y],
    ['C', x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry],
    ['L', x + w, y + h - ry],
    ['C', x + w, y + h - ry + ky, x + w - rx + kx, y + h, x + w - rx, y + h],
    ['L', x + rx, y + h],
    ['C', x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry],
    ['L', x, y + ry],
    ['C', x, y + ry - ky, x + rx - kx, y, x + rx, y],
    ['Z'],
  ]
}

/** `points="x,y x,y …"` of a polygon/polyline; null when a pair is missing. */
export function pointsSegs(points: string, close: boolean): Seg[] | null {
  const nums = points.trim().split(/[\s,]+/).filter(Boolean).map(Number)
  if (nums.length < 4 || nums.length % 2 || nums.some((v) => !Number.isFinite(v))) return null
  const out: Seg[] = []
  for (let i = 0; i < nums.length; i += 2) out.push([i ? 'L' : 'M', nums[i], nums[i + 1]])
  if (close) out.push(['Z'])
  return out
}

// --- transforming, measuring, writing -----------------------------------------------

export function transformSegs(segs: readonly Seg[], m: Mat): Seg[] {
  return segs.map((s): Seg => {
    if (s[0] === 'Z') return s
    if (s[0] === 'C') {
      const [x1, y1] = apply(m, s[1], s[2]), [x2, y2] = apply(m, s[3], s[4]), [x, y] = apply(m, s[5], s[6])
      return ['C', x1, y1, x2, y2, x, y]
    }
    const [x, y] = apply(m, s[1], s[2])
    return [s[0], x, y]
  })
}

/** Roots in (0, 1) of the derivative of one cubic Bézier coordinate. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0
  const ts: number[] = []
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b)
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) { const q = Math.sqrt(disc); ts.push((-b + q) / (2 * a), (-b - q) / (2 * a)) }
  }
  return ts.filter((t) => t > 0 && t < 1)
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/** Exact bounding box of the drawn geometry (not the control points). */
export function segsBBox(segs: readonly Seg[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const add = (x: number, y: number) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  let cx = 0, cy = 0, sx = 0, sy = 0
  for (const s of segs) {
    if (s[0] === 'M') { cx = sx = s[1]; cy = sy = s[2]; add(cx, cy) }
    else if (s[0] === 'L') { cx = s[1]; cy = s[2]; add(cx, cy) }
    else if (s[0] === 'C') {
      for (const t of cubicExtrema(cx, s[1], s[3], s[5])) add(cubicAt(cx, s[1], s[3], s[5], t), cubicAt(cy, s[2], s[4], s[6], t))
      for (const t of cubicExtrema(cy, s[2], s[4], s[6])) add(cubicAt(cx, s[1], s[3], s[5], t), cubicAt(cy, s[2], s[4], s[6], t))
      cx = s[5]; cy = s[6]; add(cx, cy)
    } else { cx = sx; cy = sy }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null
}

const r2 = (v: number) => {
  const s = (Math.round(v * 100) / 100).toString()
  return s === '-0' ? '0' : s
}

/** Segments → `d`, shifted by (-ox, -oy), two decimals. */
export function segsToD(segs: readonly Seg[], ox = 0, oy = 0): string {
  return segs.map((s) => {
    if (s[0] === 'Z') return 'Z'
    if (s[0] === 'C') return `C ${r2(s[1] - ox)} ${r2(s[2] - oy)} ${r2(s[3] - ox)} ${r2(s[4] - oy)} ${r2(s[5] - ox)} ${r2(s[6] - oy)}`
    return `${s[0]} ${r2(s[1] - ox)} ${r2(s[2] - oy)}`
  }).join(' ')
}
