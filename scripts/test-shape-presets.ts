#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Preset shape gallery rig (slides/src/editor/shapepresets.ts) — runs without
// a DOM.
//
//   slides/node_modules/.bin/esbuild scripts/test-shape-presets.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-shape-presets.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node $TMPDIR/test-shape-presets.mjs [--update]
//
// (bundled because the editor modules use extensionless imports)
//
// Every generator, at its default size and at a few awkward ones, must give:
//   - VALID path data the editors understand: one subpath of M/L/C, closed by Z
//   - INSIDE its w×h box and FILLING it (true curve bounds, not control points)
//   - DETERMINISTIC output, pinned by the snapshot file next to this rig
//     (`--update` rewrites it after an intended change to a shape)
//   - an editor ROUND TRIP that is byte-stable: straight outlines through
//     LineEditor's anchor form (lineedit.ts setPathAnchors), curves through
//     BezierEditor's parse → fold → serialize — so selecting an inserted
//     preset and nudging nothing never rewrites it
// plus the catalog itself: ~30+ entries, unique ids, translated labels, and
// the editing invariants the presets lean on: a closed curve stays closed
// down to 2 nodes, and stacked (retraced / keyhole) anchors move as one.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldClosingNode, parseBezier, serializeBezier, stackedIndices } from '../slides/src/editor/bezier.ts'
import { isCurve } from '../slides/src/editor/beziereditor.ts'
import { setPathAnchors } from '../slides/src/editor/lineedit.ts'
import { parseAnchors } from '../slides/src/editor/patheditor.ts'
import { chainBounds, PRESET_CATEGORIES, presetPath, SHAPE_PRESETS } from '../slides/src/editor/shapepresets.ts'
import { defaultShape, type ShapeElement } from '../slides/src/model.ts'
import { de } from '../slides/src/i18n/de.ts'
import { es } from '../slides/src/i18n/es.ts'
import { fr } from '../slides/src/i18n/fr.ts'
import { it } from '../slides/src/i18n/it.ts'
import { ja } from '../slides/src/i18n/ja.ts'
import { pt } from '../slides/src/i18n/pt.ts'
import { zhHans } from '../slides/src/i18n/zh-Hans.ts'
import { zhHant } from '../slides/src/i18n/zh-Hant.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

// esbuild bundles to a temp dir, so find the repo from the cwd (run from the
// repo root, as every bundled rig is) rather than from import.meta.url
const here = dirname(fileURLToPath(import.meta.url))
const root = existsSync(join(process.cwd(), 'scripts/test-shape-presets.ts')) ? process.cwd() : join(here, '..')
const snapPath = join(root, 'scripts/test-shape-presets.snapshot.json')
const update = process.argv.includes('--update')

const EPS = 0.02 // the output is rounded to 0.01

function tokens(d: string): string[] {
  return d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
}

/** Shoelace area of a point ring (absolute). */
function area(pts: Array<{ x: number; y: number }>): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a / 2)
}

/** Sample a closed cubic chain into a polygon (for its area). */
function sampleChain(d: string): Array<{ x: number; y: number }> {
  const { nodes, closed } = parseBezier(d)
  const ns = foldClosingNode(nodes, closed)
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i], b = ns[(i + 1) % ns.length]
    const c1 = a.out ?? a.p, c2 = b.in ?? b.p
    for (let k = 0; k < 16; k++) {
      const t = k / 16, u = 1 - t
      out.push({
        x: u * u * u * a.p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.p.x,
        y: u * u * u * a.p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.p.y,
      })
    }
  }
  return out
}

function checkPath(id: string, w: number, h: number) {
  const tag = `${id} @ ${w}×${h}`
  const d = presetPath(id, w, h)!
  ok(typeof d === 'string' && d.length > 0, `${tag}: produces path data`)
  ok(d === presetPath(id, w, h), `${tag}: deterministic`)
  const tk = tokens(d)
  const cmds = tk.filter((x) => /^[A-Za-z]$/.test(x))
  const nums = tk.filter((x) => !/^[A-Za-z]$/.test(x)).map(Number)
  ok(cmds.every((c) => c === 'M' || c === 'L' || c === 'C' || c === 'Z'), `${tag}: only M/L/C/Z commands`)
  ok(cmds[0] === 'M' && cmds.filter((c) => c === 'M').length === 1, `${tag}: exactly one subpath`)
  ok(cmds[cmds.length - 1] === 'Z' && cmds.filter((c) => c === 'Z').length === 1, `${tag}: closed by a single trailing Z`)
  ok(nums.every((n) => Number.isFinite(n)), `${tag}: all coordinates finite`)
  // the same tokeniser the editors use must account for every character
  ok(d.replace(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?|[\s,]/g, '') === '', `${tag}: nothing outside the tokeniser`)

  const el = defaultShape('path', { x: 0, y: 0, w, h, d, pathBox: [0, 0, w, h] }) as ShapeElement
  if (isCurve(el)) {
    const { nodes, closed } = parseBezier(d)
    const folded = foldClosingNode(nodes, closed)
    const b = chainBounds(folded)
    ok(b.x0 >= -EPS && b.y0 >= -EPS && b.x1 <= w + EPS && b.y1 <= h + EPS,
      `${tag}: curve stays inside the box (${b.x0.toFixed(2)},${b.y0.toFixed(2)} → ${b.x1.toFixed(2)},${b.y1.toFixed(2)})`)
    ok(b.x0 <= EPS && b.y0 <= EPS && b.x1 >= w - EPS && b.y1 >= h - EPS, `${tag}: curve fills the box`)
    ok(serializeBezier(folded, closed) === d, `${tag}: BezierEditor round trip is byte-stable`)
    ok(area(sampleChain(d)) > w * h * 0.15, `${tag}: encloses a real area`)
  } else {
    const pts = parseAnchors(d)
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
    ok(Math.min(...xs) >= -EPS && Math.min(...ys) >= -EPS && Math.max(...xs) <= w + EPS && Math.max(...ys) <= h + EPS,
      `${tag}: outline stays inside the box`)
    ok(Math.min(...xs) <= EPS && Math.min(...ys) <= EPS && Math.max(...xs) >= w - EPS && Math.max(...ys) >= h - EPS,
      `${tag}: outline fills the box`)
    // LineEditor commit: anchors (slide coords) → setPathAnchors
    const copy = { ...el }
    setPathAnchors(copy, pts.map((p) => ({ x: p.x + 100, y: p.y + 50 })), { closed: true, straight: true })
    ok(copy.d === d && copy.x === 100 && copy.y === 50, `${tag}: LineEditor round trip is byte-stable`)
    ok(area(pts) > w * h * 0.15, `${tag}: encloses a real area`)
  }
}

console.log('\ncatalog')
{
  ok(SHAPE_PRESETS.length >= 30, `${SHAPE_PRESETS.length} presets (≥ 30)`)
  ok(new Set(SHAPE_PRESETS.map((p) => p.id)).size === SHAPE_PRESETS.length, 'ids are unique')
  ok(new Set(SHAPE_PRESETS.map((p) => p.label)).size === SHAPE_PRESETS.length, 'labels are unique')
  for (const c of PRESET_CATEGORIES) ok(SHAPE_PRESETS.some((p) => p.category === c.id), `category ${c.id} is not empty`)
  ok(SHAPE_PRESETS.every((p) => PRESET_CATEGORIES.some((c) => c.id === p.category)), 'every preset is in a listed category')
  ok(presetPath('no-such-shape', 10, 10) === null, 'unknown id → null')
  const catalogs = { de, es, fr, it, ja, pt, 'zh-Hans': zhHans, 'zh-Hant': zhHant } as Record<string, Record<string, string>>
  const strings = [...SHAPE_PRESETS.map((p) => p.label), ...PRESET_CATEGORIES.map((c) => c.label)]
  for (const [loc, cat] of Object.entries(catalogs)) {
    const missing = strings.filter((s) => !cat[s])
    const untranslated = strings.filter((s) => cat[s] === s && !/^\d/.test(s))
    ok(!missing.length, `${loc}: every name translated${missing.length ? ` — missing ${missing.join(', ')}` : ''}`)
    // a few honest cognates (fr Cube/Chevron/Document…) are fine; a catalog
    // padded with English copies to satisfy coverage is not
    ok(untranslated.length <= 6, `${loc}: names are real translations, not English copies${untranslated.length ? ` (${untranslated.join(', ')})` : ''}`)
  }
}

console.log('\ngenerators')
{
  const sizes: Array<[number, number]> = [[100, 100], [600, 120], [120, 600], [37.5, 333]]
  for (const p of SHAPE_PRESETS) {
    checkPath(p.id, p.size[0], p.size[1])
    for (const [w, h] of sizes) checkPath(p.id, w, h)
  }
}

console.log('\nediting')
{
  // a 2-segment closed curve (lens) must round-trip closed — before the fix
  // serializeBezier dropped the closing segment below 3 nodes, so any edit
  // opened it and lost half the shape
  const lens = 'M 0 0 C 10 -10 20 -10 30 0 C 20 10 10 10 0 0 Z'
  const lp = parseBezier(lens)
  const lf = foldClosingNode(lp.nodes, lp.closed)
  ok(lf.length === 2, 'lens folds to 2 nodes')
  ok(serializeBezier(lf, lp.closed) === lens, 'lens round trip stays closed and byte-stable')
  // deleting nodes of a closed curve down to 2 keeps it closed (BezierEditor
  // refuses to go below 3, but a 2-node closed curve must never open)
  const circle = presetPath('flowConnector', 120, 120) ?? ''
  const cp = parseBezier(circle)
  const cf = foldClosingNode(cp.nodes, cp.closed)
  ok(cf.length === 4, 'flowchart connector: 4 nodes after folding')
  const two = serializeBezier([cf[0], cf[2]], true)
  ok(/Z$/.test(two) && (two.match(/C/g) ?? []).length === 2, `closed curve cut to 2 nodes stays closed (${two})`)
  ok(serializeBezier([cf[0], cf[2]], false).indexOf('Z') === -1, 'an open 2-node curve stays open')

  // stacked anchors: moving one stack as a group must not create a new
  // distinct vertex (= the outline tearing) nor leave a copy behind
  const key = (p: { x: number; y: number }) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`
  for (const id of ['frame', 'cube', 'can', 'predefinedProcess']) {
    const preset = SHAPE_PRESETS.find((p) => p.id === id)
    if (!preset) { ok(false, `${id}: preset exists`); continue }
    const d = preset.path(preset.size[0], preset.size[1])
    const el = defaultShape('path', { x: 0, y: 0, w: preset.size[0], h: preset.size[1], d, pathBox: [0, 0, preset.size[0], preset.size[1]] }) as ShapeElement
    const pts = isCurve(el)
      ? (() => { const q = parseBezier(d); return foldClosingNode(q.nodes, q.closed).map((n) => n.p) })()
      : parseAnchors(d)
    const distinct = new Set(pts.map(key)).size
    ok(distinct < pts.length, `${id}: has stacked anchors (${pts.length} anchors, ${distinct} spots)`)
    let allGood = true
    for (let i = 0; i < pts.length; i++) {
      const group = stackedIndices(pts, i)
      const moved = pts.map((p, j) => (group.includes(j) ? { x: p.x + 7, y: p.y + 5 } : p))
      const left = moved.some((p) => key(p) === key(pts[i]))
      if (new Set(moved.map(key)).size !== distinct || left) allGood = false
    }
    ok(allGood, `${id}: dragging any anchor moves its whole stack (no tear)`)
  }
  ok(stackedIndices([{ x: 0, y: 0 }, { x: 0.01, y: 0 }, { x: 1, y: 0 }], 0).join() === '0,1', 'stackedIndices: within 0.05 only')
}

console.log('\nsnapshot')
{
  const now: Record<string, string> = {}
  for (const p of SHAPE_PRESETS) now[p.id] = p.path(p.size[0], p.size[1])
  if (update || !existsSync(snapPath)) {
    writeFileSync(snapPath, JSON.stringify(now, null, 2) + '\n')
    console.log(`  wrote ${snapPath}`)
  } else {
    const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as Record<string, string>
    for (const id of Object.keys(now)) ok(snap[id] === now[id], `${id}: matches the snapshot`)
    for (const id of Object.keys(snap)) ok(id in now, `${id}: snapshot entry still has a generator`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
