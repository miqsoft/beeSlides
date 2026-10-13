// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Present mode: a fullscreen Reveal.js overlay generated from the model.
// Slides marked transition:'morph' use GSAP Flip to animate elements whose
// ids match across the two slides (PowerPoint "Morph" behaviour).

import { dashTarget, dashTravel } from './dashmarch'
import Reveal from 'reveal.js'
import 'reveal.js/dist/reveal.css'
import { anim, resetXform } from './anim'
import { chartSnapshotSvg, mountChart } from './charts'
import type { SlidomingoDoc, GradientFill, ShapeElement, Slide, SlideElement, SvgElement } from './model'
import {
  morphKey, paginates, inLinearFlow, LOOP_DEFAULTS, LOOP_ORIGINS, extraParent, presentNext, presentPrev, presentToggleExtras,
  presentJumpTarget, presentNumberKey, transitionDir,
} from './model'
import { isDrawnTransition, playDrawnTransition } from './transitions'
import { playZoomTransition, zoomTileRect, type ZoomRect } from './zoom'
import { isZoomElement, zoomCover, zoomFirst, zoomFrameFor, zoomNext, zoomPrev, zoomStackAt, ZOOM_SECONDS } from './model'
import type { ZoomElement, ZoomFrame } from './model'
import { createPresentInk } from './presentink'
import { buildPlan, isParagraphBuilt, slideAtStep, tagParagraphs, targetKey, visibleAt } from './builds'
import type { BuildPlan, BuildTarget } from './builds'
import { applyElementFrame, fieldContext, gradientLineCoords, renderSlide, sanitizeLinkHref, svgVarDecls } from './render'
import { paintSpeaker, setSpeakerWindow, speakerIdleBody, speakerWindow } from './screens'
import { t } from './i18n'
import { lsGet, lsSet } from '../../kernel/src/storage.ts'

const MORPH_DURATION_DEFAULT = 0.65
/** Set per-deck by doc.present.morphSeconds; clamped to something sane. */
let MORPH_DURATION = MORPH_DURATION_DEFAULT
const MORPH_EASE = 'power2.inOut'

export interface PresentSession {
  exit(): void
}

export function startPresentation(
  doc: SlidomingoDoc,
  startIndex: number,
  onExit: (lastIndex: number) => void,
  // `kiosk`: run self-advancing from the start (the start card's Kiosk mode).
  // Without it the deck's own doc.present.autoAdvance/loop and per-slide
  // advanceAfter decide, and K can switch kiosk on or off mid-show.
  opts: { fullscreen?: boolean; kiosk?: { seconds: number; loop: boolean } } = {},
): PresentSession {
  MORPH_DURATION = Math.min(6, Math.max(0.1, doc.present?.morphSeconds ?? MORPH_DURATION_DEFAULT))

  const overlay = document.createElement('div')
  overlay.className = 'slidomingo-present-overlay'
  overlay.style.setProperty('--slidomingo-accent', doc.theme.accent)
  // Reveal ignores key events originating from form fields. If focus is still
  // on an editor input (title, notes…) when the show starts, arrows go dead.
  ;(document.activeElement as HTMLElement | null)?.blur?.()

  const revealEl = document.createElement('div')
  revealEl.className = 'reveal'
  const slidesEl = document.createElement('div')
  slidesEl.className = 'slides'
  revealEl.appendChild(slidesEl)
  overlay.appendChild(revealEl)

  // click builds: one plan per slide, the step cursor of the slide on screen,
  // and whether the NEXT arrival is a step back into a slide (lands fully built)
  const plans: BuildPlan[] = []
  let curStep = 0
  let arriveAtEnd = false

  // What Reveal plays for section i on its own. A drawn kind (push/wipe/cover/
  // split) reads 'fade' here: that is what shows when something moves the
  // deck without going through `slideTo` (Reveal's own Home/End/G keys) —
  // `prepTransition` switches the pair to 'none' when we draw it ourselves.
  const staticTransition = (i: number): string => {
    const slide = doc.slides[i]
    const morphNext = doc.slides[i + 1]?.transition === 'morph'
    if (slide.transition === 'morph' || morphNext) return 'none'
    return isDrawnTransition(slide.transition) ? 'fade' : slide.transition
  }

  doc.slides.forEach((slide, i) => {
    const section = document.createElement('section')
    // Morph slides swap instantly; the Flip animation supplies the motion.
    //
    // A slide that PRECEDES a morph must not fade OUT either. Reveal takes the
    // OUTGOING slide's transition on exit, and the morph's moving elements live
    // on the INCOMING slide — which is already at full opacity from the first
    // frame. So the outgoing dissolve paints a ghost of the old slide straight
    // over the animation: measured at 450ms, against a 600ms morph, which reads
    // as "the change just appeared" rather than as motion.
    // Reveal has no `none-out`: its stylesheet carries `~="slide-out"` style
    // rules for slide/zoom/convex/concave (24 of them) but none for `none`, so
    // a split value like `fade-in none-out` matches nothing and the deck-level
    // default transition wins — measured, the ghost was still there. Only the
    // exact value `none` cuts, so a slide handing off to a morph cuts in as
    // well as out. That is the deliberate trade: an instant cut into the
    // "before" frame costs less than a dissolve painted over the morph itself.
    section.dataset.transition = staticTransition(i)
    if (!inLinearFlow(slide)) section.dataset.slidomingoState = '1' // dimmed in overview
    const surface = renderSlide(slide, doc, { hidePlaceholders: true, liveMedia: true })
    markZoomTiles(doc, slide, surface)
    // click builds: the slide opens at click 0, so what only arrives later stays hidden
    const plan = buildPlan(slide)
    plans[i] = plan
    if (plan.steps.length) {
      tagBuilds(surface, plan)
      applyBuildState(surface, plan, visibleAt(slide, 0, plan))
    }
    // reveal slides start with only the default hover set visible
    if (slide.hover?.type === 'reveal') applyRevealSet(surface, slide.hover.default ?? null, slide.hover.default)
    section.appendChild(surface)
    if (slide.notes) {
      const aside = document.createElement('aside')
      aside.className = 'notes'
      aside.textContent = slide.notes
      section.appendChild(aside)
    }
    slidesEl.appendChild(section)
  })

  document.body.appendChild(overlay)

  // ——— state-aware linear navigation ———
  // Slides with stateOf are interactive states: linked-to, never walked-to.
  const isState = (i: number) => { const sl = doc.slides[i]; return !!sl && !inLinearFlow(sl) }
  // The slide a state/extra hangs off (itself for a normal slide) — the speaker rail's highlight.
  const anchorOf = (i: number) => {
    const pid = doc.slides[i]?.stateOf
    const p = doc.slides.findIndex((s) => s.id === pid)
    const a = p >= 0 ? p : i
    const ep = extraParent(doc, a)
    return ep >= 0 ? ep : a
  }
  const stepsOn = (i: number) => plans[i]?.steps.length ?? 0
  const sectionOf = (i: number) => slidesEl.children[i] as HTMLElement | undefined
  /** a "GIF" slide plays its own builds — → / ← leave it instead of stepping it */
  const isAuto = (i: number) => !!doc.slides[i]?.autoBuild
  // Click steps a user can take on this slide (none on an auto-playing one).
  const manualSteps = (i: number) => (isAuto(i) ? 0 : stepsOn(i))

  // ——— engine-clock timers (auto-playing builds, kiosk advance) ———
  // On the animation engine's clock, not setTimeout, so the manual clock the
  // tests drive (anim.setManual/tick) moves them exactly like it moves tweens.
  const wait = (seconds: number, fn: () => void): (() => void) => {
    const o = { p: 0 }
    anim.to(o, { p: 1, duration: Math.max(0.05, seconds), ease: 'none', onComplete: fn })
    return () => anim.killTweensOf(o)
  }
  let cancelAuto: (() => void) | null = null
  let cancelKiosk: (() => void) | null = null
  let kioskDeadline = 0 // wall-clock ms, for the speaker's countdown only
  // Session-scoped kiosk choice (never in the doc): `kioskSet` = seconds/loop
  // picked on the start card or by K, which win over the deck's doc-level
  // autoAdvance/loop (a slide's own advanceAfter still wins over both);
  // `kioskOff` = K switched the deck's own kiosk timing off.
  let kioskSet: { seconds: number; loop: boolean } | null = opts.kiosk ?? null
  let kioskOff = false
  const kioskSecs = (i: number): number => {
    if (kioskOff) return 0
    return doc.slides[i]?.advanceAfter ?? kioskSet?.seconds ?? doc.present?.autoAdvance ?? 0
  }
  const kioskLoops = (): boolean => (kioskSet ? kioskSet.loop : !!doc.present?.loop)
  const kioskActive = (): boolean =>
    !kioskOff && !!(kioskSet || doc.present?.autoAdvance || doc.slides.some((sl) => sl.advanceAfter))

  /** kill the slide's tweens and put every element back on its model frame, at the current click */
  const resettle = (i: number, replay: boolean, restartMedia = false) => {
    const section = sectionOf(i)
    const slide = doc.slides[i]
    if (!section || !slide) return
    clearMorphGhosts(section)
    anim.killTweensOf(section.querySelectorAll('.slidomingo-el'))
    for (const el of slide.elements) {
      const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (node) { stopLoops(node); applyElementFrame(node, el); resetXform(node) }
    }
    // build-hidden nodes come back at the current click; anything the killed
    // tweens left mid-exit or mid-entrance is put straight again
    const plan = plans[i]
    const vis = plan?.steps.length ? visibleAt(slide, curStep, plan) : undefined
    if (vis) applyBuildState(section, plan, vis)
    if (replay) {
      runEnterFx(slide, section, vis)
      runAmbientFx(slide, section, vis)
      restartSvgAnimations(section)
      if (restartMedia) startMediaIn(section)
    }
  }

  const stopAuto = () => { cancelAuto?.(); cancelAuto = null }
  /** Play this slide's builds by themselves: one every `every` s, hold, then start over (if looping). */
  const startAuto = (i: number) => {
    stopAuto()
    const ab = doc.slides[i]?.autoBuild
    if (!ab) return
    const every = Math.max(0.1, ab.every)
    const run = () => {
      if (!deckReady || exited || deck.getIndices().h !== i) return
      if (curStep < stepsOn(i)) {
        cancelAuto = wait(every, () => { curStep++; playStep(i, curStep, false); run() })
      } else if (ab.loop) {
        cancelAuto = wait(ab.hold ?? every, () => {
          curStep = 0
          resettle(i, !reduceMotion, true)
          updateSpeaker()
          run()
        })
      }
    }
    run()
  }

  const stopKiosk = () => { cancelKiosk?.(); cancelKiosk = null; kioskDeadline = 0 }
  /** (Re)start the kiosk countdown for the slide on screen. Any key or click calls this again. */
  const armKiosk = () => {
    stopKiosk()
    if (!deckReady || exited) return
    const secs = kioskSecs(deck.getIndices().h)
    if (!secs || !(secs > 0)) return
    kioskDeadline = performance.now() + secs * 1000
    cancelKiosk = wait(secs, () => {
      cancelKiosk = null
      // a click build counts as an advance; at the end of a deck that does not
      // loop there is nothing left to do, so the countdown simply stops
      if (goNext()) armKiosk()
    })
  }

  /** play click `n` on the slide on screen (tweened, or instant under reduced motion) */
  const playStep = (i: number, n: number, fromUser = true) => {
    const section = sectionOf(i)
    if (section) playBuildStep(doc.slides[i], section, plans[i], n, reduceMotion)
    updateSpeaker()
    if (fromUser) armKiosk()
  }
  /** take click `n` back, instantly — a step back is never a reverse tween */
  const undoStep = (i: number, n: number) => {
    const section = sectionOf(i)
    if (section) undoBuildStep(doc.slides[i], section, plans[i], n)
    updateSpeaker()
    armKiosk()
  }
  // ——— drawn transitions (push/wipe/cover/split, src/transitions.ts) ———
  // Every slide change of ours goes through slideTo. When the change is owned
  // by a drawn kind (the incoming slide going forward, the outgoing one going
  // back — the same rule as morph), both sections are switched to Reveal's
  // 'none' so it cuts, and slidechanged draws the motion. The override lasts
  // until the drawn motion ends (or the next slideTo, whichever is first), so
  // a move that bypasses slideTo (Reveal's Home/End/G, the overview) gets the
  // static value again instead of a stale cut.
  let txOverride: number[] = []
  let txPending: { from: number; to: number; forward: boolean } | null = null
  let cancelTx: (() => void) | null = null
  // ——— zoom (Slide / Section / Summary Zoom: model.ts ZoomFrame, src/zoom.ts) ———
  // A tile click pushes a frame and dives into its range; → / ← walk the
  // range and zoom back out past either end, restoring the overview's click.
  // slidechanged pops every frame (from the top) whose range no longer holds
  // the slide on screen — one rule for links, jumps, the grid, loop and kiosk.
  const zoomStack: ZoomFrame[] = []
  let zoomPending: { from: number; to: number } & ZoomMotion | null = null
  /** the click a zoom-out lands the overview on (consumed by slidechanged) */
  let arriveStep: number | null = null
  /** Put the overridden sections back on their static transition. Both are at
   *  rest by now (Reveal cut to them), so the swap must not animate anything:
   *  transitions are switched off on the section across the change and a
   *  style flush commits it before they come back. */
  const restoreTransitions = () => {
    for (const i of txOverride) {
      const s = sectionOf(i)
      if (!s) continue
      const value = staticTransition(i)
      if (s.dataset.transition === value) continue
      s.style.transition = 'none'
      s.dataset.transition = value
      void s.offsetWidth // flush, so the new rules apply with transitions off
      s.style.transition = ''
    }
    txOverride = []
  }
  /** `forward` is the presenter's intent: a loop wrapping to slide 1 is a step FORWARD */
  const prepTransition = (fromIdx: number, toIdx: number, forward = toIdx > fromIdx) => {
    restoreTransitions()
    txPending = null
    zoomPending = null
    if (fromIdx < 0 || fromIdx === toIdx) return
    const owner = doc.slides[forward ? toIdx : fromIdx]
    if (!isDrawnTransition(owner?.transition)) return
    for (const i of [fromIdx, toIdx]) {
      const s = sectionOf(i)
      if (s) { s.dataset.transition = 'none'; txOverride.push(i) }
    }
    txPending = { from: fromIdx, to: toIdx, forward }
  }
  const slideTo = (i: number, forward?: boolean, zoom?: ZoomMotion) => {
    if (deckReady) prepTransition(deck.getIndices().h, i, forward)
    if (deckReady && zoom) prepZoom(deck.getIndices().h, i, zoom)
    deck.slide(i, 0)
  }
  /** like prepTransition, for a zoom: both sections cut, slidechanged plays the camera */
  const prepZoom = (fromIdx: number, toIdx: number, zoom: ZoomMotion) => {
    txPending = null
    if (fromIdx < 0 || fromIdx === toIdx) return
    for (const i of [fromIdx, toIdx]) {
      const s = sectionOf(i)
      if (s) { s.dataset.transition = 'none'; txOverride.push(i) }
    }
    zoomPending = { from: fromIdx, to: toIdx, ...zoom }
  }
  // Jumping BACK into a slide lands on its finished state (the arriveAtEnd
  // flag, consumed by slidechanged); every other jump starts at click 0.
  const jumpBack = (i: number) => { arriveAtEnd = true; slideTo(i); arriveAtEnd = false }
  /** true when it did something (played a click, changed slide, or wrapped) */
  const goNext = (): boolean => {
    const cur = deck.getIndices().h
    if (curStep < manualSteps(cur)) { playStep(cur, ++curStep); return true }
    if (zoomStack.length) { zoomGoNext(cur); return true }
    const n = presentNext(doc, cur)
    // leaving the last extra moves forward to N+1 (with its transition); only an appendix run at the
    // end of the deck falls back to its parent, which then lands on the FINISHED state like any step back
    if (n >= 0) { if (n < cur) jumpBack(n); else slideTo(n); return true }
    if (kioskLoops() && railIndices.length) { slideTo(railIndices[0], true); return true } // wrap (plays slide 1's transition forward)
    return false
  }
  const goPrev = () => {
    const cur = deck.getIndices().h
    if (curStep > 0 && !isAuto(cur)) { undoStep(cur, curStep--); return }
    if (zoomStack.length) { zoomGoPrev(cur); return }
    const p = presentPrev(doc, cur)
    if (p >= 0) jumpBack(p)
  }
  // X: enter the hidden "extra" slides after this slide, or leave them forward to the next slide. Keyboard only.
  const toggleExtras = () => {
    const cur = deck.getIndices().h
    const n = presentToggleExtras(doc, cur)
    if (n < 0) return
    if (n < cur) jumpBack(n)
    else slideTo(n)
  }
  const hasNext = () => {
    const cur = deck.getIndices().h
    if (curStep < manualSteps(cur)) return true
    if (zoomStack.length) return true // at worst, back out to the overview
    if (kioskLoops()) return true
    return presentNext(doc, cur) >= 0
  }
  const hasPrev = () => {
    const cur = deck.getIndices().h
    if (curStep > 0 && !isAuto(cur)) return true
    if (zoomStack.length) return true
    return presentPrev(doc, cur) >= 0 // a state or an extra returns to its parent
  }
  const visibleIndex = (i: number) => doc.slides.slice(0, i + 1).filter((s) => paginates(s, doc)).length
  const visibleTotal = doc.slides.filter((s) => paginates(s, doc)).length
  // real slide indices that appear in linear navigation (states are excluded) —
  // the presenter-view thumbnail rail and grid iterate this.
  const railIndices = doc.slides.map((_, i) => i).filter((i) => !isState(i))
  const goFirst = () => slideTo(railIndices[0] ?? 0)
  const goLast = () => slideTo(railIndices[railIndices.length - 1] ?? 0)

  const topZoom = (): ZoomFrame | undefined => zoomStack[zoomStack.length - 1]
  const zoomMotion = (el: ZoomElement, dir: 'in' | 'out'): ZoomMotion =>
    ({ rect: zoomTileRect(el, doc.size), dir, seconds: el.duration ?? ZOOM_SECONDS })
  /** a click (or Enter) on tile `el` on the slide on screen, `overview`; false = nothing to zoom into */
  const zoomTo = (overview: number, el: ZoomElement): boolean => {
    if (!deckReady || deck.getIndices().h !== overview) return false
    const f = zoomFrameFor(doc, overview, el, curStep)
    if (!f) return false
    ;(document.activeElement as HTMLElement | null)?.blur?.() // a focused tile must not keep Enter
    if (el.returnToZoom !== false) zoomStack.push(f)
    slideTo(zoomFirst(doc, f), true, zoomMotion(el, 'in'))
    return true
  }
  /** close `f` (and anything opened inside it) and shrink back into its tile, at the overview's old click */
  const zoomOut = (f: ZoomFrame) => {
    const k = zoomStack.indexOf(f)
    if (k >= 0) zoomStack.splice(k)
    const el = doc.slides[f.overview]?.elements.find((e) => e.id === f.tile)
    arriveStep = f.step
    slideTo(f.overview, false, isZoomElement(el) ? zoomMotion(el, 'out') : undefined)
    arriveStep = null
  }
  const zoomGoNext = (cur: number) => {
    const f = topZoom()!
    const n = zoomNext(doc, f, cur)
    if (n < 0) zoomOut(f)
    else if (n < cur) jumpBack(n)
    else slideTo(n)
  }
  const zoomGoPrev = (cur: number) => {
    const f = topZoom()!
    const p = zoomPrev(doc, f, cur)
    if (p < 0) zoomOut(f)
    else jumpBack(p)
  }
  /** a tile node in the show → zoom; false when it is not on the slide on screen or plays nothing */
  const zoomFromTile = (tile: HTMLElement): boolean => {
    const idx = [...slidesEl.children].indexOf(tile.closest('section') as Element)
    const el = doc.slides[idx]?.elements.find((e) => e.id === tile.dataset.elId)
    return isZoomElement(el) && zoomTo(idx, el)
  }
  /** what → shows next while a zoom is open (the speaker's preview): the next slide of the range, or the overview */
  const zoomNextTarget = (cur: number): { idx: number; step: number; back: boolean } | null => {
    const f = topZoom()
    if (!f) return null
    const n = zoomNext(doc, f, cur)
    return n >= 0 ? { idx: n, step: 0, back: false } : { idx: f.overview, step: f.step, back: true }
  }

  // ——— black-screen (audience blackout; presenter keeps notes) ———
  let blacked = false
  const blackout = document.createElement('div')
  blackout.className = 'slidomingo-blackout'
  blackout.hidden = true
  overlay.appendChild(blackout)

  // ——— laser pointer (local presenter state; never written to the deck) ———
  // A passive viewport-level layer paints above Reveal while pointer movement
  // is observed from the overlay's capture phase. Links, hover states, charts
  // and media therefore keep receiving their normal pointer events. Blackout
  // and toasts intentionally paint above the laser visuals.
  const laserLayer = document.createElement('div')
  laserLayer.className = 'slidomingo-laser-layer'
  laserLayer.setAttribute('aria-hidden', 'true')
  // Until a real pointer event supplies screen coordinates, let the browser
  // paint the laser at the OS cursor. The DOM dot and trail take over on the
  // first move, when `laser-over-slide` hides this native cursor.
  const laserCursorStyle = document.createElement('style')
  laserCursorStyle.textContent =
    `.slidomingo-present-overlay.laser-enabled:not(.laser-over-slide) .slidomingo-slide,` +
    `.slidomingo-present-overlay.laser-enabled:not(.laser-over-slide) .slidomingo-slide *{` +
    `cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%23000' fill-opacity='.55'/%3E%3Ccircle cx='8' cy='8' r='6' fill='%23fff'/%3E%3Ccircle cx='8' cy='8' r='4' fill='%23ef252f'/%3E%3C/svg%3E") 8 8,crosshair!important}`
  const laserTrail = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  laserTrail.classList.add('slidomingo-laser-trail')
  laserTrail.setAttribute('width', '100%')
  laserTrail.setAttribute('height', '100%')
  laserTrail.setAttribute('focusable', 'false')
  const laserTrailHalo = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  const laserTrailCore = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  laserTrail.append(laserTrailHalo, laserTrailCore)
  const laserDot = document.createElement('div')
  laserDot.className = 'slidomingo-laser-dot'
  laserLayer.append(laserTrail, laserDot)

  const LASER_TRAIL_LIFETIME = 275
  const LASER_TRAIL_SAMPLE_MS = 5
  const LASER_TRAIL_SEGMENTS = Math.ceil(LASER_TRAIL_LIFETIME / LASER_TRAIL_SAMPLE_MS) + 1
  const laserTrailHaloSegments: SVGPathElement[] = []
  const laserTrailCoreSegments: SVGPathElement[] = []

  // Built on FIRST ENABLE, not at startup. startPresentation() is not only the
  // "user pressed Present" path — a doc.readonly player file boots straight
  // into the show, so this runs at document-OPEN time for every player deck
  // ever shared. Eagerly that cost 112 SVGPathElements, an injected <style>
  // and the layer, for a feature reached only by pressing L — which a player
  // deck's audience often cannot do at all.
  let laserBuilt = false
  const buildLaser = () => {
    if (laserBuilt) return
    laserBuilt = true
    overlay.insertBefore(laserCursorStyle, blackout)
    overlay.insertBefore(laserLayer, blackout)
    for (let i = 0; i < LASER_TRAIL_SEGMENTS; i++) {
      const halo = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      halo.classList.add('slidomingo-laser-trail-segment', 'halo')
      const core = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      core.classList.add('slidomingo-laser-trail-segment', 'core')
      if (i === 0) {
        halo.classList.add('tail-tip')
        core.classList.add('tail-tip')
      }
      laserTrailHalo.appendChild(halo)
      laserTrailCore.appendChild(core)
      laserTrailHaloSegments.push(halo)
      laserTrailCoreSegments.push(core)
    }
  }

  type LaserTrailPoint = { x: number; y: number; time: number }
  const laserTrailPoints: LaserTrailPoint[] = Array.from(
    { length: LASER_TRAIL_SEGMENTS + 1 },
    () => ({ x: 0, y: 0, time: 0 }),
  )
  let laserEnabled = false
  let laserFrame = 0
  let laserTrailFrame = 0
  let laserTrailStart = 0
  let laserTrailLength = 0
  let laserTrailVisibleSegments = 0
  let laserPoint: { x: number; y: number } | null = null

  const hideLaserDot = () => {
    laserDot.classList.remove('visible')
  }

  const laserTrailPointAt = (index: number) =>
    laserTrailPoints[(laserTrailStart + index) % laserTrailPoints.length]

  const clearLaserTrail = () => {
    if (laserTrailFrame) cancelAnimationFrame(laserTrailFrame)
    laserTrailFrame = 0
    laserTrailStart = 0
    laserTrailLength = 0
    for (let i = 0; i < laserTrailVisibleSegments; i++) {
      laserTrailHaloSegments[i].setAttribute('opacity', '0')
      laserTrailCoreSegments[i].setAttribute('opacity', '0')
    }
    laserTrailVisibleSegments = 0
  }

  const pruneLaserTrail = (now: number) => {
    while (laserTrailLength && now - laserTrailPointAt(0).time >= LASER_TRAIL_LIFETIME) {
      laserTrailStart = (laserTrailStart + 1) % laserTrailPoints.length
      laserTrailLength--
    }
  }

  const setTrailPath = (
    path: SVGPathElement,
    startX: number,
    startY: number,
    control: LaserTrailPoint,
    endX: number,
    endY: number,
    width: number,
    opacity: number,
  ) => {
    path.setAttribute(
      'd',
      `M ${startX.toFixed(1)} ${startY.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`,
    )
    path.setAttribute('stroke-width', width.toFixed(2))
    path.setAttribute('opacity', opacity.toFixed(3))
  }

  const setTrailTipPath = (
    path: SVGPathElement,
    startX: number,
    startY: number,
    control: LaserTrailPoint,
    endX: number,
    endY: number,
    width: number,
    opacity: number,
  ) => {
    const left: string[] = []
    const right: string[] = []
    const steps = 5
    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      const mt = 1 - t
      const x = mt * mt * startX + 2 * mt * t * control.x + t * t * endX
      const y = mt * mt * startY + 2 * mt * t * control.y + t * t * endY
      const dx = 2 * mt * (control.x - startX) + 2 * t * (endX - control.x)
      const dy = 2 * mt * (control.y - startY) + 2 * t * (endY - control.y)
      const length = Math.hypot(dx, dy) || 1
      const halfWidth = width * t / 2
      const nx = -dy / length * halfWidth
      const ny = dx / length * halfWidth
      left.push(`${(x + nx).toFixed(1)} ${(y + ny).toFixed(1)}`)
      right.unshift(`${(x - nx).toFixed(1)} ${(y - ny).toFixed(1)}`)
    }
    path.setAttribute('d', `M ${left.join(' L ')} L ${right.join(' L ')} Z`)
    path.setAttribute('opacity', opacity.toFixed(3))
  }

  const renderLaserTrail = (now: number) => {
    laserTrailFrame = 0
    pruneLaserTrail(now)
    const used = Math.max(0, laserTrailLength - 1)
    for (let i = 0; i < used; i++) {
      const from = laserTrailPointAt(i)
      const to = laserTrailPointAt(i + 1)
      const before = i ? laserTrailPointAt(i - 1) : from
      const startX = i ? (before.x + from.x) / 2 : from.x
      const startY = i ? (before.y + from.y) / 2 : from.y
      const endX = i === used - 1 ? to.x : (from.x + to.x) / 2
      const endY = i === used - 1 ? to.y : (from.y + to.y) / 2
      const age = Math.max(0, now - (from.time + to.time) / 2)
      const life = Math.max(0, 1 - age / LASER_TRAIL_LIFETIME)
      const taper = Math.pow(life, 0.7)
      const width = 0.75 + 7.25 * taper
      const opacity = 0.72 * Math.pow(life, 1.45)
      const haloWidth = width + 1.8 * taper
      if (i === 0) {
        setTrailTipPath(
          laserTrailHaloSegments[i], startX, startY, from, endX, endY,
          haloWidth, opacity * 0.48,
        )
        setTrailTipPath(
          laserTrailCoreSegments[i], startX, startY, from, endX, endY,
          width, opacity,
        )
      } else {
        setTrailPath(
          laserTrailHaloSegments[i], startX, startY, from, endX, endY,
          haloWidth, opacity * 0.48,
        )
        setTrailPath(laserTrailCoreSegments[i], startX, startY, from, endX, endY, width, opacity)
      }
    }
    for (let i = used; i < laserTrailVisibleSegments; i++) {
      laserTrailHaloSegments[i].setAttribute('opacity', '0')
      laserTrailCoreSegments[i].setAttribute('opacity', '0')
    }
    laserTrailVisibleSegments = used
    if (used) laserTrailFrame = requestAnimationFrame(renderLaserTrail)
  }

  const addLaserTrailPoint = (x: number, y: number, now: number) => {
    if (reduceMotion) return
    pruneLaserTrail(now)
    const previous = laserTrailLength ? laserTrailPointAt(laserTrailLength - 1) : null
    if (previous) {
      const dx = x - previous.x
      const dy = y - previous.y
      if (now - previous.time < LASER_TRAIL_SAMPLE_MS || dx * dx + dy * dy < 2.25) return
    }
    if (laserTrailLength === laserTrailPoints.length) {
      laserTrailStart = (laserTrailStart + 1) % laserTrailPoints.length
      laserTrailLength--
    }
    const point = laserTrailPointAt(laserTrailLength)
    point.x = x
    point.y = y
    point.time = now
    laserTrailLength++
  }

  const resetLaserPointer = () => {
    hideLaserDot()
    clearLaserTrail()
    if (laserFrame) cancelAnimationFrame(laserFrame)
    laserFrame = 0
    laserPoint = null
    overlay.classList.remove('laser-over-slide')
  }

  const paintLaser = (now: number) => {
    laserFrame = 0
    const point = laserPoint
    if (!laserEnabled || blacked || !deckReady || !point) {
      resetLaserPointer()
      return
    }
    const section = deck.getCurrentSlide() as HTMLElement | null
    const surface = section?.querySelector<HTMLElement>('.slidomingo-slide')
    if (!surface) {
      resetLaserPointer()
      return
    }
    // Measure the transformed surface itself instead of duplicating Reveal's
    // scale/letterbox maths. Pointer and dot both stay in viewport coordinates.
    const rect = surface.getBoundingClientRect()
    const inside = point.x >= rect.left && point.x <= rect.right &&
      point.y >= rect.top && point.y <= rect.bottom
    if (!inside) {
      hideLaserDot()
      clearLaserTrail()
      overlay.classList.remove('laser-over-slide')
      return
    }
    const host = overlay.getBoundingClientRect()
    const x = point.x - host.left
    const y = point.y - host.top
    laserDot.style.left = `${x}px`
    laserDot.style.top = `${y}px`
    overlay.classList.add('laser-over-slide')
    laserDot.classList.add('visible')
    addLaserTrailPoint(x, y, now)
    if (!reduceMotion && laserTrailLength > 1) {
      if (laserTrailFrame) cancelAnimationFrame(laserTrailFrame)
      renderLaserTrail(now)
    }
  }

  const scheduleLaser = (ev: PointerEvent) => {
    if (!laserEnabled || ev.pointerType === 'touch' || !ev.isPrimary) return
    laserPoint = { x: ev.clientX, y: ev.clientY }
    if (!laserFrame) laserFrame = requestAnimationFrame(paintLaser)
  }

  const setLaserEnabled = (on: boolean, feedback = true) => {
    if (laserEnabled === on) return
    if (on) { buildLaser(); if (ink.tool) ink.setTool(null) }
    laserEnabled = on
    overlay.classList.toggle('laser-enabled', on)
    if (!on) resetLaserPointer()
    if (feedback) flashPresentMsg(on ? t('Laser pointer: on') : t('Laser pointer: off'))
    updateSpeakerControls()
  }
  const toggleLaser = () => setLaserEnabled(!laserEnabled)

  overlay.addEventListener('pointermove', scheduleLaser, true)
  overlay.addEventListener('pointerleave', resetLaserPointer)
  const onWindowBlur = () => resetLaserPointer()
  window.addEventListener('blur', onWindowBlur)

  const setBlack = (on: boolean) => {
    blacked = on
    if (on) resetLaserPointer()
    blackout.hidden = !on
    updateSpeakerControls()
  }
  const toggleBlack = () => setBlack(!blacked)

  // ——— reduced motion (a VIEWER/PRESENTER preference, never in the doc) ———
  // Defaults to the OS 'prefers-reduced-motion'; an explicit toggle (M, or the
  // speaker view) overrides it and persists per browser. When on, slide
  // transitions cut instantly and every fx animation (morph, entrances,
  // count-ups, loops, ken-burns) is skipped — elements just show their final
  // state. The '.reduce-motion' class also neutralises CSS motion (svg
  // animations, Reveal's section transitions). Mirrors how locale/auto-check
  // are viewer prefs that never enter the document format.
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const readMotionPref = (): boolean | null => {
    try {
      const v = lsGet('slidomingo-reduce-motion')
      return v === 'on' ? true : v === 'off' ? false : null
    } catch { return null }
  }
  let reduceMotion = readMotionPref() ?? reduceQuery.matches
  overlay.classList.toggle('reduce-motion', reduceMotion)

  let exited = false
  const deck = new Reveal(revealEl, {
    embedded: true,
    width: doc.size.width,
    height: doc.size.height,
    margin: 0,
    // Reveal's default maxScale is 2.0 — on a 1280-wide deck that caps the show
    // at 2560px and letterboxes it in the middle of large displays (a 4K/5K/8K
    // screen shows a small centred slide). BeeSlides content is vector/text, so it
    // upscales crisply: allow it to fill any display. minScale stays generous
    // for tiny embeds.
    minScale: 0.1,
    maxScale: 100,
    /**
     * Never switch to Reveal's SCROLL VIEW, whatever the window size.
     *
     * Reveal 5 auto-swaps the classic one-slide-at-a-time renderer for a
     * vertical scrolling page below `scrollActivationWidth`, default 435px.
     * That default is meant for a deck embedded in an article, where reading
     * beats presenting. Presenting is the only thing this overlay does, and
     * EVERY phone is under the threshold — an iPhone is 390-430 CSS px — so
     * the platform slidomingo/tray exists to serve would silently get a different
     * renderer from a laptop.
     *
     * The concrete cost is navigation, not layout: measured at 402px the
     * section still scales and positions correctly. But scroll view replaces
     * slide navigation with page scrolling, which bypasses our own swipe
     * handling (Reveal's is off deliberately — it walks into hidden state
     * slides), and turns those state slides into scrollable content when they
     * are supposed to be reachable only through a link. It also renders every
     * section at once rather than one at a time, which is the opposite of what
     * a presentation overlay is for.
     */
    scrollActivationWidth: 0,
    center: false,
    hash: false,
    history: false,
    transition: 'fade',
    transitionSpeed: 'default',
    backgroundTransition: 'fade',
    controls: doc.present?.controls ?? false, // links/keys navigate; corner arrows are clutter
    progress: doc.present?.progress ?? true,
    slideNumber: (doc.present?.slideNumber ?? true)
      ? (((slideEl: HTMLElement) => {
          const i = [...slidesEl.children].indexOf(slideEl)
          return [`${visibleIndex(i)} / ${visibleTotal}`]
        }) as any)
      : false,
    // touch is handled by our own swipe logic below (state-aware + ends exit)
    touch: false,
    // Reveal uses distance < viewDistance; 2 is the minimum that keeps adjacent
    // sections mounted so fade/slide/zoom transitions can animate.
    viewDistance: 2,
    keyboardCondition: null,
    plugins: [],
  })

  const onResize = () => { resetLaserPointer(); deck.layout() }

  // ——— ink: pen / highlighter / eraser (src/presentink.ts; never saved) ———
  const ink = createPresentInk({
    overlay,
    slidesEl,
    size: doc.size,
    currentSurface: () => (deckReady
      ? (deck.getCurrentSlide() as HTMLElement | null)?.querySelector<HTMLElement>(':scope > .slidomingo-slide') ?? null
      : null),
    onTool: (tool) => { if (tool) setLaserEnabled(false, false) },
    onActivity: () => armKiosk(), // drawing holds a timed slide, like a click does
  })

  // ——— type a slide number, then Enter (PowerPoint) ———
  // The number is the one the show displays (presentJumpTarget). Digits are
  // otherwise unbound in both windows; a key that is not part of the number
  // drops what was typed.
  let jumpBuf = ''
  let jumpTimer = 0
  const resetJump = () => { jumpBuf = ''; clearTimeout(jumpTimer) }
  /** true when the key belonged to a slide number; `say('')` hides the feedback */
  const jumpKey = (ev: KeyboardEvent, say: (text: string) => void): boolean => {
    const r = presentNumberKey(jumpBuf, ev.key, ev.code)
    if (r.kind === 'pass') return false
    if (r.kind === 'hold') return false // Shift on its own (AZERTY digits): keep the number, let the key through
    clearTimeout(jumpTimer)
    if (r.kind === 'edit') {
      jumpBuf = r.buf
      say(jumpBuf ? t('Go to slide {n}', { n: jumpBuf }) : '')
      if (jumpBuf) jumpTimer = window.setTimeout(() => { resetJump(); say('') }, 4000)
      return true
    }
    resetJump()
    if (r.kind === 'go') {
      const i = presentJumpTarget(doc, r.n)
      if (i < 0) {
        say(t('There is no slide {n}', { n: r.n }))
        jumpTimer = window.setTimeout(() => say(''), 4000) // the speaker counter has no timer of its own
        return true
      }
      say('')
      if (deckReady && i !== deck.getIndices().h) slideTo(i)
      return true
    }
    say('')
    return r.consumed // Esc only drops the number; it does not end the show
  }
  const sayInOverlay = (text: string) => { if (text) flashPresentMsg(text, 4000); else hidePresentMsg() }
  /** keys typed into a field (Reveal's own G jump box) are the field's */
  const inField = (target: EventTarget | null) =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || !!(target as HTMLElement | null)?.isContentEditable

  // ——— speaker view (S) ———
  // Reveal's stock speaker window reloads the presentation URL in iframes —
  // which in a BeeSlides file boots the EDITOR. Instead: our own popup, rendered
  // with the same renderer from this one app instance and synced directly.
  let speaker: Window | null = null
  let speakerTimer = 0
  let speakerStart = 0
  // opening the speaker popup drops the main window out of OS fullscreen on most
  // browsers; this guards the fullscreenchange handler so that bounce doesn't
  // end the show (see onFsChange).
  let openingSpeaker = false
  // Reveal reports valid indices only after initialize(). The speaker view can
  // be opened (from the editor) before that, so gate any deck.getIndices() read
  // and re-populate once the deck is ready.
  let deckReady = false
  // true when we adopted a speaker window the EDITOR opened. On the web it
  // outlives this session (reset to an idle placeholder on exit, so it can be
  // dragged to a second screen first); on desktop it is closed on exit — the
  // next Present opens a new one, placed by main.
  let speakerAdopted = false
  // desktop: Present opens the speaker window itself and main places it
  const desktopSpeaker = !!window.slidomingoDesktop?.presentBegin
  // one per session: the speaker document is adopted across sessions, so its
  // listeners must die with this one (or the next show also drives this deck)
  const sessionAbort = new AbortController()
  // Second-screen placement is set up in the EDITOR (properties panel) before
  // presenting — that's where the Window Management permission is granted via a
  // dedicated gesture, and the layout is cached in ../screens. Here we just read
  // the chosen display synchronously when the notes open.
  const nextVisibleIndex = (from: number) => presentNext(doc, from)
  /** `step` given = the slide as it looks after that many clicks; omitted = every element */
  const svSlide = (idx: number, w: number, step?: number): HTMLElement => {
    const frame = document.createElement('div')
    frame.className = 'sv-frame'
    const scale = w / doc.size.width
    frame.style.width = `${w}px`
    frame.style.height = `${doc.size.height * scale}px`
    if (idx >= 0) {
      const inner = document.createElement('div')
      inner.style.cssText = `transform:scale(${scale});transform-origin:0 0`
      // inlineData: this renders into the speaker view's OWN window
      const slide = doc.slides[idx]
      const plan = plans[idx]
      const staged = step !== undefined && !!plan?.steps.length
      // fields from the ORIGINAL slide: slideAtStep returns a copy, and
      // fieldContext finds the page by identity, so a build slide's {{page}}
      // used to show the deck's last page number here
      const surface = renderSlide(staged ? slideAtStep(slide, step!) : slide, doc,
        { hidePlaceholders: true, inlineData: true, fields: fieldContext(doc, slide) })
      // Text links are pictures here, never live: the speaker window has none
      // of the main window's click routing (sanitizeLinkHref + window.open),
      // and a native follow from it would open the link in an app window
      // (desktop) or navigate the speaker view itself. The <a> stays, so the
      // link still LOOKS like one (styles.css colours `a`, not `a[href]`).
      for (const a of Array.from(surface.querySelectorAll('a[href]'))) a.removeAttribute('href')
      if (staged) {
        // whole elements are already filtered out; paragraphs are hidden in the DOM
        tagBuilds(surface, plan)
        applyBuildState(surface, plan, visibleAt(slide, step!, plan))
      }
      inner.appendChild(surface)
      frame.appendChild(inner)
    } else {
      frame.classList.add('end')
      frame.textContent = t('End of deck')
    }
    return frame
  }
  // Cheap, one-shot update of just the controls (highlight, counter, button
  // states) — called on every slidechange AND on black toggle without re-rendering
  // the (expensive) current/next slides or the thumbnail rail.
  const updateSpeakerControls = () => {
    if (!speaker || speaker.closed || !deckReady) return
    const d = speaker.document
    const cur = deck.getIndices().h
    const anchor = anchorOf(cur)
    const count = d.querySelector('.sv-count')
    if (count) {
      const clicks = manualSteps(cur)
      count.textContent = `${visibleIndex(cur)} / ${visibleTotal}` +
        (clicks ? ` · ${t('click {n}/{total}', { n: curStep, total: clicks })}` : '')
    }
    d.querySelectorAll<HTMLElement>('.sv-thumb').forEach((th) => {
      const on = Number(th.dataset.idx) === anchor
      th.classList.toggle('current', on)
      if (on && th.closest('.sv-rail')) th.scrollIntoView({ block: 'nearest', inline: 'center' })
    })
    const nav = (k: string) => d.querySelector<HTMLButtonElement>(`.sv-btn[data-nav="${k}"]`)
    nav('prev')?.toggleAttribute('disabled', !hasPrev())
    nav('first')?.toggleAttribute('disabled', !hasPrev())
    nav('next')?.toggleAttribute('disabled', !hasNext())
    nav('last')?.toggleAttribute('disabled', !hasNext())
    nav('black')?.classList.toggle('active', blacked)
    nav('laser')?.classList.toggle('active', laserEnabled)
    nav('laser')?.setAttribute('aria-pressed', String(laserEnabled))
    nav('reduce')?.classList.toggle('active', reduceMotion)
  }

  // A brief centred pill so a keypress (M) gives visible confirmation — the
  // audience overlay otherwise changes silently.
  let toastTimer = 0
  const flashPresentMsg = (text: string, ms = 1400) => {
    let el = overlay.querySelector<HTMLElement>('.slidomingo-present-toast')
    if (!el) { el = document.createElement('div'); el.className = 'slidomingo-present-toast'; overlay.appendChild(el) }
    el.textContent = text
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show') // restart the fade
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => el!.classList.remove('show'), ms)
  }
  const hidePresentMsg = () => {
    clearTimeout(toastTimer)
    overlay.querySelector('.slidomingo-present-toast')?.classList.remove('show')
  }

  const setReduceMotion = (on: boolean, persist = true) => {
    reduceMotion = on
    if (persist) lsSet('slidomingo-reduce-motion', on ? 'on' : 'off')
    overlay.classList.toggle('reduce-motion', on)
    if (on) clearLaserTrail()
    // Toast only on an explicit toggle (M / speaker button), not the silent
    // OS-preference follow or the initial state.
    if (persist) flashPresentMsg(on ? t('Reduced motion: on') : t('Reduced motion: off'))
    // Re-settle the CURRENT slide: kill any running tweens and restore final
    // frames (a killed entrance would otherwise strand an element at opacity 0);
    // if motion is back on, replay this slide's entrance + ambient fx.
    if (deckReady) resettle(deck.getIndices().h, !on)
    updateSpeakerControls()
  }
  const toggleReduceMotion = () => setReduceMotion(!reduceMotion)
  // Follow later OS changes ONLY while the user hasn't set an explicit choice.
  const onMotionQuery = (e: MediaQueryListEvent) => { if (readMotionPref() === null) setReduceMotion(e.matches, false) }
  reduceQuery.addEventListener?.('change', onMotionQuery)

  const updateSpeaker = () => {
    if (!speaker || speaker.closed) return
    if (!deckReady) return // opened pre-init — populated on ready
    const d = speaker.document
    const cur = deck.getIndices().h
    const zn = curStep < stepsOn(cur) ? null : zoomNextTarget(cur)
    const nxt = zn ? zn.idx : nextVisibleIndex(cur)
    const curBox = d.querySelector('.sv-current')
    const nxtBox = d.querySelector('.sv-nextbox')
    if (!curBox || !nxtBox) return
    curBox.innerHTML = ''
    curBox.appendChild(d.importNode(svSlide(cur, 660, curStep), true))
    // PowerPoint behaviour: while clicks remain, "Next" is the next click of
    // THIS slide; only after the last one is it the next slide
    const clicksLeft = curStep < stepsOn(cur)
    nxtBox.innerHTML = ''
    nxtBox.appendChild(d.importNode(clicksLeft ? svSlide(cur, 300, curStep + 1) : svSlide(nxt, 300, zn?.step ?? 0), true))
    const nxtLabel = d.querySelector('.sv-next-wrap .sv-label')
    if (nxtLabel) nxtLabel.textContent = clicksLeft ? t('Next click') : zn?.back ? t('Back to zoom') : t('Next')
    const notes = d.querySelector('.sv-notes')
    if (notes) notes.textContent = doc.slides[cur]?.notes || t('— no notes for this slide —')
    updateSpeakerControls()
  }
  const openSpeaker = () => {
    if (speaker && !speaker.closed) {
      speaker.focus()
      return
    }
    // guard the whole open + fullscreen-restore dance: the popup makes the
    // browser leave fullscreen, and without this that would end the show
    const wasFullscreen = document.fullscreenElement === overlay
    openingSpeaker = true
    // ADOPT a window the editor already opened (the clean two-gesture path:
    // opened in its own gesture, never fought fullscreen for this click's
    // activation, never trapped in the fullscreen Space). Only open a fresh one —
    // on THIS display — when none was pre-opened (e.g. S pressed mid-show).
    const pre = speakerWindow()
    if (pre) {
      speaker = pre
      speakerAdopted = true
    } else {
      // Literal 'about:blank', not '' — see screens.ts speakerFeatures()/
      // openSpeakerWindow for why: an empty url string is spec'd to mean
      // about:blank, but that special case is exactly the kind of thing this
      // codebase does not trust (see render.ts assetSrc's doc comment on the
      // identical class of bug for `<video src="">`). Under file://, relying
      // on it here is an unnecessary risk for zero benefit — 'about:blank'
      // is unambiguous and behaves identically whenever the spec case holds.
      speaker = window.open('about:blank', 'slidomingo-speaker', 'width=1200,height=800')
      speakerAdopted = false
    }
    if (!speaker) { openingSpeaker = false; console.warn('[slidomingo-speaker] popup blocked — allow pop-ups for this site'); return }
    setSpeakerWindow(speaker)
    ;(window as unknown as Record<string, unknown>).__slidomingoSpeaker = speaker // diagnostics
    const d = speaker.document
    d.title = `${doc.title} — ${t('Speaker view')}`
    if (!d.head.querySelector('style')) { // already styled when adopting an editor window
      for (const st of document.querySelectorAll('style')) d.head.appendChild(d.importNode(st, true))
    }
    d.body.className = 'slidomingo-speaker'
    const navBtn = (k: string, glyph: string, label: string, pressed = false) =>
      `<button class="sv-btn" data-nav="${k}" title="${label}" aria-label="${label}"${pressed ? ' aria-pressed="false"' : ''}>${glyph}</button>`
    d.body.innerHTML =
      `<div class="sv-top">` +
        `<div class="sv-timer" title="${t('Click to reset')}">00:00</div>` +
        `<div class="sv-clock"></div>` +
        `<div class="sv-kiosk" hidden title="${t('Seconds until the show advances by itself')}"></div>` +
        `<div class="sv-count"></div>` +
        `<div class="sv-ctrls">` +
          navBtn('first', '⇤', t('First slide')) +
          navBtn('prev', '‹', t('Previous')) +
          navBtn('next', '›', t('Next')) +
          navBtn('last', '⇥', t('Last slide')) +
          navBtn('black', '■', t('Black screen (B)')) +
          navBtn('laser', '🟒', t('Laser pointer (L)'), true) +
          navBtn('grid', '▦', t('All slides (G)')) +
          navBtn('reduce', '⏸', t('Reduce motion (M)')) +
        `</div>` +
      `</div>` +
      `<div class="sv-main">` +
        `<div class="sv-current"></div>` +
        `<div class="sv-side">` +
          `<div class="sv-next-wrap"><div class="sv-label">${t('Next')}</div><div class="sv-nextbox"></div></div>` +
          `<div class="sv-notes-wrap"><div class="sv-label">${t('Notes')}</div><div class="sv-notes"></div></div>` +
        `</div>` +
      `</div>` +
      `<div class="sv-rail"></div>` +
      `<div class="sv-grid" hidden><div class="sv-grid-inner"></div></div>`

    speakerStart = performance.now()
    d.querySelector('.sv-timer')?.addEventListener('click', () => { speakerStart = performance.now() })
    clearInterval(speakerTimer)
    speakerTimer = window.setInterval(() => {
      if (!speaker || speaker.closed) { clearInterval(speakerTimer); return }
      const el = speaker.document.querySelector('.sv-timer')
      if (el) {
        const s = Math.floor((performance.now() - speakerStart) / 1000)
        el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      }
      const clock = speaker.document.querySelector('.sv-clock')
      if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      // kiosk countdown: only shown while an auto-advance is pending
      const kiosk = speaker.document.querySelector<HTMLElement>('.sv-kiosk')
      if (kiosk) {
        const left = kioskDeadline ? Math.max(0, Math.ceil((kioskDeadline - performance.now()) / 1000)) : 0
        kiosk.hidden = !kioskDeadline
        if (kioskDeadline) kiosk.textContent = t('next in {n}s', { n: left })
      }
    }, 1000)

    // a clickable thumbnail: an imported slide render inside a button, badged
    // with its slide number; clicking jumps the live show there.
    const thumb = (idx: number, w: number): HTMLElement => {
      const b = d.createElement('button')
      b.className = 'sv-thumb'
      b.dataset.idx = String(idx)
      b.appendChild(d.importNode(svSlide(idx, w), true))
      const num = d.createElement('span')
      num.className = 'sv-thumb-n'
      num.textContent = String(visibleIndex(idx))
      b.appendChild(num)
      b.addEventListener('click', () => { slideTo(idx); toggleGrid(false) })
      return b
    }

    const rail = d.querySelector('.sv-rail')!
    for (const idx of railIndices) rail.appendChild(thumb(idx, 150))

    // all-slides grid overlay — built lazily on first open (cheap for small decks,
    // but a big deck shouldn't pay for it unless the presenter asks).
    const grid = d.querySelector('.sv-grid') as HTMLElement
    const gridInner = d.querySelector('.sv-grid-inner')!
    let gridBuilt = false
    const toggleGrid = (on?: boolean) => {
      const show = on ?? grid.hasAttribute('hidden')
      if (show && !gridBuilt) { for (const idx of railIndices) gridInner.appendChild(thumb(idx, 240)); gridBuilt = true }
      grid.toggleAttribute('hidden', !show)
      if (show) updateSpeakerControls()
    }
    grid.addEventListener('click', (ev) => { if (ev.target === grid) toggleGrid(false) }, { signal: sessionAbort.signal })

    const doNav = (k: string) => {
      if (k === 'first') goFirst()
      else if (k === 'prev') goPrev()
      else if (k === 'next') goNext()
      else if (k === 'last') goLast()
      else if (k === 'black') toggleBlack()
      else if (k === 'laser') toggleLaser()
      else if (k === 'grid') toggleGrid()
      else if (k === 'reduce') toggleReduceMotion()
    }
    d.querySelectorAll<HTMLButtonElement>('.sv-btn[data-nav]').forEach((b) => {
      b.addEventListener('click', () => doNav(b.dataset.nav!), { signal: sessionAbort.signal })
    })

    // drive the show FROM the speaker window (its keys fire in its own document)
    d.addEventListener('keydown', (ev: KeyboardEvent) => {
      const k = ev.key
      armKiosk()
      // a slide number + Enter; the counter shows what is being typed
      const sayInSpeaker = (text: string) => {
        const count = d.querySelector('.sv-count')
        if (text && count) count.textContent = text
        else updateSpeakerControls()
      }
      if (!ev.metaKey && !ev.ctrlKey && !ev.altKey && jumpKey(ev, sayInSpeaker)) { ev.preventDefault(); return }
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'n') { ev.preventDefault(); goNext() }
      else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'p') { ev.preventDefault(); goPrev() }
      else if (k === 'Home') { ev.preventDefault(); goFirst() }
      else if (k === 'End') { ev.preventDefault(); goLast() }
      else if (k === 'b' || k === 'B') { ev.preventDefault(); toggleBlack() }
      else if (k === 'g' || k === 'G') { ev.preventDefault(); toggleGrid() }
      else if (k === 'l' || k === 'L') { ev.preventDefault(); if (!ev.repeat) toggleLaser() }
      else if (k === 'm' || k === 'M') { ev.preventDefault(); toggleReduceMotion() }
      else if (k === 'x' || k === 'X') { ev.preventDefault(); if (!ev.repeat) toggleExtras() }
      else if (k === 'k' || k === 'K') { ev.preventDefault(); if (!ev.repeat) toggleKiosk() }
      else if (k === 's' || k === 'S') { ev.preventDefault(); if (!ev.repeat) closeSpeaker() }
      else if (k === 'Escape' && !grid.hasAttribute('hidden')) { ev.preventDefault(); toggleGrid(false) }
    }, { signal: sessionAbort.signal })

    updateSpeaker()
    if (!speakerAdopted && wasFullscreen) {
      // A fresh window on THIS display sits behind the fullscreen slides — drop
      // fullscreen so the notes are visible. (Open notes from the Slide panel and
      // drag them to a second screen to keep the slides fullscreen.)
      document.exitFullscreen?.().catch(() => {})
    }
    window.setTimeout(() => { openingSpeaker = false }, 500)
  }

  /** S: a second window with notes and the next slide on, or back to one window. */
  const closeSpeaker = () => {
    if (!speaker || speaker.closed) return
    const w = speaker
    speaker = null
    clearInterval(speakerTimer)
    w.close()
    setSpeakerWindow(null)
    flashPresentMsg(t('Speaker view off'))
  }
  const toggleSpeaker = () => {
    if (speaker && !speaker.closed) { closeSpeaker(); return }
    openSpeaker()
    if (speaker && !(speaker as Window).closed) flashPresentMsg(t('Speaker view on'))
  }
  /** K: run the deck by itself (the deck's own timing, else 10 s a slide, looping) or stop doing so. */
  const toggleKiosk = () => {
    if (kioskActive()) {
      kioskOff = true
      kioskSet = null
      stopKiosk()
      flashPresentMsg(t('Kiosk off'))
    } else {
      kioskOff = false
      kioskSet = { seconds: doc.present?.autoAdvance ?? 10, loop: doc.present?.loop ?? true }
      armKiosk()
      flashPresentMsg(kioskSet.loop
        ? t('Kiosk on · {n}s · loop', { n: kioskSet.seconds })
        : t('Kiosk on · {n}s', { n: kioskSet.seconds }))
    }
    updateSpeakerControls()
  }

  // Real fullscreen (F toggles; Present enters it by default). The overlay
  // element is what goes fullscreen, so the speaker popup stays independent.
  // Requests can be denied (iframes, no user activation) — tab-fill mode is
  // the graceful floor, and stays the mode for testing/sharing via F.
  /**
   * Keep the screen awake for the length of the show.
   *
   * This matters most on a PHONE, which is where a shared deck usually gets
   * presented from: iOS dims and locks on its own idle timer, and a presenter
   * advancing a slide every couple of minutes trips it mid-talk. Desktop
   * benefits too — fullscreen alone does not defeat a screensaver.
   *
   * Best-effort by construction: the API is absent on older iOS (<16.4) and
   * Firefox, and the request is REJECTED unless the page is visible, so this
   * must never throw into the caller. The lock is also dropped by the browser
   * whenever the tab is hidden — switching apps mid-show and coming back would
   * otherwise leave the screen sleeping again — so re-acquire on visibility.
   */
  let wakeLock: { release(): Promise<void> } | null = null
  const acquireWakeLock = async () => {
    const wl = (navigator as any).wakeLock
    if (!wl || wakeLock || document.visibilityState !== 'visible') return
    try { wakeLock = await wl.request('screen') } catch { /* denied or unsupported */ }
  }
  const releaseWakeLock = () => {
    const held = wakeLock
    wakeLock = null
    void held?.release?.().catch(() => {})
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void acquireWakeLock()
    else resetLaserPointer()
  }
  document.addEventListener('visibilitychange', onVisibility)
  void acquireWakeLock()

  const enterFullscreen = (onOk?: () => void, onDenied?: () => void) => {
    overlay.requestFullscreen?.({ navigationUI: 'hide' }).then(() => onOk?.(), () => onDenied?.())
  }
  // F swaps between fullscreen and a window WITHOUT ending the show:
  // `fsToggledOut` tells onFsChange that this exit was asked for.
  let fsToggledOut = false
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      fsToggledOut = true
      flashPresentMsg(t('In a window'))
      document.exitFullscreen().catch(() => { fsToggledOut = false })
    } else {
      enterFullscreen(() => flashPresentMsg(t('Full screen')))
    }
  }
  // leaving fullscreen — Esc, the browser's own UI, an OS gesture — ends the
  // show outright; it never drops into tab-fill mode. (Tab mode is entered
  // deliberately: the small present button, the start card, or F.)
  // The one exception is a text link (DECISIONS 2026-10-08, rich text
  // phase 2): the window it opens takes the browser out of fullscreen, and
  // that is not the presenter asking to stop — the show goes on in the tab,
  // and F puts it back in fullscreen (re-entering needs a user gesture).
  let wentFullscreen = false
  const onFsChange = () => {
    if (document.fullscreenElement === overlay) { wentFullscreen = true; linkAway = false; return }
    if (fsToggledOut) { fsToggledOut = false; return }
    if (!wentFullscreen || exited || openingSpeaker) return
    if (linkAway && linkGuardHolds()) {
      fsLostToLink = true
      noticeFsLostToLink()
      return
    }
    exit()
  }
  // A link click arms the guard; it holds while the page is away (hidden or
  // unfocused — the browser may only deliver fullscreenchange once the tab
  // is shown again) and for LINK_GRACE_MS after the page last came back or
  // opened the link. After that, a fullscreen exit means "end the show" again.
  const LINK_GRACE_MS = 1500
  let linkAway = false
  let linkBackAt = 0
  let fsLostToLink = false
  const linkGuardHolds = () =>
    document.visibilityState !== 'visible' || !document.hasFocus() || performance.now() - linkBackAt < LINK_GRACE_MS
  const noticeFsLostToLink = () => {
    if (!fsLostToLink || document.visibilityState !== 'visible' || !document.hasFocus()) return
    fsLostToLink = false
    flashPresentMsg(t('Link opened — press F to go back to full screen'), 3200)
  }
  const onShowFocus = () => {
    if (!linkAway) return
    linkBackAt = performance.now()
    noticeFsLostToLink()
  }
  window.addEventListener('focus', onShowFocus)
  document.addEventListener('visibilitychange', onShowFocus)
  const openTextLink = (href: string) => {
    linkAway = true
    linkBackAt = performance.now()
    // desktop: the app window denies window.open; main opens a clicked
    // link itself (it checks this click's user activation)
    const desktopOpen = window.slidomingoDesktop?.openExternal
    if (desktopOpen) void desktopOpen(href).catch(() => {})
    else window.open(href, '_blank', 'noopener,noreferrer')
  }
  document.addEventListener('fullscreenchange', onFsChange)
  // Presenter view opens the speaker window in the same click that starts the
  // show, and a popup uses that click's activation up — the browser may then
  // refuse fullscreen. The show still runs (in this window); say how to finish.
  if (opts.fullscreen !== false) {
    enterFullscreen(undefined, () => { if (speakerWindow()) flashPresentMsg(t('Press F for full screen'), 4200) })
  }
  // If the editor already opened notes on the second screen, go live on that
  // existing window now — no new window.open, so fullscreen above kept this
  // click's activation and the notes were never trapped in the fullscreen Space.
  if (speakerWindow()) openSpeaker()

  const exit = () => {
    if (exited) return
    exited = true
    // measurements are keyed by slide INDEX, so they'd be wrong for the next
    // show if the deck was edited in between — never carry them across
    symCache.clear()
    pauseMediaIn(slidesEl) // stop any playing clip before teardown
    // Live charts are otherwise disposed only on slidechanged, so the slide on
    // screen kept its chart: a tooltip the pointer left open (it lives on
    // document.body outside fullscreen, and mouseleave never fires on a
    // removed svg) stayed painted over the editor, with its tween running.
    Array.from(slidesEl.children).forEach((s, i) => {
      try { disposeLiveCharts(doc.slides[i], s as HTMLElement) } catch { /* teardown is best-effort */ }
    })
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    const last = deck.getIndices().h
    try {
      deck.destroy()
    } catch {
      /* Reveal teardown is best-effort */
    }
    overlay.remove()
    window.removeEventListener('resize', onResize)
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('fullscreenchange', onFsChange)
    document.removeEventListener('visibilitychange', onVisibility)
    document.removeEventListener('visibilitychange', onShowFocus)
    window.removeEventListener('focus', onShowFocus)
    releaseWakeLock()
    reduceQuery.removeEventListener?.('change', onMotionQuery)
    clearInterval(speakerTimer)
    stopAuto()
    stopKiosk()
    cancelTx?.()
    resetJump()
    ink.destroy()
    sessionAbort.abort()
    if (speaker && !speaker.closed) {
      if (speakerAdopted && !desktopSpeaker) {
        // editor-owned window — leave it open, reset to the idle placeholder so
        // it's ready for the next run instead of freezing on the last slide
        paintSpeaker(speaker, `${doc.title} — ${t('Speaker view')}`,
          speakerIdleBody(doc.title, t('Presentation ended. Start it again to bring these notes back to life.')))
      } else {
        speaker.close()
        setSpeakerWindow(null)
      }
    }
    setLaserEnabled(false, false)
    window.removeEventListener('blur', onWindowBlur)
    onExit(last)
  }

  // Capture-phase keys: Esc exits; arrows navigate unconditionally. Reveal
  // drops key events when focus sits in odd places (a leftover form field, a
  // host-embedded frame) — present mode has no fields, so arrows are always
  // navigation. Handled here exclusively (stopPropagation avoids double-steps).
  const onKeydown = (ev: KeyboardEvent) => {
    armKiosk() // any key restarts the kiosk countdown (a no-op when it is off)
    const plain = !ev.metaKey && !ev.ctrlKey && !ev.altKey && !inField(ev.target)
    if (plain && jumpKey(ev, sayInOverlay)) {
      ev.preventDefault()
      ev.stopPropagation()
      return
    }
    if (ev.key === 'Escape' && ink.tool) { // Esc puts the pen down before it ends the show
      ev.preventDefault()
      ev.stopPropagation()
      ink.setTool(null)
      return
    }
    // P / H / E pick up (or put down) pen, highlighter, eraser; C clears this
    // slide's ink. Audience window only — the speaker window keeps P = previous.
    const inkKey = plain && !ev.shiftKey ? ({ p: 'pen', h: 'highlighter', e: 'eraser' } as const)[(ev.key ?? '').toLowerCase() as 'p'] : undefined
    if (inkKey) {
      ev.preventDefault()
      ev.stopPropagation()
      if (!ev.repeat) ink.toggle(inkKey)
      return
    }
    if (plain && (ev.key === 'c' || ev.key === 'C') && (ink.tool || ink.hasInk())) {
      ev.preventDefault()
      ev.stopPropagation()
      ink.clear()
      return
    }
    if (ev.key === 'Escape') {
      if (deck.isOverview()) return // let Reveal close its overview first
      ev.preventDefault()
      ev.stopPropagation()
      exit()
      return
    }
    if (ev.key === 's' || ev.key === 'S') {
      ev.preventDefault()
      ev.stopPropagation()
      toggleSpeaker()
      return
    }
    if (plain && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault()
      ev.stopPropagation()
      if (!ev.repeat) toggleKiosk()
      return
    }
    if (ev.key === 'f' || ev.key === 'F') {
      ev.preventDefault()
      ev.stopPropagation()
      toggleFullscreen()
      return
    }
    if (ev.key === 'm' || ev.key === 'M') {
      ev.preventDefault()
      ev.stopPropagation()
      toggleReduceMotion()
      return
    }
    if (ev.key === 'l' || ev.key === 'L') {
      ev.preventDefault()
      ev.stopPropagation()
      if (!ev.repeat) toggleLaser()
      return
    }
    if (ev.key === 'x' || ev.key === 'X') {
      ev.preventDefault()
      ev.stopPropagation()
      if (!ev.repeat) toggleExtras()
      return
    }
    // a tile reached with Tab is a button: Enter (or Space) zooms
    const focusedTile = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-zoom-tile]')
    if (plain && (ev.key === 'Enter' || ev.key === ' ') && focusedTile && slidesEl.contains(focusedTile) && zoomFromTile(focusedTile)) {
      ev.preventDefault()
      ev.stopPropagation()
      return
    }
    const key = ev.key || ({ 32: ' ', 37: 'ArrowLeft', 39: 'ArrowRight', 33: 'PageUp', 34: 'PageDown' } as Record<number, string>)[ev.keyCode]
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') {
      ev.preventDefault()
      ev.stopPropagation()
      goNext()
    } else if (key === 'ArrowLeft' || key === 'PageUp') {
      ev.preventDefault()
      ev.stopPropagation()
      goPrev()
    }
  }
  document.addEventListener('keydown', onKeydown, true)

  // ——— touch: swipe left/right to navigate; swiping past either end of
  // the deck drops back into the editor (phones have no Esc) ———
  let touchX = 0
  let touchY = 0
  overlay.addEventListener('pointerdown', () => armKiosk()) // a click restarts the kiosk countdown
  overlay.addEventListener('touchstart', (ev) => {
    touchX = ev.touches[0].clientX
    touchY = ev.touches[0].clientY
  }, { passive: true })
  overlay.addEventListener('touchend', (ev) => {
    const t0 = ev.changedTouches[0]
    if (!t0 || ink.tool) return // a finger drawing is not a swipe
    const dx = t0.clientX - touchX
    const dy = t0.clientY - touchY
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return // a tap or a scroll
    if (dx < 0) {
      if (hasNext()) goNext()
      else exit()
    } else {
      if (hasPrev()) goPrev()
      else exit()
    }
  }, { passive: true })

  deck.on('slidechanged', ((event: any) => {
    const from = event.previousSlide as HTMLElement | undefined
    const to = event.currentSlide as HTMLElement
    if (!to) return
    const fromIdx = from ? [...slidesEl.children].indexOf(from) : -1
    const toIdx = [...slidesEl.children].indexOf(to)
    // the outgoing slide's auto-play and the kiosk countdown end with it
    stopAuto()
    stopKiosk()
    cancelTx?.() // a drawn transition still running lands at its end
    cancelTx = null
    const drawn = !!from && txPending?.from === fromIdx && txPending.to === toIdx
    const drawnForward = drawn ? txPending!.forward : toIdx > fromIdx
    txPending = null
    const zp = from && zoomPending?.from === fromIdx && zoomPending.to === toIdx ? zoomPending : null
    zoomPending = null
    // leaving a zoom's range by any route closes it — frames nest, so from the top
    zoomStack.length = zoomStackAt(doc, zoomStack, toIdx).length
    if (from) {
      // Kill the outgoing slide's tweens, then restore model frames —
      // a tween killed during its delay would otherwise leave the element
      // stuck at its "from" state (invisible) for every future visit.
      clearMorphGhosts(from)
      anim.killTweensOf(from.querySelectorAll('.slidomingo-el'))
      sweepSymbolSpans(from)
      const fromSlide = doc.slides[fromIdx]
      for (const el of fromSlide?.elements ?? []) {
        const node = from.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
        if (node) {
          stopLoops(node)
          applyElementFrame(node, el) // resets style.transform…
          resetXform(node) // …so the engine must forget its composed state
        }
      }
      if (fromSlide?.hover?.type === 'reveal') {
        applyRevealSet(from, null, fromSlide.hover.default)
      }
    }
    // The incoming section may still carry span state from a PREVIOUS visit
    // (Reveal keeps sections mounted) — start clean before any fx runs.
    sweepSymbolSpans(to)
    // Click builds. The OUTGOING section keeps whatever state it ended in until
    // it is visited again — resetting it now would blink its elements out
    // while Reveal is still fading it away. The INCOMING one is put at click 0
    // (or, stepping back into it, at its last click) BEFORE any fx or morph
    // pairing looks at it. `fromStep` is where the outgoing slide stood.
    const fromStep = curStep
    const landAtEnd = arriveAtEnd && !doc.slides[toIdx]?.autoBuild // an auto-playing slide always starts over
    arriveAtEnd = false
    const toSlide = doc.slides[toIdx]
    const toPlan = plans[toIdx]
    curStep = landAtEnd ? stepsOn(toIdx) : 0
    if (arriveStep !== null) curStep = Math.min(arriveStep, stepsOn(toIdx)) // back from a zoom: the click it left at
    const toVis = toPlan?.steps.length ? visibleAt(toSlide, curStep, toPlan) : undefined
    if (toVis) applyBuildState(to, toPlan, toVis)
    const forward = toIdx > fromIdx
    // after the outgoing frames are restored, so the snapshot shows the slide at rest
    if (drawn) {
      const owner = doc.slides[drawnForward ? toIdx : fromIdx]
      // the static values come back once the motion is over — unless a newer
      // slideTo has taken the override over by then (it restored these itself)
      const override = txOverride
      const done = () => { if (txOverride === override) restoreTransitions() }
      if (!reduceMotion && isDrawnTransition(owner.transition)) {
        cancelTx = playDrawnTransition(from!, to, owner.transition, transitionDir(owner), drawnForward, done)
      } else done() // nothing drawn: Reveal's cut was the whole change
    }
    // a zoom plays its camera INSTEAD of morph or a drawn transition
    if (zp) {
      const override = txOverride
      const done = () => { if (txOverride === override) restoreTransitions() }
      if (!reduceMotion) cancelTx = playZoomTransition(from!, to, zp.rect, doc.size, zp.dir, zp.seconds, done)
      else done() // reduced motion: the cut was the whole change
    }
    // Morph forward into a morph slide, and un-morph when backing out of one.
    const morphing =
      !zp && from &&
      ((forward && doc.slides[toIdx]?.transition === 'morph') ||
        (!forward && doc.slides[fromIdx]?.transition === 'morph'))
    if (morphing) {
      if (!reduceMotion) {
        // only what is on screen pairs: elements not yet clicked in, or already
        // clicked out, take no part on either side
        const fromView = slideAtStep(doc.slides[fromIdx], fromStep)
        const toView = slideAtStep(toSlide, curStep)
        runMorph(doc, from!, to, fromIdx, toIdx, fromView, toView)
        runMorphArrivalCountUps(fromView, toView, to)
      }
    }
    else if (!reduceMotion && zp?.dir !== 'out') runEnterFx(toSlide, to, toVis) // back on an overview: no re-entrance
    if (!reduceMotion) {
      runAmbientFx(toSlide, to, toVis)
      restartSvgAnimations(to)
    }
    wireHoverFocus(doc.slides[toIdx], to)
    if (from) disposeLiveCharts(doc.slides[fromIdx], from)
    mountLiveCharts(doc.slides[toIdx], to, morphing ? doc.slides[fromIdx] : undefined)
    if (from) pauseMediaIn(from)
    startMediaIn(to)
    // Capture where this slide's formula symbols sit WHILE it is on screen —
    // once it becomes the outgoing slide there is no layout left to measure.
    // Synchronously, not in rAF: a backgrounded tab never runs animation
    // frames, and a slide whose symbols were never captured simply doesn't
    // symbol-morph on the way out. symbolOffsets normalises by the element's
    // own box, so measuring mid-morph is safe.
    cacheSlideSymbols(doc, to, toIdx)
    ink.slideChanged()
    updateSpeaker()
    startAuto(toIdx)
    armKiosk()
  }) as any)

  // Clicking an element with a link jumps to its target slide.
  slidesEl.addEventListener('click', (ev) => {
    // A text link (rich text) wins over its element's slide link: it opens
    // in a new window and the show stays where it is — also when that
    // window takes the browser out of fullscreen (openTextLink). The href is
    // judged AGAIN here rather than trusted because the sanitizer wrote it —
    // this is the one place a click turns into navigation.
    const anchor = (ev.target as Element).closest?.('a[href]')
    if (anchor && slidesEl.contains(anchor)) {
      ev.preventDefault()
      ev.stopPropagation()
      const href = sanitizeLinkHref(anchor.getAttribute('href'))
      if (href) openTextLink(href)
      return
    }
    // a zoom tile wins over an element link, and a click never advances builds
    const tile = (ev.target as HTMLElement).closest<HTMLElement>('[data-zoom-tile]')
    if (tile && slidesEl.contains(tile) && zoomFromTile(tile)) {
      ev.preventDefault()
      ev.stopPropagation()
      return
    }
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-link]')
    if (!target) return
    const idx = doc.slides.findIndex((s) => s.id === target.dataset.link)
    if (idx >= 0) {
      ev.preventDefault()
      ev.stopPropagation()
      slideTo(idx)
    }
  })

  deck.initialize().then(() => {
    deckReady = true
    // Reduced motion is silent otherwise: say once why nothing animates.
    if (reduceMotion) flashPresentMsg(t('Animations off (reduced motion) — press M'))
    if (startIndex > 0) deck.slide(startIndex, 0)
    // if the speaker view was opened before init (macOS reorder), fill it now
    updateSpeaker()
    // late layout: fonts/images that finish loading after init can change
    // the measured size, and the boot viewport may still be settling
    window.addEventListener('resize', onResize)
    setTimeout(onResize, 120)
    setTimeout(onResize, 600)
    const first = slidesEl.children[startIndex] as HTMLElement | undefined
    if (first) {
      if (!reduceMotion) {
        const plan = plans[startIndex]
        const vis = plan?.steps.length ? visibleAt(doc.slides[startIndex], curStep, plan) : undefined
        runEnterFx(doc.slides[startIndex], first, vis)
        runAmbientFx(doc.slides[startIndex], first, vis)
        restartSvgAnimations(first)
      }
      wireHoverFocus(doc.slides[startIndex], first)
      // the opening slide never gets a slidechanged, so capture its symbols
      // here or the very first morph would have no from-side to travel from
      cacheSlideSymbols(doc, first, startIndex)
      mountLiveCharts(doc.slides[startIndex], first)
      startMediaIn(first)
      startAuto(startIndex)
      armKiosk()
    }
  })

  return { exit }
}

// --- zoom tiles -----------------------------------------------------------------

/** How a slide change zooms: the tile's cover rect, which way, how long. */
interface ZoomMotion { rect: ZoomRect; dir: 'in' | 'out'; seconds: number }

/** In the show a zoom tile is a button: focusable, named after what it opens. */
function markZoomTiles(doc: SlidomingoDoc, slide: Slide, surface: HTMLElement) {
  for (const node of surface.querySelectorAll<HTMLElement>(':scope > [data-zoom-tile]')) {
    const el = slide.elements.find((e) => e.id === node.dataset.elId)
    if (!isZoomElement(el)) continue
    const cover = zoomCover(doc, el)
    if (!cover) continue
    const title = cover.elements.find((e) => e.type === 'text' && e.role === 'title')
    // parsed in an inert document: author html must never reach a live element here
    const text = title?.type === 'text' ? new DOMParser().parseFromString(title.html, 'text/html').body.textContent?.trim() : ''
    const name = cover.name || text || String(doc.slides.indexOf(cover) + 1)
    node.setAttribute('role', 'button')
    node.tabIndex = 0
    node.setAttribute('aria-label', t('Zoom into {name}', { name }))
  }
}

// --- media playback -----------------------------------------------------------

// Autoplay is intentionally NOT set at render time (it would fire on the editor
// canvas and in every thumbnail). Present mode starts flagged media on entry
// and pauses everything on exit so a paused clip doesn't keep playing off-slide.
function startMediaIn(section: HTMLElement) {
  section.querySelectorAll<HTMLMediaElement>('video[data-autoplay="1"], audio[data-autoplay="1"]').forEach((m) => {
    // a clip still waiting for its click starts when it arrives, not before
    if (m.closest(`.${BUILD_HIDDEN}`)) return
    try { m.currentTime = 0 } catch { /* not seekable yet */ }
    void m.play().catch(() => { /* blocked (e.g. un-muted video) — leave paused */ })
  })
}

function pauseMediaIn(section: HTMLElement) {
  section.querySelectorAll<HTMLMediaElement>('video, audio').forEach((m) => { m.pause() })
}

// --- live charts --------------------------------------------------------------

// Present mode swaps chart snapshots for live ECharts instances (tooltips,
// dataZoom). Leaving the slide disposes the instance and restores the
// snapshot so the section stays presentable in Reveal's viewDistance cache.
const chartHandles = new WeakMap<HTMLElement, Array<() => void>>()

function mountLiveCharts(slide: Slide, section: HTMLElement, fromSlide?: Slide) {
  const handles: Array<() => void> = []
  for (const el of slide?.elements ?? []) {
    if (el.type !== 'chart') continue
    const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (!node) continue
    // a matching chart on the other side of a morph: animate its data over
    const fromEl = fromSlide?.elements.find((e) => e.id === el.id && e.type === 'chart')
    const dispose = mountChart(el, node, fromEl && fromEl.type === 'chart' ? fromEl.option : undefined)
    handles.push(() => {
      dispose()
      node.innerHTML = chartSnapshotSvg(el)
      const csvg = node.querySelector('svg')
      if (csvg) {
        csvg.setAttribute('preserveAspectRatio', 'none')
        ;(csvg as SVGElement).style.cssText = 'width:100%;height:100%;display:block'
      }
    })
  }
  if (handles.length) chartHandles.set(section, handles)
}

function disposeLiveCharts(_slide: Slide, section: HTMLElement) {
  for (const h of chartHandles.get(section) ?? []) h()
  chartHandles.delete(section)
}

// --- click builds ------------------------------------------------------------
//
// builds.ts decides WHAT is on screen at click N (pure, model-only); this half
// puts it on the DOM. A node that has not arrived yet carries BUILD_HIDDEN
// (visibility, so layout never shifts); a click removes it and tweens it in
// with the same enterSpec every other entrance uses.

const BUILD_HIDDEN = 'slidomingo-build-hidden'

/**
 * Per-node generation counter. A step that is undone (or re-applied) while an
 * exit tween is still running must not have that tween's completion hide the
 * node it just brought back — completions check the generation they started in.
 */
const buildGen = new WeakMap<Element, number>()
const bumpGen = (n: Element) => { const g = (buildGen.get(n) ?? 0) + 1; buildGen.set(n, g); return g }

/** Mark the paragraphs of every paragraph-built text element in `root`. Idempotent. */
export function tagBuilds(root: HTMLElement, plan: BuildPlan) {
  for (const elId of plan.paragraphs.keys()) {
    const inner = root.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(elId)}"] .slidomingo-text-inner`)
    if (inner && !inner.querySelector('[data-para]')) tagParagraphs(inner)
  }
}

function targetNode(root: HTMLElement, t: BuildTarget): HTMLElement | null {
  const el = `[data-el-id="${CSS.escape(t.elId)}"]`
  return root.querySelector<HTMLElement>(t.para === undefined ? el : `${el} [data-para="${t.para}"]`)
}

function planTargets(plan: BuildPlan): BuildTarget[] {
  const seen = new Set<string>()
  const out: BuildTarget[] = []
  for (const s of plan.steps) {
    for (const t of [...s.enter, ...s.exit]) if (!seen.has(targetKey(t))) { seen.add(targetKey(t)); out.push(t) }
  }
  return out
}

/** Put every build target of `plan` at the state `vis` names — instantly, no tweens. */
export function applyBuildState(root: HTMLElement, plan: BuildPlan, vis: Set<string>) {
  for (const t of planTargets(plan)) {
    const node = targetNode(root, t)
    if (!node) continue
    bumpGen(node)
    if (t.para !== undefined) {
      // paragraphs are not `.slidomingo-el`s, so nothing else clears a tween
      // an interrupted visit left on them
      anim.killTweensOf(node)
      node.style.opacity = ''
      node.style.transform = ''
      resetXform(node)
    }
    node.classList.toggle(BUILD_HIDDEN, !vis.has(targetKey(t)))
  }
}

/** Back to the model's own frame: an element via applyElementFrame, a paragraph by clearing what a tween wrote. */
function settleBuildNode(node: HTMLElement, el: SlideElement | undefined, t: BuildTarget) {
  stopLoops(node)
  if (t.para !== undefined || !el) { node.style.opacity = ''; node.style.transform = '' }
  else applyElementFrame(node, el)
  resetXform(node)
}

/** The exit mirror of enterSpec: the same table, reversed (slide-left leaves to the LEFT, easing in). */
function exitSpec(kind: EnterKind, exitDur?: number) {
  const s = enterSpec(kind, undefined)
  const sliding = kind.startsWith('slide-')
  return {
    to: { opacity: 0, x: s.from.x ? -s.from.x : 0, y: s.from.y ? -s.from.y : 0 },
    duration: exitDur ?? (sliding ? 0.5 : 0.35),
    ease: sliding ? 'power3.in' : 'power2.in',
  }
}

interface ResolvedTarget { t: BuildTarget; el: SlideElement; node: HTMLElement }
function resolveTargets(slide: Slide, root: HTMLElement, targets: BuildTarget[]): ResolvedTarget[] {
  const out: ResolvedTarget[] = []
  for (const t of targets) {
    const el = slide.elements.find((e) => e.id === t.elId)
    const node = el && targetNode(root, t)
    if (el && node) out.push({ t, el, node })
  }
  return out
}

/**
 * Play click `n` (1-based): bring the step's entering targets in (tweened with
 * the element's own entrance, default a fade) and take its exiting ones out.
 * `instant` (reduced motion) still gates content — a click still reveals — it
 * just doesn't tween. Loops and media on what arrives start now.
 */
export function playBuildStep(slide: Slide, root: HTMLElement, plan: BuildPlan, n: number, instant: boolean) {
  const step = plan.steps[n - 1]
  if (!step) return
  const exiting = resolveTargets(slide, root, step.exit)
  const entering = resolveTargets(slide, root, step.enter)

  for (const { t, el, node } of exiting) {
    const gen = bumpGen(node)
    stopLoops(node) // ends any loop on it
    const finish = () => {
      if (buildGen.get(node) !== gen) return // taken back (or re-applied) meanwhile
      node.classList.add(BUILD_HIDDEN)
      settleBuildNode(node, el, t)
      node.querySelectorAll<HTMLMediaElement>('video, audio').forEach((m) => m.pause())
    }
    if (instant) { finish(); continue }
    const spec = exitSpec(el.fx?.exit ?? 'fade', el.fx?.exitDur)
    anim.to(node, { ...spec.to, duration: spec.duration, ease: spec.ease, onComplete: finish })
    // wall-clock net for starved render loops (throttled tabs): never stay half-gone
    setTimeout(finish, spec.duration * 1000 + 2800)
  }

  // within one click `order` only staggers; equal values enter together
  const orders = entering.map(({ el }) => el.fx?.order).filter((o): o is number => typeof o === 'number')
  const base = orders.length ? Math.min(...orders) : 0
  for (const { t, el, node } of entering) {
    bumpGen(node)
    node.classList.remove(BUILD_HIDDEN)
    if (instant) { settleBuildNode(node, el, t); continue }
    const fx = el.fx!
    const final = t.para === undefined ? (el.opacity ?? 1) : 1
    if (fx.loop?.type === 'motion-path') {
      // the loop owns the transform — an entrance may only touch opacity
      anim.fromTo(node, { opacity: 0 }, { opacity: final, duration: 0.4, ease: 'power2.out' })
    } else {
      const spec = enterSpec(fx.enter ?? 'fade', fx.enterDur)
      anim.fromTo(node, spec.from, {
        opacity: final, x: 0, y: 0,
        duration: spec.duration,
        delay: Math.min(Math.max((fx.order ?? base) - base, 0), 24) * 0.05,
        ease: spec.ease,
      })
    }
    if (fx.countUp && t.para === undefined) runCountUp(node)
  }
  if (!instant && entering.length) {
    setTimeout(() => {
      for (const { t, el, node } of entering) {
        if (!node.isConnected || node.classList.contains(BUILD_HIDDEN)) continue
        if (anim.getTweensOf(node).some((tw) => !tw.infinite && tw.progress() < 1)) settleBuildNode(node, el, t)
      }
    }, 2800)
  }
  for (const { node } of entering) startMediaIn(node)
  // what just arrived gets its loops / ken-burns now (what is on screen already keeps running)
  const arrived = new Set(entering.filter(({ t }) => t.para === undefined).map(({ el }) => el.id))
  if (!instant && arrived.size) runAmbientFx(slide, root, arrived)
}

/**
 * Take click `n` back: what it brought in is hidden again, what it took out
 * returns (and its loops restart). Instant — never a reverse tween.
 */
export function undoBuildStep(slide: Slide, root: HTMLElement, plan: BuildPlan, n: number) {
  const step = plan.steps[n - 1]
  if (!step) return
  for (const { t, el, node } of resolveTargets(slide, root, step.enter)) {
    bumpGen(node)
    settleBuildNode(node, el, t)
    node.classList.add(BUILD_HIDDEN)
    node.querySelectorAll<HTMLMediaElement>('video, audio').forEach((m) => m.pause())
  }
  const back = resolveTargets(slide, root, step.exit)
  for (const { t, el, node } of back) {
    bumpGen(node)
    settleBuildNode(node, el, t)
    node.classList.remove(BUILD_HIDDEN)
  }
  const returning = new Set(back.map(({ el }) => el.id))
  if (returning.size) runAmbientFx(slide, root, returning)
}

// --- element fx -------------------------------------------------------------

function fxNodes(slide: Slide, section: HTMLElement): Array<[SlideElement, HTMLElement]> {
  const pairs: Array<[SlideElement, HTMLElement]> = []
  for (const el of slide?.elements ?? []) {
    if (!el.fx) continue
    const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (node) pairs.push([el, node])
  }
  return pairs
}

type EnterKind = NonNullable<NonNullable<SlideElement['fx']>['enter']>

/**
 * The starting frame, duration and ease an `fx.enter` kind implies.
 *
 * Shared by the two places an element can enter — the plain entrance runner and
 * the morph path, which gives elements with no morph partner an entrance of
 * their own. Keeping ONE table means a new direction cannot work on ordinary
 * slides and quietly do nothing on morph arrivals.
 *
 * fade-* nudge 16px; slide-* sweep 120px in from an edge (slide-left starts to
 * the RIGHT and travels leftward). x needs the x transform channel in anim.ts.
 */
function enterSpec(kind: EnterKind, enterDur?: number) {
  const D = 120
  const from = { opacity: 0, x: 0, y: 0 }
  if (kind === 'fade-up') from.y = 16
  else if (kind === 'fade-down') from.y = -16
  else if (kind === 'slide-left') from.x = D
  else if (kind === 'slide-right') from.x = -D
  else if (kind === 'slide-up') from.y = D
  else if (kind === 'slide-down') from.y = -D
  const sliding = kind.startsWith('slide-')
  return {
    from,
    duration: enterDur ?? (sliding ? 0.75 : 0.55),
    ease: sliding ? 'power3.out' : 'power2.out',
  }
}

/**
 * Editor "Preview animation": plays the entrance + ambient/loop fx of `slide`
 * on `root` (the editor canvas host) exactly as present mode would on entry.
 * Returns the animated nodes so the caller can kill them and repaint.
 */
export function previewSlideFx(slide: Slide, root: HTMLElement): HTMLElement[] {
  runEnterFx(slide, root)
  runAmbientFx(slide, root)
  restartSvgAnimations(root)
  return fxNodes(slide, root).map(([, node]) => node)
}

/**
 * Editor click-by-click preview of `slide` on `root` (the editor canvas host):
 * the slide opens at click 0 exactly as present mode would show it, then
 * `next()` plays the following click through the SAME playBuildStep present
 * mode uses, `prev()` takes one back. `stop()` kills every tween it started;
 * the caller repaints the canvas from the model, so nothing is left hidden.
 */
export interface BuildPreview {
  /** clicks played so far */
  readonly step: number
  readonly total: number
  next(): boolean
  prev(): boolean
  stop(): void
}

export function previewBuilds(slide: Slide, root: HTMLElement, onChange?: (step: number, total: number) => void): BuildPreview {
  const plan = buildPlan(slide)
  const vis0 = visibleAt(slide, 0, plan)
  tagBuilds(root, plan)
  applyBuildState(root, plan, vis0)
  runEnterFx(slide, root, vis0)
  runAmbientFx(slide, root, vis0)
  restartSvgAnimations(root)
  let step = 0
  const total = plan.steps.length
  const api: BuildPreview = {
    get step() { return step },
    total,
    next() {
      if (step >= total) return false
      playBuildStep(slide, root, plan, ++step, false)
      onChange?.(step, total)
      return true
    },
    prev() {
      if (step <= 0) return false
      undoBuildStep(slide, root, plan, step--)
      onChange?.(step, total)
      return true
    },
    stop() {
      anim.killTweensOf(root.querySelectorAll('.slidomingo-el, [data-para]'))
    },
  }
  return api
}

/**
 * Staggered entrance animations + count-ups for the incoming slide.
 * `vis` (click builds) = what is on screen at this click; elements outside it
 * wait for their step, and paragraph-built text enters paragraph by paragraph.
 */
function runEnterFx(slide: Slide, section: HTMLElement, vis?: Set<string>) {
  const entering = fxNodes(slide, section)
    // reveal-set members are shown/hidden by hover, never by entrance tweens
    .filter(([el]) => (el.fx!.enter || el.fx!.countUp) && !el.showOnHover)
    .filter(([el]) => !vis || (vis.has(el.id) && !isParagraphBuilt(el)))
    .sort((a, b) => (a[0].fx!.order ?? 0) - (b[0].fx!.order ?? 0))
  // Delay derives from fx.order when set (equal order ⇒ elements enter
  // together — how a diagram reveals band-by-band), else from list position.
  entering.forEach(([el, node], i) => {
    const fx = el.fx!
    const step = fx.order ?? i
    // motion-path loops own the transform — an entrance tween on the same
    // node would fight it and freeze the dot off its path
    if (fx.loop?.type === 'motion-path') return
    if (fx.enter) {
      const spec = enterSpec(fx.enter, fx.enterDur)
      anim.fromTo(
        node,
        spec.from,
        {
          opacity: el.opacity ?? 1,
          x: 0,
          y: 0,
          duration: spec.duration,
          delay: 0.12 + Math.min(step, 24) * 0.05,
          ease: spec.ease,
        },
      )
    }
    if (fx.countUp) runCountUp(node)
  })
  settleGuarantee(entering.map(([el, node]) => [node, el]))
}

/**
 * Count-ups on a MORPH arrival, for elements the morph did not carry over.
 *
 * Morph and entrance are mutually exclusive branches — an entrance tween on a
 * morphing element would fight the morph — and `runCountUp` lived only on the
 * entrance side, so `fx.countUp` on a slide reached by `transition:'morph'`
 * silently rendered a static number. That is a combination the authoring guide
 * actively recommends (a headline statistic on a slide that morphs its
 * furniture in), so it failed quietly and often.
 *
 * A count-up element WITH a morph partner is already on screen showing its
 * number as it flies in; restarting it from zero would be wrong. One with no
 * partner is new on this slide, has no transform to fight, and is exactly what
 * the author asked to count.
 */
function runMorphArrivalCountUps(from: Slide | undefined, to: Slide, section: HTMLElement) {
  const carried = new Set((from?.elements ?? []).map((el) => el.morphId || el.id))
  for (const [el, node] of fxNodes(to, section)) {
    if (!el.fx!.countUp || el.showOnHover) continue
    if (!carried.has(el.morphId || el.id)) runCountUp(node)
  }
}

/**
 * Wall-clock safety net: on starved render loops (throttled tabs, weak
 * machines) tween progress crawls — guarantee every animated element lands
 * on its final model state instead of lingering half-invisible.
 */
function settleGuarantee(pairs: Array<[HTMLElement, SlideElement]>) {
  // Ambient/looping elements run infinite tweens by design — their progress
  // never reaches 1, and "settling" them would kill the loop and freeze the
  // element (a real bug once: orbit dots died 2.8s after every morph entry).
  pairs = pairs.filter(([, el]) => !el.fx?.loop && el.fx?.ambient !== 'kenburns')
  if (!pairs.length) return
  setTimeout(() => {
    for (const [node, el] of pairs) {
      if (!node.isConnected) continue
      const tweens = anim.getTweensOf(node)
      if (tweens.some((t) => t.progress() < 1)) {
        anim.killTweensOf(node)
        applyElementFrame(node, el)
        resetXform(node)
      }
    }
  }, 2800)
}

/** Animate every number in the element's text from 0 to its final value. */
/**
 * How a number was WRITTEN, so the count-up can put it back the same way.
 *
 * The number must settle exactly as the author typed it. Routing through
 * `Intl.NumberFormat(navigator.language)` is the tempting fix and the wrong
 * one: slide content is authored, so the same deck would read `1,234.5` for
 * one viewer and `1.234,5` for another. Locale follows the viewer for CHROME
 * only (`PLATFORM.md` §3).
 */
interface NumberShape {
  value: number
  decimals: number
  group: string   // separator between thousands, '' if the author used none
  point: string   // decimal separator, '' if the number is an integer
}

/**
 * Read an authored number. Separators are genuinely ambiguous, so the rules
 * are stated rather than guessed:
 *
 * - BOTH `.` and `,` present → the LAST one is the decimal point, the other
 *   groups. `1,234.5` → 1234.5, `1.234,5` → 1234.5.
 * - Only `,` → grouping if there are several (`1,234,567`), or if a single one
 *   is followed by exactly three digits (`1,234`). Otherwise a decimal comma
 *   (`1,23`, `1,2345`).
 * - Only `.` → a decimal point, always. A deck writing `1.234` means
 *   one-point-two-three-four; reading it as grouping would break every
 *   three-decimal number to fix a rarer case.
 */
function readNumber(raw: string): NumberShape {
  const dots = (raw.match(/\./g) ?? []).length
  const commas = (raw.match(/,/g) ?? []).length
  let point = ''
  if (dots && commas) point = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ','
  else if (commas) point = commas > 1 || /,\d{3}$/.test(raw) ? '' : ','
  else if (dots) point = '.'
  const group = point === '.' ? (commas ? ',' : '')
    : point === ',' ? (dots ? '.' : '')
      : (commas ? ',' : dots ? '.' : '')
  const cut = point ? raw.lastIndexOf(point) : -1
  const whole = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/[.,]/g, '')
  const frac = cut >= 0 ? raw.slice(cut + 1) : ''
  return { value: Number(frac ? `${whole}.${frac}` : whole), decimals: frac.length, group, point }
}

/** Put a number back in the author's own convention. */
function writeNumber(value: number, shape: NumberShape): string {
  const fixed = value.toFixed(shape.decimals)
  const dot = fixed.indexOf('.')
  let whole = dot >= 0 ? fixed.slice(0, dot) : fixed
  const frac = dot >= 0 ? fixed.slice(dot + 1) : ''
  if (shape.group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, shape.group)
  return frac ? whole + shape.point + frac : whole
}

function runCountUp(node: HTMLElement) {
  const inner = node.querySelector<HTMLElement>('.slidomingo-text-inner') ?? node
  const final = inner.textContent ?? ''
  // Separators only count BETWEEN digits, so a sentence ending in a number
  // ("grew 25.") keeps its full stop instead of having it swallowed and
  // re-emitted as part of the value.
  const tokens = [...final.matchAll(/\d+(?:[.,]\d+)*/g)]
  if (!tokens.length) return
  const shapes = tokens.map((m) => readNumber(m[0]))
  const state = { p: 0 }
  anim.to(state, {
    p: 1,
    duration: 1.15,
    delay: 0.15,
    ease: 'power2.out',
    onUpdate() {
      let out = ''
      let last = 0
      tokens.forEach((m, i) => {
        out += final.slice(last, m.index)
        out += writeNumber(shapes[i].value * state.p, shapes[i])
        last = m.index! + m[0].length
      })
      inner.textContent = out + final.slice(last)
    },
  })
}

/**
 * Replace inline svg elements with fresh copies so their CSS/SMIL animations
 * replay on entry. CLONED, never re-parsed (`host.innerHTML = host.innerHTML`
 * was the old one-liner): a serialize → parse round trip is not the identity.
 * An html-namespace <style> serializes its text verbatim, so sanitized CSS
 * holding `</style` came back as live markup after the <style> — measured
 * running an onerror on every slide entry (2026-10-08 review).
 */
function restartSvgAnimations(section: HTMLElement) {
  for (const host of section.querySelectorAll<HTMLElement>('.slidomingo-el-svg')) {
    if (host.querySelector('animate, [style*="animation"], style')) {
      host.replaceChildren(...Array.from(host.childNodes, (n) => n.cloneNode(true)))
      alignEndlessAnimations(host)
    }
  }
}

/**
 * Endless CSS animations (wind, a turning wheel, falling snow) run on ONE
 * clock for the whole show — the document timeline's origin — instead of
 * restarting with each slide. The same drawing on the next slide is then in
 * the same pose, so a morph or a crossfade between two states of it has no
 * jump. Finite animations (a draw-on, an entrance) still replay on entry:
 * that is what the clone above is for.
 */
function alignEndlessAnimations(host: HTMLElement) {
  if (typeof host.getAnimations !== 'function') return
  for (const a of host.getAnimations({ subtree: true })) {
    if (a.effect?.getTiming().iterations === Infinity) a.startTime = 0
  }
}

/**
 * Continuous motion: ken-burns zoom, marching dashes, dots along paths.
 * `vis` (click builds) = what is on screen right now; an element still waiting
 * for its click starts its loop when it arrives.
 */
function runAmbientFx(slide: Slide, section: HTMLElement, vis?: Set<string>) {
  for (const [el, node] of fxNodes(slide, section)) {
    if (vis && !vis.has(el.id)) continue
    const fx = el.fx!
    if (fx.ambient === 'kenburns') {
      const ken = fx.ken ?? {}
      const dir = ken.dir ?? 'drift'
      if (dir === 'drift') {
        anim.fromTo(
          node,
          { scale: 1.02 },
          { scale: ken.scale ?? 1.1, duration: ken.duration ?? 26, ease: 'none', repeat: -1, yoyo: true, transformOrigin: '50% 40%' },
        )
      } else {
        // one-shot settle, replayed on every slide entry
        const far = ken.scale ?? 1.06
        const dur = ken.duration ?? 2.5
        anim.fromTo(
          node,
          { scale: dir === 'out' ? far : 1 },
          { scale: dir === 'out' ? 1 : far, duration: dur, ease: 'power2.out', transformOrigin: '50% 50%' },
        )
      }
    }
    if (fx.loop?.type === 'dash-march') {
      const target = dashTarget(node)
      if (target) {
        // Seamless marching ants: travel a WHOLE number of dash+gap periods
        // (else the pattern snaps back mid-cycle), sign kept for direction.
        const da = target.getAttribute('stroke-dasharray') || getComputedStyle(target).strokeDasharray || ''
        const parts = da.split(/[\s,]+/).map(parseFloat).filter((n) => n > 0)
        const travel = dashTravel(fx.loop.distance ?? 18, parts)
        anim.fromTo(
          target,
          { strokeDashoffset: travel },
          { strokeDashoffset: 0, duration: fx.loop.duration ?? 1.4, ease: 'none', repeat: -1 },
        )
      }
    }
    if (fx.loop?.type === 'motion-path') {
      anim.to(node, {
        motionPath: { path: fx.loop.path, speeds: fx.loop.speeds },
        duration: fx.loop.duration,
        delay: fx.loop.delay ?? 0,
        ease: fx.loop.ease ?? 'none',
        repeat: -1,
      })
    }
    if (fx.loop && fx.loop.type !== 'dash-march' && fx.loop.type !== 'motion-path') startGenericLoop(node, el, fx.loop)
  }
}

type GenericLoop = Extract<NonNullable<NonNullable<SlideElement['fx']>['loop']>, { type: 'pulse' | 'spin' | 'float' | 'blink' | 'wiggle' }>

/**
 * A loop must not start while an entrance is still running on the same node:
 * the engine lets a newer tween on a channel KILL an older one wholesale, so a
 * float (y) or blink (opacity) begun beside a fade-up would take the entrance
 * with it and strand the element at opacity 0. So wait the entrance out — on
 * the engine clock, so the manual test clock moves it too — then start.
 * `loopGen` lets a slide exit (or a re-settle) cancel a start still pending.
 */
const loopGen = new WeakMap<Element, number>()
/**
 * Nodes whose frame a morph is moving right now. That tween runs on a plain
 * state object and writes `transform` itself, so the engine cannot see it on
 * the node — and a loop started beside it wrote the same property every frame
 * (a floating balloon that also travels between slides flickered between the
 * two). A loop waits for these exactly as it waits for an entrance.
 */
const frameMorphing = new WeakSet<Element>()
const bumpLoopGen = (n: Element) => { const g = (loopGen.get(n) ?? 0) + 1; loopGen.set(n, g); return g }
/** Cancel any loop on `node`: running tweens die, a start still waiting never fires. */
function stopLoops(node: HTMLElement) {
  bumpLoopGen(node)
  anim.killTweensOf(node)
  frameMorphing.delete(node) // an interrupted morph must not leave a later loop waiting
  // a pivot (fx.loop.origin) must not outlive its loop: the model's own
  // rotate() turns about the centre, and a frame restore only resets transform
  node.style.transformOrigin = ''
}

/**
 * Move the transform pivot to (fx, fy) of the element's box WITHOUT moving the
 * element. The node's transform also carries the model's own rotate(), and
 * that would now turn about the new pivot — a rotated element would jump. The
 * difference between turning about the pivot P and about the centre C is a
 * pure translation, (R − I)(C − P); undo it with the engine's x/y channel, so
 * only the loop's own rotate/scale uses the new pivot.
 */
function pivotAt(node: HTMLElement, el: SlideElement, fx: number, fy: number) {
  const px = (fx - 0.5) * el.w
  const py = (fy - 0.5) * el.h
  const r = ((el.rotation ?? 0) * Math.PI) / 180
  if (!r || (!px && !py)) return
  const x = px * Math.cos(r) - py * Math.sin(r) - px
  const y = px * Math.sin(r) + py * Math.cos(r) - py
  anim.fromTo(node, { x, y }, { x, y, duration: 0.0001 })
}

function startGenericLoop(node: HTMLElement, el: SlideElement, loop: GenericLoop) {
  const d = LOOP_DEFAULTS[loop.type]
  const cycle = Math.max(0.1, loop.duration ?? d.cycle)
  const amount = loop.amount ?? d.amount
  const half = cycle / 2
  const base = el.opacity ?? 1
  const [ox, oy] = LOOP_ORIGINS[loop.origin ?? 'center'] ?? LOOP_ORIGINS.center
  const origin = `${ox * 100}% ${oy * 100}%`
  const go = () => {
    if (loop.type === 'pulse' || loop.type === 'spin' || loop.type === 'wiggle') pivotAt(node, el, ox, oy)
    switch (loop.type) {
      case 'pulse':
        anim.to(node, { scale: 1 + amount, duration: half, ease: 'sine.inOut', repeat: -1, yoyo: true, transformOrigin: origin })
        break
      case 'float':
        anim.to(node, { y: -amount, duration: half, ease: 'sine.inOut', repeat: -1, yoyo: true })
        break
      case 'blink':
        anim.to(node, { opacity: Math.max(0, base * (1 - amount)), duration: half, ease: 'sine.inOut', repeat: -1, yoyo: true })
        break
      case 'spin':
        anim.fromTo(node, { rotate: 0 }, { rotate: amount, duration: cycle, ease: 'none', repeat: -1, transformOrigin: origin })
        break
      case 'wiggle':
        // swing out to one side first, so it starts moving without a jump
        anim.to(node, {
          rotate: amount, duration: cycle / 4, ease: 'sine.out', transformOrigin: origin,
          onComplete() {
            anim.fromTo(node, { rotate: amount }, { rotate: -amount, duration: half, ease: 'sine.inOut', repeat: -1, yoyo: true })
          },
        })
        break
    }
  }
  const gen = bumpLoopGen(node)
  const launch = () => {
    if (loopGen.get(node) !== gen || !node.isConnected) return
    if ((loop.delay ?? 0) > 0) {
      const o = { p: 0 }
      anim.to(o, { p: 1, duration: loop.delay!, ease: 'none', onComplete: () => { if (loopGen.get(node) === gen && node.isConnected) go() } })
    } else go()
  }
  const busy = () => frameMorphing.has(node) || anim.getTweensOf(node).some((tw) => !tw.infinite && tw.progress() < 1)
  if (!busy()) return launch()
  const probe = { p: 0 }
  anim.to(probe, {
    p: 1, duration: 30, ease: 'none',
    onUpdate() {
      if (loopGen.get(node) !== gen) { anim.killTweensOf(probe); return }
      if (!busy()) { anim.killTweensOf(probe); launch() }
    },
  })
}

/** Show only the showOnHover set for `group` (falling back to the default). */
function applyRevealSet(root: HTMLElement, group: string | null, def?: string | null) {
  const active = group ?? def ?? null
  for (const node of root.querySelectorAll<HTMLElement>('[data-show-on-hover]')) {
    const show = node.dataset.showOnHover === active
    node.style.transition = 'opacity .18s ease'
    node.style.opacity = show ? '' : '0'
    node.style.pointerEvents = show ? '' : 'none'
  }
}

/**
 * Hover behaviours. focus-group: pointing at a grouped element dims every
 * element outside its group. reveal: pointing at a grouped element shows the
 * matching showOnHover set (in-slide content swap — no state slides needed).
 */
function wireHoverFocus(slide: Slide, section: HTMLElement) {
  if (!slide?.hover || section.dataset.hoverWired) return
  section.dataset.hoverWired = '1'
  const mode = slide.hover.type
  const dim = slide.hover.dim ?? 0.13
  const def = slide.hover.default ?? null
  let current: string | null = null
  const apply = (group: string | null) => {
    if (group === current) return
    current = group
    if (mode === 'reveal') {
      applyRevealSet(section, group, def)
      return
    }
    for (const node of section.querySelectorAll<HTMLElement>('[data-group]')) {
      const other = group !== null && node.dataset.group !== group
      node.style.transition = 'opacity .25s ease'
      node.style.opacity = other ? String(dim) : ''
    }
  }
  section.addEventListener('mouseover', (ev) => {
    const hit = (ev.target as HTMLElement).closest<HTMLElement>('[data-group]')
    apply(hit ? hit.dataset.group! : null)
  })
  section.addEventListener('mouseleave', () => apply(null))
}

// --- morph ------------------------------------------------------------------

function elementsById(root: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>()
  root.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((n) => {
    // not on screen (yet, or any more) = not part of the morph
    if (n.classList.contains(BUILD_HIDDEN)) return
    map.set(n.dataset.flipId!, n)
  })
  return map
}

/**
 * Model frames keyed by MORPH KEY, not by `id` — every caller looks these up
 * with a `data-flip-id`, which is `morphId || id`. Keying by `id` meant any
 * element carrying a `morphId` missed its own model entry, so `runMorph` hit
 * `if (!a || !b) continue` and skipped the tween: the DOM paired correctly and
 * then nothing animated (issue #54). Same-slide keys are unique — the panel
 * rejects a `morphId` that collides on the slide — so this stays 1:1.
 */
function modelByMorphKey(doc: SlidomingoDoc, index: number, slide: Slide | undefined = doc.slides[index]): Map<string, SlideElement> {
  const map = new Map<string, SlideElement>()
  for (const el of slide?.elements ?? []) map.set(morphKey(el), el)
  return map
}

/**
 * Where a symbol sits INSIDE its element, in model units.
 *
 * The engine's rule is "geometry from the model, never the DOM" — because the
 * outgoing section carries Reveal's own transforms, so absolute measurement
 * lies. A symbol inside a formula has no model entry to read: it is produced
 * at render time from a raw `$…$` string, so there is nothing to look up.
 *
 * The way through is to measure only what is INVARIANT under those transforms:
 * the symbol's offset from its own element's box, divided by that element's
 * measured width over its MODEL width. Any uniform scale an ancestor applies
 * hits numerator and denominator alike and cancels. Box geometry stays fully
 * model-driven; only the rearrangement WITHIN a box is measured.
 */
/**
 * Symbol offsets measured while a slide was ON SCREEN, keyed `slideIdx ␟ flipId`.
 *
 * Necessary because the outgoing section has NO LAYOUT by the time runMorph
 * runs — its elements measure zero width, which is the same fact that made
 * "geometry from the model, never the DOM" the rule in the first place. A
 * formula's symbols have no model entry to fall back on, so the only honest
 * source for where a symbol WAS is a measurement taken while it was visible.
 * Captured on slide entry; read on slide exit.
 */
/**
 * Clear runtime inline state from a section's morph symbols. Token and formula
 * spans carry state no model frame can restore — the symbol morph's transform,
 * the fresh-token fade's opacity — because applyElementFrame knows elements,
 * not spans, and the settle guarantee filters to elements with model entries.
 * An interrupted visit (fast advance, hidden tab, starved render loop) leaves
 * opacity:0 written inline on spans of a section Reveal keeps MOUNTED, and the
 * next visit shows code with holes: seen as "confetti() disappeared and came
 * back after the animations", and reproduced exactly by driving a hidden tab.
 * Swept on every exit and every entry; the entering morph recreates what it
 * actually needs.
 */
function sweepSymbolSpans(section: HTMLElement) {
  for (const sym of Array.from(section.querySelectorAll<HTMLElement>('[data-sym],[data-msx]'))) {
    anim.killTweensOf(sym)
    sym.style.opacity = ''
    sym.style.transform = ''
    sym.style.willChange = ''
    // Colour is cleared ONLY where the scaffolding fade pinned it. Code tokens
    // carry their syntax colour as an inline style straight from the renderer,
    // so clearing colour unconditionally here stripped every highlight in the
    // deck the first time a slide was swept.
    if (sym.dataset.inkpin !== undefined) {
      sym.style.color = ''
      delete sym.dataset.inkpin
    }
  }
}

const symCache = new Map<string, Map<string, { x: number; y: number }>>()
/** Scaffolding geometry (fraction bars, radicals) per slide, by host. */
const structCache = new Map<string, Map<string, { x: number; y: number; w: number; h: number }>>()
const symKey = (idx: number, flipId: string) => `${idx}${flipId}`

/** Measure and cache every formula on a slide that is currently displayed. */
function cacheSlideSymbols(doc: SlidomingoDoc, section: HTMLElement, idx: number) {
  const slide = doc.slides[idx]
  if (!slide) return
  const byKey = modelByMorphKey(doc, idx)
  for (const host of Array.from(section.querySelectorAll<HTMLElement>('[data-flip-id]'))) {
    if (!host.querySelector('[data-sym]')) continue
    const model = byKey.get(host.dataset.flipId!)
    if (!model) continue
    const offsets = symbolOffsets(host, model.w, model.h)
    if (offsets.size) symCache.set(symKey(idx, host.dataset.flipId!), offsets)
    structCache.set(symKey(idx, host.dataset.flipId!), structGeometry(host, model.w, model.h))
  }
}

/**
 * Where a formula's scaffolding sits and how big it is, in model units. Size
 * matters as much as position: a fraction bar is as wide as its widest side,
 * so an equation that keeps its outer fraction across a step can still have
 * that bar change length completely — 14px to 79px across the derivation's
 * last beat, snapping in one frame while every symbol around it travelled.
 */
function structGeometry(host: HTMLElement, modelW: number, modelH: number) {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>()
  const box = host.getBoundingClientRect()
  if (!box.width || !box.height) return out
  const sx = box.width / Math.max(modelW, 0.01)
  const sy = box.height / Math.max(modelH, 0.01)
  for (const node of Array.from(host.querySelectorAll<HTMLElement>('[data-msx]'))) {
    const r = node.getBoundingClientRect()
    out.set(node.dataset.msx!, {
      x: (r.left - box.left) / sx, y: (r.top - box.top) / sy,
      w: r.width / sx, h: r.height / sy,
    })
  }
  return out
}

function symbolOffsets(host: HTMLElement, modelW: number, modelH: number): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  const box = host.getBoundingClientRect()
  if (!box.width || !box.height) return out // no layout (hidden slide) — nothing to measure
  // Normalise per axis: the box morph can scale x and y differently, and one
  // shared factor would skew every vertical offset when it does.
  const sx = box.width / Math.max(modelW, 0.01)
  const sy = box.height / Math.max(modelH, 0.01)
  for (const sym of Array.from(host.querySelectorAll<HTMLElement>('[data-sym]'))) {
    const r = sym.getBoundingClientRect()
    out.set(sym.dataset.sym!, { x: (r.left - box.left) / sx, y: (r.top - box.top) / sy })
  }
  return out
}

/**
 * Morph a formula symbol by symbol: each token travels from where it sat on
 * the previous slide to where it sits on this one, so a term moving across the
 * equals sign is SEEN to move rather than crossfading.
 *
 * Composes with the element box morph rather than replacing it: that tween
 * already carries the element's gross position and scale, so what is animated
 * here is only each symbol's offset RELATIVE to its box. The delta is divided
 * by the box's current scale because a transform on a child inside a scaled
 * parent is scaled too — without it, symbols overshoot whenever the formula
 * changes size between slides.
 *
 * Symbols on only one side are left alone: they simply appear with their
 * element, which is what the box morph already does for them.
 */
function morphMathSymbols(
  fromAt: Map<string, { x: number; y: number }> | undefined,
  fromStruct: Map<string, { x: number; y: number; w: number; h: number }> | undefined,
  to: HTMLElement,
  a: SlideElement,
  b: SlideElement,
): boolean {
  if (!fromAt?.size || !to.querySelector('[data-sym]')) return false
  const toAt = symbolOffsets(to, b.w, b.h)
  if (!toAt.size) return false

  // A symbol with no partner on the previous slide has nowhere to travel FROM,
  // so it simply appeared. For a formula that is right — a new term rides the
  // element's own transition. For code it is not: a step can introduce a whole
  // line, and a line that snaps in while its neighbours glide reads as a redraw
  // rather than an edit. Fading them in, staggered and starting once the travel
  // is under way, makes the two motions one beat.
  const fresh = Array.from(to.querySelectorAll<HTMLElement>('[data-sym]'))
    .filter((s) => !fromAt.has(s.dataset.sym!))
  fresh.forEach((s, i) => {
    anim.fromTo(s, { opacity: 0 }, {
      opacity: 1,
      duration: 0.3,
      delay: MORPH_DURATION * 0.4 + Math.min(i, 30) * 0.015,
      ease: 'power2.out',
    })
  })

  // Scaffolding that is new this step arrives on the SAME beat as the fresh
  // tokens — but via `color`, never `opacity`.
  //
  // A fraction bar and a radical are painted by their box in currentColor, and
  // opacity groups a whole subtree: fading the box would take the terms
  // travelling into it along too, hiding them for the first 40% of their
  // journey and popping them into view mid-flight. Animating colour touches
  // only what the box itself paints — verified by pinning the leaves and
  // setting the box transparent, which leaves every symbol legible and in
  // place with the bars gone. Pinning is what makes it work: leaves inherit
  // colour, so they must carry their own before the box's is animated.
  const toStruct = structGeometry(to, b.w, b.h)
  // TWO passes, and the order is load-bearing. Scaffolding nests — a radical
  // inside a fraction — and anim renders a fromTo's from-state at creation, so
  // starting the outer box's fade first leaves the inner one inheriting a
  // transparent colour at the moment its own ink is read. It then animates
  // towards transparent and only becomes visible when the tween clears, which
  // is the pop this is meant to remove, one level down. Read every ink first,
  // against untouched colours, then start the tweens.
  const fades: Array<{ box: HTMLElement; ink: string; leaves: HTMLElement[] }> = []
  for (const box of Array.from(to.querySelectorAll<HTMLElement>('[data-msx]'))) {
    // New scaffolding fades in — and so does scaffolding that SURVIVES but
    // changes shape, because it cannot travel: transforming a container would
    // drag its children off their own paths. A bar that merely resizes would
    // otherwise snap in a single frame while everything inside it glided.
    // Absent, or so different it is plainly not the same bar. The key is
    // positional (tag#occurrence), not semantic, so it can claim an identity
    // that does not exist: across the derivation's last beat mfrac#0 is
    // `b OVER 2a` on one side and `-b±√(b²-4ac) OVER 2a` on the other. Those
    // are two different bars, and stretching one into the other would animate
    // a fiction. Judge by how much changed instead, generously enough that a
    // bar which genuinely persists and merely shifts a pixel or two is left
    // alone rather than blinking for no reason.
    const was = fromStruct?.get(box.dataset.msx!)
    const now = toStruct.get(box.dataset.msx!)
    const resized = (x: number, y: number) => Math.abs(x - y) > Math.max(x, y, 1) * 0.15
    const changed = !was || !now
      || Math.abs(was.x - now.x) > 6 || Math.abs(was.y - now.y) > 6
      || resized(was.w, now.w) || resized(was.h, now.h)
    if (!changed) continue
    // Read the ink from the BOX, not the flip host: the host is the element
    // wrapper and computes to its own colour (black here), while the box
    // inherits the formula's. Fading from the wrong one made the bar arrive
    // as black and snap to white on completion — invisible for the whole fade
    // on a dark slide, which looks exactly like the pop this replaces.
    fades.push({
      box,
      ink: getComputedStyle(box).color,
      leaves: Array.from(box.querySelectorAll<HTMLElement>('[data-sym]')),
    })
  }
  for (const { box, ink, leaves } of fades) {
    const inkClear = ink.startsWith('rgb(')
      ? ink.replace('rgb(', 'rgba(').replace(')', ', 0)')
      : 'rgba(0, 0, 0, 0)'
    // Marked, so the slide sweep knows which colours are ours to undo.
    for (const leaf of leaves) { leaf.style.color = ink; leaf.dataset.inkpin = '' }
    anim.fromTo(box, { color: inkClear }, {
      color: ink,
      duration: 0.3,
      delay: MORPH_DURATION * 0.4,
      ease: 'power2.out',
      onComplete() {
        box.style.color = ''
        for (const leaf of leaves) { leaf.style.color = ''; delete leaf.dataset.inkpin }
      },
    })
  }

  const pairs: Array<{ node: HTMLElement; dx: number; dy: number }> = []
  for (const sym of Array.from(to.querySelectorAll<HTMLElement>('[data-sym]'))) {
    const src = fromAt.get(sym.dataset.sym!)
    const dst = toAt.get(sym.dataset.sym!)
    if (!src || !dst) continue
    const dx = src.x - dst.x
    const dy = src.y - dst.y
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue // sits still — don't tween it
    pairs.push({ node: sym, dx, dy })
  }
  if (!pairs.length) return false

  const state = { p: 0 }
  for (const { node } of pairs) node.style.willChange = 'transform'
  anim.to(state, {
    p: 1,
    duration: MORPH_DURATION,
    ease: MORPH_EASE,
    onUpdate() {
      const p = state.p
      // undo the box tween's scale so the symbol delta stays in model units
      const sx = (a.w + (b.w - a.w) * p) / Math.max(b.w, 0.01)
      const sy = (a.h + (b.h - a.h) * p) / Math.max(b.h, 0.01)
      for (const { node, dx, dy } of pairs) {
        node.style.transform = `translate(${(dx * (1 - p)) / sx}px, ${(dy * (1 - p)) / sy}px)`
      }
    },
    onComplete() {
      for (const { node } of pairs) {
        node.style.transform = ''
        node.style.willChange = ''
      }
    },
  })
  return true
}

type Frame = Pick<SlideElement, 'x' | 'y' | 'w' | 'h' | 'rotation'>

const frameMoves = (a: Frame, b: Frame) =>
  a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || (a.rotation ?? 0) !== (b.rotation ?? 0)

/**
 * The transform that shows a node RESTING at `base` in the frame p of the way
 * from `a` to `b` — translate+scale about the top-left corner (scale mode like
 * PowerPoint: text scales instead of reflowing mid-morph), while rotation
 * pivots about the element's own centre.
 *
 * The centre is spelled out around an origin of 0 0 rather than by moving the
 * origin. Position and scale want the top-left, but the resting frame that
 * applyElementFrame writes — a plain `rotate()` with the default centre
 * origin — must be exactly what the end lands on, or a rotated element snaps
 * the instant the tween completes and the origin flips back. Measured on the
 * choreography scene: 7deg jumped 4.1px across and 5.1px up, -6deg the other
 * way, on the frame the morph finished. The triplet below collapses to the
 * resting rotate() whenever the frame IS `base`, so the two agree.
 *
 * `base` is `b` for the incoming node and `a` for a crossfade ghost of the
 * outgoing one, which rests (and lays its content out) at the old frame.
 */
function morphFrameTransform(base: Frame, a: Frame, b: Frame, p: number): string {
  const x = a.x + (b.x - a.x) * p
  const y = a.y + (b.y - a.y) * p
  const w = a.w + (b.w - a.w) * p
  const h = a.h + (b.h - a.h) * p
  const r = (a.rotation ?? 0) + ((b.rotation ?? 0) - (a.rotation ?? 0)) * p
  const cx = base.w / 2
  const cy = base.h / 2
  return `translate(${x - base.x}px, ${y - base.y}px)` +
    ` scale(${w / Math.max(base.w, 0.01)}, ${h / Math.max(base.h, 0.01)})` +
    (r ? ` translate(${cx}px, ${cy}px) rotate(${r}deg) translate(${-cx}px, ${-cy}px)` : '')
}

/**
 * Does a paired element change WHAT it shows, beyond what the morph tweens?
 * Frame, opacity, text colour and shape fill are tweened and never count
 * here. Charts and code carry their own morphs (data lerp, token travel), so
 * they never crossfade. Text compares its rendered text as well as its html:
 * a `{{page}}` footer has the same html on every slide and a different number.
 */
function morphContentChanged(a: SlideElement, b: SlideElement, from: HTMLElement, to: HTMLElement): boolean {
  if (a.type !== b.type) return true
  if (b.type === 'zoom') return JSON.stringify((a as typeof b).target) !== JSON.stringify(b.target) // another cover
  switch (b.type) {
    case 'text': {
      const t = a as typeof b
      return t.html !== b.html || from.textContent !== to.textContent ||
        t.fontSize !== b.fontSize || t.fontFamily !== b.fontFamily || t.fontWeight !== b.fontWeight ||
        t.align !== b.align || t.valign !== b.valign || t.lineHeight !== b.lineHeight
    }
    case 'image': {
      const i = a as typeof b
      const ca = i.crop, cb = b.crop
      const cropChanged = !!ca !== !!cb || (!!ca && !!cb && (ca.x !== cb.x || ca.y !== cb.y || ca.w !== cb.w || ca.h !== cb.h))
      return i.src !== b.src || i.fit !== b.fit || cropChanged
    }
    case 'shape': { const sh = a as typeof b; return sh.shape !== b.shape || sh.d !== b.d }
    case 'media': { const m = a as typeof b; return m.src !== b.src || m.poster !== b.poster }
    // an equation whose symbols were captured never gets here (the symbol
    // morph moves them); this is the crossfade for one that was not
    case 'math': {
      const q = a as typeof b
      return q.tex !== b.tex || !!q.inline !== !!b.inline || q.fontSize !== b.fontSize ||
        q.align !== b.align || q.valign !== b.valign
    }
    case 'svg': { const v = a as typeof b; return v.markup !== b.markup || v.asset !== b.asset || v.css !== b.css }
    case 'table': {
      const tb = a as typeof b
      return JSON.stringify([tb.columns, tb.rows, tb.header, tb.style]) !==
        JSON.stringify([b.columns, b.rows, b.header, b.style])
    }
    default: return false
  }
}

/**
 * A still copy of an OUTGOING element, parked in the incoming section so it
 * can fade out there. Reveal hides the old section the instant a morph starts
 * (both sides use transition 'none'), so without this an element with no
 * partner simply vanished at 0 ms.
 *
 * It must be invisible to everything that looks elements up: no
 * `data-flip-id` (elementsById, the math caches), and no `data-el-id` either —
 * `querySelector` returns the FIRST match and the ghost sits before its
 * partner, so a ghost of an element with the same id would answer for it in
 * every fx, chart and settle lookup. An svg element keeps its id when nothing
 * on the new slide shares it: its scoped CSS keys off that attribute. Hover,
 * link and autoplay markers go too, so no other system adopts the ghost.
 */
function morphGhost(src: HTMLElement, frame: SlideElement, toSection: HTMLElement): HTMLElement {
  const g = src.cloneNode(true) as HTMLElement
  const keepElId = frame.type === 'svg' &&
    !toSection.querySelector(`[data-el-id="${CSS.escape(frame.id)}"]`)
  for (const n of [g, ...Array.from(g.querySelectorAll<HTMLElement>('*'))]) {
    if (!n.dataset) continue
    delete n.dataset.flipId
    if (!keepElId) delete n.dataset.elId
    delete n.dataset.showOnHover
    delete n.dataset.link
    delete n.dataset.group
    delete n.dataset.autoplay
    delete n.dataset.zoomTile // a ghost of a zoom tile is no button
    n.removeAttribute('tabindex')
  }
  g.dataset.morphGhost = ''
  g.setAttribute('aria-hidden', 'true')
  applyElementFrame(g, frame)
  g.style.transition = '' // applyRevealSet's opacity transition would lag every tween frame
  g.style.pointerEvents = 'none'
  return g
}

/** Remove a section's leftover morph ghosts — a skip-ahead, a reduced-motion
 *  toggle or a starved render loop can leave them mid-fade. */
function clearMorphGhosts(section: HTMLElement) {
  for (const g of Array.from(section.querySelectorAll<HTMLElement>('[data-morph-ghost]'))) {
    anim.killTweensOf(g)
    g.remove()
  }
}

function runMorph(
  doc: SlidomingoDoc,
  fromSection: HTMLElement,
  toSection: HTMLElement,
  fromIdx: number,
  toIdx: number,
  /** the slides as they LOOK at this click (builds filtered out); default = the whole model */
  fromView: Slide | undefined = doc.slides[fromIdx],
  toView: Slide | undefined = doc.slides[toIdx],
) {
  clearMorphGhosts(toSection)
  const fromEls = elementsById(fromSection)
  const toEls = elementsById(toSection)
  const fromModel = modelByMorphKey(doc, fromIdx, fromView)
  const toModel = modelByMorphKey(doc, toIdx, toView)

  const matchedFrom: HTMLElement[] = []
  const matchedTo: HTMLElement[] = []
  for (const [id, el] of fromEls) {
    const target = toEls.get(id)
    if (target) {
      matchedFrom.push(el)
      matchedTo.push(target)
    }
  }
  const ghosts: HTMLElement[] = []

  // Entrances wait until the morph is 40% done, so travel and arrival read as
  // one beat — but only when something actually travels. With nothing moving
  // there is no morph to wait for, and the wait was a blank slide: the old
  // content already gone, the new not yet arrived (260 ms+ on every imported
  // deck, where paired chrome sits still). Starting at once overlaps the exit
  // fades below, and the transition reads as a crossfade.
  const moving = matchedTo.some((n) => {
    const a = fromModel.get(n.dataset.flipId!)
    const b = toModel.get(n.dataset.flipId!)
    return !!a && !!b && frameMoves(a, b)
  })
  const enterAt = moving ? MORPH_DURATION * 0.4 : 0

  // Unmatched incoming elements fade/rise in — to their MODEL opacity
  // (clearProps would wipe reveal-set hiding and dimmed-state opacities).
  const toSlide = toView
  const activeSet = toSlide?.hover?.type === 'reveal' ? (toSlide.hover.default ?? null) : null
  const entering: Array<[HTMLElement, number]> = []
  for (const n of toEls.values()) {
    const id = n.dataset.flipId!
    if (fromEls.has(id)) continue
    const m = toModel.get(id)
    if (m?.showOnHover && m.showOnHover !== activeSet) continue // hover-revealed, stays hidden
    entering.push([n, m?.opacity ?? 1])
  }
  if (entering.length) {
    // The default stagger runs in DOCUMENT order — chrome first, the title
    // last. Beside a morph that travels it lets arrivals trail the motion; in
    // a crossfade it only held the title back (about 0.2 s on an imported
    // slide) while the old one faded, so there everything arrives together.
    const spread = moving ? Math.min(0.45, entering.length * 0.03) : 0
    entering.forEach(([n, opacity], i) => {
      // motion-path loops own the transform — entrance limited to opacity
      const m = toModel.get(n.dataset.flipId!)
      const owns = m?.fx?.loop?.type === 'motion-path'
      // An explicit fx.enter WINS over the default rise. This element has no
      // morph partner — it is new to this slide, so there is no morph tween for
      // an entrance to fight, and the author named a direction. Elements with a
      // partner are excluded above and keep morphing; elements with no fx.enter
      // keep the default, so no existing deck changes unless it asked to.
      const kind = owns ? undefined : m?.fx?.enter
      const spec = kind ? enterSpec(kind, m?.fx?.enterDur) : null
      const step = m?.fx?.order ?? i
      anim.fromTo(n,
        spec ? { ...spec.from } : owns ? { opacity: 0 } : { opacity: 0, y: 14 },
        {
          opacity,
          ...(spec ? { x: 0, y: 0 } : owns ? {} : { y: 0 }),
          duration: spec?.duration ?? 0.45,
          // Both stagger from the same base (see enterAt above).
          delay: enterAt +
            (spec ? Math.min(step, 24) * 0.05 : (spread * i) / entering.length),
          ease: spec?.ease ?? 'power2.out',
        })
    })
    settleGuarantee(entering.map(([n]) => {
      const m = toModel.get(n.dataset.flipId!)
      return [n, m!] as [HTMLElement, SlideElement]
    }).filter(([, m]) => !!m))
  }

  // Unmatched OUTGOING elements fade out as ghosts in the new section. Each
  // keeps its old stacking relative to what the two slides share: it goes
  // right above the incoming partner of the nearest shared element below it
  // on the old slide — so an old picture never fades out UNDER a shared
  // full-slide background — or beneath everything when nothing shared is
  // below it. Incoming elements then land on top of the fading ones.
  const fromSlide = fromView
  const fromSet = fromSlide?.hover?.type === 'reveal' ? (fromSlide.hover.default ?? null) : null
  const surface = toSection.querySelector<HTMLElement>('.slidomingo-slide')
  if (surface) {
    let anchor: HTMLElement | null = null
    for (const [id, n] of fromEls) {
      const partner = toEls.get(id)
      if (partner) { anchor = partner; continue }
      const a = fromModel.get(id)
      if (!a || !(a.opacity > 0) || a.type === 'embed') continue // an iframe clone would reload
      if (a.showOnHover && a.showOnHover !== fromSet) continue
      const g = morphGhost(n, a, toSection)
      if (anchor) anchor.after(g)
      else surface.insertBefore(g, surface.querySelector('[data-flip-id]'))
      anchor = g
      ghosts.push(g)
      anim.fromTo(g, { opacity: a.opacity }, {
        opacity: 0, duration: MORPH_DURATION * 0.5, ease: 'power1.out', onComplete: () => g.remove(),
      })
    }
  }

  // Paired elements whose CONTENT changes crossfade: a ghost of the old one
  // sits directly under the new one and they swap opacities, travelling
  // together when the frame changes too. Without this, a title in a shared
  // slot (same frame, new words) hard-cut — the box morph had nothing to do.
  // Same beat as an unpaired exit and entrance: the old fades quickly while
  // the new comes up over it. A slow symmetric swap was tried first and read
  // as two overlapping paragraphs for most of the morph. Formulas and code
  // whose symbols were captured are left to the symbol morph, which moves
  // them instead.
  const crossfading = new Map<HTMLElement, HTMLElement>() // to-node → its ghost
  matchedTo.forEach((to, i) => {
    const id = to.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b || a.type === 'embed' || b.type === 'embed') return
    if (b.showOnHover && b.showOnHover !== activeSet) return
    if (a.showOnHover && a.showOnHover !== fromSet) return
    if (symCache.get(symKey(fromIdx, id))?.size && to.querySelector('[data-sym]')) return
    if (!morphContentChanged(a, b, matchedFrom[i], to)) return
    const g = morphGhost(matchedFrom[i], a, toSection)
    to.before(g)
    ghosts.push(g)
    crossfading.set(to, g)
    anim.fromTo(g, { opacity: a.opacity }, {
      opacity: 0, duration: MORPH_DURATION * 0.5, ease: 'power1.out', onComplete: () => g.remove(),
    })
    anim.fromTo(to, { opacity: 0 }, { opacity: b.opacity, duration: 0.45, ease: 'power2.out' })
  })
  if (crossfading.size) {
    settleGuarantee([...crossfading.keys()].map((n) => [n, toModel.get(n.dataset.flipId!)!]))
  }
  // the ghosts' own wall-clock net: on a starved render loop their fades
  // crawl, and a ghost left behind would sit in the slide for good
  if (ghosts.length) setTimeout(() => { for (const g of ghosts) g.remove() }, 2800)
  if (!matchedFrom.length) return

  // Geometry straight from the model — no DOM measuring needed (both sides'
  // frames are in the doc), so the outgoing section's Reveal styling is
  // irrelevant. Each matched node animates from the from-slide's frame to its
  // own (morphFrameTransform); a crossfade ghost rides the same tween.
  for (const node of matchedTo) {
    const id = node.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b || !frameMoves(a, b)) continue
    const ghost = crossfading.get(node)
    const state = { p: 0 }
    node.style.transformOrigin = '0 0'
    if (ghost) ghost.style.transformOrigin = '0 0'
    frameMorphing.add(node)
    anim.to(state, {
      p: 1,
      duration: MORPH_DURATION,
      ease: MORPH_EASE,
      onUpdate() {
        node.style.transform = morphFrameTransform(b, a, b, state.p)
        if (ghost) ghost.style.transform = morphFrameTransform(a, a, b, state.p)
      },
      onComplete() {
        frameMorphing.delete(node)
        node.style.transformOrigin = ''
        node.style.transform = b.rotation ? `rotate(${b.rotation}deg)` : ''
        resetXform(node)
      },
    })
  }

  // Symbol-level math morph, layered on top of the box morph above. The
  // from-side offsets come from the cache captured while that slide was
  // visible — measuring it now would read zeros (it has no layout).
  for (const to of matchedTo) {
    const id = to.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b) continue
    morphMathSymbols(symCache.get(symKey(fromIdx, id)), structCache.get(symKey(fromIdx, id)), to, a, b)
  }

  // Styles morph straight from the model — exact values, no DOM sniffing.
  for (const to of matchedTo) {
    const id = to.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b) continue
    // a crossfading node's opacity already runs 0 → b (its ghost starts at a)
    if (a.opacity !== b.opacity && !crossfading.has(to)) {
      anim.fromTo(to, { opacity: a.opacity }, { opacity: b.opacity, duration: MORPH_DURATION, ease: MORPH_EASE })
    }
    if (a.type === 'shape' && b.type === 'shape') {
      const target = to.querySelector<SVGElement>('rect,ellipse,polygon,line,path')
      if (target) morphShapeFill(target, a, b)
    }
    if (a.type === 'text' && b.type === 'text' && a.color !== b.color) {
      const inner = to.querySelector<HTMLElement>('.slidomingo-text-inner')
      if (inner) {
        anim.fromTo(inner, { color: a.color }, { color: b.color, duration: MORPH_DURATION, ease: MORPH_EASE })
      }
    }
    if (a.type === 'math' && b.type === 'math' && a.color !== b.color) {
      const inner = to.querySelector<HTMLElement>('.slidomingo-math-inner')
      if (inner) anim.fromTo(inner, { color: a.color }, { color: b.color, duration: MORPH_DURATION, ease: MORPH_EASE })
    }
    // same drawing, another state: blend its vars (content changes crossfaded above)
    if (a.type === 'svg' && b.type === 'svg' && !crossfading.has(to)) morphSvgVars(to, a, b)
  }
}

/**
 * Blend an svg's `vars` from slide a's values to slide b's on the incoming
 * node. Numbers (with the same unit on both sides) and solid colours blend;
 * anything else — a keyword, a unit change, a var only one side has — is
 * already at b's value from render and simply stays there.
 */
function morphSvgVars(node: HTMLElement, a: SvgElement, b: SvgElement) {
  const from = new Map(svgVarDecls(a))
  const blends: Array<(p: number) => void> = []
  for (const [k, vb] of svgVarDecls(b)) {
    const va = from.get(k)
    if (va === undefined || va === vb) continue
    const blend = varLerp(va, vb)
    if (blend) blends.push((p) => node.style.setProperty(k, blend(p)))
  }
  if (!blends.length) return
  for (const f of blends) f(0) // a's state on the very first frame, not b's
  const state = { p: 0 }
  anim.to(state, {
    p: 1, duration: MORPH_DURATION, ease: MORPH_EASE,
    onUpdate() { for (const f of blends) f(state.p) },
  })
}

const NUM_UNIT = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/
const SOLID = /^(?:#|rgba?\()/

/** value-pair → interpolator, or null when the pair has no in-between */
function varLerp(a: string, b: string): ((p: number) => string) | null {
  const na = a.match(NUM_UNIT)
  const nb = b.match(NUM_UNIT)
  if (na && nb) {
    if (na[2] !== nb[2]) return null
    const x = Number(na[1])
    const y = Number(nb[1])
    return (p) => `${Math.round((x + (y - x) * p) * 1e4) / 1e4}${nb[2]}`
  }
  if (SOLID.test(a) && SOLID.test(b)) {
    const ca = colorParts(a)
    const cb = colorParts(b)
    return (p) => rgbaStr([0, 1, 2, 3].map((k) => ca[k] + (cb[k] - ca[k]) * p) as [number, number, number, number])
  }
  return null
}

// --- fill morphing (solid ⇄ solid, solid ⇄ gradient, gradient ⇄ gradient) ----

const SVG_NS = 'http://www.w3.org/2000/svg'
let morphGradSeq = 0

/** Any solid CSS color we author (#hex / rgb / rgba) → [r, g, b, a]. */
function colorParts(v: string): [number, number, number, number] {
  const m = v?.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(/[\s,/]+/).map(Number)
    return [p[0] || 0, p[1] || 0, p[2] || 0, Number.isFinite(p[3]) ? p[3] : 1]
  }
  let hex = (v ?? '').trim()
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('')
  if (/^#[0-9a-fA-F]{6,8}$/.test(hex)) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
      hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1,
    ]
  }
  return [0, 0, 0, v === 'transparent' || v === 'none' ? 0 : 1]
}

const rgbaStr = (c: [number, number, number, number]) =>
  `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${Math.round(c[3] * 1000) / 1000})`

/** Color of a gradient evaluated at position t (piecewise-linear between stops). */
function sampleGradient(stops: GradientFill['stops'], t: number): string {
  const s = [...stops].sort((x, y) => x.at - y.at)
  if (t <= s[0].at) return rgbaStr(colorParts(s[0].color))
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]
    const b = s[i + 1]
    if (t <= b.at) {
      const f = b.at === a.at ? 0 : (t - a.at) / (b.at - a.at)
      const ca = colorParts(a.color)
      const cb = colorParts(b.color)
      return rgbaStr([0, 1, 2, 3].map((k) => ca[k] + (cb[k] - ca[k]) * f) as [number, number, number, number])
    }
  }
  return rgbaStr(colorParts(s[s.length - 1].color))
}

/**
 * Tween a shape's fill from element a's to element b's. Solids tween the fill
 * attribute; when a gradient is involved the tween runs on the <stop> nodes
 * (colors sampled from the other side at matching positions) and on the
 * gradient line, so angle changes sweep too. A solid destination gets a
 * temporary gradient that collapses to the flat color and is then removed.
 */
function morphShapeFill(target: SVGElement, a: ShapeElement, b: ShapeElement) {
  if (a.fill === b.fill && JSON.stringify(a.fillGradient) === JSON.stringify(b.fillGradient)) return
  // line shapes paint with stroke (fill is the line color in the model)
  if (b.shape === 'line' && target.tagName === 'line') {
    anim.fromTo(target, { attr: { stroke: a.fill } }, { attr: { stroke: b.fill }, duration: MORPH_DURATION, ease: MORPH_EASE })
    return
  }
  const ag = a.fillGradient?.stops.length ? a.fillGradient : undefined
  const bg = b.fillGradient?.stops.length ? b.fillGradient : undefined
  if (!ag && !bg) {
    if (a.fill !== b.fill) {
      anim.fromTo(target, { attr: { fill: a.fill } }, { attr: { fill: b.fill }, duration: MORPH_DURATION, ease: MORPH_EASE })
    }
    return
  }
  const svg = target.ownerSVGElement
  if (!svg) return

  let lin = svg.querySelector('linearGradient')
  if (!lin) {
    // destination is solid — fabricate a gradient shaped like the source so
    // there is something to tween through, then collapse it to b.fill
    lin = document.createElementNS(SVG_NS, 'linearGradient')
    lin.id = `slidomingo-morph-grad-${morphGradSeq++}`
    for (const s of ag!.stops) {
      const stop = document.createElementNS(SVG_NS, 'stop')
      stop.setAttribute('offset', String(s.at))
      lin.appendChild(stop)
    }
    const defs = document.createElementNS(SVG_NS, 'defs')
    defs.appendChild(lin)
    svg.appendChild(defs)
    target.setAttribute('fill', `url(#${lin.id})`)
  }

  const stops = [...lin.querySelectorAll('stop')]
  // per rendered stop: where it sits, what it starts as, what it ends as
  const finals = bg ? bg.stops : ag!.stops.map((s) => ({ at: s.at, color: b.fill }))
  stops.forEach((node, i) => {
    const at = finals[i]?.at ?? 1
    const fromColor = ag ? sampleGradient(ag.stops, at) : rgbaStr(colorParts(a.fill))
    const toColor = finals[i]?.color ?? b.fill
    anim.fromTo(
      node,
      { attr: { 'stop-color': fromColor } },
      {
        attr: { 'stop-color': toColor },
        duration: MORPH_DURATION,
        ease: MORPH_EASE,
        ...(i === 0 && !bg
          ? {
              // solid destination: swap the temp gradient back to a flat fill
              onComplete: () => {
                target.setAttribute('fill', b.fill)
                lin!.parentElement?.remove()
              },
            }
          : {}),
      },
    )
  })

  const fromLine = gradientLineCoords((ag ?? bg)!.angle)
  const toLine = gradientLineCoords((bg ?? ag)!.angle)
  anim.fromTo(lin, { attr: fromLine }, { attr: toLine, duration: MORPH_DURATION, ease: MORPH_EASE })
}
