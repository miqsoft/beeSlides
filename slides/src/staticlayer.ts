// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The full-deck static declarative layer ("slidomingo/deck"): what every slide in
// this file looks like to something that renders HTML but never runs
// JavaScript — generalizing preview.ts's first-page-only, thumbnail-fidelity
// trick to every slide, at full fidelity, as PRIMARY saved content rather
// than a disposable thumbnail. See kernel/src/save.ts's writeStaticLayer for
// the placement rules, the encryption veto and the output-safety check —
// this module only builds the markup; the kernel decides whether it is
// allowed to reach the file at all.
//
// WHY IT REUSES render.ts, and why it does NOT reuse preview.ts's staticize()
// despite the obvious overlap: staticize() unconditionally strips
// video/audio/iframe because preview.ts *never* wants a live media element
// (svgAsImage already renders media as a poster/icon still, so there is
// nothing live left to strip — the removal there is defence in depth, not
// load-bearing). This layer is the opposite: it WANTS real, playable
// <video controls>/<audio controls> — full fidelity is the entire point —
// and gets that safely by asking render.ts for it directly (liveMedia:true)
// rather than by relaxing a stripping pass built for a different goal.
// `embed` still never gets a live iframe here (inertEmbed:true) — same
// belt-and-suspenders posture render.ts's own 'embed' case already documents
// for svgAsImage. Author content that DOES reach this layer's DOM (text/
// table cell html, svg markup) arrives through render.ts's own
// sanitizeHtml/sanitizeSvg allowlists — already safe by construction, not
// re-sanitized here — with kernel/src/save.ts's previewIsSafe as the final,
// independent check over the whole assembled markup.
//
// EVERY PICTURE IS STORED ONCE, in the file's asset store (kernel/src/
// assetstore.ts). render.ts inlines every <img>'s full data: URI; this module
// marks each box-filling one as storable, and the kernel turns it into a div
// that draws the SAME bytes through CSS content replacement from one rule in
// #beeslides-assets, with the img's own object-fit and radius — the JSON then
// refers to those bytes instead of carrying them a second time. Lossless by
// construction: nothing is downscaled or re-encoded, ever (product rule — size
// is fine, quality is sacred). See docs/DECISIONS.md 2026-09-28 (both entries).

import {
  type SlidomingoDoc, type Slide, inLinearFlow,
} from './model'
import { renderSlide, fieldContext } from './render'
import { inlineRuntimeCss, markStorable } from './staticrender'
import { STORABLE_ATTR, type AssetStoreSpec } from './save'

/**
 * Total serialized-byte ceiling before the fallback tier kicks in.
 *
 * Unlike PREVIEW_BUDGET (64KB, one slide, thumbnail-fidelity) this covers the
 * WHOLE deck at full fidelity, so it is sized two orders of magnitude up —
 * embedded video is the dominant cost by far (a single MEDIA_EMBED_BUDGET
 * clip is already most of this on its own), not text/shape/table/chart
 * content, which stays in every tier.
 */
export const STATIC_LAYER_BUDGET = 6 * 1024 * 1024 // 6 MB

/**
 * What the layer will cost in the file: its markup, with each distinct
 * storable picture counted once — the store writes every picture once, so
 * repeats cost a class name, not the bytes.
 */
function layerBytes(root: HTMLElement): number {
  const enc = new TextEncoder()
  let total = enc.encode(root.outerHTML).length
  const seen = new Set<string>()
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>(`img[${STORABLE_ATTR}]`))) {
    const src = img.getAttribute('src') ?? ''
    if (!seen.has(src)) { seen.add(src); continue }
    total -= src.length // data: URIs are ASCII in practice; close enough for a budget
  }
  return total
}

/**
 * Resolve a slide's `hover:'reveal'` resting frame: the `default` set when
 * declared, else the first `showOnHover` group encountered in document
 * order (confirmed product decision — see the format's design notes).
 * `focus-group` slides need no equivalent: their resting frame is simply
 * every element visible and undimmed, which renderSlide already produces.
 */
export function applyHoverDefault(page: HTMLElement, slide: Slide): void {
  if (slide.hover?.type !== 'reveal') return
  const firstGroup = slide.elements.find((e) => e.showOnHover)?.showOnHover
  const chosen = slide.hover.default ?? firstGroup
  if (!chosen) return
  for (const el of slide.elements) {
    if (!el.showOnHover || el.showOnHover === chosen) continue
    const node = page.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (node) node.style.display = 'none'
  }
}

/**
 * Namespace `data-el-id` per slide, and any svg `<style>` scoped to it.
 *
 * render.ts's gradient/marker ids are already globally unique (a module
 * counter — see its own comment on gradSeq/markSeq, added because the same
 * element already renders simultaneously on the canvas, in thumbnails and in
 * the present overlay). `data-el-id` is not: it is the model's OWN element
 * id, which routinely repeats across slides (the duplicate-a-slide morph
 * idiom, layout-instantiated chrome). That is harmless everywhere render.ts
 * is used today because only ONE slide's worth of markup is ever live in the
 * DOM at once — this layer breaks that assumption outright by rendering
 * EVERY slide into one document, so a shared element id would otherwise let
 * one slide's svg `[data-el-id="…"]`-scoped <style> rule (render.ts's own
 * scopeCss call for SvgElement.css, hard-won gotcha #7's class of bug) leak
 * into another slide's element sharing that same id.
 */
function namespaceElementIds(page: HTMLElement, slideId: string): void {
  for (const node of Array.from(page.querySelectorAll<HTMLElement>('[data-el-id]'))) {
    const oldId = node.dataset.elId!
    const newId = `${slideId}:${oldId}`
    node.dataset.elId = newId
    const selOld = `[data-el-id="${CSS.escape(oldId)}"]`
    const selNew = `[data-el-id="${CSS.escape(newId)}"]`
    for (const style of Array.from(node.querySelectorAll('style'))) {
      if (style.textContent?.includes(selOld)) {
        style.textContent = style.textContent.split(selOld).join(selNew)
      }
    }
  }
}

/** Render one slide's elements at full fidelity. */
function renderSlideStatic(slide: Slide, doc: SlidomingoDoc, staticMediaStill: boolean): HTMLElement {
  const fields = fieldContext(doc, slide)
  const page = renderSlide(slide, doc, {
    hidePlaceholders: true, liveMedia: true, inertEmbed: true, staticMediaStill, fields,
    // written into the saved file: the document's own bytes, never blob: URLs
    inlineData: true, stillTrails: true,
  })
  applyHoverDefault(page, slide)
  namespaceElementIds(page, slide.id)
  return page
}

/**
 * What the asset store should hold beyond what the layer draws (registered
 * with the kernel from main.ts): every embedded picture in `doc.assets` —
 * including ones only an unused slide type or a hidden slide uses, since a
 * CSS rule nothing draws costs nothing — and every embedded font, whose
 * @font-face the store now carries for the layer and any no-JS reader.
 * Pictures written inline on an element (not through `doc.assets`) are
 * stored when the layer draws them, and otherwise simply stay inline.
 */
export function assetStoreSpec(doc: SlidomingoDoc): AssetStoreSpec {
  const assets = doc.assets ?? {}
  const images = Object.values(assets).filter((v) => typeof v === 'string' && v.startsWith('data:image/'))
  const fonts = (doc.fonts ?? []).flatMap((f) => {
    const uri = assets[f.asset]
    return typeof uri === 'string' && uri.startsWith('data:')
      ? [{ uri, family: f.family, weight: f.weight, style: f.style }] : []
  })
  return { images, fonts }
}

/** Build the full declarative layer, or null when the deck has no slide to
 *  show one (mirrors preview.ts's own "nothing to render" case). Registered
 *  with the kernel from main.ts; the kernel applies the encryption veto and
 *  the output-safety check before this ever reaches a saved file. */
export function buildStaticLayer(doc: SlidomingoDoc): HTMLElement | null {
  const slides = doc.slides.filter(inLinearFlow)
  if (!slides.length) return null

  const build = (staticMediaStill: boolean): HTMLElement => {
    const root = document.createElement('div')
    root.id = 'beeslides-static-layer'
    root.dataset.beeslidesDeckVersion = '1'

    // (embedded fonts: the asset store's @font-face rules, not a style here)
    for (const slide of slides) {
      const page = renderSlideStatic(slide, doc, staticMediaStill)
      page.setAttribute('data-beeslides-static-slide', slide.id)
      inlineRuntimeCss(page)
      root.appendChild(page)
    }
    markStorable(root)
    return root
  }

  const full = build(false)
  if (layerBytes(full) <= STATIC_LAYER_BUDGET) return full

  // Fallback tier: media is by far the dominant byte cost (an embedded clip
  // alone can dwarf everything else combined) — drop it to a poster/icon
  // still first, exactly like the thumbnail path already does, before
  // touching anything else. Text/shape/image/table/chart/svg/code/embed all
  // stay full-fidelity in every tier.
  const mediaStill = build(true)
  if (layerBytes(mediaStill) > STATIC_LAYER_BUDGET) {
    console.warn('slidomingo: static layer exceeds its size budget even with media degraded; saving it anyway')
  }
  return mediaStill
}
