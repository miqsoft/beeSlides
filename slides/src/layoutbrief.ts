// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// A slide type described for an agent about to fill slides of it (doc_info
// slideTypes): its placeholders by id, and the free area its header and footer
// leave for content. Without it an agent writes a probe slide to find out
// where the title goes and what HTML does to the type's elements.
import { effectiveLayout, type Slide, type SlidomingoDoc } from './model'

export interface LayoutBrief {
  /** The type's placeholders (its own and inherited): slide_html fills one
   *  when an element of the HTML carries its id. */
  placeholders: Array<{ id: string; role?: string; frame: [number, number, number, number] }>
  /** [x, y, w, h]: below the header (title, logo, accent bars), above the
   *  footer, aligned with the title. A hint for laying out content. */
  contentArea: [number, number, number, number]
}

const GAP = 16
const r = (n: number): number => Math.round(n)

export function layoutBrief(doc: SlidomingoDoc, layout: Slide, margin: number): LayoutBrief {
  const { width: W, height: H } = doc.size
  const els = effectiveLayout(doc, layout).elements.filter((e) => !e.hidden)
  const placeholders = els
    .filter((e) => e.type === 'text' && typeof e.placeholder === 'string')
    .map((e) => ({ id: e.id, ...(e.role ? { role: e.role } : {}), frame: [r(e.x), r(e.y), r(e.w), r(e.h)] as [number, number, number, number] }))
  // what shapes the free area: everything but backgrounds and body slots
  // (a body placeholder IS content space)
  const fixed = els.filter((e) => e.w * e.h < 0.5 * W * H && !(e.type === 'text' && e.placeholder && e.role !== 'title' && e.role !== 'subtitle'))
  const header = fixed.filter((e) => e.y + e.h <= 0.3 * H)
  const footer = fixed.filter((e) => e.y >= 0.75 * H)
  const top = header.length ? Math.max(...header.map((e) => e.y + e.h)) + GAP : margin * 0.75
  const bottom = footer.length ? Math.min(...footer.map((e) => e.y)) - GAP : H - margin * 0.75
  const title = placeholders.find((p) => p.role === 'title')
  const left = title && title.frame[0] < W / 3 ? title.frame[0] : margin
  return { placeholders, contentArea: [r(left), r(top), r(W - 2 * left), r(Math.max(0, bottom - top))] }
}
