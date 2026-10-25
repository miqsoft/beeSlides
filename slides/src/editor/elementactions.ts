// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The shared element-edit layer. The properties panel and the floating mini
// toolbar both change the selected element, and they must agree on what one
// edit IS: one undo checkpoint per burst of continuous input (a colour drag,
// typing in a number field), one action-log entry when the burst ends, and a
// palette reference cleared when a colour is picked by hand. Before this file
// that logic lived privately in PropsPanel, so a second surface would have had
// to copy it — and two copies of "when does a burst end" drift apart.
//
// One instance per Editor, handed to both surfaces. The burst flag is SHARED
// on purpose: a burst opened from the toolbar and continued from the panel is
// still one undo step. It resets on selection/slide changes (and undo/redo,
// which emit both), because a burst can never meaningfully continue across
// those.

import type { Store } from '../store'
import { MEDIA_EMBED_BUDGET, internAsset, isVisibleColor, setShapeStroke, setShapeStrokeWidth, strokeFallbackFor, type ImageElement, type MediaElement, type ShapeElement, type SlideElement, type TextElement } from '../model'
import { combineColor } from './colorpicker'
import { refAt, setColor } from '../palette'
import { t } from '../i18n'
import { resetCrop } from './cropmode'
import { fitMathFrame } from '../measure'
import { liveStep } from './livestep'

/** Where a colour lives, for palette references. `id: null` = the slide. */
export interface ColorRef { id: string | null; path: string }

export type TextAlign = TextElement['align']
export type ImageFit = ImageElement['fit']

/** Slide-space px per point: the slide is a 96dpi space, 1pt = 4/3 px. */
const PX_PER_PT = 4 / 3

/** One element or several: every named setter takes either, and several
 *  are ONE edit (one undo step) — how a group's borders change together. */
export type Ids = string | readonly string[]
const list = (ids: Ids): readonly string[] => (typeof ids === 'string' ? [ids] : ids)

export class ElementEdits {
  private burst = false
  /** True from a FINAL edit until the end of the current task — see setRef. */
  private justCommitted = false

  constructor(private store: Store) {
    const reset = () => { this.burst = false }
    store.on('selection', reset)
    store.on('current', reset)
  }

  /** checkpoint once per burst of continuous input, commit on change. Only
   *  the FINAL step of a burst closes out the action log (store.recordAction) —
   *  recording on every touch() would flood it with one entry per keystroke
   *  instead of one "text edited" entry per edit. */
  edit(mutate: () => void, final: boolean) {
    if (!this.burst) {
      this.store.checkpoint()
      this.burst = true
    }
    mutate()
    // recordAction() BEFORE touch(): touch() synchronously emits 'doc', which
    // rebuilds the panel (including the History section) — the new
    // action-log entry must already exist when that rebuild reads it back.
    if (final) {
      this.burst = false
      this.store.recordAction()
      this.justCommitted = true
      queueMicrotask(() => { this.justCommitted = false })
    }
    // A non-final step redraws the canvas and panel at the next frame, not
    // now (livestep.ts); the final step is the ordinary synchronous commit.
    liveStep(final, () => this.store.touch())
  }

  /** Abandon an open burst without committing anything — the next edit
   *  starts a fresh undo step. */
  resetBurst() {
    this.burst = false
  }

  /** Mutate elements by id, as one edit (ids that no longer exist are
   *  skipped; none left = no edit at all). */
  mutate(ids: Ids, fn: (el: SlideElement) => void, final: boolean) {
    const els = list(ids).map((id) => this.store.element(id)).filter((e): e is SlideElement => !!e)
    if (els.length) this.edit(() => { for (const el of els) fn(el) }, final)
  }

  /** Write a colour and its palette reference together, as one undoable edit.
   *  `token: null` clears the reference — what a hand-picked colour must do,
   *  or the next theme edit silently overwrites a deliberate choice. */
  setRef(refs: ColorRef | readonly ColorRef[], literal: string, token: string | null) {
    const pairs = (Array.isArray(refs) ? refs : [refs] as readonly ColorRef[])
      .map((ref) => ({ ref, holder: ref.id ? this.store.element(ref.id) : this.store.slide }))
      .filter((p): p is { ref: ColorRef; holder: NonNullable<typeof p.holder> } => !!p.holder)
    if (!pairs.length) return
    if (token === null && this.justCommitted) {
      // The "manual pick" half of a colour commit: the control has just
      // written this literal through a final edit, and clearing the palette
      // reference belongs to THAT undo step — a second checkpoint here made
      // every hand-picked colour cost two ⌘Z presses.
      const held = pairs.filter(({ ref, holder }) => refAt(holder as never, ref.path))
      if (!held.length) return
      for (const { ref, holder } of held) setColor(holder as never, ref.path, literal, null)
      this.store.touch()
      return
    }
    this.edit(() => {
      for (const { ref, holder } of pairs) {
        setColor(holder as never, ref.path, literal, token)
        // a palette swatch on a borderless shape's Stroke must show a border
        // too — the same rule setStroke applies
        if (ref.path === 'stroke' && 'type' in holder && holder.type === 'shape') {
          setShapeStroke(holder, literal, this.strokeFallback(holder))
        }
      }
    }, true)
  }

  /** What a border "comes back" as: the slide type's default shape style
   *  (model.strokeFallbackFor), for a shape that has none yet. */
  private strokeFallback(s: ShapeElement): { stroke: string; strokeWidth: number } {
    return strokeFallbackFor(this.store.doc, this.store.slide, s)
  }

  // --- named setters: the operations both surfaces offer --------------------

  /** Text/code size in points; the model stores slide-space px. */
  setFontSizePt(id: Ids, pt: number, final = true) {
    if (!Number.isFinite(pt)) return
    this.mutate(id, (e) => {
      if (e.type !== 'text' && e.type !== 'code' && e.type !== 'math') return
      e.fontSize = Math.round(Math.max(pt, 3) * PX_PER_PT * 100) / 100
      // an equation's box follows its formula (height fits, width only grows)
      if (e.type === 'math') Object.assign(e, fitMathFrame(e, this.store.doc))
    }, final)
  }

  /** Every element's size through `next(pt)`, as one edit — several sizes
   *  each take their own step (A−/A+ on a mixed selection). */
  setFontSizesBy(id: Ids, next: (pt: number) => number) {
    this.mutate(id, (e) => {
      if (e.type !== 'text' && e.type !== 'code' && e.type !== 'math') return
      const pt = next(ElementEdits.fontSizePt(e))
      if (!Number.isFinite(pt)) return
      e.fontSize = Math.round(Math.max(pt, 3) * PX_PER_PT * 100) / 100
      if (e.type === 'math') Object.assign(e, fitMathFrame(e, this.store.doc))
    }, true)
  }

  /** The element's size in points, rounded to one decimal (what the UI shows). */
  static fontSizePt(el: { fontSize: number }): number {
    return Math.round((el.fontSize / PX_PER_PT) * 10) / 10
  }

  /** Solid fill colour (shape fill, text colour). */
  setFill(id: Ids, v: string, final = true) {
    this.mutate(id, (e) => {
      if (e.type === 'shape') e.fill = v
      else if (e.type === 'text') e.color = v
      else if (e.type === 'math') e.color = v
    }, final)
  }

  /** The palette path a fill colour lives at, for setRef. */
  static fillPath(el: SlideElement): string {
    return el.type === 'text' || el.type === 'math' ? 'color' : 'fill'
  }

  /**
   * The VISIBLE stroke colour. A `line` shape paints its colour from `fill`
   * (render.ts draws the line with stroke=el.fill, because `stroke` is what
   * the morph tweens) — so for a line, "stroke" writes `fill`. Every other
   * shape has a real outline in `stroke`.
   */
  setStroke(id: Ids, v: string, final = true) {
    this.mutate(id, (e) => {
      if (e.type !== 'shape') return
      if (e.shape === 'line') e.fill = v
      // a visible colour on a borderless shape brings the default width too
      else setShapeStroke(e, v, this.strokeFallback(e))
    }, final)
  }

  /** The stroke colour a control shows — see setStroke for the line case.
   *  No border yet: the slide type's default border colour at 0%, so
   *  picking a hue lifts it to 100% (colorpicker.ts alphaAfterHuePick). */
  strokeOf(el: ShapeElement): string {
    if (el.shape === 'line') return el.fill
    return isVisibleColor(el.stroke) ? el.stroke : combineColor(this.strokeFallback(el).stroke, 0)
  }

  /** The palette path the visible stroke colour lives at, for setRef. */
  static strokePath(el: ShapeElement): string {
    return el.shape === 'line' ? 'fill' : 'stroke'
  }

  setStrokeWidth(id: Ids, px: number, final = true) {
    if (!Number.isFinite(px)) return
    this.mutate(id, (e) => {
      if (e.type !== 'shape') return
      // a width on a borderless shape brings the default colour too
      if (e.shape === 'line') e.strokeWidth = Math.max(px, 0)
      else setShapeStrokeWidth(e, px, this.strokeFallback(e))
    }, final)
  }

  setTextAlign(id: Ids, align: TextAlign) {
    this.mutate(id, (e) => {
      if (e.type === 'text' || e.type === 'code' || e.type === 'math') e.align = align
    }, true)
  }

  /** Whole-box bold: 700 ⇄ 400. Anything already heavier than regular counts
   *  as bold, so a 600 heading toggles OFF rather than to 700. */
  toggleBold(id: Ids) {
    // several: all bold already → all regular, otherwise all bold
    const texts = list(id).map((i) => this.store.element(i)).filter((e): e is TextElement => e?.type === 'text')
    const on = !texts.length || !texts.every((e) => ElementEdits.isBold(e))
    this.mutate(id, (e) => {
      if (e.type !== 'text') return
      if (typeof id === 'string') e.fontWeight = (e.fontWeight ?? 400) > 400 ? 400 : 700
      else e.fontWeight = on ? 700 : 400
    }, true)
  }

  /** Line style of shapes' outlines (and lines). */
  setStrokeStyle(id: Ids, style: 'solid' | 'dashed' | 'dotted') {
    this.mutate(id, (e) => {
      if (e.type !== 'shape') return
      e.strokeStyle = style === 'solid' ? undefined : style
      if (style === 'solid') delete e.strokeDash // the legacy dash too
    }, true)
  }

  /** Font family of text boxes ('' = the theme's). */
  setFontFamily(id: Ids, family: string) {
    this.mutate(id, (e) => {
      if (e.type === 'text') e.fontFamily = family
    }, true)
  }

  /** Opacity 0–1 of any element. */
  setOpacity(id: Ids, v: number, final = true) {
    if (!Number.isFinite(v)) return
    this.mutate(id, (e) => { e.opacity = Math.min(1, Math.max(0, v)) }, final)
  }

  static isBold(el: TextElement): boolean {
    return (el.fontWeight ?? 400) > 400
  }

  setImageFit(id: Ids, fit: ImageFit) {
    this.mutate(id, (e) => {
      if (e.type === 'image') e.fit = fit
    }, true)
  }

  /** "Reset crop": the whole picture again, the frame grown back out to it
   *  at the scale and place it has now — at the picture's natural aspect
   *  when its natural size is given (cropmode.resetCrop). One undo step. */
  resetImageCrop(id: string, natW = 0, natH = 0) {
    const el = this.store.element(id)
    if (el?.type !== 'image' || !el.crop) return
    this.mutate(id, (e) => { if (e.type === 'image') resetCrop(e, natW, natH) }, true)
  }

  /** Swap a video/audio clip's source, keeping its frame and playback
   *  settings. Interned — only doc.assets entries are reachable by the
   *  live-collab blob offload. */
  replaceMediaSrc(id: string, dataUrl: string) {
    this.mutate(id, (e) => {
      if (e.type === 'media') e.src = internAsset(this.store.doc, dataUrl)
    }, true)
  }

  setMediaAutoplay(id: Ids, on: boolean) {
    this.mutate(id, (e) => {
      if (e.type === 'media') e.autoplay = on || undefined
    }, true)
  }

  /** Swap an image's picture, keeping its frame. Interned into doc.assets
   *  like every other embed site. */
  replaceImageSrc(id: string, dataUrl: string) {
    this.mutate(id, (e) => {
      if (e.type === 'image') e.src = internAsset(this.store.doc, dataUrl)
    }, true)
  }
}

/** Open a file picker for an image and resolve its data: URL together with
 *  its natural size (null when the file can't be decoded as an image).
 *  Shared by Insert ▸ Image and the panel/toolbar "Replace image…". */
export function readImageFile(): Promise<{ src: string; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) { resolve(null); return }
      const reader = new FileReader()
      reader.onload = () => {
        const src = String(reader.result)
        const img = new Image()
        img.onload = () => resolve({ src, width: img.width, height: img.height })
        img.onerror = () => resolve(null)
        img.src = src
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
    // A cancelled picker fires no change event; the promise simply never
    // settles, which is harmless — nothing awaits it past the click.
    input.click()
  })
}

/** Open a file picker for a clip of `kind` and resolve its data: URL, after
 *  confirming an embed above MEDIA_EMBED_BUDGET (null when declined or
 *  unreadable). Shared by the panel's and the toolbar's "Replace file…". */
export function pickMediaFile(kind: MediaElement['kind']): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = kind === 'audio' ? 'audio/*' : 'video/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) { resolve(null); return }
      if (file.size > MEDIA_EMBED_BUDGET) {
        const mb = Math.round(file.size / (1024 * 1024))
        if (!confirm(t('This file is {mb} MB. Embedding makes the .beeslides.html large and slow to open and save. Embed anyway?', { mb }))) {
          resolve(null)
          return
        }
      }
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
    input.click()
  })
}
