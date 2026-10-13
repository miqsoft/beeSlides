// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The floating mini toolbar: the three or four things you most likely
// selected an element to change, right next to it — PowerPoint's mini
// toolbar / Keynote's format bar. Everything else stays in the properties
// panel; the ⋯ button opens the matching panel section.
//
// Edits go through the SAME ElementEdits instance the panel uses, so a change
// here is one undo step and the panel shows the new value on its next
// rebuild. Colour wells come from panel.colorControl(), so the palette
// swatches and the "hand-picked colour clears its theme reference" rule are
// identical on both surfaces.
//
// MOUNTING: inside the canvas wrap (not document.body), so it rides along
// when the Layout Manager reparents the canvas, and positioned `absolute`
// against that wrap. It sits BELOW the selection — Moveable's rotate handle
// owns the space above — and flips above when there is no room.
//
// FOCUS: every button acts on mousedown + preventDefault (the Insert-field
// menu's trick), so clicking B while editing text never blurs the
// contentEditable and never ends the edit. Selects and number fields do take
// focus; they only appear when no text edit is live.

import type { Store } from '../store'
import type { SlideCanvas } from './canvas'
import type { PropsPanel } from './panels'
import { applyChartPalette, type ChartElement, type CodeElement, type ImageElement, type LineEnding, type MediaElement, type ShapeElement, type SlideElement, type TableElement, type TextElement } from '../model'
import { CHART_PRESETS } from '../charts'
import { TRANSITION_KINDS, TRANSITION_LABELS } from './menumodel'
import { LANGS } from '../../../kernel/src/tokenize.ts'
import type { MenuCustomization } from './customize/apply'
import type { QuickBarPlace } from './customize/schema'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { positionAtRect } from './floatingposition'
import { ElementEdits, pickMediaFile, readImageFile } from './elementactions'
import { editRoot, indentList, openColorPicker, openLinkEditor, stepRunSize, toggleList } from './richtext'
import type { MathElement } from '../model'
import { openProsePalette } from './mathpalettebar'

const SETTING_KEY = 'slidomingo-minitoolbar'
const SETTING_EVENT = 'slidomingo:minitoolbar-setting'


/** The place from before the UI profile knew it — the old on/off viewer
 *  preference: 'off' stays off, an explicit 'on' meant floating, and no
 *  choice at all is the new default, the top. */
export function legacyQuickBarPlace(): QuickBarPlace {
  const v = lsGet(SETTING_KEY)
  return v === 'off' ? 'off' : v === 'on' ? 'floating' : 'top'
}

/** Kept for the old preference's writers; the UI profile's
 *  `toolbar.quickbar` wins over it (editor/customize/). */
export function setLegacyQuickBarPlace(place: QuickBarPlace) {
  lsSet(SETTING_KEY, place === 'off' ? 'off' : place === 'floating' ? 'on' : place)
  document.dispatchEvent(new CustomEvent(SETTING_EVENT))
}

/** PowerPoint's font-size ladder — what the A−/A+ buttons step through. */
const SIZE_STEPS = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96, 120, 144, 180, 240]

/** The next size on the ladder above (dir=1) or below (dir=-1) `pt`. */
export function stepFontSize(pt: number, dir: 1 | -1): number {
  if (dir > 0) return SIZE_STEPS.find((s) => s > pt + 1e-6) ?? Math.round(pt * 1.25)
  for (let i = SIZE_STEPS.length - 1; i >= 0; i--) if (SIZE_STEPS[i] < pt - 1e-6) return SIZE_STEPS[i]
  return Math.max(3, Math.round(pt * 0.8))
}

export interface MiniToolbarHooks {
  /** true while something outside the canvas owns the screen (presenting) */
  suppressed(): boolean
  /** open the properties panel (if collapsed) and reveal a section in it */
  revealPanelSection(key: string): void
  /** the UI profile's pins and hidden items (editor/customize/) */
  custom?(): MenuCustomization | null
  /** The DOCKED bar: pinned at the top of the slide area instead of
   *  floating under the selection — same controls, same customization. */
  docked?: boolean
  /** Run a menu command / read its state (the docked bar's slide actions). */
  runCommand?(id: string): void
  commandVisible?(id: string): boolean
}

/** What the docked bar's leading chip calls the selection. */
const KIND_LABEL: Record<string, string> = {
  shape: 'Shape', line: 'Line', text: 'Text', 'text-edit': 'Editing text', image: 'Picture', chart: 'Chart',
  code: 'Code', media: 'Media', math: 'Equation', table: 'Table', svg: 'Diagram', embed: 'Embed', zoom: 'Zoom',
}

type Mode =
  | { kind: 'shape'; el: ShapeElement }
  | { kind: 'line'; el: ShapeElement }
  | { kind: 'text'; el: TextElement }
  | { kind: 'text-edit'; el: TextElement | TableElement }
  | { kind: 'image'; el: ImageElement }
  | { kind: 'chart'; el: ChartElement }
  | { kind: 'code'; el: CodeElement }
  | { kind: 'media'; el: MediaElement }
  | { kind: 'multi'; els: SlideElement[] }
  | { kind: 'math'; el: MathElement }

export class MiniToolbar {
  readonly el: HTMLElement
  /** a mouse button is down on the canvas (a click, marquee or drag) */
  private pointerDown = false
  private gesture = false
  /** element id of the live inline text edit, if any */
  private editingId: string | undefined
  /** what the current buttons were built for; a change rebuilds them */
  private signature = ''
  /** the document changed while the user was interacting with the bar */
  private stale = false
  private readonly docked: boolean

  constructor(
    private store: Store,
    private canvas: SlideCanvas,
    private panel: PropsPanel,
    private edits: ElementEdits,
    private host: HTMLElement,
    private hooks: MiniToolbarHooks,
  ) {
    this.docked = !!hooks.docked
    this.el = document.createElement('div')
    this.el.className = this.docked ? 'ed-minibar ed-quickbar' : 'ed-minibar'
    this.el.setAttribute('role', 'toolbar')
    this.el.setAttribute('aria-label', t('Quick format'))
    this.el.setAttribute('aria-orientation', 'horizontal')
    // Branch-3 rich text: a text edit's blur commit skips focus moving here.
    this.el.dataset.rtKeep = ''
    this.el.hidden = true
    host.appendChild(this.el)
    if (this.docked) {
      // the slide area starts below the docked bar, however tall it wraps
      new ResizeObserver(() => this.reserve()).observe(this.el)
    }

    store.on('selection', () => this.update())
    store.on('current', () => this.update())
    store.on('doc', () => { this.stale = true; this.update() })
    canvas.onViewportChange(() => this.update())
    canvas.onGesture((active) => { this.gesture = active; this.update() })
    canvas.onTextEditChange((id) => { this.editingId = id; this.update() })
    document.addEventListener(SETTING_EVENT, () => this.update())

    // Hide for the whole press on the canvas — a click that re-selects, a
    // marquee, a drag — and come back once it has settled.
    host.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || this.el.contains(ev.target as Node)) return
      this.pointerDown = true
      this.update()
      const release = () => {
        window.removeEventListener('mouseup', release, true)
        window.removeEventListener('blur', release)
        // after Selecto/Moveable have processed the release
        setTimeout(() => { this.pointerDown = false; this.update() })
      }
      window.addEventListener('mouseup', release, true)
      window.addEventListener('blur', release)
    }, true)

    // Roving focus: ←/→ between controls, Home/End, Esc back to the canvas.
    this.el.addEventListener('keydown', (ev) => this.onKey(ev))
    this.el.addEventListener('focusout', () => setTimeout(() => this.update()))
    // B/I/U/S pressed state follows the caret while editing
    document.addEventListener('selectionchange', () => {
      if (this.signature.startsWith('text-edit')) this.refreshPressed()
    })
    // a table row grows while its cell is typed into (a text box only grows
    // on commit): keep the bar clear of the cell it sits under
    document.addEventListener('input', () => {
      if (this.signature.startsWith('text-edit') && this.canvas.isEditingCell && !this.el.hidden) this.place()
    }, true)
  }

  /** Alt+F10: move keyboard focus onto the toolbar (when it is showing). */
  focus(): boolean {
    if (this.el.hidden) return false
    const first = this.controls()[0]
    first?.focus()
    return !!first
  }

  // --- state ------------------------------------------------------------------

  /** Where the bar shows: the profile's choice, else the old preference. */
  placement(): QuickBarPlace {
    return this.hooks.custom?.()?.quickbar?.() ?? legacyQuickBarPlace()
  }

  /** This instance (docked or floating) is switched on at all. */
  private shown(): boolean {
    const p = this.placement()
    return p === 'both' || p === (this.docked ? 'top' : 'floating')
  }

  private mode(): Mode | null {
    if (!this.shown() || this.hooks.suppressed() || this.store.readOnly) return null
    const c = this.canvas
    if (c.isCommentMode || c.isFormatPaintArmed || c.isReapplyChangeArmed) return null
    if (c.isPathEditing || c.isDrawing) return null
    if (c.isEditingMath) return null // the equation popover owns the space
    // the floating bar gets out of the way of a press; the docked one is
    // not in the way, and blinking it would only distract
    if (!this.docked && (this.pointerDown || this.gesture)) return null
    const els = this.store.selectedElements
    if (!els.length) return null
    if (els.length > 1) return { kind: 'multi', els }
    const el = els[0]
    if (c.isEditingText) {
      // a text box's inline edit — or a table cell's (rich text phase 2) —
      // gets the inline-format bar; code edits as plain text, so it gets none
      if (this.editingId !== el.id) return null
      if (el.type === 'text') return { kind: 'text-edit', el }
      return el.type === 'table' && c.isEditingCell ? { kind: 'text-edit', el } : null
    }
    switch (el.type) {
      case 'shape': return el.shape === 'line' ? { kind: 'line', el } : { kind: 'shape', el }
      case 'text': return { kind: 'text', el }
      case 'image': return { kind: 'image', el }
      case 'chart': return { kind: 'chart', el }
      case 'code': return { kind: 'code', el }
      case 'media': return { kind: 'media', el }
      case 'math': return { kind: 'math', el }
      default: return null // table, svg, embed: the panel has what they need
    }
  }

  /** The user is mid-interaction with the bar: a focused field, or an open
   *  colour popover (a rebuild would tear it out from under the pointer). */
  private interacting(): boolean {
    return this.el.contains(document.activeElement) || !!this.el.querySelector('.ed-color-pop')
  }

  /** Rebuild on the next update (the UI profile changed its pins or hidden items). */
  invalidate() {
    this.signature = ''
    this.update()
  }

  update() {
    const mode = this.mode()
    if (!mode) {
      if (this.docked && this.shown() && !this.hooks.suppressed()) {
        // docked: stays put and says what it is waiting for
        const sl = this.store.slide
        // the slide type's name too: the idle bar shows it
        const type = sl?.layoutId ? this.store.doc.layouts?.find((l) => l.id === sl.layoutId)?.name ?? '?' : ''
        const sig = `idle:${this.store.selection.join(',')}:${sl?.id}:${sl?.background}:${sl?.transition}:${type}:${!!this.store.editingSurface}`
        if (sig !== this.signature && !this.interacting()) { this.buildIdle(); this.signature = sig }
        this.el.hidden = false
        this.reserve()
        return
      }
      this.el.hidden = true
      this.signature = ''
      this.reserve()
      return
    }
    const sig = mode.kind === 'multi'
      ? `multi:${mode.els.map((e) => e.id).join(',')}`
      : `${mode.kind}:${mode.el.id}`
    if (sig !== this.signature || (this.stale && !this.interacting())) {
      // A different selection always rebuilds. The same one rebuilds to show
      // new values — but never while the user is working a control in it.
      if (sig !== this.signature || !this.interacting()) {
        this.build(mode)
        this.signature = sig
        this.stale = false
      }
    }
    this.place()
  }

  /** Docked: keep the slide area clear of the bar (the scroller starts
   *  below it). Floating: nothing to reserve. */
  private reserve() {
    if (!this.docked) return
    const on = !this.el.hidden
    this.host.classList.toggle('ed-has-quickbar', on)
    if (on) this.host.style.setProperty('--quickbar-h', `${Math.ceil(this.el.offsetHeight) + 16}px`)
  }

  private place() {
    if (this.docked) {
      this.el.hidden = false
      this.reserve()
      return
    }
    // a cell edit: the bar sits under the cell being edited, not the table
    const cell = this.canvas.isEditingCell ? editRoot()?.closest('td, th')?.getBoundingClientRect() : undefined
    const sel = cell ?? this.canvas.selectionRect()
    const view = this.canvas.viewportRect()
    // selection scrolled out of view: don't pin a bar to the canvas edge
    if (!sel || sel.bottom < view.top || sel.top > view.bottom || sel.right < view.left || sel.left > view.right) {
      this.el.hidden = true
      return
    }
    this.el.hidden = false
    positionAtRect(sel, this.el, {
      placement: 'bottom',
      align: 'center',
      gap: 14, // clear of Moveable's resize handles
      margin: 8,
      bounds: view,
      relativeTo: this.host,
    })
  }

  // --- building ---------------------------------------------------------------

  private build(mode: Mode) {
    this.el.innerHTML = ''
    if (this.docked) this.chip(mode)
    switch (mode.kind) {
      case 'shape': this.buildShape(mode.el); break
      case 'line': this.buildLine(mode.el); break
      case 'text': this.buildText(mode.el); break
      case 'text-edit': this.buildTextEdit(); break
      case 'image': this.buildImage(mode.el); break
      case 'chart': this.buildChart(mode.el); break
      case 'code': this.buildCode(mode.el); break
      case 'media': this.buildMedia(mode.el); break
      case 'multi': this.buildMulti(mode.els); break
      case 'math': this.buildMath(mode.el); break
    }
    this.customize(mode.kind)
    // one tab stop for the whole bar (roving tabindex)
    this.controls().forEach((c, i) => { c.tabIndex = i === 0 ? 0 : -1 })
  }

  /** Docked bar, leading chip: what the controls after it act on. */
  private chip(mode: Mode) {
    const c = document.createElement('span')
    c.className = 'ed-quickbar-chip'
    if (mode.kind === 'multi') {
      const gid = mode.els[0]?.groupId
      const oneGroup = !!gid && mode.els.every((e) => e.groupId === gid)
      c.textContent = oneGroup ? t('Group') : t('{n} objects', { n: mode.els.length })
      c.classList.add('is-multi')
    } else {
      c.textContent = t(mode.kind === 'media' ? (mode.el.kind === 'audio' ? 'Audio' : 'Video') : KIND_LABEL[mode.kind] ?? mode.kind)
    }
    this.el.appendChild(c)
  }

  /** Docked bar with nothing it can format: a calm hint, or — for a type
   *  whose settings only live in the panel — the way there. */
  private buildIdle() {
    this.el.innerHTML = ''
    const els = this.store.selectedElements
    const chip = (text: string) => {
      const c = document.createElement('span')
      c.className = 'ed-quickbar-chip'
      c.textContent = text
      this.el.appendChild(c)
      return c
    }
    if (els.length === 1) {
      chip(t(KIND_LABEL[els[0].type] ?? els[0].type))
      const hint = document.createElement('span')
      hint.className = 'ed-quickbar-hint'
      hint.textContent = t('Its settings are in the side panel')
      this.el.appendChild(hint)
      this.add('more', this.more(''))
      return
    }
    // nothing selected: the slide's own everyday settings, so the bar is
    // useful instead of a placeholder (not while a slide type/object is open)
    const run = this.hooks.runCommand
    if (!els.length && run && !this.store.editingSurface) {
      const slide = this.store.slide
      chip(t('Slide')).classList.add('is-slide')
      this.el.appendChild(this.labelled(t('Background'), this.panel.colorControl(slide.background,
        (v, fin) => this.edits.edit(() => { this.store.slide.background = v }, fin), { ref: { id: null, path: 'background' } })))
      if (this.hooks.commandVisible?.('slide.transition.fade') !== false) {
        this.el.appendChild(this.select(
          TRANSITION_KINDS.map((k) => [k, t(TRANSITION_LABELS[k])] as [string, string]),
          slide.transition ?? 'none', t('Transition'), (v) => run(`slide.transition.${v}`)))
      }
      this.sep()
      if (this.hooks.commandVisible?.('slide.changeType') !== false) {
        // the current type's name when the slide follows one (same as the slide panel's row)
        const type = slide.layoutId ? this.store.doc.layouts?.find((l) => l.id === slide.layoutId) : undefined
        const typeB = this.button(t('Slide type…'), t('Change slide type…'), () => run('slide.changeType'), { text: true })
        if (type) { // a user-chosen name: text, never markup
          const name = document.createElement('span')
          name.className = 'ed-minibar-typename'
          name.textContent = type.name ?? t('Untitled')
          const caret = document.createElement('span')
          caret.className = 'ed-slidetype-chev'
          caret.innerHTML = ICONS.chevronDown
          typeB.replaceChildren(name, caret)
        }
        this.el.appendChild(typeB)
      }
      if (this.hooks.commandVisible?.('slide.new') !== false) {
        this.el.appendChild(this.button(`${ICONS.plus}<span>${t('New slide')}</span>`, t('Add a slide — pick a slide type'), () => run('slide.new'), { text: true }))
      }
      return
    }
    const hint = document.createElement('span')
    hint.className = 'ed-quickbar-hint'
    hint.innerHTML = ICONS.pointerClick
    hint.append(t('Select something to format it'))
    this.el.appendChild(hint)
  }

  private buildShape(el: ShapeElement) {
    if (el.fillGradient) {
      this.add('gradient', this.button(t('gradient'), t('Edit the gradient'), () => this.hooks.revealPanelSection('Fill & stroke'), { text: true }))
    } else {
      this.add('fill', this.labelled(t('Fill'), this.panel.colorControl(el.fill, (v, fin) => this.edits.setFill(el.id, v, fin),
        { alpha: true, ref: { id: el.id, path: 'fill' } })))
    }
    this.add('stroke', this.labelled(t('Stroke'), this.panel.colorControl(this.edits.strokeOf(el), (v, fin) => this.edits.setStroke(el.id, v, fin),
      { alpha: true, ref: { id: el.id, path: ElementEdits.strokePath(el) } }), true))
    this.add('stroke-width', this.widthField(el))
    this.sep()
    this.add('more', this.more('Fill & stroke'))
  }

  private buildLine(el: ShapeElement) {
    this.add('stroke', this.labelled(t('Stroke'), this.panel.colorControl(this.edits.strokeOf(el), (v, fin) => this.edits.setStroke(el.id, v, fin),
      { alpha: true, ref: { id: el.id, path: ElementEdits.strokePath(el) } }), true))
    this.add('stroke-width', this.widthField(el))
    this.add('line-tip', this.select(
      [['none', t('No tip')], ['arrow', t('Arrow tip')], ['dot', t('Dot tip')], ['bar', t('Bar tip')]],
      el.lineEnd ?? 'none', t('End tip'),
      (v) => this.edits.mutate(el.id, (e) => { (e as ShapeElement).lineEnd = v === 'none' ? undefined : (v as LineEnding) }, true)))
    this.sep()
    this.add('more', this.more('Stroke'))
  }

  private buildText(el: TextElement) {
    const pt = ElementEdits.fontSizePt(el)
    this.add('size', this.button('A−', t('Smaller text'), () => this.edits.setFontSizePt(el.id, stepFontSize(ElementEdits.fontSizePt(this.live(el)), -1)), { text: true }))
    const size = document.createElement('span')
    size.className = 'ed-minibar-val'
    size.textContent = String(pt)
    size.title = t('Size (pt)')
    this.add('size', size)
    this.add('size', this.button('A+', t('Larger text'), () => this.edits.setFontSizePt(el.id, stepFontSize(ElementEdits.fontSizePt(this.live(el)), 1)), { text: true }))
    this.sep()
    if (el.colorGradient) {
      this.add('gradient', this.button(t('gradient'), t('Edit the gradient'), () => this.hooks.revealPanelSection('Typography'), { text: true }))
    } else {
      this.add('color', this.labelled(t('Color'), this.panel.colorControl(el.color, (v, fin) => this.edits.setFill(el.id, v, fin),
        { ref: { id: el.id, path: 'color' } })))
    }
    this.add('bold', this.button(ICONS.bold, t('Bold'), () => this.edits.toggleBold(el.id), { pressed: ElementEdits.isBold(el) }))
    this.sep()
    for (const [a, icon, label] of [['left', ICONS.textLeft, t('Align left')], ['center', ICONS.textCenter, t('Center')], ['right', ICONS.textRight, t('Align right')]] as const) {
      this.add('text-align', this.button(icon, label, () => this.edits.setTextAlign(el.id, a), { pressed: el.align === a }))
    }
    this.sep()
    this.add('more', this.more('Typography'))
  }

  /** Inline formatting of the selection inside a live text edit. execCommand
   *  keeps the browser's own contentEditable undo working; the canvas commits
   *  the resulting html (sanitized) when the edit ends. */
  private buildTextEdit() {
    const cmds: Array<[string, string, string]> = [
      ['bold', '<b>B</b>', t('Bold (⌘B)')],
      ['italic', '<i>I</i>', t('Italic (⌘I)')],
      ['underline', '<u>U</u>', t('Underline (⌘U)')],
      ['strikeThrough', '<s>S</s>', t('Strikethrough')],
    ]
    for (const [cmd, glyph, label] of cmds) {
      const b = this.button(glyph, label, () => this.inline(cmd), { text: true })
      b.dataset.cmd = cmd
      this.add('inline-format', b)
    }
    // rich text (richtext.ts): run colour and size, lists, link — all on the
    // selection inside the edit, all mousedown-only so the edit never blurs
    this.sep()
    const color = this.button('<span class="ed-rt-a">A</span>', t('Text color'), () => openColorPicker(color, this.store.doc), { text: true })
    color.dataset.rt = 'color'
    this.add('color', color)
    this.add('size', this.button('A−', t('Smaller selected text'), () => stepRunSize(-1, stepFontSize), { text: true }))
    this.add('size', this.button('A+', t('Larger selected text'), () => stepRunSize(1, stepFontSize), { text: true }))
    this.sep()
    const lists: Array<[string, string, string, boolean]> = [
      ['insertUnorderedList', ICONS.listBullet, t('Bulleted list (⌘⇧8)'), false],
      ['insertOrderedList', ICONS.listNumber, t('Numbered list (⌘⇧7)'), true],
    ]
    for (const [cmd, icon, label, ordered] of lists) {
      const b = this.button(icon, label, () => { toggleList(ordered); this.refreshPressed() })
      b.dataset.cmd = cmd
      this.add('lists', b)
    }
    this.add('lists', this.button(ICONS.outdent, t('Decrease list level (⇧Tab)'), () => { indentList(-1) }))
    this.add('lists', this.button(ICONS.indent, t('Increase list level (Tab)'), () => { indentList(1) }))
    const link = this.button(ICONS.link, t('Link (⌘K)'), () => openLinkEditor(link))
    link.dataset.rt = 'link'
    this.add('link', link)
    // the equation palette: a pick is typed at the caret as $…$ math
    const sum = this.button(ICONS.equation, t('Equation palette'), () => openProsePalette(sum))
    sum.dataset.rt = 'math'
    this.add('equation', sum)
    this.refreshPressed()
  }

  private inline(cmd: string) {
    document.execCommand(cmd)
    // execCommand writes <strike>, which the sanitizer does not keep; <s> is
    // the same mark and survives the commit.
    if (cmd === 'strikeThrough') {
      const inner = editRoot() // the text box's or the table cell's
      inner?.querySelectorAll('strike').forEach((n) => {
        const s = document.createElement('s')
        s.append(...n.childNodes)
        n.replaceWith(s)
      })
    }
    this.refreshPressed()
  }

  private refreshPressed() {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button[data-cmd]')) {
      let on = false
      try { on = document.queryCommandState(b.dataset.cmd!) } catch { /* unsupported */ }
      b.setAttribute('aria-pressed', String(on))
      b.classList.toggle('is-on', on)
    }
  }

  private buildImage(el: ImageElement) {
    this.add('replace', this.button(t('Replace…'), t('Pick a new picture — position, size and effects stay'), () => {
      void readImageFile().then((p) => { if (p) this.edits.replaceImageSrc(el.id, p.src) })
    }, { text: true }))
    this.add('crop', this.button(t('Crop'), t('Cut the picture down by dragging its edges on the canvas (or double-click it)'), () =>
      document.dispatchEvent(new CustomEvent('slidomingo:crop-image', { detail: { id: el.id } })), { text: true }))
    // a cropped picture always fills its frame, so Fit has nothing to say
    if (!el.crop) {
      this.add('fit', this.select(
        [['contain', t('contain')], ['cover', t('cover')], ['fill', t('fill')]],
        el.fit, t('Fit'), (v) => this.edits.setImageFit(el.id, v as ImageElement['fit'])))
    }
  }

  private buildChart(el: ChartElement) {
    this.add('chart-type', this.select(
      Object.keys(CHART_PRESETS).map((k) => [k, t(k)] as [string, string]),
      el.preset ?? 'bar', t('Type'),
      (v) => this.edits.mutate(el.id, (e) => {
        const c = e as ChartElement
        c.preset = v
        c.option = applyChartPalette(CHART_PRESETS[v](), this.store.doc.theme)
      }, true)))
    this.add('edit-data', this.button(t('Edit data'), t('Open the chart’s data table in the panel'), () => this.hooks.revealPanelSection('Data'), { text: true }))
  }

  private buildCode(el: CodeElement) {
    const langs = Object.keys(LANGS).sort().concat(['diff', 'md'])
    this.add('language', this.select(langs.map((l) => [l, t(l)] as [string, string]), el.grammarName ?? 'js', t('Language'),
      (v) => this.edits.mutate(el.id, (e) => { (e as CodeElement).grammarName = v }, true)))
    this.sep()
    this.add('size', this.button('A−', t('Smaller text'), () => this.edits.setFontSizePt(el.id, stepFontSize(ElementEdits.fontSizePt(this.live(el)), -1)), { text: true }))
    this.add('size', this.button('A+', t('Larger text'), () => this.edits.setFontSizePt(el.id, stepFontSize(ElementEdits.fontSizePt(this.live(el)), 1)), { text: true }))
  }

  private buildMath(el: MathElement) {
    this.add('edit-math', this.button(t('Edit…'), t('Open the equation editor (or double-click the equation)'), () =>
      document.dispatchEvent(new CustomEvent('slidomingo:edit-math', { detail: { id: el.id } })), { text: true }))
    this.sep()
    this.add('size', this.button('A−', t('Smaller text'), () => this.edits.setFontSizePt(el.id, stepFontSize(ElementEdits.fontSizePt(this.live(el)), -1)), { text: true }))
    this.add('size', this.button('A+', t('Larger text'), () => this.edits.setFontSizePt(el.id, stepFontSize(ElementEdits.fontSizePt(this.live(el)), 1)), { text: true }))
    this.add('color', this.labelled(t('Color'), this.panel.colorControl(el.color, (v, fin) => this.edits.setFill(el.id, v, fin),
      { ref: { id: el.id, path: 'color' } })))
    this.sep()
    for (const [a, icon, label] of [['left', ICONS.textLeft, t('Align left')], ['center', ICONS.textCenter, t('Center')], ['right', ICONS.textRight, t('Align right')]] as const) {
      this.add('text-align', this.button(icon, label, () => this.edits.setTextAlign(el.id, a), { pressed: el.align === a }))
    }
    this.sep()
    this.add('more', this.more('Typesetting'))
  }

  private buildMedia(el: MediaElement) {
    this.add('replace', this.button(el.src ? t('Replace…') : t('Choose file…'), t('Replace file…'), () => {
      void pickMediaFile(el.kind).then((src) => { if (src) this.edits.replaceMediaSrc(el.id, src) })
    }, { text: true }))
    this.add('autoplay', this.button(t('Autoplay'), t('Autoplay runs only while presenting; browsers require “muted” for video to autoplay.'),
      () => this.edits.setMediaAutoplay(el.id, !this.live(el).autoplay), { text: true, pressed: !!el.autoplay }))
  }

  private buildMulti(els: SlideElement[]) {
    const ids = els.map((e) => e.id)
    const live = () => ids.map((id) => this.store.element(id)).filter(Boolean) as SlideElement[]
    // group formatting first — what you most often select several things for
    const shapes = els.filter((e): e is ShapeElement => e.type === 'shape')
    const boxes = shapes.filter((e) => e.shape !== 'line')
    const sameOr = <T>(vals: T[], fallback: T): T => (vals.every((v) => v === vals[0]) ? vals[0] : fallback)
    // a colour the objects don't share: striped swatch (styles.css .ed-row-mixed)
    const mixedIf = (node: HTMLElement, vals: unknown[]) => {
      if (!vals.every((v) => v === vals[0])) { node.classList.add('ed-row-mixed'); node.title += ` — ${t('Mixed')}` }
      return node
    }
    if (boxes.length) {
      const bIds = boxes.map((e) => e.id)
      this.add('fill', mixedIf(this.labelled(t('Fill'), this.panel.colorControl(sameOr(boxes.map((e) => e.fill), boxes[0].fill), (v, fin) =>
        this.edits.mutate(bIds, (e) => { if (e.type === 'shape') { delete e.fillGradient; e.fill = v } }, fin),
      { alpha: true, ref: boxes.map((e) => ({ id: e.id, path: 'fill' })) })), boxes.map((e) => e.fillGradient ? 'gradient' : e.fill)))
    }
    if (shapes.length) {
      const sIds = shapes.map((e) => e.id)
      this.add('stroke', mixedIf(this.labelled(t('Stroke'), this.panel.colorControl(sameOr(shapes.map((e) => this.edits.strokeOf(e)), this.edits.strokeOf(shapes[0])),
        (v, fin) => this.edits.setStroke(sIds, v, fin),
        { alpha: true, ref: shapes.map((e) => ({ id: e.id, path: ElementEdits.strokePath(e) })) }), true), shapes.map((e) => this.edits.strokeOf(e))))
      const w = this.widthField(shapes[0], sIds)
      if (!shapes.every((e) => e.strokeWidth === shapes[0].strokeWidth)) { w.value = ''; w.placeholder = '–' }
      this.add('stroke-width', w)
    }
    const inked = els.filter((e): e is TextElement | MathElement => e.type === 'text' || e.type === 'math')
    const sized = els.filter((e) => e.type === 'text' || e.type === 'code' || e.type === 'math')
    if (inked.length || sized.length) {
      if (shapes.length) this.sep()
      if (inked.length) {
        const tIds = inked.map((e) => e.id)
        this.add('color', this.labelled(t('Color'), this.panel.colorControl(sameOr(inked.map((e) => e.color), inked[0].color), (v, fin) =>
          this.edits.mutate(tIds, (e) => { if (e.type === 'text') { delete e.colorGradient; e.color = v } else if (e.type === 'math') e.color = v }, fin),
        { ref: inked.map((e) => ({ id: e.id, path: 'color' })) })))
      }
      if (sized.length) {
        // each one steps its own size up/down the ladder, so different sizes keep their ratio
        const step = (dir: 1 | -1) => this.edits.setFontSizesBy(sized.map((e) => e.id), (pt) => stepFontSize(pt, dir))
        this.add('size', this.button('A−', t('Smaller text'), () => step(-1), { text: true }))
        this.add('size', this.button('A+', t('Larger text'), () => step(1), { text: true }))
      }
    }
    if (shapes.length || inked.length || sized.length) this.sep()
    // align, distribute, centre: one dropdown — six align icons in a row
    // made the bar the longest thing on screen
    this.add('arrange', this.arrangeMenu(els, live))
    this.sep()
    const grouped = els.every((e) => e.groupId && e.groupId === els[0].groupId)
    this.add('group', grouped
      ? this.button(t('⛓ Ungroup'), t('Dissolve the group (⇧G)'), () => this.panel.ungroup(live()), { text: true })
      : this.button(t('⛓ Group'), t('Elements select and move as one; Alt-click reaches a member (G)'), () => this.panel.group(live()), { text: true }))
  }

  /**
   * Arrange ▾ — the align/distribute kit in a small popover under the
   * button: the Align to switch, the six align buttons, Center on slide and
   * Distribute (honouring a profile that hides `distribute`). Any action
   * closes it (the doc changes, the bar rebuilds); Esc or a click outside too.
   */
  private arrangeMenu(els: SlideElement[], live: () => SlideElement[]): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'ed-arrange-dd'
    const trigger = this.button(`${ICONS.alignLeft}<span>${t('Arrange')}</span><span class="ed-minibar-caret">▾</span>`,
      t('Align, distribute, center on slide'), () => (pop ? close() : open()), { text: true })
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'false')
    wrap.appendChild(trigger)
    let pop: HTMLElement | null = null
    const onDoc = (ev: MouseEvent) => { if (pop && !wrap.contains(ev.target as Node)) close() }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); trigger.focus() } }
    const close = () => {
      pop?.remove()
      pop = null
      trigger.setAttribute('aria-expanded', 'false')
      trigger.classList.remove('is-on')
      document.removeEventListener('mousedown', onDoc, true)
    }
    const item = (id: string, icon: string, label: string, run: () => void) => {
      const b = this.button(icon, label, () => { close(); run() })
      b.dataset.uiItem = id
      return b
    }
    const open = () => {
      const hidden = this.hooks.custom?.()?.hidden('minibar') ?? new Set<string>()
      pop = document.createElement('div')
      pop.className = 'ed-arrange-pop'
      pop.setAttribute('role', 'menu')
      pop.dataset.rtKeep = ''
      pop.addEventListener('keydown', onKey)
      // what the buttons line things up against (one object: always the slide)
      if (els.length > 1) {
        const seg = document.createElement('div')
        seg.className = 'ed-arrange-ref'
        const cap = document.createElement('span')
        cap.textContent = t('Align to')
        seg.appendChild(cap)
        for (const [ref, label] of [['selection', t('Selection')], ['slide', t('Slide')]] as const) {
          const b = this.button(label, label, () => {
            this.panel.alignRef = ref
            for (const x of seg.querySelectorAll('button')) x.classList.toggle('is-on', x === b)
          }, { text: true, pressed: this.panel.alignRef === ref })
          seg.appendChild(b)
        }
        pop.appendChild(seg)
      }
      const grid = document.createElement('div')
      grid.className = 'ed-arrange-grid'
      const EDGES: Array<[string, string, 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom']> = [
        [ICONS.alignLeft, t('Align left'), 'left'], [ICONS.alignCenterX, t('Align horizontal centers'), 'centerX'],
        [ICONS.alignRight, t('Align right'), 'right'], [ICONS.alignTop, t('Align top'), 'top'],
        [ICONS.alignMiddleY, t('Align vertical middles'), 'middleY'], [ICONS.alignBottom, t('Align bottom'), 'bottom'],
      ]
      for (const [icon, label, edge] of EDGES) grid.appendChild(item('arrange', icon, label, () => this.panel.align(live(), edge)))
      pop.appendChild(grid)
      const row = document.createElement('div')
      row.className = 'ed-arrange-row2'
      const center = this.button(`${ICONS.centerSlide}<span>${t('Center on slide')}</span>`, t('Center on slide'),
        () => { close(); this.panel.centerOnSlide(live()) }, { text: true })
      row.appendChild(center)
      if (!hidden.has('distribute') && this.panel.offersDistribute(els)) {
        row.appendChild(item('distribute', ICONS.distributeX, t('Distribute horizontally'), () => this.panel.distribute(live(), 'x')))
        row.appendChild(item('distribute', ICONS.distributeY, t('Distribute vertically'), () => this.panel.distribute(live(), 'y')))
      }
      pop.appendChild(row)
      wrap.appendChild(pop)
      trigger.setAttribute('aria-expanded', 'true')
      trigger.classList.add('is-on')
      document.addEventListener('mousedown', onDoc, true)
      ;(pop.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true })
    }
    return wrap
  }

  /** The UI profile's part: its hidden built-ins go (with the separators
   *  they leave behind), its pins for this kind of selection come last. */
  private customize(kind: Mode['kind']) {
    const custom = this.hooks.custom?.()
    if (!custom) return
    const hidden = custom.hidden('minibar')
    if (hidden.size) {
      for (const n of [...this.el.querySelectorAll<HTMLElement>(':scope > [data-ui-item]')]) if (hidden.has(n.dataset.uiItem!)) n.remove()
    }
    const pins = custom.pins('minibar', ['*', kind])
    if (pins.length) this.sep()
    for (const pin of pins) {
      const icon = pin.icon && pin.icon in ICONS ? ICONS[pin.icon as keyof typeof ICONS] : null
      const b = this.button(icon ?? '', pin.chord ? `${pin.label} (${pin.chord})` : pin.label, () => pin.run(), { text: !icon })
      if (!icon) b.textContent = pin.label
      b.classList.add('ed-minibar-custom')
      this.el.appendChild(b)
    }
    let prevSep = true
    for (const n of [...this.el.children]) {
      const isSep = n.classList.contains('ed-minibar-sep')
      if (isSep && prevSep) n.remove()
      else prevSep = isSep
    }
    while (this.el.lastElementChild?.classList.contains('ed-minibar-sep')) this.el.lastElementChild.remove()
  }

  // --- controls ---------------------------------------------------------------

  /** The element as it is NOW (the bar may be a few edits behind). */
  private live<T extends SlideElement>(el: T): T {
    return (this.store.element(el.id) as T | undefined) ?? el
  }

  /** `id` = the catalog id a UI profile hides it by (customize/catalog.ts MINIBAR_ITEMS). */
  private add(id: string, node: HTMLElement) {
    node.dataset.uiItem = id
    this.el.appendChild(node)
  }

  private sep() {
    const s = document.createElement('span')
    s.className = 'ed-minibar-sep'
    s.setAttribute('role', 'separator')
    this.el.appendChild(s)
  }

  /**
   * A toolbar button. It acts on MOUSEDOWN with preventDefault, so it never
   * takes focus from a live text edit; keyboard activation (Enter/Space on a
   * focused button) arrives as a click with detail 0.
   */
  private button(content: string, label: string, onPress: () => void, opts: { text?: boolean; pressed?: boolean } = {}): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-minibar-btn' + (opts.text ? ' ed-minibar-text' : '')
    b.innerHTML = content
    b.title = label
    // an icon needs a spoken name; a text button already has its own
    if (!opts.text) b.setAttribute('aria-label', label)
    if (opts.pressed !== undefined) {
      b.setAttribute('aria-pressed', String(opts.pressed))
      b.classList.toggle('is-on', opts.pressed)
    }
    b.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return
      ev.preventDefault()
      onPress()
    })
    b.addEventListener('click', (ev) => { if (ev.detail === 0) onPress() })
    return b
  }

  private more(sectionKey: string): HTMLButtonElement {
    return this.button(ICONS.more, t('More options'), () => this.hooks.revealPanelSection(sectionKey))
  }

  /** Label a colour control for tooltips and screen readers. `ring` draws
   *  its swatch as a ring — a stroke — so Fill and Stroke read apart. */
  private labelled(label: string, control: HTMLElement, ring = false): HTMLElement {
    control.classList.add('ed-minibar-color')
    if (ring) control.classList.add('ed-minibar-ring')
    control.title = label
    const trigger = control.querySelector('button')
    trigger?.setAttribute('aria-label', label)
    // docked, there is room for the word: a swatch alone doesn't say "border"
    if (this.docked && trigger) {
      const cap = document.createElement('span')
      cap.className = 'ed-qb-cap'
      cap.textContent = label
      trigger.appendChild(cap)
    }
    return control
  }

  private widthField(el: ShapeElement, ids: string | string[] = el.id): HTMLInputElement {
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '0'
    input.step = '0.5'
    input.className = 'ed-minibar-num'
    input.value = String(el.strokeWidth)
    input.title = t('Stroke width')
    input.setAttribute('aria-label', t('Stroke width'))
    input.addEventListener('change', () => {
      const v = parseFloat(input.value)
      if (Number.isFinite(v)) this.edits.setStrokeWidth(ids, v)
    })
    return input
  }

  private select(options: Array<[string, string]>, value: string, label: string, onChange: (v: string) => void): HTMLSelectElement {
    const sel = document.createElement('select')
    sel.className = 'ed-minibar-select'
    sel.title = label
    sel.setAttribute('aria-label', label)
    for (const [v, text] of options) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = text
      if (v === value) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => onChange(sel.value))
    return sel
  }

  // --- keyboard ---------------------------------------------------------------

  private controls(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>(':scope > button, :scope > select, :scope > input, :scope > .ed-color-control > button, :scope > .ed-arrange-dd > button')]
  }

  private onKey(ev: KeyboardEvent) {
    const list = this.controls()
    const i = list.indexOf(document.activeElement as HTMLElement)
    // a popover inside the bar handles its own keys (Escape closes it)
    if ((ev.target as HTMLElement).closest('.ed-color-pop')) return
    const move = (to: number) => {
      ev.preventDefault()
      const next = list[(to + list.length) % list.length]
      list.forEach((c) => { c.tabIndex = c === next ? 0 : -1 })
      next?.focus()
    }
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.blur()
      return
    }
    // ↑/↓ still change a select's or number field's value; ←/→ move on
    if (ev.key === 'ArrowRight') move(i + 1)
    else if (ev.key === 'ArrowLeft') move(i - 1)
    else if (ev.key === 'Home') move(0)
    else if (ev.key === 'End') move(list.length - 1)
  }
}
