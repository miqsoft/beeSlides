// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slides/src/svgpath.ts — the pure geometry under "Convert to objects": path
// data → absolute M/L/C/Z, matrices, exact bounding boxes, and the way back to
// a short `d`. Run (bundled, like test-validate.ts):
//   slides/node_modules/.bin/esbuild scripts/test-svg-path.ts --bundle --platform=node --format=esm --outfile=/tmp/t.mjs && node /tmp/t.mjs
import {
  apply, ellipseSegs, isAxisAligned, markerVertices, mul, parsePath, pointsSegs, rectSegs, rotateAbout, scaleOf, segsBBox, segsToD, transformSegs, translate,
  type Seg,
} from '../slides/src/svgpath.ts'

let checks = 0, failures = 0
const ok = (c: boolean, m: string, d?: unknown) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.log(`  FAIL  ${m}${d === undefined ? '' : ' — ' + JSON.stringify(d)}`) } }
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps
const bbox = (d: string) => { const s = parsePath(d); return s && segsBBox(s) }

console.log('-- reading d')
ok(JSON.stringify(parsePath('M1 2 L3 4 Z')) === JSON.stringify([['M', 1, 2], ['L', 3, 4], ['Z']]), 'M L Z')
ok(JSON.stringify(parsePath('m1 2 l3 4 l-1 -1')) === JSON.stringify([['M', 1, 2], ['L', 4, 6], ['L', 3, 5]]), 'relative commands, and the first m is absolute')
ok(JSON.stringify(parsePath('M0 0 10 0 10 10')) === JSON.stringify([['M', 0, 0], ['L', 10, 0], ['L', 10, 10]]), 'extra pairs after M are lineto')
ok(JSON.stringify(parsePath('M0 0 H5 V7 h-5 v-7')) === JSON.stringify([['M', 0, 0], ['L', 5, 0], ['L', 5, 7], ['L', 0, 7], ['L', 0, 0]]), 'H V h v')
ok(JSON.stringify(parsePath('M0,0L1-1 2.5.5')) === JSON.stringify([['M', 0, 0], ['L', 1, -1], ['L', 2.5, 0.5]]), 'commas, packed signs and .5 numbers')
ok(JSON.stringify(parsePath('M1e1 2E0 l1e-1 0')) === JSON.stringify([['M', 10, 2], ['L', 10.1, 2]]), 'exponents')
const c = parsePath('M0 0 C 1 2 3 4 5 6 s 2 2 4 0')
ok(c?.[2]?.[0] === 'C' && c[2][1] === 7 && c[2][2] === 8, 'S reflects the previous control point', c?.[2])
const q = parsePath('M0 0 Q 3 6 6 0')
ok(q?.[1]?.[0] === 'C' && near(q[1][1] as number, 2) && near(q[1][2] as number, 4) && near(q[1][3] as number, 4), 'Q is raised to a cubic exactly', q?.[1])
const t = parsePath('M0 0 Q 3 6 6 0 T 12 0')
ok(t?.[2]?.[0] === 'C' && near(t[2][2] as number, -4), 'T reflects the quad control', t?.[2])
const zz = parsePath('M0 0 L4 0 L4 4 z l1 1')
ok(zz?.[4]?.[0] === 'L' && zz[4][1] === 1 && zz[4][2] === 1, 'a command after z starts at the subpath start', zz)
ok(parsePath('') === null && parsePath('L 1 2') === null && parsePath('M 1') === null && parsePath('M 0 0 X 1 1') === null && parsePath('M0 0 L1') === null, 'junk, a missing M, short arguments and unknown commands are refused, not guessed')
ok(parsePath('M 0 0 z 1 1') === null, 'numbers after z with no command are refused')

console.log('-- arcs')
const circle = bbox('M 10 0 A 10 10 0 1 1 -10 0 A 10 10 0 1 1 10 0')
ok(circle && near(circle.x, -10) && near(circle.y, -10) && near(circle.w, 20) && near(circle.h, 20), 'two half-circle arcs bound a circle exactly', circle)
const half = bbox('M 0 0 A 10 10 0 0 1 20 0')
ok(half && near(half.y, -10) && near(half.h, 10), 'a sweep=1 half circle bulges up (y down)', half)
const half2 = bbox('M 0 0 A 10 10 0 0 0 20 0')
ok(half2 && near(half2.y, 0) && near(half2.h, 10), 'sweep=0 bulges down', half2)
const packed = parsePath('M0 0 a10 10 0 0120 0')
ok(packed && packed.filter((s) => s[0] === 'C').length === 2, 'arc flags packed against the next number (…0 0120 0)', packed)
const tooSmall = bbox('M 0 0 A 1 1 0 0 1 20 0')
ok(tooSmall && near(tooSmall.w, 20) && near(tooSmall.h, 10), 'radii too small for the chord are scaled up like the spec says', tooSmall)
ok(JSON.stringify(parsePath('M 5 5 A 0 10 0 0 1 9 9')) === JSON.stringify([['M', 5, 5], ['L', 9, 9]]), 'a zero radius is a straight line')
const tilted = bbox('M 0 0 A 20 5 45 0 1 20 20')
ok(tilted && tilted.w > 0 && tilted.h > 0, 'a rotated ellipse arc parses', tilted)

console.log('-- shapes')
const rb = segsBBox(rectSegs(5, 6, 30, 20, 4, 4))!
ok(near(rb.x, 5) && near(rb.y, 6) && near(rb.w, 30) && near(rb.h, 20), 'a rounded rect has its own box')
ok(rectSegs(0, 0, 10, 10, 20, 20).filter((s) => s[0] === 'C').length === 4 && near(segsBBox(rectSegs(0, 0, 10, 10, 20, 20))!.w, 10), 'a radius past half the side is clamped')
const eb = segsBBox(ellipseSegs(50, 40, 30, 10))!
ok(near(eb.x, 20) && near(eb.y, 30) && near(eb.w, 60) && near(eb.h, 20), 'an ellipse box (extrema of the four cubics)', eb)
ok(pointsSegs('0,0 10,0 10,10', true)?.length === 4 && pointsSegs('0,0 10', false) === null && pointsSegs('0 0', false) === null, 'polygon points, and refusal of odd or short lists')

console.log('-- matrices and boxes')
const m = mul(translate(10, 20), [2, 0, 0, 3, 0, 0])
ok(JSON.stringify(apply(m, 1, 1)) === JSON.stringify([12, 23]), 'mul applies the right-hand matrix first')
ok(near(scaleOf([2, 0, 0, 3, 0, 0]), Math.sqrt(6), 1e-9) && near(scaleOf(rotateAbout(30, 5, 5)), 1, 1e-9), 'stroke scale is √|det|, unchanged by rotation')
ok(isAxisAligned([2, 0, 0, -3, 5, 5]) && !isAxisAligned(rotateAbout(10, 0, 0)) && !isAxisAligned([1, 0, 0.3, 1, 0, 0]), 'axis-aligned means no rotation or skew; flips count as aligned')
const rot = apply(rotateAbout(90, 10, 10), 20, 10)
ok(near(rot[0], 10) && near(rot[1], 20), 'rotateAbout turns clockwise on a y-down page', rot)
const tb = segsBBox(transformSegs(rectSegs(0, 0, 10, 10), rotateAbout(45, 5, 5)))!
ok(near(tb.w, 14.14, 0.05) && near(tb.h, 14.14, 0.05), 'a rotated square’s box is its diagonal')
const curve = segsBBox([['M', 0, 0], ['C', 0, 10, 10, 10, 10, 0]])!
ok(near(curve.h, 7.5), 'the box of a bump is the curve’s extremum (7.5), not its control points (10)', curve)

console.log('-- writing d')
const d = segsToD(transformSegs(parsePath('M10 10 L20 10 L20 20 Z')!, translate(0.001, 0)), 10, 10)
ok(d === 'M 0 0 L 10 0 L 10 10 Z', 'shifted to the box origin, two decimals, no -0', d)
const back = parsePath(segsToD(parsePath('M0 0 C 1.234 5.678 9 9 10 0 Z')!))
ok(back && JSON.stringify(back) === JSON.stringify([['M', 0, 0], ['C', 1.23, 5.68, 9, 9, 10, 0], ['Z']]), 'round-trips through its own output', back)
const every = (segs: Seg[]) => segs.every((s) => 'MLCZ'.includes(s[0]))
ok(every(parsePath('M0 0 q1 1 2 0 t2 0 a3 3 0 0 1 4 0 s1 1 2 2 h1 v1 z')!), 'whatever goes in, only M / L / C / Z comes out')

console.log('-- marker vertices')
const mv = markerVertices(parsePath('M0 0 L10 0 L10 10')!)
ok(mv.length === 3 && near(mv[0].angle, 0) && near(mv[2].angle, 90) && near(mv[2].x, 10) && near(mv[2].y, 10), 'start points along the first segment, end along the last (90° = down on a y-down page)', mv)
ok(near(mv[1].angle, 45), 'a middle vertex takes the bisector', mv[1])
const mc = markerVertices(parsePath('M0 0 C 0 10 10 10 10 0')!)
ok(near(mc[0].angle, 90) && near(mc[1].angle, -90), 'a curve: the tangents come from its control points', mc)
const md = markerVertices(parsePath('M0 0 C 0 0 10 0 10 0')!)
ok(near(md[0].angle, 0) && near(md[1].angle, 0), 'control points on the end points fall back to the chord', md)
const ml = markerVertices(parsePath('M20 5 L0 5')!)
ok(near(Math.abs(ml[1].angle), 180), 'a line drawn right to left ends pointing left', ml)

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\n${checks}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
