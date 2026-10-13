// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Find & replace — the pure half (no DOM, rig: scripts/test-find-replace.ts).
// The bar that drives it lives in findbar.ts.
//
// What is searched, per slide of `doc.slides` in deck order: text boxes,
// table cells, code, chart labels (title, axis names, category labels,
// series and pie-slice names, legend entries) and the speaker notes. Slide
// types (doc.layouts) and deck objects are NOT searched, and neither is a
// linked slide's inherited chrome (the caller's `skip`) — editing it on the
// slide would be reverted by the next resync anyway.
//
// RICH TEXT. Text and cells are sanitized inline HTML. A match is found and
// replaced INSIDE one text run — the characters between two tags — never
// across markup, so `**bold**` / colour spans / links can't be torn apart:
// "foo <b>bar</b>" does not match "foo bar" (we never find what we could not
// replace cleanly). Entities count as the character they stand for (`&amp;`
// is "&", `&nbsp;` matches a space), untouched entities are kept verbatim,
// and the replacement is escaped. Field tokens (`{{page}}`…) are opaque: a
// search never reaches into one, so a replace can't break a field.

import type { ChartElement, Slide, SlideElement, SlidomingoDoc } from '../model'
import { tableLayout } from '../tablespans'

export interface FindOptions {
  matchCase?: boolean
  wholeWord?: boolean
  /** true = leave this element out (the editor passes inherited chrome) */
  skip?: (slide: Slide, el: SlideElement) => boolean
}

/** Where a match lives inside one slide. `path` walks a chart's option. */
export type FieldRef =
  | { kind: 'text'; elId: string }
  | { kind: 'cell'; elId: string; row: number; col: number }
  | { kind: 'code'; elId: string }
  | { kind: 'math'; elId: string }
  | { kind: 'chart'; elId: string; path: Array<string | number> }
  | { kind: 'notes' }

export interface FindMatch {
  slideIndex: number
  slideId: string
  ref: FieldRef
  /** global unit index range inside the field — stable identity for replace */
  g0: number
  g1: number
  /** the n-th match inside this field (0-based) — maps to the rendered DOM */
  ordinal: number
  /** the matched text, decoded */
  text: string
}

// ---- the field's text, as units --------------------------------------------

/** One searchable character (`ch`, decoded) and the source it came from. */
interface Unit { raw: string; ch: string }
type Piece = { tag: string; brk: boolean } | Unit

const OPAQUE = '￼' // a field token: never matches, never a word char
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const TAG_RE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/y
const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/y
const FIELD_RE = /\{\{[^{}<>]*\}\}/y
const BREAK_TAG = /^<\/?(br|div|p|li|ul|ol|tr|td|th|h[1-6])\b/i

function parseHtml(s: string): Piece[] {
  const out: Piece[] = []
  for (let i = 0; i < s.length;) {
    const c = s[i]
    if (c === '<') {
      TAG_RE.lastIndex = i
      const m = TAG_RE.exec(s)
      if (m) { out.push({ tag: m[0], brk: BREAK_TAG.test(m[0]) }); i += m[0].length; continue }
    } else if (c === '&') {
      ENTITY_RE.lastIndex = i
      const m = ENTITY_RE.exec(s)
      if (m) {
        const body = m[1]
        let ch: string | undefined
        if (body[0] === '#') {
          const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
          if (n > 0 && n <= 0x10ffff) ch = String.fromCodePoint(n)
        } else ch = ENTITIES[body]
        // an entity we can't decode is kept as an opaque unit, never torn
        out.push({ raw: m[0], ch: ch ?? OPAQUE })
        i += m[0].length
        continue
      }
    } else if (c === '{' && s[i + 1] === '{') {
      FIELD_RE.lastIndex = i
      const m = FIELD_RE.exec(s)
      if (m) { out.push({ raw: m[0], ch: OPAQUE }); i += m[0].length; continue }
    }
    out.push({ raw: c, ch: c })
    i++
  }
  return out
}

function parsePlain(s: string): Piece[] {
  const out: Piece[] = []
  for (const c of s.split('')) out.push({ raw: c, ch: c })
  return out
}

const isUnit = (p: Piece): p is Unit => 'ch' in p

/** Per-code-unit case fold that never changes the length (so offsets hold);
 *  NBSP always folds to a space — contentEditable writes one for a typed
 *  double space, and nobody searches for it on purpose. */
function fold(s: string, matchCase: boolean): string {
  let out = ''
  for (const c of s.split('')) {
    if (c === ' ') { out += ' '; continue }
    if (matchCase) { out += c; continue }
    const l = c.toLowerCase()
    out += l.length === 1 ? l : c
  }
  return out
}

const WORD = /[\p{L}\p{N}_]/u
const isWord = (c: string | undefined) => !!c && WORD.test(c)

/** Matches in a parsed field, as global unit ranges. Runs are maximal unit
 *  sequences between tags; a match never spans two runs. */
function findInPieces(pieces: Piece[], query: string, opts: FindOptions): Array<[number, number]> {
  const q = fold(query, !!opts.matchCase)
  if (!q) return []
  // flat text for word boundaries: a break tag reads as a newline
  let flat = ''
  const runs: Array<{ g: number; flat: number; text: string; starts: number[] }> = []
  let g = 0
  let cur: (typeof runs)[number] | null = null
  for (const p of pieces) {
    if (isUnit(p)) {
      if (!cur) { cur = { g, flat: flat.length, text: '', starts: [] }; runs.push(cur) }
      cur.starts.push(cur.text.length)
      cur.text += p.ch
      flat += p.ch
      g++
    } else {
      cur = null
      if (p.brk) flat += '\n'
    }
  }
  const out: Array<[number, number]> = []
  for (const run of runs) {
    const text = fold(run.text, !!opts.matchCase)
    // string offset → unit index (only unit boundaries are valid match ends)
    const unitAt = new Map<number, number>()
    run.starts.forEach((s, i) => unitAt.set(s, i))
    unitAt.set(text.length, run.starts.length)
    let from = 0
    for (;;) {
      const i = text.indexOf(q, from)
      if (i < 0) break
      const j = i + q.length
      const u0 = unitAt.get(i), u1 = unitAt.get(j)
      const fi = run.flat + i
      const wordOk = !opts.wholeWord || (!isWord(flat[fi - 1]) && !isWord(flat[fi + q.length]))
      if (u0 === undefined || u1 === undefined || !wordOk) { from = i + 1; continue }
      out.push([run.g + u0, run.g + u1])
      from = j
    }
  }
  return out
}

function rebuild(pieces: Piece[], ranges: Array<[number, number]>, replacement: string): string {
  const starts = new Map(ranges.map(([a, b]) => [a, b]))
  let out = ''
  let g = 0
  let skipTo = -1
  for (const p of pieces) {
    if (!isUnit(p)) { out += p.tag; continue }
    const end = starts.get(g)
    if (end !== undefined) { out += replacement; skipTo = end }
    if (g >= skipTo) out += p.raw
    g++
  }
  return out
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---- the fields of a slide --------------------------------------------------

interface Field {
  ref: FieldRef
  html: boolean
  get(): string
  set(v: string): void
}

const strField = (ref: FieldRef, obj: Record<string | number, unknown>, key: string | number): Field | null =>
  typeof obj[key] === 'string'
    ? { ref, html: false, get: () => obj[key] as string, set: (v) => { obj[key] = v } }
    : null

type Opt = Record<string | number, unknown>
const asObj = (v: unknown): Opt | null => (v && typeof v === 'object' ? (v as Opt) : null)
/** ECharts allows one component or an array of them — iterate either. */
function each(opt: Opt, key: string, f: (o: Opt, path: Array<string | number>) => void) {
  const v = opt[key]
  if (Array.isArray(v)) v.forEach((o, i) => { const x = asObj(o); if (x) f(x, [key, i]) })
  else { const x = asObj(v); if (x) f(x, [key]) }
}

function chartFields(el: ChartElement): Field[] {
  const out: Field[] = []
  const opt = asObj(el.option)
  if (!opt) return out
  const linked = !!el.source // categories / pie names are derived from the table
  const add = (obj: Opt, key: string | number, path: Array<string | number>) => {
    const f = strField({ kind: 'chart', elId: el.id, path: [...path, key] }, obj, key)
    if (f) out.push(f)
  }
  each(opt, 'title', (t, p) => { add(t, 'text', p); add(t, 'subtext', p) })
  for (const axis of ['xAxis', 'yAxis']) {
    each(opt, axis, (a, p) => {
      add(a, 'name', p)
      if (!linked && Array.isArray(a.data)) (a.data as unknown[]).forEach((_, i) => add(a.data as Opt, i, [...p, 'data']))
    })
  }
  each(opt, 'series', (s, p) => {
    add(s, 'name', p)
    if (!linked && Array.isArray(s.data)) {
      (s.data as unknown[]).forEach((d, i) => { const o = asObj(d); if (o) add(o, 'name', [...p, 'data', i]) })
    }
  })
  each(opt, 'legend', (l, p) => {
    if (Array.isArray(l.data)) (l.data as unknown[]).forEach((_, i) => add(l.data as Opt, i, [...p, 'data']))
  })
  return out
}

function elementFields(el: SlideElement): Field[] {
  switch (el.type) {
    case 'text':
      return [{ ref: { kind: 'text', elId: el.id }, html: true, get: () => el.html ?? '', set: (v) => { el.html = v } }]
    case 'table': {
      const out: Field[] = []
      // a cell under a merged cell is never shown — nothing to find there
      const span = tableLayout(el).span
      el.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
        if (!span[r]?.[c]) return
        out.push({ ref: { kind: 'cell', elId: el.id, row: r, col: c }, html: true, get: () => cell.html ?? '', set: (v) => { cell.html = v } })
      }))
      return out
    }
    case 'code':
      return [{ ref: { kind: 'code', elId: el.id }, html: false, get: () => el.content ?? '', set: (v) => { el.content = v } }]
    // an equation's LaTeX source, as plain text (renaming x → t across a deck)
    case 'math':
      return [{ ref: { kind: 'math', elId: el.id }, html: false, get: () => el.tex ?? '', set: (v) => { el.tex = v } }]
    case 'chart':
      return chartFields(el)
    default:
      return []
  }
}

/** Reading order: top to bottom, then left to right (z-order is not an
 *  order anybody reads a slide in). */
function readingOrder(els: SlideElement[]): SlideElement[] {
  return els.slice().sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x))
}

function slideFields(slide: Slide, opts: FindOptions): Field[] {
  const out: Field[] = []
  for (const el of readingOrder(slide.elements ?? [])) {
    if (opts.skip?.(slide, el)) continue
    out.push(...elementFields(el))
  }
  out.push({ ref: { kind: 'notes' }, html: false, get: () => slide.notes ?? '', set: (v) => { slide.notes = v } })
  return out
}

export function sameRef(a: FieldRef, b: FieldRef): boolean {
  return fieldKey(a) === fieldKey(b)
}

export function fieldKey(ref: FieldRef): string {
  switch (ref.kind) {
    case 'notes': return 'notes'
    case 'cell': return `cell:${ref.elId}:${ref.row}:${ref.col}`
    case 'chart': return `chart:${ref.elId}:${ref.path.join('.')}`
    default: return `${ref.kind}:${ref.elId}`
  }
}

export function refElementId(ref: FieldRef): string | undefined {
  return ref.kind === 'notes' ? undefined : ref.elId
}

// ---- the public operations ----------------------------------------------------

/** Every match in the deck, in deck → reading → field order. */
export function findMatches(doc: SlidomingoDoc, query: string, opts: FindOptions = {}): FindMatch[] {
  const out: FindMatch[] = []
  if (!query) return out
  doc.slides.forEach((slide, slideIndex) => {
    for (const f of slideFields(slide, opts)) {
      const value = f.get()
      if (!value) continue
      const pieces = f.html ? parseHtml(value) : parsePlain(value)
      const units = pieces.filter(isUnit)
      findInPieces(pieces, query, opts).forEach(([g0, g1], ordinal) => {
        out.push({
          slideIndex, slideId: slide.id, ref: f.ref, g0, g1, ordinal,
          text: units.slice(g0, g1).map((u) => u.ch).join(''),
        })
      })
    }
  })
  return out
}

function fieldFor(doc: SlidomingoDoc, m: FindMatch, opts: FindOptions): Field | undefined {
  const slide = doc.slides.find((s) => s.id === m.slideId)
  if (!slide) return undefined
  const key = fieldKey(m.ref)
  return slideFields(slide, opts).find((f) => fieldKey(f.ref) === key)
}

/** A checked single replace: `apply()` writes it. `changed` is false when
 *  the replacement equals what is there (nothing to commit). */
export interface ReplacePlan { changed: boolean; apply(): void }

/** Plan replacing ONE match (as found by findMatches), re-verified against
 *  the current text: a stale match gives null rather than being misapplied.
 *  Pure until `apply()` — so the caller only opens an undo step for a real
 *  change (store.commit always records one). */
export function planReplaceMatch(doc: SlidomingoDoc, m: FindMatch, query: string, replacement: string, opts: FindOptions = {}): ReplacePlan | null {
  const f = fieldFor(doc, m, opts)
  if (!f) return null
  const before = f.get()
  const pieces = f.html ? parseHtml(before) : parsePlain(before)
  const hit = findInPieces(pieces, query, opts).find(([a, b]) => a === m.g0 && b === m.g1)
  if (!hit) return null
  const after = rebuild(pieces, [hit], f.html ? escapeHtml(replacement) : replacement)
  return { changed: after !== before, apply: () => f.set(after) }
}

/** Replace ONE match now (planReplaceMatch + apply). Mutates `doc`; the
 *  caller wraps it in one store.commit. False = stale, nothing written. */
export function replaceMatch(doc: SlidomingoDoc, m: FindMatch, query: string, replacement: string, opts: FindOptions = {}): boolean {
  const plan = planReplaceMatch(doc, m, query, replacement, opts)
  plan?.apply()
  return !!plan
}

/** Replace every match in the deck; returns how many. Mutates `doc` — the
 *  caller wraps it in ONE store.commit so it is one undo step. */
export function replaceAll(doc: SlidomingoDoc, query: string, replacement: string, opts: FindOptions = {}): number {
  if (!query) return 0
  let n = 0
  for (const slide of doc.slides) {
    for (const f of slideFields(slide, opts)) {
      const value = f.get()
      if (!value) continue
      const pieces = f.html ? parseHtml(value) : parsePlain(value)
      const hits = findInPieces(pieces, query, opts)
      if (!hits.length) continue
      f.set(rebuild(pieces, hits, f.html ? escapeHtml(replacement) : replacement))
      n += hits.length
    }
  }
  return n
}

// ---- the rendered field (the canvas highlighter) ----------------------------

/** The source of the field a match lives in — what renderedSpans() aligns. */
export function fieldSource(doc: SlidomingoDoc, m: FindMatch): { value: string; html: boolean } | undefined {
  const f = fieldFor(doc, m, {})
  return f ? { value: f.get(), html: f.html } : undefined
}

/** Where each unit range of a field (a match's g0..g1) lands in the field's
 *  RENDERED text: its DOM text nodes concatenated, field chips left out.
 *
 *  The highlighter maps the model's own matches through this rather than
 *  searching the DOM again — a second search disagreed with the model's
 *  (whole words are judged on the field's whole text, across tags), so the
 *  marks and the counter could differ. The units are aligned to the rendered
 *  text one by one; where the renderer rewrote something (an entity the
 *  browser decodes differently, an unresolved field token in a cell, math…)
 *  the alignment re-syncs on the next few characters. A range that is not
 *  placed contiguously gets null: no mark beats a wrong one. */
export function renderedSpans(source: string, html: boolean, rendered: string, ranges: Array<[number, number]>): Array<[number, number] | null> {
  const units = (html ? parseHtml(source) : parsePlain(source)).filter(isUnit)
  const chars = units.map((u) => fold(u.ch, true)) // NBSP ≡ space, on both sides
  const text = fold(rendered, true)
  const at: number[] = new Array(units.length).fill(-1)
  let pos = 0
  for (let i = 0; i < units.length; i++) {
    const c = chars[i]
    if (c === OPAQUE) {
      // a field chip is not in `rendered`; where fields stay unresolved (a
      // table cell) the token is there verbatim
      const raw = units[i].raw
      if (raw.startsWith('{{') && text.startsWith(raw, pos)) pos += raw.length
      continue
    }
    if (text.startsWith(c, pos)) { at[i] = pos; pos += c.length; continue }
    // out of step: find where the next few characters went
    let probe = ''
    for (let k = i; k < units.length && k < i + 8 && chars[k] !== OPAQUE; k++) probe += chars[k]
    const rest = chars.slice(i).filter((x) => x !== OPAQUE).join('').length
    if (probe.length < Math.min(3, rest)) continue
    const p = text.indexOf(probe, pos)
    if (p < 0) continue
    at[i] = p
    pos = p + c.length
  }
  return ranges.map(([g0, g1]) => {
    if (g0 < 0 || g1 > units.length || g1 <= g0) return null
    for (let k = g0; k < g1; k++) {
      if (at[k] < 0) return null
      if (k > g0 && at[k] !== at[k - 1] + chars[k - 1].length) return null
    }
    return [at[g0], at[g1 - 1] + chars[g1 - 1].length]
  })
}
