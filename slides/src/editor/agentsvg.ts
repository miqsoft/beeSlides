// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Agents do not author SVG. An `svg` element is opaque: nobody can edit it in
// the editor, and markup a model writes (or "remembers" from the internet) has
// no origin or license. So a write that comes from an AI tool is refused when
// it would put NEW svg artwork into the deck. What stays allowed:
//   · native objects — rect/ellipse/line and `path` shapes, text — which the
//     user can edit, recolour and morph (this is what the refusal points to);
//   · the `icons` tool, which inserts through Editor.agentInsertElements and
//     never reaches these checks (it records the icon's source and license);
//   · keeping or moving artwork the deck already holds: a get_slide →
//     write_slide round trip returns every svg unchanged, and an `asset` key
//     that is already in doc.assets names existing artwork, not new.
// A picture is no loophole: an `image` whose src is a `data:image/svg+xml` URI
// is the same artwork in a different wrapper, and is held to the same rule.
//
// Pure (no DOM, no editor), so scripts/test-agent-ops.ts exercises it directly.
// It guards the three verbs that take element data from a model:
// insert_elements, write_slide and update_element. A model that edits the deck
// FILE directly, bypassing the app, is outside what this can see.

import type { SlidomingoDoc, SlideElement } from '../model'

/** What a refused model is told to do instead — every refusal ends with this. */
export const AGENT_SVG_ADVICE =
  'AI-written SVG is refused: it cannot be edited in the editor and has no known source or license. ' +
  'For icons use the icons tool (search, then insert). For shapes and diagrams compose rect/ellipse/line elements and ' +
  '`path` shapes (shape:"path" with d and pathBox), grouped, plus text. For a picture, ask the user to insert one.'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Raw SVG markup, or an image data URI carrying SVG. */
const isSvgPayload = (v: unknown): boolean =>
  typeof v === 'string' && (/^\s*(<\?xml|<svg|<!--|<!doctype)/i.test(v) || /^data:image\/svg\+xml/i.test(v))

const refuse = (what: string): string => `${what} ${AGENT_SVG_ADVICE}`

/**
 * Refuses element specs (insert_elements `elements`, write_slide `slide.elements`)
 * that would introduce new svg artwork. `existing` = the elements the write
 * replaces, so an unchanged svg/image coming back round-trips. `assets` is the
 * insert_elements asset map: svg payloads in it only ever feed svg elements.
 * Returns the refusal text, or null when the write may go ahead.
 */
export function agentSvgViolation(
  doc: SlidomingoDoc, elements: unknown, opts: { existing?: readonly SlideElement[]; assets?: unknown } = {},
): string | null {
  const held = new Map<string, Record<string, unknown>>()
  for (const e of opts.existing ?? []) held.set(e.id, e as unknown as Record<string, unknown>)
  const docAssets = doc.assets ?? {}

  if (isObj(opts.assets)) {
    for (const [key, val] of Object.entries(opts.assets)) {
      if (isSvgPayload(val) && !(key in docAssets && docAssets[key] === val)) {
        return refuse(`The asset "${key}" is SVG markup.`)
      }
    }
  }
  if (!Array.isArray(elements)) return null
  for (const [i, raw] of elements.entries()) {
    if (!isObj(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id : `#${i + 1}`
    const was = typeof raw.id === 'string' ? held.get(raw.id) : undefined
    if (raw.type === 'svg') {
      if (typeof raw.markup === 'string' && raw.markup && !(was?.type === 'svg' && was.markup === raw.markup)) {
        return refuse(`Element "${id}" is an svg with its own markup.`)
      }
      if (typeof raw.asset === 'string' && raw.asset && !(raw.asset in docAssets) && !(was?.type === 'svg' && was.asset === raw.asset)) {
        return refuse(`Element "${id}" is an svg whose asset "${raw.asset}" is not artwork already in the deck.`)
      }
    } else if (raw.type === 'image' && isSvgPayload(raw.src) && !(was?.type === 'image' && was.src === raw.src)) {
      return refuse(`Element "${id}" is a picture holding SVG.`)
    }
  }
  return null
}

/**
 * Refuses an update_element patch that would swap in new svg artwork: `markup`
 * or `asset` on an svg, or an SVG `src` on an image. `target` is the element as
 * it is now. Returns the refusal text, or null.
 */
export function agentSvgPatchViolation(doc: SlidomingoDoc, target: SlideElement, props: Record<string, unknown>): string | null {
  const patch: Record<string, unknown> = { ...props, type: target.type, id: target.id }
  return agentSvgViolation(doc, [patch], { existing: [target] })
}
