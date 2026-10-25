#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Sidebar thumbnail cache (slides/src/editor/thumbcache.ts): a thumbnail is
// re-rendered exactly when something its render reads changed — its own
// slide, the deck outside the slides (theme, slide types, footer, meta …),
// assets, its page number when it shows a field, the slide a zoom tile shows,
// its width — and NOT for comments, notes or an edit to another slide.
// No DOM: the render callback hands out stand-in objects.
//
//   node scripts/run-tests.mjs thumb-cache

import { emptySlide, newDoc, type Slide, type SlidomingoDoc } from '../slides/src/model.ts'
import { ThumbCache } from '../slides/src/editor/thumbcache.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

const text = (id: string, html: string) => ({ id, type: 'text', x: 10, y: 10, w: 200, h: 40, rotation: 0, opacity: 1, html, fontSize: 24, color: '#000', fontFamily: '', fontWeight: 400, align: 'left' }) as unknown as Slide['elements'][number]

function deck(): SlidomingoDoc {
  const doc = newDoc()
  doc.slides = ['a', 'b', 'c', 'd'].map((id) => ({ ...emptySlide(), id }))
  doc.slides[0].elements.push(text('t', 'Plain'))
  doc.slides[1].elements.push(text('p', '{{page}} / {{pages}}'))
  doc.slides[2].elements.push({ id: 'z', type: 'zoom', x: 0, y: 0, w: 320, h: 180, rotation: 0, opacity: 1, target: { slide: 'd' } } as unknown as Slide['elements'][number])
  doc.slides[3].elements.push(text('q', 'Cover'))
  return doc
}

const cache = new ThumbCache()
let made = 0
/** one pass over every slide: the ids rendered (not reused) */
function pass(doc: SlidomingoDoc, extra = '', width = 200): string[] {
  const p = cache.begin(doc, extra)
  const rendered: string[] = []
  doc.slides.forEach((s, i) => {
    cache.surface(p, s, i, width, () => { rendered.push(s.id); made++; return { n: made } as unknown as HTMLElement })
  })
  cache.prune(p)
  return rendered
}
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

const doc = deck()
ok(same(pass(doc), ['a', 'b', 'c', 'd']), 'first pass renders every slide')
ok(pass(doc).length === 0, 'an unchanged deck renders nothing')

doc.slides[0].elements[0] = { ...doc.slides[0].elements[0], x: 50 }
ok(same(pass(doc), ['a']), 'moving an element re-renders only its slide')

doc.slides[0].comments = [{ id: 'c1', author: '', text: 'hm', at: '' }] as Slide['comments']
doc.slides[0].notes = 'speaker notes'
doc.modified = new Date(Date.now() + 1000).toISOString()
ok(pass(doc).length === 0, 'comments, notes and doc.modified re-render nothing')

doc.theme.accent = '#ff0000'
ok(pass(doc).length === 4, 'a theme change re-renders every slide')

doc.headerFooter = { footer: { text: 'ACME' } } as SlidomingoDoc['headerFooter']
ok(pass(doc).length === 4, 'a header/footer change re-renders every slide')

doc.meta = { ...(doc.meta ?? {}), custom: { x: '1' } }
ok(pass(doc).length === 4, 'a custom property change re-renders every slide')

;(doc.assets ??= {}).pic = 'data:image/png;base64,AAAA'
ok(pass(doc).length === 4, 'a new asset re-renders every slide')
doc.assets.pic = 'data:image/png;base64,BBBB'
ok(pass(doc).length === 4, 'an asset replaced under the same key re-renders every slide')
doc.assets = JSON.parse(JSON.stringify(doc.assets))
ok(pass(doc).length === 0, 'an equal re-parsed asset table (undo) re-renders nothing')

ok(pass(doc, 'de').length === 4, 'editor state (UI language, look) re-renders every slide')
ok(pass(doc, 'de', 180).length === 4, 'a new width re-renders every slide')

// position: only the slide showing {{page}} cares that a slide before it went away
doc.slides[0].hidden = true
ok(same(pass(doc, 'de', 180), ['a', 'b']), 'hiding slide a re-renders it and the page-field slide, nothing else')
doc.slides.push({ ...emptySlide(), id: 'e' })
ok(same(pass(doc, 'de', 180), ['b', 'e']), 'a new slide re-renders itself and the page-field slide ({{pages}})')

// zoom: the tile's slide follows its cover
doc.slides[3].elements[0] = { ...doc.slides[3].elements[0], x: 99 }
ok(same(pass(doc, 'de', 180), ['c', 'd']), 'editing a zoom cover re-renders the slide with the tile')
doc.slides[3].comments = [{ id: 'c2', author: '', text: 'x', at: '' }] as Slide['comments']
ok(pass(doc, 'de', 180).length === 0, 'a comment on the cover re-renders nothing')
doc.slides[3].elements.push(text('pf', 'p. {{page}}'))
pass(doc, 'de', 180)
const [moved] = doc.slides.splice(0, 1)
doc.slides.push(moved)
ok(pass(doc, 'de', 180).length === 0, 'moving a hidden slide (no page number shifts) re-renders nothing')
{
  delete doc.slides[doc.slides.length - 1].hidden
  const r = pass(doc, 'de', 180)
  ok(same(r, ['a', 'b', 'c', 'd']), 'un-hiding the last slide re-renders every slide showing a page field, and the tile of a cover that does')
}

// a duplicate slide id never shares one surface between two thumbnails
const dup = deck()
dup.slides[1] = { ...dup.slides[0] }
const p = cache.begin(dup, '')
const s0 = cache.surface(p, dup.slides[0], 0, 200, () => ({ k: 0 }) as unknown as HTMLElement)
const s1 = cache.surface(p, dup.slides[1], 1, 200, () => ({ k: 1 }) as unknown as HTMLElement)
ok(s0 !== s1, 'a duplicate slide id gets its own surface')

// ---- inline pictures: keyed by token, still exact ---------------------------
console.log('\ninline pictures')
{
  const big = new ThumbCache()
  let n = 0
  const run = (d: SlidomingoDoc, width = 200): string[] => {
    const p = big.begin(d, '')
    const out: string[] = []
    d.slides.forEach((s, i) => big.surface(p, s, i, width, () => { out.push(s.id); return { n: n++ } as unknown as HTMLElement }))
    big.prune(p)
    return out
  }
  const keys = () => [...(big as unknown as { entries: Map<string, { key: string }> }).entries.values()].map((e) => e.key)
  // same length, different last bytes: only an exact compare tells them apart
  const pic = (tail: string) => `data:image/jpeg;base64,${'Q'.repeat(64 * 1024)}${tail}`
  const P = pic('AAAA'), P2 = pic('AAAB')
  const image = (id: string, src: string) => ({ id, type: 'image', x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, src, fit: 'cover', radius: 0 }) as unknown as Slide['elements'][number]
  const d = deck()
  d.slides[0].elements.push(image('photo', P))
  ok(same(run(d), ['a', 'b', 'c', 'd']), 'first pass renders every slide')
  ok(keys().every((k) => k.length < 16 * 1024), `no key holds the picture's bytes (longest ${Math.max(...keys().map((k) => k.length))} chars for a ${P.length}-char picture)`)
  ok(run(d).length === 0, 'an unchanged deck with a picture renders nothing')
  ;(d.slides[0].elements[1] as { src: string }).src = P2
  ok(same(run(d), ['a']), 'the picture swapped in place (same length, last bytes differ) re-renders its slide')
  ;(d.slides[0].elements[1] as { src: string }).src = P
  ok(same(run(d), ['a']), 'and swapped back, again')
  d.slides[0].elements[0] = { ...d.slides[0].elements[0], x: 77 }
  ok(same(run(d), ['a']), 'moving another element on the picture slide re-renders only it')
  // a real string that looks like a token is not one: P is token 0 here
  ;(d.slides[0].elements[1] as { src: string }).src = '\u00050'
  ok(same(run(d), ['a']), 'a string spelled like the picture\'s token is a change')
  ;(d.slides[0].elements[1] as { src: string }).src = P
  run(d)
  // a page field in a long text on a picture slide still follows the page number
  d.slides[0].elements.push(text('long', `${'x'.repeat(2000)} {{page}}`))
  d.slides.unshift({ ...emptySlide(), id: 'first' })
  const moved = run(d)
  ok(moved.includes('a') && moved.includes('first'), `a {{page}} in a long text on a picture slide still re-renders when its page moves (${moved})`)
  // an undo hands out new objects with the same content: nothing to render
  const undone = JSON.parse(JSON.stringify(d)) as SlidomingoDoc
  ok(run(undone).length === 0, 'a re-parsed, equal deck (undo) re-renders nothing')
  // a slide that grows big in place: one render, then quiet
  undone.slides[2].elements.push(image('late', P2))
  ok(same(run(undone), [undone.slides[2].id]), 'a picture added in place re-renders its slide')
  ok(run(undone).length === 0, 'and the next pass (now keyed by token) renders nothing')
  // a picture in the deck part (a slide type) is tokenized too
  undone.layouts = [{ ...emptySlide(), id: 'L', elements: [image('logo', P)] }]
  ok(run(undone).length === undone.slides.length, 'a picture in a slide type re-renders every slide')
  ok(run(undone).length === 0, 'and then nothing')
  ;(undone.layouts[0].elements[0] as { src: string }).src = P2
  ok(run(undone).length === undone.slides.length, "swapping the slide type's picture re-renders every slide")
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
