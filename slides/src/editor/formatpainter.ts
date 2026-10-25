// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Format Painter: arm the tool, click a source element to capture its style,
// then click any number of other elements to apply it — PowerPoint's
// stay-armed paintbrush. Click-capture mechanics (armed cursor, capture-phase
// hit test, Esc to disarm) live in canvas.ts beside its other armed tools;
// this file owns only the style bag itself: what gets copied and how it
// merges onto a target, type by type.

import type { Store } from '../store'
import type { SlideCanvas } from './canvas'
import type { ElementBase, ShapeElement, SlideElement, TextElement } from '../model'
import { jsonClone } from '../jsonclone.ts'

const UNIVERSAL_KEYS = ['shadow', 'blur', 'blend', 'backdropFilter'] as const
const TEXT_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'color', 'align', 'valign', 'lineHeight'] as const
const SHAPE_KEYS = ['fill', 'fillGradient', 'stroke', 'strokeWidth', 'strokeStyle', 'strokeDash', 'radius'] as const

type UniversalKey = (typeof UNIVERSAL_KEYS)[number]
type TextKey = (typeof TEXT_KEYS)[number]
type ShapeKey = (typeof SHAPE_KEYS)[number]

interface StyleBag {
  universal: Partial<Record<UniversalKey, unknown>>
  sourceType: SlideElement['type']
  text?: Partial<Record<TextKey, unknown>>
  shape?: Partial<Record<ShapeKey, unknown>>
}

function clone<T>(v: T): T {
  return v && typeof v === 'object' ? jsonClone(v) : v
}

export class FormatPainter {
  private captured: StyleBag | null = null

  /** notified when the tool arms/disarms (topbar button state) */
  onArmedChange: ((on: boolean) => void) | null = null

  constructor(
    private store: Store,
    private canvas: SlideCanvas,
  ) {
    this.canvas.onFormatPaintClick = (elId) => this.handleClick(elId)
    this.canvas.onFormatPaintModeChange = (on) => {
      if (!on) this.captured = null
      this.onArmedChange?.(on)
    }
  }

  get isArmed() {
    return this.canvas.isFormatPaintArmed
  }

  toggle() {
    if (this.canvas.isFormatPaintArmed) this.canvas.disarmFormatPaint()
    else this.canvas.armFormatPaint()
  }

  private handleClick(elId: string) {
    const el = this.store.element(elId)
    if (!el) return
    if (!this.captured) {
      this.captured = this.capture(el)
      return
    }
    const bag = this.captured
    this.store.commit(() => {
      const target = this.store.element(elId)
      if (target) applyBag(bag, target)
    })
  }

  private capture(el: SlideElement): StyleBag {
    const universal: Partial<Record<UniversalKey, unknown>> = {}
    for (const k of UNIVERSAL_KEYS) universal[k] = clone((el as ElementBase)[k])
    const bag: StyleBag = { universal, sourceType: el.type }
    if (el.type === 'text') {
      const text: Partial<Record<TextKey, unknown>> = {}
      for (const k of TEXT_KEYS) text[k] = clone((el as TextElement)[k])
      bag.text = text
    } else if (el.type === 'shape') {
      const shape: Partial<Record<ShapeKey, unknown>> = {}
      for (const k of SHAPE_KEYS) shape[k] = clone((el as ShapeElement)[k])
      bag.shape = shape
    }
    return bag
  }
}

/** Merge a captured bag onto a live target: universal fields always (an
 *  absent source field CLEARS the target's, matching "paint this exact
 *  look"); type-specific fields only when the target's type matches the
 *  set that was captured — a text-captured bag never writes shape-only
 *  fields onto a shape, and vice versa. */
function applyBag(bag: StyleBag, target: SlideElement) {
  for (const k of UNIVERSAL_KEYS) {
    const v = bag.universal[k]
    if (v === undefined) delete (target as ElementBase)[k]
    else (target as ElementBase)[k] = clone(v) as never
  }
  if (bag.text && target.type === 'text') {
    for (const k of TEXT_KEYS) (target as TextElement)[k] = clone(bag.text[k]) as never
  } else if (bag.shape && target.type === 'shape') {
    for (const k of SHAPE_KEYS) {
      // the optional ones (gradient, dash) clear when the source had none
      const v = bag.shape[k]
      if (v === undefined) delete (target as ShapeElement)[k]
      else (target as ShapeElement)[k] = clone(v) as never
    }
  }
}
