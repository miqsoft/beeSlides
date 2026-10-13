#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Rich text phase 1 rig: the FORMAT half (the security half — what html may
// say — is scripts/test-sanitize.ts, which drives the real sanitizer in a
// browser).
//
//   slides/node_modules/.bin/esbuild scripts/test-rich-text.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-rich-text.mjs" \
//     && node "$TMPDIR/test-rich-text.mjs"
//
// Pins (DECISIONS 2026-10-08):
//   * the reader gate: a document whose text uses links, lists or styled runs
//     declares `requires: ['rich-text']`, exactly while it does — an older
//     build would strip all three on its next save, so it must open such a
//     file read-only — and this build knows the name;
//   * untrusted.ts's shape gate on rich html (list nesting);
//   * markdown.ts, pasted markdown → lists/links (the way back, htmlToMarkdown,
//     needs a DOM: scripts/lib/rich-text-probe.ts via test-sanitize.ts);
//   * click builds: a top-level list item is one paragraph.

import fs from 'node:fs'
import path from 'node:path'
import { KNOWN_FEATURES, RICH_TEXT_FEATURE, mergeTemplateDesign, newDoc, parseDoc, stampAsTemplate, syncRichTextRequires, unsupportedFeatures, usesRichText } from '../slides/src/model'
import { withRichTextRequires } from '../slides/src/save'
import { missingFeatures } from '../kernel/src/doc'
import { LIMITS, sanitizeElement } from '../slides/src/untrusted'
import { markdownToHtml } from '../slides/src/editor/markdown'
import { markerText } from '../slides/src/svgexport'
import { splitParagraphs } from '../slides/src/builds'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) } else console.log(`  ✓ ${msg}`)
}

const textEl = (html: string) => ({
  id: 't1', type: 'text', x: 0, y: 0, w: 400, h: 100, rotation: 0, opacity: 1,
  html, fontSize: 24, fontFamily: 'sans-serif', fontWeight: 400, color: '#111',
  align: 'left', valign: 'top', lineHeight: 1.2,
}) as never

// --- the reader gate -----------------------------------------------------------

console.log('\nrequires: rich-text')

ok(KNOWN_FEATURES.has(RICH_TEXT_FEATURE) && RICH_TEXT_FEATURE === 'rich-text', 'this build knows "rich-text"')
const PRE_RICH = new Set(['asset-store']) // what every build before this one knew
ok(missingFeatures({ requires: ['rich-text'] }, PRE_RICH).join() === 'rich-text',
  'an older build does not — it opens such a file read-only instead of flattening it on save')
ok(unsupportedFeatures({ requires: ['rich-text', 'asset-store'] }).length === 0, 'and this build may write it')

for (const [html, why] of [
  ['<a href="https://example.com/">x</a>', 'a link'],
  ['<ul><li>a</li></ul>', 'a bulleted list'],
  ['<OL><LI>a</LI></OL>', 'a numbered list, in any case'],
  ['<span style="color:#f00">x</span>', 'a coloured run'],
  ['<span style="font-size:30px">x</span>', 'a sized run'],
] as const) {
  const d = newDoc()
  d.slides[0].elements = [textEl(html)]
  ok(usesRichText(d), `detected: ${why}`)
}
for (const html of ['plain', '<b>bold</b> <i>i</i> <u>u</u> <s>s</s> <code>c</code><br><div>line</div>', 'a < b and c > d', 'see list below']) {
  const d = newDoc()
  d.slides[0].elements = [textEl(html)]
  ok(!usesRichText(d), `not rich: ${JSON.stringify(html).slice(0, 40)}`)
}

{
  const d = newDoc()
  d.slides[0].elements = [{ id: 'e1', type: 'embed', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, html: '<ul><li><a href="https://x">page</a></li></ul>' } as never]
  ok(!usesRichText(d), "an embed's html is a whole page, not rich text — it never sets the gate")
}
{
  const d = newDoc()
  d.layouts = [{ ...d.slides[0], id: 'L1', elements: [textEl('<a href="https://e.example/">x</a>')] }]
  ok(usesRichText(d), 'rich text on a slide TYPE counts — an older build would strip it there too')
}
{
  const d = newDoc()
  d.slides[0].elements = [{
    id: 'tb', type: 'table', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, columns: [{ w: 1 }], header: false,
    rows: [{ cells: [{ html: '<ul><li>cell list</li></ul>' }] }], style: {},
  } as never]
  ok(usesRichText(d), 'and so does a table cell')
}

{
  const d = newDoc() as ReturnType<typeof newDoc> & { requires?: unknown }
  d.slides[0].elements = [textEl('<a href="https://example.com/">x</a>')]
  ok(syncRichTextRequires(d) && JSON.stringify(d.requires) === '["rich-text"]', 'sync adds the name when the text uses it')
  ok(!syncRichTextRequires(d), 'and is a no-op the second time')
  d.requires = ['asset-store', 'rich-text']
  ;(d.slides[0].elements[0] as { html: string }).html = 'plain again'
  ok(syncRichTextRequires(d) && JSON.stringify(d.requires) === '["asset-store"]',
    'removing the last link drops the name and keeps every other one — the file opens in older builds again')
  d.requires = ['rich-text']
  syncRichTextRequires(d)
  ok(!('requires' in d), 'an emptied list is removed, not left as []')
  d.requires = 'rich-text'
  ;(d.slides[0].elements[0] as { html: string }).html = '<ul><li>x</li></ul>'
  ok(!syncRichTextRequires(d) && d.requires === 'rich-text', 'a malformed requires is never "fixed" — that is the reader gate\'s call')
}

{
  // the name survives the format's own load path
  const d = newDoc() as ReturnType<typeof newDoc> & { requires?: string[] }
  d.slides[0].elements = [textEl('<ol><li>a<ul><li>b</li></ul></li></ol><a href="mailto:x@example.com">m</a>')]
  d.requires = ['rich-text']
  const back = parseDoc(JSON.stringify(d)) as (typeof d) | null
  ok(!!back && JSON.stringify(back.requires) === '["rich-text"]', 'parseDoc keeps requires')
  ok(back?.slides[0].elements[0] && (back.slides[0].elements[0] as { html: string }).html.includes('<ol><li>a<ul>'),
    'and the rich html, as stored')
}

// Write paths that never meet the Store: a library save splices file.doc
// straight into the library file, a template update/stamp serializes a doc
// built by mergeTemplateDesign/stampAsTemplate. Each declares the gate at
// the point the JSON is written (save.ts wraps every serialize entry point;
// library.ts spliceForeignDoc calls the same helper).
{
  const deck = newDoc()
  const tmpl = stampAsTemplate(newDoc(), { samples: false }) as ReturnType<typeof newDoc> & { requires?: string[] }
  deck.layouts = [{ ...deck.slides[0], id: 'lay-rich', elements: [textEl('<ul><li>styled bullet</li></ul>')] }] as never
  const merged = mergeTemplateDesign(tmpl, deck) as ReturnType<typeof newDoc> & { requires?: string[] }
  ok(!('error' in merged) && usesRichText(merged), 'a template update carries the deck\'s rich layouts')
  const written = withRichTextRequires(merged)
  ok(JSON.stringify(written.requires) === '["rich-text"]', 'and what gets serialized declares rich-text')
  ok(written !== merged && !('requires' in merged), 'without touching the caller\'s doc (a shallow copy)')
  const plain = newDoc()
  ok(withRichTextRequires(plain) === plain, 'a doc already in step is passed through as is')
  const lib = newDoc() as ReturnType<typeof newDoc> & { requires?: string[] }
  lib.requires = ['rich-text']
  ok(!('requires' in withRichTextRequires(lib)), 'and a stale name is dropped on write, like the Store does')

  const save = fs.readFileSync(path.resolve('slides/src/save.ts'), 'utf8')
  for (const fn of ['serializeFile', 'serializeWith', 'serializeDocInto', 'serializeAuto']) {
    ok(new RegExp('export function ' + fn + '\\([^)]*\\)[^{]*\\{\\s*return kernel' + fn[0].toUpperCase() + fn.slice(1) + '\\([^)]*withContentRequires\\(doc\\)').test(save),
      `save.ts's ${fn} declares the gate before the kernel writes`)
  }
  const library = fs.readFileSync(path.resolve('slides/src/editor/library.ts'), 'utf8')
  const splice = library.slice(library.indexOf('function spliceForeignDoc'), library.indexOf('function spliceForeignDoc') + 1400)
  ok(splice.includes('JSON.stringify(withContentRequires(doc))'), 'and so does the library file splice')
}

// the wiring: every local mutation and every whole-doc swap re-derives the
// name (a source pin — the Store needs IndexedDB, which a node rig has not)
{
  const store = fs.readFileSync(path.resolve('slides/src/store.ts'), 'utf8')
  const touch = store.slice(store.indexOf('  touch(event'), store.indexOf('  touch(event') + 600)
  const replace = store.slice(store.indexOf('  replaceDoc(next'), store.indexOf('  replaceDoc(next') + 800)
  // syncContentRequires = syncRichTextRequires + the table-merge twin (model.ts)
  ok(touch.includes('syncContentRequires(this.doc)'), 'Store.touch keeps requires in step')
  ok(replace.includes('syncContentRequires(next)'), 'and so does Store.replaceDoc')
}

// --- untrusted.ts ----------------------------------------------------------------

console.log('\nuntrusted: rich html shape')

const keep = (html: string) => (sanitizeElement(textEl(html)) as { html?: string } | null)?.html === html
ok(keep('<ul><li>a<ul><li>b<ol><li>c</li></ol></li></ul></li></ul>'), 'a real nested list is kept as written')
ok(keep('<a href="https://example.com/">x</a><span style="color:#fff">y</span>'), 'links and styled runs are kept (their content is sanitizeHtml\'s call)')
let deep = ''
for (let i = 0; i <= LIMITS.listDepth; i++) deep += '<ul><li>'
ok(sanitizeElement(textEl(deep + 'x')) === null, `a paste nested past ${LIMITS.listDepth} lists is refused (the text element goes with its html)`)
let balanced = ''
for (let i = 0; i < 40; i++) balanced += '<ul><li>x</li></ul>'
ok(keep(balanced), 'many lists side by side are not depth')

// --- markdown.ts --------------------------------------------------------------------

console.log('\nmarkdown → rich text')

ok(markdownToHtml('- one\n- two') === '<ul><li>one</li><li>two</li></ul>', 'dash lines make a bulleted list')
ok(markdownToHtml('* one\n+ two') === '<ul><li>one</li><li>two</li></ul>', '* and + are bullets too')
ok(markdownToHtml('1. one\n2) two') === '<ol><li>one</li><li>two</li></ol>', 'numbered lines make a numbered list')
ok(markdownToHtml('- a\n  - b\n    - c\n  - d\n- e') ===
  '<ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>',
  'indentation nests, and each sub-list sits inside its item')
ok(markdownToHtml('- a\n\t1. b') === '<ul><li>a<ol><li>b</li></ol></li></ul>', 'a tab indents, and a list kind can change per level')
ok(markdownToHtml('- a\n1. b') === '<ul><li>a</li></ul><ol><li>b</li></ol>', 'a different marker at the same level starts a new list')
ok(markdownToHtml('intro\n- a\noutro') === 'intro<ul><li>a</li></ul>outro', 'a list is a block: no <br> around it')
let md = ''
for (let i = 0; i < 12; i++) md += ' '.repeat(i * 2) + '- l' + i + '\n'
ok((markdownToHtml(md).match(/<ul>/g) ?? []).length === 6, 'pasted indentation stops at six levels, like Tab')
ok(markdownToHtml('see [the docs](https://example.com/a_b_c) now') === 'see <a href="https://example.com/a_b_c">the docs</a> now',
  'a [link](url) — and the underscores in its URL are not italics')
ok(markdownToHtml('[x](https://e.com/?a=1&b=2)') === '<a href="https://e.com/?a=1&amp;b=2">x</a>', 'an & in a URL is attribute-escaped once')
ok(markdownToHtml('[x](https://e.com/"onclick="y)') === '<a href="https://e.com/&quot;onclick=&quot;y">x</a>',
  'a quote in a pasted URL cannot close the attribute')
ok(markdownToHtml('-5 degrees') === '-5 degrees' && markdownToHtml('*emph* text') === '<i>emph</i> text',
  'a minus sign and an emphasis are not list markers')
ok(markdownToHtml('\\- not a list') === '- not a list', 'an escaped marker stays literal')
ok(markdownToHtml('**b** and `c`') === '<b>b</b> and <code>c</code>', 'the inline subset is unchanged')
ok(markdownToHtml('C:\\\\Users') === 'C:\\Users' && markdownToHtml('C:\\Users') === 'C:\\Users',
  'an escaped backslash reads back as one backslash, a lone one stays (outline edits never double it)')
ok(markdownToHtml('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))') === '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a>',
  'a link whose URL holds one level of balanced parentheses is a link')
ok(markdownToHtml('[x](https://e.example/a)b)') === '<a href="https://e.example/a">x</a>b)',
  'an unbalanced closing paren ends the link, as in markdown')

// rich text phase 2 (DECISIONS 2026-10-08): a numbered list starts only at
// "1." — the format has no list start, so a list starting anywhere else would
// renumber what was typed (silently changing the text). Once open, any
// numbered line at its level continues it, as in markdown.
console.log('\nmarkdown: typed numbers are never renumbered')

ok(markdownToHtml('2019. was a good year') === '2019. was a good year', 'a year at the start of a line stays text, not a list from 1')
ok(markdownToHtml('intro\n2019. was a good year\n2020. was not') === 'intro<br>2019. was a good year<br>2020. was not',
  'and so do the lines after it')
ok(markdownToHtml('3. b') === '3. b' && markdownToHtml('intro\n2. b\n3. c') === 'intro<br>2. b<br>3. c', 'a list does not start at 2 or 3')
ok(markdownToHtml('01. x') === '01. x' && markdownToHtml('0. x') === '0. x', 'a leading zero or a 0 is not a list start')
ok(markdownToHtml('- a\n2. b') === '<ul><li>a</li></ul>2. b', 'a numbered line after a bullet starts nothing at 2')
ok(markdownToHtml('1. a\n  1. x\n  2. y\n2. b') === '<ol><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ol>',
  'nested numbering counts per level, and the outer list continues at 2')
ok(markdownToHtml('- a\n  3. x') === '<ul><li>a</li></ul>  3. x', 'a nested list does not start at 3 either')

console.log('\nmarkdown: an open numbered list takes any number (markdown renumbers)')
ok(markdownToHtml('1. a\n1. b\n1. c') === '<ol><li>a</li><li>b</li><li>c</li></ol>', 'the lazy "1. 1. 1." style is one list')
ok(markdownToHtml('1. a\n3. b') === '<ol><li>a</li><li>b</li></ol>', 'a deleted item: the rest stays in the list')
ok(markdownToHtml('1. a\n2. new\n2. b\n3. c') === '<ol><li>a</li><li>new</li><li>b</li><li>c</li></ol>', 'an inserted item: so does everything after it')
ok(markdownToHtml('1. a\n  1. x\n  5. y\n7. b') === '<ol><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ol>',
  'per level, nested too')
{
  // the outline: the field was written from a real list, so a run of its
  // old numbered items may start elsewhere (the first item was deleted)
  const keep = [{ key: 'alpha', html: 'alpha', ordered: true }, { key: 'beta', html: 'beta', ordered: true }, { key: 'gamma', html: 'gamma', ordered: true }]
  ok(markdownToHtml('2. beta\n3. gamma', keep) === '<ol><li>beta</li><li>gamma</li></ol>', 'the outline: deleting the first item keeps the list')
  ok(markdownToHtml('2. beta, edited\n3. gamma', keep) === '<ol><li>beta, edited</li><li>gamma</li></ol>', 'also with the next item edited')
  ok(markdownToHtml('2. other\n3. words', keep) === '2. other<br>3. words', 'but a numbered run with none of the old items stays text')
  const bullets = [{ key: 'beta', html: 'beta' }]
  ok(markdownToHtml('2. beta', bullets) === '2. beta', 'and an old BULLET item does not count')
}
ok(markdownToHtml('1\\. not a list') === '1. not a list' && markdownToHtml('\\+ not a list') === '+ not a list',
  'an escaped list marker at a line start reads back literal (what htmlToMarkdown writes for such a plain line)')
ok(markdownToHtml('a\\.b \\+ c') === 'a\\.b \\+ c', 'a "\\." or "\\+" anywhere else keeps its backslash')

console.log('\nmarkdown: an outline edit keeps the lines it did not change')
{
  const keep = [{ key: 'a', html: '<span style="color:#f00">a</span>' }, { key: 'b', html: '<i>b</i>' }, { key: 'x', html: '<u>x</u>' }]
  ok(markdownToHtml('a\nB\n- x', keep) === '<span style="color:#f00">a</span><br>B<ul><li><u>x</u></li></ul>',
    'an unchanged line (or list item) takes its old html again; a changed one converts (no DOM here to patch it into)')
  const dups = [{ key: 'dup', html: '<b>1</b>' }, { key: 'dup', html: '<b>2</b>' }]
  ok(markdownToHtml('dup\ndup\ndup', dups) === '<b>1</b><br><b>2</b><br>dup', 'repeated lines take their old html in order, each once')
  ok(markdownToHtml('**b**', [{ key: 'b', html: '<i>no</i>' }]) === '<b>b</b>', 'the lookup is by the whole line as typed, markers included')
  ok(markdownToHtml('a\nnew\nb', [{ key: 'a', html: '<u>a</u>' }, { key: 'b', html: '<u>b</u>' }]) === '<u>a</u><br>new<br><u>b</u>',
    'an inserted line converts and the lines around it keep theirs (aligned, not positional)')
  ok(markdownToHtml('b', [{ key: 'a', html: '<u>a</u>' }, { key: 'b', html: '<u>b</u>' }]) === '<u>b</u>', 'and so does a deleted one')
  ok(markdownToHtml('a', [{ key: 'a', html: null }]) === 'a', 'a line with no clean old html converts')
}

console.log('\nsvg export: list markers')
ok(markerText('disc', 1) === '•' && markerText('circle', 2) === '◦' && markerText('square', 3) === '▪', 'bullets per level')
ok(markerText('decimal', 12) === '12.' && markerText('lower-alpha', 1) === 'a.' && markerText('lower-alpha', 27) === 'aa.',
  'numbers and letters (z → aa)')
ok(markerText('lower-roman', 4) === 'iv.' && markerText('upper-roman', 1994) === 'MCMXCIV.', 'roman numerals')
ok(markerText('none', 1) === '', 'list-style none draws nothing')

// --- builds ------------------------------------------------------------------------

console.log('\nclick builds: list items are paragraphs')

ok(splitParagraphs('<ul><li>a</li><li>b</li></ul>').join('|') === '<li>a</li>|<li>b</li>', 'each top-level item is a paragraph')
ok(splitParagraphs('<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>').length === 2,
  'a sub-list rides along with its item (PowerPoint\'s "by 1st level paragraphs")')
ok(splitParagraphs('intro<ol><li>x</li><li><br></li></ol>outro').join('|') === 'intro|<li>x</li>|outro',
  'text around a list is its own paragraph, and a blank item is none')
ok(splitParagraphs('<div>a</div><div><ul><li>x</li><li>y</li></ul></div>').length === 3,
  'a list inside a block line counts item by item — the renderer lifts it out of the line (hoistLists)')
ok(splitParagraphs('<div>x<ul><li>a</li><li>b</li></ul>y</div>').length === 4,
  'and the line\'s words before and after it are paragraphs of their own')
ok(splitParagraphs('<div><div>a</div><div>b</div></div>').length === 1,
  'nested blocks without a list still stay inside their top-level block')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
