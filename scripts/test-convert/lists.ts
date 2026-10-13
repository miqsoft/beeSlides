#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert rig — real lists (ul/ol/li) and the rich-text gate.
//
//   node scripts/test-convert/lists.ts        (Node ≥ 23.6 strips types natively)
//
// Both importers write bullets as REAL lists in the exact shape the slides
// sanitizer keeps byte for byte (render.ts sanitizeHtml: no attributes, a
// ul/ol holds only li, a nested list sits inside its item, no list inside a
// line block, no <br> touching a list, ≤ 6 deep — and the canonical shape
// slides/src/editor/markdown.ts writes). The sanitizer itself needs a DOM, so
// `canonical()` below re-states those rules as a checker over every text
// element of every fixture (the real sanitizeHtml round trip needs a browser
// and was checked against the editor's import; DECISIONS 2026-10-08,
// "Importer follow-ups"). The traps:
//
//   • a document with a list requires 'rich-text' (an older reader would
//     write the items back as run-on lines); one WITHOUT stays unflagged.
//   • a numbered list that does not start at 1 must stay literal text — the
//     sanitizer strips <ol start>, so a real list would say "1." for "3.".
//   • nesting goes INSIDE the parent item (the sibling form is what the
//     sanitizer rewrites, i.e. not byte-stable).

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import { convertMarkdown } from '../../kernel/src/convert/qmd.ts'
import { paragraphsHtml, usesLists } from '../../kernel/src/convert/lists.ts'
import type { OutDoc, OutText } from '../../kernel/src/convert/types.ts'
import { fxImportFollowups, fxMinimal, allFixtures } from './_fixtures.ts'
import { allMarkdownFixtures } from './_mdfixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** Why `html` would NOT survive sanitizeHtml unchanged, or '' when it would
 *  (for the list rules; inline tags are checked for attributes only). */
function canonical(html: string): string {
  if (/ /.test(html)) return 'raw U+00A0 (serializes as &nbsp;)'
  const stack: string[] = []
  let prev = '' // the previous token: 'text', '<br>', '</ul>' …
  const re = /<(\/?)([a-z]+)([^>]*)>|[^<]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (!m[2]) {
      if (stack.length && (stack[stack.length - 1] === 'ul' || stack[stack.length - 1] === 'ol')) return 'text directly in a list'
      prev = 'text'
      continue
    }
    const [, close, tag, attrs] = m
    if (attrs.trim()) return `attributes on <${tag}>`
    if (!['b', 'i', 'u', 's', 'code', 'br', 'ul', 'ol', 'li'].includes(tag)) return `<${tag}> is not emitted by the importers`
    const top = stack[stack.length - 1]
    if (close) {
      if (stack.pop() !== tag) return `unbalanced </${tag}>`
      prev = `</${tag}>`
      continue
    }
    if (tag === 'br') {
      if (prev === '</ul>' || prev === '</ol>') return '<br> right after a list'
      if (top === 'ul' || top === 'ol') return '<br> directly in a list'
      prev = '<br>'
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      if (prev === '<br>') return '<br> right before a list'
      if (top !== undefined && top !== 'li') return `a list inside <${top}>`
      if (stack.filter((t) => t === 'ul' || t === 'ol').length >= 6) return 'deeper than MAX_LIST_DEPTH'
    } else if (tag === 'li') {
      if (top !== 'ul' && top !== 'ol') return '<li> outside a list'
    } else if (top === 'ul' || top === 'ol') return `<${tag}> directly in a list`
    stack.push(tag)
    prev = `<${tag}>`
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : ''
}

function allCanonical(label: string, doc: OutDoc) {
  const bad: string[] = []
  for (const s of [...doc.slides, ...(doc.layouts ?? [])]) {
    for (const e of s.elements) {
      if (e.type !== 'text') continue
      const why = canonical(e.html)
      if (why) bad.push(`${s.id}/${e.id}: ${why} in ${e.html.slice(0, 80)}`)
    }
  }
  ok(bad.length === 0, `${label}: every text html is in the sanitizer's canonical shape${bad.length ? ` — ${bad.join(' | ')}` : ''}`)
}

// ----------------------------------------------------------- the builder
{
  ok(paragraphsHtml([{ kind: 'line', html: 'a' }, { kind: 'line', html: 'b' }]) === 'a<br>b',
    'lines only: joined by <br>, exactly the pre-list output')
  ok(paragraphsHtml([
    { kind: 'item', level: 0, ordered: false, html: 'x' },
    { kind: 'line', html: '' },
    { kind: 'item', level: 0, ordered: false, html: 'y' },
  ]) === '<ul><li>x<br><br></li><li>y</li></ul>',
  'a blank line between two items stays inside the list (two <br>: the last one draws no line)')
  ok(paragraphsHtml([
    { kind: 'item', level: 0, ordered: true, html: 'one' },
    { kind: 'line', html: '' }, { kind: 'line', html: '' },
    { kind: 'item', level: 0, ordered: true, html: 'two' },
  ]) === '<ol><li>one<br><br><br></li><li>two</li></ol>',
  'two blank lines inside a numbered list: one <ol>, so "two" is still 2.')
  ok(paragraphsHtml([
    { kind: 'item', level: 1, ordered: false, html: 'sub' },
    { kind: 'line', html: '' },
    { kind: 'item', level: 0, ordered: true, html: 'top' },
  ]) === '<ul><li>sub<br><br></li></ul><ol><li>top</li></ol>',
  'a blank before a SHALLOWER item joins the deeper item')
  ok(paragraphsHtml([
    { kind: 'item', level: 0, ordered: false, html: 'x' },
    { kind: 'line', html: '' },
    { kind: 'item', level: 1, ordered: false, html: 'deeper' },
  ]) === '<ul><li>x</li></ul><br><ul><li>deeper</li></ul>',
  'a blank before a DEEPER item stays a line (no <br> may touch the nested list)')
  ok(paragraphsHtml([
    { kind: 'item', level: 0, ordered: false, html: 'x' },
    { kind: 'line', html: '' },
    { kind: 'line', html: 'after' },
  ]) === '<ul><li>x</li></ul><br>after',
  'a blank between a list and a line is still a line of its own')
  ok(paragraphsHtml([
    { kind: 'line', html: 't' }, { kind: 'line', html: '' },
    { kind: 'item', level: 0, ordered: true, html: 'x' },
  ]) === 't<br><br><ol><li>x</li></ol>',
  'a blank line BEFORE a list gets its extra <br> (a trailing <br> draws no line)')
  const deep = paragraphsHtml(Array.from({ length: 9 }, (_, i) => ({ kind: 'item' as const, level: i, ordered: false, html: `l${i}` })))
  ok((deep.match(/<ul>/g) ?? []).length === 6 && canonical(deep) === '',
    'levels past MAX_LIST_DEPTH join the deepest list (6 <ul>s, still canonical)')
  ok(paragraphsHtml([
    { kind: 'item', level: 2, ordered: false, html: 'a' },
    { kind: 'item', level: 0, ordered: false, html: 'b' },
  ]) === '<ul><li>a</li></ul><ul><li>b</li></ul>',
  'a shallower item after a deeper first one starts a list of its own')
}

// ------------------------------------------------------------------ .pptx
{
  const r = await convertPptx(await fxImportFollowups(), { link: false })
  const body = r.doc.slides[8].elements.find((e) => e.id === 's9-3') as OutText
  ok(body?.html === 'Agenda<ul><li>First<ul><li>Detail</li></ul></li><li>Second</li></ul><ol><li>Step one</li><li>Step two</li></ol>',
    `nested bullets inside their item; Wingdings "l" (●) and Courier New "o" are plain markers; numbers a sibling <ol> (got ${body?.html})`)
  ok(!r.report.entries.some((e) => e.where.includes('Body') && /bullet-flattened|list-marker|auto-number/.test(e.code)),
    'and none of those markers is reported as approximated or frozen')
  const gapped = r.doc.slides[8].elements.find((e) => e.id === 's9-4') as OutText
  ok(gapped?.html === '<ol><li>one<br><br></li><li>two</li></ol>',
    `1. / empty paragraph / 2.: one <ol>, the blank inside item 1 — "two" stays 2., not a restarted 1. (got ${gapped?.html})`)
  ok(!r.report.entries.some((e) => e.where.includes('Gapped') && /list-|auto-number/.test(e.code)),
    'and the gap is neither frozen nor reported as an approximation')
  ok(JSON.stringify(r.doc.requires) === '["rich-text"]', 'a converted deck with a list requires ["rich-text"]')
  ok(usesLists(r.doc), 'usesLists agrees')
  const plain = await convertPptx(await fxMinimal(), { link: false })
  ok(!('requires' in plain.doc), 'NEGATIVE — a deck without a list carries no requires at all')
  const twice = await convertPptx(await fxImportFollowups())
  ok(JSON.stringify(twice.doc.requires) === '["rich-text"]', 'linked mode: requires once, deduped')
}

// ---------------------------------------------------------- markdown/qmd
{
  const md = convertMarkdown([
    '## Lists',
    '',
    '- one',
    '- two',
    '  - two-a',
    '- three',
    '',
    '## Numbers',
    '',
    '1. first',
    '2. second',
    '',
    '## From three',
    '',
    '3. third',
    '4. fourth',
    '',
    '## Steps',
    '',
    '::: {.incremental}',
    '1. alpha',
    '   1. alpha-1',
    '2. beta',
    ':::',
    '',
    '## Steps with details',
    '',
    '1. Step one',
    '   - detail a',
    '   - detail b',
    '2. Step two',
    '',
    '## Two lists',
    '',
    '1. numbered',
    '- bulleted',
    '',
    '## Short steps',
    '',
    '::: {.incremental}',
    '1. x',
    '2. y',
    '3. z',
    ':::',
  ].join('\n'), { name: 'lists.md' })
  const texts = (i: number) => md.doc.slides[i].elements.filter((e) => e.type === 'text') as OutText[]
  ok(texts(0).some((e) => e.html === '<ul><li>one</li><li>two<ul><li>two-a</li></ul></li><li>three</li></ul>'),
    `a nested markdown list is a real nested <ul> (got ${texts(0).map((e) => e.html).join(' | ')})`)
  ok(texts(1).some((e) => e.html === '<ol><li>first</li><li>second</li></ol>'), 'an ordered list from 1 is a real <ol>')
  ok(texts(2).some((e) => e.html === '3. third<br>4. fourth'),
    `a list starting at 3 stays literal — <ol start> does not survive the sanitizer (got ${texts(2).map((e) => e.html).join(' | ')})`)
  ok(md.report.entries.some((e) => e.code === 'list-start-frozen'), 'and says so')
  const steps = texts(3).filter((e) => e.fx?.enter)
  ok(steps.length === 2 && steps[0].html === '1. alpha<br>&nbsp;&nbsp;&nbsp;&nbsp;1. alpha-1' && steps[1].html === '2. beta',
    `incremental: one step per top-level item, sub-items ride along, every step keeps literal numbers so they line up (got ${steps.map((e) => e.html).join(' | ')})`)
  ok(texts(4).some((e) => e.html === '<ol><li>Step one<ul><li>detail a</li><li>detail b</li></ul></li><li>Step two</li></ol>'),
    `numbered steps with bullet details: ONE list, the <ul> nested in its step, "Step two" still a real item (got ${texts(4).map((e) => e.html).join(' | ')})`)
  ok(!md.report.entries.some((e) => e.code === 'list-start-frozen' && e.where.includes('Steps with details')),
    'NEGATIVE — and nothing there is frozen')
  ok(texts(5).some((e) => e.html === '<ol><li>numbered</li></ol>') && texts(5).some((e) => e.html === '<ul><li>bulleted</li></ul>'),
    `a kind change at the top level still starts a separate list (got ${texts(5).map((e) => e.html).join(' | ')})`)
  const short = texts(6).filter((e) => e.fx?.enter)
  ok(short.map((e) => e.html).join(' | ') === '1. x | 2. y | 3. z',
    `incremental 1/2/3: all three steps are literal, the first is not a hanging <ol> (got ${short.map((e) => e.html).join(' | ')})`)
  const single = convertMarkdown('## One\n\n::: {.incremental}\n1. only\n   - sub\n:::\n', { name: 'one.md' })
  ok((single.doc.slides[0].elements as OutText[]).some((e) => e.type === 'text' && e.html === '<ol><li>only<ul><li>sub</li></ul></li></ol>'),
    'an incremental numbered list with ONE step stays a real list (nothing to line up with)')
  ok(JSON.stringify(md.doc.requires) === '["rich-text"]', 'a markdown deck with a list requires ["rich-text"]')
  const none = convertMarkdown('## Plain\n\nJust prose.\n', { name: 'plain.md' })
  ok(!('requires' in none.doc), 'NEGATIVE — a markdown deck without a list carries no requires')
}

// ------------------------------------------- every fixture stays canonical
for (const { name, build } of allFixtures()) {
  allCanonical(`pptx ${name}`, (await convertPptx(await build())).doc)
}
for (const f of allMarkdownFixtures()) {
  allCanonical(`md ${f.name}`, convertMarkdown(f.source, { assets: f.assets, name: `${f.name}.qmd` }).doc)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
