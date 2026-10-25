// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// What the props panel's builders draw with: the panel's host, store and edit
// layer, and the small controls every section is made of (section headers,
// rows, numbers, colour chips, the gradient bar …). PropsPanel (../panels.ts)
// owns one PanelContext for its lifetime and hands it to every builder; the
// builders reach the panel itself only through `panel`, `rebuild` and the
// colour tracking wired in here.

import type { Store } from '../../store'
import type { ChartElement, SlideElement } from '../../model'
import { refAt } from '../../palette'
import { t } from '../../i18n'
import { buildColorControl, buildPaletteSwatchRow } from '../colorpicker'
import { ElementEdits, type ColorRef } from '../elementactions'
import type { PropsPanel } from '../panels'

// Hover help for panel rows, keyed by the RAW English label (translated at
// render). A missing entry means no tooltip — better silence than an echo.
// i18n NOTE: both the keys (row labels) and the values here reach t() as
// VARIABLES — literal-extraction sweeps must treat this table as in-use
// catalog keys, never prune them.
export const ROW_TIPS: Record<string, string> = {
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

/** A short message at the bottom of the window; a new one replaces it. */
export function toast(message: string, ms = 2600) {
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

/** The panel as its builders see it (one per PropsPanel, for its lifetime). */
export class PanelContext {
  /** True while a gradient-stop drag bar handle is being dragged — see
   *  gradientBar() below. Not a focused form control (a custom pointer-drag
   *  div), so isActiveEditFocus() (../panels.ts) alone can't see it; a mid-drag rebuild would
   *  destroy the handle the pointer capture is attached to. */
  gradDragging = false
  /** The "add a style" drawer is open (iconset.ts buildIconStyles). */
  lookDrawer = false
  /** The picked style's "More settings" are open (iconset.ts buildLookEditor). */
  lookMore = false

  constructor(
    /** Where the builders append: the panel, or a fold inside it for a
     *  moment (../panels.ts arrangeRows). */
    public host: HTMLElement,
    readonly store: Store,
    readonly edits: ElementEdits,
    /** The panel's own API that the builders call back into. */
    readonly panel: Pick<PropsPanel, 'revealSection' | 'tableCells' | 'setSlidesHidden' | 'promptSaveSlideAsLayout' | 'convertSvg' | 'revertChange'>,
    /** PropsPanel.rebuild: `force` rebuilds even while a field is focused. */
    readonly rebuild: (force?: boolean) => void,
    /** PropsPanel.trackColor: a chip the live-step refresh keeps current. */
    private readonly trackColor: (control: HTMLElement, value: string, ref: ColorRef | ColorRef[] | undefined) => void,
  ) {}

  /** One undoable edit (burst-aware) — forwards to the shared edit layer. */
  edit(mutate: () => void, final: boolean) {
    this.edits.edit(mutate, final)
  }

  /** Human label for a slide in pickers. */
  slideLabel(s: { id: string; name?: string; stateOf?: string }, i: number): string {
    const linear = this.store.doc.slides.slice(0, i + 1).filter((x) => !x.stateOf).length
    if (s.stateOf) {
      const p = this.store.doc.slides.findIndex((x) => x.id === s.stateOf)
      const pn = this.store.doc.slides.slice(0, p + 1).filter((x) => !x.stateOf).length
      return `state of ${pn}${s.name ? ` — ${s.name}` : ''}`
    }
    return `slide ${linear}${s.name ? ` — ${s.name}` : ''}`
  }

  /** The label/button pair shown in a basics row when the element paints a
   *  gradient instead of the solid colour: one click opens the section that
   *  edits it, rather than a colour well that would silently do nothing
   *  (the gradient wins over the solid fallback). */
  gradientJump(sectionKey: string): HTMLElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn ed-grad-jump'
    b.textContent = t('gradient')
    b.title = t('Edit the gradient')
    b.addEventListener('click', () => this.panel.revealSection(sectionKey))
    return b
  }

  /** Edit the live chart option in place; final=false while typing. */
  editOption(id: string, fn: (o: Record<string, any>) => void, final = true) {
    this.mutate(id, (e) => { fn((e as ChartElement).option as Record<string, any>) }, final)
  }

  /** Native <select> with distinct value/label pairs (for model-word values). */
  labeledSelect(pairs: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement {
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

  mutate(id: string, fn: (el: SlideElement) => void, final: boolean) {
    this.edits.mutate(id, fn, final)
  }

  setNum(id: string, key: 'x' | 'y' | 'w' | 'h' | 'rotation' | 'opacity', v: number) {
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
  section(key: string, opts: { fixed?: boolean; modified?: boolean; label?: string } = {}) {
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
  subhead(label: string) {
    const d = document.createElement('div')
    d.className = 'ed-subhead'
    d.textContent = label
    this.host.appendChild(d)
  }

  /** A small "which option is active" pill row for mutually-exclusive
   *  choices. Reuses .ed-btn-armed (the app's "this control is toggled on"
   *  look, from the armed comment tool) instead of inventing a new
   *  active-state colour. `icon` options render their label as the tooltip. */
  segButtons(
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

  row(label: string, input: HTMLElement): HTMLLabelElement {
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

  mini(label: string, value: number, onChange: (v: number) => void): HTMLElement {
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

  number(value: number, step: number, onEdit: (v: number, final: boolean) => void): HTMLElement {
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
  color(
    value: string,
    onEdit: (v: string, final: boolean) => void,
    ref?: ColorRef | ColorRef[],
  ): HTMLElement {
    const control = this.colorChip(value, onEdit, ref)
    this.trackColor(control, value, ref)
    return control
  }

  /** A panel colour control, untracked (colorControl hands these to the mini
   *  toolbar, whose chips are not this panel's to refresh). */
  colorChip(
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
  setRef(ref: ColorRef | ColorRef[], literal: string, token: string | null) {
    this.edits.setRef(ref, literal, token)
  }

  /**
   * The deck's brand colours as clickable swatches.
   *
   * Choosing one records WHERE the colour came from, so editing the theme later
   * re-derives it — that is the whole difference between a deck that can be
   * re-branded and one that has 400 hex literals in it.
   */
  paletteSwatches(refs: ColorRef | ColorRef[], input: HTMLInputElement): HTMLElement {
    const ref = Array.isArray(refs) ? refs[0] : refs
    const holder = (ref.id ? this.store.element(ref.id) : this.store.slide) as never
    const current = holder ? refAt(holder, ref.path) : undefined
    return buildPaletteSwatchRow(this.store.doc, current, input, (base, slot) => this.setRef(refs, base, slot))
  }

  /** Color swatch + opacity %. Native color inputs have no alpha channel, so
   *  the pair round-trips rgba()/#rrggbbaa strings losslessly. */
  colorAlpha(
    value: string,
    onEdit: (v: string, final: boolean) => void,
    ref?: ColorRef | ColorRef[],
  ): HTMLElement {
    const control = this.colorAlphaChip(value, onEdit, ref)
    this.trackColor(control, value, ref)
    return control
  }

  colorAlphaChip(
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
  gradientBar(elId: string, getStops: (el: SlideElement) => Array<{ at: number; color: string }> | undefined): HTMLElement {
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

  select(options: string[], value: string, onChange: (v: string) => void): HTMLElement {
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

  toggle(value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'ed-toggle'
    cb.checked = value
    cb.addEventListener('change', () => onChange(cb.checked))
    return cb
  }

  opBtn(icon: string, title: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'ed-btn ed-btn-icon'
    btn.title = title
    btn.innerHTML = icon
    btn.addEventListener('click', onClick)
    return btn
  }
}
