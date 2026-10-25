// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Right-hand properties panel. Shows slide properties when nothing is
// selected, element properties otherwise. Bursts of 'input' events collapse
// into a single undo checkpoint (see elementactions.ts, shared with the mini
// toolbar).
//
// Element panels are TIERED: a fixed header holds the type name, Duplicate/
// Delete and the handful of basics you select the element to change; every
// other section starts collapsed, and a closed header shows a dot when the
// element carries non-default values in it — so nothing is hidden without a
// trace, and nothing is open that you didn't ask for.
//
// This file is the panel's shell: lifecycle and store listeners, the rebuild
// dispatch, the accordion and section order, the stale/focus guard and the
// live-step colour refresh, plus the element ops and arrange kit that are its
// public API. The builders live in panels/: context.ts (PanelContext, the
// controls they draw with), slide.ts, iconset.ts, element.ts, objects.ts and
// charts.ts.

import { displayChord } from './customize/logic'
import { isMacOS } from '../screens'
import type { Store } from '../store'
import { effectiveCanvasSize } from '../store'
import { panelSectionId } from './customize/catalog'
import { alignUnits, applyMoves, distributeMin, effectiveRef, planAlign, planCenterOnSlide, planDistribute, type AlignEdge, type AlignRef } from '../alignment'
import { guardLayout, snapshotSlide, staticBaseline, type Baseline } from '../layoutguard'
import { isLineLike } from './lineedit'
import { resolveAgentSlide, defaultShape, uid, type ShapeElement, type Slide, type SlideElement, type TextElement } from '../model'
import type { ElementChange } from '../actionlog'
import { askText } from './comments'
import { canFlip } from '../render'
import { measureElement } from '../measure'
import { _readPath as readPath } from '../palette'
import { onSystemFontsReady } from '../localfonts'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { convertSvgInPlace } from './svgtoobjects'
import { lsJson, lsSet } from '../../../kernel/src/storage.ts'
import { closeActiveColorPopover, combineColor, parseColor, syncColorControl } from './colorpicker'
import type { TableRange } from './tablerange'
import { ElementEdits, type ColorRef } from './elementactions'
import { remapCopiedRefs } from './clipboard'
import { FrameCoalescer, inLiveStep } from './livestep'
import { jsonClone } from '../jsonclone.ts'
import { PanelContext, toast } from './panels/context'
import { buildLayoutSurfacePanel, buildReusableObjectPanel, buildSlidePanel } from './panels/slide'
import { buildIconShapeStyle } from './panels/iconset'
import { buildAdvancedProps, buildAltProps, buildEffectsProps, buildHistoryProps, buildMultiStyle, buildPresentingProps, buildProvenanceProps } from './panels/element'
import { buildCodeProps, buildEmbedProps, buildImageProps, buildMathProps, buildMediaProps, buildShapeProps, buildSvgProps, buildTextProps, buildZoomProps } from './panels/objects'
import { buildChartProps, buildTableProps } from './panels/charts'

// parseColor/combineColor now live in colorpicker.ts (the color popover needs
// them too); re-exported here so this module's public surface is unchanged.
export { parseColor, combineColor }
// The deck-wide theme swatches moved to panels/slide.ts with the slide panel;
// the Layout Manager imports them from here.
export { renderThemeSwatches } from './panels/slide'

export class PropsPanel {
  // --- arrange-tool session state --------------------------------------------
  // Modes for the arrange kit's Space row. These are TOOL settings, not
  // document properties — they never enter the model, so they live as plain
  // instance fields (this PropsPanel outlives every selection change, so a
  // choice made here survives the next rebuild without persisting anywhere).
  /** 'edge' (default, unchanged): distribute() equalizes edge-to-edge gaps.
   *  'center': equalizes center-to-center spacing instead. */
  private distributeMode: 'edge' | 'center' = 'edge'
  /** Fixed gap in px for distribute(), overriding the derived even spacing.
   *  null = automatic (the original behavior). */
  private distributeGap: number | null = null
  /** Which value matchSize() uses as the reference. 'first' (default,
   *  unchanged) = first-selected element, matching prior behavior exactly. */
  private matchSizeMode: 'first' | 'largest' | 'smallest' | 'average' = 'first'
  /** What Align and Distribute line things up against when more than one
   *  object is selected (one object always uses the slide). Shared by the
   *  panel, ribbon, Arrange menu and keys — so it is shown wherever it is
   *  used, never a hidden mode like PowerPoint's. */
  private _alignRef: AlignRef = 'selection'
  /** "More arrange options" open/closed, for the session. */
  private static arrangeFoldOpen = false
  /** The UI profile's section order (catalog.ts PANEL_SECTIONS ids). */
  sectionOrder: () => readonly string[] = () => []
  /** Called when alignRef changes (the ribbon and menu reflect it). */
  onAlignRefChange: (() => void) | null = null
  get alignRef(): AlignRef { return this._alignRef }
  set alignRef(v: AlignRef) {
    if (v === this._alignRef) return
    this._alignRef = v
    this.rebuild(true)
    this.onAlignRefChange?.()
  }

  constructor(
    private host: HTMLElement,
    private store: Store,
    /** The shared edit layer — Editor hands the SAME instance to the mini
     *  toolbar, so a burst started on either surface is one undo step. */
    readonly edits: ElementEdits = new ElementEdits(store),
  ) {
    this.ctx = new PanelContext(host, store, this.edits, this,
      (force) => this.rebuild(force), (control, value, ref) => this.trackColor(control, value, ref))
    // Selection/slide switches always rebuild — the user acted outside the
    // panel, so whatever input was focused is obsolete. Doc mutations respect
    // a focused input (skip + mark stale) and catch up when focus leaves.
    store.on('selection', () => this.rebuild(true))
    store.on('current', () => this.rebuild(true))
    // A live step of a burst (a colour drag in the mini toolbar, typing in
    // the notes pane) does not rebuild: the colour chips showing a changed
    // value refresh in place at the next frame, and the burst's FINAL step —
    // an ordinary synchronous 'doc' — rebuilds everything (History, warnings,
    // structure). See onLiveStep.
    store.on('doc', () => (inLiveStep() ? this.onLiveStep() : this.rebuild()))
    store.on('look', () => this.rebuild(true))
    onSystemFontsReady(() => this.rebuild())
    this.host.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.stale && !this.host.matches(':focus-within')) this.rebuild()
      }, 0)
    })
    this.rebuild()
  }

  /** What the builders (panels/) draw with; lives as long as the panel. */
  private readonly ctx: PanelContext

  /** Hide/show the whole slide-panel selection in one undo step (Editor). */
  setSlidesHidden?: (on: boolean) => void
  /** The canvas's selected table cells (editor/tablerange.ts) — set by the
   *  Editor; the table panel's Cells block acts on them. */
  tableCells: TableRange | null = null

  /** The selected cells changed: refresh a table's panel (merge/split etc.
   *  enable by them). */
  refreshTableCells() {
    const els = this.store.selectedElements
    if (els.length === 1 && els[0].type === 'table') this.rebuild()
  }

  private stale = false

  /**
   * True only while the user is mid-edit in a control a rebuild would
   * disrupt: typing in text/number fields, or the native color popup.
   * Discrete controls (selects, checkboxes, buttons) commit atomically, so
   * the panel rebuilds the moment they change — structural rows (shadow
   * color, fx options) appear immediately instead of after focus leaves.
   */
  private isActiveEditFocus(): boolean {
    const a = document.activeElement as HTMLElement | null
    if (!a || !this.host.contains(a)) return false
    if (a.tagName === 'TEXTAREA' || a.isContentEditable) return true
    if (a.tagName === 'INPUT') {
      const t = (a as HTMLInputElement).type
      return t !== 'checkbox' && t !== 'radio' && t !== 'button'
    }
    return false
  }

  /** One undoable edit (burst-aware) — forwards to the shared edit layer. */
  private edit(mutate: () => void, final: boolean) {
    this.edits.edit(mutate, final)
  }

  /** Colour chips of the current build whose shown value IS the colour at
   *  their refs — the only panel values a live step changes from outside the
   *  panel (live steps come from colour drags, gradient stops, chart cells
   *  and notes; inside the panel the focused control already shows its own
   *  value). */
  private liveColors: Array<{ control: HTMLElement; refs: readonly ColorRef[] }> = []
  private readonly liveSync = new FrameCoalescer(() => this.syncLiveColors())
  /** Catch-up rebuild for a burst that pauses or never sends its final step. */
  private liveIdle = 0
  private static LIVE_IDLE_MS = 250

  /**
   * A live (non-final) step changed the doc. Rebuilding here cost ~1 ms of
   * script + layout per pointer step for a mini-toolbar colour drag on a
   * 40-element slide, though the only values such a step changes under an
   * unfocused panel are colours. So:
   * refresh the tracked colour chips at the next frame (one per frame) and
   * leave everything else to the final step's synchronous rebuild — or to a
   * rebuild once the burst has been idle for LIVE_IDLE_MS, so a pause (or a
   * burst whose final step never comes) never leaves the panel behind.
   */
  private onLiveStep() {
    this.liveSync.schedule()
    clearTimeout(this.liveIdle)
    this.liveIdle = window.setTimeout(() => { this.liveIdle = 0; this.rebuild() }, PropsPanel.LIVE_IDLE_MS)
  }

  /** The colour at `refs`, or undefined when they disagree or hold no string. */
  private colorAtRefs(refs: readonly ColorRef[]): string | undefined {
    let out: string | undefined
    for (const ref of refs) {
      const holder = ref.id ? this.store.element(ref.id) : this.store.slide
      const v = holder ? readPath(holder, ref.path) : undefined
      if (typeof v !== 'string' || (out !== undefined && v !== out)) return undefined
      out = v
    }
    return out
  }

  /** Track a panel colour chip for live in-place refresh — only when the
   *  value it shows is exactly the colour at its refs (a derived display,
   *  like an invisible stroke's grey or a mixed selection's first value,
   *  waits for the rebuild). */
  private trackColor(control: HTMLElement, value: string, ref: ColorRef | ColorRef[] | undefined) {
    if (!ref) return
    const refs = Array.isArray(ref) ? ref : [ref]
    if (refs.length && this.colorAtRefs(refs) === value) this.liveColors.push({ control, refs })
  }

  private syncLiveColors() {
    for (const { control, refs } of this.liveColors) {
      const v = this.colorAtRefs(refs)
      if (v !== undefined) syncColorControl(control, v)
    }
  }

  private rebuild(force = false) {
    this.liveSync.cancel()
    clearTimeout(this.liveIdle)
    this.liveIdle = 0
    if (!force && (this.isActiveEditFocus() || this.ctx.gradDragging)) {
      this.stale = true // don't rip the field out from under the user; catch up on focusout
      return
    }
    // A color popover is a DOM child of this.host (see colorpicker.ts), so an
    // ordinary wipe below would destroy it without running its own teardown —
    // leaking its document-level pointerdown/keydown listeners. Close it
    // explicitly first. (While its hex field is focused, isActiveEditFocus()
    // above already deferred this rebuild; this covers the FORCED-rebuild and
    // nothing-focused cases that guard doesn't.) Scoped to this.host: a
    // popover opened from the mini toolbar is not ours to close — a colour
    // drag there rebuilds this panel at its final step (and when it pauses).
    closeActiveColorPopover(this.host)
    // No burst reset here any more: the burst belongs to the shared edit
    // layer, which resets it on selection/slide changes. Resetting on every
    // 'doc' rebuild would split a toolbar colour drag into one undo step per
    // pointer move.
    const scrollTop = this.host.scrollTop
    this.stale = false
    this.liveColors = []
    this.host.innerHTML = ''
    const els = this.store.selectedElements
    if (els.length === 0 && this.store.editingSurface?.kind === 'reusableObject') buildReusableObjectPanel(this.ctx)
    else if (els.length === 0 && this.store.editingSurface?.kind === 'layout') buildLayoutSurfacePanel(this.ctx)
    else if (els.length === 0) buildSlidePanel(this.ctx)
    else if (els.length === 1) this.buildElementPanel(els[0])
    else this.buildMultiPanel(els)
    this.applyAccordion()
    this.orderSections()
    // A doc-driven rebuild (a value changed) must not jump the panel back to
    // the top — the user is usually looking at the control they just used.
    if (!force) this.host.scrollTop = scrollTop
  }

  /**
   * Sections that start collapsed until the user opens them. Keyed by the
   * ENGLISH section key (never the translated title — see applyAccordion).
   * Element panels are tiered: everything past the fixed basics header starts
   * closed, and a closed header shows a dot when it holds custom values.
   */
  private static CLOSED_BY_DEFAULT = new Set([
    // slide panel
    'Slideshow', 'Interactivity', 'Fonts', 'Default styles', 'Builds', 'Auto-play',
    // element panel — the per-type "more" sections…
    'Typography', 'Fill & stroke', 'Stroke', 'Series', 'Style', 'Source & playback', 'Source & license', 'Source Code',
    // …and the shared ones
    'Position & size', 'Effects', 'Arrange', 'Presenting', 'Advanced', 'History',
  ])

  /** Open/closed state, keyed by English section key. v1 was keyed by the
   *  TRANSLATED title, so every section fell back to its default in any
   *  non-English locale; v2 migrates each key from v1 the first time it is
   *  looked up and leaves v1 in place, so a rollback still finds its state. */
  private static OPEN_KEY = 'slidomingo-panel-open-v2'
  private static OPEN_KEY_V1 = 'slidomingo-panel-open'

  private isSectionOpen(key: string, state: Record<string, boolean>): boolean {
    if (typeof state[key] === 'boolean') return state[key]
    const v1 = lsJson<Record<string, boolean>>(PropsPanel.OPEN_KEY_V1, {})
    const old = v1[t(key)] ?? v1[key]
    if (typeof old === 'boolean') {
      state[key] = old
      lsSet(PropsPanel.OPEN_KEY, JSON.stringify(state))
      return old
    }
    return !PropsPanel.CLOSED_BY_DEFAULT.has(key)
  }

  /**
   * Retrofit the flat panel into an accordion: every .ed-section header
   * gathers its following siblings into a collapsible body. Headers become
   * real buttons (keyboard + screen-reader operable: aria-expanded/-controls,
   * the body hidden with `hidden`). A `fixed` header (the element's type +
   * basics) is never collapsible. A `modified` header shows a dot while
   * CLOSED — it never auto-opens, which would undo the point of tiering.
   */
  /** Re-sort the (collapsible) sections by the profile's order: the fixed
   *  header stays on top, listed sections follow in their order, the rest
   *  keep their own order after them. Runs after applyAccordion, when each
   *  section is a header + body pair. */
  private orderSections() {
    const order = this.sectionOrder()
    if (!order.length) return
    const pairs = [...this.host.querySelectorAll<HTMLElement>(':scope > .ed-section:not([data-fixed])')]
      .map((h, i) => ({ h, body: h.nextElementSibling as HTMLElement | null, i, rank: order.indexOf(panelSectionId(h.dataset.key ?? '')) }))
    pairs.sort((a, b) => (a.rank < 0 ? order.length : a.rank) - (b.rank < 0 ? order.length : b.rank) || a.i - b.i)
    for (const p of pairs) {
      this.host.appendChild(p.h)
      if (p.body?.classList.contains('ed-section-body')) this.host.appendChild(p.body)
    }
  }

  private applyAccordion() {
    const state = lsJson<Record<string, boolean>>(PropsPanel.OPEN_KEY, {})
    const headers = [...this.host.querySelectorAll<HTMLElement>('.ed-section')]
    headers.forEach((h, i) => {
      const key = h.dataset.key ?? h.textContent ?? ''
      const body = document.createElement('div')
      body.className = 'ed-section-body'
      let n: ChildNode | null = h.nextSibling
      while (n && !(n instanceof HTMLElement && n.classList.contains('ed-section'))) {
        const next: ChildNode | null = n.nextSibling
        body.appendChild(n)
        n = next
      }
      h.after(body)
      if (h.dataset.fixed) return
      body.id = `ed-sec-body-${i}`
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ed-sec-toggle'
      btn.setAttribute('aria-controls', body.id)
      const label = document.createElement('span')
      label.textContent = h.textContent
      btn.appendChild(label)
      if (h.dataset.modified) {
        const dot = document.createElement('span')
        dot.className = 'ed-sec-dot'
        dot.title = t('Has custom settings')
        btn.appendChild(dot)
      }
      h.textContent = ''
      h.appendChild(btn)
      const setOpen = (open: boolean) => {
        h.classList.toggle('closed', !open)
        btn.setAttribute('aria-expanded', String(open))
        body.hidden = !open
      }
      setOpen(this.isSectionOpen(key, state))
      btn.addEventListener('click', () => {
        const open = body.hidden
        setOpen(open)
        state[key] = open
        lsSet(PropsPanel.OPEN_KEY, JSON.stringify(state))
        this.syncBuildFocus()
      })
    })
    this.syncBuildFocus()
  }

  /** While the Presenting or Builds section is open, ask the canvas for the click-step chips. */
  private syncBuildFocus() {
    const open = ['Presenting', 'Builds'].some((k) =>
      !!this.host.querySelector(`.ed-section[data-key="${k}"]:not(.closed)`))
    document.dispatchEvent(new CustomEvent('slidomingo:build-focus', { detail: open }))
  }

  /**
   * Open the section with this English key (persisted, like a click) and
   * scroll it into view. The mini toolbar's ⋯ button lands here. Returns
   * false when the current panel has no such section.
   */
  revealSection(key: string): boolean {
    const h = this.host.querySelector<HTMLElement>(`.ed-section[data-key="${CSS.escape(key)}"]`)
    if (!h) return false
    if (h.classList.contains('closed')) h.querySelector<HTMLButtonElement>('.ed-sec-toggle')?.click()
    h.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return true
  }

  // --- builders ---------------------------------------------------------------

  private buildMultiPanel(els: SlideElement[]) {
    // Separate singular key rather than plural machinery — same shape as the
    // 'Pasted 1 item' / 'Pasted {n} items' pair in editor.ts.
    const gid = els[0]?.groupId
    const oneGroup = !!gid && els.every((e) => e.groupId === gid)
    this.ctx.section('elements', {
      fixed: true,
      label: oneGroup ? t('Group of {n}', { n: els.length }) : els.length === 1 ? t('1 element') : t('{n} elements', { n: els.length }),
    })
    this.opsRow(els)
    // What every selected object can share — borders, fills, text, effects —
    // changed for all of them in ONE undo step; then the arrange kit.
    buildMultiStyle(this.ctx, els)
    buildIconShapeStyle(this.ctx, els)
    this.ctx.section('multi:Arrange', { label: t('Arrange') })
    this.arrangeRows(els)
  }

  private buildElementPanel(el: SlideElement) {
    const typeKey = { text: 'Text', shape: 'Shape', image: 'Image', svg: 'Diagram', chart: 'Chart', table: 'Table', code: 'Code', embed: 'Embed', math: 'Equation', zoom: 'Zoom', media: el.type === 'media' && el.kind === 'audio' ? 'Audio' : 'Video' }[el.type]
    // Tier 1 — fixed header: what it is, Duplicate/Delete, and the basics
    // (the reason it was selected). Tier 2 — the type's own "more" section.
    // Tier 3 — the shared sections, all collapsed until asked for.
    this.ctx.section(typeKey, { fixed: true })
    this.opsRow([el])
    if (el.type === 'text') buildTextProps(this.ctx, el)
    if (el.type === 'shape') buildShapeProps(this.ctx, el)
    if (el.type === 'image') buildImageProps(this.ctx, el)
    if (el.type === 'svg') buildSvgProps(this.ctx, el)
    if (el.type === 'chart') buildChartProps(this.ctx, el)
    if (el.type === 'table') buildTableProps(this.ctx, el)
    if (el.type === 'media') buildMediaProps(this.ctx, el)
    if (el.type === 'code') buildCodeProps(this.ctx, el)
    if (el.type === 'embed') buildEmbedProps(this.ctx, el)
    if (el.type === 'math') buildMathProps(this.ctx, el)
    if (el.type === 'image' || el.type === 'svg' || el.type === 'chart' || el.type === 'media') buildAltProps(this.ctx, el)
    if (el.type === 'image' || el.type === 'svg') buildProvenanceProps(this.ctx, el)
    if (el.type === 'zoom') buildZoomProps(this.ctx, el)

    this.ctx.section('Position & size', { modified: !!el.rotation })
    const geo = document.createElement('div')
    geo.className = 'ed-grid2'
    geo.append(
      this.ctx.mini(t('X'), el.x, (v) => this.ctx.setNum(el.id, 'x', v)),
      this.ctx.mini(t('Y'), el.y, (v) => this.ctx.setNum(el.id, 'y', v)),
      this.ctx.mini(t('W'), el.w, (v) => this.ctx.setNum(el.id, 'w', Math.max(v, 1))),
      this.ctx.mini(t('H'), el.h, (v) => this.ctx.setNum(el.id, 'h', Math.max(v, 1))),
      this.ctx.mini(t('Angle'), el.rotation, (v) => this.ctx.setNum(el.id, 'rotation', v)),
    )
    this.ctx.host.appendChild(geo)

    buildEffectsProps(this.ctx, el)

    this.ctx.section('Arrange', { modified: !!(el.groupId || el.parentId) })
    this.arrangeRows([el])

    buildPresentingProps(this.ctx, el)
    buildAdvancedProps(this.ctx, el)
    buildHistoryProps(this.ctx, el)
  }

  /** Right-click ▸ Convert to objects, and the Diagram section's button. */
  convertSvg(id: string) {
    const r = convertSvgInPlace(this.store, id)
    if (!r.ok) { toast(r.error, 5000); return }
    toast(r.notes.length
      ? `${t('Converted into {n} objects.', { n: String(r.count) })} ${t('Not carried over:')} ${r.notes.join('; ')}.`
      : t('Converted into {n} objects.', { n: String(r.count) }), r.notes.length ? 9000 : 2600)
  }

  // --- element ops --------------------------------------------------------------

  private opsRow(els: SlideElement[]) {
    const row = document.createElement('div')
    row.className = 'ed-ops'
    row.append(
      this.ctx.opBtn(ICONS.copy, t('Duplicate'), () => this.duplicate(els)),
      this.ctx.opBtn(ICONS.trash, t('Delete'), () => this.deleteEls(els)),
    )
    // Lock / hide toggles: a locked element ignores canvas clicks and drags, a
    // hidden one leaves every output. Both stay reachable via right-click ▸ Select.
    const locked = els.every((e) => e.locked)
    const hidden = els.every((e) => e.hidden)
    const toggle = (glyph: string, title: string, on: boolean, fn: () => void) => {
      const b = this.ctx.opBtn('', title, fn)
      b.textContent = glyph
      b.setAttribute('aria-pressed', String(on))
      b.setAttribute('aria-label', title)
      if (on) b.classList.add('ed-on')
      return b
    }
    row.append(
      toggle('🔒', locked ? t('Unlock') : t('Lock — ignore clicks and drags on canvas'), locked, () => this.setLocked(els, !locked)),
      toggle(hidden ? '🙈' : '👁', hidden ? t('Show') : t('Hide — remove from the canvas and every output'), hidden, () => this.setHidden(els, !hidden)),
    )
    this.ctx.host.appendChild(row)
  }

  /** Lock/unlock — an optional flag, deleted (not false) when off so files stay lean. */
  /** Rebuild after a view preference changed (e.g. the grid), unless a field is being edited. */
  refresh() { this.rebuild() }

  setLocked(els: SlideElement[], on: boolean) {
    this.store.commit(() => {
      for (const el of els) { if (on) el.locked = true; else delete el.locked }
    })
  }

  /** Mirror shapes / images / svgs. A mixed selection flips together: if all
   *  of them are already flipped on this axis it clears, otherwise it sets. */
  flip(els: SlideElement[], axis: 'flipH' | 'flipV') {
    const flippable = els.filter(canFlip)
    if (!flippable.length) return
    const on = !flippable.every((e) => e[axis])
    this.store.commit(() => {
      for (const el of flippable) { if (on) el[axis] = true; else delete el[axis] }
    })
  }

  /** Hide/show — same optional-flag convention as setLocked. */
  setHidden(els: SlideElement[], on: boolean) {
    this.store.commit(() => {
      for (const el of els) { if (on) el.hidden = true; else delete el.hidden }
    })
  }

  /** Align / distribute / size / order / rotate — the arrange kit, in
   *  captioned, balanced rows. */
  private arrangeRows(els: SlideElement[]) {
    const iconBtn = (icon: string, title: string, onClick: (e: MouseEvent) => void) => {
      const b = document.createElement('button')
      b.className = 'ed-btn ed-arrange-btn'
      b.innerHTML = icon
      b.title = title
      b.setAttribute('aria-label', title)
      b.addEventListener('click', onClick)
      return b
    }
    const group = (caption: string, buttons: HTMLElement[]) => {
      const row = document.createElement('div')
      row.className = 'ed-arrange-row'
      const cap = document.createElement('span')
      cap.className = 'ed-arrange-cap'
      cap.textContent = t(caption)
      row.appendChild(cap)
      row.append(...buttons)
      this.ctx.host.appendChild(row)
    }
    // "Align to" is the visible version of PowerPoint's buried Align to
    // Slide / Align Selected Objects mode. One object (a group counts as
    // one) always aligns to the slide, so the switch only appears for more.
    // Alt-click an Align button = the slide, for that click only.
    const units = alignUnits(els)
    const ref = effectiveRef(units, this.alignRef)
    if (units.length > 1) {
      this.ctx.row('Align to', this.ctx.segButtons(
        [['selection', t('Selection')], ['slide', t('Slide')]],
        this.alignRef,
        (v) => { this.alignRef = v as AlignRef },
      ))
    }
    const alignHint = ref === 'selection' ? ' — ' + t('Alt-click: align to slide') : ''
    group('Align', [
      iconBtn(ICONS.alignLeft, t('Align left') + alignHint, (e) => this.align(els, 'left', e.altKey)),
      iconBtn(ICONS.alignCenterX, t('Align horizontal centers') + alignHint, (e) => this.align(els, 'centerX', e.altKey)),
      iconBtn(ICONS.alignRight, t('Align right') + alignHint, (e) => this.align(els, 'right', e.altKey)),
      iconBtn(ICONS.alignTop, t('Align top') + alignHint, (e) => this.align(els, 'top', e.altKey)),
      iconBtn(ICONS.alignMiddleY, t('Align vertical middles') + alignHint, (e) => this.align(els, 'middleY', e.altKey)),
      iconBtn(ICONS.alignBottom, t('Align bottom') + alignHint, (e) => this.align(els, 'bottom', e.altKey)),
    ])
    {
      // its own labelled button: the Align row has no room for a seventh icon
      const center = document.createElement('button')
      center.className = 'ed-btn ed-btn-block ed-center-slide'
      center.innerHTML = ICONS.centerSlide
      center.append(' ' + t('Center on slide'))
      center.title = `${t('Center on slide')} (${displayChord('Alt+Shift+E', isMacOS())})`
      center.addEventListener('click', () => this.centerOnSlide(els))
      this.ctx.host.appendChild(center)
    }
    // Space needs 2+ elements (match size); distribute 3+ between
    // themselves, 2+ across the slide (one would just be centred — the
    // command and key still do that). Rows of permanently-disabled buttons
    // were pure clutter, so they only appear once they can do something.
    const canDist = this.offersDistribute(els)
    if (els.length >= 2) {
      group('Space', [
        ...(canDist ? [
          iconBtn(ICONS.distributeX, ref === 'slide' ? t('Spread evenly across the slide, horizontally') : t('Equal horizontal gaps (3+)'), () => this.distribute(els, 'x')),
          iconBtn(ICONS.distributeY, ref === 'slide' ? t('Spread evenly across the slide, vertically') : t('Equal vertical gaps (3+)'), () => this.distribute(els, 'y')),
        ] : []),
        iconBtn(ICONS.matchWidth, t('Match widths — first selected sets the size (2+)'), () => this.matchSize(els, 'w')),
        iconBtn(ICONS.matchHeight, t('Match heights — first selected sets the size (2+)'), () => this.matchSize(els, 'h')),
      ])
    }
    group('Order', [
      iconBtn(ICONS.front, t('Bring to front'), () => this.reorder(els, 'front')),
      iconBtn(ICONS.stepForward, t('Bring forward one step'), () => this.step(els, +1)),
      iconBtn(ICONS.stepBack, t('Send backward one step'), () => this.step(els, -1)),
      iconBtn(ICONS.back, t('Send to back'), () => this.reorder(els, 'back')),
    ])


    const grouped = els.some((e) => e.groupId)
    if (els.length > 1 || grouped) {
      const g = document.createElement('button')
      g.className = 'ed-btn ed-btn-block'
      const allSame = els.length > 1 && els.every((e) => e.groupId && e.groupId === els[0].groupId)
      if (allSame || (grouped && els.length === 1)) {
        g.textContent = t('⛓ Ungroup')
        g.title = t('Dissolve the group (⇧G)')
        g.addEventListener('click', () => this.ungroup(els))
      } else {
        g.textContent = t('⛓ Group')
        g.title = t('Elements select and move as one; Alt-click reaches a member (G)')
        g.addEventListener('click', () => this.group(els))
      }
      this.ctx.host.appendChild(g)
    }


    // The everyday arrange kit is above; the rest — spacing options, size
    // reference, Tidy, flip, containers — folds away (open state remembered
    // for the session). The section stays complete, just calmer.
    const fold = document.createElement('details')
    fold.className = 'ed-more-fold'
    fold.open = PropsPanel.arrangeFoldOpen
    fold.addEventListener('toggle', () => { PropsPanel.arrangeFoldOpen = fold.open })
    const summary = document.createElement('summary')
    summary.textContent = t('More arrange options')
    fold.appendChild(summary)
    this.ctx.host.appendChild(fold)
    const outer = this.ctx.host
    this.ctx.host = fold
    try {
      // Distribute mode + custom gap — only relevant once distribute() itself
      // is usable (canDist above). Changing the mode doesn't touch the document
      // (it's a tool setting, not a doc property), so it force-rebuilds the
      // panel directly rather than waiting on a 'doc' event that will never fire.
      if (canDist) {
        this.ctx.row('Distribute mode', this.ctx.segButtons(
          [['edge', t('Edges')], ['center', t('Centers')]],
          this.distributeMode,
          (v) => { this.distributeMode = v as 'edge' | 'center'; this.rebuild(true) },
        ))
        const gapInput = document.createElement('input')
        gapInput.type = 'number'
        gapInput.step = '1'
        gapInput.placeholder = t('auto')
        gapInput.value = this.distributeGap != null ? String(this.distributeGap) : ''
        gapInput.addEventListener('change', () => {
          const raw = gapInput.value.trim()
          if (raw === '') { this.distributeGap = null; return }
          const v = parseFloat(raw)
          this.distributeGap = Number.isFinite(v) ? v : null
        })
        this.ctx.row('Gap (px)', gapInput)
      }
      // matchSize() reference — which value the Match width/height buttons
      // above use. 'first' is the default and matches the original behavior.
      if (els.length >= 2) {
        this.ctx.row('Size to', this.ctx.labeledSelect(
          [['first', t('First')], ['largest', t('Largest')], ['smallest', t('Smallest')], ['average', t('Average')]],
          this.matchSizeMode,
          (v) => { this.matchSizeMode = v as 'first' | 'largest' | 'smallest' | 'average' },
        ))
      }
      // Layout guard, by hand: what the app does around Claude's edits
      {
        const tidy = document.createElement('button')
        tidy.className = 'ed-btn ed-btn-block'
        tidy.textContent = t('✦ Tidy around selection')
        tidy.title = t('Fit text, keep the gaps and keep arrows attached around the selection (⌥⇧T)').replace('⌥⇧T', displayChord('Alt+Shift+T', isMacOS()))
        tidy.addEventListener('click', () => this.tidy(els))
        this.ctx.host.appendChild(tidy)
        if (this.claudeAvailable && window.slidomingoDesktop?.sendAgentPrompt) {
          const polish = document.createElement('button')
          polish.className = 'ed-btn ed-btn-block'
          polish.textContent = t('✦ Polish with Claude')
          polish.title = t('Ask the Claude Code session to review this slide and polish its layout')
          polish.addEventListener('click', () => {
            window.slidomingoDesktop?.sendAgentPrompt?.('polish')
            toast(t('Asked Claude Code to polish this slide'))
          })
          this.ctx.host.appendChild(polish)
        }
      }
      // Mirror the picture (shape / image / svg); text and data stay readable
      if (els.some(canFlip)) {
        group('Flip', [
          iconBtn(ICONS.flipH, t('Flip horizontal'), () => this.flip(els, 'flipH')),
          iconBtn(ICONS.flipV, t('Flip vertical'), () => this.flip(els, 'flipV')),
        ])
      }

      // Containers: a container is a rect shape flagged `container:true`;
      // children carry `parentId`. v1 blocks nesting outright (a hard guard,
      // not a silent half-working state) — "Group into container" refuses a
      // selection that already includes one, "Add to container" refuses a
      // target that's already a container or already a child of one.
      const soleContainer = els.length === 1 && this.isContainer(els[0])
      if (els.length >= 1 && !els.some((e) => this.isContainer(e))) {
        const b = document.createElement('button')
        b.className = 'ed-btn ed-btn-block'
        b.textContent = t('▭ Group into container')
        b.title = t('Wrap the selection in a visible container frame')
        b.addEventListener('click', () => this.groupIntoContainer(els))
        this.ctx.host.appendChild(b)
      }
      if (soleContainer) {
        const n = this.store.slide.elements.filter((e) => e.parentId === els[0].id).length
        const b = document.createElement('button')
        b.className = 'ed-btn ed-btn-block'
        b.textContent = t('▭ Ungroup container')
        b.title = n
          ? t('Dissolve the container — its {n} contained element(s) stay in place, independent', { n: String(n) })
          : t('Remove this empty container')
        b.addEventListener('click', () => this.ungroupContainer(els[0]))
        this.ctx.host.appendChild(b)
      }
      if (els.length === 2) {
        const container = els.find((e) => this.isContainer(e))
        const other = container && els.find((e) => e !== container)
        if (container && other && !other.parentId && !this.isContainer(other)) {
          const b = document.createElement('button')
          b.className = 'ed-btn ed-btn-block'
          b.textContent = t('▭ Add to container')
          b.title = t('Make the other selected element a child of this container')
          b.addEventListener('click', () => this.addToContainer(container, other))
          this.ctx.host.appendChild(b)
        }
      }
      const removable = els.filter((e) => e.parentId)
      if (removable.length) {
        const b = document.createElement('button')
        b.className = 'ed-btn ed-btn-block'
        b.textContent = t('▭ Remove from container')
        b.title = t('Detach from its container without dissolving it')
        b.addEventListener('click', () => this.removeFromContainer(removable))
        this.ctx.host.appendChild(b)
      }
    } finally {
      this.ctx.host = outer
    }
  }

  private isContainer(el: SlideElement): boolean {
    return el.type === 'shape' && !!(el as ShapeElement).container
  }

  /** Same width/height for the whole selection. Default reference is the
   *  FIRST selected element (selection-order dependent — unchanged from
   *  before); the panel's "Size to" picker (this.matchSizeMode) can instead
   *  reference the LARGEST, SMALLEST, or AVERAGE value across the selection. */
  matchSize(els: SlideElement[], dim: 'w' | 'h') {
    if (els.length < 2) return
    const values = els.map((e) => e[dim])
    const ref =
      this.matchSizeMode === 'largest' ? Math.max(...values)
      : this.matchSizeMode === 'smallest' ? Math.min(...values)
      : this.matchSizeMode === 'average' ? values.reduce((s, v) => s + v, 0) / values.length
      : els[0][dim] // 'first' — original behavior
    this.edit(() => { for (const el of els) el[dim] = ref }, true)
  }

  /** Single element aligns to the slide; a multi-selection aligns to its own
   *  bounds by default. Pass toSlide=true (wired to Alt-click in the panel)
   *  to align a multi-selection to the SLIDE instead, reusing the exact box
   *  the single-element case already uses. */
  /** Align to the selection's box or to the slide (`alignRef`, or
   *  `toSlide` for one call — Alt-click). Groups move as one object; see
   *  alignment.ts. */
  align(els: SlideElement[], edge: AlignEdge, toSlide = false) {
    const units = alignUnits(els)
    if (!units.length) return
    const moves = planAlign(units, edge, toSlide ? 'slide' : this.alignRef, this.store.doc.size)
    this.edit(() => applyMoves(units, moves), true)
  }

  /** Centre the selection, as one block, on the slide (both axes). */
  centerOnSlide(els: SlideElement[]) {
    const units = alignUnits(els)
    if (!units.length) return
    const moves = planCenterOnSlide(units, this.store.doc.size)
    this.edit(() => applyMoves(units, moves), true)
  }

  /** Whether distribute() can act on `els` with the current reference. */
  canDistribute(els: SlideElement[]): boolean {
    const units = alignUnits(els)
    return units.length >= distributeMin(effectiveRef(units, this.alignRef))
  }

  /** Whether to OFFER Distribute buttons for `els`: it can act, on more than
   *  one object (one would only be centred — Center on slide says that). */
  offersDistribute(els: SlideElement[]): boolean {
    return alignUnits(els).length >= 2 && this.canDistribute(els)
  }

  /**
   * Space the selection along `axis` (alignment.ts planDistribute): between
   * its outermost two, or across the whole slide when `alignRef` is 'slide'
   * (or only one object is selected). Mode 'edge' (default) equalizes the
   * gaps, 'center' the centre spacing; a custom gap (the panel's "Gap (px)")
   * replaces the derived one — between themselves it cascades forward from
   * the first, so the last moves too.
   */
  distribute(els: SlideElement[], axis: 'x' | 'y') {
    const units = alignUnits(els)
    const moves = planDistribute(units, axis, effectiveRef(units, this.alignRef), this.store.doc.size,
      { mode: this.distributeMode, gap: this.distributeGap })
    if (!moves) return
    this.edit(() => applyMoves(units, moves), true)
  }

  /** The slide exactly as the last Tidy left it: a second Tidy straight
   *  after must not re-apply the same deltas against the pre-Tidy snapshot
   *  (it would push everything twice), so it falls back to static mode. */
  private tidyMark: string | null = null

  /**
   * Tidy around the selection — the layout guard (layoutguard.ts) the agent
   * write path runs, on the user's own edits. The baseline is the newest undo
   * snapshot where the selection looked different (Store.baselineFor), so
   * "I just made this text longer" reads as a resize the neighbours make room
   * for. Without one (or after a Tidy) it runs in static mode: text grows to
   * fit, neighbours the selection overlaps are pushed off it, arrows
   * touching it attach. One undo step; a no-op leaves none.
   */
  tidy(els: SlideElement[]) {
    const ids = els.filter((e) => !isLineLike(e)).map((e) => e.id)
    if (!ids.length) return
    const doc = this.store.doc
    const slide = this.store.slide
    const measure = (el: TextElement) => measureElement(el, doc).height
    const slideJson = JSON.stringify(slide)
    let before: Baseline | null = null
    let changed = new Set<string>()
    if (this.tidyMark !== slideJson) {
      const base = this.store.baselineFor(ids)
      const baseSlide = base ? resolveAgentSlide(base, slide.id)?.slide : undefined
      if (baseSlide) {
        const was = snapshotSlide(baseSlide)
        const now = snapshotSlide(slide)
        changed = new Set(ids.filter((id) => {
          const b = was.get(id)
          const n = now.get(id)
          return !!b && !!n && (b.x !== n.x || b.y !== n.y || b.w !== n.w || b.h !== n.h || b.html !== n.html || b.fontSize !== n.fontSize)
        }))
        before = was
      }
    }
    const staticMode = !before || !changed.size
    if (staticMode) {
      changed = new Set(ids)
      before = staticBaseline(doc, slide, changed, measure)
    }
    const opts = { apply: true, measure, canvas: effectiveCanvasSize(this.store), changed, growAll: staticMode }
    // dry run on a copy first, so a Tidy with nothing to do leaves no undo step
    const probe = guardLayout(doc, JSON.parse(slideJson) as Slide, before!, opts)
    const left = (issues: typeof probe.issues) => issues.filter((i) => i.severity !== 'info')
    if (!probe.adjusted.length) {
      const issues = left(probe.issues)
      toast(issues.length
        ? t('Tidy: nothing it can fix; still overlapping: {ids}', { ids: [...new Set(issues.flatMap((i) => i.elements ?? [i.element ?? '']))].join(', ') })
        : t('Tidy: nothing to fix around the selection'))
      return
    }
    let result = probe
    this.edit(() => { result = guardLayout(doc, this.store.slide, before!, opts) }, true)
    this.tidyMark = JSON.stringify(this.store.slide)
    const issues = left(result.issues)
    const n = new Set(result.adjusted.map((a) => a.element)).size
    toast(issues.length
      ? t('Tidy: adjusted {n}; still overlapping: {ids}', { n: String(n), ids: [...new Set(issues.flatMap((i) => i.elements ?? [i.element ?? '']))].join(', ') })
      : t('Tidy: adjusted {n} around the selection', { n: String(n) }))
  }

  /** Set by the editor from the terminal panel's open/closed state — the
   *  "Polish with Claude" button only shows while a session is running. */
  private claudeAvailable = false
  setClaudeAvailable(open: boolean) {
    if (this.claudeAvailable === open) return
    this.claudeAvailable = open
    this.rebuild()
  }

  /** Move the selection one step up/down the paint order (adjacent swap). */
  step(els: SlideElement[], dir: 1 | -1) {
    const ids = new Set(els.map((e) => e.id))
    this.store.commit(() => {
      const arr = this.store.slide.elements
      const idxs = arr.map((e, i) => (ids.has(e.id) ? i : -1)).filter((i) => i >= 0)
      const ordered = dir > 0 ? [...idxs].reverse() : idxs
      for (const i of ordered) {
        const j = i + dir
        if (j < 0 || j >= arr.length || ids.has(arr[j].id)) continue
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
    })
  }

  group(els: SlideElement[]) {
    if (els.length < 2) return
    const gid = `grp-${uid()}`
    this.edit(() => { for (const el of els) el.groupId = gid }, true)
  }

  ungroup(els: SlideElement[]) {
    const gids = new Set(els.map((e) => e.groupId).filter(Boolean))
    this.edit(() => {
      for (const el of this.store.slide.elements) {
        if (el.groupId && gids.has(el.groupId)) delete el.groupId
      }
    }, true)
  }

  /** Wrap the selection in a new container shape: a padded bounding-box rect
   *  with `container:true`. Each selected element gets `parentId` +
   *  `parentOffset` fixed at the container's box right now — editor.ts's
   *  syncContainers() re-derives x/y/w/h from that offset on every future
   *  move/resize of the container. The group (container + its new children,
   *  in their existing relative order) is reinserted at the position of the
   *  topmost-behind selected element, so unrelated siblings keep their
   *  z-order; within the group the container paints first (behind), its
   *  children after (in front) — no reorder/step changes needed. */
  groupIntoContainer(els: SlideElement[]) {
    if (!els.length || els.some((e) => this.isContainer(e))) return
    const PAD = 16
    const minX = Math.min(...els.map((e) => e.x)) - PAD
    const minY = Math.min(...els.map((e) => e.y)) - PAD
    const maxX = Math.max(...els.map((e) => e.x + e.w)) + PAD
    const maxY = Math.max(...els.map((e) => e.y + e.h)) + PAD
    const container = defaultShape('rect', {
      x: minX, y: minY, w: maxX - minX, h: maxY - minY,
      fill: 'transparent', stroke: 'transparent', strokeWidth: 0,
      container: true,
    })
    const ids = new Set(els.map((e) => e.id))
    this.edit(() => {
      for (const el of els) {
        el.parentId = container.id
        el.parentOffset = {
          relX: (el.x - container.x) / container.w,
          relY: (el.y - container.y) / container.h,
          relW: el.w / container.w,
          relH: el.h / container.h,
        }
      }
      const slide = this.store.slide
      const firstIdx = slide.elements.findIndex((e) => ids.has(e.id))
      const before = slide.elements.slice(0, firstIdx).filter((e) => !ids.has(e.id))
      const after = slide.elements.slice(firstIdx).filter((e) => !ids.has(e.id))
      const childrenInOrder = slide.elements.filter((e) => ids.has(e.id))
      slide.elements = [...before, container, ...childrenInOrder, ...after]
    }, true)
    this.store.select([container.id])
  }

  /** Dissolve a container: clears parentId/parentOffset on every child
   *  (already-synced absolute geometry untouched) and leaves the container
   *  shape in place — mirrors ungroup() above. */
  ungroupContainer(container: SlideElement) {
    if (!this.isContainer(container)) return
    this.edit(() => {
      for (const el of this.store.slide.elements) {
        if (el.parentId === container.id) { delete el.parentId; delete el.parentOffset }
      }
    }, true)
  }

  /** Add an existing, unattached element to an existing container — the
   *  create-only "Group into container" affordance would feel half-finished
   *  the moment someone wants one more element in an existing container.
   *  Splices the newly-added child immediately after the container so it
   *  paints above the frame, same ordering groupIntoContainer establishes. */
  addToContainer(container: SlideElement, el: SlideElement) {
    if (!this.isContainer(container) || this.isContainer(el) || el.parentId) return
    if (!container.w || !container.h) return
    this.edit(() => {
      el.parentId = container.id
      el.parentOffset = {
        relX: (el.x - container.x) / container.w,
        relY: (el.y - container.y) / container.h,
        relW: el.w / container.w,
        relH: el.h / container.h,
      }
      const slide = this.store.slide
      const rest = slide.elements.filter((e) => e !== el)
      const containerIdx = rest.indexOf(container)
      slide.elements = [...rest.slice(0, containerIdx + 1), el, ...rest.slice(containerIdx + 1)]
    }, true)
  }

  /** Detach one or more children from their container without dissolving it
   *  — mirrors the "Unlink from layout" button precedent, not connectors'
   *  implicit drag-to-detach: a container's parentId is a durable pointer,
   *  and ordinary rearranging shouldn't risk silently losing membership
   *  mid-drag the way a decorative connector endpoint can. */
  removeFromContainer(els: SlideElement[]) {
    const targets = els.filter((e) => e.parentId)
    if (!targets.length) return
    this.edit(() => {
      for (const el of targets) { delete el.parentId; delete el.parentOffset }
    }, true)
  }

  /** "Save as slide type…" from every entry point (this panel, the ribbon,
   *  Slide ▸ Save as slide type…). An in-page dialog: `window.prompt` does
   *  nothing in Electron. */
  async promptSaveSlideAsLayout() {
    const name = await askText({ title: t('Slide type name'), initial: this.store.slide.name ?? t('My slide type'), okLabel: t('Save'), singleLine: true })
    if (name) this.saveSlideAsLayout(name)
  }

  /** Adds the current slide to doc.layouts as a new reusable layout. Public
   *  so the desktop ribbon's Design tab can call it directly (its own name
   *  prompt) instead of duplicating this button's logic. */
  saveSlideAsLayout(name: string) {
    this.edit(() => {
      const doc = this.store.doc
      const copy: Slide = jsonClone(this.store.slide)
      doc.layouts = [...(doc.layouts ?? []), { ...copy, id: uid('layout'), name, stateOf: undefined, notes: '' }]
    }, true)
  }

  duplicate(els: SlideElement[]) {
    // uid(), not `<id>-copy<0..999>`: repeated duplication of one element
    // drew from 1000 names and minted duplicate ids on the slide
    const idMap = new Map<string, string>()
    for (const el of els) idMap.set(el.id, uid(el.type[0]))
    const clones: SlideElement[] = els.map((el) => ({
      ...jsonClone(el),
      id: idMap.get(el.id)!,
      x: el.x + 24,
      y: el.y + 24,
    }))
    // fresh group, container and connector refs within the batch
    remapCopiedRefs(clones, idMap)
    this.store.commit(() => this.store.slide.elements.push(...clones))
    this.store.select(clones.map((c) => c.id))
  }

  deleteEls(els: SlideElement[]) {
    const ids = new Set(els.map((e) => e.id))
    // Deleting a container orphans any child NOT also being deleted with it
    // (the next syncContainers pass drops the dangling parentId for free —
    // no cascade-delete code needed) — but that's a real content change,
    // so it gets the same confirm-before-delete discipline as slide
    // deletion (slidesDeleteImpact/window.confirm idiom), not a silent surprise.
    const orphanCount = els
      .filter((e) => this.isContainer(e))
      .reduce((n, c) => n + this.store.slide.elements.filter((e) => e.parentId === c.id && !ids.has(e.id)).length, 0)
    if (orphanCount > 0) {
      const parts = `${orphanCount} contained element${orphanCount > 1 ? 's' : ''} will also become independent`
      if (!window.confirm(t('Delete this container? {parts}.', { parts }))) return
    }
    this.store.commit(() => {
      this.store.slide.elements = this.store.slide.elements.filter((e) => !ids.has(e.id))
    })
    this.store.select([])
  }

  /** Revert one recorded element change — shared by the context menu's
   *  "Revert last change" item and the History section's ↺ buttons below.
   *  store.revertChange() re-validates staleness itself; this just adds the
   *  toast, same convention as every other panel/menu action. */
  revertChange(change: ElementChange): boolean {
    const ok = this.store.revertChange(change)
    if (ok) toast(t('Reverted the last change to this element'))
    return ok
  }

  reorder(els: SlideElement[], where: 'front' | 'back') {
    const ids = new Set(els.map((e) => e.id))
    this.store.commit(() => {
      const slide = this.store.slide
      const picked = slide.elements.filter((e) => ids.has(e.id))
      const rest = slide.elements.filter((e) => !ids.has(e.id))
      slide.elements = where === 'front' ? [...rest, ...picked] : [...picked, ...rest]
    })
  }

  /**
   * A colour control with the deck's palette swatches, for surfaces other
   * than this panel (the mini toolbar). Same behaviour as the panel's own
   * rows: picking by hand clears the palette reference, a swatch records it.
   */
  colorControl(
    value: string,
    onEdit: (v: string, final: boolean) => void,
    opts: { alpha?: boolean; ref?: ColorRef | ColorRef[] } = {},
  ): HTMLElement {
    return opts.alpha ? this.ctx.colorAlphaChip(value, onEdit, opts.ref) : this.ctx.colorChip(value, onEdit, opts.ref)
  }
}
