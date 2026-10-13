// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Slide / Section / Summary Zoom — the camera. A zoom tile (render.ts
// `case 'zoom'`) draws its cover slide contained in its box; while
// presenting, a click on it moves a "camera" from the overview slide into
// that box until the box fills the screen and IS the target slide, and the
// reverse on the way back. This file is the geometry (pure) plus
// `playZoomTransition`, which puts it on two Reveal sections that Reveal has
// just cut between (present.ts `slideTo(…, zoom)`), on the engine clock.
//
// The camera is a uniform scale about ONE fixed point of the overview, the
// point that ends where it started — so the motion reads as a straight dive
// into the tile rather than a pan plus a zoom. Scale is interpolated in log
// space (s = S^p), the only parametrisation under which equal times look
// like equal "zoom speeds". Rotation of the tile is ignored by the motion
// (DECISIONS 2026-10-09). Where no dive is possible (a tile already as big as
// the slide, or one hanging off the slide) the change is a crossfade.

import { anim } from './anim'
import type { ZoomRect } from './model'
import { makeGhost } from './transitions'

export type { ZoomRect }

/** Where a tile draws its cover slide, in overview-slide px: the slide's
 *  aspect contained (centred) in the tile's box. */
export function zoomTileRect(el: { x: number; y: number; w: number; h: number }, size: { width: number; height: number }): ZoomRect {
  const s = Math.max(0, Math.min(el.w / size.width, el.h / size.height))
  const w = size.width * s
  const h = size.height * s
  return { x: el.x + (el.w - w) / 2, y: el.y + (el.h - h) / 2, w, h }
}

/** A camera: screen = (tx, ty) + s · overview point. */
export interface ZoomCam { s: number; tx: number; ty: number }

/** The full zoom factor that makes `rect` fill the slide, or 0 when the
 *  motion cannot be drawn as a dive (crossfade instead). */
export function zoomScale(rect: ZoomRect, size: { width: number; height: number }): number {
  if (!(rect.w > 0) || !(rect.h > 0)) return 0
  const S = size.width / rect.w
  const eps = 0.5
  const inside = rect.x >= -eps && rect.y >= -eps && rect.x + rect.w <= size.width + eps && rect.y + rect.h <= size.height + eps
  return S > 1.02 && inside ? S : 0
}

/**
 * The camera at progress `p` (0 = the overview as it is, 1 = `rect` filling
 * the slide), or null for the crossfade fallback. Scale grows as S^p about
 * the fixed point F = S·rect.xy / (S − 1), which lies inside the slide
 * whenever the tile does.
 */
export function zoomFrame(rect: ZoomRect, size: { width: number; height: number }, p: number): ZoomCam | null {
  const S = zoomScale(rect, size)
  if (!S) return null
  const q = Math.min(1, Math.max(0, p))
  const s = Math.pow(S, q)
  const fx = (S * rect.x) / (S - 1)
  const fy = (S * rect.y) / (S - 1)
  return { s, tx: fx * (1 - s), ty: fy * (1 - s) }
}

/** The same camera applied to the TARGET slide, which sits in `rect` at
 *  scale 1/S under it — identity at p = 1. */
export function zoomSlideFrame(rect: ZoomRect, size: { width: number; height: number }, p: number): ZoomCam | null {
  const cam = zoomFrame(rect, size, p)
  if (!cam) return null
  const S = size.width / rect.w
  return { s: cam.s / S, tx: cam.tx + cam.s * rect.x, ty: cam.ty + cam.s * rect.y }
}

/** Opacity of the target slide over its tile at progress p: it fades in over
 *  the first 30% of a dive (and out over the last 30% of the way back), so
 *  the tile's own still never pops. */
export const zoomSlideOpacity = (p: number): number => Math.min(1, Math.max(0, p / 0.3))

const matrix = (c: ZoomCam) => `matrix(${+c.s.toFixed(6)},0,0,${+c.s.toFixed(6)},${+c.tx.toFixed(3)},${+c.ty.toFixed(3)})`

/**
 * Play a zoom between two Reveal sections Reveal has just CUT between (both
 * `data-transition="none"`, see present.ts). `dir` 'in': `from` is the
 * overview, `to` the target — a snapshot of the overview goes UNDER the
 * arriving slide and the camera dives. 'out': `from` is the slide being left,
 * `to` the overview — a snapshot of the left slide shrinks back into the
 * tile on top of it. `rect` is the tile's cover rect on the overview
 * (`zoomTileRect`). Returns a cancel that snaps to the end; `onDone` runs once.
 */
export function playZoomTransition(
  from: HTMLElement, to: HTMLElement, rect: ZoomRect, size: { width: number; height: number },
  dir: 'in' | 'out', seconds: number, onDone?: () => void,
): () => void {
  const surface = to.querySelector<HTMLElement>(':scope > .slidomingo-slide')
  const old = from.querySelector<HTMLElement>(':scope > .slidomingo-slide')
  if (!surface || !old) { onDone?.(); return () => {} }
  const ghost = makeGhost(old)
  ghost.classList.add('slidomingo-zoom-ghost')
  const zin = dir === 'in'
  ghost.style.zIndex = zin ? '0' : '2'
  to.classList.add('slidomingo-tx-running')
  to.appendChild(ghost)
  const overview = zin ? ghost : surface
  const target = zin ? surface : ghost
  overview.style.transformOrigin = '0 0'
  target.style.transformOrigin = '0 0'
  const state = { p: zin ? 0 : 1 }
  const apply = () => {
    const cam = zoomFrame(rect, size, state.p)
    const tcam = zoomSlideFrame(rect, size, state.p)
    overview.style.transform = cam ? matrix(cam) : ''
    target.style.transform = tcam ? matrix(tcam) : ''
    target.style.opacity = String(cam ? zoomSlideOpacity(state.p) : state.p)
  }
  let done = false
  const finish = () => {
    if (done) return
    done = true
    anim.killTweensOf(state)
    ghost.remove()
    surface.style.transform = ''
    surface.style.transformOrigin = ''
    surface.style.opacity = ''
    to.classList.remove('slidomingo-tx-running')
    onDone?.()
  }
  apply()
  anim.to(state, {
    p: zin ? 1 : 0, duration: Math.min(6, Math.max(0.1, seconds)), ease: 'power2.inOut', onUpdate: apply, onComplete: finish,
  })
  return finish
}
