// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Shared floating-position math for JS-positioned popovers (position:fixed).
// Three implementations of "put a panel near a trigger" existed independently
// before this file: openLayoutPicker (editor.ts) and openIconSearchPopover
// (iconlibrary.ts) each hand-rolled their own clamp, and the icon popover's
// clamped only the ceiling of its vertical offset — on a short viewport it
// could compute a `top` ABOVE the trigger's own bottom edge, rendering on top
// of the button that opened it instead of below it. positionFloating() is the
// one clamp both now share; flipMenuIfNeeded() is the sibling for the OTHER
// family of floating panel in this codebase, the CSS-anchored `.ed-menu`
// (position:absolute, `top: calc(100% + 4px)`) used by the Save/Share/
// Language/View/Shape/Media/File dropdowns — those had no vertical flip at
// all, opening downward unconditionally regardless of space.

/** Anchor corner: which corner of the trigger the panel's near corner lines
 *  up with, before any flip/clamp is applied. */
export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export interface PositionFloatingOpts {
  placement?: Placement
  /** px gap between trigger and panel on the anchored axis. */
  gap?: number
  /** px minimum distance kept from every viewport edge. */
  margin?: number
}

function clamp(value: number, lo: number, hi: number): number {
  // If the panel is wider/taller than the viewport minus margins, `hi` can
  // fall below `lo` — pin to the near edge instead of inverting the range.
  return hi < lo ? lo : Math.min(Math.max(value, lo), hi)
}

/** A client-coordinate box (a DOMRect, or any subset with these edges). */
export interface RectLike { left: number; top: number; right: number; bottom: number }

export interface PositionAtRectOpts {
  /** preferred side of the anchor; flips when that side lacks room */
  placement?: 'bottom' | 'top'
  /** horizontal alignment of the panel against the anchor */
  align?: 'start' | 'center' | 'end'
  /** px gap between anchor and panel on the anchored axis. */
  gap?: number
  /** px minimum distance kept from every edge of `bounds`. */
  margin?: number
  /** the box the panel must stay inside (client coords) — the viewport by
   *  default; the mini toolbar passes the canvas area. */
  bounds?: RectLike
  /** position `absolute` relative to this element's box instead of `fixed`
   *  — for panels whose ancestors may be reparented into a transformed or
   *  clipping container (the mini toolbar rides the canvas into the Layout
   *  Manager). The element must be the panel's offset parent. */
  relativeTo?: HTMLElement
}

/**
 * Place `panel` (already appended and visible — its box is measured with
 * `getBoundingClientRect()`, never guessed) next to the client rect `anchor`.
 * Flips to the opposite vertical side when the requested side lacks room and
 * the other side has more; clamps the final `left`/`top` on BOTH ends of BOTH
 * axes inside `bounds`. Returns which side it landed on.
 */
export function positionAtRect(anchor: RectLike, panel: HTMLElement, opts: PositionAtRectOpts = {}): 'bottom' | 'top' {
  const gap = opts.gap ?? 8
  const margin = opts.margin ?? 8
  const bounds = opts.bounds ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  const pr = panel.getBoundingClientRect()

  const spaceBelow = bounds.bottom - anchor.bottom
  const spaceAbove = anchor.top - bounds.top
  let side: 'bottom' | 'top'
  if ((opts.placement ?? 'bottom') === 'bottom') {
    side = pr.height > spaceBelow - gap && spaceAbove > spaceBelow ? 'top' : 'bottom' // flip up — more room there
  } else {
    side = pr.height > spaceAbove - gap && spaceBelow > spaceAbove ? 'bottom' : 'top' // flip down — more room there
  }
  const top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - pr.height

  const align = opts.align ?? 'start'
  const left = align === 'start' ? anchor.left
    : align === 'end' ? anchor.right - pr.width
    : (anchor.left + anchor.right) / 2 - pr.width / 2

  let x = clamp(left, bounds.left + margin, bounds.right - pr.width - margin)
  let y = clamp(top, bounds.top + margin, bounds.bottom - pr.height - margin)
  if (opts.relativeTo) {
    const base = opts.relativeTo.getBoundingClientRect()
    x -= base.left
    y -= base.top
    panel.style.position = 'absolute'
  } else {
    panel.style.position = 'fixed'
  }
  panel.style.left = `${Math.round(x)}px`
  panel.style.top = `${Math.round(y)}px`
  return side
}

/**
 * Position `panel` relative to `trigger`, as `position: fixed` — the
 * trigger-anchored form of positionAtRect (same flip + clamp), so the panel
 * can never render off-screen OR overlapping the trigger it hangs off of.
 */
export function positionFloating(trigger: HTMLElement, panel: HTMLElement, opts: PositionFloatingOpts = {}): void {
  const [side, align] = (opts.placement ?? 'bottom-start').split('-') as ['bottom' | 'top', 'start' | 'end']
  positionAtRect(trigger.getBoundingClientRect(), panel, { placement: side, align, gap: opts.gap, margin: opts.margin })
}

/**
 * For the CSS-anchored `.ed-menu` family: measure at open-time and toggle
 * `.ed-menu-flip-up` on the wrapper when the menu would overflow the viewport
 * bottom AND flipping upward would not just overflow the top instead. Sets
 * NO z-index and NO position — it only ever toggles a class, so it cannot
 * reopen hard-won gotcha #9 (a flex item's z-index capping every descendant).
 *
 * No-op inside the phone-fold "⋯" scroll container: gotcha #10's existing
 * fix already renders a demoted menu `position: static` there (a floating
 * child can't escape a scroll container), so flipping it would do nothing
 * and the measurement is wasted.
 */
export function flipMenuIfNeeded(wrap: HTMLElement, menu: HTMLElement): void {
  if (wrap.closest('.ed-topbar.ed-bar-fold .ed-menu')) return
  wrap.classList.remove('ed-menu-flip-up')
  const menuRect = menu.getBoundingClientRect()
  if (menuRect.bottom <= window.innerHeight) return // fits below — nothing to do
  const wrapRect = wrap.getBoundingClientRect()
  const spaceAbove = wrapRect.top
  const spaceBelow = window.innerHeight - wrapRect.bottom
  if (spaceAbove > spaceBelow) wrap.classList.add('ed-menu-flip-up')
}
