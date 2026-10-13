// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The file extension of a BeeSlides document — one place, used by the page,
// the kernel and the desktop main process.
//
// New files are saved as `.beeslides.html`. Files saved before 2026-10-13 end
// in `.slidomingo.html`; they are the same format and must keep opening,
// appearing in the template gallery and saving in place (docs/DECISIONS.md,
// 2026-10-13). So everything that RECOGNISES a document accepts both, and
// only things that NAME a new file use DOC_EXT.

export const DOC_EXT = '.beeslides.html'

/** What files saved before the rename end in. Read, never written new. */
export const LEGACY_DOC_EXT = '.slidomingo.html'

/** Either extension at the end of a name or path. */
export const DOC_EXT_RE = /\.(?:beeslides|slidomingo)\.html$/i

export const hasDocExt = (name: string): boolean => DOC_EXT_RE.test(name)

/** "Q3.beeslides.html", "Q3.slidomingo.html" or "Q3.html" → "Q3". */
export const stripDocExt = (name: string): string => name.replace(DOC_EXT_RE, '').replace(/\.html$/i, '')
