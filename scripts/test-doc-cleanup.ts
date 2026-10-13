#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// "Clean up document…" + paste asset dedup (docs/DECISIONS.md 2026-09-28).
// Bundled, not run directly — clipboard.ts pulls in render.ts, which imports
// './model' extensionless (same as scripts/test-clipboard.ts):
//
//   slides/node_modules/.bin/esbuild scripts/test-doc-cleanup.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-doc-cleanup.mjs" \
//     && node "$TMPDIR/test-doc-cleanup.mjs"
//
// WHAT THIS PROVES. `unusedContent` only ever offers what nothing needs: a
// type no slide follows goes, but every ancestor of a used type stays, and so
// do the default type's and `rootFontLayoutId`'s chains; a template keeps all
// its types. An asset goes only when its last user was a removed type — one a
// slide, a reusable object, a font or a markup asset still names stays.
// `bytes` is the real JSON shrink. And pasting the same picture twice stores
// it once, while different bytes under a taken key still get a fresh key.

import { insertElements, insertSlides, serializeElements } from '../slides/src/editor/clipboard.ts'
import {
  defaultImage, newDoc, removeUnusedContent, unusedContent,
  type Slide, type SlideElement, type SlidomingoDoc,
} from '../slides/src/model.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const PNG_A = 'data:image/png;base64,' + 'A'.repeat(400)
const PNG_B = 'data:image/png;base64,' + 'B'.repeat(400)
const img = (id: string, src: string): SlideElement => ({ ...defaultImage(src), id })
const ly = (id: string, elements: SlideElement[] = [], extra: Partial<Slide> = {}): Slide =>
  ({ id, name: id, background: '#fff', transition: 'fade', notes: '', elements, ...extra })
const slide = (id: string, layoutId?: string, elements: SlideElement[] = []): Slide =>
  ({ id, background: '#fff', transition: 'fade', notes: '', elements, ...(layoutId ? { layoutId } : {}) })

function makeDoc(): SlidomingoDoc {
  const doc = newDoc()
  //   root ─┬─ used      (a slide follows it)
  //         └─ spare     (nothing follows it; only it shows asset "spare")
  //   lone               (a detached root nothing follows)
  //   fontroot ── deflt  (the default type; fontroot is also rootFontLayoutId)
  //   other              (rootFontLayoutId's own chain would be fontroot — other is free)
  doc.layouts = [
    ly('root'),
    ly('used', [], { parentId: 'root' }),
    ly('spare', [img('sp', 'asset:spare')], { parentId: 'root' }),
    ly('lone', [img('ln', 'asset:shared')]),
    ly('fontroot'),
    ly('deflt', [], { parentId: 'fontroot' }),
    ly('other'),
  ]
  doc.defaultLayoutId = 'deflt'
  doc.rootFontLayoutId = 'fontroot'
  doc.slides = [
    slide('s1', 'used', [img('p1', 'asset:onslide')]),
    slide('s2', undefined, [img('p2', 'asset:shared')]),
    { ...slide('s3', 'gone-type'), stateOf: 's1' },
  ]
  doc.reusableObjects = [{ id: 'ro', name: 'logo', elements: [img('ro1', 'asset:reuse')] } as never]
  doc.fonts = [{ family: 'Brand', asset: 'fontkey' }]
  doc.assets = {
    spare: PNG_A,
    shared: PNG_B,
    onslide: 'data:image/png;base64,C',
    reuse: 'data:image/png;base64,D',
    fontkey: 'data:font/woff2;base64,E',
    markup: '<svg><image href="asset:viamarkup"/></svg>',
    viamarkup: 'data:image/png;base64,F',
    orphan: 'data:image/png;base64,' + 'G'.repeat(1000),
  }
  // the markup asset is named by an svg element on a slide
  doc.slides[1].elements.push({ id: 'sv', type: 'svg', asset: 'markup', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 } as never)
  return doc
}

console.log('unusedContent')
{
  const doc = makeDoc()
  const found = unusedContent(doc)
  const ids = found.layouts.map((l) => l.id).sort()
  ok(JSON.stringify(ids) === JSON.stringify(['lone', 'other', 'spare']), `removable types = lone, other, spare (got ${ids})`)
  ok(!ids.includes('root'), 'a used type keeps its parent')
  ok(!ids.includes('deflt') && !ids.includes('fontroot'), 'the default type and its ancestors stay')
  const keys = [...found.assetKeys].sort()
  ok(JSON.stringify(keys) === JSON.stringify(['orphan', 'spare']), `unused assets = orphan, spare (got ${keys})`)
  ok(!keys.includes('shared'), 'an asset a removed type AND a slide use stays')
  ok(!keys.includes('reuse') && !keys.includes('fontkey') && !keys.includes('viamarkup'), 'reusable object / font / markup-referenced assets stay')
  ok(JSON.stringify(unusedContent(doc)) === JSON.stringify(found), 'it is a pure read (asking twice gives the same answer)')
  ok(doc.layouts!.length === 7 && Object.keys(doc.assets!).length === 8, 'the doc is untouched')

  const before = JSON.stringify(doc).length
  const removed = removeUnusedContent(doc)
  const after = JSON.stringify(doc).length
  ok(removed.bytes === before - after, `bytes = the JSON shrink (${removed.bytes} vs ${before - after})`)
  ok(doc.layouts!.map((l) => l.id).join() === 'root,used,fontroot,deflt', `kept types in order (got ${doc.layouts!.map((l) => l.id)})`)
  ok(!doc.assets!.spare && !doc.assets!.orphan && !!doc.assets!.shared && !!doc.assets!.viamarkup, 'removeUnusedContent pruned exactly those assets')
  ok(doc.layouts!.every((l) => !l.parentId || doc.layouts!.some((p) => p.id === l.parentId)), 'no kept type is orphaned')
  const again = unusedContent(doc)
  ok(!again.layouts.length && !again.assetKeys.length && again.bytes === 0, 'afterwards nothing is unused')
}

console.log('rootFontLayoutId and the fallback default')
{
  const doc = makeDoc()
  delete doc.defaultLayoutId
  doc.rootFontLayoutId = 'other'
  const ids = unusedContent(doc).layouts.map((l) => l.id).sort()
  ok(!ids.includes('other'), 'rootFontLayoutId is kept')
  // no defaultLayoutId → the default is layouts[0] ('root'), already kept via 'used'
  ok(!ids.includes('root'), 'the fallback default (layouts[0]) is kept')
  ok(ids.includes('deflt') && ids.includes('fontroot'), 'an old default no longer named is free to go')
}

console.log('templates keep their types')
{
  for (const flag of ['template', 'templateId'] as const) {
    const doc = makeDoc()
    if (flag === 'template') doc.template = true
    else doc.templateId = 't-1'
    const found = unusedContent(doc)
    ok(found.layouts.length === 0, `${flag}: no slide type is removable`)
    ok(JSON.stringify(found.assetKeys) === JSON.stringify(['orphan']), `${flag}: a type's asset stays, a true orphan goes (got ${found.assetKeys})`)
  }
}

console.log('paste dedup')
{
  const src = newDoc()
  src.assets = { k1: PNG_A }
  src.slides[0].elements = [img('e1', 'asset:k1')]
  const clip = JSON.parse(serializeElements(src.slides[0].elements, src))

  const target = newDoc()
  insertElements(clip, target, target.slides[0])
  insertElements(clip, target, target.slides[0])
  ok(Object.keys(target.assets!).length === 1, 'pasting the same picture twice leaves one key')

  // Same bytes already in the target under ANOTHER key → reuse that key.
  const t2 = newDoc()
  t2.assets = { mine: PNG_A }
  const [pasted] = insertElements(clip, t2, t2.slides[0])
  ok(Object.keys(t2.assets).length === 1 && (pasted as { src: string }).src === 'asset:mine', 'identical bytes under a different key remap to the existing key')

  // Different bytes under the same key → a fresh key, still remapped.
  const t3 = newDoc()
  t3.assets = { k1: PNG_B }
  const [p3] = insertElements(clip, t3, t3.slides[0])
  const k3 = (p3 as { src: string }).src.slice(6)
  ok(k3 !== 'k1' && t3.assets[k3] === PNG_A && t3.assets.k1 === PNG_B, 'different bytes under a taken key get a fresh key')

  // An svg's bare `asset` key is remapped too, and a→b / b→c never chains.
  const s4 = newDoc()
  s4.assets = { k1: '<svg/>', k2: PNG_B }
  s4.slides[0].elements = [
    img('i4', 'asset:k2'),
    { id: 'sv4', type: 'svg', asset: 'k1', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 } as never,
  ]
  const clip4 = JSON.parse(serializeElements(s4.slides[0].elements, s4))
  const t4 = newDoc()
  t4.assets = { k2: '<svg/>' } // k1's markup lives under k2; k2's own bytes are new
  const [i4, sv4] = insertElements(clip4, t4, t4.slides[0]) as Array<{ src?: string; asset?: string }>
  ok(sv4.asset === 'k2', `svg asset remapped to the existing copy (got ${sv4.asset})`)
  ok(i4.src !== 'asset:k2' && t4.assets[i4.src!.slice(6)] === PNG_B, `image got its own fresh key, not chained onto k2 (got ${i4.src})`)
  ok(Object.keys(t4.assets).length === 2, 'two distinct assets, two keys')

  // Slides paste the same way.
  const t5 = newDoc()
  t5.assets = { other: PNG_A }
  const slideClip = { __slidomingo: 'clip', kind: 'slides', slides: [slide('x', undefined, [img('e9', 'asset:k1')])], assets: { k1: PNG_A } }
  const [ps] = insertSlides(slideClip as never, t5, 1)
  ok((ps.elements[0] as { src: string }).src === 'asset:other' && Object.keys(t5.assets).length === 1, 'pasted slides reuse existing bytes too')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
