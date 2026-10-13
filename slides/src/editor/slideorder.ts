// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Slide and section moves — the pure half of editor.ts's slide-panel write
// surface, split out so it runs (and is tested) without a DOM.
//
// The panel is read as a sequence of TOKENS: section headers and slide
// blocks (a slide plus the interactive states that follow it). Every move —
// a drag in the sidebar or Slide Sorter, ⌘↑/⌘↓ — is a permutation of these
// tokens, written back by applyTokens() inside ONE store.commit:
//   doc.slides            = the blocks, in order
//   section.startSlideId  = the first block after that section's header
//   header → header / end = the section is empty, so it is dropped
// The boundary-marker format (model.ts `Section`) is untouched; only which
// slide a marker names changes. Sections whose start no longer names a live
// slide (ignored by sectionsInOrder) are never tokens and survive as-is.
//
// The planners (moveSlidesTo, moveSectionTo, stepSlides) return the next
// token list, or null for a no-op, so a caller never commits an empty undo
// step.

import { extraParent, inLinearFlow, sectionsInOrder, type Section, type Slide, type SlidomingoDoc } from '../model'

export type Token =
  | { kind: 'header'; section: Section }
  | { kind: 'block'; slides: Slide[] }

/** The deck as move/copy units: each ordinary slide plus the interactive
 *  states that follow it in doc order. (A state never stands alone; a
 *  leading orphan state still gets a block of its own.) */
export function slideBlocks(slides: Slide[]): Slide[][] {
  const blocks: Slide[][] = []
  for (const s of slides) {
    if (s.stateOf && blocks.length) blocks[blocks.length - 1].push(s)
    else blocks.push([s])
  }
  return blocks
}

/** The panel as tokens. A section whose start is an interactive state is
 *  normalized onto that state's block: before it, or after it when the block
 *  already carries a header of its own (so neither section empties). */
export function tokensOf(doc: SlidomingoDoc): Token[] {
  const blocks = slideBlocks(doc.slides)
  const blockOf = new Map<string, number>()
  blocks.forEach((b, k) => { for (const s of b) blockOf.set(s.id, k) })
  const before = new Map<number, Section[]>()
  const after = new Map<number, Section[]>()
  for (const sec of sectionsInOrder(doc)) {
    const k = blockOf.get(sec.startSlideId)!
    const onState = blocks[k][0].id !== sec.startSlideId
    const into = onState && before.has(k) ? after : before
    if (!into.has(k)) into.set(k, [])
    into.get(k)!.push(sec)
  }
  const tokens: Token[] = []
  blocks.forEach((slides, k) => {
    for (const section of before.get(k) ?? []) tokens.push({ kind: 'header', section })
    tokens.push({ kind: 'block', slides })
    for (const section of after.get(k) ?? []) tokens.push({ kind: 'header', section })
  })
  return tokens
}

/** Write a token order back to the doc. Mutates — call inside store.commit.
 *  Returns whether anything changed. */
export function applyTokens(doc: SlidomingoDoc, tokens: Token[]): boolean {
  const slides = tokens.flatMap((t) => (t.kind === 'block' ? t.slides : []))
  const start = new Map<string, string>()
  tokens.forEach((t, k) => {
    const next = tokens[k + 1]
    if (t.kind === 'header' && next?.kind === 'block') start.set(t.section.id, next.slides[0].id)
  })
  const placed = new Set(tokens.flatMap((t) => (t.kind === 'header' ? [t.section.id] : [])))
  let changed = slides.length !== doc.slides.length || slides.some((s, i) => s !== doc.slides[i])
  doc.slides = slides
  if (doc.sections) {
    const next: Section[] = []
    for (const sec of doc.sections) {
      if (!placed.has(sec.id)) { next.push(sec); continue } // dangling — not ours to touch
      const to = start.get(sec.id)
      if (!to) { changed = true; continue } // emptied by this move — dropped
      if (sec.startSlideId !== to) { sec.startSlideId = to; changed = true }
      next.push(sec)
    }
    if (next.length) doc.sections = next
    else delete doc.sections
  }
  return changed
}

const sameOrder = (a: Token[], b: Token[]) => a.length === b.length && a.every((t, k) => t === b[k])

/** Remove the tokens at `picked` and re-insert them, in their original
 *  relative order, in front of token `at` (an index into `tokens` as it
 *  stood before the removal). Null when that changes nothing. */
function relocate(tokens: Token[], picked: Set<number>, at: number): Token[] | null {
  if (!picked.size) return null
  const moving = tokens.filter((_, k) => picked.has(k))
  const rest = tokens.filter((_, k) => !picked.has(k))
  let shifted = at
  for (const k of picked) if (k < at) shifted--
  const next = [...rest.slice(0, shifted), ...moving, ...rest.slice(shifted)]
  return sameOrder(next, tokens) ? null : next
}

/** A hidden, non-state block — an extra when a normal block precedes it. */
const isExtraBlock = (t: Token): boolean => t.kind === 'block' && !!t.slides[0].hidden && !t.slides[0].stateOf

/** Token indices of normal block `k`'s extras run: the hidden blocks right
 *  after it, up to the next normal block or header (model.ts extrasOf, read
 *  at token level). Empty when block `k` is not a normal-flow slide. */
function extrasRun(tokens: Token[], k: number): number[] {
  const t = tokens[k]
  if (t?.kind !== 'block' || !inLinearFlow(t.slides[0])) return []
  const run: number[] = []
  for (let j = k + 1; j < tokens.length && isExtraBlock(tokens[j]); j++) run.push(j)
  return run
}

/** Token indices of the blocks holding any of `slideIds` — a selected
 *  state brings its whole parent block, and a selected normal slide brings
 *  its extras run (extras are positional: left behind, they would re-nest
 *  under whatever slide then preceded them). A selected extra moves alone. */
function pickedBlocks(tokens: Token[], slideIds: Iterable<string>): Set<number> {
  const want = new Set(slideIds)
  const picked = new Set<number>()
  tokens.forEach((t, k) => { if (t.kind === 'block' && t.slides.some((s) => want.has(s.id))) picked.add(k) })
  for (const k of [...picked]) for (const j of extrasRun(tokens, k)) picked.add(j)
  return picked
}

/** Every slide id a move of `slideIds` carries — their blocks plus a normal
 *  slide's extras run (the panel dims these while dragging). */
export function movingSlideIds(doc: SlidomingoDoc, slideIds: Iterable<string>): Set<string> {
  const tokens = tokensOf(doc)
  const ids = new Set<string>()
  for (const k of pickedBlocks(tokens, slideIds)) {
    const t = tokens[k]
    if (t.kind === 'block') for (const s of t.slides) ids.add(s.id)
  }
  return ids
}

/** The tokens grouped into the units ⌘↑/⌘↓ step over: a header alone; a
 *  block together with the extras run that follows it. A run is cut where
 *  picked meets unpicked, so a selected extra still steps within its run,
 *  while a normal slide never lands between another slide and its extras. */
function stepUnits(tokens: Token[], picked: Set<number>): number[][] {
  const units: number[][] = []
  tokens.forEach((t, k) => {
    const cur = units[units.length - 1]
    const joins = cur && isExtraBlock(t) && tokens[cur[0]].kind === 'block' && picked.has(cur[0]) === picked.has(k)
    if (joins) cur.push(k)
    else units.push([k])
  })
  return units
}

/** Drag-drop of slides: the blocks holding `slideIds` go in front of token
 *  `at` (pre-removal index; tokens.length = the end of the deck). */
export function moveSlidesTo(doc: SlidomingoDoc, slideIds: Iterable<string>, at: number): Token[] | null {
  const tokens = tokensOf(doc)
  return relocate(tokens, pickedBlocks(tokens, slideIds), at)
}

/**
 * Drag-drop of slides AS EXTRAS (the sidebar's "drop to the right" gesture):
 * the same move as `moveSlidesTo`, after which the moved slides are hidden —
 * so they read as extras of the normal slide above them. `heads` are the
 * slides to hide (each moved block's own slide; its states ride along). Null
 * when the drop can't make extras — nothing normal above the slot, or it sits
 * right under a section header (a hidden section start) — or when it would
 * change nothing.
 */
export function moveSlidesAsExtras(doc: SlidomingoDoc, slideIds: Iterable<string>, at: number): { tokens: Token[]; heads: Slide[] } | null {
  const tokens = tokensOf(doc)
  const picked = pickedBlocks(tokens, slideIds)
  if (!picked.size) return null
  const moved = new Set(tokens.filter((_, k) => picked.has(k)))
  const next = relocate(tokens, picked, at) ?? tokens
  const first = next.findIndex((t) => moved.has(t))
  if (first < 1 || next[first - 1].kind !== 'block') return null
  const hasParent = next.slice(0, first).some((t) => t.kind === 'block' && !moved.has(t) && !t.slides[0].hidden)
  if (!hasParent) return null
  const heads = next.flatMap((t) => (t.kind === 'block' && moved.has(t) ? [t.slides[0]] : []))
  if (next === tokens && heads.every((h) => h.hidden)) return null
  return { tokens: next, heads }
}

/**
 * A plain sidebar drop of slides (the left part of the list — the opposite of
 * `moveSlidesAsExtras`): the same move as `moveSlidesTo`, after which every
 * dragged slide that WAS an extra is shown again, so it leaves its parent's
 * extras run and becomes a normal slide. `heads` are the slides to un-hide —
 * only ones named in `slideIds`; extras carried along by a dragged normal
 * slide stay its extras. A hidden slide that isn't an extra (a leading
 * orphan) keeps its flag. Null when it changes nothing.
 */
export function moveSlidesOutOfExtras(doc: SlidomingoDoc, slideIds: Iterable<string>, at: number): { tokens: Token[]; heads: Slide[] } | null {
  const want = new Set(slideIds)
  const heads = doc.slides.filter((s, i) => want.has(s.id) && extraParent(doc, i) >= 0)
  const next = moveSlidesTo(doc, want, at)
  if (!next && !heads.length) return null
  return { tokens: next ?? tokensOf(doc), heads }
}

/**
 * Where a "drop beside slide X" gesture inserts, to make the dropped slides
 * extras of X — a token index for `moveSlidesAsExtras`. A normal slide takes
 * them at the END of its extras run (after its block and the hidden blocks
 * that follow, stopping at the next normal block or header); an extra takes
 * them right after itself, joining the same run. A state counts as its
 * parent's block. Null when X can't host extras (hidden with no normal slide
 * above it) or isn't on the panel.
 */
export function extraDropAt(doc: SlidomingoDoc, targetSlideId: string): number | null {
  const tokens = tokensOf(doc)
  const k = tokens.findIndex((t) => t.kind === 'block' && t.slides.some((s) => s.id === targetSlideId))
  if (k < 0) return null
  const head = (tokens[k] as Extract<Token, { kind: 'block' }>).slides[0]
  if (head.stateOf) return null // a leading orphan state
  if (head.hidden) return extraParent(doc, doc.slides.indexOf(head)) >= 0 ? k + 1 : null
  if (!inLinearFlow(head)) return null
  let at = k + 1
  while (at < tokens.length) {
    const t = tokens[at]
    if (t.kind !== 'block' || !t.slides[0].hidden || t.slides[0].stateOf) break
    at++
  }
  return at
}

/** [header index, end) of a section's run of tokens — its header plus every
 *  block up to the next header. Null when the section isn't on the panel. */
function sectionSpan(tokens: Token[], sectionId: string): [number, number] | null {
  const h = tokens.findIndex((t) => t.kind === 'header' && t.section.id === sectionId)
  if (h < 0) return null
  let e = h + 1
  while (e < tokens.length && tokens[e].kind === 'block') e++
  return [h, e]
}

/** Drag-drop of a section: its header and blocks move as one unit in front
 *  of token `at` (pre-removal index). */
export function moveSectionTo(doc: SlidomingoDoc, sectionId: string, at: number): Token[] | null {
  const tokens = tokensOf(doc)
  const span = sectionSpan(tokens, sectionId)
  if (!span) return null
  const picked = new Set<number>()
  for (let k = span[0]; k < span[1]; k++) picked.add(k)
  return relocate(tokens, picked, at)
}

/** ⌘↑/⌘↓ (one token) and ⌘⇧↑/⌘⇧↓ (to the start/end). A picked block
 *  swaps with whatever token is next to it — a header too, which is how a
 *  slide steps across a section boundary; a normal slide and its extras run
 *  count as one token on either side of the swap (stepUnits). 'start' puts everything before the
 *  first header (unsectioned), 'end' after the last slide. */
export function stepSlides(doc: SlidomingoDoc, slideIds: Iterable<string>, dir: -1 | 1 | 'start' | 'end'): Token[] | null {
  const tokens = tokensOf(doc)
  const picked = pickedBlocks(tokens, slideIds)
  if (!picked.size) return null
  let order = tokens.map((_, k) => k)
  if (dir === 'start' || dir === 'end') {
    const moving = order.filter((k) => picked.has(k))
    const rest = order.filter((k) => !picked.has(k))
    order = dir === 'start' ? [...moving, ...rest] : [...rest, ...moving]
  } else {
    // One step = past one neighbouring UNIT (a slide with its extras run), so
    // a normal slide never lands inside someone's run. A picked EXTRA steps
    // past one token only, as before: within its run, it passes one sibling.
    const units = stepUnits(tokens, picked)
    const up = (u: number[]) => picked.has(u[0])
    const extra = (u: number[]) => isExtraBlock(tokens[u[0]])
    if (dir === -1) {
      for (let k = 1; k < units.length; k++) {
        if (!up(units[k]) || up(units[k - 1])) continue
        const prev = units[k - 1]
        if (extra(units[k]) && prev.length > 1) units.splice(k - 1, 2, prev.slice(0, -1), units[k], prev.slice(-1))
        else [units[k - 1], units[k]] = [units[k], units[k - 1]]
      }
    } else {
      for (let k = units.length - 2; k >= 0; k--) {
        if (!up(units[k]) || up(units[k + 1])) continue
        const next = units[k + 1]
        if (extra(units[k]) && next.length > 1) units.splice(k, 2, next.slice(0, 1), units[k], next.slice(1))
        else [units[k], units[k + 1]] = [units[k + 1], units[k]]
      }
    }
    order = units.flat()
  }
  const next = order.map((k) => tokens[k])
  return sameOrder(next, tokens) ? null : next
}

/** Where a drop slot's indicator goes: above a header, hugging a header's
 *  bottom ("first slide of this section"), above a thumbnail, or after the
 *  last thing on the panel. `id` is the section or slide it anchors to. */
export interface DropSlot {
  at: number
  anchor: 'beforeHeader' | 'afterHeader' | 'beforeThumb' | 'end'
  id?: string
}

/**
 * Every position a drag may drop at, in visual order. `hidden` is the doc
 * indices inside collapsed sections (editor.ts collapsedSlideIndices) —
 * their thumbs aren't rendered, so they offer no slots of their own.
 *
 * slides mode: before every visible block; after every header (the section's
 * first slide — a collapsed section too); before every header (the end of
 * the section above), except the first header when nothing is above it (that
 * would mint an unsectioned slide by accident) and a header right under a
 * collapsed section (it would sit on that section's own after-header slot);
 * and the end of the deck.
 *
 * section mode (`sectionId` = the dragged one): before every header except
 * its own and the next one (both no-ops), and the end unless it is already
 * last. Slots only ever sit at headers, so a section can never land above a
 * leading unsectioned run — derived membership would absorb those slides.
 */
export function dropSlots(doc: SlidomingoDoc, mode: 'slides' | 'section', hidden: Set<number>, sectionId?: string): DropSlot[] {
  const tokens = tokensOf(doc)
  const slots: DropSlot[] = []
  if (mode === 'section') {
    const span = sectionId ? sectionSpan(tokens, sectionId) : null
    tokens.forEach((t, k) => {
      if (t.kind !== 'header' || (span && (k === span[0] || k === span[1]))) return
      slots.push({ at: k, anchor: 'beforeHeader', id: t.section.id })
    })
    if (!span || span[1] !== tokens.length) slots.push({ at: tokens.length, anchor: 'end' })
    return slots
  }
  const indexOf = new Map(doc.slides.map((s, i) => [s.id, i]))
  const visible = (t: Token) => t.kind === 'block' && !hidden.has(indexOf.get(t.slides[0].id)!)
  let collapsedAbove = false
  tokens.forEach((t, k) => {
    if (t.kind === 'header') {
      if (k > 0 && !collapsedAbove) slots.push({ at: k, anchor: 'beforeHeader', id: t.section.id })
      slots.push({ at: k + 1, anchor: 'afterHeader', id: t.section.id })
      const first = tokens[k + 1]
      collapsedAbove = first?.kind === 'block' && !visible(first)
      return
    }
    if (!visible(t)) return
    if (tokens[k - 1]?.kind !== 'header') slots.push({ at: k, anchor: 'beforeThumb', id: t.slides[0].id })
  })
  slots.push({ at: tokens.length, anchor: 'end' })
  return slots
}
