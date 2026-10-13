// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Picture cropping on the canvas (ImageElement.crop). Double-click a picture,
// or press Crop in its panel / the mini toolbar: the whole picture shows as a
// faded ghost, the part that will stay is a bright window with eight handles.
// Drag a handle to cut an edge, drag the picture to move it under the window.
// Enter, Done or a click anywhere else applies it as ONE undo step; Esc and
// Cancel leave the element untouched.
//
// PowerPoint's model: cropping moves the FRAME's edges inward while the
// picture stays where it is on the slide, so the frame always shows exactly
// the window and its aspect matches the region (nothing stretches). The
// stored crop is fractions of the natural picture (model.ts ImageCrop).
//
// Everything is worked out in the frame's LOCAL display space: origin at the
// frame's top-left, before rotation, after flip (what the reader sees inside
// the box). Model-driven like LineEditor: the overlay is drawn from the
// element's geometry, so a canvas re-render does not move it; the canvas
// cancels the mode if the document changes underneath (canvas.render).
//
// Moveable is hidden while cropping (canvas.syncTargets) and every pointer
// gesture here stops propagation, so Selecto never sees it.

import type { Store } from '../store'
import { normalizeCrop, MIN_CROP, type ImageCrop, type ImageElement } from '../model'
import { t } from '../i18n'

export interface Rect { x: number; y: number; w: number; h: number }

/** Mirror a local rect inside a w×h frame — natural ⇄ display under flips. */
function mirror(r: Rect, w: number, h: number, flipH?: boolean, flipV?: boolean): Rect {
  return {
    x: flipH ? w - r.x - r.w : r.x,
    y: flipV ? h - r.y - r.h : r.y,
    w: r.w, h: r.h,
  }
}

/**
 * Where the WHOLE picture sits in the frame's local display space, as it is
 * drawn now: from the crop when there is one (no natural size needed),
 * otherwise from `fit` and the natural size (0 = unknown → the frame).
 */
export function pictureRect(el: ImageElement, natW = 0, natH = 0): Rect {
  const crop = normalizeCrop(el.crop)
  let r: Rect
  if (crop) {
    const w = el.w / crop.w
    const h = el.h / crop.h
    r = { x: -crop.x * w, y: -crop.y * h, w, h }
  } else if (el.fit === 'fill' || !natW || !natH) {
    r = { x: 0, y: 0, w: el.w, h: el.h }
  } else {
    const s = el.fit === 'cover' ? Math.max(el.w / natW, el.h / natH) : Math.min(el.w / natW, el.h / natH)
    const w = natW * s
    const h = natH * s
    r = { x: (el.w - w) / 2, y: (el.h - h) / 2, w, h }
  }
  return mirror(r, el.w, el.h, el.flipH, el.flipV)
}

/** The part of picture `r` the frame shows now (contain leaves bars). */
export function visibleWindow(el: ImageElement, r: Rect): Rect {
  const x0 = Math.max(r.x, 0)
  const y0 = Math.max(r.y, 0)
  const x1 = Math.min(r.x + r.w, el.w)
  const y1 = Math.min(r.y + r.h, el.h)
  return { x: x0, y: y0, w: Math.max(x1 - x0, 1), h: Math.max(y1 - y0, 1) }
}

/** The crop that shows window `c` of picture `r` (both local display rects);
 *  null when the window is the whole picture. */
export function cropFor(r: Rect, c: Rect, flipH?: boolean, flipV?: boolean): ImageCrop | null {
  let x = (c.x - r.x) / r.w
  let y = (c.y - r.y) / r.h
  const w = c.w / r.w
  const h = c.h / r.h
  if (flipH) x = 1 - x - w
  if (flipV) y = 1 - y - h
  return normalizeCrop({ x, y, w, h })
}

/**
 * The slide frame for local rect `c` of element `el` — rotation-aware, so
 * what is on screen stays where it is: the rect's centre is rotated about
 * the old frame's centre, then the new (unrotated) box is laid around it.
 */
export function frameFor(el: { x: number; y: number; w: number; h: number; rotation?: number }, c: Rect): Rect {
  const rad = ((el.rotation || 0) * Math.PI) / 180
  const dx = c.x + c.w / 2 - el.w / 2
  const dy = c.y + c.h / 2 - el.h / 2
  const cx = el.x + el.w / 2 + dx * Math.cos(rad) - dy * Math.sin(rad)
  const cy = el.y + el.h / 2 + dx * Math.sin(rad) + dy * Math.cos(rad)
  return { x: cx - c.w / 2, y: cy - c.h / 2, w: c.w, h: c.h }
}

const round = (v: number) => Math.round(v * 100) / 100
const roundFrac = (v: number) => Math.round(v * 1e6) / 1e6

/**
 * Apply a crop edit: frame = window `c`, crop = `c` within picture `r`.
 * `fit` becomes 'cover' with a crop — ignored by this renderer, but it is
 * what an OLDER reader draws (the whole picture, centre-cropped to the
 * frame's shape) instead of squeezing it. A window that is the whole picture
 * removes the crop.
 */
export function applyCropEdit(el: ImageElement, r: Rect, c: Rect): void {
  const crop = cropFor(r, c, el.flipH, el.flipV)
  const f = frameFor(el, c)
  el.x = round(f.x); el.y = round(f.y); el.w = round(f.w); el.h = round(f.h)
  if (crop) {
    el.crop = { x: roundFrac(crop.x), y: roundFrac(crop.y), w: roundFrac(crop.w), h: roundFrac(crop.h) }
    el.fit = 'cover'
  } else delete el.crop
}

/**
 * The whole picture `r` at the picture's NATURAL aspect: a cropped frame that
 * was resized freely draws the picture stretched, and showing all of it must
 * not keep that stretch. Width and centre stay, the height follows the
 * natural ratio. Unchanged when the natural size is unknown (0).
 */
export function unstretched(r: Rect, natW = 0, natH = 0): Rect {
  if (!natW || !natH || !r.w) return r
  const h = (r.w * natH) / natW
  return { x: r.x, y: r.y + (r.h - h) / 2, w: r.w, h }
}

/** "Reset crop": show the whole picture again, at the scale and place it
 *  has now — the frame grows back out to it, at the picture's natural
 *  aspect when its natural size is given (see `unstretched`). No-op
 *  without a crop. */
export function resetCrop(el: ImageElement, natW = 0, natH = 0): boolean {
  if (!el.crop) return false
  const r = unstretched(pictureRect(el), natW, natH)
  const f = frameFor(el, r)
  delete el.crop
  el.x = round(f.x); el.y = round(f.y); el.w = round(f.w); el.h = round(f.h)
  return true
}

/** The natural size of an image element's picture as the editor canvas has
 *  it decoded ([0, 0] when it is not on the canvas or not decoded yet). */
export function canvasNaturalSize(elId: string): [number, number] {
  const img = document.querySelector<HTMLImageElement>(
    `.ed-stage-scale .slidomingo-el[data-el-id="${CSS.escape(elId)}"] img`)
  return [img?.naturalWidth || 0, img?.naturalHeight || 0]
}

type HandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: HandleDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CURSOR: Record<HandleDir, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))

export class CropMode {
  private elId = ''
  private overlay: HTMLElement | null = null
  private bar: HTMLElement | null = null
  private src = ''
  /** the whole picture / the kept window, local display px */
  private pic: Rect = { x: 0, y: 0, w: 1, h: 1 }
  private win: Rect = { x: 0, y: 0, w: 1, h: 1 }
  private dirty = false
  /** the picture's natural size (0 = unknown) — Reset un-stretches with it */
  private nat: [number, number] = [0, 0]
  /** an element whose crop mode waits for its picture to decode */
  private pendingId = ''
  private scale = () => 1
  private off: Array<() => void> = []
  /** bumped on every start/stop so a late image decode cannot start a stale mode */
  private gen = 0

  constructor(
    private scaleHost: HTMLElement,
    private wrap: HTMLElement,
    private scroller: HTMLElement,
    private store: Store,
    /** the mode ended (applied or not) — the canvas brings Moveable back */
    private onExit: () => void,
  ) {}

  get active() { return !!this.overlay }
  /** active, or about to be (waiting for the picture to decode): the canvas
   *  keeps Moveable and Selecto off the element either way */
  get engaged() { return this.active || !!this.pendingId }
  get elementId() { return this.elId || this.pendingId }
  setScaleGetter(fn: () => number) { this.scale = fn }

  private node(id = this.elId): HTMLElement | null {
    return this.scaleHost.querySelector<HTMLElement>(`.slidomingo-el[data-el-id="${CSS.escape(id)}"]`)
  }

  /** Enter crop mode for an image element. Waits for the picture to decode
   *  when its natural size is needed and not known yet. */
  start(elId: string): boolean {
    const el = this.store.element(elId)
    if (!el || el.type !== 'image') return false
    if (this.active) this.commit()
    const gen = ++this.gen
    const img = this.node(elId)?.querySelector('img')
    if (!img) return false
    if (!img.naturalWidth && !img.complete) {
      this.pendingId = elId
      void img.decode().catch(() => {}).then(() => {
        if (gen !== this.gen) return
        this.pendingId = ''
        // gone or re-rendered meanwhile: give the canvas its handles back
        if (!img.isConnected || !this.open(elId, img)) this.onExit()
      })
      return true
    }
    return this.open(elId, img)
  }

  private open(elId: string, img: HTMLImageElement): boolean {
    const el = this.store.element(elId) as ImageElement | undefined
    if (!el || el.type !== 'image') return false
    this.elId = elId
    this.src = img.currentSrc || img.src
    this.nat = [img.naturalWidth, img.naturalHeight]
    this.pic = pictureRect(el, img.naturalWidth, img.naturalHeight)
    this.win = visibleWindow(el, this.pic)
    this.dirty = false
    const node = this.node()
    if (node) node.style.visibility = 'hidden'

    const ov = document.createElement('div')
    ov.className = 'ed-crop'
    ov.addEventListener('dblclick', (ev) => { ev.preventDefault(); ev.stopPropagation(); this.commit() })
    this.scaleHost.appendChild(ov)
    this.overlay = ov
    this.buildBar()
    this.draw()

    // Capture on WINDOW: runs before the canvas's document-capture blocks
    // (Alt-click, context menu, format painter) and before Selecto.
    const onKey = (ev: KeyboardEvent) => {
      const tgt = ev.target as HTMLElement | null
      if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName))) return
      // Enter/Space on a focused crop-bar button presses THAT button (Reset
      // must not apply the crop instead)
      if ((ev.key === 'Enter' || ev.key === ' ') && tgt?.closest('button') && this.bar?.contains(tgt)) return
      const mod = ev.metaKey || ev.ctrlKey
      if (ev.key === 'Enter') this.commit()
      else if (ev.key === 'Escape') this.cancel()
      // undo while cropping undoes the crop session only — the earlier edit
      // the store would undo next stays (the session is not a store step yet)
      else if (mod && ev.key.toLowerCase() === 'z') this.cancel()
      else if (ev.key === 'Delete' || ev.key === 'Backspace' || ev.key.startsWith('Arrow')) { /* swallowed */ }
      else return
      ev.preventDefault()
      ev.stopImmediatePropagation()
    }
    const onDown = (ev: MouseEvent) => {
      const tgt = ev.target as Node | null
      if (tgt && (this.overlay?.contains(tgt) || this.bar?.contains(tgt))) return
      // undo/redo buttons cancel the session on click (editor.undo) — applying
      // it here first would make their undo take the crop back as a step
      if (tgt instanceof Element && tgt.closest('[data-keeps-crop]')) return
      const onCanvas = !!tgt && this.scroller.contains(tgt)
      this.commit()
      // a click on the canvas only ends the mode — it must not also select
      // (Selecto would hit-test a node the commit just re-rendered away)
      if (onCanvas) { ev.preventDefault(); ev.stopImmediatePropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    this.off.push(
      () => window.removeEventListener('keydown', onKey, true),
      () => window.removeEventListener('mousedown', onDown, true),
    )
    return true
  }

  private buildBar() {
    const bar = document.createElement('div')
    bar.className = 'ed-fx-preview-hint ed-step-bar ed-crop-bar'
    const label = document.createElement('span')
    label.textContent = t('Drag the handles to crop, drag the picture to move it — Enter applies, Esc cancels')
    const btn = (text: string, title: string, fn: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-btn'
      b.textContent = text
      if (title) b.title = title
      // a mouse press must not focus the button: a focused bar button takes
      // Enter/Space for itself (onKey), so after clicking Reset and dragging
      // a handle, Enter would press Reset again instead of applying. Keyboard
      // focus (Tab) still reaches the buttons.
      b.addEventListener('mousedown', (ev) => ev.preventDefault())
      b.addEventListener('click', fn)
      return b
    }
    bar.append(
      label,
      btn(t('Reset crop'), t('Show the whole picture again'), () => {
        // a cropped frame resized freely draws the picture stretched — the
        // whole picture comes back at its own aspect (an uncropped 'fill'
        // picture keeps the stretch its owner chose)
        const el = this.store.element(this.elId) as ImageElement | undefined
        if (normalizeCrop(el?.crop)) this.pic = unstretched(this.pic, ...this.nat)
        this.win = { ...this.pic }
        this.dirty = true
        this.draw()
      }),
      btn(t('Cancel'), '', () => this.cancel()),
      btn(t('Done'), '', () => this.commit()),
    )
    this.wrap.appendChild(bar)
    this.wrap.classList.add('ed-cropping') // hides the mini toolbar
    this.bar = bar
  }

  /** The overlay's parts, built once per session (draw() only moves them —
   *  re-creating the imgs on every mousemove would re-decode the picture). */
  private parts: { ghost: HTMLImageElement; win: HTMLElement; pic: HTMLImageElement; handles: Map<HandleDir, HTMLElement> } | null = null

  private build(ov: HTMLElement, el: ImageElement) {
    const flip = el.flipH || el.flipV ? `scale(${el.flipH ? -1 : 1},${el.flipV ? -1 : 1})` : 'none'
    const picImg = (cls: string) => {
      const img = document.createElement('img')
      img.className = cls
      img.src = this.src
      img.alt = ''
      img.draggable = false
      img.style.cssText = `position:absolute;max-width:none;object-fit:fill;transform:${flip}`
      return img
    }
    const ghost = picImg('ed-crop-ghost')
    ghost.addEventListener('mousedown', (ev) => this.dragPicture(ev))
    const win = document.createElement('div')
    win.className = 'ed-crop-window'
    const pic = picImg('ed-crop-pic')
    pic.style.pointerEvents = 'none'
    win.appendChild(pic)
    win.addEventListener('mousedown', (ev) => this.dragPicture(ev))
    ov.append(ghost, win)
    const handles = new Map<HandleDir, HTMLElement>()
    for (const dir of HANDLES) {
      const h = document.createElement('div')
      h.className = 'ed-crop-h'
      h.dataset.h = dir
      h.style.cursor = CURSOR[dir]
      h.addEventListener('mousedown', (ev) => this.dragHandle(ev, dir))
      ov.appendChild(h)
      handles.set(dir, h)
    }
    this.parts = { ghost, win, pic, handles }
  }

  /** Lay the overlay out from the model frame + the session's rects; also
   *  called on zoom so the handles keep one screen size. */
  draw() {
    const ov = this.overlay
    const el = this.store.element(this.elId) as ImageElement | undefined
    if (!ov || !el) return
    if (!this.parts) this.build(ov, el)
    const { ghost, win, pic, handles } = this.parts!
    const k = 1 / (this.scale() || 1)
    const px = (r: Rect) => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`
    ov.style.cssText = `position:absolute;${px(el)};` +
      `transform:${el.rotation ? `rotate(${el.rotation}deg)` : 'none'};z-index:49;pointer-events:none`
    const p = this.pic
    const w = this.win
    ghost.style.left = `${p.x}px`; ghost.style.top = `${p.y}px`
    ghost.style.width = `${p.w}px`; ghost.style.height = `${p.h}px`
    win.style.cssText = `position:absolute;${px(w)};overflow:hidden;pointer-events:auto;cursor:move;` +
      `outline:${1.5 * k}px solid #fff;box-shadow:0 0 0 ${2.5 * k}px rgba(0,0,0,.35)`
    pic.style.left = `${p.x - w.x}px`; pic.style.top = `${p.y - w.y}px`
    pic.style.width = `${p.w}px`; pic.style.height = `${p.h}px`
    const size = 12 * k
    for (const [dir, h] of handles) {
      const hx = w.x + (dir.includes('w') ? 0 : dir.includes('e') ? w.w : w.w / 2)
      const hy = w.y + (dir.includes('n') ? 0 : dir.includes('s') ? w.h : w.h / 2)
      // edge handles are bars along their edge, corners squares
      const hw = dir === 'n' || dir === 's' ? size * 2 : size
      const hh = dir === 'e' || dir === 'w' ? size * 2 : size
      h.style.left = `${hx - hw / 2}px`; h.style.top = `${hy - hh / 2}px`
      h.style.width = `${hw}px`; h.style.height = `${hh}px`
      h.style.borderWidth = `${1.5 * k}px`; h.style.borderRadius = `${2 * k}px`
    }
  }

  /** A client-space mouse delta in the frame's local (unrotated) px. */
  private localDelta(down: MouseEvent, ev: MouseEvent): { dx: number; dy: number } {
    const el = this.store.element(this.elId)
    const s = this.scale() || 1
    const gx = (ev.clientX - down.clientX) / s
    const gy = (ev.clientY - down.clientY) / s
    const rad = (-(el?.rotation || 0) * Math.PI) / 180
    return { dx: gx * Math.cos(rad) - gy * Math.sin(rad), dy: gx * Math.sin(rad) + gy * Math.cos(rad) }
  }

  private track(down: MouseEvent, onMove: (dx: number, dy: number) => void) {
    down.preventDefault()
    down.stopPropagation()
    const move = (ev: MouseEvent) => {
      const { dx, dy } = this.localDelta(down, ev)
      onMove(dx, dy)
      this.dirty = true
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('mouseup', up, true)
    }
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', up, true)
  }

  /** Move the picture under the window; the window never leaves it. */
  private dragPicture(down: MouseEvent) {
    if (down.button !== 0) return
    const p0 = { ...this.pic }
    const w = this.win
    this.track(down, (dx, dy) => {
      this.pic = {
        ...p0,
        x: clamp(p0.x + dx, w.x + w.w - p0.w, w.x),
        y: clamp(p0.y + dy, w.y + w.h - p0.h, w.y),
      }
    })
  }

  /** Move one or two window edges, inside the picture, never below a minimum. */
  private dragHandle(down: MouseEvent, dir: HandleDir) {
    if (down.button !== 0) return
    const w0 = { ...this.win }
    const p = this.pic
    const minW = Math.max(4, p.w * MIN_CROP)
    const minH = Math.max(4, p.h * MIN_CROP)
    this.track(down, (dx, dy) => {
      let l = w0.x, tp = w0.y, r = w0.x + w0.w, b = w0.y + w0.h
      if (dir.includes('w')) l = clamp(w0.x + dx, p.x, r - minW)
      if (dir.includes('e')) r = clamp(r + dx, l + minW, p.x + p.w)
      if (dir.includes('n')) tp = clamp(w0.y + dy, p.y, b - minH)
      if (dir.includes('s')) b = clamp(b + dy, tp + minH, p.y + p.h)
      this.win = { x: l, y: tp, w: r - l, h: b - tp }
    })
  }

  private teardown() {
    this.gen++
    this.pendingId = ''
    for (const f of this.off.splice(0)) f()
    this.overlay?.remove()
    this.bar?.remove()
    this.wrap.classList.remove('ed-cropping')
    this.parts = null
    this.overlay = null
    this.bar = null
    const node = this.elId ? this.node() : null
    if (node) node.style.visibility = ''
  }

  /** Apply the crop as one undo step (nothing to apply = no step). */
  commit() {
    if (!this.active) return
    const id = this.elId
    const pic = { ...this.pic }
    const win = { ...this.win }
    const dirty = this.dirty
    this.teardown()
    this.elId = ''
    if (dirty) {
      this.store.commit(() => {
        const el = this.store.element(id)
        if (el?.type === 'image') applyCropEdit(el, pic, win)
      })
    }
    this.onExit()
  }

  /** Leave without changing anything. */
  cancel() {
    // still waiting for the decode: just never open (the caller re-syncs)
    if (!this.active) { this.gen++; this.pendingId = ''; return }
    this.teardown()
    this.elId = ''
    this.onExit()
  }
}
