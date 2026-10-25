// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The slide list's thumbnail cache (editor.ts rebuildSidebar / scheduleThumbs).
//
// Every 'doc' event used to re-render EVERY sidebar thumbnail through
// renderSlide (charts, math, svg and all), although an edit almost always
// touches one slide. Each thumbnail now remembers a key of everything its
// render reads, and is re-rendered only when that key changes; a full
// rebuildSidebar (move, delete, undo, a lock badge) reuses unchanged surfaces
// too.
//
// The key is deliberately conservative — a stale thumbnail is a bug, a
// redundant render only costs time:
//   - the deck part: every top-level doc field except `slides`, `assets`,
//     `modified` and the editor overlays `guides`/`layoutGrid` (theme/palette,
//     layouts and their fonts, header/footer, meta and custom props, terms,
//     size, kind, iconset styles, present.numberHidden, sections,
//     rootFontLayoutId …), a generation counter for `assets` (by
//     value, cheaply: entries are compared string by string), and the
//     editor's `extra` (UI language, offline mode, the icon style shown);
//   - the slide's own JSON, minus what no render reads (comments, notes,
//     htmlSource — badges are refreshed separately by the editor);
//   - when the slide holds a field token ({{page}}, {{pages}} …): its page
//     number and the page count (fieldContext), and for {{date}}/{{time}} the
//     current minute;
//   - per zoom tile: its cover slide's JSON (+ the cover's own page context),
//     and the background of each cover a tile ON the cover shows (render.ts
//     renderZoomTile draws those as still boxes);
//   - the thumbnail width (sidebar width, 0.84× for states and extras).
// Anything the renderer starts reading from `doc` outside `slides` is covered
// by the deck part automatically; a new dependency on ANOTHER slide (as zoom
// tiles have) must be added to `slideKey`. Rig: scripts/test-thumb-cache.ts.

import { paginates, zoomCover, type Slide, type SlidomingoDoc } from '../model'

/** One pass over the deck: the parts of the key shared by every thumbnail. */
export interface ThumbPass {
  doc: SlidomingoDoc
  deck: string
  /** fieldContext's `page` of the slide at each index */
  pageAt: number[]
  pages: number
  minute: number
  /** slide ids handed a surface in this pass (a duplicate id never shares one) */
  used: Set<string>
  /** surfaces rendered (not reused) in this pass — diagnostics */
  rendered: number
}

const DATE_FIELD = /\{\{\s*(?:date|time)\b/i

/** A slide's own part of the key: what a render of it reads. */
function ownJson(slide: Slide): string {
  return JSON.stringify({ ...slide, comments: undefined, notes: undefined, htmlSource: undefined })
}

/** Where a slide's field tokens resolve differently by position or time. */
function fieldPart(pass: ThumbPass, json: string, index: number): string {
  if (!json.includes('{{')) return ''
  return `\u0001${pass.pageAt[index] ?? -1}/${pass.pages}${DATE_FIELD.test(json) ? `@${pass.minute}` : ''}`
}

/** The full key of `slide` at `index`, rendered `width` px wide. */
export function slideKey(pass: ThumbPass, slide: Slide, index: number, width: number): string {
  const own = ownJson(slide)
  let key = `${pass.deck}\u0002${width}\u0002${own}${fieldPart(pass, own, index)}`
  for (const el of slide.elements) {
    if (el.type !== 'zoom') continue
    const cover = zoomCover(pass.doc, el)
    if (!cover) { key += '\u0003-'; continue }
    const json = ownJson(cover)
    key += `\u0003${json}${fieldPart(pass, json, pass.doc.slides.indexOf(cover))}`
    for (const inner of cover.elements) {
      if (inner.type === 'zoom') key += `\u0004${zoomCover(pass.doc, inner)?.background ?? '-'}`
    }
  }
  return key
}

export class ThumbCache {
  private entries = new Map<string, { key: string; surface: HTMLElement }>()
  private assetsSeen = new Map<string, string>()
  private assetsGen = 0

  /** Start a pass: computes the deck-wide part of the key once. `extra` is
   *  editor state outside the doc that a thumbnail shows. */
  begin(doc: SlidomingoDoc, extra: string): ThumbPass {
    const rest: Partial<SlidomingoDoc> = { ...doc }
    delete rest.slides
    delete rest.assets
    delete rest.modified
    // editor overlays no render reads; a guide drag must not re-render the list
    delete rest.guides
    delete rest.layoutGrid
    const pageAt: number[] = []
    let page = 0
    for (const s of doc.slides) { if (paginates(s, doc)) page++; pageAt.push(page) }
    return {
      doc,
      deck: `${JSON.stringify(rest)}\u0002${this.assetsStamp(doc)}\u0002${extra}`,
      pageAt,
      pages: page,
      minute: Math.floor(Date.now() / 60000),
      used: new Set(),
      rendered: 0,
    }
  }

  /** `doc.assets` changes bump a counter. The entries are compared one by one
   *  (identical strings compare by pointer), so a pass never serialises
   *  megabytes of pictures; an undo (a re-parsed doc) costs one compare. */
  private assetsStamp(doc: SlidomingoDoc): number {
    const assets = doc.assets ?? {}
    const keys = Object.keys(assets)
    let same = keys.length === this.assetsSeen.size
    if (same) for (const k of keys) if (this.assetsSeen.get(k) !== assets[k]) { same = false; break }
    if (!same) {
      this.assetsSeen = new Map(Object.entries(assets))
      this.assetsGen++
    }
    return this.assetsGen
  }

  /** The surface for `slide` at `index`: the cached one while its key holds,
   *  else a fresh `render()`. */
  surface(pass: ThumbPass, slide: Slide, index: number, width: number, render: () => HTMLElement): HTMLElement {
    if (pass.used.has(slide.id)) { pass.rendered++; return render() }
    pass.used.add(slide.id)
    const key = slideKey(pass, slide, index, width)
    const hit = this.entries.get(slide.id)
    if (hit && hit.key === key) return hit.surface
    pass.rendered++
    const surface = render()
    this.entries.set(slide.id, { key, surface })
    return surface
  }

  /** After a full rebuild: forget every slide the pass did not show. */
  prune(pass: ThumbPass) {
    for (const id of [...this.entries.keys()]) if (!pass.used.has(id)) this.entries.delete(id)
  }
}
