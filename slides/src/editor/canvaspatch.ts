// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The canvas's incremental redraw (SlideCanvas.render, mode 'patch'): when the
// surface on screen already shows this slide and only some elements changed,
// only those element nodes are drawn again, through render.ts
// `renderSlideElement` — the same per-element path `renderSlide` takes, so a
// patched surface equals a fresh full render (scripts/test-canvas-patch-e2e.mjs).
//
// What decides "changed":
//   - a signature of everything outside the elements that the surface is drawn
//     from (doc-level fields, the slide's own fields, field values, fonts,
//     footer, locks, hover set, view state) — any difference = full render;
//   - the element ids in order — any difference = full render;
//   - a signature per element (its JSON), plus element types that read other
//     slides or the clock (`alwaysRedraw`) — those elements are redrawn;
//   - DOM dirt: any mutation of an element node's subtree since it was drawn
//     that the canvas did not make itself (a Moveable gesture, a math preview,
//     a hover highlight, a text edit) — that element is redrawn, exactly as a
//     full render would have reset it.

import type { SlideElement } from '../model'

/** A JSON signature. Strings longer than BIG (pictures as `data:` URIs, svg
 *  markup, fonts) are not copied into the JSON: they are compared by identity
 *  first, which is what makes a 5 MB picture cost nothing per step. */
export type Sig = { json: string; big: string[] }

const BIG = 256
const NUL = '\u0000'

export function signature(value: unknown): Sig {
  const big: string[] = []
  const json = JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v !== 'string') return v
    if (v.length > BIG) { big.push(v); return NUL + (big.length - 1) }
    // a real string that starts with NUL can never read as a placeholder
    return v.startsWith(NUL) ? NUL + v : v
  }) ?? ''
  return { json, big }
}

export function sameSig(a: Sig, b: Sig): boolean {
  if (a.json !== b.json || a.big.length !== b.big.length) return false
  for (let i = 0; i < a.big.length; i++) if (a.big[i] !== b.big[i]) return false
  return true
}

/** Elements whose drawing depends on more than their own JSON and the
 *  surface context: a code block diffs against the neighbouring slides, a zoom
 *  tile draws another slide, a text field may show the time. Redrawn on every
 *  patch pass (each costs what it cost in the full render). */
export function alwaysRedraw(el: SlideElement): boolean {
  return el.type === 'code' || el.type === 'zoom' || (el.type === 'text' && el.html.includes('{{'))
}

/** The box comment pins and build badges are placed by. */
export function frameKey(el: SlideElement): string {
  return `${el.x},${el.y},${el.w},${el.h},${el.rotation ?? 0}`
}

/** Make `old` (kept, so Moveable's and Selecto's targets stay the same nodes)
 *  look exactly like the freshly rendered `next`: same attributes in the same
 *  order, `next`'s children. */
export function patchNode(old: HTMLElement, next: HTMLElement): void {
  for (const a of Array.from(old.attributes)) old.removeAttribute(a.name)
  for (const a of Array.from(next.attributes)) old.setAttribute(a.name, a.value)
  old.replaceChildren(...Array.from(next.childNodes))
}

/**
 * Element nodes of the shown surface whose DOM changed since the canvas drew
 * them. A MutationObserver on the surface; the canvas wraps its own DOM work
 * (`own`) so only someone else's mutations count.
 */
export class DomDirt {
  private surface: HTMLElement | null = null
  private readonly observer: MutationObserver | null
  /** element nodes (direct children of the surface) touched since the last take */
  private nodes = new Set<HTMLElement>()
  /** the surface itself was touched (its attributes, its child list) */
  private whole = false

  constructor() {
    this.observer = typeof MutationObserver === 'function' ? new MutationObserver((rs) => this.absorb(rs)) : null
  }

  /** Start over on a freshly drawn surface. */
  watch(surface: HTMLElement): void {
    this.observer?.disconnect()
    this.surface = surface
    this.nodes.clear()
    this.whole = !this.observer // no observer: never trust the DOM
    this.observer?.observe(surface, { subtree: true, childList: true, attributes: true, characterData: true })
  }

  /** Run the canvas's own DOM work: mutations made inside `fn` are not dirt. */
  own<T>(fn: () => T): T {
    if (this.observer) this.absorb(this.observer.takeRecords())
    try { return fn() } finally { this.observer?.takeRecords() }
  }

  /** Everything recorded since the last take, then a clean slate. */
  take(): { whole: boolean; nodes: Set<HTMLElement> } {
    if (this.observer) this.absorb(this.observer.takeRecords())
    const out = { whole: this.whole, nodes: this.nodes }
    this.nodes = new Set()
    this.whole = !this.observer
    return out
  }

  private absorb(records: MutationRecord[]): void {
    const surface = this.surface
    if (!surface) return
    for (const r of records) {
      if (r.target === surface) { this.whole = true; continue }
      let n: Node | null = r.target
      while (n && n.parentNode !== surface) n = n.parentNode
      if (n) this.nodes.add(n as HTMLElement)
      // a node no longer under the surface is not shown: nothing to redraw
    }
  }
}
