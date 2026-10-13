// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Facade: the IndexedDB auto-save/version store lives in the shared kernel now
// (kernel/src/autosave.ts). This path stays alive so slides code keeps
// importing './autosave' unchanged — see docs/PLATFORM.md §9.
//
// docContentKey stays HERE (not in the kernel): "what counts as content" is a
// per-app model question — it reads slides-specific fields the kernel must
// never see. Spaces/dash define their own beside their models.

import type { SlidomingoDoc } from './model'
import { canonicalJson } from '../../kernel/src/doc.ts'

export * from '../../kernel/src/autosave.ts'

/** The content that actually matters for "did this change" — the WHOLE
 *  document minus the volatile fields (modified timestamp, legacy collab sync
 *  state) that churn without a real edit. Crash recovery compares a snapshot
 *  to the opened file with this, and an equal key means no Restore banner, so
 *  a field left out here is an edit recovery silently drops: it used to list
 *  title/size/theme/slides/layouts/fonts/assets/reusableObjects only, and an
 *  unsaved section rename or footer text was lost with the tab.
 *  canonicalJson, not JSON.stringify: the opened file's keys come back in the
 *  canonical order and a snapshot's in session order, and the same content in
 *  a different key order is not an edit. */
export function docContentKey(doc: SlidomingoDoc): string {
  return canonicalJson({ ...doc, modified: undefined, collab: undefined })
}
