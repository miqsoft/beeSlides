// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Direct on-canvas editing for line / curved-line / connector SHAPES — the
// intuitive alternative to resizing a box and rotating it. A selected line
// shows two draggable endpoint handles; a curve (path) shows its anchor points
// (double-click to add on the curve, double-click a point to remove); dragging
// the body moves the whole thing. Connectors (endpoints anchored to elements)
// are edited the same way but re-route automatically — see editor.syncConnectors.
//
// Model-driven: handles are positioned from the element's geometry (not its DOM
// node), so a re-render underneath us doesn't matter. Geometry conversions:
//   • line  ⇄ two endpoints (box centre ± half-width along rotation)
//   • path  ⇄ anchor points  (pathBox normalised to [0,0,w,h], d = smoothed)

import type { Store } from '../store'
import { effectiveCanvasSize } from '../store'
import type { ShapeElement, Slide, SlideElement } from '../model'
import { anchorsToPath, parseAnchors, samplePathAnchors } from './patheditor'
import { stackedIndices } from './bezier'

const rnd = (v: number) => Math.round(v * 100) / 100
/** Closed shapes (polygons) end with Z; straight ones have no curve commands. */
export const pathIsClosed = (d?: string) => /z\s*$/i.test(d ?? '')
export const pathIsStraight = (d?: string) => !/[csqta]/i.test(d ?? '')

const SVG_NS = 'http://www.w3.org/2000/svg'
type Pt = { x: number; y: number }

/** True for shapes this editor takes over (instead of Moveable's box). */
export function isLineLike(el: { type: string; shape?: string }): boolean {
  return el.type === 'shape' && (el.shape === 'line' || el.shape === 'path')
}

/** The two endpoints of a line shape, in slide coords. */
export function lineEndpoints(el: ShapeElement): [Pt, Pt] {
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  const rad = ((el.rotation || 0) * Math.PI) / 180
  const hw = el.w / 2
  const dx = Math.cos(rad) * hw
  const dy = Math.sin(rad) * hw
  return [{ x: cx - dx, y: cy - dy }, { x: cx + dx, y: cy + dy }]
}

/** Write a line shape from two endpoints (keeps its stroke-box thickness). */
export function setLineEndpoints(el: ShapeElement, a: Pt, b: Pt): void {
  const cx = (a.x + b.x) / 2
  const cy = (a.y + b.y) / 2
  const w = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1)
  const h = el.h || 4
  el.w = w
  el.x = cx - w / 2
  el.y = cy - h / 2
  el.rotation = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
}

type Box = { x: number; y: number; w: number; h: number }
export function boxCenter(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}
/** Where the ray from box b's centre toward `target` crosses b's border. */
export function borderPoint(b: Box, target: Pt): Pt {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = target.x - cx
  const dy = target.y - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const sx = dx ? b.w / 2 / Math.abs(dx) : Infinity
  const sy = dy ? b.h / 2 / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

/** Midpoint of one side of a box (connector anchor points). */
export function sideMidpoint(b: Box, side: 'top' | 'right' | 'bottom' | 'left'): Pt {
  if (side === 'top') return { x: b.x + b.w / 2, y: b.y }
  if (side === 'bottom') return { x: b.x + b.w / 2, y: b.y + b.h }
  if (side === 'left') return { x: b.x, y: b.y + b.h / 2 }
  return { x: b.x + b.w, y: b.y + b.h / 2 }
}

/** Re-route connectors (line shapes anchored via from/to) on `slide` to the
 *  current boxes of the elements they name; a dangling ref is dropped and that
 *  end becomes free. Pure model code — editor.syncConnectors runs it on the
 *  open slide after every change, the layout guard (layoutguard.ts) on
 *  whichever slide an agent write or Tidy touched. Returns the ids of the
 *  connectors whose geometry or anchoring changed. */
export function rerouteConnectors(slide: Slide): string[] {
  const byId = new Map(slide.elements.map((e) => [e.id, e]))
  const changed: string[] = []
  for (const el of slide.elements) {
    if (el.type !== 'shape' || el.shape !== 'line') continue
    const c = el as ShapeElement
    if (!c.from && !c.to) continue
    let touched = false
    if (c.from && !byId.has(c.from.el)) { delete c.from; touched = true }
    if (c.to && !byId.has(c.to.el)) { delete c.to; touched = true }
    if (c.from || c.to) {
      const [a, b] = lineEndpoints(c)
      const fromBox = c.from ? byId.get(c.from.el) : null
      const toBox = c.to ? byId.get(c.to.el) : null
      // explicit side → pin to that side's midpoint; 'auto' → nearest border
      const end = (box: SlideElement, side: 'auto' | 'top' | 'right' | 'bottom' | 'left' | undefined, toward: Pt) =>
        side && side !== 'auto' ? sideMidpoint(box, side) : borderPoint(box, toward)
      const na = fromBox ? end(fromBox, c.from?.side, toBox ? boxCenter(toBox) : b) : a
      const nb = toBox ? end(toBox, c.to?.side, fromBox ? boxCenter(fromBox) : a) : b
      if (Math.hypot(na.x - a.x, na.y - a.y) > 0.5 || Math.hypot(nb.x - b.x, nb.y - b.y) > 0.5) {
        setLineEndpoints(c, na, nb)
        touched = true
      }
    }
    if (touched) changed.push(c.id)
  }
  return changed
}

/** Anchor points of a path shape, in slide coords. Straight paths (polylines/
 *  polygons) parse exactly; curves are sampled+reduced. */
export function pathAnchors(el: ShapeElement): Pt[] {
  const [px, py, pw, ph] = el.pathBox ?? [0, 0, el.w || 1, el.h || 1]
  const sx = el.w / (pw || 1)
  const sy = el.h / (ph || 1)
  const src = pathIsStraight(el.d) ? parseAnchors(el.d ?? '') : samplePathAnchors(el.d ?? '')
  return src.map((p) => ({ x: el.x + (p.x - px) * sx, y: el.y + (p.y - py) * sy }))
}

/** Write a path shape from anchor points (slide coords); normalises pathBox.
 *  `straight` keeps segments as lines (polygons); `closed` appends Z. */
export function setPathAnchors(el: ShapeElement, pts: Pt[], opts: { closed?: boolean; straight?: boolean } = {}): void {
  if (pts.length < 2) return
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const w = Math.max(Math.max(...xs) - minX, 1)
  const h = Math.max(Math.max(...ys) - minY, 1)
  el.x = minX
  el.y = minY
  el.w = w
  el.h = h
  el.pathBox = [0, 0, w, h]
  const rel = pts.map((p) => ({ x: rnd(p.x - minX), y: rnd(p.y - minY) }))
  el.d = (opts.straight
    ? 'M ' + rel.map((p) => `${p.x} ${p.y}`).join(' L ')
    : anchorsToPath(rel)) + (opts.closed ? ' Z' : '')
}

export class LineEditor {
  private overlay: SVGSVGElement | null = null
  private elId = ''
  private kind: 'line' | 'path' = 'line'
  private closed = false
  private straight = false
  private pts: Pt[] = []
  private scale = () => 1
  /** Grid snap for endpoint/body drags — wired by the canvas (identity when the grid is off). */
  snap: (p: Pt) => Pt = (p) => p

  constructor(
    private scaleHost: HTMLElement,
    private store: Store,
  ) {}

  get active() {
    return !!this.overlay
  }
  get elementId() {
    return this.elId
  }

  setScaleGetter(fn: () => number) {
    this.scale = fn
  }

  /** Show handles for a line/path shape (idempotent — re-reads geometry). */
  attach(elId: string) {
    const el = this.store.element(elId) as ShapeElement | undefined
    if (!el || !isLineLike(el)) return this.detach()
    this.elId = elId
    this.kind = el.shape === 'path' ? 'path' : 'line'
    this.closed = this.kind === 'path' && pathIsClosed(el.d)
    this.straight = this.kind === 'path' && pathIsStraight(el.d)
    this.pts = this.kind === 'line' ? lineEndpoints(el) : pathAnchors(el)
    if (!this.overlay) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.classList.add('ed-lineedit')
      const { width, height } = effectiveCanvasSize(this.store)
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
      svg.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:visible;z-index:49;pointer-events:none`
      svg.addEventListener('dblclick', (ev) => this.onDblClick(ev))
      this.scaleHost.appendChild(svg)
      this.overlay = svg
    }
    this.draw()
  }

  detach() {
    this.overlay?.remove()
    this.overlay = null
    this.elId = ''
  }

  // --- rendering -------------------------------------------------------------

  private draw() {
    const svg = this.overlay
    if (!svg) return
    svg.innerHTML = ''
    const k = 1 / this.scale()
    const mk = (tag: string) => document.createElementNS(SVG_NS, tag)
    const d = this.kind === 'line'
      ? `M ${this.pts[0].x} ${this.pts[0].y} L ${this.pts[1].x} ${this.pts[1].y}`
      : (this.straight
          ? 'M ' + this.pts.map((p) => `${p.x} ${p.y}`).join(' L ')
          : anchorsToPath(this.pts)) + (this.closed ? ' Z' : '')

    // fat invisible hit-line to drag the whole shape (and, for curves, to insert)
    const hit = mk('path')
    hit.setAttribute('d', d)
    hit.setAttribute('fill', 'none')
    hit.setAttribute('stroke', 'transparent')
    hit.setAttribute('stroke-width', String(16 * k))
    hit.classList.add('ed-le-body')
    hit.style.cursor = 'move'
    hit.style.pointerEvents = 'stroke'
    hit.addEventListener('mousedown', (ev) => this.dragBody(ev))
    svg.appendChild(hit)

    // thin guide line so the geometry is visible while editing
    const guide = mk('path')
    guide.setAttribute('d', d)
    guide.setAttribute('fill', 'none')
    guide.setAttribute('stroke', '#5b8def')
    guide.setAttribute('stroke-width', String(1.5 * k))
    guide.style.pointerEvents = 'none'
    svg.appendChild(guide)

    this.pts.forEach((p, i) => {
      const dot = mk('circle')
      dot.setAttribute('cx', String(p.x))
      dot.setAttribute('cy', String(p.y))
      dot.setAttribute('r', String(6.5 * k))
      dot.setAttribute('fill', '#fff')
      dot.setAttribute('stroke', '#2f6df6')
      dot.setAttribute('stroke-width', String(2 * k))
      dot.classList.add('ed-le-anchor')
      dot.dataset.idx = String(i)
      dot.style.cursor = 'grab'
      dot.style.pointerEvents = 'all'
      dot.addEventListener('mousedown', (ev) => this.dragAnchor(ev, i))
      svg.appendChild(dot)
    })
  }

  // --- interaction -----------------------------------------------------------

  private toSlide(ev: MouseEvent): Pt {
    const rect = this.scaleHost.getBoundingClientRect()
    const s = this.scale()
    return { x: (ev.clientX - rect.left) / s, y: (ev.clientY - rect.top) / s }
  }

  private elNode(): HTMLElement | null {
    return this.scaleHost.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(this.elId)}"]`)
  }

  private dragAnchor(down: MouseEvent, idx: number) {
    down.stopPropagation()
    down.preventDefault()
    const start = this.toSlide(down)
    const orig = { ...this.pts[idx] }
    // a path's anchors stacked on this spot (a retraced edge / keyhole seam,
    // e.g. the Frame or Cube preset) move as one, so the outline can't tear.
    // A line's two ends always move independently (even when they touch).
    const group = this.kind === 'path' ? stackedIndices(this.pts, idx) : [idx]
    const node = this.elNode()
    if (node) node.style.opacity = '0.4'
    let moved = false
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      moved = true
      const np = this.snap({ x: orig.x + (p.x - start.x), y: orig.y + (p.y - start.y) })
      for (const i of group) this.pts[i] = { ...np }
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (node) node.style.opacity = ''
      if (moved) this.commit(idx)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private dragBody(down: MouseEvent) {
    down.stopPropagation()
    down.preventDefault()
    const start = this.toSlide(down)
    const orig = this.pts.map((p) => ({ ...p }))
    const node = this.elNode()
    if (node) node.style.opacity = '0.4'
    let moved = false
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      // snap the delta so the first point lands on the grid
      const s0 = this.snap({ x: orig[0].x + p.x - start.x, y: orig[0].y + p.y - start.y })
      const dx = s0.x - orig[0].x
      const dy = s0.y - orig[0].y
      moved = true
      this.pts = orig.map((o) => ({ x: o.x + dx, y: o.y + dy }))
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (node) node.style.opacity = ''
      if (moved) this.commit(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private onDblClick(ev: MouseEvent) {
    if (this.kind !== 'path') return
    ev.preventDefault()
    ev.stopPropagation()
    const target = ev.target as Element
    const p = this.toSlide(ev)
    if (target.classList.contains('ed-le-anchor')) {
      const idx = Number((target as SVGElement).dataset.idx)
      // a stacked anchor goes as a whole; a polygon keeps at least 3 points
      const drop = new Set(stackedIndices(this.pts, idx))
      if (this.pts.length - drop.size >= (this.closed ? 3 : 2)) {
        this.pts = this.pts.filter((_, i) => !drop.has(i))
        this.commit(null)
      }
      return
    }
    // insert into the nearest segment midpoint
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < this.pts.length - 1; i++) {
      const mx = (this.pts[i].x + this.pts[i + 1].x) / 2
      const my = (this.pts[i].y + this.pts[i + 1].y) / 2
      const dd = Math.hypot(p.x - mx, p.y - my)
      if (dd < bestDist) { bestDist = dd; best = i }
    }
    this.pts.splice(best + 1, 0, p)
    this.commit(null)
  }

  /** Push the edited geometry into the model (one undo step); a connector whose
   *  dragged END lands on nothing loses that anchor (it becomes free). */
  private commit(draggedIdx: number | null) {
    const id = this.elId
    const pts = this.pts.map((p) => ({ ...p }))
    const kind = this.kind
    this.store.commit(() => {
      const el = this.store.element(id) as ShapeElement | undefined
      if (!el) return
      if (kind === 'line') setLineEndpoints(el, pts[0], pts[1])
      else setPathAnchors(el, pts, { closed: this.closed, straight: this.straight })
      // moving an endpoint by hand detaches that end of a connector
      if (draggedIdx === 0) delete el.from
      if (draggedIdx !== null && draggedIdx === pts.length - 1) delete el.to
    })
  }
}
