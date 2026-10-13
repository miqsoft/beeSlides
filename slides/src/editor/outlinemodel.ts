// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// What the Outline View shows for one slide. Pure (no DOM), so a node rig can
// check it. The outline used to need a tidy `role:'title'` + ONE `role:'body'`
// and showed everything else as a greyed read-only placeholder — which, in a
// real deck (a picture beside the text, two columns, a hand-built or imported
// slide with no roles), was nearly every row. Now EVERY text element on a
// slide is a field, in reading order, and what the outline cannot show (a
// picture, a table, a chart…) is only named.

import type { Slide, SlideElement, TextElement } from '../model'

export interface OutlineParts {
  /** The slide's heading: the `role:'title'` text, else the topmost text. */
  title?: TextElement
  /** Every other text element, top-to-bottom then left-to-right. */
  rest: TextElement[]
  /** Counts of what is on the slide but is not text, by element type. */
  other: Partial<Record<'image' | 'media' | 'table' | 'chart' | 'code' | 'math', number>>
}

// an opaque svg is artwork, so it counts as a picture
const NAMED: Record<string, keyof OutlineParts['other']> = {
  image: 'image', svg: 'image', media: 'media', table: 'table', chart: 'chart', code: 'code', math: 'math',
}

const reading = (a: TextElement, b: TextElement) => (a.y - b.y) || (a.x - b.x)

/** `inherited` = ids of elements this slide only mirrors from its slide
 *  type (`model.ancestorElementIds`): editing them here would be undone by
 *  the next resync, so the outline leaves them to the Layout Manager. */
export function outlineParts(slide: Slide, inherited: ReadonlySet<string> = new Set()): OutlineParts {
  const texts: TextElement[] = []
  const other: OutlineParts['other'] = {}
  for (const e of slide.elements as SlideElement[]) {
    if (e.type === 'text') {
      // footer pieces (date / page number / footer) are page furniture
      if (e.footerRole || inherited.has(e.id) || e.hidden) continue
      texts.push(e)
    } else if (NAMED[e.type] && !inherited.has(e.id) && !e.hidden) {
      const k = NAMED[e.type]
      other[k] = (other[k] ?? 0) + 1
    }
  }
  texts.sort(reading)
  const title = texts.find((e) => e.role === 'title') ?? texts[0]
  return { title, rest: texts.filter((e) => e !== title), other }
}
