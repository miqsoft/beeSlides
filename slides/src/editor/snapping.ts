// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Where things snap — pure math for the canvas (editor/canvas.ts) and its rig
// (scripts/test-grid-snap.ts). DECISIONS 2026-10-13 ("Grid & Snap").
//
// Two kinds of target, with one priority rule between them:
//   • MAGNETIC lines — guides, layout columns and margins, the safe-zone
//     margins, the slide's edges/center, other objects — pull an edge or
//     center that comes within a few screen px (Moveable does the dragging
//     part; points use `snapPoint`).
//   • The GRID is firm: when no magnetic line caught an axis, the nearest of
//     the box's start / center / end lands on a grid line.
// So a deliberate alignment always beats the grid, and nothing is ever left
// floating between grid lines unless you hold ⌥ (free placement).

import type { SlidomingoDoc } from '../model'
import { layoutLines, normalizeGuides, normalizeLayoutGrid } from '../layoutgrid'
import { marginFor } from '../validate'
import type { GridPref } from './gridpref'

export interface SnapLines { x: number[]; y: number[] }

/** What the canvas currently shows, beyond the preference itself. */
export interface SnapContext {
  /** a free-floating reusable object — no page, so no page lines */
  pageless: boolean
}

/** The fixed magnetic lines for this document + preference. Guides and the
 *  column lines snap only while shown (and ticked) — you hide them to get
 *  them out of the way. The template's BORDERS — the safe-zone sides and the
 *  column grid's outer margins — snap whenever Margins is ticked, shown or
 *  not: they are the layout's rule, and Moveable draws the line it caught. */
export function staticSnapLines(doc: SlidomingoDoc, pref: GridPref, ctx: SnapContext): SnapLines {
  const out: SnapLines = { x: [], y: [] }
  if (ctx.pageless) return out
  const size = doc.size
  if (pref.showGuides && pref.snap.guides) {
    const g = normalizeGuides(doc.guides, size)
    out.x.push(...g.x)
    out.y.push(...g.y)
  }
  const grid = normalizeLayoutGrid(doc.layoutGrid, size)
  if (grid && pref.showLayout && pref.snap.layout) {
    const l = layoutLines(grid, size)
    out.x.push(...l.x)
    out.y.push(...l.y)
  }
  if (pref.snap.margins) {
    const m = marginFor(doc)
    out.x.push(m, size.width - m)
    if (grid) {
      out.x.push(grid.marginX, size.width - grid.marginX)
      out.y.push(grid.marginY, size.height - grid.marginY)
    }
  }
  return { x: [...new Set(out.x)].sort((a, b) => a - b), y: [...new Set(out.y)].sort((a, b) => a - b) }
}

/**
 * The new `start` of a span (`start`..`start+size`) that puts whichever of its
 * start, center or end is nearest a grid line ON that line (ties: start, then
 * end). `origin` shifts the grid. `step` ≤ 0 returns `start` unchanged.
 */
export function gridSnapSpan(start: number, size: number, step: number, origin = 0): number {
  if (!(step > 0)) return start
  const near = (v: number) => Math.round((v - origin) / step) * step + origin - v
  const cands = [near(start), near(start + size), near(start + size / 2)]
  let best = cands[0]
  for (const d of cands) if (Math.abs(d) < Math.abs(best) - 1e-6) best = d
  return round3(start + best)
}

/** A point snapped per axis: the nearest magnetic line within `threshold`
 *  wins; otherwise the grid (when `step` > 0); otherwise unchanged. */
export function snapPoint(p: { x: number; y: number }, lines: SnapLines, threshold: number, step: number): { x: number; y: number } {
  const axis = (v: number, list: number[]) => {
    let best: number | null = null
    for (const l of list) if (Math.abs(l - v) <= threshold && (best === null || Math.abs(l - v) < Math.abs(best - v))) best = l
    if (best !== null) return best
    return step > 0 ? Math.round(v / step) * step : v
  }
  return { x: axis(p.x, lines.x), y: axis(p.y, lines.y) }
}

/** Did a magnetic snap move this axis? Moveable reports the snapped position;
 *  `raw` is where the pointer alone would have put it. */
export function axisCaught(snapped: number, raw: number): boolean {
  return Math.abs(snapped - raw) > 0.25
}

function round3(v: number) {
  return Math.round(v * 1000) / 1000
}
