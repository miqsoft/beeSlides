// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// The editing canvas: renders the current slide at fit-to-window scale and
// wires Moveable (drag/resize/rotate/snap) + Selecto (click & rubber-band
// selection) + contenteditable text editing on top of it.

import Moveable from 'moveable'
import Selecto from 'selecto'
import type { Store } from '../store'
import { effectiveCanvasSize } from '../store'
import { locale, t } from '../i18n'
import { offlineEnabled } from '../../../kernel/src/net.ts'
import { ancestorElementIds, defaultShape, effectiveLayout, internAsset, lineDefaultsFor, normalizeCrop, shapeDefaultsFor, uid, type ShapeElement, type Slide, type SlideElement, type TableElement } from '../model'
import { iconShapes, iconsetInfo } from '../iconset'
import { lookPreviewUrl } from './iconsetactions'
import { isBackdrop as isBackdropBox, renderSlide, renderSlideElement, sanitizeHtml, slideRenderContext, type RenderOpts } from '../render'
import { anim } from '../anim'
import { previewBuilds, previewSlideFx, type BuildPreview } from '../present'
import { buildPlan, stepsOf } from '../builds'
import { autoformatAtCaret, clearAutoformat, insertLiteralText, markdownToHtml, undoAutoformat } from './markdown'
import { RT_KEEP, closeRichPopover, handleRichKey, listAt, normalizeRuns, richCopy, richPaste } from './richtext'
import { remapCopiedRefs, takePlainPaste } from './clipboard'
import { PathEditor } from './patheditor'
import { LineEditor, isLineLike, setLineEndpoints, setPathAnchors } from './lineedit'
import { BezierEditor, isCurve } from './beziereditor'
import { CropMode } from './cropmode'
import { MathEditSession, activeMathEdit } from './matheditor'
import { TableRange } from './tablerange'
import { cellToward, nextCell } from '../tablespans'
import { simplifyPoints } from './patheditor'
import { findChord } from './findbar'
import { marginFor } from '../validate'
import { layoutTracks, normalizeGuides, normalizeLayoutGrid, setGuide } from '../layoutgrid'
import { formatLength, loadGridPref, type GridPref } from './gridpref'
import { axisCaught, gridSnapSpan, snapPoint, staticSnapLines, type SnapLines } from './snapping'
import { lsGet, lsSet } from '../../../kernel/src/storage.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
type DrawKind = 'line' | 'path' | 'connector' | 'free' | 'poly'
import { CommentsUI } from './comments'
import { FrameCoalescer, inLiveStep } from './livestep'
import { DomDirt, alwaysRedraw, frameKey, patchNode, sameSig, signature, type Sig } from './canvaspatch'
import { jsonClone } from '../jsonclone.ts'

/** Editor-only view preference — never in the doc, same idiom as present.ts's
 *  'slidomingo-reduce-motion' (a VIEWER setting, not a document property). */
const SAFE_ZONE_KEY = 'slidomingo-safe-zone'
const BUILD_BADGES_KEY = 'slidomingo-build-badges'
/** How close (screen px) an edge or point must come to a line to snap to it. */
const SNAP_SCREEN_PX = 6

/** The surface on screen and what it was drawn from (SlideCanvas.render). */
type ShownSurface = {
  surface: HTMLElement
  ctxSig: Sig
  ids: string[]
  sigs: Sig[]
  frames: string[]
  nodes: Array<HTMLElement | null>
  /** `docEpoch` when it was last drawn or patched */
  epoch: number
}

export class SlideCanvas {
  private stage: HTMLElement
  private scaleHost: HTMLElement
  private scroller: HTMLElement
  private surface: HTMLElement | null = null
  private moveable: Moveable
  private selecto: Selecto
  private scale = 1
  private fitScale = 1
  /** user zoom, multiplier on the fitted scale (1 = fit to window) */
  private zoom = 1
  private zoomLabel: HTMLElement | null = null
  private editing: HTMLElement | null = null
  /** Slide identity captured when an inline edit begins. Element ids may be
   *  shared across duplicated slides, so resolving through store.slide at
   *  commit time can write into the wrong slide after navigation or a remote
   *  deletion. */
  private editingSlideId: string | null = null
  /** startTextEdit swapped the rendered form for raw source (a field or a
   *  formula), so commit must re-render even if the text is unchanged. */
  private editingShowedRaw = false
  /** when editing a table cell, which cell (else null → text element edit) */
  private editingCell: { r: number; c: number } | null = null
  /** a repaint arrived (e.g. a remote collab op) while an inline edit was in
   *  progress and was deferred so it wouldn't tear the edited node out from
   *  under the caret; flushed when the edit commits. */
  private pendingRender = false
  /** a live step of a continuous panel edit (livestep.ts) redraws at the next
   *  frame; any synchronous render() supersedes it */
  private readonly liveRender = new FrameCoalescer(() => this.render('patch'))
  /** What the surface on screen was drawn from — the diff base of
   *  render('patch'); null = draw in full next time. */
  private shown: ShownSurface | null = null
  /** element nodes someone else's code changed since they were drawn */
  private readonly domDirt = new DomDirt()
  /** counts the store's 'doc' events: an unchanged epoch means the model is
   *  as last drawn, so even `alwaysRedraw` elements need no redraw */
  private docEpoch = 0
  /** how often each render path ran — e2e/bench diagnostics only */
  readonly renderStats = { full: 0, patch: 0, unchanged: 0, patchedNodes: 0 }
  /** space is down and the canvas is armed to pan (see the keydown handler) */
  private spaceHeld = false
  /** a pan drag is in flight — keeps the grabbing cursor through a space release */
  private panning = false
  /** true while any Moveable drag/resize/rotate gesture (single or group)
   *  is in flight — guards syncTargets from reassigning moveable.target
   *  mid-gesture (repo hard-won #2; also the dragInfo null-write crash:
   *  reassigning target tears down/rebuilds Moveable's abilities, nulling
   *  internal gesture state a still-in-flight pointermove writes into). */
  private gestureActive = false
  /** Set when syncTargets wanted to reassign moveable.target while a
   *  gesture was active; flushed once the live gesture's End event fires. */
  private pendingTargetSync = false
  /** ids of container children EXCLUDED from the live 'rotateGroup' cascade —
   *  set at rotateGroupStart, cleared at rotateGroupEnd. v1: rotating a
   *  container's frame does not rotate its children around it (deferred to
   *  v2), unlike drag/resize which DO cascade live — see
   *  `containerCascadeChildren`. */
  private rotateCascadeChildIds: Set<string> | null = null
  private pathEditor!: PathEditor
  private lineEditor!: LineEditor
  private bezierEditor!: BezierEditor
  private cropMode!: CropMode
  /** the selected cells of a lone selected table (editor/tablerange.ts) */
  readonly tableRange: TableRange
  /** The lone selected element when the current pointer press began — so the
   *  Moveable `click` that ends the press which SELECTED a table does not also
   *  pick a cell (the first click selects the table, the second picks a cell). */
  private selAtPress: string | null = null
  private drawOverlay: HTMLElement | null = null
  private comments!: CommentsUI
  /** Persistent safe-zone margin guide — purely visual, toggled from the
   *  View menu, state kept in localStorage (never the document). */
  private safeZoneLayer: HTMLElement | null = null
  /** icon sets: the keyline square + circle (padding) over the icon canvas */
  private keylineLayer: HTMLElement | null = null
  /** icon sets: the icon painted in the style being shown (store.iconLook) */
  private lookLayer: HTMLElement | null = null
  /** Drawing grid (slides and figures): `gridStep` model px, 0 = off. Drags snap firmly to it (wireMoveable), resizes through Moveable's own grid, points via snapPoint(). */
  private gridLayer: HTMLElement | null = null
  private gridStep = 0
  /** Grid & Snap viewer preference (gridpref.ts) — what shows and what snaps. */
  private gridPref: GridPref = loadGridPref()
  /** Magnetic lines (guides, layout grid, margins) in slide px — refreshSnap(). */
  private snapLines: SnapLines = { x: [], y: [] }
  private layoutLayer: HTMLElement | null = null
  private guidesLayer: HTMLElement | null = null
  private safeZoneOn = lsGet(SAFE_ZONE_KEY) === 'on'
  /** Click-build step chips on the elements: a View toggle (a viewer preference,
   *  like the safe zone) OR forced on while the Presenting / Builds panel is open. */
  private buildBadgesOn = lsGet(BUILD_BADGES_KEY) === 'on'
  private buildBadgesFocus = false
  private buildBadgeLayer: HTMLElement | null = null
  // Listener sets for chrome that floats over the canvas (the mini toolbar).
  // Sets, not single callback fields, so more than one surface can follow.
  private viewportListeners = new Set<() => void>()
  private gestureListeners = new Set<(active: boolean) => void>()
  private textEditListeners = new Set<(elId: string | undefined) => void>()

  constructor(
    private wrap: HTMLElement,
    private store: Store,
  ) {
    this.scroller = document.createElement('div')
    this.scroller.className = 'ed-scroll'
    this.stage = document.createElement('div')
    this.stage.className = 'ed-stage'
    this.scaleHost = document.createElement('div')
    this.scaleHost.className = 'ed-stage-scale'
    this.stage.appendChild(this.scaleHost)
    this.scroller.appendChild(this.stage)
    wrap.appendChild(this.scroller)
    this.buildZoomBar()
    // pinch / ctrl+wheel zooms like every design tool
    this.scroller.addEventListener('wheel', (ev) => {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault()
        this.setZoom(this.zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), ev) // toward the pointer
        return
      }
      // plain wheel → walk slides, but only when the slide can't be panned (it
      // fits, i.e. not zoomed to overflow) and nothing is being edited. A distance
      // threshold + cooldown makes one trackpad swipe advance exactly one slide.
      if (!this.onSlideNav || this.editing || this.editingCell || this.isPathEditing) return
      const s = this.scroller
      if (s.scrollHeight > s.clientHeight + 1 || s.scrollWidth > s.clientWidth + 1) return // pannable → let it scroll
      if (Math.abs(ev.deltaY) < Math.abs(ev.deltaX)) return // horizontal intent
      ev.preventDefault()
      const now = Date.now()
      if (now < this.wheelNavCooldown) return
      this.wheelNavAccum += ev.deltaY
      if (Math.abs(this.wheelNavAccum) < 40) return
      const dir = this.wheelNavAccum > 0 ? 1 : -1
      this.wheelNavAccum = 0
      this.wheelNavCooldown = now + 400
      this.onSlideNav(dir)
    }, { passive: false })

    // Middle-button drag pans. Until now the scrollbars were the only way to
    // move a zoomed slide, which puts the control at the edge of the screen
    // while the work is in the middle of it. Middle-drag is what design tools
    // do, and unlike space-drag it cannot collide with typing a space.
    //
    // Capture phase, because Selecto is bound to this same scroller and would
    // otherwise read the press as the start of a marquee.
    this.scroller.addEventListener('mousedown', (ev) => {
      // Middle button, or left button while space is held — the two gestures
      // every canvas tool offers. Space is the one most hands already know;
      // middle-drag is the one that works when a hand is on the mouse, and the
      // one #166 asked for. Neither exists on an Apple trackpad, which is why
      // a plain two-finger scroll still pans once the slide is zoomed past fit.
      // canGrabSpace is re-checked HERE, not just when space armed the pan: a
      // keyup can be missed (a native dialog, focus leaving mid-hold), and a
      // canvas stuck in pan mode would swallow the click that starts a text
      // edit. The press itself is the last honest moment to ask.
      if (ev.button !== 1 && !(ev.button === 0 && this.spaceHeld && this.canGrabSpace())) return
      ev.preventDefault() // suppress the OS autoscroll widget
      ev.stopPropagation()
      this.startPan(ev)
    }, true)
    // X11 pastes the selection on middle-click release; the drag consumed it
    this.scroller.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) ev.preventDefault()
    })
    // A rich-text link on the canvas is content being edited, not a way out:
    // clicking it selects (or, mid-edit, places the caret in) its text box and
    // never opens it — in the editor it would navigate away from unsaved work
    // or spawn a window per click. Only the default action is cancelled, so
    // Selecto and the text edit still see the click. Document-wide because
    // slides are drawn in more places than this scroller (Layout Manager,
    // sorter, outline); present mode opens links itself (present.ts), with
    // window.open, so cancelling the default there costs it nothing.
    const inertLinks = (ev: MouseEvent) => {
      const a = (ev.target as Element | null)?.closest?.('a[href]')
      if (a && a.closest('.beeslides-slide, .beeslides-el')) ev.preventDefault()
    }
    document.addEventListener('click', inertLinks, true)
    document.addEventListener('auxclick', inertLinks, true)

    // Space arms the pan. It is unbound in the editor otherwise, but it DOES
    // page a scroll container by default, so the keydown has to be swallowed
    // while we own it. Never while text is being edited or a panel field has
    // focus — there a space is a space.
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== ' ' || ev.repeat || this.spaceHeld || !this.canGrabSpace()) return
      ev.preventDefault()
      this.spaceHeld = true
      this.scroller.style.cursor = 'grab'
    })
    window.addEventListener('keyup', (ev) => {
      if (ev.key !== ' ' || !this.spaceHeld) return
      this.spaceHeld = false
      if (!this.panning) this.scroller.style.cursor = ''
    })
    // Losing the window with space down would otherwise leave it stuck armed
    window.addEventListener('blur', () => {
      this.spaceHeld = false
      if (!this.panning) this.scroller.style.cursor = ''
    })

    // Control box lives INSIDE the scaled host with rootContainer at body:
    // Moveable then works in slide-local coordinates (e.left/e.top are model
    // px), and `zoom` compensates the handles' visual size (set in relayout).
    this.moveable = new Moveable(this.scaleHost, {
      rootContainer: document.body,
      draggable: true,
      resizable: true,
      rotatable: true,
      origin: false,
      snappable: true,
      snapThreshold: 6,
      snapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
      elementSnapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
      isDisplaySnapDigit: false,
      throttleRotate: 1,
      rotationPosition: 'top',
      renderDirections: ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'],
    })

    this.selecto = new Selecto({
      container: this.scroller,
      dragContainer: this.scroller,
      selectableTargets: ['.beeslides-el[data-el-id]'], // not a zoom tile's nested picture
      selectByClick: true,
      selectFromInside: false,
      // Shift, Ctrl or Cmd (+click / +marquee) adds to / toggles the selection.
      toggleContinueSelect: [['shift'], ['ctrl'], ['meta']],
      // A two-finger pinch (mobile Safari) must not start a marquee — it throws
      // off the selection box and has crashed the page. Only single-touch drags
      // rubber-band; the browser keeps its own gesture.
      dragCondition: (e) => {
        const touches = (e?.inputEvent as TouchEvent | undefined)?.touches
        return !touches || touches.length <= 1
      },
      // Marquee selects only elements it fully contains (clicking still
      // selects whatever is under the cursor via selectByClick).
      hitRate: 100,
    })

    this.wireMoveable()
    this.wireSelecto()

    // Mobile Safari: a two-finger pinch over the canvas zooms the PAGE, which
    // (mid-marquee) throws Selecto's coordinates off and has crashed the page.
    // Swallow multi-touch gestures on the canvas — the editor has its own zoom,
    // and page-pinch-zooming an editor surface is never what you want. Single
    // touch (scroll / marquee) is untouched. Non-passive so preventDefault works.
    const swallowPinch = (ev: TouchEvent) => { if (ev.touches.length > 1) ev.preventDefault() }
    this.scroller.addEventListener('touchstart', swallowPinch, { passive: false })
    this.scroller.addEventListener('touchmove', swallowPinch, { passive: false })

    // Pin the scroller during Moveable gestures: snap guidelines can overflow
    // the stage and grow the scroll area, which made the slide jump around
    // mid-drag. Any scroll while a gesture is live is snapped straight back.
    let lockL = 0
    let lockT = 0
    this.scroller.addEventListener('scroll', () => {
      if (this.gestureActive) {
        this.scroller.scrollLeft = lockL
        this.scroller.scrollTop = lockT
      }
      this.emitViewport()
    }, { passive: true })
    const lockScroll = () => {
      this.gestureActive = true
      for (const fn of this.gestureListeners) fn(true)
      lockL = this.scroller.scrollLeft
      lockT = this.scroller.scrollTop
      // the REAL jump culprit: a scrollbar APPEARING mid-drag (guideline overflow)
      // shrinks the client box and re-centres the stage. If no bar is showing at
      // gesture start, forbid overflow for the drag so one can never appear.
      // (scrollbar-gutter covers the vertical bar; this covers horizontal too.)
      const s = this.scroller
      if (s.scrollHeight <= s.clientHeight && s.scrollWidth <= s.clientWidth) s.style.overflow = 'hidden'
    }
    const unlockScroll = () => {
      this.gestureActive = false
      this.scroller.style.overflow = ''
      if (this.pendingTargetSync) {
        this.pendingTargetSync = false
        this.syncTargets() // re-derives from live store state, not a stale snapshot
      }
      for (const fn of this.gestureListeners) fn(false)
    }
    for (const e of ['dragStart', 'resizeStart', 'rotateStart', 'dragGroupStart', 'resizeGroupStart', 'rotateGroupStart'])
      (this.moveable as unknown as { on: (e: string, f: () => void) => void }).on(e, lockScroll)
    for (const e of ['dragEnd', 'resizeEnd', 'rotateEnd', 'dragGroupEnd', 'resizeGroupEnd', 'rotateGroupEnd'])
      (this.moveable as unknown as { on: (e: string, f: () => void) => void }).on(e, unlockScroll)

    this.pathEditor = new PathEditor(this.scaleHost, store, () => this.syncTargets())
    this.pathEditor.setScaleGetter(() => this.scale)
    this.lineEditor = new LineEditor(this.scaleHost, store)
    this.lineEditor.setScaleGetter(() => this.scale)
    this.bezierEditor = new BezierEditor(this.scaleHost, store)
    this.bezierEditor.setScaleGetter(() => this.scale)
    this.lineEditor.snap = (p) => this.snapPoint(p)
    this.bezierEditor.snap = (p) => this.snapPoint(p)
    document.addEventListener('slidomingo:edit-path', ((ev: CustomEvent) => {
      this.startPathEdit(ev.detail.id)
    }) as EventListener)
    // picture crop (cropmode.ts): the panel / mini toolbar ask with this event
    this.cropMode = new CropMode(this.scaleHost, this.wrap, this.scroller, store, () => this.syncTargets())
    this.tableRange = new TableRange({
      store,
      surface: () => this.surface,
      editCell: (id, r, c) => this.editCellAt(id, r, c),
      editingCell: () => !!this.editingCell,
      commitTextEdit: () => this.commitTextEdit(),
    })
    // capture phase, before Selecto/Moveable change the selection for this press
    window.addEventListener('pointerdown', () => {
      const sel = this.store.selection
      this.selAtPress = sel.length === 1 ? sel[0] : null
    }, true)
    this.cropMode.setScaleGetter(() => this.scale)
    document.addEventListener('slidomingo:crop-image', ((ev: CustomEvent) => {
      this.startCrop(ev.detail.id)
    }) as EventListener)
    // the equation popover: Insert ▸ Equation (no id), the panel, the mini
    // toolbar and the context menu (an id)
    document.addEventListener('slidomingo:edit-math', ((ev: CustomEvent) => {
      this.startMathEdit(ev.detail?.id)
    }) as EventListener)

    document.addEventListener('slidomingo:preview-fx', () => this.previewAnimations())
    document.addEventListener('slidomingo:step-through', () => this.stepThrough())
    // the Presenting / Builds panel sections ask for the chips while they are open
    document.addEventListener('slidomingo:build-focus', ((ev: CustomEvent<boolean>) => {
      if (this.buildBadgesFocus === !!ev.detail) return
      this.buildBadgesFocus = !!ev.detail
      this.updateBuildBadges()
    }) as EventListener)

    this.comments = new CommentsUI(store, this.stage, () => this.scale)

    // Alt/Option-click digs through overlapping elements: first click grabs
    // the topmost, each further alt-click steps one element deeper (wrapping).
    // Capture phase so it wins over Selecto AND Moveable's control-box area,
    // which otherwise swallows clicks over the current selection.
    document.addEventListener('mousedown', (ev) => {
      if (!ev.altKey || ev.button !== 0 || this.pathEditor.active || this.bezierEditor.active) return
      // Alt on a resize/rotate handle means center-scale, not deep-select
      if (ev.target instanceof Element && ev.target.closest('.moveable-control-box')) return
      const r = this.scaleHost.getBoundingClientRect()
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return
      if (ev.target instanceof Element && ev.target.closest('.ed-sidebar, .ed-props, .ed-topbar, .ed-desktop-chrome, .ed-minibar, .ed-math-pop')) return
      ev.preventDefault()
      ev.stopPropagation()
      this.deepSelect((ev.clientX - r.left) / this.scale, (ev.clientY - r.top) / this.scale)
    }, true)

    // Right-click: same target-filtering idiom as the Alt-click block above
    // (capture phase, bounded to the stage, sidebar/props/topbar excluded).
    // The .beeslides-el hit is selected here so the menu built by editor/
    // contextmenu.ts always sees an up-to-date selection; the menu itself
    // has no opinion on what's clickable — that stays in this filter.
    // --- contextmenu block begin (editor/contextmenu.ts hooks in via onContextMenu) ---
    document.addEventListener('contextmenu', (ev) => {
      if (this.pathEditor.active || this.bezierEditor.active || this.editing || this.editingCell) return
      if (ev.target instanceof Element && ev.target.closest('.moveable-control-box, .ed-minibar, .ed-math-pop')) return
      // Bounded to the whole canvas wrap (grey surround included), not just
      // the rendered slide — a right-click on the grey margin is still an
      // "empty canvas" gesture, same as the comment tool treating it as the
      // whole-slide anchor rather than nothing.
      const r = this.wrap.getBoundingClientRect()
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return
      if (ev.target instanceof Element && ev.target.closest('.ed-sidebar, .ed-props, .ed-topbar, .ed-desktop-chrome')) return
      if (!this.onContextMenu) return
      ev.preventDefault()
      // resolveClickTarget (not a raw '.beeslides-el' hit) so a right-click
      // that lands only on locked building-block chrome falls through to
      // whatever real content is behind it, or the empty-canvas menu.
      const elId = this.resolveClickTarget(ev.clientX, ev.clientY)
      if (elId && !this.store.selection.includes(elId)) this.store.select([elId])
      this.pickCellAt(elId, ev.target, 'context')
      const sr = this.scaleHost.getBoundingClientRect()
      const stack = this.hitStack((ev.clientX - sr.left) / this.scale, (ev.clientY - sr.top) / this.scale, { includeHidden: true })
      this.onContextMenu(elId, ev.clientX, ev.clientY, stack)
    }, true)
    // --- contextmenu block end ---

    // --- format painter block begin (editor/formatpainter.ts owns capture/apply) ---
    // Same capture-phase, .beeslides-el-hit, sidebar/props/topbar-excluded idiom as
    // the Alt-click and context-menu blocks above — but unlike the one-shot
    // comment tool, this STAYS ARMED across clicks (PowerPoint's paint-many
    // feel): only Esc or arming/disarming again ends it. This class owns the
    // click capture only; editor/formatpainter.ts owns what a click DOES
    // (capture a style bag on the first hit, apply it on every hit after).
    document.addEventListener('mousedown', (ev) => {
      if (!this.formatPaintCleanup) return
      if (ev.button !== 0 || this.pathEditor.active || this.bezierEditor.active) return
      if (ev.target instanceof Element && ev.target.closest('.moveable-control-box')) return
      const r = this.wrap.getBoundingClientRect()
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return
      if (ev.target instanceof Element && ev.target.closest('.ed-sidebar, .ed-props, .ed-topbar, .ed-desktop-chrome')) return
      const hitEl = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.beeslides-el') : null
      if (!hitEl?.dataset.elId) return
      ev.preventDefault()
      ev.stopPropagation()
      this.onFormatPaintClick?.(hitEl.dataset.elId)
    }, true)
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return
      if (this.formatPaintCleanup) this.disarmFormatPaint()
      if (this.reapplyChangeCleanup) this.disarmReapplyChange()
    }, true)
    // --- format painter block end ---

    // --- reapply-change block begin (editor/reapplychange.ts owns capture/apply) ---
    // Same capture-phase, .beeslides-el-hit, sidebar/props/topbar-excluded,
    // stay-armed-across-clicks idiom as the format painter block above — a
    // separate armed mode (its own cleanup flag) so the two tools never fight
    // over the same click.
    document.addEventListener('mousedown', (ev) => {
      if (!this.reapplyChangeCleanup) return
      if (ev.button !== 0 || this.pathEditor.active || this.bezierEditor.active) return
      if (ev.target instanceof Element && ev.target.closest('.moveable-control-box')) return
      const r = this.wrap.getBoundingClientRect()
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return
      if (ev.target instanceof Element && ev.target.closest('.ed-sidebar, .ed-props, .ed-topbar, .ed-desktop-chrome')) return
      const hitEl = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.beeslides-el') : null
      if (!hitEl?.dataset.elId) return
      ev.preventDefault()
      ev.stopPropagation()
      this.onReapplyChangeClick?.(hitEl.dataset.elId)
    }, true)
    // --- reapply-change block end ---

    this.stage.addEventListener('dblclick', (ev) => {
      // Look for TextElement, and then CodeElement
      const selectors = [
        '.beeslides-el-text',
        '.beeslides-el-code'
      ]
      var textEl: HTMLElement | null = null
      for (const selector of selectors) {
        textEl = (ev.target as HTMLElement).closest<HTMLElement>(selector)
        if (textEl) break
      }
      if (textEl) { this.startTextEdit(textEl); return }
      const eq = (ev.target as HTMLElement).closest<HTMLElement>('.beeslides-el-math')
      if (eq?.dataset.elId && eq.closest('.ed-stage-scale')) { this.startMathEdit(eq.dataset.elId); return }
      const td = (ev.target as HTMLElement).closest<HTMLElement>('.beeslides-el-table td[data-c]')
      if (td) { this.editCellFromTd(td); return }
      const pic = (ev.target as HTMLElement).closest<HTMLElement>('.beeslides-el-image')
      if (pic?.dataset.elId && !this.cropMode.engaged) this.startCrop(pic.dataset.elId)
    })

    new ResizeObserver(() => this.relayout()).observe(wrap)

    store.on('current', () => this.render())
    store.on('doc', () => {
      this.docEpoch++
      if (inLiveStep()) this.liveRender.schedule()
      else this.render('patch')
    })
    store.on('look', () => this.render())
    // with a live redraw still waiting, the selection syncs against the new
    // surface — render() runs syncTargets itself
    store.on('selection', () => (this.liveRender.pending ? this.render('patch') : this.syncTargets()))
    // while shapes are dragged, show them as drawn: the styled picture would lag behind
    this.gestureListeners.add((on) => this.scaleHost.classList.toggle('ed-lookview-live', on))

    this.render()
  }

  // --- panning ----------------------------------------------------------------

  /**
   * Is space free to mean "pan" right now? Not while any text is being edited
   * on the canvas, and not while a panel field, the title or any other input
   * has focus — in all of those a space is a character the user typed.
   */
  private canGrabSpace(): boolean {
    if (this.editing || this.editingCell || this.isPathEditing) return false
    const el = document.activeElement as HTMLElement | null
    if (!el) return true
    if (el.isContentEditable) return false
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
    // Space ACTIVATES a focused button (panel section headers, toolbar
    // buttons) — swallowing it here would make them mouse-only.
    return !el.closest('button, [role="button"], summary, a[href]')
  }

  /**
   * Drag the canvas from wherever it is now. Shared by both gestures so they
   * cannot drift apart.
   *
   * The move/up listeners live on `window`: a pan that stops the moment the
   * pointer crosses the panel edge would be useless precisely when panning
   * matters, which is when the slide is bigger than the viewport.
   */
  private startPan(ev: MouseEvent) {
    const fromX = ev.clientX
    const fromY = ev.clientY
    const atLeft = this.scroller.scrollLeft
    const atTop = this.scroller.scrollTop
    this.panning = true
    this.scroller.style.cursor = 'grabbing'
    const move = (m: MouseEvent) => {
      this.scroller.scrollLeft = atLeft - (m.clientX - fromX)
      this.scroller.scrollTop = atTop - (m.clientY - fromY)
    }
    const up = () => {
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('mouseup', up, true)
      this.panning = false
      // still armed if space is down, so keep the open hand rather than reset
      this.scroller.style.cursor = this.spaceHeld ? 'grab' : ''
    }
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', up, true)
  }

  // --- layout & rendering ---------------------------------------------------

  relayout() {
    const { width, height } = effectiveCanvasSize(this.store)
    const availW = this.scroller.clientWidth - 64
    const availH = this.scroller.clientHeight - 64
    if (availW <= 0 || availH <= 0) return
    this.fitScale = Math.min(availW / width, availH / height)
    this.scale = this.fitScale * this.zoom
    this.stage.style.width = `${width * this.scale}px`
    this.stage.style.height = `${height * this.scale}px`
    // Pan room. Scrolling used to stop dead at the slide's edges, so at high
    // zoom a corner element could never be moved off the corner of the screen
    // to be worked on. Half a viewport of padding once the stage outgrows the
    // window is exactly enough for any point on the slide to reach the middle.
    //
    // None at all while the whole slide fits: padding there would put
    // scrollbars on a view that needs none, and — because the plain-wheel
    // slide-nav stands down whenever the canvas is pannable — would silently
    // cost the wheel gesture that walks slides. clientWidth is the padding
    // box, so writing padding here cannot disturb the fitScale computed above.
    const padX = width * this.scale > availW ? Math.round(this.scroller.clientWidth / 2) : 0
    const padY = height * this.scale > availH ? Math.round(this.scroller.clientHeight / 2) : 0
    // Changing the pan room moves the stage within the scroll canvas by exactly
    // that much, so changing it without compensating TELEPORTS the view. The
    // first relayout that turns padding on leaves the scroll at 0 — which is now
    // half a viewport of empty canvas, with the slide shoved off to the side and
    // clipped. setZoom re-centres afterwards and hid this; every OTHER route in
    // (opening a deck whose stage already overflows, a window resize, toggling a
    // panel) does not. Reported on a 1600x900 deck, whose stage outgrows the
    // canvas at ordinary zooms where the 1280x720 default still fits.
    const wasX = parseFloat(this.scroller.style.paddingLeft) || 0
    const wasY = parseFloat(this.scroller.style.paddingTop) || 0
    this.scroller.style.padding = padX || padY ? `${padY}px ${padX}px` : ''
    if (padX !== wasX) this.scroller.scrollLeft += padX - wasX
    if (padY !== wasY) this.scroller.scrollTop += padY - wasY
    this.scaleHost.style.transform = `scale(${this.scale})`
    this.moveable.zoom = 1 / this.scale
    // Moveable measures snap distance in slide px; keep it SNAP_SCREEN_PX on screen at any zoom
    const reach = SNAP_SCREEN_PX / this.scale
    this.moveable.snapThreshold = reach
    this.moveable.snapHorizontalThreshold = reach
    this.moveable.snapVerticalThreshold = reach
    this.moveable.updateRect()
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`
    this.comments?.refresh()
    this.updateSafeZone()
    this.updateGrid()
    this.updateKeyline()
    this.refreshSnap()
    this.updateBuildBadges()
    if (this.cropMode?.active) this.cropMode.draw()
    this.emitViewport()
  }

  // --- floating-chrome hooks (the mini toolbar) -------------------------------

  /**
   * Notified whenever the selection's on-screen box may have moved: zoom or
   * resize (relayout), scroll, or a re-sync of the selection targets (which
   * follows every selection change, render, text/path edit start and stop).
   * Returns an unsubscribe function.
   */
  onViewportChange(fn: () => void): () => void {
    this.viewportListeners.add(fn)
    return () => this.viewportListeners.delete(fn)
  }

  private emitViewport() {
    for (const fn of this.viewportListeners) fn()
  }

  /** Notified when a Moveable drag/resize/rotate gesture starts (true) and
   *  ends (false). */
  onGesture(fn: (active: boolean) => void): () => void {
    this.gestureListeners.add(fn)
    return () => this.gestureListeners.delete(fn)
  }

  /** Notified when inline text (or table-cell) editing starts (with the
   *  element id) and stops (undefined). */
  onTextEditChange(fn: (elId: string | undefined) => void): () => void {
    this.textEditListeners.add(fn)
    return () => this.textEditListeners.delete(fn)
  }

  private emitTextEdit(elId: string | undefined) {
    for (const fn of this.textEditListeners) fn(elId)
  }

  /**
   * The selection's box on screen, in client coordinates: the union of the
   * selected elements' rendered boxes (rotation included, since it reads the
   * transformed DOM). Null when nothing selected is rendered on this surface.
   */
  selectionRect(): DOMRect | null {
    if (!this.surface) return null
    const ids = new Set(this.store.selection)
    if (!ids.size) return null
    let l = Infinity, tp = Infinity, r = -Infinity, b = -Infinity
    for (const n of this.surface.querySelectorAll<HTMLElement>('.beeslides-el[data-el-id]')) {
      if (!n.dataset.elId || !ids.has(n.dataset.elId)) continue
      const rc = n.getBoundingClientRect()
      if (!rc.width && !rc.height) continue // display:none (another hover set)
      l = Math.min(l, rc.left); tp = Math.min(tp, rc.top)
      r = Math.max(r, rc.right); b = Math.max(b, rc.bottom)
    }
    return l === Infinity ? null : new DOMRect(l, tp, r - l, b - tp)
  }

  /** The visible canvas area (the scroller's box), in client coordinates. */
  viewportRect(): DOMRect {
    return this.scroller.getBoundingClientRect()
  }

  get isGestureActive() {
    return this.gestureActive
  }

  // --- safe-zone margin guide -------------------------------------------------

  /** Whether the safe-zone overlay is currently shown. */
  get showSafeZone() {
    return this.safeZoneOn
  }

  setSafeZone(on: boolean) {
    if (this.safeZoneOn === on) return
    this.safeZoneOn = on
    lsSet(SAFE_ZONE_KEY, on ? 'on' : 'off')
    this.updateSafeZone()
  }

  /** Apply the Grid & Snap preference (gridpref.ts) with the active grid
   *  step in model px (0 = no grid): the drawing grid, the layout-grid and
   *  guide layers, and every snap target Moveable and the point tools use.
   *  All visual layers live in `scaleHost` like the safe zone — never part of
   *  an export. */
  setGridPref(pref: GridPref, stepPx: number) {
    this.gridPref = pref
    this.gridStep = stepPx > 0 ? stepPx : 0
    this.updateGrid()
    this.refreshSnap()
  }

  get gridOn(): boolean { return this.gridStep > 0 }

  /** The grid step points and drags snap to (0 when the grid is hidden or its Snap box is off). */
  private get gridSnapStep(): number {
    return this.gridPref.snap.grid ? this.gridStep : 0
  }

  /** Snap a point (drawing, line/curve points): the nearest guide, column or
   *  margin line within a few screen px, else the grid. `free` (⌥) skips it. */
  snapPoint(p: { x: number; y: number }, free = false): { x: number; y: number } {
    if (free) return p
    return snapPoint(p, this.snapLines, SNAP_SCREEN_PX / (this.scale || 1), this.gridSnapStep)
  }

  private get pageless(): boolean {
    return this.store.editingSurface?.kind === 'reusableObject'
  }

  /** Re-derive the magnetic lines and the layers that show them; call after
   *  anything they depend on changes (preference, doc guides/layout grid,
   *  safe zone, surface). Cheap — a few dozen numbers. */
  private refreshSnap() {
    this.snapLines = staticSnapLines(this.store.doc, this.gridPref, { pageless: this.pageless })
    const mv = this.moveable
    const step = this.gridSnapStep
    if (mv.snapGridWidth !== step) { mv.snapGridWidth = step; mv.snapGridHeight = step }
    const same = (a: unknown, b: number[]) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])
    if (!same(mv.verticalGuidelines, this.snapLines.x)) mv.verticalGuidelines = this.snapLines.x
    if (!same(mv.horizontalGuidelines, this.snapLines.y)) mv.horizontalGuidelines = this.snapLines.y
    if (mv.snapGap !== this.gridPref.snap.objects) mv.snapGap = this.gridPref.snap.objects
    this.updateLayoutGrid()
    this.updateGuides()
  }

  private updateGrid() {
    if (!this.gridStep || this.pageless) {
      this.gridLayer?.remove()
      this.gridLayer = null
      return
    }
    if (!this.gridLayer) {
      const layer = document.createElement('div')
      layer.className = 'ed-grid'
      layer.setAttribute('aria-hidden', 'true')
      this.gridLayer = layer
    }
    this.scaleHost.appendChild(this.gridLayer)
    const { width, height } = this.store.doc.size
    const inv = 1 / (this.scale || 1) // a hairline at any zoom
    const line = `rgba(40,90,200,0.22)`
    const g = this.gridLayer.style
    g.width = `${width}px`
    g.height = `${height}px`
    g.backgroundImage =
      `linear-gradient(to right, ${line} ${inv}px, transparent ${inv}px),` +
      `linear-gradient(to bottom, ${line} ${inv}px, transparent ${inv}px)`
    g.backgroundSize = `${this.gridStep}px ${this.gridStep}px`
  }

  /** The deck's layout grid as tinted column (and row) bands inside dashed
   *  margins — shown while `showLayout` is on and the doc has one. */
  private updateLayoutGrid() {
    const grid = normalizeLayoutGrid(this.store.doc.layoutGrid, this.store.doc.size)
    if (!grid || !this.gridPref.showLayout || this.pageless) {
      this.layoutLayer?.remove()
      this.layoutLayer = null
      return
    }
    if (!this.layoutLayer) {
      this.layoutLayer = document.createElement('div')
      this.layoutLayer.className = 'ed-layoutgrid'
      this.layoutLayer.setAttribute('aria-hidden', 'true')
    }
    const layer = this.layoutLayer
    if (layer.parentNode !== this.scaleHost) this.scaleHost.appendChild(layer)
    const size = this.store.doc.size
    const { columns, rows } = layoutTracks(grid, size)
    const inv = 1 / (this.scale || 1)
    layer.style.width = `${size.width}px`
    layer.style.height = `${size.height}px`
    layer.style.setProperty('--lg-line', `${inv}px`)
    const band = (cls: string, x: number, y: number, w: number, h: number) =>
      `<div class="${cls}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`
    const cw = size.width - 2 * grid.marginX
    const ch = size.height - 2 * grid.marginY
    layer.innerHTML =
      band('ed-lg-content', grid.marginX, grid.marginY, cw, ch) +
      columns.map((c) => band('ed-lg-col', c.start, grid.marginY, c.size, ch)).join('') +
      rows.map((r) => band('ed-lg-row', grid.marginX, r.start, cw, r.size)).join('')
  }

  /** Guides: a hairline per `doc.guides` entry with a wider grab strip — drag
   *  to move (it snaps like an edge), drag off the slide to remove — plus two
   *  strips just outside the slide's top and left edges to drag NEW guides out
   *  of, ruler-style. Shown while `showGuides` is on. */
  private updateGuides() {
    if (!this.gridPref.showGuides || this.pageless) {
      this.guidesLayer?.remove()
      this.guidesLayer = null
      return
    }
    if (!this.guidesLayer) {
      this.guidesLayer = document.createElement('div')
      this.guidesLayer.className = 'ed-guides'
    }
    const layer = this.guidesLayer
    if (layer.parentNode !== this.scaleHost) this.scaleHost.appendChild(layer)
    const size = this.store.doc.size
    const inv = 1 / (this.scale || 1)
    layer.style.width = `${size.width}px`
    layer.style.height = `${size.height}px`
    layer.style.setProperty('--gd-inv', String(inv))
    layer.replaceChildren()
    const g = normalizeGuides(this.store.doc.guides, size)
    const make = (axis: 'x' | 'y', pos: number | null): HTMLElement => {
      const n = document.createElement('div')
      n.className = pos === null ? `ed-guide-ruler ed-guide-ruler-${axis}` : `ed-guide ed-guide-${axis}`
      if (pos !== null) this.placeGuide(n, axis, pos)
      n.title = pos === null
        ? (axis === 'x' ? t('Drag right to add a vertical guide') : t('Drag down to add a horizontal guide'))
        : t('Drag to move this guide — drag it off the slide to remove it')
      n.addEventListener('pointerdown', (ev) => this.startGuideDrag(ev, n, axis, pos))
      layer.appendChild(n)
      return n
    }
    for (const x of g.x) make('x', x)
    for (const y of g.y) make('y', y)
    if (!this.store.readOnly) { make('x', null); make('y', null) }
  }

  private placeGuide(n: HTMLElement, axis: 'x' | 'y', pos: number) {
    if (axis === 'x') n.style.left = `${pos}px`
    else n.style.top = `${pos}px`
  }

  /** Move (or, from a ruler strip, create) a guide. One commit on release —
   *  none when it ends where it began; off the slide removes it. */
  private startGuideDrag(ev: PointerEvent, node: HTMLElement, axis: 'x' | 'y', from: number | null) {
    if (ev.button !== 0 || this.store.readOnly) return
    // preventDefault on pointerdown also suppresses the compatibility
    // mousedown, so Selecto never starts a marquee and Alt-deep-select never runs
    ev.preventDefault()
    ev.stopPropagation()
    let guide = node
    if (from === null) {
      guide = document.createElement('div')
      guide.className = `ed-guide ed-guide-${axis} ed-guide-new`
      this.guidesLayer?.appendChild(guide)
    }
    guide.classList.add('ed-guide-dragging')
    const tip = document.createElement('div')
    tip.className = 'ed-guide-tip'
    guide.appendChild(tip)
    const limit = axis === 'x' ? this.store.doc.size.width : this.store.doc.size.height
    let pos = from ?? -1
    const at = (e: PointerEvent) => {
      const r = this.scaleHost.getBoundingClientRect()
      const raw = axis === 'x' ? (e.clientX - r.left) / this.scale : (e.clientY - r.top) / this.scale
      if (e.altKey) return Math.round(raw * 10) / 10
      const p = this.snapPoint(axis === 'x' ? { x: raw, y: 0 } : { x: 0, y: raw })
      const v = axis === 'x' ? p.x : p.y
      // without a grid, whole px; also catch the slide's center
      const mid = limit / 2
      if (Math.abs(raw - mid) <= SNAP_SCREEN_PX / this.scale) return mid
      return v === raw ? Math.round(raw) : v
    }
    const unit = this.store.doc.kind === 'figure' ? (this.store.doc.figure?.unit ?? 'mm') : this.gridPref.unit
    const move = (e: PointerEvent) => {
      pos = at(e)
      this.placeGuide(guide, axis, pos)
      const out = pos < 0 || pos > limit
      guide.classList.toggle('ed-guide-out', out)
      tip.textContent = out ? t('Remove') : formatLength(pos, unit)
    }
    const up = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      const out = pos < 0 || pos > limit
      if (from === null && out) { this.updateGuides(); return }
      if (from !== null && !out && Math.abs(pos - from) < 0.05) { this.updateGuides(); return }
      this.store.commit(() => setGuide(this.store.doc, axis, from, out ? null : pos))
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    move(ev)
  }

  /** Add guides at slide px (deduplicated), one undo step. */
  addGuides(xs: number[], ys: number[]) {
    if (!xs.length && !ys.length) return
    this.store.commit(() => {
      for (const x of xs) setGuide(this.store.doc, 'x', null, x)
      for (const y of ys) setGuide(this.store.doc, 'y', null, y)
    })
  }

  toggleSafeZone() {
    this.setSafeZone(!this.safeZoneOn)
  }

  // --- click-build step badges --------------------------------------------------

  get showBuildBadges() { return this.buildBadgesOn }

  setBuildBadges(on: boolean) {
    if (this.buildBadgesOn === on) return
    this.buildBadgesOn = on
    lsSet(BUILD_BADGES_KEY, on ? 'on' : 'off')
    this.updateBuildBadges()
  }

  toggleBuildBadges() { this.setBuildBadges(!this.buildBadgesOn) }

  /**
   * A small numbered chip at each build element's top-left corner: `2` = it
   * arrives on click 2, `↘3` = it leaves on click 3, `1–3` = a paragraph run.
   * A purely visual layer in `scaleHost` like the safe zone — positioned in
   * slide px and counter-scaled so it reads at one size at any zoom; never
   * part of the document or an export (`.ed-capturing` hides it).
   */
  private updateBuildBadges() {
    const slide = this.store.slide
    const plan = this.buildBadgesOn || this.buildBadgesFocus ? buildPlan(slide) : null
    if (!plan || !plan.steps.length || this.store.editingSurface?.kind === 'reusableObject' || this.stepping) {
      this.buildBadgeLayer?.remove()
      this.buildBadgeLayer = null
      return
    }
    if (!this.buildBadgeLayer) {
      const layer = document.createElement('div')
      layer.className = 'ed-buildbadges'
      layer.setAttribute('aria-hidden', 'true')
      this.buildBadgeLayer = layer
    }
    const layer = this.buildBadgeLayer
    this.scaleHost.appendChild(layer) // last, so it sits above the slide
    layer.textContent = ''
    const inv = 1 / (this.scale || 1)
    for (const el of slide.elements) {
      const { enter, exit } = stepsOf(plan, el.id)
      if (!enter && !exit) continue
      const paras = plan.steps.flatMap((s, i) => s.enter.filter((t) => t.elId === el.id && t.para !== undefined).map(() => i + 1))
      const parts: string[] = []
      if (paras.length > 1) parts.push(`${Math.min(...paras)}–${Math.max(...paras)}`)
      else if (enter) parts.push(String(enter))
      if (exit) parts.push(`↘${exit}`)
      const chip = document.createElement('div')
      chip.className = 'ed-buildbadge' + (this.store.selection.includes(el.id) ? ' sel' : '')
      chip.textContent = parts.join(' ')
      chip.style.left = `${el.x}px`
      chip.style.top = `${el.y}px`
      chip.style.transform = `translate(-30%, -60%) scale(${inv})`
      layer.appendChild(chip)
    }
  }

  /** Toggle the reusable-object canvas's visual content-space grid (a CSS
   *  background on `.ed-stage-scale`, so it pans/zooms with the content —
   *  unlike `.ed-canvas-wrap`'s ambient dot backdrop, which is fixed to the
   *  viewport). Driven by layoutmanager.ts's syncSurface() alongside
   *  entering/leaving that editing surface. */
  setObjectGrid(on: boolean) {
    this.scaleHost.classList.toggle('ed-objectgrid', on)
  }

  /**
   * Purely visual margin guide, inset from the slide edges by the SAME
   * scaled margin `validate.ts`'s 'past-margin' check uses (`marginFor`) — a
   * single source of truth, so the drawn guide and the linter finding can
   * never disagree about where the margin falls. Lives inside `scaleHost`
   * so it is positioned in slide-local px and rides the CSS `scale()`
   * transform for free — no re-derivation needed when `doc.size` differs
   * from the 1280-wide reference case. Never affects Moveable's snap
   * targets (not added to `elementGuidelines`) and carries no document
   * content of its own.
   */
  private updateSafeZone() {
    // The margin-guide concept doesn't apply to a free-floating reusable
    // object (no page to stay inside of) — force-hide unconditionally
    // rather than teaching marginFor() about a surface it has no opinion on.
    if (!this.safeZoneOn || this.store.editingSurface?.kind === 'reusableObject') {
      this.safeZoneLayer?.remove()
      this.safeZoneLayer = null
      return
    }
    if (!this.safeZoneLayer) {
      const layer = document.createElement('div')
      layer.className = 'ed-safezone'
      layer.setAttribute('aria-hidden', 'true')
      this.safeZoneLayer = layer
    }
    // Kept last in scaleHost so it sits above the rendered slide.
    this.scaleHost.appendChild(this.safeZoneLayer)
    const { width, height } = this.store.doc.size
    const margin = marginFor(this.store.doc)
    const w = Math.max(0, width - margin * 2)
    // Only the SIDE margins are drawn: they are what the 'past-margin' check
    // tests (validate.ts), so the guide never promises more than Check slides
    // enforces. Full height, with the outside bands tinted via ::before/::after.
    // counter-scale the border so it reads at a constant visual thickness
    // regardless of zoom.
    const inv = 1 / (this.scale || 1)
    this.safeZoneLayer.style.left = `${margin}px`
    this.safeZoneLayer.style.top = '0px'
    this.safeZoneLayer.style.width = `${w}px`
    this.safeZoneLayer.style.height = `${height}px`
    this.safeZoneLayer.style.setProperty('--sz-margin', `${margin}px`)
    this.safeZoneLayer.style.borderWidth = `0 ${1.5 * inv}px`
  }

  /** Icon sets: the padding square and the circle inside it, the guides icon
   *  designers keep shapes on (`iconset.style.padding`). Editor-only, like the
   *  safe zone; hidden from agent screenshots (`.ed-capturing`). */
  private updateKeyline() {
    const info = iconsetInfo(this.store.doc)
    if (!info || this.pageless) {
      this.keylineLayer?.remove()
      this.keylineLayer = null
      return
    }
    if (!this.keylineLayer) {
      this.keylineLayer = document.createElement('div')
      this.keylineLayer.className = 'ed-keyline'
      this.keylineLayer.setAttribute('aria-hidden', 'true')
    }
    this.scaleHost.appendChild(this.keylineLayer)
    const { width, height } = this.store.doc.size
    const g = info.grid, gh = info.gridH, p = Math.min(Math.max(info.style.padding, 0), Math.min(g, gh) / 2)
    const inv = 1 / (this.scale || 1)
    const svgNs = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgNs, 'svg')
    svg.setAttribute('viewBox', `0 0 ${g} ${gh}`)
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    const sw = String(inv / info.scale)
    const add = (tag: string, attrs: Record<string, string | number>) => {
      const n = document.createElementNS(svgNs, tag)
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
      n.setAttribute('fill', 'none')
      n.setAttribute('stroke-width', sw)
      svg.appendChild(n)
    }
    add('rect', { x: p, y: p, width: g - 2 * p, height: gh - 2 * p })
    add('circle', { cx: g / 2, cy: gh / 2, r: Math.min(g, gh) / 2 - p })
    this.keylineLayer.replaceChildren(svg)
  }

  // --- zoom ------------------------------------------------------------------

  /** `anchor` (a wheel/pinch event) keeps the slide point under the pointer
   *  fixed on screen; without it (buttons, ⌘±) the view re-centres. */
  setZoom(zoom: number, anchor?: { clientX: number; clientY: number }) {
    const before = anchor ? this.scaleHost.getBoundingClientRect() : null
    const px = before ? (anchor!.clientX - before.left) / this.scale : 0
    const py = before ? (anchor!.clientY - before.top) / this.scale : 0
    this.zoom = Math.min(Math.max(zoom, 0.5), 8)
    this.relayout()
    if (before) {
      // the browser clamps scrollLeft/Top, so a slide that fits just stays centred
      const after = this.scaleHost.getBoundingClientRect()
      this.scroller.scrollLeft += after.left + px * this.scale - anchor!.clientX
      this.scroller.scrollTop += after.top + py * this.scale - anchor!.clientY
      return
    }
    // keep the view centred on the slide as it grows/shrinks
    this.scroller.scrollLeft = (this.scroller.scrollWidth - this.scroller.clientWidth) / 2
    this.scroller.scrollTop = (this.scroller.scrollHeight - this.scroller.clientHeight) / 2
  }

  zoomIn() { this.setZoom(this.zoom * 1.25) }
  zoomOut() { this.setZoom(this.zoom / 1.25) }
  zoomReset() { this.setZoom(1) }

  private buildZoomBar() {
    const bar = document.createElement('div')
    bar.className = 'ed-zoombar'
    const mk = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.className = 'ed-zoombtn'
      b.textContent = label
      b.title = title
      b.addEventListener('click', onClick)
      return b
    }
    const label = mk('100%', t('Reset zoom to fit'), () => this.zoomReset())
    label.classList.add('ed-zoomlabel')
    this.zoomLabel = label
    bar.append(
      mk('−', t('Zoom out'), () => this.zoomOut()),
      label,
      mk('+', t('Zoom in'), () => this.zoomIn()),
    )
    this.wrap.appendChild(bar)
  }

  /** notified when the comment tool arms/disarms (topbar button state) */
  onCommentModeChange: ((on: boolean) => void) | null = null
  onSlideNav: ((dir: 1 | -1) => void) | null = null
  /** right-click inside the canvas: elId is the .beeslides-el hit (already
   *  selected before this fires), or null for an empty-canvas click. Client
   *  coords, same as every other pointer callback here. */
  /** `stack` = every element under the pointer, top first (hidden and
   *  user-locked included) — feeds the menu's "Select" block. */
  onContextMenu: ((elId: string | null, clientX: number, clientY: number, stack: SlideElement[]) => void) | null = null
  /** notified on each click while the format-painter tool is armed (see the
   *  "format painter block" in the constructor for the click-capture side) */
  onFormatPaintClick: ((elId: string) => void) | null = null
  /** notified when the format-painter tool arms/disarms (topbar button state) */
  onFormatPaintModeChange: ((on: boolean) => void) | null = null
  private formatPaintCleanup: (() => void) | null = null
  /** notified on each click while the reapply-change tool is armed (see the
   *  "reapply-change block" in the constructor for the click-capture side) */
  onReapplyChangeClick: ((elId: string) => void) | null = null
  /** notified when the reapply-change tool arms/disarms (topbar button state) */
  onReapplyChangeModeChange: ((on: boolean) => void) | null = null
  private reapplyChangeCleanup: (() => void) | null = null
  /** notified when a click resolves to nothing but every raw hit underneath
   *  was a locked (Slide-type sub-editor) building-block element — i.e. the
   *  user clicked something they can see but can't select here. */
  onLockedElementClick: (() => void) | null = null
  private wheelNavAccum = 0
  private wheelNavCooldown = 0
  private commentCleanup: (() => void) | null = null

  refreshComments() { this.comments?.refresh() }
  /** open thread `id` on the current slide (call after switching to its slide) */
  openCommentThread(id: string) { this.comments?.refresh(); this.comments?.openThreadById(id) }

  get isCommentMode() {
    return !!this.commentCleanup
  }

  /**
   * The unified comment tool. Armed: the next canvas click anchors a new
   * thread — on the ELEMENT under the cursor when there is one, else at
   * that POINT of the slide. Capture phase (Selecto/Moveable never see the
   * click); Esc or toggling again disarms.
   */
  /** Where a comment click at these client coords would anchor.
   *  Near-full-slide elements (photos, scrims) don't capture — a comment
   *  "here" on scenery means the spot, not the backdrop object. */
  private commentAnchorAt(clientX: number, clientY: number): { x: number; y: number; el?: SlideElement } | null {
    const r = this.scaleHost.getBoundingClientRect()
    const x = Math.round((clientX - r.left) / this.scale)
    const y = Math.round((clientY - r.top) / this.scale)
    const { width, height } = this.store.doc.size
    if (x < 0 || y < 0 || x > width || y > height) return null
    let hit: SlideElement | undefined
    for (const el of this.store.slide.elements) {
      if (x < el.x || x > el.x + el.w || y < el.y || y > el.y + el.h) continue
      if (this.isBackdrop(el)) continue
      const node = this.scaleHost.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (node && node.style.display !== 'none') hit = el
    }
    return { x, y, el: hit }
  }

  /** Client rect of a comment anchor (element frame, area, or a zero-size
   *  point) — where the composer card and pending marker go. */
  private commentAnchorRect(elId?: string, box?: { x: number; y: number; w?: number; h?: number }):
    { left: number; top: number; right: number; bottom: number } | undefined {
    const el = elId ? this.store.slide.elements.find((e) => e.id === elId) : undefined
    const f = el ? { x: el.x, y: el.y, w: el.w, h: el.h } : box ? { x: box.x, y: box.y, w: box.w ?? 0, h: box.h ?? 0 } : undefined
    if (!f) return undefined
    const r = this.scaleHost.getBoundingClientRect()
    return {
      left: r.left + f.x * this.scale, top: r.top + f.y * this.scale,
      right: r.left + (f.x + f.w) * this.scale, bottom: r.top + (f.y + f.h) * this.scale,
    }
  }

  /** Open a new comment thread without arming the crosshair tool — the
   *  context menu's "Add comment" already knows what was clicked. Pass an
   *  element id, or client coords for a point/whole-slide anchor (same
   *  resolution as toggleCommentMode's live preview). */
  addCommentAt(elId?: string, clientPoint?: { x: number; y: number }) {
    if (elId) { void this.comments.openNew(elId, undefined, undefined, this.commentAnchorRect(elId)); return }
    if (clientPoint) {
      const a = this.commentAnchorAt(clientPoint.x, clientPoint.y)
      if (!a) void this.comments.openNew()
      else void this.comments.openNew(a.el?.id, a.el ? undefined : { x: a.x, y: a.y }, undefined, this.commentAnchorRect(a.el?.id, a.el ? undefined : a))
      return
    }
    void this.comments.openNew()
  }

  toggleCommentMode() {
    if (this.commentCleanup) {
      this.commentCleanup()
      return
    }
    // A selection is the obvious target: comment on it right away instead of
    // making the user pick it again. One element anchors to it; several anchor
    // to an AREA around all of them (a thread has a single element anchor).
    // Nothing selected = ambiguous, so fall through to the crosshair.
    const sel = this.store.selection
    if (!this.store.editingSurface) {
      const picked = this.store.slide.elements.filter((e) => sel.includes(e.id))
      if (picked.length === 1) {
        this.addCommentAt(picked[0].id)
        return
      }
      if (picked.length > 1) {
        const x1 = Math.min(...picked.map((e) => e.x))
        const y1 = Math.min(...picked.map((e) => e.y))
        const area = {
          x: Math.round(x1),
          y: Math.round(y1),
          w: Math.round(Math.max(...picked.map((e) => e.x + e.w)) - x1),
          h: Math.round(Math.max(...picked.map((e) => e.y + e.h)) - y1),
        }
        void this.comments.openNew(undefined, { x: area.x, y: area.y }, area, this.commentAnchorRect(undefined, area))
        return
      }
    }
    this.wrap.style.cursor = 'crosshair' // the whole canvas area, grey included
    // live feedback: an amber outline over the element the comment would
    // anchor to, a pin-dot + coordinates where the point would land, or the
    // whole-slide outline plus a cursor-following chip out on the grey
    const hl = document.createElement('div')
    hl.className = 'ed-comment-hl'
    this.stage.appendChild(hl)
    const chip = document.createElement('div')
    chip.className = 'ed-comment-chip'
    chip.textContent = t('💬 whole slide')
    chip.style.display = 'none'
    this.stage.appendChild(chip)
    const cleanup = (keepHl = false) => {
      this.commentCleanup = null
      this.wrap.style.cursor = ''
      if (!keepHl) hl.remove()
      chip.remove()
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('keydown', onKey, true)
      this.onCommentModeChange?.(false)
      this.emitViewport() // floating chrome hides while a click tool is armed
    }
    const onMove = (ev: MouseEvent) => {
      const inWrap = ev.target instanceof Element && !!ev.target.closest('.ed-canvas-wrap')
      const a = inWrap ? this.commentAnchorAt(ev.clientX, ev.clientY) : null
      if (!inWrap) {
        hl.style.display = 'none'
        chip.style.display = 'none'
        return
      }
      hl.style.display = ''
      if (!a) {
        // on the canvas but off the slide: the WHOLE SLIDE is the anchor.
        // Outline the slide AND pin a chip to the cursor — that's where the
        // user is looking.
        const { width, height } = this.store.doc.size
        hl.className = 'ed-comment-hl slide'
        hl.style.left = '-3px'
        hl.style.top = '-3px'
        hl.style.width = `${width * this.scale + 6}px`
        hl.style.height = `${height * this.scale + 6}px`
        hl.textContent = ''
        const stageR = this.stage.getBoundingClientRect()
        chip.style.display = ''
        chip.style.left = `${ev.clientX - stageR.left + 14}px`
        chip.style.top = `${ev.clientY - stageR.top + 6}px`
        return
      }
      chip.style.display = 'none'
      if (a.el) {
        hl.className = 'ed-comment-hl element'
        hl.style.left = `${a.el.x * this.scale - 3}px`
        hl.style.top = `${a.el.y * this.scale - 3}px`
        hl.style.width = `${a.el.w * this.scale + 6}px`
        hl.style.height = `${a.el.h * this.scale + 6}px`
        hl.textContent = ''
      } else {
        hl.className = 'ed-comment-hl pin'
        hl.style.left = `${a.x * this.scale}px`
        hl.style.top = `${a.y * this.scale}px`
        hl.style.width = ''
        hl.style.height = ''
        hl.textContent = `${a.x}, ${a.y}`
      }
    }
    const onDown = (ev: MouseEvent) => {
      const t = ev.target instanceof Element ? ev.target : null
      if (t?.closest('.ed-topbar, .ed-desktop-chrome')) return // let the 💬 toggle (or other tools) handle it
      if (!t?.closest('.ed-canvas-wrap')) {
        cleanup() // clicked some other UI: disarm without placing
        return
      }
      ev.preventDefault()
      ev.stopPropagation()
      // press-drag = AREA comment; a plain click keeps element > point > slide
      const sr = this.scaleHost.getBoundingClientRect()
      const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v))
      const { width, height } = this.store.doc.size
      const toSlide = (cx: number, cy: number) => ({
        x: clamp((cx - sr.left) / this.scale, width),
        y: clamp((cy - sr.top) / this.scale, height),
      })
      const sx = ev.clientX
      const sy = ev.clientY
      const start = toSlide(sx, sy)
      let dragging = false
      const rectAt = (cx: number, cy: number) => {
        const p = toSlide(cx, cy)
        return {
          x: Math.round(Math.min(start.x, p.x)),
          y: Math.round(Math.min(start.y, p.y)),
          w: Math.round(Math.abs(p.x - start.x)),
          h: Math.round(Math.abs(p.y - start.y)),
        }
      }
      const move = (e: MouseEvent) => {
        if (!dragging && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return
        if (!dragging) {
          dragging = true
          chip.style.display = 'none'
          hl.style.display = ''
          hl.className = 'ed-comment-hl area'
          hl.textContent = ''
        }
        const r = rectAt(e.clientX, e.clientY)
        hl.style.left = `${r.x * this.scale}px`
        hl.style.top = `${r.y * this.scale}px`
        hl.style.width = `${r.w * this.scale}px`
        hl.style.height = `${r.h * this.scale}px`
      }
      const stopDrag = () => {
        document.removeEventListener('mousemove', move, true)
        document.removeEventListener('mouseup', up, true)
        window.removeEventListener('blur', abort)
        window.removeEventListener('pointercancel', abort)
      }
      // mouseup outside the window / pointer cancelled: end the drag, place nothing
      const abort = () => { stopDrag(); cleanup() }
      const up = (e: MouseEvent) => {
        stopDrag()
        const r = dragging ? rectAt(e.clientX, e.clientY) : null
        const a = r ? null : this.commentAnchorAt(sx, sy)
        const keep = !!r && r.w >= 6 && r.h >= 6
        cleanup(keep) // keep the drawn rectangle visible while the dialog is open
        e.preventDefault()
        e.stopPropagation()
        if (r) {
          if (!keep) return
          void this.comments.openNew(undefined, { x: r.x, y: r.y }, r, this.commentAnchorRect(undefined, r)).finally(() => hl.remove())
        } else if (!a) void this.comments.openNew() // off-slide canvas click = whole slide
        else void this.comments.openNew(a.el?.id, a.el ? undefined : { x: a.x, y: a.y }, undefined, this.commentAnchorRect(a.el?.id, a.el ? undefined : a))
      }
      document.removeEventListener('mousemove', onMove, true) // the drag takes over the live preview
      document.addEventListener('mousemove', move, true)
      document.addEventListener('mouseup', up, true)
      window.addEventListener('blur', abort)
      window.addEventListener('pointercancel', abort)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') cleanup()
    }
    this.commentCleanup = cleanup
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('keydown', onKey, true)
    this.onCommentModeChange?.(true)
    this.emitViewport() // floating chrome hides while a click tool is armed
  }

  get isFormatPaintArmed() {
    return !!this.formatPaintCleanup
  }

  /** Arm the format-painter click tool (see the "format painter block" above
   *  for the actual click capture). Stays armed across multiple clicks. */
  armFormatPaint() {
    if (this.formatPaintCleanup) return
    this.wrap.style.cursor = 'crosshair'
    this.formatPaintCleanup = () => {
      this.formatPaintCleanup = null
      this.wrap.style.cursor = ''
    }
    this.onFormatPaintModeChange?.(true)
    this.emitViewport() // floating chrome hides while a click tool is armed
  }

  disarmFormatPaint() {
    if (!this.formatPaintCleanup) return
    this.formatPaintCleanup()
    this.onFormatPaintModeChange?.(false)
    this.emitViewport() // floating chrome hides while a click tool is armed
  }

  get isReapplyChangeArmed() {
    return !!this.reapplyChangeCleanup
  }

  /** Arm the reapply-change click tool (see the "reapply-change block" above
   *  for the actual click capture). Stays armed across multiple clicks. */
  armReapplyChange() {
    if (this.reapplyChangeCleanup) return
    this.wrap.style.cursor = 'crosshair'
    this.reapplyChangeCleanup = () => {
      this.reapplyChangeCleanup = null
      this.wrap.style.cursor = ''
    }
    this.onReapplyChangeModeChange?.(true)
    this.emitViewport() // floating chrome hides while a click tool is armed
  }

  disarmReapplyChange() {
    if (!this.reapplyChangeCleanup) return
    this.reapplyChangeCleanup()
    this.onReapplyChangeModeChange?.(false)
    this.emitViewport() // floating chrome hides while a click tool is armed
  }

  /** Grow a selection to whole groups: any member pulls in its groupId kin.
   *  (Alt-click deep select bypasses this — that's how you reach a member.) */
  private expandGroups(ids: string[]): string[] {
    const els = this.store.slide.elements
    const groups = new Set(
      ids.map((id) => els.find((e) => e.id === id)?.groupId).filter((g): g is string => !!g),
    )
    if (!groups.size) return ids
    const out = new Set(ids)
    for (const el of els) if (el.groupId && groups.has(el.groupId)) out.add(el.id)
    return [...out]
  }

  /** ids of elements a slide/layout inherits from its ANCESTOR chain (see
   *  model.ts's `ancestorElementIds`) — these ride along visually but are
   *  never directly selectable/editable in the current context (any hand
   *  edit would just be stomped by the next resync from the ancestor that
   *  actually owns them). Empty when there's no ancestor to exclude. Since
   *  the 2026-09-20 redesign there is no separate Building-Blocks editing
   *  direction anymore — a former "master" is just another `doc.layouts`
   *  entry, so this is the ONLY locking direction left. */
  private lockedIds(): Set<string> {
    const slide = this.store.slide
    if (this.store.editingSurface?.kind === 'layout') return ancestorElementIds(this.store.doc, slide)
    const layout = slide.layoutId ? this.store.doc.layouts?.find((l) => l.id === slide.layoutId) : undefined
    return layout ? ancestorElementIds(this.store.doc, layout) : new Set()
  }

  /** ids to render dimmed/inert (render.ts RenderOpts.ghostIds). Always
   *  empty since the 2026-09-20 redesign: ghosting only ever applied to the
   *  old Building-Blocks editing direction (previewing a representative
   *  slide type's elements ghosted on top of the live blocks), which no
   *  longer exists as a separate surface. Kept as a function (rather than
   *  inlined at the call site) so a future ghosting need has an obvious
   *  home. */
  private ghostIds(): Set<string> {
    return new Set()
  }

  /** ids to render with a "locked" cursor (render.ts RenderOpts.lockedCursorIds)
   *  — while editing a slide TYPE, its inherited ancestor elements render at
   *  full opacity (they're real, final-looking content here, not a preview)
   *  but are still non-selectable, so they get a cursor cue instead of a
   *  visual dimming. */
  private lockedCursorIds(): Set<string> {
    const ids = this.store.editingSurface?.kind === 'layout' ? this.lockedIds() : new Set<string>()
    for (const id of this.userLockedIds()) ids.add(id)
    return ids
  }

  /** What actually gets PAINTED for the current `store.slide` — never the
   *  mutation/selection target itself, only visual context layered around
   *  it, so this cannot affect insert/select/edit correctness by
   *  construction. While editing a slide type, composites its full ancestor
   *  chain underneath (the same merge shape thumbnails/instantiation
   *  already use via `effectiveLayout` — not a new composition rule). */
  private compositeForRender(slide: Slide): Slide {
    const surface = this.store.editingSurface
    const doc = this.store.doc
    if (surface?.kind === 'layout') return effectiveLayout(doc, slide)
    return slide
  }

  /** Point-based hit test (client coords) for the topmost element under the
   *  point, EXCLUDING locked building-block elements — the fallback used
   *  when a raw hit (Selecto, right-click) resolves only to locked chrome,
   *  so a gesture that visually lands on real content behind it still
   *  reaches that content, not empty canvas. Real DOM hit test (not a
   *  bbox approximation), so it respects rotation same as the native click
   *  it's replacing. */
  private resolveClickTarget(clientX: number, clientY: number): string | null {
    const locked = this.lockedIds()
    for (const node of document.elementsFromPoint(clientX, clientY)) {
      const hit = node instanceof Element ? node.closest<HTMLElement>('.beeslides-el[data-el-id]') : null
      const id = hit?.dataset.elId
      if (id && !locked.has(id)) return id
    }
    return null
  }

  /** Alt-click: select the element under (px, py), digging one step deeper
   *  below the current selection on each repeat. Coordinates in slide px. */
  private stopFxPreview: (() => void) | null = null

  /**
   * Plays the current slide's animations (entrance, count-up, ken-burns,
   * loops) on the live canvas — they otherwise only run in present mode.
   * Selection is cleared so Moveable's frame doesn't fight the tweens; the
   * preview ends on any click/key (or the slide changing) and the canvas is
   * repainted from the model, so nothing is ever left mid-tween.
   */
  previewAnimations(): boolean {
    this.stopFxPreview?.()
    if (this.editing || this.pathEditor.active) return false
    const slide = this.store.slide
    if (!slide?.elements.some((el) => el.fx)) return false
    this.store.select([])
    // a slide with click builds plays them through on a timer (▶ Step through
    // is the one you drive by hand)
    const builds = buildPlan(slide).steps.length ? previewBuilds(slide, this.scaleHost) : null
    const nodes = builds ? [] : previewSlideFx(slide, this.scaleHost)
    const tick = builds ? window.setInterval(() => { if (!builds.next()) clearInterval(tick) }, 1300) : 0
    const bar = document.createElement('div')
    bar.className = 'ed-fx-preview-hint'
    bar.textContent = t('Previewing animation — click or press any key to stop')
    this.wrap.appendChild(bar)
    let done = false
    const stop = () => {
      if (done) return
      done = true
      this.stopFxPreview = null
      window.removeEventListener('mousedown', stop, true)
      window.removeEventListener('keydown', stop, true)
      offSlide()
      bar.remove()
      clearInterval(tick)
      builds?.stop()
      for (const n of nodes) anim.killTweensOf(n)
      this.render()
    }
    window.addEventListener('mousedown', stop, true)
    window.addEventListener('keydown', stop, true)
    const offSlide = this.store.on('current', stop)
    this.stopFxPreview = stop
    return true
  }

  private stopStepThrough: (() => void) | null = null
  private stepping = false

  /**
   * "▶ Step through": the slide opens at click 0 and → plays the next click
   * through the very code present mode uses; ← takes one back; Esc / Done ends
   * and repaints the canvas from the model. Returns false when there is
   * nothing to step through (then Preview animation is the better button).
   */
  stepThrough(): boolean {
    this.stopFxPreview?.()
    this.stopStepThrough?.()
    if (this.editing || this.pathEditor.active) return false
    const slide = this.store.slide
    if (!buildPlan(slide).steps.length) return false
    this.store.select([])
    this.stepping = true
    this.updateBuildBadges() // hides them while stepping
    const bar = document.createElement('div')
    bar.className = 'ed-fx-preview-hint ed-step-bar'
    const label = document.createElement('span')
    const prevB = document.createElement('button')
    prevB.type = 'button'; prevB.className = 'ed-btn'; prevB.textContent = '←'
    prevB.title = t('Back one click')
    const nextB = document.createElement('button')
    nextB.type = 'button'; nextB.className = 'ed-btn'; nextB.textContent = '→'
    nextB.title = t('Play the next click')
    const doneB = document.createElement('button')
    doneB.type = 'button'; doneB.className = 'ed-btn'; doneB.textContent = t('Done')
    bar.append(prevB, label, nextB, doneB)
    this.wrap.appendChild(bar)
    let preview: BuildPreview
    const paint = () => {
      label.textContent = t('Click {n} of {total} — → next · ← back · Esc ends', { n: preview.step, total: preview.total })
      prevB.disabled = preview.step <= 0
      nextB.disabled = preview.step >= preview.total
    }
    preview = previewBuilds(slide, this.scaleHost, paint)
    paint()
    let done = false
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); stop() }
      else if (ev.key === 'ArrowRight' || ev.key === ' ' || ev.key === 'PageDown') { ev.preventDefault(); ev.stopPropagation(); preview.next() }
      else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); ev.stopPropagation(); preview.prev() }
    }
    const onDown = (ev: MouseEvent) => { if (!bar.contains(ev.target as Node)) stop() }
    const stop = () => {
      if (done) return
      done = true
      this.stepping = false
      this.stopStepThrough = null
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
      offSlide()
      bar.remove()
      preview.stop()
      this.render()
      this.updateBuildBadges()
    }
    prevB.addEventListener('click', () => preview.prev())
    nextB.addEventListener('click', () => preview.next())
    doneB.addEventListener('click', stop)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    const offSlide = this.store.on('current', stop)
    this.stopStepThrough = stop
    return true
  }

  /** ⌘/Ctrl+A: every selectable (unlocked, visible) element on the slide. */
  selectAllElements() {
    const locked = this.lockedIds()
    const ids = this.store.slide.elements
      .filter((el) => !locked.has(el.id) && !el.locked && !el.hidden)
      .filter((el) => this.scaleHost.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)?.style.display !== 'none')
      .map((el) => el.id)
    this.store.select(this.expandGroups(ids))
  }

  /** Near-full-slide element (≥80% of the page) — scenery, not a click target. */
  isBackdrop(el: SlideElement): boolean {
    return isBackdropBox(el, effectiveCanvasSize(this.store))
  }

  /** Elements the USER locked (`el.locked`): click-through, never in marquee /
   *  select-all, but still in `hitStack` so the Select menu and Alt-click
   *  reach them. */
  private userLockedIds(): Set<string> {
    return new Set(this.store.slide.elements.filter((e) => e.locked).map((e) => e.id))
  }

  /** Every element under (px, py) in slide px, TOP FIRST. Tests the ROTATED
   *  box (the point is inverse-rotated about the element's centre). Skips
   *  inherited-locked elements and hover-set members that are display:none;
   *  keeps user-locked ones, and hidden ones when `includeHidden`. */
  hitStack(px: number, py: number, opts: { includeHidden?: boolean } = {}): SlideElement[] {
    const inherited = this.lockedIds()
    const out: SlideElement[] = []
    for (const el of this.store.slide.elements) {
      if (inherited.has(el.id)) continue
      if (el.hidden && !opts.includeHidden) continue
      let x = px, y = py
      if (el.rotation) {
        const rad = (-el.rotation * Math.PI) / 180
        const cx = el.x + el.w / 2, cy = el.y + el.h / 2
        const dx = px - cx, dy = py - cy
        x = cx + dx * Math.cos(rad) - dy * Math.sin(rad)
        y = cy + dx * Math.sin(rad) + dy * Math.cos(rad)
      }
      if (x < el.x || x > el.x + el.w || y < el.y || y > el.y + el.h) continue
      const node = this.scaleHost.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (!node || node.style.display === 'none') continue // hidden hover set
      out.push(el)
    }
    return out.reverse() // model order is z-order; topmost last
  }

  /** Outline the canvas node of `id` (right-click Select menu row hover). */
  highlightElement(id: string | null) {
    this.surface?.querySelectorAll('.ed-sel-hover').forEach((n) => n.classList.remove('ed-sel-hover'))
    if (!id) return
    this.surface?.querySelector(`[data-el-id="${CSS.escape(id)}"]`)?.classList.add('ed-sel-hover')
  }

  private deepSelect(px: number, py: number) {
    const stack = this.hitStack(px, py).map((e) => e.id)
    if (!stack.length) {
      // Nothing selectable under the point — if a locked building-block
      // element sits there instead, that's the same "can't select this
      // here" case as the selectEnd fallback above, just via Alt-click.
      const inherited = this.lockedIds()
      const hitsLocked = this.store.slide.elements.some(
        (el) => inherited.has(el.id) && px >= el.x && px <= el.x + el.w && py >= el.y && py <= el.y + el.h,
      )
      if (hitsLocked) this.onLockedElementClick?.()
      return
    }
    const topFirst = stack
    let pick = topFirst[0]
    if (this.store.selection.length === 1) {
      const i = topFirst.indexOf(this.store.selection[0])
      if (i >= 0) pick = topFirst[(i + 1) % topFirst.length]
    }
    // Alt-click on something NOT yet selected adds it (multi-select with
    // Alt); alt-clicking the same spot again still digs deeper.
    const sel = this.store.selection
    if (sel.length && !sel.some((id) => stack.includes(id))) {
      this.store.select(this.expandGroups([...sel, pick]))
      return
    }
    this.store.select([pick])
  }

  // --- motion-path editing ----------------------------------------------------

  get isPathEditing() {
    return this.pathEditor.active
  }

  startPathEdit(elId: string) {
    this.commitTextEdit()
    this.pathEditor.start(elId)
    this.syncTargets()
  }

  // --- picture crop ------------------------------------------------------------

  get isCropping() {
    return !!this.cropMode?.engaged
  }

  /** Leave crop mode without applying it (also one still waiting for its
   *  picture to decode). False when nothing was being cropped. */
  cancelCrop(): boolean {
    if (!this.cropMode?.engaged) return false
    const open = this.cropMode.active
    this.cropMode.cancel() // an open session brings Moveable back via onExit
    if (!open) this.syncTargets()
    return true
  }

  /** Enter crop mode for an image (double-click, panel, mini toolbar). Not
   *  for a locked or slide-type-inherited picture — those can't be resized
   *  either, and cropping moves the frame. */
  startCrop(elId: string): boolean {
    const el = this.store.element(elId)
    if (!el || el.type !== 'image' || el.locked || this.lockedIds().has(elId)) return false
    this.commitTextEdit()
    if (this.pathEditor.active) this.stopPathEdit(true)
    if (this.store.selection.length !== 1 || this.store.selection[0] !== elId) this.store.select([elId])
    const ok = this.cropMode.start(elId)
    // hides Moveable's box — also while the mode still waits for the picture
    // to decode (cropMode.engaged), so no handle is usable under the overlay
    this.syncTargets()
    return ok
  }

  // --- equation editing -------------------------------------------------------

  /** True while the equation popover (editor/matheditor.ts) is open. */
  get isEditingMath() {
    return !!activeMathEdit()
  }

  /**
   * Open the equation popover — for the equation `elId`, or with no id for a
   * NEW one that its commit inserts (so cancelling leaves no element). Not
   * for a locked or slide-type-inherited equation, nor in a read-only deck.
   */
  startMathEdit(elId?: string): boolean {
    if (this.store.readOnly) return false
    if (elId) {
      const el = this.store.element(elId)
      if (!el || el.type !== 'math' || el.locked || this.lockedIds().has(elId)) return false
      if (this.store.selection.length !== 1 || this.store.selection[0] !== elId) this.store.select([elId])
    }
    this.commitTextEdit()
    if (this.pathEditor.active) this.stopPathEdit(true)
    new MathEditSession({ store: this.store, canvas: this, elId, onEnd: () => this.emitTextEdit(undefined) })
    this.emitTextEdit(undefined) // the mini toolbar steps aside while it is open
    return true
  }

  /** Close the equation popover without applying it. False when none was
   *  open — Editor.undo/redo cancel the session instead of undoing. */
  cancelMathEdit(): boolean {
    const s = activeMathEdit()
    if (!s) return false
    s.cancel()
    return true
  }

  /** finish path editing; commit=false discards the changes */
  stopPathEdit(commit = true) {
    if (commit) this.pathEditor.commit()
    else {
      this.pathEditor.cancel()
      this.syncTargets()
    }
  }


  /** Frames the canvas for a screenshot (agent render_preview /
   *  review_slide): `area` (slide px) is zoomed to fill the view and
   *  centred, or with none the whole slide is shown at fit — a zoomed-in
   *  view used to hand the agent a fragment. `rect` is where it now is on
   *  screen, in CSS px of this document (null when the canvas is not laid
   *  out); `restore` puts the user's zoom and scroll back, unless the user
   *  zoomed meanwhile. */
  frameForCapture(area?: { x: number; y: number; w: number; h: number }): { rect: { x: number; y: number; width: number; height: number } | null; restore: () => void } {
    const zoom = this.zoom
    const { scrollLeft, scrollTop } = this.scroller
    const { width, height } = effectiveCanvasSize(this.store)
    const a = area ?? { x: 0, y: 0, w: width, h: height }
    const availW = this.scroller.clientWidth - 64 // relayout's margins
    const availH = this.scroller.clientHeight - 64
    const want = area && availW > 0 && availH > 0 ? Math.max(1, Math.min(availW / a.w, availH / a.h) / this.fitScale) : 1
    if (want !== zoom) this.setZoom(want)
    if (area) {
      const s = this.stage.getBoundingClientRect()
      const v = this.scroller.getBoundingClientRect()
      this.scroller.scrollLeft += s.left + (a.x + a.w / 2) * this.scale - (v.left + v.width / 2)
      this.scroller.scrollTop += s.top + (a.y + a.h / 2) * this.scale - (v.top + v.height / 2)
    }
    const framed = this.zoom
    const restore = () => {
      if (this.zoom !== framed) return
      if (this.zoom !== zoom) this.setZoom(zoom)
      this.scroller.scrollLeft = scrollLeft
      this.scroller.scrollTop = scrollTop
    }
    const s = this.stage.getBoundingClientRect() // sized to the scaled slide
    const v = this.scroller.getBoundingClientRect()
    const x0 = Math.max(s.left + a.x * this.scale, v.left)
    const y0 = Math.max(s.top + a.y * this.scale, v.top)
    const x1 = Math.min(s.left + (a.x + a.w) * this.scale, v.right)
    const y1 = Math.min(s.top + (a.y + a.h) * this.scale, v.bottom)
    if (x1 - x0 < 2 || y1 - y0 < 2) return { rect: null, restore }
    return { rect: { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) }, restore }
  }
  /**
   * Draw the current surface. `'full'` (every outside caller) replaces the
   * whole slide surface; `'patch'` (the store's 'doc'/'current' events and the
   * live-step frame) redraws only the elements that changed when the surface
   * on screen already shows this slide in the same context, and falls back to
   * the full render whenever it cannot tell (see canvaspatch.ts).
   */
  render(mode: 'full' | 'patch' = 'full') {
    this.liveRender.cancel()
    // A slide switch is a hard boundary for an inline edit. Commit against
    // the slide where editing began (or discard if that slide was remotely
    // deleted) before replacing the canvas DOM.
    if (this.editing && this.editingSlideId !== this.store.slide?.id) this.commitTextEdit()
    // Don't repaint out from under an in-progress inline edit. A remote collab
    // op landing must NOT tear down the text/cell node you're typing in — that
    // steals focus and resets the caret (the #1 rough edge reported at launch).
    // Defer the repaint and catch up the instant the edit commits; a burst of
    // remote ops coalesces into a single repaint then.
    if (this.editing) { this.pendingRender = true; return }
    this.pendingRender = false
    if (this.pathEditor?.active) this.pathEditor.cancel() // doc changed under us
    if (this.cropMode?.engaged) this.cropMode.cancel() // same: its rects are stale
    const slide = this.store.slide
    const shown = this.compositeForRender(slide)
    const opts: RenderOpts = {
      ghostIds: this.ghostIds(), lockedCursorIds: this.lockedCursorIds(), size: effectiveCanvasSize(this.store),
      fieldMarkers: true, showHidden: true, paintHit: true, language: this.store.termPreview ?? undefined,
    }
    // hover-reveal slides: preview one set at a time; hidden sets are
    // display:none so they don't block selection
    const sets = [...new Set(slide.elements.map((e) => e.showOnHover).filter(Boolean))] as string[]
    const active = sets.length ? this.store.hoverPreview ?? slide.hover?.default ?? sets[0] : null
    const ctx = slideRenderContext(shown, this.store.doc, opts)
    const ctxSig = this.contextSignature(shown, ctx, opts, sets, active)
    if (mode === 'patch' && this.patch(shown, ctx, ctxSig, active)) return
    this.renderStats.full++
    const next = renderSlide(shown, this.store.doc, opts)
    if (active !== null) {
      for (const node of next.querySelectorAll<HTMLElement>('[data-show-on-hover]')) {
        if (node.dataset.showOnHover !== active) node.style.display = 'none'
      }
    }
    this.renderSetBar(sets)
    if (this.surface) this.surface.replaceWith(next)
    else this.scaleHost.appendChild(next)
    this.surface = next
    this.domDirt.watch(next)
    this.shown = this.recordShown(next, shown, ctxSig)
    this.updateLookView()
    this.relayout()
    this.syncTargets()
  }

  /** Everything outside the elements the surface is drawn from. Any change
   *  here redraws the whole surface. */
  private contextSignature(shown: Slide, ctx: ReturnType<typeof slideRenderContext>, opts: RenderOpts, sets: string[], active: string | null): Sig {
    const { slides: _s, layouts: _l, reusableObjects: _r, modified: _m, ...docRest } = this.store.doc
    // speaker notes are typed live in the notes pane and never drawn here
    const { elements: _e, notes: _n, ...slideRest } = shown
    return signature([
      docRest, slideRest, ctx.fields.page, ctx.fields.pages, ctx.fonts, [...ctx.footerOff], ctx.isType,
      [...opts.ghostIds ?? []], [...opts.lockedCursorIds ?? []], opts.size, opts.language ?? null,
      this.store.editingSurface, sets, active, offlineEnabled(), locale(),
    ])
  }

  /** The diff base for the next patch: per element its signature, frame and
   *  node (null when the surface leaves it out). */
  private recordShown(surface: HTMLElement, shown: Slide, ctxSig: Sig): ShownSurface {
    const children = Array.from(surface.children) as HTMLElement[]
    let at = 0
    const nodes = shown.elements.map((el) => {
      const n = children[at]
      if (n && n.dataset.elId === el.id) { at++; return n }
      return null
    })
    return {
      surface, ctxSig, nodes,
      ids: shown.elements.map((el) => el.id),
      sigs: shown.elements.map((el) => signature(el)),
      frames: shown.elements.map(frameKey),
      epoch: this.docEpoch,
    }
  }

  /** render('patch'): redraw the changed elements into the surface on
   *  screen. False = the full render must run (nothing was touched then
   *  except, possibly, some element nodes that the full render replaces). */
  private patch(shown: Slide, ctx: ReturnType<typeof slideRenderContext>, ctxSig: Sig, active: string | null): boolean {
    const prev = this.shown
    if (!prev || !this.surface || prev.surface !== this.surface || !this.surface.isConnected) return false
    if (!sameSig(prev.ctxSig, ctxSig)) return false
    const els = shown.elements
    if (els.length !== prev.ids.length || els.some((el, i) => el.id !== prev.ids[i])) return false
    const dirt = this.domDirt.take()
    if (dirt.whole) return false
    const doc = this.store.doc
    const modelChanged = prev.epoch !== this.docEpoch
    prev.epoch = this.docEpoch
    let patched = 0
    let moved = false
    const fresh: Array<[number, Sig]> = []
    const ok = this.domDirt.own(() => {
      for (let i = 0; i < els.length; i++) {
        const el = els[i]
        const old = prev.nodes[i]
        const sig = signature(el)
        if (sameSig(sig, prev.sigs[i]) && !(modelChanged && alwaysRedraw(el)) && !(old && dirt.nodes.has(old))) continue
        fresh.push([i, sig])
        const next = renderSlideElement(el, doc, ctx)
        if (!next !== !old) return false // shown ⇄ left out: the node list changes
        if (!next || !old) continue
        if (active !== null) {
          for (const n of [next, ...next.querySelectorAll<HTMLElement>('[data-show-on-hover]')]) {
            if (n.dataset.showOnHover && n.dataset.showOnHover !== active) n.style.display = 'none'
          }
        }
        patchNode(old, next)
        patched++
        if (frameKey(el) !== prev.frames[i]) moved = true
      }
      return true
    })
    if (!ok) return false
    for (const [i, sig] of fresh) {
      prev.sigs[i] = sig
      prev.frames[i] = frameKey(els[i])
    }
    if (!patched) { this.renderStats.unchanged++; return true }
    this.renderStats.patch++
    this.renderStats.patchedNodes += patched
    // relayout's other work (stage size, zoom, grid, guides, safe zone, snap
    // lines) reads only what the context signature covers
    if (moved) this.comments?.refresh()
    if (this.buildBadgeLayer) this.updateBuildBadges()
    this.updateLookView()
    this.syncTargets() // data-sel, table handles, Moveable's rect
    return true
  }

  /** Icon sets: with a style shown (store.iconLook), the icon is painted in
   *  it over the canvas and the drawn shapes turn invisible — still there to
   *  select, move and edit, and shown again while a gesture runs. Editor-only;
   *  agent screenshots see the drawing (`.ed-capturing`). */
  private updateLookView() {
    const look = this.store.editingSurface ? undefined : this.store.shownLook
    this.scaleHost.classList.toggle('ed-lookview-on', !!look)
    if (!look || !this.surface) {
      this.lookLayer?.remove()
      this.lookLayer = null
      return
    }
    if (!this.lookLayer) {
      this.lookLayer = document.createElement('div')
      this.lookLayer.className = 'ed-lookview'
      this.lookLayer.setAttribute('aria-hidden', 'true')
      this.lookLayer.appendChild(document.createElement('img')).alt = ''
    }
    // right above the slide, under the guides and the selection box
    if (this.lookLayer.previousElementSibling !== this.surface) this.surface.after(this.lookLayer)
    const { width, height } = this.store.doc.size
    const img = this.lookLayer.firstElementChild as HTMLImageElement
    img.width = width
    img.height = height
    const url = lookPreviewUrl(this.store, this.store.slide.id, look)
    if (img.getAttribute('src') !== url) img.src = url
    this.updateLookSelection()
  }

  /** The selected shapes, outlined over the styled picture: the drawn shapes
   *  are invisible there, so this is how you see what you picked. */
  private updateLookSelection() {
    const layer = this.lookLayer
    if (!layer) return
    layer.querySelector('svg')?.remove()
    const sel = new Set(this.store.selection)
    if (!sel.size) return
    const info = iconsetInfo(this.store.doc)
    if (!info) return
    const picked = iconShapes(this.store.doc, this.store.slide).shapes.filter((s) => sel.has(s.el.id))
    if (!picked.length) return
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    const { width, height } = this.store.doc.size
    svg.setAttribute('viewBox', `0 0 ${info.grid} ${info.gridH}`)
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    svg.setAttribute('class', 'ed-lookview-sel')
    for (const s of picked) {
      const p = document.createElementNS(ns, 'path')
      p.setAttribute('d', s.d)
      svg.appendChild(p)
    }
    layer.appendChild(svg)
  }

  /**
   * Canvas set-switcher: when a slide has hover-reveal sets, a chip bar sits
   * above the stage so each set is one click away while editing. Selection
   * survives the switch when the selected element is in the shown set.
   */
  private renderSetBar(sets: string[]) {
    this.wrap.querySelector('.ed-setbar')?.remove()
    if (!sets.length) return
    const slide = this.store.slide
    const active = this.store.hoverPreview ?? slide.hover?.default ?? sets[0]
    const bar = document.createElement('div')
    bar.className = 'ed-setbar'
    const label = document.createElement('span')
    label.className = 'ed-setbar-label'
    label.textContent = t('Hover set:')
    bar.appendChild(label)
    for (const set of sets) {
      const chip = document.createElement('button')
      chip.className = 'ed-setchip'
      chip.textContent = set + (slide.hover?.default === set ? ' ●' : '')
      chip.title = slide.hover?.default === set
        ? `"${set}" — shown when nothing is hovered (default set)`
        : `Preview and edit the "${set}" hover set`
      if (set === active) chip.classList.add('active')
      chip.addEventListener('click', () => {
        this.store.hoverPreview = set
        this.render()
      })
      bar.appendChild(chip)
    }
    this.wrap.appendChild(bar)
  }

  private selectedNodes(): HTMLElement[] {
    if (!this.surface) return []
    return this.store.selection
      .map((id) => this.surface!.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(id)}"]`))
      .filter((n): n is HTMLElement => !!n)
  }

  /** DOM nodes of a lone selected container's direct children — empty unless
   *  selection is EXACTLY one container element with 1+ children. Feeding
   *  these into `moveable.target` alongside the container (see `syncTargets`)
   *  gets Moveable's own group drag/resize math to move them live, for free,
   *  during the gesture; `commitFrames`/`commitDomFrames` then write every
   *  node's final box back per-element at gesture end, same as an ordinary
   *  multi-select group drag. Not recursive — v1 blocks nesting, so a
   *  container's children are never themselves containers with children. */
  private containerCascadeChildren(): HTMLElement[] {
    if (!this.surface) return []
    const sel = this.store.selection
    if (sel.length !== 1) return []
    const el = this.store.element(sel[0])
    if (!el || el.type !== 'shape' || !(el as ShapeElement).container) return []
    const childIds = new Set(this.store.slide.elements.filter((e) => e.parentId === sel[0]).map((e) => e.id))
    if (!childIds.size) return []
    return Array.from(this.surface.querySelectorAll<HTMLElement>('.beeslides-el[data-el-id]')).filter(
      (n) => n.dataset.elId && childIds.has(n.dataset.elId),
    )
  }

  private syncTargets() {
    this.updateLookSelection()
    // A single selected line/curve/connector is edited with endpoint handles
    // (LineEditor), not Moveable's box — grab an end and drag it.
    const sel = this.store.selectedElements
    // the selection moved off the picture being cropped (⌘A, a panel action,
    // undo): apply the crop first — commit re-renders, which syncs again
    if (this.cropMode?.engaged && (sel.length !== 1 || sel[0].id !== this.cropMode.elementId)) {
      if (this.cropMode.active) { this.cropMode.commit(); return }
      this.cropMode.cancel() // still waiting for its picture: it never opens
    }
    const cropping = !!this.cropMode?.engaged
    const one = sel.length === 1 && !this.editing && !this.pathEditor.active && !cropping ? sel[0] : null
    // Curves get true bezier handles (BezierEditor); lines and straight polygons
    // keep endpoint/anchor handles (LineEditor).
    const curve = !!one && isCurve(one) && !one.locked
    const lineLike = !!one && !curve && isLineLike(one) && !one.locked
    if (curve) { this.bezierEditor.attach(one!.id); this.lineEditor.detach() }
    else if (lineLike) { this.lineEditor.attach(one!.id); this.bezierEditor.detach() }
    else { this.lineEditor.detach(); this.bezierEditor.detach() }
    const handled = curve || lineLike
    const anyLocked = sel.some((e) => e.locked)
    this.domDirt.own(() => {
      this.surface?.querySelectorAll('[data-sel]').forEach((n) => n.removeAttribute('data-sel'))
      for (const n of this.selectedNodes()) n.dataset.sel = '1'
    })
    const selNodes = this.editing || this.pathEditor?.active || cropping || handled ? [] : this.selectedNodes()
    // moveable.target gets the container's children too (live drag/resize
    // cascade — see containerCascadeChildren) but Selecto's own bookkeeping
    // must NOT: it stays scoped to the actual store.selection, or a cascade
    // child seeded in here leaks into the NEXT shift-click's result (that
    // child was never selected, it just rides along visually).
    const targets = selNodes.length ? [...selNodes, ...this.containerCascadeChildren()] : selNodes
    // snap against slide bounds/center and every non-selected element —
    // each only while its Grid & Snap box is ticked
    const { objects, slide: slideLines } = this.gridPref.snap
    const others = this.surface
      ? [
          ...(slideLines && !this.pageless ? [this.surface] : []),
          ...(objects ? Array.from(this.surface.querySelectorAll<HTMLElement>('.beeslides-el[data-el-id]')) : []),
        ].filter((n) => !targets.includes(n))
      : []
    this.moveable.elementGuidelines = others
    // Only reset targets when they actually changed — setting the same array
    // re-attaches gesture listeners a frame later and can swallow a drag that
    // starts immediately after.
    const current = (this.moveable.target ?? []) as HTMLElement[]
    const same = current.length === targets.length && targets.every((t, i) => current[i] === t)
    if (!same) {
      if (this.gestureActive) this.pendingTargetSync = true
      else this.moveable.target = targets
    }
    this.moveable.draggable = !anyLocked
    this.moveable.resizable = !anyLocked
    this.moveable.rotatable = !anyLocked
    this.moveable.renderDirections = anyLocked ? [] : ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']
    this.moveable.updateRect()
    // Keep Selecto's continue-select memory in lockstep with the store —
    // otherwise shift-click resurrects targets from a previously shown slide.
    this.selecto.setSelectedTargets(selNodes)
    this.domDirt.own(() => this.updateTableHandles())
    this.emitViewport()
  }

  // --- column resize handles (single selected table) --------------------------

  /** Show draggable dividers on the boundaries of a lone selected table. */
  private updateTableHandles() {
    this.tableRange.paint()
    this.surface?.querySelectorAll('.beeslides-col-handle').forEach((h) => h.remove())
    if (this.editing) return
    const ids = this.store.selection
    if (ids.length !== 1) return
    const el = this.store.element(ids[0])
    if (!el || el.type !== 'table' || el.columns.length < 2) return
    const node = this.surface?.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (!node) return
    const total = el.columns.reduce((s, c) => s + (c.w || 0), 0) || 1
    let acc = 0
    for (let i = 0; i < el.columns.length - 1; i++) {
      acc += el.columns[i].w || 0
      const handle = document.createElement('div')
      handle.className = 'beeslides-col-handle'
      handle.style.cssText =
        `position:absolute;top:0;height:${el.h}px;width:11px;` +
        `left:${(acc / total) * el.w - 5.5}px;cursor:col-resize;z-index:5;`
      handle.addEventListener('pointerdown', (ev) => this.startColResize(ev, el.id, i))
      node.appendChild(handle)
    }
  }

  /** Drag a column divider: adjust the two adjacent weights, commit on release. */
  private startColResize(ev: PointerEvent, id: string, i: number) {
    ev.preventDefault()
    ev.stopPropagation()
    const el = this.store.element(id)
    if (!el || el.type !== 'table') return
    const node = this.surface?.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(id)}"]`)
    if (!node) return
    const startX = ev.clientX
    const w0 = el.columns[i].w || 0
    const w1 = el.columns[i + 1].w || 0
    const pair = w0 + w1
    const min = pair * 0.12
    const cols = node.querySelectorAll<HTMLElement>('col')
    const handles = [...node.querySelectorAll<HTMLElement>('.beeslides-col-handle')]
    const total = el.columns.reduce((s, c) => s + (c.w || 0), 0) || 1
    let live0 = w0
    let live1 = w1
    const onMove = (e: PointerEvent) => {
      const dFrac = ((e.clientX - startX) / this.scale / el.w) * total
      live0 = Math.min(Math.max(w0 + dFrac, min), pair - min)
      live1 = pair - live0
      // live DOM update only — no store write until release
      if (cols[i]) cols[i].style.width = `${(live0 / total) * 100}%`
      if (cols[i + 1]) cols[i + 1].style.width = `${(live1 / total) * 100}%`
      let a = 0
      for (let k = 0; k < el.columns.length - 1; k++) {
        a += k === i ? live0 : k === i + 1 ? live1 : el.columns[k].w || 0
        if (handles[k]) handles[k].style.left = `${(a / total) * el.w - 5.5}px`
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      this.store.commit(() => {
        const tb = this.store.element(id) as TableElement
        if (tb?.columns[i] && tb.columns[i + 1]) {
          tb.columns[i].w = live0
          tb.columns[i + 1].w = live1
        }
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // --- moveable -------------------------------------------------------------

  /** ⌘/Ctrl-drag duplicate: originals move, copies stay behind (committed at drag end) */
  private pendingCopy: SlideElement[] | null = null

  private wireMoveable() {
    const mv = this.moveable
    // start positions per target — Shift axis-locks against these
    const dragStarts = new Map<HTMLElement, { left: number; top: number }>()

    const noteDragStart = (target: HTMLElement, inputEvent: MouseEvent | undefined) => {
      dragStarts.set(target, {
        left: parseFloat(target.style.left) || 0,
        top: parseFloat(target.style.top) || 0,
      })
      if (inputEvent && (inputEvent.metaKey || inputEvent.ctrlKey) && !this.pendingCopy) {
        // duplicate-drag: snapshot the selection now; the stationary copies
        // are committed in one undo step together with the moved frames
        this.pendingCopy = this.store.selectedElements.map(
          (el) => jsonClone(el),
        )
      }
    }
    /** Shift: hold the axis the pointer moved less along (`held`). */
    const axisLock = (target: HTMLElement, left: number, top: number, ev: { inputEvent?: MouseEvent; dist?: number[] }) => {
      const start = dragStarts.get(target)
      if (!start || !ev.inputEvent?.shiftKey || !ev.dist) return { left, top, held: null }
      return Math.abs(ev.dist[0]) >= Math.abs(ev.dist[1])
        ? { left, top: start.top, held: 'y' as const }
        : { left: start.left, top, held: 'x' as const }
    }
    // The pointer at drag start: where the pointer ALONE puts a frame (`rawOf`)
    // tells a magnetic catch by Moveable from free movement (axisCaught).
    let dragClient = { x: 0, y: 0 }
    const rawOf = (target: HTMLElement, e: { clientX: number; clientY: number }) => {
      const s = dragStarts.get(target) ?? { left: parseFloat(target.style.left) || 0, top: parseFloat(target.style.top) || 0 }
      return { left: s.left + (e.clientX - dragClient.x) / this.scale, top: s.top + (e.clientY - dragClient.y) / this.scale }
    }
    // ⌥ while dragging = free placement: no magnetic lines, no grid. (⌥ before
    // the press is deep-select, so it is pressed once the drag is under way.)
    const setFree = (free: boolean) => { if (mv.snappable === free) mv.snappable = !free }
    // Firm grid: on an axis no magnetic line caught (and Shift does not hold),
    // whichever of the box's start / center / end is nearest lands on the grid.
    const gridOffset = (box: { left: number; top: number; w: number; h: number }, keepX: boolean, keepY: boolean) => {
      const step = this.gridSnapStep
      if (!step) return { dx: 0, dy: 0 }
      return {
        dx: keepX ? 0 : gridSnapSpan(box.left, box.w, step) - box.left,
        dy: keepY ? 0 : gridSnapSpan(box.top, box.h, step) - box.top,
      }
    }
    const sizeOf = (n: HTMLElement) => ({ w: parseFloat(n.style.width) || 0, h: parseFloat(n.style.height) || 0 })

    mv.on('dragStart', (e) => {
      dragClient = { x: e.clientX, y: e.clientY }
      noteDragStart(e.target as HTMLElement, e.inputEvent as MouseEvent)
    })
    // a click on the selected table picks the cell under it; Shift extends
    // the range from the active cell (double-click still edits — stage dblclick)
    // (isDouble is not filtered out: two quick clicks on DIFFERENT cells
    // count as a double for Moveable, and re-picking the same cell is a no-op)
    mv.on('click', (e) => {
      const ids = this.store.selection
      const id = ids.length === 1 ? ids[0] : null
      // the press that selected the table only selects it (⌘C / Delete / arrows
      // still act on the element); a click on the ALREADY selected table picks
      if (!id || id !== this.selAtPress) return
      this.pickCellAt(id, e.inputTarget, (e.inputEvent as MouseEvent | undefined)?.shiftKey ? 'extend' : 'click')
    })
    mv.on('dragGroupStart', (e) => {
      dragClient = { x: e.clientX, y: e.clientY }
      e.events.forEach((ev) => noteDragStart(ev.target as HTMLElement, e.inputEvent as MouseEvent))
    })
    mv.on('drag', (e) => {
      const target = e.target as HTMLElement
      const free = !!(e.inputEvent as MouseEvent | undefined)?.altKey
      setFree(free)
      const raw = rawOf(target, e)
      const a = free ? axisLock(target, raw.left, raw.top, e) : axisLock(target, e.left, e.top, e)
      const { dx, dy } = free ? { dx: 0, dy: 0 } : gridOffset(
        { left: a.left, top: a.top, ...sizeOf(target) },
        a.held === 'x' || axisCaught(e.left, raw.left),
        a.held === 'y' || axisCaught(e.top, raw.top),
      )
      target.style.left = `${a.left + dx}px`
      target.style.top = `${a.top + dy}px`
    })
    mv.on('dragGroup', (e) => {
      const free = !!(e.inputEvent as MouseEvent | undefined)?.altKey
      setFree(free)
      const items = e.events.map((ev) => {
        const target = ev.target as HTMLElement
        const raw = rawOf(target, e)
        return { target, raw, ev, ...(free ? axisLock(target, raw.left, raw.top, ev) : axisLock(target, ev.left, ev.top, ev)) }
      })
      if (!items.length) return
      // one shared offset from the group's UNION box, so the group keeps its
      // shape and its outer edges (or center) land on the grid
      let l = Infinity, tp = Infinity, r = -Infinity, b = -Infinity
      for (const it of items) {
        const { w, h } = sizeOf(it.target)
        l = Math.min(l, it.left); tp = Math.min(tp, it.top)
        r = Math.max(r, it.left + w); b = Math.max(b, it.top + h)
      }
      const first = items[0]
      const { dx, dy } = free ? { dx: 0, dy: 0 } : gridOffset(
        { left: l, top: tp, w: r - l, h: b - tp },
        first.held === 'x' || axisCaught(first.ev.left, first.raw.left),
        first.held === 'y' || axisCaught(first.ev.top, first.raw.top),
      )
      for (const it of items) {
        it.target.style.left = `${it.left + dx}px`
        it.target.style.top = `${it.top + dy}px`
      }
    })
    // Shift while resizing keeps the aspect ratio; Alt/Option scales from
    // the center (both live per move, combinable)
    const resizeCenters = new Map<HTMLElement, { cx: number; cy: number }>()
    const noteResizeStart = (target: HTMLElement) => {
      resizeCenters.set(target, {
        cx: (parseFloat(target.style.left) || 0) + (parseFloat(target.style.width) || 0) / 2,
        cy: (parseFloat(target.style.top) || 0) + (parseFloat(target.style.height) || 0) / 2,
      })
    }
    const applyResize = (
      target: HTMLElement,
      w: number,
      h: number,
      left: number,
      top: number,
      inputEvent: MouseEvent | undefined,
    ) => {
      target.style.width = `${w}px`
      target.style.height = `${h}px`
      const c = resizeCenters.get(target)
      if (inputEvent?.altKey && c) {
        target.style.left = `${c.cx - w / 2}px`
        target.style.top = `${c.cy - h / 2}px`
      } else {
        target.style.left = `${left}px`
        target.style.top = `${top}px`
      }
    }
    // Shift keeps the aspect ratio — inverted for a CROPPED picture, which
    // keeps it by default (a free resize stretches the picture) and Shift frees
    const keepsRatio = (target: HTMLElement) => {
      const el = target.dataset.elId ? this.store.element(target.dataset.elId) : undefined
      return (el?.type === 'image' && !!normalizeCrop(el.crop)) || el?.type === 'zoom' // a zoom tile keeps the slide's shape
    }
    const syncKeepRatio = (inputEvent: MouseEvent | undefined, target: HTMLElement) => {
      const want = !!inputEvent?.shiftKey !== keepsRatio(target)
      if (mv.keepRatio !== want) mv.keepRatio = want
    }
    mv.on('resizeStart', (e) => {
      syncKeepRatio(e.inputEvent as MouseEvent, e.target as HTMLElement)
      noteResizeStart(e.target as HTMLElement)
    })
    mv.on('resize', (e) => {
      syncKeepRatio(e.inputEvent as MouseEvent, e.target as HTMLElement)
      applyResize(e.target as HTMLElement, e.width, e.height, e.drag.left, e.drag.top, e.inputEvent as MouseEvent)
    })
    mv.on('resizeGroupStart', (e) => e.events.forEach((ev) => noteResizeStart(ev.target as HTMLElement)))
    mv.on('resizeGroup', (e) => e.events.forEach((ev) => {
      applyResize(ev.target as HTMLElement, ev.width, ev.height, ev.drag.left, ev.drag.top, e.inputEvent as MouseEvent)
    }))
    // Shift while rotating snaps to 15° steps
    mv.on('rotateStart', (e) => { mv.throttleRotate = (e.inputEvent as MouseEvent | undefined)?.shiftKey ? 15 : 1 })
    mv.on('rotate', (e) => {
      mv.throttleRotate = (e.inputEvent as MouseEvent | undefined)?.shiftKey ? 15 : 1
      e.target.style.transform = `rotate(${e.rotation}deg)`
    })
    // v1: rotating a container's frame does NOT rotate its children around it
    // (drag/resize DO cascade — see containerCascadeChildren) — so a group
    // rotate whose target set is a container+children cascade must leave the
    // child nodes' transforms untouched, live and at commit.
    mv.on('rotateGroupStart', () => {
      const ids = new Set(this.containerCascadeChildren().map((n) => n.dataset.elId!))
      this.rotateCascadeChildIds = ids.size ? ids : null
    })
    mv.on('rotateGroup', (e) => e.events.forEach((ev) => {
      if (this.rotateCascadeChildIds?.has((ev.target as HTMLElement).dataset.elId!)) return
      ev.target.style.transform = ev.transform
    }))

    const commitFrames = (nodesOverride?: HTMLElement[], cascadeContainerId?: string) => {
      const copies = this.pendingCopy
      this.pendingCopy = null
      if (copies?.length) {
        // one undo step: stationary duplicates (fresh ids) + moved originals
        const nodes = this.selectedNodes()
        const frames = nodes.map((node) => ({
          id: node.dataset.elId!,
          x: parseFloat(node.style.left) || 0,
          y: parseFloat(node.style.top) || 0,
        }))
        this.store.commit(() => {
          const dupes = copies.map((el) => ({ ...el, id: uid(el.type[0]) }))
          // the stationary copies form their own group/container/connector
          // set — sharing the originals' refs merged them into the moved group
          remapCopiedRefs(dupes, new Map(copies.map((el, k) => [el.id, dupes[k].id])))
          this.store.slide.elements.push(...dupes)
          for (const f of frames) {
            const el = this.store.element(f.id)
            if (!el) continue
            el.x = Math.round(f.x * 10) / 10
            el.y = Math.round(f.y * 10) / 10
          }
        })
        return
      }
      this.commitDomFrames(nodesOverride ?? this.selectedNodes(), cascadeContainerId)
    }
    // A lone selected container with children puts its children in
    // moveable.target too (see syncTargets/containerCascadeChildren), so
    // their live-dragged/resized frames must be committed alongside the
    // container's own — and parentOffset re-derived from the new boxes.
    const commitCascade = () => {
      const cascade = this.containerCascadeChildren()
      const containerId = this.store.selection.length === 1 ? this.store.selection[0] : undefined
      commitFrames(cascade.length ? [...this.selectedNodes(), ...cascade] : undefined, containerId)
    }
    mv.on('dragEnd', ({ isDrag }) => {
      setFree(false)
      if (isDrag) commitFrames()
      else this.pendingCopy = null
    })
    mv.on('dragGroupEnd', ({ isDrag }) => {
      setFree(false)
      if (isDrag) commitCascade()
      else this.pendingCopy = null
    })
    mv.on('resizeEnd', ({ isDrag }) => {
      mv.keepRatio = false
      if (isDrag) commitFrames()
    })
    mv.on('resizeGroupEnd', ({ isDrag }) => isDrag && commitCascade())
    mv.on('rotateEnd', ({ isDrag }) => {
      mv.throttleRotate = 1
      if (isDrag) commitFrames()
    })
    mv.on('rotateGroupEnd', ({ isDrag }) => {
      // rotate never cascades (see rotateGroupStart/rotateGroup above) — only
      // the container's own frame changed, so commit just the selection
      if (isDrag) commitFrames()
      this.rotateCascadeChildIds = null
    })
  }

  /** Read live DOM styles back into the model in one undo step. When
   *  `cascadeContainerId` is given, also re-derives every committed child's
   *  `parentOffset` from its new box relative to that container's new box —
   *  the fractions syncContainers reads back on every future move/resize. */
  private commitDomFrames(nodes: HTMLElement[], cascadeContainerId?: string) {
    if (!nodes.length) return
    const frames = nodes.map((node) => {
      const rotation = /rotate\((-?[\d.]+)deg\)/.exec(node.style.transform)
      return {
        id: node.dataset.elId!,
        x: parseFloat(node.style.left) || 0,
        y: parseFloat(node.style.top) || 0,
        w: parseFloat(node.style.width) || 1,
        h: parseFloat(node.style.height) || 1,
        rotation: rotation ? Math.round(parseFloat(rotation[1]) * 10) / 10 : 0,
      }
    })
    this.store.commit(() => {
      for (const f of frames) {
        const el = this.store.element(f.id)
        if (!el) continue
        el.x = Math.round(f.x * 10) / 10
        el.y = Math.round(f.y * 10) / 10
        el.w = Math.round(f.w * 10) / 10
        el.h = Math.round(f.h * 10) / 10
        el.rotation = f.rotation
      }
      if (!cascadeContainerId) return
      const parent = this.store.element(cascadeContainerId)
      if (!parent || !parent.w || !parent.h) return
      for (const f of frames) {
        if (f.id === cascadeContainerId) continue
        const child = this.store.element(f.id)
        if (!child || child.parentId !== cascadeContainerId) continue
        child.parentOffset = {
          relX: (child.x - parent.x) / parent.w,
          relY: (child.y - parent.y) / parent.h,
          relW: child.w / parent.w,
          relH: child.h / parent.h,
        }
      }
    })
  }

  // --- selecto ----------------------------------------------------------------

  private wireSelecto() {
    this.selecto.on('dragStart', (e) => {
      const target = e.inputEvent.target as HTMLElement
      // floating controls over the canvas are not marquee territory
      if (target.closest('.ed-present-fabs, .ed-zoombar, .ed-panel-toggle, .ed-resizer, .ed-minibar, .ed-math-pop')) {
        e.stop()
        return
      }
      if (this.pathEditor?.active || this.cropMode?.engaged) {
        e.stop() // the path / crop overlay owns the pointer while editing
        return
      }
      if (this.editing) {
        // editing a table cell: clicking a DIFFERENT cell switches to it
        if (this.editingCell) {
          const td = (target as HTMLElement)?.closest?.<HTMLElement>('td[data-c]')
          if (td && this.editing.contains(td)) {
            const already = Number(td.dataset.r) === this.editingCell.r && Number(td.dataset.c) === this.editingCell.c
            const id = this.editing.dataset.elId
            // Shift+click another cell: the cells between become the range
            if (!already && (e.inputEvent as MouseEvent).shiftKey && id) {
              this.tableRange.setCell(id, this.editingCell.r, this.editingCell.c)
              this.commitTextEdit()
              this.tableRange.setCell(id, Number(td.dataset.r), Number(td.dataset.c), true)
              e.stop()
              return
            }
            if (!already) { this.editCellFromTd(td); e.stop(); return }
            // same cell: let contentEditable place the caret — and a drag
            // that reaches another cell selects the cells instead
            if (id) this.tableRange.armDrag(id, this.editingCell.r, this.editingCell.c)
            return
          }
        }
        // clicking outside the text being edited commits it; inside, do nothing
        if (!this.editing.contains(target)) this.commitTextEdit()
        e.stop()
        return
      }
      const selected = this.selectedNodes()
      if (
        this.moveable.isMoveableElement(target) ||
        selected.some((n) => n === target || n.contains(target))
      ) {
        e.stop() // let Moveable take the drag
      }
    })

    this.selecto.on('selectEnd', (e) => {
      let rawIds = (e.selected as HTMLElement[])
        .map((n) => n.dataset.elId)
        .filter((id): id is string => !!id)
      // Selecto's click hit-test is GEOMETRIC (point inside the element's box),
      // which ignores the editor's click-through (data-hit). Re-resolve a plain
      // click from the real DOM stack so empty parts of text boxes, lines and
      // outline shapes pass the click to what is underneath.
      if (e.isClick && !this.editing) {
        const mouse = e.inputEvent as MouseEvent | undefined
        if (mouse && typeof mouse.clientX === 'number') {
          const domId = this.resolveClickTarget(mouse.clientX, mouse.clientY)
          if (mouse.shiftKey || mouse.ctrlKey || mouse.metaKey) {
            const added = new Set((e.added as HTMLElement[]).map((n) => n.dataset.elId))
            rawIds = rawIds.filter((id) => id === domId || !added.has(id))
          } else {
            rawIds = domId ? [domId] : []
          }
        }
      }
      const locked = this.lockedIds()
      const userLocked = this.userLockedIds()
      let ids = rawIds.filter((id) => !locked.has(id) && !userLocked.has(id))
      // Selecto's native hit-test found only locked chrome (e.g. a
      // full-slide master background) — fall back to whatever real content
      // sits at the gesture's point rather than just going empty, so a
      // click that visually lands on content still reaches it in one click.
      if (!ids.length && rawIds.some((id) => locked.has(id))) {
        const pt = e.inputEvent as MouseEvent | undefined
        const fallback = pt ? this.resolveClickTarget(pt.clientX, pt.clientY) : null
        if (fallback) ids = [fallback]
        else this.onLockedElementClick?.()
      }
      // A plain click on an unselected backdrop (click-through while idle, so
      // it never starts a drag or blocks the marquee) still selects it.
      if (!ids.length && e.isClick && !this.editing) {
        const pt = e.inputEvent as MouseEvent | undefined
        const r = this.scaleHost.getBoundingClientRect()
        if (pt) {
          const top = this.hitStack((pt.clientX - r.left) / this.scale, (pt.clientY - r.top) / this.scale)
            .find((el) => this.isBackdrop(el) && !el.locked)
          if (top) ids = [top.id]
        }
      }
      this.store.select(this.expandGroups(ids))
      if (e.isDragStartEnd) {
        e.inputEvent.preventDefault()
        this.moveable.waitToChangeTarget().then(() => {
          this.moveable.dragStart(e.inputEvent)
        })
      }
    })
  }

  // --- text editing -----------------------------------------------------------

  startTextEdit(node: HTMLElement) {
    if (this.store.readOnly) return // live viewer — no inline editing
    if (this.editing === node) return
    this.commitTextEdit()
    const inner = node.querySelector<HTMLElement>('.beeslides-text-inner')
    if (!inner) return
    // fields ({{page}} etc.) and math ($…$) render RESOLVED; while editing,
    // show the raw source so the author edits the token, not the computed value
    const model = this.store.element(node.dataset.elId ?? '')
    // Remember that we swapped: on commit the resolved view has to be put back
    // even when the text did NOT change, and only a re-render can do that.
    this.editingShowedRaw = false
    if (model?.type === 'text' && typeof model.html === 'string' && /\{\{|\$/.test(model.html)) {
      // SANITIZED, even though the point of the swap is to show what the model
      // holds. This is the only place raw model html reaches the live canvas —
      // the render path has always cleaned it — so without this, double-
      // clicking a text box in a deck someone sent you ran its script, and the
      // `{{`-or-`$` gate is no barrier at all: one literal dollar sign opens it.
      // Nothing is lost: the sanitizer unwraps tags and strips attributes, so a
      // {{page:2}} token and `$E=mc^2$` TeX source are plain text to it and
      // survive verbatim, which is the entire purpose of showing the raw html.
      inner.innerHTML = sanitizeHtml(model.html)
      this.editingShowedRaw = true
    } else if (model?.type === 'code' && typeof model.content === 'string') {
      // When editing code, we always treat the content as raw text to preserve formatting.
      inner.innerText = model.content
      this.editingShowedRaw = true
    }
    this.editing = node
    this.editingSlideId = this.store.slide.id
    node.classList.add('beeslides-editing')
    inner.contentEditable = 'true'
    inner.focus()
    document.getSelection()?.selectAllChildren(inner)
    this.syncTargets()
    this.emitTextEdit(node.dataset.elId)

    inner.addEventListener('keydown', (ev) => {
      // ⌘, (Settings) is the one global shortcut allowed through — it means
      // nothing to text, and the editor commits this edit before opening
      if ((ev.metaKey || ev.ctrlKey) && ev.key === ',') return
      // ⌘F / ⌥⌘F open the find bar (seeded with the selected words) — the
      // edit commits as the bar takes focus, like ⌘, above
      if (findChord(ev)) return
      ev.stopPropagation() // keep global shortcuts (Delete, arrows…) away
      if (ev.key === 'Escape') {
        ev.preventDefault()
        this.commitTextEdit()
        return
      }
      // rich text: ⌘K link, ⌘⇧7/⌘⇧8 lists, Tab/⇧Tab list level (richtext.ts)
      if (handleRichKey(ev, () => this.richTrigger(inner))) { clearAutoformat(); return }
      // inline markup: ⌘/Ctrl+B/I/U toggle bold/italic/underline on the
      // selection (sanitize keeps b/i/u/strong/em, so it round-trips); the
      // rest of rich text (⌘K, lists, Tab) is handleRichKey above
      if (ev.metaKey || ev.ctrlKey) {
        // ⌘Z right after a markdown conversion restores the literal markers;
        // otherwise the browser's native contentEditable undo runs
        if (ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
          if (undoAutoformat()) ev.preventDefault()
          return
        }
        const cmd = { b: 'bold', i: 'italic', u: 'underline' }[ev.key.toLowerCase()]
        if (cmd) {
          ev.preventDefault()
          document.execCommand(cmd)
        }
      }
    })
    // markdown affordances: **bold** / *italic* / `code` / ~~strike~~ / "- "
    // collapse as you type (⌘Z reverts, backslash escapes); pasted plain
    // text converts the same patterns
    inner.addEventListener('input', () => {
      if (!autoformatAtCaret()) clearAutoformat()
    })
    inner.addEventListener('paste', (ev) => {
      const plain = takePlainPaste() // ⌘⇧V: the words only, no markdown styling
      if (!plain && richPaste(ev)) return // copied from a text edit: keep its formatting
      const text = ev.clipboardData?.getData('text/plain')
      if (!text) return
      ev.preventDefault()
      if (plain) insertLiteralText(text)
      else document.execCommand('insertHTML', false, sanitizeHtml(markdownToHtml(text)))
    })
    inner.addEventListener('copy', (ev) => richCopy(ev, false))
    inner.addEventListener('cut', (ev) => richCopy(ev, true))
    this.armBlurCommit(inner)
  }

  /**
   * End the edit when its text loses focus — unless focus went into a
   * rich-text control (`[data-rt-keep]`: the link field, the colour
   * popover). Then the edit stays live, and is settled when focus leaves
   * that control: back into the text re-arms this, anywhere else commits.
   */
  private armBlurCommit(inner: HTMLElement) {
    inner.addEventListener('blur', (ev) => {
      if (this.editing === null) return
      const to = ev.relatedTarget as HTMLElement | null
      const keep = to?.closest?.<HTMLElement>(`[${RT_KEEP}]`)
      if (!keep) { this.commitTextEdit(); return }
      const settle = (e: FocusEvent) => {
        const next = e.relatedTarget as Node | null
        if (next && keep.contains(next)) return // moving within the control
        keep.removeEventListener('focusout', settle)
        if (!inner.isConnected || this.editing === null) return
        if (next && (next === inner || inner.contains(next))) this.armBlurCommit(inner)
        else this.commitTextEdit()
      }
      keep.addEventListener('focusout', settle)
    }, { once: true })
  }

  /** What a ⌘K link popover anchors to: the mini toolbar's link button when
   *  it is showing, else the text being edited. */
  private richTrigger(inner: HTMLElement): HTMLElement {
    return document.querySelector<HTMLElement>('.ed-minibar:not([hidden]) [data-rt="link"]') ?? inner
  }

  commitTextEdit() {
    const node = this.editing
    if (!node) return
    if (this.editingCell) { this.commitCellEdit(node); return }
    const slideId = this.editingSlideId
    this.editing = null
    this.editingSlideId = null
    this.emitTextEdit(undefined)
    const inner = node.querySelector<HTMLElement>('.beeslides-text-inner')
    const id = node.dataset.elId
    node.classList.remove('beeslides-editing')
    if (!inner || !id) return
    closeRichPopover(false)
    // For code, we care about the raw innerText
    const text = inner.innerText
    // the browser's leftovers (<strike>, <font>, copied inherited styles)
    // into the format's shape — measured while still laid out, so it can
    // compare a run with what it would inherit
    if (this.store.element(id)?.type !== 'code') normalizeRuns(inner)
    inner.contentEditable = 'false'
    // drop the zero-width caret spacers autoformat leaves behind
    const html = sanitizeHtml(inner.innerHTML.replace(/\u200B/g, '').replace(/\\([*_~`-])/g, '$1'))
    const grownH = Math.max(parseFloat(node.style.height) || 0, inner.scrollHeight)
    const el = this.editedSurface(slideId)?.elements.find((element) => element.id === id)
    if (el && el.type === 'text' && (el.html !== html || grownH > el.h)) {
      this.store.commit(() => {
        el.html = html
        if (grownH > el.h) el.h = Math.ceil(grownH)
      })
    } else if (el && el.type === 'code' && (el.content !== text || grownH > el.h)) {
      this.store.commit(() => {
        el.content = text
        if (grownH > el.h) el.h = Math.ceil(grownH)
      })
    } else if (this.editingShowedRaw) {
      // Nothing changed, so there is no commit to re-render off the back of —
      // but startTextEdit replaced the rendered formula (or {{page}} field)
      // with its raw source, and that raw source is still on screen. Editing a
      // formula and changing nothing left `$$x = \\frac{…}$$` sitting on the
      // slide until some unrelated event happened to repaint. Put the resolved
      // view back.
      this.editingShowedRaw = false
      this.render()
    } else {
      this.syncTargets()
    }
    this.flushPendingRender()
  }

  /** The surface an inline edit began on, by the id `editingSlideId` recorded:
   *  a deck slide, or — while the Layout Manager has a slide type or a
   *  reusable object open — that `doc.layouts` / `doc.reusableObjects` entry.
   *  Looking in `doc.slides` alone silently dropped every text/cell edit made
   *  on a slide type or object. Undefined when it was deleted meanwhile. */
  private editedSurface(slideId: string | null): Slide | undefined {
    if (!slideId) return undefined
    const doc = this.store.doc
    return doc.slides.find((s) => s.id === slideId)
      ?? doc.layouts?.find((l) => l.id === slideId)
      ?? doc.reusableObjects?.find((o) => o.id === slideId)
  }

  /** Run a repaint that was deferred while an inline edit was in progress (a
   *  remote op that arrived mid-edit). No-op when nothing is pending. Runs
   *  after the commit above, so the repaint reflects the merged model. */
  private flushPendingRender() {
    if (this.pendingRender) { this.pendingRender = false; this.render() }
  }

  // --- table cell editing -----------------------------------------------------

  /** Enter cell editing from a clicked/dbl-clicked <td> (re-queries fresh). */
  private editCellFromTd(td: HTMLElement) {
    const tableNode = td.closest<HTMLElement>('.beeslides-el-table')
    const id = tableNode?.dataset.elId
    if (!id) return
    this.editCellAt(id, Number(td.dataset.r), Number(td.dataset.c))
  }

  /** Commit any current edit, then edit cell (r,c) of table `id`. */
  private editCellAt(id: string, r: number, c: number) {
    if (this.store.readOnly) return // live viewer — no inline editing
    this.commitTextEdit()
    const td = this.surface?.querySelector<HTMLElement>(
      `[data-el-id="${CSS.escape(id)}"] td[data-r="${r}"][data-c="${c}"]`)
    if (!td) return
    const node = td.closest<HTMLElement>('.beeslides-el-table')
    const inner = td.querySelector<HTMLElement>('.beeslides-cell-inner')
    if (!node || !inner) return
    // a cell's $…$ math renders typeset; edit its SOURCE, the way
    // startTextEdit does for a text box. Mandatory, not cosmetic: committing
    // the rendered MathML would sanitize it down to bare glyphs and lose the
    // TeX for good.
    const cellModel = this.store.element(id)
    const rawCell = cellModel?.type === 'table' ? cellModel.rows[r]?.cells[c]?.html : undefined
    this.editingShowedRaw = typeof rawCell === 'string' && rawCell.includes('$')
    if (this.editingShowedRaw) inner.innerHTML = sanitizeHtml(rawCell!) || '<br>'
    this.editing = node
    this.editingSlideId = this.store.slide.id
    this.editingCell = { r, c }
    this.tableRange.setCell(id, r, c) // stays the active cell when the edit ends
    node.classList.add('beeslides-editing')
    inner.contentEditable = 'true'
    inner.focus()
    document.getSelection()?.selectAllChildren(inner)
    this.syncTargets()
    this.emitTextEdit(id)

    inner.addEventListener('keydown', (ev) => {
      if (findChord(ev)) return // the find bar, as in startTextEdit
      ev.stopPropagation()
      if (ev.key === 'Escape') { ev.preventDefault(); this.commitTextEdit(); return }
      // in a list, Tab changes the item's level; anywhere else it moves cells
      if (handleRichKey(ev, () => this.richTrigger(inner))) { clearAutoformat(); return }
      if (ev.key === 'Tab') { ev.preventDefault(); this.moveCell(ev.shiftKey ? -1 : 1, 'cell'); return }
      // Enter in a list item makes the next item (an empty one ends the
      // list), as in a text box; elsewhere it moves down a row
      if (ev.key === 'Enter' && !ev.shiftKey && listAt(inner)) return
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this.moveCell(1, 'row'); return }
      // an arrow that would leave the text moves to the neighbouring cell
      // (past a merged cell's whole block); Shift+arrow stays text selection
      const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[ev.key as 'ArrowUp']
      if (dir && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey && caretAtEdge(inner, dir)) {
        const el = this.store.element(id)
        const cur = this.editingCell
        const to = el?.type === 'table' && cur ? cellToward(el, cur.r, cur.c, dir) : null
        if (to) { ev.preventDefault(); this.editCellAt(id, to[0], to[1]); return }
      }
      if (ev.metaKey || ev.ctrlKey) {
        if (ev.key.toLowerCase() === 'z' && !ev.shiftKey) { if (undoAutoformat()) ev.preventDefault(); return }
        const cmd = { b: 'bold', i: 'italic', u: 'underline' }[ev.key.toLowerCase()]
        if (cmd) { ev.preventDefault(); document.execCommand(cmd) }
      }
    })
    inner.addEventListener('input', () => { if (!autoformatAtCaret()) clearAutoformat() })
    inner.addEventListener('paste', (ev) => {
      const plain = takePlainPaste() // ⌘⇧V: the words only, no markdown styling
      if (!plain && richPaste(ev)) return // copied from a text edit: keep its formatting
      const text = ev.clipboardData?.getData('text/plain')
      if (!text) return
      ev.preventDefault()
      if (plain) insertLiteralText(text)
      else document.execCommand('insertHTML', false, sanitizeHtml(markdownToHtml(text)))
    })
    inner.addEventListener('copy', (ev) => richCopy(ev, false))
    inner.addEventListener('cut', (ev) => richCopy(ev, true))
    this.armBlurCommit(inner)
  }

  private commitCellEdit(node: HTMLElement) {
    const cell = this.editingCell!
    const id = node.dataset.elId
    const slideId = this.editingSlideId
    this.editing = null
    this.editingSlideId = null
    this.editingCell = null
    this.emitTextEdit(undefined)
    node.classList.remove('beeslides-editing')
    const inner = node.querySelector<HTMLElement>(
      `td[data-r="${cell.r}"][data-c="${cell.c}"] .beeslides-cell-inner`)
    if (!inner || !id) return
    closeRichPopover(false)
    normalizeRuns(inner)
    inner.contentEditable = 'false'
    const html = sanitizeHtml(inner.innerHTML.replace(/\u200B/g, '').replace(/\\([*_~`-])/g, '$1'))
    const el = this.editedSurface(slideId)?.elements.find((element) => element.id === id)
    if (el && el.type === 'table' && el.rows[cell.r]?.cells[cell.c] && el.rows[cell.r].cells[cell.c].html !== html) {
      this.editingShowedRaw = false
      this.store.commit(() => {
        const tb = el as TableElement
        if (tb.rows[cell.r]?.cells[cell.c]) tb.rows[cell.r].cells[cell.c].html = html
      })
    } else if (this.editingShowedRaw) {
      // unchanged, but the cell still shows its TeX source: typeset it again
      this.editingShowedRaw = false
      this.render()
    } else {
      this.syncTargets()
    }
    this.flushPendingRender()
  }

  /** Make the cell under `target` (a node inside table `elId` on the canvas)
   *  the active cell, or extend the range to it. A right-click inside the
   *  current range keeps the range — the menu acts on all of it. */
  private pickCellAt(elId: string | null, target: EventTarget | null, mode: 'click' | 'extend' | 'context') {
    if (!elId || this.store.element(elId)?.type !== 'table' || this.editingCell) return
    const td = target instanceof Element ? target.closest<HTMLElement>('td[data-r][data-c]') : null
    if (!td || td.closest<HTMLElement>('.beeslides-el-table')?.dataset.elId !== elId || !td.closest('.ed-stage-scale')) return
    const r = Number(td.dataset.r)
    const c = Number(td.dataset.c)
    const rect = this.tableRange.rect()
    if (mode === 'context' && rect && r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1) return
    this.tableRange.setCell(elId, r, c, mode === 'extend')
  }

  /** Tab/Enter navigation between cells — covered cells (under a merged
   *  one) are skipped; Tab off the last cell appends a row. */
  private moveCell(dir: 1 | -1, mode: 'cell' | 'row') {
    const cur = this.editingCell
    const id = this.editing?.dataset.elId
    if (!cur || !id) return
    const el = this.store.element(id)
    if (!el || el.type !== 'table') return
    const nRows = el.rows.length
    const to = mode === 'row'
      ? cellToward(el, cur.r, cur.c, dir > 0 ? 'down' : 'up')
      : nextCell(el, cur.r, cur.c, dir)
    if (to) { this.editCellAt(id, to[0], to[1]); return }
    this.commitTextEdit()
    if (mode === 'cell' && dir > 0) {
      this.store.commit(() => {
        const tb = this.store.element(id) as TableElement
        tb.rows.push({ cells: tb.columns.map(() => ({ html: '' })) })
      })
      this.editCellAt(id, nRows, 0)
    }
  }

  get isEditingText() {
    return !!this.editing
  }

  /** True while the inline edit is a table CELL (isEditingText is too). */
  get isEditingCell() {
    return !!this.editingCell
  }

  get isDrawing() {
    return !!this.drawOverlay
  }

  /** Arm a draw tool: line/curve/connector drag start→end (click = default);
   *  'free' captures the pointer trail; 'poly' click-places vertices — click
   *  near the first point (or double-click) to close the shape. Connector ends
   *  SNAP to visible anchor points (side midpoints + centre) on the element
   *  under the cursor and anchor there (auto-reroute afterwards). Esc cancels. */
  armDraw(kind: DrawKind) {
    this.cancelDraw()
    const { width, height } = effectiveCanvasSize(this.store)
    const ov = document.createElement('div')
    ov.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;z-index:60;cursor:crosshair`
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none'
    const preview = document.createElementNS(SVG_NS, 'path')
    preview.setAttribute('fill', 'none')
    preview.setAttribute('stroke', '#2f6df6')
    const dots = document.createElementNS(SVG_NS, 'g')
    svg.append(preview, dots)
    ov.appendChild(svg)
    this.scaleHost.appendChild(ov)
    this.drawOverlay = ov
    const k = () => 1 / this.scale
    const toSlide = (ev: MouseEvent) => {
      const r = this.scaleHost.getBoundingClientRect()
      return { x: (ev.clientX - r.left) / this.scale, y: (ev.clientY - r.top) / this.scale }
    }
    const setPreview = (d: string) => {
      preview.setAttribute('stroke-width', String(3 * k()))
      preview.setAttribute('stroke-dasharray', `${6 * k()} ${4 * k()}`)
      preview.setAttribute('d', d)
    }
    type Pt = { x: number; y: number }
    type Snap = { el: string; side: 'auto' | 'top' | 'right' | 'bottom' | 'left'; pt: Pt } | null
    const anchorsFor = (id: string) => {
      const e = this.store.slide.elements.find((x) => x.id === id)!
      return [
        { side: 'top' as const, pt: { x: e.x + e.w / 2, y: e.y } },
        { side: 'right' as const, pt: { x: e.x + e.w, y: e.y + e.h / 2 } },
        { side: 'bottom' as const, pt: { x: e.x + e.w / 2, y: e.y + e.h } },
        { side: 'left' as const, pt: { x: e.x, y: e.y + e.h / 2 } },
        { side: 'auto' as const, pt: { x: e.x + e.w / 2, y: e.y + e.h / 2 } },
      ]
    }
    // visible anchor points on the element under the cursor (connector tool)
    const showAnchors = (p: Pt | null) => {
      dots.innerHTML = ''
      if (kind !== 'connector' || !p) return
      const id = this.elementAt(p, 12 * Math.max(k(), 1))
      if (!id) return
      for (const a of anchorsFor(id)) {
        const c = document.createElementNS(SVG_NS, 'circle')
        c.setAttribute('cx', String(a.pt.x))
        c.setAttribute('cy', String(a.pt.y))
        c.setAttribute('r', String(5 * k()))
        c.setAttribute('fill', '#2f6df6')
        c.setAttribute('stroke', '#fff')
        c.setAttribute('stroke-width', String(1.5 * k()))
        dots.appendChild(c)
      }
    }
    const snap = (p: Pt): { a: Snap; pt: Pt } => {
      if (kind !== 'connector') return { a: null, pt: this.snapPoint(p) }
      const id = this.elementAt(p, 12 * Math.max(k(), 1))
      if (!id) return { a: null, pt: this.snapPoint(p) }
      let best: Snap = null
      let bd = 30 * Math.max(k(), 1)
      for (const cand of anchorsFor(id)) {
        const d = Math.hypot(p.x - cand.pt.x, p.y - cand.pt.y)
        if (d < bd) { bd = d; best = { el: id, side: cand.side, pt: cand.pt } }
      }
      return best ? { a: best, pt: best.pt } : { a: { el: id, side: 'auto', pt: p }, pt: this.snapPoint(p) }
    }

    if (kind === 'poly') {
      const verts: Pt[] = []
      const redraw = (cur?: Pt) => {
        if (!verts.length) return setPreview('')
        let d = `M ${verts[0].x} ${verts[0].y}` + verts.slice(1).map((v) => ` L ${v.x} ${v.y}`).join('')
        if (cur) d += ` L ${cur.x} ${cur.y}`
        setPreview(d)
      }
      const finish = () => {
        if (verts.length >= 3) {
          const el = defaultShape('path', shapeDefaultsFor(this.store.doc, this.store.slide, 'path')) as ShapeElement
          setPathAnchors(el, verts, { closed: true, straight: true })
          this.insert(el)
        }
        this.cancelDraw()
      }
      ov.addEventListener('mousedown', (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
        const p = this.snapPoint(toSlide(ev), ev.altKey)
        if (verts.length >= 3 && Math.hypot(p.x - verts[0].x, p.y - verts[0].y) < 16 * Math.max(k(), 1)) return finish()
        verts.push(p)
        redraw(p)
      })
      ov.addEventListener('mousemove', (ev: MouseEvent) => redraw(this.snapPoint(toSlide(ev), ev.altKey)))
      ov.addEventListener('dblclick', (ev: MouseEvent) => { ev.preventDefault(); finish() })
      return
    }

    if (kind === 'free') {
      ov.addEventListener('mousedown', (down: MouseEvent) => {
        down.preventDefault()
        down.stopPropagation()
        const raw: Pt[] = [toSlide(down)]
        const move = (e: MouseEvent) => {
          raw.push(toSlide(e))
          setPreview('M ' + raw.map((p) => `${p.x} ${p.y}`).join(' L '))
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          const pts = simplifyPoints(raw, 3)
          if (pts.length >= 2) {
            const el = defaultShape('path', lineDefaultsFor(this.store.doc, this.store.slide, 'path')) as ShapeElement
            setPathAnchors(el, pts.length > 2 ? pts : [pts[0], { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, pts[1]])
            this.insert(el)
          }
          this.cancelDraw()
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      })
      return
    }

    // line / curve / connector: drag start → end
    ov.addEventListener('mousemove', (ev: MouseEvent) => {
      if (!(ev.buttons & 1)) showAnchors(toSlide(ev))
    })
    ov.addEventListener('mousedown', (down: MouseEvent) => {
      down.preventDefault()
      down.stopPropagation()
      const s0 = snap(toSlide(down))
      const start = s0.pt
      const move = (e: MouseEvent) => {
        const p = toSlide(e)
        const sn = snap(p)
        showAnchors(p)
        setPreview(kind === 'path' ? this.curveBowD(start, sn.pt) : `M ${start.x} ${start.y} L ${sn.pt.x} ${sn.pt.y}`)
      }
      const up = (e: MouseEvent) => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        const sn = snap(toSlide(e))
        const short = Math.hypot(sn.pt.x - start.x, sn.pt.y - start.y) < 8
        const end = short ? { x: start.x + 320, y: start.y } : sn.pt
        this.createDrawn(kind, start, end, s0.a ?? undefined, short ? undefined : sn.a ?? undefined)
        this.cancelDraw()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
  }

  cancelDraw() {
    this.drawOverlay?.remove()
    this.drawOverlay = null
  }

  /** SVG path 'd' for a gentle bow between two points (curve preview + default). */
  private curveBowD(a: { x: number; y: number }, b: { x: number; y: number }): string {
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const off = len * 0.2
    return `M ${a.x} ${a.y} Q ${mx - (dy / len) * off} ${my + (dx / len) * off} ${b.x} ${b.y}`
  }

  /** Topmost non-line element whose box contains pt (for connector anchoring).
   *  `pad` forgives near-misses just outside the border. */
  private elementAt(pt: { x: number; y: number }, pad = 0): string | null {
    const els = this.store.slide.elements
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i]
      if (e.type === 'shape' && (e.shape === 'line' || e.shape === 'path')) continue
      if (pt.x >= e.x - pad && pt.x <= e.x + e.w + pad && pt.y >= e.y - pad && pt.y <= e.y + e.h + pad) return e.id
    }
    return null
  }

  private createDrawn(
    kind: DrawKind,
    a: { x: number; y: number },
    b: { x: number; y: number },
    fromA?: { el: string; side: 'auto' | 'top' | 'right' | 'bottom' | 'left' },
    toA?: { el: string; side: 'auto' | 'top' | 'right' | 'bottom' | 'left' },
  ) {
    // the slide type's line style (Layout Manager ▸ Default styles); a line
    // paints with its fill, a curve with its stroke — lineDefaultsFor maps it
    if (kind === 'path') {
      const el = defaultShape('path', lineDefaultsFor(this.store.doc, this.store.slide, 'path')) as ShapeElement
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const off = len * 0.2
      setPathAnchors(el, [a, { x: mx - (dy / len) * off, y: my + (dx / len) * off }, b])
      this.insert(el)
      return
    }
    const el = defaultShape('line', { h: 4, ...lineDefaultsFor(this.store.doc, this.store.slide, 'line') }) as ShapeElement
    setLineEndpoints(el, a, b)
    if (kind === 'connector') {
      el.lineEnd = 'arrow' // a connector points, whatever the line style's tips
      if (fromA) el.from = { el: fromA.el, side: fromA.side }
      if (toA) el.to = { el: toA.el, side: toA.side }
    }
    this.insert(el)
  }

  /** Insert an element, select it, and (for text) drop straight into editing. */
  insert(el: SlideElement, startEditing = false) {
    // inserting while previewing a non-default hover set joins that set —
    // "I'm editing the italy panel" means new content belongs to it
    const slide = this.store.slide
    const preview = this.store.hoverPreview
    if (preview && slide.hover?.type === 'reveal' && preview !== slide.hover.default) {
      el.showOnHover = preview
    }
    this.store.commit(() => {
      // Embedded binary belongs in doc.assets, never inline on the element —
      // one place binary content lives. Done INSIDE the commit so the asset
      // and the element land as one undo step.
      if ((el.type === 'image' || el.type === 'media') && typeof el.src === 'string') {
        el.src = internAsset(this.store.doc, el.src)
      }
      this.store.slide.elements.push(el)
    })
    this.store.select([el.id])
    if (startEditing && el.type === 'text') {
      const node = this.surface?.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (node) this.startTextEdit(node)
    }
  }
}

/**
 * Whether an arrow key would take the caret out of a table cell's text:
 * ←/→ at its very start/end, ↑/↓ on its first/last line (measured from the
 * caret's box; an empty cell has none, so start/end decides).
 */
function caretAtEdge(inner: HTMLElement, dir: 'up' | 'down' | 'left' | 'right'): boolean {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return false
  // an empty cell: nothing to move through, any arrow leaves (its select-all
  // around a lone <br> does not even collapse on an arrow)
  if (!inner.textContent?.replace(/\u200B/g, '').trim()) return true
  if (!sel.isCollapsed) return false
  const caret = sel.getRangeAt(0)
  if (!inner.contains(caret.startContainer)) return false
  const before = document.createRange()
  before.selectNodeContents(inner)
  before.setEnd(caret.startContainer, caret.startOffset)
  const after = document.createRange()
  after.selectNodeContents(inner)
  after.setStart(caret.startContainer, caret.startOffset)
  const atStart = !before.toString().replace(/\u200B/g, '').length
  const atEnd = !after.toString().replace(/\u200B/g, '').length
  if (dir === 'left') return atStart
  if (dir === 'right') return atEnd
  if (dir === 'up' ? atStart : atEnd) return true
  const r = caret.getClientRects()[0]
  if (!r || !r.height) return false
  const box = inner.getBoundingClientRect()
  return dir === 'up' ? r.top - box.top < r.height * 0.9 : box.bottom - r.bottom < r.height * 0.9
}
