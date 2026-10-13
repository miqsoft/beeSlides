// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Text measurement — `window.slidomingo.measure()`.
//
// WHY THIS EXISTS. The format is absolute pixels, which is what lets morph, the
// editor's drag handles and the renderer all work from one representation. The
// cost lands on whoever is generating a deck without a screen: the rendered
// height of a string, for a given font, size, weight and lineHeight, is
// unknowable without a render. So every card, caption and two-line heading is a
// guess, and overflow and collisions are downstream of that one gap.
//
// This closes it. Give it text and a width, get back the height that text needs
// — before the element exists, so an agent can size a box rather than guess it
// and correct later.
//
// It measures by RENDERING, through `renderElement`, the same path the editor,
// present mode and thumbnails use. A reimplementation — canvas measureText, a
// line-count estimate — would drift from the renderer the moment anything about
// text layout changed, and drift in a measuring tool is worse than no tool: it
// reads as authoritative and is quietly wrong.

import type { MathElement, SlidomingoDoc, TextElement } from './model.ts'
import { defaultText } from './model.ts'
import { renderElement } from './render.ts'

/** What to measure. Anything omitted falls back to the deck's text defaults. */
export interface TextMeasureSpec {
  html: string
  /** box width in slide px — the thing that decides where lines wrap */
  w: number
  /** box height, if you have one and want `fits`/`overflow` computed */
  h?: number
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  lineHeight?: number
  letterSpacing?: number
}

export interface TextMeasurement {
  /** height this content needs at this width, in slide px, rounded up */
  height: number
  /** the width it was measured at, echoed back */
  width: number
  /** how many lines it wrapped to */
  lines: number
  /** only when `h` was supplied: does the content fit the box? */
  fits?: boolean
  /** only when `h` was supplied: px of overflow (0 when it fits) */
  overflow?: number
}

/**
 * A hidden host that is in the document (so layout runs) but paints nothing.
 *
 * visibility:hidden rather than display:none — a display:none subtree has no
 * layout at all and every height would read 0. Marked transient so
 * `serializeBody` strips it if a save ever races a measurement.
 */
function withHost<T>(fn: (host: HTMLElement) => T): T {
  const host = document.createElement('div')
  host.setAttribute('data-slidomingo-transient', '')
  host.style.cssText =
    'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;contain:strict;'
  document.body.appendChild(host)
  try {
    return fn(host)
  } finally {
    host.remove()
  }
}

/**
 * Measure one text element as the renderer would lay it out.
 *
 * `doc` supplies the theme font and the embedded faces, so measuring against
 * the deck the text will live in is the whole point — the same string in
 * Fraunces and in a system stack are different heights.
 */
export function measureText(spec: TextMeasureSpec, doc: SlidomingoDoc): TextMeasurement {
  return withHost((host) => measureInto(host, spec, doc))
}

/** One measurement inside an already-open host. */
function measureInto(host: HTMLElement, spec: TextMeasureSpec, doc: SlidomingoDoc): TextMeasurement {
  const el = defaultText({
    ...spec,
    id: 'slidomingo-measure',
    x: 0,
    y: 0,
    w: spec.w,
    h: spec.h ?? 10,
  })
  const node = renderElement(el, doc)
  // The box height is what we are trying to find, so it must not constrain the
  // measurement — let the inner text take whatever height it needs.
  node.style.height = 'auto'
  host.appendChild(node)
  const inner = node.querySelector<HTMLElement>('.slidomingo-text-inner') ?? node
  const height = Math.ceil(inner.getBoundingClientRect().height)
  // lineHeight is unitless in the model, so one line is fontSize * lineHeight
  const per = (el.fontSize ?? 16) * (el.lineHeight ?? 1.2)
  const lines = Math.max(1, Math.round(height / Math.max(per, 1)))
  node.remove()
  const out: TextMeasurement = { height, width: spec.w, lines }
  if (typeof spec.h === 'number') {
    out.fits = height <= spec.h
    out.overflow = Math.max(0, height - spec.h)
  }
  return out
}

/**
 * Measure many elements through ONE host — what `validate()` uses to check a
 * whole deck. Opening a host per element would be the same answer and a lot
 * more DOM churn on a long deck.
 */
export function measureElements(els: TextElement[], doc: SlidomingoDoc): TextMeasurement[] {
  if (!els.length) return []
  return withHost((host) => els.map((el) => measureInto(host, specOf(el), doc)))
}

const specOf = (el: TextElement): TextMeasureSpec => ({
  html: el.html,
  w: el.w,
  h: el.h,
  fontSize: el.fontSize,
  fontFamily: el.fontFamily,
  fontWeight: el.fontWeight,
  lineHeight: el.lineHeight,
  letterSpacing: el.letterSpacing,
})

/**
 * The height an existing element's content needs — the number to write into
 * `h` so the box fits its text exactly.
 */
export function measureElement(el: TextElement, doc: SlidomingoDoc): TextMeasurement {
  return measureText(specOf(el), doc)
}

/** The typeset size of an equation element's content, in slide px. */
export interface MathMeasurement {
  width: number
  height: number
}

/**
 * Measure an equation (model.ts `MathElement`) as the renderer lays it out:
 * the natural size of its `.slidomingo-math-box`, unconstrained by the
 * element's own frame. Same rule as text — render through `renderElement`,
 * never estimate — because MathML layout depends on the viewer's math font.
 */
export function measureMath(el: MathElement, doc: SlidomingoDoc): MathMeasurement {
  return withHost((host) => {
    const node = renderElement({ ...el, id: 'slidomingo-measure', x: 0, y: 0, rotation: 0 } as MathElement, doc)
    // neither box dimension may constrain what we are trying to find
    node.style.width = '100000px'
    node.style.height = 'auto'
    node.style.transform = ''
    host.appendChild(node)
    const box = node.querySelector<HTMLElement>('.slidomingo-math-box') ?? node
    const r = box.getBoundingClientRect()
    node.remove()
    return { width: Math.ceil(r.width), height: Math.ceil(r.height) }
  })
}

/**
 * The frame an equation should get after its content changed: the HEIGHT
 * fits the formula (plus a little air), the WIDTH only ever grows. Shrinking
 * the width would move a centred or right-aligned formula's anchor every
 * time a term is deleted; growing it keeps the formula from spilling out.
 * When the box grows it grows about its own alignment, so a centred
 * formula stays centred where the author put it.
 */
export function fitMathFrame(el: MathElement, doc: SlidomingoDoc): { x: number; y: number; w: number; h: number } {
  const m = measureMath(el, doc)
  // air around the ink: MathML boxes sit tight on their glyphs, and a
  // descender or a radical's hook would otherwise touch the frame
  const pad = Math.max(12, Math.round((el.fontSize || 48) * 0.5))
  const h = Math.max(m.height + pad, Math.round((el.fontSize || 48) * 1.2))
  const w = Math.max(el.w, m.width + pad)
  const dx = w - el.w
  const x = el.align === 'right' ? el.x - dx : el.align === 'left' ? el.x : el.x - dx / 2
  // keep the vertical anchor the valign implies
  const dy = h - el.h
  const y = el.valign === 'bottom' ? el.y - dy : el.valign === 'top' ? el.y : el.y - dy / 2
  return { x: Math.round(x), y: Math.round(y), w: Math.ceil(w), h: Math.ceil(h) }
}
