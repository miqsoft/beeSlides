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

import { displayChord } from './customize/logic'
import { isMacOS } from '../screens'
import { PAGE_PRESETS, addLinkedState, clampPageEdge, patchPresent, setSlideFooterVisible, syncStateWithParent, type PresentFlag } from './decksettings'
import type { Store } from '../store'
import { effectiveCanvasSize } from '../store'
import { panelSectionId } from './customize/catalog'
import { alignUnits, applyMoves, distributeMin, effectiveRef, planAlign, planCenterOnSlide, planDistribute, type AlignEdge, type AlignRef } from '../alignment'
import { guardLayout, snapshotSlide, staticBaseline, type Baseline } from '../layoutguard'
import { isLineLike } from './lineedit'
import { LOOP_DEFAULTS, FIGURE_PRESETS, figureSizePx, pxToUnit, FOOTER_ROLES, SHADOW_PRESETS, REFLECTION_PRESETS, applyChartPalette, resolveAgentSlide, resyncOwner, defaultChart, defaultShape, morphKey, tableStyleFor, uid, type ReflectionSpec, type ChartElement, type EmbedElement, type ImageElement, type LineEnding, type MediaElement, type ShapeElement, type SvgElement, type LoopOrigin, type Slide, type SlideElement, type TableElement, type TextElement, type TransitionKind, type TransitionDir, TRANSITION_DIRS, transitionDir, setSlideTransition, type CodeElement, type FooterRole, type FigureUnit } from '../model'
import { TRANSITION_KINDS, TRANSITION_LABELS, TRANSITION_DIR_LABELS } from './menumodel'
import { summarizeChange, type ElementChange } from '../actionlog'
import { askText, relTime } from './comments'
import { buildPlan, clickHasParagraphs, enterStepOf, mergeClickIntoPrevious, setEnterClick, setExitClick, stepsOf, swapClicks } from '../builds'
import { LANGS } from '../../../kernel/src/tokenize.ts'
import { canFlip, resolveAsset } from '../render'
import { fitMathFrame, measureElement } from '../measure'
import { paletteOf, refAt } from '../palette'
import { CHART_PRESETS } from '../charts'
import { catAxisKey, chartCategories, chartIsHorizontal, chartIsStacked, ensureCatAxis, setChartHorizontal, setChartStacked, valueAxisKey } from '../chartaxes'
import { injectFonts, populateFontSelect } from '../fonts'
import { onSystemFontsReady, requestSystemFonts } from '../localfonts'
import { ICONS } from '../icons'
import { locale, t, tc } from '../i18n'
import { convertSvgInPlace } from './svgtoobjects'
import { iconShapes, iconsetInfo } from '../iconset'
import {
  addExamplesFromFiles, addLook, describeStyleWithAi, examplePreviewUrl, findLook, iconExamples, iconPreviewUrl, learnFromIcon, lookPreviewUrl, moveLook, removeExample, removeLook, restoreIconToSet,
  withStyle, writeIconsetInfo,
} from './iconsetactions'
import { LOOK_PRESETS, clearTweaks, iconParts, iconTweaks, lookFromPreset, setTweak, tweakedIconCount, type IconPart } from '../iconstyles'
import { loadMyLooks, lookFromClipText, lookToClipText, removeMyLook, saveMyLook } from './iconlooklibrary'
import type { IconLook, IconPaint, IconShapeTweak, IconsetInfo, IconsetStyle } from '../model'
import { loadGridPref, saveGridPref, FIGURE_GRID_STEPS_MM } from './gridpref'
import { lsJson, lsSet } from '../../../kernel/src/storage.ts'
import { LIMITS } from '../untrusted'
import { buildColorControl, buildPaletteSwatchRow, closeActiveColorPopover, combineColor, parseColor } from './colorpicker'
import { positionAtRect, positionFloating } from './floatingposition'
import { TABLE_OPS, type TableRange } from './tablerange'
import { deleteColumns, deleteRows, insertColumn, insertRow } from '../tablespans'
import { ElementEdits, pickMediaFile, readImageFile, type ColorRef } from './elementactions'
import { canvasNaturalSize } from './cropmode'
import { remapCopiedRefs } from './clipboard'
import { renderStyleDefaultsForm } from './styledefaults'
import type { MathElement } from '../model'
import { texError } from '../math'
import { buildMathPalette, insertIntoTextarea, openProsePalette, tabToSlot } from './mathpalettebar'
import { ZOOM_SECONDS, ensureTerm, termText, zoomCover, type ZoomElement } from '../model'
import { openZoomPicker, zoomTargetLabel } from './zoompicker'

// parseColor/combineColor now live in colorpicker.ts (the color popover needs
// them too); re-exported here so this module's public surface is unchanged.
export { parseColor, combineColor }

// Hover help for panel rows, keyed by the RAW English label (translated at
// render). A missing entry means no tooltip — better silence than an echo.
// i18n NOTE: both the keys (row labels) and the values here reach t() as
// VARIABLES — literal-extraction sweeps must treat this table as in-use
// catalog keys, never prune them.
/**
 * Sentinel <option> value for "clear the morph override". Safe against
 * collision with a real morph key by construction: setMorphId strips anything
 * outside [A-Za-z0-9._-], so no stored morphId can ever contain '#'.
 */
const UNPAIR = '#unpair'

/** Panel cap on stacked shadow layers (the validator allows 16; six is already a lot of blur). */
const SHADOW_LAYERS_UI_MAX = 6

const ROW_TIPS: Record<string, string> = {
  'Plays': 'How much the zoom plays before it comes back: just the target slide, or on to the end of its section',
  'Return to zoom': 'After the last slide it plays, zoom back out to this slide (off = the show simply carries on from there)',
  'Page size': 'Deck-wide slide size. Elements keep their positions — changing size reframes the canvas, never rescales your art.',
  'Width': 'Custom slide width in pixels',
  'Height': 'Custom slide height in pixels',
  'Slide number': 'Deck-wide. Show the slide counter to the audience while presenting.',
  'Progress bar': 'Deck-wide. Show the thin progress bar along the bottom while presenting.',
  'Corner arrows': 'Deck-wide. Reveal’s own navigation arrows. Off by default — links and keys already navigate.',
  'Background': 'This slide’s background colour',
  'Transition': 'How this slide enters. Morph animates elements that share ids with the previous slide.',
  'Name': 'A friendly name for this slide — shown in link pickers and state badges',
  'Hover': 'What hovering does while presenting: reveal swaps content sets; focus-group dims the other groups',
  'Hover dim': 'How strongly the non-hovered groups fade (focus-group mode)',
  'Default set': 'The hover set everyone sees before any hover happens',
  'Preview set': 'Which hover set to show on the canvas while you edit',
  'Role': 'What this text IS in a slide type (title, body…) — a slide type matches elements by role',
  'Footer item': 'Makes this text part of the footer: Document properties ▸ Header & footer shows or hides it on every slide',
  'Bar direction': 'Upright columns, or bars lying sideways with the categories down the left',
  'Stacked': 'Pile the series on top of each other in each category instead of side by side',
  'Shadow': 'Drop-shadow presets — the shadow follows the element’s real shape, corners and transparency',
  'Reflection': 'Mirror image below the element that fades out. Opacity and Length are percentages (length = how much of the element is mirrored); Gap is the space between, in px. Not shown in Firefox or exported to SVG.',
  'Color': 'Colour with opacity — pick with the swatch, the % field is how opaque it is',
  'Auto-advance (secs)': 'Kiosk mode: the show moves on by itself after this many seconds (0 = manual). Any key or click restarts the countdown; a click build counts as an advance.',
  'Loop the show': 'Next on the last slide wraps back to the first',
  'Play builds automatically': 'This slide plays its click builds on a timer instead of waiting for clicks (a “GIF” slide)',
  'Advance after (secs)': 'Kiosk: how long this slide stays up before the show moves on (0 = the deck default)',
  'Appears': 'When this element arrives: with the slide, or on a click while presenting (→ plays the next click)',
  'Bullets one by one': 'Show this text one paragraph per click instead of all at once (each line or bullet is a paragraph)',
  'Disappears': 'Take this element away again on a later click',
  'Exit': 'How the element leaves (the mirror of Enter)',
  'Exit secs': 'How long the exit takes, in seconds',
  'Enter': 'Entrance animation when the slide appears (plays on non-morph entries; equal order = together)',
  'Enter secs': 'How long the entrance takes, in seconds',
  'Count up': 'Numbers in this text count up from zero when the slide enters',
  'Ambient': 'Continuous motion while the slide is on screen — Ken Burns drift or zoom',
  'Zoom': 'Ken Burns direction — drift, settle out, or settle in',
  'Zoom %': 'How far the Ken Burns zoom travels',
  'Zoom secs': 'How long one Ken Burns pass takes',
  // 'Loop animation' — NOT 'Loop': the media panel's playback toggle owns that
  // word, and one key cannot mean both (a language must pick one and be wrong
  // in the other place).
  'Loop animation': 'A repeating animation: marching dashes along strokes, motion along a drawn path, or a pulse / spin / float / blink / wiggle',
  'Loop secs': 'Seconds for one full cycle of the loop (a lap, a revolution…)',
  'Loop delay': 'Seconds to wait before the first cycle starts (it also waits for the entrance to finish)',
  'Pivot': 'The point it spins, wiggles or grows around — Bottom makes a wiggle sway like a plant in the wind',
  'Path': 'The motion path — edit it as draggable points on the canvas',
  'Lap easing': 'Tempo across one lap — ease-in-out dwells at the ends, linear is constant',
  'Show on hover': 'Puts this element in a hover set — visible only while that set is active',
  'Group': 'Presentation group — with focus-group hover, the other groups dim',
  'Link to': 'Clicking this element during the show jumps to the chosen slide',
  'Font': 'Typeface for this text',
  'Size (pt)': 'Font size in points',
  'Weight': 'Font weight — 400 regular, 700 bold',
  'Align': 'Horizontal text alignment',
  'V-align': 'Vertical alignment inside the box',
  'Line height': 'Line spacing as a multiple of the font size',
  'Fill style': 'Solid colour or a linear gradient',
  'Fill': 'Fill colour with opacity — for lines this IS the line colour',
  'Grad. angle': 'Gradient direction in degrees (CSS convention: 0° points up)',
  'Line color': 'Colour of the line, with opacity',
  'Stroke': 'Outline colour',
  'Stroke width': 'Outline thickness in pixels',
  'Line style': 'Solid, dashed or dotted stroke',
  'Cap style': 'Shape of the line’s ends — round, square or butt (flush)',
  'Start tip': 'Decoration at the line’s start — arrow, dot or bar',
  'End tip': 'Decoration at the line’s end — arrow, dot or bar',
  'Corner radius': 'How rounded the corners are, in pixels',
  'Type': 'Chart type — switching bar⇄pie animates the data across',
  'Decorative': 'Purely visual, nothing to describe — screen readers skip it and Check slides stops asking for alt text',
  'Legend': 'Show the series legend above the chart',
  'Second axis': 'Adds a right-hand value axis — assign series to it in the list below',
  'Header row': 'Style the first row as a header',
  'Preset': 'Quick table looks — Lined, Zebra, Boxed, Minimal',
  'Header fill': 'Header row background colour',
  'Header text': 'Header row text colour',
  'Text': 'Table text colour',
  'Grid lines': 'Colour of the lines between cells',
  'Fit': 'How the media fills its box — cover crops to fill, contain letterboxes',
  'URL': 'Link a hosted file instead of embedding — keeps the deck small',
  'Poster': 'Preview image shown before the video plays',
  'State of': 'Makes this slide a hidden state of another — reached by clicked links, skipped by arrow keys',
  'Align to': 'Selection: line the objects up with each other. Slide: line them up with the slide, moving them as one block. One object always uses the slide.',
  'Distribute mode': 'Edges: equal gaps between element edges (default). Centers: equal spacing between element centers.',
  'Gap (px)': 'Fixed gap for the Space buttons above, overriding the automatic even spacing. Leave blank for automatic.',
  'Size to': 'Which value Match width/height uses as the reference — first selected (default), largest, smallest, or the average.',
}

/**
 * Fill-style options: the stored model words are 'solid'/'gradient', only the
 * LABEL is localised. 'solid' here is a solid COLOUR, which in many languages
 * is a different word from the 'solid' LINE style further down (Swedish:
 * enfärgad vs heldragen) — so it gets its own catalog key rather than sharing
 * one that must be wrong in one of the two places.
 *
 * A function, not a const: t() in a module-level const freezes the English at
 * import time.
 */
const fillStyles = (): Array<[string, string]> =>
  [['solid', t('solid colour')], ['gradient', t('gradient')]]

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
    // Selection/slide switches always rebuild — the user acted outside the
    // panel, so whatever input was focused is obsolete. Doc mutations respect
    // a focused input (skip + mark stale) and catch up when focus leaves.
    store.on('selection', () => this.rebuild(true))
    store.on('current', () => this.rebuild(true))
    store.on('doc', () => this.rebuild())
    store.on('look', () => this.rebuild(true))
    onSystemFontsReady(() => this.rebuild())
    this.host.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.stale && !this.host.matches(':focus-within')) this.rebuild()
      }, 0)
    })
    this.rebuild()
  }

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

  /** True while a gradient-stop drag bar handle is being dragged — see
   *  gradientBar() below. Not a focused form control (a custom pointer-drag
   *  div), so isActiveEditFocus() alone can't see it; a mid-drag rebuild would
   *  destroy the handle the pointer capture is attached to. */
  private gradDragging = false

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

  private rebuild(force = false) {
    if (!force && (this.isActiveEditFocus() || this.gradDragging)) {
      this.stale = true // don't rip the field out from under the user; catch up on focusout
      return
    }
    // A color popover is a DOM child of this.host (see colorpicker.ts), so an
    // ordinary wipe below would destroy it without running its own teardown —
    // leaking its document-level pointerdown/keydown listeners. Close it
    // explicitly first. (While its hex field is focused, isActiveEditFocus()
    // above already deferred this rebuild; this covers the FORCED-rebuild and
    // nothing-focused cases that guard doesn't.) Scoped to this.host: a
    // popover opened from the mini toolbar is not ours to close — every live
    // step of a colour drag there rebuilds this panel.
    closeActiveColorPopover(this.host)
    // No burst reset here any more: the burst belongs to the shared edit
    // layer, which resets it on selection/slide changes. Resetting on every
    // 'doc' rebuild would split a toolbar colour drag into one undo step per
    // pointer move.
    const scrollTop = this.host.scrollTop
    this.stale = false
    this.host.innerHTML = ''
    const els = this.store.selectedElements
    if (els.length === 0 && this.store.editingSurface?.kind === 'reusableObject') this.buildReusableObjectPanel()
    else if (els.length === 0 && this.store.editingSurface?.kind === 'layout') this.buildLayoutSurfacePanel()
    else if (els.length === 0) this.buildSlidePanel()
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



  /**
   * Minimal panel for the reusable-object editing surface — Name + optional
   * Background only. Deliberately NOT `buildSlidePanel()`: that panel's
   * "Page size" control writes `doc.size` — showing it here would let an
   * edit meant for a small figure accidentally resize the WHOLE DECK.
   */
  private buildReusableObjectPanel() {
    const obj = this.store.slide
    this.section('Reusable object')
    const name = document.createElement('input')
    name.type = 'text'
    name.placeholder = t('Untitled object')
    name.value = obj.name ?? ''
    name.addEventListener('change', () =>
      this.edit(() => { this.store.slide.name = name.value.trim() || undefined }, true))
    this.row('Name', name)
    this.row('Background', this.color(obj.background, (v, fin) =>
      this.edit(() => { this.store.slide.background = v }, fin),
      { id: null, path: 'background' }))
  }

  /**
   * Minimal panel for a Slide Types sub-editor when nothing on that surface
   * is selected — Name + Background. Deliberately NOT `buildSlidePanel()`,
   * for the same reason `buildReusableObjectPanel()` isn't used for
   * reusable objects: a `doc.layouts` entry is not actually in `doc.slides`,
   * so `buildSlidePanel()`'s "Page size" (mutates the WHOLE DECK's
   * `doc.size`), "Hide slide" / "Exclude from page numbering" (neither is
   * ever reached by linear navigation or PDF export to begin with) and
   * deck-wide "Slideshow" section are all semantically nonsensical here.
   * `store.slide.name` here IS the slide type's real, displayed name (the
   * Slide Types grid card title, the "Editing "{name}"" header).
   */
  private buildLayoutSurfacePanel() {
    const slide = this.store.slide
    this.section('Slide types')
    const name = document.createElement('input')
    name.type = 'text'
    name.placeholder = t('Untitled')
    name.value = slide.name ?? ''
    name.addEventListener('change', () =>
      this.edit(() => { this.store.slide.name = name.value.trim() || undefined }, true))
    this.row('Name', name)
    this.row('Background', this.color(slide.background, (v, fin) =>
      this.edit(() => { this.store.slide.background = v }, fin),
      { id: null, path: 'background' }))

    // This slide type's OWN font choices (model.ts's `Slide.fontFamily`/
    // `headingFamily`) — nearest-wins up the parent chain, then doc.theme
    // (render.ts's resolveSlideFonts). Collapsed by default (CLOSED_BY_DEFAULT)
    // like the other rarely-touched sections, and NOT gated on "has
    // children" — a leaf slide type may want its own override before ever
    // becoming a parent.
    this.section('Fonts')
    const bodySel = document.createElement('select')
    populateFontSelect(bodySel, this.store.doc, slide.fontFamily ?? '', t('Inherit'))
    bodySel.addEventListener('change', () =>
      this.edit(() => {
        if (bodySel.value) this.store.slide.fontFamily = bodySel.value
        else delete this.store.slide.fontFamily
      }, true))
    this.row('Body font', bodySel)
    const headSel = document.createElement('select')
    populateFontSelect(headSel, this.store.doc, slide.headingFamily ?? '', t('Inherit'))
    headSel.addEventListener('change', () =>
      this.edit(() => {
        if (headSel.value) this.store.slide.headingFamily = headSel.value
        else delete this.store.slide.headingFamily
      }, true))
    this.row('Heading font', headSel)

    // What NEW shapes/lines/text look like on slides of this type — the form
    // lives in styledefaults.ts; collapsed by default like Fonts.
    this.section('Default styles')
    renderStyleDefaultsForm(this.host, this.store, { kind: 'layout', id: slide.id })
  }

  /** "Show on this slide" for each footer piece the slide carries
   *  (`slide.footer`) — PowerPoint's Header & Footer "Apply", one slide at a
   *  time. A piece switched off deck-wide shows here as off and disabled:
   *  the deck-wide switch is in Document properties. */
  private buildSlideFooterToggles(slide: Slide) {
    const present = new Set(slide.elements.flatMap((e) => (e.type === 'text' && e.footerRole ? [e.footerRole] : [])))
    if (!present.size) return
    const hf = this.store.doc.headerFooter
    const labels: Record<FooterRole, string> = { date: 'Show date', slideNumber: 'Show slide number', footer: 'Show footer' }
    for (const role of FOOTER_ROLES) {
      if (!present.has(role)) continue
      const deckOff = hf?.[role]?.show === false
      const input = this.toggle(!deckOff && slide.footer?.[role] !== false, (v) =>
        this.edit(() => setSlideFooterVisible(this.store.slide, role, v), true))
      if (deckOff) {
        input.setAttribute('disabled', '')
        input.title = t('Switched off for the whole deck — Document properties ▸ Header & footer')
      }
      this.row(labels[role], input)
    }
  }

  private buildSlidePanel() {
    const slide = this.store.slide
    if (this.store.doc.kind === 'figure') { this.buildFigurePanel(); return }
    if (this.store.doc.kind === 'iconset') { this.buildIconsetPanel(); return }
    this.section('Slide')
    this.buildSlideTypeRow(slide)
    // deck-wide page size: presets + custom. Elements keep their absolute
    // positions — a size change reframes the canvas, it never rescales art.
    const { width: dw, height: dh } = this.store.doc.size
    const presetKey =
      Object.entries(PAGE_PRESETS).find(([, s]) => s.w === dw && s.h === dh)?.[0] ?? 'Custom…'
    let widthRow: HTMLLabelElement
    let heightRow: HTMLLabelElement
    const showCustomSize = (show: boolean) => {
      widthRow.style.display = show ? '' : 'none'
      heightRow.style.display = show ? '' : 'none'
    }
    this.row('Page size', this.select(
      [...Object.keys(PAGE_PRESETS), 'Custom…'],
      presetKey,
      (v) => {
        const s = PAGE_PRESETS[v]
        if (s) {
          showCustomSize(false)
          this.edit(() => { this.store.doc.size = { width: s.w, height: s.h } }, true)
        } else {
          showCustomSize(true)
        }
      },
    ))
    widthRow = this.row('Width', this.number(dw, 10, (v, fin) =>
      this.edit(() => { this.store.doc.size.width = clampPageEdge(v) }, fin)))
    heightRow = this.row('Height', this.number(dh, 10, (v, fin) =>
      this.edit(() => { this.store.doc.size.height = clampPageEdge(v) }, fin)))
    showCustomSize(presetKey === 'Custom…')
    this.row('Background', this.color(slide.background, (v, fin) =>
      this.edit(() => { this.store.slide.background = v }, fin),
      { id: null, path: 'background' }))
    this.row('Transition', this.labeledSelect(
      TRANSITION_KINDS.map((k) => [k, t(TRANSITION_LABELS[k])]),
      slide.transition,
      (v) => this.edit(() => { setSlideTransition(this.store.slide, v as TransitionKind) }, true),
    ))
    // push/wipe/cover/split only; picking the default writes no field
    const dirs = TRANSITION_DIRS[slide.transition]
    if (dirs) {
      this.row('Direction', this.labeledSelect(
        dirs.map((d) => [d, t(TRANSITION_DIR_LABELS[d])]),
        transitionDir(slide) ?? dirs[0],
        (v) => this.edit(() => {
          if (v === dirs[0]) delete this.store.slide.transitionDir
          else this.store.slide.transitionDir = v as TransitionDir
        }, true),
      ))
    }
    // Hidden slides stay in the deck and stay editable; they drop out of the
    // walk, the PDF and the file thumbnail. Hidden slides directly after a
    // normal one are its "extras" (X while presenting). The toggle acts on the
    // whole slide-panel selection. Offered only on ordinary slides —
    // a state is already unreachable linearly, so hiding one means nothing.
    if (!slide.stateOf) {
      this.row('Hide slide', this.toggle(!!slide.hidden, (v) => {
        if (this.setSlidesHidden) this.setSlidesHidden(v)
        else this.edit(() => {
          if (v) this.store.slide.hidden = true
          else delete this.store.slide.hidden
        }, true)
      }))
      this.row('Exclude from page numbering', this.toggle(!!slide.excludeFromNumbering, (v) =>
        this.edit(() => {
          if (v) this.store.slide.excludeFromNumbering = true
          else delete this.store.slide.excludeFromNumbering
        }, true)))
      const numberingHint = document.createElement('p')
      numberingHint.className = 'ed-hint'
      numberingHint.textContent = t('Stays visible and reachable — only its own page number is skipped, and later slides still count normally')
      this.host.appendChild(numberingHint)
      this.buildSlideFooterToggles(slide)
    }
    if (slide.transition === 'morph') {
      const hint = document.createElement('p')
      hint.className = 'ed-hint'
      hint.innerHTML = t('<b>Morph</b> animates elements that appear on both this slide and the previous one (copy a slide, then move things around).')
      this.host.appendChild(hint)
    }

    this.buildBuildsProps(slide)
    this.buildAutoPlayProps(slide)

    // Deck-wide slideshow chrome, in its own section: these are not properties
    // of THIS slide (the section above) but of how the whole deck presents, and
    // mixing them in beside Background and Transition read as per-slide.
    //
    // "Slideshow" is what the UI already calls present mode on the button, and
    // it avoids colliding with the element panel's own "Presenting" section.
    this.section('Slideshow')
    // These live in doc.present because they are AUDIENCE-facing: what the
    // author designs is what a recipient's audience sees. Contrast reduce-motion
    // and locale, which are viewer preferences and deliberately never enter the
    // document.
    //
    // Each writes `undefined` at its default rather than the default value, so a
    // deck that never touches these carries no `present` block at all.
    const pres = this.store.doc.present ?? {}
    const setPresent = (k: PresentFlag, v: boolean, _dflt: boolean) =>
      this.edit(() => patchPresent(this.store.doc, { [k]: v }), true)
    this.row('Slide number', this.toggle(pres.slideNumber ?? true,
      (v) => setPresent('slideNumber', v, true)))
    this.row('Progress bar', this.toggle(pres.progress ?? true,
      (v) => setPresent('progress', v, true)))
    this.row('Corner arrows', this.toggle(pres.controls ?? false,
      (v) => setPresent('controls', v, false)))
    // Off by default: skipped means uncounted, the same rule interactive states
    // already follow, which is what keeps the audience's numbering contiguous.
    // On matches PowerPoint and Keynote, where a hidden slide keeps its number
    // so the visible ones do not renumber as you toggle slides during rehearsal.
    this.row('Number hidden slides', this.toggle(pres.numberHidden ?? false,
      (v) => setPresent('numberHidden', v, false)))
    // Kiosk: the show moves on by itself and wraps. Absent = manual, so a deck
    // that never touches these carries no extra keys.
    this.row('Auto-advance (secs)', this.number(pres.autoAdvance ?? 0, 1, (v, fin) =>
      this.edit(() => patchPresent(this.store.doc, { autoAdvance: v }), fin)))
    this.row('Loop the show', this.toggle(pres.loop ?? false, (v) => setPresent('loop', v, false)))


    // interactivity: naming, state-of, hover focus
    this.buildThemeProps()
    this.section('Interactivity')
    const name = document.createElement('input')
    name.type = 'text'
    name.placeholder = t('unnamed')
    name.value = slide.name ?? ''
    name.addEventListener('change', () =>
      this.edit(() => { this.store.slide.name = name.value || undefined }, true))
    this.row('Name', name)

    const stateSel = document.createElement('select')
    const optNone = document.createElement('option')
    optNone.value = ''
    optNone.textContent = t('no — normal slide')
    stateSel.appendChild(optNone)
    this.store.doc.slides.forEach((s, i) => {
      if (s.stateOf || s.id === slide.id) return
      const o = document.createElement('option')
      o.value = s.id
      o.textContent = this.slideLabel(s, i)
      if (slide.stateOf === s.id) o.selected = true
      stateSel.appendChild(o)
    })
    stateSel.addEventListener('change', () =>
      this.edit(() => {
        this.store.slide.stateOf = stateSel.value || undefined
        this.store.emit('slides')
      }, true))
    stateSel.title = t('A state is hidden from arrow-key flow — viewers reach it by clicking a linked element. Shared element ids morph between states.')
    this.row('State of', stateSel)

    if (slide.stateOf) {
      const sync = document.createElement('button')
      sync.className = 'ed-btn ed-btn-block'
      sync.innerHTML = `${ICONS.sync}<span>${t('Sync from parent slide')}</span>`
      sync.title = t('Pull elements added to the parent into this state and adopt its ordering — your changes to shared elements are kept')
      sync.addEventListener('click', () => this.syncStateFromParent())
      this.host.appendChild(sync)
    }

    this.row('Hover', this.select(
      ['none', 'focus-group', 'reveal'],
      slide.hover?.type ?? 'none',
      (v) => this.edit(() => {
        this.store.slide.hover = v === 'none'
          ? undefined
          : { ...(this.store.slide.hover ?? {}), type: v as 'focus-group' | 'reveal' }
      }, true)))
    if (slide.hover?.type === 'focus-group') {
      this.row('Hover dim', this.number(slide.hover.dim ?? 0.15, 0.01, (v, fin) =>
        this.edit(() => { if (this.store.slide.hover) this.store.slide.hover.dim = Math.min(Math.max(v, 0), 1) }, fin)))
    }
    if (slide.hover?.type === 'reveal') {
      const sets = [...new Set(slide.elements.map((e) => e.showOnHover).filter(Boolean))] as string[]
      const defIn = document.createElement('input')
      defIn.type = 'text'
      defIn.placeholder = sets[0] ?? 'set name'
      defIn.value = slide.hover.default ?? ''
      defIn.addEventListener('change', () =>
        this.edit(() => { if (this.store.slide.hover) this.store.slide.hover.default = defIn.value || undefined }, true))
      this.row('Default set', defIn)
      if (sets.length) {
        this.row('Preview set', this.select(sets, this.store.hoverPreview ?? slide.hover.default ?? sets[0], (v) => {
          this.store.hoverPreview = v
          this.store.emit('current') // re-render canvas without touching the doc
        }))
        const revealHint = document.createElement('p')
        revealHint.className = 'ed-hint'
        revealHint.innerHTML = t('While presenting, hovering an element whose <b>group</b> matches a set name shows that set. Use Preview to edit each set.')
        this.host.appendChild(revealHint)
      }
    }
  }

  /**
   * The slide's type as ONE control at the top of the slide panel: the name
   * opens the picker ("Change slide type…", editor.ts changeSlideLayout —
   * onto a doc type the slide FOLLOWS it, onto a built-in it is re-arranged
   * once and unlinked); the rare actions sit behind ⋯. A dangling layoutId
   * (its type deleted by a path that predates removeLayout's cleanup) reads
   * as not linked.
   */
  private buildSlideTypeRow(slide: Slide) {
    const type = slide.layoutId ? this.store.doc.layouts?.find((l) => l.id === slide.layoutId) : undefined
    const wrap = document.createElement('div')
    wrap.className = 'ed-slidetype'
    const pickB = document.createElement('button')
    pickB.type = 'button'
    pickB.className = 'ed-slidetype-pick'
    const name = document.createElement('span')
    name.className = 'ed-slidetype-name'
    name.textContent = type ? type.name ?? t('Untitled') : t('None')
    if (type) name.title = name.textContent // the full name when it is cut short
    const caret = document.createElement('span')
    caret.className = 'ed-slidetype-chev'
    caret.innerHTML = ICONS.chevronDown
    pickB.append(name, caret)
    pickB.title = t('Pick the slide type this slide follows — its content moves into the new placeholders; nothing is deleted')
    pickB.addEventListener('click', () =>
      document.dispatchEvent(new CustomEvent('slidomingo:apply-layout', { detail: { anchor: pickB } })))
    const moreB = document.createElement('button')
    moreB.type = 'button'
    moreB.className = 'ed-slidetype-more'
    moreB.innerHTML = ICONS.more
    moreB.title = t('More options')
    moreB.setAttribute('aria-label', t('More options'))
    moreB.setAttribute('aria-haspopup', 'menu')
    moreB.addEventListener('click', (ev) => {
      ev.preventDefault() // the row is a <label>: never forward the click to the picker button
      this.openSlideTypeMenu(moreB, type)
    })
    if (!type) name.classList.add('is-none')
    wrap.append(pickB, moreB)
    this.row('Slide type', wrap)
    const hint = document.createElement('p')
    hint.className = 'ed-hint ed-slidetype-hint'
    hint.textContent = type
      ? t('Follows this slide type — edits to it update this slide')
      : t('Edits in the Layout Manager don’t reach this slide')
    if (type) hint.title = t('Edits to that slide type re-apply here automatically — including its frame and fonts, which can override a local tweak.')
    this.host.appendChild(hint)
  }

  /** The slide-type row's ⋯ menu: the actions too rare for their own button. */
  private openSlideTypeMenu(anchor: HTMLElement, type: Slide | undefined) {
    document.querySelector('.ed-slidetype-menu')?.remove()
    const menu = document.createElement('div')
    menu.className = 'ed-ctx-menu ed-slidetype-menu'
    menu.setAttribute('role', 'menu')
    const close = () => {
      menu.remove()
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
    }
    const item = (label: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-btn'
      b.setAttribute('role', 'menuitem')
      b.textContent = label
      b.addEventListener('click', () => { close(); onClick() })
      menu.appendChild(b)
    }
    const openLM = (layoutId?: string) => document.dispatchEvent(new CustomEvent('slidomingo:open-layout-manager',
      { detail: layoutId ? { tab: 'types', layoutId } : undefined }))
    if (type) item(t('Edit this slide type'), () => openLM(type.id))
    item(t('Save as slide type…'), () => void this.promptSaveSlideAsLayout())
    if (type) item(t('Unlink (keep look)'), () => this.edit(() => { delete this.store.slide.layoutId }, true))
    menu.appendChild(Object.assign(document.createElement('div'), { className: 'ed-menu-sep' }))
    item(t('Layout Manager…'), () => openLM())
    document.body.appendChild(menu)
    positionAtRect(anchor.getBoundingClientRect(), menu, { placement: 'bottom', align: 'end', gap: 4, margin: 8 })
    const onOutside = (ev: PointerEvent) => {
      if (!menu.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) close()
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
    ;(menu.querySelector('button') as HTMLButtonElement | null)?.focus()
  }

  /** Figure mode's page panel: physical size, background, drawing grid, crop to content. */
  private buildFigurePanel() {
    const doc = this.store.doc
    const unit: FigureUnit = doc.figure?.unit ?? 'mm'
    const round = (v: number) => Math.round(v * 100) / 100
    const w = round(doc.figure?.width ?? pxToUnit(doc.size.width, unit))
    const h = round(doc.figure?.height ?? pxToUnit(doc.size.height, unit))
    this.section('Figure')
    const setSize = (nw: number, nh: number, nu: FigureUnit) => this.edit(() => {
      doc.figure = { unit: nu, width: nw, height: nh }
      doc.size = figureSizePx(nw, nh, nu)
    }, true)
    const presetLabels = FIGURE_PRESETS.map((p) => p.label)
    const current = FIGURE_PRESETS.findIndex((p) => unit === 'mm' && p.width === w)
    this.row('Width preset', this.select([...presetLabels, 'Custom'], current >= 0 ? presetLabels[current] : 'Custom', (v) => {
      const p = FIGURE_PRESETS[presetLabels.indexOf(v)]
      if (p) setSize(p.width, h, 'mm')
    }))
    this.row('Unit', this.select(['mm', 'pt', 'in'], unit, (v) => {
      const nu = v as FigureUnit
      setSize(round(pxToUnit(doc.size.width, nu)), round(pxToUnit(doc.size.height, nu)), nu)
    }))
    this.row(`Width (${unit})`, this.number(w, unit === 'in' ? 0.1 : 1, (v) => v > 0 && setSize(round(v), h, unit)))
    this.row(`Height (${unit})`, this.number(h, unit === 'in' ? 0.1 : 1, (v) => v > 0 && setSize(w, round(v), unit)))
    this.row('Background', this.color(this.store.slide.background, (v, fin) =>
      this.edit(() => { this.store.slide.background = v }, fin),
      { id: null, path: 'background' }))
    // The grid is a viewer preference (gridpref.ts); the Editor re-applies it on this event.
    const gp = loadGridPref()
    // a custom spacing set in Grid & Snap shows as its own entry
    const steps = FIGURE_GRID_STEPS_MM.includes(gp.figureStepMm) ? FIGURE_GRID_STEPS_MM : [...FIGURE_GRID_STEPS_MM, gp.figureStepMm].sort((a, b) => a - b)
    const grids = ['Off', ...steps.map((mm) => `${mm} mm`)]
    this.row('Grid', this.select(grids, gp.on ? `${gp.figureStepMm} mm` : 'Off', (v) => {
      const mm = parseFloat(v)
      const p = loadGridPref()
      saveGridPref(Number.isFinite(mm) ? { ...p, on: true, figureStepMm: mm } : { ...p, on: false })
      document.dispatchEvent(new CustomEvent('slidomingo:grid-changed'))
    }))
    const fit = document.createElement('button')
    fit.className = 'ed-btn ed-btn-block'
    fit.textContent = t('Fit canvas to content')
    fit.title = t('Crop the canvas to the drawing plus a 2 mm margin')
    fit.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:figure-fit')))
    this.host.appendChild(fit)
  }

  /** An icon set's panel: this icon (name, search words, what it shows, a
   *  real-size preview), then the set (brief, the one style, licence) and its
   *  actions. The actions run in the Editor (slidomingo:iconset events). */
  private buildIconsetPanel() {
    const doc = this.store.doc
    const slide = this.store.slide
    const info = iconsetInfo(doc)
    if (!info) return
    const act = (action: string) => () => document.dispatchEvent(new CustomEvent('slidomingo:iconset', { detail: { action } }))
    const field = (value: string, multi: boolean, placeholder: string, onCommit: (v: string) => void): HTMLElement => {
      const el = multi ? document.createElement('textarea') : document.createElement('input')
      if (el instanceof HTMLTextAreaElement) { el.rows = 3; el.className = 'ed-iconset-text' }
      else el.type = 'text'
      el.value = value
      el.placeholder = placeholder
      el.maxLength = LIMITS.prose
      el.addEventListener('change', () => onCommit(el.value))
      return el
    }
    const setInfo = (next: IconsetInfo) => this.edit(() => writeIconsetInfo(this.store.doc, next), true)
    const ai = !!window.slidomingoDesktop?.sendAgentPrompt
    const empty = doc.slides.filter((s) => !s.elements.length).length
    const drawB = () => {
      const draw = document.createElement('button')
      draw.className = 'ed-btn ed-btn-block'
      draw.textContent = empty === 1 ? t('Draw 1 empty icon') : empty ? t('Draw {n} empty icons', { n: empty }) : t('Draw with AI')
      draw.title = t('Claude drafts every empty icon (or the icons selected in the icon list) from native shapes, in the set style')
      draw.addEventListener('click', act('draw'))
      return draw
    }
    // planning is how a set starts; once icons are drawn it stays in the ribbon (Home ▸ Plan with AI)
    const planning = ai && doc.slides.every((s) => !s.elements.length)

    // the AI workflow: say what you need → Claude plans empty icons → you check → Draw
    if (planning) {
      this.section('Plan with AI')
      const ask = document.createElement('textarea')
      ask.className = 'ed-iconset-text ed-iconset-ask'
      ask.rows = 4
      ask.maxLength = LIMITS.prose
      ask.placeholder = t('e.g. think about 12 icons for a digital forensics course: evidence handling, analysis tools, reporting')
      this.host.appendChild(ask)
      const go = document.createElement('button')
      go.className = 'ed-btn ed-btn-block ed-primary'
      go.textContent = t('Plan with AI')
      go.title = t('Say which icons you need in your own words — Claude plans them as empty icons for you to check')
      go.addEventListener('click', () => {
        if (!ask.value.trim()) { ask.focus(); return }
        document.dispatchEvent(new CustomEvent('slidomingo:iconset', { detail: { action: 'plan', request: ask.value } }))
        ask.value = ''
      })
      this.host.appendChild(go)
      this.host.appendChild(drawB())
    }

    this.section('Icon')
    const nameField = field(slide.name ?? '', false, t('e.g. fingerprint'), (v) =>
      this.edit(() => { if (v.trim()) this.store.slide.name = v.trim(); else delete this.store.slide.name }, true))
    nameField.title = t('The icon’s name — also its file name when you export the set')
    this.row('Name', nameField)
    this.row('Keywords', field((slide.icon?.keywords ?? []).join(', '), false, t('search words, comma separated'), (v) =>
      this.edit(() => {
        const s = this.store.slide
        const keywords = v.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 32)
        const icon: NonNullable<Slide['icon']> = { ...s.icon, keywords }
        if (!keywords.length) delete icon.keywords
        if (Object.keys(icon).length) s.icon = icon; else delete s.icon
      }, true)))
    this.row('What it shows', field(slide.icon?.prompt ?? '', true, t('For Claude: e.g. a fingerprint inside a magnifying glass'), (v) =>
      this.edit(() => {
        const s = this.store.slide
        const icon: NonNullable<Slide['icon']> = { ...s.icon, prompt: v.trim() }
        if (!icon.prompt) delete icon.prompt
        if (Object.keys(icon).length) s.icon = icon; else delete s.icon
      }, true)))
    if (slide.elements.length) {
      const strip = document.createElement('div')
      strip.className = 'ed-iconset-preview'
      strip.title = t('Actual size: 16, 24, 32 and 48 px')
      const url = iconPreviewUrl(this.store, slide.id)
      for (const px of [16, 24, 32, 48]) {
        const img = document.createElement('img')
        img.src = url
        img.width = img.height = px
        img.alt = ''
        img.style.background = slide.background // the icon on its own canvas
        strip.appendChild(img)
      }
      this.host.appendChild(strip)
    } else {
      // an empty icon: say so, instead of four blank squares
      const hint = document.createElement('p')
      hint.className = 'ed-hint'
      hint.textContent = t('Not drawn yet. Draw it with the tools in Insert, or let Claude draft it.')
      this.host.appendChild(hint)
      if (ai && !planning) this.host.appendChild(drawB())
    }

    this.buildIconDrawing(info, field)
    this.buildIconStyles(info)

    this.section('Icon set')
    this.row('Set name', field(doc.title === 'Untitled icon set' ? '' : doc.title, false, t('e.g. Forensics'), (v) =>
      this.edit(() => { this.store.doc.title = v.trim() || 'Untitled icon set' }, true)))
    this.row('License', field(info.license ?? '', false, t('e.g. CC-BY-4.0'), (v) => {
      const next = { ...info }
      if (v.trim()) next.license = v.trim(); else delete next.license
      setInfo(next)
    }))
    this.row('Author', field(info.author ?? '', false, '', (v) => {
      const next = { ...info }
      if (v.trim()) next.author = v.trim(); else delete next.author
      setInfo(next)
    }))
    const exp = document.createElement('button')
    exp.className = 'ed-btn ed-btn-block'
    exp.textContent = t('Export icon set…')
    exp.title = t('Export the icons as SVG files (24 × 24, currentColor) with an icons.json for icon libraries')
    exp.addEventListener('click', act('export'))
    this.host.appendChild(exp)
  }

  /** The DRAWING side of the set's style (DECISIONS "Drawing style and
   *  styles"): what Claude reads before it draws — the brief, example icons
   *  someone likes, and the line width, ends, corners, padding and ink. The
   *  Styles section below only repaints what is drawn. */
  private buildIconDrawing(info: IconsetInfo, field: (value: string, multi: boolean, placeholder: string, onCommit: (v: string) => void) => HTMLElement) {
    const setInfo = (next: IconsetInfo) => this.edit(() => writeIconsetInfo(this.store.doc, next), true)
    const hint = (text: string) => {
      const p = document.createElement('p')
      p.className = 'ed-hint'
      p.textContent = text
      this.host.appendChild(p)
    }
    this.section('Drawing')
    hint(t('How every icon is drawn — Claude reads this and your example icons before it draws. Styles below only repaint.'))
    this.row('Brief', field(info.brief ?? '', true, t('e.g. friendly and rounded, few details, for a forensics course'), (v) => {
      const next = { ...info }
      if (v.trim()) next.brief = v.trim(); else delete next.brief
      setInfo(next)
    }))

    // icons someone likes: Claude draws like them, the line settings follow them
    const examples = iconExamples(this.store.doc)
    const strip = document.createElement('div')
    strip.className = 'ed-iconset-examples'
    examples.forEach((ex, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-iconset-example'
      b.title = t('“{name}” — click to remove', { name: ex.name })
      const img = document.createElement('img')
      img.src = examplePreviewUrl(this.store, ex)
      img.alt = ex.name
      img.width = img.height = 24
      b.appendChild(img)
      b.addEventListener('click', () => removeExample(this.store, i))
      strip.appendChild(b)
    })
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'ed-iconset-example ed-iconset-example-add'
    add.innerHTML = ICONS.plus
    add.title = t('Add icons you like (SVG files from any library) — Claude draws new icons like them')
    add.setAttribute('aria-label', t('Add examples'))
    add.addEventListener('click', () => {
      void addExamplesFromFiles(this.store).then((r) => {
        if (r === 'unreadable') this.toast(t('No icon shapes found in those files'))
        else if (r) this.toast(Object.keys(r.changed).length
          ? t('Added the examples and took their line width, ends and corners')
          : t('Added the examples — Claude draws new icons like them'), 4000)
      })
    })
    strip.appendChild(add)
    // not this.row: a <label> would forward a click on its text to the first example (removing it)
    const exRow = document.createElement('div')
    exRow.className = 'ed-row'
    const exLabel = document.createElement('span')
    exLabel.textContent = t('Examples')
    exRow.append(exLabel, strip)
    this.host.appendChild(exRow)

    const st = info.style
    this.row('Stroke (units)', this.number(st.strokeWidth, 0.25, (v) => v > 0 && v <= info.grid / 2 && setInfo(withStyle(info, { strokeWidth: v }))))
    const CAPS: Record<string, IconsetStyle['cap']> = { Round: 'round', Square: 'square', Flat: 'butt' }
    const JOINS: Record<string, IconsetStyle['join']> = { Round: 'round', Bevel: 'bevel', Miter: 'miter' }
    // duotone is paint (a Style) now; a set drawn that way keeps the choice
    const FILLS: Record<string, IconsetStyle['fill']> = { Outline: 'outline', Solid: 'solid', ...(st.fill === 'duotone' ? { Duotone: 'duotone' as const } : {}) }
    const keyOf = <V,>(m: Record<string, V>, v: V) => Object.keys(m).find((k) => m[k] === v) ?? Object.keys(m)[0]
    this.row('Line ends', this.select(Object.keys(CAPS), keyOf(CAPS, st.cap), (v) => setInfo(withStyle(info, { cap: CAPS[v] }))))
    this.row('Corners', this.select(Object.keys(JOINS), keyOf(JOINS, st.join), (v) => setInfo(withStyle(info, { join: JOINS[v] }))))
    this.row('Drawn as', this.select(Object.keys(FILLS), keyOf(FILLS, st.fill), (v) => setInfo(withStyle(info, { fill: FILLS[v] }))))
    this.row('Padding (units)', this.number(st.padding, 0.5, (v) => v >= 0 && v < info.grid / 2 && setInfo(withStyle(info, { padding: v }))))
    this.row('Ink', this.color(st.color, (v, fin) => fin && setInfo(withStyle(info, { color: v }))))
    const apply = document.createElement('button')
    apply.className = 'ed-btn ed-btn-block'
    apply.textContent = t('Apply set style')
    apply.title = t('Stroke width, caps, joins and ink from the set, on every icon (or the selected ones)')
    apply.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:iconset', { detail: { action: 'style' } })))
    this.host.appendChild(apply)
  }

  // ---- icon styles (iconstyles.ts, DECISIONS "Icon styles") ----------------------------

  /** The style picked in the Styles gallery ('' = the set's own style): the
   *  one the canvas shows the icons in (store.iconLook). */
  private get lookSel(): string { return this.store.shownLook?.id ?? '' }
  /** The "add a style" drawer is open. */
  private lookDrawer = false

  /** The icon the style previews show: this one, else the first that has a drawing. */
  private lookPreviewSlideId(): string {
    const cur = this.store.slide
    if (cur.elements.length) return cur.id
    return this.store.doc.slides.find((s) => s.elements.length)?.id ?? cur.id
  }

  /** One gallery card: a real-size preview of the icon in a style, and its name. */
  private lookCard(name: string, url: string, opts: { active?: boolean; title?: string; onClick: () => void; onRemove?: () => void }): HTMLElement {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'ed-look-card' + (opts.active ? ' is-active' : '')
    card.setAttribute('aria-pressed', String(!!opts.active))
    if (opts.title) card.title = opts.title
    const img = document.createElement('img')
    img.src = url
    img.alt = ''
    img.width = img.height = 40
    const label = document.createElement('span')
    label.textContent = name
    card.append(img, label)
    card.addEventListener('click', opts.onClick)
    if (opts.onRemove) {
      const x = document.createElement('span')
      x.className = 'ed-look-remove'
      x.textContent = '×'
      x.title = t('Remove from My styles')
      x.setAttribute('role', 'button')
      x.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onRemove!() })
      card.appendChild(x)
    }
    return card
  }

  /** The Styles section: the set's looks as a gallery of the current icon, the
   *  drawer to add one (presets, My styles, from this icon, paste, describe
   *  with AI) and the picked look's settings. A style only repaints; other
   *  shapes are the Drawing section's job. */
  private buildIconStyles(info: IconsetInfo) {
    const looks = info.variants ?? []
    const sid = this.lookPreviewSlideId()
    this.section('Styles')
    const grid = document.createElement('div')
    grid.className = 'ed-looks'
    // previews sit on the icons' own canvas colour, like the size strip above
    this.host.style.setProperty('--look-paper', this.store.slide.background || '#ffffff')
    const pick = (id: string) => () => { this.lookDrawer = false; this.store.showLook(id || null) }
    grid.appendChild(this.lookCard(t('As drawn'), lookPreviewUrl(this.store, sid, null), {
      active: !this.lookSel, title: t('The icons as drawn — change that under Drawing'), onClick: pick(''),
    }))
    for (const l of looks) grid.appendChild(this.lookCard(l.name, lookPreviewUrl(this.store, sid, l), { active: this.lookSel === l.id, onClick: pick(l.id) }))
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'ed-look-card ed-look-add' + (this.lookDrawer ? ' is-active' : '')
    add.innerHTML = `${ICONS.plus}<span></span>`
    add.querySelector('span')!.textContent = t('Add style')
    add.title = t('Show the same icons in another style: presets, your saved styles, or make one')
    add.setAttribute('aria-expanded', String(this.lookDrawer))
    add.addEventListener('click', () => { this.lookDrawer = !this.lookDrawer; this.rebuild(true) })
    grid.appendChild(add)
    this.host.appendChild(grid)

    if (this.lookDrawer) this.buildLookDrawer(info, sid)
    const sel = this.lookSel ? looks.find((l) => l.id === this.lookSel) : undefined
    if (sel) this.buildLookEditor(sel, looks)
    else if (!this.lookDrawer) {
      const hint = document.createElement('p')
      hint.className = 'ed-hint'
      hint.textContent = looks.length
        ? t('Every style paints the same drawings, so a fix to an icon shows in all of them. Export writes one folder per style.')
        : t('Styles repaint the same drawings — bold, solid, colour, sticker, badge … Nothing is redrawn, and export writes one folder per style.')
      this.host.appendChild(hint)
    }
    if (looks.length) {
      const sheet = document.createElement('button')
      sheet.className = 'ed-btn ed-btn-block'
      sheet.textContent = t('Compare all styles…')
      sheet.title = t('Every icon in every style side by side')
      sheet.addEventListener('click', () => this.openLookSheet())
      this.host.appendChild(sheet)
    }
  }

  /** "Add style": presets, My styles, and the ways to make one. */
  private buildLookDrawer(info: IconsetInfo, sid: string) {
    const drawer = document.createElement('div')
    drawer.className = 'ed-look-drawer'
    const head = (label: string) => {
      const h = document.createElement('div')
      h.className = 'ed-subhead'
      h.textContent = label
      drawer.appendChild(h)
    }
    const note = (text: string) => {
      const p = document.createElement('p')
      p.className = 'ed-hint'
      p.textContent = text
      drawer.appendChild(p)
    }
    const added = (id: string, name: string) => {
      this.lookDrawer = false
      this.toast(t('Added the style “{name}”', { name }))
      this.store.showLook(id)
    }
    head(t('Presets'))
    const presets = document.createElement('div')
    presets.className = 'ed-looks ed-looks-small'
    for (const p of LOOK_PRESETS) {
      const look = lookFromPreset(p, info.style.color, t(p.name))
      presets.appendChild(this.lookCard(t(p.name), lookPreviewUrl(this.store, sid, look), {
        title: t(p.hint),
        onClick: () => added(addLook(this.store, look), look.name),
      }))
    }
    drawer.appendChild(presets)

    const mine = loadMyLooks()
    if (mine.length) {
      head(t('My styles'))
      const row = document.createElement('div')
      row.className = 'ed-looks ed-looks-small'
      for (const l of mine) {
        row.appendChild(this.lookCard(l.name, lookPreviewUrl(this.store, sid, l), {
          title: t('Saved in this app — use it in any icon set'),
          onClick: () => added(addLook(this.store, l), l.name),
          onRemove: () => { removeMyLook(l.id); this.rebuild(true) },
        }))
      }
      drawer.appendChild(row)
    }

    head(t('Make your own'))
    const action = (label: string, title: string, run: () => void) => {
      const b = document.createElement('button')
      b.className = 'ed-btn ed-btn-block'
      b.textContent = label
      b.title = title
      b.addEventListener('click', run)
      drawer.appendChild(b)
    }
    if (window.slidomingoDesktop?.sendAgentPrompt) {
      action(t('Describe with AI…'), t('Say how the icons should look — Claude makes it a style'), () => {
        void askText({
          title: t('Describe a style'),
          placeholder: t('e.g. playful comic look, yellow fills, thick black lines and a hard shadow'),
          okLabel: t('Send to Claude'),
        }).then((text) => {
          if (text && describeStyleWithAi(this.store, text)) this.toast(t('Claude is making the style — it appears in Styles when done'))
        })
      })
    }
    action(t('From this icon'), t('Paint one icon by hand (fills, line color and width), then take its look as a style — the icon goes back to the set style'), () => {
      const l = learnFromIcon(this.store)
      if (!l) { this.toast(t('This icon has nothing drawn yet')); return }
      const lookId = addLook(this.store, l)
      restoreIconToSet(this.store, this.store.slide.id)
      added(lookId, l.name)
      this.toast(t('Learned a style from this icon, and put the icon back in the set style (⌘Z brings your paint back)'), 5000)
    })
    action(t('Paste style'), t('Add a style someone shared with Copy style'), () => {
      const apply = (text: string | null) => {
        if (!text) return
        const l = lookFromClipText(text)
        if (typeof l === 'string') { this.toast(t('That is not an icon style')); return }
        added(addLook(this.store, l), l.name)
      }
      // the clipboard when it holds a style, else a box to paste into
      const askPaste = () => void askText({ title: t('Paste style'), placeholder: '{ "format": "slidomingo-icon-style", … }', okLabel: t('Add') }).then(apply)
      const clip = navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.reject(new Error('no clipboard'))
      void clip.then((text) => (typeof lookFromClipText(text) === 'string' ? askPaste() : apply(text))).catch(askPaste)
    })
    note(t('Need other shapes — hand-drawn, more detail, rounder? That is the drawing: change Drawing above (brief, examples) and redraw.'))
    this.host.appendChild(drawer)
  }

  /** The picked style's settings and actions. The basics show; the rest
   *  (detail fill, ends, corners, cut-outs, shadow, border, badge, sharing,
   *  order) is behind "More settings". */
  private lookMore = false
  private buildLookEditor(look: IconLook, looks: readonly IconLook[]) {
    const id = look.id
    const row = (label: string, input: HTMLElement) => this.row(label, input).classList.add('ed-look-row')
    const set = (fn: (l: IconLook) => void, final = true) => this.edit(() => {
      const l = findLook(this.store.doc, id)
      if (l) fn(l)
    }, final)
    const keyOf = <V,>(m: Record<string, V>, v: V) => Object.keys(m).find((k) => m[k] === v) ?? Object.keys(m)[0]
    /** a fill per part: on/off, colour, opacity */
    const partRow = (part: IconPart, label: string) => {
      const paint = look.fill?.[part]
      const wrap = document.createElement('div')
      wrap.className = 'ed-look-paint'
      wrap.appendChild(this.toggle(!!paint, (on) => set((l) => {
        const f = { ...l.fill }
        if (on) f[part] = { color: part === 'accent' ? '#fb923c' : part === 'body' ? '#7dd3fc' : l.stroke.color }
        else delete f[part]
        if (Object.keys(f).length) l.fill = f; else delete l.fill
      })))
      if (paint) {
        wrap.appendChild(this.color(paint.color, (v, fin) => set((l) => { if (l.fill?.[part]) l.fill[part]!.color = v }, fin)))
        const op = this.number(Math.round((paint.opacity ?? 1) * 100), 5, (v) => v >= 5 && v <= 100 && set((l) => {
          const p: IconPaint | undefined = l.fill?.[part]
          if (!p) return
          if (v >= 100) delete p.opacity; else p.opacity = v / 100
        }))
        op.title = t('Opacity (%)')
        op.classList.add('ed-look-pct')
        wrap.appendChild(op)
      }
      row(label, wrap)
    }

    const nameField = document.createElement('input')
    nameField.type = 'text'
    nameField.value = look.name
    nameField.maxLength = 60
    nameField.addEventListener('change', () => { const v = nameField.value.trim(); if (v) set((l) => { l.name = v }) })
    row('Name', nameField)
    row('Line weight (×)', this.number(look.stroke.weight, 0.1, (v) => v >= 0.25 && v <= 4 && set((l) => { l.stroke.weight = Math.round(v * 100) / 100 })))
    row('Line color', this.color(look.stroke.color, (v, fin) => set((l) => { l.stroke.color = v }, fin)))
    partRow('body', 'Body fill')
    partRow('accent', 'Accent fill')

    // the rest, folded; the toggle says how many of them are on
    const extrasOn = [look.fill?.detail, look.stroke.cap, look.stroke.join, look.knockout, look.shadow, look.halo, look.sketch, look.tile].filter(Boolean).length
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'ed-btn ed-btn-block ed-look-more'
    more.setAttribute('aria-expanded', String(this.lookMore))
    more.textContent = this.lookMore ? t('Fewer settings') : extrasOn ? t('More settings ({n} on)', { n: extrasOn }) : t('More settings')
    more.addEventListener('click', () => { this.lookMore = !this.lookMore; this.rebuild(true) })
    this.host.appendChild(more)
    if (this.lookMore) {
      partRow('detail', 'Detail fill')
      const ENDS: Record<string, IconsetStyle['cap'] | undefined> = { 'As the set': undefined, Round: 'round', Square: 'square', Flat: 'butt' }
      const CORNERS: Record<string, IconsetStyle['join'] | undefined> = { 'As the set': undefined, Round: 'round', Bevel: 'bevel', Miter: 'miter' }
      row('Line ends', this.select(Object.keys(ENDS), keyOf(ENDS, look.stroke.cap), (v) => set((l) => { if (ENDS[v]) l.stroke.cap = ENDS[v]; else delete l.stroke.cap })))
      row('Corners', this.select(Object.keys(CORNERS), keyOf(CORNERS, look.stroke.join), (v) => set((l) => { if (CORNERS[v]) l.stroke.join = CORNERS[v]; else delete l.stroke.join })))
      row('Cut details out', this.toggle(!!look.knockout, (on) => set((l) => { if (on) l.knockout = true; else delete l.knockout })))
      row('Hard shadow', this.toggle(!!look.shadow, (on) => set((l) => { if (on) l.shadow = { dx: 0.9, dy: 0.9, color: '#111111' }; else delete l.shadow })))
      if (look.shadow) {
        row('Shadow color', this.color(look.shadow.color, (v, fin) => set((l) => { if (l.shadow) l.shadow.color = v }, fin)))
        row('Shadow offset (units)', this.offsetPair(look.shadow.dx, look.shadow.dy, (dx, dy) => set((l) => { if (l.shadow) { l.shadow.dx = dx; l.shadow.dy = dy } })))
      }
      row('Sticker border', this.toggle(!!look.halo, (on) => set((l) => { if (on) l.halo = { width: 1.5, color: '#ffffff' }; else delete l.halo })))
      if (look.halo) {
        row('Border width (units)', this.number(look.halo.width, 0.25, (v) => v > 0 && v <= 4 && set((l) => { if (l.halo) l.halo.width = v })))
        row('Border color', this.color(look.halo.color, (v, fin) => set((l) => { if (l.halo) l.halo.color = v }, fin)))
      }
      // a wobble is not a hand-drawn set (that is a drawing); only looks that have one show it
      if (look.sketch) row('Hand-drawn', this.number(look.sketch, 0.1, (v) => v >= 0 && v <= 1 && set((l) => { if (v > 0) l.sketch = Math.round(v * 100) / 100; else delete l.sketch })))
      const BADGE: Record<string, 'circle' | 'rounded' | 'square' | undefined> = { None: undefined, Circle: 'circle', Rounded: 'rounded', Square: 'square' }
      row('Badge', this.select(Object.keys(BADGE), keyOf(BADGE, look.tile?.shape), (v) => set((l) => {
        const shape = BADGE[v]
        if (shape) l.tile = { color: '#4f46e5', scale: 0.62, ...l.tile, shape }; else delete l.tile
      })))
      if (look.tile) row('Badge color', this.color(look.tile.color, (v, fin) => set((l) => { if (l.tile) l.tile.color = v }, fin)))
    }

    // single icons painted their own way in this style (buildIconShapeStyle)
    const tweaked = tweakedIconCount(look)
    const sid = this.store.slide.id
    const note = document.createElement('p')
    note.className = 'ed-hint'
    note.textContent = tweaked
      ? t('{n} icons have their own changes in this style (• on the canvas chips).', { n: tweaked })
      : t('The canvas shows the icon in this style. Select a shape there to paint it its own way in this style.')
    this.host.appendChild(note)
    if (tweaked) {
      const undo = document.createElement('div')
      undo.className = 'ed-look-actions'
      const b = (label: string, title: string, slideId?: string) => {
        const btn = document.createElement('button')
        btn.className = 'ed-btn'
        btn.textContent = label
        btn.title = title
        btn.addEventListener('click', () => set((l) => clearTweaks(l, slideId)))
        undo.appendChild(btn)
      }
      if (look.tweaks?.[sid]) b(t('Reset this icon'), t('This icon painted as the style again'), sid)
      b(t('Reset all icons'), t('Every icon painted as the style again'))
      this.host.appendChild(undo)
    }

    const bar = document.createElement('div')
    bar.className = 'ed-look-actions'
    const act = (label: string, title: string, run: () => void, cls = '') => {
      const b = document.createElement('button')
      b.className = `ed-btn ${cls}`.trim()
      b.textContent = label
      b.title = title
      b.addEventListener('click', run)
      bar.appendChild(b)
    }
    act(t('Save to My styles'), t('Keep this style in the app, to use it in any icon set'), () => {
      const cur = findLook(this.store.doc, id)
      if (!cur) return
      this.toast(saveMyLook(cur) ? t('Saved “{name}” to My styles', { name: cur.name }) : t('Could not save — storage is not available here'))
    }, 'ed-primary')
    act(t('Duplicate'), t('A copy of this style to vary'), () => {
      const cur = findLook(this.store.doc, id)
      if (!cur) return
      this.store.showLook(addLook(this.store, cur))
    })
    if (this.lookMore) {
      act(t('Copy style'), t('Copy the style as text to share it — paste it with Add style ▸ Paste style'), () => {
        const cur = findLook(this.store.doc, id)
        if (!cur) return
        void navigator.clipboard?.writeText(lookToClipText(cur)).then(() => this.toast(t('Style copied')), () => this.toast(t('Could not copy')))
      })
      const at = looks.findIndex((l) => l.id === id)
      if (at > 0) act('↑', t('Move earlier'), () => moveLook(this.store, id, -1))
      if (at < looks.length - 1) act('↓', t('Move later'), () => moveLook(this.store, id, 1))
    }
    act(t('Delete'), t('Remove this style from the set (the icons stay)'), () => { this.store.showLook(null); removeLook(this.store, id) }, 'ed-danger')
    this.host.appendChild(bar)
  }

  /** Icon sets: what the selected shapes are in the icon (their part, the
   *  same in every style) and, while a style is shown on the canvas, their own
   *  paint in it (IconLook.tweaks) — the drawing itself stays shared. */
  private buildIconShapeStyle(els: readonly SlideElement[]) {
    const shapes = els.filter((e): e is ShapeElement => e.type === 'shape')
    if (this.store.doc.kind !== 'iconset' || !shapes.length) return
    const slide = this.store.slide
    const look = this.store.shownLook
    const ids = shapes.map((e) => e.id)
    const drawn = iconShapes(this.store.doc, slide).shapes
    const parts = iconParts(drawn)
    const guessed = new Map(drawn.map((d, i) => [d.el.id, parts[i]] as const))
    this.section('Icon style', { label: look ? t('In “{name}”', { name: look.name }) : t('Icon part') })

    const PARTS: Record<string, IconPart | undefined> = { Guess: undefined, Body: 'body', Detail: 'detail', Accent: 'accent' }
    const PART_NAME: Record<IconPart, string> = { body: 'Body', detail: 'Detail', accent: 'Accent' }
    const own = shapes[0].iconPart
    this.row('Part', this.select(Object.keys(PARTS), own ? PART_NAME[own] : 'Guess', (v) => this.edit(() => {
      for (const e of this.store.slide.elements) {
        if (!ids.includes(e.id) || e.type !== 'shape') continue
        const part = PARTS[v]
        if (part) e.iconPart = part; else delete e.iconPart
      }
    }, true)))
    const hint = (text: string) => {
      const p = document.createElement('p')
      p.className = 'ed-hint'
      p.textContent = text
      this.host.appendChild(p)
    }
    const g = guessed.get(shapes[0].id)
    if (!own && g) hint(t('Guessed: {part}. Every style paints body, detail and accent its own way — the part counts in all of them.', { part: t(PART_NAME[g]) }))
    if (!look) {
      if (this.store.doc.iconset?.variants?.length) hint(t('Show a style above the canvas to paint this shape its own way in it.'))
      return
    }

    const lookId = look.id
    const tweakOf = (id: string): IconShapeTweak => iconTweaks(look, slide.id)[id] ?? {}
    const first = tweakOf(ids[0])
    const tweak = (fn: (tw: IconShapeTweak) => void, final = true) => this.edit(() => {
      const l = findLook(this.store.doc, lookId)
      if (!l) return
      for (const id of ids) {
        const tw = structuredClone(iconTweaks(l, slide.id)[id] ?? {})
        fn(tw)
        setTweak(l, slide.id, id, tw)
      }
    }, final)

    // what the style paints this shape with now — a starting colour for its own
    const part = shapes[0].iconPart ?? g ?? 'detail'
    const styleFill = look.fill?.[part]?.color ?? look.stroke.color
    if (shapes.some((e) => !drawn.find((d) => d.el.id === e.id)?.open)) {
      const FILL: Record<string, 'style' | 'none' | 'own'> = { 'As the style': 'style', 'No fill': 'none', 'Own color': 'own' }
      const mode = first.fill === 'none' ? 'No fill' : first.fill ? 'Own color' : 'As the style'
      const wrap = document.createElement('div')
      wrap.className = 'ed-look-paint'
      wrap.appendChild(this.select(Object.keys(FILL), mode, (v) => tweak((tw) => {
        if (FILL[v] === 'none') tw.fill = 'none'
        else if (FILL[v] === 'own') tw.fill = { color: typeof tw.fill === 'object' ? tw.fill.color : styleFill }
        else delete tw.fill
      })))
      if (first.fill && first.fill !== 'none') {
        const paint = first.fill
        wrap.appendChild(this.color(paint.color, (v, fin) => tweak((tw) => { tw.fill = { ...(typeof tw.fill === 'object' ? tw.fill : {}), color: v } }, fin)))
        const op = this.number(Math.round((paint.opacity ?? 1) * 100), 5, (v) => v >= 5 && v <= 100 && tweak((tw) => {
          if (typeof tw.fill !== 'object') return
          if (v >= 100) delete tw.fill.opacity; else tw.fill.opacity = v / 100
        }))
        op.title = t('Opacity (%)')
        op.classList.add('ed-look-pct')
        wrap.appendChild(op)
      }
      this.row('Fill here', wrap)
    }
    const line = document.createElement('div')
    line.className = 'ed-look-paint'
    line.appendChild(this.toggle(!!first.stroke, (on) => tweak((tw) => { if (on) tw.stroke = look.stroke.color; else delete tw.stroke })))
    if (first.stroke) line.appendChild(this.color(first.stroke, (v, fin) => tweak((tw) => { tw.stroke = v }, fin)))
    this.row('Own line color', line)
    this.row('Show in this style', this.toggle(!first.hide, (on) => tweak((tw) => { if (on) delete tw.hide; else tw.hide = true })))
    if (ids.some((id) => Object.keys(tweakOf(id)).length)) {
      const reset = document.createElement('button')
      reset.className = 'ed-btn ed-btn-block'
      reset.textContent = t('Paint as the style again')
      reset.title = t('Drop the own changes of the selected shapes in this style')
      reset.addEventListener('click', () => tweak((tw) => { for (const k of Object.keys(tw)) delete tw[k as keyof IconShapeTweak] }))
      this.host.appendChild(reset)
    } else {
      hint(t('Changes here apply to this icon in “{name}” only; the drawing and the other styles stay as they are.', { name: look.name }))
    }
  }

  /** Two small numbers (x, y) that commit together. */
  private offsetPair(x: number, y: number, onEdit: (x: number, y: number) => void): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'ed-look-pair'
    const ix = this.number(x, 0.1, (v) => Number.isFinite(v) && Math.abs(v) <= 4 && onEdit(v, y))
    const iy = this.number(y, 0.1, (v) => Number.isFinite(v) && Math.abs(v) <= 4 && onEdit(x, v))
    ix.title = 'x'
    iy.title = 'y'
    wrap.append(ix, iy)
    return wrap
  }

  /** "Compare all styles…": every icon in every style, on light or dark. */
  private openLookSheet() {
    const doc = this.store.doc
    const info = iconsetInfo(doc)
    if (!info) return
    const looks: Array<IconLook | null> = [null, ...(info.variants ?? [])]
    const dlg = document.createElement('dialog')
    dlg.className = 'ed-dialog ed-look-sheet'
    dlg.style.setProperty('--look-paper', this.store.slide.background || '#ffffff')
    const top = document.createElement('div')
    top.className = 'ed-look-sheet-top'
    const h = document.createElement('h2')
    h.textContent = t('All styles')
    const bg = this.segButtons([['light', t('Light')], ['dark', t('Dark')]], 'light', (v) => {
      dlg.classList.toggle('is-dark', v === 'dark')
      // one-colour icons follow the text colour (currentColor): light on dark
      dlg.querySelectorAll<HTMLImageElement>('img[data-light]').forEach((img) => { img.src = (v === 'dark' ? img.dataset.dark : img.dataset.light) ?? '' })
      bg.querySelectorAll('button').forEach((b, i) => {
        const on = (i === 1) === (v === 'dark')
        b.classList.toggle('ed-btn-armed', on)
        b.setAttribute('aria-pressed', String(on))
      })
    })
    const close = document.createElement('button')
    close.className = 'ed-btn'
    close.textContent = t('Close')
    close.addEventListener('click', () => dlg.close())
    top.append(h, bg, close)
    const scroll = document.createElement('div')
    scroll.className = 'ed-look-sheet-scroll'
    const table = document.createElement('table')
    const head = table.createTHead().insertRow()
    head.insertCell().textContent = ''
    for (const s of doc.slides) {
      const th = document.createElement('th')
      th.textContent = s.name ?? ''
      head.appendChild(th)
    }
    const body = table.createTBody()
    for (const look of looks) {
      const tr = body.insertRow()
      const name = document.createElement('th')
      name.scope = 'row'
      name.textContent = look ? look.name : t('As drawn')
      tr.appendChild(name)
      doc.slides.forEach((s, index) => {
        const img = document.createElement('img')
        img.src = img.dataset.light = lookPreviewUrl(this.store, s.id, look)
        img.dataset.dark = lookPreviewUrl(this.store, s.id, look, '#f3f4f6')
        img.width = img.height = 40
        img.alt = s.name ?? ''
        // a cell opens that icon in that style on the canvas, to look closer or change it
        const open = document.createElement('button')
        open.type = 'button'
        open.className = 'ed-look-cell'
        const tweaked = !!look?.tweaks?.[s.id]
        if (tweaked) open.classList.add('is-tweaked')
        open.title = `${s.name ?? ''} · ${look ? look.name : t('As drawn')}` + (tweaked ? ` · ${t('own changes in this style')}` : '')
        open.appendChild(img)
        open.addEventListener('click', () => {
          dlg.close()
          this.store.goTo(index)
          this.store.showLook(look?.id ?? null)
        })
        tr.insertCell().appendChild(open)
      })
    }
    scroll.appendChild(table)
    dlg.append(top, scroll)
    dlg.addEventListener('close', () => dlg.remove())
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close() })
    document.body.appendChild(dlg)
    dlg.showModal()
  }

  private buildMultiPanel(els: SlideElement[]) {
    // Separate singular key rather than plural machinery — same shape as the
    // 'Pasted 1 item' / 'Pasted {n} items' pair in editor.ts.
    const gid = els[0]?.groupId
    const oneGroup = !!gid && els.every((e) => e.groupId === gid)
    this.section('elements', {
      fixed: true,
      label: oneGroup ? t('Group of {n}', { n: els.length }) : els.length === 1 ? t('1 element') : t('{n} elements', { n: els.length }),
    })
    this.opsRow(els)
    // What every selected object can share — borders, fills, text, effects —
    // changed for all of them in ONE undo step; then the arrange kit.
    this.buildMultiStyle(els)
    this.buildIconShapeStyle(els)
    this.section('multi:Arrange', { label: t('Arrange') })
    this.arrangeRows(els)
  }

  /**
   * Group formatting for a multi-selection (a group is one too): the
   * properties the selected objects have in common, each edit applied to all
   * of them at once (ElementEdits takes several ids = one undo step). A value
   * that differs between them shows as "Mixed" until it is set.
   */
  private buildMultiStyle(els: SlideElement[]) {
    const ids = (xs: SlideElement[]) => xs.map((e) => e.id)
    const same = <T>(vals: T[]): T | undefined => (vals.length && vals.every((v) => v === vals[0]) ? vals[0] : undefined)
    // "Mixed" lives IN the control (a striped swatch, a placeholder, a first
    // option) — a separate tag pushed the control onto its own line
    const mixed = (row: HTMLElement, on: boolean) => {
      if (!on) return
      row.classList.add('ed-row-mixed')
      row.title = t('The selected objects differ here — a new value sets it on all of them')
      const label = row.querySelector<HTMLElement>('.ed-color-trigger-label')
      if (label) label.textContent = t('Mixed')
      const opt = row.querySelector<HTMLOptionElement>('option[value="mixed"]')
      if (opt) opt.textContent = t('Mixed')
    }
    const subset = (n: number) => {
      if (n === els.length) return
      const hint = document.createElement('div')
      hint.className = 'ed-subset-hint'
      hint.textContent = t('Applies to {n} of the {total} selected', { n, total: els.length })
      this.host.appendChild(hint)
    }
    const numberMixed = (value: number | undefined, step: number, onEdit: (v: number) => void) => {
      const input = this.number(value ?? 0, step, (v) => onEdit(v)) as HTMLInputElement
      if (value === undefined) { input.value = ''; input.placeholder = t('Mixed') }
      return input
    }

    // --- fill & border -------------------------------------------------------
    const shapes = els.filter((e): e is ShapeElement => e.type === 'shape')
    const boxes = shapes.filter((e) => e.shape !== 'line')
    if (shapes.length) {
      this.section('multi:Fill & stroke', { label: t('Fill & stroke') })
      subset(shapes.length)
      if (boxes.length) {
        const fill = same(boxes.map((e) => (e.fillGradient ? 'gradient' : e.fill)))
        const row = this.row('Fill', this.colorAlpha(fill && fill !== 'gradient' ? fill : boxes[0].fill, (v, fin) =>
          // a solid pick replaces a gradient — that is what "make them all blue" means
          this.edits.mutate(ids(boxes), (e) => { if (e.type === 'shape') { delete e.fillGradient; e.fill = v } }, fin),
        boxes.map((e) => ({ id: e.id, path: 'fill' }))))
        mixed(row, fill === undefined || fill === 'gradient')
      }
      const stroke = same(shapes.map((e) => this.edits.strokeOf(e)))
      mixed(this.row('Stroke', this.colorAlpha(stroke ?? this.edits.strokeOf(shapes[0]), (v, fin) =>
        this.edits.setStroke(ids(shapes), v, fin), shapes.map((e) => ({ id: e.id, path: ElementEdits.strokePath(e) })))), stroke === undefined)
      const width = same(shapes.map((e) => e.strokeWidth))
      mixed(this.row('Stroke width', numberMixed(width, 0.5, (v) => this.edits.setStrokeWidth(ids(shapes), v))), width === undefined)
      const style = same(shapes.map((e) => e.strokeStyle ?? (e.strokeDash ? 'dashed' : 'solid')))
      const styleSel = this.select([...(style ? [] : ['mixed']), 'solid', 'dashed', 'dotted'], style ?? 'mixed', (v) => {
        if (v !== 'mixed') this.edits.setStrokeStyle(ids(shapes), v as 'solid' | 'dashed' | 'dotted')
      })
      mixed(this.row('Line style', styleSel), style === undefined)
    }

    // --- text ----------------------------------------------------------------
    const texts = els.filter((e): e is TextElement => e.type === 'text')
    const sized = els.filter((e) => e.type === 'text' || e.type === 'code' || e.type === 'math') as Array<TextElement | CodeElement | MathElement>
    if (sized.length) {
      this.section('multi:Text', { label: t('Text') })
      subset(sized.length)
      if (texts.length) {
        requestSystemFonts()
        const fam = same(texts.map((e) => e.fontFamily ?? ''))
        const sel = document.createElement('select')
        populateFontSelect(sel, this.store.doc, fam ?? '', 'theme default')
        if (fam === undefined) {
          const o = document.createElement('option')
          o.value = '\u0000mixed'
          o.textContent = t('Mixed')
          o.selected = true
          sel.prepend(o)
        }
        sel.addEventListener('change', () => { if (sel.value !== '\u0000mixed') this.edits.setFontFamily(ids(texts), sel.value) })
        mixed(this.row('Font', sel), fam === undefined)
      }
      const pt = same(sized.map((e) => ElementEdits.fontSizePt(e)))
      mixed(this.row('Size (pt)', numberMixed(pt, 1, (v) => this.edits.setFontSizePt(ids(sized), v))), pt === undefined)
      const inked = sized.filter((e): e is TextElement | MathElement => e.type === 'text' || e.type === 'math')
      if (inked.length) {
        const color = same(inked.map((e) => (e.type === 'text' && e.colorGradient ? 'gradient' : e.color)))
        mixed(this.row('Color', this.color(color && color !== 'gradient' ? color : inked[0].color, (v, fin) =>
          this.edits.mutate(ids(inked), (e) => {
            if (e.type === 'text') { delete e.colorGradient; e.color = v } else if (e.type === 'math') e.color = v
          }, fin),
        inked.map((e) => ({ id: e.id, path: 'color' })))), color === undefined || color === 'gradient')
      }
      const align = same(sized.map((e) => e.align))
      const seg = this.segButtons(
        [['left', t('Align left'), ICONS.textLeft], ['center', t('Center'), ICONS.textCenter], ['right', t('Align right'), ICONS.textRight]],
        align ?? '',
        (v) => this.edits.setTextAlign(ids(sized), v as 'left' | 'center' | 'right'),
      )
      if (texts.length) {
        const bold = document.createElement('button')
        bold.type = 'button'
        const allBold = texts.every((e) => ElementEdits.isBold(e))
        bold.className = 'ed-btn ed-seg-btn' + (allBold ? ' ed-btn-armed' : '')
        bold.innerHTML = ICONS.bold
        bold.title = t('Bold')
        bold.setAttribute('aria-label', t('Bold'))
        bold.setAttribute('aria-pressed', String(allBold))
        bold.addEventListener('click', () => this.edits.toggleBold(ids(texts)))
        seg.prepend(bold)
      }
      mixed(this.row('Alignment', seg), align === undefined)
    }

    // --- effects -------------------------------------------------------------
    this.section('multi:Effects', { label: t('Effects') })
    const shadowKey = (e: SlideElement) => Object.entries(SHADOW_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(e.shadow))?.[0]
      ?? (e.shadow ? 'custom' : 'none')
    const shadow = same(els.map(shadowKey))
    const shadowSel = this.select(
      [...(shadow === undefined ? ['mixed'] : shadow === 'custom' ? ['custom'] : []), 'none', ...Object.keys(SHADOW_PRESETS)],
      shadow ?? 'mixed',
      (v) => {
        if (v === 'mixed' || v === 'custom') return
        this.edits.mutate(ids(els), (e) => { if (v === 'none') delete e.shadow; else e.shadow = { ...SHADOW_PRESETS[v] } }, true)
      })
    mixed(this.row('Shadow', shadowSel), shadow === undefined)
    const opacity = same(els.map((e) => Math.round((e.opacity ?? 1) * 100)))
    mixed(this.row('Opacity (%)', numberMixed(opacity, 5, (v) => this.edits.setOpacity(ids(els), v / 100))), opacity === undefined)
  }

  private buildElementPanel(el: SlideElement) {
    const typeKey = { text: 'Text', shape: 'Shape', image: 'Image', svg: 'Diagram', chart: 'Chart', table: 'Table', code: 'Code', embed: 'Embed', math: 'Equation', zoom: 'Zoom', media: el.type === 'media' && el.kind === 'audio' ? 'Audio' : 'Video' }[el.type]
    // Tier 1 — fixed header: what it is, Duplicate/Delete, and the basics
    // (the reason it was selected). Tier 2 — the type's own "more" section.
    // Tier 3 — the shared sections, all collapsed until asked for.
    this.section(typeKey, { fixed: true })
    this.opsRow([el])
    if (el.type === 'text') this.buildTextProps(el)
    if (el.type === 'shape') this.buildShapeProps(el)
    if (el.type === 'image') this.buildImageProps(el)
    if (el.type === 'svg') this.buildSvgProps(el)
    if (el.type === 'chart') this.buildChartProps(el)
    if (el.type === 'table') this.buildTableProps(el)
    if (el.type === 'media') this.buildMediaProps(el)
    if (el.type === 'code') this.buildCodeProps(el)
    if (el.type === 'embed') this.buildEmbedProps(el)
    if (el.type === 'math') this.buildMathProps(el)
    if (el.type === 'image' || el.type === 'svg' || el.type === 'chart' || el.type === 'media') this.buildAltProps(el)
    if (el.type === 'image' || el.type === 'svg') this.buildProvenanceProps(el)
    if (el.type === 'zoom') this.buildZoomProps(el)

    this.section('Position & size', { modified: !!el.rotation })
    const geo = document.createElement('div')
    geo.className = 'ed-grid2'
    geo.append(
      this.mini(t('X'), el.x, (v) => this.setNum(el.id, 'x', v)),
      this.mini(t('Y'), el.y, (v) => this.setNum(el.id, 'y', v)),
      this.mini(t('W'), el.w, (v) => this.setNum(el.id, 'w', Math.max(v, 1))),
      this.mini(t('H'), el.h, (v) => this.setNum(el.id, 'h', Math.max(v, 1))),
      this.mini(t('Angle'), el.rotation, (v) => this.setNum(el.id, 'rotation', v)),
    )
    this.host.appendChild(geo)

    this.buildEffectsProps(el)

    this.section('Arrange', { modified: !!(el.groupId || el.parentId) })
    this.arrangeRows([el])

    this.buildPresentingProps(el)
    this.buildAdvancedProps(el)
    this.buildHistoryProps(el)
  }

  /** Shadow, blur, opacity — how the element is drawn, beyond its own fill. */
  private buildEffectsProps(el: SlideElement) {
    this.section('Effects', { modified: !!(el.shadow || el.reflection || el.blur || el.opacity < 1) })
    const current = Object.entries(SHADOW_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(el.shadow))?.[0]
      ?? (el.shadow ? 'custom' : 'none')
    this.row('Shadow', this.select(
      [...(current === 'custom' ? ['custom'] : []), 'none', ...Object.keys(SHADOW_PRESETS)],
      current,
      (v) => this.mutate(el.id, (e) => {
        if (v === 'none') delete e.shadow
        else if (v !== 'custom') e.shadow = { ...SHADOW_PRESETS[v] }
      }, true)))
    // Always show the concrete values (per layer when stacked) — editing any
    // of them turns a preset into 'custom' on the next rebuild, which is fine.
    const shadows = Array.isArray(el.shadow) ? el.shadow : el.shadow ? [el.shadow] : []
    const setShadow = (i: number, patch: Record<string, unknown>, fin = true) =>
      this.mutate(el.id, (e) => {
        const arr = Array.isArray(e.shadow) ? [...e.shadow] : e.shadow ? [e.shadow] : []
        arr[i] = { ...arr[i], ...patch }
        e.shadow = Array.isArray(e.shadow) ? arr : arr[0]
      }, fin)
    const removeShadow = (i: number) =>
      this.mutate(el.id, (e) => {
        const arr = (Array.isArray(e.shadow) ? [...e.shadow] : e.shadow ? [e.shadow] : []).filter((_, j) => j !== i)
        if (!arr.length) delete e.shadow
        else e.shadow = arr.length === 1 ? arr[0] : arr
      }, true)
    shadows.forEach((sh, i) => {
      if (shadows.length > 1) {
        const cap = document.createElement('div')
        cap.className = 'ed-shadow-cap'
        const name = document.createElement('span')
        name.textContent = t('Layer {n}', { n: i + 1 })
        const del = document.createElement('button')
        del.className = 'ed-btn ed-btn-icon'
        del.textContent = '✕'
        del.title = t('Remove shadow layer')
        del.addEventListener('click', () => removeShadow(i))
        cap.append(name, del)
        this.host.appendChild(cap)
      }
      const grid = document.createElement('div')
      grid.className = 'ed-grid2'
      grid.append(
        this.mini(t('X'), sh.x ?? 0, (v) => setShadow(i, { x: v })),
        this.mini(t('Y'), sh.y ?? 0, (v) => setShadow(i, { y: v })),
        this.mini(t('Blur'), sh.blur, (v) => setShadow(i, { blur: Math.max(v, 0) })),
      )
      this.host.appendChild(grid)
      this.row('Color', this.colorAlpha(sh.color, (v, fin) => setShadow(i, { color: v }, fin)))
    })
    if (shadows.length && shadows.length < SHADOW_LAYERS_UI_MAX) {
      // Stacking (e.g. a glow over a drop shadow) used to be JSON/AI-only.
      const addLayer = document.createElement('button')
      addLayer.className = 'ed-btn ed-btn-block'
      addLayer.textContent = t('＋ Add shadow layer')
      addLayer.title = t('Stack another shadow on top — e.g. a glow over a drop shadow')
      addLayer.addEventListener('click', () =>
        this.mutate(el.id, (e) => {
          const arr = Array.isArray(e.shadow) ? [...e.shadow] : e.shadow ? [e.shadow] : []
          e.shadow = [...arr, { ...SHADOW_PRESETS.glow }]
        }, true))
      this.host.appendChild(addLayer)
    }

    this.buildReflectionProps(el)

    // Blur ON the element (0 clears) and opacity. The backdrop blur BEHIND
    // it and the blend mode are rarer — they live in Advanced.
    const fxGrid = document.createElement('div')
    fxGrid.className = 'ed-grid2'
    fxGrid.append(
      this.mini(t('Blur'), el.blur ?? 0, (v) => this.mutate(el.id, (e) => {
        if (v > 0) e.blur = v
        else delete e.blur
      }, true)),
      this.mini(t('Opacity'), Math.round(el.opacity * 100), (v) =>
        this.setNum(el.id, 'opacity', Math.min(Math.max(v / 100, 0), 1))),
    )
    this.host.appendChild(fxGrid)
  }

  /** Mirror reflection below the element: a preset, then the concrete values
   *  (editing any of them turns the preset into 'custom' on the next rebuild). */
  private buildReflectionProps(el: SlideElement) {
    const r = el.reflection
    const current = !r ? 'none'
      : Object.entries(REFLECTION_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(r))?.[0] ?? 'custom'
    this.row('Reflection', this.select(
      [...(current === 'custom' ? ['custom'] : []), 'none', ...Object.keys(REFLECTION_PRESETS)],
      current,
      (v) => this.mutate(el.id, (e) => {
        if (v === 'none') delete e.reflection
        else if (v !== 'custom') e.reflection = { ...REFLECTION_PRESETS[v] }
      }, true)))
    if (!r) return
    const setReflection = (patch: Partial<ReflectionSpec>) =>
      this.mutate(el.id, (e) => { e.reflection = { ...e.reflection, ...patch } }, true)
    const clamp01 = (v: number) => Math.min(Math.max(Number.isNaN(v) ? 0 : v, 0), 100) / 100
    const grid = document.createElement('div')
    grid.className = 'ed-grid2'
    grid.append(
      this.mini(t('Opacity'), Math.round((r.opacity ?? 0.35) * 100), (v) => setReflection({ opacity: clamp01(v) })),
      this.mini(t('Length'), Math.round((r.size ?? 0.5) * 100), (v) => setReflection({ size: clamp01(v) })),
      this.mini(t('Gap'), r.gap ?? 0, (v) => setReflection({ gap: Number.isNaN(v) ? 0 : v })),
    )
    this.host.appendChild(grid)
  }

  /**
   * Role, blend, backdrop — real features, but ones you reach for on purpose,
   * so they stop costing the space Fill gets. A chart's raw-JSON escape hatch
   * lives here too.
   */
  private buildAdvancedProps(el: SlideElement) {
    const footerRole = el.type === 'text' ? el.footerRole : undefined
    this.section('Advanced', { modified: !!(el.role || footerRole || el.blend || el.backdropFilter) })
    this.row('Role', this.select(
      ['none', 'title', 'subtitle', 'body', 'kicker', 'media'],
      el.role ?? 'none',
      (v) => this.mutate(el.id, (e) => {
        if (v === 'none') delete e.role
        else e.role = v
      }, true)))
    if (el.type === 'text') {
      this.row('Footer item', this.labeledSelect(
        [['', t('No')], ['date', t('Date')], ['slideNumber', t('Slide number')], ['footer', t('Footer')]],
        footerRole ?? '',
        (v) => this.mutate(el.id, (e) => {
          const tx = e as TextElement
          if (v) tx.footerRole = v as FooterRole
          else delete tx.footerRole
        }, true)))
    }
    this.row('Blend', this.select(
      ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion'],
      el.blend || 'normal',
      (v) => this.mutate(el.id, (e) => {
        if (v === 'normal') delete e.blend
        else e.blend = v
      }, true)))
    const grid = document.createElement('div')
    grid.className = 'ed-grid2'
    grid.append(
      this.mini(t('Backdrop'), el.backdropFilter ?? 0, (v) => this.mutate(el.id, (e) => {
        if (v > 0) e.backdropFilter = v
        else delete e.backdropFilter
      }, true)),
    )
    this.host.appendChild(grid)
    if (el.type === 'chart') this.buildChartJson(el)
  }

  /**
   * Per-element change history: the last ~10 recorded ElementChanges for
   * this element (actionlog.ts), newest first — a short summarizeChange()
   * label + relative time, and a ↺ button that reverts just that change
   * (store.revertChange). A row's button greys out once store.canRevert()
   * says the entry is stale — either something newer superseded it, or an
   * earlier row in this same list was already reverted (which itself is a
   * new commit, so the panel rebuilds and re-checks every row fresh).
   */
  private buildHistoryProps(el: SlideElement) {
    const entries = this.store.actionLog.changesFor(this.store.slide.id, el.id)
    if (!entries.length) return
    this.section('History')
    for (const { change, at } of entries) {
      const row = document.createElement('div')
      row.className = 'ed-history-row'
      const label = document.createElement('span')
      label.className = 'ed-history-label'
      label.textContent = summarizeChange(change)
      const time = document.createElement('span')
      time.className = 'ed-history-time'
      time.textContent = relTime(at)
      const revertBtn = this.opBtn(ICONS.undo, t('Revert this change'), () => this.revertChange(change))
      if (!this.store.canRevert(change)) (revertBtn as HTMLButtonElement).disabled = true
      row.append(label, time, revertBtn)
      this.host.appendChild(row)
    }
  }

  /**
   * Morph rows, at the end of the Presenting section (they used to be their
   * own always-open section). The morph key is `morphId ?? id`: by default an element
   * morphs with same-id elements on adjacent slides (the duplicate-a-slide
   * idiom), but setting a `morphId` re-targets the pairing WITHOUT mutating
   * `id` (which stays the stable identity used by selection, connectors,
   * comments and the CRDT). The text field edits the key directly; the picker
   * adopts another slide element's key. Writing the element's own id clears
   * the override.
   */
  private buildMorphProps(el: SlideElement) {
    this.subhead(t('Morph'))
    const effective = morphKey(el)

    const warn = document.createElement('p')
    warn.className = 'ed-hint ed-morph-warn'
    warn.style.display = 'none'

    const input = document.createElement('input')
    input.type = 'text'
    input.value = effective
    input.spellcheck = false
    input.addEventListener('change', () => {
      const err = this.setMorphId(el, input.value)
      if (err) { warn.textContent = err; warn.style.display = ''; input.value = effective }
    })
    this.row('Morph id', input)

    const targets = this.morphTargets(el)
    // `|| el.morphId`: a paired element with no OTHER slide to pair with still
    // needs the picker — otherwise there is nowhere to unpair from.
    if (targets.length || el.morphId) {
      const sel = document.createElement('select')
      const none = document.createElement('option')
      none.value = ''
      none.textContent = t('(pick an element)')
      sel.appendChild(none)
      // Clearing an override had no affordance: the documented way is to retype
      // the element's own id into the field above, which means knowing what it
      // was (issue #54). Offer it as a choice instead.
      if (el.morphId) {
        const un = document.createElement('option')
        un.value = UNPAIR
        un.textContent = t('Don’t pair — use its own id')
        sel.appendChild(un)
      }
      for (const tgt of targets) {
        const o = document.createElement('option')
        o.value = tgt.key
        o.textContent = tgt.label
        if (tgt.key === effective) o.selected = true
        sel.appendChild(o)
      }
      sel.addEventListener('change', () => {
        if (!sel.value) return
        // writing the element's OWN id is what clears the override
        const err = this.setMorphId(el, sel.value === UNPAIR ? el.id : sel.value)
        if (err) { warn.textContent = err; warn.style.display = '' }
      })
      this.row('Pair with', sel)
    }

    this.host.appendChild(warn)

    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    // ids come from the document, which an opened file does not sanitize —
    // escape them before they meet innerHTML (t() interpolates verbatim)
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    hint.innerHTML = el.morphId
      ? t('Morphs as <code>{id}</code>, overriding its own id. Set it back to <code>{own}</code> to clear.', { id: esc(effective), own: esc(el.id) })
      : t('Elements sharing a morph id morph into each other across slides. Change this (or pick below) to pair with an element on another slide.')
    this.host.appendChild(hint)
  }

  /** Set or clear an element's morph-key override. Writing the element's own
   *  id clears it. Returns an inline error message, or null on success. */
  private setMorphId(el: SlideElement, raw: string): string | null {
    const clean = raw.trim().replace(/[^A-Za-z0-9._-]/g, '')
    if (!clean) return t('Morph id can’t be empty.')
    const next = clean === el.id ? undefined : clean
    const effective = next ?? el.id
    const clash = this.store.slide.elements.some(
      (e) => e.id !== el.id && morphKey(e) === effective)
    if (clash) return t('Another element on this slide already uses that morph id.')
    this.mutate(el.id, (e) => {
      if (next === undefined) delete e.morphId
      else e.morphId = next
    }, true)
    return null
  }

  /** Distinct morph keys present on OTHER slides, each with a readable label,
   *  for the "Pair with" picker. Skips keys that already sit on this slide
   *  (they'd collide) and our own default key. */
  private morphTargets(el: SlideElement): Array<{ key: string; label: string }> {
    const here = new Set(
      this.store.slide.elements.filter((e) => e.id !== el.id).map(morphKey))
    const seen = new Map<string, string>()
    this.store.doc.slides.forEach((s, i) => {
      if (s.id === this.store.slide.id) return
      for (const e of s.elements) {
        const key = morphKey(e)
        if (key === el.id || here.has(key) || seen.has(key)) continue
        seen.set(key, `${t('Slide')} ${i + 1} · ${this.morphElDesc(e)}`)
      }
    })
    return [...seen].map(([key, label]) => ({ key, label }))
  }

  /** Short human label for an element in the morph picker. */
  private morphElDesc(e: SlideElement): string {
    if (e.type === 'text') {
      const txt = (e as TextElement).html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      if (txt) return `"${txt.slice(0, 24)}"`
    }
    // Capitalize to hit the existing insert-menu catalog keys (Text/Image/…).
    return t(e.type.charAt(0).toUpperCase() + e.type.slice(1))
  }

  /**
   * The slide's click builds as an ordered list: one group per click, each row
   * an element that arrives (＋) or leaves (－) on it. ↑/↓ or a drag moves a row
   * between clicks; a click header folds into / swaps with its neighbour. All
   * edits go through builds.ts, which renumbers to compressed clicks, so the
   * list can never hold a gap.
   */
  private buildBuildsProps(slide: Slide) {
    const plan = buildPlan(slide)
    const n = plan.steps.length
    this.section('Builds', { modified: n > 0 })
    const apply = (fn: (s: Slide) => void) => this.edit(() => fn(this.store.slide), true)

    if (!n) {
      const hint = document.createElement('p')
      hint.className = 'ed-hint'
      hint.textContent = t('No click builds yet. Select an element and set when it Appears (Presenting) — the order shows up here.')
      this.host.appendChild(hint)
      return
    }

    const actions = document.createElement('div')
    actions.className = 'ed-builds-actions'
    const step = document.createElement('button')
    step.className = 'ed-btn ed-btn-block'
    step.textContent = t('▶ Step through')
    step.title = t('Play the slide’s clicks one at a time on the canvas (→ next, ← back, Esc ends)')
    step.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:step-through')))
    const play = document.createElement('button')
    play.className = 'ed-btn ed-btn-block'
    play.textContent = t('▶ Preview animation')
    play.title = t('Play this slide\'s animations on the canvas (click or any key stops)')
    play.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:preview-fx')))
    actions.append(step, play)
    this.host.appendChild(actions)

    type Row = { kind: 'enter' | 'exit'; el: SlideElement; para?: number }
    const rowsBy: Row[][] = Array.from({ length: n + 1 }, () => [])
    const withSlide: Row[] = []
    for (const el of slide.elements) {
      if (el.hidden || el.showOnHover || !el.fx) continue
      const { enter } = stepsOf(plan, el.id)
      const paraBuilt = el.type === 'text' && !!el.fx.byParagraph
      if (!enter && (paraBuilt || el.fx.exitStep)) withSlide.push({ kind: 'enter', el })
    }
    plan.steps.forEach((st, i) => {
      for (const tg of st.enter) {
        const el = slide.elements.find((e) => e.id === tg.elId)
        if (el) rowsBy[i + 1].push({ kind: 'enter', el, para: tg.para })
      }
      for (const tg of st.exit) {
        const el = slide.elements.find((e) => e.id === tg.elId)
        if (el) rowsBy[i + 1].push({ kind: 'exit', el })
      }
    })

    const list = document.createElement('div')
    list.className = 'ed-builds'
    const drop = (group: HTMLElement, click: number) => {
      group.addEventListener('dragover', (ev) => { ev.preventDefault(); group.classList.add('over') })
      group.addEventListener('dragleave', () => group.classList.remove('over'))
      group.addEventListener('drop', (ev) => {
        ev.preventDefault()
        group.classList.remove('over')
        const [kind, id] = (ev.dataTransfer?.getData('text/plain') ?? '').split('|')
        if (!id) return
        if (kind === 'exit') { if (click > 0) apply((s) => setExitClick(s, id, click)) }
        else if (kind === 'enter') apply((s) => setEnterClick(s, id, click))
      })
    }
    const mkRow = (r: Row, click: number): HTMLElement => {
      const row = document.createElement('div')
      row.className = 'ed-build-row ' + r.kind
      row.draggable = r.para === undefined || r.para === 0
      row.addEventListener('dragstart', (ev) => ev.dataTransfer?.setData('text/plain', `${r.kind}|${r.el.id}`))
      const icon = document.createElement('span')
      icon.className = 'ed-build-kind'
      icon.textContent = r.kind === 'enter' ? '＋' : '－'
      icon.title = r.kind === 'enter' ? t('Appears') : t('Disappears')
      const label = document.createElement('button')
      label.type = 'button'
      label.className = 'ed-build-label'
      // shapes carry no words, so tell same-typed rows apart by where they sit
      label.textContent = this.morphElDesc(r.el)
        + (r.el.type === 'text' ? '' : ` (${Math.round(r.el.x)}, ${Math.round(r.el.y)})`)
        + (r.para !== undefined ? `  ¶${r.para + 1}` : '')
      label.title = t('Select this element')
      label.addEventListener('click', () => this.store.select([r.el.id]))
      row.append(icon, label)
      // paragraphs after the first follow their box's run — only the first moves it
      if (r.para === undefined || r.para === 0) {
        const mv = (glyph: string, title: string, to: number, disabled: boolean) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'ed-build-mv'
          b.textContent = glyph
          b.title = title
          b.disabled = disabled
          b.addEventListener('click', () =>
            apply((s) => (r.kind === 'enter' ? setEnterClick(s, r.el.id, to) : setExitClick(s, r.el.id, to))))
          row.appendChild(b)
        }
        const entered = stepsOf(plan, r.el.id).enter
        mv('↑', t('Move to the previous click'), click - 1, r.kind === 'enter' ? click <= 0 : click - 1 <= entered)
        mv('↓', t('Move to the next click'), click + 1, false)
      }
      row.addEventListener('click', (ev) => { if (ev.target === row) this.store.select([r.el.id]) })
      return row
    }

    if (withSlide.length) {
      const g = document.createElement('div')
      g.className = 'ed-build-group'
      const h = document.createElement('div')
      h.className = 'ed-build-head'
      h.textContent = t('With slide')
      g.appendChild(h)
      for (const r of withSlide) g.appendChild(mkRow(r, 0))
      drop(g, 0)
      list.appendChild(g)
    }
    for (let i = 1; i <= n; i++) {
      const g = document.createElement('div')
      g.className = 'ed-build-group'
      const h = document.createElement('div')
      h.className = 'ed-build-head'
      const name = document.createElement('span')
      name.textContent = t('Click {n}', { n: i })
      h.appendChild(name)
      const hb = (glyph: string, title: string, disabled: boolean, fn: () => void) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'ed-build-mv'
        b.textContent = glyph
        b.title = title
        b.disabled = disabled
        b.addEventListener('click', fn)
        h.appendChild(b)
      }
      const locked = (c: number) => c < 1 || c > n || clickHasParagraphs(plan, c)
      const keep = t('Bullets keep their one-per-click order')
      hb('⇤', clickHasParagraphs(plan, i) ? keep : t('Fold this click into the one before it (with previous)'),
        clickHasParagraphs(plan, i), () => apply((s) => mergeClickIntoPrevious(s, i)))
      hb('↑', locked(i) || locked(i - 1) ? keep : t('Play this click earlier'), locked(i) || locked(i - 1), () => apply((s) => swapClicks(s, i, i - 1)))
      hb('↓', locked(i) || locked(i + 1) ? keep : t('Play this click later'), locked(i) || locked(i + 1), () => apply((s) => swapClicks(s, i, i + 1)))
      g.appendChild(h)
      for (const r of rowsBy[i]) g.appendChild(mkRow(r, i))
      drop(g, i)
      list.appendChild(g)
    }
    const fresh = document.createElement('div')
    fresh.className = 'ed-build-group ed-build-new'
    fresh.textContent = t('Drop here for a new click')
    drop(fresh, n + 1)
    list.appendChild(fresh)
    this.host.appendChild(list)
  }

  /**
   * Hands-free playback of ONE slide: its click builds play on a timer ("GIF"
   * slide) and/or the show leaves it by itself after N seconds (kiosk).
   */
  private buildAutoPlayProps(slide: Slide) {
    const ab = slide.autoBuild
    this.section('Auto-play', { modified: !!(ab || slide.advanceAfter) })
    const setSlide = (fn: (s: Slide) => void) => this.edit(() => fn(this.store.slide), true)
    this.row('Play builds automatically', this.toggle(!!ab, (on) =>
      setSlide((s) => { if (on) s.autoBuild = { every: 2, hold: 2, loop: true }; else delete s.autoBuild })))
    if (ab) {
      const patch = (p: Partial<NonNullable<Slide['autoBuild']>>, fin: boolean) =>
        this.edit(() => {
          const cur = this.store.slide.autoBuild
          if (!cur) return
          const next = { ...cur, ...p }
          if (next.loop !== true) delete next.loop
          if (!next.hold) delete next.hold
          this.store.slide.autoBuild = next
        }, fin)
      this.row('Every (secs)', this.number(ab.every, 0.1, (v, fin) => patch({ every: Math.max(v, 0.1) }, fin)))
      this.row('Hold (secs)', this.number(ab.hold ?? 0, 0.1, (v, fin) => patch({ hold: Math.max(v, 0) }, fin)))
      this.row('Loop slide', this.toggle(!!ab.loop, (v) => patch({ loop: v }, true)))
      const hint = document.createElement('p')
      hint.className = 'ed-hint'
      hint.textContent = t('The slide plays its clicks by itself, one every N seconds, holds on the last, then starts over. → and ← leave the slide.')
      this.host.appendChild(hint)
    }
    this.row('Advance after (secs)', this.number(slide.advanceAfter ?? 0, 1, (v, fin) =>
      this.edit(() => {
        if (v > 0) this.store.slide.advanceAfter = Math.min(v, 86400)
        else delete this.store.slide.advanceAfter
      }, fin)))
  }

  /** fx + link + morph pairing — how the element behaves while presenting.
   *  Keeps the 'Presenting' key, so saved open state and translations carry
   *  over from before Morph merged in. */
  private buildPresentingProps(el: SlideElement) {
    this.section('Presenting', {
      modified: !!(el.fx || el.showOnHover || el.group || el.link || el.morphId),
    })
    const setFx = (patch: Partial<NonNullable<SlideElement['fx']>>) =>
      this.mutate(el.id, (e) => {
        const fx: Record<string, unknown> = { ...(e.fx ?? {}), ...patch }
        for (const k of Object.keys(fx)) if (fx[k] === undefined || fx[k] === false) delete fx[k]
        if (Object.keys(fx).length) e.fx = fx as NonNullable<SlideElement['fx']>
        else delete e.fx
      }, true)

    // Click builds: WHEN this element arrives. The choices are the clicks the
    // slide already has plus "a new click", so authoring never has to know the
    // step numbers (builds.ts compresses gaps; the Builds list reorders).
    {
      const plan = buildPlan(this.store.slide)
      const ats = plan.steps.map((s) => s.at)
      const byPara = el.type === 'text' && !!el.fx?.byParagraph
      const cur = enterStepOf(el)
      const pairs: Array<[string, string]> = [['0', t('With slide')]]
      ats.forEach((at, i) => pairs.push([String(at), t('On click {n}', { n: i + 1 })]))
      if (cur > 0 && !ats.includes(cur)) pairs.push([String(cur), t('On click {n}', { n: ats.length + 1 })])
      pairs.push(['new', t('On a new click')])
      this.row('Appears', this.labeledSelect(pairs, String(cur), (v) => {
        const next = v === 'new' ? Math.max(0, ...ats, cur) + 1 : Number(v)
        // paragraph-built text reads "step 0" as "first paragraph with the slide",
        // so there it is stored; for everything else "with the slide" = no step
        setFx({ step: next > 0 || byPara ? next : undefined })
      }))

      // text: one paragraph per click ("bullets one by one")
      if (el.type === 'text') {
        this.row('Bullets one by one', this.toggle(byPara, (on) =>
          // an explicit "step 0" only means something to paragraph-built text
          setFx({ byParagraph: on ? true : undefined, step: !on && el.fx?.step === 0 ? undefined : el.fx?.step })))
      }

      // Disappears: the click that takes it out again (always after it arrived)
      const x = el.fx?.exitStep ?? 0
      const later = ats.filter((at) => at > cur)
      const outs: Array<[string, string]> = [['0', t('Never')]]
      later.forEach((at) => outs.push([String(at), t('On click {n}', { n: ats.indexOf(at) + 1 })]))
      if (x > 0 && !later.includes(x)) outs.push([String(x), t('On click {n}', { n: ats.length + 1 })])
      outs.push(['new', t('On a new click')])
      this.row('Disappears', this.labeledSelect(outs, String(x), (v) => {
        if (v === '0') setFx({ exitStep: undefined, exit: undefined, exitDur: undefined })
        else setFx({ exitStep: v === 'new' ? Math.max(0, ...ats, cur) + 1 : Number(v) })
      }))
      if (x > 0) {
        this.row('Exit', this.select(
          ['fade', 'fade-up', 'fade-down', 'slide-left', 'slide-right', 'slide-up', 'slide-down'],
          el.fx?.exit ?? 'fade',
          (v) => setFx({ exit: v === 'fade' ? undefined : v as NonNullable<typeof el.fx>['exit'] })))
        const exitKind = el.fx?.exit ?? 'fade'
        this.row('Exit secs', this.number(
          el.fx?.exitDur ?? (exitKind.startsWith('slide-') ? 0.5 : 0.35), 0.05,
          (v, fin) => { if (fin) setFx({ exitDur: Math.max(v, 0.05) }) }))
      }
    }

    this.row('Enter', this.select(
      ['none', 'fade', 'fade-up', 'fade-down', 'slide-left', 'slide-right', 'slide-up', 'slide-down'],
      el.fx?.enter ?? 'none',
      (v) => setFx(v === 'none'
        ? { enter: undefined, enterDur: undefined }
        : { enter: v as NonNullable<typeof el.fx>['enter'] })))
    if (el.fx?.enter) {
      // per-kind default (slide-* 0.75s, fade-* 0.55s); lower = snappier
      this.row('Enter secs', this.number(
        el.fx.enterDur ?? (el.fx.enter.startsWith('slide-') ? 0.75 : 0.55), 0.05,
        (v, fin) => { if (fin) setFx({ enterDur: Math.max(v, 0.05) }) }))
    }
    this.row('Count up', this.select(
      ['off', 'on'], el.fx?.countUp ? 'on' : 'off',
      (v) => setFx({ countUp: v === 'on' ? true : undefined })))
    this.row('Ambient', this.select(
      ['none', 'kenburns'], el.fx?.ambient ?? 'none',
      (v) => setFx(v === 'none' ? { ambient: undefined, ken: undefined } : { ambient: 'kenburns' })))
    if (el.fx?.ambient === 'kenburns') {
      const ken = el.fx.ken ?? {}
      const dir = ken.dir ?? 'drift'
      const setKen = (patch: Partial<NonNullable<NonNullable<SlideElement['fx']>['ken']>>) =>
        setFx({ ken: { ...ken, ...patch } })
      this.row('Zoom', this.select(
        ['drift', 'zoom-out', 'zoom-in'],
        dir === 'out' ? 'zoom-out' : dir === 'in' ? 'zoom-in' : 'drift',
        (v) => {
          const d = v === 'zoom-out' ? 'out' : v === 'zoom-in' ? 'in' : 'drift'
          // give each style its natural pace when switching
          setFx({ ken: d === 'drift' ? undefined : { dir: d, scale: 1.06, duration: 2.5 } })
        }))
      this.row('Zoom %', this.number(
        Math.round(((ken.scale ?? (dir === 'drift' ? 1.1 : 1.06)) - 1) * 100), 1,
        (v, fin) => { if (fin) setKen({ scale: 1 + Math.min(Math.max(v, 0), 100) / 100 }) }))
      this.row('Zoom secs', this.number(
        ken.duration ?? (dir === 'drift' ? 26 : 2.5), 0.1,
        (v, fin) => { if (fin) setKen({ duration: Math.max(v, 0.1) }) }))
    }

    // continuous loop animation
    const loop = el.fx?.loop
    this.row('Loop animation', this.select(
      ['none', 'dash-march', 'motion-path', 'pulse', 'spin', 'float', 'blink', 'wiggle'],
      loop?.type ?? 'none',
      (v) => setFx({
        loop: v === 'none' ? undefined
          : v === 'dash-march' ? { type: 'dash-march', distance: 18, duration: (loop as any)?.duration ?? 1.4 }
          : v === 'motion-path' ? { type: 'motion-path', path: (loop as any)?.path ?? 'M 0 0 L 100 0', duration: (loop as any)?.duration ?? 3 }
          // each generic loop has its own natural pace and size, so none carries over
          : { type: v as keyof typeof LOOP_DEFAULTS },
      })))
    if (loop) {
      const generic = loop.type !== 'dash-march' && loop.type !== 'motion-path' ? loop : null
      this.row('Loop secs', this.number(loop.duration ?? (generic ? LOOP_DEFAULTS[generic.type].cycle : 2), 0.1, (v, fin) =>
        this.mutate(el.id, (e) => { if (e.fx?.loop) e.fx.loop.duration = Math.max(v, 0.1) }, fin)))
      if (generic) {
        const dflt = LOOP_DEFAULTS[generic.type].amount
        const asPct = generic.type === 'pulse' || generic.type === 'blink'
        const amountRow = this.row('Amount', this.number(
          asPct ? Math.round((generic.amount ?? dflt) * 100) : (generic.amount ?? dflt), 1,
          (v, fin) => this.mutate(el.id, (e) => {
            const lp = e.fx?.loop
            if (lp && lp.type !== 'dash-march' && lp.type !== 'motion-path') lp.amount = asPct ? Math.max(v, 0) / 100 : v
          }, fin)))
        amountRow.title = {
          pulse: t('How much it grows, in % (8 = up to 8% bigger)'),
          blink: t('How far it dims, in % (70 = down to 30% opacity)'),
          float: t('How far it rises, in pixels'),
          wiggle: t('Degrees it swings to each side'),
          spin: t('Degrees per turn — negative spins the other way'),
        }[generic.type]
        if (generic.type === 'spin' || generic.type === 'wiggle' || generic.type === 'pulse') {
          this.row('Pivot', this.labeledSelect(
            [['center', tc('Center', 'pivot')], ['bottom', t('Bottom')], ['top', t('Top')], ['left', t('Left')], ['right', t('Right')]],
            generic.origin ?? 'center',
            (v) => this.mutate(el.id, (e) => {
              const lp = e.fx?.loop
              if (!lp || lp.type === 'dash-march' || lp.type === 'motion-path') return
              if (v === 'center') delete lp.origin; else lp.origin = v as LoopOrigin
            }, true)))
        }
        this.row('Loop delay', this.number(generic.delay ?? 0, 0.1, (v, fin) =>
          this.mutate(el.id, (e) => {
            const lp = e.fx?.loop
            if (lp && lp.type !== 'dash-march' && lp.type !== 'motion-path') { if (v > 0) lp.delay = v; else delete lp.delay }
          }, fin)))
      }
      if (loop.type === 'motion-path') {
        const path = document.createElement('input')
        path.type = 'text'
        path.value = loop.path
        path.title = t('SVG path the element travels along, relative to its position')
        path.addEventListener('change', () =>
          this.mutate(el.id, (e) => { if (e.fx?.loop?.type === 'motion-path') e.fx.loop.path = path.value }, true))
        this.row('Path', path)

        // lap easing — the tempo of a whole lap (per-anchor speed is edited on canvas)
        this.row('Lap easing', this.labeledSelect(
          [['none', t('Constant')], ['sine.inOut', t('Ease in-out')], ['power2.in', t('Ease in')], ['power2.out', t('Ease out')]],
          (loop as { ease?: string }).ease ?? 'none',
          (v) => this.mutate(el.id, (e) => {
            const lp = e.fx?.loop
            if (lp?.type !== 'motion-path') return
            if (v === 'none') delete lp.ease; else lp.ease = v
          }, true)))

        const editPath = document.createElement('button')
        editPath.className = 'ed-btn ed-btn-block'
        editPath.textContent = t('✎ Edit path on canvas')
        editPath.title = t('Drag points to reshape · double-click to add/remove · scroll a point to change its speed')
        editPath.addEventListener('click', () =>
          document.dispatchEvent(new CustomEvent('slidomingo:edit-path', { detail: { id: el.id } })))
        this.host.appendChild(editPath)
        const speedHint = document.createElement('p')
        speedHint.className = 'ed-hint'
        speedHint.textContent = t('Tip: on the canvas, scroll a point to make the element dwell there or rush past it.')
        this.host.appendChild(speedHint)
      }
    }

    if (el.fx) {
      const play = document.createElement('button')
      play.className = 'ed-btn ed-btn-block'
      play.textContent = t('▶ Preview animation')
      play.title = t('Play this slide\'s animations on the canvas (click or any key stops)')
      play.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:preview-fx')))
      this.host.appendChild(play)
    }

    // hover-reveal set membership
    const soh = document.createElement('input')
    soh.type = 'text'
    soh.placeholder = t('always visible')
    soh.value = el.showOnHover ?? ''
    soh.title = "Only visible while an element with this group is hovered (slide hover: 'reveal')"
    soh.addEventListener('change', () => {
      this.mutate(el.id, (e) => {
        if (soh.value) e.showOnHover = soh.value
        else delete e.showOnHover
      }, true)
      // follow the element into its new set so it stays visible/editable
      this.store.hoverPreview = soh.value || null
      this.store.emit('current')
    })
    this.row('Show on hover', soh)

    // group tag (hover focus & interaction targeting)
    const group = document.createElement('input')
    group.type = 'text'
    group.placeholder = t('none')
    group.value = el.group ?? ''
    group.addEventListener('change', () =>
      this.mutate(el.id, (e) => {
        if (group.value) e.group = group.value
        else delete e.group
      }, true))
    this.row('Group', group)

    // link → slide picker
    const sel = document.createElement('select')
    const none = document.createElement('option')
    none.value = ''
    none.textContent = t('none')
    sel.appendChild(none)
    this.store.doc.slides.forEach((s, i) => {
      const o = document.createElement('option')
      o.value = s.id
      o.textContent = this.slideLabel(s, i)
      if (el.link === s.id) o.selected = true
      sel.appendChild(o)
    })
    sel.addEventListener('change', () =>
      this.mutate(el.id, (e) => {
        if (sel.value) e.link = sel.value
        else delete e.link
      }, true))
    if (el.type !== 'zoom') this.row('Link to', sel) // a zoom tile's click is the zoom

    // one-click interactivity: duplicate this slide as a hidden state
    // (element ids preserved ⇒ it morphs) and link this element to it
    const makeState = document.createElement('button')
    makeState.className = 'ed-btn ed-btn-block'
    makeState.textContent = t('＋ New state linked from this element')
    makeState.title = t('Duplicates this slide as a hidden interactive state and links the selected element to it')
    makeState.addEventListener('click', () => this.createLinkedState(el))
    if (el.type !== 'zoom') this.host.appendChild(makeState)

    this.buildMorphProps(el)
  }

  /**
   * Re-sync an interactive state with its parent: parent elements missing
   * here (added since the state was created) come in, ordering follows the
   * parent, and this state's own versions of shared elements — its whole
   * point — stay untouched. Elements unique to this state stay on top.
   */
  private syncStateFromParent() {
    const r = syncStateWithParent(this.store, this.store.slide.id)
    if (typeof r === 'string') { this.toast(r); return }
    this.store.select([])
    const bits = [r.added ? `${r.added} new element${r.added > 1 ? 's' : ''} pulled in` : 'nothing new in the parent']
    if (r.kept) bits.push(`${r.kept} state-only element${r.kept > 1 ? 's' : ''} kept`)
    this.toast(`Synced — ${bits.join('; ')}`)
  }

  private toast(message: string, ms = 2600) {
    document.querySelector('.ed-toast')?.remove()
    const t = document.createElement('div')
    t.className = 'ed-toast'
    t.textContent = message
    document.body.appendChild(t)
    setTimeout(() => t.classList.add('show'))
    setTimeout(() => {
      t.classList.remove('show')
      setTimeout(() => t.remove(), 300)
    }, ms)
  }

  /** Right-click ▸ Convert to objects, and the Diagram section's button. */
  convertSvg(id: string) {
    const r = convertSvgInPlace(this.store, id)
    if (!r.ok) { this.toast(r.error, 5000); return }
    this.toast(r.notes.length
      ? `${t('Converted into {n} objects.', { n: String(r.count) })} ${t('Not carried over:')} ${r.notes.join('; ')}.`
      : t('Converted into {n} objects.', { n: String(r.count) }), r.notes.length ? 9000 : 2600)
  }

  /** A diagram is opaque artwork; this is the way into editing it. */
  private buildSvgProps(el: SvgElement) {
    const convert = document.createElement('button')
    convert.className = 'ed-btn ed-btn-block'
    convert.textContent = t('Convert to objects')
    convert.title = t('Turn this diagram into shapes, curves and text you can select and edit one by one (one undo step)')
    convert.addEventListener('click', () => this.convertSvg(el.id))
    this.host.appendChild(convert)
  }

  /** Duplicate the current slide as a hidden state and link `el` to it. */
  private createLinkedState(el: SlideElement) {
    const state = addLinkedState(this.store, this.store.slide.id, el.id)
    if (state) this.store.goTo(this.store.doc.slides.indexOf(state))
  }

  /** Human label for a slide in pickers. */
  private slideLabel(s: { id: string; name?: string; stateOf?: string }, i: number): string {
    const linear = this.store.doc.slides.slice(0, i + 1).filter((x) => !x.stateOf).length
    if (s.stateOf) {
      const p = this.store.doc.slides.findIndex((x) => x.id === s.stateOf)
      const pn = this.store.doc.slides.slice(0, p + 1).filter((x) => !x.stateOf).length
      return `state of ${pn}${s.name ? ` — ${s.name}` : ''}`
    }
    return `slide ${linear}${s.name ? ` — ${s.name}` : ''}`
  }

  /**
   * "Fit height to text" — set `h` to exactly what the content needs.
   *
   * A box that is too short lets its text spill over whatever sits below, and
   * one that is too tall throws off vertical alignment against its neighbours;
   * neither is visible in the numbers. The button reports the delta so it is
   * obvious whether anything was wrong before you press it.
   */
  private buildFitHeight(el: TextElement) {
    if (!el.html?.trim()) return // nothing to measure yet
    const m = measureElement(el, this.store.doc)
    const delta = m.height - el.h
    const fit = document.createElement('button')
    fit.className = 'ed-btn ed-btn-block'
    fit.textContent = t('Fit height to text')
    fit.title = t('The text needs {need}px and the box is {have}px',
      { need: String(m.height), have: String(el.h) })
    if (delta === 0) fit.setAttribute('disabled', '')
    fit.addEventListener('click', () => {
      // measure again at click time — the text may have been edited since the
      // panel was built, and a stale height is worse than no button
      const fresh = measureElement(this.store.element(el.id) as TextElement, this.store.doc)
      this.mutate(el.id, (e) => { e.h = fresh.height }, true)
    })
    this.host.appendChild(fit)
  }

  /** The dynamic-field tokens render.ts's `resolveFields` understands — see
   *  render.ts's doc comment for the full list. Kept local: this is the one
   *  UI surface that needs the human labels, everywhere else reads/writes
   *  the raw token. */
  private static readonly FIELD_TOKENS: Array<[string, string]> = [
    ['Page number', '{{page}}'],
    ['Total pages', '{{pages}}'],
    ['Date', '{{date}}'],
    ['Time', '{{time}}'],
    ['Title', '{{title}}'],
    ['Author', '{{author}}'],
    ['Company', '{{company}}'],
    ['Subject', '{{subject}}'],
    ['Event', '{{event}}'],
    ['Footer text', '{{footer}}'],
  ]

  /**
   * "Insert field" — the discoverability fix for tokens that already fully
   * work (render.ts resolveFields/fieldContext) but previously had no UI:
   * you had to know to hand-type `{{page}}`. A floating menu, not a native
   * `<select>`, specifically so opening it and picking a token can keep
   * focus OFF the menu the whole time (`mousedown` + `preventDefault()` on
   * every option, same trick colorpicker.ts's native-picker button uses) —
   * a native select steals focus on open, which would end an in-progress
   * canvas text edit (canvas.ts commits on `blur`) before the token could
   * ever reach it.
   */
  private buildInsertFieldControl(el: TextElement): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'ed-insertfield'
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'ed-btn ed-btn-block'
    trigger.textContent = t('Insert field…')
    trigger.title = t('Insert a token that resolves live — page numbers renumber as slides change, the rest follow Document properties')
    trigger.addEventListener('mousedown', (ev) => ev.preventDefault())
    wrap.appendChild(trigger)

    let pop: HTMLElement | null = null
    let close = () => {}
    trigger.addEventListener('click', () => {
      if (pop) { close(); return }
      pop = document.createElement('div')
      pop.className = 'ed-insertfield-menu'
      // plus one entry per custom document property ({{prop:Name}})
      const props = Object.keys(this.store.doc.meta?.custom ?? {}).map((n): [string, string, boolean] => [n, `{{prop:${n}}}`, true])
      // and, on a slide type, one per translated term ({{term:Name}}), shown
      // in the document language — terms are template chrome, not content
      const terms = this.store.editingSurface?.kind !== 'layout' ? [] : (this.store.doc.terms?.entries ?? []).map((e): [string, string, boolean] => [`${e.name} — ${termText(this.store.doc, e.name)}`, `{{term:${e.name}}}`, true])
      for (const [label, token, raw] of [...PropsPanel.FIELD_TOKENS.map(([l, tk]): [string, string, boolean] => [l, tk, false]), ...props, ...terms]) {
        const opt = document.createElement('button')
        opt.type = 'button'
        opt.textContent = raw ? label : t(label)
        opt.addEventListener('mousedown', (ev) => ev.preventDefault())
        opt.addEventListener('click', () => {
          this.insertFieldToken(el.id, token)
          close()
        })
        pop.appendChild(opt)
      }
      wrap.appendChild(pop)
      positionFloating(trigger, pop, { placement: 'bottom-start' })
      close = () => {
        pop?.remove()
        pop = null
        document.removeEventListener('pointerdown', onOutside, true)
        document.removeEventListener('keydown', onKey, true)
      }
      const onOutside = (ev: PointerEvent) => {
        if (pop && !pop.contains(ev.target as Node) && ev.target !== trigger) close()
      }
      const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
      setTimeout(() => document.addEventListener('pointerdown', onOutside, true))
      document.addEventListener('keydown', onKey, true)
    })
    return wrap
  }

  /**
   * "Make translatable" (template window, a slide type's text): the words
   * selected in a live edit — or, with no edit open, the whole text when it
   * is plain — become a `doc.terms` entry (`model.ensureTerm`) and a
   * `{{term:…}}` token in their place. Same focus trick as Insert field: the
   * button never takes focus, so the edit's Selection is still there.
   */
  private buildMakeTranslatable(el: TextElement): HTMLElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn ed-btn-block'
    b.textContent = t('Make translatable')
    b.title = t('Turn the selected words into a term of this layout, so each deck shows them in its own language (Document properties ▸ Language & terms)')
    b.addEventListener('mousedown', (ev) => ev.preventDefault())
    b.addEventListener('click', () => {
      const editingNode = document.querySelector<HTMLElement>('.slidomingo-editing')
      const inner = editingNode?.dataset.elId === el.id ? editingNode.querySelector<HTMLElement>('.slidomingo-text-inner') : null
      const lang = this.store.doc.meta?.language || locale().split('-')[0] || 'en'
      if (inner && document.activeElement === inner) {
        const sel = window.getSelection()
        const text = sel && !sel.isCollapsed && inner.contains(sel.anchorNode) ? sel.toString() : ''
        if (!text.trim() || text.includes('{{')) { this.toast(t('Select the words to translate first')); return }
        let name = ''
        this.store.commit(() => { name = ensureTerm(this.store.doc, text, lang) })
        document.execCommand('insertText', false, `{{term:${name}}}`)
        return
      }
      const cur = this.store.slide?.elements.find((e) => e.id === el.id) as TextElement | undefined
      if (!cur || /[<{]/.test(cur.html) || !cur.html.trim()) { this.toast(t('Select the words to translate first')); return }
      this.store.commit(() => {
        const plain = new DOMParser().parseFromString(cur.html, 'text/html').body.textContent ?? ''
        const name = ensureTerm(this.store.doc, plain, lang)
        cur.html = `{{term:${name}}}`
      })
    })
    return b
  }

  /**
   * Insert one field token into a text element two different ways, per the
   * design's deliberate split:
   *
   * - Mid live-edit (the canvas contentEditable session for THIS element is
   *   still open — checked via the DOM, not store state, since that is the
   *   only place edit-in-progress lives): insert at the cursor with
   *   `execCommand('insertText', …)`. This only works because the trigger/
   *   option buttons above never took focus (mousedown preventDefault), so
   *   `document.activeElement` is still the live contentEditable and its
   *   Selection/Range is exactly where the author left it.
   * - Otherwise (element merely selected): append to the end of `el.html`
   *   through the normal panel `mutate()` path. Panels don't track cursor
   *   position outside an active edit session, so this is a deliberate,
   *   documented simplification, not a bug.
   */
  private insertFieldToken(elId: string, token: string) {
    const editingNode = document.querySelector<HTMLElement>('.slidomingo-editing')
    const inner = editingNode?.dataset.elId === elId
      ? editingNode.querySelector<HTMLElement>('.slidomingo-text-inner')
      : null
    if (inner && document.activeElement === inner) {
      document.execCommand('insertText', false, token)
      return
    }
    this.mutate(elId, (e) => { (e as TextElement).html = (e as TextElement).html + token }, true)
  }

  /** The label/button pair shown in a basics row when the element paints a
   *  gradient instead of the solid colour: one click opens the section that
   *  edits it, rather than a colour well that would silently do nothing
   *  (the gradient wins over the solid fallback). */
  private gradientJump(sectionKey: string): HTMLElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn ed-grad-jump'
    b.textContent = t('gradient')
    b.title = t('Edit the gradient')
    b.addEventListener('click', () => this.revealSection(sectionKey))
    return b
  }

  private buildTextProps(el: TextElement) {
    // --- basics ---------------------------------------------------------------
    this.row('Font', this.fontSelect(el))
    // Shown in POINTS (the unit office users know); the model stores slide-space
    // px. 1pt = 4/3 px at the slide's 96dpi space, so 32px = 24pt exactly.
    this.row('Size (pt)', this.number(ElementEdits.fontSizePt(el), 1, (v, fin) =>
      this.edits.setFontSizePt(el.id, v, fin)))
    const tgrad = el.colorGradient
    this.row('Color', tgrad
      ? this.gradientJump('Typography')
      : this.color(el.color, (v, fin) => this.edits.setFill(el.id, v, fin), { id: el.id, path: 'color' }))
    this.row('Weight', this.weightSelect(el))
    this.row('Align', this.segButtons([
      ['left', t('left'), ICONS.textLeft],
      ['center', t('center'), ICONS.textCenter],
      ['right', t('right'), ICONS.textRight],
    ], el.align, (v) => this.edits.setTextAlign(el.id, v as TextElement['align'])))

    // --- more -----------------------------------------------------------------
    this.section('Typography', {
      modified: !!(tgrad || el.textStroke?.width || el.valign !== 'middle' || el.lineHeight !== 1.25),
    })
    // Text fill: a solid colour, or a multi-stop gradient painted into the glyphs.
    this.row('Fill style', this.labeledSelect(fillStyles(), tgrad ? 'gradient' : 'solid', (v) =>
      this.mutate(el.id, (e) => {
        const tx = e as TextElement
        if (v === 'gradient') {
          const base = parseColor(tx.color)
          tx.colorGradient ??= {
            angle: 90,
            stops: [
              { at: 0, color: combineColor(base.hex, Math.max(base.a, 1)) },
              { at: 1, color: '#5B8DEF' },
            ],
          }
        } else {
          delete tx.colorGradient
        }
      }, true)))
    if (tgrad) {
      this.row('Grad. angle', this.number(tgrad.angle, 1, (v, fin) =>
        this.mutate(el.id, (e) => {
          const g = (e as TextElement).colorGradient
          if (g) g.angle = v
        }, fin)))
      this.host.appendChild(this.gradientBar(el.id, (e) => (e as TextElement).colorGradient?.stops))
      tgrad.stops.forEach((stop, i) => {
        const wrap = document.createElement('div')
        wrap.className = 'ed-gradstop'
        const at = this.number(Math.round(stop.at * 100), 1, (v, fin) =>
          this.mutate(el.id, (e) => {
            const g = (e as TextElement).colorGradient
            if (g?.stops[i]) g.stops[i].at = Math.min(Math.max(v / 100, 0), 1)
          }, fin))
        at.title = t('Position %')
        const color = this.colorAlpha(stop.color, (v, fin) =>
          this.mutate(el.id, (e) => {
            const g = (e as TextElement).colorGradient
            if (g?.stops[i]) g.stops[i].color = v
          }, fin))
        wrap.append(at, color)
        if (tgrad.stops.length > 2) {
          const del = document.createElement('button')
          del.className = 'ed-btn ed-btn-icon'
          del.textContent = '✕'
          del.title = t('Remove stop')
          del.addEventListener('click', () =>
            this.mutate(el.id, (e) => {
              const g = (e as TextElement).colorGradient
              if (g && g.stops.length > 2) g.stops.splice(i, 1)
            }, true))
          wrap.appendChild(del)
        }
        this.row(`Stop ${i + 1}`, wrap)
      })
      const addStop = document.createElement('button')
      addStop.className = 'ed-btn ed-btn-block'
      addStop.textContent = t('＋ Add stop')
      addStop.title = t('Add gradient stop')
      addStop.addEventListener('click', () =>
        this.mutate(el.id, (e) => {
          const g = (e as TextElement).colorGradient
          if (!g) return
          const mid = g.stops[Math.floor(g.stops.length / 2)]
          g.stops.push({ at: 0.5, color: mid?.color ?? '#808080' })
          g.stops.sort((a, b) => a.at - b.at)
        }, true))
      this.host.appendChild(addStop)
    }
    this.row('V-align', this.select(['top', 'middle', 'bottom'], el.valign, (v) =>
      this.mutate(el.id, (e) => { (e as TextElement).valign = v as TextElement['valign'] }, true)))
    this.row('Line height', this.number(el.lineHeight, 0.05, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TextElement).lineHeight = Math.max(v, 0.5) }, fin)))

    // Outline / hollow glyphs via -webkit-text-stroke. Width 0 = off; 'hollow'
    // makes the glyph interior transparent (the classic outlined section word).
    const ts = el.textStroke
    this.row('Outline', this.number(ts?.width ?? 0, 0.5, (v, fin) =>
      this.mutate(el.id, (e) => {
        const tx = e as TextElement
        if (v > 0) tx.textStroke = { color: '#1D1119', ...(tx.textStroke ?? {}), width: v }
        else delete tx.textStroke
      }, fin)))
    if (ts && ts.width) {
      this.row('Outline color', this.colorAlpha(ts.color, (v, fin) =>
        this.mutate(el.id, (e) => {
          const g = (e as TextElement).textStroke
          if (g) g.color = v
        }, fin)))
      this.row('Interior', this.select(['filled', 'hollow'], ts.fill === 'none' ? 'hollow' : 'filled', (v) =>
        this.mutate(el.id, (e) => {
          const g = (e as TextElement).textStroke
          if (g) { if (v === 'hollow') g.fill = 'none'; else delete g.fill }
        }, true)))
    }

    this.buildFitHeight(el)
    this.host.appendChild(this.buildInsertFieldControl(el))
    if (this.store.editingSurface?.kind === 'layout' && this.store.doc.template) this.host.appendChild(this.buildMakeTranslatable(el))
    this.host.appendChild(this.buildInsertMathControl(el))
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.innerHTML = t('While editing: <b>⌘B</b>/<b>⌘I</b>/<b>⌘U</b> · markdown auto-converts — **bold*&#8203;* *italic*&#8203; `code` ~~strike~~ and "- " bullets; pasting markdown converts too. Escape with \\ or press ⌘Z right after to keep the literal characters.')
    this.host.appendChild(hint)

    const embed = document.createElement('button')
    embed.className = 'ed-btn ed-btn-block'
    embed.textContent = t('＋ Embed font file…')
    embed.title = t('Bundle a .woff2/.woff/.ttf/.otf into this file and use it here')
    embed.addEventListener('click', () => this.embedFont(el))
    this.host.appendChild(embed)
  }

  /**
   * Font picker: theme default, fonts embedded in the document, fonts actually
   * installed on the machine (Local Font Access API — see localfonts.ts),
   * curated cross-platform stacks, and (if unmatched) the element's current
   * custom stack. Options render in their own face so the menu previews itself.
   */
  private fontSelect(el: TextElement): HTMLElement {
    // Only ever reached from a genuine user-gesture-triggered rebuild (panel
    // rebuilds are downstream of clicks/keypresses), which is what satisfies
    // queryLocalFonts()'s transient-activation requirement.
    requestSystemFonts()
    const sel = document.createElement('select')
    populateFontSelect(sel, this.store.doc, el.fontFamily ?? '', 'theme default')
    sel.addEventListener('change', () =>
      this.mutate(el.id, (e) => { (e as TextElement).fontFamily = sel.value }, true))
    return sel
  }

  /** Bundle a font file into the document and apply it to this element. */
  private embedFont(el: TextElement) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.woff2,.woff,.ttf,.otf'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const family = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Embedded font'
        const asset = `font_${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        this.store.commit(() => {
          const doc = this.store.doc
          doc.assets = { ...(doc.assets ?? {}), [asset]: String(reader.result) }
          doc.fonts = [...(doc.fonts ?? []).filter((f) => f.family !== family), { family, asset }]
          const live = this.store.element(el.id)
          if (live && live.type === 'text') live.fontFamily = family
        })
        injectFonts(this.store.doc)
        this.toast(`"${family}" embedded into this file`)
      }
      reader.readAsDataURL(file)
    })
    input.click()
  }

  private buildShapeProps(el: ShapeElement) {
    const line = el.shape === 'line'
    const path = el.shape === 'path'
    const grad = el.fillGradient
    // a line's one colour row says what it paints; a borderless shape's
    // Stroke opens on the default grey at 0% (picking a colour lifts that to
    // 100% — colorpicker.ts alphaAfterHuePick), see ElementEdits.strokeOf
    const strokeRow = () => this.row(line ? 'Line color' : 'Stroke', this.colorAlpha(this.edits.strokeOf(el), (v, fin) =>
      this.edits.setStroke(el.id, v, fin), { id: el.id, path: ElementEdits.strokePath(el) }))
    const widthRow = () => this.row('Stroke width', this.number(el.strokeWidth, 0.5, (v, fin) =>
      this.edits.setStrokeWidth(el.id, v, fin)))
    const fillRow = () => this.row('Fill', grad
      ? this.gradientJump('Fill & stroke')
      : this.colorAlpha(el.fill, (v, fin) => this.edits.setFill(el.id, v, fin), { id: el.id, path: 'fill' }))
    const lineStyleRow = () => this.row('Line style', this.select(
      ['solid', 'dashed', 'dotted'],
      el.strokeStyle ?? (el.strokeDash ? 'dashed' : 'solid'),
      (v) => this.mutate(el.id, (e) => {
        const s = e as ShapeElement
        s.strokeStyle = v === 'solid' ? undefined : (v as 'dashed' | 'dotted')
        if (v === 'solid') delete s.strokeDash // clear the legacy dash too
      }, true)))
    const dashed = !!(el.strokeStyle && el.strokeStyle !== 'solid') || !!el.strokeDash

    if (line) {
      // A line is all stroke: its colour (stored in `fill` — see
      // ElementEdits.setStroke), its width and its tips are the basics.
      const ENDINGS = ['none', 'arrow', 'dot', 'bar']
      strokeRow()
      widthRow()
      this.row('Start tip', this.select(ENDINGS, el.lineStart ?? 'none', (v) =>
        this.mutate(el.id, (e) => { (e as ShapeElement).lineStart = v === 'none' ? undefined : (v as LineEnding) }, true)))
      this.row('End tip', this.select(ENDINGS, el.lineEnd ?? 'none', (v) =>
        this.mutate(el.id, (e) => { (e as ShapeElement).lineEnd = v === 'none' ? undefined : (v as LineEnding) }, true)))
      this.buildIconShapeStyle([el]) // after the basics: they belong to the fixed header
      this.section('Stroke', { modified: dashed || !!el.strokeCap })
      lineStyleRow()
      this.row('Cap style', this.select(['round', 'square', 'butt'], el.strokeCap ?? 'round', (v) =>
        this.mutate(el.id, (e) => { (e as ShapeElement).strokeCap = v === 'round' ? undefined : (v as 'round' | 'square' | 'butt') }, true)))
      return
    }

    // A curve is usually an open stroke, so its stroke leads; every other
    // shape leads with its fill.
    if (path) { strokeRow(); widthRow(); fillRow() }
    else { fillRow(); strokeRow(); widthRow() }
    if (el.shape === 'rect') {
      this.row('Corner radius', this.number(el.radius, 1, (v, fin) =>
        this.mutate(el.id, (e) => { (e as ShapeElement).radius = Math.max(v, 0) }, fin)))
    }

    this.buildIconShapeStyle([el]) // after the basics: they belong to the fixed header
    this.section('Fill & stroke', { modified: !!grad || dashed })
    this.row('Fill style', this.labeledSelect(fillStyles(), grad ? 'gradient' : 'solid', (v) =>
      this.mutate(el.id, (e) => {
        const s = e as ShapeElement
        if (v === 'gradient') {
          const base = parseColor(s.fill)
          s.fillGradient ??= {
            angle: 180,
            stops: [
              { at: 0, color: combineColor(base.hex, Math.max(base.a, 0.85)) },
              { at: 1, color: combineColor(base.hex, 0) },
            ],
          }
        } else {
          delete s.fillGradient
        }
      }, true)))

    if (grad) {
      this.row('Grad. angle', this.number(grad.angle, 1, (v, fin) =>
        this.mutate(el.id, (e) => {
          const g = (e as ShapeElement).fillGradient
          if (g) g.angle = v
        }, fin)))
      this.host.appendChild(this.gradientBar(el.id, (e) => (e as ShapeElement).fillGradient?.stops))
      grad.stops.forEach((stop, i) => {
        const wrap = document.createElement('div')
        wrap.className = 'ed-gradstop'
        const at = this.number(Math.round(stop.at * 100), 1, (v, fin) =>
          this.mutate(el.id, (e) => {
            const g = (e as ShapeElement).fillGradient
            if (g?.stops[i]) g.stops[i].at = Math.min(Math.max(v / 100, 0), 1)
          }, fin))
        at.title = t('Position %')
        const color = this.colorAlpha(stop.color, (v, fin) =>
          this.mutate(el.id, (e) => {
            const g = (e as ShapeElement).fillGradient
            if (g?.stops[i]) g.stops[i].color = v
          }, fin))
        wrap.append(at, color)
        if (grad.stops.length > 2) {
          const del = document.createElement('button')
          del.className = 'ed-btn ed-btn-icon'
          del.textContent = '✕'
          del.title = t('Remove stop')
          del.addEventListener('click', () =>
            this.mutate(el.id, (e) => {
              const g = (e as ShapeElement).fillGradient
              if (g && g.stops.length > 2) g.stops.splice(i, 1)
            }, true))
          wrap.appendChild(del)
        }
        this.row(`Stop ${i + 1}`, wrap)
      })
      const add = document.createElement('button')
      add.className = 'ed-btn ed-btn-block'
      add.textContent = t('＋ Add stop')
      add.title = t('Add gradient stop')
      add.addEventListener('click', () =>
        this.mutate(el.id, (e) => {
          const g = (e as ShapeElement).fillGradient
          if (!g) return
          const mid = g.stops[Math.floor(g.stops.length / 2)]
          g.stops.push({ at: 0.5, color: mid?.color ?? '#808080' })
          g.stops.sort((a, b) => a.at - b.at)
        }, true))
      this.host.appendChild(add)
    }

    lineStyleRow()
  }

  /** Edit the live chart option in place; final=false while typing. */
  private editOption(id: string, fn: (o: Record<string, any>) => void, final = true) {
    this.mutate(id, (e) => { fn((e as ChartElement).option as Record<string, any>) }, final)
  }

  /** Native <select> with distinct value/label pairs (for model-word values). */
  private labeledSelect(pairs: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement {
    const sel = document.createElement('select')
    for (const [v, label] of pairs) {
      const o = document.createElement('option')
      o.value = v; o.textContent = label
      if (v === value) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => onChange(sel.value))
    return sel
  }

  private buildChartProps(el: ChartElement) {
    const opt = el.option as Record<string, any>
    const series: any[] = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []
    const isPie = series.some((s) => s?.type === 'pie')
    const isScatter = series.some((s) => s?.type === 'scatter')
    // live table binding banner (if this chart tracks a table)
    if (el.source?.tableId) {
      const linkRow = document.createElement('div')
      linkRow.className = 'ed-chart-link'
      const label = document.createElement('span')
      const stillThere = this.store.slide.elements.some((e) => e.id === el.source!.tableId && e.type === 'table')
      label.textContent = stillThere ? t('🔗 Live-linked to a table') : t('🔗 Linked table not on this slide')
      const unlink = document.createElement('button')
      unlink.className = 'ed-btn'
      unlink.textContent = t('Unlink')
      unlink.title = t('Stop tracking the table; the chart keeps its current data')
      unlink.addEventListener('click', () => this.mutate(el.id, (e) => { delete (e as ChartElement).source }, true))
      linkRow.append(label, unlink)
      this.host.appendChild(linkRow)
    }
    this.row('Type', this.select(Object.keys(CHART_PRESETS), el.preset ?? 'bar', (v) =>
      this.mutate(el.id, (e) => {
        const c = e as ChartElement
        c.preset = v
        c.option = applyChartPalette(CHART_PRESETS[v](), this.store.doc.theme)
      }, true)))

    if (!isPie && !isScatter) this.buildChartCartesian(el, opt, series)
    else if (isPie) this.buildChartPie(el, series)
  }

  /** The escape hatch: the full option as JSON, for anything the UI omits.
   *  Rendered inside the Advanced section (buildAdvancedProps). */
  private buildChartJson(el: ChartElement) {
    this.subhead(t('Chart option (JSON)'))
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.innerHTML = t('The full <b>chart option</b> as JSON (pure data — use template-string formatters like <code>{b}: {c}</code>, never functions). Tooltips and zoom run while presenting.')
    this.host.appendChild(hint)
    const ta = document.createElement('textarea')
    ta.className = 'ed-chart-json'
    ta.rows = 12
    ta.spellcheck = false
    ta.value = JSON.stringify(el.option, null, 2)
    ta.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(ta.value)
        ta.classList.remove('ed-invalid')
        this.mutate(el.id, (e) => { (e as ChartElement).option = parsed }, true)
      } catch { ta.classList.add('ed-invalid') }
    })
    this.host.appendChild(ta)
  }

  private static seriesColor(s: any, palette: string[] | undefined, i: number): string {
    const c = s?.type === 'line' ? s?.lineStyle?.color : s?.itemStyle?.color
    if (typeof c === 'string') return c
    const p = palette && palette.length ? palette : ['#5470c6', '#91cc75', '#fac858', '#ee6666']
    return p[i % p.length]
  }

  private static setSeriesColor(s: any, v: string) {
    if (s?.type === 'line') s.lineStyle = { ...(s.lineStyle ?? {}), color: v }
    else s.itemStyle = { ...(s.itemStyle ?? {}), color: v }
  }

  private buildChartCartesian(el: ChartElement, opt: Record<string, any>, series: any[]) {
    // horizontal bars keep their ONE value axis on xAxis (chartaxes.ts)
    const horizontal = chartIsHorizontal(opt)
    const valKey = valueAxisKey(opt)
    const yAxis: any[] = Array.isArray(opt[valKey]) ? opt[valKey] : opt[valKey] ? [opt[valKey]] : [{ type: 'value' }]
    const twoAxes = !horizontal && yAxis.length > 1

    this.row('Legend', this.toggle(!!opt.legend, (on) =>
      this.editOption(el.id, (o) => { if (on) o.legend = { bottom: 0 }; else delete o.legend })))
    // orientation is a bar chart's choice; a line-only chart offers it only
    // when it is already sideways, so it can be turned back
    if (horizontal || series.some((s) => s?.type === 'bar')) {
      this.row('Bar direction', this.labeledSelect([['vertical', t('Vertical')], ['horizontal', t('Horizontal')]],
        horizontal ? 'horizontal' : 'vertical',
        (v) => this.editOption(el.id, (o) => { setChartHorizontal(o, v === 'horizontal') })))
    }
    this.row('Stacked', this.toggle(chartIsStacked(opt), (on) =>
      this.editOption(el.id, (o) => setChartStacked(o, on))))

    // The data is what a chart is FOR — its grid stays an open section right
    // under the basics; series styling and axes are the "more".
    this.buildChartGrid(el, opt, series)

    this.section('Series')
    // one value axis across horizontal bars — no second axis to offer
    if (!horizontal) this.row('Second axis', this.toggle(twoAxes, (on) => this.editOption(el.id, (o) => {
      const ss: any[] = Array.isArray(o.series) ? o.series : o.series ? [o.series] : []
      if (on) {
        const first = Array.isArray(o.yAxis) ? (o.yAxis[0] ?? {}) : (o.yAxis ?? {})
        o.yAxis = [{ type: 'value', ...first }, { type: 'value', name: t('Axis {n}', { n: 2 }) }]
        ss.forEach((s, i) => { if (s) s.yAxisIndex = i === 0 ? 0 : 1 })
      } else {
        o.yAxis = { type: 'value', ...(Array.isArray(o.yAxis) ? o.yAxis[0] : o.yAxis) }
        ss.forEach((s) => { if (s) delete s.yAxisIndex })
      }
    })))

    // --- series list --------------------------------------------------------
    const palette: string[] | undefined = Array.isArray(opt.color) ? opt.color : undefined
    series.forEach((s, i) => {
      const row = document.createElement('div')
      row.className = 'ed-series-row'
      const name = document.createElement('input')
      name.type = 'text'; name.className = 'ed-series-name'; name.value = s?.name ?? ''
      name.placeholder = t('Series {n}', { n: i + 1 })
      name.addEventListener('input', () => this.editOption(el.id, (o) => { o.series[i].name = name.value }, false))
      name.addEventListener('change', () => this.editOption(el.id, (o) => { o.series[i].name = name.value }, true))
      const type = this.labeledSelect([['bar', t('Bar')], ['line', t('Line')]], s?.type === 'line' ? 'line' : 'bar',
        (v) => this.editOption(el.id, (o) => { o.series[i].type = v }))
      row.append(name, type)
      if (twoAxes) {
        row.append(this.labeledSelect([['0', t('Left')], ['1', t('Right')]], String(Math.round(s?.yAxisIndex ?? 0)),
          (v) => this.editOption(el.id, (o) => { o.series[i].yAxisIndex = parseInt(v) })))
      }
      row.append(this.color(PropsPanel.seriesColor(s, palette, i), (v, final) =>
        this.editOption(el.id, (o) => PropsPanel.setSeriesColor(o.series[i], v), final)))
      const rm = this.opBtn('✕', t('Remove'), () => this.editOption(el.id, (o) => {
        o.series.splice(i, 1)
        if (o.series.length <= 1) { o.series.forEach((x: any) => x && delete x.yAxisIndex); if (Array.isArray(o.yAxis)) o.yAxis = o.yAxis[0] ?? { type: 'value' } }
      }))
      rm.classList.add('ed-series-rm')
      row.append(rm)
      this.host.appendChild(row)
    })
    const addRow = document.createElement('div')
    addRow.className = 'ed-chart-add'
    const addBtn = document.createElement('button')
    addBtn.className = 'ed-btn'
    addBtn.textContent = t('＋ Add series')
    addBtn.title = t('Add chart series')
    addBtn.addEventListener('click', () => this.editOption(el.id, (o) => {
      const ss: any[] = Array.isArray(o.series) ? o.series : o.series ? [o.series] : []
      const n = chartCategories(o).length || 4
      ss.push({ type: 'bar', name: t('Series {n}', { n: ss.length + 1 }), data: Array(n).fill(0) })
      o.series = ss
    }))
    addRow.appendChild(addBtn)
    this.host.appendChild(addRow)

    // --- per-axis min/max ---------------------------------------------------
    yAxis.forEach((ax, ai) => {
      const label = twoAxes ? (ai === 0 ? t('Left axis') : t('Right axis')) : horizontal ? t('Value axis') : t('Y axis')
      const wrap = document.createElement('div')
      wrap.className = 'ed-axis-range'
      const mk = (key: 'min' | 'max', ph: string) => {
        const inp = document.createElement('input')
        inp.type = 'number'; inp.placeholder = ph
        inp.value = typeof ax?.[key] === 'number' ? String(ax[key]) : ''
        const commit = (final: boolean) => this.editOption(el.id, (o) => {
          const k = valueAxisKey(o)
          const a = Array.isArray(o[k]) ? o[k][ai] : o[k]
          const raw = inp.value.trim()
          if (raw === '' || Number.isNaN(parseFloat(raw))) delete a[key]
          else a[key] = parseFloat(raw)
        }, final)
        inp.addEventListener('input', () => commit(false))
        inp.addEventListener('change', () => commit(true))
        return inp
      }
      wrap.append(mk('min', t('min')), mk('max', t('max')))
      this.row(label, wrap)
    })
  }

  /** Editable categories × series grid. Adding/removing rows keeps every
   *  series data array and the x-axis categories in lockstep. */
  private buildChartGrid(el: ChartElement, opt: Record<string, any>, series: any[]) {
    // the categories sit on yAxis when the bars are horizontal
    const cats: any[] = chartCategories(opt)
    this.section('Data')
    const scroll = document.createElement('div')
    scroll.className = 'ed-chart-grid-wrap'
    const table = document.createElement('table')
    table.className = 'ed-chart-grid'
    const thead = document.createElement('tr')
    const corner = document.createElement('th'); corner.textContent = ''
    thead.appendChild(corner)
    series.forEach((s, i) => {
      const th = document.createElement('th')
      th.textContent = s?.name || t('Series {n}', { n: i + 1 })
      thead.appendChild(th)
    })
    thead.appendChild(document.createElement('th'))
    table.appendChild(thead)

    const cellInput = (value: string, onCommit: (v: string, final: boolean) => void, numeric: boolean) => {
      const inp = document.createElement('input')
      inp.type = numeric ? 'number' : 'text'
      inp.value = value
      inp.addEventListener('input', () => onCommit(inp.value, false))
      inp.addEventListener('change', () => onCommit(inp.value, true))
      return inp
    }

    const rowCount = Math.max(cats.length, ...series.map((s) => (s?.data?.length ?? 0)))
    for (let r = 0; r < rowCount; r++) {
      const tr = document.createElement('tr')
      const cat = document.createElement('td')
      cat.appendChild(cellInput(String(cats[r] ?? ''), (v, final) => this.editOption(el.id, (o) => {
        ensureCatAxis(o).data[r] = v
      }, final), false))
      tr.appendChild(cat)
      series.forEach((s, i) => {
        const td = document.createElement('td')
        td.appendChild(cellInput(String(s?.data?.[r] ?? ''), (v, final) => this.editOption(el.id, (o) => {
          const arr = o.series[i].data ?? (o.series[i].data = [])
          const n = parseFloat(v)
          arr[r] = Number.isNaN(n) ? 0 : n
        }, final), true))
        tr.appendChild(td)
      })
      const rmTd = document.createElement('td')
      rmTd.appendChild(this.opBtn('✕', t('Remove row'), () => this.editOption(el.id, (o) => {
        const ca = o[catAxisKey(o)]
        if (Array.isArray(ca?.data)) ca.data.splice(r, 1)
        o.series.forEach((s: any) => { if (Array.isArray(s?.data)) s.data.splice(r, 1) })
      })))
      tr.appendChild(rmTd)
      table.appendChild(tr)
    }
    scroll.appendChild(table)
    this.host.appendChild(scroll)

    const addRow = document.createElement('div')
    addRow.className = 'ed-chart-add'
    const addBtn = document.createElement('button')
    addBtn.className = 'ed-btn'
    addBtn.textContent = t('＋ Add row')
    addBtn.title = t('Add row')
    addBtn.addEventListener('click', () => this.editOption(el.id, (o) => {
      const ca = ensureCatAxis(o)
      ca.data.push(t('Item {n}', { n: ca.data.length + 1 }))
      const ss: any[] = Array.isArray(o.series) ? o.series : [o.series]
      ss.forEach((s) => { if (s) (s.data ?? (s.data = [])).push(0) })
    }))
    addRow.appendChild(addBtn)
    this.host.appendChild(addRow)
  }

  /** Pie: one row per slice (name · value · colour · remove) + add. */
  private buildChartPie(el: ChartElement, series: any[]) {
    const s = series.find((x) => x?.type === 'pie') ?? series[0]
    const data: any[] = s?.data ?? []
    const palette: string[] | undefined = Array.isArray((el.option as any).color) ? (el.option as any).color : undefined
    this.section('Slices')
    data.forEach((d, i) => {
      const row = document.createElement('div')
      row.className = 'ed-series-row'
      const name = document.createElement('input')
      name.type = 'text'; name.className = 'ed-series-name'; name.value = d?.name ?? ''
      name.addEventListener('input', () => this.editPieDatum(el.id, i, (x) => { x.name = name.value }, false))
      name.addEventListener('change', () => this.editPieDatum(el.id, i, (x) => { x.name = name.value }, true))
      const val = document.createElement('input')
      val.type = 'number'; val.className = 'ed-pie-val'; val.value = String(d?.value ?? 0)
      const commitVal = (final: boolean) => this.editPieDatum(el.id, i, (x) => { const n = parseFloat(val.value); x.value = Number.isNaN(n) ? 0 : n }, final)
      val.addEventListener('input', () => commitVal(false))
      val.addEventListener('change', () => commitVal(true))
      const swatch = this.color((palette && palette[i]) || PropsPanel.seriesColor({ type: 'pie' }, palette, i), (v, final) =>
        this.editOption(el.id, (o) => { if (!Array.isArray(o.color)) o.color = []; o.color[i] = v }, final))
      const rm = this.opBtn('✕', t('Remove'), () => this.editPieDatum(el.id, i, null, true))
      rm.classList.add('ed-series-rm')
      row.append(name, val, swatch, rm)
      this.host.appendChild(row)
    })
    const addRow = document.createElement('div')
    addRow.className = 'ed-chart-add'
    const addBtn = document.createElement('button')
    addBtn.className = 'ed-btn'
    addBtn.textContent = t('＋ Add slice')
    addBtn.title = t('Add slice')
    addBtn.addEventListener('click', () => this.editOption(el.id, (o) => {
      const ps = (Array.isArray(o.series) ? o.series : [o.series]).find((x: any) => x?.type === 'pie') ?? o.series[0]
      ps.data = ps.data ?? []
      ps.data.push({ name: t('Item {n}', { n: ps.data.length + 1 }), value: 0 })
    }))
    addRow.appendChild(addBtn)
    this.host.appendChild(addRow)
  }

  private editPieDatum(id: string, i: number, fn: ((d: any) => void) | null, final: boolean) {
    this.editOption(id, (o) => {
      const ps = (Array.isArray(o.series) ? o.series : [o.series]).find((x: any) => x?.type === 'pie') ?? o.series[0]
      if (!ps?.data) return
      if (fn === null) ps.data.splice(i, 1)
      else fn(ps.data[i])
    }, final)
  }

  private buildTableProps(el: TableElement) {
    const stepper = (label: string, count: number, onDelta: (d: number) => void) => {
      const wrap = document.createElement('div')
      wrap.className = 'ed-stepper'
      const minus = this.opBtn('−', t('Remove'), () => onDelta(-1))
      const val = document.createElement('span')
      val.className = 'ed-stepper-val'
      val.textContent = String(count)
      const plus = this.opBtn('+', t('Add'), () => onDelta(1))
      wrap.append(minus, val, plus)
      this.row(label, wrap)
    }
    const cols = el.columns.length
    const rows = el.rows.length
    // at the end of the table; tablespans.ts keeps merged cells in step
    // (one that reaches the removed row/column shrinks)
    stepper(t('Columns'), cols, (d) => this.mutate(el.id, (e) => {
      const tb = e as TableElement
      if (d > 0) insertColumn(tb, tb.columns.length)
      else deleteColumns(tb, tb.columns.length - 1, tb.columns.length - 1)
    }, true))
    stepper(t('Rows'), rows, (d) => this.mutate(el.id, (e) => {
      const tb = e as TableElement
      const minRows = tb.header ? 2 : 1
      if (d > 0) insertRow(tb, tb.rows.length)
      else if (tb.rows.length > minRows) deleteRows(tb, tb.rows.length - 1, tb.rows.length - 1)
    }, true))

    this.row('Header row', this.toggle(el.header, (v) => this.mutate(el.id, (e) => {
      (e as TableElement).header = v
    }, true)))

    // one-tap looks that all work within the fixed-grid renderer
    const st = el.style
    const preset = st.borderWidth && st.zebra ? 'Boxed'
      : st.borderWidth ? 'Lined'
      : st.zebra ? 'Zebra'
      : 'Minimal'
    const themed = tableStyleFor(this.store.doc.theme)
    this.row('Preset', this.select(['Lined', 'Zebra', 'Boxed', 'Minimal'], preset, (v) =>
      this.mutate(el.id, (e) => {
        const s = (e as TableElement).style
        s.borderWidth = v === 'Lined' || v === 'Boxed' ? Math.max(themed.borderWidth, 1) : 0
        s.zebra = v === 'Zebra' || v === 'Boxed' ? themed.zebra ?? 'rgba(29,17,25,0.05)' : undefined
        if (v === 'Minimal') { s.headerBg = 'transparent'; s.headerColor = s.color }
        else if (s.headerBg === 'transparent') {
          s.headerBg = themed.headerBg
          s.headerColor = themed.headerColor
        }
      }, true)))

    this.buildTableCells(el)

    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('Double-click a cell to edit. Tab moves across, Enter down.')
    this.host.appendChild(hint)

    const toChart = document.createElement('button')
    toChart.className = 'ed-btn ed-btn-block'
    toChart.textContent = t('Make a chart from this table →')
    toChart.title = t('Create a bar chart from the numbers in this table (first column = labels)')
    toChart.addEventListener('click', () => this.tableToChart(el))
    this.host.appendChild(toChart)

    // --- more: the fine-grained look ------------------------------------------
    this.section('Style')
    this.row('Header fill', this.colorAlpha(st.headerBg, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TableElement).style.headerBg = v }, fin)))
    this.row('Header text', this.colorAlpha(st.headerColor, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TableElement).style.headerColor = v }, fin)))
    this.row('Text', this.colorAlpha(st.color, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TableElement).style.color = v }, fin)))
    this.row('Grid lines', this.colorAlpha(st.borderColor, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TableElement).style.borderColor = v }, fin)))

    const grid = document.createElement('div')
    grid.className = 'ed-grid2'
    grid.append(
      this.mini(t('Font'), st.fontSize, (v) => this.mutate(el.id, (e) =>
        { (e as TableElement).style.fontSize = Math.max(v, 6) }, true)),
      this.mini(t('Radius'), st.radius, (v) => this.mutate(el.id, (e) =>
        { (e as TableElement).style.radius = Math.max(v, 0) }, true)),
      this.mini(t('Pad X'), st.cellPadX, (v) => this.mutate(el.id, (e) =>
        { (e as TableElement).style.cellPadX = Math.max(v, 0) }, true)),
      this.mini(t('Pad Y'), st.cellPadY, (v) => this.mutate(el.id, (e) =>
        { (e as TableElement).style.cellPadY = Math.max(v, 0) }, true)),
    )
    this.host.appendChild(grid)
  }

  /** The Cells block: merge/split and rows/columns at the selected cells. */
  private buildTableCells(el: TableElement) {
    const cells = this.tableCells
    const live = cells?.state()?.id === el.id
    const cap = document.createElement('div')
    cap.className = 'ed-arrange-cap'
    cap.textContent = t('Cells')
    this.host.appendChild(cap)
    const grid = document.createElement('div')
    grid.className = 'ed-grid2 ed-table-cells'
    for (const [op, label] of TABLE_OPS) {
      const b = document.createElement('button')
      b.className = 'ed-btn'
      b.textContent = t(label)
      b.dataset.tableOp = op
      b.disabled = !live || !cells!.can(op)
      // mousedown would blur a cell being edited before the click lands;
      // run() commits that edit itself, so keep focus where it is
      b.addEventListener('mousedown', (ev) => ev.preventDefault())
      b.addEventListener('click', () => { cells?.run(op) })
      grid.appendChild(b)
    }
    this.host.appendChild(grid)
    if (!live) {
      const hint = document.createElement('p')
      hint.className = 'ed-hint'
      hint.textContent = t('Click a cell of the table to work on it. Shift+click, Shift+arrows or a drag across cells select several.')
      this.host.appendChild(hint)
    }
  }

  /** Bridge: build a bar chart from a table's numeric columns and insert it. */
  private tableToChart(el: TableElement) {
    const bodyRows = el.header ? el.rows.slice(1) : el.rows
    // strip markup + entities + thousands separators so "1,204" / "+222%" parse
    const strip = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').replace(/,/g, '').trim()
    const num = (html: string) => parseFloat(strip(html))
    const labels = bodyRows.map((r) => strip(r.cells[0]?.html ?? ''))
    const headerRow = el.header ? el.rows[0] : null
    // every column after the labels that is mostly numeric becomes its own series
    const cols: Array<{ name: string; data: number[]; isPct: boolean; maxAbs: number }> = []
    for (let c = 1; c < el.columns.length; c++) {
      const raw = bodyRows.map((r) => r.cells[c]?.html ?? '')
      const parsed = raw.map(num)
      const good = parsed.filter((n) => !Number.isNaN(n))
      if (good.length < Math.ceil(bodyRows.length / 2)) continue
      const isPct = /%/.test(headerRow ? strip(headerRow.cells[c]?.html ?? '') : '') ||
        raw.filter((h) => /%/.test(h)).length >= Math.ceil(bodyRows.length / 2)
      cols.push({
        name: headerRow ? strip(headerRow.cells[c]?.html ?? '') : '',
        data: parsed.map((n) => (Number.isNaN(n) ? 0 : n)),
        isPct,
        maxAbs: Math.max(1, ...good.map((n) => Math.abs(n))),
      })
    }
    if (!cols.length) { this.toast(t('No numeric column found to chart')); return }

    // two columns on very different scales (or one is a %) → dual axis: bars
    // on the left, the odd one as a line on a right-hand axis
    let secondary = -1
    if (cols.length === 2) {
      const pct = cols.filter((c) => c.isPct)
      if (pct.length === 1) secondary = cols.indexOf(pct[0])
      else {
        const big = cols[0].maxAbs >= cols[1].maxAbs ? 0 : 1
        if (cols[big].maxAbs / cols[1 - big].maxAbs >= 12) secondary = 1 - big
      }
    }

    const option: Record<string, unknown> = {
      xAxis: { type: 'category', data: labels },
      tooltip: { trigger: 'axis' },
    }
    if (secondary >= 0) {
      const prim = cols[1 - secondary], sec = cols[secondary]
      option.yAxis = [
        { type: 'value', name: prim.name || undefined },
        { type: 'value', name: sec.name || undefined, axisLabel: sec.isPct ? { formatter: '{value}%' } : undefined },
      ]
      option.series = [
        { type: 'bar', name: prim.name, data: prim.data, yAxisIndex: 0 },
        { type: 'line', name: sec.name, data: sec.data, yAxisIndex: 1, smooth: true },
      ]
      option.legend = { bottom: 0 }
    } else {
      option.yAxis = { type: 'value' }
      option.series = cols.map((c) => ({ type: 'bar', name: c.name, data: c.data }))
      if (cols.length > 1) option.legend = { bottom: 0 }
    }
    applyChartPalette(option, this.store.doc.theme)
    const chart = defaultChart(option, {
      x: el.x, y: Math.min(el.y + el.h + 24, 480), w: Math.max(el.w, 640), h: 300, preset: 'bar',
      // live binding: edits to the table flow into this chart
      source: { tableId: el.id },
    })
    this.store.commit(() => this.store.slide.elements.push(chart))
    this.store.select([chart.id])
    this.toast(t('Chart created — it updates live with the table'))
  }

  private buildImageProps(el: ImageElement) {
    const replace = document.createElement('button')
    replace.className = 'ed-btn ed-btn-block'
    replace.textContent = t('Replace image…')
    replace.title = t('Pick a new picture — position, size and effects stay')
    replace.addEventListener('click', () => {
      void readImageFile().then((picked) => { if (picked) this.edits.replaceImageSrc(el.id, picked.src) })
    })
    this.host.appendChild(replace)
    // crop mode lives on the canvas (editor/cropmode.ts); double-click works too
    const crop = document.createElement('button')
    crop.className = 'ed-btn ed-btn-block'
    crop.textContent = t('Crop')
    crop.title = t('Cut the picture down by dragging its edges on the canvas (or double-click it)')
    crop.addEventListener('click', () =>
      document.dispatchEvent(new CustomEvent('slidomingo:crop-image', { detail: { id: el.id } })))
    this.host.appendChild(crop)
    if (el.crop) {
      const reset = document.createElement('button')
      reset.className = 'ed-btn ed-btn-block'
      reset.textContent = t('Reset crop')
      reset.title = t('Show the whole picture again')
      reset.addEventListener('click', () => this.edits.resetImageCrop(el.id, ...canvasNaturalSize(el.id)))
      this.host.appendChild(reset)
    } else {
      // a cropped picture always fills its frame, so Fit has nothing to say
      this.row('Fit', this.select(['contain', 'cover', 'fill'], el.fit, (v) =>
        this.edits.setImageFit(el.id, v as ImageElement['fit'])))
    }
    this.row('Corner radius', this.number(el.radius, 1, (v, fin) =>
      this.mutate(el.id, (e) => { (e as ImageElement).radius = Math.max(v, 0) }, fin)))
  }

  /**
   * The text alternative (model.ts `Describable`): what a screen reader says
   * instead of the picture, chart or clip. Open by default — unlike the other
   * "more" sections it is not a tweak, it is the one thing the picture cannot
   * say for itself, and Check slides points people here. "Decorative" stores
   * `alt: ''` (HTML's own convention); clearing the field drops the key, back
   * to "not described yet". Each change is one undo step.
   */
  private buildAltProps(el: ImageElement | SvgElement | ChartElement | MediaElement) {
    this.section('Alt text')
    const decorative = el.alt === ''
    const ta = document.createElement('textarea')
    ta.className = 'ed-alt-text'
    ta.rows = 3
    ta.maxLength = LIMITS.alt
    ta.value = el.alt ?? ''
    ta.disabled = decorative
    ta.placeholder = decorative
      ? t('Decorative — screen readers skip it')
      : t('Describe what this shows for someone who can’t see it')
    ta.setAttribute('aria-label', t('Alt text'))
    ta.addEventListener('change', () => this.mutate(el.id, (e) => {
      const v = ta.value.trim()
      const d = e as ImageElement
      if (v) d.alt = v
      else delete d.alt
    }, true))
    this.host.appendChild(ta)
    this.row('Decorative', this.toggle(decorative, (on) => this.mutate(el.id, (e) => {
      const d = e as ImageElement
      if (on) d.alt = ''
      else delete d.alt
    }, true)))
    // A slide's copy of a slide-type element is rebuilt from the type on the
    // next resync (applyLayout keeps only text and link), so alt typed here
    // would quietly vanish — say where it has to go instead.
    const owner = this.store.editingSurface ? undefined : resyncOwner(this.store.doc, this.store.slide, el)
    if (owner) {
      const hint = document.createElement('p')
      hint.className = 'ed-hint ed-alt-resync'
      hint.textContent = t('This comes from the slide type “{name}”: alt text typed here is reset when the slide type next re-applies. Set it on the slide type in the Layout Manager.', { name: owner.name ?? t('Untitled') })
      this.host.appendChild(hint)
    }
  }

  /** Where a picture or diagram came from and what it may be used under
   *  (model.ts Provenance). The icon library fills it in on insert; anything
   *  else is declared here. Blank fields are removed, and an emptied record
   *  is dropped from the file entirely. */
  private buildProvenanceProps(el: ImageElement | SvgElement) {
    const p = el.provenance
    this.section('Source & license', { modified: !!p && Object.keys(p).length > 0 })
    const field = (key: 'origin' | 'url' | 'author' | 'license', label: string, placeholder: string) => {
      const input = document.createElement('input')
      input.type = 'text'
      input.maxLength = key === 'url' ? LIMITS.provUrl : LIMITS.provField
      input.value = p?.[key] ?? ''
      input.placeholder = t(placeholder)
      input.spellcheck = false
      input.addEventListener('change', () => this.mutate(el.id, (e) => {
        const d = e as ImageElement
        const v = input.value.trim()
        const next = { ...(d.provenance ?? {}) }
        if (v) next[key] = v
        else delete next[key]
        if (Object.keys(next).length) d.provenance = next
        else delete d.provenance
      }, true))
      this.row(label, input)
    }
    field('origin', 'Found in', 'Where it came from')
    field('url', 'Address', 'Link to the file')
    field('author', 'Author', 'Who made it')
    field('license', 'License', 'e.g. CC0-1.0, Company-owned')
    if (p && !p.license?.trim()) {
      const hint = document.createElement('p')
      hint.className = 'ed-hint'
      hint.textContent = t('No license recorded — if you’re not sure it may be used here, replace it.')
      this.host.appendChild(hint)
    }
  }

  /** Zoom tile (model.ts ZoomElement): what it zooms into, how much it plays,
   *  whether it comes back; the camera speed and the frame in "Zoom tile". */
  private buildZoomProps(el: ZoomElement) {
    const doc = this.store.doc
    const target = el.target
    const what = document.createElement('p')
    what.className = 'ed-hint ed-zoom-target'
    what.textContent = zoomTargetLabel(doc, target)
    this.host.appendChild(what)
    const btns = document.createElement('div')
    btns.className = 'ed-grid2'
    const change = document.createElement('button')
    change.className = 'ed-btn ed-btn-block'
    change.textContent = t('Change…')
    change.title = t('Pick another slide or section for this tile')
    change.addEventListener('click', () => openZoomPicker(this.store, {
      multi: false,
      title: t('Change zoom target'),
      overviewId: this.store.slide.id,
      current: target,
      onPick: ([next]) => {
        if (next) this.mutate(el.id, (e) => {
          const z = e as ZoomElement
          z.target = next
          if ('section' in next) delete z.range
        }, true)
      },
    }))
    const go = document.createElement('button')
    go.className = 'ed-btn ed-btn-block'
    go.textContent = t('Go to target')
    go.title = t('Show the slide this tile zooms into')
    const cover = zoomCover(doc, el, this.store.slide.id)
    go.disabled = !cover
    go.addEventListener('click', () => {
      const i = cover ? this.store.doc.slides.indexOf(cover) : -1
      if (i >= 0) this.store.goTo(i)
    })
    btns.append(change, go)
    this.host.appendChild(btns)
    if (target && 'slide' in target) {
      const PLAYS = ['This slide only', 'To the end of its section']
      this.row('Plays', this.select(PLAYS, el.range === 'section' ? PLAYS[1] : PLAYS[0], (v) =>
        this.mutate(el.id, (e) => {
          const z = e as ZoomElement
          if (v === PLAYS[1]) z.range = 'section'
          else delete z.range
        }, true)))
    }
    this.row('Return to zoom', this.select(['on', 'off'], el.returnToZoom === false ? 'off' : 'on', (v) =>
      this.mutate(el.id, (e) => {
        const z = e as ZoomElement
        if (v === 'off') z.returnToZoom = false
        else delete z.returnToZoom
      }, true)))

    // --- more -------------------------------------------------------------------
    this.section('Zoom tile')
    this.row('Duration (s)', this.number(el.duration ?? ZOOM_SECONDS, 0.1, (v, fin) =>
      this.mutate(el.id, (e) => { (e as ZoomElement).duration = Math.min(60, Math.max(0.1, v)) }, fin)))
    this.row('Frame color', this.color(el.stroke ?? '#FFFFFF', (v, fin) =>
      this.mutate(el.id, (e) => { (e as ZoomElement).stroke = v }, fin)))
    this.row('Frame width', this.number(el.strokeWidth ?? 0, 1, (v, fin) =>
      this.mutate(el.id, (e) => { (e as ZoomElement).strokeWidth = Math.min(200, Math.max(0, v)) }, fin)))
    this.row('Corner radius', this.number(el.radius ?? 0, 1, (v, fin) =>
      this.mutate(el.id, (e) => { (e as ZoomElement).radius = Math.max(0, v) }, fin)))
  }

  private buildMediaProps(el: MediaElement) {
    // source status: embedded (with size) / linked / none
    const status = document.createElement('p')
    status.className = 'ed-hint'
    // Resolve first: an embed is stored as an `asset:` ref, so testing el.src
    // directly would report an embedded clip as "linked".
    const resolved = el.src ? resolveAsset(this.store.doc, el.src) : ''
    if (!el.src) status.textContent = t('No source yet — choose a file or paste a URL.')
    else if (resolved.startsWith('data:')) {
      const kb = Math.round((resolved.length * 3) / 4 / 1024)
      status.innerHTML = t('Embedded in the file') + ` · <b>${kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'}</b>`
    } else status.textContent = t('Linked — the deck stays small but needs this URL to play.')
    this.host.appendChild(status)

    // replace / choose file (embeds; warns over budget)
    const replace = document.createElement('button')
    replace.className = 'ed-btn ed-btn-block'
    replace.textContent = el.src ? t('Replace file…') : t('Choose file…')
    replace.addEventListener('click', () => {
      void pickMediaFile(el.kind).then((src) => { if (src) this.edits.replaceMediaSrc(el.id, src) })
    })
    this.host.appendChild(replace)

    // playback
    // Labels stay RAW English — row() translates them, and looks its tooltip up
    // by the English label. Passing t(…) here would translate twice and miss
    // ROW_TIPS in every locale but English.
    const toggle = (label: string, on: boolean, set: (v: boolean) => void) =>
      this.row(label, this.select(['off', 'on'], on ? 'on' : 'off', (v) => set(v === 'on')))
    toggle('Autoplay', !!el.autoplay, (v) => this.edits.setMediaAutoplay(el.id, v))
    toggle('Loop', !!el.loop, (v) => this.mutate(el.id, (e) => { (e as MediaElement).loop = v || undefined }, true))

    // --- more -------------------------------------------------------------------
    this.section('Source & playback')
    // URL (reference) — clears an embed when set
    const url = document.createElement('input')
    url.type = 'text'
    url.placeholder = t('…or paste a media URL')
    url.value = el.src && !el.src.startsWith('data:') && !el.src.startsWith('asset:') ? el.src : ''
    url.addEventListener('change', () =>
      this.mutate(el.id, (e) => { (e as MediaElement).src = url.value.trim() }, true))
    this.row('URL', url)

    toggle('Controls', el.controls !== false, (v) => this.mutate(el.id, (e) => { (e as MediaElement).controls = v ? undefined : false }, true))
    toggle('Muted', !!el.muted, (v) => this.mutate(el.id, (e) => { (e as MediaElement).muted = v || undefined }, true))
    const note = document.createElement('p')
    note.className = 'ed-hint'
    note.textContent = t('Autoplay runs only while presenting; browsers require “muted” for video to autoplay.')
    this.host.appendChild(note)

    if (el.kind === 'video') {
      this.row('Fit', this.select(['contain', 'cover', 'fill'], el.fit ?? 'contain', (v) =>
        this.mutate(el.id, (e) => { (e as MediaElement).fit = v as MediaElement['fit'] }, true)))
      this.row('Corner radius', this.number(el.radius ?? 0, 1, (v, fin) =>
        this.mutate(el.id, (e) => { (e as MediaElement).radius = Math.max(v, 0) }, fin)))
      const poster = document.createElement('input')
      poster.type = 'text'
      poster.placeholder = t('Poster image URL (optional)')
      poster.value = el.poster && !el.poster.startsWith('data:') ? el.poster : ''
      poster.addEventListener('change', () =>
        this.mutate(el.id, (e) => {
          const m = e as MediaElement
          const v = poster.value.trim()
          if (v) m.poster = v; else delete m.poster
        }, true))
      this.row('Poster', poster)
    }
  }

  private buildCodeProps(el: CodeElement) {
    // Language — selects the built-in tokenizer table. grammarName doubles as
    // the language id; grammarAssetId/themeAssetId stay in the format as the
    // seam for a future signed-extension tier carrying real TextMate grammars
    // as deck assets, at which point pickers for them return here.
    const langs = Object.keys(LANGS).sort().concat(['diff', 'md'])
    this.row('Language', this.select(langs, el.grammarName ?? 'js', (v) =>
      this.mutate(el.id, (e) => { (e as CodeElement).grammarName = v }, true)))
    // Shown in POINTS (the unit office users know); the model stores slide-space
    // px. 1pt = 4/3 px at the slide's 96dpi space, so 32px = 24pt exactly.
    this.row('Size (pt)', this.number(ElementEdits.fontSizePt(el), 1, (v, fin) =>
      this.edits.setFontSizePt(el.id, v, fin)))

    // --- more -------------------------------------------------------------------
    this.section('Source Code')
    // Alignment
    this.row('Align', this.select(['left', 'center', 'right'], el.align, (v) =>
      this.mutate(el.id, (e) => { (e as CodeElement).align = v as CodeElement['align'] }, true)))
    // V-Alignment
    this.row('V-align', this.select(['top', 'middle', 'bottom'], el.valign, (v) =>
      this.mutate(el.id, (e) => { (e as CodeElement).valign = v as CodeElement['valign'] }, true)))
    // Line height
    this.row('Line height', this.number(el.lineHeight, 0.05, (v, fin) =>
      this.mutate(el.id, (e) => { (e as CodeElement).lineHeight = Math.max(v, 0.5) }, fin)))
    const status = document.createElement('p')
    status.className = 'ed-hint'
    status.textContent = t('{n} languages built in', { n: String(langs.length) })
    this.host.appendChild(status)
  }

  private buildEmbedProps(el: EmbedElement) {
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('Runs sandboxed — scripts and canvas work, but the embed can’t read this page’s data, navigate it, or open popups.')
    this.host.appendChild(hint)
    const ta = document.createElement('textarea')
    ta.className = 'ed-chart-json' // same monospace/rows-friendly styling as the JSON escape hatches
    ta.rows = 14
    ta.spellcheck = false
    ta.value = el.html
    ta.addEventListener('change', () => this.mutate(el.id, (e) => { (e as EmbedElement).html = ta.value }, true))
    this.host.appendChild(ta)
  }

  private buildMathProps(el: MathElement) {
    // --- basics ---------------------------------------------------------------
    // The TeX itself, editable in place. Committed on blur / ⌘↵ as ONE step
    // that also fits the box; the popover (Edit…) is the roomier way in.
    const ta = document.createElement('textarea')
    ta.className = 'ed-math-tex ed-math-tex-panel'
    ta.rows = 3
    ta.spellcheck = false
    ta.value = el.tex
    ta.setAttribute('aria-label', t('TeX source'))
    const err = document.createElement('p')
    err.className = 'ed-math-err'
    err.setAttribute('role', 'status')
    const status = () => {
      const msg = texError(ta.value)
      err.textContent = msg ? t('TeX error: {msg}', { msg }) : ''
      err.hidden = !msg
    }
    let dirty = false
    const commit = () => {
      if (!dirty) return
      dirty = false
      const tex = ta.value
      this.mutate(el.id, (e) => {
        if (e.type !== 'math') return
        e.tex = tex
        Object.assign(e, fitMathFrame(e, this.store.doc))
      }, true)
    }
    ta.addEventListener('input', () => { dirty = true; status() })
    ta.addEventListener('blur', commit)
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Tab' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && tabToSlot(ta, ev.shiftKey)) { ev.preventDefault(); return }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); commit() }
    })
    this.host.appendChild(ta)
    status()
    this.host.appendChild(err)

    const tools = document.createElement('div')
    tools.className = 'ed-math-tools'
    const pal = document.createElement('div')
    pal.className = 'ed-math-panel-palette'
    pal.hidden = true
    const palBtn = document.createElement('button')
    palBtn.type = 'button'
    palBtn.className = 'ed-btn'
    palBtn.textContent = t('∑ Palette')
    palBtn.title = t('Structures, symbols and common formulas — inserted at the caret')
    palBtn.setAttribute('aria-expanded', 'false')
    // mousedown: keep the caret where it is in the TeX field
    palBtn.addEventListener('mousedown', (ev) => ev.preventDefault())
    palBtn.addEventListener('click', () => {
      if (!pal.firstChild) pal.appendChild(buildMathPalette((s) => insertIntoTextarea(ta, s, () => { dirty = true; status() })))
      pal.hidden = !pal.hidden
      palBtn.setAttribute('aria-expanded', String(!pal.hidden))
    })
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'ed-btn'
    edit.textContent = t('Edit…')
    edit.title = t('Open the equation editor with a live preview (or double-click the equation)')
    edit.addEventListener('click', () => {
      commit()
      document.dispatchEvent(new CustomEvent('slidomingo:edit-math', { detail: { id: el.id } }))
    })
    tools.append(palBtn, edit)
    this.host.append(tools, pal)

    this.row('Size (pt)', this.number(ElementEdits.fontSizePt(el), 1, (v, fin) =>
      this.edits.setFontSizePt(el.id, v, fin)))
    this.row('Color', this.color(el.color, (v, fin) => this.edits.setFill(el.id, v, fin), { id: el.id, path: 'color' }))
    this.row('Align', this.segButtons([
      ['left', t('left'), ICONS.textLeft],
      ['center', t('center'), ICONS.textCenter],
      ['right', t('right'), ICONS.textRight],
    ], el.align, (v) => this.edits.setTextAlign(el.id, v as MathElement['align'])))

    // --- more -----------------------------------------------------------------
    this.section('Typesetting', { modified: !!el.inline || el.valign !== 'middle' })
    this.row('Style', this.labeledSelect([['display', t('Display')], ['inline', t('Inline')]], el.inline ? 'inline' : 'display', (v) =>
      this.mutate(el.id, (e) => {
        if (e.type !== 'math') return
        if (v === 'inline') e.inline = true
        else delete e.inline
        Object.assign(e, fitMathFrame(e, this.store.doc))
      }, true)))
    this.row('V-align', this.select(['top', 'middle', 'bottom'], el.valign, (v) =>
      this.mutate(el.id, (e) => { (e as MathElement).valign = v as MathElement['valign'] }, true)))
    const fit = document.createElement('button')
    fit.className = 'ed-btn ed-btn-block'
    fit.textContent = t('Fit box to equation')
    fit.title = t('Height to the formula; the width only grows')
    fit.addEventListener('click', () => this.mutate(el.id, (e) => {
      if (e.type === 'math') Object.assign(e, fitMathFrame(e, this.store.doc))
    }, true))
    this.host.appendChild(fit)
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('LaTeX, typeset by Temml. Inline math also works in any text box or table cell: type $…$.')
    this.host.appendChild(hint)
  }

  /** Typography's "Insert equation…": the palette over a live text edit
   *  (typed at the caret as $…$), or — the box merely selected — a new
   *  formula appended to its text. */
  private buildInsertMathControl(el: TextElement): HTMLElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn ed-btn-block'
    b.textContent = t('Insert equation…')
    b.title = t('Pick a structure or symbol — it is typed into the text as $…$ math')
    // never take focus: a live text edit must survive the click
    b.addEventListener('mousedown', (ev) => ev.preventDefault())
    b.addEventListener('click', () => openProsePalette(b, (s) =>
      this.mutate(el.id, (e) => { if (e.type === 'text') e.html = `${e.html}$${s.preview ?? s.tex}$` }, true)))
    return b
  }

  // --- element ops --------------------------------------------------------------

  private opsRow(els: SlideElement[]) {
    const row = document.createElement('div')
    row.className = 'ed-ops'
    row.append(
      this.opBtn(ICONS.copy, t('Duplicate'), () => this.duplicate(els)),
      this.opBtn(ICONS.trash, t('Delete'), () => this.deleteEls(els)),
    )
    // Lock / hide toggles: a locked element ignores canvas clicks and drags, a
    // hidden one leaves every output. Both stay reachable via right-click ▸ Select.
    const locked = els.every((e) => e.locked)
    const hidden = els.every((e) => e.hidden)
    const toggle = (glyph: string, title: string, on: boolean, fn: () => void) => {
      const b = this.opBtn('', title, fn)
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
    this.host.appendChild(row)
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
      this.host.appendChild(row)
    }
    // "Align to" is the visible version of PowerPoint's buried Align to
    // Slide / Align Selected Objects mode. One object (a group counts as
    // one) always aligns to the slide, so the switch only appears for more.
    // Alt-click an Align button = the slide, for that click only.
    const units = alignUnits(els)
    const ref = effectiveRef(units, this.alignRef)
    if (units.length > 1) {
      this.row('Align to', this.segButtons(
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
      this.host.appendChild(center)
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
      this.host.appendChild(g)
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
    this.host.appendChild(fold)
    const outer = this.host
    this.host = fold
    try {
      // Distribute mode + custom gap — only relevant once distribute() itself
      // is usable (canDist above). Changing the mode doesn't touch the document
      // (it's a tool setting, not a doc property), so it force-rebuilds the
      // panel directly rather than waiting on a 'doc' event that will never fire.
      if (canDist) {
        this.row('Distribute mode', this.segButtons(
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
        this.row('Gap (px)', gapInput)
      }
      // matchSize() reference — which value the Match width/height buttons
      // above use. 'first' is the default and matches the original behavior.
      if (els.length >= 2) {
        this.row('Size to', this.labeledSelect(
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
        this.host.appendChild(tidy)
        if (this.claudeAvailable && window.slidomingoDesktop?.sendAgentPrompt) {
          const polish = document.createElement('button')
          polish.className = 'ed-btn ed-btn-block'
          polish.textContent = t('✦ Polish with Claude')
          polish.title = t('Ask the Claude Code session to review this slide and polish its layout')
          polish.addEventListener('click', () => {
            window.slidomingoDesktop?.sendAgentPrompt?.('polish')
            this.toast(t('Asked Claude Code to polish this slide'))
          })
          this.host.appendChild(polish)
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
        this.host.appendChild(b)
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
        this.host.appendChild(b)
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
          this.host.appendChild(b)
        }
      }
      const removable = els.filter((e) => e.parentId)
      if (removable.length) {
        const b = document.createElement('button')
        b.className = 'ed-btn ed-btn-block'
        b.textContent = t('▭ Remove from container')
        b.title = t('Detach from its container without dissolving it')
        b.addEventListener('click', () => this.removeFromContainer(removable))
        this.host.appendChild(b)
      }
    } finally {
      this.host = outer
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
      this.toast(issues.length
        ? t('Tidy: nothing it can fix; still overlapping: {ids}', { ids: [...new Set(issues.flatMap((i) => i.elements ?? [i.element ?? '']))].join(', ') })
        : t('Tidy: nothing to fix around the selection'))
      return
    }
    let result = probe
    this.edit(() => { result = guardLayout(doc, this.store.slide, before!, opts) }, true)
    this.tidyMark = JSON.stringify(this.store.slide)
    const issues = left(result.issues)
    const n = new Set(result.adjusted.map((a) => a.element)).size
    this.toast(issues.length
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
      const copy: Slide = JSON.parse(JSON.stringify(this.store.slide))
      doc.layouts = [...(doc.layouts ?? []), { ...copy, id: uid('layout'), name, stateOf: undefined, notes: '' }]
    }, true)
  }

  duplicate(els: SlideElement[]) {
    // uid(), not `<id>-copy<0..999>`: repeated duplication of one element
    // drew from 1000 names and minted duplicate ids on the slide
    const idMap = new Map<string, string>()
    for (const el of els) idMap.set(el.id, uid(el.type[0]))
    const clones: SlideElement[] = els.map((el) => ({
      ...JSON.parse(JSON.stringify(el)),
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
    if (ok) this.toast(t('Reverted the last change to this element'))
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

  // --- tiny DOM helpers -----------------------------------------------------------

  private mutate(id: string, fn: (el: SlideElement) => void, final: boolean) {
    this.edits.mutate(id, fn, final)
  }

  private setNum(id: string, key: 'x' | 'y' | 'w' | 'h' | 'rotation' | 'opacity', v: number) {
    if (Number.isNaN(v)) return
    this.mutate(id, (el) => { (el as any)[key] = v }, true)
  }

  /**
   * Start a section. `key` is the ENGLISH catalog key: it identifies the
   * section for persisted open state and revealSection(), and t(key) is only
   * its label — never key state off the translated title (v1 did, and every
   * section reopened in any non-English locale). `label` overrides the
   * displayed text for dynamic titles ("3 elements"); `fixed` makes it a
   * non-collapsible header; `modified` shows the custom-settings dot.
   * i18n NOTE: keys reach t() as variables — they are catalog keys in use,
   * and literal-extraction sweeps must not prune them.
   */
  private section(key: string, opts: { fixed?: boolean; modified?: boolean; label?: string } = {}) {
    const h = document.createElement('h3')
    h.className = 'ed-section'
    h.dataset.key = key
    h.textContent = opts.label ?? t(key)
    if (opts.fixed) {
      h.dataset.fixed = '1'
      h.classList.add('ed-section-fixed')
    }
    if (opts.modified) h.dataset.modified = '1'
    this.host.appendChild(h)
  }

  /** A small caption inside a section, grouping a few rows (e.g. Morph
   *  inside Presenting). Not a section: the accordion ignores it. */
  private subhead(label: string) {
    const d = document.createElement('div')
    d.className = 'ed-subhead'
    d.textContent = label
    this.host.appendChild(d)
  }

  /** A small "which option is active" pill row for mutually-exclusive
   *  choices. Reuses .ed-btn-armed (the app's "this control is toggled on"
   *  look, from the armed comment tool) instead of inventing a new
   *  active-state colour. `icon` options render their label as the tooltip. */
  private segButtons(
    options: Array<[string, string, string?]>,
    value: string,
    onChange: (v: string) => void,
  ): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'ed-seg'
    wrap.setAttribute('role', 'group')
    for (const [v, label, icon] of options) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-btn ed-seg-btn' + (v === value ? ' ed-btn-armed' : '')
      b.setAttribute('aria-pressed', String(v === value))
      if (icon) {
        b.innerHTML = icon
        b.title = label
        b.setAttribute('aria-label', label)
      } else {
        b.textContent = label
      }
      b.addEventListener('click', () => onChange(v))
      wrap.appendChild(b)
    }
    return wrap
  }

  private row(label: string, input: HTMLElement): HTMLLabelElement {
    const row = document.createElement('label')
    row.className = 'ed-row'
    const span = document.createElement('span')
    span.textContent = t(label)
    // real help on hover (label + control): looked up by the RAW English label;
    // rows without an entry get no tooltip — never a useless label echo
    const tip = ROW_TIPS[label]
    if (tip && !input.title) row.title = t(tip)
    row.append(span, input)
    this.host.appendChild(row)
    return row
  }

  private mini(label: string, value: number, onChange: (v: number) => void): HTMLElement {
    const wrap = document.createElement('label')
    wrap.className = 'ed-mini'
    const span = document.createElement('span')
    span.textContent = label
    const input = document.createElement('input')
    input.type = 'number'
    input.value = String(Math.round(value * 10) / 10)
    input.addEventListener('change', () => onChange(parseFloat(input.value)))
    wrap.append(span, input)
    return wrap
  }

  private number(value: number, step: number, onEdit: (v: number, final: boolean) => void): HTMLElement {
    const input = document.createElement('input')
    input.type = 'number'
    input.step = String(step)
    input.value = String(value)
    input.addEventListener('change', () => {
      const v = parseFloat(input.value)
      if (!Number.isNaN(v)) onEdit(v, true)
    })
    return input
  }

  /** when given, offer the deck's brand palette above the free picker.
   *  `id: null` means the property belongs to the slide, not an element. */
  private color(
    value: string,
    onEdit: (v: string, final: boolean) => void,
    ref?: ColorRef | ColorRef[],
  ): HTMLElement {
    return buildColorControl({
      value,
      alpha: false,
      onChange: onEdit,
      // A colour chosen by hand must CLEAR any palette reference on this
      // path. Without that, the next theme edit silently overwrites a colour
      // somebody picked deliberately — which reads as the app changing their
      // work.
      onManualCommit: ref ? (v) => this.setRef(ref, v, null) : undefined,
      buildPaletteSwatches: ref ? (input) => this.paletteSwatches(ref, input) : undefined,
    })
  }

  /** Write a colour and its palette reference together, as one undoable edit. */
  private setRef(ref: ColorRef | ColorRef[], literal: string, token: string | null) {
    this.edits.setRef(ref, literal, token)
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
    return opts.alpha ? this.colorAlpha(value, onEdit, opts.ref) : this.color(value, onEdit, opts.ref)
  }

  /**
   * The deck's brand colours as clickable swatches.
   *
   * Choosing one records WHERE the colour came from, so editing the theme later
   * re-derives it — that is the whole difference between a deck that can be
   * re-branded and one that has 400 hex literals in it.
   */
  private paletteSwatches(refs: ColorRef | ColorRef[], input: HTMLInputElement): HTMLElement {
    const ref = Array.isArray(refs) ? refs[0] : refs
    const holder = (ref.id ? this.store.element(ref.id) : this.store.slide) as never
    const current = holder ? refAt(holder, ref.path) : undefined
    return buildPaletteSwatchRow(this.store.doc, current, input, (base, slot) => this.setRef(refs, base, slot))
  }

  private buildThemeProps() {
    renderThemeSwatches(this.host, this.store)
  }

  /** Color swatch + opacity %. Native color inputs have no alpha channel, so
   *  the pair round-trips rgba()/#rrggbbaa strings losslessly. */
  private colorAlpha(
    value: string,
    onEdit: (v: string, final: boolean) => void,
    ref?: ColorRef | ColorRef[],
  ): HTMLElement {
    return buildColorControl({
      value,
      alpha: true,
      onChange: onEdit,
      // picking by hand clears the palette reference — see color() for why
      onManualCommit: ref ? (v) => this.setRef(ref, v, null) : undefined,
      buildPaletteSwatches: ref ? (input) => this.paletteSwatches(ref, input) : undefined,
    })
  }

  /**
   * Visual draggable gradient-stop bar, shown ABOVE the precise per-stop
   * number+color rows (buildTextProps/buildShapeProps keep those — they're
   * the keyboard-accessible editor; this is the quick, visual one). The
   * bar's own background is a live `linear-gradient` built from the current
   * stops; one draggable handle per stop, positioned at `stop.at * 100%`.
   * Dragging computes a new `at` from the pointer's x-fraction and mutates
   * non-final while dragging, final on release — the same commit pattern the
   * numeric `at` field already uses, so undo/collab behavior matches exactly.
   */
  private gradientBar(elId: string, getStops: (el: SlideElement) => Array<{ at: number; color: string }> | undefined): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'ed-gradbar'
    const stops = getStops(this.store.element(elId) as SlideElement)
    if (!stops) return bar
    const paintTrack = () => {
      const sorted = [...stops].sort((a, b) => a.at - b.at)
      bar.style.background = sorted.length
        ? `linear-gradient(90deg, ${sorted.map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(', ')})`
        : ''
    }
    paintTrack()
    stops.forEach((stop, i) => {
      const handle = document.createElement('div')
      handle.className = 'ed-gradstop-handle'
      handle.style.left = `${stop.at * 100}%`
      handle.style.background = stop.color
      handle.title = t('Position %')
      handle.addEventListener('pointerdown', (down) => {
        down.preventDefault()
        handle.setPointerCapture(down.pointerId)
        this.gradDragging = true
        const rect = bar.getBoundingClientRect()
        const fracAt = (clientX: number) => Math.min(1, Math.max(0, rect.width ? (clientX - rect.left) / rect.width : 0))
        const move = (mv: PointerEvent) => {
          const frac = fracAt(mv.clientX)
          handle.style.left = `${frac * 100}%`
          this.mutate(elId, (e) => {
            const s = getStops(e)
            if (s?.[i]) s[i].at = Math.round(frac * 1000) / 1000
          }, false)
        }
        const up = (uv: PointerEvent) => {
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('pointerup', up)
          this.gradDragging = false
          const frac = fracAt(uv.clientX)
          this.mutate(elId, (e) => {
            const s = getStops(e)
            if (s?.[i]) s[i].at = Math.round(frac * 1000) / 1000
          }, true)
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', up)
      })
      bar.appendChild(handle)
    })
    return bar
  }

  /** Weight picker with the familiar named weights; stores the numeric value. */
  private weightSelect(el: TextElement): HTMLElement {
    const WEIGHTS: Array<[number, string]> = [
      [100, 'Thin'], [200, 'Extra light'], [300, 'Light'], [400, 'Regular'],
      [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black'],
    ]
    const sel = document.createElement('select')
    const current = el.fontWeight ?? 400
    if (!WEIGHTS.some(([n]) => n === current)) {
      const o = document.createElement('option')
      o.value = String(current)
      o.textContent = t('Custom ({n})', { n: current })
      o.selected = true
      sel.appendChild(o)
    }
    for (const [n, name] of WEIGHTS) {
      const o = document.createElement('option')
      o.value = String(n)
      o.textContent = t(name)
      o.style.fontWeight = String(n)
      if (n === current) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () =>
      this.mutate(el.id, (e) => { (e as TextElement).fontWeight = parseInt(sel.value) }, true))
    return sel
  }

  private select(options: string[], value: string, onChange: (v: string) => void): HTMLElement {
    const sel = document.createElement('select')
    for (const opt of options) {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = t(opt)
      if (opt === value) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => onChange(sel.value))
    return sel
  }

  private toggle(value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'ed-toggle'
    cb.checked = value
    cb.addEventListener('change', () => onChange(cb.checked))
    return cb
  }

  private opBtn(icon: string, title: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'ed-btn ed-btn-icon'
    btn.title = title
    btn.innerHTML = icon
    btn.addEventListener('click', onClick)
    return btn
  }
}

/**
 * Deck-wide brand colours (Background/Text/Accent 1-6). Editing one re-derives
 * every colour in the deck that points at it (editor.syncThemeRefs), which is
 * what makes a BeeSlides deck re-brandable rather than a pile of literals.
 *
 * Shared by the element panel's Theme section (nothing selected) and the
 * Layout Manager / Settings "Document properties" form — both call this with
 * the same live Store, so there is no divergence between the two surfaces.
 */
export function renderThemeSwatches(host: HTMLElement, store: Store): void {
  let burst = false
  const edit = (mutate: () => void, final: boolean) => {
    if (!burst) {
      store.checkpoint()
      burst = true
    }
    mutate()
    if (final) {
      burst = false
      store.recordAction()
    }
    store.touch()
  }
  const section = (key: string) => {
    const h = document.createElement('h3')
    h.className = 'ed-section'
    h.dataset.key = key // English key — the panel accordion persists by it
    h.textContent = t(key)
    host.appendChild(h)
  }
  const addRow = (label: string, input: HTMLElement) => {
    const row = document.createElement('label')
    row.className = 'ed-row'
    const span = document.createElement('span')
    span.textContent = t(label)
    const tip = ROW_TIPS[label]
    if (tip && !input.title) row.title = t(tip)
    row.append(span, input)
    host.appendChild(row)
  }
  const color = (value: string, onEdit: (v: string, final: boolean) => void): HTMLElement =>
    buildColorControl({ value, alpha: false, onChange: onEdit })

  section('Theme')
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = t('Deck-wide brand colours. Anything using a theme colour follows when you change it here.')
  host.appendChild(hint)
  const theme = store.doc.theme
  const slot = (label: string, get: () => string, set: (v: string) => void) =>
    addRow(label, color(get(), (v, fin) => edit(() => set(v), fin)))
  slot('Background', () => theme.background, (v) => { store.doc.theme.background = v })
  slot('Text', () => theme.color, (v) => { store.doc.theme.color = v })
  slot('Accent', () => theme.accent, (v) => { store.doc.theme.accent = v })
  for (const n of [2, 3, 4, 5, 6] as const) {
    const key = `accent${n}` as const
    slot(t('Accent {n}', { n: String(n) }), () => paletteOf(store.doc)[key], (v) => {
      const t2 = store.doc.theme
      ;(t2.palette ??= {})[key] = v
    })
  }
}

