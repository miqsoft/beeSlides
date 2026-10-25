// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Deck-wide settings and interactive states, shared by the editor UI
// (panels.ts, layoutmanager.ts) and the agent ops (agentops.ts): page size
// presets, the slideshow block, header & footer, footer text boxes, states.
// Free functions on `store`/`doc`, no DOM — the same normalising rules
// (defaults are deleted, empty blocks dropped) whichever surface writes.
import { PAGE_SIZE_PRESETS } from '../agentops/spec'
import type { Store } from '../store'
import {
  defaultText, readableInk, uid,
  type FooterRole, type Slide, type SlideElement, type SlidomingoDoc,
} from '../model'
import { jsonClone } from '../jsonclone.ts'

// ---- page size -------------------------------------------------------------------

/** The page sizes the Slide panel offers (label → px); the numbers are the
 *  agent `size` presets' (agentops/spec.ts), so both offer the same pages. */
export const PAGE_PRESETS: Record<string, { w: number; h: number }> = {
  'Widescreen 16:9': PAGE_SIZE_PRESETS['16:9'],
  'Classic 4:3': PAGE_SIZE_PRESETS['4:3'],
  'Square 1:1': PAGE_SIZE_PRESETS['1:1'],
  'Portrait 9:16': PAGE_SIZE_PRESETS['9:16'],
  'A4 landscape': PAGE_SIZE_PRESETS['a4-landscape'],
  'A4 portrait': PAGE_SIZE_PRESETS['a4-portrait'],
}

/** A page edge in px, as the size fields allow it. */
export const clampPageEdge = (v: number): number => Math.max(320, Math.min(4000, Math.round(v)))

// ---- slideshow (doc.present) -------------------------------------------------------

export type PresentFlag = 'slideNumber' | 'progress' | 'controls' | 'numberHidden' | 'loop'

/** What each switch means when absent. */
export const PRESENT_DEFAULTS: Record<PresentFlag, boolean> = { slideNumber: true, progress: true, controls: false, numberHidden: false, loop: false }

export interface PresentPatch extends Partial<Record<PresentFlag, boolean>> {
  /** Seconds per slide; 0 = manual. */
  autoAdvance?: number
  /** Morph duration in seconds (0.1..6); 0 = the default. */
  morphSeconds?: number
}

/** Applies a patch to doc.present (call inside a commit/edit). A value equal
 *  to its default is deleted rather than written, and an empty block is
 *  dropped, so a deck that never touches these carries no `present`. */
export function patchPresent(doc: SlidomingoDoc, patch: PresentPatch): void {
  const cur = { ...(doc.present ?? {}) }
  for (const k of Object.keys(PRESENT_DEFAULTS) as PresentFlag[]) {
    const v = patch[k]
    if (v === undefined) continue
    if (v === PRESENT_DEFAULTS[k]) delete cur[k]
    else cur[k] = v
  }
  if (patch.autoAdvance !== undefined) {
    if (patch.autoAdvance > 0) cur.autoAdvance = Math.min(patch.autoAdvance, 86400)
    else delete cur.autoAdvance
  }
  if (patch.morphSeconds !== undefined) {
    if (patch.morphSeconds > 0) cur.morphSeconds = Math.min(Math.max(patch.morphSeconds, 0.1), 6)
    else delete cur.morphSeconds
  }
  if (Object.keys(cur).length) doc.present = cur
  else delete doc.present
}

// ---- header & footer ---------------------------------------------------------------

export type HeaderFooter = NonNullable<SlidomingoDoc['headerFooter']>

/** One undo step that edits a copy of doc.headerFooter and writes it back
 *  normalised: `show` only when false, empty strings and parts dropped. */
export function commitHeaderFooter(store: Store, mut: (hf: HeaderFooter) => void): void {
  store.commit(() => {
    const hf: HeaderFooter = jsonClone(store.doc.headerFooter ?? {})
    mut(hf)
    for (const k of ['date', 'slideNumber', 'footer'] as const) {
      const part = hf[k] as Record<string, unknown> | undefined
      if (!part) continue
      if (part.show !== false) delete part.show
      for (const [pk, pv] of Object.entries(part)) if (pv === '' || pv === undefined) delete part[pk]
      if (!Object.keys(part).length) delete hf[k]
    }
    if (!hf.hideOnTitle) delete hf.hideOnTitle
    if (Object.keys(hf).length) store.doc.headerFooter = hf
    else delete store.doc.headerFooter
  })
}

/** A footer text box for `role`, placed along the bottom edge (date left,
 *  footer centre, slide number right), readable on `bg`. */
export function footerElement(doc: SlidomingoDoc, role: FooterRole, bg: string): SlideElement {
  const { width, height } = doc.size
  const base = { y: height - 40 - 26, h: 26, valign: 'middle' as const, fontSize: 13, color: readableInk(bg), footerRole: role }
  if (role === 'slideNumber') return defaultText({ ...base, x: width - 96 - 160, w: 160, html: '{{page}} / {{pages}}', align: 'right', fontWeight: 700 })
  if (role === 'date') return defaultText({ ...base, x: 96, w: 220, html: '{{date}}', align: 'left' })
  return defaultText({ ...base, x: width / 2 - 260, w: 520, html: '{{footer}}', align: 'center' })
}

/** The footer roles that have a text box somewhere (deck slides or slide types). */
export function footerRolesInUse(doc: SlidomingoDoc): Set<FooterRole> {
  const roles = new Set<FooterRole>()
  for (const s of [...doc.slides, ...(doc.layouts ?? [])]) {
    for (const e of s.elements) if (e.type === 'text' && e.footerRole) roles.add(e.footerRole)
  }
  return roles
}

/** Shows or hides one footer role on one slide (Slide.footer override;
 *  call inside a commit/edit). Visible is the default, so it is deleted. */
export function setSlideFooterVisible(slide: Slide, role: FooterRole, visible: boolean): void {
  const next = { ...(slide.footer ?? {}) }
  if (visible) delete next[role]
  else next[role] = false
  if (Object.keys(next).length) slide.footer = next
  else delete slide.footer
}

// ---- interactive states ------------------------------------------------------------

/** Duplicates slide `srcId` as a new interactive state (states of a state
 *  share one parent), keeping element ids so it morphs, right after the
 *  parent's existing states. With `linkFrom`, that element on the source
 *  slide links to the new state. One commit; returns the state. */
export function addLinkedState(store: Store, srcId: string, linkFrom?: string, name?: string): Slide | null {
  const doc = store.doc
  const src = doc.slides.find((s) => s.id === srcId)
  if (!src) return null
  const clone = jsonClone(src)
  clone.id = uid('slide')
  clone.stateOf = src.stateOf ?? src.id
  clone.name = name || `${src.name ?? 'state'} ${doc.slides.filter((s) => s.stateOf === clone.stateOf).length + 2}`
  clone.transition = 'morph'
  delete clone.hover // inherit nothing implicit; user can re-enable
  if (src.hover) clone.hover = { ...src.hover }
  // right after the parent and its existing states: the family stays together
  const parentIdx = doc.slides.findIndex((s) => s.id === clone.stateOf)
  let insertAt = parentIdx + 1
  while (doc.slides[insertAt]?.stateOf === clone.stateOf) insertAt++
  store.commit(() => {
    doc.slides.splice(insertAt, 0, clone)
    const live = linkFrom ? src.elements.find((e) => e.id === linkFrom) : undefined
    if (live) live.link = clone.id
  }, 'slides')
  return clone
}

/** Pulls the parent's elements into state `stateId`: elements the state
 *  shares (same id) keep the state's own version — its whole point —,
 *  parent elements it lacks are copied in, state-only ones stay on top.
 *  One commit. An error string when there is nothing to sync against. */
export function syncStateWithParent(store: Store, stateId: string): { added: number; kept: number } | string {
  const state = store.doc.slides.find((s) => s.id === stateId)
  const parent = state?.stateOf ? store.doc.slides.find((s) => s.id === state.stateOf) : undefined
  if (!state || !parent) return 'This slide is not an interactive state.'
  const own = new Map(state.elements.map((e) => [e.id, e]))
  // only states that share lineage with the parent — otherwise "merging"
  // would just stack two full copies of everything
  if (state.elements.length && !parent.elements.some((pe) => own.has(pe.id))) return 'This state shares no element ids with its parent — nothing to sync against'
  let added = 0
  const merged: SlideElement[] = parent.elements.map((pe) => {
    const mine = own.get(pe.id)
    if (mine) { own.delete(pe.id); return mine }
    added++
    return jsonClone(pe)
  })
  const extras = [...own.values()]
  store.commit(() => { state.elements = [...merged, ...extras] })
  return { added, kept: extras.length }
}
