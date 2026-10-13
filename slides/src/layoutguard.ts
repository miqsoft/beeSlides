// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Layout guard — keep what is AROUND an edit intact.
//
// WHY THIS EXISTS. An edit addressed at one element (an agent's set_frame or
// update_element, a write_slide, a hand resize) changes exactly that element.
// Nothing near it adapts: text that grew spills over the box below, an arrow
// that touched a card keeps pointing at where the card used to be, a stack
// that had even gaps now has one crushed gap and one huge one. The format is
// absolute pixels, so none of that is anybody's job unless something makes it
// one. This is that something, for the PREDICTABLE cases; what is left is
// reported, so the agent (or the user, via Tidy) can decide.
//
// Pure model code: it reads and (with `apply`) mutates one `Slide` in place
// and never touches the DOM. Text measurement is injected (`measure`), so the
// same engine runs in the editor (real renderer, measure.ts), in node rigs
// (a stub) and in check_layout. Callers wrap `apply` in one store.commit, so
// the fixes ride the same undo step as the edit that caused them.
//
// The passes, in order — what one pass moves feeds the next:
//   1. grow text to fit       — a changed text box that fitted before and no
//                               longer does gets h = measured (valign anchors)
//   2. reflow neighbours      — a SIZE change pushes (or pulls) everything
//                               stacked after it along that axis, keeping the
//                               old gaps; a widened member of an evenly spaced
//                               row is redistributed within the row's span;
//                               a card that contained the edit grows with it.
//                               A pure move is intentional: no reflow.
//   3. arrows follow          — bound connectors re-route (any slide, not just
//                               the open one); a free line that touched a box
//                               that moved is re-projected, and bound when its
//                               end sits on a side midpoint / the auto point
//   4. detect overlaps        — new partial intersections involving anything
//                               changed or moved, with a suggested frame
//   5. uneven gaps            — a run that was evenly spaced and is not now

import type { ShapeElement, SlidomingoDoc, Slide, SlideElement, TextElement } from './model.ts'
import { isFullBleed, isFurniture, marginFor, type Finding } from './validate.ts'
import {
  borderPoint, boxCenter, isLineLike, lineEndpoints, pathAnchors, pathIsClosed, pathIsStraight,
  rerouteConnectors, setLineEndpoints, setPathAnchors, sideMidpoint,
} from './editor/lineedit.ts'

export type Frame = { x: number; y: number; w: number; h: number }
/** What an element looked like before the edit — the guard's baseline. */
export type BaselineEntry = Frame & { html?: string; fontSize?: number; rotation?: number }
export type Baseline = Map<string, BaselineEntry>

export interface Adjustment {
  element: string
  kind: 'grow' | 'shift' | 'redistribute' | 'grow-card' | 'reroute' | 'follow' | 'bind' | 'follow-parent'
  /** one line, written for an agent: "moved b3 down 40px to keep its gap" */
  message: string
  frame: Frame
}

/** A Finding plus the layout-specific extras an agent can act on directly. */
export interface LayoutFinding extends Finding {
  /** every element the finding is about (element = the first) */
  elements?: string[]
  /** a frame for `element` that would resolve it */
  suggest?: Frame
}

export interface GuardOpts {
  /** ids the edit changed; default = every element whose frame/html/fontSize
   *  differs from `before`, plus every element `before` doesn't know (new) */
  changed?: Set<string>
  /** measured content height of a text element at its current width */
  measure?: (el: TextElement) => number
  /** false = report only: nothing on the slide is touched */
  apply: boolean
  /** canvas bounds for no-room checks; default doc.size */
  canvas?: { width: number; height: number }
  /** Tidy's static mode: grow changed text even if it already overflowed */
  growAll?: boolean
  /** The edit PLACED every changed element on purpose (an agent's arrange /
   *  align / distribute): all of them are pinned, so nothing is reflowed
   *  around them. Text still grows to fit, arrows still follow, overlaps
   *  are still reported. */
  placed?: boolean
}

export interface GuardResult {
  adjusted: Adjustment[]
  issues: LayoutFinding[]
}

// --- tunables ---------------------------------------------------------------
/** px slack when deciding "at or below the old bottom" */
const TOL = 2
/** two boxes share a column/row when they overlap this much of the narrower */
const SHARE = 0.3
/** ±px for "near-equal gaps" */
const GAP_EQ = 4
/** a free line end within this of a box border was touching it */
const TOUCH = 6
/** a box nested in another should sit at least this far inside it (px at 1280 wide) */
const INSET_MIN = 12

const r1 = (v: number) => Math.round(v * 10) / 10
const frameOf = (e: Frame): Frame => ({ x: e.x, y: e.y, w: e.w, h: e.h })
const sameFrame = (a: Frame, b: Frame, eps = 0.5) =>
  Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps
const isRotated = (el: SlideElement) => Math.abs(((el.rotation ?? 0) % 360 + 360) % 360) > 1 && Math.abs(((el.rotation ?? 0) % 360 + 360) % 360 - 360) > 1
const contains = (outer: Frame, inner: Frame, eps = 1) =>
  outer.x <= inner.x + eps && outer.y <= inner.y + eps &&
  outer.x + outer.w >= inner.x + inner.w - eps && outer.y + outer.h >= inner.y + inner.h - eps
function intersection(a: Frame, b: Frame): { w: number; h: number } | null {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 1 && h > 1 ? { w, h } : null
}
/** Overlap of a and b across `axis` (the OTHER axis's extent), as a share of
 *  the narrower of the two. */
function crossShare(a: Frame, b: Frame, axis: 'x' | 'y'): number {
  const [p, s] = axis === 'y' ? ['x', 'w'] as const : ['y', 'h'] as const
  const ov = Math.min(a[p] + a[s], b[p] + b[s]) - Math.max(a[p], b[p])
  const narrow = Math.min(a[s], b[s])
  return narrow > 0 ? ov / narrow : 0
}

/** Snapshot every element's frame (+ text content) — the `before` for guardLayout. */
export function snapshotSlide(slide: Slide): Baseline {
  const out: Baseline = new Map()
  for (const e of slide.elements) {
    out.set(e.id, {
      ...frameOf(e),
      rotation: e.rotation,
      ...(e.type === 'text' ? { html: e.html, fontSize: e.fontSize } : {}),
    })
  }
  return out
}

/** Equal-gap positions for items of `sizes` laid out from `start` to `end`
 *  (first starts at `start`, last ends at `end`). Shared by the Arrange
 *  panel's distribute() and the guard's run redistribution. */
export function equalGapPositions(sizes: number[], start: number, end: number): { positions: number[]; gap: number } {
  const total = sizes.reduce((s, v) => s + v, 0)
  const gap = sizes.length > 1 ? (end - start - total) / (sizes.length - 1) : 0
  const positions: number[] = []
  let cursor = start
  for (const size of sizes) {
    positions.push(cursor)
    cursor += size + gap
  }
  return { positions, gap }
}

/** Re-derive container children's absolute boxes from their parent +
 *  `parentOffset` (a dangling parentId is dropped). Returns ids it moved.
 *  editor.syncContainers runs this on the open slide; the guard runs it on
 *  whatever slide it is checking, so a container an agent moves on a slide
 *  nobody has open still carries its children. `skip` = children whose own
 *  frame the caller just set and must not be overwritten. */
export function deriveContainerChildren(slide: Slide, skip?: ReadonlySet<string>): string[] {
  const byId = new Map(slide.elements.map((e) => [e.id, e]))
  const moved: string[] = []
  for (const el of slide.elements) {
    if (!el.parentId) continue
    const parent = byId.get(el.parentId)
    if (!parent) { delete el.parentId; delete el.parentOffset; moved.push(el.id); continue }
    const off = el.parentOffset
    if (!off || skip?.has(el.id)) continue
    const nx = parent.x + off.relX * parent.w
    const ny = parent.y + off.relY * parent.h
    const nw = off.relW * parent.w
    const nh = off.relH * parent.h
    if (Math.abs(nx - el.x) > 0.5 || Math.abs(ny - el.y) > 0.5 || Math.abs(nw - el.w) > 0.5 || Math.abs(nh - el.h) > 0.5) {
      el.x = nx; el.y = ny; el.w = nw; el.h = nh
      moved.push(el.id)
    }
  }
  return moved
}

/** Re-anchor a container child to its parent's CURRENT box, keeping the
 *  child's absolute frame — what a direct move/resize of a child means. */
export function reanchorChild(el: SlideElement, parent: Frame): void {
  if (!parent.w || !parent.h) return
  el.parentOffset = {
    relX: (el.x - parent.x) / parent.w,
    relY: (el.y - parent.y) / parent.h,
    relW: el.w / parent.w,
    relH: el.h / parent.h,
  }
}

/** reflow:false still keeps container bookkeeping right: a child the edit
 *  moved/resized is re-anchored to its (unchanged) parent, or the open
 *  slide's syncContainers would snap it straight back. */
export function reanchorEditedChildren(slide: Slide, before: Baseline): void {
  const byId = new Map(slide.elements.map((e) => [e.id, e]))
  for (const el of slide.elements) {
    if (!el.parentId) continue
    const b = before.get(el.id)
    const parent = byId.get(el.parentId)
    const pb = parent && before.get(parent.id)
    if (!parent || !pb || !sameFrame(pb, parent)) continue
    if (!b || !sameFrame(b, el)) reanchorChild(el, parent)
  }
}

/** The changed set when the caller gives none: frame/html/fontSize diff + new ids. */
function diffChanged(before: Baseline, slide: Slide): Set<string> {
  const out = new Set<string>()
  for (const e of slide.elements) {
    const b = before.get(e.id)
    if (!b) { out.add(e.id); continue }
    if (!sameFrame(b, e, 0.01) || (b.rotation ?? 0) !== (e.rotation ?? 0)) { out.add(e.id); continue }
    if (e.type === 'text' && (b.html !== e.html || b.fontSize !== e.fontSize)) out.add(e.id)
  }
  return out
}

/** Elements that carry content a reader must see — the ones an overlap hurts. */
const carriesContent = (el: SlideElement) =>
  el.type === 'text' || el.type === 'table' || el.type === 'image' || el.type === 'code' || el.type === 'chart' ||
  el.type === 'math' || el.type === 'zoom'

/** Page chrome the guard leaves alone: footer pieces, and small boxes that
 *  sit in the top/bottom margin band (page numerals, running heads). */
function isChrome(el: SlideElement, doc: SlidomingoDoc, canvas: { width: number; height: number }): boolean {
  if (el.type === 'text' && el.footerRole) return true
  if (!isFurniture(el, doc)) return false
  const band = marginFor(doc) * 0.75
  return el.y + el.h <= band || el.y >= canvas.height - band
}

/** The box text actually paints: an overflowing text box spills its ink past
 *  `h` in the direction its valign leaves free. */
function inkBox(el: SlideElement, measured: Map<string, number>): Frame {
  const f = frameOf(el)
  const m = measured.get(el.id)
  if (el.type !== 'text' || m == null || m <= f.h + 1) return f
  const extra = m - f.h
  if (el.valign === 'bottom') return { ...f, y: f.y - extra, h: m }
  if (el.valign === 'middle') return { ...f, y: f.y - extra / 2, h: m }
  return { ...f, h: m }
}

/** Smallest move of `a` that clears `b` by `gap`, kept on the canvas —
 *  preferring a spot that also clears every box in `others` (so a fix for one
 *  overlap does not suggest the next one). */
function suggestClear(a: Frame, b: Frame, canvas: { width: number; height: number }, gap: number, others: Frame[] = []): Frame | undefined {
  // clear b, then (one step further) whatever that spot would land on
  const tries: Frame[] = []
  const around = (o: Frame) => [
    { ...a, y: o.y + o.h + gap },
    { ...a, y: o.y - gap - a.h },
    { ...a, x: o.x + o.w + gap },
    { ...a, x: o.x - gap - a.w },
  ]
  for (const f of around(b)) {
    tries.push(f)
    for (const o of others) if (intersection(f, o)) tries.push(...around(o).filter((g) => !intersection(g, b)))
  }
  const onCanvas = tries.filter((f) => f.x >= 0 && f.y >= 0 && f.x + f.w <= canvas.width && f.y + f.h <= canvas.height)
  if (!onCanvas.length) return undefined
  const cost = (f: Frame) => Math.abs(f.x - a.x) + Math.abs(f.y - a.y)
  const free = onCanvas.filter((f) => !others.some((o) => intersection(f, o)))
  const best = (free.length ? free : onCanvas).sort((p, q) => cost(p) - cost(q))[0]
  return { x: Math.round(best.x), y: Math.round(best.y), w: Math.round(best.w), h: Math.round(best.h) }
}

/** Evenly spaced run (≥3, gaps within ±GAP_EQ) along `axis` that contains `id`,
 *  among `pool` (frames by id). Members sorted by position, or null. */
function findRun(id: string, pool: Map<string, Frame>, axis: 'x' | 'y'): { ids: string[]; gap: number } | null {
  const self = pool.get(id)
  if (!self) return null
  const size = axis === 'x' ? 'w' : 'h'
  const mates = [...pool.entries()]
    .filter(([oid, f]) => oid === id || crossShare(self, f, axis) >= SHARE)
    .sort((a, b) => a[1][axis] - b[1][axis])
  const idx = mates.findIndex(([oid]) => oid === id)
  const gapAt = (i: number) => mates[i + 1][1][axis] - (mates[i][1][axis] + mates[i][1][size])
  let best: { ids: string[]; gap: number } | null = null
  for (const ref of [idx - 1, idx]) {
    if (ref < 0 || ref >= mates.length - 1) continue
    const g = gapAt(ref)
    if (g < -TOL) continue
    let lo = idx
    while (lo > 0 && Math.abs(gapAt(lo - 1) - g) <= GAP_EQ) lo--
    let hi = idx
    while (hi < mates.length - 1 && Math.abs(gapAt(hi) - g) <= GAP_EQ) hi++
    if (hi - lo + 1 >= 3 && (!best || hi - lo + 1 > best.ids.length)) {
      best = { ids: mates.slice(lo, hi + 1).map(([oid]) => oid), gap: g }
    }
  }
  return best
}

/**
 * Run the layout guard on `slide`. With `apply`, mutates the slide in place
 * (wrap in one store.commit); without, only reports what it would leave.
 */
export function guardLayout(doc: SlidomingoDoc, slide: Slide, before: Baseline, opts: GuardOpts): GuardResult {
  const canvas = opts.canvas ?? doc.size
  const adjusted: Adjustment[] = []
  const issues: LayoutFinding[] = []
  const changed = opts.changed ?? diffChanged(before, slide)
  const apply = opts.apply
  // In report-only mode work on a scratch copy, so every pass can still run
  // (what grows decides what overlaps) without touching the caller's slide.
  const work: Slide = apply ? slide : JSON.parse(JSON.stringify(slide))
  const els = work.elements
  const byId = new Map(els.map((e) => [e.id, e]))
  const gapUnit = Math.round(16 * (doc.size.width / 1280))

  // Frames as the EDIT left them, before the guard does anything — the
  // reference for "what did the guard move" and for intersection-before.
  const agentFrame = new Map(els.map((e) => [e.id, frameOf(e)]))
  /** where an element was before the edit (changed, or carried along with a
   *  container the edit moved → baseline; else as the edit left it) */
  const priorFrame = (id: string): Frame | undefined => {
    if (changed.has(id) || followers.has(id)) {
      const b = before.get(id)
      return b ? frameOf(b) : undefined
    }
    return agentFrame.get(id)
  }

  // --- 0. containers: a moved child keeps its new spot, a moved parent
  //        carries its children (any slide — not only the open one) ----------
  const followers = new Set<string>()
  for (const el of els) {
    if (!el.parentId || !changed.has(el.id)) continue
    const parent = byId.get(el.parentId)
    if (parent) reanchorChild(el, parent)
  }
  for (const id of deriveContainerChildren(work, changed)) {
    followers.add(id)
    agentFrame.set(id, frameOf(byId.get(id)!))
  }

  // --- measurement (cached; text only, non-empty) ---------------------------
  const measured = new Map<string, number>()
  const measureEl = (el: SlideElement) => {
    if (!opts.measure || el.type !== 'text' || !el.html?.trim()) return undefined
    if (!measured.has(el.id)) measured.set(el.id, opts.measure(el))
    return measured.get(el.id)
  }

  /** May the guard move/resize this element at all? */
  const movable = (el: SlideElement) =>
    !isLineLike(el) && !isRotated(el) && !isFullBleed(el, doc) && !isChrome(el, doc, canvas)

  // --- 1. grow text to fit ---------------------------------------------------
  // Grown amounts per edge (negative start = grew toward the start).
  const grownStart = new Map<string, number>()
  const grownEnd = new Map<string, number>()
  for (const el of els) {
    if (el.type !== 'text' || !changed.has(el.id) || isRotated(el)) continue
    const m = measureEl(el)
    if (m == null || m <= el.h + 1) continue
    const b = before.get(el.id)
    let fittedBefore = true
    if (b && !opts.growAll && b.html != null && opts.measure) {
      const prev = opts.measure({ ...el, html: b.html, fontSize: b.fontSize ?? el.fontSize, w: b.w, h: b.h } as TextElement)
      fittedBefore = prev <= b.h + 1
    }
    if (!fittedBefore) {
      issues.push({
        code: 'text-overflow', severity: 'warning', slide: slide.id, element: el.id, path: 'h',
        message: `"${el.id}" already overflowed before this edit (needs ${Math.ceil(m)}px, box is ${Math.round(el.h)}px) — left as is; grow the box or shorten the text.`,
        suggest: { ...frameOf(el), h: Math.ceil(m) },
      })
      continue
    }
    const newH = Math.ceil(m)
    const d = newH - el.h
    if (el.valign === 'bottom') { el.y -= d; grownStart.set(el.id, -d) }
    else if (el.valign === 'middle') { el.y -= d / 2; grownStart.set(el.id, -d / 2); grownEnd.set(el.id, d / 2) }
    else grownEnd.set(el.id, d)
    el.h = newH
    measured.set(el.id, newH)
    adjusted.push({ element: el.id, kind: 'grow', frame: frameOf(el),
      message: `grew text "${el.id}" to ${newH}px tall so its text fits (${el.valign === 'bottom' ? 'bottom' : el.valign === 'middle' ? 'centre' : 'top'} edge kept)` })
  }

  // --- 2. reflow neighbours ----------------------------------------------------
  // `pre` = the layout as the edit left it with each RESIZE undone: the guard
  // propagates edge deltas through that layout. An edit that moved both edges
  // of an axis the same way (a move, possibly plus a resize) is deliberate
  // placement — that element is pinned and pushes nothing; new elements too.
  type Node = { id: string; pre: Frame; d: { x: [number, number]; y: [number, number] }; pinned: boolean }
  const nodes = new Map<string, Node>()
  for (const el of els) {
    if (!movable(el)) continue
    const a = agentFrame.get(el.id)!
    const b = before.get(el.id)
    let pinned = followers.has(el.id) || (!!opts.placed && changed.has(el.id))
    let pre = { ...a }
    const d = { x: [0, 0] as [number, number], y: [0, 0] as [number, number] }
    if (changed.has(el.id) && !pinned) {
      if (!b) pinned = true
      else {
        const edges = (p: 'x' | 'y', z: 'w' | 'h'): [number, number] => [a[p] - b[p], (a[p] + a[z]) - (b[p] + b[z])]
        const ex = edges('x', 'w')
        const ey = edges('y', 'h')
        const moved = (e: [number, number]) => Math.abs(e[0]) > 0.5 && Math.abs(e[1]) > 0.5 && Math.sign(e[0]) === Math.sign(e[1])
        if (moved(ex) || moved(ey)) pinned = true
        else {
          pre = frameOf(b)
          d.x = ex
          d.y = ey
        }
      }
    }
    // guard growth is on top of the agent frame
    d.y[0] += grownStart.get(el.id) ?? 0
    d.y[1] += grownEnd.get(el.id) ?? 0
    nodes.set(el.id, { id: el.id, pre, d, pinned })
  }
  const isSource = (n: Node) => !!(Math.abs(n.d.x[0]) > 0.5 || Math.abs(n.d.x[1]) > 0.5 || Math.abs(n.d.y[0]) > 0.5 || Math.abs(n.d.y[1]) > 0.5)
  /** Shifts fixed by run redistribution (bypass the propagation). */
  const fixed = { x: new Map<string, number>(), y: new Map<string, number>() }
  /** Sources whose delta a redistributed run already absorbed on an axis. */
  const absorbed = { x: new Set<string>(), y: new Set<string>() }

  /** Propagate edge deltas along `axis` in direction `dir` (+1 = toward the
   *  end: down/right; -1 = toward the start: up/left). An element's
   *  supporters are the elements sharing its column that end before it
   *  starts with nothing sharing the column in between, plus a card that
   *  contains it. It moves by max(supporters' new ends) − max(their old
   *  ends): it keeps its gap to whatever ends LAST before it. That is what
   *  makes it right both ways — stacked growers add up, side-by-side ones
   *  don't, and a shrink closes a gap only as far as the next-longest
   *  neighbour column allows.
   *  Returns shifts and card growth, both in direction units (positive =
   *  away from the change). */
  function propagate(axis: 'x' | 'y', dir: 1 | -1): { shift: Map<string, number>; grow: Map<string, number> } {
    const out = new Map<string, number>()
    const grow = new Map<string, number>()
    const size = axis === 'x' ? 'w' : 'h'
    const list = [...nodes.values()]
    // direction coordinates: s = start, e = end, both increasing along dir
    const s = (n: Node) => dir > 0 ? n.pre[axis] : -(n.pre[axis] + n.pre[size])
    const e = (n: Node) => dir > 0 ? n.pre[axis] + n.pre[size] : -n.pre[axis]
    const ownEnd = (n: Node) => absorbed[axis].has(n.id) ? 0 : (dir > 0 ? n.d[axis][1] : -n.d[axis][0])
    const ownStart = (n: Node) => absorbed[axis].has(n.id) ? 0 : (dir > 0 ? n.d[axis][0] : -n.d[axis][1])
    list.sort((p, q) => s(p) - s(q))
    const shared = (p: Node, q: Node) => crossShare(p.pre, q.pre, axis) >= SHARE
    const shiftOf = (n: Node) => {
      const f = fixed[axis].get(n.id)
      if (f != null) return Math.max(0, dir * f)
      return out.get(n.id) ?? 0
    }
    // cards: shapes containing other nodes grow with their content
    const contents = new Map<string, Node[]>()
    for (const c of list) {
      const el = byId.get(c.id)!
      if (el.type !== 'shape' || c.pinned || changed.has(c.id)) continue
      const inside = list.filter((n) => n !== c && contains(c.pre, n.pre) && !contains(n.pre, c.pre))
      if (inside.length) contents.set(c.id, inside)
    }
    const growOf = (c: Node): number => {
      if (grow.has(c.id)) return grow.get(c.id)!
      const inside = contents.get(c.id)!
      // keep the card's inner padding (the tighter of its start/end pads):
      // content growing into empty card space needs no bigger card
      const pad = Math.min(e(c) - Math.max(...inside.map(e)), Math.min(...inside.map(s)) - s(c))
      const need = Math.max(...inside.map((n) => e(n) + shiftOf(n) + ownEnd(n))) + pad
      const g = Math.max(0, need - (e(c) + shiftOf(c)))
      grow.set(c.id, g)
      return g
    }
    for (const n of list) {
      if (n.pinned || fixed[axis].has(n.id)) continue
      // n keeps its gap to whatever ends LAST before it: new start =
      // max(supporters' new ends) + the old gap to max(supporters' old ends)
      let oldMax = -Infinity
      let newMax = -Infinity
      for (const x of list) {
        if (x === n) continue
        let o: number | null = null
        let v = 0
        if (contents.get(x.id)?.includes(n)) {
          o = s(x) // a card carries what it contains (by its start edge)
          v = s(x) + shiftOf(x) + ownStart(x)
        } else if (e(x) <= s(n) + TOL && shared(x, n)) {
          const screened = list.some((z) => z !== x && z !== n &&
            s(z) >= e(x) - TOL && e(z) <= s(n) + TOL && shared(z, n) && shared(z, x))
          if (screened) continue
          o = e(x)
          v = e(x) + shiftOf(x) + ownEnd(x) + (contents.has(x.id) ? growOf(x) : 0)
        }
        if (o == null) continue
        oldMax = Math.max(oldMax, o)
        newMax = Math.max(newMax, v)
      }
      const d = newMax - oldMax
      if (Number.isFinite(d) && Math.abs(d) > 0.5) out.set(n.id, d)
    }
    for (const c of contents.keys()) growOf(nodes.get(c)!)
    return { shift: out, grow }
  }

  const sources = [...nodes.values()].filter(isSource)
  if (apply && sources.length) {
    // A resized member of an evenly spaced row is redistributed within the
    // row's original span (a row of cards keeps its margins). Columns keep
    // their gaps by pushing instead — a stack usually has room below — and
    // only fall back to redistribution when the push runs out of canvas.
    const prePool = () => new Map([...nodes.values()].map((n) => [n.id, n.pre]))
    const tryRun = (src: Node, axis: 'x' | 'y'): boolean => {
      const size = axis === 'x' ? 'w' : 'h'
      if (Math.abs(src.d[axis][0]) <= 0.5 && Math.abs(src.d[axis][1]) <= 0.5) return false
      const run = findRun(src.id, prePool(), axis)
      if (!run) return false
      const members = run.ids.map((id) => nodes.get(id)!)
      if (members.some((m) => m !== src && (m.pinned || isSource(m)))) return false
      const span0 = members[0].pre[axis]
      const last = members[members.length - 1]
      const span1 = last.pre[axis] + last.pre[size]
      const sizes = members.map((m) => m.pre[size] + (m === src ? src.d[axis][1] - src.d[axis][0] : 0))
      const { positions, gap } = equalGapPositions(sizes, span0, span1)
      if (gap < Math.min(run.gap, 8) - 0.5) return false
      members.forEach((m, i) => {
        // relative to where the element is now (a source: its agent frame)
        const now = m === src ? m.pre[axis] + src.d[axis][0] : m.pre[axis]
        fixed[axis].set(m.id, positions[i] - now)
      })
      absorbed[axis].add(src.id)
      return true
    }
    for (const src of sources) tryRun(src, 'x')

    type Plan = { dx: number; dy: number; gx: [number, number]; gy: [number, number] }
    const plan = new Map<string, Plan>()
    const planFor = (id: string) => {
      let p = plan.get(id)
      if (!p) { p = { dx: 0, dy: 0, gx: [0, 0], gy: [0, 0] }; plan.set(id, p) }
      return p
    }
    const solve = (axis: 'x' | 'y') => {
      for (const p of plan.values()) {
        if (axis === 'x') { p.dx = 0; p.gx = [0, 0] } else { p.dy = 0; p.gy = [0, 0] }
      }
      const fwd = propagate(axis, 1)
      const back = propagate(axis, -1)
      const set = (id: string, v: number) => { const p = planFor(id); if (axis === 'x') p.dx += v; else p.dy += v }
      for (const [id, v] of fwd.shift) set(id, v)
      for (const [id, v] of back.shift) set(id, -v)
      for (const [id, v] of fixed[axis]) {
        if (nodes.get(id)?.pinned) continue
        const p = planFor(id)
        if (axis === 'x') p.dx = v; else p.dy = v
      }
      for (const [id, g] of fwd.grow) if (g > 0.5) { const p = planFor(id); (axis === 'x' ? p.gx : p.gy)[1] = g }
      for (const [id, g] of back.grow) if (g > 0.5) { const p = planFor(id); (axis === 'x' ? p.gx : p.gy)[0] = g }
    }
    solve('x')
    solve('y')

    const target = (id: string): Frame => {
      const el = byId.get(id)!
      const p = plan.get(id)!
      return { x: el.x + p.dx - p.gx[0], y: el.y + p.dy - p.gy[0], w: el.w + p.gx[0] + p.gx[1], h: el.h + p.gy[0] + p.gy[1] }
    }
    const outside = (f: Frame) => f.x < -0.5 || f.y < -0.5 || f.x + f.w > canvas.width + 0.5 || f.y + f.h > canvas.height + 0.5
    const blocked = () => [...plan.keys()].filter((id) => !outside(agentFrame.get(id)!) && outside(target(id)))
    if (blocked().length) {
      let retried = false
      for (const src of sources) if (!absorbed.y.has(src.id) && tryRun(src, 'y')) retried = true
      if (retried) solve('y')
    }
    const noRoom = blocked()
    for (const id of noRoom) plan.delete(id)
    if (noRoom.length) {
      issues.push({
        code: 'layout-no-room', severity: 'warning', slide: slide.id, element: noRoom[0], elements: noRoom,
        message: `No room to keep the spacing: moving ${noRoom.map((i) => `"${i}"`).join(', ')} would push past the ${canvas.width}x${canvas.height} canvas, so ${noRoom.length > 1 ? 'they were' : 'it was'} left in place — shrink or shorten something on this slide, or move content to another slide.`,
      })
    }

    // a group moves as one when nothing in it is the edit itself
    const groups = new Map<string, string[]>()
    for (const el of els) if (el.groupId) groups.set(el.groupId, [...(groups.get(el.groupId) ?? []), el.id])
    for (const ids of groups.values()) {
      if (ids.some((id) => changed.has(id) || !nodes.has(id) || noRoom.includes(id))) continue
      for (const k of ['dx', 'dy'] as const) {
        const pick = ids.map((id) => plan.get(id)?.[k] ?? 0).reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0)
        if (pick) for (const id of ids) planFor(id)[k] = pick
      }
    }

    const dirWord = (axis: 'x' | 'y', v: number) => axis === 'y' ? (v > 0 ? 'down' : 'up') : (v > 0 ? 'right' : 'left')
    for (const [id, p] of plan) {
      const el = byId.get(id)!
      const f = target(id)
      if (sameFrame(f, el)) continue
      el.x = f.x; el.y = f.y; el.w = f.w; el.h = f.h
      for (const axis of ['x', 'y'] as const) {
        const v = axis === 'x' ? p.dx : p.dy
        if (Math.abs(v) < 0.5) continue
        const how = fixed[axis].has(id) ? 'redistribute' : 'shift'
        adjusted.push({ element: id, kind: how, frame: frameOf(el),
          message: how === 'redistribute'
            ? `moved "${id}" ${dirWord(axis, v)} ${Math.round(Math.abs(v))}px to keep its ${axis === 'x' ? 'row' : 'column'} evenly spaced`
            : `moved "${id}" ${dirWord(axis, v)} ${Math.round(Math.abs(v))}px to keep its gap` })
      }
      const gw = p.gx[0] + p.gx[1]
      const gh = p.gy[0] + p.gy[1]
      if (gw > 0.5 || gh > 0.5) {
        adjusted.push({ element: id, kind: 'grow-card', frame: frameOf(el),
          message: `grew "${id}" ${[gh > 0.5 ? `${Math.round(gh)}px taller` : '', gw > 0.5 ? `${Math.round(gw)}px wider` : ''].filter(Boolean).join(' and ')} so it still holds its content` })
      }
    }
  }

  // container bookkeeping after the guard moved things: a translated parent
  // carries its children; every child of a touched container re-anchors.
  {
    const touched = new Set<string>()
    for (const el of els) {
      const a = agentFrame.get(el.id)!
      if (!sameFrame(a, el)) touched.add(el.id)
    }
    for (const el of els) {
      if (!el.parentId) continue
      const parent = byId.get(el.parentId)
      if (!parent) continue
      if (touched.has(parent.id) && !touched.has(el.id)) {
        const pa = agentFrame.get(parent.id)!
        if (Math.abs(pa.w - parent.w) < 0.5 && Math.abs(pa.h - parent.h) < 0.5) {
          el.x += parent.x - pa.x
          el.y += parent.y - pa.y
          touched.add(el.id)
          adjusted.push({ element: el.id, kind: 'follow-parent', frame: frameOf(el), message: `moved "${el.id}" with its container "${parent.id}"` })
        }
      }
      if (touched.has(parent.id) || touched.has(el.id)) reanchorChild(el, parent)
    }
  }

  // --- 3. arrows follow --------------------------------------------------------
  // Boxes that ended up somewhere else than before the edit: old frame →
  // final frame. A free line end that touched the old border follows.
  const movedBoxes: Array<{ id: string; old: Frame; now: Frame }> = []
  for (const el of els) {
    if (isLineLike(el)) continue
    const old = priorFrame(el.id)
    if (!old) continue
    const now = frameOf(el)
    if (!sameFrame(old, now)) movedBoxes.push({ id: el.id, old: frameOf(old), now })
  }
  /** distance from p to the border of box f (inside or out) */
  const borderDist = (p: { x: number; y: number }, f: Frame) => {
    const inside = p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h
    if (inside) return Math.min(p.x - f.x, f.x + f.w - p.x, p.y - f.y, f.y + f.h - p.y)
    const dx = Math.max(f.x - p.x, 0, p.x - (f.x + f.w))
    const dy = Math.max(f.y - p.y, 0, p.y - (f.y + f.h))
    return Math.hypot(dx, dy)
  }
  const nearestSide = (p: { x: number; y: number }, f: Frame) => {
    const sides = (['top', 'right', 'bottom', 'left'] as const).map((side) => {
      const m = sideMidpoint(f, side)
      const onEdge = side === 'top' ? Math.abs(p.y - f.y) : side === 'bottom' ? Math.abs(p.y - (f.y + f.h))
        : side === 'left' ? Math.abs(p.x - f.x) : Math.abs(p.x - (f.x + f.w))
      const along = side === 'top' || side === 'bottom' ? Math.abs(p.x - m.x) : Math.abs(p.y - m.y)
      const len = side === 'top' || side === 'bottom' ? f.w : f.h
      return { side, onEdge, along, len }
    }).sort((a, b) => a.onEdge - b.onEdge)
    return sides[0]
  }
  if (apply) {
    for (const el of els) {
      if (!isLineLike(el) || changed.has(el.id)) continue
      const line = el as ShapeElement
      const isLine = line.shape === 'line'
      if (!isLine && !pathIsStraight(line.d)) continue // a curve can't be re-projected losslessly
      const pts = isLine ? lineEndpoints(line) : pathAnchors(line)
      if (pts.length < 2) continue
      const ends: Array<{ idx: number; key: 'from' | 'to' }> = [{ idx: 0, key: 'from' }, { idx: pts.length - 1, key: 'to' }]
      const binds: Array<{ key: 'from' | 'to'; box: string; side: 'auto' | 'top' | 'right' | 'bottom' | 'left' }> = []
      let moved = false
      for (const { idx, key } of ends) {
        if (isLine && line[key]) continue // bound: rerouteConnectors' job
        const p = pts[idx]
        let hit: { id: string; old: Frame; now: Frame } | null = null
        let bestD = TOUCH
        for (const mb of movedBoxes) {
          if (mb.id === line.id) continue
          const dd = borderDist(p, mb.old)
          if (dd <= bestD) { bestD = dd; hit = mb }
        }
        if (!hit) continue
        const rx = hit.old.w ? (p.x - hit.old.x) / hit.old.w : 0
        const ry = hit.old.h ? (p.y - hit.old.y) / hit.old.h : 0
        pts[idx] = { x: hit.now.x + rx * hit.now.w, y: hit.now.y + ry * hit.now.h }
        moved = true
        if (isLine) {
          const ns = nearestSide(p, hit.old)
          const other = pts[idx === 0 ? pts.length - 1 : 0]
          const auto = borderPoint(hit.now, other)
          if (ns.along <= Math.max(8, ns.len * 0.15)) binds.push({ key, box: hit.id, side: ns.side })
          else if (Math.hypot(auto.x - pts[idx].x, auto.y - pts[idx].y) <= TOUCH) binds.push({ key, box: hit.id, side: 'auto' })
        }
        adjusted.push({ element: line.id, kind: 'follow', frame: frameOf(line), message: `arrow "${line.id}" now follows "${hit.id}"` })
      }
      if (!moved) continue
      if (isLine) setLineEndpoints(line, pts[0], pts[1])
      else setPathAnchors(line, pts, { closed: pathIsClosed(line.d), straight: true })
      // once one end follows a box, an untouched far end sitting on another
      // box's side midpoint is attached too, so the arrow follows both ways
      if (isLine && binds.length === 1) {
        const farKey = binds[0].key === 'from' ? 'to' : 'from'
        const far = pts[farKey === 'from' ? 0 : 1]
        if (!line[farKey]) {
          for (const box of els) {
            if (box === line || isLineLike(box) || box.id === binds[0].box || isRotated(box)) continue
            if (borderDist(far, box) > TOUCH) continue
            const ns = nearestSide(far, box)
            if (ns.along <= Math.max(8, ns.len * 0.15)) { binds.push({ key: farKey, box: box.id, side: ns.side }); break }
          }
        }
      }
      for (const b of binds) {
        line[b.key] = { el: b.box, side: b.side }
        adjusted.push({ element: line.id, kind: 'bind', frame: frameOf(line),
          message: `arrow "${line.id}" is now attached to "${b.box}" (${b.side}) and will follow it from now on` })
      }
      // the follow entry's frame was taken before the write — refresh it
      for (const a of adjusted) if (a.element === line.id && a.kind === 'follow') a.frame = frameOf(line)
    }
    const lineBefore = new Map(els.filter((e) => isLineLike(e)).map((e) => [e.id, frameOf(e)]))
    for (const id of rerouteConnectors(work)) {
      const el = byId.get(id) as ShapeElement | undefined
      if (!el) continue
      const was = lineBefore.get(id)
      if (was && sameFrame(was, el)) continue
      const targets = [el.from?.el, el.to?.el].filter(Boolean).join(' → ')
      adjusted.push({ element: id, kind: 'reroute', frame: frameOf(el), message: `re-routed arrow "${id}" to stay attached${targets ? ` (${targets})` : ''}` })
    }
  }

  // --- 4. overlaps that are new ------------------------------------------------
  const finalFrame = new Map(els.map((e) => [e.id, frameOf(e)]))
  const involved = new Set<string>()
  for (const el of els) {
    if (changed.has(el.id) || followers.has(el.id)) involved.add(el.id)
    const a = agentFrame.get(el.id)
    if (a && !sameFrame(a, el)) involved.add(el.id)
  }
  issues.push(...overlapFindings(doc, work, {
    involved, measured, measureEl, canvas, gapUnit,
    priorFrame: (id) => (involved.has(id) ? priorFrame(id) : finalFrame.get(id)),
  }))
  issues.push(...tightInsetFindings(doc, work, {
    involved, canvas,
    priorFrame: (id) => (involved.has(id) ? priorFrame(id) : finalFrame.get(id)),
  }))

  // --- 5. runs that were even and are not now ----------------------------------
  {
    const priorPool = new Map<string, Frame>()
    const nowPool = new Map<string, Frame>()
    for (const el of els) {
      if (!movable(el)) continue
      const p = priorFrame(el.id)
      if (p) priorPool.set(el.id, p)
      nowPool.set(el.id, frameOf(el))
    }
    const seen = new Set<string>()
    for (const id of involved) {
      if (!priorPool.has(id)) continue
      for (const axis of ['x', 'y'] as const) {
        const run = findRun(id, priorPool, axis)
        if (!run) continue
        const key = axis + ':' + run.ids.join(',')
        if (seen.has(key)) continue
        seen.add(key)
        const size = axis === 'x' ? 'w' : 'h'
        const now = run.ids.map((i) => nowPool.get(i)!).sort((a, b) => a[axis] - b[axis])
        const gaps = now.slice(1).map((f, i) => f[axis] - (now[i][axis] + now[i][size]))
        const spread = Math.max(...gaps) - Math.min(...gaps)
        if (spread > GAP_EQ) {
          issues.push({
            code: 'layout-uneven-gap', severity: 'info', slide: slide.id, element: id, elements: run.ids,
            message: `${run.ids.map((i) => `"${i}"`).join(', ')} were evenly spaced ${axis === 'x' ? 'side by side' : 'top to bottom'} (${r1(run.gap)}px gaps) and now have gaps of ${gaps.map((g) => Math.round(g)).join('/')}px — re-space them evenly.`,
          })
        }
      }
    }
  }

  return { adjusted: apply ? adjusted : [], issues }
}

/** The overlap rule shared by guardLayout (new overlaps only) and checkLayout
 *  (any overlap). A pair is reported when the boxes (text: its ink) partially
 *  intersect, neither contains the other, neither is a line or page chrome,
 *  and at least one carries content. */
function overlapFindings(doc: SlidomingoDoc, slide: Slide, o: {
  involved: Set<string> | null
  measured: Map<string, number>
  measureEl: (el: SlideElement) => number | undefined
  canvas: { width: number; height: number }
  gapUnit: number
  /** where an element was before; null box = new (never intersected) */
  priorFrame: ((id: string) => Frame | undefined) | null
}): LayoutFinding[] {
  const out: LayoutFinding[] = []
  const candidates = slide.elements.filter((e) =>
    !isLineLike(e) && !isRotated(e) && !isChrome(e, doc, o.canvas) && !isFullBleed(e, doc))
  for (const e of candidates) o.measureEl(e)
  const done = new Set<string>()
  for (const a of candidates) {
    if (o.involved && !o.involved.has(a.id)) continue
    for (const b of candidates) {
      if (a === b) continue
      const key = [a.id, b.id].sort().join('|')
      if (done.has(key)) continue
      done.add(key)
      if (!carriesContent(a) && !carriesContent(b)) continue
      if (a.parentId === b.id || b.parentId === a.id) continue
      const fa = inkBox(a, o.measured)
      const fb = inkBox(b, o.measured)
      const hit = intersection(fa, fb)
      if (!hit) continue
      if (contains(fa, fb) || contains(fb, fa)) continue
      if (o.priorFrame) {
        const pa = o.priorFrame(a.id)
        const pb = o.priorFrame(b.id)
        if (pa && pb && intersection(pa, pb)) continue // overlapped before the edit too
      }
      // suggest moving the one the edit touched (a), else the smaller one
      const mover = o.involved ? a : (a.w * a.h <= b.w * b.h ? a : b)
      const other = mover === a ? b : a
      const others = candidates.filter((e) => e !== a && e !== b && carriesContent(e) &&
        !contains(inkBox(e, o.measured), inkBox(mover, o.measured))).map((e) => inkBox(e, o.measured))
      const suggest = suggestClear(frameOf(mover), mover === a ? fb : fa, o.canvas, o.gapUnit, others)
      out.push({
        code: 'layout-overlap', severity: 'warning', slide: slide.id, element: mover.id, elements: [mover.id, other.id],
        message: `"${mover.id}" (${mover.type}) overlaps "${other.id}" (${other.type}) by ${Math.round(hit.w)}x${Math.round(hit.h)}px` +
          (suggest ? ` — e.g. set_frame ${mover.id} x=${suggest.x} y=${suggest.y}, or resize/shorten one of them.` : ' — resize or shorten one of them; there is no free spot to move it to.'),
        ...(suggest ? { suggest } : {}),
      })
    }
  }
  return out
}

/**
 * layout-tight-inset: a box fully inside another box (the containment case
 * overlapFindings skips) whose gap to the outer edge is more than 0 but less
 * than INSET_MIN on some side — close enough to read as a mistake, not as
 * flush alignment. Stronger wording when a connector/line end lands on the
 * inner box (the arrow-into-a-nested-box case). Report only: `suggest` is the
 * inner frame inset to INSET_MIN, applied by nobody automatically.
 */
function tightInsetFindings(doc: SlidomingoDoc, slide: Slide, o: {
  involved: Set<string> | null
  canvas: { width: number; height: number }
  priorFrame: ((id: string) => Frame | undefined) | null
}): LayoutFinding[] {
  const out: LayoutFinding[] = []
  const unit = doc.size.width / 1280
  const min = INSET_MIN * unit
  const boxes = slide.elements.filter((e) =>
    !isLineLike(e) && !isRotated(e) && e.type !== 'text' && !isChrome(e, doc, o.canvas) && !isFullBleed(e, doc))
  const lines = slide.elements.filter((e): e is ShapeElement => isLineLike(e) && e.type === 'shape')
  const insets = (outer: Frame, inner: Frame) => [
    inner.x - outer.x, inner.y - outer.y,
    outer.x + outer.w - (inner.x + inner.w), outer.y + outer.h - (inner.y + inner.h),
  ]
  const tight = (outer: Frame, inner: Frame) => {
    if (!contains(outer, inner, 0)) return false
    const m = insets(outer, inner).filter((v) => v > 0.5)
    return m.length > 0 && Math.min(...m) < min - 0.5
  }
  const distTo = (pt: { x: number; y: number }, f: Frame) => {
    const dx = Math.max(f.x - pt.x, 0, pt.x - (f.x + f.w))
    const dy = Math.max(f.y - pt.y, 0, pt.y - (f.y + f.h))
    return Math.hypot(dx, dy)
  }
  const arrowTouching = (inner: SlideElement): ShapeElement | undefined => lines.find((ln) => {
    if (ln.from?.el === inner.id || ln.to?.el === inner.id) return true
    const pts = ln.shape === 'line' ? lineEndpoints(ln) : pathAnchors(ln)
    if (pts.length < 2) return false
    return [pts[0], pts[pts.length - 1]].some((pt) => distTo(pt, frameOf(inner)) <= TOUCH * unit)
  })
  for (const inner of boxes) {
    for (const outer of boxes) {
      if (inner === outer) continue
      if (inner.parentId === outer.id || outer.parentId === inner.id) continue
      if (o.involved && !o.involved.has(inner.id) && !o.involved.has(outer.id)) continue
      const fi = frameOf(inner)
      const fo = frameOf(outer)
      if (!tight(fo, fi)) continue
      if (o.priorFrame) {
        const pi = o.priorFrame(inner.id)
        const po = o.priorFrame(outer.id)
        if (pi && po && tight(po, pi)) continue // was already that tight before the edit
      }
      const arrow = arrowTouching(inner)
      const sides = ['left', 'top', 'right', 'bottom'] as const
      const worst = insets(fo, fi).map((v, i) => ({ v, side: sides[i] })).filter((x) => x.v > 0.5).sort((a, b) => a.v - b.v)[0]
      const suggest: Frame = {
        x: Math.max(fi.x, fo.x + min), y: Math.max(fi.y, fo.y + min),
        w: 0, h: 0,
      }
      suggest.w = Math.max(1, Math.min(fi.x + fi.w, fo.x + fo.w - min) - suggest.x)
      suggest.h = Math.max(1, Math.min(fi.y + fi.h, fo.y + fo.h - min) - suggest.y)
      out.push({
        code: 'layout-tight-inset', severity: arrow ? 'warning' : 'info', slide: slide.id, element: inner.id,
        elements: [inner.id, outer.id, ...(arrow ? [arrow.id] : [])],
        message: `"${inner.id}" sits only ${Math.round(worst.v)}px inside "${outer.id}" (${worst.side} edge) — ` +
          (arrow
            ? `and arrow "${arrow.id}" ends on it, so the nested box crowds the outer one right where the arrow lands. `
            : 'it reads as crowded rather than aligned. ') +
          `Give it at least ${Math.round(min)}px of inset, e.g. set_frame ${inner.id} x=${Math.round(suggest.x)} y=${Math.round(suggest.y)} w=${Math.round(suggest.w)} h=${Math.round(suggest.h)} (or enlarge "${outer.id}").`,
        suggest,
      })
    }
  }
  return out
}

/**
 * check_layout: what is wrong with the slide AS IT IS — no baseline, so the
 * overlap rule is just "partial intersection, not containment". Also reports
 * overflowing text and text pushed off the canvas, so "clean" means clean.
 * `elementIds` limits the overlap check to pairs involving those elements.
 */
export function checkLayout(doc: SlidomingoDoc, slide: Slide, opts: {
  elementIds?: string[]
  measure?: (el: TextElement) => number
  canvas?: { width: number; height: number }
} = {}): LayoutFinding[] {
  const canvas = opts.canvas ?? doc.size
  const measured = new Map<string, number>()
  const measureEl = (el: SlideElement) => {
    if (!opts.measure || el.type !== 'text' || !el.html?.trim()) return undefined
    if (!measured.has(el.id)) measured.set(el.id, opts.measure(el))
    return measured.get(el.id)
  }
  const out: LayoutFinding[] = []
  const scope = opts.elementIds?.length ? new Set(opts.elementIds) : null
  for (const el of slide.elements) {
    if (scope && !scope.has(el.id)) continue
    const m = measureEl(el)
    if (m != null && m > el.h + 1) {
      out.push({
        code: 'text-overflow', severity: 'warning', slide: slide.id, element: el.id, path: 'h',
        message: `"${el.id}" needs ${Math.ceil(m)}px but its box is ${Math.round(el.h)}px tall — grow the box or shorten the text.`,
        suggest: { ...frameOf(el), h: Math.ceil(m) },
      })
    }
    if ((el.type === 'text' || el.type === 'table') && !isChrome(el, doc, canvas) &&
        (el.x < -0.5 || el.y < -0.5 || el.x + el.w > canvas.width + 0.5 || el.y + el.h > canvas.height + 0.5)) {
      out.push({
        code: 'layout-off-canvas', severity: 'warning', slide: slide.id, element: el.id,
        message: `"${el.id}" reaches outside the ${canvas.width}x${canvas.height} canvas — its text is cut off when presenting.`,
      })
    }
  }
  out.push(...overlapFindings(doc, slide, {
    involved: scope, measured, measureEl, canvas, gapUnit: Math.round(16 * (doc.size.width / 1280)), priorFrame: null,
  }))
  out.push(...tightInsetFindings(doc, slide, { involved: scope, canvas, priorFrame: null }))
  return out
}

/**
 * Tidy without history to compare against (static mode): treat `ids` as just
 * edited. Text grows to fit, neighbours a selected box now overlaps are pushed
 * off it along the dominant axis (and everything stacked behind them with
 * them), arrows touching the selection get attached. Built as a synthetic
 * baseline for guardLayout — a selected box "used to" end where its
 * overlapped neighbours begin — so it is the same engine, not a second one.
 */
export function staticBaseline(doc: SlidomingoDoc, slide: Slide, ids: Set<string>, measure?: (el: TextElement) => number): Baseline {
  const before = snapshotSlide(slide)
  const gap = Math.round(16 * (doc.size.width / 1280))
  const measured = new Map<string, number>()
  for (const id of ids) {
    const el = slide.elements.find((e) => e.id === id)
    if (!el || isLineLike(el) || isRotated(el)) continue
    if (el.type === 'text' && measure && el.html?.trim()) measured.set(el.id, Math.max(el.h, measure(el)))
    // the box it will have once grown, so pushes account for the growth
    const grownH = measured.get(el.id) ?? el.h
    const grownY = el.type === 'text' && el.valign === 'bottom' ? el.y - (grownH - el.h)
      : el.type === 'text' && el.valign === 'middle' ? el.y - (grownH - el.h) / 2 : el.y
    const box = { x: el.x, y: grownY, w: el.w, h: grownH }
    const b = { ...before.get(id)! }
    for (const o of slide.elements) {
      if (o === el || ids.has(o.id) || isLineLike(o) || isRotated(o) || isFullBleed(o, doc) || isChrome(o, doc, doc.size)) continue
      if (!carriesContent(o) && !carriesContent(el)) continue
      const hit = intersection(box, o)
      if (!hit || contains(box, o) || contains(o, box)) continue
      // dominant axis: where the neighbour sits relative to the box
      const cb = boxCenter(box)
      const co = boxCenter(o)
      const vertical = Math.abs(co.y - cb.y) / (box.h + o.h) >= Math.abs(co.x - cb.x) / (box.w + o.w)
      if (vertical && co.y >= cb.y) b.h = Math.min(b.h, Math.max(1, o.y - gap - b.y))
      else if (!vertical && co.x >= cb.x) b.w = Math.min(b.w, Math.max(1, o.x - gap - b.x))
      // a neighbour above/left: shrink from the start edge (bottom-anchored)
      else if (vertical) { const end = b.y + b.h; b.y = Math.max(b.y, o.y + o.h + gap); b.h = Math.max(1, end - b.y) }
      else { const end = b.x + b.w; b.x = Math.max(b.x, o.x + o.w + gap); b.w = Math.max(1, end - b.x) }
    }
    before.set(id, b)
  }
  return before
}
