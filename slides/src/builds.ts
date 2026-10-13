// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Click builds: the single source of truth for "what is on screen after click
// N" — shared by present mode, the speaker view, editor badges, validate and
// the pptx importer's tests. Pure: no DOM, no engine, nothing but the model.
//
// Model (all optional/additive on `ElementBase.fx`, see docs/DECISIONS.md):
//   step       the click that brings the element in (1 = first click);
//              absent/0 = with the slide
//   exitStep   the click that takes it out again
//   byParagraph  text only: paragraph k enters on click (step ?? 1) + k
// `fx.order` is NOT a build order — within one click it only staggers.
//
// Clicks are COMPRESSED: a deck that uses steps 1, 3 and 4 has three clicks,
// not four, so a gap (a deleted element, a pptx import) never costs the
// presenter a click that does nothing. `plan.steps[i]` is click i+1; `at` is
// the authored number it came from.

import type { Slide, SlideElement } from './model'

export interface BuildTarget {
  elId: string
  /** paragraph index inside a byParagraph text element */
  para?: number
}

export interface BuildStep {
  /** the authored step number this click came from (before compression) */
  at: number
  enter: BuildTarget[]
  exit: BuildTarget[]
}

export interface BuildPlan {
  steps: BuildStep[]
  /** elements that take their steps from byParagraph, with their paragraph count */
  paragraphs: Map<string, number>
}

export const targetKey = (t: BuildTarget): string => (t.para === undefined ? t.elId : `${t.elId}#${t.para}`)

// ——— paragraphs ————————————————————————————————————————————————————————————
// A text element's html is a flat run of inline text plus <div>/<p> blocks
// and <ul>/<ol> lists (the sanitizer allows nothing else). A paragraph is
// either one top-level block, one item of a top-level list (its nested
// sub-list rides along with it — PowerPoint's "by 1st level paragraphs"), or
// a run of inline content between top-level blocks / lists / <br>s. Blank
// ones (whitespace, &nbsp;, an empty <div><br></div> line) are not paragraphs:
// they would cost a click and show nothing. present.ts applies the SAME rule
// to the rendered DOM (`tagParagraphs`); keep the two in step.

const BLOCK = /^(div|p)$/i
const LIST = /^(ul|ol)$/i
const BLANK = /(?:&nbsp;|&#160;|\s| )+/g

/** Split text html into its paragraphs' markup (blank ones dropped). */
export function splitParagraphs(html: string): string[] {
  const out: string[] = []
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>|[^<]+|</g
  let depth = 0
  let list = 0 // ul/ol nesting (a list inside a line block is hoisted out on render)
  let start = -1 // offset where the current paragraph began
  let content = false // does the current paragraph show anything?
  let m: RegExpExecArray | null
  const flush = (end: number) => {
    if (start >= 0 && content) out.push(html.slice(start, end))
    start = -1
    content = false
  }
  while ((m = re.exec(html))) {
    const [tok, close, tag] = m
    const isTag = tok[0] === '<' && tag !== undefined
    if (!isTag) {
      if (tok.replace(BLANK, '')) {
        if (start < 0) start = m.index
        content = true
      } else if (start < 0 && depth === 0) {
        // leading whitespace between paragraphs: not part of any
      }
      continue
    }
    // A list counts at ANY block depth, not only the top level: the
    // sanitizer lifts a list out of the line div it sits in (render.ts
    // hoistLists), so `<div>a<ul>…</ul>b</div>` renders as a, the items, b —
    // the block's words before and after it are paragraphs of their own.
    // Inside a list, block tags never change `depth`, so it stays put.
    if (LIST.test(tag) && (list > 0 || !close)) {
      if (close) {
        list = Math.max(0, list - 1)
        if (list === 0) flush(m.index + tok.length)
      } else {
        if (list === 0) flush(m.index)
        list++
      }
      continue
    }
    if (list === 1 && /^li$/i.test(tag)) {
      if (close) flush(m.index + tok.length)
      else { flush(m.index); start = m.index }
      continue
    }
    if (list > 0) {
      // inside an item (or a nested list): it all belongs to that item
      if (!close && !/^(br|ul|ol|li)$/i.test(tag)) { if (start < 0) start = m.index; content = true }
      continue
    }
    const isBlock = BLOCK.test(tag)
    const isBr = /^br$/i.test(tag)
    if (isBlock) {
      if (close) {
        depth = Math.max(0, depth - 1)
        if (depth === 0) flush(m.index + tok.length)
      } else {
        if (depth === 0) { flush(m.index); start = m.index }
        depth++
      }
      continue
    }
    if (isBr) {
      if (depth === 0) { flush(m.index + tok.length) }
      continue
    }
    // any other tag opening means "there is something here" (math, an img…)
    if (!close) {
      if (start < 0) start = m.index
      content = true
    }
  }
  flush(html.length)
  return out
}

export const paragraphCount = (html: string): number => splitParagraphs(html).length

const BLANK_TEXT = /[\s ]+/g

/**
 * The DOM twin of `splitParagraphs` (present.ts runs it on the rendered,
 * sanitized text): tag each paragraph of a text
 * element's inner with `data-para=k` and return them. A paragraph is a
 * top-level <div>/<p>, an item of a top-level list, or a run of inline
 * content between blocks / lists / <br>s
 * (wrapped in a block <div> — layout-neutral, since inline runs already sit in
 * an anonymous block box — so it can take a transform). Blank lines are not
 * paragraphs. KEEP IN STEP with builds.ts.
 */
export function tagParagraphs(inner: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  const shows = (n: Node) => n.nodeType === 3
    ? !!(n.textContent ?? '').replace(BLANK_TEXT, '')
    : n instanceof Element && (n.tagName !== 'BR')
  let run: Node[] = []
  const flush = () => {
    if (run.some(shows)) {
      const w = document.createElement('div')
      inner.insertBefore(w, run[0])
      for (const n of run) w.appendChild(n)
      out.push(w)
    }
    run = []
  }
  for (const n of Array.from(inner.childNodes)) {
    if (n instanceof HTMLElement && (n.tagName === 'UL' || n.tagName === 'OL')) {
      // each top-level item is a paragraph, its sub-list riding along; the
      // <li> itself takes the transform (a block box), so numbering holds
      flush()
      for (const li of Array.from(n.children)) {
        if (li.tagName !== 'LI') continue
        if ((li.textContent ?? '').replace(BLANK_TEXT, '') || li.querySelector(':not(br):not(div):not(p):not(ul):not(ol):not(li)')) out.push(li as HTMLElement)
      }
    } else if (n instanceof HTMLElement && (n.tagName === 'DIV' || n.tagName === 'P')) {
      flush()
      if ((n.textContent ?? '').replace(BLANK_TEXT, '') || n.querySelector(':not(br):not(div):not(p)')) out.push(n)
    } else {
      run.push(n)
      if (n instanceof HTMLElement && n.tagName === 'BR') flush()
    }
  }
  flush()
  out.forEach((p, k) => { p.dataset.para = String(k) })
  return out
}

// ——— the plan ——————————————————————————————————————————————————————————————

const whole = (n: unknown): number => {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** True when `el` takes part in click builds at all. */
function participates(el: SlideElement): boolean {
  if (el.hidden || el.showOnHover) return false
  const fx = el.fx
  return !!fx && (whole(fx.step) > 0 || whole(fx.exitStep) > 0 || fx.byParagraph === true)
}

/** The paragraph-split text elements, regardless of whether they have steps. */
export function isParagraphBuilt(el: SlideElement): boolean {
  return el.type === 'text' && el.fx?.byParagraph === true && !el.hidden && !el.showOnHover
}

/** The authored step an element's FIRST piece enters at (0 = with the slide). */
export function enterStepOf(el: SlideElement): number {
  const fx = el.fx
  if (!fx) return 0
  if (isParagraphBuilt(el)) return fx.step === undefined ? 1 : Math.max(0, Math.floor(Number(fx.step)) || 0)
  return whole(fx.step)
}

/** The authored exit step that is actually honoured (an exit at or before the entrance is ignored). */
export function exitStepOf(el: SlideElement): number {
  const x = whole(el.fx?.exitStep)
  return x > enterStepOf(el) ? x : 0
}

export function buildPlan(slide: Slide): BuildPlan {
  const paragraphs = new Map<string, number>()
  const enters = new Map<number, BuildTarget[]>()
  const exits = new Map<number, BuildTarget[]>()
  const add = (m: Map<number, BuildTarget[]>, at: number, t: BuildTarget) => {
    const list = m.get(at)
    if (list) list.push(t)
    else m.set(at, [t])
  }
  for (const el of slide?.elements ?? []) {
    if (!participates(el)) continue
    const base = enterStepOf(el)
    const x = exitStepOf(el)
    if (isParagraphBuilt(el) && el.type === 'text') {
      const n = paragraphCount(el.html)
      paragraphs.set(el.id, n)
      // paragraphs arrive at base, base+1, … (base 0 = the first is with the
      // slide); one that would arrive after the element has left is dropped,
      // so it never costs a click that shows nothing
      for (let k = 0; k < n; k++) {
        if (x > 0 && base + k >= x) break
        if (base + k > 0) add(enters, base + k, { elId: el.id, para: k })
      }
    } else if (base > 0) {
      add(enters, base, { elId: el.id })
    }
    if (x > 0) add(exits, x, { elId: el.id })
  }
  const ats = [...new Set([...enters.keys(), ...exits.keys()])].sort((a, b) => a - b)
  return {
    steps: ats.map((at) => ({ at, enter: enters.get(at) ?? [], exit: exits.get(at) ?? [] })),
    paragraphs,
  }
}

export const stepCount = (slide: Slide): number => buildPlan(slide).steps.length

/**
 * What is shown after `n` clicks, as target keys: every non-build element
 * (by its id), every build element that has entered and not yet exited, and —
 * for paragraph-built text — the element itself plus each entered paragraph
 * (`id#k`). `n` is clamped to the plan.
 */
export function visibleAt(slide: Slide, n: number, plan: BuildPlan = buildPlan(slide)): Set<string> {
  const click = Math.max(0, Math.min(n, plan.steps.length))
  // the authored step number reached after `click` clicks
  const reached = click === 0 ? 0 : plan.steps[click - 1].at
  const out = new Set<string>()
  for (const el of slide?.elements ?? []) {
    if (el.hidden) continue
    const x = exitStepOf(el)
    const gone = x > 0 && x <= reached
    if (isParagraphBuilt(el)) {
      const base = enterStepOf(el)
      if (!gone) out.add(el.id)
      const total = plan.paragraphs.get(el.id) ?? 0
      for (let k = 0; k < total; k++) if (!gone && base + k <= reached) out.add(`${el.id}#${k}`)
      continue
    }
    const base = enterStepOf(el)
    if (base <= reached && !gone) out.add(el.id)
  }
  return out
}

/** A copy of `slide` holding only the ELEMENTS visible after `n` clicks (paragraph granularity is DOM-side). */
export function slideAtStep(slide: Slide, n: number): Slide {
  if (!slide) return slide
  const plan = buildPlan(slide)
  if (!plan.steps.length) return slide
  const vis = visibleAt(slide, n, plan)
  return { ...slide, elements: slide.elements.filter((el) => el.hidden || vis.has(el.id) || el.showOnHover) }
}

/** Where `el` appears in the plan: the compressed click it enters and exits at (0 = none). */
export function stepsOf(plan: BuildPlan, elId: string): { enter: number; exit: number } {
  let enter = 0
  let exit = 0
  plan.steps.forEach((s, i) => {
    if (!enter && s.enter.some((t) => t.elId === elId)) enter = i + 1
    if (!exit && s.exit.some((t) => t.elId === elId)) exit = i + 1
  })
  return { enter, exit }
}

// ——— editing ————————————————————————————————————————————————————————————————
// The Builds panel edits clicks, not authored numbers: every operation first
// renumbers the slide to its compressed clicks (so click i IS step i), changes
// what it was asked to, and renumbers again, so a slide never accumulates gaps.
// All of them mutate `slide` in place and are meant to run inside one undo step.

/** Rewrite every `fx.step` / `fx.exitStep` on `slide` to its compressed click number. */
export function normalizeSteps(slide: Slide): void {
  const plan = buildPlan(slide)
  const idx = new Map(plan.steps.map((s, i) => [s.at, i + 1]))
  for (const el of slide.elements) {
    const fx = el.fx
    if (!fx || !participates(el)) continue
    const base = enterStepOf(el)
    if (base > 0) fx.step = idx.get(base) ?? base
    else if (isParagraphBuilt(el) && fx.step !== undefined) fx.step = 0
    else delete fx.step
    const x = exitStepOf(el)
    if (x > 0) fx.exitStep = idx.get(x) ?? x
  }
}

const elOf = (slide: Slide, elId: string): SlideElement | undefined => slide.elements.find((e) => e.id === elId)

/** Drop fx.* keys that hold nothing, and fx itself when it is empty. */
function tidyFx(el: SlideElement): void {
  const fx = el.fx as Record<string, unknown> | undefined
  if (!fx) return
  for (const k of Object.keys(fx)) if (fx[k] === undefined || fx[k] === false) delete fx[k]
  if (!Object.keys(fx).length) delete el.fx
}

/**
 * Make `elId` enter on `click` (0 = with the slide, 1…N = an existing click,
 * N+1 or more = a new last click). An exit that would no longer come after the
 * entrance moves to the click after it, so moving an element never silently
 * discards its Disappears setting.
 */
export function setEnterClick(slide: Slide, elId: string, click: number): void {
  const el = elOf(slide, elId)
  if (!el) return
  normalizeSteps(slide)
  const n = stepCount(slide)
  const to = Math.max(0, Math.min(Math.floor(click), n + 1))
  const fx = (el.fx ??= {})
  if (to > 0) fx.step = to
  else if (isParagraphBuilt(el)) fx.step = 0
  else delete fx.step
  if (fx.exitStep !== undefined && fx.exitStep <= to) fx.exitStep = to + 1
  tidyFx(el)
  normalizeSteps(slide)
}

/** Make `elId` leave on `click` (0 = never); it is always kept after the entrance. */
export function setExitClick(slide: Slide, elId: string, click: number): void {
  const el = elOf(slide, elId)
  if (!el) return
  normalizeSteps(slide)
  const fx = (el.fx ??= {})
  if (click <= 0) { delete fx.exitStep; delete fx.exit; delete fx.exitDur }
  else fx.exitStep = Math.max(Math.floor(click), enterStepOf(el) + 1)
  tidyFx(el)
  normalizeSteps(slide)
}

/** True when a click holds paragraph targets — those keep their one-per-click order. */
export function clickHasParagraphs(plan: BuildPlan, click: number): boolean {
  const s = plan.steps[click - 1]
  return !!s && s.enter.some((t) => t.para !== undefined)
}

/** Swap clicks `i` and `j` (1-based) wholesale — every element entering or leaving on one now does so on the other. */
export function swapClicks(slide: Slide, i: number, j: number): void {
  normalizeSteps(slide)
  for (const el of slide.elements) {
    const fx = el.fx
    if (!fx) continue
    const sw = (v: number | undefined) => (v === i ? j : v === j ? i : v)
    if (fx.step !== undefined && !isParagraphBuilt(el)) fx.step = sw(fx.step)
    if (fx.exitStep !== undefined) fx.exitStep = sw(fx.exitStep)
  }
  normalizeSteps(slide)
}

/** Fold click `i` into the one before it (click 1 folds into "with the slide"). */
export function mergeClickIntoPrevious(slide: Slide, i: number): void {
  normalizeSteps(slide)
  for (const el of slide.elements) {
    const fx = el.fx
    if (!fx || isParagraphBuilt(el)) continue
    if (fx.step === i) { if (i - 1 > 0) fx.step = i - 1; else delete fx.step }
    if (fx.exitStep === i) fx.exitStep = i - 1
    // an exit that no longer follows its entrance is dropped rather than left dead
    if (fx.exitStep !== undefined && fx.exitStep <= (fx.step ?? 0)) { delete fx.exitStep; delete fx.exit; delete fx.exitDur }
    tidyFx(el)
  }
  normalizeSteps(slide)
}
