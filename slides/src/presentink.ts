// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Present-mode ink: pen, highlighter, eraser, clear. Presenter-session state
// like the laser — strokes live in an <svg> inside each slide's rendered
// surface for as long as the show runs and are NEVER written to the document
// (exit removes the overlay and every stroke with it).
//
// The layer sits INSIDE `.beeslides-slide`, in slide coordinates (viewBox =
// the deck size), so Reveal's scaling, a resize and a drawn transition all
// carry the ink with its slide. It is `pointer-events:none` until a tool is
// picked: with ink off, links, hover sets, charts and builds see exactly the
// clicks they saw before.

import { t } from './i18n'

export type InkTool = 'pen' | 'highlighter' | 'eraser'

export interface PresentInk {
  readonly tool: InkTool | null
  setTool(tool: InkTool | null): void
  /** pick `tool`, or put the pen down when it is already in hand */
  toggle(tool: InkTool): void
  /** remove every stroke on the slide on screen; false when there was none */
  clear(): boolean
  /** does the slide on screen carry ink? */
  hasInk(): boolean
  /** the slide on screen changed */
  slideChanged(): void
  /** a live edit re-rendered a slide: its drawing moves onto the new surface */
  moveInk(from: HTMLElement, to: HTMLElement): void
  destroy(): void
}

const SVG_NS = 'http://www.w3.org/2000/svg'
export const INK_COLORS = ['#E5243B', '#1F6FEB', '#13A35B'] as const
const HIGHLIGHTER = '#FFE13B'

interface Stroke { node: SVGPathElement; pts: number[]; width: number }

const ICONS: Record<string, string> = {
  pen: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 7l3 3"/>',
  highlighter: '<path d="M5 20h6"/><path d="M8 16l-1.5 4"/><path d="M8 16l8.5-11 3.5 3-8.5 11z"/>',
  eraser: '<path d="M9 20h11"/><path d="M4 15l9-9 6 6-8 8H9z"/><path d="M8.5 10.5l6 6"/>',
  clear: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
  off: '<path d="M6 6l12 12M18 6L6 18"/>',
}
const icon = (k: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`

/** a smoothed path through the points: quadratic segments via the midpoints */
function pathData(pts: number[]): string {
  const n = pts.length / 2
  if (n === 1) return `M${pts[0]} ${pts[1]}l0.01 0`
  let d = `M${pts[0]} ${pts[1]}`
  for (let i = 1; i < n - 1; i++) {
    const x = pts[2 * i], y = pts[2 * i + 1]
    d += ` Q${x} ${y} ${((x + pts[2 * i + 2]) / 2).toFixed(1)} ${((y + pts[2 * i + 3]) / 2).toFixed(1)}`
  }
  return d + ` L${pts[2 * n - 2]} ${pts[2 * n - 1]}`
}

/** distance from (px,py) to the segment a–b */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len = dx * dx + dy * dy
  const k = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
  return Math.hypot(px - (ax + k * dx), py - (ay + k * dy))
}

export function createPresentInk(opts: {
  overlay: HTMLElement
  slidesEl: HTMLElement
  size: { width: number; height: number }
  /** the rendered surface of the slide on screen, or null before Reveal is ready */
  currentSurface: () => HTMLElement | null
  /** a tool was picked (the laser steps aside) */
  onTool: (tool: InkTool | null) => void
  /** the presenter is drawing (restarts the kiosk countdown, as a click would) */
  onActivity?: () => void
}): PresentInk {
  const { overlay, slidesEl, size } = opts
  const W = size.width
  const penWidth = Math.max(2, W * 0.0028)
  const markerWidth = Math.max(10, W * 0.018)
  const eraserRadius = Math.max(8, W * 0.012)
  const strokes = new WeakMap<HTMLElement, Stroke[]>()
  let tool: InkTool | null = null
  let color: string = INK_COLORS[0]

  const layerOf = (surface: HTMLElement, create: boolean): SVGSVGElement | null => {
    let svg = surface.querySelector<SVGSVGElement>(':scope > svg.beeslides-ink')
    if (!svg && create) {
      svg = document.createElementNS(SVG_NS, 'svg')
      svg.classList.add('beeslides-ink')
      svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`)
      svg.setAttribute('aria-hidden', 'true')
      // highlighter strokes paint under pen strokes, whatever the order drawn
      for (const k of ['marker', 'pen']) {
        const g = document.createElementNS(SVG_NS, 'g')
        g.dataset.ink = k
        svg.appendChild(g)
      }
      surface.appendChild(svg)
    }
    return svg
  }

  // ——— the toolbar: a pen button that wakes on pointer movement, the full
  // set while a tool is in hand ———
  const bar = document.createElement('div')
  bar.className = 'beeslides-ink-bar'
  const button = (key: string, title: string, extra = true) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.tabIndex = -1 // never takes focus: Space/Enter stay show keys
    b.dataset.inkBtn = key
    b.title = title
    b.setAttribute('aria-label', title)
    if (extra) b.classList.add('ink-extra')
    b.innerHTML = icon(key)
    bar.appendChild(b)
    return b
  }
  button('pen', t('Pen (P)'), false)
  button('highlighter', t('Highlighter (H)'))
  button('eraser', t('Eraser (E)'))
  const swatches = INK_COLORS.map((c) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.tabIndex = -1
    b.className = 'ink-extra ink-swatch'
    b.dataset.inkColor = c
    b.style.setProperty('--ink-swatch', c)
    b.title = t('Pen colour')
    b.setAttribute('aria-label', t('Pen colour'))
    bar.appendChild(b)
    return b
  })
  button('clear', t('Clear drawing (C)'))
  button('off', t('Stop drawing (Esc)'))
  overlay.appendChild(bar)

  const syncBar = () => {
    for (const b of bar.querySelectorAll<HTMLElement>('[data-ink-btn]')) {
      const on = b.dataset.inkBtn === tool
      b.classList.toggle('active', on)
      if (b.dataset.inkBtn !== 'clear' && b.dataset.inkBtn !== 'off') b.setAttribute('aria-pressed', String(on))
    }
    for (const s of swatches) s.classList.toggle('active', s.dataset.inkColor === color)
  }

  let wakeTimer = 0
  const wake = () => {
    bar.classList.add('awake')
    clearTimeout(wakeTimer)
    wakeTimer = window.setTimeout(() => { if (!bar.matches(':hover')) bar.classList.remove('awake') }, 2500)
  }
  const onWakeMove = () => wake()
  overlay.addEventListener('pointermove', onWakeMove, { passive: true })
  overlay.addEventListener('pointerdown', onWakeMove, { passive: true })
  bar.addEventListener('pointerleave', () => wake())
  // the bar is chrome, not slide: nothing it does reaches the show's handlers
  bar.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); ev.preventDefault() })
  bar.addEventListener('click', (ev) => {
    ev.stopPropagation()
    const b = (ev.target as Element).closest<HTMLElement>('button')
    if (!b) return
    if (b.dataset.inkColor) {
      color = b.dataset.inkColor
      api.setTool('pen')
      return
    }
    const k = b.dataset.inkBtn
    if (k === 'clear') api.clear()
    else if (k === 'off') api.setTool(null)
    else if (k) api.toggle(k as InkTool)
  })

  // ——— drawing ———
  let live: { surface: HTMLElement; stroke: Stroke | null; id: number } | null = null
  const toSlide = (surface: HTMLElement, ev: PointerEvent): [number, number] => {
    const r = surface.getBoundingClientRect()
    return [
      +(((ev.clientX - r.left) / (r.width || 1)) * size.width).toFixed(1),
      +(((ev.clientY - r.top) / (r.height || 1)) * size.height).toFixed(1),
    ]
  }
  const erase = (surface: HTMLElement, x: number, y: number) => {
    const list = strokes.get(surface)
    if (!list?.length) return
    // whole strokes go (PowerPoint's stroke eraser), never a bite out of one
    const hit = (s: Stroke) => {
      const reach = eraserRadius + s.width / 2
      const p = s.pts
      if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach
      for (let i = 2; i < p.length; i += 2) {
        if (segDist(x, y, p[i - 2], p[i - 1], p[i], p[i + 1]) <= reach) return true
      }
      return false
    }
    const keep: Stroke[] = []
    for (const s of list) {
      if (hit(s)) s.node.remove()
      else keep.push(s)
    }
    strokes.set(surface, keep)
  }
  const onDown = (ev: PointerEvent) => {
    if (!tool || live || (ev.pointerType === 'mouse' && ev.button !== 0)) return
    if (!slidesEl.contains(ev.target as Node)) return
    const surface = opts.currentSurface()
    if (!surface) return
    ev.preventDefault()
    ev.stopPropagation()
    opts.onActivity?.()
    const [x, y] = toSlide(surface, ev)
    if (tool === 'eraser') {
      live = { surface, stroke: null, id: ev.pointerId }
      erase(surface, x, y)
    } else {
      const svg = layerOf(surface, true)!
      const marker = tool === 'highlighter'
      const node = document.createElementNS(SVG_NS, 'path')
      node.setAttribute('fill', 'none')
      node.setAttribute('stroke', marker ? HIGHLIGHTER : color)
      node.setAttribute('stroke-width', String(marker ? markerWidth : penWidth))
      node.setAttribute('stroke-linecap', 'round')
      node.setAttribute('stroke-linejoin', 'round')
      if (marker) node.setAttribute('stroke-opacity', '0.45')
      const stroke: Stroke = { node, pts: [x, y], width: marker ? markerWidth : penWidth }
      node.setAttribute('d', pathData(stroke.pts))
      svg.querySelector(`g[data-ink="${marker ? 'marker' : 'pen'}"]`)!.appendChild(node)
      const list = strokes.get(surface) ?? []
      list.push(stroke)
      strokes.set(surface, list)
      live = { surface, stroke, id: ev.pointerId }
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }
  const onMove = (ev: PointerEvent) => {
    if (!live || ev.pointerId !== live.id) return
    ev.preventDefault()
    const [x, y] = toSlide(live.surface, ev)
    const s = live.stroke
    opts.onActivity?.()
    if (!s) { erase(live.surface, x, y); return }
    const n = s.pts.length
    if (Math.hypot(x - s.pts[n - 2], y - s.pts[n - 1]) < 1.5) return
    s.pts.push(x, y)
    s.node.setAttribute('d', pathData(s.pts))
  }
  const endStroke = () => {
    live = null
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onUp, true)
  }
  const onUp = (ev: PointerEvent) => { if (live && ev.pointerId === live.id) endStroke() }
  // a click that ends a stroke must not follow a link or reach the slide
  const onClick = (ev: MouseEvent) => {
    if (tool && slidesEl.contains(ev.target as Node)) { ev.preventDefault(); ev.stopPropagation() }
  }
  overlay.addEventListener('pointerdown', onDown, true)
  overlay.addEventListener('click', onClick, true)

  const api: PresentInk = {
    get tool() { return tool },
    setTool(next) {
      if (live) endStroke()
      tool = next
      overlay.classList.toggle('ink-on', !!next)
      if (next) overlay.dataset.inkTool = next
      else delete overlay.dataset.inkTool
      if (next) { const s = opts.currentSurface(); if (s) layerOf(s, true) }
      syncBar()
      wake()
      opts.onTool(next)
    },
    toggle(next) { api.setTool(tool === next ? null : next) },
    clear() {
      const s = opts.currentSurface()
      const list = s ? strokes.get(s) : undefined
      if (!s || !list?.length) return false
      for (const st of list) st.node.remove()
      strokes.set(s, [])
      return true
    },
    hasInk() {
      const s = opts.currentSurface()
      return !!s && !!strokes.get(s)?.length
    },
    slideChanged() {
      if (live) endStroke()
      if (tool) { const s = opts.currentSurface(); if (s) layerOf(s, true) }
    },
    moveInk(from, to) {
      if (live) endStroke()
      const layer = layerOf(from, false)
      if (layer) to.appendChild(layer)
      const list = strokes.get(from)
      if (list) { strokes.set(to, list); strokes.delete(from) }
    },
    destroy() {
      endStroke()
      clearTimeout(wakeTimer)
      overlay.removeEventListener('pointerdown', onDown, true)
      overlay.removeEventListener('click', onClick, true)
      overlay.removeEventListener('pointermove', onWakeMove)
      overlay.removeEventListener('pointerdown', onWakeMove)
      bar.remove()
    },
  }
  syncBar()
  return api
}
