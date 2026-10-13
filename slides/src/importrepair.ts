// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// After a PowerPoint import: settle what can be settled without judgement,
// then name what is left for an AI (or the user).
//
// STATIC FIRST. The converter (kernel/src/convert/pptx.ts) cannot measure
// text, so a box that relied on autofit, or whose font was substituted,
// arrives with PowerPoint's frame around text that may now wrap differently.
// `settleImportedText` re-measures every imported text box through the real
// renderer (injected `measure`, as in layoutguard.ts) and fixes the overflow
// the way PowerPoint itself would: grow the box (spAutoFit) when that covers
// nothing new and stays on the slide, else shrink the type a little
// (normAutofit, at most MIN_SHRINK). What neither fixes faithfully is
// returned as a leftover, never forced.
//
// THEN AI, ONLY FOR JUDGEMENT. `repairItems` turns the fidelity report plus
// those leftovers into the short work list "Fix with Claude" sends: only the
// codes in REPAIRABLE (something a model can restore from the source XML or
// the rendered original), each pointing at a slide id. Everything else in
// the report (a missing picture part, a substituted font, a transition with
// no counterpart) is a fact to read, not a task — no model can repair it.
//
// Pure model code: no DOM, no store. The editor wraps `settleImportedText`
// in one store.commit (one undo step) and runs it with measure.ts.

import type { SlidomingoDoc, Slide, SlideElement, TextElement } from './model.ts'
import { effectiveLayout } from './model.ts'
import { isFullBleed } from './validate.ts'
import type { FidelityReport } from '../../kernel/src/convert/report.ts'

type Frame = { x: number; y: number; w: number; h: number }

/** Smallest type scale the static pass will use (PowerPoint's own
 *  normAutofit goes much further, but past this the slide reads differently
 *  and that is a judgement call). */
export const MIN_SHRINK = 0.8

/** Overflow below this many px is rounding, not a problem. */
const SLACK = 1

export interface TextLeftover {
  slideId: string
  /** 1-based position in the deck */
  slide: number
  elementId: string
  /** px the text needs beyond its box at its current size */
  overflow: number
  /** why the static pass left it: one line, written for an agent */
  why: string
}

export interface SettleResult {
  grown: number
  shrunk: number
  leftovers: TextLeftover[]
}

/**
 * Re-measure every text box on the deck's slides and fix overflow in place
 * (mutates `doc`). `measure(el)` = the height `el`'s content needs at its
 * own width and size. Slide types are left alone: their boxes hold prompts,
 * not the imported text.
 */
export function settleImportedText(doc: SlidomingoDoc, measure: (el: TextElement) => number): SettleResult {
  const out: SettleResult = { grown: 0, shrunk: 0, leftovers: [] }
  doc.slides.forEach((slide, i) => {
    const owned = layoutOwnedIds(doc, slide)
    for (const el of slide.elements) {
      if (el.type !== 'text' || el.hidden || !el.html.trim()) continue
      const need = measure(el)
      const overflow = need - el.h
      if (overflow <= SLACK) continue
      const leftover = (why: string) => out.leftovers.push({
        slideId: slide.id, slide: i + 1, elementId: el.id, overflow: Math.round(overflow), why,
      })
      // a linked slide's slot takes its frame and type size from the slide
      // type on every resync — a local fix would silently revert
      if (owned.has(el.id)) { leftover('its frame and size come from the slide type'); continue }
      if (!el.rotation && tryGrow(doc, slide, el, need)) { out.grown++; continue }
      if (tryShrink(el, measure)) { out.shrunk++; continue }
      leftover(el.rotation
        ? 'rotated, and shrinking the text to fit would change it too much'
        : 'growing the box would cover other content or leave the slide, and shrinking the text to fit would change it too much')
    }
  })
  return out
}

/** Ids a linked slide's slide type supplies (frame + typography win there). */
function layoutOwnedIds(doc: SlidomingoDoc, slide: Slide): Set<string> {
  const layout = slide.layoutId ? doc.layouts?.find((l) => l.id === slide.layoutId) : undefined
  return new Set(layout ? effectiveLayout(doc, layout).elements.map((e) => e.id) : [])
}

/** The text's box-with-text partner: the shape the converter split it from
 *  (same groupId, same frame) — it grows with the text, as one PowerPoint
 *  shape would. */
function weldedPartners(slide: Slide, el: TextElement): SlideElement[] {
  if (!el.groupId) return []
  return slide.elements.filter((o) => o !== el && o.groupId === el.groupId && o.type === 'shape'
    && Math.abs(o.x - el.x) <= 2 && Math.abs(o.y - el.y) <= 2
    && Math.abs(o.w - el.w) <= 2 && Math.abs(o.h - el.h) <= 2)
}

/** Grow `el` (and its welded shape) to `need`, keeping its valign anchor —
 *  only when that stays on the slide and covers nothing it did not already
 *  cover. Applies and returns true, or leaves everything as it was. */
function tryGrow(doc: SlidomingoDoc, slide: Slide, el: TextElement, need: number): boolean {
  const delta = need - el.h
  const y = el.valign === 'bottom' ? el.y - delta : el.valign === 'middle' ? el.y - delta / 2 : el.y
  const grown: Frame = { x: el.x, y, w: el.w, h: need }
  if (grown.y < -SLACK || grown.y + grown.h > doc.size.height + SLACK) return false
  const before: Frame = { x: el.x, y: el.y, w: el.w, h: el.h }
  const partners = weldedPartners(slide, el)
  const skip = new Set<SlideElement>([el, ...partners])
  for (const o of slide.elements) {
    if (skip.has(o) || o.hidden || isFullBleed(o, doc)) continue
    if (contains(o, before)) continue // a card the text sits on
    if (intersects(grown, o) && !intersects(before, o)) return false
  }
  for (const target of [el, ...partners]) {
    target.y = round1(grown.y)
    target.h = Math.ceil(grown.h)
  }
  return true
}

/** Scale the type down (box size kept) until it fits, never below
 *  MIN_SHRINK. Run sizes inside the html scale with it. Applies and returns
 *  true, or leaves the element as it was. */
function tryShrink(el: TextElement, measure: (el: TextElement) => number): boolean {
  const fits = (k: number) => measure(scaled(el, k)) - el.h <= SLACK
  if (!fits(MIN_SHRINK)) return false
  // the largest scale that fits, to within half a percent
  let lo = MIN_SHRINK
  let hi = 1
  while (hi - lo > 0.005) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  const next = scaled(el, lo)
  el.fontSize = next.fontSize
  el.html = next.html
  return true
}

function scaled(el: TextElement, k: number): TextElement {
  return {
    ...el,
    fontSize: round1(el.fontSize * k),
    html: el.html.replace(/font-size:\s*([\d.]+)px/g, (_m, n: string) => `font-size:${round1(Number(n) * k)}px`),
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10

function intersects(a: Frame, b: Frame): boolean {
  return a.x < b.x + b.w - SLACK && b.x < a.x + a.w - SLACK && a.y < b.y + b.h - SLACK && b.y < a.y + a.h - SLACK
}

function contains(outer: Frame, inner: Frame): boolean {
  return outer.x <= inner.x + SLACK && outer.y <= inner.y + SLACK
    && outer.x + outer.w >= inner.x + inner.w - SLACK && outer.y + outer.h >= inner.y + inner.h - SLACK
}

// --- the AI work list --------------------------------------------------------

/**
 * Report codes a model can act on: content the converter replaced with a
 * placeholder, or approximated in a way the source XML (or a picture of the
 * original) says how to restore. Codes outside this list stay in the report
 * for the user to read and are never sent.
 */
export const REPAIRABLE = new Set([
  // placeholders — rebuild from the source part
  'graphic-dropped', 'chart-type-unsupported', 'chart-unreadable', 'chart-no-data', 'table-unreadable',
  // charts that lost something visible
  'chart-pie-extra-series', 'chart-secondary-axis-merged', 'chart-number-format-dropped',
  'chart-axis-title-dropped', 'chart-data-labels-dropped',
  // tables
  'table-merge-hidden-text', 'table-text-flattened', 'table-fill-flattened', 'table-style-unknown',
  // shapes, fills, pictures
  'shape-approximated', 'callout-approximated', 'picture-fill-dropped', 'fill-unsupported',
  'gradient-stroke-approximated', 'flip-dropped', 'connector-tip-dropped',
  // backgrounds
  'background-unresolved', 'background-image-dropped', 'background-approximated',
  // text: runs CAN carry their own size/colour (rich text spans) — the
  // converter just does not emit them yet
  'run-formatting-flattened',
  // NOT here: what the format cannot express at all, so no model can fix it
  // faithfully — paragraph-spacing-dropped, list-marker-approximated,
  // list-numbering-approximated, columns-approximated, table-borders-unified.
])

export interface RepairItem {
  /** 1-based deck position */
  slide: number
  slideId: string
  code: string
  /** the source shape, e.g. `sp "Diagram 4"`, when the report names one */
  shape?: string
  elementId?: string
  detail: string
  count: number
}

/** At most this many items are sent; the rest are counted. */
export const MAX_REPAIR_ITEMS = 60

/**
 * The work list for "Fix with Claude": REPAIRABLE report entries on slides
 * that still exist in `doc`, then the text the static pass left. Report
 * entries name SOURCE slides (`slide 4 / sp "Title 1"`); the importer gives
 * source slide n the id `s<n>`, which is how they are found again — so a
 * slide the user has deleted since simply drops out.
 */
export function repairItems(doc: SlidomingoDoc, report: FidelityReport, leftovers: TextLeftover[] = [], extra: RepairItem[] = []): RepairItem[] {
  const index = new Map(doc.slides.map((s, i) => [s.id, i + 1]))
  const items: RepairItem[] = []
  for (const e of report.entries) {
    if (e.verdict === 'carried' || !REPAIRABLE.has(e.code)) continue
    const m = /^slide (\d+)(?: \/ (.+))?$/.exec(e.where)
    if (!m) continue // a layout/master entry: slide types are not repaired here
    const slideId = `s${m[1]}`
    const slide = index.get(slideId)
    if (!slide) continue
    items.push({ slide, slideId, code: e.code, ...(m[2] ? { shape: m[2] } : {}), detail: e.detail, count: e.count })
  }
  for (const l of leftovers) {
    items.push({
      slide: l.slide, slideId: l.slideId, code: 'text-overflow', elementId: l.elementId, count: 1,
      detail: `text needs ${l.overflow}px more than its box — ${l.why}`,
    })
  }
  items.push(...extra)
  return items.sort((a, b) => a.slide - b.slide)
}
