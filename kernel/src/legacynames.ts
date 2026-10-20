// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The names files saved before 2026-10-20 use — one place, used by the page,
// the kernel and the desktop main process.
//
// Until then every identifier inside a file said `slidomingo`: the doc block
// `#slidomingo-doc`, the formats `slidomingo/slides` and `slidomingo/enc`, the
// asset store's `slidomingo-store:` refs, `#slidomingo-assets` and
// `data-slidomingo-*` attributes. New files say `beeslides` (docs/DECISIONS.md,
// 2026-10-20). Old files must keep opening, and they move to the new names the
// next time they are saved. So everything that READS a file accepts both, and
// every writer uses only the new names — the same rule as docext.ts.

/** The doc block's id in files saved before the rename. Read, never written. */
export const LEGACY_DOC_BLOCK_ID = 'slidomingo-doc'

/** Either doc block, for querySelector. */
export const DOC_BLOCK_SELECTOR = '#beeslides-doc, #slidomingo-doc'

/** Regex source matching either doc block id (no anchors, no groups). */
export const DOC_BLOCK_ID_SRC = '(?:beeslides|slidomingo)-doc'

/** What asset-store refs started with before the rename. */
export const LEGACY_STORE_REF_PREFIX = 'slidomingo-store:'

/** The asset store's ids and attributes before the rename. */
export const LEGACY_STORE_ID = 'slidomingo-assets'
export const LEGACY_MEDIA_SRC_ATTR = 'data-slidomingo-store'
export const LEGACY_MEDIA_POSTER_ATTR = 'data-slidomingo-poster'

/** The first-page preview and the static layer's markers before the rename. */
export const LEGACY_PREVIEW_ATTR = 'data-slidomingo-preview'
export const LEGACY_STATIC_ATTR = 'data-slidomingo-static'

/** A password envelope, under either name. */
export const isEncFormat = (format: unknown): boolean =>
  format === 'beeslides/enc' || format === 'slidomingo/enc'

/** A format string under its current name: `slidomingo/slides` → `beeslides/slides`.
 *  Anything else comes back as it was. */
export function currentFormat<T>(format: T): T | string {
  return typeof format === 'string' && format.startsWith('slidomingo/') ? 'beeslides/' + format.slice('slidomingo/'.length) : format
}
