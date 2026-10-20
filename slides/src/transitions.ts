// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Push / wipe / cover / split — the slide transitions Reveal has no section
// transition for, so present.ts draws them itself. This file is the pure
// half: given a kind, a direction and a progress it says where the two slides
// are. present.ts puts the result on the DOM (a snapshot "ghost" of the other
// slide inside the incoming section) and drives `p` on the engine clock.
//
// TOP is the slide that OWNS the transition (the one arrived at going
// forward), BOTTOM the slide before it. Going backward the same frames play
// in reverse (p runs 1 → 0), so a cover un-covers and a push pushes back.

import { anim } from './anim'
import { TRANSITION_DIRS, type TransitionDir, type TransitionKind } from './model'

export type DrawnTransition = 'push' | 'wipe' | 'cover' | 'split'

/** Is this a transition present.ts draws (rather than Reveal's CSS)? */
export const isDrawnTransition = (kind: TransitionKind | undefined): kind is DrawnTransition =>
  kind === 'push' || kind === 'wipe' || kind === 'cover' || kind === 'split'

/** Inline styles for one slide at one moment; '' clears the property. */
export interface TxStyle { transform: string; clipPath: string }
export interface TxFrame { top: TxStyle; bottom: TxStyle }

const NONE: TxStyle = { transform: '', clipPath: '' }
const pct = (n: number) => `${+(n * 100).toFixed(3)}%`

/** Unit vector pointing from the slide's resting place to the side it comes from. */
const fromVector = (dir: TransitionDir): [number, number] =>
  dir === 'left' ? [-1, 0] : dir === 'top' ? [0, -1] : dir === 'bottom' ? [0, 1] : [1, 0]

/**
 * The two slides at progress `p` (0 = only BOTTOM shows, 1 = only TOP).
 * Translations are percentages of the slide's own box; clip-paths are insets.
 */
export function transitionFrame(kind: DrawnTransition, dir: TransitionDir | undefined, p: number): TxFrame {
  const q = Math.min(1, Math.max(0, p))
  const d = dir && TRANSITION_DIRS[kind]?.includes(dir) ? dir : TRANSITION_DIRS[kind]![0]
  if (kind === 'split') {
    const gap = pct((1 - q) / 2)
    const clip = d === 'horizontal' ? `inset(${gap} 0 ${gap} 0)` : `inset(0 ${gap} 0 ${gap})`
    return { top: { transform: '', clipPath: q >= 1 ? '' : clip }, bottom: NONE }
  }
  const [vx, vy] = fromVector(d)
  if (kind === 'wipe') {
    // the uncovered band grows from the side the wipe comes from
    const rest = pct(1 - q)
    const inset = vx > 0 ? `inset(0 0 0 ${rest})` : vx < 0 ? `inset(0 ${rest} 0 0)`
      : vy > 0 ? `inset(${rest} 0 0 0)` : `inset(0 0 ${rest} 0)`
    return { top: { transform: '', clipPath: q >= 1 ? '' : inset }, bottom: NONE }
  }
  const away = 1 - q
  const top = q >= 1 ? NONE : { transform: `translate(${pct(vx * away)}, ${pct(vy * away)})`, clipPath: '' }
  if (kind === 'cover') return { top, bottom: NONE }
  // push: the old slide leaves by the opposite side at the same speed
  const bottom = q <= 0 ? NONE : { transform: `translate(${pct(-vx * q)}, ${pct(-vy * q)})`, clipPath: '' }
  return { top, bottom }
}

/**
 * A snapshot "ghost" of a slide surface for a drawn motion (here, and the
 * zoom camera in zoom.ts): a deep clone that answers no lookup (same rule as
 * morph ghosts — appended AFTER the real surface and stripped of the ids
 * fx/builds/links/zoom tiles query by), with live iframes/media swapped for
 * empty boxes of the same size.
 */
export function makeGhost(surface: HTMLElement): HTMLElement {
  const ghost = surface.cloneNode(true) as HTMLElement
  ghost.classList.add('beeslides-tx-ghost')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute('inert', '')
  for (const n of [ghost, ...ghost.querySelectorAll('*')]) {
    n.removeAttribute('data-el-id')
    n.removeAttribute('data-flip-id')
    n.removeAttribute('data-link')
    n.removeAttribute('data-zoom-tile')
    n.removeAttribute('tabindex')
  }
  // a cloned iframe/video reloads its source (an embed would boot a whole page
  // for 0.7 s) — an empty box of the same size reads the same at that speed
  for (const n of ghost.querySelectorAll('iframe, video, audio')) {
    const box = document.createElement('div')
    box.setAttribute('style', n.getAttribute('style') ?? '')
    box.className = n.getAttribute('class') ?? ''
    n.replaceWith(box)
  }
  return ghost
}

/** Seconds a drawn transition takes. */
export const DRAWN_TRANSITION_SECONDS = 0.7

/**
 * Play a drawn transition between two Reveal sections that Reveal itself has
 * just CUT between (both carry `data-transition="none"` — see present.ts
 * `prepTransition`). A snapshot of the other slide goes into the incoming
 * section as a ghost: under the arriving slide going forward, over it going
 * backward (the owner un-plays on top). Runs on the engine clock, so the
 * tests' manual clock drives it. Returns a cancel that snaps to the end.
 * `onDone` runs once when it ends — played out, cancelled, or not drawable.
 */
export function playDrawnTransition(
  from: HTMLElement, to: HTMLElement, kind: DrawnTransition, dir: TransitionDir | undefined, forward: boolean,
  onDone?: () => void,
): () => void {
  const surface = to.querySelector<HTMLElement>(':scope > .beeslides-slide')
  const old = from.querySelector<HTMLElement>(':scope > .beeslides-slide')
  if (!surface || !old) { onDone?.(); return () => {} }
  const ghost = makeGhost(old)
  ghost.style.zIndex = forward ? '0' : '2'
  to.classList.add('beeslides-tx-running')
  to.appendChild(ghost)
  const top = forward ? surface : ghost
  const bottom = forward ? ghost : surface
  const state = { p: forward ? 0 : 1 }
  const apply = () => {
    const f = transitionFrame(kind, dir, state.p)
    top.style.transform = f.top.transform
    top.style.clipPath = f.top.clipPath
    bottom.style.transform = f.bottom.transform
    bottom.style.clipPath = f.bottom.clipPath
  }
  let done = false
  const finish = () => {
    if (done) return
    done = true
    anim.killTweensOf(state)
    ghost.remove()
    surface.style.transform = ''
    surface.style.clipPath = ''
    to.classList.remove('beeslides-tx-running')
    onDone?.()
  }
  apply()
  anim.to(state, {
    p: forward ? 1 : 0, duration: DRAWN_TRANSITION_SECONDS, ease: 'power2.inOut', onUpdate: apply, onComplete: finish,
  })
  return finish
}
