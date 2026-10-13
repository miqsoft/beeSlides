#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Find & replace, the pure half (slides/src/editor/findreplace.ts): what is
// searched, in what order, and that a replace never tears markup, entities
// or field tokens apart. Runs without a DOM.
//
//   npx tsx scripts/test-find-replace.ts

import { defaultChart, defaultMath, defaultText, emptySlide, newDoc, type MathElement, type ChartElement, type SlidomingoDoc, type TableElement, type TextElement } from '../slides/src/model.ts'
import { Store } from '../slides/src/store.ts'
import { findMatches, replaceAll, replaceMatch, planReplaceMatch, renderedSpans, fieldSource, type FindMatch } from '../slides/src/editor/findreplace.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}
const eq = (a: unknown, b: unknown, message: string) => {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, same ? message : `${message} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
}

function table(id: string, cells: string[][]): TableElement {
  return {
    id, type: 'table', x: 100, y: 400, w: 600, h: 200, rotation: 0, opacity: 1,
    columns: cells[0].map(() => ({ w: 1 })), header: true, style: {},
    rows: cells.map((r) => ({ cells: r.map((html) => ({ html })) })),
  } as unknown as TableElement
}

function deck(): SlidomingoDoc {
  const doc = newDoc()
  const s1 = emptySlide({ id: 's1' })
  s1.elements.push(
    // deliberately listed bottom-first: the search walks reading order
    defaultText({ id: 'body', y: 300, x: 100, html: 'The cat sat. <b>Cat</b> food &amp; cat&nbsp;nip' }),
    defaultText({ id: 'title', y: 50, x: 100, html: 'Cats and dogs' }),
  )
  s1.notes = 'Mention the cat twice: cat.'
  const s2 = emptySlide({ id: 's2' })
  s2.elements.push(table('tbl', [['Animal', 'Count'], ['cat', '3'], ['dog <i>cat</i>', '1']]))
  const chart = defaultChart({
    title: { text: 'Cat census' },
    xAxis: { type: 'category', data: ['Cats', 'Dogs', 7] },
    yAxis: { type: 'value', name: 'cat count' },
    series: [{ type: 'bar', name: 'Wildcat', data: [1, 2, 3] }],
  }, { id: 'ch' }) as ChartElement
  s2.elements.push(chart)
  doc.slides = [s1, s2]
  return doc
}

const text = (doc: SlidomingoDoc, s: number, id: string) => (doc.slides[s].elements.find((e) => e.id === id) as TextElement).html

console.log('\nwhat is searched, in what order')
{
  const doc = deck()
  const ms = findMatches(doc, 'cat')
  const where = ms.map((m) => `${m.slideIndex}:${m.ref.kind}${'elId' in m.ref ? ':' + m.ref.elId : ''}${m.ref.kind === 'cell' ? `:${m.ref.row},${m.ref.col}` : ''}${m.ref.kind === 'chart' ? ':' + m.ref.path.join('.') : ''}`)
  eq(where, [
    '0:text:title',                                  // "Cats" — reading order puts the title first
    '0:text:body', '0:text:body', '0:text:body',      // cat, <b>Cat</b>, cat&nbsp;nip
    '0:notes', '0:notes',
    '1:chart:ch:title.text', '1:chart:ch:xAxis.data.0', '1:chart:ch:yAxis.name', '1:chart:ch:series.0.name',
    '1:cell:tbl:1,0', '1:cell:tbl:2,0',               // the chart sits above the table
  ], 'text, notes, chart labels and cells — deck, reading, field order')
  eq(findMatches(doc, 'cat', { matchCase: true }).length, 8, 'match case')
  eq(findMatches(doc, 'cat', { wholeWord: true }).map((m) => m.text),
    ['cat', 'Cat', 'cat', 'cat', 'cat', 'Cat', 'cat', 'cat', 'cat'], 'whole word: not Cats / Wildcat; NBSP and tags are boundaries')
  eq(findMatches(doc, '').length, 0, 'an empty query finds nothing')
  eq(findMatches(doc, 'cat nip').length, 1, '&nbsp; matches a typed space')
  eq(findMatches(doc, 'food & cat').length, 1, '&amp; matches "&"')
  eq(findMatches(doc, 'amp').length, 0, 'entity names are not text')
  eq(findMatches(doc, 'b>').length, 0, 'tags are not text')
  eq(findMatches(doc, 'cat. cat').length, 0, 'never across markup ("sat. <b>Cat</b>")')
  eq(findMatches(doc, '7').length, 0, 'non-string chart data is left alone')
  const odd = deck()
  ;(odd.slides[0].elements[0] as TextElement).html = '<span title="a>cat" style="color:red">cat</span> a < cat'
  eq(findMatches(odd, 'cat').filter((m) => m.ref.kind === 'text' && m.ref.elId === 'body').length, 2, 'a ">" inside a quoted attribute is still markup; a bare "<" is text')
  replaceAll(odd, 'cat', 'dog')
  eq(text(odd, 0, 'body'), '<span title="a>cat" style="color:red">dog</span> a < dog', 'attributes are never rewritten')
}

console.log('\nfields and inherited chrome')
{
  const doc = deck()
  ;(doc.slides[0].elements[0] as TextElement).html = 'Page {{page}} of {{pages}} — page'
  eq(findMatches(doc, 'page').map((m) => m.text), ['Page', 'page'], 'field tokens are opaque to search')
  replaceAll(doc, 'page', 'Seite')
  eq(text(doc, 0, 'body'), 'Seite {{page}} of {{pages}} — Seite', 'replace all keeps field tokens intact')
  const skipped = findMatches(deck(), 'cat', { skip: (_s, el) => el.id === 'body' })
  ok(!skipped.some((m) => 'elId' in m.ref && m.ref.elId === 'body'), 'skip() leaves an element (inherited chrome) out')
  const doc2 = deck()
  ;(doc2.slides[1].elements[1] as ChartElement).source = { tableId: 'tbl' }
  const linked = findMatches(doc2, 'cat').filter((m) => m.ref.kind === 'chart').map((m) => (m.ref as { path: unknown[] }).path.join('.'))
  eq(linked, ['title.text', 'yAxis.name', 'series.0.name'], 'a table-linked chart: derived categories are not offered')
}

console.log('\nreplace keeps markup')
{
  const doc = deck()
  const n = replaceAll(doc, 'cat', 'dog & <pup>')
  eq(n, 12, 'replace all counts every match')
  eq(text(doc, 0, 'body'), 'The dog &amp; &lt;pup&gt; sat. <b>dog &amp; &lt;pup&gt;</b> food &amp; dog &amp; &lt;pup&gt;&nbsp;nip', 'inside runs only; replacement escaped; &amp; / &nbsp; / <b> untouched')
  eq(doc.slides[0].notes, 'Mention the dog & <pup> twice: dog & <pup>.', 'notes are plain text — not escaped')
  eq((doc.slides[1].elements[0] as TableElement).rows[2].cells[0].html, 'dog <i>dog &amp; &lt;pup&gt;</i>', 'a cell keeps its <i>')
  const ch = doc.slides[1].elements[1] as ChartElement
  eq((ch.option.xAxis as { data: unknown[] }).data, ['dog & <pup>s', 'Dogs', 7], 'chart labels replaced, numbers kept')
  eq(findMatches(doc, 'cat').length, 0, 'nothing left to find')
}
{
  // a replacement containing the query must not loop
  const doc = deck()
  const n = replaceAll(doc, 'cat', 'catcat', { matchCase: true })
  eq(n, 8, 'replacement containing the query: replaced once each')
  ok(text(doc, 0, 'body').startsWith('The catcat sat.'), 'no runaway re-replacement')
}

console.log('\nreplace one')
{
  const doc = deck()
  const ms = findMatches(doc, 'cat', { wholeWord: true })
  const second = ms[1] // the bold "Cat" in body
  ok(replaceMatch(doc, second, 'cat', 'Dog', { wholeWord: true }), 'replace the current match')
  eq(text(doc, 0, 'body'), 'The cat sat. <b>Dog</b> food &amp; cat&nbsp;nip', 'only that one changed, inside its <b>')
  ok(!replaceMatch(doc, second, 'cat', 'Dog', { wholeWord: true }), 'a stale match is refused, not misapplied')
  const notes = findMatches(doc, 'cat').find((m) => m.ref.kind === 'notes')!
  ok(replaceMatch(doc, notes, 'cat', 'kitten'), 'replace inside notes')
  eq(doc.slides[0].notes, 'Mention the kitten twice: cat.', 'first notes match only')
}

console.log('\nreplace all is ONE undo step')
{
  const doc = deck()
  const store = new Store(doc)
  const before = JSON.stringify(store.doc)
  let n = 0
  store.commit(() => { n = replaceAll(store.doc, 'cat', 'dog') })
  ok(n > 5 && findMatches(store.doc, 'cat').length === 0, `replaced ${n} matches across 2 slides`)
  store.undo()
  eq(JSON.stringify(store.doc), before, 'one undo restores every slide')
}

console.log('\nreplace one opens an undo step only for a real change')
{
  const doc = deck()
  const store = new Store(doc)
  const depth = () => (store as unknown as { undoStack: unknown[] }).undoStack.length
  const ms = findMatches(store.doc, 'cat', { wholeWord: true })
  const m = ms[0]
  // what findbar.replaceCurrent does: plan first, commit only on a change
  const run = (match: FindMatch, replacement: string) => {
    const plan = planReplaceMatch(store.doc, match, 'cat', replacement, { wholeWord: true })
    if (plan?.changed) store.commit(() => plan.apply())
    return plan
  }
  const noop = run(m, m.text)
  ok(!!noop && !noop.changed && depth() === 0, 'replacing a match with itself: planned, unchanged, no undo step')
  const real = run(m, 'dog')
  ok(!!real?.changed && depth() === 1 && text(store.doc, 0, 'body').startsWith('The dog sat.'), 'a real replace: one undo step')
  const stale = run(m, 'dog')
  ok(stale === null && depth() === 1, 'the same (now stale) match again: refused before any commit — no empty undo step')
  const before = JSON.stringify(store.doc)
  ok(planReplaceMatch(store.doc, ms[1], 'cat', 'x', { wholeWord: true }) !== null && JSON.stringify(store.doc) === before, 'planning never writes')
}

console.log('\nrenderedSpans: the model\'s matches on the rendered text (the canvas highlighter)')
{
  const spans = (html: string, rendered: string, query: string, opts = {}) => {
    const doc = newDoc()
    const s = emptySlide({ id: 's' })
    s.elements.push(defaultText({ id: 't', html }))
    doc.slides = [s]
    const ms = findMatches(doc, query, opts).filter((m) => m.ref.kind === 'text')
    const src = fieldSource(doc, ms[0] ?? { slideIndex: 0, slideId: 's', ref: { kind: 'text', elId: 't' }, g0: 0, g1: 0, ordinal: 0, text: '' })!
    const out = renderedSpans(src.value, src.html, rendered, ms.map((m) => [m.g0, m.g1]))
    return out.map((sp) => (sp ? rendered.slice(sp[0], sp[1]) + '@' + sp[0] : null))
  }
  eq(spans('The cat sat. <b>Cat</b>', 'The cat sat. Cat', 'cat'), ['cat@4', 'Cat@13'], 'markup is not rendered text')
  eq(spans('cat<b>s</b> cat <i>cat</i>', 'cats cat cat', 'cat', { wholeWord: true }), ['cat@5', 'cat@9'],
    'whole words: "cat<b>s</b>" is no match in the model, so it is not marked either (a per-text-node search marked it)')
  eq(spans('food &amp; cat&nbsp;nip', 'food & cat nip', 'cat nip'), ['cat nip@7'], 'entities are one character; NBSP is a space')
  eq(spans('Page {{page}} of {{pages}}: page', 'Page  of : page', 'page'), ['Page@0', 'page@11'], 'field chips are left out of the rendered text')
  eq(spans('Page {{page}} of page', 'Page {{page}} of page', 'page'), ['Page@0', 'page@17'], 'an unresolved token rendered verbatim (a table cell)')
  eq(spans('one &hellip; cat &bogus; cat', 'one … cat &bogus; cat', 'cat'), ['cat@6', 'cat@18'], 'entities we do not decode: the alignment re-syncs')
  eq(spans('a cat <span>[math]</span> b cat', 'a cat ∑x² b cat', 'cat'), ['cat@2', 'cat@12'], 'rewritten text in between (math): re-synced after it')
  eq(spans('a cat', 'a dog', 'cat'), [null], 'text the renderer does not show is never marked somewhere else')
  eq(spans('caT cAt', 'caT cAt', 'cat'), ['caT@0', 'cAt@4'], 'case is the model\'s business, not the alignment\'s')
}

console.log('\nequation TeX')
{
  const doc = deck()
  doc.slides[0].elements.push(defaultMath({ id: 'eq', y: 600, tex: 'f(x) = x^2 + \\frac{x}{2} < \\pi' }))
  const ms = findMatches(doc, 'x').filter((m) => m.ref.kind === 'math')
  eq(ms.length, 3, 'an equation’s TeX is searched as plain text')
  ok(ms.every((m) => m.ref.kind === 'math' && m.ref.elId === 'eq'), 'matches point at the equation')
  eq(findMatches(doc, 'frac').filter((m) => m.ref.kind === 'math').length, 1, 'TeX commands are text there too (renaming a macro works)')
  eq(findMatches(doc, 'x <').filter((m) => m.ref.kind === 'math').length, 0, 'no html escaping in TeX: "<" is found only where it is typed')
  eq(findMatches(doc, '} <').filter((m) => m.ref.kind === 'math').length, 1, 'a raw "<" in TeX matches a typed "<"')
  replaceAll(doc, 'x', 't')
  eq((doc.slides[0].elements.find((e) => e.id === 'eq') as MathElement).tex, 'f(t) = t^2 + \\frac{t}{2} < \\pi', 'replace all rewrites the TeX verbatim, no entities')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
