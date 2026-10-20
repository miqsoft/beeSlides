// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Document validation — `window.beeslides.validate()`.
//
// WHY THIS EXISTS. Almost everything that goes wrong in a generated deck fails
// SILENTLY. A typo'd property is ignored, so the styling just does not apply. A
// dash-march loop on a solid stroke animates nothing. An entrance on a morph
// arrival never runs. Text overflows its box and the JSON looks perfect. An
// agent authoring a deck has no way to see any of it without rendering the
// result and looking at every slide — which is exactly what nobody does.
//
// So this reports, in one structured pass, the things the runtime would
// otherwise swallow. It only READS: it never mutates the document, and a
// finding is advice, not a refusal. `parseDoc` remains the thing that decides
// whether a document is loadable at all.
//
// Text overflow needs real layout, so it goes through measure.ts — the same
// path `window.beeslides.measure()` uses, which renders off-screen with the SAME
// renderer the editor and present mode use. One path means the validator and
// the measuring tool cannot disagree about whether a box fits its text. Without
// a DOM (node tooling) the measured checks are skipped and `measured` reports
// false, rather than guessing.

import type { SlidomingoDoc, Slide, SlideElement, StyleDefaults, TableElement, TextElement } from './model.ts'
import { cellText, tableLayout } from './tablespans.ts'
import { FOOTER_ROLES, STYLE_SHAPE_KINDS, extraParent, footerHidden } from './model.ts'
import { MODEL_KEYS } from './modelkeys.generated.ts'
import { measureElements } from './measure.ts'
import { texError } from './math.ts'
import { buildPlan } from './builds.ts'
import { eachRef, paletteOf, parseThemeRef, resolveRef, _readPath } from './palette.ts'
import type { ZoomElement } from './model.ts'
import { zoomFrameFor, zoomRange, zoomTargetLive, zoomTiles } from './model.ts'

export type Severity = 'error' | 'warning' | 'info'

export interface Finding {
  /** stable machine-readable code, e.g. 'text-overflow' */
  code: string
  severity: Severity
  /** one line, written to be actionable on its own */
  message: string
  /** slide id, when the finding belongs to a slide */
  slide?: string
  /** element id, when it belongs to an element */
  element?: string
  /** property path within the element/document, e.g. 'option.series[0].label' */
  path?: string
  /** slide-type id (a `doc.layouts` entry), when the finding is about that
   *  type's own chrome copied onto the slide — the fix belongs in the slide
   *  type, where it reaches every slide that uses it */
  layout?: string
}

export interface ValidateResult {
  ok: boolean
  /** false when there was no DOM, so overflow was not checked */
  measured: boolean
  counts: Record<Severity, number>
  findings: Finding[]
}

export interface ValidateOpts {
  /** measure text overflow (needs a DOM). Default true when one exists. */
  measure?: boolean
  /** side margin in px on a 1280-wide canvas; scaled to the deck. 0 disables. */
  margin?: number
}

/** The side margin `validateDoc`'s 'past-margin' check uses, in px on a
 *  1280-wide canvas — scaled to the deck's actual size by `marginFor`. Also
 *  the basis for the canvas's visual safe-zone guide (editor/canvas.ts), so
 *  the drawn guide and the linter can never disagree about where the margin
 *  falls. */
export const DEFAULT_MARGIN = 96

/** Scale `base` (px at a 1280-wide canvas, default `DEFAULT_MARGIN`) to this
 *  doc's actual width. `base` of 0 yields 0 (margin checking disabled). */
export function marginFor(doc: SlidomingoDoc, base: number = DEFAULT_MARGIN): number {
  return base * (doc.size.width / 1280)
}

/**
 * Chart option keys charts-lite implements (kernel/src/charts.ts). Anything
 * else in an `option` is ignored at render time with no warning — the engine
 * reads the ECharts option SHAPE, it is not ECharts.
 *
 * Kept deliberately close to the renderer: `label` is listed for pie only,
 * because `renderPie` is the sole reader of it and a `label` on a bar or line
 * series genuinely does nothing.
 */
const CHART_KEYS = {
  top: ['color', 'series', 'xAxis', 'yAxis', 'legend', 'grid', 'tooltip', 'textStyle', 'dataZoom'],
  series: ['type', 'name', 'data', 'yAxisIndex', 'itemStyle'],
  seriesByType: {
    // `stack` piles bars and lines/areas (charts.ts stackBars / stackLines)
    bar: ['barWidth', 'stack'],
    line: ['smooth', 'symbol', 'symbolSize', 'lineStyle', 'areaStyle', 'stack'],
    scatter: ['symbol', 'symbolSize'],
    pie: ['radius', 'label'],
  } as Record<string, string[]>,
  // `inverse` is read on a horizontal chart's category (y) axis
  axis: ['type', 'data', 'min', 'max', 'axisLabel', 'axisLine', 'splitLine', 'name', 'inverse'],
  legend: ['show', 'top', 'bottom', 'textStyle', 'itemWidth', 'itemHeight', 'itemGap', 'data'],
}

/**
 * Families a viewer's machine can be expected to resolve without the document
 * carrying the bytes — generics, the CSS system keywords, and the faces that
 * ship with mainstream desktop operating systems.
 *
 * Anything else named FIRST in a stack, and not in `doc.fonts`, is a face the
 * document is asking for and does not have. On the author's machine that
 * usually looks fine, because the author is exactly the person who has the
 * typeface installed; everyone else silently gets the next entry in the stack.
 * Two gallery templates shipped that way for months.
 */
const SYSTEM_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
  '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica',
  'helvetica neue', 'arial', 'arial black', 'verdana', 'tahoma', 'trebuchet ms',
  'georgia', 'times', 'times new roman', 'palatino', 'garamond', 'book antiqua',
  'courier', 'courier new', 'menlo', 'monaco', 'consolas', 'sf mono',
  'liberation mono', 'lucida console', 'impact', 'comic sans ms', 'cambria',
  'calibri', 'candara', 'optima', 'futura', 'gill sans', 'avenir', 'avenir next',
  'noto sans', 'noto serif', 'dejavu sans', 'pt sans', 'pt serif', 'emoji',
])

/** The first family in a CSS font stack, unquoted and lowercased. */
function firstFamily(stack: string): string {
  const first = stack.split(',')[0]?.trim() ?? ''
  return first.replace(/^['"]|['"]$/g, '').trim().toLowerCase()
}

const morphKey = (el: SlideElement) => el.morphId || el.id

/**
 * Small chrome — page numerals, running heads, corner labels. These live in
 * the margin ON PURPOSE, so flagging them for it is pure noise; the margin
 * guideline is about the body content that has to look aligned.
 */
export const isFurniture = (el: SlideElement, doc: SlidomingoDoc) =>
  el.w * el.h < doc.size.width * doc.size.height * 0.03

/** A backdrop: spans (nearly) the whole canvas in one direction, so margins,
 *  and the layout guard's reflow, do not apply to it. */
export const isFullBleed = (el: SlideElement, doc: SlidomingoDoc) =>
  el.w >= doc.size.width * 0.9 || el.h >= doc.size.height * 0.9

/** Slides reached by a morph transition, forward or backward out of one. */
function morphArrivals(doc: SlidomingoDoc): Map<string, Slide | undefined> {
  const out = new Map<string, Slide | undefined>()
  doc.slides.forEach((s, i) => {
    if (s.transition === 'morph' && i > 0) out.set(s.id, doc.slides[i - 1])
  })
  return out
}

export function validateDoc(doc: SlidomingoDoc, opts: ValidateOpts = {}): ValidateResult {
  const findings: Finding[] = []
  const add = (f: Finding) => findings.push(f)

  const hasDom = typeof document !== 'undefined'
  const measure = (opts.measure ?? true) && hasDom
  const marginBase = opts.margin ?? DEFAULT_MARGIN
  const margin = marginFor(doc, marginBase)
  const slideIds = new Set(doc.slides.map((s) => s.id))
  const assets = doc.assets ?? {}
  const arrivals = morphArrivals(doc)
  // Every slide any element can jump to. A hidden slide is reachable ONLY this
  // way, so one with no inbound link is in the file and in nobody's path.
  const linkTargets = new Set<string>()
  for (const sl of doc.slides) for (const el of sl.elements) if (el.link) linkTargets.add(el.link)
  // …or by zooming into it: every slide a zoom tile plays counts, hidden ones included
  for (const { el } of zoomTiles(doc)) {
    const r = zoomRange(doc, el)
    if (r) for (let i = r.start; i < r.end; i++) linkTargets.add(doc.slides[i].id)
  }
  // slide-type chrome is copied onto every linked slide under the type's own
  // element ids; an accessibility gap in it is ONE fix (in the slide type), so
  // it is reported once, on the first slide that shows it — see chromeOwner
  const licenseSeen = new Set<string>()
  const layoutEls = new Map<string, { layout: Slide; el: SlideElement }>()
  for (const ly of doc.layouts ?? []) {
    for (const el of ly.elements) if (!layoutEls.has(el.id)) layoutEls.set(el.id, { layout: ly, el })
  }
  const a11ySeen = new Set<string>()
  const a11yCtx: A11yContext = {
    chromeOwner: (el) => chromeOwner(el, layoutEls),
    firstTime: (key) => { if (a11ySeen.has(key)) return false; a11ySeen.add(key); return true },
  }

  // ---- document level ------------------------------------------------------
  for (const k of Object.keys(doc)) {
    if (!(MODEL_KEYS.doc as readonly string[]).includes(k)) {
      add({ code: 'unknown-key', severity: 'warning', path: k,
        message: `Document key "${k}" is not part of the BeeSlides document format — it is ignored at render time.` })
    }
  }
  for (const f of doc.fonts ?? []) {
    if (f.asset && !assets[f.asset]) {
      add({ code: 'missing-asset', severity: 'error', path: `fonts.${f.family}`,
        message: `Font "${f.family}" points at asset "${f.asset}", which is not in doc.assets — the face will not load and text falls back silently.` })
    }
  }
  const embedded = new Set((doc.fonts ?? []).map((f) => f.family.trim().toLowerCase()))
  const seenFallback = new Set<string>()
  const checkFamily = (stack: string | undefined, where: Omit<Finding, 'code' | 'severity' | 'message'>) => {
    if (!stack) return
    const fam = firstFamily(stack)
    if (!fam || embedded.has(fam) || SYSTEM_FAMILIES.has(fam)) return
    // one finding per family — a deck sets the same stack on 40 elements
    if (seenFallback.has(fam)) return
    seenFallback.add(fam)
    add({ ...where, code: 'font-not-embedded', severity: 'info',
      message: `"${stack.split(',')[0].trim()}" is not in doc.fonts, so it renders only for viewers who happen to have it installed — everyone else silently gets the next family in the stack. Embed the woff2 in doc.assets and declare it in doc.fonts.` })
  }
  checkFamily(doc.theme?.fontFamily, { path: 'theme.fontFamily' })
  checkFamily(doc.theme?.headingFamily, { path: 'theme.headingFamily' })

  // ---- brand palette references --------------------------------------------
  // A `themeRefs` entry says a colour came from a palette slot, so editing the
  // palette rewrites it. Both failures here are silent: a ref nobody can
  // resolve simply never updates, and a literal that disagrees with its ref is
  // about to be overwritten by the next palette edit — which looks like the
  // app changing a colour on its own.
  {
    const palette = paletteOf(doc)
    eachRef(doc, ({ slide, element, path, token }) => {
      const at = { slide: slide.id, ...(element ? { element: element.id } : {}) }
      const parsed = parseThemeRef(token)
      if (!parsed) {
        add({ ...at, code: 'theme-ref-malformed', severity: 'warning', path: `themeRefs.${path}`,
          message: `"${token}" is not a palette reference — expected a slot name, optionally with a shift like "accent1 -20%". The colour is left as it is and will not follow the palette.` })
        return
      }
      if (!palette[parsed.slot]) {
        add({ ...at, code: 'theme-ref-unknown-slot', severity: 'warning', path: `themeRefs.${path}`,
          message: `Palette slot "${parsed.slot}" is empty, so this colour will not follow the palette. Set it in the theme, or drop the reference.` })
        return
      }
      const want = resolveRef(token, palette)
      const have = _readPath(element ?? slide, path)
      if (typeof have !== 'string') {
        add({ ...at, code: 'theme-ref-dangling', severity: 'warning', path: `themeRefs.${path}`,
          message: `There is no colour at "${path}" for this reference to control — it does nothing. Remove it, or restore the property.` })
      } else if (want && have.toLowerCase() !== want.toLowerCase()) {
        add({ ...at, code: 'theme-ref-stale', severity: 'info', path,
          message: `This colour is ${have} but its reference "${token}" resolves to ${want}, so the next palette change will replace it. If ${have} was deliberate, clear the reference.` })
      }
    })
  }

  // ---- default styles (slide types + deck) ---------------------------------
  // Only read when an object is created, so a typo here fails quietly: the
  // new object just gets the inherited look. Report keys the format lacks.
  {
    const unknownIn = (obj: unknown, known: readonly string[], path: string, slide?: string) => {
      if (!obj || typeof obj !== 'object') return
      for (const k of Object.keys(obj)) {
        if (!known.includes(k)) {
          add({ code: 'unknown-key', severity: 'warning', ...(slide ? { slide } : {}), path: `${path}.${k}`,
            message: `"${k}" is not a default-style field here — it is ignored, so new objects keep the inherited look.` })
        }
      }
    }
    const checkDefaults = (sd: StyleDefaults | undefined, path: string, slide?: string) => {
      if (!sd) return
      unknownIn(sd, MODEL_KEYS.styleDefaults, path, slide)
      unknownIn(sd.shape, MODEL_KEYS.shapeStyle, `${path}.shape`, slide)
      unknownIn(sd.shapes, STYLE_SHAPE_KINDS, `${path}.shapes`, slide)
      for (const [kind, st] of Object.entries(sd.shapes ?? {})) unknownIn(st, MODEL_KEYS.shapeStyle, `${path}.shapes.${kind}`, slide)
      unknownIn(sd.line, MODEL_KEYS.lineStyle, `${path}.line`, slide)
      unknownIn(sd.text, MODEL_KEYS.textStyle, `${path}.text`, slide)
      checkFamily(sd.text?.fontFamily, { ...(slide ? { slide } : {}), path: `${path}.text.fontFamily` })
    }
    checkDefaults(doc.theme?.styleDefaults, 'theme.styleDefaults')
    for (const ly of doc.layouts ?? []) checkDefaults(ly.styleDefaults, 'styleDefaults', ly.id)
  }

  for (const slide of doc.slides) {
    const sid = slide.id
    const prev = arrivals.get(sid)
    const isMorphArrival = arrivals.has(sid)
    const partners = new Set((prev?.elements ?? []).map(morphKey))
    const seenIds = new Set<string>()
    const seenMorph = new Map<string, string>()
    const elsOnSlide = new Set(slide.elements.map((e) => e.id))

    for (const k of Object.keys(slide)) {
      if (!(MODEL_KEYS.slide as readonly string[]).includes(k)) {
        add({ code: 'unknown-key', severity: 'warning', slide: sid, path: k,
          message: `Slide key "${k}" is not part of the format — it is ignored.` })
      }
    }
    // A hidden slide after a normal slide is that slide's "extra" (X while
    // presenting), so only one with no slide before it AND no link is lost.
    if (slide.hidden && !slide.stateOf && !linkTargets.has(sid) && extraParent(doc, doc.slides.indexOf(slide)) === -1) {
      add({ code: 'unreachable-hidden-slide', severity: 'info', slide: sid, path: 'hidden',
        message: `Hidden with no slide before it to press X on, and nothing links to it — this slide cannot be reached at all while presenting. Move it after a visible slide (X opens it there), give an element a link to it, or unhide it.` })
    }
    if (slide.layoutId && doc.layouts?.find((l) => l.id === slide.layoutId)?.parentOnly) {
      add({ code: 'parent-only-type', severity: 'info', slide: sid, path: 'layoutId',
        message: `Follows "${slide.layoutId}", a master (parentOnly) — it still works, but the slide-type pickers never offer a master. Relink it to one of the master's children.` })
    }
    if (slide.autoBuild) {
      const ab = slide.autoBuild
      if (!(ab.every > 0)) {
        add({ code: 'bad-auto-build', severity: 'warning', slide: sid, path: 'autoBuild.every',
          message: `autoBuild.every must be a positive number of seconds — it is ${JSON.stringify(ab.every)}, so the slide will not play by itself.` })
      } else if (!buildPlan(slide).steps.length && !ab.loop) {
        add({ code: 'auto-build-nothing', severity: 'info', slide: sid, path: 'autoBuild',
          message: `This slide plays its builds automatically but has none (no fx.step / exitStep / byParagraph) and does not loop — autoBuild changes nothing here.` })
      }
    }
    if (slide.stateOf && !slideIds.has(slide.stateOf)) {
      add({ code: 'broken-state-parent', severity: 'error', slide: sid, path: 'stateOf',
        message: `stateOf points at "${slide.stateOf}", which is not a slide in this deck — the state is unreachable.` })
    }

    for (const el of slide.elements) {
      const at = { slide: sid, element: el.id }

      // identity ---------------------------------------------------------
      if (seenIds.has(el.id)) {
        add({ ...at, code: 'duplicate-id', severity: 'error',
          message: `Two elements on this slide share the id "${el.id}" — selection, morph and comment anchors all key off it.` })
      }
      seenIds.add(el.id)
      const mk = morphKey(el)
      const clash = seenMorph.get(mk)
      if (clash && clash !== el.id) {
        add({ ...at, code: 'morph-key-collision', severity: 'error', path: 'morphId',
          message: `Morph key "${mk}" is used by both "${clash}" and "${el.id}" on this slide — morph pairs by that key, so one of them will not tween.` })
      }
      seenMorph.set(mk, el.id)

      // unknown keys -------------------------------------------------------
      const known = (MODEL_KEYS.element as Record<string, readonly string[]>)[el.type]
      if (known) {
        for (const k of Object.keys(el)) {
          if (!known.includes(k)) {
            add({ ...at, code: 'unknown-key', severity: 'warning', path: k,
              message: `"${k}" is not a property of a ${el.type} element — it is ignored, so whatever it was meant to do will not happen.` })
          }
        }
      }
      if (el.type === 'text' && el.footerRole !== undefined && !(FOOTER_ROLES as readonly unknown[]).includes(el.footerRole)) {
        add({ ...at, code: 'unknown-footer-role', severity: 'warning', path: 'footerRole',
          message: `footerRole "${String(el.footerRole)}" is not one of ${FOOTER_ROLES.join(', ')} — Header & footer will not switch this text.` })
      }
      if (el.fx) {
        for (const k of Object.keys(el.fx)) {
          if (!(MODEL_KEYS.fx as readonly string[]).includes(k)) {
            add({ ...at, code: 'unknown-key', severity: 'warning', path: `fx.${k}`,
              message: `"fx.${k}" is not a known effect property — it is ignored.` })
          }
        }
      }

      // geometry -----------------------------------------------------------
      // Bleeding a shape or photo off the canvas is a deliberate idiom, and a
      // full-bleed backdrop is SUPPOSED to ignore the margin — so geometry is
      // only a warning for the element types that carry words, where going
      // past an edge means the reader loses some. For everything else it is
      // recorded at 'info' and stays out of the way.
      const carriesText = el.type === 'text' || el.type === 'table' || el.type === 'math'
      const right = el.x + el.w
      const bottom = el.y + el.h
      const fullBleed = isFullBleed(el, doc)
      if (right > doc.size.width || bottom > doc.size.height || el.x < 0 || el.y < 0) {
        add({ ...at, code: 'out-of-canvas', severity: carriesText ? 'warning' : 'info',
          message: carriesText
            ? `Extends outside the ${doc.size.width}x${doc.size.height} canvas (x ${el.x}-${right}, y ${el.y}-${bottom}) — the text past the edge is cropped when presenting.`
            : `Extends outside the ${doc.size.width}x${doc.size.height} canvas (x ${el.x}-${right}, y ${el.y}-${bottom}) — fine as a deliberate bleed, cropped either way.` })
      // A few px inside the margin is an optical adjustment, not crowding —
      // large type is routinely nudged left to hang its side bearing. Only
      // flag content that misses the margin by an amount a reader would see.
      } else if (carriesText && !fullBleed && margin > 0 && !isFurniture(el, doc)
        && (el.x < margin * 0.9 || right > doc.size.width - margin * 0.9)) {
        add({ ...at, code: 'past-margin', severity: 'info',
          message: `Reaches past the ${Math.round(margin)}px side margin (x ${el.x}-${right}) — the deck's other content stops short of it.` })
      }

      // effects that will not run -------------------------------------------
      // Only a MORPHING element loses its entrance: it is already travelling
      // from its previous-slide frame, and an entrance tween would fight that.
      // An element with no partner on the previous slide runs its fx.enter
      // normally, so there is nothing to report.
      if (el.fx?.enter && isMorphArrival && partners.has(mk)) {
        add({ ...at, code: 'overridden-enter-fx', severity: 'warning', path: 'fx.enter',
          message: `This element morphs in from the previous slide, so it is already in motion and fx.enter is skipped. Give it a morph key that is new to this slide if you want it to enter instead.` })
      }
      if (el.fx?.enter && el.fx?.loop?.type === 'motion-path') {
        add({ ...at, code: 'entrance-on-motion-path', severity: 'warning', path: 'fx.enter',
          message: `An entrance tween and a motion-path loop fight over the same transform — the element can freeze off its path. Use one or the other.` })
      }
      if (el.fx?.countUp && isMorphArrival && partners.has(mk)) {
        add({ ...at, code: 'inert-countup', severity: 'info', path: 'fx.countUp',
          message: `This element morphs in from the previous slide already showing its number, so the count-up is skipped by design. Give it a morph key that is new to this slide if you want it to count.` })
      }
      // click builds ---------------------------------------------------------
      // A morphing element is already travelling in from the previous slide, so
      // a click that "brings it in" would pop it in after the morph had shown it.
      if (el.fx?.step && isMorphArrival && partners.has(mk)) {
        add({ ...at, code: 'step-on-morph', severity: 'warning', path: 'fx.step',
          message: `This element morphs in from the previous slide, so it is already on screen when the slide arrives — fx.step then hides it only until its click and the morph is wasted. Give it a morph key that is new to this slide, or drop the step.` })
      }
      for (const key of ['step', 'exitStep'] as const) {
        const v = el.fx?.[key]
        if (v !== undefined && !(Number.isInteger(v) && v >= 0)) {
          add({ ...at, code: 'bad-step', severity: 'warning', path: `fx.${key}`,
            message: `fx.${key} is ${JSON.stringify(v)} — it must be a whole number of clicks (1 = the first click).` })
        }
      }
      if (el.fx?.exitStep && el.fx.exitStep <= (el.fx.step ?? 0)) {
        add({ ...at, code: 'exit-before-enter', severity: 'warning', path: 'fx.exitStep',
          message: `exitStep ${el.fx.exitStep} is not after step ${el.fx.step ?? 0} — the element would leave before (or as) it arrives, so the exit is ignored.` })
      }
      if (el.fx?.byParagraph && el.type !== 'text') {
        add({ ...at, code: 'by-paragraph-not-text', severity: 'warning', path: 'fx.byParagraph',
          message: `fx.byParagraph only splits TEXT elements into clicks; on a ${el.type} it does nothing.` })
      }
      if (el.fx?.step && el.showOnHover) {
        add({ ...at, code: 'step-on-hover-set', severity: 'info', path: 'fx.step',
          message: `Hover-revealed content is shown by pointer, never by a click — fx.step is ignored on it.` })
      }
      // two loops fighting for one transform channel: pulse and ken-burns both
      // drive `scale`, and the engine lets the newer tween kill the older, so
      // one of them silently never plays
      if (el.fx?.loop?.type === 'pulse' && el.fx.ambient === 'kenburns') {
        add({ ...at, code: 'loop-scale-clash', severity: 'warning', path: 'fx.loop',
          message: `A pulse loop and the Ken Burns zoom both animate scale on the same element — only one of them plays. Use one, or pulse a different element.` })
      }
      if (el.fx?.loop && ['pulse', 'spin', 'float', 'blink', 'wiggle'].includes(el.fx.loop.type)
        && (el.type === 'shape' && el.shape === 'line')) {
        add({ ...at, code: 'loop-on-line', severity: 'info', path: 'fx.loop',
          message: `A ${el.fx.loop.type} loop rotates/scales the line's box, which is a thin strip — it will look odd. Loops read best on a filled shape, text or picture.` })
      }
      if (el.fx?.loop?.type === 'dash-march') {
        const dashed = el.type === 'shape' && (el.strokeStyle === 'dashed' || el.strokeStyle === 'dotted')
        // a line paints its stroke with `fill` (render.ts), other shapes with `stroke`
        const stroked = el.type === 'shape' && (el.shape === 'line'
          ? !!el.fill && el.fill !== 'transparent'
          : !!el.stroke && el.stroke !== 'transparent' && (el.strokeWidth ?? 0) > 0)
        if (!dashed || !stroked) {
          add({ ...at, code: 'dash-march-no-dash', severity: 'warning', path: 'fx.loop',
            message: `A dash-march loop animates strokeDashoffset, so it needs a visible stroke AND strokeStyle "dashed" or "dotted". As set, the tween runs and nothing moves.` })
        }
      }

      // references -----------------------------------------------------------
      if (el.link && !slideIds.has(el.link)) {
        add({ ...at, code: 'broken-link', severity: 'error', path: 'link',
          message: `Links to slide "${el.link}", which does not exist — clicking it does nothing.` })
      }
      if (el.type === 'zoom') validateZoom(doc, slide, el, at, add)
      for (const [side, end] of [['from', (el as any).from], ['to', (el as any).to]] as const) {
        if (end?.el && !elsOnSlide.has(end.el)) {
          add({ ...at, code: 'dangling-connector', severity: 'warning', path: side,
            message: `Connector ${side} references element "${end.el}", which is not on this slide — that end is dropped and stops following.` })
        }
      }
      for (const key of ['src', 'asset', 'poster'] as const) {
        const ref = (el as any)[key]
        if (typeof ref === 'string' && ref.startsWith('asset:') && !assets[ref.slice(6)]) {
          add({ ...at, code: 'missing-asset', severity: 'error', path: key,
            message: `${key} references asset "${ref.slice(6)}", which is not in doc.assets — nothing renders.` })
        }
      }

      // artwork whose origin is recorded but not its terms. Only a present
      // `provenance` is judged: a picture someone pasted or drew says nothing,
      // and guessing at it would teach people to ignore the list. Slide-type
      // chrome shares its element id across every linked slide, so it is one
      // finding, on the first slide that shows it.
      if ((el.type === 'image' || el.type === 'svg' || el.type === 'shape') && el.provenance && typeof el.provenance === 'object'
          && !(typeof el.provenance.license === 'string' && el.provenance.license.trim())
          && !licenseSeen.has(el.id)) {
        licenseSeen.add(el.id)
        const from = typeof el.provenance.origin === 'string' && el.provenance.origin.trim() ? ` from "${el.provenance.origin.trim()}"` : ''
        add({ ...at, code: 'unlicensed-artwork', severity: 'info', path: 'provenance.license',
          message: `This ${el.type} came${from} but no license is recorded for it, so nobody can tell whether it may be used here. Set provenance.license (an SPDX id such as "CC0-1.0", or a phrase like "Company-owned"), or replace it with artwork you can vouch for.` })
      }

      if (el.type === 'text') checkFamily((el as TextElement).fontFamily, at)

      // charts ---------------------------------------------------------------
      if (el.type === 'chart' && el.option) validateChart(el.option as any, at, add)

      // tables ---------------------------------------------------------------
      if (el.type === 'table' && Array.isArray(el.rows) && Array.isArray(el.columns)) validateTableSpans(el, at, add)

      // equations ------------------------------------------------------------
      if (el.type === 'math') {
        const tex = typeof el.tex === 'string' ? el.tex : ''
        const err = tex.trim() ? texError(tex) : null
        if (!tex.trim()) {
          add({ ...at, code: 'math-empty', severity: 'warning', path: 'tex',
            message: `The equation has no TeX — it shows a placeholder in the editor and nothing while presenting.` })
        } else if (err) {
          add({ ...at, code: 'math-parse-error', severity: 'error', path: 'tex',
            message: `The TeX does not typeset (${err}) — the slide shows the raw source instead of the formula.` })
        }
      }
    }

    checkAccessibility(doc, slide, add, a11yCtx)
  }

  // ---- measured checks -----------------------------------------------------
  if (measure) measureOverflow(doc, add)

  const counts = { error: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  return { ok: counts.error === 0, measured: measure, counts, findings }
}

// ---- zoom tiles ------------------------------------------------------------
//
// A tile whose target is gone, or that would play nothing, fails silently in
// the show: the click does nothing. These three say why.

function validateZoom(doc: SlidomingoDoc, slide: Slide, el: ZoomElement, at: { slide: string; element: string },
  add: (f: Finding) => void) {
  const t = el.target as { slide?: unknown; section?: unknown } | undefined
  if (!zoomTargetLive(doc, el)) {
    const what = typeof t?.slide === 'string' ? `slide "${t.slide}"` : typeof t?.section === 'string' ? `section "${t.section}"` : 'nothing'
    add({ ...at, code: 'zoom-missing-target', severity: 'error', path: 'target',
      message: `This zoom tile points at ${what}, which is not in this deck — it shows an empty box and clicking it does nothing. Pick a slide or section for it.` })
    return
  }
  const target = typeof t?.slide === 'string' ? doc.slides.find((s) => s.id === t.slide) : undefined
  if (target?.stateOf) {
    add({ ...at, code: 'zoom-target-state', severity: 'warning', path: 'target',
      message: `This zoom tile targets an interactive state, which a zoom never walks into — clicking it does nothing. Target the state's parent slide instead.` })
    return
  }
  if (!zoomFrameFor(doc, doc.slides.indexOf(slide), el)) {
    add({ ...at, code: 'zoom-self-target', severity: 'warning', path: 'target',
      message: `This zoom tile only reaches the slide it sits on, so there is nothing to zoom into. Point it at another slide or section.` })
  }
}

// ---- accessibility ---------------------------------------------------------
//
// Three checks a person can act on from the canvas, written to stay QUIET
// whenever the answer is not certain — a false "this is unreadable" teaches
// people to ignore the whole list:
//
//  · missing-alt   an image / svg / chart / media with no `alt` at all. The
//                  empty string is an answer (decorative) and is never flagged.
//  · low-contrast  text against what is actually behind it, by the WCAG 2.x
//                  ratio: < 4.5:1, or < 3:1 for large text (≥ 24px, or ≥ 18.66px
//                  at weight ≥ 700 — WCAG's 18pt / 14pt bold, in slide px).
//                  "Behind it" is the slide's flat background plus any solid,
//                  unrotated rectangles that fully cover the text box. The
//                  moment anything else is involved — a gradient or picture
//                  background, a photo / chart / partially covering shape under
//                  the text, gradient or outlined text, inline colour spans, a
//                  blend mode — the colours cannot be resolved and the check
//                  says nothing.
//  · missing-title a slide with no TITLE: a text element with role "title"
//                  holding written text. Role, not position or size, because the
//                  role is what slide types, the outline and an exported title
//                  placeholder key on, and it is what the author can set (the
//                  Role select). To keep blank, picture-only, section-divider
//                  and one-statement slides quiet, a slide with no title slot
//                  is flagged only when it carries TWO or more pieces of
//                  written body text; an EMPTY title slot is flagged as soon as
//                  the slide has any written text. Interactive states
//                  (stateOf) share their parent's title and are skipped, and
//                  figure documents (one canvas, not slides) are never checked.

type Rgba = [number, number, number, number]

const NAMED_COLORS: Record<string, Rgba> = {
  white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0],
}

/** A flat CSS colour → [r, g, b, a] (0-255, alpha 0-1), or null when it is
 *  not one this can read for certain (a gradient, a var(), an unknown name,
 *  a colour space other than sRGB). Exported for the rig. */
export function parseCssColor(v: string | undefined | null): Rgba | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (!s) return null
  if (NAMED_COLORS[s]) return [...NAMED_COLORS[s]] as Rgba
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
  }
  const alpha = (a: string | undefined) => {
    if (a === undefined) return 1
    const x = a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a)
    return Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : NaN
  }
  const fn = /^(rgba?|color)\(\s*([^)]*)\)$/.exec(s)
  if (!fn) return null
  let parts = fn[2].split(/[\s,/]+/).filter(Boolean)
  if (fn[1] === 'color') {
    if (parts[0] !== 'srgb') return null
    parts = parts.slice(1)
    if (parts.length < 3 || parts.length > 4) return null
    const rgb = parts.slice(0, 3).map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p)) * 255)
    const out = [...rgb, alpha(parts[3])] as Rgba
    return out.every(Number.isFinite) ? out : null
  }
  if (parts.length < 3 || parts.length > 4) return null
  const rgb = parts.slice(0, 3).map((p) => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p)))
  const out = [...rgb.map((c) => Math.min(Math.max(c, 0), 255)), alpha(parts[3])] as Rgba
  return out.every(Number.isFinite) ? out : null
}

/** `top` (with its own alpha) painted over an opaque `under`. */
const over = (top: Rgba, under: Rgba): Rgba => {
  const a = top[3]
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1) as Rgba
}

/** WCAG 2.x relative luminance of an opaque sRGB colour. */
function luminance([r, g, b]: Rgba): number {
  const ch = (c: number) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

/** WCAG contrast ratio of two opaque colours, 1 … 21. Exported for the rig. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const hexOf = (c: Rgba) => '#' + c.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase()

/** Written text of an element's html: tags out, entities that are only
 *  spacing out. Regex, not DOMParser — validate() runs without a DOM. */
const writtenText = (html: string | undefined) =>
  (html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/\s+/g, ' ').trim()

const DESCRIBABLE = new Set(['image', 'svg', 'chart', 'media'])

/** What an element shows, as opposed to where it sits — the keys a copy of
 *  a slide-type element must share with it to still BE that element. */
const CONTENT_KEYS = ['type', 'src', 'asset', 'markup', 'option', 'kind', 'poster', 'html', 'color'] as const
const contentOf = (el: SlideElement) =>
  JSON.stringify(CONTENT_KEYS.map((k) => (el as unknown as Record<string, unknown>)[k] ?? null))

interface A11yContext {
  /** the slide type `el` is unchanged chrome of, if it is */
  chromeOwner(el: SlideElement): Slide | undefined
  /** true the first time `key` is seen in this validate run */
  firstTime(key: string): boolean
}

/**
 * The slide type whose own, unchanged chrome `el` is — a logo or footer
 * strip copied verbatim onto every linked slide — or undefined. A slot for
 * CONTENT is never chrome even though it keeps the layout's id: a filled
 * `role:'media'` slot adopts the slide's own picture under the slot's id
 * (model.ts applyLayout), and every title/body placeholder keeps its id
 * while holding that slide's text. So: no role on either side, not a text
 * placeholder, and the same content as the slide type's element. A copy
 * whose slide-type original is already described is stale, not chrome
 * (it is fixed on the slide, or by the next resync).
 */
function chromeOwner(el: SlideElement, layoutEls: Map<string, { layout: Slide; el: SlideElement }>): Slide | undefined {
  const own = layoutEls.get(el.id)
  if (!own || el.role || own.el.role) return undefined
  if ((el.type === 'text' && el.placeholder) || (own.el.type === 'text' && own.el.placeholder)) return undefined
  if (contentOf(el) !== contentOf(own.el)) return undefined
  if (DESCRIBABLE.has(el.type) && typeof (own.el as { alt?: unknown }).alt === 'string') return undefined
  return own.layout
}

/**
 * The opaque colour behind `el`'s whole box, or null if it cannot be known
 * for certain. Walks DOWN the stack from just under the text: transparent
 * things and other text are looked through; a solid, unrotated rectangle that
 * covers the whole box is a layer (composited with whatever shows through its
 * alpha); anything else that overlaps the box makes the answer unknowable.
 */
function backdropOf(slide: Slide, el: TextElement): Rgba | null {
  const layers: Rgba[] = []
  const idx = slide.elements.indexOf(el)
  const x1 = el.x, y1 = el.y, x2 = el.x + el.w, y2 = el.y + el.h
  let base: Rgba | null = null
  for (let i = idx - 1; i >= 0; i--) {
    const u = slide.elements[i]
    if (u.hidden) continue
    const overlaps = u.x < x2 && u.x + u.w > x1 && u.y < y2 && u.y + u.h > y1
    if (!overlaps || u.type === 'text') continue
    if (u.type !== 'shape') return null
    // a line across the text is a decoration, not a backdrop (render.ts paints
    // a line with `fill`, so its fill says nothing about an interior)
    if (u.shape === 'line') continue
    const unfilled = !u.fillGradient && (!u.fill || u.fill === 'none' || parseCssColor(u.fill)?.[3] === 0)
    if (unfilled || (u.opacity ?? 1) === 0) continue // outline-only: look through it
    const fill = u.fillGradient ? null : parseCssColor(u.fill)
    if (!fill) return null
    const a = fill[3] * (u.opacity ?? 1)
    const covers = u.x <= x1 + 1 && u.y <= y1 + 1 && u.x + u.w >= x2 - 1 && u.y + u.h >= y2 - 1
    if (u.shape !== 'rect' || u.rotation || u.blend || u.backdropFilter || !covers) return null
    const layer: Rgba = [fill[0], fill[1], fill[2], a]
    if (a >= 1) { base = layer; break }
    layers.push(layer)
  }
  if (!base) {
    // only a FLAT slide background is a colour; a gradient or image is not
    const bg = typeof slide.background === 'string' && !/gradient|url\(/i.test(slide.background)
      ? parseCssColor(slide.background) : null
    if (!bg || bg[3] < 1) return null
    base = bg
  }
  for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base)
  return base
}

/** WCAG large text, from the element's own size and weight (slide px). */
const isLargeText = (el: TextElement) => el.fontSize >= 24 || (el.fontSize >= 18.66 && el.fontWeight >= 700)

function checkAccessibility(
  doc: SlidomingoDoc, slide: Slide, add: (f: Finding) => void, ctx: A11yContext,
) {
  const sid = slide.id
  const footerOff = footerHidden(doc, slide)
  for (const el of slide.elements) {
    if (el.hidden) continue
    const at = { slide: sid, element: el.id }

    if (DESCRIBABLE.has(el.type)) {
      const alt = (el as { alt?: unknown }).alt
      const described = typeof alt === 'string' && (alt === '' || alt.trim() !== '')
      const owner = described ? undefined : ctx.chromeOwner(el)
      if (!described && owner) {
        // one finding per slide-type element, pointing at the slide type:
        // alt typed on a slide's copy would be reset by the next resync
        if (ctx.firstTime(`alt|${el.id}`)) {
          add({ ...at, layout: owner.id, code: 'missing-alt', severity: 'info', path: 'alt',
            message: `This ${el.type} is part of slide type "${owner.name}" and repeats on every slide that uses it, and it has no text alternative. Set "alt" on the slide type's element (doc.layouts, id "${el.id}") — a short description, or "" if it is purely decorative — and it reaches every slide.` })
        }
      } else if (!described) {
        add({ ...at, code: 'missing-alt', severity: 'info', path: 'alt',
          message: `This ${el.type} has no text alternative, so a screen reader announces nothing useful (or a file name). Set "alt" to a short description of what it shows, or to "" if it is purely decorative.` })
      }
    }

    if (el.type === 'text') {
      if (el.footerRole && footerOff.has(el.footerRole)) continue
      if (!writtenText(el.html)) continue
      // things this cannot see through: a gradient fill, outlined-only glyphs,
      // inline colour runs, a blend mode or backdrop filter on the text itself
      if (el.colorGradient?.stops?.length || el.textStroke?.fill === 'none') continue
      if (/color\s*:|<font\b/i.test(el.html) || el.blend || el.backdropFilter) continue
      const fg = parseCssColor(el.color)
      if (!fg || fg[3] === 0) continue
      const bg = backdropOf(slide, el)
      if (!bg) continue
      const ink = over([fg[0], fg[1], fg[2], fg[3] * (el.opacity ?? 1)], bg)
      const ratio = contrastRatio(ink, bg)
      const large = isLargeText(el)
      const min = large ? 3 : 4.5
      // judged at two decimals, the way contrast tools report it — 4.499 is
      // "4.50:1" everywhere a person would check it
      // unchanged slide-type chrome on the same backdrop is one fix: report
      // it once; anything sitting in a slot is that slide's own text
      const failing = Math.round(ratio * 100) / 100 < min
      if (failing && (!ctx.chromeOwner(el) || ctx.firstTime(`contrast|${el.id}|${hexOf(ink)}|${hexOf(bg)}`))) {
        add({ ...at, code: 'low-contrast', severity: 'warning', path: 'color',
          message: `Text ${hexOf(ink)} on ${hexOf(bg)} has a contrast ratio of ${ratio.toFixed(2)}:1 — below the WCAG AA minimum of ${min}:1 for ${large ? 'large' : 'normal-size'} text, so it is hard to read for many viewers and on a projector. Darken or lighten the text, or what is behind it.` })
      }
    }
  }

  // ---- slide title
  if (doc.kind === 'figure' || doc.kind === 'iconset' || slide.stateOf) return
  const texts = slide.elements.filter((e): e is TextElement => e.type === 'text' && !e.hidden)
  const titles = texts.filter((e) => e.role === 'title')
  if (titles.some((e) => writtenText(e.html))) return
  const body = texts.filter((e) => e.role !== 'title' && !e.footerRole && !isFurniture(e, doc) && writtenText(e.html))
  if (titles.length && body.length >= 1) {
    add({ slide: sid, element: titles[0].id, code: 'missing-title', severity: 'info', path: 'html',
      message: `The slide's title placeholder is empty — the slide has no title for screen readers, the outline or an exported title. Write one into it.` })
  } else if (!titles.length && body.length >= 2) {
    add({ slide: sid, code: 'missing-title', severity: 'info', path: 'elements',
      message: `No text on this slide has role "title", so it has no title for screen readers, the outline or an exported title. Set role "title" on its heading, or add one.` })
  }
}

/** Report option keys charts-lite does not implement. */
/**
 * Merged cells (tablespans.ts) that do not say what they draw: a span the
 * grid clamps (past the edge, over another merged cell, on a cell that is
 * itself covered), and text in a covered cell, which is never shown. The
 * renderer copes with all of it silently — which is the problem.
 */
function validateTableSpans(
  el: TableElement,
  at: { slide: string; element: string },
  add: (f: Finding) => void,
) {
  const L = tableLayout(el)
  el.rows.forEach((row, r) => (Array.isArray(row?.cells) ? row.cells : []).forEach((cell, c) => {
    if (!cell || typeof cell !== 'object') return
    const path = `rows[${r}].cells[${c}]`
    const want = { cs: Math.max(1, Number(cell.colspan) || 1), rs: Math.max(1, Number(cell.rowspan) || 1) }
    const sp = L.span[r]?.[c]
    const owner = L.owner[r]?.[c]
    if (!sp && owner) {
      if (want.cs > 1 || want.rs > 1) {
        add({ ...at, code: 'table-span-clamped', severity: 'warning', path,
          message: `Cell (row ${r + 1}, column ${c + 1}) is covered by the merged cell at (row ${owner[0] + 1}, column ${owner[1] + 1}) — its own span is ignored.` })
      }
      if (cellText(String(cell.html ?? ''))) {
        add({ ...at, code: 'table-hidden-text', severity: 'warning', path: `${path}.html`,
          message: `Cell (row ${r + 1}, column ${c + 1}) is covered by the merged cell at (row ${owner[0] + 1}, column ${owner[1] + 1}) and holds text that is never shown.` })
      }
      return
    }
    if (sp && (sp.cs !== want.cs || sp.rs !== want.rs)) {
      add({ ...at, code: 'table-span-clamped', severity: 'warning', path,
        message: `Cell (row ${r + 1}, column ${c + 1}) asks to span ${want.rs}×${want.cs} cells but only ${sp.rs}×${sp.cs} fit (the table's edge or another merged cell) — drawn as ${sp.rs}×${sp.cs}.` })
    }
  }))
}

function validateChart(
  option: Record<string, any>,
  at: { slide: string; element: string },
  add: (f: Finding) => void,
) {
  const note = (path: string, what: string) =>
    add({ ...at, code: 'chart-key-ignored', severity: 'warning', path,
      message: `charts-lite does not implement ${what} — it is ignored, with no warning at render time.` })

  for (const k of Object.keys(option)) {
    if (!CHART_KEYS.top.includes(k)) note(`option.${k}`, `the top-level chart option "${k}"`)
  }
  const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : []
  series.forEach((s: any, i: number) => {
    if (!s || typeof s !== 'object') return
    const allowed = [...CHART_KEYS.series, ...(CHART_KEYS.seriesByType[s.type] ?? [])]
    for (const k of Object.keys(s)) {
      if (allowed.includes(k)) continue
      // the one people reach for most, and the one that reads as a bug
      if (k === 'label') {
        note(`option.series[${i}].label`,
          'value labels on a bar, line or scatter series (label is read for pie only)')
      } else {
        note(`option.series[${i}].${k}`, `"${k}" on a ${s.type ?? 'series'} series`)
      }
    }
  })
  for (const axis of ['xAxis', 'yAxis'] as const) {
    const list = Array.isArray(option[axis]) ? option[axis] : option[axis] ? [option[axis]] : []
    list.forEach((a: any, i: number) => {
      if (!a || typeof a !== 'object') return
      for (const k of Object.keys(a)) {
        if (!CHART_KEYS.axis.includes(k)) note(`option.${axis}[${i}].${k}`, `"${k}" on an axis`)
      }
    })
  }
  if (option.legend && typeof option.legend === 'object') {
    for (const k of Object.keys(option.legend)) {
      if (!CHART_KEYS.legend.includes(k)) note(`option.legend.${k}`, `"${k}" on the legend`)
    }
  }
}

/**
 * Measure every text element and report the ones that do not fit.
 *
 * Goes through measure.ts, the same path `window.beeslides.measure()` uses, so the
 * validator and the measuring tool can never disagree about whether a given
 * box fits its text — which they would within a release if each had its own
 * copy of the arithmetic.
 */
function measureOverflow(doc: SlidomingoDoc, add: (f: Finding) => void, slides: Slide[] = doc.slides) {
  // a placeholder with no content measures as one empty line — not overflow
  const targets: Array<{ slide: string; el: TextElement }> = []
  for (const slide of slides) {
    for (const el of slide.elements) {
      if (el.type === 'text' && el.html?.trim()) targets.push({ slide: slide.id, el })
    }
  }
  const measured = measureElements(targets.map((t) => t.el), doc)
  measured.forEach((m, i) => {
    const { slide, el } = targets[i]
    if (m.fits !== false || m.overflow! <= 1) return
    add({
      slide, element: el.id, code: 'text-overflow', severity: 'warning', path: 'h',
      message: `Text needs ${m.height}px but the box is ${el.h}px tall — it overflows by ${m.overflow}px (${m.lines} lines) and will collide with whatever is below it.`,
    })
  })
}

/** measureOverflow for one slide that validateDoc doesn't walk — a slide
 *  type or reusable object an agent just wrote (editor.ts warningsForSlide). */
export function overflowFindings(doc: SlidomingoDoc, slide: Slide): Finding[] {
  if (typeof document === 'undefined') return []
  const out: Finding[] = []
  measureOverflow(doc, (f) => out.push(f), [slide])
  return out
}
