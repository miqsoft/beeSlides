// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Deck-structure mutations shared by the editor UI (sidebar, Slide Sorter,
// Outline View) and the agent ops (agentops/deck.ts): ONE implementation per
// operation, so a slide an agent adds, duplicates or deletes goes through
// exactly what a click does. Free functions taking `store` explicitly.
import type { Store } from '../store'
import {
  effectiveLayout, inLinearFlow, instantiateLayout, isZoomElement, pruneDanglingZoomTiles, remapZoomTarget, retargetSectionZooms,
  sectionRange, uid, zoomTilesInto,
  type Section, type Slide, type SlidomingoDoc,
} from '../model'
import { slideBlocks } from './slideorder'
import { jsonClone } from '../jsonclone.ts'

/** Index just past slide `i`'s block (it and the states that follow it) —
 *  where something inserted "after" it must go, so it never lands between
 *  a parent and its states. When the insert carries a normal slide
 *  (`normal`), also past the rest of the extras run there: hidden slides
 *  after a normal one are ITS extras, so a new slide in front of them
 *  would silently take them over. */
export function afterSlideBlock(slides: Slide[], i: number, normal = true): number {
  let j = i + 1
  while (slides[j]?.stateOf) j++
  if (normal) while (slides[j] && !inLinearFlow(slides[j])) j++
  return Math.min(j, slides.length)
}

/** `count` new slides from `layout` at index `at`, in ONE commit. Only a
 *  REAL doc.layouts entry (`fromDocLayout`) gets a live link — a built-in
 *  has no persistent identity for a future master edit to point back to.
 *  `init` adjusts each new slide before the commit (an agent's names). */
export function insertSlidesFromLayout(store: Store, layout: Slide, at: number, count = 1, fromDocLayout = false, init?: (slide: Slide, k: number) => void): Slide[] {
  const made: Slide[] = []
  for (let k = 0; k < count; k++) {
    const slide = instantiateLayout(effectiveLayout(store.doc, layout))
    if (fromDocLayout) slide.layoutId = layout.id
    init?.(slide, k)
    made.push(slide)
  }
  store.commit(() => {
    store.doc.slides.splice(at, 0, ...made)
  }, 'slides')
  return made
}

/** Duplicate a set of slides in ONE commit (one undo step). A selected
 *  slide brings its interactive states along (re-pointed at the copy, as
 *  are links between them); the copies land together after the last
 *  selected slide's block (past its extras run when a copy is a normal
 *  slide; extras are not copied along). A state selected without its
 *  parent is copied as another state of that same parent. Returns the
 *  copies' ids, in the order of `ids`. */
export function duplicateSlidesInStore(store: Store, ids: string[]): string[] {
  const doc = store.doc
  const want = new Set(ids)
  if (!doc.slides.some((s) => want.has(s.id))) return []
  const copyOf = new Map<string, string>()
  store.commit(() => {
    const blocks = slideBlocks(doc.slides)
    const whole = blocks.filter((b) => !b[0].stateOf && want.has(b[0].id))
    // Duplicated slides keep element ids → set transition to morph and you
    // get PowerPoint-Morph behaviour for free.
    const copies = whole.flatMap((b) => cloneSlides(b, copyOf))
    // A normal copy lands past the extras run that follows (the hidden
    // slides after a normal one are ITS extras) — dropped right after the
    // original it took those extras over. Copies of extras only stay put.
    let k = blocks.indexOf(whole[whole.length - 1])
    if (k >= 0 && copies.some(inLinearFlow)) while (k + 1 < blocks.length && !inLinearFlow(blocks[k + 1][0])) k++
    const anchor = blocks[k]
    const next: Slide[] = []
    for (const b of blocks) {
      next.push(...b)
      if (b[0].stateOf || !want.has(b[0].id)) {
        for (const st of b) if (st.stateOf && want.has(st.id)) next.push(...cloneSlides([st], copyOf))
      }
      if (b === anchor) next.push(...copies)
    }
    doc.slides = next
  }, 'slides')
  return ids.map((id) => copyOf.get(id)).filter((id): id is string => !!id)
}

/** Deep copies with fresh ids; `stateOf` and element links that point
 *  inside the copied set are re-pointed at the copies (a duplicated slide's
 *  state buttons lead to the duplicated states). `copyOf` collects old→new. */
export function cloneSlides(slides: Slide[], copyOf: Map<string, string>): Slide[] {
  const local = new Map(slides.map((s) => [s.id, uid('slide')]))
  for (const [from, to] of local) copyOf.set(from, to)
  return slides.map((s) => {
    const c = jsonClone(s)
    c.id = local.get(s.id)!
    if (c.stateOf && local.has(c.stateOf)) c.stateOf = local.get(c.stateOf)
    for (const el of c.elements) if (el.link && local.has(el.link)) el.link = local.get(el.link)
    for (const el of c.elements) if (isZoomElement(el)) remapZoomTarget(el, local)
    return c
  })
}

/** Impact of deleting a set of slides: cascading dependent interactive
 *  states + inbound element links that would be cleared. Pure (no mutation)
 *  — callers use it to build confirm-dialog text before committing to
 *  anything real. */
export function slidesDeleteImpact(
  doc: SlidomingoDoc,
  ids: string[],
): { doomedIds: Set<string>; states: Slide[]; linkCount: number; zoomCount: number } {
  const doomedIds = new Set(ids)
  // states are hidden variants of a doomed slide — they die with their parent
  const states = doc.slides.filter((s) => s.stateOf && doomedIds.has(s.stateOf))
  for (const s of states) doomedIds.add(s.id)
  let linkCount = 0
  for (const s of doc.slides) {
    if (doomedIds.has(s.id)) continue
    for (const el of s.elements) if (el.link && doomedIds.has(el.link)) linkCount++
  }
  return { doomedIds, states, linkCount, zoomCount: zoomTilesInto(doc, doomedIds) }
}

/** "A deck needs at least one slide", checked against what will SURVIVE a
 *  deletion (see deleteSlidesByIds — states never count as survivors). */
export function survivesDeletion(doc: SlidomingoDoc, doomedIds: Set<string>): boolean {
  return doc.slides.some((s) => !s.stateOf && !doomedIds.has(s.id))
}

/**
 * Delete a set of slides by id — the ONE mutation path for both an ordinary
 * single-slide delete and a section's "delete N slides too". Cascades
 * dependent interactive states (states never count as survivors — issue
 * #30: they're unreachable except through a parent), clears dangling
 * element links, and reassigns/drops any Section whose startSlideId was
 * among the deleted ids. This is the direct fix for the layoutId-cleanup
 * bug class this feature was built to avoid: implemented exactly once and
 * called from both deletion paths, so it cannot go stale for one of them
 * the way a hand-duplicated cleanup could.
 *
 * A reassigned boundary only ever lands on a slide that was truly inside
 * that section's OWN original range (walked forward from its old start,
 * bounded by its old end — computed BEFORE the splice, from the doc as it
 * stood) — never on a neighbouring section's content. That bound is what
 * makes deleting a section's ENTIRE range (deleteSection's
 * deleteSlides:true) correctly DROP the section instead of reattaching its
 * name to whatever slide happens to slide into the gap.
 *
 * Returns false (no-op) if it would leave no slide in the linear flow.
 */
export function deleteSlidesByIds(store: Store, ids: string[]): boolean {
  const doc = store.doc
  const { doomedIds } = slidesDeleteImpact(doc, ids)
  if (!survivesDeletion(doc, doomedIds)) return false
  store.commit(() => {
    const oldSlides = doc.slides
    const oldRanges = new Map<string, { start: number; end: number }>()
    for (const sec of doc.sections ?? []) oldRanges.set(sec.id, sectionRange(doc, sec))

    doc.slides = oldSlides.filter((s) => !doomedIds.has(s.id))
    for (const s of doc.slides) {
      for (const el of s.elements) if (el.link && doomedIds.has(el.link)) delete el.link
    }

    if (doc.sections?.length) {
      const survivingIds = new Set(doc.slides.map((s) => s.id))
      const next: Section[] = []
      for (const sec of doc.sections) {
        if (!doomedIds.has(sec.startSlideId)) { next.push(sec); continue }
        const range = oldRanges.get(sec.id)!
        let replacement: string | undefined
        for (let i = range.start + 1; i < range.end; i++) {
          const cand = oldSlides[i]
          if (survivingIds.has(cand.id)) { replacement = cand.id; break }
        }
        if (replacement) { sec.startSlideId = replacement; next.push(sec) }
        // else: this section's entire range is gone — drop it, don't push
      }
      if (next.length) doc.sections = next
      else delete doc.sections
    }
    pruneDanglingZoomTiles(doc) // a zoom into a deleted slide/section has nothing left to show
  }, 'slides')
  return true
}

export function insertSectionBefore(store: Store, slideId: string, name: string): Section {
  const section: Section = { id: uid('section'), name, startSlideId: slideId }
  store.commit(() => {
    (store.doc.sections ??= []).push(section)
  }, 'slides')
  return section
}

export function renameSection(store: Store, sectionId: string, name: string) {
  store.commit(() => {
    const section = store.doc.sections?.find((s) => s.id === sectionId)
    if (section) section.name = name
  }, 'slides')
}

/**
 * deleteSlides:false ("ungroup") just removes the Section entry — slides
 * untouched, the safe default. deleteSlides:true computes the range's slide
 * ids and routes through deleteSlidesByIds, the SAME shared per-slide
 * delete path an ordinary single-slide delete uses.
 */
export function deleteSection(store: Store, sectionId: string, opts: { deleteSlides: boolean }) {
  const doc = store.doc
  const section = doc.sections?.find((s) => s.id === sectionId)
  if (!section) return
  if (!opts.deleteSlides) {
    store.commit(() => {
      retargetSectionZooms(doc, sectionId) // its zooms now zoom into its first slide
      doc.sections = doc.sections!.filter((s) => s.id !== sectionId)
      if (!doc.sections.length) delete doc.sections
    }, 'slides')
    return
  }
  const { start, end } = sectionRange(doc, section)
  if (start < 0) return
  const ids = doc.slides.slice(start, end).map((s) => s.id)
  deleteSlidesByIds(store, ids)
}
