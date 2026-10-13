// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// After a PowerPoint import: put the deck on a layout the user already has,
// when — and only when — it is provably the same design.
//
// WHY. The converter turns a file's masters and layouts into NEW slide
// types every time, so ten decks made from the company template carry ten
// copies of it, none tied to the layout the user keeps for that template.
// Here the imported design is compared with a layout file BY CONTENT
// (the converter numbers masters/layouts per file, so ids say nothing): a
// slide type matches when its background and every element — position,
// size, style, the bytes of every picture — are the same, in the same
// order. Placeholder prompts, names, roles and ids are ignored; they never
// show when presenting.
//
// THE RULES (docs/DECISIONS.md 2026-10-13, "Import onto an existing layout"):
//   - same slide size, and at least one root type (a master) matches → the
//     deck takes the layout's design: its slide types, theme, fonts, and
//     `basedOn`, so "Update this deck from layout" works later;
//   - a slide linked to a matched type follows the layout's type — but only
//     if the resync would render it exactly as the file did; otherwise it is
//     kept exactly as in the file, unlinked;
//   - a type the layout lacks (a trimmed layout) is kept from the file, as
//     an extra slide type under the layout's matching master;
//   - a master that matches nothing keeps the file's own design for its
//     slides.
// Nothing here ever changes how a slide looks.
//
// Pure model code: no DOM, no store. The editor runs `rebaseOnLayout` in
// one store.commit and keeps a copy of the file's design for "Keep the
// file's own design".

import type { SlidomingoDoc, Slide, SlideElement, TextElement } from './model.ts'
import { adoptTemplateDesign, ancestorChain, ancestorElementIds, defaultSlideType, effectiveLayout, layoutElementIds, matchLayout, pickableSlideTypes, relinkPreview } from './model.ts'

/** deck slide-type id → layout slide-type id, and deck element id → layout
 *  element id for every element of a matched type. */
export interface DesignMatch {
  types: Map<string, string>
  elements: Map<string, string>
  /** matched ROOT types (masters) — the match counts only when > 0 */
  roots: number
  /** field values read off the file's literal footer text where the layout
   *  has a field there (`{{footer}}`, `{{prop:Name}}`, …), so the deck can
   *  say the same thing through the layout's fields */
  bindings: Bindings
}

/** Values for the fields a layout's chrome may use. */
export interface Bindings {
  footer?: string
  author?: string
  company?: string
  subject?: string
  event?: string
  props: Record<string, string>
}

export interface RebaseResult {
  /** slides now following one of the layout's slide types */
  linked: number
  /** slides that were linked in the file but would not render the same on
   *  the layout's types — kept exactly as in the file, unlinked */
  keptFromFile: number
  /** names of the file's slide types the layout lacks, kept as extras */
  extraTypes: string[]
  /** per kept-from-file slide id: what would have looked different */
  why: Record<string, string>
}

// --- render signatures -------------------------------------------------------

/** Fields that never change what a viewer sees. */
const IDENTITY = new Set(['id', 'morphId', 'groupId', 'parentId', 'parentOffset', 'placeholder', 'role', 'name', 'locked', 'from', 'to', 'footerRole'])

/** FNV-1a over a string — picture bytes are compared by hash, not by key:
 *  the same picture sits under different asset keys in two files. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(36)}:${s.length}`
}

/** A signature of what an element LOOKS like, comparable across documents. */
export function renderSig(el: SlideElement, doc: SlidomingoDoc, cache = new Map<string, string>(), html?: (h: string) => string): string {
  const assetHash = (key: string) => {
    const data = doc.assets?.[key]
    if (data === undefined) return `missing:${key}`
    let h = cache.get(data)
    if (!h) { h = hash(data); cache.set(data, h) }
    return h
  }
  const norm = (v: unknown, key?: string): unknown => {
    if (typeof v === 'number') return Math.round(v * 2) / 2
    if (typeof v === 'string') {
      if (v.startsWith('asset:')) return `#${assetHash(v.slice(6))}`
      if (v.startsWith('data:')) return `#${hash(v)}`
      if (key === 'asset') return `#${assetHash(v)}`
      if (key === 'html' && html) return html(v)
      return v
    }
    if (Array.isArray(v)) return v.map((x) => norm(x))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort()) {
        if (IDENTITY.has(k)) continue
        const x = (v as Record<string, unknown>)[k]
        if (x === undefined) continue
        out[k] = norm(x, k)
      }
      return out
    }
    return v
  }
  return JSON.stringify(norm(el))
}

function backgroundSig(slide: Pick<Slide, 'background'>, doc: SlidomingoDoc, cache: Map<string, string>): string {
  return renderSig({ background: slide.background } as unknown as SlideElement, doc, cache)
}

/** Visible elements in z-order (hidden ones never render). */
const shown = (els: SlideElement[]) => els.filter((e) => !e.hidden)

// --- matching ----------------------------------------------------------------

/** Children of `parentId` (roots when undefined) among `doc.layouts`. */
function childrenOf(doc: SlidomingoDoc, parentId: string | undefined): Slide[] {
  const ids = new Set((doc.layouts ?? []).map((l) => l.id))
  return (doc.layouts ?? []).filter((l) => (parentId === undefined ? !l.parentId || !ids.has(l.parentId) : l.parentId === parentId))
}

/** The document fields a footer may carry, by token name. */
const BINDABLE = /\{\{\s*(footer|author|company|subject|event|prop)(?::([^}]*))?\s*\}\}/gi

const decode = (s: string) => s.replace(/&nbsp;/g, '\u00a0').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Does the file's literal `text` read as the layout's `pattern` with its
 *  fields filled in? Records the values in `b` (refusing a value that
 *  contradicts one already read). */
function bindHtml(text: string, pattern: string, b: Bindings): boolean {
  if (text === pattern) return true
  const names: string[] = []
  let re = ''
  let last = 0
  for (const m of pattern.matchAll(BINDABLE)) {
    re += escapeRe(pattern.slice(last, m.index)) + '(.*?)'
    names.push(m[1].toLowerCase() === 'prop' ? `prop:${(m[2] ?? '').trim()}` : m[1].toLowerCase())
    last = m.index! + m[0].length
  }
  if (!names.length) return false
  const hit = new RegExp(`^${re}${escapeRe(pattern.slice(last))}$`, 's').exec(text)
  if (!hit) return false
  const next: Bindings = { ...b, props: { ...b.props } }
  for (let i = 0; i < names.length; i++) {
    const value = decode(hit[i + 1])
    const name = names[i]
    const cur = name.startsWith('prop:') ? next.props[name.slice(5)] : next[name as Exclude<keyof Bindings, 'props'>]
    if (cur !== undefined && cur !== value) return false
    if (name.startsWith('prop:')) next.props[name.slice(5)] = value
    else next[name as Exclude<keyof Bindings, 'props'>] = value
  }
  Object.assign(b, next)
  return true
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One element of a file type against one of a layout type: an empty text
 *  slot by its box (its prompt styling never shows when presenting, and a
 *  slide's own text takes the slot's style anyway — the per-slide proof
 *  catches that); text by everything but its words, which must read as the
 *  layout's (fields filled in); anything else by its whole signature. */
function sameElement(d: SlideElement, l: SlideElement, deck: SlidomingoDoc, layout: SlidomingoDoc, b: Bindings, dc: Map<string, string>, lc: Map<string, string>): boolean {
  if (d.type !== l.type) return false
  if (d.type === 'text' && l.type === 'text') {
    if (!d.html.trim() && !l.html.trim()) {
      const r = (n: number) => Math.round(n * 2) / 2
      return r(d.x) === r(l.x) && r(d.y) === r(l.y) && r(d.w) === r(l.w) && r(d.h) === r(l.h)
    }
    const strip = (e: SlideElement) => ({ ...e, html: '' }) as SlideElement
    if (renderSig(strip(d), deck, dc) !== renderSig(strip(l), layout, lc)) return false
    // footer furniture is the layout's to word ("Page" vs "Seite", a field
    // vs a literal): read what fields it can, never refuse the design over
    // it — each slide's own proof decides whether its footer still reads
    // the same
    if (l.footerRole) { bindHtml(d.html, l.html, b); return true }
    return bindHtml(d.html, l.html, b)
  }
  return renderSig(d, deck, dc) === renderSig(l, layout, lc)
}

/**
 * Match the deck's slide types against `layout`'s, level by level: roots
 * against roots, then the children of a matched pair against each other.
 * Two types match when their backgrounds are the same and their visible
 * elements pair up one by one (`sameElement`); a same-named candidate is
 * preferred. Returns null when the slide sizes differ or no root matches.
 */
export function matchDesign(deck: SlidomingoDoc, layout: SlidomingoDoc): DesignMatch | null {
  if (deck.size.width !== layout.size.width || deck.size.height !== layout.size.height) return null
  const dc = new Map<string, string>()
  const lc = new Map<string, string>()
  const match: DesignMatch = { types: new Map(), elements: new Map(), roots: 0, bindings: { props: {} } }
  const used = new Set<string>()
  const same = (d: Slide, l: Slide): Bindings | null => {
    if (backgroundSig(d, deck, dc) !== backgroundSig(l, layout, lc)) return null
    const a = shown(d.elements)
    const z = shown(l.elements)
    if (a.length !== z.length) return null
    const b: Bindings = { ...match.bindings, props: { ...match.bindings.props } }
    return a.every((e, i) => sameElement(e, z[i], deck, layout, b, dc, lc)) ? b : null
  }
  const pair = (deckParent: string | undefined, layoutParent: string | undefined) => {
    const candidates = childrenOf(layout, layoutParent)
    for (const d of childrenOf(deck, deckParent)) {
      let hit: Slide | undefined
      let bound: Bindings | null = null
      for (const l of [...candidates.filter((c) => c.name === d.name), ...candidates.filter((c) => c.name !== d.name)]) {
        if (used.has(l.id)) continue
        bound = same(d, l)
        if (bound) { hit = l; break }
      }
      if (!hit || !bound) continue
      used.add(hit.id)
      match.bindings = bound
      match.types.set(d.id, hit.id)
      if (deckParent === undefined) match.roots++
      const a = shown(d.elements)
      const z = shown(hit.elements)
      a.forEach((e, i) => match.elements.set(e.id, z[i].id))
      pair(d.id, hit.id)
    }
  }
  pair(undefined, undefined)
  return match.roots ? match : null
}

/** Field values as the renderer would fill them in, for comparing a
 *  slide's text before (literal) and after (the layout's fields). Only the
 *  document fields; page/date tokens are the same on both sides. */
function fieldText(doc: SlidomingoDoc): (html: string) => string {
  const m = doc.meta ?? {}
  return (html) => html.indexOf('{{') < 0 ? html : html.replace(BINDABLE, (_t, raw: string, arg?: string) => {
    const name = raw.toLowerCase()
    if (name === 'prop') return encode(m.custom?.[(arg ?? '').trim()] ?? '')
    if (name === 'footer') return encode(doc.headerFooter?.footer?.text ?? '')
    return encode((m as Record<string, string | undefined>)[name] ?? '')
  })
}

/** Write what the file's footers said into the deck's own fields. */
function applyBindings(deck: SlidomingoDoc, b: Bindings): void {
  if (b.footer !== undefined) deck.headerFooter = { ...deck.headerFooter, footer: { ...deck.headerFooter?.footer, text: b.footer } }
  const meta = { ...(deck.meta ?? {}) } as NonNullable<SlidomingoDoc['meta']>
  for (const k of ['author', 'company', 'subject', 'event'] as const) if (b[k] !== undefined && !meta[k]) meta[k] = b[k]
  if (Object.keys(b.props).length) meta.custom = { ...(meta.custom ?? {}), ...b.props }
  deck.meta = meta
}

// --- rebasing ----------------------------------------------------------------

const FILE_SUFFIX = '-file'

/**
 * Put `deck` on `layout`'s design (mutates `deck`) using `match`. See the
 * header for the rules. `name` is the layout's display name for `basedOn`.
 */
export function rebaseOnLayout(deck: SlidomingoDoc, layout: SlidomingoDoc, match: DesignMatch, name: string): RebaseResult {
  const before = structuredClone(deck)
  const result: RebaseResult = { linked: 0, keptFromFile: 0, extraTypes: [], why: {} }
  const deckTypes = deck.layouts ?? []
  const byId = new Map(deckTypes.map((l) => [l.id, l]))

  // The file's types the layout lacks are KEPT: renamed out of the layout's
  // id space (the converter numbers both the same way), and a kept child of
  // a matched master moves under the layout's master.
  const kept = deckTypes.filter((l) => !match.types.has(l.id))
  const keptIds = new Map(kept.map((l) => [l.id, `${l.id}${FILE_SUFFIX}`]))
  const elementIds = new Map(match.elements)
  for (const l of kept) for (const e of l.elements) elementIds.set(e.id, `${e.id}${FILE_SUFFIX}`)
  const renamedKept = kept.map((l) => {
    const c = structuredClone(l)
    c.id = keptIds.get(l.id)!
    if (c.parentId) c.parentId = match.types.get(c.parentId) ?? keptIds.get(c.parentId) ?? c.parentId
    for (const e of c.elements) e.id = elementIds.get(e.id) ?? e.id
    return c
  })

  // install the layout's design (slide types, theme, fonts, objects, the
  // assets they use), then the kept extras after it
  deck.layouts = []
  delete deck.defaultLayoutId
  const adopted = adoptTemplateDesign(deck, layout)
  if ('error' in adopted) return result // sizes were checked by matchDesign
  deck.layouts.push(...renamedKept)
  deck.defaultLayoutId = layout.defaultLayoutId && deck.layouts.some((l) => l.id === layout.defaultLayoutId)
    ? layout.defaultLayoutId
    : deck.layouts[0]?.id
  if (layout.templateId) deck.basedOn = { templateId: layout.templateId, name }
  applyBindings(deck, match.bindings)

  // every slide that followed a file type: move it over, then PROVE it
  // renders as before — else restore it exactly as in the file, unlinked
  const known = layoutElementIds(deck)
  const dc = new Map<string, string>()
  const bc = new Map<string, string>()
  const designIds = new Set(deckTypes.flatMap((l) => l.elements.map((e) => e.id)))
  const afterText = fieldText(deck)
  const beforeText = fieldText(before)
  deck.slides.forEach((slide, i) => {
    const old = before.slides[i]
    if (!old.layoutId || !byId.has(old.layoutId)) return
    const targetId = match.types.get(old.layoutId) ?? keptIds.get(old.layoutId)!
    const target = deck.layouts!.find((l) => l.id === targetId)!
    const renamed: Slide = { ...slide, layoutId: targetId, elements: slide.elements.map((e) => renameEl(e, elementIds)) }
    const elements = relinkPreview(deck, renamed, target, known).elements
    const background = effectiveLayout(deck, target).background
    const why = backgroundSig({ background }, deck, dc) !== backgroundSig(old, before, bc)
      ? 'background'
      : firstDifference(shown(elements).map((e) => renderSig(e, deck, dc, afterText)), shown(old.elements).map((e) => renderSig(e, before, bc, beforeText)))
    if (!why) {
      slide.layoutId = targetId
      slide.elements = elements
      result.linked++
      return
    }
    // exactly as in the file: its own copies, ids out of the layout's space
    delete slide.layoutId
    slide.elements = old.elements.map((e) => designIds.has(e.id) ? { ...e, id: `${e.id}${FILE_SUFFIX}` } : e)
    slide.background = old.background
    result.keptFromFile++
    result.why[slide.id] = why
  })

  // kept types nobody follows any more are dropped again (the converter
  // pruned unused ones already; a restored slide no longer follows its type)
  let types: Slide[] = deck.layouts
  for (;;) {
    const used = new Set(deck.slides.map((x) => x.layoutId).filter(Boolean) as string[])
    const parents = new Set(types.map((l) => l.parentId).filter(Boolean) as string[])
    const idle = new Set(renamedKept.filter((l) => types.includes(l) && !used.has(l.id) && !parents.has(l.id)))
    if (!idle.size) break
    types = types.filter((l) => !idle.has(l))
  }
  deck.layouts = types
  result.extraTypes = renamedKept.filter((l) => types.includes(l)).map((l) => l.name ?? l.id)
  return result
}

function renameEl(e: SlideElement, ids: Map<string, string>): SlideElement {
  const id = ids.get(e.id)
  return id ? { ...e, id } : e
}

/** '' when both z-ordered signature lists are the same; else a short note
 *  on the first difference ("text: fontFamily, html"). */
function firstDifference(after: string[], before: string[]): string {
  if (after.length !== before.length) return `${before.length} elements would become ${after.length}`
  for (let i = 0; i < after.length; i++) {
    if (after[i] === before[i]) continue
    const a = JSON.parse(after[i]) as Record<string, unknown>
    const b = JSON.parse(before[i]) as Record<string, unknown>
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    return `${String(b.type ?? 'element')}: ${keys.join(', ')}`
  }
  return ''
}

// --- restyling onto ANOTHER layout ("Use a different layout…") ---------------

export interface RestyleResult {
  /** slides whose content found a slot for every titled/body piece */
  fit: number
  /** slides with content that found no slot (left where it was) */
  partial: number
  /** that content, for the report and "Fix with Claude" */
  floating: Array<{ slideId: string; slide: number; elementId: string }>
}

/** What is DESIGN on an imported slide (and goes when it is restyled): the
 *  copies of its slide type's chain, the converter's baked chrome on an
 *  unlinked slide (`mst<n>-`/`ly<n>-`), and its footers — the new layout
 *  brings its own. A slot that holds the slide's text or picture is content. */
/** How much of the slide a type's OWN artwork covers (0…1): a closing or
 *  title design is mostly picture, a content type mostly empty. Free
 *  content wants the quiet one. */
function decoration(deck: SlidomingoDoc, type: Slide): number {
  const area = deck.size.width * deck.size.height
  let covered = 0
  for (const e of type.elements) {
    if (e.role || e.type === 'text' || e.hidden) continue
    covered += Math.max(0, e.w) * Math.max(0, e.h)
  }
  return Math.min(1, covered / area)
}

function designOf(chain: Set<string>): (e: SlideElement) => boolean {
  return (e) => {
    if (e.type === 'text' && e.footerRole) return true
    if (/^(mst|ly)\d+-/.test(e.id)) return true
    if (!chain.has(e.id)) return false
    if (e.type === 'text') return !e.role || !e.html.trim()
    return !(e.role === 'media' && e.type !== 'shape') // a filled media slot is the slide's picture
  }
}

/**
 * Restyle `deck` (mutates it) onto `layout`'s design — a deliberate design
 * change, run only when the user asks. Every slide keeps its own content and
 * loses the file's chrome; each goes onto the slide type of `layout` that
 * fits it best (`relinkPreview`: most slots filled, least content left
 * without a slot, fewest empty slots), and follows it from then on.
 */
export function restyleOnLayout(deck: SlidomingoDoc, layout: SlidomingoDoc, name: string, hints: ReadonlyMap<string, string> = new Map()): RestyleResult {
  const result: RestyleResult = { fit: 0, partial: 0, floating: [] }
  // what each slide WAS: its slide type's name (a linked slide), else the
  // caller's hint (the report names an unlinked slide's layout) — a slide
  // type of the same name in the new layout is almost always the answer
  const wasNamed = new Map(deck.slides.map((sl) => {
    const type = sl.layoutId ? deck.layouts?.find((l) => l.id === sl.layoutId) : undefined
    return [sl.id, type?.name ?? hints.get(sl.id)] as const
  }))
  // the file's footers say things the new layout says through fields
  // ("© ACME" → {{footer}}, "- Intern -" → "- {{prop:Classification}} -"):
  // read what they can before the file's chrome goes
  const said = new Map<string, TextElement['footerRole']>()
  for (const s of [...deck.slides, ...(deck.layouts ?? [])]) {
    for (const e of s.elements) {
      if (e.type === 'text' && e.html.trim() && e.html.indexOf('{{') < 0 && e.html.length < 200) said.set(e.html, e.footerRole ?? said.get(e.html))
    }
  }
  const bindings: Bindings = { props: {} }
  for (const l of layout.layouts ?? []) {
    for (const e of l.elements) {
      if (e.type !== 'text' || e.html.search(BINDABLE) < 0) continue
      // a field with no words around it would read ANY text: only the
      // file's footer of the same kind may fill it
      const bare = !e.html.replace(BINDABLE, '').trim()
      for (const [text, role] of said) {
        if (bare && (!e.footerRole || role !== e.footerRole)) continue
        if (bindHtml(text, e.html, bindings)) break
      }
    }
  }
  const content = deck.slides.map((slide) => {
    const type = slide.layoutId ? deck.layouts?.find((l) => l.id === slide.layoutId) : undefined
    const chain = new Set(type ? ancestorChain(deck, type).flatMap((l) => l.elements.map((e) => e.id)) : [])
    const isDesign = designOf(chain)
    // a slot the slide filled keeps its content but leaves the file's id
    // space: the new layout's ids come from the same converter numbering
    return slide.elements.filter((e) => !isDesign(e)).map((e) => chain.has(e.id) ? { ...e, id: `${e.id}${FILE_SUFFIX}` } : e)
  })
  deck.layouts = []
  delete deck.defaultLayoutId
  if ('error' in adoptTemplateDesign(deck, layout)) return result
  deck.defaultLayoutId = defaultSlideType(deck).id
  if (layout.templateId) deck.basedOn = { templateId: layout.templateId, name }
  applyBindings(deck, bindings)
  const known = layoutElementIds(deck)
  const types = pickableSlideTypes(deck)
  const fallback = defaultSlideType(deck)
  deck.slides.forEach((slide, i) => {
    const bare: Slide = { ...slide, elements: content[i] }
    delete bare.layoutId
    let best: { type: Slide; score: number; preview: ReturnType<typeof relinkPreview> } | null = null
    for (const type of types.length ? types : [fallback]) {
      const preview = relinkPreview(deck, bare, type, known)
      // content should land near where it was: every px a slot moves or
      // resizes its donor counts against the type
      let moved = 0
      for (const { slot, donor } of matchLayout(bare, effectiveLayout(deck, type), known, ancestorElementIds(deck, type)).slots) {
        if (donor) moved += Math.abs(slot.x - donor.x) + Math.abs(slot.y - donor.y) + Math.abs(slot.w - donor.w) + Math.abs(slot.h - donor.h)
      }
      const named = !!type.name && type.name === wasNamed.get(slide.id)
      const score = preview.filled.length * 3 - preview.floating.length * 4 - preview.emptySlots.length - moved / 200 + (named ? 6 : 0)
        - decoration(deck, type) * 3
      if (!best || score > best.score || (score === best.score && type.id === fallback.id)) best = { type, score, preview }
    }
    if (!best) return
    slide.layoutId = best.type.id
    // the slide's own full-bleed picture stays its backdrop, under the chrome
    const els = best.preview.elements
    const backdrop = els.filter((e) => e.id.endsWith('-bg') && e.locked)
    slide.elements = [...backdrop, ...els.filter((e) => !backdrop.includes(e))]
    slide.background = effectiveLayout(deck, best.type).background
    if (best.preview.floating.length) {
      result.partial++
      for (const e of best.preview.floating) result.floating.push({ slideId: slide.id, slide: i + 1, elementId: e.id })
    } else result.fit++
  })
  return result
}
