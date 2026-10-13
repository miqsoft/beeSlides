// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The deck's layout grid and guides — DESIGN data that travels with the file
// (`doc.layoutGrid`, `doc.guides`), unlike the drawing grid, which is a viewer
// preference (editor/gridpref.ts). Pure: the editor draws and snaps to what
// this module computes, and agents place content by the same columns.
// DECISIONS 2026-10-13 ("Grid & Snap").

import type { SlidomingoDoc } from './model'

/** Columns (and optional rows) inside outer margins — InDesign/Figma style.
 *  Every length is slide px, in the same space as `doc.size`. */
export interface LayoutGrid {
  /** 1..MAX_TRACKS */
  columns: number
  /** 0/absent = no rows; 1..MAX_TRACKS */
  rows?: number
  /** space between two columns, and between two rows */
  gutter: number
  /** left and right margin */
  marginX: number
  /** top and bottom margin */
  marginY: number
}

/** Guides at fixed slide px, deck-wide (every slide and slide type). */
export interface Guides { x?: number[]; y?: number[] }

export const MAX_TRACKS = 24

/** One column or row: where it starts and how long it is. */
export interface Track { start: number; size: number }

type Size = { width: number; height: number }

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round1 = (v: number) => Math.round(v * 10) / 10

/** A sensible first grid for this page: 12 columns, a 24 px gutter and the
 *  margins of the 1280×720 reference (the safe zone's 96 px sides, 64 px top
 *  and bottom), scaled to the page. */
export function defaultLayoutGrid(size: Size): LayoutGrid {
  const kx = size.width / 1280
  const ky = size.height / 720
  return { columns: 12, rows: 0, gutter: Math.round(24 * kx), marginX: Math.round(96 * kx), marginY: Math.round(64 * ky) }
}

/** A stored grid made safe to compute with (null = none). Margins never eat
 *  more than the page; a gutter never makes a track narrower than 1 px. */
export function normalizeLayoutGrid(g: unknown, size: Size): LayoutGrid | null {
  if (!g || typeof g !== 'object') return null
  const o = g as Record<string, unknown>
  const columns = Math.round(num(o.columns, 0))
  if (columns < 1) return null
  const out: LayoutGrid = {
    columns: Math.min(MAX_TRACKS, columns),
    rows: clamp(Math.round(num(o.rows, 0)), 0, MAX_TRACKS),
    gutter: Math.max(0, num(o.gutter, 0)),
    marginX: clamp(num(o.marginX, 0), 0, size.width / 2 - 1),
    marginY: clamp(num(o.marginY, 0), 0, size.height / 2 - 1),
  }
  return out
}

function tracks(n: number, from: number, length: number, gutter: number): Track[] {
  if (n < 1 || length <= 0) return []
  const g = Math.min(gutter, n > 1 ? Math.max(0, (length - n) / (n - 1)) : 0)
  const size = (length - g * (n - 1)) / n
  return Array.from({ length: n }, (_, i) => ({ start: round1(from + i * (size + g)), size: round1(size) }))
}

/** The grid's columns and rows (rows empty when the grid has none). */
export function layoutTracks(g: LayoutGrid, size: Size): { columns: Track[]; rows: Track[] } {
  return {
    columns: tracks(g.columns, g.marginX, size.width - 2 * g.marginX, g.gutter),
    rows: tracks(g.rows ?? 0, g.marginY, size.height - 2 * g.marginY, g.gutter),
  }
}

/** Every line an edge can snap to: the margins plus each track's two edges.
 *  The top and bottom margins count even without rows. */
export function layoutLines(g: LayoutGrid, size: Size): { x: number[]; y: number[] } {
  const { columns, rows } = layoutTracks(g, size)
  const x = [g.marginX, size.width - g.marginX, ...columns.flatMap((c) => [c.start, c.start + c.size])]
  const y = [g.marginY, size.height - g.marginY, ...rows.flatMap((r) => [r.start, r.start + r.size])]
  return { x: uniq(x), y: uniq(y) }
}

/** The box that spans columns `from`..`to` (1-based, inclusive) and, given,
 *  rows likewise — else the content area's full height. Out-of-range picks
 *  are clamped. What an agent means by "put it in columns 7–12". */
export function spanRect(
  g: LayoutGrid, size: Size,
  cols: [number, number], rows?: [number, number],
): { x: number; y: number; w: number; h: number } {
  const t = layoutTracks(g, size)
  const pick = (list: Track[], [a, b]: [number, number]) => {
    const i = clamp(Math.round(Math.min(a, b)) - 1, 0, list.length - 1)
    const j = clamp(Math.round(Math.max(a, b)) - 1, 0, list.length - 1)
    return { start: list[i].start, size: round1(list[j].start + list[j].size - list[i].start) }
  }
  const c = pick(t.columns, cols)
  const r = rows && t.rows.length ? pick(t.rows, rows) : { start: g.marginY, size: round1(size.height - 2 * g.marginY) }
  return { x: c.start, y: r.start, w: c.size, h: r.size }
}

/** "columns 7-12", "cols 3", "columns 1-6 rows 2-3" → the 1-based spans
 *  `spanRect` takes (null when the text is not such a span). How an agent
 *  names a region by the layout grid (elements arrange `within`). */
export function parseSpan(s: string): { cols: [number, number]; rows?: [number, number] } | null {
  const m = /^\s*col(?:umn)?s?\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?(?:\s*,?\s*rows?\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?)?\s*$/i.exec(s)
  if (!m) return null
  const a = +m[1], b = m[2] ? +m[2] : a
  return m[3] ? { cols: [a, b], rows: [+m[3], m[4] ? +m[4] : +m[3]] } : { cols: [a, b] }
}

/** Stored guides made safe: finite, on the page, sorted, no duplicates. */
export function normalizeGuides(g: unknown, size: Size): { x: number[]; y: number[] } {
  const o = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>
  const list = (v: unknown, max: number) =>
    uniq((Array.isArray(v) ? v : []).filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max).map(round1))
  return { x: list(o.x, size.width), y: list(o.y, size.height) }
}

/** The doc's guides with one added, moved or removed — `to` null removes.
 *  Writes `doc.guides` (deleted when empty); call inside a store commit. */
export function setGuide(doc: SlidomingoDoc, axis: 'x' | 'y', from: number | null, to: number | null): void {
  const g = normalizeGuides(doc.guides, doc.size)
  let list = g[axis]
  if (from !== null) {
    const i = list.findIndex((v) => Math.abs(v - from) < 0.05)
    if (i >= 0) list.splice(i, 1)
  }
  if (to !== null && to >= 0 && to <= (axis === 'x' ? doc.size.width : doc.size.height)) list.push(round1(to))
  list = uniq(list)
  g[axis] = list
  if (g.x.length || g.y.length) doc.guides = { ...(g.x.length ? { x: g.x } : {}), ...(g.y.length ? { y: g.y } : {}) }
  else delete doc.guides
}

function uniq(v: number[]): number[] {
  return [...new Set(v.map(round1))].sort((a, b) => a - b)
}
