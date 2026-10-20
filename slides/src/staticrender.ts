// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Shared pieces for rendering render.ts's output somewhere the runtime
// stylesheet never loads: the first-page preview (preview.ts) and the
// full-deck static declarative layer (staticlayer.ts). Both draw through
// renderSlide/renderElement — the one model→DOM renderer — and both then
// need the same small set of `.beeslides-*` class rules the (absent) runtime
// stylesheet would otherwise have supplied, because that stylesheet ships
// deflated and is never inflated for an audience that runs no script.

import { STORABLE_ATTR } from './save'

/** Put `css` in front of the element's existing inline style (which wins). */
export function prepend(el: HTMLElement, css: string) {
  const own = el.getAttribute('style') ?? ''
  el.setAttribute('style', own ? `${css};${own}` : css)
}

/**
 * Generic families appended to every inline font-family.
 *
 * `doc.fonts[]` are injected as @font-face at boot from the asset table — by
 * JavaScript, for the preview, which is not running. (The full static layer
 * DOES carry real @font-face rules, generated at save time — see
 * staticlayer.ts's fontFaceCss — but an unembeddable/unresolved family still
 * wants a deliberate fallback rather than whatever the UA picks for an
 * unresolvable name, usually Times.)
 */
export const FONT_FALLBACK = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`

/** Inline the rules `.beeslides-*` classes get from styles.css, which is
 *  compressed into a payload this audience never decompresses. */
export function inlineRuntimeCss(root: HTMLElement) {
  prepend(root, 'position:relative;overflow:hidden')
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.beeslides-el'))) {
    prepend(el, 'position:absolute')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.beeslides-el-text .beeslides-text-inner'))) {
    prepend(el, 'overflow-wrap:break-word')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.beeslides-el-table'))) {
    prepend(el, 'overflow:visible')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.beeslides-cell-inner'))) {
    prepend(el, 'min-height:1em')
  }
  // rich text (styles.css, "rich text lists and links")
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.beeslides-el ul, .beeslides-el ol'))) {
    prepend(el, 'margin:0;padding-inline-start:1.25em')
  }
  // nested numbering 1. → a. → i. (deepest first: prepend puts a rule BEFORE
  // what is there, so the later-prepended, shallower one would otherwise win)
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.beeslides-el ol ol ol'))) {
    prepend(el, 'list-style-type:lower-roman')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.beeslides-el ol ol'))) {
    prepend(el, 'list-style-type:lower-alpha')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.beeslides-el a[href]'))) {
    prepend(el, 'color:var(--sl-hlink,inherit);text-decoration:underline')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('code'))) {
    prepend(el, 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.9em;' +
      'background:rgb(127 127 127 / 0.16);padding:0 0.28em;border-radius:3px')
  }
}

/** A background string safe to repeat behind a page: a flat colour repeats
 *  invisibly, a gradient or an embedded image does not (and a data: URI
 *  would be paid for twice). */
export const flatBackground = (css: string) => (/url\(|gradient|data:/i.test(css) ? null : css)

const FITS = ['contain', 'cover', 'fill']

/**
 * Mark render.ts's box-filling pictures (width/height 100%, a known
 * object-fit — image elements, media-still posters, and svg-as-image in the
 * preview) as storable: the kernel draws exactly these from the asset store
 * (kernel/src/save.ts STORABLE_ATTR), for the static layer and the preview
 * alike. Any other <img> is left as it is.
 *
 * Why content replacement and not background-image, and why the store is a
 * <style> ahead of everything: docs/DECISIONS.md 2026-09-28 (measured —
 * `background-size:cover` resamples differently from `object-fit:cover`;
 * content replacement is pixel-identical at 1× and 2×, and it prints).
 */
export function markStorable(root: HTMLElement): void {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[src^="data:"]'))) {
    // a cropped image (render.ts): the picture is absolutely placed in its
    // clipping box with explicit % sizes and object-fit:fill — every part of
    // that box is in its own inline style, so content replacement draws it
    // the same way
    const cropped = img.parentElement?.classList.contains('beeslides-crop') &&
      img.style.position === 'absolute' && img.style.objectFit === 'fill'
    if (!cropped && (img.style.width !== '100%' || img.style.height !== '100%' || !FITS.includes(img.style.objectFit))) continue
    img.setAttribute(STORABLE_ATTR, '')
  }
}
