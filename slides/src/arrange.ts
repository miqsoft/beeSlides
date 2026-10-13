// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Arrange — layout INTENT for agents ("these cards form a grid in the free
// space"), solved here instead of by the model.
//
// WHY THIS EXISTS. An agent that only has set_frame must read every frame,
// do the arithmetic and write the boxes one call at a time. That is slow
// (one round trip per box), and it is the part models are worst at, so the
// result looks almost-but-not-quite aligned. The `elements` agent tool
// (agentops/spec.ts) hands the intent to these planners instead.
//
// UNITS. A card on a slide is several elements: a box and the texts/icons
// inside it. Arranging the texts on their own would tear cards apart, so
// every planner works on UNITS: a picked element plus everything inside its
// box (and its container children / groupId members). A picked element that
// sits inside another picked one joins that unit, so passing "all 21 ids of
// 7 cards" and "the 7 card boxes" mean the same thing. Resizing a unit maps
// its members proportionally; text grows to fit afterwards through the
// layout guard, which the caller runs in the same undo step.
//
// Pure model code, no DOM: the planners return frames and the caller applies
// them (`applyUnitFrames`) inside its commit. Rig: scripts/test-arrange.ts.

import type { SlidomingoDoc, Slide, SlideElement } from './model.ts'
import { equalGapPositions } from './layoutguard.ts'
import { isLineLike } from './editor/lineedit.ts'

export type Frame = { x: number; y: number; w: number; h: number }

export interface Unit {
  /** the element the unit is named after (the outermost picked one) */
  lead: SlideElement
  /** every element that moves with it, the lead included */
  members: SlideElement[]
  /** union of the members' frames */
  box: Frame
}

const r1 = (v: number) => Math.round(v * 10) / 10
const frameOf = (e: Frame): Frame => ({ x: e.x, y: e.y, w: e.w, h: e.h })
const area = (f: Frame) => Math.max(0, f.w) * Math.max(0, f.h)
const contains = (outer: Frame, inner: Frame, eps = 2) =>
  outer.x <= inner.x + eps && outer.y <= inner.y + eps &&
  outer.x + outer.w >= inner.x + inner.w - eps && outer.y + outer.h >= inner.y + inner.h - eps
function union(fs: Frame[]): Frame {
  const x0 = Math.min(...fs.map((f) => f.x))
  const y0 = Math.min(...fs.map((f) => f.y))
  const x1 = Math.max(...fs.map((f) => f.x + f.w))
  const y1 = Math.max(...fs.map((f) => f.y + f.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
function overlapArea(a: Frame, b: Frame): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}
const median = (vs: number[]) => {
  if (!vs.length) return 0
  const s = [...vs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** px at a 1280-wide canvas, scaled to the deck */
const scaled = (doc: SlidomingoDoc, px: number) => px * (doc.size.width / 1280)

/** A backdrop the layout never treats as content: covers most of the canvas. */
export const isBackdrop = (el: SlideElement, doc: SlidomingoDoc) =>
  area(el) >= doc.size.width * doc.size.height * 0.6

/** Elements that take no part in layout (invisible, or a backdrop). */
const inert = (el: SlideElement, doc: SlidomingoDoc) => !!el.hidden || isBackdrop(el, doc)

/** Group the picked ids into units. Unknown ids come back in `missing`;
 *  lines/connectors in `skipped` (they follow the boxes they touch). */
export function buildUnits(doc: SlidomingoDoc, slide: Slide, ids: string[]): { units: Unit[]; missing: string[]; skipped: string[] } {
  const byId = new Map(slide.elements.map((e) => [e.id, e]))
  const missing = ids.filter((id) => !byId.has(id))
  const picked = [...new Set(ids)].map((id) => byId.get(id)).filter((e): e is SlideElement => !!e)
  const skipped = picked.filter((e) => isLineLike(e)).map((e) => e.id)
  const boxes = picked.filter((e) => !isLineLike(e))
  // outermost first: a picked element inside another picked one joins it
  const byArea = [...boxes].sort((a, b) => area(b) - area(a))
  const leads: SlideElement[] = []
  const memberOf = new Map<string, SlideElement>()
  for (const e of byArea) {
    const host = leads.filter((l) => contains(l, e)).sort((a, b) => area(a) - area(b))[0]
    if (host) memberOf.set(e.id, host)
    else leads.push(e)
  }
  // everything else on the slide that lives inside a lead (smallest lead wins)
  const extra = new Map<string, SlideElement[]>(leads.map((l) => [l.id, []]))
  const taken = new Set(boxes.map((e) => e.id))
  for (const el of slide.elements) {
    if (taken.has(el.id) || inert(el, doc) || isLineLike(el)) continue
    const host = leads
      .filter((l) => el.parentId === l.id || (l.groupId && el.groupId === l.groupId) || (contains(l, el) && area(el) < area(l)))
      .sort((a, b) => area(a) - area(b))[0]
    if (host) { extra.get(host.id)!.push(el); taken.add(el.id) }
  }
  // keep the slide's order inside a unit, the reading order between units
  const order = new Map(slide.elements.map((e, i) => [e.id, i]))
  const units = leads.map((lead) => {
    const members = [lead, ...boxes.filter((e) => memberOf.get(e.id) === lead), ...extra.get(lead.id)!]
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    return { lead, members, box: union(members.map(frameOf)) }
  })
  return { units: readingOrder(units), missing, skipped }
}

/** Rows top to bottom (a new row once a centre is half a typical height
 *  below the row's first), each left to right. */
export function readingOrder<T extends { box: Frame }>(items: T[]): T[] {
  if (items.length < 2) return [...items]
  const tol = median(items.map((u) => u.box.h)) / 2
  const byY = [...items].sort((a, b) => (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2))
  const rows: T[][] = []
  for (const u of byY) {
    const row = rows[rows.length - 1]
    const cy = u.box.y + u.box.h / 2
    if (row && Math.abs(cy - (row[0].box.y + row[0].box.h / 2)) <= tol) row.push(u)
    else rows.push([u])
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x))
}

/** Move/resize each unit to its new box. Members keep their padding the way
 *  a designer resizes a card: a member spanning the box stretches with it
 *  (insets kept), one in the lower part stays anchored to the bottom, the
 *  rest keep their distance from the top; a narrower member keeps its width
 *  and its relative place across. Mutates the slide. */
export function applyUnitFrames(units: Unit[], frames: Frame[]): void {
  units.forEach((u, i) => {
    const to = frames[i]
    if (!to) return
    const b = u.box
    for (const m of u.members) {
      // horizontal
      const l = m.x - b.x, r = b.x + b.w - (m.x + m.w)
      if (l <= b.w * 0.25 && r <= b.w * 0.25) { m.x = to.x + l; m.w = Math.max(1, to.w - l - r) }
      else {
        const w = Math.min(m.w, to.w)
        const c = b.w > 0 ? (m.x + m.w / 2 - b.x) / b.w : 0.5
        m.x = to.x + c * to.w - w / 2
        m.w = w
      }
      // vertical
      const t = m.y - b.y, bt = b.y + b.h - (m.y + m.h)
      if (t <= b.h * 0.15 && bt <= b.h * 0.15) { m.y = to.y + t; m.h = Math.max(1, to.h - t - bt) }
      else if (t > b.h * 0.6) m.y = to.y + to.h - bt - m.h
      else m.y = to.y + t
      m.x = r1(m.x); m.y = r1(m.y); m.w = r1(m.w); m.h = r1(m.h)
    }
    u.box = { ...to }
  })
}

// --- regions --------------------------------------------------------------------

/** The deck's own side margin, read from where content starts (clamped to a
 *  sane band), so a region never runs into the slide edge. */
export function contentMargin(doc: SlidomingoDoc, slide: Slide): number {
  const { width } = doc.size
  const els = slide.elements.filter((e) => !inert(e, doc) && !isLineLike(e) && e.w < width * 0.9)
  const lo = scaled(doc, 24)
  const hi = scaled(doc, 96)
  if (!els.length) return scaled(doc, 64)
  const m = Math.min(...els.map((e) => Math.min(e.x, width - (e.x + e.w))))
  return Math.min(hi, Math.max(lo, m))
}

/**
 * The largest empty rectangle on the slide inside its content margins, with
 * `exclude` lifted out (the elements about to be arranged) and every other
 * element an obstacle padded by `gap`. Exact for axis-aligned boxes: every
 * pair of obstacle edges bounds a vertical strip, and the strip's tallest
 * free run is the best rectangle of that width.
 */
export function largestEmptyRect(doc: SlidomingoDoc, slide: Slide, exclude: Set<string>, gap: number): Frame | null {
  const { width, height } = doc.size
  const m = contentMargin(doc, slide)
  const L = m, R = width - m, T = m * 0.75, B = height - m * 0.75
  const obstacles = slide.elements
    .filter((e) => !exclude.has(e.id) && !inert(e, doc))
    .map((e) => ({ x0: e.x - gap, x1: e.x + e.w + gap, y0: e.y - gap, y1: e.y + e.h + gap }))
    .filter((o) => o.x1 > L && o.x0 < R && o.y1 > T && o.y0 < B)
  const xs = [...new Set([L, R, ...obstacles.flatMap((o) => [o.x0, o.x1])].filter((x) => x >= L && x <= R))].sort((a, b) => a - b)
  let best: Frame | null = null
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const x0 = xs[i], x1 = xs[j]
      const blocked = obstacles
        .filter((o) => Math.min(o.x1, x1) - Math.max(o.x0, x0) > 0.5)
        .map((o) => [Math.max(T, o.y0), Math.min(B, o.y1)] as const)
        .sort((a, b) => a[0] - b[0])
      let cursor = T
      const consider = (y0: number, y1: number) => {
        const f = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
        if (f.w > 0 && f.h > 0 && (!best || area(f) > area(best))) best = f
      }
      for (const [y0, y1] of blocked) {
        if (y0 > cursor) consider(cursor, y0)
        cursor = Math.max(cursor, y1)
      }
      if (cursor < B) consider(cursor, B)
    }
  }
  return best
}

/** The gap the units already use (median of the positive gaps between
 *  reading-order neighbours in a row), else a default. */
export function currentGap(doc: SlidomingoDoc, units: Array<Pick<Unit, 'box'>>): number {
  const gaps: number[] = []
  const ordered = readingOrder(units)
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1].box, b = ordered[i].box
    const sameRow = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > Math.min(a.h, b.h) * 0.3
    const g = sameRow ? b.x - (a.x + a.w) : b.y - (a.y + a.h)
    if (g > 0) gaps.push(g)
  }
  const g = median(gaps)
  return Math.round(g > 0 ? Math.min(scaled(doc, 64), Math.max(scaled(doc, 8), g)) : scaled(doc, 24))
}

// --- companions --------------------------------------------------------------------

/** A small caption that belongs to the arranged group (a legend under a row
 *  of cards): it is lifted out with the group and put back on the same side
 *  of the new layout, at the same distance. */
export interface Companion {
  el: SlideElement
  side: 'above' | 'below' | 'left' | 'right'
  /** distance from the group's box, px */
  dist: number
}

/** Small elements hugging the group's box (within ~2.5 gaps, outside it):
 *  legends, captions, a source line. Titles and footer pieces never count. */
export function companionsOf(doc: SlidomingoDoc, slide: Slide, units: Unit[], gap: number): Companion[] {
  if (!units.length) return []
  const group = union(units.map((u) => u.box))
  const members = new Set(units.flatMap((u) => u.members.map((m) => m.id)))
  const near = Math.max(gap * 2.5, scaled(doc, 24))
  const out: Companion[] = []
  for (const el of slide.elements) {
    if (members.has(el.id) || inert(el, doc) || isLineLike(el)) continue
    if (el.role === 'title' || el.role === 'subtitle' || (el.type === 'text' && el.footerRole)) continue
    if (area(el) > doc.size.width * doc.size.height * 0.05 || overlapArea(el, group) > 0) continue
    const dists = {
      below: el.y - (group.y + group.h), above: group.y - (el.y + el.h),
      right: el.x - (group.x + group.w), left: group.x - (el.x + el.w),
    }
    const across = { below: 'x', above: 'x', right: 'y', left: 'y' } as const
    for (const side of ['below', 'above', 'right', 'left'] as const) {
      const d = dists[side]
      if (d < 0 || d > near) continue
      // it must sit along the group, not off a corner
      const ax = across[side]
      const sz = ax === 'x' ? 'w' : 'h'
      if (Math.min(el[ax] + el[sz], group[ax] + group[sz]) - Math.max(el[ax], group[ax]) <= 0) continue
      out.push({ el, side, dist: d })
      break
    }
  }
  return out
}

/** The room companions need on each side of a region. */
export function companionRoom(cs: Companion[]): Record<Companion['side'], number> {
  const room = { above: 0, below: 0, left: 0, right: 0 }
  for (const c of cs) {
    const need = (c.side === 'above' || c.side === 'below' ? c.el.h : c.el.w) + c.dist
    room[c.side] = Math.max(room[c.side], need)
  }
  return room
}

/** Put each companion back next to the group's new box: same side, same
 *  distance, same relative position along it. Mutates the slide. */
export function placeCompanions(cs: Companion[], oldGroup: Frame, newGroup: Frame): void {
  for (const { el, side, dist } of cs) {
    if (side === 'below' || side === 'above') {
      const t = oldGroup.w > el.w ? (el.x - oldGroup.x) / (oldGroup.w - el.w) : 0
      el.x = r1(newGroup.x + Math.max(0, Math.min(1, t)) * Math.max(0, newGroup.w - el.w))
      el.y = r1(side === 'below' ? newGroup.y + newGroup.h + dist : newGroup.y - dist - el.h)
    } else {
      const t = oldGroup.h > el.h ? (el.y - oldGroup.y) / (oldGroup.h - el.h) : 0
      el.y = r1(newGroup.y + Math.max(0, Math.min(1, t)) * Math.max(0, newGroup.h - el.h))
      el.x = r1(side === 'right' ? newGroup.x + newGroup.w + dist : newGroup.x - dist - el.w)
    }
  }
}

export const unionFrame = union

// --- arrange ---------------------------------------------------------------------

export interface ArrangeOpts {
  as: 'row' | 'column' | 'grid'
  /** grid columns; default chosen to fit */
  cols?: number
  gap?: number
  /** fill = units take the cell size; keep = their own size, placed in the cell */
  size: 'fill' | 'keep'
  /** keep mode: where a unit sits across its cell */
  align: 'start' | 'center' | 'end'
  region: Frame
}

export interface ArrangePlan {
  frames: Frame[]
  cols: number
  rows: number
  gap: number
  /** problems worth telling the agent (e.g. does not fit the region) */
  notes: string[]
}

/** How far `fill` may stretch an item away from its own aspect ratio. */
const STRETCH = 1.35

/** Lay the units out on a grid in `region` (units in reading order). A
 *  short last row is centred. */
export function planArrange(doc: SlidomingoDoc, units: Array<Pick<Unit, 'box'>>, o: ArrangeOpts): ArrangePlan {
  const n = units.length
  const gap = Math.max(0, o.gap ?? currentGap(doc, units))
  const notes: string[] = []
  const reg = o.region
  let cols = o.as === 'row' ? n : o.as === 'column' ? 1 : Math.max(1, Math.min(n, Math.round(o.cols ?? 0)))
  if (o.as === 'grid' && !o.cols) cols = autoCols(units, reg, gap, o.size)
  const rows = Math.ceil(n / cols)
  // a balanced grid: 7 in 4 columns is 4+3, never 4+4 with a hole... and
  // never more columns than the fullest row needs
  if (o.as === 'grid') cols = Math.ceil(n / rows)

  const frames: Frame[] = []
  if (o.size === 'fill') {
    let cw = (reg.w - gap * (cols - 1)) / cols
    let ch = (reg.h - gap * (rows - 1)) / rows
    if (cw < 8 || ch < 8) notes.push(`the region ${fmt(reg)} is too small for ${rows}x${cols} cells with gap ${gap}`)
    // never stretch items far from their own shape (a card is not a sliver):
    // the cells keep within STRETCH of the items' aspect, the grid is centred
    const aspect = median(units.map((u) => u.box.w / Math.max(1, u.box.h))) || 1
    if (ch > (cw / aspect) * STRETCH) ch = (cw / aspect) * STRETCH
    if (cw > ch * aspect * STRETCH) cw = ch * aspect * STRETCH
    const x0 = reg.x + (reg.w - (cw * cols + gap * (cols - 1))) / 2
    const y0 = reg.y + (reg.h - (ch * rows + gap * (rows - 1))) / 2
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols)
      const c = i % cols
      const inRow = r === rows - 1 ? n - r * cols : cols
      const shift = ((cols - inRow) * (cw + gap)) / 2
      frames.push({ x: r1(x0 + shift + c * (cw + gap)), y: r1(y0 + r * (ch + gap)), w: r1(Math.max(1, cw)), h: r1(Math.max(1, ch)) })
    }
    return { frames, cols, rows, gap, notes }
  }

  // keep: columns as wide as their widest unit, rows as tall as their tallest
  const colW = Array.from({ length: cols }, (_, c) => Math.max(...units.filter((_, i) => i % cols === c).map((u) => u.box.w)))
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(...units.slice(r * cols, r * cols + cols).map((u) => u.box.h)))
  const blockW = colW.reduce((s, v) => s + v, 0) + gap * (cols - 1)
  const blockH = rowH.reduce((s, v) => s + v, 0) + gap * (rows - 1)
  if (blockW > reg.w + 1 || blockH > reg.h + 1) notes.push(`at their own size the units need ${Math.round(blockW)}x${Math.round(blockH)}, more than the region ${fmt(reg)}: use size "fill" or a larger region`)
  const x0 = reg.x + Math.max(0, (reg.w - blockW) / 2)
  const y0 = reg.y + Math.max(0, (reg.h - blockH) / 2)
  const colX = colW.map((_, c) => x0 + colW.slice(0, c).reduce((s, v) => s + v, 0) + gap * c)
  const rowY = rowH.map((_, r) => y0 + rowH.slice(0, r).reduce((s, v) => s + v, 0) + gap * r)
  units.forEach((u, i) => {
    const r = Math.floor(i / cols)
    const c = i % cols
    const inRow = r === rows - 1 ? n - r * cols : cols
    const rowW = colW.slice(0, inRow).reduce((s, v) => s + v, 0) + gap * (inRow - 1)
    const shift = inRow < cols ? (blockW - rowW) / 2 : 0
    const cellX = colX[c] + shift
    const x = cellX + (colW[c] - u.box.w) / 2
    const free = rowH[r] - u.box.h
    const y = rowY[r] + (o.align === 'start' ? 0 : o.align === 'end' ? free : free / 2)
    frames.push({ x: r1(x), y: r1(y), w: u.box.w, h: u.box.h })
  })
  return { frames, cols, rows, gap, notes }
}

/** Grid columns that suit the units: in fill mode the cell shape closest to
 *  the units' own shape (few empty cells); in keep mode the most columns
 *  that fit the region's width, balanced over the rows. */
function autoCols(units: Array<Pick<Unit, 'box'>>, reg: Frame, gap: number, size: 'fill' | 'keep'): number {
  const n = units.length
  if (size === 'keep') {
    const w = Math.max(...units.map((u) => u.box.w))
    const fit = Math.max(1, Math.min(n, Math.floor((reg.w + gap) / (w + gap))))
    return Math.ceil(n / Math.ceil(n / fit))
  }
  const aspect = median(units.map((u) => u.box.w / Math.max(1, u.box.h))) || 1
  let best = 1
  let bestScore = Infinity
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c)
    const cw = (reg.w - gap * (c - 1)) / c
    const ch = (reg.h - gap * (rows - 1)) / rows
    if (cw <= 0 || ch <= 0) continue
    const score = Math.abs(Math.log((cw / ch) / aspect)) + 0.25 * (rows * c - n)
    if (score < bestScore) { bestScore = score; best = c }
  }
  return best
}

// --- align / distribute / match size ---------------------------------------------

export type Edge = 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom'

/** Align every unit's edge to the same edge of `ref`. */
export function planAlign(units: Unit[], edge: Edge, ref: Frame): Frame[] {
  return units.map(({ box: b }) => {
    const f = { ...b }
    if (edge === 'left') f.x = ref.x
    if (edge === 'right') f.x = ref.x + ref.w - b.w
    if (edge === 'centerX') f.x = ref.x + ref.w / 2 - b.w / 2
    if (edge === 'top') f.y = ref.y
    if (edge === 'bottom') f.y = ref.y + ref.h - b.h
    if (edge === 'middleY') f.y = ref.y + ref.h / 2 - b.h / 2
    return { x: r1(f.x), y: r1(f.y), w: f.w, h: f.h }
  })
}

/** Equal gaps along `axis`: the first and last unit stay put, or with a
 *  fixed `gap` everything after the first follows it at that gap (the
 *  Arrange panel's rules). Frames come back in the units' order. */
export function planDistribute(units: Unit[], axis: 'x' | 'y', gap?: number): Frame[] {
  const size = axis === 'x' ? 'w' : 'h'
  const sorted = [...units].sort((a, b) => a.box[axis] - b.box[axis])
  const at = new Map<Unit, number>()
  if (gap != null) {
    let cursor = sorted[0].box[axis]
    for (const u of sorted) { at.set(u, cursor); cursor += u.box[size] + gap }
  } else {
    const first = sorted[0].box
    const last = sorted[sorted.length - 1].box
    const { positions } = equalGapPositions(sorted.map((u) => u.box[size]), first[axis], last[axis] + last[size])
    sorted.forEach((u, i) => at.set(u, positions[i]))
  }
  return units.map((u) => ({ ...u.box, [axis]: r1(at.get(u)!) }))
}

/** Same width and/or height for every unit (top-left corners stay). */
export function planMatchSize(units: Unit[], dim: 'w' | 'h' | 'both', ref: { w: number; h: number }): Frame[] {
  return units.map(({ box: b }) => ({
    x: b.x, y: b.y,
    w: dim === 'h' ? b.w : r1(ref.w),
    h: dim === 'w' ? b.h : r1(ref.h),
  }))
}

// --- what a delete left behind ----------------------------------------------------

/** After deleting `removed` (frames as they were): the area they covered, if
 *  it is now empty and big enough to be worth mentioning. */
export function freedRegion(doc: SlidomingoDoc, slide: Slide, removed: Frame[]): Frame | null {
  if (!removed.length) return null
  const u = union(removed)
  if (area(u) < doc.size.width * doc.size.height * 0.05) return null
  const covered = slide.elements
    .filter((e) => !inert(e, doc) && !isLineLike(e))
    .reduce((s, e) => s + overlapArea(u, e), 0)
  return covered <= area(u) * 0.1 ? { x: r1(u.x), y: r1(u.y), w: r1(u.w), h: r1(u.h) } : null
}

export const fmt = (f: Frame) => `${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.w)}x${Math.round(f.h)}`
