// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Align / distribute for the EDITOR (panel, ribbon, Arrange menu, keys).
// The agents' `elements` tool has its own planners in arrange.ts; this is
// the small, predictable PowerPoint-style kit.
//
// UNITS. A group (`groupId`) moves as ONE object, the way PowerPoint treats
// a group: aligning a group with other things never pulls it apart. A
// container's children follow their container (editor.syncContainers), so a
// selected child whose container is selected too is left to it.
//
// REFERENCE. 'selection' = the units' own bounding box (distribute: between
// the outermost two). 'slide' = the slide. A lone unit always uses the
// slide, since aligning something to itself does nothing. Against the slide
// the selection moves as a BLOCK (its layout kept) — PowerPoint moves each
// object on its own, which stacks them; aligning them to each other first
// and then to the slide gives that result in two steps.
//
// Pure: returns per-unit offsets, the caller moves the members inside its
// own commit. Rig: scripts/test-alignment.ts.

import type { SlideElement } from './model.ts'
import { equalGapPositions } from './layoutguard.ts'

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom'
export type AlignRef = 'selection' | 'slide'

interface Box { x: number; y: number; w: number; h: number }

export interface AlignUnit {
  members: SlideElement[]
  box: Box
}

/** An offset per unit, in `units` order. */
export interface Move { dx: number; dy: number }

export interface DistributeOpts {
  /** 'edge' = equal gaps between boxes, 'center' = equal centre spacing */
  mode?: 'edge' | 'center'
  /** a fixed gap (or centre step) in px instead of the derived one */
  gap?: number | null
}

function union(els: readonly Box[]): Box {
  const x0 = Math.min(...els.map((e) => e.x))
  const y0 = Math.min(...els.map((e) => e.y))
  const x1 = Math.max(...els.map((e) => e.x + e.w))
  const y1 = Math.max(...els.map((e) => e.y + e.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Group a selection into units: one per groupId, one per other element;
 *  children of a selected container are dropped (they follow it). */
export function alignUnits(els: readonly SlideElement[]): AlignUnit[] {
  const ids = new Set(els.map((e) => e.id))
  const byGroup = new Map<string, SlideElement[]>()
  const units: SlideElement[][] = []
  for (const el of els) {
    if (el.parentId && ids.has(el.parentId)) continue
    if (el.groupId) {
      const g = byGroup.get(el.groupId)
      if (g) { g.push(el); continue }
      const fresh = [el]
      byGroup.set(el.groupId, fresh)
      units.push(fresh)
    } else units.push([el])
  }
  return units.map((members) => ({ members, box: union(members) }))
}

/** The reference that actually applies: a lone unit always uses the slide. */
export const effectiveRef = (units: readonly AlignUnit[], ref: AlignRef): AlignRef =>
  units.length <= 1 ? 'slide' : ref

const horizontal = (e: AlignEdge) => e === 'left' || e === 'centerX' || e === 'right'

/** Where the edge of `b` lies along its axis. */
function edgeOf(b: Box, edge: AlignEdge): number {
  switch (edge) {
    case 'left': return b.x
    case 'centerX': return b.x + b.w / 2
    case 'right': return b.x + b.w
    case 'top': return b.y
    case 'middleY': return b.y + b.h / 2
    case 'bottom': return b.y + b.h
  }
}

/** Offsets that line the units up on `edge`. */
export function planAlign(units: readonly AlignUnit[], edge: AlignEdge, ref: AlignRef, slide: { width: number; height: number }): Move[] {
  if (!units.length) return []
  const along = (d: number): Move => (horizontal(edge) ? { dx: d, dy: 0 } : { dx: 0, dy: d })
  const all = union(units.map((u) => u.box))
  if (effectiveRef(units, ref) === 'slide') {
    // the whole selection moves as one block
    const d = edgeOf({ x: 0, y: 0, w: slide.width, h: slide.height }, edge) - edgeOf(all, edge)
    return units.map(() => along(d))
  }
  const target = edgeOf(all, edge)
  return units.map((u) => along(target - edgeOf(u.box, edge)))
}

/** Offsets that centre the selection (as a block) on the slide. */
export function planCenterOnSlide(units: readonly AlignUnit[], slide: { width: number; height: number }): Move[] {
  if (!units.length) return []
  const all = union(units.map((u) => u.box))
  const dx = slide.width / 2 - (all.x + all.w / 2)
  const dy = slide.height / 2 - (all.y + all.h / 2)
  return units.map(() => ({ dx, dy }))
}

/** Fewest units distribute needs against `ref`. */
export const distributeMin = (ref: AlignRef): number => (ref === 'slide' ? 1 : 3)

/**
 * Offsets that space the units evenly along `axis`, or null when there are
 * too few (3 between themselves, 1 across the slide).
 *
 * Between themselves: the outermost two stay put and the ones in between
 * move; a fixed gap instead cascades forward from the first (the last moves
 * too — a fixed gap and two fixed ends can't both hold).
 * Across the slide: equal space before, between and after (one unit ends up
 * centred); a fixed gap keeps the run centred on the slide.
 */
export function planDistribute(
  units: readonly AlignUnit[], axis: 'x' | 'y', ref: AlignRef,
  slide: { width: number; height: number }, opts: DistributeOpts = {},
): Move[] | null {
  const toSlide = ref === 'slide'
  if (units.length < distributeMin(ref)) return null
  const size = axis === 'x' ? 'w' : 'h'
  const span = axis === 'x' ? slide.width : slide.height
  const order = units.map((_, i) => i).sort((a, b) => units[a].box[axis] - units[b].box[axis])
  const boxes = order.map((i) => units[i].box)
  const sizes = boxes.map((b) => b[size])
  const n = boxes.length
  const centers = opts.mode === 'center'
  const gap = opts.gap ?? null

  // the new start (x or y) of each box, in sorted order
  let starts: number[]
  if (centers) {
    let first: number, step: number
    if (toSlide) {
      step = gap ?? span / (n + 1)
      first = gap == null ? step : span / 2 - (step * (n - 1)) / 2
    } else {
      first = boxes[0][axis] + sizes[0] / 2
      const last = boxes[n - 1][axis] + sizes[n - 1] / 2
      step = gap ?? (last - first) / (n - 1)
    }
    starts = boxes.map((_, i) => first + step * i - sizes[i] / 2)
  } else {
    const total = sizes.reduce((s, v) => s + v, 0)
    let from: number, step: number
    if (toSlide) {
      step = gap ?? (span - total) / (n + 1)
      from = gap == null ? step : (span - total - step * (n - 1)) / 2
    } else if (gap != null) {
      from = boxes[0][axis]
      step = gap
    } else {
      // the same math the layout guard re-spaces an evenly spaced run with
      starts = equalGapPositions(sizes, boxes[0][axis], boxes[n - 1][axis] + sizes[n - 1]).positions
      return toMoves(units, order, boxes, starts, axis)
    }
    starts = []
    let cursor = from
    for (const s of sizes) { starts.push(cursor); cursor += s + step }
  }
  return toMoves(units, order, boxes, starts, axis)
}

function toMoves(units: readonly AlignUnit[], order: number[], boxes: Box[], starts: number[], axis: 'x' | 'y'): Move[] {
  const moves: Move[] = units.map(() => ({ dx: 0, dy: 0 }))
  order.forEach((ui, k) => {
    const d = starts[k] - boxes[k][axis]
    moves[ui] = axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d }
  })
  return moves
}

/** Move every member of each unit by its offset (call inside a commit). */
export function applyMoves(units: readonly AlignUnit[], moves: readonly Move[]): void {
  units.forEach((u, i) => {
    const m = moves[i]
    if (!m || (!m.dx && !m.dy)) return
    for (const el of u.members) { el.x += m.dx; el.y += m.dy }
  })
}
