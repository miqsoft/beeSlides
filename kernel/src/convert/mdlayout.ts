// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Coordinate synthesis — the one hard problem in importing a `.qmd`.
//
// Quarto is DOCUMENT FLOW; slidomingo/slides is ABSOLUTE COORDINATES. A `.qmd`
// carries no x/y/w/h anywhere, so inventing them is the job. This file does
// NOT contain a layout engine, and adding one here would be the wrong answer:
// slides already has a layout system (roles, layouts, `applyLayout`), and a
// bespoke flow engine would produce slides that look placed but cannot be
// re-themed, re-laid-out, or re-applied afterwards. So:
//
//   1. Every emitted slide is LINKED to a real `doc.layouts` entry, and that
//      entry is one of `builtinLayouts()`'s six designs, materialized.
//   2. Content is dropped into that layout's placeholders BY ROLE.
//   3. A body placeholder is treated as a REGION, and several blocks stack
//      inside it — but only the first keeps `role:'body'`, so a later
//      re-apply moves the slide's actual body text and leaves the extras
//      riding on top (`applyLayout`'s documented behaviour) rather than
//      fighting over one slot.
//
// WHY THE FRAMES ARE RESTATED HERE AND NOT IMPORTED. The kernel must not
// depend on an app (`types.ts`'s header, the same inversion charts.ts uses),
// so `builtinLayouts()` in slides/src/model.ts is unreachable from here. The
// table below is therefore a deliberate restatement of it — and, exactly like
// scripts/shell-gate.mjs's restated splice rule, it is GATED: the light-theme
// output of `buildLayout()` is compared element-for-element against the real
// `builtinLayouts()` by scripts/test-convert/qmd.ts, which can import both.
// If model.ts's geometry moves and this does not, that rig fails.
//
// Geometry is authored at LAYOUT_BASE (1600x900) and scaled to the deck the
// same way model.ts's `scaleLayout` does — type scales with the SMALLER axis,
// because on a squarer canvas that is what decides whether a heading fits.

import type { OutElement, OutShape, OutText } from './types.ts'

/** The canvas the geometry below is authored against — model.ts's LAYOUT_BASE. */
export const LAYOUT_BASE = { width: 1600, height: 900 }

/** The default deck size for an import: LAYOUT_BASE itself, so the six
 *  designs land unscaled and a `.qmd` (always 16:9 in reveal) gets the stage
 *  they were drawn for. */
export const DEFAULT_SIZE = { width: 1600, height: 900 }

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
export const MONO_STACK =
  "ui-monospace, 'SFMono-Regular', 'Berkeley Mono', 'Menlo', 'Consolas', monospace"

/**
 * Every colour the emitted layouts and content use, in one place.
 *
 * The LIGHT values are the literals `builtinLayouts()` hardcodes, which is
 * what lets the rig compare a light import against it exactly. A reveal.js
 * dark theme name in the front matter swaps the whole set rather than tinting
 * individual elements.
 */
export interface Palette {
  bg: string
  ink: string
  /** subtitle ink (#5A4452 in the built-ins) */
  sub: string
  /** body/caption ink (#76606C in the built-ins) */
  muted: string
  accent: string
  /** the section-divider slide's own inverted ground */
  sectionBg: string
  sectionInk: string
  /** media-placeholder fill/stroke */
  slotFill: string
  slotStroke: string
  font: string
  mono: string
}

export const LIGHT: Palette = {
  bg: '#FFFFFF', ink: '#1D1119', sub: '#5A4452', muted: '#76606C', accent: '#9A5F00', // BRAND.honeyOnLight
  sectionBg: '#1D1119', sectionInk: '#FFFFFF',
  slotFill: '#F5EEF1', slotStroke: '#DCCCD3',
  font: FONT_STACK, mono: MONO_STACK,
}

export const DARK: Palette = {
  bg: '#14181D', ink: '#EDF1F6', sub: '#A9B7C8', muted: '#94A5B8', accent: '#FFC233', // BRAND.honey
  sectionBg: '#0B0E13', sectionInk: '#FFFFFF',
  slotFill: '#1E252E', slotStroke: '#34404E',
  font: FONT_STACK, mono: MONO_STACK,
}

/** The six designs, by the shape of content they hold. */
export type LayoutKind = 'title' | 'title-content' | 'two-col' | 'picture-caption' | 'section' | 'blank'

/** One materialized layout: a `doc.layouts` entry plus its own id/name. */
export interface LayoutOut {
  id: string
  name: string
  background: string
  elements: OutElement[]
}

export interface Frame { x: number; y: number; w: number; h: number }

/** What a slide's content looks like, reduced to the few facts that pick a
 *  design. `chooseLayout` is the only consumer. */
export interface Shape {
  hasTitle: boolean
  /** a heading ABOVE slide-level: Pandoc's own "this is a section" signal */
  isSection: boolean
  /** the front-matter title slide */
  isTitleSlide: boolean
  /** how many `::: {.column}`s the slide's body is split into (0 = not split) */
  columns: number
  /** the body is exactly one figure (plus an optional caption) */
  soloFigure: boolean
  /** any content at all besides the title */
  hasBody: boolean
}

export function chooseLayout(s: Shape): LayoutKind {
  if (s.isTitleSlide) return 'title'
  if (s.isSection) return 'section'
  if (!s.hasTitle) return 'blank'
  if (!s.hasBody) return 'section' // a heading with nothing under it IS a divider
  if (s.columns === 2) return 'two-col'
  if (s.soloFigure) return 'picture-caption'
  return 'title-content'
}

// --- the layout table --------------------------------------------------------

/** Ids are `qmd-*`, never `layout-*`: a materialized copy must not collide
 *  with the built-in of the same name in the layout picker, which lists both
 *  ("Built-in" and "This document"). The ELEMENT ids inside are the built-ins'
 *  own — that is what carries slot lineage (and the morph pairing that makes a
 *  code block travel when a slide is duplicated) across slides of one design. */
export const LAYOUT_IDS: Record<LayoutKind, string> = {
  title: 'qmd-title',
  'title-content': 'qmd-title-content',
  'two-col': 'qmd-two-col',
  'picture-caption': 'qmd-picture-caption',
  section: 'qmd-section',
  blank: 'qmd-blank',
}

const LAYOUT_NAMES: Record<LayoutKind, string> = {
  title: 'Title',
  'title-content': 'Title + content',
  'two-col': 'Two columns',
  'picture-caption': 'Picture with caption',
  section: 'Section divider',
  blank: 'Blank',
}

/** A text placeholder, mirroring model.ts's own `ph()` defaults exactly. */
function ph(id: string, placeholder: string, f: Frame, pal: Palette, over: Partial<OutText> = {}): OutText {
  return {
    id, type: 'text', ...f,
    rotation: 0, opacity: 1,
    html: '',
    placeholder,
    fontSize: 32,
    fontFamily: pal.font,
    fontWeight: 400,
    color: pal.ink,
    align: 'left',
    valign: 'top',
    lineHeight: 1.25,
    ...over,
  }
}

/** The accent rule/bar, mirroring model.ts's `bar()`. */
function bar(id: string, f: Frame, pal: Palette): OutShape {
  return {
    id, type: 'shape', shape: 'rect', ...f,
    rotation: 0, opacity: 1, fill: pal.accent, stroke: 'transparent', strokeWidth: 0, radius: 2,
  }
}

/** A `role:'media'` slot, mirroring model.ts's `mediaPh()`. */
function mediaPh(id: string, f: Frame, pal: Palette): OutShape {
  return {
    id, type: 'shape', shape: 'rect', ...f,
    rotation: 0, opacity: 1,
    fill: pal.slotFill, stroke: pal.slotStroke, strokeWidth: 1.5, strokeStyle: 'dashed',
    radius: 8, role: 'media',
  }
}

/** One design at LAYOUT_BASE, before scaling. */
function baseLayout(kind: LayoutKind, pal: Palette): LayoutOut {
  const id = LAYOUT_IDS[kind]
  const name = LAYOUT_NAMES[kind]
  switch (kind) {
    case 'title':
      return {
        id, name, background: pal.bg, elements: [
          bar('lt-bar', { x: 160, y: 380, w: 72, h: 8 }, pal),
          ph('lt-title', 'Click to add title', { x: 160, y: 404, w: 1280, h: 140 }, pal,
            { fontSize: 76, fontWeight: 700, valign: 'middle', role: 'title' }),
          ph('lt-sub', 'Click to add subtitle', { x: 160, y: 556, w: 1100, h: 60 }, pal,
            { fontSize: 28, color: pal.sub, valign: 'middle', role: 'subtitle' }),
        ],
      }
    case 'title-content':
      return {
        id, name, background: pal.bg, elements: [
          ph('ltc-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 }, pal,
            { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
          bar('ltc-rule', { x: 120, y: 168, w: 1360, h: 3 }, pal),
          ph('ltc-body', 'Click to add content', { x: 120, y: 208, w: 1360, h: 600 }, pal,
            { fontSize: 26, color: pal.muted, valign: 'top', lineHeight: 1.5, role: 'body' }),
        ],
      }
    case 'two-col':
      return {
        id, name, background: pal.bg, elements: [
          ph('l2c-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 }, pal,
            { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
          bar('l2c-rule', { x: 120, y: 168, w: 1360, h: 3 }, pal),
          ph('l2c-left', 'Left column', { x: 120, y: 208, w: 660, h: 600 }, pal,
            { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
          ph('l2c-right', 'Right column', { x: 820, y: 208, w: 660, h: 600 }, pal,
            { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
        ],
      }
    case 'picture-caption':
      return {
        id, name, background: pal.bg, elements: [
          ph('lpc-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 }, pal,
            { fontSize: 40, fontWeight: 700, valign: 'middle', role: 'title' }),
          mediaPh('lpc-media', { x: 120, y: 176, w: 1360, h: 560 }, pal),
          ph('lpc-caption', 'Click to add a caption', { x: 120, y: 752, w: 1360, h: 60 }, pal,
            { fontSize: 20, color: pal.muted, align: 'center', valign: 'middle', role: 'body' }),
        ],
      }
    case 'section':
      return {
        id, name, background: pal.sectionBg, elements: [
          bar('lsec-bar', { x: 160, y: 396, w: 72, h: 8 }, pal),
          ph('lsec-title', 'Section title', { x: 160, y: 420, w: 1280, h: 120 }, pal,
            { fontSize: 64, fontWeight: 700, color: pal.sectionInk, valign: 'middle', role: 'title' }),
          ph('lsec-kicker', 'PART 1', { x: 160, y: 350, w: 800, h: 40 }, pal,
            { fontSize: 18, fontWeight: 600, color: pal.accent, letterSpacing: 3, valign: 'middle', role: 'kicker' }),
        ],
      }
    case 'blank':
      return { id, name, background: pal.bg, elements: [] }
  }
}

/** model.ts's `scaleLayout`, restated (see the header). Type scales with the
 *  smaller axis; frames scale per-axis; everything rounds like the original. */
function scaleTo(ly: LayoutOut, size: { width: number; height: number }): LayoutOut {
  const sx = size.width / LAYOUT_BASE.width
  const sy = size.height / LAYOUT_BASE.height
  if (sx === 1 && sy === 1) return ly
  const st = Math.min(sx, sy)
  return {
    ...ly,
    elements: ly.elements.map((el) => {
      const next = {
        ...el,
        x: Math.round(el.x * sx), y: Math.round(el.y * sy),
        w: Math.round(el.w * sx), h: Math.round(el.h * sy),
      } as OutElement
      if (next.type === 'text') {
        const txt = next as OutText
        if (txt.fontSize) txt.fontSize = Math.max(8, Math.round(txt.fontSize * st))
        if (txt.letterSpacing) txt.letterSpacing = Math.round(txt.letterSpacing * st * 10) / 10
      }
      return next
    }),
  }
}

/** One design, scaled to the deck. */
export function buildLayout(kind: LayoutKind, size: { width: number; height: number }, pal: Palette): LayoutOut {
  return scaleTo(baseLayout(kind, pal), size)
}

/** A layout's placeholder for `role`, `n`-th in document order (0-based). */
export function slot(ly: LayoutOut, role: string, n = 0): OutText | undefined {
  const hits = ly.elements.filter((e): e is OutText => e.type === 'text' && e.role === role)
  return hits[n]
}

/** A layout's `role:'media'` slot — a shape, not a text placeholder. */
export function mediaSlot(ly: LayoutOut): OutShape | undefined {
  return ly.elements.find((e): e is OutShape => e.type === 'shape' && e.role === 'media')
}

// --- stacking inside a region ------------------------------------------------

/**
 * One piece of slide content that does not have a frame yet.
 *
 * A closure, not a tagged union: qmd.ts knows how to build every element type
 * and this file knows nothing about them, which is exactly the split that
 * keeps a layout engine from growing here. `nat`/`min` are asked for a natural
 * and a floor height at a given width; `emit` is handed the frame it actually
 * got and clamps its own typography to fit.
 */
export interface Box {
  nat(w: number): number
  min(w: number): number
  emit(f: Frame): OutElement[]
}

export interface Placed {
  frames: Frame[]
  /** true when even every box's floor height did not fit — the caller reports
   *  it, because a slide that overflows is a fact the reader must be told. */
  dense: boolean
}

/**
 * Stack `boxes` down `region`, top-aligned, with `gap` between them.
 *
 * Over budget, each box shrinks from its natural height toward its floor in
 * proportion to how much slack it has — so a 3-line paragraph beside a 40-line
 * listing gives up 3 lines' worth, not half the slide. Past every floor the
 * region is simply overrun and `dense` says so; silently scaling type to 6px
 * would be worse than an honest report plus a slide someone can fix.
 */
export function place(region: Frame, boxes: Box[], gap: number, limitY?: number): Placed {
  const n = boxes.length
  if (!n) return { frames: [], dense: false }
  const gaps = gap * (n - 1)
  const nats = boxes.map((b) => Math.max(1, b.nat(region.w)))
  const budget = region.h - gaps
  let hs = nats
  let dense = false
  const total = nats.reduce((a, b) => a + b, 0)
  if (total > budget) {
    const mins = boxes.map((b, i) => Math.min(Math.max(1, b.min(region.w)), nats[i]))
    const floor = mins.reduce((a, b) => a + b, 0)
    if (floor >= budget) {
      hs = mins
      dense = true
      // A dense stack still has to stay ON the canvas: `limitY` is the last y
      // it may reach (the page, not the region — every design leaves slack
      // below its body frame), and past that the floors are scaled down
      // together. Emitting frames off the page instead would trip
      // validate.ts's out-of-canvas finding on content the reader can still
      // see, which reads as a bug rather than as "this slide is too full".
      const bottom = region.y + floor + gaps
      if (limitY !== undefined && bottom > limitY) {
        const k = Math.max(0.2, (limitY - region.y - gaps) / floor)
        hs = mins.map((h) => Math.max(12, Math.round(h * k)))
      }
    } else {
      const slack = total - floor
      const cut = total - budget
      hs = nats.map((h, i) => Math.round(h - (h - mins[i]) * (cut / slack)))
    }
  }
  let y = region.y
  const frames = hs.map((h) => {
    const f = { x: region.x, y, w: region.w, h }
    y += h + gap
    return f
  })
  // Vertically centre the stack in its region — reveal.js centres slide
  // content by default, so this is the faithful reading as well as the
  // better-looking one. Skipped when dense, where the stack already fills
  // (or overruns) the region and shifting it would only clip the top.
  const used = hs.reduce((a, b) => a + b, 0) + gaps
  if (!dense && used < region.h) {
    const shift = Math.round((region.h - used) / 2)
    for (const f of frames) f.y += shift
  }
  return { frames, dense }
}

/** Split a region into side-by-side columns with the given relative weights. */
export function columns(region: Frame, weights: number[], gap: number): Frame[] {
  const sum = weights.reduce((a, b) => a + b, 0) || weights.length
  const avail = region.w - gap * (weights.length - 1)
  let x = region.x
  return weights.map((wt) => {
    const w = Math.round((avail * wt) / sum)
    const f = { x, y: region.y, w, h: region.h }
    x += w + gap
    return f
  })
}

// --- measurement (no DOM: the kernel is pure) --------------------------------

/**
 * Mean glyph advance as a fraction of font size. Two constants, both measured
 * off the stacks above rather than guessed: mixed-case proportional sans runs
 * ~0.52em, monospace is exactly its own advance (~0.6em for every face in
 * MONO_STACK). This is a BUDGET, not a layout — the real text metrics come
 * from `window.slidomingo.measure()` in the app layer, which is what produces the
 * post-import overflow findings.
 */
export const ADV_SANS = 0.52
export const ADV_MONO = 0.6

/** Wrapped line count for `text` (its own newlines respected) at this width. */
export function lineCount(text: string, w: number, fontSize: number, adv = ADV_SANS): number {
  const per = Math.max(1, Math.floor(w / (fontSize * adv)))
  let n = 0
  for (const para of text.split('\n')) n += Math.max(1, Math.ceil(para.length / per))
  return n
}

/** Rendered height of `text` at this width and size. */
export function textHeight(text: string, w: number, fontSize: number, lineHeight: number, adv = ADV_SANS): number {
  return Math.ceil(lineCount(text, w, fontSize, adv) * fontSize * lineHeight)
}

/** The largest size ≤ `base` at which `text` fits `w`x`h`, floored at 9px. */
export function fitFont(text: string, w: number, h: number, base: number, lineHeight: number, adv = ADV_SANS): number {
  let size = Math.round(base)
  while (size > 9 && textHeight(text, w, size, lineHeight, adv) > h) size -= 1
  return size
}
