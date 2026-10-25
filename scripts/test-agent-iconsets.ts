#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon sets for decks (DECISIONS 2026-10-25): the pure parts.
//
//   node scripts/test-agent-iconsets.ts
//
// WHAT THIS PROVES
//  1. The icon set open_deck create:true kind:"iconset" writes (desktop
//     newdocs.ts, written by hand because main cannot import the model) is
//     the document the start page makes (model.ts newIconsetDoc), and opens
//     as an icon set.
//  2. Main reads only an icon set out of a file (docfile.ts iconSetDocText):
//     legacy names accepted; a deck, an encrypted file or another file refused.
//  3. findSetIcons matches names, keywords and "what it shows", skips undrawn
//     icons; setIconSvg paints the ink, picks a style by name, keeps a
//     colourful style's colours and refuses an unknown one.
// The handlers around them: scripts/test-agent-ops.ts; a real editor:
// scripts/test-agent-iconsets-e2e.mjs.

import { newIconsetFileDoc } from '../desktop/src/main/newdocs.ts'
import { iconSetDocText } from '../desktop/src/main/docfile.ts'
import { findSetIcons, iconsetInfo } from '../slides/src/iconset.ts'
import { setIconSvg } from '../slides/src/iconstyles.ts'
import { newIconsetDoc, parseDoc, type SlidomingoDoc } from '../slides/src/model.ts'

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.log(`  FAIL  ${m}`) } }

// ---- 1. the new set main writes = the start page's ---------------------------
console.log('-- new icon set --')
{
  const strip = (d: Record<string, any>) => {
    const { docId, modified, title, ...rest } = structuredClone(d)
    rest.slides = rest.slides.map(({ id, ...s }: Record<string, unknown>) => s)
    // compared deeply, never as JSON strings with keys in written order
    const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v
    return sorted(rest)
  }
  const mine = newIconsetFileDoc('talk.icons')
  const model = newIconsetDoc() as unknown as Record<string, unknown>
  const a = JSON.stringify(strip(mine)), b = JSON.stringify(strip(model))
  ok(a === b, a === b ? 'main\'s new icon set matches model.newIconsetDoc() (all but docId, title, modified, slide ids)' : `differs:\n    main  ${a}\n    model ${b}`)
  ok(mine.title === 'talk.icons' && newIconsetFileDoc('').title === 'Untitled icon set', 'titled after the file')
  const parsed = parseDoc(JSON.stringify(mine))
  ok(parsed?.kind === 'iconset' && iconsetInfo(parsed)?.grid === 24 && parsed.docId === mine.docId, 'it opens as an icon set, docId kept')
}

// ---- 2. reading a set out of a file --------------------------------------------
console.log('-- iconSetDocText --')
{
  const file = (json: unknown, id = 'beeslides-doc') =>
    `<!DOCTYPE html><html><head><script type="application/beeslides+json" id="${id}">\n${JSON.stringify(json).replace(/</g, '\\u003c')}\n</script></head><body></body></html>`
  const set = newIconsetFileDoc('s')
  const got = iconSetDocText(file(set))
  ok('text' in got && JSON.parse(got.text).kind === 'iconset', 'an icon set is read')
  const legacy = iconSetDocText(file({ ...set, format: 'slidomingo/slides' }, 'slidomingo-doc'))
  ok('text' in legacy, 'a set saved under the old names (#slidomingo-doc, slidomingo/slides) is read too')
  const deck = iconSetDocText(file({ format: 'beeslides/slides', slides: [{ id: 'a', elements: [] }] }))
  ok('error' in deck && deck.error.includes('not an icon set'), 'a deck is refused')
  const enc = iconSetDocText(file({ format: 'beeslides/enc', v: 1 }))
  ok('error' in enc && enc.error.includes('encrypted'), 'an encrypted file is refused')
  const other = iconSetDocText('<html><body>hello</body></html>')
  ok('error' in other && other.error.includes('not a BeeSlides document'), 'another file is refused')
}

// ---- 3. search and artwork ------------------------------------------------------
console.log('-- findSetIcons / setIconSvg --')
{
  const doc = newIconsetDoc({ names: ['evidence bag', 'fingerprint', 'hash'] }) as SlidomingoDoc
  const path = (d: string, extra: Record<string, unknown> = {}) => ({
    id: `p${Math.random().toString(36).slice(2, 6)}`, type: 'shape', shape: 'path', x: 0, y: 0, w: 384, h: 384, rotation: 0, opacity: 1, radius: 0,
    pathBox: [0, 0, 24, 24], d, fill: 'transparent', stroke: '#000000', strokeWidth: 32, ...extra,
  }) as never
  doc.slides[0].elements.push(path('M5 6 H19 V20 H5 Z', { iconPart: 'body' }), path('M9 11 H15', { iconPart: 'detail' }))
  doc.slides[0].icon = { prompt: 'a sealed bag with a tag', keywords: ['seal', 'forensics'] }
  doc.slides[1].elements.push(path('M12 4 A8 8 0 1 1 11.9 4'))
  const names = (q: string) => findSetIcons(doc, q).hits.map((s) => s.name).join()
  ok(names('') === 'evidence bag,fingerprint' && findSetIcons(doc, '').undrawn === 1, '"" lists the drawn icons and counts the undrawn one')
  ok(names('seal') === 'evidence bag' && names('BAG tag') === 'evidence bag' && names('forensics finger') === '', 'every word must hit the name, keywords or prompt')
  ok(names('hash') === '', 'an undrawn icon is never found')
  const plain = setIconSvg(doc, doc.slides[0], undefined, '#1F5C78')
  ok(typeof plain !== 'string' && plain.inked && plain.svg.includes('stroke="#1F5C78"') && !plain.svg.includes('currentColor') && !plain.look, 'plain drawing: the ink is the colour given')
  doc.iconset!.variants = [
    { id: 'look-a', name: 'Bold', stroke: { weight: 1.5, color: '#000000' } },
    { id: 'look-b', name: 'Sticker', stroke: { weight: 1, color: '#111111' }, fill: { body: { color: '#ffd23f' } } },
  ]
  const bold = setIconSvg(doc, doc.slides[0], 'bold', '#1F5C78')
  ok(typeof bold !== 'string' && bold.look === 'Bold' && bold.inked && bold.svg.includes('#1F5C78') && bold.svg.includes('stroke-width="3"'), 'a one-colour style takes the ink, at its own weight')
  const sticker = setIconSvg(doc, doc.slides[0], 'Sticker', '#1F5C78')
  ok(typeof sticker !== 'string' && !sticker.inked && sticker.svg.includes('#ffd23f') && !sticker.svg.includes('#1F5C78'), 'a colourful style keeps its colours')
  const none = setIconSvg(doc, doc.slides[0], 'Neon', '#000')
  ok(typeof none === 'string' && none.includes('"Bold", "Sticker"'), 'an unknown style is refused, naming the ones there are')
  const evil = setIconSvg(doc, doc.slides[0], undefined, '"/><script>')
  ok(typeof evil !== 'string' && !evil.svg.includes('<script') && evil.svg.includes('#000000'), 'an ink that is not a colour never reaches the markup')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
