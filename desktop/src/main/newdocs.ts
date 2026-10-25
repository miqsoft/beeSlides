// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The documents open_deck create:true writes (agentdecks.ts). Main cannot
// import the renderer's model, so these mirror model.ts by hand; no electron
// import, so scripts/test-agent-iconsets.ts compares them with the model's own
// (`newIconsetDoc`) in node.

import { randomUUID } from 'node:crypto'

const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/** A new deck for an agent: a fresh docId, 16:9, one empty slide, as
 *  model.ts's `newDoc()` (libraryfs.ts seedLibraryDoc does the same). The
 *  theme is a neutral one in the spirit of docs/slide-design.md (near-black
 *  on white, one deep teal accent): what a deck looks like when nobody picked
 *  a look, and what its diagram components are drawn in until someone does. */
export function newDeckDoc(title: string): Record<string, unknown> {
  return {
    format: 'beeslides/slides',
    version: 1,
    docId: randomUUID(),
    title: title || 'Untitled',
    size: { width: 1280, height: 720 },
    theme: {
      background: '#FFFFFF',
      color: '#1D2433',
      accent: '#1F5C78',
      fontFamily: FONT_STACK,
    },
    slides: [{ id: `slide-${randomUUID().slice(0, 8)}`, background: '#FFFFFF', transition: 'fade', elements: [], notes: '' }],
    modified: new Date().toISOString(),
  }
}

/** A new icon set for an agent (open_deck create:true kind:"iconset"): the
 *  document the start page's Icon set tile makes (model.ts `newIconsetDoc()`:
 *  24 × 24 grid at 16 px per unit, the default set style, one blank icon),
 *  titled after the file. */
export function newIconsetFileDoc(title: string): Record<string, unknown> {
  const grid = 24
  const scale = Math.max(1, Math.round(384 / grid))
  const style = { strokeWidth: 2, cap: 'round', join: 'round', padding: 2, fill: 'outline', color: '#000000' }
  const w = style.strokeWidth * scale
  return {
    format: 'beeslides/slides',
    version: 1,
    docId: randomUUID(),
    title: title || 'Untitled icon set',
    kind: 'iconset',
    iconset: { grid, scale, style },
    size: { width: grid * scale, height: grid * scale },
    theme: {
      background: '#FFFFFF',
      color: style.color,
      accent: '#9A5F00',
      fontFamily: FONT_STACK,
      styleDefaults: {
        shape: { fill: 'transparent', stroke: style.color, strokeWidth: w },
        line: { color: style.color, width: w, strokeCap: style.cap },
        text: { fontFamily: 'Helvetica, Arial, sans-serif', fontSize: 6 * scale, color: style.color, lineHeight: 1.2 },
      },
    },
    slides: [{ id: `slide-${randomUUID().slice(0, 8)}`, name: 'icon', background: '#FFFFFF', transition: 'none', elements: [], notes: '' }],
    modified: new Date().toISOString(),
  }
}
