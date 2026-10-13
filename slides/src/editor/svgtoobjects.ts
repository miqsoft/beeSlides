// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The editor side of "Convert to objects" (svgconvert.ts holds the geometry):
// swap one `svg` element for the shapes, paths and text it was drawn from, in
// place in the stacking order, as ONE undo step, with the pieces selected.
// The diagram's asset stays in doc.assets (Clean up removes it once unused).

import type { Store } from '../store'
import { convertSvgToObjects } from '../svgconvert'

export type ConvertOutcome =
  | { ok: true; count: number; notes: string[] }
  | { ok: false; error: string }

export function convertSvgInPlace(store: Store, elementId: string): ConvertOutcome {
  const slide = store.slide
  const i = slide.elements.findIndex((e) => e.id === elementId)
  const el = slide.elements[i]
  if (!el || el.type !== 'svg') return { ok: false, error: 'Select a diagram first.' }
  if (el.locked) return { ok: false, error: 'This diagram is locked.' }
  const r = convertSvgToObjects(el, store.doc)
  if ('error' in r) return { ok: false, error: r.error }
  store.commit(() => { slide.elements.splice(i, 1, ...r.elements) })
  store.select(r.elements.map((e) => e.id))
  return { ok: true, count: r.elements.length, notes: r.notes }
}
